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
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
  rebaseTeamConfigCommand,
} from '../src/application/commands.ts'
import {
  adoptKnowledgeCommand,
  archiveKnowledgeCommand,
  proposeKnowledgeCommand,
} from '../src/application/knowledge-commands.ts'
import { cancelTaskCommand, reopenTaskCommand, rewireDependenciesCommand } from '../src/application/task-commands.ts'
import { boardView, taskDetail, teamView } from '../src/application/queries.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'

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

function bootstrap(runtime: ProjectRuntime): { teamId: string; roleId: string; memberId: string; memberActor: ActorRef } {
  initializeProject(runtime, { actor: HUMAN, name: '知识项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
  const team = createTeamCommand(runtime, {
    actor: HUMAN,
    name: '知识队',
    goal: '沉淀知识',
    captainSessionId: 'ses_captain_01',
  })
  const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id
  const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_member_01' })
  const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id
  const memberActor: ActorRef = {
    kind: 'member',
    teamId,
    memberId,
    sessionId: 'ses_member_01',
    memberSessionGeneration: 1,
    attemptId: null,
  }
  return { teamId, roleId, memberId, memberActor }
}

test('知识：成员提案、队长采纳、归档', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-knowledge-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { memberActor } = bootstrap(runtime)

      const proposed = proposeKnowledgeCommand(runtime, {
        actor: memberActor,
        title: '登录接口要限流',
        body: '压测时 200 QPS 触发数据库连接池耗尽。',
        evidence: [{ kind: 'file', ref: 'docs/bench/login.md' }],
      })
      const entryId = (proposed.events[0]!.payload as { entry: { id: string } }).entry.id
      assert.equal(runtime.state.knowledge.get(entryId)!.status, 'proposed')

      adoptKnowledgeCommand(runtime, { actor: HUMAN, entryId })
      assert.equal(runtime.state.knowledge.get(entryId)!.status, 'adopted')

      archiveKnowledgeCommand(runtime, { actor: HUMAN, entryId })
      assert.equal(runtime.state.knowledge.get(entryId)!.status, 'archived')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('知识：无证据的提案被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-knowledge-'))
  try {
    const runtime = openRuntime(dir)
    try {
      bootstrap(runtime)
      assert.throws(
        () => proposeKnowledgeCommand(runtime, { actor: HUMAN, title: 'x', body: 'y', evidence: [] }),
        (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_PAYLOAD',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('任务：改依赖成环被拒，取消与重开可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-task-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = bootstrap(runtime)
      const a = createTaskCommand(runtime, {
        actor: HUMAN,
        title: 'a',
        description: '',
        acceptance: ['x'],
        ownerTeamId: teamId,
      })
      const aId = (a.events[0]!.payload as { task: { id: string } }).task.id
      const b = createTaskCommand(runtime, {
        actor: HUMAN,
        title: 'b',
        description: '',
        acceptance: ['x'],
        ownerTeamId: teamId,
        dependencies: [aId],
      })
      const bId = (b.events[0]!.payload as { task: { id: string } }).task.id

      assert.throws(
        () => rewireDependenciesCommand(runtime, { actor: HUMAN, taskId: aId, dependencies: [bId] }),
        (error: unknown) => error instanceof MyTeamError && error.code === 'DEPENDENCY_CYCLE',
      )

      const before = runtime.state.graphRevision
      rewireDependenciesCommand(runtime, { actor: HUMAN, taskId: bId, dependencies: [] })
      assert.equal(runtime.state.graphRevision, before + 1, '改依赖应推进 graphRevision')
      assert.deepEqual(runtime.state.tasks.get(bId)!.dependencies, [])

      cancelTaskCommand(runtime, { actor: HUMAN, taskId: bId, reason: '不需要了' })
      assert.equal(runtime.state.tasks.get(bId)!.status, 'cancelled')
      reopenTaskCommand(runtime, { actor: HUMAN, taskId: bId, reason: '又需要了' })
      assert.equal(runtime.state.tasks.get(bId)!.status, 'ready')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置：团队 rebase 必须带正确的 configRevision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-config-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = bootstrap(runtime)
      const before = runtime.state.teams.get(teamId)!.configRevision
      assert.equal(before, 1)

      rebaseTeamConfigCommand(runtime, {
        actor: HUMAN,
        teamId,
        overrides: { limits: { maxMembers: 3 } },
        expectedConfigRevision: before,
      })
      const after = runtime.state.teams.get(teamId)!.configRevision
      assert.equal(after, 2)
      assert.equal(runtime.state.teamConfigs.get(teamId)!.values.limits.maxMembers, 3)
      assert.equal(runtime.state.teamConfigs.get(teamId)!.values.gates.requireEvidence, true, '未覆盖项保持默认')

      assert.throws(
        () =>
          rebaseTeamConfigCommand(runtime, {
            actor: HUMAN,
            teamId,
            overrides: { limits: { maxMembers: 2 } },
            expectedConfigRevision: before,
          }),
        (error: unknown) => error instanceof MyTeamError && error.code === 'PRECONDITION_FAILED',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('查询：看板与任务详情来自同一份投影', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-query-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId, memberId } = bootstrap(runtime)
      const a = createTaskCommand(runtime, {
        actor: HUMAN,
        title: '写登录',
        description: '',
        acceptance: ['能登录'],
        ownerTeamId: teamId,
      })
      const aId = (a.events[0]!.payload as { task: { id: string } }).task.id
      const b = createTaskCommand(runtime, {
        actor: HUMAN,
        title: '写登出',
        description: '',
        acceptance: ['能登出'],
        ownerTeamId: teamId,
        dependencies: [aId],
      })
      const bId = (b.events[0]!.payload as { task: { id: string } }).task.id

      const board = boardView(runtime.state)
      assert.equal(board.totals.all, 2)
      assert.equal(board.columns.find((column) => column.status === 'ready')!.count, 1)
      assert.equal(board.columns.find((column) => column.status === 'planned')!.count, 1)
      assert.equal(board.columns.find((column) => column.status === 'planned')!.tasks[0]!.blockedBy[0], aId)

      const detail = taskDetail(runtime.state, bId)
      assert.equal(detail.task.title, '写登出')
      assert.equal(detail.team!.id, teamId)
      assert.deepEqual(detail.dependencies.map((item) => item.taskId), [aId])
      assert.equal(detail.dependencies[0]!.status, 'ready')
      assert.deepEqual(detail.dependents, [])

      const overview = teamView(runtime.state, teamId)
      assert.equal(overview.team.id, teamId)
      assert.equal(overview.members.length, 1)
      assert.equal(overview.members[0]!.id, memberId)
      assert.equal(overview.captain!.generation, 1)
      assert.equal(overview.tasks.length, 2)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})