/**
 * CHG-78（真实宿主实弹）：终态任务不再接收成员上报。
 *
 * 实测缺陷（`--profile myteam-desktop-verify` + 真实成员 agent）：
 *   task-1 完成后，成员在同一 attempt 里又报了一次 evidence + completed，
 *   账本出现两对 `task.evidence` / `task.completed`（seq 11/12 与 14/15）。
 *   根因：折叠后终态仍保留 attemptId，旧 checkAttempt 只比 attemptId → 通过。
 *
 * 口径：终态（done/failed/cancelled）任务的任何重开只能走 rescope / 新建任务，
 *       成员上报（progress / evidence / completed / failed / escalated）一律 MT_TASK_TERMINAL。
 *
 * 覆盖：
 *   1) 完成后重报 evidence / completed / progress → MT_TASK_TERMINAL，账本不增长、投影不变；
 *   2) 取消后重报同样被拒（取消是终态）；
 *   3) 失败后重报被拒；
 *   4) 非终态任务的正常上报不受影响（回归保护）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService } from '../src/core/service.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t54-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  return { ws, service }
}

const task = (over: Record<string, unknown> = {}) => ({
  title: 't', description: 'd', acceptanceCriteria: ['ac'],
  deliverableSpec: { path: 'docs/x.md' }, deps: [],
  requiredRole: 'implementer', priority: 'P2' as const,
  gateChain: ['review'], ...over,
})

const ledgerLines = (service: TeamService) => readFileSync(service.ledgerPath, 'utf8').trim().split('\n').length

function step(service: TeamService, draft: Parameters<TeamService['commit']>[0]) {
  const r = service.commit(draft)
  assert.equal(r.ok, true, `${draft.type} should commit: ${JSON.stringify(r)}`)
  return r
}

/** 走到「团队 active + 任务已领取」，返回 service 供各用例继续推进 */
function teamWithClaimedTask(service: TeamService, taskId = 'k1') {
  step(service, { actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } })
  step(service, {
    actor: 'lead', type: 'team.created',
    payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] },
  })
  step(service, {
    actor: 'host', type: 'member.spawned',
    payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', instanceName: 'dev', sessionId: 's1', status: 'active' },
  })
  step(service, { actor: 'lead', type: 'plan.staged', payload: { teamId: 't1', planId: 'p1' } })
  step(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId, task: task() } })
  step(service, { actor: 'human', type: 'plan.approved', payload: { teamId: 't1', planId: 'p1' } })
  step(service, { actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId, memberId: 'm1', attemptId: 'a1' } })
}

const EVIDENCE = { kind: 'na', na: { reason: 'no archive' } } as const

/** 完成 → 走完门禁链 → done（completed 只是「实现完成」，门禁通过才是终态） */
function completeWithGates(service: TeamService, gate: string, taskId = 'k1') {
  step(service, { actor: 'm1', type: 'task.evidence', payload: { teamId: 't1', taskId, attemptId: 'a1', evidence: { ...EVIDENCE } } })
  step(service, { actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId, attemptId: 'a1' } })
  step(service, { actor: 'm1', type: 'task.gate.result', payload: { teamId: 't1', taskId, gate, verdict: 'pass' } })
}

test('t54-1: 完成后重报 evidence/completed/progress 一律 MT_TASK_TERMINAL，账本不增长', () => {
  const { service } = setup()
  teamWithClaimedTask(service)
  completeWithGates(service, 'review')

  const before = ledgerLines(service)
  const refsBefore = service.projectionSnapshot.tasks.k1.evidenceRefs.length
  assert.equal(service.projectionSnapshot.tasks.k1.state, 'done')

  for (const draft of [
    { actor: 'm1', type: 'task.evidence', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { ...EVIDENCE } } },
    { actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1' } },
    { actor: 'm1', type: 'task.progress', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', note: 'again' } },
  ] as Parameters<TeamService['commit']>[0][]) {
    const r = service.commit(draft)
    assert.equal(r.ok, false, `${draft.type} on done task must be rejected`)
    assert.equal((r as { code?: string }).code, 'MT_TASK_TERMINAL')
  }
  assert.equal(ledgerLines(service), before, '被拒的上报不得落账')
  assert.equal(service.projectionSnapshot.tasks.k1.evidenceRefs.length, refsBefore)
})

test('t54-2: 取消后重报同样被拒（cancelled 也是终态）', () => {
  const { service } = setup()
  teamWithClaimedTask(service)
  step(service, { actor: 'lead', type: 'task.cancelled', payload: { teamId: 't1', taskId: 'k1', reason: '换方向' } })
  assert.equal(service.projectionSnapshot.tasks.k1.state, 'cancelled')

  const r = service.commit({
    actor: 'm1', type: 'task.evidence',
    payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { ...EVIDENCE } },
  })
  assert.equal(r.ok, false)
  assert.equal((r as { code?: string }).code, 'MT_TASK_TERMINAL')
})

test('t54-3: 失败后重报被拒（failed 是终态）', () => {
  const { service } = setup()
  teamWithClaimedTask(service)
  step(service, { actor: 'm1', type: 'task.failed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', reason: '卡住' } })
  assert.equal(service.projectionSnapshot.tasks.k1.state, 'failed')

  const r = service.commit({ actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1' } })
  assert.equal(r.ok, false)
  assert.equal((r as { code?: string }).code, 'MT_TASK_TERMINAL')
})

test('t54-4: 非终态任务的正常上报不受影响（回归保护）', () => {
  const { service } = setup()
  teamWithClaimedTask(service)
  step(service, { actor: 'm1', type: 'task.progress', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', note: 'half' } })
  step(service, { actor: 'm1', type: 'task.evidence', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { ...EVIDENCE } } })
  assert.equal(service.projectionSnapshot.tasks.k1.state, 'in_progress')
  step(service, { actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1' } })
  // 门禁未走完 → 不是终态，仍可继续上报（门禁结果 / 复查证据）
  assert.equal(service.projectionSnapshot.tasks.k1.state, 'gate:review')
  step(service, { actor: 'm1', type: 'task.gate.result', payload: { teamId: 't1', taskId: 'k1', gate: 'review', verdict: 'pass' } })
  assert.equal(service.projectionSnapshot.tasks.k1.state, 'done')
})
