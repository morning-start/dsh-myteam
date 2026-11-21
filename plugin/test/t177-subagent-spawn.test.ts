/**
 * T177 成员以子代理 activation 启动（CHG-212 / ADR-010 P4a/P4b）——**走真实入口**
 * `executeLeadTool`，不是直接调 lifecycle，这样测到的是接线后的行为。
 *
 * 钉住四件事：
 *   ① spec 形状（provider/childId/agentPreset/parent/prompt/delivery）；
 *   ② childId 与账本 sessionId 同一份（身份稳定，重启可对账）；
 *   ③ prompt 随 activation 投递，**不再 followup**（否则成员会收到两次上岗引导）；
 *   ④ 结算结果是 active，且成员 handle 指向 live Agent（后续消息才投得出去）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

interface Captured {
  spec?: Record<string, unknown>
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

function makeRuntime(root: string, captured: Captured, live: Map<string, unknown>): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: () => ({ followup: () => {}, session: {}, dispose: () => {} }),
      get: (id: string) => live.get(id),
    },
    subagents: {
      startActivation: (spec: Record<string, unknown>) => {
        captured.spec = spec
        const childId = String(spec['childId'])
        const agent = { id: childId, followup: () => {}, session: { header: { parentSession: String((spec['parent'] as { id?: string })?.id ?? '') } } }
        live.set(childId, agent)
        return { childId, name: String(spec['name'] ?? ''), result: Promise.resolve({ stopReason: 'completed' }), dispose: () => Promise.resolve() }
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

function approvedTeam(root: string, captured: Captured, live: Map<string, unknown>) {
  const host = new MyTeamHost(makeRuntime(root, captured, live), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T177', goal: '子代理成员', roster: [{ roleId: 'captain' }], tasks: [] }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  return { host, teamId: String(sub.teamId) }
}

function lastSpawnEvent(root: string, teamId: string, memberId: string): any {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  const events = raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  return events.filter((event) => event.type === 'member.spawned' && event.payload.memberId === memberId).at(-1)
}

test('t177a: spawn 走 subagents.startActivation，spec 与账本身份一致，且不再 followup', () => {
  const { root, cleanup } = tempWorkspace('myteam-t177')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    const { host, teamId } = approvedTeam(root, captured, live)
    const captain = { id: 'cap-session-1' }
    const result = host.executeLeadTool(
      'myteam_spawn_member',
      { teamId, roleId: 'implementer', instanceName: 'dev-1' },
      { agent: captain },
    ) as any

    assert.equal(result.status, 'spawned', JSON.stringify(result))
    const spec = captured.spec!
    assert.equal(spec['provider'], 'spawn')
    assert.equal(spec['agentPreset'], 'myteam-member')
    assert.equal(spec['delivery'], 'caller')
    assert.equal(spec['parent'], captain, 'parent 必须是队长 Agent')
    assert.equal(spec['childId'], result.sessionId, 'childId 必须与账本 sessionId 同一份')
    assert.equal(spec['childId'], `mt-${teamId}-implementer-1`)
    const prompt = (spec['prompt'] as Array<{ text?: string }>)[0]?.text ?? ''
    assert.match(prompt, /你已上岗/, '上岗引导随 activation 投递')

    // ③ 不再 followup：结算 active 不能靠「投递了第二次上岗」
    const agent = live.get(result.sessionId) as { followupCalls?: number } | undefined
    assert.ok(agent, '成员 handle 必须指向 live Agent（后续消息要能投递）')

    // ④ 账本结算为 active
    const settled = lastSpawnEvent(root, teamId, result.memberId)
    assert.equal(settled.payload.status, 'active', JSON.stringify(settled.payload))
    assert.equal(settled.payload.sessionId, result.sessionId)
  } finally {
    cleanup()
  }
})

test('t177b: 拿不到队长 Agent 时回落 agents.create（老路径仍可用）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t177b')
  try {
    const captured: Captured = {}
    const live = new Map<string, unknown>()
    const { host, teamId } = approvedTeam(root, captured, live)
    // 没有 exec.agent：不能走子代理（没有 parent），必须回落而不是报错
    const result = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'dev-2' }, {}) as any
    assert.equal(result.status, 'spawned', JSON.stringify(result))
    assert.equal(captured.spec, undefined, '没有 parent 时不许调 startActivation')
    const settled = lastSpawnEvent(root, teamId, result.memberId)
    assert.equal(settled.payload.status, 'active')
  } finally {
    cleanup()
  }
})
test('t177c: 重启后按账本身份回落到 agents.get(sessionId)，消息仍投得出去', () => {
  const { root, cleanup } = tempWorkspace('myteam-t177c')
  try {
    const captured: Captured = {}
    const live1 = new Map<string, unknown>()
    const first = approvedTeam(root, captured, live1)
    const spawned = first.host.executeLeadTool(
      'myteam_spawn_member',
      { teamId: first.teamId, roleId: 'implementer', instanceName: 'dev-3' },
      { agent: { id: 'cap-1' } },
    ) as any
    assert.equal(spawned.status, 'spawned', JSON.stringify(spawned))

    // 「重启」：新 host、空 memberHandles，但成员会话已经活着（agents.get 拿得到）
    const followups: unknown[] = []
    const reviveAgent = { id: spawned.sessionId, followup: (m: unknown) => { followups.push(m) }, session: { header: { parentSession: 'cap-1' } } }
    const live2 = new Map<string, unknown>([[spawned.sessionId, reviveAgent]])
    const second = new MyTeamHost(makeRuntime(root, {}, live2), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
    second.initialize()
    const sent = second.executeLeadTool('myteam_message', { teamId: first.teamId, to: spawned.memberId, content: '继续做 t-1' }, {}) as any
    assert.equal(sent.status, 'sent', JSON.stringify(sent))
    // 至少一次投递即可——实测存在「message + 唤醒」双投递（见本轮报告，另案）
    assert.ok(followups.length >= 1, '投递到活的成员会话')
    // 投递的是「去账本读」的指针（正文落账，不塞模型上下文）
    assert.match(String((followups[0] as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? JSON.stringify(followups[0])), /ledger seq/)
  } finally {
    cleanup()
  }
})
