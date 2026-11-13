/**
 * T139 · 成员派生树（FR-32 支柱一 / CHG-187）
 *
 * 判据分五段：
 *  ① 纯函数（深度 / 直接子 / 级联顺序 / 两个拒绝码）——深度、子数、顺序三条规则必须能脱离宿主单测；
 *  ② **旧账本可读**（t139-9）：`member.spawned` 只有原来 5 个字段时，投影默认成「一级成员」；
 *  ③ **旧团队配置可读**（t139-10）：`team.config.json` 里已有的 `memberMaxDepth: 0` 保持 0；
 *  ④ 宿主写路径（t139-6/7/8）走**真实入口**（`executeLeadTool`），不用 `host.commit` 桩——
 *     接线断链正是「单测绕过入口」时最容易被漏掉的那类缺陷；
 *  ⑤ 名册只读面（t139-11）：`listMembers` 的 `childCount` 与派生树一致，读不到成员就返回空数组。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { depthOf, childrenOf, cascadeOrder, assertSpawnAllowed } from '../src/core/members/hierarchy.ts'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import { DEFAULT_CONFIG, PATCH_CEILINGS, loadEffectiveConfig } from '../src/core/config/team-config.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const m = (id: string, parent: string | null, depth: number) => ({
  id, parentMemberId: parent, depth, rootMemberId: parent ? 'm1' : id,
})
const roster = [m('m1', null, 0), m('m2', 'm1', 1), m('m3', 'm2', 2), m('m4', 'm1', 1)]

test('t139-1: depthOf = 根为 0，逐级 +1', () => {
  assert.equal(depthOf(roster, 'm1'), 0)
  assert.equal(depthOf(roster, 'm2'), 1)
  assert.equal(depthOf(roster, 'm3'), 2)
})

test('t139-2: childrenOf 只返回直接子成员', () => {
  assert.deepEqual(childrenOf(roster, 'm1').map((x) => x.id), ['m2', 'm4'])
  assert.deepEqual(childrenOf(roster, 'm3'), [])
})

test('t139-3: cascadeOrder 是**倒序**（叶子先释放，父最后）', () => {
  assert.deepEqual(cascadeOrder(roster, 'm1'), ['m3', 'm2', 'm4', 'm1'])
})

test('t139-4: 深度超限拒绝，错误码 MT_DEPTH_EXCEEDED 带实测值', () => {
  // m3 深度 2 → 它的子成员深度 3；maxDepth 1 ⇒ 拒绝，消息必须带**实测值**（3 而不是抽象的「超限」）
  const err = (() => { try { assertSpawnAllowed(roster, 'm3', { maxDepth: 1, maxChildren: 3 }) } catch (e) { return e } })()
  assert.equal((err as { code?: string }).code, 'MT_DEPTH_EXCEEDED')
  assert.match((err as Error).message, /depth 3 > maxDepth 1/)
})

test('t139-5: 子数超限拒绝，错误码 MT_CHILDREN_LIMIT', () => {
  const err = (() => { try { assertSpawnAllowed(roster, 'm1', { maxDepth: 2, maxChildren: 1 }) } catch (e) { return e } })()
  assert.equal((err as { code?: string }).code, 'MT_CHILDREN_LIMIT')
})

/* ── ② 旧账本可读（向后兼容：默认保守，不许让老项目崩）────────────── */

test('t139-9: 旧载荷（只有原来 5 个字段）→ 投影默认成一级成员，不崩', () => {
  // 老账本里的成员就是「队长直接召唤的一级成员」——这是唯一诚实的解释（不是猜）。
  // 默认成 undefined 会让名册/面板的 parentMemberId 比较出现 undefined 分支。
  const events = [
    { seq: 1, ts: 1, actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'active' } },
    { seq: 2, ts: 2, actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm2', roleId: 'implementer', sessionId: 's2', status: 'active' } },
  ] as never
  const proj = foldEvents('t1', events)
  for (const id of ['m1', 'm2']) {
    assert.equal(proj.members[id].parentMemberId, null, `${id} 的父成员必须是 null（一级成员）`)
    assert.equal(proj.members[id].depth, 0, `${id} 的深度必须是 0`)
    assert.equal(proj.members[id].rootMemberId, id, `${id} 的树根必须是它自己`)
  }
  assert.deepEqual(childrenOf([proj.members.m1, proj.members.m2], 'm1'), [], '旧账本不得凭空长出父子边')
})

