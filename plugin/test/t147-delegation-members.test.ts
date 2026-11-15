/**
 * T147 · CHG-202y（FR-32 · G1-2/G1-3）：**成员侧委派**——档位 C→CM + 两套授权源 + C5 第 9 条。
 *
 * 口径（docs/23 §3.5）：
 *  - `myteam_spawn_member` / `myteam_release_member` 是 **CM 档**：队长天生可调，成员只有
 *    角色 `delegation.canSpawn === true` 时才注册进自己的工具面；
 *  - 其它 CM（审计 / 会话考古）仍看 `toolPolicy.allow` 显式点名——**两套授权源不许混**；
 *  - C5 第 9 条：子成员工具集 **⊆** 父成员（派生是扩编，不是提权）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canCall, tierOf, toolsByTier } from '../src/core/tools/tool-tiers.ts'
import { DELEGATION_TOOL_NAMES, delegationToolDefs, memberToolDefs } from '../src/tools/defs.ts'
import { buildToolMask, childToolSubsetViolation } from '../src/core/members/member-setup.ts'
import type { RoleDefinition } from '../src/core/roles/builtin-roles.ts'

const role = (over: Partial<RoleDefinition> = {}): RoleDefinition =>
  ({ id: 'implementer', name: '实现者', description: 'd', systemPrompt: 'sp', version: 1, ...over })

test('t147-1: spawn/release 是 CM 档——队长可调，成员默认不可调', () => {
  for (const name of DELEGATION_TOOL_NAMES) {
    assert.equal(tierOf(name), 'CM', `${name} 必须是 CM 档`)
    assert.equal(canCall(name, 'captain'), true, '队长天生可调')
    assert.equal(canCall(name, 'member'), false, '成员未授权 = 不可调（CM 没有默认放行）')
    assert.equal(canCall(name, 'member', true), true, '显式授权后成员可调')
  }
  // 档位分布：A 23 / C 36 / CM 4 / H 6 = 69
  const byTier = toolsByTier()
  assert.equal(byTier.A.length, 23)
  assert.equal(byTier.C.length, 36)
  assert.equal(byTier.CM.length, 4)
  assert.equal(byTier.H.length, 6)
  assert.equal(byTier.A.length + byTier.C.length + byTier.CM.length + byTier.H.length, 69)
})

test('t147-2: 委派工具定义按名字从 Lead 表取（不复制 schema），且不在成员固定表里', () => {
  const defs = delegationToolDefs()
  assert.deepEqual(defs.map((def) => def.name).sort(), [...DELEGATION_TOOL_NAMES].sort())
  const fixed = new Set(memberToolDefs().map((def) => def.name))
  for (const name of DELEGATION_TOOL_NAMES) {
    assert.equal(fixed.has(name), false, `${name} 不能进固定成员表（那会让所有成员都看见）`)
  }
})

test('t147-3: C5 第 9 条——子成员工具集 ⊆ 父成员（三种父掩码）', () => {
  // 父无策略（继承全量）→ 子集恒成立
  assert.equal(childToolSubsetViolation(buildToolMask(role()), buildToolMask(role({ toolPolicy: { allow: ['Read'] } }))), null)

  // 父 allow：子必须 allow 且 ⊆ 父
  const parentAllow = buildToolMask(role({ toolPolicy: { allow: ['Read', 'myteam_*'] } }))
  assert.equal(childToolSubsetViolation(parentAllow, buildToolMask(role({ toolPolicy: { allow: ['Read'] } }))), null, '子集通过')
  assert.ok(childToolSubsetViolation(parentAllow, buildToolMask(role({ toolPolicy: { allow: ['Write'] } }))), '子多出 Write 必须拒')
  assert.ok(childToolSubsetViolation(parentAllow, buildToolMask(role())), '父受限时子不能无策略（等于全量）')

  // 父 deny：子不能把父禁掉的工具重新开出来
  const parentDeny = buildToolMask(role({ toolPolicy: { deny: ['Bash'] } }))
  assert.ok(childToolSubsetViolation(parentDeny, buildToolMask(role({ toolPolicy: { allow: ['Bash'] } }))), '子重新启用父 deny 的工具必须拒')
  assert.equal(childToolSubsetViolation(parentDeny, buildToolMask(role({ toolPolicy: { allow: ['Read'] } }))), null, '不碰父 deny 的名字就通过')
})

test('t147-4: delegation 缺省 = 不可派生（canSpawn 未写与 false 同义）', () => {
  // 这是「缺省只收窄」的可执行形式：没有任何 delegation 的角色不能派生
  const plain = role()
  assert.equal(plain.delegation?.canSpawn, undefined)
  assert.equal(canCall('myteam_spawn_member', 'member', plain.delegation?.canSpawn === true), false)
})
