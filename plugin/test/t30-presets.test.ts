/**
 * T30（CHG-50/51）：开箱团队三层目录单测。
 *  - 内置 starter-team 与 submit_plan 兜底模板同源（队长隐式 + 3 队员）；
 *  - project/global 目录读取（origin/filePath、队员 skills/mcpAllowlist）；
 *  - 坏 JSON / 非法 id 跳过并记 warning；空队员列表只告警不丢弃（运行时另有校验）；
 *  - 目录不存在时只返回 builtin。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_PRESETS, presetDirs, readPresetCatalog } from '../src/core/presets/preset-store.ts'
import { presetTeamRoster } from '../src/core/roles/builtin-roles.ts'

function withWorkspace(fn: (ws: string) => void): void {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t30-'))
  try { fn(ws) } finally { rmSync(ws, { recursive: true, force: true }) }
}

const writePreset = (dir: string, file: string, value: unknown): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value))
}

test('t30-1: 内置开箱团队（标准队长隐式 + 3 名队员；看板列/泳道/门禁与默认配置同源）', () => {
  assert.equal(BUILTIN_PRESETS.length, 1)
  const def = BUILTIN_PRESETS[0]
  assert.equal(def.id, 'starter-team')
  assert.equal(def.name, '开箱团队')
  assert.deepEqual(def.members.map((member) => member.roleId), ['req-validator', 'developer', 'acceptor'])
  assert.ok(!def.members.some((member) => member.roleId === 'captain'), '队长不在队员名册里')
  assert.deepEqual(
    def.members.map((member) => member.roleId),
    presetTeamRoster('triad').filter((entry) => entry.roleId !== 'captain').map((entry) => entry.roleId),
    '开箱团队与 submit_plan 兜底名册同源',
  )
  assert.deepEqual(def.board?.columns, ['backlog', 'ready', 'running', 'gates', 'done'])
  assert.deepEqual(def.pipeline?.stages, ['plan', 'dev', 'gates', 'integrate'])
  assert.equal(def.gates?.commandTimeoutMs, 120000)
})

test('t30-2: 项目模板目录读取 + 坏文件与校验告警（不抛错）', () => {
  withWorkspace((ws) => {
    const projectDir = join(ws, '.dsh-myteam', 'config', 'teams')
    writePreset(projectDir, 'alpha.json', {
      id: 'alpha', name: 'Alpha',
      members: [
        { roleId: 'developer', skills: ['ui-design'], mcpAllowlist: ['filesystem'] },
        { roleId: 'acceptor' },
      ],
      board: { columns: ['todo', 'doing', 'done'] },
      pipeline: { swimlaneBy: 'member', stages: ['plan', 'dev'] },
      gates: { enabled: true, commandTimeoutMs: 30000 },
    })
    writePreset(projectDir, 'bad.json', '{not json')
    writePreset(projectDir, 'unsafe.json', { id: '../evil', name: 'Evil', members: [{ roleId: 'developer' }] })
    writePreset(projectDir, 'empty.json', { id: 'empty', name: 'No Members', members: [] })

    const catalog = readPresetCatalog(ws)
    const ids = catalog.entries.map((entry) => `${entry.origin}:${entry.definition.id}`)
    assert.ok(ids.includes('project:alpha'))
    assert.ok(ids.includes('project:empty'))
    assert.ok(ids.includes('builtin:starter-team'))
    assert.ok(!ids.some((id) => id.includes('evil')), '非法 id 被跳过')

    const alpha = catalog.entries.find((entry) => entry.definition.id === 'alpha')!
    assert.equal(alpha.origin, 'project')
    assert.ok(alpha.filePath?.endsWith('alpha.json'))
    assert.deepEqual(alpha.definition.board?.columns, ['todo', 'doing', 'done'])
    assert.deepEqual(alpha.definition.members, [
      { roleId: 'developer', skills: ['ui-design'], mcpAllowlist: ['filesystem'] },
      { roleId: 'acceptor' },
    ])

    assert.ok(catalog.warnings.some((warning) => warning.includes('bad.json')), '坏 JSON 记 warning')
    assert.ok(catalog.warnings.some((warning) => warning.includes('no members')), '空队员记 warning')
    assert.ok(catalog.warnings.some((warning) => warning.includes('unsafe.json')), '非法 id 记 warning')
  })
})

test('t30-3: 目录不存在 → 仅 builtin；全局不参与团队模板（CHG-52）', () => {
  withWorkspace((ws) => {
    const catalog = readPresetCatalog(ws)
    assert.deepEqual(catalog.entries.map((entry) => entry.origin), ['builtin'])
    assert.equal(catalog.dirs.project, join(ws, '.dsh-myteam', 'config', 'teams'))
    assert.deepEqual(Object.keys(catalog.dirs).sort(), ['builtin', 'project'], '全局只存角色，没有团队模板目录')
    assert.deepEqual(Object.keys(presetDirs(ws)).sort(), ['builtin', 'project'])
  })
})

test('t30-4: 旧 roster 格式兼容——队长隐式剔除，成员技能/MCP 保留', () => {
  withWorkspace((ws) => {
    const dir = join(ws, '.dsh-myteam', 'config', 'teams')
    writePreset(dir, 'legacy.json', {
      id: 'legacy', name: 'Legacy',
      roster: [
        { roleId: 'captain' },
        { roleId: 'developer', skills: ['office'] },
        { roleId: 'acceptor', mcpAllowlist: ['github'] },
      ],
    })
    const catalog = readPresetCatalog(ws)
    const legacy = catalog.entries.find((entry) => entry.definition.id === 'legacy')!
    assert.deepEqual(legacy.definition.members, [
      { roleId: 'developer', skills: ['office'] },
      { roleId: 'acceptor', mcpAllowlist: ['github'] },
    ])
  })
})
