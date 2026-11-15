/**
 * T146 · CHG-202y（FR-32 · G1-4）：**角色委派声明**（`delegation`）。
 *
 * 为什么必须有这一份：`myteam_spawn_member` / `myteam_release_member` 从 C 档挪到 CM 档后，
 * 「成员能不能派生」需要一个**角色级**的单一事实源。缺省 = **不可派生**（只收窄、无默认放行），
 * 所以校验必须拒绝式：写错了不能静默退化成「可以派生」。
 *
 * 覆盖：① 合法形状通过；② 8 类非法形状逐个拒绝；③ 硬上限与 `PATCH_CEILINGS` 同源；
 * ④ `createRole` / `updateRole` 的落盘与收回（`delegation: null`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertValidRole, RoleError, type RoleDefinition } from '../src/core/roles/role-store.ts'
import { PATCH_CEILINGS } from '../src/core/config/team-config.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function def(over: Partial<RoleDefinition> = {}): RoleDefinition {
  return { id: 'implementer', name: '实现者', description: 'd', systemPrompt: 'sp', version: 1, ...over }
}

function codeOf(fn: () => void): string {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof RoleError, `expected RoleError, got ${String(e)}`)
    return e.code
  }
  assert.fail('expected a RoleError')
}

test('t146-1: 合法委派声明通过（canSpawn 必填布尔；白名单/深度/子数可选）', () => {
  assert.doesNotThrow(() => assertValidRole(def({ delegation: { canSpawn: true } })))
  assert.doesNotThrow(() => assertValidRole(def({ delegation: { canSpawn: true, allowedRoles: ['implementer', 'reviewer'], maxDepth: 1, maxChildren: 3 } })))
  // 不可派生 = 合法（缺省语义）
  assert.doesNotThrow(() => assertValidRole(def({ delegation: { canSpawn: false } })))
  // 完全不写 delegation = 与 v4.0 之前一致
  assert.doesNotThrow(() => assertValidRole(def()))
})

test('t146-2: 非法形状逐个拒绝（不能静默退化成「可以派生」）', () => {
  const cases: [string, unknown][] = [
    ['非对象', 'yes'],
    ['数组', []],
    ['缺 canSpawn', {}],
    ['canSpawn 非布尔', { canSpawn: 'true' }],
    ['allowedRoles 空数组', { canSpawn: true, allowedRoles: [] }],
    ['allowedRoles 非字符串项', { canSpawn: true, allowedRoles: [1] }],
    ['allowedRoles 非法 id', { canSpawn: true, allowedRoles: ['Bad Id'] }],
    ['canSpawn:false 却写了白名单（自相矛盾）', { canSpawn: false, allowedRoles: ['implementer'] }],
    ['maxDepth 越界', { canSpawn: true, maxDepth: 3 }],
    ['maxDepth 非整数', { canSpawn: true, maxDepth: 1.5 }],
    ['maxDepth 为负', { canSpawn: true, maxDepth: -1 }],
    ['maxChildren 越界', { canSpawn: true, maxChildren: 6 }],
    ['maxChildren 为 0', { canSpawn: true, maxChildren: 0 }],
  ]
  for (const [label, delegation] of cases) {
    const code = codeOf(() => assertValidRole(def({ delegation: delegation as RoleDefinition['delegation'] })))
    assert.equal(code, 'MT_ROLE_INVALID', label)
  }
})

test('t146-3: 硬上限与 PATCH_CEILINGS 同源（两份常量不许漂移）', () => {
  assert.equal(PATCH_CEILINGS['limits.memberMaxDepth'], 2, 'memberMaxDepth 硬上限 = 2')
  assert.equal(PATCH_CEILINGS['limits.maxChildren'], 5, 'maxChildren 硬上限 = 5')
  // 边界值正好是上限
  assert.doesNotThrow(() => assertValidRole(def({ delegation: { canSpawn: true, maxDepth: 2, maxChildren: 5 } })))
  assert.equal(codeOf(() => assertValidRole(def({ delegation: { canSpawn: true, maxDepth: 3 } }))), 'MT_ROLE_INVALID')
})

function makeRuntime(root: string) {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

test('t146-4: createRole 落盘 delegation；updateRole 可改、传 null 收回', () => {
  const root = mkdtempSync(join(tmpdir(), 't146-4-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    const created = host.createRole({
      roleId: 'team-lead',
      name: '小组长',
      description: '可以派生实现者',
      systemPrompt: 'sp',
      delegation: { canSpawn: true, allowedRoles: ['implementer'], maxDepth: 1, maxChildren: 2 },
    }) as Record<string, unknown>
    assert.notEqual(created.status, 'error', JSON.stringify(created))

    const found = (host.roleCatalog() as Array<{ definition: RoleDefinition }>)
      .map((entry) => entry.definition)
      .find((entry) => entry.id === 'team-lead')
    assert.ok(found, '角色必须落进项目库')
    assert.deepEqual(found!.delegation, { canSpawn: true, allowedRoles: ['implementer'], maxDepth: 1, maxChildren: 2 })

    // 改白名单
    const updated = host.updateRole({ roleId: 'team-lead', patch: { delegation: { canSpawn: true, allowedRoles: ['reviewer'] } } }) as Record<string, unknown>
    assert.notEqual(updated.status, 'error', JSON.stringify(updated))
    const afterUpdate = (host.roleCatalog() as Array<{ definition: RoleDefinition }>)
      .map((entry) => entry.definition)
      .find((entry) => entry.id === 'team-lead')
    assert.deepEqual(afterUpdate!.delegation, { canSpawn: true, allowedRoles: ['reviewer'] })

    // 传 null 收回（回到不可派生）
    const cleared = host.updateRole({ roleId: 'team-lead', patch: { delegation: null } }) as Record<string, unknown>
    assert.notEqual(cleared.status, 'error', JSON.stringify(cleared))
    const afterClear = (host.roleCatalog() as Array<{ definition: RoleDefinition }>)
      .map((entry) => entry.definition)
      .find((entry) => entry.id === 'team-lead')
    assert.equal(afterClear!.delegation, undefined, 'delegation:null 必须把它删掉，而不是留一个空对象')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t146-5: createRole 的非法 delegation 被拒绝且不落盘', () => {
  const root = mkdtempSync(join(tmpdir(), 't146-5-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    const r = host.createRole({
      roleId: 'bad-role',
      name: 'x',
      description: 'd',
      systemPrompt: 'sp',
      delegation: { canSpawn: false, allowedRoles: ['implementer'] },
    }) as Record<string, unknown>
    assert.equal(r.status, 'error')
    assert.equal(r.code, 'MT_ROLE_INVALID')
    assert.equal(
      (host.roleCatalog() as Array<{ definition: RoleDefinition }>).some((entry) => entry.definition.id === 'bad-role'),
      false,
      '校验失败不许落盘',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
