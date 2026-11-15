/**
 * T113 · P0-1（docs/21 §6，来源官方 `types/roster.js:206-386`）：两阶段 spawn + 三条件对账。
 *
 * 为什么需要这一组用例：两阶段 spawn 的正确性**全都藏在「顺序」里**——
 *   - `provisioning` 必须先于 `agents.create` 落账，否则宿主崩在 create 期间 = 孤儿成员；
 *   - `active` / `failed` 必须与 `provisioning` 同 memberId 结算，否则重试会留下永久 provisioning；
 *   - 启动对账必须只按三条件判活（parent 匹配 ∧ continuable ∧ 初始 prompt 已接受）。
 * 这些顺序没有任何东西能在运行时替你保证，只能靠断言钉住。
 *
 * 测试纪律：
 *  - `DSH_HOME` 指到临时目录（否则写用户真实 `~/.dsh/myteam/`——CHG-127 的教训）；
 *  - 纯函数用例不碰 fs（三条件矩阵穷举）；host 用例用可观测 mock 捕获 `agents.create` 与账本事件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import {
  reconcileProvisioning,
  type ProvisioningMember,
  type ProvisioningProbeResult,
} from '../src/core/scheduler/recovery.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'

type LogEntry = { level: 'info' | 'warn'; msg: string }

/** 临时工作区 + 临时 DSH_HOME（清理必须还原 env，否则污染同进程其它用例） */
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

/** agents.create 的同步桩：create 返回 handle 本体（真实宿主返回 Promise，两条路径都要覆盖） */
function syncAgents() {
  const created: any[] = []
  return {
    created,
    service: {
      create: (opts: any) => {
        created.push(opts)
        return { followup: () => {}, session: {} }
      },
    },
  }
}

/** 落一个 draft 团队（角色在 spawn 时自动复制进项目库），返回 teamId */
function stagedTeam(host: MyTeamHost, name: string): string {
  const staged = host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: '两阶段 spawn 用例',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  return String(staged.teamId)
}