/* ── ③ 旧团队配置可读（默认值只对新建团队生效）───────────────────── */

test('t139-10: 老团队配置里已有的 memberMaxDepth: 0 保持 0（读时合并，不重写文件）', () => {
  assert.equal(DEFAULT_CONFIG.limits.memberMaxDepth, 1, '新默认值：允许一层子成员')
  assert.equal(DEFAULT_CONFIG.limits.maxChildren, 3)
  const legacy = loadEffectiveConfig(undefined, { limits: { memberMaxDepth: 0 } })
  assert.equal(legacy.config.limits.memberMaxDepth, 0, '老团队显式关掉派生 → 读出来还是 0（不是 1）')
  assert.equal(legacy.config.limits.maxChildren, 3, '没写的新字段由默认补')
  assert.deepEqual(legacy.warnings.filter((w) => w.includes('memberMaxDepth')), [], '0 不触发钳制告警（它在硬上限之内）')
  // 硬上限仍然生效：超过 2 的配置被钳到 2（更严格者胜）
  const clamped = loadEffectiveConfig(undefined, { limits: { memberMaxDepth: 9, maxChildren: 9 } })
  assert.equal(clamped.config.limits.memberMaxDepth, PATCH_CEILINGS['limits.memberMaxDepth'])
  assert.equal(clamped.config.limits.maxChildren, PATCH_CEILINGS['limits.maxChildren'])
  assert.ok(clamped.warnings.some((w) => w.includes('memberMaxDepth 9 exceeds patch ceiling 2')), clamped.warnings.join(' / '))
})

/* ── ④ 宿主写路径（真实入口，禁止 host.commit 桩）────────────────── */

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, dispose: () => {} }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
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

/** 已批准的空团队（roster 只有队长；任务为空——本用例只关心成员树） */
function approvedTeam(root: string) {
  const host = new MyTeamHost(makeRuntime(root), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T139', goal: '派生树', roster: [{ roleId: 'captain' }], tasks: [] }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  return { host, teamId: String(sub.teamId) }
}

function ledgerEventsOf(root: string, teamId: string): any[] {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

/** 父成员（一级）+ 子成员（深度 1）——派生树的最小形态 */
function treeOf(host: MyTeamHost, teamId: string) {
  const parent = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'parent' }, {}) as any
  assert.ok(['spawned', 'ok'].includes(String(parent.status)), `父成员应召唤成功：${JSON.stringify(parent)}`)
  const child = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'child', parentMemberId: parent.memberId }, {}) as any
  assert.ok(['spawned', 'ok'].includes(String(child.status)), `子成员应召唤成功：${JSON.stringify(child)}`)
  return { parent, child }
}

test('t139-6: 真实入口 spawn 子成员 → 账本落 parentMemberId/depth/rootMemberId', () => {
  const { root, cleanup } = tempWorkspace('myteam-t139-spawn')
  try {
    const { host, teamId } = approvedTeam(root)
    const parent = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'parent' }, {}) as any
    assert.equal(parent.depth, 0, '一级成员深度 0')
    assert.equal(parent.parentMemberId, null)
    assert.equal(parent.rootMemberId, parent.memberId, '根成员的树根是它自己')

    const child = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'child', parentMemberId: parent.memberId }, {}) as any
    assert.equal(child.depth, 1)
    assert.equal(child.parentMemberId, parent.memberId)
    assert.equal(child.rootMemberId, parent.memberId, '子成员的树根是父成员所在树的根')

    // 账本：**active 结算**那条必须是派生树事实（provisioning 那条也有，取最后一条 = 真实阶段）
    const spawnEvents = ledgerEventsOf(root, teamId).filter((event) => event.type === 'member.spawned')
    const lastOfChild = spawnEvents.filter((event) => event.payload.memberId === child.memberId).at(-1)!
    assert.equal(lastOfChild.payload.parentMemberId, parent.memberId)
    assert.equal(lastOfChild.payload.depth, 1)
    assert.equal(lastOfChild.payload.rootMemberId, parent.memberId)
    const lastOfParent = spawnEvents.filter((event) => event.payload.memberId === parent.memberId).at(-1)!
    assert.equal(lastOfParent.payload.parentMemberId, null)
    assert.equal(lastOfParent.payload.depth, 0)
  } finally {
    cleanup()
  }
})

