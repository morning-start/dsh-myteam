/**
 * T120 · P1-5 单调用护栏四类检测（docs/21 §6 P1-5；来源 TeamFlow `host/core/agent/guard.ts:1-70`、
 * `host/constants.ts:83-108`）。
 *
 * 锁八件事：
 *  ① **四类判据各自可触发**，且各自有「不触发」边界（退出码 0 / 输出无特征 / 时间未到 /
 *     输出变化 / 阈值未到）；
 *  ② **顺序即协议**：同一调用同时满足 env-unavailable 与 repeat 时，env 优先；
 *  ③ `blocksCompletion` 双向：env-unavailable 阻止「完成」放行，其余三类不；
 *  ④ **连续段语义**：换签名清空复读计数、成功调用打断环境失败计数；
 *  ⑤ `stuck` 必须「同输出指纹」+「超过时间窗」两个条件同时成立；
 *  ⑥ `empty-turn` 按回合计数，一次工具调用即清零；
 *  ⑦ 阈值常量可被 `opts` 覆盖，非法覆盖值回落默认（不得静默变成永不触发）；
 *  ⑧ `guardReminder` 文案非空且**每条都含「下一步」**（只写「请注意」的提醒没有可执行性）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUARD_EMPTY_TURN_THRESHOLD,
  GUARD_ENV_THRESHOLD,
  GUARD_REPEAT_THRESHOLD,
  GUARD_STUCK_THRESHOLD,
  GUARD_STUCK_TIMEOUT_MS,
  blocksCompletion,
  createGuardState,
  guardReminder,
  observeCall,
  observeEmptyTurn,
  type GuardCall,
  type GuardVerdict,
} from '../src/core/agent/guard.ts'

/** 构造一次工具调用（缺省字段由用例按需覆盖） */
function toolCall(signature: string, at: number, extra: Partial<GuardCall> = {}): GuardCall {
  return {
    tool: extra.tool ?? 'pwsh',
    signature,
    at,
    ...extra,
  }
}

/** 环境不可用形态：同签名 + 非 0 退出码 + 命中特征的输出（指纹每次不同，避免被 stuck 抢先） */
function envFail(at: number, output = 'bash: nope: command not found', exitCode = 127): GuardCall {
  return toolCall('pwsh|nope', at, { exitCode, output, outputHash: `env-${at}` })
}

test('t120-1: env-unavailable——同签名连续 3 次非 0 退出 + 特征输出 → 触发并给可执行提示', () => {
  const state = createGuardState()
  assert.equal(observeCall(state, envFail(0)), undefined, '第 1 次：未达阈值')
  assert.equal(observeCall(state, envFail(1_000)), undefined, '第 2 次：未达阈值')
  const verdict = observeCall(state, envFail(2_000))
  assert.ok(verdict)
  assert.equal(verdict.kind, 'env-unavailable')
  assert.equal(verdict.count, GUARD_ENV_THRESHOLD)
  assert.match(verdict.message, /环境不可用/)
  assert.match(verdict.message, /command not found/)
  assert.match(verdict.hint, /下一步/)
  // 证据落进状态（latch 的载体），面板/日志可直接展示
  assert.equal(state.envUnavailable?.count, GUARD_ENV_THRESHOLD)
  assert.match(state.envUnavailable?.evidence ?? '', /command not found/)
})

test('t120-2: env-unavailable 不触发边界——exit 0 / 输出无特征 / 成功调用打断连续段', () => {
  const opts = { repeatThreshold: 99 }
  // ① exit 0：输出里出现 command not found 只是日志内容，不是环境故障
  const okState = createGuardState()
  for (const at of [0, 1, 2]) {
    assert.equal(
      observeCall(okState, toolCall('pwsh|nope', at, { exitCode: 0, output: 'command not found', outputHash: `ok-${at}` }), opts),
      undefined,
    )
  }
  // ② 非 0 退出但输出无特征：普通的断言失败，不是环境坏了
  const plainState = createGuardState()
  for (const at of [0, 1, 2]) {
    assert.equal(
      observeCall(plainState, toolCall('pwsh|test', at, { exitCode: 1, output: 'AssertionError: expected 1 to equal 2', outputHash: `p-${at}` }), opts),
      undefined,
    )
  }
  // ③ 中间出现一次成功 → 连续段被打破，后面两次失败也不够阈值
  const resetState = createGuardState()
  assert.equal(observeCall(resetState, envFail(0), opts), undefined)
  assert.equal(observeCall(resetState, envFail(1), opts), undefined)
  assert.equal(observeCall(resetState, toolCall('pwsh|nope', 2, { exitCode: 0, output: '', outputHash: 'ok' }), opts), undefined)
  assert.equal(observeCall(resetState, envFail(3), opts), undefined)
  assert.equal(observeCall(resetState, envFail(4), opts), undefined)
  // ④ 缺输出原文 = 不可判（不猜），不计数
  const blindState = createGuardState()
  for (const at of [0, 1, 2]) {
    assert.equal(observeCall(blindState, toolCall('pwsh|nope', at, { exitCode: 127, outputHash: `b-${at}` }), opts), undefined)
  }
})

