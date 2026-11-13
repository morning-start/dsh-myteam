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
 *
 * 本文件的 ④⑤ 由「宿主写路径」那一批提交补上（`spawnMember` 记父 / `release` 级联 / 端点），
 * 当前这批只锁纯规则层 + 向后兼容（旧账本 / 旧配置）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { depthOf, childrenOf, cascadeOrder, assertSpawnAllowed } from '../src/core/members/hierarchy.ts'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import { DEFAULT_CONFIG, PATCH_CEILINGS, loadEffectiveConfig } from '../src/core/config/team-config.ts'

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
