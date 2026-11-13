/**
 * T130 · CHG-158（报告 A5）：attempt 四字段**接线** —— 从「零写入方」到「账本 → 投影」全链路。
 *
 * 为什么必须补这一层：CHG-152 拆出了 `attempt` / `handoffId` / `reassigning` / `parkedAttempts`
 * 四个字段 + `attemptPhase` 五态判定，但**没有任何事件携带它们**，fold 也不折叠。结果是
 * `handoff` / `reassigning` / `parked` 三个态**永远到不了**——「零件造好了没装上车」。
 *
 * 接线纪律（这三条不成立，接线就是错的）：
 *  ① **fold 只读 payload，绝不生成**：`randomUUID()` 会让同一本账本两次重放得出不同投影，
 *     `attempt` 自增在事件被裁剪/跳号时也会分叉。世代号与票据都由**写入方**给。
 *  ② **向后兼容**：老账本没有这些字段 → 缺省（`undefined` / 空对象），重放结果逐字不变，
 *     且不得变成非法事件（`PAYLOAD_REQUIRED` 故意不登记它们，见 `core/ledger/ledger.ts`）。
 *  ③ **停放记录是普通对象不是 `Map`**：`Map` 能 `structuredClone`，但 `JSON.stringify` 恒为 `{}`
 *     ——面板 RPC / 导出 / 日志会把停放记录静默丢光。
 *
 * 五态的**生命周期**（与 `recovery.ts` 的 `attemptPhase` 注释逐条对应）：
 *   idle ──claim──► claimed ──revoke(reassign)──► reassigning ──assigned──► handoff ──claim──► claimed
 *                      └──revoke(plain)──► parked ──claim──► claimed
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'
import { attemptPhase, recoveryAction, type TaskRuntimeFacts } from '../src/core/scheduler/recovery.ts'
import type { TaskProjection, TeamProjection } from '../src/core/scheduler/state.ts'

const TEAM = 'team-a'

type Draft = { type: string; payload: Record<string, unknown> }

/** 草稿 → 账本事件（seq 连续、ts 单调；重放只看这两个结构字段） */
function foldDrafts(drafts: Draft[]): TeamProjection {
  let seq = 0
  const events: LedgerEvent[] = drafts.map((draft) => {
    seq += 1
    return { seq: seq - 1, ts: 1000 + seq, actor: 'test', type: draft.type as LedgerEvent['type'], payload: draft.payload }
  })
  return foldEvents(TEAM, events)
}

const taskInput = (over: Record<string, unknown> = {}) => ({
  title: '任务',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deps: [],
  requiredRole: 'dev',
  priority: 'P2',
  ...over,
})

const created = (taskId: string, over: Record<string, unknown> = {}): Draft => ({
  type: 'task.created',
  payload: { teamId: TEAM, taskId, task: taskInput(over) },
})

const claimed = (taskId: string, generation: number, over: Record<string, unknown> = {}): Draft => ({
  type: 'task.claimed',
  payload: { teamId: TEAM, taskId, memberId: 'm1', attemptId: `at-${generation}`, attempt: generation, ...over },
})

const revoked = (taskId: string, attemptId: string, reason: string, over: Record<string, unknown> = {}): Draft => ({
  type: 'task.attempt.revoked',
  payload: { teamId: TEAM, taskId, attemptId, reason, prevAssignee: 'm1', ...over },
})

const assigned = (taskId: string, over: Record<string, unknown> = {}): Draft => ({
  type: 'task.assigned',
  payload: { teamId: TEAM, taskId, memberId: 'm1', ...over },
})

const BASE: Draft[] = [
  { type: 'team.created', payload: { teamId: TEAM, name: 'T', goal: 'G' } },
  { type: 'plan.approved', payload: { teamId: TEAM, planId: 'p1' } },
  { type: 'member.spawned', payload: { teamId: TEAM, memberId: 'm1', roleId: 'dev', sessionId: 's1', status: 'active', parentMemberId: null, depth: 0, rootMemberId: 'm1' } },
]

