/**
 * T93 · CHG-120（M2-D ② / FR-16.4②）：**会话考古**——按 `session:<id>` 只读读一页历史。
 *
 * 背景：handoff 摘要（CHG-88）只给 `session:<id>` 指针；没有读取方它就是死链接。
 * 宿主能力 = `SessionController.page`（真 asar 注释原文「Read one message-aligned
 * history page **without activating an Agent**」）。
 *
 * 断言：
 *  ① 翻页请求：默认读最新（throughSeq=-1）；给 beforeSeq → 读到 beforeSeq-1；空 id 抛错；
 *  ② 正文抽取：text / content 字符串 / content 块数组 / 未知形状；
 *  ③ 有界摘要：条数上限、单条截断标记、omitted、hasMore、口径说明；
 *  ④ 能力探测：无 rt / 无 page → undefined；有 page → 透传调用；
 *  ⑤ 宿主端点：缺 sessionId → MT_VALIDATION；缺 page 能力 → MT_UNAVAILABLE；
 *     有 page → `{status:'ok', items,...}` 且**带 teamId 时落 session.read 审计**；
 *     page 抛错 → 原样带回错误码；
 *  ⑥ 客户端接线：`makeApi.readSessionHistory` + 设置页「考古」按钮与抽屉 + 文案 zh/en 成对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSessionPageRequest,
  excerptOf,
  summarizeSessionRecords,
  resolveSessionHistoryCapability,
  ARCHAEOLOGY_DEFAULT_MAX_MESSAGES,
} from '../src/core/host/session-archaeology.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const readSource = (path: string): string => readFileSync(path, 'utf8')
const clientSource = readSource(join(import.meta.dirname, '..', 'client', 'client.js'))

test('t93-1: 翻页请求 —— 默认最新、beforeSeq 往回、空 id 抛错', () => {
  const latest = buildSessionPageRequest('s1')
  assert.deepEqual(latest.address, { kind: 'session', sessionId: 's1' })
  assert.equal(latest.throughSeq, -1, '默认读最新')
  assert.equal('beforeSeq' in latest, false)
  const earlier = buildSessionPageRequest('s1', { beforeSeq: 10 })
  assert.equal(earlier.throughSeq, 9, '读到 beforeSeq-1')
  assert.equal(earlier.beforeSeq, 10)
  const bounded = buildSessionPageRequest('s1', { maxMessages: 5 })
  assert.equal(bounded.maxMessages, 5)
  const fallback = buildSessionPageRequest('s1', { maxMessages: 0 })
  assert.equal('maxMessages' in fallback, false, '非法上限不传（宿主默认）')
  assert.equal(ARCHAEOLOGY_DEFAULT_MAX_MESSAGES, 20)
  assert.throws(() => buildSessionPageRequest('  '), /sessionId is required/)
})

test('t93-2: 正文抽取 —— text / content 字符串 / 块数组 / 未知形状', () => {
  assert.equal(excerptOf({ text: 'hello' }), 'hello')
  assert.equal(excerptOf({ content: 'raw' }), 'raw')
  assert.equal(excerptOf({ content: [{ type: 'text', text: 'A' }, { type: 'image' }, 'B'] }), 'A\nB')
  assert.equal(excerptOf({ content: { text: 'ignored' } }), '', '非数组对象不猜')
  assert.equal(excerptOf(undefined), '')
  assert.equal(excerptOf({}), '')
})

test('t93-3: 有界摘要 —— 条数上限 / 截断标记 / omitted / hasMore / 口径', () => {
  const page = {
    records: [
      { seq: 1, role: 'user', text: 'x'.repeat(10) },
      { seq: 2, role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(2000) }] },
      { seq: 3, type: 'tool', text: 'z' },
    ],
    hasMore: true,
  }
  const view = summarizeSessionRecords('s1', page, { maxChars: 100, maxItems: 2 })
  assert.equal(view.sessionId, 's1')
  assert.equal(view.items.length, 2, '按 maxItems 截断')
  assert.equal(view.omitted, 1)
  assert.equal(view.items[1].truncated, true, '超长正文标截断')
  assert.ok(view.items[1].text.endsWith('…'))
  assert.equal(view.hasMore, true)
  assert.ok(view.chars > 0)
  assert.ok(view.notes.some((note) => note.includes('只读')))
  assert.ok(view.notes.some((note) => note.includes('未展示')))
  assert.ok(view.notes.some((note) => note.includes('更早')))
  /* 空页：不造记录 */
  const empty = summarizeSessionRecords('s2', { records: [] })
  assert.deepEqual(empty.items, [])
  assert.equal(empty.hasMore, false)
  assert.equal(empty.chars, 0)
  /* 坏记录容错 */
  const messy = summarizeSessionRecords('s3', { records: [null, { text: 'ok' }] as never })
  assert.equal(messy.items.length, 1)
})

