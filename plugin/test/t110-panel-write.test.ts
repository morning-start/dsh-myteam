/**
 * T110 · CHG-139b（docs/19 §5.2/§5.3）：**面板写端点** `copyTeam` / `publishTeam`。
 *
 * 断言：
 *  ① 三处接线齐全（门面 / 远程 / 客户端 api）；
 *  ② 远程**委托** Lead 工具（`copyTeamTool` / `publishTeamTool`），不重复实现；
 *  ③ **两段确认透传**：`confirm-required` 原样回给面板（面板负责二次确认 UI），不被吞成成功；
 *  ④ 门面缺远程能力 → `MT_UNAVAILABLE` 诚实降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MyTeamPanelFacade } from '../src/panel.ts'
import { MyTeamRemote } from '../src/remote/service.ts'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
const ENDPOINTS = ['copyTeam', 'publishTeam']

test('t110-1: 三处接线齐全（门面 / 远程 / 客户端 api）', () => {
  for (const name of ENDPOINTS) {
    assert.equal(typeof (MyTeamPanelFacade.prototype as any)[name], 'function', `门面缺 ${name}`)
    assert.equal(typeof (MyTeamRemote.prototype as any)[name], 'function', `远程缺 ${name}`)
    assert.ok(clientSource.includes(`${name}: (query) => call('${name}', query)`), `客户端 api 缺 ${name}`)
  }
})

test('t110-2: 远程委托 Lead 工具（含两段确认透传）', async () => {
  const calls: string[] = []
  const fakeHost = {
    copyTeamTool: (args: unknown) => { calls.push('copy'); return { status: 'ok', teamId: 'new-1', sourceTeamId: 'src-1', args } },
    publishTeamTool: (args: Record<string, unknown>) => {
      calls.push(`publish:${String(args.confirm)}`)
      /* 未带 confirm 时回两段确认（与真实实现一致） */
      return args.confirm === true
        ? { status: 'ok', teamId: 't1', action: 'updated' }
        : { status: 'confirm-required', teamId: 't1', impact: { exists: true } }
    },
  }
  const remote = Object.create(MyTeamRemote.prototype) as any
  remote.host = fakeHost
  const copied = await remote.copyTeam({ sourceTeamId: 'src-1' })
  assert.equal(copied.status, 'ok')
  assert.equal(copied.sourceTeamId, 'src-1')
  assert.equal(calls.includes('copy'), true, '必须委托 host.copyTeamTool')
  /* 两段确认：第一次 confirm-required 原样回给面板 */
  const first = await remote.publishTeam({ teamId: 't1' })
  assert.equal(first.status, 'confirm-required', JSON.stringify(first))
  assert.equal(first.impact.exists, true)
  /* 带 confirm 重调 → 成功 */
  const second = await remote.publishTeam({ teamId: 't1', confirm: true })
  assert.equal(second.status, 'ok', JSON.stringify(second))
  assert.equal(second.action, 'updated')
})

test('t110-3: 门面缺远程能力 → MT_UNAVAILABLE', async () => {
  const facade = Object.create(MyTeamPanelFacade.prototype) as any
  facade.remoteFor = () => ({})
  const agent = { session: { id: 's1' } }
  for (const name of ENDPOINTS) {
    const result = await facade[name](agent, {})
    assert.equal(result.status, 'error', `${name} 应降级`)
    assert.equal(result.code, 'MT_UNAVAILABLE', `${name} 降级码必须是 MT_UNAVAILABLE`)
  }
})
