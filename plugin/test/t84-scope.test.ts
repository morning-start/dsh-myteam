/**
 * T84（CHG-103）：作用域契约 —— 全局 vs 项目级。
 *
 * 用户定案（2026-11-07）：
 *   「全局是一定要明示的，只有在信息足够确定的情况下才能创建全局角色；否则，一般情况下
 *     直接只创建项目级别的角色。」
 *   「任务、历史、状态这些内容只有项目级别才有……历史、状态、导出明显就是项目级别的。」
 *
 * 本文件锁两件事：
 *  ① 角色写入口的**作用域门**：缺省项目级；global 必须 confirmGlobal（否则 confirm-required）；
 *  ② **项目级专属内容**（tasks/history/state/export/members）写进全局 → MT_SCOPE_PROJECT_ONLY。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roleOp } from '../src/core/roles/role-ops.ts'
import { saveGlobalRole, readGlobalRole, deleteGlobalRoleSafe } from '../src/core/roles/role-store.ts'
import {
  GLOBAL_KINDS,
  PROJECT_ONLY_KINDS,
  assertWritableAtScope,
  normalizeScope,
  scopeDir,
  scopeMatrix,
  ScopeError,
} from '../src/core/workspace/scope.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t84-'))
  const globalDir = join(root, 'global-roles')
  const paths = { projectRolesDir: join(root, '.dsh-myteam', 'config', 'roles'), globalRolesDir: globalDir }
  return { root, paths, globalDir }
}

const role = (id: string) => ({
  id,
  name: `角色 ${id}`,
  description: '测试角色',
  systemPrompt: '你是测试角色。只做测试，不越界。',
})

test('t84-1: 缺省作用域 = 项目级（用户第 3 条：不明确就只建项目）', () => {
  assert.equal(normalizeScope(undefined), 'project')
  assert.equal(normalizeScope(''), 'project')
  assert.equal(normalizeScope('project'), 'project')
  assert.equal(normalizeScope('global'), 'global')
  assert.throws(() => normalizeScope('workspace'), (e: unknown) => e instanceof ScopeError && e.code === 'MT_SCOPE_INVALID')
})

test('t84-2: 项目级专属内容写全局 → MT_SCOPE_PROJECT_ONLY（历史/状态/导出/任务/成员）', () => {
  for (const kind of PROJECT_ONLY_KINDS) {
    assert.throws(
      () => assertWritableAtScope('global', kind),
      (e: unknown) => e instanceof ScopeError && e.code === 'MT_SCOPE_PROJECT_ONLY',
      `${kind} 必须拒绝全局作用域`,
    )
    // 项目级照常
    assert.doesNotThrow(() => assertWritableAtScope('project', kind))
  }
  // 全局允许的五类（角色 / 团队 / 技能 / 工具 / 知识）
  for (const kind of GLOBAL_KINDS) assert.doesNotThrow(() => assertWritableAtScope('global', kind))
})

test('t84-3: 全局目录只有五个子目录，永远不出现 tasks/history/state/export', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t84d-'))
  try {
    for (const kind of ['roles', 'teams', 'skills', 'tools', 'knowledge'] as const) {
      const dir = scopeDir(root, 'global', kind, { DSH_HOME: join(root, '.dsh') })
      assert.ok(dir.endsWith(join('myteam', kind === 'knowledge' ? 'knowledge' : kind)), dir)
      for (const forbidden of ['tasks', 'history', 'state', 'export']) {
        assert.ok(!dir.includes(`${forbidden}`), `全局目录不得包含 ${forbidden}：${dir}`)
      }
    }
    const matrix = scopeMatrix()
    assert.equal(matrix.filter((row) => row.scope === 'global').length, 5)
    assert.ok(matrix.some((row) => row.kind === 'tasks' && row.scope === 'project'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t84-4: roleOp.save 缺省写项目库；scope=global 不带 confirmGlobal → confirm-required（不落盘）', () => {
  const { root, paths, globalDir } = fixture()
  try {
    const projectOut = roleOp({ paths }, 'save', { role: role('proj-a') }) as Record<string, unknown>
    assert.equal(projectOut.status, 'saved')
    assert.equal(projectOut.scope, 'project')
    assert.ok(existsSync(join(paths.projectRolesDir, 'proj-a.json')))
    assert.ok(!existsSync(join(globalDir, 'proj-a.json')), '项目角色不得落进全局库')

    const globalOut = roleOp({ paths }, 'save', { role: role('glob-a'), scope: 'global' }) as Record<string, unknown>
    assert.equal(globalOut.status, 'confirm-required')
    assert.equal(globalOut.scope, 'global')
    assert.ok(!existsSync(join(globalDir, 'glob-a.json')), '未确认时零写入')

    const confirmed = roleOp({ paths }, 'save', { role: role('glob-a'), scope: 'global', confirmGlobal: true }) as Record<string, unknown>
    assert.equal(confirmed.status, 'saved')
    assert.equal(confirmed.scope, 'global')
    assert.ok(existsSync(join(globalDir, 'glob-a.json')), '确认后写全局库')
    assert.ok(!existsSync(join(paths.projectRolesDir, 'glob-a.json')), '全局角色不写项目库')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t84-5: 全局角色删除需 confirmGlobal + confirm 双确认；删不存在的全局角色不假装成功', () => {
  const { root, paths, globalDir } = fixture()
  try {
    saveGlobalRole(paths, role('glob-b') as never, {})
    const first = roleOp({ paths }, 'delete', { roleId: 'glob-b', scope: 'global' }) as Record<string, unknown>
    assert.equal(first.status, 'confirm-required')
    assert.ok(existsSync(join(globalDir, 'glob-b.json')), '未确认时不得删除')

    const onlyOne = roleOp({ paths }, 'delete', { roleId: 'glob-b', scope: 'global', confirm: true }) as Record<string, unknown>
    assert.equal(onlyOne.status, 'confirm-required', '只有 confirm 没有 confirmGlobal 也不行')

    const done = roleOp({ paths }, 'delete', { roleId: 'glob-b', scope: 'global', confirm: true, confirmGlobal: true }) as Record<string, unknown>
    assert.equal(done.status, 'deleted')
    assert.equal(done.scope, 'global')
    assert.ok(!existsSync(join(globalDir, 'glob-b.json')))

    const missing = roleOp({ paths }, 'delete', { roleId: 'nope', scope: 'global', confirm: true, confirmGlobal: true }) as Record<string, unknown>
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_ROLE_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t84-6: 全局角色留审计行（$DSH_HOME/myteam/roles/.audit.jsonl），且不被当成角色读', () => {
  const { root, paths, globalDir } = fixture()
  try {
    saveGlobalRole(paths, role('glob-c') as never, { actor: 'human' })
    const audit = join(globalDir, '.audit.jsonl')
    assert.ok(existsSync(audit), '全局写操作必须留审计行')
    const line = JSON.parse(readFileSync(audit, 'utf8').trim().split('\n')[0])
    assert.equal(line.scope, 'global')
    assert.equal(line.action, 'created')
    assert.equal(line.roleId, 'glob-c')
    // 审计文件不是角色定义：readGlobalRole 只按 `<id>.json` 取
    assert.ok(readGlobalRole(paths, '.audit') === undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t84-7: 全局角色同样禁止占用 captain 身份', () => {
  const { root, paths } = fixture()
  try {
    assert.throws(
      () => saveGlobalRole(paths, role('captain') as never, {}),
      (e: unknown) => (e as { code?: string }).code === 'MT_ROLE_INVALID',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
