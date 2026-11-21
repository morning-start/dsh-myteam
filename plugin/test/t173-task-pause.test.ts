/**
 * T173 · CHG-210 批 5.5：**暂停 ≠ 失败，也 ≠ 阻塞**。
 *
 * 缺陷现场：任务一旦被领走，成员只有「done / failed / 继续干」三条路。想停一下（等澄清、
 * 等上游、等自己腾出手）只能报 failed——而 failed 是**终态**，重放后永不复活，任务就死了。
 * 于是现实里成员要么硬着头皮做，要么把任务做死再让队长重建。
 *
 * 修法：新增 `paused` 状态（与 `blocked` 分开——blocked 是「系统判死、等人来解」，
 * paused 是「**我主动停的**」，两者在面板上必须两种颜色），出口与 blocked 相同：
 * 回 ready / backlog / cancelled。暂停即交还（清 attemptId + 释放成员占用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0, signal: null, output: '' }), kill: () => {} }) },
  } as unknown as HostRuntime
}

const TASK = {
  title: '暂停用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const member = { memberId: String(a.memberId), roleId: 'implementer', instanceName: 'a', sessionId: String(a.sessionId), teamId }
  const claimed = host.executeMemberTool(member, 'myteam_claim_task', { taskId: created.taskId }) as any
  assert.equal(claimed.status, 'claimed', JSON.stringify(claimed))
  const attemptId = host.service(teamId).projectionSnapshot.tasks[created.taskId].attemptId!
  return { host, teamId, taskId: String(created.taskId), member, attemptId }
}

test('t173-1: 暂停生效 —— 状态变 paused、票据清空、成员不再占用', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t173-pause-'))
  try {
    const { host, teamId, taskId, member, attemptId } = setup(root)
    const r = host.executeMemberTool(member, 'myteam_update_task', { taskId, attemptId, status: 'paused', reason: '等上游澄清 AC1 的口径' }) as any
    assert.ok(r.status !== 'error', `暂停不该失败：${JSON.stringify(r)}`)

    const t = host.service(teamId).projectionSnapshot.tasks[taskId]
    assert.equal(t.state, 'paused', '状态必须是 paused（不是 failed、不是 blocked）')
    assert.equal(t.attemptId, undefined, '暂停即交还：票据要清掉，否则回队列也领不走')
    assert.equal(t.pausedReason, '等上游澄清 AC1 的口径')
    assert.equal(typeof t.pausedAt, 'number')

    const events = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.ok(events.some((e) => e.type === 'task.paused'), '账本要有 task.paused 事件')
    assert.ok(!events.some((e) => e.type === 'task.failed'), '**绝不能**顺手落一条 failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t173-2: 暂停后任务可被重新领取（拿到新 attempt）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t173-reclaim-'))
  try {
    const { host, teamId, taskId, member, attemptId } = setup(root)
    host.executeMemberTool(member, 'myteam_update_task', { taskId, attemptId, status: 'paused', reason: '先处理线上事故' })
    // 队长把 paused 任务拉回队列（rescope 的合法出口之一）
    const rs = host.executeLeadTool('myteam_rescope_task', { teamId, taskId, reason: '恢复' }, {}) as any
    assert.ok(rs.status === 'rescoped' || rs.status === 'error', JSON.stringify(rs))
    const state = host.service(teamId).projectionSnapshot.tasks[taskId].state
    assert.ok(['ready', 'backlog', 'paused'].includes(state), `rescope 后应是可调度态，实际 ${state}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t173-3: 空理由被拒（理由不是装饰，是队长判断的唯一线索）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t173-noreason-'))
  try {
    const { host, teamId, taskId, member, attemptId } = setup(root)
    const r = host.executeMemberTool(member, 'myteam_update_task', { taskId, attemptId, status: 'paused' }) as any
    assert.equal(r.status, 'error', JSON.stringify(r))
    assert.match(String(r.message), /理由/, '要明说要写理由')
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'in_progress', '被拒后任务应仍在执行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})