/** 投影任务 → 阶段判定输入（`memberLive` 由调用方给：它是宿主事实，不在账本里） */
const factsOf = (t: TaskProjection, memberLive = true): TaskRuntimeFacts => ({
  state: t.state,
  attemptId: t.attemptId,
  assignee: t.assignee,
  attempt: t.attempt,
  handoffId: t.handoffId,
  reassigning: t.reassigning,
  parkedAttempts: t.parkedAttempts,
  memberLive,
})

/* ── 1. 世代号（attempt）────────────────────────────────────────── */

test('t129-1: 世代号 —— claim 后 = 1，撤权后再 claim = 2；同一账本两次重放深相等', () => {
  const first = foldDrafts([...BASE, created('k1'), claimed('k1', 1)])
  assert.equal(first.tasks.k1.attempt, 1, '首次 claim = 第 1 代')
  assert.equal(first.tasks.k1.attemptId, 'at-1', '能力票据仍按旧口径落投影')

  const drafts = [...BASE, created('k1'), claimed('k1', 1), revoked('k1', 'at-1', '换人重派'), claimed('k1', 2)]
  const proj = foldDrafts(drafts)
  assert.equal(proj.tasks.k1.attempt, 2, '重派后的 claim = 第 2 代（只增不减）')
  assert.equal(proj.tasks.k1.attemptId, 'at-2')
  // 重放确定性：同一本账本两次 fold 必须深相等（fold 里自增 / 生成随机 id 都会破坏这一点）
  assert.deepEqual(foldDrafts(drafts), proj)
})

/* ── 2. 重派标记（reassigning）──────────────────────────────────── */

test('t129-2: `reassign:true` 的撤销 → reassigning = true；下一次 claim 清掉（重派完成）', () => {
  const reassigning = foldDrafts([
    ...BASE,
    created('k1'),
    claimed('k1', 1),
    revoked('k1', 'at-1', '交接给新持有人', { reassign: true, handoffId: 'ho-1' }),
  ]).tasks.k1
  assert.equal(reassigning.reassigning, true, '重派中：调度器不得派单')
  assert.equal(reassigning.attemptId, undefined, '旧 attempt 已撤权')
  assert.equal(reassigning.handoffId, 'ho-1', '交接票据随重派落投影')
  assert.equal(attemptPhase(factsOf(reassigning)), 'reassigning')

  const reclaimed = foldDrafts([
    ...BASE,
    created('k1'),
    claimed('k1', 1),
    revoked('k1', 'at-1', '交接给新持有人', { reassign: true, handoffId: 'ho-1' }),
    claimed('k1', 2),
  ]).tasks.k1
  assert.equal(reclaimed.reassigning, undefined, 'claim = 重派完成，闸门落下')
  assert.equal(reclaimed.handoffId, undefined, '交接落地：票据失效（保留会让阶段永远停在 handoff）')
  assert.equal(attemptPhase(factsOf(reclaimed)), 'claimed')
})

/* ── 3. 停放记录（parkedAttempts）───────────────────────────────── */

