/**
 * T117 · P1-4 dispose 有界结算（docs/21 §6 P1-4；来源官方
 * `dsh-experimental-agent-team/lib/types/lifecycle.js:1-103`）。
 *
 * 锁四件事（对应官方三段式：准入截止 → 收集已准入操作 → allSettled + 超时 → 聚合告警）：
 *  ① **准入关闭后新操作立即被拒**：已经开始的卸载不该被新操作拖长，也不能假装接受了；
 *  ② **超时列出名字**：有界结算 = 「不再等」，不是「假装收干净了」——`timedOut` 必须指名道姓；
 *  ③ **预期取消不告警**：卸载期间成员会话被取消是**正常结果**；把它当失败报，真失败会被淹没。
 *     `isCancellation` 沿 `cause` 链走，且**带环也不死循环**（卸载路径死循环 = 宿主关不掉）；
 *  ④ **正常完成不告警**：健康卸载只留 info，不产生任何 warn（告警疲劳比没有告警更糟）。
 *
 * 纯函数用例不碰宿主；dispose 用例用可控的 handle 桩（ok / 抛错 / 永远悬着）验证真实排空路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DISPOSAL_TIMEOUT_MS,
  createAdmissionGate,
  disposalCancellationError,
  isCancellation,
  settleWithin,
} from '../src/core/lifecycle.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

type LogEntry = { level: 'info' | 'warn' | 'error'; msg: string }

function tempWorkspace(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const cleanup = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  return { root, home, cleanup }
}

/** 可控 handle 桩：`dispose` 的行为由用例指定（ok / 抛取消 / 抛真错 / 永远悬着） */
function handleOf(behavior: 'ok' | 'cancel' | 'error' | 'hang') {
  return {
    followup: () => {},
    session: {},
    dispose: () => {
      if (behavior === 'ok') return
      if (behavior === 'cancel') throw disposalCancellationError('member session cancelled by disposal')
      if (behavior === 'error') throw new Error('member session dispose exploded')
      return new Promise(() => {}) // 永远不结算：有界结算必须超时返回
    },
  }
}

function makeRuntime(root: string, handle: unknown, logs: LogEntry[]): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => handle },
    logger: {
      info: (msg: string) => { logs.push({ level: 'info', msg }) },
      warn: (msg: string) => { logs.push({ level: 'warn', msg }) },
      error: (msg: string) => { logs.push({ level: 'error', msg }) },
    },
    workspace: { root },
  } as unknown as HostRuntime
}

