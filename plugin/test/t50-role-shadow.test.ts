/**
 * CHG-74：同名角色副本（内置 / 全局 / 项目库同一 id）的口径统一。
 *
 * 背景：spawn 会把内置角色复制进项目库（引用即复制），于是同一个 id 可能同时存在多份。
 * 旧实现的两个真缺陷：
 *   1. **详情取错来源**：`buildRoleDetailView` 用 `entries.find(id)` → 命中第一份（内置），
 *      于是「项目里改的那份，详情却显示内置定义」，编辑入口也走错分支（fork 而非 edit）；
 *   2. **列表 id 重复**：视图里同 id 出现两份，客户端用 `role.id` 当 React key → 重复 key。
 *
 * 新口径：**运行时真相恒为项目库**（R13），同名时按 project > project-role > global > builtin 裁决，
 * 被压过的那份标 `shadowedBy`（谁让我让位），目录不隐藏任何一份（隐藏会让人以为角色丢了）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copyToProject,
  listRoleCatalog,
  resolveEffectiveRole,
  markShadowedRoles,
  writeProjectRole,
  writeProjectRoleCard,
  type RoleEntry,
} from '../src/core/roles/role-store.ts'
import { buildRoleCatalogView, buildRoleDetailView } from '../src/remote/views.ts'

const pathsOf = (root: string) => ({ projectRolesDir: join(root, 'config', 'roles') })

test('t50-1: 同名副本 → 目录两份都在，让位者标 shadowedBy（不隐藏 = 不让人以为角色丢了）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t50-catalog-'))
  const paths = pathsOf(root)
  copyToProject(paths, 'req-validator', 'builtin')
  copyToProject(paths, 'developer', 'builtin')
  const catalog = listRoleCatalog(paths)
  const ids = catalog.map((e) => e.definition.id)
  // 内置 6 个 + 项目库 2 个副本 = 8 条（副本不折叠）
  assert.equal(catalog.length, 8)
  assert.ok(ids.includes('req-validator') && ids.includes('developer'))
  const rv = catalog.filter((e) => e.definition.id === 'req-validator')
  assert.equal(rv.length, 2, '同名两份都在目录里')
  const builtin = rv.find((e) => e.origin === 'builtin')!
  const project = rv.find((e) => e.origin === 'project')!
  assert.equal(builtin.shadowedBy, 'project', '内置那份应标注「被项目库那份压过」')
  assert.equal(project.shadowedBy, undefined, '生效的那份不标')
  // 没被压过的角色没有 shadowedBy
  assert.equal(catalog.find((e) => e.definition.id === 'captain')?.shadowedBy, undefined)
})

test('t50-2: 生效条目 = 优先级最高者（project > project-role > global > builtin）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t50-effective-'))
  const paths = pathsOf(root)
  copyToProject(paths, 'req-validator', 'builtin')
  writeProjectRoleCard(paths, {
    id: 'project-assistant', name: '项目助理', description: 'd', systemPrompt: 'p',
  } as never)
  const catalog = listRoleCatalog(paths)
  // 项目库副本优先于内置
  assert.equal(resolveEffectiveRole(catalog, 'req-validator')?.origin, 'project')
  // 项目自身角色在无项目库副本时胜出
  assert.equal(resolveEffectiveRole(catalog, 'project-assistant')?.origin, 'project-role')
  // 不存在的 id → undefined（不静默回落）
  assert.equal(resolveEffectiveRole(catalog, 'ghost'), undefined)
})

test('t50-3: 角色详情取生效条目（项目里改的那份，不是内置那份）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t50-detail-'))
  const paths = pathsOf(root)
  copyToProject(paths, 'req-validator', 'builtin')
  // 项目库里把这份改了名（模拟用户在项目里编辑）
  writeProjectRole(paths.projectRolesDir, {
    id: 'req-validator', name: '项目版需求验证员', description: 'd', systemPrompt: 'p',
  } as never)
  const catalog = listRoleCatalog(paths)
  const detail = buildRoleDetailView(catalog, 'req-validator', [])!
  assert.equal(detail.origin, 'project')
  assert.equal(detail.definition.name, '项目版需求验证员')
  assert.equal(detail.editable, true, '项目库那份可直接编辑')
  assert.deepEqual(detail.shadowed, ['builtin'], '被压过的来源要如实列出')
  // 只有内置、没有项目副本时：详情是内置那份且不可直接编辑（要 fork）
  const onlyBuiltin = buildRoleDetailView(
    listRoleCatalog({ projectRolesDir: join(root, 'empty-roles') }),
    'req-validator',
    [],
  )!
  assert.equal(onlyBuiltin.origin, 'builtin')
  assert.equal(onlyBuiltin.editable, false)
  assert.deepEqual(onlyBuiltin.shadowed, [])
})

test('t50-4: 目录视图透传 shadowedBy；同 id 的两份各自标自己的来源（UI 可分别标注）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t50-view-'))
  const paths = pathsOf(root)
  copyToProject(paths, 'req-validator', 'builtin')
  const view = buildRoleCatalogView(listRoleCatalog(paths), [])
  const copies = view.roles.filter((r) => r.id === 'req-validator')
  assert.equal(copies.length, 2)
  assert.equal(copies.find((r) => r.origin === 'builtin')?.shadowedBy, 'project')
  assert.equal(copies.find((r) => r.origin === 'project')?.shadowedBy, undefined)
})

test('t50-5: markShadowedRoles 是纯函数：同 id 多份只标低优先级那份', () => {
  const def = (id: string, origin: RoleEntry['origin']): RoleEntry => ({
    origin,
    definition: { id, name: id, description: '', systemPrompt: '' } as never,
  })
  const entries = markShadowedRoles([def('x', 'builtin'), def('x', 'global'), def('x', 'project'), def('y', 'builtin')])
  const byId = (id: string) => entries.filter((e) => e.definition.id === id)
  assert.equal(byId('x').find((e) => e.origin === 'builtin')?.shadowedBy, 'project')
  assert.equal(byId('x').find((e) => e.origin === 'global')?.shadowedBy, 'project')
  assert.equal(byId('x').find((e) => e.origin === 'project')?.shadowedBy, undefined)
  assert.equal(byId('y')[0].shadowedBy, undefined, '不同 id 不互相影响')
})
