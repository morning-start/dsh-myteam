import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GateVerdict, Task } from '../src/contracts/entities.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { authorize, can, isHumanOnly } from '../src/domain/permissions/policy.ts'
import {
  assertTransition,
  createPlannedTask,
  evaluateTaskCompletion,
  nextAttemptGeneration,
  TASK_TRANSITIONS,
} from '../src/domain/tasks/task.ts'
import {
  SAFETY_LIMITS,
  clampToSafety,
  computeEffectiveConfig,
  configContentHash,
  DEFAULT_TEAM_CONFIG,
  isSnapshotConsistent,
} from '../src/domain/config/merge.ts'

const NOW = '2026-01-01T00:00:00.000Z'

function task(overrides: Partial<Task> = {}): Task {
  return {
    ...createPlannedTask({
      id: 'task_00000001',
      title: '实现登录',
      description: '',
      acceptance: ['能登录'],
      ownerTeamId: 'team_00000001',
      dependencies: [],
      gate: { commands: [], requireEvidence: true, requireArtifacts: false },
      now: NOW,
    }),
    status: 'review',
    attemptId: 'att_00000001',
    ...overrides,
  }
}

function verdict(overrides: Partial<GateVerdict> = {}): GateVerdict {
  return {
    id: 'gd_00000001',
    taskId: 'task_00000001',
    attemptId: 'att_00000001',
    outcome: 'pass',
    checks: [],
    evidence: [{ kind: 'command', ref: 'npm test', excerpt: '42 passed' }],
    decidedAt: NOW,
    ...overrides,
  }
}

test('任务状态机：合法与非法迁移', () => {
  assert.doesNotThrow(() => assertTransition('ready', 'claimed'))
  assert.doesNotThrow(() => assertTransition('review', 'done'))
  assert.throws(() => assertTransition('planned', 'done'), /不能从/)
  assert.deepEqual(TASK_TRANSITIONS.done, ['ready'])
})

test('完成判定：缺裁决/缺证据/上游未完成都拦住', () => {
  const decision = evaluateTaskCompletion({
    task: task(),
    verdict: null,
    evidence: [],
    artifacts: [],
    blockingDependencies: ['task_00000002'],
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.blockers.some((blocker) => blocker.includes('门禁裁决')))
  assert.ok(decision.blockers.some((blocker) => blocker.includes('上游任务')))
})

test('完成判定：旧 Attempt 的裁决不算', () => {
  const decision = evaluateTaskCompletion({
    task: task(),
    verdict: verdict({ attemptId: 'att_old' }),
    evidence: [],
    artifacts: [],
    blockingDependencies: [],
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.blockers.some((blocker) => blocker.includes('旧 Attempt')))
})

test('完成判定：交付物必须存在且有 hash', () => {
  const withDeliverable = task({ deliverable: { paths: ['docs/a.md'], description: '' } })
  const decision = evaluateTaskCompletion({
    task: withDeliverable,
    verdict: verdict(),
    evidence: [],
    artifacts: [{ path: 'docs/a.md', hash: null, exists: true }],
    blockingDependencies: [],
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.blockers.some((blocker) => blocker.includes('hash')))
})

test('完成判定：全部满足才通过', () => {
  const decision = evaluateTaskCompletion({
    task: task(),
    verdict: verdict(),
    evidence: [],
    artifacts: [],
    blockingDependencies: [],
  })
  assert.deepEqual(decision, { ok: true, blockers: [] })
})

test('Attempt generation 单调递增', () => {
  assert.equal(nextAttemptGeneration(null), 1)
  assert.equal(
    nextAttemptGeneration({
      id: 'att_00000001',
      taskId: 'task_00000001',
      teamId: 'team_00000001',
      memberId: 'mem_00000001',
      generation: 3,
      configRevision: 1,
      roleRevision: 1,
      sessionId: 'ses_00000001',
      status: 'revoked',
      startedAt: NOW,
      endedAt: NOW,
    }),
    4,
  )
})

test('配置：分层合并顺序与钳制', () => {
  const snapshot = computeEffectiveConfig({
    projectDefaults: { limits: { maxMembers: 6 } },
    blueprintDefaults: { limits: { maxMembers: 5 }, gates: { requireArtifacts: false } },
    teamOverrides: { limits: { maxMembers: 99 }, gates: { requireEvidence: false } },
    configRevision: 7,
    sources: { projectDefaultsRevision: 2, blueprintRevision: 3, teamOverridesRevision: 1 },
  })
  // 团队覆盖 > 蓝图默认 > 项目默认；再被安全上限钳制。
  assert.equal(snapshot.values.limits.maxMembers, SAFETY_LIMITS.maxMembersPerTeam)
  assert.deepEqual(snapshot.clamped, [
    { field: 'limits.maxMembers', requested: 99, applied: SAFETY_LIMITS.maxMembersPerTeam },
  ])
  assert.equal(snapshot.values.gates.requireEvidence, false)
  assert.equal(snapshot.values.gates.requireArtifacts, false)
  assert.ok(isSnapshotConsistent(snapshot))
})

test('配置：未知键报错而不是静默忽略', () => {
  assert.throws(
    () =>
      computeEffectiveConfig({
        projectDefaults: {},
        blueprintDefaults: null,
        teamOverrides: { limits: { maxMember: 3 } } as never,
        configRevision: 1,
        sources: { projectDefaultsRevision: 0, blueprintRevision: null, teamOverridesRevision: 1 },
      }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_PAYLOAD',
  )
})

test('配置：hash 只覆盖生效值', () => {
  const left = clampToSafety(DEFAULT_TEAM_CONFIG).values
  const right = clampToSafety(DEFAULT_TEAM_CONFIG).values
  assert.equal(configContentHash(left), configContentHash(right))
})

test('授权：人类专属动作不能由 agent 发起', () => {
  const captain: ActorRef = { kind: 'captain', teamId: 'team_00000001', sessionId: 'ses_00000001', generation: 1 }
  assert.throws(
    () => authorize('definition.publish.confirm', captain),
    (error: unknown) => error instanceof MyTeamError && error.code === 'HUMAN_ONLY',
  )
  assert.equal(isHumanOnly('definition.publish.confirm'), true)
  assert.equal(can('task.create', captain), true)
  assert.equal(can('migration.cutover', captain), false)
})

test('授权：成员只能提交自己的 Attempt，且不能建任务', () => {
  const member: ActorRef = {
    kind: 'member',
    teamId: 'team_00000001',
    memberId: 'mem_00000001',
    sessionId: 'ses_00000001',
    memberSessionGeneration: 1,
    attemptId: 'att_00000001',
  }
  assert.throws(
    () => authorize('task.create', member, { teamId: 'team_00000001' }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'FORBIDDEN',
  )
  assert.doesNotThrow(() => authorize('task.progress', member, { teamId: 'team_00000001', attemptMemberId: 'mem_00000001' }))
  assert.throws(
    () => authorize('task.progress', member, { teamId: 'team_00000001', attemptMemberId: 'mem_00000002' }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'FORBIDDEN',
  )
  assert.throws(
    () => authorize('task.progress', member, { teamId: 'team_00000002' }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'FORBIDDEN',
  )
})

test('授权：队长不能操作别的团队', () => {
  const captain: ActorRef = { kind: 'captain', teamId: 'team_00000001', sessionId: 'ses_00000001', generation: 1 }
  assert.throws(
    () => authorize('task.create', captain, { teamId: 'team_00000002' }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'FORBIDDEN',
  )
})