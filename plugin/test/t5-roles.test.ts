import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readProjectRole,
  listProjectRoles,
  writeProjectRole,
  deleteProjectRole,
  resolveRuntimeRole,
  listRoleCatalog,
  copyToProject,
  assertValidRole,
  validateRoster,
  RoleError,
} from '../src/core/roles/role-store.ts'
import { BUILTIN_ROLES } from '../src/core/roles/builtin-roles.ts'

function paths() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t5-'))
  return { paths: { projectRolesDir: join(ws, 'roles'), globalRolesDir: join(ws, 'global') }, ws }
}

function projectDef(id: string, over = {}) {
  return { id, name: id, description: 'd', systemPrompt: 'sp', version: 1, ...over }
}

test('T5: builtin roles are read-only three-layer source (captain/implementer/reviewer)', () => {
  assert.equal(BUILTIN_ROLES.filter((r) => r.isCaptain).length, 1, 'exactly one builtin captain')
  const captain = BUILTIN_ROLES.find((r) => r.id === 'captain')
  assert.ok(captain?.isCaptain)
  // 领域中性抽查：内置提示词不硬编码开发词汇
  for (const r of BUILTIN_ROLES) {
    assert.ok(!/写代码|跑测试|代码评审/.test(r.systemPrompt), `builtin role ${r.id} hardcodes dev domain`)
  }
})

test('T5: project library is runtime truth; runtime resolve never falls back (scene 13)', () => {
  const p = paths()
  // 项目库为空时运行时解析不到
  assert.equal(resolveRuntimeRole(p.paths, 'captain'), undefined)
  // 写入项目库后可解析
  writeProjectRole(p.paths.projectRolesDir, projectDef('captain', { isCaptain: true }))
  const entry = resolveRuntimeRole(p.paths, 'captain')
  assert.equal(entry?.origin, 'project')
  // 删掉项目库文件 → 运行时解析失败（不静默回退内置）
  const { deleteProjectRole: del } = { deleteProjectRole }
  del(p.paths.projectRolesDir, 'captain', [])
  assert.equal(resolveRuntimeRole(p.paths, 'captain'), undefined)
})

test('T5: copy builtin → project adds origin marker; copy is one-way no-sync (scene 14)', () => {
  const p = paths()
  copyToProject(p.paths, 'implementer', 'builtin')
  const copied = readProjectRole(p.paths.projectRolesDir, 'implementer')
  assert.equal(copied?.origin, 'builtin:implementer')
  // 复制是值拷贝：修改项目副本不影响内置
  copied!.systemPrompt = 'changed locally'
  writeProjectRole(p.paths.projectRolesDir, copied!)
  assert.notEqual(BUILTIN_ROLES.find((r) => r.id === 'implementer')!.systemPrompt, 'changed locally')
  // 同名再复制 → 拒绝（不静默覆盖）
  assert.throws(() => copyToProject(p.paths, 'implementer', 'builtin'), (e: unknown) => e instanceof RoleError && e.code === 'MT_ROLE_EXISTS')
})

test('T5: C7 guard — delete bound role refused with occupant list (scene 14)', () => {
  const p = paths()
  writeProjectRole(p.paths.projectRolesDir, projectDef('writer'))
  assert.throws(
    () => deleteProjectRole(p.paths.projectRolesDir, 'writer', ['preset:dev-team']),
    (e: unknown) => e instanceof RoleError && e.code === 'MT_ROLE_OCCUPIED' && Array.isArray((e as RoleError).detail) && (e as RoleError).detail!.length === 1,
  )
  // 无占用可删
  deleteProjectRole(p.paths.projectRolesDir, 'writer', [])
  assert.ok(!existsSync(join(p.paths.projectRolesDir, 'writer.json')))
})

