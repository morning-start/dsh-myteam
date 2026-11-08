/**
 * T124 · CHG-152（docs/21 §6 P2-2，来源 NM `refs/competitors/dsh-agent-teams/src/types.ts:179-188`）：
 * **attempt 四字段拆分** —— 数据模型 + 纯函数（不做调度接线）。
 *
 * 为什么值得单测：四字段拆分真正的产出不是「多四个字段」，而是**阶段判定唯一**。
 * 字段拆开之后，「当前在干什么」有五种合法组合；任何一处调用方自己写
 * `if (attemptId) … else if (handoffId) …`，顺序一有分歧，同一个任务在不同视图里就是不同阶段
 * （看板说「交接中」、调度器说「已领取」）——这类分叉不报错，只让人做出相反的决定。
 *
 * 三条纪律：
 *  - 五态矩阵 + 优先级（谁压谁）必须穷举，且**顺序即契约**；
 *  - `recoveryAction` 对**既有 facts**（无新字段）逐条不变（把既有恢复表用例原样复制一份跑，防回归）；
 *    CHG-158（报告 A5）接线后 `recoveryAction` 改为经 `attemptPhase` 判定，新字段参与决策——
 *    这条用例锁的是「旧 facts 的结果不变」，t124-4 锁「新字段的映射」；
 *  - 新字段是**投影内存态**：不改账本（40 型不变）、不新增事件。`Map` 能 `structuredClone`
 *    但 `JSON.stringify` 恒为 `{}`（面板 RPC / 导出全走 JSON）——所以 `parkedAttempts` 用普通对象。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'
import { emptyProjection, type TaskProjection } from '../src/core/scheduler/state.ts'
import {
  attemptPhase,
  recoveryAction,
  type AttemptPhase,
  type TaskRuntimeFacts,
} from '../src/core/scheduler/recovery.ts'

/* ── 1. 五态矩阵 ─────────────────────────────────────────────── */

test('t124-1: attemptPhase 五态矩阵 —— 每个字段「单独出现」时对应一个阶段', () => {
  const cases: Array<[string, TaskRuntimeFacts, AttemptPhase]> = [
    ['四字段全空（可调度 / 终态）', { state: 'ready', memberLive: false }, 'idle'],
    [
      '有当前票据（执行中）',
      { state: 'in_progress', attemptId: 'at-1', attempt: 1, assignee: 'm1', memberLive: true },
      'claimed',
    ],
    [
      '有交接票据（撤权已发、下一次 attempt 未开始）',
      { state: 'ready', handoffId: 'ho-1', memberLive: false },
      'handoff',
    ],
    [
      '重派中（交接正在排空旧持有人）',
      { state: 'ready', handoffId: 'ho-1', reassigning: true, memberLive: false },
      'reassigning',
    ],
    [
      '当前 attempt 已停放（等人工 / 重试裁决）',
      { state: 'in_progress', attemptId: 'at-1', parkedAttempts: { 'at-1': 'recovery: no live member' }, memberLive: false },
      'parked',
    ],
  ]
  for (const [label, facts, expected] of cases) {
    assert.equal(attemptPhase(facts), expected, label)
  }
})

/* ── 2. 优先级（顺序即契约）──────────────────────────────────── */

test('t124-2: 优先级 —— 当前停放 > reassigning > handoff > 陈旧停放 > claimed > idle', () => {
  // 四个字段同时为真时，最「不可自动推进」的那个说了算
  const all: TaskRuntimeFacts = {
    state: 'in_progress',
    attemptId: 'at-2',
    attempt: 2,
    assignee: 'm1',
    memberLive: false,
    handoffId: 'ho-2',
    reassigning: true,
    parkedAttempts: { 'at-2': 'parked by recovery', 'at-1': 'older stop' },
  }
  assert.equal(attemptPhase(all), 'parked', '停放 = 已有裁决的停止，压过一切过渡态')
  // 摘掉「当前 attempt 被停放」→ 重派中（交接的子阶段，取更具体的名字）
  assert.equal(attemptPhase({ ...all, parkedAttempts: { 'at-1': 'older stop' } }), 'reassigning')
  // 闸门落下（排空完成）→ 交接票据还在，阶段回落到 handoff
  assert.equal(attemptPhase({ ...all, parkedAttempts: { 'at-1': 'older stop' }, reassigning: false }), 'handoff')
  // 撤权后旧 attemptId 可能还留着——交接世代压过旧票据，不能报 claimed
  assert.equal(
    attemptPhase({ ...all, parkedAttempts: { 'at-1': 'older stop' }, reassigning: false, handoffId: undefined }),
    'claimed',
  )
  // A5 接线后：没有活跃 attempt、只有**历史**停放记录时，重派/交接优先于「已停」
  // （停放记录是更早被撤下的 attempt 的历史，不是当前裁决；压过交接会让「重派中」不可达）
  assert.equal(attemptPhase({ state: 'ready', reassigning: true, parkedAttempts: { 'at-1': 'older stop' } }), 'reassigning')
  assert.equal(attemptPhase({ state: 'ready', handoffId: 'ho-1', parkedAttempts: { 'at-1': 'older stop' } }), 'handoff')
  // 全空 → idle
  assert.equal(attemptPhase({ state: 'done', memberLive: false }), 'idle')
})

