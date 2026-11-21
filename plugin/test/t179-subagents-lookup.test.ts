/**
 * T179 表 CHG-213：**活体验收抓到的两个实机缺陷**（单测与门禁都抓不到，只有真实 host 能暴露）。
 *
 *   ① spawn 读 `ctx.subagents` 用的是**属性直读**，而插件 `inject` 只有 `tools/agents`
 *      → `cannot get property "subagents" without inject` 抛在 `canActivate` 里，
 *      **子代理分支与回落分支一起挂掉**，成员永远起不来（账本只留一条 failed）。
 *   ② `myteam_message` 无条件回 `{status:'sent'}`，把①的失败掩盖成「已送达」。
 *
 * 这两个用例故意把 `subagents` 属性做成**会抛**的（复刻真实 ctx 的未 inject 行为）：
 * 不这么做，假 ctx 上的属性读永远成功，缺陷测不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const NOT_INJECTED = 'cannot get property "subagents" without inject'

interface Captured {
  spec?: Record<string, unknown>
  created?: number
}

function tempWorkspace(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    root,
    cleanup: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function activationFake(captured: Captured, live: Map<string, unknown>) {
  return {
    startActivation: (spec: Record<string, unknown>) => {
      captured.spec = spec
      const childId = String(spec['childId'])
      live.set(childId, {
        id: childId,
        followup: () => {},
        session: { header: { parentSession: String((spec['parent'] as { id?: string })?.id ?? '') } },
      })
      return { childId, name: String(spec['name'] ?? ''), result: Promise.resolve({ stopReason: 'completed' }), dispose: () => Promise.resolve() }
    },
  }
}

function baseRuntime(root: string, captured: Captured, live: Map<string, unknown>): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: () => {
        captured.created = (captured.created ?? 0) + 1
        return { followup: () => {}, session: {}, dispose: () => {} }
      },
      get: (id: string) => live.get(id),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

/** 复刻真实 ctx：未 inject 的 `subagents` 属性读会抛；只有 `get('subagents')` 能拿到 */
function unInjectedRuntime(root: string, captured: Captured, live: Map<string, unknown>, service: unknown): HostRuntime {
  const runtime = baseRuntime(root, captured, live) as unknown as Record<string, unknown>
  Object.defineProperty(runtime, 'subagents', {
    configurable: true,
    get() { throw new Error(NOT_INJECTED) },
  })
  runtime['get'] = (name: string) => (name === 'subagents' ? service : undefined)
  return runtime as unknown as HostRuntime
}

function approvedTeam(runtime: HostRuntime) {
  const host = new MyTeamHost(runtime, { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T179', goal: '子代理取值回归', roster: [{ roleId: 'captain' }], tasks: [] }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  return { host, teamId: String(sub.teamId) }
}

function lastSpawnEvent(root: string, teamId: string, memberId: string): any {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  const events = raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  return events.filter((event) => event.type === 'member.spawned' && event.payload.memberId === memberId).at(-1)
}

test('t179a: subagents 未 inject（属性读抛）时，仍能经 get() 走子代理 activation', () => {
  const { root, cleanup } = tempWorkspace('myteam-t179a')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    const { host, teamId } = approvedTeam(unInjectedRuntime(root, captured, live, activationFake(captured, live)))
    const captain = { id: 'cap-t179a' }
    const result = host.executeLeadTool(
      'myteam_spawn_member',
      { teamId, roleId: 'implementer', instanceName: 'dev-1' },
      { agent: captain },
    ) as any

    assert.equal(result.status, 'spawned', `不允许因为属性读抛错就失败：${JSON.stringify(result)}`)
    assert.ok(captured.spec, '必须真的走 startActivation')
    assert.equal(captured.spec!['childId'], result.sessionId)
    assert.equal(lastSpawnEvent(root, teamId, result.memberId).payload.status, 'active')
  } finally {
    cleanup()
  }
})

test('t179b: 宿主根本没有 subagents（也没有 get）时回落 agents.create，不抛错', () => {
  const { root, cleanup } = tempWorkspace('myteam-t179b')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    const runtime = baseRuntime(root, captured, live) as unknown as Record<string, unknown>
    Object.defineProperty(runtime, 'subagents', {
      configurable: true,
      get() { throw new Error(NOT_INJECTED) },
    })
    const { host, teamId } = approvedTeam(runtime as unknown as HostRuntime)
    const result = host.executeLeadTool(
      'myteam_spawn_member',
      { teamId, roleId: 'implementer', instanceName: 'dev-2' },
      { agent: { id: 'cap-t179b' } },
    ) as any

    assert.equal(result.status, 'spawned', JSON.stringify(result))
    assert.equal(captured.spec, undefined, '拿不到 subagents 服务时不许调 startActivation')
    assert.equal(captured.created, 1, '必须回落到 agents.create（一条命都不能浪费）')
    assert.equal(lastSpawnEvent(root, teamId, result.memberId).payload.status, 'active')
  } finally {
    cleanup()
  }
})