test('t139-7: 有子成员时 release 不带 cascade 被拒（MT_HAS_CHILDREN），且账本零写入', () => {
  const { root, cleanup } = tempWorkspace('myteam-t139-haschildren')
  try {
    const { host, teamId } = approvedTeam(root)
    const { parent } = treeOf(host, teamId)
    const before = ledgerEventsOf(root, teamId)

    const rejected = host.executeLeadTool('myteam_release_member', { teamId, memberId: parent.memberId, mode: 'suspend' }, {}) as any
    assert.equal(rejected.status, 'error', JSON.stringify(rejected))
    assert.equal(rejected.code, 'MT_HAS_CHILDREN')
    assert.match(String(rejected.message), /cascade:true/)

    const after = ledgerEventsOf(root, teamId)
    assert.equal(after.length, before.length, '冲突时账本必须零写入（多一条释放事件 = 子成员变孤儿）')
    assert.equal(host.service(teamId).projectionSnapshot.members[parent.memberId].status, 'active', '被拒后成员仍 active')
  } finally {
    cleanup()
  }
})

test('t139-8: cascade 释放是倒序（子先、父后）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t139-cascade')
  try {
    const { host, teamId } = approvedTeam(root)
    const { parent, child } = treeOf(host, teamId)

    const released = host.executeLeadTool('myteam_release_member', { teamId, memberId: parent.memberId, mode: 'suspend', cascade: true }, {}) as any
    assert.equal(released.status, 'suspend', JSON.stringify(released))

    const releaseEvents = ledgerEventsOf(root, teamId).filter((event) => event.type === 'member.released')
    assert.deepEqual(releaseEvents.map((event) => event.payload.memberId), [child.memberId, parent.memberId], '级联必须叶子先、父最后')
    assert.deepEqual(releaseEvents.map((event) => event.payload.reason), ['cascade', 'cascade'], '级联释放要留痕（与手动释放区分）')
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.members[child.memberId].status, 'suspended')
    assert.equal(proj.members[parent.memberId].status, 'suspended')
  } finally {
    cleanup()
  }
})

/* ── ⑤ 名册只读面 ──────────────────────────────────────────────── */

test('t139-11: listMembers 返回派生树事实（父 / 深度 / 树根 / childCount），读不到就是空数组', () => {
  const { root, cleanup } = tempWorkspace('myteam-t139-list')
  try {
    const { host, teamId } = approvedTeam(root)
    const { parent, child } = treeOf(host, teamId)

    const listed = host.executeLeadTool('myteam_list_members', { teamId }, {}) as any
    assert.equal(listed.status, 'ok', JSON.stringify(listed))
    assert.equal(listed.teamId, teamId)
    const byId = new Map<string, any>(listed.members.map((member: any) => [member.id, member]))
    assert.equal(byId.get(parent.memberId).childCount, 1, '父成员有 1 个直接子成员')
    assert.equal(byId.get(parent.memberId).depth, 0)
    assert.equal(byId.get(child.memberId).parentMemberId, parent.memberId)
    assert.equal(byId.get(child.memberId).depth, 1)
    assert.equal(byId.get(child.memberId).rootMemberId, parent.memberId)
    assert.equal(byId.get(child.memberId).childCount, 0)

    // 零伪造：没有成员的服务（不存在的团队 id）→ 空数组，不编造
    const empty = host.executeLeadTool('myteam_list_members', { teamId: 'no-such-team' }, {}) as any
    assert.equal(empty.status, 'ok')
    assert.deepEqual(empty.members, [])
    assert.equal(empty.total, 0)
  } finally {
    cleanup()
  }
})
