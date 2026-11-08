/**
 * T92 · CHG-119：计划质量反馈（FR-11.6）——**只读观测，不自动改计划**。
 *
 * 断言：
 *  ① 空投影：计数全 0、口径说明仍在（不造演示数据，同 CHG-107 纪律）；
 *  ② 任务数 / 粒度分布（S/M/L/未填单列）；
 *  ③ estimate vs 实际：终态任务用「终态事件 ts − created」，未终态用 now − created（`running:true`）；
 *  ④ 桶边界：≤4h=S、≤24h=M、其余=L；实际桶 > 估算桶 = 超时；
 *  ⑤ 角色负载：计划数 / 未终态数 / 在册成员数；「有计划无在册」进 notes；
 *  ⑥ 坏事件容错（缺 taskId / ts 非数）不崩；
 *  ⑦ 远程端点 `getPlanFeedback` 返回 `{status:'ok', feedback}` 且只读（不写账本）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bucketOfMs, buildPlanFeedback, ESTIMATE_HOURS } from '../src/remote/plan-feedback.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'

const HOUR = 3_600_000

/** 造一个最小投影（只填纯函数用到的字段） */
function projection(tasks, members = {}) {
  return {
    teamId: 't1',
    state: 'active',
    revision: 1,
    tasks,
    members,
    participations: {},
    proposals: {},
    perTaskMessages: {},
    inbox: [],
  }
}
const task = (id, input, extra = {}) => ({
  id,
  input: { title: `T${id}`, requiredRole: 'developer', ...input },
  state: 'ready',
  gates: [],
  gateVerdicts: {},
  evidenceRefs: [],
  deliverables: [],
  createdAt: 0,
  escalateCount: 0,
  ...extra,
})

test('t92-1: 桶边界（可观测口径）', () => {
  assert.equal(bucketOfMs(0), 'S')
  assert.equal(bucketOfMs(4 * HOUR), 'S')
  assert.equal(bucketOfMs(4 * HOUR + 1), 'M')
  assert.equal(bucketOfMs(24 * HOUR), 'M')
  assert.equal(bucketOfMs(24 * HOUR + 1), 'L')
  assert.equal(bucketOfMs(Number.NaN), 'S', '坏值退化为 S（不抛）')
  assert.deepEqual(ESTIMATE_HOURS, { S: 4, M: 24, L: 72 })
})

test('t92-2: 空投影 —— 全 0 且口径说明仍在（不造演示数据）', () => {
  const view = buildPlanFeedback(projection({}), [], 1000)
  assert.equal(view.teamId, 't1')
  assert.equal(view.caliber, 'heuristic')
  assert.equal(view.tasks.total, 0)
  assert.equal(view.tasks.terminal, 0)
  assert.equal(view.tasks.open, 0)
  assert.deepEqual(view.granularity, { S: 0, M: 0, L: 0, unset: 0 })
  assert.deepEqual(view.roleLoad, [])
  assert.deepEqual(view.deviations, [])
  assert.equal(view.notes.length >= 3, true, '口径说明不随数据为空')
})

test('t92-3: 任务数 / 粒度分布 / 状态计数', () => {
  const proj = projection({
    a: task('a', { estimate: 'S' }),
    b: task('b', { estimate: 'M' }, { state: 'in_progress' }),
    c: task('c', { estimate: 'L' }, { state: 'done' }),
    d: task('d', {}, { state: 'failed' }),
  })
  const view = buildPlanFeedback(proj, [], 10 * HOUR)
  assert.equal(view.tasks.total, 4)
  assert.equal(view.tasks.terminal, 2, 'done + failed 都是终态')
  assert.equal(view.tasks.open, 2)
  assert.deepEqual(view.granularity, { S: 1, M: 1, L: 1, unset: 1 })
  assert.equal(view.tasks.byState.done, 1)
  assert.equal(view.tasks.byState.failed, 1)
})

