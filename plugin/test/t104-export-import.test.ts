/**
 * T104 · CHG-133（docs/20 §8）：`myteam_export_team` / `myteam_import_team` —— 团队快照导出 / 导入。
 *
 * 断言：
 *  ① 两个工具都已注册；
 *  ② 导出：落 `history/exports/<label>-<ts>.json`，含 `version/teamId/name/goal/roster/eventCount/exportedAt`，
 *    **不含**运行态（sessionId / tokens / memory）；
 *  ③ 导入：读快照 → 新团队（新 id ≠ 源 id）+ `sourceTeamId` 溯源 + 名册一致 + **任务为 0**；
 *  ④ 校验：缺 `filePath` / 文件不存在 / 版本不兼容 / 名册为空 → `MT_VALIDATION`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t104-'))
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

async function teamWith(host: MyTeamHost, name: string) {
  const staged: any = await host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: '导出用目标',
    tasks: [{
      title: '任务', description: '描述', acceptanceCriteria: ['AC'],
      deliverableSpec: { path: 'docs/a.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
      deps: [], requiredRole: 'developer',
    }],
  }, {})
  const teamId = String(staged.teamId)
  await host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  return teamId
}

test('t104-1: 注册 + 导出落盘（不含运行态）', async () => {
  assert.ok(defsSource.includes("name: 'myteam_export_team'"), 'defs 必须有 myteam_export_team')
  assert.ok(defsSource.includes("name: 'myteam_import_team'"), 'defs 必须有 myteam_import_team')
  const { host, root } = setup()
  try {
    const teamId = await teamWith(host, '导出团队')
    const exported: any = await host.executeLeadTool('myteam_export_team', { teamId }, {})
    assert.equal(exported.status, 'ok', JSON.stringify(exported))
    assert.ok(existsSync(exported.filePath), '快照必须落盘')
    assert.ok(String(exported.filePath).includes(join('history', 'exports')), `落点应在 history/exports：${exported.filePath}`)
    assert.ok(exported.bytes > 0)
    assert.ok(exported.counts.roster > 0)
    const snapshot = JSON.parse(readFileSync(exported.filePath, 'utf8')) as Record<string, any>
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.teamId, teamId)
    assert.equal(snapshot.goal, '导出用目标')
    for (const forbidden of ['sessionId', 'tokens', 'memory', 'ledger']) {
      assert.equal(forbidden in snapshot, false, `快照不得包含运行态字段 ${forbidden}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t104-2: 导入 —— 新 id + 溯源 + 名册一致 + 任务为 0', async () => {
  const { host, root } = setup()
  try {
    const sourceTeamId = await teamWith(host, '导出团队2')
    const exported: any = await host.executeLeadTool('myteam_export_team', { teamId: sourceTeamId }, {})
    const imported: any = await host.executeLeadTool('myteam_import_team', { filePath: exported.filePath }, {})
    assert.equal(imported.status, 'ok', JSON.stringify(imported))
    assert.ok(imported.teamId && imported.teamId !== sourceTeamId, '必须生成新团队 id（永不覆盖）')
    assert.equal(imported.sourceTeamId, sourceTeamId, '必须溯源源团队')
    assert.ok(String(imported.name).startsWith('导出团队2（导入'), `名称应为「源名（导入-时间戳）」：${imported.name}`)
    assert.ok(imported.rosterCount > 0)
    const detail: any = host.executeLeadTool('myteam_get_team', { teamId: imported.teamId }, {})
    assert.equal(detail.state, 'draft', '导入结果是 draft（走人审）')
    assert.equal(detail.counts.tasks, 0, '任务不导入')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t104-3: 校验 —— 缺路径 / 不存在 / 版本不符 / 名册为空', async () => {
  const { host, root } = setup()
  try {
    const missing: any = await host.executeLeadTool('myteam_import_team', {}, {})
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'filePath')
    const notFound: any = await host.executeLeadTool('myteam_import_team', { filePath: 'nope.json' }, {})
    assert.equal(notFound.code, 'MT_VALIDATION')
    const badVersion = join(root, 'bad-version.json')
    writeFileSync(badVersion, JSON.stringify({ version: 9, roster: [] }), 'utf8')
    const version: any = await host.executeLeadTool('myteam_import_team', { filePath: badVersion }, {})
    assert.equal(version.code, 'MT_VALIDATION')
    assert.equal(version.field, 'version')
    const emptyRoster = join(root, 'empty-roster.json')
    writeFileSync(emptyRoster, JSON.stringify({ version: 1, roster: [] }), 'utf8')
    const roster: any = await host.executeLeadTool('myteam_import_team', { filePath: emptyRoster }, {})
    assert.equal(roster.code, 'MT_VALIDATION')
    assert.equal(roster.field, 'roster')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
