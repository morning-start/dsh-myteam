/**
 * T107 · CHG-137（docs/19 §三「档位元数据」）：工具权限档位——单一事实源 + 只收窄门禁。
 *
 * 断言：
 *  ① **双向锁死**：`leadToolDefs()` 的每个名字都在 `TOOL_TIERS` 里；`TOOL_TIERS` 的每个键都是真实工具
 *    （改工具忘改档位 / 删工具留孤儿 → 变红）；
 *  ② 档位取值只能是 `A / C / CM / H`；
 *  ③ `canCall` 矩阵：captain 可 A/C/CM、**不可 H**；member 只可 A（CM 需显式授权）、不可 C/H；
 *    human 全可；
 *  ④ 未登记工具 → `canCall` 返回 `false`（**默认拒绝**，不是放行）；
 *  ⑤ `toolsByTier()` 分组完整、组内有序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadToolDefs, memberToolDefs } from '../src/tools/defs.ts'
import { TOOL_TIERS, canCall, tierOf, toolsByTier, type ToolTier } from '../src/core/tools/tool-tiers.ts'

const TIERS: ToolTier[] = ['A', 'C', 'CM', 'H']

test('t107-1: 双向锁死 —— defs ↔ 档位表一一对应（队长 + 成员两侧都算）', () => {
  const names = [...leadToolDefs(), ...memberToolDefs()].map((def) => def.name).sort()
  const mapped = Object.keys(TOOL_TIERS).sort()
  const missing = names.filter((name) => !mapped.includes(name))
  const orphans = mapped.filter((name) => !names.includes(name))
  assert.deepEqual(missing, [], `这些工具缺档位：${missing.join(', ')}`)
  assert.deepEqual(orphans, [], `档位表里有不存在的工具：${orphans.join(', ')}`)
  assert.equal(names.length, mapped.length)
  assert.ok(names.length >= 60, `工具数异常（${names.length}）`)
})

test('t107-2: 档位取值合法 + 分组完整有序', () => {
  for (const [name, tier] of Object.entries(TOOL_TIERS)) {
    assert.ok(TIERS.includes(tier), `${name} 档位非法：${tier}`)
  }
  const grouped = toolsByTier()
  const flat = TIERS.flatMap((tier) => grouped[tier])
  assert.equal(flat.length, Object.keys(TOOL_TIERS).length, '分组必须无遗漏无重复')
  for (const tier of TIERS) {
    const group = grouped[tier]
    assert.deepEqual(group, [...group].sort(), `${tier} 组必须有序`)
    for (const name of group) assert.equal(tierOf(name), tier)
  }
})

test('t107-3: canCall 矩阵 —— 只收窄，不扩权', () => {
  /* 队长：A/C/CM 可，H 不可 */
  assert.equal(canCall('myteam_list_tasks', 'captain'), true)
  assert.equal(canCall('myteam_create_task', 'captain'), true)
  assert.equal(canCall('myteam_get_audit', 'captain'), true)
  assert.equal(canCall('myteam_disband', 'captain'), false, 'H 档队长也不可调（人类专属）')
  assert.equal(canCall('myteam_publish_role', 'captain'), false)
  /* 成员：只有 A；CM 需显式授权；C/H 一律不可 */
  assert.equal(canCall('myteam_list_tasks', 'member'), true)
  assert.equal(canCall('myteam_get_audit', 'member'), false, 'CM 未授权不可用')
  assert.equal(canCall('myteam_get_audit', 'member', true), true, 'CM 显式授权后可用')
  assert.equal(canCall('myteam_create_task', 'member', true), false, 'C 档授权也不能扩到成员')
  assert.equal(canCall('myteam_disband', 'member', true), false)
  /* 人类：全可 */
  for (const tier of TIERS) {
    const name = toolsByTier()[tier][0]
    assert.equal(canCall(name, 'human'), true, `human 应可调 ${name}（${tier}）`)
  }
})

test('t107-4: 未登记工具默认拒绝', () => {
  assert.equal(tierOf('myteam_not_a_tool'), undefined)
  assert.equal(canCall('myteam_not_a_tool', 'human'), false, '未登记 ≠ 放行（人类也不行，必须先登记）')
  assert.equal(canCall('', 'captain'), false)
})