test('t129-3: parkedAttempts 累积记录每次停放原因（含重派：重派先撤权）', () => {
  const proj = foldDrafts([
    ...BASE,
    created('k1'),
    claimed('k1', 1),
    revoked('k1', 'at-1', 'recovery: 成员不在'),
    claimed('k1', 2),
    revoked('k1', 'at-2', 'captain parked'),
  ])
  assert.deepEqual(
    proj.tasks.k1.parkedAttempts,
    { 'at-1': 'recovery: 成员不在', 'at-2': 'captain parked' },
    '每次停放都留痕（累积，不覆盖历史）',
  )
  assert.equal(attemptPhase(factsOf(proj.tasks.k1)), 'parked', '没有活跃 attempt + 有停放记录 → parked')

  // 重派同样留停放记录（重派先撤权，那次 attempt 也是「被撤下的」），但阶段由 reassigning 表达：
  // 陈旧停放记录不得把「正在交接」盖成「已停」，否则调度器会把它当人工停下的任务不再派单
  const reassigned = foldDrafts([
    ...BASE,
    created('k2'),
    claimed('k2', 1),
    revoked('k2', 'at-1', '交接', { reassign: true, handoffId: 'ho-2' }),
  ])
  assert.deepEqual(reassigned.tasks.k2.parkedAttempts, { 'at-1': '交接' }, '每次撤销都留痕（含重派）')
  assert.equal(attemptPhase(factsOf(reassigned.tasks.k2)), 'reassigning', '停放记录是历史，阶段是重派中')
})

/* ── 4. 交接票据（handoffId）────────────────────────────────────── */

test('t129-4: handoffId 从 payload 折叠 —— 给什么就是什么，不给就是缺省（不发明）', () => {
  const withTicket = foldDrafts([...BASE, created('k1'), assigned('k1', { handoffId: 'ho-session-42' })]).tasks.k1
  assert.equal(withTicket.handoffId, 'ho-session-42', 'fold 只赋值，不生成随机票据')
  assert.equal(attemptPhase(factsOf(withTicket)), 'handoff', '票据已发、下一次 attempt 未开始')

  const noTicket = foldDrafts([...BASE, created('k2'), assigned('k2')]).tasks.k2
  assert.equal(noTicket.handoffId, undefined, '载荷没给 → 投影缺省')
})

/* ── 5. 向后兼容（老账本）──────────────────────────────────────── */

test('t129-5: 老账本（无新字段）重放不报错，四字段取缺省', () => {
  const legacyClaim: Draft = {
    type: 'task.claimed',
    payload: { teamId: TEAM, taskId: 'k1', memberId: 'm1', attemptId: 'at-legacy' },
  }
  let proj: TeamProjection | undefined
  assert.doesNotThrow(() => {
    proj = foldDrafts([...BASE, created('k1'), legacyClaim])
  })
  const t = proj!.tasks.k1
  assert.equal(t.attemptId, 'at-legacy')
  assert.equal(t.attempt, undefined, '缺省 = 未接线（不是 0 也不是 1）')
  assert.equal(t.handoffId, undefined)
  assert.equal(t.reassigning, undefined)
  assert.equal(t.parkedAttempts, undefined)
  assert.equal(attemptPhase(factsOf(t)), 'claimed')

  // 老撤销事件（只有既有字段）仍然能重放：停放记录由 attemptId + reason 推导，不需要新字段
  const legacyRevoked = foldDrafts([
    ...BASE,
    created('k1'),
    legacyClaim,
    { type: 'task.attempt.revoked', payload: { teamId: TEAM, taskId: 'k1', attemptId: 'at-legacy', reason: 'old ledger' } },
  ])
  assert.deepEqual(legacyRevoked.tasks.k1.parkedAttempts, { 'at-legacy': 'old ledger' })
  assert.equal(legacyRevoked.tasks.k1.reassigning, undefined, '老账本没有重派标记 → 缺省')
})

/* ── 6. 五态在真实 fold 投影上逐个可达 ─────────────────────────── */

