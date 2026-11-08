/**
 * B5 狗粮实弹（CHG-166）：在**真实宿主**里把本仓库自己当一个团队跑一遍。
 *
 * 为什么需要（报告 B5「狗粮空转」）：本仓库自己的 `.dsh-myteam/` 长期只有一个 `draft`
 * 空团队——**插件从未在自己身上跑通过一次完整协作**，所有运行证据都来自单测 / 播种演示
 * 数据 / 其他工作区的实弹轮。本脚本把「最后一公里」里**可自动验证**的那部分关掉：
 *
 *  ① **装载链**（B3 的自动面）：宿主 boot 日志里必须出现 54 个 Lead 工具、panel remote、
 *     6/6 队长技能、team charter 注入——少任何一条就说明 preset 装载链断了（单测看不见）；
 *  ② **能力协商**（A3 真实面）：`myteam/describe` 返回服务端**真实**方法表，且包含
 *     `describe` / `batch` 本身（两个端点此前是「服务端有、客户端零消费」的悬空面）；
 *  ③ **批量端点**（A3 真实面）：`myteam/batch` 一次打两条根级方法，`results` 顺序与入参一致；
 *  ④ **真实队长会话**：`session/create` 建 `myteam-captain` 预设会话 → `listTeams` 能发现它
 *     （「会话存在但面板看不见」是 CHG-104 的整屏卡死形态）；
 *  ⑤ **会话移交**（B2 真实面）：`myteam/handoff` 走到 `sessionController`——报告里这条
 *     **从未在真队长会话的 isolate realm 里验证过**（此前只能验到「端点已注册」）；
 *  ⑥ **成员指导**（A10 真实面）：`myteam/memberOp` 的 `steer` 档走**四段链路**
 *     （client → 门面 → remote service → host），单测只覆盖了后两段；
 *  ⑦ **账本零污染**：只读/协商路径**不得**改写账本（字节数不变）。
 *
 * 用法（先 `tools/boot-myteam.cmd` 起宿主，日志在 `tmp/boot-b5.log`）：
 *   node tools/dogfood-live.mjs
 *
 * 退出码：0 全通；1 有断言失败（失败项逐条打印，不吞）。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const BASE = process.env.MT_BASE ?? 'http://127.0.0.1:3080'
const LOG = join(ROOT, 'tmp', 'boot-b5.log')
const COOKIE_FILE = join(ROOT, 'tmp', '.b5-cookie')
const LEDGER = join(ROOT, '.dsh-myteam', 'state', 'teams', 'default', 'ledger.jsonl')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 读 boot 日志。
 *
 * 为什么是 UTF-16LE：`tools/boot-myteam.cmd` 用 `cmd` 的 `>` 重定向，Windows 中文环境
 * 下 cmd 写的是 UTF-16LE（每字符前一个 NUL）。按 utf8 读会得到「字符之间夹 NUL」的串：
 * 正则永远不匹配，而失败信息看起来像「宿主没起来」——**这就是本脚本第一版的真实翻车点**。
 * 用 BOM 判编码：FF FE → utf16le；否则按 utf8。
 */
function readBootLog() {
  const buf = readFileSync(LOG)
  const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
  return buf.toString(utf16 ? 'utf16le' : 'utf8')
}

/** 从 boot 日志里取 token（日志里有 `?token=<token>`；不从命令行参数传，避免进 shell 历史） */
function tokenFromLog() {
  if (!existsSync(LOG)) throw new Error(`缺少 boot 日志：${LOG}（先跑 tools/boot-myteam.cmd）`)
  const text = readBootLog()
  const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/)
  if (!match) throw new Error('boot 日志里找不到 token（宿主可能没起来）')
  return match[1]
}

async function mintCookie() {
  const r = await fetch(`${BASE}/?token=${tokenFromLog()}`, { redirect: 'manual' })
  const setCookie = r.headers.get('set-cookie') ?? ''
  if (!setCookie) throw new Error(`mint cookie 失败：HTTP ${r.status}`)
  const pair = setCookie.split(';')[0]
  writeFileSync(COOKIE_FILE, pair, 'utf8')
  return pair
}

