/**
 * T132 · A9（报告 KI-5，CHG-163）：**成员会话冷启动重连**。
 *
 * 缺陷现场：`memberHandles` 是纯内存（`dispose()` 里 `clear()`），进程重启即空。而它是
 * 「成员会话还活着」的唯一判据，三个消费点全都吃它：
 *  - `syncTokens` 记 `no-session`（token 少算）；
 *  - `wakeDecisionsFor` 投不出 followup（唤醒静默失效）；
 *  - `recoverOnBoot` 判 `memberLive=false` → 真活着的成员被转 `to-blocked`（活人被当死人）。
 * CHG-135 成员卡 + CHG-142 启动对账只覆盖 provisioning 半边，**既有活跃成员的重连没有收口**。
 *
 * 本组用例钉住四条硬不变量 + 两个消费点：
 *  ① 重连成功：`agents.get(sessionId)` 拿回 handle → `memberHandles` 里有该成员（幂等）；
 *  ② `agents.get` 抛错 / 返回空 → 进 `missing`，不抛，其余成员照常重连；
 *  ③ 宿主没有 `agents` 服务 → 进 `skipped`，**绝不抛**（插件不能因为宿主少一个 API 就起不来）；
 *  ④ 终态（`removed` / `archived`）与无 `sessionId` 的成员**不重连**；
 *  ⑤ **账本字节数不变**（重连是纯内存重建：不写账本、不建会话、不发消息）；
 *  ⑥ `syncTokens` 重连后能读到该成员（token 不再少算）；
 *  ⑦ `recoverOnBoot` 不再把活着的成员判死（对照组：没有重连 → attempt 被撤）。
 *
 * 测试纪律：`DSH_HOME` 指到临时目录（否则会写用户真实 `~/.dsh/myteam/`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

type LogEntry = { level: 'info' | 'warn'; msg: string }

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

function makeRuntime(root: string, agents: unknown, logs: LogEntry[] = []): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents,
    logger: {
      info: (msg: string) => { logs.push({ level: 'info', msg }) },
      warn: (msg: string) => { logs.push({ level: 'warn', msg }) },
    },
    workspace: { root },
  } as unknown as HostRuntime
}

/** 在线 handle 的形状与真实宿主一致：`{ session, followup }`（`agentOf` 才能认出来） */
function onlineHandle(sessionId: string) {
  return { session: { id: sessionId }, followup: () => {} }
}

/** 冷启动后的宿主：`create` 一旦被调就是 bug（重连**不建会话**），lookup 走注入的 `get` */
function restartedHost(root: string, lookup: (sessionId: string) => unknown, logs: LogEntry[] = []) {
  return new MyTeamHost(makeRuntime(root, {
    create: () => { throw new Error('reconnect must not create sessions') },
    get: lookup,
  }, logs))
}

function stagedTeam(host: MyTeamHost, name: string): string {
  const staged = host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: '冷启动重连用例',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  return String(staged.teamId)
}

function ledgerPathOf(root: string, teamId: string): string {
  return join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  gateChain: ['review'],
  ...over,
})

/**
 * 播种一个团队：4 个 spawn 出来的成员（active / suspended / archived / removed）
 * + 2 个直接落账的成员（无 sessionId 的 active、建成失败的），覆盖「该重连」与「不该重连」两半。
 */