test('t129-6: attemptPhase 五态在真实 fold 出来的投影上逐个可达', () => {
  const idle = foldDrafts([...BASE, created('k1')]).tasks.k1
  assert.equal(attemptPhase(factsOf(idle)), 'idle')

  const claimedTask = foldDrafts([...BASE, created('k1'), claimed('k1', 1)]).tasks.k1
  assert.equal(attemptPhase(factsOf(claimedTask)), 'claimed')

  const reassigningTask = foldDrafts([
    ...BASE,
    created('k1'),
    claimed('k1', 1),
    revoked('k1', 'at-1', '交接', { reassign: true, handoffId: 'ho-1' }),
  ]).tasks.k1
  assert.equal(attemptPhase(factsOf(reassigningTask)), 'reassigning')

  // 排空完成（task.assigned）= 闸门落下 → 阶段回落到 handoff（票据还在、新 attempt 未开始）
  const handoffTask = foldDrafts([
    ...BASE,
    created('k1'),
    claimed('k1', 1),
    revoked('k1', 'at-1', '交接', { reassign: true, handoffId: 'ho-1' }),
    assigned('k1'),
  ]).tasks.k1
  assert.equal(attemptPhase(factsOf(handoffTask)), 'handoff')

  const parkedTask = foldDrafts([...BASE, created('k1'), claimed('k1', 1), revoked('k1', 'at-1', '停')]).tasks.k1
  assert.equal(attemptPhase(factsOf(parkedTask)), 'parked')
})

/* ── 7. recoveryAction 对既有 facts 逐条不变 ───────────────────── */

test('t129-7: recoveryAction 对既有 facts 的判定结果与 t8 恢复表逐条一致（接线不改既有行为）', () => {
  const cases: Array<[TaskRuntimeFacts, ReturnType<typeof recoveryAction>]> = [
    [{ state: 'in_progress', attemptId: 'a', assignee: 'm1', memberLive: true }, { kind: 're-activate-in-place' }],
    [{ state: 'in_progress', attemptId: 'a', assignee: 'm1', memberLive: false }, { kind: 're-activate-new-attempt' }],
    [{ state: 'in_progress', memberLive: false }, { kind: 'to-blocked' }],
    [{ state: 'ready', memberLive: false }, { kind: 'noop' }],
    [{ state: 'backlog', memberLive: false }, { kind: 'noop' }],
    [{ state: 're-scoping', memberLive: false }, { kind: 'noop' }],
    [{ state: 'done', memberLive: false }, { kind: 'noop' }],
    [{ state: 'failed', memberLive: false }, { kind: 'noop' }],
    [{ state: 'cancelled', memberLive: false }, { kind: 'noop' }],
    [{ state: 'gate:review', attemptId: 'a', memberLive: false }, { kind: 're-activate-new-attempt' }],
    [{ state: 'gate:verify', memberLive: true }, { kind: 're-activate-in-place' }],
    [{ state: 'gate:archive', memberLive: false }, { kind: 're-activate-new-attempt' }],
  ]
  cases.forEach(([facts, expected], index) => {
    assert.deepEqual(recoveryAction(facts), expected, `恢复表第 ${index} 条（${facts.state}）`)
  })
})

/* ── 8. 克隆 / 序列化（防 Map 回归）────────────────────────────── */

test('t129-8: parkedAttempts 经 structuredClone + JSON 往返不丢（Map 会被 JSON 静默吞掉）', () => {
  const proj = foldDrafts([
    ...BASE,
    created('k1'),
    claimed('k1', 1),
    revoked('k1', 'at-1', 'r1'),
    claimed('k1', 2),
    revoked('k1', 'at-2', 'r2'),
  ])
  const expected = { 'at-1': 'r1', 'at-2': 'r2' }
  // `TeamService.commit` 用 structuredClone 做副本——新字段必须跟着走
  assert.deepEqual(structuredClone(proj).tasks.k1.parkedAttempts, expected)
  // 面板 RPC / 导出走 JSON——普通对象保真
  const json = JSON.parse(JSON.stringify(proj)) as TeamProjection
  assert.deepEqual(json.tasks.k1.parkedAttempts, expected)
  assert.equal(json.tasks.k1.attempt, 2)
  // 为什么不用 Map：能克隆、但序列化恒为 `{}` —— 停放记录会在跨层时静默丢光
  assert.deepEqual(JSON.parse(JSON.stringify(new Map([['at-1', 'r1']]))), {})
})