test('t93-4: 能力探测 —— 必须有 page（create/prompt 不能顶替）', () => {
  assert.equal(resolveSessionHistoryCapability(undefined), undefined)
  assert.equal(resolveSessionHistoryCapability({}), undefined)
  assert.equal(resolveSessionHistoryCapability({ sessionController: { create: () => {}, prompt: () => {} } }), undefined, '没有 page 就是不可用')
  const calls = []
  const capability = resolveSessionHistoryCapability({
    sessionController: {
      page: async (request) => { calls.push(request); return { records: [], hasMore: false } },
    },
  })
  assert.ok(capability, '有 page → 可用')
  return capability.page({ address: { kind: 'session', sessionId: 's1' }, throughSeq: -1 }).then((result) => {
    assert.deepEqual(result, { records: [], hasMore: false })
    assert.equal(calls.length, 1, '透传调用宿主 page')
  })
})

function setup(rt: Record<string, unknown>) {
  const base = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    ...rt,
  }
  const host = new MyTeamHost(base as unknown as HostRuntime)
  host.initialize()
  return { host, root: String((base as { workspace?: { root?: string } }).workspace?.root ?? '') }
}

test('t93-5: 宿主端点 —— 校验 / 缺能力 / 成功读页 / 审计留痕 / 错误透传', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t93-'))
  try {
    /* 缺能力：绝不伪造历史 */
    const bare = setup({ workspace: { root } })
    const missing: any = await bare.host.readSessionHistory({ sessionId: 's1' })
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_UNAVAILABLE')
    /* 缺 sessionId：MT_VALIDATION（在能力探测之前就拒） */
    const invalid: any = await bare.host.readSessionHistory({})
    assert.equal(invalid.status, 'error')
    assert.equal(invalid.code, 'MT_VALIDATION')
    assert.equal(invalid.field, 'sessionId')
    /* 有 page 能力：成功 + 审计 */
    const withPage = setup({
      workspace: { root },
      sessionController: {
        page: async () => ({
          records: [
            { seq: 0, role: 'user', text: '上个团队的目标' },
            { seq: 1, role: 'assistant', text: '收到' },
          ],
          hasMore: true,
        }),
      },
    })
    const staged: any = withPage.host.executeLeadTool('myteam_submit_plan', { teamName: '考古队', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const ok: any = await withPage.host.readSessionHistory({ sessionId: 'sess-9', teamId })
    assert.equal(ok.status, 'ok', JSON.stringify(ok))
    assert.equal(ok.sessionId, 'sess-9')
    assert.equal(ok.items.length, 2)
    assert.equal(ok.items[0].text, '上个团队的目标')
    assert.equal(ok.hasMore, true)
    /* 读取即留痕：session.read 落账本 */
    const ledgerPath = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
    const ledger = readSource(ledgerPath)
    assert.ok(ledger.includes('session.read'), '读取必须留痕（session.read）')
    assert.ok(ledger.includes('sess-9'), '留痕带会话 id')
    /* page 抛错：原样带回错误码 */
    const broken = setup({
      workspace: { root },
      sessionController: { page: async () => { const error: any = new Error('page boom'); error.code = 'session/not-found'; throw error } },
    })
    const failed: any = await broken.host.readSessionHistory({ sessionId: 'nope' })
    assert.equal(failed.status, 'error')
    assert.equal(failed.code, 'session/not-found')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t93-6: 客户端接线 —— api 方法 + 设置页「考古」入口 + 抽屉 + 文案成对', () => {
  assert.ok(clientSource.includes('readSessionHistory: (query) => call('), 'makeApi 暴露 readSessionHistory')
  assert.ok(clientSource.includes("api.readSessionHistory({ teamId: team.teamId, ...request })"), '设置页按会话读取')
  assert.ok(clientSource.includes("t('history.open')"), '会话索引里有「考古」按钮')
  assert.ok(clientSource.includes('history-open-'), '考古按钮可被测试定位')
  assert.ok(clientSource.includes("'data-testid': 'history-more'"), '翻页按钮')
  assert.ok(clientSource.includes('mt-history-list'), '抽屉条目样式')
  assert.ok(clientSource.includes("typeof api.readSessionHistory !== 'function'"), '旧宿主降级（不假装读到）')
  for (const key of ['history.title', 'history.desc', 'history.loading', 'history.empty', 'history.open', 'history.index', 'history.truncated', 'history.notes', 'history.failed', 'history.more', 'history.chars']) {
    const hits = clientSource.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh/en 各一条（实际 ${hits}）`)
  }
})