function seedTeam(host: MyTeamHost, teamName: string) {
  const teamId = stagedTeam(host, teamName)
  const live = host.spawnMember(teamId, 'implementer') as any
  const suspended = host.spawnMember(teamId, 'implementer') as any
  const archived = host.spawnMember(teamId, 'implementer') as any
  const removed = host.spawnMember(teamId, 'implementer') as any
  for (const [spawned, op, confirm] of [
    [suspended, 'suspend', false],
    [archived, 'archive', false],
    [removed, 'remove', true],
  ] as const) {
    const r = host.memberOp(teamId, String((spawned as any).memberId), op, confirm) as any
    assert.equal(r.status, op, `前置：${op} 必须成功 ${JSON.stringify(r)}`)
  }
  const svc = host.service(teamId)
  // 建成失败：状态 spawn_failed（不是活成员，没有会话可重连）
  assert.equal(svc.commit({
    actor: 'host',
    type: 'member.spawned',
    payload: { teamId, memberId: 'm-failed', roleId: 'implementer', instanceName: 'failed', sessionId: 'mt-failed-1', status: 'failed', parentMemberId: null, depth: 0, rootMemberId: 'm-failed' },
  }).ok, true)
  const proj = svc.projectionSnapshot
  const sessionOf = (memberId: string) => String(proj.members[memberId].sessionId ?? '')
  return {
    teamId,
    live: { memberId: String(live.memberId), sessionId: sessionOf(String(live.memberId)) },
    suspended: { memberId: String(suspended.memberId), sessionId: sessionOf(String(suspended.memberId)) },
    archived: String(archived.memberId),
    removed: String(removed.memberId),
  }
}

/** 一个「既有活跃 + 挂起」两成员的团队（大多数用例只需要这一份最小播种） */
function firstHostWithTeam(root: string, name: string) {
  const first = new MyTeamHost(makeRuntime(root, { create: (opts: { sessionId: string }) => onlineHandle(opts.sessionId) }))
  first.initialize()
  const seed = seedTeam(first, name)
  return { first, ...seed }
}

/* ── ① 重连成功（幂等）───────────────────────────────────────── */

test('t132-1: 冷启动重连 —— agents.get 拿回 handle，active/suspended 进 memberHandles，重复调用幂等', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-reconnect')
  try {
    const { live, suspended, archived, removed } = firstHostWithTeam(root, '冷启动重连')

    const second = restartedHost(root, (sessionId) => (
      sessionId === live.sessionId || sessionId === suspended.sessionId ? onlineHandle(sessionId) : undefined
    ))
    // constructor 已经重连过一次
    assert.deepEqual(
      second.memberHandleIds().sort(),
      [live.memberId, suspended.memberId].sort(),
      'active + suspended 都要重连回来（终态/无 sessionId 的不算）',
    )
    assert.ok(!second.memberHandleIds().includes(archived), 'archived 不重连')
    assert.ok(!second.memberHandleIds().includes(removed), 'removed 不重连')

    // 幂等：再跑一次没有可重连项；已有 handle 不被覆盖（键集合原样）
    const idsBefore = second.memberHandleIds()
    assert.deepEqual(second.reconnectMembers(), { reconnected: 0, missing: 0, skipped: [] })
    assert.deepEqual(second.memberHandleIds(), idsBefore, '已有 handle 不被覆盖（本进程的 handle 更权威）')
  } finally {
    cleanup()
  }
})

/* ── ② lookup 失败：missing，不抛，其余照常 ───────────────────── */

test('t132-2: agents.get 抛错 / 返回空 —— 进 missing，不抛，其余成员照常重连', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-missing')
  try {
    const { live, suspended } = firstHostWithTeam(root, 'missing 用例')
    const logs: LogEntry[] = []
    const second = restartedHost(root, (sessionId) => {
      if (sessionId === live.sessionId) return onlineHandle(sessionId) // 只有它能重连
      if (sessionId === suspended.sessionId) throw new Error('host lookup exploded') // 抛错
      return undefined // 其余：找不到
    }, logs)

    assert.doesNotThrow(() => second.reconnectMembers())
    assert.deepEqual(second.memberHandleIds(), [live.memberId], '抛错的那个不能拖垮其它成员')
    const summary = second.reconnectMembers()
    // 第二次调用：live 已有 handle（不算），suspended 仍然 missing
    assert.equal(summary.reconnected, 0)
    assert.equal(summary.missing, 1, '只有 suspended 该进 missing（live 已重连）')
    assert.ok(logs.some((entry) => entry.level === 'warn' && entry.msg.includes('member reconnect lookup failed')), 'lookup 抛错必须 warn 留痕')
  } finally {
    cleanup()
  }
})