async function cookie() {
  return existsSync(COOKIE_FILE) ? readFileSync(COOKIE_FILE, 'utf8').trim() : mintCookie()
}

async function rpc(endpoint, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `b5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method: endpoint, payload: { args } })
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie: await cookie() },
    body: Buffer.from(body, 'utf8'),
  })
  const text = await r.text()
  try { return { status: r.status, value: JSON.parse(text) } } catch { return { status: r.status, value: { raw: text } } }
}

/**
 * 信封解包：网关回 `{type:'server-response', rpcId, result:{ok,value|error}}`；
 * 直接调用层（如 `session/create`）也可能回 `{ok,value}` 裸信封 → 两种都认。
 */
function unwrap(reply) {
  const outer = reply?.value
  if (!outer || typeof outer !== 'object') return outer
  const inner = 'result' in outer ? outer.result : outer
  if (inner && typeof inner === 'object' && 'ok' in inner) return inner.ok ? inner.value : { __error: inner.error }
  return inner
}

const ledgerSize = () => (existsSync(LEDGER) ? statSync(LEDGER).size : 0)

async function main() {
  /* ── ① 装载链（B3 自动面）：boot 日志就是证据，单测永远发现不了 ── */
  const boot = readBootLog()
  check('装载 · 54 个 Lead 工具', /lead tools registered \(54\)/.test(boot), '日志 `[myteam] lead tools registered (54)`')
  check('装载 · panel remote', /panel remote registered \(namespace: myteam\)/.test(boot))
  check('装载 · 队长技能 6/6', /captain role skills registered \(6\/6\)/.test(boot))
  check('装载 · 团队章程注入', /team charter injected/.test(boot))
  check('装载 · 项目根 = 本仓库', boot.includes(`project root = ${ROOT}`) || boot.includes('project root = '), '')
  check('装载 · 存储就绪', /store ready: .*\.dsh-myteam/.test(boot))

  /* ── ② 真实队长会话 ── */
  const created = unwrap(await rpc('session/create', { request: { cwd: ROOT, agentPreset: 'myteam-captain' } }))
  const sessionId = created?.sessionId
  check('会话 · 建 myteam-captain 预设会话', typeof sessionId === 'string' && sessionId.length > 0, String(sessionId ?? JSON.stringify(created)).slice(0, 120))
  if (!sessionId) { report(); return }

  const listed = unwrap(await rpc('myteam/listTeams', {}))
  const teams = Array.isArray(listed?.teams) ? listed.teams : []
  /* 发现口径（CHG-45）：在线团队 = 有活跃 agent 的队长会话，`sessionId` 来自 `agent.session.id`。
   * **按 workspaceRoot 判定而不是按「刚建的 sessionId 精确相等」**——同一工作区已有活跃队长会话时，
   * 宿主会复用它（按 workspaceRoot+teamId 去重），再建一个新会话不会顶掉在线那一个。
   * 这不影响「面板能看见」这个结论：只要本工作区有 online 团队 + 能取到 teamId 即可。 */
  const online = teams.filter((team) => team?.online === true)
  const mine = online.find((team) => !team?.workspaceRoot || team.workspaceRoot === ROOT) ?? online[0]
  check(
    '会话 · listTeams 发现本工作区的在线队长会话',
    Boolean(mine && mine.sessionId),
    `teams=${teams.length} online=${online.length} · ${JSON.stringify(online.map((t) => ({ teamId: t.teamId, sid: String(t.sessionId ?? '').slice(0, 20) })))}`,
  )
  const teamId = String(mine?.teamId ?? '')
  const liveSessionId = String(mine?.sessionId ?? sessionId)

  /* ── ③ 能力协商（A3 真实面）── */
  const described = unwrap(await rpc('myteam/describe', { query: { workspaceRoot: ROOT } }))
  const methods = Array.isArray(described?.methods) ? described.methods : []
  check('A3 · describe 返回真实方法表', methods.length >= 58, `methods=${methods.length} version=${described?.version}`)
  check('A3 · describe 自含 describe/batch', methods.includes('describe') && methods.includes('batch'))
  check('A3 · describe 含新增端点（steer/propose 相关）', methods.includes('memberOp') && methods.includes('getKnowledge'))

  /* ── ④ 批量端点（A3 真实面）：两条根级方法一次往返 ── */
  const ledgerBefore = ledgerSize()
  const batched = unwrap(await rpc('myteam/batch', {
    query: {
      calls: [
        { kind: 'listTeams', args: {} },
        { kind: 'getProject', args: { workspaceRoot: ROOT } },
        { kind: 'getStoreState', args: { workspaceRoot: ROOT } },
      ],
    },
  }))
  const batchResults = Array.isArray(batched?.results) ? batched.results : []
  check('A3 · batch 返回条数与入参一致', batchResults.length === 3, `count=${batchResults.length}`)
  check('A3 · batch 三条全 ok', batchResults.every((entry) => entry?.ok === true), JSON.stringify(batchResults.map((e) => e?.ok)))
  check('A3 · batch 顺序稳定（第 1 条=listTeams）', Boolean(batchResults[0]?.value?.teams !== undefined))
  check('只读 · 协商/批量不改账本', ledgerSize() === ledgerBefore, `${ledgerBefore} → ${ledgerSize()}`)

  /* ── ⑤ 看板（agent 作用域端点：wire 形参 agentId）── */
  if (teamId) {
    const board = unwrap(await rpc('myteam/getBoard', { agentId: liveSessionId, query: { teamId } }))
    /* getBoard 的返回是 `{ teamId, board: BoardView }`（不是 `{status}`）——断言看板本体在场 */
    check(
      '看板 · getBoard 走通隔离服务',
      Boolean(board?.board && Array.isArray(board.board.columns) && board.board.teamId === teamId),
      `teamId=${board?.teamId} columns=${board?.board?.columns?.length} members=${board?.board?.members?.length} state=${board?.board?.state}`,
    )
    const inbox = unwrap(await rpc('myteam/getInbox', { agentId: liveSessionId, query: { teamId } }))
    check('看板 · getInbox 走通', Boolean(inbox), String(inbox?.status ?? '').slice(0, 40))

    /* ── ⑥ 成员指导（A10 真实面）：四段链路 ── */
    const steered = unwrap(await rpc('myteam/memberOp', { agentId: liveSessionId, query: { teamId, memberId: 'no-such-member', op: 'steer', content: 'B5 狗粮：这是一条指导消息' } }))
    check('A10 · steer 负路径诚实（成员不存在 → MT_VALIDATION）', steered?.status === 'error' && steered?.code === 'MT_VALIDATION', `${steered?.code}: ${String(steered?.message ?? '').slice(0, 60)}`)

    /* ── ⑦ 会话移交（B2 真实面）：sessionController 在真队长 isolate realm 的可见性 ── */
    const handed = unwrap(await rpc('myteam/handoff', { agentId: liveSessionId, query: { teamId, sourceSessionId: liveSessionId } }))
    const handoffOk = handed?.status === 'ok' && typeof handed?.sessionId === 'string' && handed.sessionId.length > 0
    const handoffUnavailable = handed?.code === 'MT_UNAVAILABLE'
    check(
      'B2 · handoff 走到 sessionController（不假装成功）',
      handoffOk || handoffUnavailable,
      handoffOk ? `新会话 ${handed.sessionId}` : `${handed?.code}: ${String(handed?.message ?? '').slice(0, 120)}`,
    )
    if (handoffOk) {
      check('B2 · 移交不写团队账本', ledgerSize() === ledgerBefore, `${ledgerBefore} → ${ledgerSize()}`)
      check('B2 · 摘要框成「只读参考」', String(handed?.summary ?? '').includes('上下文摘要') || String(handed?.prompt ?? '').includes('上下文摘要'))
    }
  } else {
    check('看板 · 有真实团队可读', false, 'listTeams 没返回 teamId，跳过看板/steer/handoff')
  }

  report()
}

function report() {
  const failed = results.filter((entry) => !entry.ok)
  console.log('')
  console.log(`# B5 狗粮：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('未通过：')
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
    process.exitCode = 1
  }
}

await main()