test('t120-3: repeat——同签名连续分别达到阈值时触发（第 1、2 次不触发）', () => {
  const state = createGuardState()
  const call = (at: number) => toolCall('read|src/core/service.ts', at)
  assert.equal(observeCall(state, call(0)), undefined)
  assert.equal(observeCall(state, call(1)), undefined)
  const verdict = observeCall(state, call(2))
  assert.ok(verdict)
  assert.equal(verdict.kind, 'repeat')
  assert.equal(verdict.count, GUARD_REPEAT_THRESHOLD)
  assert.match(verdict.message, /复读/)
  assert.match(verdict.message, /连续第 3 次/)
  assert.match(verdict.hint, /下一步/)
})

test('t120-4: repeat 连续段——换签名清空计数（A A B A A 不触发，再来一次才触发）', () => {
  const state = createGuardState()
  const a = (at: number) => toolCall('read|a.ts', at)
  const b = (at: number) => toolCall('read|b.ts', at)
  assert.equal(observeCall(state, a(0)), undefined)
  assert.equal(observeCall(state, a(1)), undefined)
  assert.equal(observeCall(state, b(2)), undefined, 'B 是第 1 次，不能继承 A 的计数')
  assert.equal(observeCall(state, a(3)), undefined, 'A 的新段落从 1 开始')
  assert.equal(observeCall(state, a(4)), undefined, 'A 的新段落第 2 次')
  assert.equal(observeCall(state, a(5))?.kind, 'repeat', 'A 的新段落第 3 次才触发')
})

test('t120-5: stuck——同签名 + 同输出指纹连续 2 次且超过时间窗 → 触发', () => {
  const state = createGuardState()
  const stuck = (at: number) => toolCall('pwsh|sleep 600', at, { outputHash: 'same-hash' })
  assert.equal(observeCall(state, stuck(0), { repeatThreshold: 99 }), undefined, '第 1 次：只有一次同输出')
  const verdict = observeCall(state, stuck(GUARD_STUCK_TIMEOUT_MS + 1), { repeatThreshold: 99 })
  assert.ok(verdict)
  assert.equal(verdict.kind, 'stuck')
  assert.equal(verdict.count, GUARD_STUCK_THRESHOLD)
  assert.match(verdict.message, /挂死/)
  assert.match(verdict.hint, /下一步/)
})

test('t120-6: stuck 不触发边界——时间未到 / 输出变化 / 缺输出指纹', () => {
  // ① 恰好等于时间窗（不是「超过」）→ 不触发
  const boundary = createGuardState()
  const stuck = (at: number, hash = 'same') => toolCall('pwsh|sleep', at, { outputHash: hash })
  assert.equal(observeCall(boundary, stuck(0), { repeatThreshold: 99 }), undefined)
  assert.equal(observeCall(boundary, stuck(GUARD_STUCK_TIMEOUT_MS), { repeatThreshold: 99 }), undefined)
  // ② 输出变化（哪怕还是失败）→ 进程在动，不算挂死
  const changed = createGuardState()
  assert.equal(observeCall(changed, stuck(0, 'h1'), { repeatThreshold: 99 }), undefined)
  assert.equal(observeCall(changed, stuck(GUARD_STUCK_TIMEOUT_MS + 1, 'h2'), { repeatThreshold: 99 }), undefined)
  assert.equal(observeCall(changed, stuck((GUARD_STUCK_TIMEOUT_MS + 1) * 2, 'h3'), { repeatThreshold: 99 }), undefined)
  // ③ 缺输出指纹 = 不可判（不猜「两次都没输出」就是挂死）
  const blind = createGuardState()
  assert.equal(observeCall(blind, toolCall('pwsh|silent', 0), { repeatThreshold: 99 }), undefined)
  assert.equal(observeCall(blind, toolCall('pwsh|silent', GUARD_STUCK_TIMEOUT_MS + 1), { repeatThreshold: 99 }), undefined)
})