function stagedTeam(host: MyTeamHost, name: string): string {
  const staged = host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: 'P1-4 dispose 有界结算',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  return String(staged.teamId)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 1. 准入闸门：关闸后新操作立即被拒 ─────────────────────────── */

test('t117-1: 准入关闭后 track 立即被拒（且是**预期取消**，不是真失败）', async () => {
  const gate = createAdmissionGate({ disposalTimeoutMs: 50 })
  assert.equal(gate.disposed, false)
  assert.equal(gate.reason, undefined)

  // 关闸前：正常登记
  const admitted = gate.track(Promise.resolve('ok'), 'before-close')
  assert.equal(await admitted, 'ok')
  await sleep(0)
  assert.equal(gate.pendingCount(), 0, '结算后自动摘除（闸门只关心未好的）')

  gate.close('test dispose')
  assert.equal(gate.disposed, true)
  assert.ok(gate.reason instanceof Error)

  // 关闸后：立即拒绝，且拒绝原因能被 isCancellation 认成「预期取消」
  const late = gate.track(Promise.resolve('too-late'), 'after-close')
  await assert.rejects(late, (error: unknown) => {
    assert.equal(isCancellation(error), true, '关闸后拒绝 = 预期取消（不该被当失败告警）')
    return true
  })
  assert.equal(gate.pendingCount(), 0, '被拒的操作不登记')

  // 幂等：重复 close 不换原因（后一次调用不该改写「为什么开始卸载」）
  const reason = gate.reason
  gate.close('第二次关闸')
  assert.equal(gate.reason, reason)
})

/* ── 2. 有界结算：超时列出名字 ───────────────────────────────── */

test('t117-2: settleWithin 超时 → 列出仍未结算的名字（已结算的照常计入）', async () => {
  const outcome = await settleWithin(
    [
      { name: 'member:m1', promise: Promise.resolve('done') },
      { name: 'member:m2', promise: new Promise(() => {}) }, // 永远悬着
      { name: 'member:m3', promise: Promise.reject(new Error('dispose failed')) },
    ],
    20,
  )
  assert.equal(outcome.settled, 2, 'fulfilled + rejected 都算已结算')
  assert.deepEqual(outcome.timedOut, ['member:m2'], '超时名单必须指名道姓（顺序 = 入参顺序）')
  assert.equal(outcome.failures.length, 1)
  assert.equal(outcome.failures[0].name, 'member:m3')
  assert.match(String((outcome.failures[0].reason as Error).message), /dispose failed/)

  // 空输入不建定时器、不挂起
  assert.deepEqual(await settleWithin([], 20), { settled: 0, timedOut: [], failures: [] })
  // 全部已结算：不产生超时项（timeout 只是上界，不是等待时长）
  const quick = await settleWithin([{ name: 'a', promise: Promise.resolve() }], 5000)
  assert.deepEqual(quick, { settled: 1, timedOut: [], failures: [] })
})

/* ── 3. 预期取消识别：沿 cause 链 + 带环 ───────────────────────── */

test('t117-3: isCancellation 沿 cause 链识别预期取消；普通错误 / 环 / 原始值都判否', () => {
  assert.equal(isCancellation(disposalCancellationError()), true, 'name=AbortError + code=ABORT_ERR')
  assert.equal(isCancellation({ name: 'AbortError' }), true)
  assert.equal(isCancellation({ code: 'ABORT_ERR' }), true)

  // 包装错误：真正的原因在 cause 链深处（spawn 失败 / allSettled 的 reason 常被包一层）
  const wrapped = new Error('settlement wrapper', { cause: new Error('outer', { cause: disposalCancellationError() }) })
  assert.equal(isCancellation(wrapped), true)

  // 链上没有取消 → 否（真失败不能被当成取消吞掉）
  assert.equal(isCancellation(new Error('real failure')), false)
  assert.equal(isCancellation(new Error('outer', { cause: new Error('inner') })), false)

  // 环：a.cause = b、b.cause = a（真实世界里 JSON 化的错误再解回来会出现）→ 必须终止且判否
  const a = new Error('a')
  const b = new Error('b')
  ;(a as Error & { cause?: unknown }).cause = b
  ;(b as Error & { cause?: unknown }).cause = a
  assert.equal(isCancellation(a), false, '环不能让卸载路径死循环')
  // 环 + 链上有取消 → 仍然能认出来（先命中先返回）
  const c = new Error('c')
  const d = disposalCancellationError()
  ;(c as Error & { cause?: unknown }).cause = d
  ;(d as Error & { cause?: unknown }).cause = c
  assert.equal(isCancellation(c), true)

  // 原始值没有 cause 可走
  assert.equal(isCancellation('AbortError'), false)
  assert.equal(isCancellation(undefined), false)
  assert.equal(isCancellation(null), false)
  // 默认超时常量（面板/文档用同一份数字）
  assert.equal(DEFAULT_DISPOSAL_TIMEOUT_MS, 5000)
})

/* ── 4. host.dispose()：正常完成不告警 ───────────────────────── */

test('t117-4: 健康卸载 → 成员会话被排空，且**一条 warn 都没有**', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t117-ok')
  try {
    const logs: LogEntry[] = []
    const host = new MyTeamHost(makeRuntime(root, handleOf('ok'), logs), { disposalTimeoutMs: 200 })
    host.initialize()
    const teamId = stagedTeam(host, '健康卸载')
    assert.equal((host.spawnMember(teamId, 'implementer') as any).status, 'spawned')

    host.dispose() // 同步返回（宿主 effect disposer 不 await）
    await sleep(30) // 排空放后台：等它落完再看日志
    // 只看 dispose 自己的告警：`initialize()` 在桩运行时上本来就会报「skills / systemPrompt 缺失」
    assert.deepEqual(logs.filter((entry) => entry.level === 'warn' && entry.msg.includes('dispose')), [], '健康卸载不该有告警')
    assert.ok(
      logs.some((entry) => entry.level === 'info' && entry.msg.includes('dispose settled 1 member session(s)')),
      `必须有排空日志（「消失了」与「排空了」要可区分）：${JSON.stringify(logs)}`,
    )
  } finally {
    cleanup()
  }
})

