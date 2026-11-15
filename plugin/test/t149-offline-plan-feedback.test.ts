/**
 * T149 · CHG-203：**离线计划质量反馈**（FR-11.6 的离线面）。
 *
 * 背景：CHG-119 的 `getPlanFeedback` 是 agent 作用域（必须绑定活着的队长会话），
 * 离线/归档团队在面板「反馈」tab 永远只显示空态——文档 §7 如实登记为遗留。
 *
 * 本文件锁三件事：
 *  ① **同源**：在线（团队服务投影）与离线（`ledger.jsonl` 折叠 + 同一纯函数）返回
 *     逐字段相等（`generatedAt` 是唯一允许不同的字段）——离线折叠没有走样；
 *  ② **降级诚实**：空账本 → `empty`，非法参数 → `MT_VALIDATION`（不是空反馈）；
 *  ③ **接线**：服务端 marker / 客户端 api 表 / 面板离线分支都真的走离线端点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'

const DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 与 t92-7 同一条真实入口：提交计划 → 批准 → 取消（终态时刻来自账本事件，可逐字段比） */
async function seedTeam(root: string) {
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  const remote = new MyTeamRemote(rt as never, host)
  const staged: any = host.executeLeadTool('myteam_submit_plan', {
    teamName: '离线反馈队',
    goal: 'G',
    tasks: [{
      title: '任务一', description: 'd', acceptanceCriteria: ['AC'],
      deliverableSpec: { path: 'docs/a.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
      deps: [], requiredRole: 'developer', estimate: 'S',
    }],
  }, {})
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  const teamId = String(staged.teamId)
  const approved: any = host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  assert.ok(approved.status === 'ok' || approved.status === 'approved', JSON.stringify(approved))
  const taskId = String(Object.keys(host.service(teamId).projectionSnapshot.tasks)[0])
  /* 终态（cancelled）→ 实际耗时完全由账本事件决定，在线/离线可以逐字比 */
  const cancelled: any = host.executeLeadTool('myteam_cancel_task', { teamId, taskId, reason: '离线复核用', confirm: true }, {})
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled))
  return { host, remote, teamId, taskId }
}

test('t149-1: 在线与离线逐字段相等（同一份账本，只有 generatedAt 可以不同）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t149-'))
  try {
    const { remote, teamId } = await seedTeam(root)
    const facade = new MyTeamPanelFacade({})
    const online: any = await remote.getPlanFeedback({ teamId })
    const offline: any = await facade.getOfflinePlanFeedback({ workspaceRoot: root, teamId })
    assert.equal(online.status, 'ok')
    assert.equal(offline.status, 'ok')
    assert.equal(offline.readOnly, true)
    assert.equal(offline.online, false)
    assert.equal(offline.teamId, teamId)
    assert.equal(offline.meta.degraded, false, '干净账本不得谎报降级')
    assert.deepEqual(offline.meta.badLines, 0)
    /* 逐字段比：generatedAt 是「什么时候算的」，两条路必然差几毫秒 */
    assert.deepEqual(
      { ...offline.feedback, generatedAt: 0 },
      { ...online.feedback, generatedAt: 0 },
      '离线折叠必须与在线投影同源（口径、计数、偏差排序全部一致）',
    )
    assert.equal(offline.feedback.tasks.total, 1)
    assert.equal(offline.feedback.tasks.terminal, 1, 'cancelled 是终态')
    assert.equal(offline.feedback.tasks.byState.cancelled, 1)
    assert.equal(offline.feedback.caliber, 'heuristic')
    assert.ok(offline.feedback.notes.length >= 3, '口径说明不因离线而消失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t149-2: 空账本 → empty（不是错误，也不是空反馈）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t149-empty-'))
  try {
    const facade = new MyTeamPanelFacade({})
    const r: any = await facade.getOfflinePlanFeedback({ workspaceRoot: root, teamId: 'missing-team' })
    assert.equal(r.status, 'empty')
    assert.equal(r.readOnly, true)
    assert.equal(r.online, false)
    assert.equal(r.feedback, undefined, '空账本不造演示数据（CHG-107 纪律）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t149-3: 非法参数 → MT_VALIDATION（路径穿越 / 相对路径 / 空 teamId）', async () => {
  const facade = new MyTeamPanelFacade({})
  const bad = [
    {},
    { workspaceRoot: 'relative/ws', teamId: 't1' },
    { workspaceRoot: join(tmpdir(), 'ws'), teamId: '../evil' },
    { workspaceRoot: join(tmpdir(), 'ws'), teamId: '' },
  ]
  for (const q of bad) {
    const r: any = await facade.getOfflinePlanFeedback(q as never)
    assert.equal(r.code, 'MT_VALIDATION', `getOfflinePlanFeedback 拒绝 ${JSON.stringify(q)}`)
  }
})

test('t149-4: 接线 —— 服务端 marker / 客户端 api 表 / 面板离线分支', () => {
  const descriptor = (MyTeamPanelFacade.prototype as any)[DESCRIPTOR]
  assert.ok(descriptor.methods.some((m: any) => m.method === 'getOfflinePlanFeedback'), '服务端 marker 必须有离线端点')
  const client = readFileSync(join(PLUGIN_ROOT, 'client', 'client.js'), 'utf8')
  assert.ok(
    client.includes("getOfflinePlanFeedback: (query) => rpcCall(connection, 'myteam/getOfflinePlanFeedback', { query })"),
    '客户端 api 表必须暴露 getOfflinePlanFeedback（漏一个 = 运行时 undefined）',
  )
  assert.ok(
    client.includes('discoveryApi.getOfflinePlanFeedback({ workspaceRoot: projectRoot, teamId: selectedTeamId })'),
    '面板反馈 tab 的离线分支必须真的走离线端点（而不是 setFeedback(null) 空态）',
  )
})