test('t120-7: empty-turn——连续 2 个无工具调用回合触发（第 1 个不触发）', () => {
  const state = createGuardState()
  assert.equal(observeEmptyTurn(state), undefined)
  const verdict = observeEmptyTurn(state)
  assert.ok(verdict)
  assert.equal(verdict.kind, 'empty-turn')
  assert.equal(verdict.count, GUARD_EMPTY_TURN_THRESHOLD)
  assert.match(verdict.message, /空转/)
  assert.match(verdict.hint, /下一步/)
  // observeCall 传空值等价于「这个回合没有工具调用」，走同一个计数器
  const delegated = createGuardState()
  assert.equal(observeCall(delegated, undefined), undefined)
  assert.equal(observeCall(delegated, null)?.kind, 'empty-turn')
})

test('t120-8: empty-turn 清零——任何一次有签名的工具调用都打断空转计数', () => {
  const state = createGuardState()
  assert.equal(observeEmptyTurn(state), undefined) // 1
  assert.equal(observeCall(state, toolCall('read|a.ts', 0)), undefined)
  assert.equal(state.emptyTurns, 0, '有动作就不是空转')
  assert.equal(observeEmptyTurn(state), undefined) // 重新从 1 开始
  assert.equal(observeEmptyTurn(state)?.kind, 'empty-turn')
})

test('t120-9: 优先级——同一调用同时满足 env 与 repeat 时，env-unavailable 胜出', () => {
  const state = createGuardState()
  // 三次同签名 + 非 0 退出 + 特征输出：第 3 次 repeat 与 env 同时成立
  assert.equal(observeCall(state, envFail(0)), undefined)
  assert.equal(observeCall(state, envFail(1_000)), undefined)
  const verdict = observeCall(state, envFail(2_000))
  assert.ok(verdict)
  assert.equal(verdict.kind, 'env-unavailable', '优先级顺序：env-unavailable > repeat')
  assert.notEqual(verdict.kind, 'repeat')
})

test('t120-10: blocksCompletion——env-unavailable 阻止「完成」放行，其余三类不阻止', () => {
  const state = createGuardState()
  for (const at of [0, 1, 2]) observeCall(state, envFail(at))
  const env = observeCall(state, envFail(3)) as GuardVerdict
  assert.equal(blocksCompletion(env), true, '环境不可用 → 即使模型声称完成也不得放行')
  // 其余三类是「进度」信号：不能证伪一次真实交付，不阻止完成
  assert.equal(blocksCompletion({ kind: 'repeat', message: '', hint: '' }), false)
  assert.equal(blocksCompletion({ kind: 'stuck', message: '', hint: '' }), false)
  assert.equal(blocksCompletion({ kind: 'empty-turn', message: '', hint: '' }), false)
  assert.equal(blocksCompletion(undefined), false)
  assert.equal(blocksCompletion(null), false)
})

test('t120-11: 环境不可用 latch——无关失败不清除，真实成功才解除', () => {
  // 放大 repeat 阈值：本用例只验 latch 的保持/解除，不要被「第 4、5 次复读」抢先
  const opts = { repeatThreshold: 99 }
  const state = createGuardState()
  for (const at of [0, 1, 2]) observeCall(state, envFail(at), opts)
  // 换一种「非环境」的失败：坏掉的环境没有任何证据说明恢复了 → 判定保持
  const latched = observeCall(
    state,
    toolCall('pwsh|nope', 3_000, { exitCode: 1, output: 'SyntaxError: unexpected token', outputHash: 'other' }),
    opts,
  )
  assert.equal(latched?.kind, 'env-unavailable')
  assert.equal(latched?.count, GUARD_ENV_THRESHOLD, 'latch 保留触发时的计数')
  // 真实成功（exit 0）是恢复的充分证据 → 解除
  assert.equal(
    observeCall(state, toolCall('pwsh|nope', 4_000, { exitCode: 0, output: '', outputHash: 'ok' }), opts),
    undefined,
  )
  assert.equal(state.envUnavailable, undefined)
})