test('T5: validateRoster — exactly one captain (FR-10.1, scenes 11/23)', () => {
  const p = paths()
  mkdirSync(p.paths.projectRolesDir, { recursive: true })
  // 空 roster
  assert.throws(() => validateRoster([], p.paths), (e: unknown) => e instanceof RoleError && e.code === 'MT_ROSTER_EMPTY')
  // 缺队长
  assert.throws(
    () => validateRoster([{ roleId: "implementer" }], p.paths),
    (e: unknown) => e instanceof RoleError && e.code === 'MT_ROSTER_NO_CAPTAIN',
  )
  // 双队长（**手写 JSON** 绕过 assertValidRole —— 这正是名册校验存在的理由：
  // 队长是全局唯一的「类」，走 writeProjectRole 会先被 MT_ROLE_CAPTAIN_RESERVED 拦下，
  // 但手写配置文件仍可能造出两个 isCaptain 定义，名册是那道兜底）
  writeFileSync(
    join(p.paths.projectRolesDir, 'captain-2.json'),
    `${JSON.stringify(projectDef('captain-2', { isCaptain: true }), null, 2)}\n`,
    'utf8',
  )
  assert.throws(
    () => validateRoster([{ roleId: "captain" }, { roleId: "captain-2" }], p.paths),
    (e: unknown) => e instanceof RoleError && e.code === 'MT_ROSTER_DUAL_CAPTAIN',
  )
  // 恰一个队长（项目库定义 + 内置定义混合判定）
  assert.doesNotThrow(() => validateRoster([{ roleId: "captain" }, { roleId: "implementer" }], p.paths))
})

test('T5: 队长是全局唯一的「类」—— 只有 id === captain 能带 isCaptain（CHG-101）', () => {
  const p = paths()
  mkdirSync(p.paths.projectRolesDir, { recursive: true })
  // ① 第二个队长类：**写入即拒**（定义层唯一，不依赖名册）
  assert.throws(
    () => writeProjectRole(p.paths.projectRolesDir, projectDef('captain-2', { isCaptain: true })),
    (e: unknown) => e instanceof RoleError && e.code === 'MT_ROLE_CAPTAIN_RESERVED',
  )
  // ② 显式 isCaptain:false 不受影响（普通角色照常可建）
  assert.doesNotThrow(() => writeProjectRole(p.paths.projectRolesDir, projectDef('deputy', { isCaptain: false })))
  // ③ 项目库**覆写 captain 本身**是允许的 —— 改的是同一份设定的实现，不是新增第二个类
  assert.doesNotThrow(() => writeProjectRole(p.paths.projectRolesDir, projectDef('captain', { isCaptain: true })))
})

test('T5: role schema validation — C5 allow entries constrained', () => {
  assert.doesNotThrow(() => assertValidRole(projectDef('ok', { toolPolicy: { allow: ['myteam_*', 'bash'] } })))
  assert.throws(
    () => assertValidRole(projectDef('bad', { toolPolicy: { allow: ['Bash; rm'] } })),
    (e: unknown) => e instanceof RoleError && e.code === 'MT_ROLE_INVALID',
  )
  assert.throws(() => assertValidRole(projectDef('Bad_ID')), (e: unknown) => (e as RoleError).code === 'MT_ROLE_INVALID')
  assert.throws(
    () => assertValidRole(projectDef('empty', { systemPrompt: '  ' })),
    (e: unknown) => (e as RoleError).code === 'MT_ROLE_INVALID',
  )
})

test('T5: catalog merges three sources with origin labels (B7 tri-state)', () => {
  const p = paths()
  mkdirSync(p.paths.globalRolesDir!, { recursive: true })
  writeFileSync(join(p.paths.globalRolesDir!, 'my-global.json'), JSON.stringify(projectDef('my-global')), 'utf8')
  writeProjectRole(p.paths.projectRolesDir, projectDef('local-only'))
  const catalog = listRoleCatalog(p.paths)
  const origins = Object.fromEntries(catalog.map((e) => [e.definition.id, e.origin]))
  assert.equal(origins['captain'], 'builtin')
  assert.equal(origins['my-global'], 'global')
  assert.equal(origins['local-only'], 'project')
})

test('T5: corrupt project role file fails loud, not silent (MT_ROLE_CORRUPT)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t5b-'))
  const dir = join(ws, 'roles')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8')
  assert.throws(() => listProjectRoles(dir), (e: unknown) => (e as RoleError).code === 'MT_ROLE_CORRUPT')
})