function ledgerOf(root: string, teamId: string): any[] {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

function spawnEventsOf(root: string, teamId: string): any[] {
  return ledgerOf(root, teamId).filter((event) => event.type === 'member.spawned')
}

/* ── 1. 三条件矩阵（纯函数）──────────────────────────────────── */

test('t113-1: 三条件矩阵 —— 全真 active；任一条件不满足 → failed 且 reason 指名道姓', () => {
  const members: ProvisioningMember[] = [
    { memberId: 'm1', sessionId: 's1', status: 'provisioning' },
    { memberId: 'm2', sessionId: 's2', status: 'provisioning' },
    { memberId: 'm3', sessionId: 's3', status: 'provisioning' },
    { memberId: 'm4', sessionId: 's4', status: 'provisioning' },
  ]
  const probes: Record<string, ProvisioningProbeResult> = {
    s1: { sessionExists: true, continuable: true, initialPromptAccepted: true },
    s2: { sessionExists: false, continuable: true, initialPromptAccepted: true },
    s3: { sessionExists: true, continuable: false, initialPromptAccepted: true },
    s4: { sessionExists: true, continuable: true, initialPromptAccepted: false },
  }
  const settled = reconcileProvisioning(members, (sessionId) => probes[sessionId])
  assert.deepEqual(settled.map((s) => [s.memberId, s.action]), [
    ['m1', 'settle-active'],
    ['m2', 'settle-failed'],
    ['m3', 'settle-failed'],
    ['m4', 'settle-failed'],
  ])
  // 全真：reason 自证三条件；缺一：reason 必须点名缺的是哪一条（审计要能直接读）
  assert.match(settled[0].reason, /session exists ∧ continuable ∧ initial prompt accepted/)
  assert.match(settled[1].reason, /child session missing/)
  assert.match(settled[2].reason, /session is not continuable/)
  assert.match(settled[3].reason, /initial prompt was not accepted/)
})

test('t113-1b: 全假 / 探针抛错 / 无 sessionId —— 一律 failed（证明不了活着就不判活）', () => {
  const members: ProvisioningMember[] = [
    { memberId: 'all-false', sessionId: 'x', status: 'provisioning' },
    { memberId: 'throw', sessionId: 'y', status: 'provisioning' },
    { memberId: 'no-session', status: 'provisioning' },
  ]
  const settled = reconcileProvisioning(members, (sessionId) => {
    if (sessionId === 'y') throw new Error('agents service exploded')
    return { sessionExists: false, continuable: false, initialPromptAccepted: false }
  })
  assert.deepEqual(settled.map((s) => s.action), ['settle-failed', 'settle-failed', 'settle-failed'])
  assert.match(settled[0].reason, /child session missing; session is not continuable; initial prompt was not accepted/)
  assert.match(settled[1].reason, /probe threw: Error: agents service exploded/)
  assert.match(settled[2].reason, /no sessionId recorded/)
})

/* ── 2. 纯函数幂等 ───────────────────────────────────────────── */

test('t113-2: 纯函数幂等 —— 同输入同输出；同一 memberId 只结算一次；非 provisioning 不参与', () => {
  const members: ProvisioningMember[] = [
    { memberId: 'm1', sessionId: 's1', status: 'provisioning' },
    { memberId: 'm1', sessionId: 's1', status: 'provisioning' }, // 账本里同 memberId 的重复记录
    { memberId: 'm2', sessionId: 's2', status: 'provisioning' },
    { memberId: 'already-active', sessionId: 's3', status: 'active' },
    { memberId: 'already-failed', sessionId: 's4', status: 'spawn_failed' },
  ]
  const probe = (sessionId: string): ProvisioningProbeResult => ({
    sessionExists: sessionId === 's1',
    continuable: sessionId === 's1',
    initialPromptAccepted: sessionId === 's1',
  })
  const first = reconcileProvisioning(members, probe)
  const second = reconcileProvisioning(members, probe)
  assert.deepEqual(first, second, '同输入必须同输出（纯函数）')
  assert.deepEqual(first.map((s) => s.memberId), ['m1', 'm2'], '同一 memberId 只出一次；已结算状态不重复结算')
  // 再跑一次「结算后的成员集」= 空（幂等的可观测面：对账跑完没有可结算项）
  const settledMembers: ProvisioningMember[] = first.map((s) => ({
    memberId: s.memberId,
    sessionId: s.memberId === 'm1' ? 's1' : 's2',
    status: s.action === 'settle-active' ? 'active' : 'spawn_failed',
  }))
  assert.deepEqual(reconcileProvisioning(settledMembers, probe), [])
})

/* ── 3. host 两阶段成功（provisioning → active 两条事件 + 顺序）── */

test('t113-3: host 两阶段 —— 先 provisioning 后 active，同一 memberId/sessionId，投影落 active', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-ok')
  try {
    const agents = syncAgents()
    const host = new MyTeamHost(makeRuntime(root, agents.service))
    host.initialize()
    const teamId = stagedTeam(host, '两阶段成功')

    const spawned = host.spawnMember(teamId, 'implementer') as any
    assert.equal(spawned.status, 'spawned', JSON.stringify(spawned))
    assert.equal(agents.created.length, 1, 'agents.create 只调用一次')

    const spawnEvents = spawnEventsOf(root, teamId)
    assert.equal(spawnEvents.length, 2, '恰好两条 member.spawned 事件')
    assert.equal(spawnEvents[0].payload.status, 'provisioning', '① 先落 provisioning')
    assert.equal(spawnEvents[1].payload.status, 'active', '③ 建成后结算 active')
    assert.equal(spawnEvents[0].payload.memberId, spawnEvents[1].payload.memberId, '同一 memberId')
    assert.equal(spawnEvents[0].payload.sessionId, spawnEvents[1].payload.sessionId, '同一 sessionId')
    assert.ok(spawnEvents[0].seq < spawnEvents[1].seq, '账本顺序 = 两阶段的先后')

    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.members[String(spawned.memberId)].status, 'active')
    assert.equal(Object.keys(proj.members).length, 1, '没有第二个 memberId')
  } finally {
    cleanup()
  }
})