test('t179c: myteam_message 如实回报 delivered（投得出去 true / 投不出去 false）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t179c')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    const { host, teamId } = approvedTeam(unInjectedRuntime(root, captured, live, activationFake(captured, live)))
    const spawned = host.executeLeadTool(
      'myteam_spawn_member',
      { teamId, roleId: 'implementer', instanceName: 'dev-3' },
      { agent: { id: 'cap-t179c' } },
    ) as any

    const delivered = host.executeLeadTool('myteam_message', { teamId, to: spawned.memberId, content: '继续' }, {}) as any
    assert.equal(delivered.status, 'sent')
    assert.equal(delivered.delivered, true, '活的成员会话必须报 delivered:true')

    // 新 host（空句柄表）+ 成员会话已经不在了 → 账本照落，但必须如实说没送到
    const gone = new Map<string, unknown>()
    const second = new MyTeamHost(unInjectedRuntime(root, captured, gone, activationFake(captured, gone)), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
    second.initialize()
    const missed = second.executeLeadTool('myteam_message', { teamId, to: spawned.memberId, content: '继续' }, {}) as any
    assert.equal(missed.status, 'sent', '消息已经落账：不能把「已记账」变成「失败」')
    assert.equal(missed.delivered, false, '没有活会话时必须报 delivered:false')
    assert.match(String(missed.message), /release|spawn/, '要给出可行动的下一步')
  } finally {
    cleanup()
  }
})

test('t179d: 子代理成员走 subagents.sendMessage（不许 followup —— 那会抛 cannot append outside a SessionStore）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t179d')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    const sent: Array<{ sender: unknown; target: string; text: string }> = []
    const reject = { value: false }
    const subagents = {
      startActivation: (spec: Record<string, unknown>) => {
        captured.spec = spec
        const childId = String(spec['childId'])
        live.set(childId, {
          id: childId,
          // 复刻实机：子代理 child 的 Agent 是「可续起的 seed」，append 必抛
          followup: () => { throw new Error(`session "${childId}" cannot append outside a SessionStore`) },
          session: { header: { parentSession: 'cap-t179d' } },
        })
        return { childId, name: String(spec['name'] ?? ''), result: Promise.resolve({ stopReason: 'completed' }), dispose: () => Promise.resolve() }
      },
      sendMessage: (sender: unknown, target: string, content: Array<{ text?: string }>) => {
        if (reject.value) return Promise.reject(new Error('cannot resume: child is not resident'))
        sent.push({ sender, target, text: String(content[0]?.text ?? '') })
        return Promise.resolve('msg-1')
      },
    }
    const runtime = baseRuntime(root, captured, live) as unknown as Record<string, unknown>
    Object.defineProperty(runtime, 'subagents', { configurable: true, get() { throw new Error(NOT_INJECTED) } })
    runtime['get'] = (name: string) => (name === 'subagents' ? subagents : undefined)
    const { host, teamId } = approvedTeam(runtime as unknown as HostRuntime)
    const captain = { id: 'cap-t179d' }
    const spawned = host.executeLeadTool(
      'myteam_spawn_member',
      { teamId, roleId: 'implementer', instanceName: 'dev-4' },
      { agent: captain },
    ) as any

    const ok = (await host.executeLeadTool('myteam_message', { teamId, to: spawned.memberId, content: '继续做 t-1' }, { agent: captain })) as any
    assert.equal(ok.status, 'sent')
    assert.equal(ok.delivered, true, '子代理通道受理即视为送达')
    assert.equal(sent.length, 1, '必须经 subagents.sendMessage 投递')
    assert.equal(sent[0].sender, captain, 'sender 必须是队长 Agent（树里的活祖先）')
    assert.equal(sent[0].target, spawned.sessionId, 'target 必须是账本同一个 childId')
    assert.match(sent[0].text, /继续做 t-1/)

    // 通道在但被拒（child 不 resident）→ 如实 delivered:false，不回落 followup（回落必抛）
    reject.value = true
    const missed = (await host.executeLeadTool('myteam_message', { teamId, to: spawned.memberId, content: '再来一条' }, { agent: captain })) as any
    assert.equal(missed.status, 'sent')
    assert.equal(missed.delivered, false)
    assert.match(String(missed.message), /release|spawn/)
  } finally {
    cleanup()
  }
})

test('t179e: 释放成员 → activation.dispose 被调用（账本说已释放，child 必须真的停）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t179e')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    let disposed = 0
    const subagents = {
      startActivation: (spec: Record<string, unknown>) => {
        captured.spec = spec
        const childId = String(spec['childId'])
        live.set(childId, { id: childId, followup: () => {}, session: { header: { parentSession: 'cap-t179e', agentPreset: 'myteam-member' } } })
        return {
          childId,
          name: String(spec['name'] ?? ''),
          result: Promise.resolve({ stopReason: 'completed' }),
          dispose: () => { disposed += 1; live.delete(childId); return Promise.resolve() },
        }
      },
    }
    const runtime = baseRuntime(root, captured, live) as unknown as Record<string, unknown>
    Object.defineProperty(runtime, 'subagents', { configurable: true, get() { throw new Error(NOT_INJECTED) } })
    runtime['get'] = (name: string) => (name === 'subagents' ? subagents : undefined)
    const { host, teamId } = approvedTeam(runtime as unknown as HostRuntime)
    const spawned = host.executeLeadTool(
      'myteam_spawn_member',
      { teamId, roleId: 'implementer', instanceName: 'dev-5' },
      { agent: { id: 'cap-t179e' } },
    ) as any
    assert.equal(disposed, 0, 'spawn 阶段不许 dispose')

    const released = (await host.executeLeadTool('myteam_release_member', { teamId, memberId: spawned.memberId, mode: 'suspend' }, {})) as any
    assert.equal(released.status, 'suspend', JSON.stringify(released))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(disposed, 1, '释放必须 dispose 掉 activation（否则 child 还在跑）')
    assert.equal(live.has(String(spawned.sessionId)), false, 'dispose 后 child 不再可达')
  } finally {
    cleanup()
  }
})
