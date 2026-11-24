/**
 * t65（P3）：批准开队计划 —— 一个原子批次建出整个团队。
 *
 * 锁五件事（对应方案 §10 判据 2、3、6）：
 *   1. 批准后：团队 active、成员数 = formation 之和、配置快照落盘、队长已指派；
 *   2. 带工作流的计划：Run 与首批任务在**同一批次**里出现（不会「有团队没 Run」）；
 *   3. planHash 不符 → 拒绝（`CONFIRMATION_TARGET_CHANGED`），账本不动；
 *   4. 批准过的计划不能再次批准（已消费，NOT_FOUND）；
 *   5. 非人类 actor 调批准 → HUMAN_ONLY。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import {
  approveTeamPlanCommand,
  createProjectRole,
  createProjectWorkflowCommand,
  initializeProject,
  proposeTeamPlanCommand,
} from '../src/application/commands.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const CAPTAIN: ActorRef = { kind: 'captain', sessionId: 'ses_captain' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  const manifest = ensureProjectManifest(dir, { projectId: newId('project'), createdAt: NOW })
  return ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(dir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(dir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
}

function withProject(body: (runtime: ProjectRuntime, roleId: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t65-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '批准计划' })
      createProjectRole(runtime, {
        actor: HUMAN,
        profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
        capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
      })
      const roleId = [...runtime.state.roles.keys()][0]!
      body(runtime, roleId)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function propose(runtime: ProjectRuntime, roleId: string, extra: Record<string, unknown> = {}) {
  return proposeTeamPlanCommand(runtime, {
    actor: HUMAN,
    name: '结算改造',
    goal: '把结算页模块化',
    captainSessionId: 'ses_captain',
    formation: [
      { key: 'impl', roleId, count: 2, parentSlotKey: null },
      { key: 'reviewer', roleId, count: 1, parentSlotKey: null },
    ],
    ...extra,
  }).plan
}

test('批准：团队 active、成员数 = 队形之和、配置快照与队长都落了', () => {
  withProject((runtime, roleId) => {
    const plan = propose(runtime, roleId)
    const result = approveTeamPlanCommand(runtime, {
      actor: HUMAN,
      planId: plan.id,
      planHash: plan.planHash,
      startRun: false,
    })

    const team = runtime.state.teams.get(result.teamId)
    assert.ok(team !== undefined, '团队必须建出来')
    assert.equal(team!.status, 'active')
    assert.equal(team!.name, '结算改造')

    assert.equal(result.memberIds.length, 3, '2 + 1 = 3 名成员')
    for (const memberId of result.memberIds) {
      const member = runtime.state.members.get(memberId)
      assert.ok(member !== undefined)
      assert.equal(member!.teamId, result.teamId)
      // 会话由队长后续 spawn 绑定，批准这一步只建 appointed。
      assert.equal(member!.status, 'appointed')
      assert.equal(member!.sessionId, null)
    }

    assert.ok(runtime.state.teamConfigs.get(result.teamId) !== undefined, '配置快照要落盘')
    const captain = runtime.state.captains.get(result.teamId)
    assert.ok(captain !== undefined, '队长要指派')
    assert.equal(captain!.sessionId, 'ses_captain')
    assert.equal(captain!.generation, 1)

    // 计划被消费
    assert.equal(runtime.state.teamPlans.size, 0, '批准后计划不该还在')
  })
})

test('带工作流：Run 与首批任务和团队在同一个批次里出现', () => {
  withProject((runtime, roleId) => {
    // 先建一份工作流：一个根任务（无依赖）+ 一个依赖它的任务
    createProjectWorkflowCommand(runtime, {
      actor: HUMAN,
      name: '交付流',
      description: '',
      templates: [
          {
            key: 'impl',
            title: '实现',
            description: '',
            acceptance: ['可验证'],
            requiredRoleId: roleId,
            dependsOn: [],
            gate: { commands: [], requireEvidence: false, requireArtifacts: false },
            deliverable: null,
          },
          {
            key: 'review',
            title: '复核',
            description: '',
            acceptance: ['逐条核对'],
            requiredRoleId: null,
            dependsOn: ['impl'],
            gate: { commands: [], requireEvidence: false, requireArtifacts: false },
            deliverable: null,
          },
        ],
    })
    const workflowId = [...runtime.state.workflows.keys()][0]!
    const plan = propose(runtime, roleId, { workflowId })

    const result = approveTeamPlanCommand(runtime, {
      actor: HUMAN,
      planId: plan.id,
      planHash: plan.planHash,
    })

    assert.ok(result.runId !== null, '带工作流的计划批准后应开 Run')
    const run = runtime.state.runs.get(result.runId!)
    assert.ok(run !== undefined, 'Run 必须建出来')
    assert.equal(run!.teamId, result.teamId, 'Run 属于刚建的团队')
    assert.equal(result.taskIds.length, 2, '两个模板 → 两个任务')
    for (const taskId of result.taskIds) {
      assert.ok(runtime.state.tasks.get(taskId) !== undefined, '任务必须落盘')
    }
    // 根任务直接 ready（否则批准完还要人工放开）
    const root = runtime.state.tasks.get(result.taskIds[0]!)
    assert.equal(root!.status, 'ready', '根任务应直接 ready')
  })
})

test('planHash 不符 → 拒绝，账本不动', () => {
  withProject((runtime, roleId) => {
    const plan = propose(runtime, roleId)
    const teamsBefore = runtime.state.teams.size

    assert.throws(
      () => approveTeamPlanCommand(runtime, {
        actor: HUMAN,
        planId: plan.id,
        planHash: 'sha256:wrong',
        startRun: false,
      }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFIRMATION_TARGET_CHANGED',
    )
    assert.equal(runtime.state.teams.size, teamsBefore, '拒绝后不该建团队')
    assert.equal(runtime.state.teamPlans.size, 1, '拒绝后计划仍在')
  })
})

test('批准过的计划不能再次批准（已消费）', () => {
  withProject((runtime, roleId) => {
    const plan = propose(runtime, roleId)
    approveTeamPlanCommand(runtime, { actor: HUMAN, planId: plan.id, planHash: plan.planHash, startRun: false })

    assert.throws(
      () => approveTeamPlanCommand(runtime, { actor: HUMAN, planId: plan.id, planHash: plan.planHash, startRun: false }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'NOT_FOUND',
    )
  })
})

test('非人类调批准 → HUMAN_ONLY', () => {
  withProject((runtime, roleId) => {
    const plan = propose(runtime, roleId)
    assert.throws(
      () => approveTeamPlanCommand(runtime, { actor: CAPTAIN, planId: plan.id, planHash: plan.planHash, startRun: false }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'HUMAN_ONLY',
    )
    assert.equal(runtime.state.teams.size, 0, '被拒后不该建团队')
  })
})