/* ── 4. 创建抛错（落 failed + reason）────────────────────────── */

test('t113-3b: CHG-206 —— 成员 agent 必须带模型选择（角色无 model 时回退宿主默认模型）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-model')
  try {
    const agents = syncAgents()
    const runtime = makeRuntime(root, agents.service)
    /* 真实 DSH 的默认模型服务；没有它时 agents.create 的 agentOptions 只能是 undefined，
     * 成员每个 turn 都会以 `has no provider/model` 结束（账本 active 的空壳）。
     * 走 `ctx.get()` 路径（Cordis 未 inject 的服务不能属性直读）。 */
    ;(runtime as unknown as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'magpie', model: 'wps-lingxi/deepseek-v4.1-flash', reasoningEffort: 'high' }) }
        : undefined
    const host = new MyTeamHost(runtime)
    host.initialize()
    const teamId = stagedTeam(host, '模型回退')
    const spawned = host.spawnMember(teamId, 'implementer') as any
    assert.equal(spawned.status, 'spawned', JSON.stringify(spawned))
    assert.deepEqual(agents.created[0].agentOptions, {
      provider: 'magpie',
      model: 'wps-lingxi/deepseek-v4.1-flash',
      reasoningEffort: 'high',
    })
  } finally {
    cleanup()
  }
})

test('t113-3c: CHG-206 —— handle 没有 followup 时按失败结算（不能静默变成 active 空壳）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-nofollowup')
  try {
    const host = new MyTeamHost(makeRuntime(root, { create: () => ({}) }))
    host.initialize()
    const teamId = stagedTeam(host, '空壳成员')
    const spawned = host.spawnMember(teamId, 'implementer') as any
    assert.equal(spawned.status, 'error')
    assert.match(String(spawned.message), /no followup/)
    assert.deepEqual(spawnEventsOf(root, teamId).map((e) => e.payload.status), ['provisioning', 'failed'])
  } finally {
    cleanup()
  }
})

test('t113-4: agents.create 同步抛错 —— 落 failed + reason，返回结构化错误，投影 spawn_failed', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-throw')
  try {
    const host = new MyTeamHost(makeRuntime(root, {
      create: () => { throw new Error('host exploded during create') },
    }))
    host.initialize()
    const teamId = stagedTeam(host, '创建抛错')

    const failed = host.spawnMember(teamId, 'implementer') as any
    assert.equal(failed.status, 'error')
    assert.equal(failed.code, 'MT_INTERNAL')
    assert.match(String(failed.message), /host exploded during create/)

    const spawnEvents = spawnEventsOf(root, teamId)
    assert.equal(spawnEvents.length, 2, '失败路径也必须落终态（不留永久 provisioning）')
    assert.deepEqual(spawnEvents.map((e) => e.payload.status), ['provisioning', 'failed'])
    assert.equal(spawnEvents[1].payload.reason, 'host exploded during create')
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.members[String(failed.memberId ?? 'm1-implementer')].status, 'spawn_failed')
  } finally {
    cleanup()
  }
})

test('t113-4b: agents.create 返回 rejected Promise —— 异步失败同样落 failed + reason', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-reject')
  try {
    const host = new MyTeamHost(makeRuntime(root, {
      create: () => Promise.reject(new Error('activation rejected')),
    }))
    host.initialize()
    const teamId = stagedTeam(host, '异步创建失败')

    const spawned = host.spawnMember(teamId, 'implementer') as any
    assert.equal(spawned.status, 'spawned', 'create 调用本身已受理（失败在 settle 段异步结算）')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const spawnEvents = spawnEventsOf(root, teamId)
    assert.deepEqual(spawnEvents.map((e) => e.payload.status), ['provisioning', 'failed'])
    assert.equal(spawnEvents[1].payload.reason, 'activation rejected')
  } finally {
    cleanup()
  }
})

/* ── 5. 同 memberId 重试不产生第二个成员 ──────────────────────── */

