/**
 * T36（CHG-57）：团队模板管理守门 —— 队长工具 list/save/copy/delete + 团队配置恢复默认。
 *  - list：内置 + 项目模板摘要（含每名队员技能/MCP、看板列、任务类型、只读标记）；
 *  - save：项目层建/改；内置 id 拒写；已存在需 overwrite（两段确认）；未知角色拒绝；
 *  - copy：内置/项目 → 新项目模板；目标内置或已存在拒绝；
 *  - delete：内置拒删、confirm 两段确认、不存在报 MT_PRESET_NOT_FOUND；
 *  - reset_team_config：删团队级配置并重建缓存（账本/成员不动），二次调用 noop。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { teamConfigPath } from '../src/core/config/team-config.ts'

function setup(root: string) {
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return host
}

const PRESET = {
  id: 'team-save',
  name: '保存测试模板',
  description: '两队员',
  members: [
    { roleId: 'developer', skills: ['ui-design'] },
    { roleId: 'acceptor', mcpAllowlist: ['github'] },
  ],
  board: {
    columns: ['s-ideas', 's-build', 'done'],
    columnMapping: { 's-ideas': ['failed', 'blocked', 'cancelled'], 's-build': ['in_progress'], done: ['done'] },
  },
  taskTypes: { quick: { gateChain: ['archive'] } },
}

test('t36-1: list_presets 返回内置开箱团队（只读）+ 项目模板摘要', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t36-'))
  try {
    const host = setup(root)
    const listed: any = host.executeLeadTool('myteam_list_presets', {}, {})
    assert.equal(listed.status, 'ok', JSON.stringify(listed))
    const starter = listed.presets.find((preset: any) => preset.id === 'starter-team')
    assert.ok(starter, '内置开箱团队在列')
    assert.equal(starter.origin, 'builtin')
    assert.equal(starter.readOnly, true)
    assert.equal(starter.memberCount, 3)
    assert.deepEqual(starter.boardColumns, ['backlog', 'ready', 'running', 'gates', 'done'])

    const saved: any = host.executeLeadTool('myteam_save_preset', { preset: PRESET }, {})
    assert.equal(saved.status, 'created', JSON.stringify(saved))
    assert.equal(saved.version, 1)
    assert.equal(saved.presetPath, '.team-workplace/config/presets/team-save.json')

    const listed2: any = host.executeLeadTool('myteam_list_presets', {}, {})
    const project = listed2.presets.find((preset: any) => preset.id === 'team-save')
    assert.equal(project.origin, 'project')
    assert.equal(project.readOnly, false)
    assert.deepEqual(project.members[0].skills, ['ui-design'])
    assert.deepEqual(project.members[1].mcpAllowlist, ['github'])
    assert.deepEqual(project.boardColumns, ['s-ideas', 's-build', 'done'])
    assert.deepEqual(project.taskTypes, ['quick'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t36-2: save_preset 守门——未知角色/空队员/内置 id/覆写两段确认', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t36b-'))
  try {
    const host = setup(root)
    const unknown: any = host.executeLeadTool('myteam_save_preset', {
      preset: { ...PRESET, id: 'team-bad', members: [{ roleId: 'no-such-role' }] },
    }, {})
    assert.equal(unknown.status, 'error')
    assert.equal(unknown.code, 'MT_VALIDATION')
    assert.ok(unknown.message.includes('no-such-role'))

    const empty: any = host.executeLeadTool('myteam_save_preset', {
      preset: { ...PRESET, id: 'team-empty', members: [{ roleId: 'captain' }] },
    }, {})
    assert.equal(empty.status, 'error')
    assert.equal(empty.code, 'MT_VALIDATION')

    const builtin: any = host.executeLeadTool('myteam_save_preset', {
      preset: { ...PRESET, id: 'starter-team' },
    }, {})
    assert.equal(builtin.status, 'error')
    assert.equal(builtin.code, 'MT_PRESET_BUILTIN')

    assert.equal((host.executeLeadTool('myteam_save_preset', { preset: PRESET }, {}) as any).status, 'created')
    const again: any = host.executeLeadTool('myteam_save_preset', { preset: PRESET }, {})
    assert.equal(again.status, 'confirm-required')
    assert.equal(again.code, 'MT_PRESET_EXISTS')

    const updated: any = host.executeLeadTool('myteam_save_preset', {
      preset: { ...PRESET, name: '改过的名字', members: [{ roleId: 'developer' }] },
      overwrite: true,
    }, {})
    assert.equal(updated.status, 'updated', JSON.stringify(updated))
    assert.equal(updated.version, 2)
    const file: any = JSON.parse(readFileSync(join(root, '.team-workplace', 'config', 'presets', 'team-save.json'), 'utf8'))
    assert.equal(file.name, '改过的名字')
    assert.equal(file.version, 2)
    assert.equal(file.members.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t36-3: copy_preset 内置→项目 fork；目标内置/已存在拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t36c-'))
  try {
    const host = setup(root)
    const copied: any = host.executeLeadTool('myteam_copy_preset', {
      fromPresetId: 'starter-team', toPresetId: 'my-starter', name: '我的开箱团队',
    }, {})
    assert.equal(copied.status, 'copied', JSON.stringify(copied))
    assert.equal(copied.fromPresetId, 'starter-team')
    const file: any = JSON.parse(readFileSync(join(root, '.team-workplace', 'config', 'presets', 'my-starter.json'), 'utf8'))
    assert.equal(file.name, '我的开箱团队')
    assert.equal(file.members.length, 3)
    assert.equal(file.version, 1)

    const toBuiltin: any = host.executeLeadTool('myteam_copy_preset', { fromPresetId: 'starter-team', toPresetId: 'starter-team' }, {})
    assert.equal(toBuiltin.code, 'MT_PRESET_BUILTIN')
    const dup: any = host.executeLeadTool('myteam_copy_preset', { fromPresetId: 'starter-team', toPresetId: 'my-starter' }, {})
    assert.equal(dup.code, 'MT_PRESET_EXISTS')
    const missing: any = host.executeLeadTool('myteam_copy_preset', { fromPresetId: 'nope', toPresetId: 'x' }, {})
    assert.equal(missing.code, 'MT_PRESET_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t36-4: delete_preset 内置拒删、confirm 两段确认、不存在报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t36d-'))
  try {
    const host = setup(root)
    const builtin: any = host.executeLeadTool('myteam_delete_preset', { presetId: 'starter-team', confirm: true }, {})
    assert.equal(builtin.status, 'error')
    assert.equal(builtin.code, 'MT_PRESET_BUILTIN')

    host.executeLeadTool('myteam_save_preset', { preset: PRESET }, {})
    const needConfirm: any = host.executeLeadTool('myteam_delete_preset', { presetId: 'team-save' }, {})
    assert.equal(needConfirm.status, 'confirm-required')
    assert.ok(existsSync(join(root, '.team-workplace', 'config', 'presets', 'team-save.json')))

    const deleted: any = host.executeLeadTool('myteam_delete_preset', { presetId: 'team-save', confirm: true }, {})
    assert.equal(deleted.status, 'deleted', JSON.stringify(deleted))
    assert.equal(existsSync(join(root, '.team-workplace', 'config', 'presets', 'team-save.json')), false)

    const again: any = host.executeLeadTool('myteam_delete_preset', { presetId: 'team-save', confirm: true }, {})
    assert.equal(again.code, 'MT_PRESET_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t36-5: reset_team_config 删除团队级配置并重建缓存；二次调用 noop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t36e-'))
  try {
    const host = setup(root)
    const dir = join(root, '.team-workplace', 'config', 'presets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'team-reset.json'), JSON.stringify({ ...PRESET, id: 'team-reset', name: '恢复模板' }))

    const staged2: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-reset', teamName: '恢复队', goal: 'G', tasks: [] }, {})
    assert.equal(staged2.status, 'staged', JSON.stringify(staged2))
    const teamId = String(staged2.teamId)
    assert.ok(existsSync(teamConfigPath(root, teamId)))
    assert.equal(host.service(teamId).configSource, 'team')
    assert.deepEqual(host.service(teamId).effectiveConfig.board.columns, ['s-ideas', 's-build', 'done'])

    const needConfirm: any = host.executeLeadTool('myteam_reset_team_config', { teamId }, {})
    assert.equal(needConfirm.status, 'confirm-required')
    assert.ok(existsSync(teamConfigPath(root, teamId)))

    const reset: any = host.executeLeadTool('myteam_reset_team_config', { teamId, confirm: true }, {})
    assert.equal(reset.status, 'reset', JSON.stringify(reset))
    assert.equal(reset.configSource, 'default')
    assert.equal(existsSync(teamConfigPath(root, teamId)), false)
    assert.deepEqual(host.service(teamId).effectiveConfig.board.columns, ['backlog', 'ready', 'running', 'gates', 'done'])

    const noop: any = host.executeLeadTool('myteam_reset_team_config', { teamId, confirm: true }, {})
    assert.equal(noop.status, 'noop')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
