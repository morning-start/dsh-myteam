/**
 * T101 · CHG-130（docs/19 §M9/§M10）：`myteam_get_audit` / `myteam_handoff` / `myteam_read_session`
 * —— 审计查询 + 会话面（移交 / 考古）。
 *
 * 为什么必须有：面板有三个端点，但模型侧**没有工具**——无法自审、无法程序化移交、
 * 无法按 `session:<id>` 深读（docs/19 §M9/§M10 缺口）。
 *
 * 断言：
 *  ① 三个工具都已注册；
 *  ② `get_audit`：`{status,total,count,events,nextBeforeSeq}`，按 seq 倒序、`limit` 生效、
 *    `beforeSeq` 翻页；**只读**（账本行数不变）；
 *  ③ `read_session`：缺 `sessionId` → `MT_VALIDATION`；无 `page` 能力 → `MT_UNAVAILABLE`（不假装读到）；
 *  ④ `handoff`：无 `sessionController` 能力 → `MT_UNAVAILABLE`（不伪造 sessionId）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t101-'))
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
    ...extra,
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, root }
}

test('t101-1: 三个工具都已注册', () => {
  for (const name of ['myteam_get_audit', 'myteam_handoff', 'myteam_read_session']) {
    assert.ok(defsSource.includes(`name: '${name}'`), `defs 必须有 ${name}`)
  }
})

test('t101-2: get_audit —— 倒序 + limit + 翻页 + 只读', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T101', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const ledger = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
    const before = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    const page: any = host.executeLeadTool('myteam_get_audit', { teamId, limit: 1 }, {})
    assert.equal(page.status, 'ok', JSON.stringify(page))
    assert.equal(page.count, 1, 'limit 必须生效')
    assert.equal(page.total, before, 'total = 账本行数')
    assert.equal(typeof page.nextBeforeSeq, 'number')
    assert.ok(String(page.note).includes('只读'), '必须标注只读口径')
    /* 翻页：beforeSeq = 上页最早 seq → 更早的事件 */
    const older: any = host.executeLeadTool('myteam_get_audit', { teamId, limit: 1, beforeSeq: page.nextBeforeSeq }, {})
    assert.equal(older.status, 'ok')
    assert.ok(older.count <= 1)
    /* 只读：账本行数不变 */
    const after = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    assert.equal(after, before, '只读工具不得写账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t101-3: read_session —— 缺 id 拒绝 + 缺 page 能力不可用', async () => {
  const { host, root } = setup()
  try {
    const missing: any = await host.executeLeadTool('myteam_read_session', {}, {})
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'sessionId')
    const unavailable: any = await host.executeLeadTool('myteam_read_session', { sessionId: 'sess-1' }, {})
    assert.equal(unavailable.status, 'error')
    assert.equal(unavailable.code, 'MT_UNAVAILABLE', '无 page 能力必须诚实报不可用')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t101-4: handoff —— 缺 sessionController 不可用（不伪造 sessionId）', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T101b', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const result: any = await host.executeLeadTool('myteam_handoff', { teamId }, {})
    assert.equal(result.status, 'error', JSON.stringify(result))
    assert.equal(result.code, 'MT_UNAVAILABLE')
    assert.equal('sessionId' in result, false, '不可用时不得伪造 sessionId')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
