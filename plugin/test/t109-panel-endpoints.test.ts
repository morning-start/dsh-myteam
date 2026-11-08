/**
 * T109 · CHG-139a（docs/19 §M6/§M3）：**面板只读端点** `getTaskGraph` / `listSkills`。
 *
 * 为什么必须有：CHG-124/128 把「依赖图谱」「可复用技能」做成了 Lead 工具，但**面板侧没有端点**——
 * 模型能查、界面不能看（docs/19 §7 的 UI 缺口）。这一批先补**只读**两个端点。
 *
 * 断言：
 *  ① 门面 + 远程两侧都有方法（三处接线：remote 方法 / RemoteLike 接口 / 门面方法 / marker）；
 *  ② 客户端 `makeApi` 暴露（面板调用入口）；
 *  ③ 远程方法**委托** Lead 工具实现（不重复实现，避免与工具面分叉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MyTeamPanelFacade } from '../src/panel.ts'
import { MyTeamRemote } from '../src/remote/service.ts'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
const NEW_ENDPOINTS = ['getTaskGraph', 'listSkills']

test('t109-1: 三处接线齐全（门面 / 远程 / 客户端 api）', () => {
  for (const name of NEW_ENDPOINTS) {
    assert.equal(typeof (MyTeamPanelFacade.prototype as any)[name], 'function', `门面缺 ${name}`)
    assert.equal(typeof (MyTeamRemote.prototype as any)[name], 'function', `远程缺 ${name}`)
    assert.ok(clientSource.includes(`${name}: (query) => call('${name}', query)`), `客户端 api 缺 ${name}`)
  }
})

test('t109-2: 远程方法委托 Lead 工具（不重复实现）', async () => {
  const calls: string[] = []
  const fakeHost = {
    getTaskGraphTool: (args: unknown) => { calls.push('graph'); return { status: 'ok', teamId: 't1', nodes: [], args } },
    listSkillsTool: (args: unknown) => { calls.push('skills'); return { status: 'ok', total: 0, declared: [], args } },
  }
  const remote = Object.create(MyTeamRemote.prototype) as any
  remote.host = fakeHost
  const graph = await remote.getTaskGraph({ teamId: 't1' })
  assert.equal(graph.status, 'ok')
  assert.equal(calls.includes('graph'), true, '必须委托 host.getTaskGraphTool')
  const skills = await remote.listSkills({})
  assert.equal(skills.status, 'ok')
  assert.equal(calls.includes('skills'), true, '必须委托 host.listSkillsTool')
})

test('t109-3: 门面在缺少远程能力时诚实降级', async () => {
  const facade = Object.create(MyTeamPanelFacade.prototype) as any
  facade.remoteFor = () => ({})
  const agent = { session: { id: 's1' } }
  for (const name of NEW_ENDPOINTS) {
    const result = await facade[name](agent, {})
    assert.equal(result.status, 'error', `${name} 应降级`)
    assert.equal(result.code, 'MT_UNAVAILABLE', `${name} 降级码必须是 MT_UNAVAILABLE`)
  }
})