/* ── 3. recoveryAction 增字段后逐条不变（旧用例原样复制）────────── */

test('t124-3: recoveryAction 默认值下与旧行为逐条一致（t8 恢复表用例原样复制）', () => {
  const legacyFacts: TaskRuntimeFacts[] = [
    { state: 'in_progress', attemptId: 'a', assignee: 'm1', memberLive: true },
    { state: 'in_progress', attemptId: 'a', assignee: 'm1', memberLive: false },
    { state: 'in_progress', memberLive: false },
    { state: 'ready', memberLive: false },
    { state: 'backlog', memberLive: false },
    { state: 're-scoping', memberLive: false },
    { state: 'done', memberLive: false },
    { state: 'failed', memberLive: false },
    { state: 'cancelled', memberLive: false },
    { state: 'gate:review', attemptId: 'a', memberLive: false },
    { state: 'gate:verify', memberLive: true },
    { state: 'gate:archive', memberLive: false },
  ]
  const expected = [
    { kind: 're-activate-in-place' },
    { kind: 're-activate-new-attempt' },
    { kind: 'to-blocked' },
    { kind: 'noop' },
    { kind: 'noop' },
    { kind: 'noop' },
    { kind: 'noop' },
    { kind: 'noop' },
    { kind: 'noop' },
    { kind: 're-activate-new-attempt' },
    { kind: 're-activate-in-place' },
    { kind: 're-activate-new-attempt' },
  ]
  legacyFacts.forEach((facts, index) => {
    assert.deepEqual(recoveryAction(facts), expected[index], `恢复表第 ${index} 条（${facts.state}）`)
  })
})

test('t124-4: 恢复表按阶段判定（A5 接线后）—— 停放走人工、重派/交接换新 attempt', () => {
  /* CHG-158（报告 A5）改写了这条断言，理由：
   * 拆分当时四字段是「纯内存态」，`recoveryAction` 刻意不消费它们（旧断言 = 加满四字段动作不变）。
   * A5 把「怎么算」改成 `attemptPhase` 优先、`memberLive` 兜底，于是**新字段参与判定**——
   * 旧断言表达的正是「未接线」状态，接线之后必须换成新契约。
   * 既有 facts（无新字段）的判定结果仍逐条不变（t124-3 锁着）。 */
  const parked: TaskRuntimeFacts = { attemptId: 'a', assignee: 'm1', memberLive: true, parkedAttempts: { a: 'captain parked' } }
  assert.deepEqual(recoveryAction({ state: 'in_progress', ...parked }), { kind: 'to-blocked' }, '已停放 = 有裁决的停止 → 引导人工')
  assert.deepEqual(recoveryAction({ state: 'gate:review', ...parked }), { kind: 'to-blocked' }, '门禁态同样不得自动复活')
  const reassigning: TaskRuntimeFacts = { attempt: 2, reassigning: true, handoffId: 'ho-7', memberLive: true }
  assert.deepEqual(
    recoveryAction({ state: 'in_progress', ...reassigning }),
    { kind: 're-activate-new-attempt' },
    '重派中：旧 attempt 已撤权，换新 attempt 接手',
  )
  const handoff: TaskRuntimeFacts = { handoffId: 'ho-7', memberLive: false }
  assert.deepEqual(recoveryAction({ state: 'in_progress', ...handoff }), { kind: 're-activate-new-attempt' }, '待交接：新 attempt 还没开始')
  // idle（四字段全空）→ 旧行为：成员活着原地重激活，否则引导人工
  assert.deepEqual(recoveryAction({ state: 'in_progress', assignee: 'm1', memberLive: true }), { kind: 're-activate-in-place' })
  assert.deepEqual(recoveryAction({ state: 'in_progress', memberLive: false }), { kind: 'to-blocked' })
})

/* ── 4. parkedAttempts 与 attemptId 并存 ───────────────────── */

test('t124-5: parkedAttempts 与 attemptId 并存 —— 只认「当前 attempt」是否被停放', () => {
  // 历史停放 + 新 attempt 已被领取 → claimed（历史不得遮蔽当前）
  assert.equal(
    attemptPhase({ state: 'in_progress', attemptId: 'at-2', attempt: 2, parkedAttempts: { 'at-1': 'older stop' }, memberLive: true }),
    'claimed',
  )
  // 当前 attempt 被停放 → parked
  assert.equal(
    attemptPhase({ state: 'in_progress', attemptId: 'at-2', parkedAttempts: { 'at-2': 'parked' }, memberLive: true }),
    'parked',
  )
  // 没有活跃 attempt 但有停放记录 → parked（等人工裁决，不是 idle）
  assert.equal(attemptPhase({ state: 'blocked', parkedAttempts: { 'at-1': 'older stop' }, memberLive: false }), 'parked')
  // 原型链上的键不能冒充「已停放」（attemptId 来自账本载荷，必须用 hasOwnProperty 判定）
  assert.equal(attemptPhase({ state: 'in_progress', attemptId: 'toString', parkedAttempts: {}, memberLive: true }), 'claimed')
  assert.equal(attemptPhase({ state: 'ready', parkedAttempts: {}, memberLive: false }), 'idle')
})