test('t120-12: 阈值覆盖——复用常量默认值，opts 可整体收紧/放宽', () => {
  // 常量本身是契约（改了就是改口径）
  assert.equal(GUARD_REPEAT_THRESHOLD, 3)
  assert.equal(GUARD_STUCK_THRESHOLD, 2)
  assert.equal(GUARD_STUCK_TIMEOUT_MS, 120_000)
  assert.equal(GUARD_ENV_THRESHOLD, 3)
  assert.equal(GUARD_EMPTY_TURN_THRESHOLD, 2)

  // repeat 阈值 2：第 2 次就触发
  const repeatState = createGuardState()
  assert.equal(observeCall(repeatState, toolCall('read|a', 0), { repeatThreshold: 2 }), undefined)
  assert.equal(observeCall(repeatState, toolCall('read|a', 1), { repeatThreshold: 2 })?.kind, 'repeat')

  // env 阈值 2：第 2 次就触发
  const envState = createGuardState()
  assert.equal(observeCall(envState, envFail(0), { envThreshold: 2, repeatThreshold: 99 }), undefined)
  assert.equal(observeCall(envState, envFail(1), { envThreshold: 2, repeatThreshold: 99 })?.kind, 'env-unavailable')

  // stuck 时间窗 10ms + 阈值 2：第 2 次（11ms）就触发
  const stuckState = createGuardState()
  const stuck = (at: number) => toolCall('pwsh|hang', at, { outputHash: 'h' })
  assert.equal(observeCall(stuckState, stuck(0), { stuckTimeoutMs: 10, repeatThreshold: 99 }), undefined)
  assert.equal(observeCall(stuckState, stuck(11), { stuckTimeoutMs: 10, repeatThreshold: 99 })?.kind, 'stuck')

  // 空回合阈值 1：第 1 次就触发
  assert.equal(observeEmptyTurn(createGuardState(), { emptyTurnThreshold: 1 })?.kind, 'empty-turn')

  // 非法覆盖值（0 / 负数 / NaN）回落默认——不得静默变成「永不触发」
  const badState = createGuardState()
  const bad = { repeatThreshold: 0, stuckThreshold: Number.NaN, stuckTimeoutMs: -1, envThreshold: 0 }
  assert.equal(observeCall(badState, toolCall('read|a', 0), bad), undefined)
  assert.equal(observeCall(badState, toolCall('read|a', 1), bad), undefined)
  assert.equal(observeCall(badState, toolCall('read|a', 2), bad)?.kind, 'repeat', '0 阈值回落默认 3')
})

test('t120-13: guardReminder——四类文案都非空、都含「下一步」、且带类型锚点', () => {
  const verdicts: GuardVerdict[] = [
    { kind: 'env-unavailable', message: '环境不可用：pwsh 连续 3 次失败', hint: '下一步：停止重试，转人工' },
    { kind: 'repeat', message: '复读：连续第 3 次', hint: '下一步：换一条不同签名的命令' },
    { kind: 'stuck', message: '挂死：输出一字不差', hint: '下一步：检查是否在等交互式输入' },
    { kind: 'empty-turn', message: '空转：连续 2 个空回合', hint: '下一步：先落一次真实动作' },
  ]
  for (const verdict of verdicts) {
    const reminder = guardReminder(verdict)
    assert.ok(reminder.length > 0, `${verdict.kind} 的提醒不能为空`)
    assert.match(reminder, new RegExp(`\\[GUARD · ${verdict.kind}\\]`), '提醒必须带类型锚点')
    assert.match(reminder, /下一步/, '提醒必须给「下一步做什么」')
    assert.ok(reminder.includes(verdict.message) && reminder.includes(verdict.hint))
  }
  // 没有判定就不该产出提醒（空串，而不是 "undefined"）
  assert.equal(guardReminder(undefined), '')
  assert.equal(guardReminder(null), '')
})

test('t120-14: 状态隔离——createGuardState 每次返回独立计数（Map 不共享）', () => {
  const a = createGuardState()
  const b = createGuardState()
  assert.notEqual(a.repeats, b.repeats)
  observeCall(a, toolCall('read|x', 0))
  observeCall(a, toolCall('read|x', 1))
  observeCall(a, toolCall('read|x', 2))
  assert.equal(a.repeats.get('read|x'), 3)
  assert.equal(b.repeats.get('read|x'), undefined, '两个会话的计数互不影响')
  assert.equal(b.emptyTurns, 0)
  assert.equal(b.envUnavailable, undefined)
})
