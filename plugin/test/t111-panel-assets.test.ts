/**
 * T111 · CHG-139c/139d（docs/20 §8/§5.4）：**面板端点** `exportTeam` / `importTeam` / `createSkill` / `createTool`。
 *
 * 断言：
 *  ① 四处接线齐全（门面 / 远程 / 客户端 api）；
 *  ② 远程**委托** Lead 工具（`exportTeamTool` / `importTeamTool` / `createSkillTool` / `createToolTool`）；
 *  ③ **永不覆盖**语义透传：`importTeam` 回 `sourceTeamId`（新 id 由系统生成）；
 *  ④ **隔离提示**：`createSkill` 返回 `presetId:'myteam-captain'`（UI 必须把「只写 myteam 预设」上屏）；
 *  ⑤ 门面缺远程能力 → `MT_UNAVAILABLE` 诚实降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MyTeamPanelFacade } from '../src/panel.ts'
import { MyTeamRemote } from '../src/remote/service.ts'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
const ENDPOINTS = ['exportTeam', 'importTeam', 'createSkill', 'createTool']

test('t111-1: 四处接线齐全（门面 / 远程 / 客户端 api）', () => {
  for (const name of ENDPOINTS) {
    assert.equal(typeof (MyTeamPanelFacade.prototype as any)[name], 'function', `门面缺 ${name}`)
    assert.equal(typeof (MyTeamRemote.prototype as any)[name], 'function', `远程缺 ${name}`)
    assert.ok(clientSource.includes(`${name}: (query) => call('${name}', query)`), `客户端 api 缺 ${name}`)
  }
})

test('t111-2: 远程委托 Lead 工具 + 语义透传', async () => {
  const calls: string[] = []
  const fakeHost = {
    exportTeamTool: () => { calls.push('export'); return { status: 'ok', teamId: 't1', filePath: '/x/y.json', bytes: 10 } },
    importTeamTool: () => { calls.push('import'); return { status: 'ok', teamId: 'new-2', sourceTeamId: 'src-2' } },
    createSkillTool: () => { calls.push('skill'); return { status: 'ok', skillId: 's1', presetId: 'myteam-captain' } },
    createToolTool: () => { calls.push('tool'); return { status: 'ok', toolId: 'x1', presetId: 'myteam-captain' } },
  }
  const remote = Object.create(MyTeamRemote.prototype) as any
  remote.host = fakeHost
  const exported = await remote.exportTeam({ teamId: 't1' })
  assert.equal(exported.status, 'ok')
  assert.ok(String(exported.filePath).endsWith('.json'))
  /* 永不覆盖：新 id + 溯源 */
  const imported = await remote.importTeam({ filePath: '/x/y.json' })
  assert.equal(imported.teamId, 'new-2')
  assert.equal(imported.sourceTeamId, 'src-2')
  /* 隔离提示：只写 myteam 队长预设 */
  const skill = await remote.createSkill({ skillId: 's1' })
  assert.equal(skill.presetId, 'myteam-captain')
  const tool = await remote.createTool({ toolId: 'x1' })
  assert.equal(tool.presetId, 'myteam-captain')
  assert.deepEqual(calls.sort(), ['export', 'import', 'skill', 'tool'])
})

test('t111-3: 门面缺远程能力 → MT_UNAVAILABLE', async () => {
  const facade = Object.create(MyTeamPanelFacade.prototype) as any
  facade.remoteFor = () => ({})
  const agent = { session: { id: 's1' } }
  for (const name of ENDPOINTS) {
    const result = await facade[name](agent, {})
    assert.equal(result.status, 'error', `${name} 应降级`)
    assert.equal(result.code, 'MT_UNAVAILABLE', `${name} 降级码必须是 MT_UNAVAILABLE`)
  }
})