/* ── 5. 投影内存态：克隆 / 序列化 ───────────────────────────── */

test('t124-6: 新字段随投影 structuredClone 与 JSON 往返保真（Map 会被 JSON 静默吞掉）', () => {
  const projection = emptyProjection('t1')
  const task: TaskProjection = {
    id: 'k1',
    input: {
      title: 't',
      description: 'd',
      acceptanceCriteria: ['ac'],
      deps: [],
      requiredRole: 'dev',
      priority: 'P2',
    },
    state: 'in_progress',
    attempt: 3,
    attemptId: 'at-3',
    handoffId: 'ho-3',
    reassigning: true,
    parkedAttempts: { 'at-1': 'recovery: stale owner', 'at-2': 'captain parked' },
    escalateCount: 0,
    gates: [],
    gateVerdicts: {},
    evidenceRefs: [],
    deliverables: [],
    createdAt: 1,
  }
  projection.tasks.k1 = task
  // `TeamService.commit` 用 structuredClone 做副本——新字段必须跟着走，否则提交一次就丢
  const cloned = structuredClone(projection)
  assert.deepEqual(cloned.tasks.k1, task, 'structuredClone 必须保真')
  // 面板 RPC / 导出走 JSON——普通对象保真
  const json = JSON.parse(JSON.stringify(projection)) as { tasks: Record<string, TaskProjection> }
  assert.deepEqual(json.tasks.k1.parkedAttempts, { 'at-1': 'recovery: stale owner', 'at-2': 'captain parked' })
  assert.equal(json.tasks.k1.attempt, 3)
  assert.equal(json.tasks.k1.handoffId, 'ho-3')
  assert.equal(json.tasks.k1.reassigning, true)
  // 为什么不用 Map：能克隆、但序列化恒为 `{}` —— 停放记录会在跨层时静默丢光
  assert.deepEqual(JSON.parse(JSON.stringify(new Map([['at-1', 'reason']]))), {})
})

/* ── 6. fold 写入路径确认（fold 只读 payload）──────────────────────── */

test('t124-7: fold 只从 payload 读 —— 载荷没给的四字段，投影里就是缺省（不凭空生成）', () => {
  let seq = 0
  const ev = (type: string, payload: Record<string, unknown>): LedgerEvent => ({
    seq: seq++,
    ts: 1000 + seq,
    actor: 'test',
    type: type as LedgerEvent['type'],
    payload,
  })
  const base = [
    ev('team.created', { teamId: 't1', name: 'n', goal: 'g' }),
    ev('plan.approved', { teamId: 't1', planId: 'p1' }),
    ev('member.spawned', { teamId: 't1', memberId: 'm1', roleId: 'dev', sessionId: 's1', status: 'active' }),
    ev('task.created', {
      teamId: 't1',
      taskId: 'k1',
      task: {
        title: 't',
        description: 'd',
        acceptanceCriteria: ['ac'],
        deps: [],
        requiredRole: 'dev',
        priority: 'P2',
      },
    }),
    ev('task.claimed', { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'at-1' }),
  ]
  const claimed = foldEvents('t1', base).tasks.k1
  // 载荷没给 attempt/handoffId/reassign → 投影就是缺省（fold 只从 payload 读，不凭空生成）
  assert.equal(claimed.attemptId, 'at-1', 'task.claimed 写 attemptId')
  assert.equal(claimed.attempt, undefined, 'fold 不生成世代号')
  assert.equal(claimed.handoffId, undefined, 'fold 不发明交接票据（生成随机 id 会破坏重放确定性）')
  assert.equal(claimed.reassigning, undefined)
  assert.equal(claimed.parkedAttempts, undefined)
  assert.equal(attemptPhase({ state: claimed.state, attemptId: claimed.attemptId, memberLive: true }), 'claimed')

  // 撤权 → attemptId 清空（旧行为）；这次撤销进停放记录 → 阶段是 parked（等人工裁决）
  const revoked = foldEvents('t1', [
    ...base,
    ev('task.attempt.revoked', { teamId: 't1', taskId: 'k1', attemptId: 'at-1', reason: 'reassign' }),
  ]).tasks.k1
  assert.equal(revoked.attemptId, undefined, 'task.attempt.revoked 清 attemptId')
  assert.equal(revoked.state, 'ready', '撤权把 in_progress 复位到 ready 重新调度')
  assert.deepEqual(revoked.parkedAttempts, { 'at-1': 'reassign' }, '非重派的撤销进停放记录')
  assert.equal(attemptPhase({ state: revoked.state, attemptId: revoked.attemptId, parkedAttempts: revoked.parkedAttempts, memberLive: false }), 'parked')
})