test('t113-5: 同 memberId 重试（failed → provisioning → active）——账本 4 条事件，投影仍只有 1 个成员', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-retry')
  try {
    const host = new MyTeamHost(makeRuntime(root, {
      create: () => { throw new Error('first attempt failed') },
    }))
    host.initialize()
    const teamId = stagedTeam(host, '重试幂等')

    const failed = host.spawnMember(teamId, 'implementer') as any
    const memberId = String(failed.memberId)
    assert.equal(failed.status, 'error')
    // 重试：对同一个 memberId 再走一遍 provisioning → active（对账 / 重试的写入形状）
    const svc = host.service(teamId)
    const retryPayload = { teamId, memberId, roleId: 'implementer', instanceName: 'retry', sessionId: String(failed.sessionId ?? 'retry-session'), parentMemberId: null, depth: 0, rootMemberId: memberId }
    assert.equal(svc.commit({ actor: 'host', type: 'member.spawned', payload: { ...retryPayload, status: 'provisioning' } }).ok, true)
    assert.equal(svc.commit({ actor: 'host', type: 'member.spawned', payload: { ...retryPayload, status: 'active' } }).ok, true)

    const spawnEvents = spawnEventsOf(root, teamId)
    assert.deepEqual(spawnEvents.map((e) => e.payload.status), ['provisioning', 'failed', 'provisioning', 'active'])
    const proj = svc.projectionSnapshot
    assert.deepEqual(Object.keys(proj.members), [memberId], '同 memberId 覆盖 = 没有第二个成员')
    assert.equal(proj.members[memberId].status, 'active', '最后一次结算生效')
  } finally {
    cleanup()
  }
})

/* ── 6. 启动对账：自愈 + 幂等 + 投影无 provisioning 残留 ────────── */

test('t113-6: 启动对账 —— 崩溃残留的 provisioning 成员三条件全真 → active，再跑无可结算项', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-boot')
  try {
    // 冷启动前的账本：团队已建，某个成员停在 provisioning（模拟宿主崩在 create 之后、结算之前）
    copyToProject({ projectRolesDir: join(root, '.dsh-myteam', 'config', 'roles') }, 'implementer', 'builtin')
    const first = new MyTeamHost(makeRuntime(root, syncAgents().service))
    first.initialize()
    const teamId = stagedTeam(first, '崩溃对账')
    const svc = first.service(teamId)
    assert.equal(svc.commit({
      actor: 'lead',
      type: 'member.spawned',
      payload: { teamId, memberId: 'm-crash', roleId: 'implementer', instanceName: 'crash', sessionId: 'sess-crash', status: 'provisioning', parentMemberId: null, depth: 0, rootMemberId: 'm-crash' },
    }).ok, true)

    // 冷启动：agents.get 拿得到会话 + 会话里已有 user 消息（初始 prompt 已接受）→ 三条件全真
    const logs: LogEntry[] = []
    const second = new MyTeamHost(makeRuntime(root, {
      create: () => ({ followup: () => {}, session: {} }),
      get: (sessionId: string) => sessionId === 'sess-crash'
        ? { session: { snapshotEvents: () => [{ source: { kind: 'user' } }] } }
        : undefined,
    }, logs))
    second.initialize()

    const proj = second.service(teamId).projectionSnapshot
    assert.equal(proj.members['m-crash'].status, 'active', '三条件全真 → 自愈为 active')
    // 投影里不允许出现 provisioning 残留（fold 把 provisioning 折叠成 active，所以真正的
    // 不变量在账本：最后一条 member.spawned 必须是结算后的终态）
    assert.ok(Object.values(proj.members).every((member) => member.status !== 'provisioning'))
    const spawnEvents = spawnEventsOf(root, teamId)
    assert.equal(spawnEvents.at(-1)!.payload.status, 'active')
    assert.match(String(spawnEvents.at(-1)!.payload.reason), /session exists ∧ continuable ∧ initial prompt accepted/)
    assert.ok(logs.some((entry) => entry.level === 'info' && entry.msg.includes('spawn reconcile')), '对账必须留 info 日志')
    // 幂等：对账跑完后没有可结算项
    assert.deepEqual(second.reconcileProvisioningOnBoot(), { settled: 0, active: 0, failed: 0 })
  } finally {
    cleanup()
  }
})

