/**
 * T98 · CHG-126（docs/19 §5.1）：`myteam_copy_role` —— 复制角色到项目（fork，C 档仅队长）。
 *
 * 为什么必须有：面板有 `roleOp({op:'fork'})` 端点，但**模型侧没有工具**——「把全局角色
 * 复制进项目」只能人点面板（docs/19 §7 P0 第 4 项）。
 *
 * 断言：
 *  ① 工具已注册；缺 `roleId` → `MT_VALIDATION`（`field:'roleId'`）；
 *  ② 不存在的角色 → `MT_ROLE_NOT_FOUND`（不假装复制成功）；
 *  ③ 内置角色 → 复制成功：项目库出现同名文件，`origin` 保留来源标记；
 *  ④ **已在项目库则拒绝**（`MT_VALIDATION`；改它用 update_role，不自复制）；
 *  ⑤ 只写项目库：不碰全局库、不产生团队账本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t98-'))
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

test('t98-1: 注册 + 缺 roleId 拒绝', () => {
  assert.ok(defsSource.includes("name: 'myteam_copy_role'"), 'defs 必须有 myteam_copy_role')
  const { host, root } = setup()
  try {
    const missing: any = host.executeLeadTool('myteam_copy_role', {}, {})
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'roleId')
    const notFound: any = host.executeLeadTool('myteam_copy_role', { roleId: 'no-such-role' }, {})
    assert.equal(notFound.status, 'error')
    assert.equal(notFound.code, 'MT_ROLE_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t98-2: 内置角色 → 复制进项目库（origin 保留）', () => {
  const { host, root } = setup()
  try {
    const catalog: any = host.executeLeadTool('myteam_list_roles', {}, {})
    const builtin = catalog.roles.find((role: any) => role.origin === 'builtin')
    assert.ok(builtin, '必须有内置角色可复制')
    const copied: any = host.executeLeadTool('myteam_copy_role', { roleId: builtin.id }, {})
    assert.equal(copied.status, 'ok', JSON.stringify(copied))
    assert.equal(copied.roleId, builtin.id)
    assert.equal(copied.source, 'builtin', '来源标记必须保留')
    assert.ok(String(copied.filePath).includes('roles'), `落点应在项目角色库：${copied.filePath}`)
    const rolesDir = join(root, '.dsh-myteam', 'config', 'roles')
    assert.ok(readdirSync(rolesDir).some((name) => name.includes(builtin.id)), '项目库必须出现副本文件')
    /* 复制后 origin 变 project（可改） */
    const after: any = host.executeLeadTool('myteam_list_roles', { scope: 'project' }, {})
    assert.ok(after.roles.some((role: any) => role.id === builtin.id), '副本应出现在项目库')
    /* 再复制一次：已在项目库 → 拒绝（不自复制；写入层用 MT_ROLE_EXISTS，前置检查用 MT_VALIDATION） */
    const again: any = host.executeLeadTool('myteam_copy_role', { roleId: builtin.id }, {})
    assert.equal(again.status, 'error')
    assert.ok(['MT_VALIDATION', 'MT_ROLE_EXISTS'].includes(again.code), `意外错误码 ${again.code}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t98-3: 只写项目库 —— 不产生团队账本', () => {
  const { host, root } = setup()
  try {
    const catalog: any = host.executeLeadTool('myteam_list_roles', {}, {})
    const builtin = catalog.roles.find((role: any) => role.origin === 'builtin')
    host.executeLeadTool('myteam_copy_role', { roleId: builtin.id }, {})
    const tasksDir = join(root, '.dsh-myteam', 'tasks')
    const teams = existsSync(tasksDir) ? readdirSync(tasksDir) : []
    assert.equal(teams.length, 0, '复制角色不得创建团队账本目录')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
