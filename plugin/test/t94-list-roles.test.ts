/**
 * T94 · CHG-122（docs/19 §M1）：`myteam_list_roles` —— 角色目录只读视图（A 档全员可读）。
 *
 * 为什么必须有：`create_role` / `spawn_member` 都要填 `roleId`，但此前没有任何工具能
 * 列出「有哪些角色」——模型只能猜 id。这一条补上「先看得见，才谈聘任 / 复制 / 改」。
 *
 * 断言：
 *  ① 工具已注册（defs 有定义）；
 *  ② 返回 `{status:'ok', scope, total, roles[]}`，每条带 id / name / description / origin / readOnly；
 *  ③ 内置（builtin）与插件（plugin）贡献 `readOnly:true`；项目/全局可写；
 *  ④ `scope` 过滤生效（builtin / project 各只回本来源）；
 *  ⑤ `includeSkills:true` 时带出技能名（缺省不带，省 token）；
 *  ⑥ **只读**：不产生账本文件、不改角色库（调用前后目录快照一致）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t94-'))
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, root }
}

test('t94-1: 工具已注册 + 目录返回结构', () => {
  assert.ok(defsSource.includes("name: 'myteam_list_roles'"), 'defs 必须定义 myteam_list_roles')
  const { host, root } = setup()
  try {
    const result: any = host.executeLeadTool('myteam_list_roles', {}, {})
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.scope, 'all', '缺省 scope=all')
    assert.equal(typeof result.total, 'number')
    assert.equal(Array.isArray(result.roles), true)
    assert.ok(result.roles.length > 0, '内置角色目录不能为空')
    for (const role of result.roles) {
      assert.equal(typeof role.id, 'string')
      assert.ok(role.id.length > 0, '每条必须有 id')
      assert.equal(typeof role.name, 'string')
      assert.equal(typeof role.description, 'string')
      assert.ok(['builtin', 'global', 'project', 'plugin'].includes(role.origin), `未知来源 ${role.origin}`)
      assert.equal(typeof role.readOnly, 'boolean')
    }
    assert.equal(result.total, result.roles.length, 'total 与数组长度一致')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t94-2: 内置只读 —— builtin/plugin 贡献 readOnly:true', () => {
  const { host, root } = setup()
  try {
    const result: any = host.executeLeadTool('myteam_list_roles', {}, {})
    const builtins = result.roles.filter((role: any) => role.origin === 'builtin')
    assert.ok(builtins.length > 0, '必须有内置角色')
    for (const role of builtins) assert.equal(role.readOnly, true, `${role.id} 是内置角色，必须只读`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t94-3: scope 过滤 —— 只回本来源', () => {
  const { host, root } = setup()
  try {
    const builtin: any = host.executeLeadTool('myteam_list_roles', { scope: 'builtin' }, {})
    assert.equal(builtin.scope, 'builtin')
    assert.ok(builtin.roles.length > 0)
    assert.equal(builtin.roles.every((role: any) => role.origin === 'builtin'), true, 'scope=builtin 不得混入其它来源')
    const project: any = host.executeLeadTool('myteam_list_roles', { scope: 'project' }, {})
    assert.equal(project.roles.every((role: any) => role.origin === 'project'), true)
    const plugin: any = host.executeLeadTool('myteam_list_roles', { scope: 'plugin' }, {})
    assert.equal(plugin.roles.every((role: any) => role.origin === 'plugin'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t94-4: includeSkills —— 缺省不带、显式带出', () => {
  const { host, root } = setup()
  try {
    const plain: any = host.executeLeadTool('myteam_list_roles', {}, {})
    assert.equal(plain.roles.every((role: any) => !('skills' in role)), true, '缺省不带技能名（省 token）')
    const withSkills: any = host.executeLeadTool('myteam_list_roles', { includeSkills: true }, {})
    const withList = withSkills.roles.filter((role: any) => Array.isArray(role.skills))
    assert.ok(withList.length > 0, '至少有角色带技能名')
    for (const role of withList) assert.equal(role.skills.every((skill: unknown) => typeof skill === 'string'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t94-5: 只读 —— 不写账本、不改角色库', () => {
  const { host, root } = setup()
  try {
    const rolesDir = join(root, '.dsh-myteam', 'config', 'roles')
    const before = (() => { try { return readdirSync(rolesDir).sort().join(',') } catch { return '(absent)' } })()
    host.executeLeadTool('myteam_list_roles', {}, {})
    host.executeLeadTool('myteam_list_roles', { scope: 'project', includeSkills: true }, {})
    const after = (() => { try { return readdirSync(rolesDir).sort().join(',') } catch { return '(absent)' } })()
    assert.equal(after, before, '角色库不得被读取改变')
    /* 团队账本目录不应因只读调用被创建 */
    const tasksDir = join(root, '.dsh-myteam', 'tasks')
    const teams = (() => { try { return readdirSync(tasksDir) } catch { return [] } })()
    assert.equal(teams.length, 0, '只读调用不得创建账本目录')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