test('t92-4: estimate vs 实际 —— 终态用终态事件时刻，未终态用 now', () => {
  const proj = projection({
    /* 30h 完成，估算 S → 实际桶 L > S = 超时 */
    over: task('over', { estimate: 'S' }, { state: 'done' }),
    /* 2h 完成，估算 M → 实际桶 S，不算超时 */
    fast: task('fast', { estimate: 'M' }, { state: 'done' }),
    /* 未终态：running，actual = now - created */
    running: task('running', { estimate: 'S' }, { state: 'in_progress' }),
  })
  const events = [
    { type: 'task.created', ts: 0, payload: { taskId: 'over' } },
    { type: 'task.completed', ts: 30 * HOUR, payload: { taskId: 'over' } },
    { type: 'task.completed', ts: 2 * HOUR, payload: { taskId: 'fast' } },
  ]
  const view = buildPlanFeedback(proj, events, 6 * HOUR)
  const byId = new Map(view.deviations.map((row) => [row.id, row]))
  assert.equal(byId.get('over').actualMs, 30 * HOUR)
  assert.equal(byId.get('over').actualBucket, 'L')
  assert.equal(byId.get('over').overrun, true)
  assert.equal(byId.get('fast').actualMs, 2 * HOUR)
  assert.equal(byId.get('fast').overrun, false)
  assert.equal(byId.get('running').running, true)
  assert.equal(byId.get('running').actualMs, 6 * HOUR, '未终态 = now - created')
  assert.equal(view.overrun.comparable, 3)
  assert.equal(view.overrun.over, 1)
  /* 超时倍数降序：over 在最前 */
  assert.equal(view.deviations[0].id, 'over')
})

test('t92-5: 角色负载 —— 计划 / 未终态 / 在册；无在册进 notes', () => {
  const proj = projection(
    {
      a: task('a', { estimate: 'S', requiredRole: 'developer' }),
      b: task('b', { estimate: 'S', requiredRole: 'developer' }, { state: 'done' }),
      c: task('c', { estimate: 'M', requiredRole: 'reviewer' }),
    },
    {
      m1: { roleId: 'developer', status: 'active' },
      m2: { roleId: 'developer', status: 'suspended' },
      m3: { roleId: 'developer', status: 'released' },
    },
  )
  const view = buildPlanFeedback(proj, [], 1000)
  const dev = view.roleLoad.find((row) => row.roleId === 'developer')
  assert.deepEqual({ planned: dev.planned, open: dev.open, members: dev.members }, { planned: 2, open: 1, members: 2 }, 'released 不计入在册')
  const reviewer = view.roleLoad.find((row) => row.roleId === 'reviewer')
  assert.equal(reviewer.members, 0)
  assert.ok(view.notes.some((note) => note.includes('无在册成员')), '有计划无在册必须提示')
  /* 按计划数降序：developer(2) 在 reviewer(1) 前 */
  assert.equal(view.roleLoad[0].roleId, 'developer')
})

test('t92-6: 坏事件容错（缺 taskId / ts 非数 / 未知类型）不崩', () => {
  const proj = projection({ a: task('a', { estimate: 'S' }, { state: 'done' }) })
  const events = [
    { type: 'task.completed', ts: 100, payload: {} },
    { type: 'task.completed', ts: Number.NaN, payload: { taskId: 'a' } },
    { type: 'task.progress', ts: 5, payload: { taskId: 'a' } },
    null,
  ]
  const view = buildPlanFeedback(proj, events, 1000)
  assert.equal(view.tasks.total, 1)
  assert.equal(view.deviations.length, 1)
  /* 拿不到终态时刻 → 退化为 now - created，不抛错 */
  assert.equal(view.deviations[0].actualMs, 1000)
})

test('t92-7: 远程端点 getPlanFeedback —— 只读返回 {status:ok, feedback}', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t92-'))
  try {
    const rt = {
      set: () => {},
      tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
      agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
      logger: { info: () => {}, warn: () => {} },
      workspace: { root },
    } as unknown as HostRuntime
    const host = new MyTeamHost(rt)
    host.initialize()
    const remote = new MyTeamRemote(rt as never, host)
    const staged: any = host.executeLeadTool('myteam_submit_plan', {
      teamName: '反馈队',
      goal: 'G',
      tasks: [{
        title: '任务一', description: 'd', acceptanceCriteria: ['AC'],
        deliverableSpec: { path: 'docs/a.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
        deps: [], requiredRole: 'developer', estimate: 'S',
      }],
    }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    const teamId = String(staged.teamId)
    /* 草稿阶段的计划只在 staging 里；批准后才进投影（FR-1.1 Approve & Run） */
    const approved: any = host.executeLeadTool('myteam_approve_plan', { teamId }, {})
    assert.ok(approved.status === 'ok' || approved.status === 'approved', JSON.stringify(approved))
    const feedback: any = await remote.getPlanFeedback({ teamId })
    assert.equal(feedback.status, 'ok')
    assert.equal(feedback.feedback.teamId, teamId)
    assert.equal(feedback.feedback.tasks.total, 1)
    assert.equal(feedback.feedback.granularity.S, 1)
    assert.ok(Array.isArray(feedback.feedback.roleLoad))
    /* 只读：连调两次结果一致（没有副作用） */
    const again: any = await remote.getPlanFeedback({ teamId })
    assert.equal(again.feedback.tasks.total, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