/* ── 5. host.dispose()：预期取消不告警，真失败聚合一条 ───────── */

test('t117-5: 卸载期间成员会话被取消 → 不告警；真失败 → 聚合成**一条** warn', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t117-warn')
  try {
    // ① 只有预期取消：不告警
    const cancelLogs: LogEntry[] = []
    const cancelling = new MyTeamHost(makeRuntime(root, handleOf('cancel'), cancelLogs), { disposalTimeoutMs: 200 })
    cancelling.initialize()
    const teamA = stagedTeam(cancelling, '预期取消')
    assert.equal((cancelling.spawnMember(teamA, 'implementer') as any).status, 'spawned')
    cancelling.dispose()
    await sleep(30)
    assert.deepEqual(
      cancelLogs.filter((entry) => entry.level === 'warn' && entry.msg.includes('dispose')),
      [],
      '预期取消（AbortError）不是失败，不该告警',
    )
  } finally {
    cleanup()
  }
  const second = tempWorkspace('myteam-t117-agg')
  try {
    // ② 真失败：两条成员排空都炸 → **一条** warn（AggregateError 语义），且点名两个成员
    const logs: LogEntry[] = []
    const host = new MyTeamHost(makeRuntime(second.root, handleOf('error'), logs), { disposalTimeoutMs: 200 })
    host.initialize()
    const teamId = stagedTeam(host, '真失败聚合')
    assert.equal((host.spawnMember(teamId, 'implementer') as any).status, 'spawned')
    assert.equal((host.spawnMember(teamId, 'reviewer') as any).status, 'spawned')

    host.dispose()
    await sleep(30)
    const warns = logs.filter((entry) => entry.level === 'warn' && entry.msg.includes('unexpected failure'))
    assert.equal(warns.length, 1, `两条失败必须聚合成一条 warn：${JSON.stringify(logs)}`)
    assert.match(warns[0].msg, /2 unexpected failure\(s\)/)
    assert.match(warns[0].msg, /member session dispose exploded/)
  } finally {
    second.cleanup()
  }
})

/* ── 6. host.dispose()：超时 + 幂等 + 准入截止 ───────────────── */

test('t117-6: 排空超时 → 一条 warn 列出未排空的成员；重复 dispose 幂等；关闸后 spawn 被拒', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t117-timeout')
  try {
    const logs: LogEntry[] = []
    const host = new MyTeamHost(makeRuntime(root, handleOf('hang'), logs), { disposalTimeoutMs: 25 })
    host.initialize()
    const teamId = stagedTeam(host, '排空超时')
    const spawned = host.spawnMember(teamId, 'implementer') as any
    assert.equal(spawned.status, 'spawned')

    host.dispose()
    await sleep(80) // > disposalTimeoutMs：结算段必须已经放弃等待并留痕
    const timeoutWarns = logs.filter((entry) => entry.level === 'warn' && entry.msg.includes('dispose timeout'))
    assert.equal(timeoutWarns.length, 1, `超时必须留一条 warn：${JSON.stringify(logs)}`)
    assert.match(timeoutWarns[0].msg, new RegExp(`member:${spawned.memberId}`), '超时名单要点名未排空的成员')
    assert.match(timeoutWarns[0].msg, /25ms/)

    // 幂等：第二次 dispose 不再产生任何排空日志（也不重复等）
    const before = logs.length
    host.dispose()
    await sleep(20)
    assert.equal(logs.length, before, '重复 dispose 必须幂等（effect 与 disband 都可能各调一次）')

    // 准入截止：卸载已开始 → 新成员立即被拒（不写 provisioning 账）
    const late = host.spawnMember(teamId, 'reviewer') as any
    assert.equal(late.status, 'error')
    assert.equal(late.code, 'MT_UNAVAILABLE')
    assert.match(String(late.message), /disposing/)
  } finally {
    cleanup()
  }
})
