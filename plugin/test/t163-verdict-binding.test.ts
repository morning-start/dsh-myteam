/**
 * T163 · CHG-210 批 3.3：**裁决绑字节**——旧结论不能自动继承到新一世的产物上。
 *
 * 缺陷现场：`task.gate.result` 落账后 `gateVerdicts` / `gateResults` 常驻投影，而
 * `task.claimed`（新 attempt）**从不清空它们**。于是：
 *   ① 上一世过的 review 留在投影里，面板显示「已过审」——当前产物根本没被看过；
 *   ② 交付判定若读这两个字段，就会拿旧结论放行新代码。
 *
 * 参考项目 NM 用 `reviewedAttempt` 把裁决钉在被审的那一世；本项目的对应修法：
 *   - `task.gate.result` 载荷记 `reviewedAttempt`（审计能回答「过的是哪一版」）；
 *   - `task.claimed` 开新 attempt 时**清空旧裁决**；
 *   - **不清** `gateRejects`（打回预算是跨轮累计的成本闸，清了正好帮刷轮数的人）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

const TASK = {
  title: '裁决绑字节用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }, { roleId: 'reviewer' }], tasks: [],
  }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const b = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'reviewer', instanceName: 'b' }, {}) as any
  const as = (m: any) => ({ memberId: String(m.memberId), roleId: String(m.roleId), instanceName: String(m.instanceName ?? m.memberId), sessionId: String(m.sessionId), teamId })
  return { host, teamId, taskId: String(created.taskId), a: as(a), b: as(b) }
}

/** 走一次完整的「实现到 done 申报」，返回当时那一代的 attemptId */
function runToReview(host: MyTeamHost, teamId: string, taskId: string, a: any) {
  assert.equal((host.executeMemberTool(a, 'myteam_claim_task', { taskId }) as any).status, 'claimed')
  const attemptId = host.service(teamId).projectionSnapshot.tasks[taskId].attemptId!
  host.commit(teamId, { actor: `member:${a.memberId}`, type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: { kind: 'na', na: { reason: '手工核对' } } } })
  const done = host.executeMemberTool(a, 'myteam_update_task', { taskId, attemptId, status: 'done', progress: '完成' }) as any
  assert.equal(done.status, 'completed', JSON.stringify(done)) // 申报 done 成功
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')
  return attemptId
}

test('t163-1: review pass 记下被审的那一代 attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t163-bind-'))
  try {
    const { host, teamId, taskId, a, b } = setup(root)
    const attemptId = runToReview(host, teamId, taskId, a)
    const r = host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: b.memberId, reason: '看过' }, {}) as any
    assert.ok(r.status === 'gate-pass' || r.status === 'gate-fail', JSON.stringify(r))
    const g = host.service(teamId).projectionSnapshot.tasks[taskId].gateResults?.review
    assert.equal(g?.verdict, 'pass')
    assert.equal(g?.reviewedAttempt, attemptId, '必须记下这一版的 attemptId（审计要能回答「过的是哪一版」）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t163-2: 开新 attempt 后旧裁决作废（不能拿旧 pass 过新产物）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t163-reset-'))
  try {
    const { host, teamId, taskId, a, b } = setup(root)
    runToReview(host, teamId, taskId, a)
    host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: b.memberId, reason: '看过' }, {})
    assert.ok(host.service(teamId).projectionSnapshot.tasks[taskId].gateResults?.review, '先确认旧裁决在')

    // 重规划 → 撤 attempt → 回 ready；再 claim = 新一世
    const rescope = host.executeLeadTool('myteam_rescope_task', { teamId, taskId, reason: '定义要改' }, {}) as any
    assert.equal(rescope.status, 'rescoped', JSON.stringify(rescope))
    assert.equal((host.executeMemberTool(a, 'myteam_claim_task', { taskId }) as any).status, 'claimed')

    const after = host.service(teamId).projectionSnapshot.tasks[taskId]
    assert.equal(after.gateResults?.review, undefined, '新 attempt 必须清掉旧 review 裁决')
    assert.notEqual(after.attemptId, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t163-3: 打回预算不清（跨轮累计是成本闸，清了等于帮刷轮数）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t163-budget-'))
  try {
    const { host, teamId, taskId, a, b } = setup(root)
    runToReview(host, teamId, taskId, a)
    const fail = host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'fail', reviewerMemberId: b.memberId, reason: 'AC1 没覆盖' }, {}) as any
    assert.equal(fail.status, 'gate-fail', JSON.stringify(fail))
    const rejectsBefore = host.service(teamId).projectionSnapshot.tasks[taskId].gateRejects?.review
    assert.equal(rejectsBefore, 1)

    // 任务被放回 ready，重新 claim = 新一世；打回轮数必须还在
    if ((host.executeMemberTool(a, 'myteam_claim_task', { taskId }) as any).status === 'claimed') {
      assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].gateRejects?.review, 1, '打回轮数跨轮累计，不得被 claim 清掉')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