test('t132-2b: agents.get 对全部成员都返回空 —— 全部进 missing（不猜、不伪造 handle）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-missing-all')
  try {
    const { live, suspended } = firstHostWithTeam(root, '全 missing')
    const second = restartedHost(root, () => undefined)
    const summary = second.reconnectMembers()
    assert.equal(summary.missing, 2, `live + suspended 都该 missing（实际 ${JSON.stringify(summary)}）`)
    assert.equal(summary.reconnected, 0)
    assert.deepEqual(second.memberHandleIds(), [], '拿不到 handle 就是空的——不许编一个出来')
    assert.ok(live.memberId !== suspended.memberId)
  } finally {
    cleanup()
  }
})

/* ── ③ 宿主没有 agents 服务：skipped，绝不抛 ──────────────────── */

test('t132-3: 宿主没有 agents 服务 —— 进 skipped、不抛（插件必须起得来）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-skip')
  try {
    firstHostWithTeam(root, 'skipped 用例')
    const logs: LogEntry[] = []
    let host!: MyTeamHost
    assert.doesNotThrow(() => { host = new MyTeamHost(makeRuntime(root, undefined, logs)) }, '构造不能抛')
    const summary = host.reconnectMembers()
    assert.deepEqual(summary, { reconnected: 0, missing: 0, skipped: ['agents.get unavailable (host has no session lookup)'] })
    assert.deepEqual(host.memberHandleIds(), [])
    assert.doesNotThrow(() => host.initialize(), 'initialize 也不能因为少了 agents 而抛')
  } finally {
    cleanup()
  }
})

/* ── ④ 终态 / 无 sessionId 不重连 ─────────────────────────────── */

test('t132-4: removed / archived / spawn_failed —— 一律不重连（也不再为它们做 lookup）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-terminal')
  try {
    const { live, suspended, archived, removed } = firstHostWithTeam(root, '终态用例')
    const probed: string[] = []
    const second = restartedHost(root, (sessionId) => {
      probed.push(sessionId)
      return onlineHandle(sessionId)
    })
    const ids = second.memberHandleIds()
    assert.deepEqual(ids.sort(), [live.memberId, suspended.memberId].sort(), '只有 active/suspended（有 sessionId）的成员被重连')
    assert.ok(!ids.includes(archived) && !ids.includes(removed))
    assert.ok(!probed.includes('mt-failed-1'), 'spawn_failed 的会话不该被 lookup')
    // 只 lookup 了该 lookup 的：live + suspended 两个（suspended 也是「活着」的合法态）
    // 注：`member.spawned` 的账本必填字段含 sessionId（MT_LEDGER_MISSING_FIELD），所以
    // 「active 但无 sessionId」只可能来自旧账本；代码里的空 sessionId 守卫是给旧账本兜底的，
    // 写路径造不出这种事件，故不在此用例里伪造。
    assert.equal(probed.length, 2, `只该为 active/suspended 成员 lookup（实际 ${JSON.stringify(probed)}）`)
  } finally {
    cleanup()
  }
})

/* ── ⑤ 账本字节数不变（纯内存重建）────────────────────────────── */

test('t132-5: 重连不改账本 —— 构造（含重连）与显式调用前后账本字节数不变', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-bytes')
  try {
    const { teamId, live, suspended } = firstHostWithTeam(root, '字节不变')
    const ledgerPath = ledgerPathOf(root, teamId)
    const before = statSync(ledgerPath).size

    const second = restartedHost(root, (sessionId) => onlineHandle(sessionId))
    assert.equal(statSync(ledgerPath).size, before, '构造期的重连不得写账本（不落 member.* / message.*）')

    second.reconnectMembers()
    assert.equal(statSync(ledgerPath).size, before, '显式重连也不得写账本')
    assert.deepEqual(second.memberHandleIds().sort(), [live.memberId, suspended.memberId].sort(), '前置：确实重连了（否则「没写」没有意义）')
  } finally {
    cleanup()
  }
})