test('t113-6b: 启动对账 —— 探针判死 → failed + reason；坏团队账本不阻断启动', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-dead')
  try {
    copyToProject({ projectRolesDir: join(root, '.dsh-myteam', 'config', 'roles') }, 'implementer', 'builtin')
    const first = new MyTeamHost(makeRuntime(root, syncAgents().service))
    first.initialize()
    const teamId = stagedTeam(first, '死成员对账')
    assert.equal(first.service(teamId).commit({
      actor: 'lead',
      type: 'member.spawned',
      payload: { teamId, memberId: 'm-dead', roleId: 'implementer', instanceName: 'dead', sessionId: 'sess-dead', status: 'provisioning', parentMemberId: null, depth: 0, rootMemberId: 'm-dead' },
    }).ok, true)

    const logs: LogEntry[] = []
    const second = new MyTeamHost(makeRuntime(root, {
      create: () => ({ followup: () => {}, session: {} }),
      get: () => undefined, // 会话不存在 = 探针判死
    }, logs))
    assert.doesNotThrow(() => second.initialize(), '对账失败不得阻断启动')

    const proj = second.service(teamId).projectionSnapshot
    assert.equal(proj.members['m-dead'].status, 'spawn_failed')
    const last = spawnEventsOf(root, teamId).at(-1)!
    assert.equal(last.payload.status, 'failed')
    assert.match(String(last.payload.reason), /child session missing/)
    assert.ok(logs.some((entry) => entry.level === 'warn' && entry.msg.includes('spawn reconcile')), '判死必须 warn 让人看见')
  } finally {
    cleanup()
  }
})

/**
 * t113-7（CHG-142 回归）：**相位更新不得吃 maxMembers 配额**。
 *
 * 缺陷现场：两阶段 spawn 让每个成员先落 `provisioning`，而 fold 会把它折叠成 active 计入配额——
 * 第 N 名成员的 `settle(active)` 因此被 `checkDomain` 当成「新成员准入」拒掉，账本永久停在
 * provisioning、成员卡也不写，**启动对账同样被拒**（自愈路径一起死）。
 * 本用例钉住两条：① 满员前每个成员都能 settle 成 active；② 满员后**新 memberId** 仍必须被拒。
 */
test('t113-7: 相位更新不吃 maxMembers 配额 —— 第 N 名成员能 settle 成 active，新成员仍被拒', () => {
  const { root, cleanup } = tempWorkspace('myteam-t113-cap')
  try {
    copyToProject({ projectRolesDir: join(root, '.dsh-myteam', 'config', 'roles') }, 'implementer', 'builtin')
    const host = new MyTeamHost(makeRuntime(root, syncAgents().service))
    host.initialize()
    const teamId = stagedTeam(host, '配额相位')
    const svc = host.service(teamId)
    const limit = svc.effectiveConfig.limits.maxMembers

    for (let i = 0; i < limit; i += 1) {
      const memberId = `m-cap-${i}`
      const payload = { teamId, memberId, roleId: 'implementer', instanceName: `cap-${i}`, sessionId: `sess-cap-${i}`, parentMemberId: null, depth: 0, rootMemberId: memberId }
      assert.equal(svc.commit({ actor: 'lead', type: 'member.spawned', payload: { ...payload, status: 'provisioning' } }).ok, true)
      const settled = svc.commit({ actor: 'lead', type: 'member.spawned', payload: { ...payload, status: 'active' } })
      assert.equal(settled.ok, true, `第 ${i + 1} 名成员的 settle 不得被 maxMembers 误拒`)
    }

    const rejected = svc.commit({
      actor: 'lead',
      type: 'member.spawned',
      payload: { teamId, memberId: 'm-over', roleId: 'implementer', instanceName: 'over', sessionId: 'sess-over', status: 'provisioning', parentMemberId: null, depth: 0, rootMemberId: 'm-over' },
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'MT_MEMBER_LIMIT')
  } finally {
    cleanup()
  }
})
