/**
 * T169 · CHG-210 批 6.6：**成员也能看名册**。
 *
 * 缺陷现场：`tool-tiers` 把 `myteam_list_members` 标成 A 档（成员可用）、
 * `delegationToolDefs()` 也把它发给了成员，但**成员通道的分支里没有它**——
 * 于是成员看得到这个工具、调了却得 `MT_UNKNOWN_TOOL`。一个「工具存在但不可用」的空壳。
 *
 * 为什么该放行而不是降档：名册是只读面，而 `myteam_peer_message` 需要知道队友 id；
 * 不放行等于逼成员用错出口（发给 `'lead'`，见 t168）。
 *
 * 本文件钉两件事：
 *   ① 成员调 `list_members` 不再是 `MT_UNKNOWN_TOOL`；
 *   ② 返回的名册里能查到队友（不是空壳）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
  } as unknown as HostRuntime
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [],
  }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const b = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'b' }, {}) as any
  const as = (m: any) => ({ memberId: String(m.memberId), roleId: String(m.roleId), instanceName: String(m.instanceName ?? m.memberId), sessionId: String(m.sessionId), teamId })
  return { host, teamId, a: as(a), b: as(b) }
}

test('t169-1: 成员调 list_members 不再是 MT_UNKNOWN_TOOL', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t169-ok-'))
  try {
    const { host, teamId, a } = setup(root)
    const r = host.executeMemberTool(a, 'myteam_list_members', { teamId }) as any
    assert.notEqual(r.code, 'MT_UNKNOWN_TOOL', `成员通道必须认识这个工具：${JSON.stringify(r)}`)
    assert.notEqual(r.status, 'error', `名册是只读面，不该拒绝：${JSON.stringify(r)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t169-2: 名册里能查到队友（不是空壳）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t169-roster-'))
  try {
    const { host, teamId, a, b } = setup(root)
    const r = host.executeMemberTool(a, 'myteam_list_members', { teamId }) as any
    const list = (r.members ?? r.items ?? []) as any[]
    assert.ok(Array.isArray(list), `返回结构里应有名册数组：${JSON.stringify(r)}`)
    const ids = list.map((m) => String(m.memberId ?? m.id ?? ''))
    assert.ok(ids.includes(b.memberId), `名册应包含队友 ${b.memberId}，实际 ${JSON.stringify(ids)}`)
    assert.ok(ids.includes(a.memberId), '名册应包含自己')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
