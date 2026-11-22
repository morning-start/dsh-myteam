import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import {
  appointMemberCommand,
  claimTaskCommand,
  createProjectRole,
  createProjectWorkflowCommand,
  createTeamCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { startWorkflowRunCommand } from '../src/application/run-commands.ts'
import {
  completeTaskCommand,
  recordEvidenceCommand,
  recordProgressCommand,
  recordVerdictCommand,
  submitReviewCommand,
} from '../src/application/task-commands.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import type { TaskTemplate } from '../src/contracts/entities.ts'

const PROJECT = 'prj_00000001'
const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'panel' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  return ProjectRuntime.open({
    projectId: PROJECT,
    eventStore: new FileEventStore(join(dir, 'events', 'project.jsonl')),
    writerLock: new WriterLeaseManager(join(dir, 'state', 'writer.lock')),
    clock: { now: () => NOW },
    ids: newId,
  })
}

function template(key: string, dependsOn: string[] = []): TaskTemplate {
  return {
    key,
    title: key,
    description: '',
    acceptance: [`${key} 已完成`],
    requiredRoleId: null,
    dependsOn,
    gate: { commands: [], requireEvidence: true, requireArtifacts: false },
    deliverable: null,
  }
}

function bootstrap(runtime: ProjectRuntime) {
  initializeProject(runtime, { actor: HUMAN, name: '工作流项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read', 'write'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id

  const team = createTeamCommand(runtime, {
    actor: HUMAN,
    name: '交付队',
    goal: '交付',
    captainSessionId: 'ses_captain_01',
  })
  const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id

  const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_member_01' })
  const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id

  return { teamId, roleId, memberId }
}

function driveToReview(
  runtime: ProjectRuntime,
  input: { taskId: string; memberId: string },
): { attemptId: string } {
  claimTaskCommand(runtime, { actor: HUMAN, taskId: input.taskId, memberId: input.memberId })
  const attemptId = runtime.state.tasks.get(input.taskId)!.attemptId!
  recordProgressCommand(runtime, {
    actor: HUMAN,
    taskId: input.taskId,
    attemptId,
    memberId: input.memberId,
    note: '进行中',
    percent: 50,
  })
  recordEvidenceCommand(runtime, {
    actor: HUMAN,
    taskId: input.taskId,
    attemptId,
    memberId: input.memberId,
    evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
  })
  submitReviewCommand(runtime, { actor: HUMAN, taskId: input.taskId, attemptId, memberId: input.memberId })
  return { attemptId }
}

test('工作流实例化：一次批次产出 Run 与全部任务，根任务直接 ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-run-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = bootstrap(runtime)
      const workflow = createProjectWorkflowCommand(runtime, {
        actor: HUMAN,
        name: '实现流程',
        description: '',
        templates: [template('design'), template('build', ['design'])],
      })
      const workflowId = (workflow.events[0]!.payload as { workflow: { id: string } }).workflow.id

      const started = startWorkflowRunCommand(runtime, { actor: HUMAN, teamId, workflowId })
      assert.equal(started.taskIds.length, 2)
      assert.equal(runtime.state.graphRevision, 2, '一次实例化只推进一次 graphRevision')

      const run = runtime.state.runs.get(started.runId)!
      assert.equal(run.status, 'active')
      assert.equal(run.completionRevision, 1)
      assert.deepEqual(run.taskIds, started.taskIds)

      const design = runtime.state.tasks.get(started.taskIds[0]!)!
      const build = runtime.state.tasks.get(started.taskIds[1]!)!
      assert.equal(design.status, 'ready')
      assert.equal(build.status, 'planned')
      assert.deepEqual(build.dependencies, [design.id])
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁闭环：证据 → 裁决 → 完成 → 下游放开 → Run 收口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-gate-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId, memberId } = bootstrap(runtime)
      const workflow = createProjectWorkflowCommand(runtime, {
        actor: HUMAN,
        name: '实现流程',
        description: '',
        templates: [template('design'), template('build', ['design'])],
      })
      const workflowId = (workflow.events[0]!.payload as { workflow: { id: string } }).workflow.id
      const started = startWorkflowRunCommand(runtime, { actor: HUMAN, teamId, workflowId })
      const [designId, buildId] = started.taskIds as [string, string]

      // 先证明「没有裁决不能完成」。
      const designAttempt = driveToReview(runtime, { taskId: designId, memberId })
      assert.throws(
        () =>
          completeTaskCommand(runtime, {
            actor: HUMAN,
            taskId: designId,
            attemptId: designAttempt.attemptId,
            artifacts: [],
          }),
        (error: unknown) => error instanceof MyTeamError && error.code === 'TASK_NOT_READY',
      )

      recordVerdictCommand(runtime, {
        actor: HUMAN,
        taskId: designId,
        attemptId: designAttempt.attemptId,
        outcome: 'pass',
        checks: [{ command: 'npm test', exitCode: 0, stdoutHash: 'sha256:abc', summary: 'ok' }],
        evidence: [],
      })
      completeTaskCommand(runtime, {
        actor: HUMAN,
        taskId: designId,
        attemptId: designAttempt.attemptId,
        artifacts: [],
      })
      assert.equal(runtime.state.tasks.get(designId)!.status, 'done')
      assert.equal(runtime.state.tasks.get(buildId)!.status, 'ready', '下游应在同一批次被放开')

      const buildAttempt = driveToReview(runtime, { taskId: buildId, memberId })
      recordVerdictCommand(runtime, {
        actor: HUMAN,
        taskId: buildId,
        attemptId: buildAttempt.attemptId,
        outcome: 'pass',
        checks: [],
        evidence: [],
      })
      completeTaskCommand(runtime, {
        actor: HUMAN,
        taskId: buildId,
        attemptId: buildAttempt.attemptId,
        artifacts: [],
      })

      assert.equal(runtime.state.tasks.get(buildId)!.status, 'done')
      assert.equal(runtime.state.runs.get(started.runId)!.status, 'completed', '完成条件满足后 Run 应关闭')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('门禁不通过：裁决 fail 时完成被拒且列出原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-gate-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId, memberId } = bootstrap(runtime)
      const workflow = createProjectWorkflowCommand(runtime, {
        actor: HUMAN,
        name: '单任务流程',
        description: '',
        templates: [template('only')],
      })
      const workflowId = (workflow.events[0]!.payload as { workflow: { id: string } }).workflow.id
      const started = startWorkflowRunCommand(runtime, { actor: HUMAN, teamId, workflowId })
      const taskId = started.taskIds[0]!

      const { attemptId } = driveToReview(runtime, { taskId, memberId })
      recordVerdictCommand(runtime, {
        actor: HUMAN,
        taskId,
        attemptId,
        outcome: 'fail',
        checks: [{ command: 'npm test', exitCode: 1, stdoutHash: null, summary: 'failed' }],
        evidence: [],
      })

      try {
        completeTaskCommand(runtime, { actor: HUMAN, taskId, attemptId, artifacts: [] })
        assert.fail('门禁 fail 时不应完成')
      } catch (error) {
        assert.ok(error instanceof MyTeamError)
        assert.equal(error.code, 'TASK_NOT_READY')
        const blockers = (error.details as { blockers: string[] }).blockers
        assert.ok(blockers.some((blocker) => blocker.includes('fail')))
      }
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})