/* ── ⑥ 消费点一：syncTokens 能读到成员 ────────────────────────── */

test('t132-6: 重连后 syncTokens 能读到该成员 —— token 不再少算（no-session → 计量）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-tokens')
  try {
    const { teamId, live } = firstHostWithTeam(root, 'token 用例')
    // 宿主 token 投影：给一个固定的累计量（calls=2 才有 metered 计数）
    const sessionProjections = {
      stateOf: (session: unknown, key: string) => (key === 'tokenUsage'
        ? { totals: { uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 40, calls: 2 } }
        : undefined),
    }
    const second = new MyTeamHost({
      ...makeRuntime(root, {
        create: () => { throw new Error('reconnect must not create sessions') },
        get: (sessionId: string) => onlineHandle(sessionId),
      }),
      sessionProjections,
    } as unknown as HostRuntime)

    const file = second.syncTokens(teamId)
    const bucket = file.totals[live.memberId]
    assert.ok(bucket, `重连后 tokens.json 必须有该成员（实际 ${JSON.stringify(Object.keys(file.totals))}）`)
    assert.equal(bucket.calls, 2, '累计调用数从投影读到（重连前这里会是 no-session / 缺行）')
    assert.equal(bucket.uncachedInput, 100)
    // 落盘也是真的（不是只在内存里）
    /* CHG-202x（P1-14）：契约位置 = history/tokens/<teamId>.json（派生数据不入库） */
    const onDisk = JSON.parse(readFileSync(join(root, '.dsh-myteam', 'history', 'tokens', `${teamId}.json`), 'utf8'))
    assert.equal(onDisk.totals[live.memberId].calls, 2)
  } finally {
    cleanup()
  }
})

/* ── ⑦ 消费点二：recoverOnBoot 不再把活着的成员判死 ─────────────── */

test('t132-7: recoverOnBoot —— 重连后活着的成员不再被判 to-blocked/换 attempt（对照组：没重连就撤权）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t132-recover')
  try {
    const { first, teamId, live, suspended } = firstHostWithTeam(root, '恢复表用例')
    const created = first.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    assert.equal(created.status, 'created', JSON.stringify(created))
    const claimed = first.executeMemberTool(
      { memberId: live.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: live.sessionId, teamId },
      'myteam_claim_task',
      { taskId: created.taskId },
    ) as any
    assert.equal(claimed.status, 'claimed', JSON.stringify(claimed))
    assert.equal(first.service(teamId).projectionSnapshot.tasks[created.taskId].state, 'in_progress')

    // 重连回来的宿主：成员活着 → 原地重激活，**不撤 attempt**
    const reconnected = restartedHost(root, (sessionId) => onlineHandle(sessionId))
    assert.ok(reconnected.memberHandleIds().includes(live.memberId), '前置：成员已重连')
    assert.deepEqual(reconnected.recoverOnBoot(teamId), { recovered: 0, actions: [] }, '活着的成员不该触发任何恢复动作')

    // 对照组：没有 agents 服务（重连不了 = 旧行为）→ 成员被判死 → attempt 被撤
    const control = new MyTeamHost(makeRuntime(root, undefined))
    const controlResult = control.recoverOnBoot(teamId)
    assert.ok(controlResult.recovered > 0, '对照组必须演示「没重连就撤权」的旧缺陷')
    assert.match(controlResult.actions.join('\n'), /attempt revoked for re-claim/)
    // 撤权 = attempt 被撤，任务回到 ready 等新 attempt 接手（活着的成员却被重跑了一遍）
    assert.equal(control.service(teamId).projectionSnapshot.tasks[created.taskId].state, 'ready')
    assert.ok(suspended.memberId !== live.memberId)
  } finally {
    cleanup()
  }
})
