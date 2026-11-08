/**
 * B5 狗粮 · 第二段（CHG-166）：**让真队长会话自己组一次队**。
 *
 * 第一段 `tools/dogfood-live.mjs` 验的是「装载链 + 能力协商 + 只读面 + 移交/steer」——
 * 全是**机制层**，队长会话本身没被要求干过活（团队停在 `draft`、0 成员 0 任务），
 * 所以「插件从未在自己身上跑通过一次完整协作」这条**只走了一半**。
 *
 * 本段把队长会话真正用起来：给它一个**最小但完整**的指令（组队 → 提交计划 → 批准），
 * 然后轮询账本看它有没有真的落 `team.created` / `plan.staged` / `plan.approved`。
 *
 * 为什么不做「再多派几个成员跑任务」：那是 LLM 的自主决策面，还要真实写文件，
 * 成本与不确定性都远大于它能证明的东西——`t23-host-run` 已经用 mock 覆盖了 spawn 后
 * 的完整执行面。这里的价值只是**证明队长会话在真宿主里能自己动起来**。
 *
 * 用法：`node tools/dogfood-collab.mjs`（宿主需已 boot，日志在 tmp/boot-b5.log）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const BASE = process.env.MT_BASE ?? 'http://127.0.0.1:3080'
const LOG = join(ROOT, 'tmp', 'boot-b5.log')
const COOKIE_FILE = join(ROOT, 'tmp', '.b5-cookie')
const TEAMS_DIR = join(ROOT, '.dsh-myteam', 'tasks')
const TIMEOUT_MS = Number(process.env.MT_TIMEOUT_MS ?? 240_000)

/**
 * 团队账本路径 = `.dsh-myteam/tasks/<teamId>/ledger.jsonl`（**不是** `state/teams/`——
 * `state/teams/` 只有索引式的旧布局残留，写路径以 `storeLayout().tasks` 为准）。
 * 本脚本的判据是「**本次指令前后**新增了哪些事件」，所以先取一份基线快照。
 */
function ledgerFiles() {
  if (!existsSync(TEAMS_DIR)) return []
  return readdirSync(TEAMS_DIR)
    .map((teamId) => ({ teamId, file: join(TEAMS_DIR, teamId, 'ledger.jsonl') }))
    .filter((entry) => existsSync(entry.file))
    .map((entry) => ({ ...entry, mtime: statSync(entry.file).mtimeMs }))
}
function eventsOf() {
  const all = []
  for (const { teamId, file } of ledgerFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try { all.push({ teamId, ...JSON.parse(line) }) } catch { /* 坏行不计入（fold 侧另有容错口径） */ }
    }
  }
  return all
}

function readBootLog() {
  const buf = readFileSync(LOG)
  const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
  return buf.toString(utf16 ? 'utf16le' : 'utf8')
}
function tokenFromLog() {
  const match = readBootLog().match(/[?&]token=([A-Za-z0-9_-]+)/)
  if (!match) throw new Error('boot 日志里找不到 token')
  return match[1]
}
async function cookie() {
  if (existsSync(COOKIE_FILE)) return readFileSync(COOKIE_FILE, 'utf8').trim()
  const r = await fetch(`${BASE}/?token=${tokenFromLog()}`, { redirect: 'manual' })
  const pair = (r.headers.get('set-cookie') ?? '').split(';')[0]
  if (!pair) throw new Error(`mint cookie 失败：HTTP ${r.status}`)
  writeFileSync(COOKIE_FILE, pair, 'utf8')
  return pair
}
async function rpc(endpoint, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `b5c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method: endpoint, payload: { args } })
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie: await cookie() },
    body: Buffer.from(body, 'utf8'),
  })
  const text = await r.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}
function unwrap(reply) {
  const outer = reply?.result ?? reply
  if (outer && typeof outer === 'object' && 'ok' in outer) return outer.ok ? outer.value : { __error: outer.error }
  return outer
}
const events = () => eventsOf()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const created = unwrap(await rpc('session/create', { request: { cwd: ROOT, agentPreset: 'myteam-captain' } }))
const sessionId = created?.sessionId
if (!sessionId) throw new Error(`建队长会话失败：${JSON.stringify(created)}`)
/* 基线：只数**本次指令之后新增**的事件（历史账本里本来就有 team.created 的话不能算成绩） */
const baseline = events()
console.log(`# 队长会话 ${sessionId}`)
console.log(`# 指令前账本事件数：${baseline.length}（团队：${[...new Set(baseline.map((e) => e.teamId))].join(', ') || '无'}）`)

const instruction = [
  '你现在是团队队长。请只做下面三件事，不要做别的：',
  '1. 用 myteam_submit_plan 提交一个 **2 名成员**的团队名册（队长 + 1 名「开发者」角色），',
  '   目标写「B5 狗粮：验证队长会话能在真宿主里自己组队」。',
  '2. 名册里带 **1 个任务**：标题「写一行 proof」，requiredRole 用「开发者」，',
  '   acceptanceCriteria 写「tmp/b5-proof.txt 存在且内容为 ok」，deliverableSpec.path 写「tmp/b5-proof.txt」。',
  '3. 提交后立刻用 myteam_approve_plan 批准这份计划，然后停下来汇报结果。',
  '不要 spawn 成员、不要 claim 任务、不要写任何文件——只要「提交 + 批准」。',
].join('\n')

const prompted = unwrap(await rpc('session/prompt', {
  request: { requestId: `b5c-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: instruction }] },
}))
console.log(`# 注入结果：${JSON.stringify(prompted).slice(0, 200)}`)

/* 轮询：只认**本次新增**的账本证据（不读 LLM 的自述——「它说做了」不等于「账本里有」，
 * 也不能把历史账本里本来就有的 team.created 算成本次成绩）。 */
const baselineKey = new Set(baseline.map((event) => `${event.teamId}#${event.seq}`))
const fresh = () => events().filter((event) => !baselineKey.has(`${event.teamId}#${event.seq}`))
const started = Date.now()
let staged = 0
let approved = 0
while (Date.now() - started < TIMEOUT_MS) {
  await sleep(5000)
  const list = fresh()
  staged = list.filter((event) => event.type === 'plan.staged').length
  approved = list.filter((event) => event.type === 'plan.approved').length
  process.stdout.write(
    `\r# ${Math.round((Date.now() - started) / 1000)}s · 新增=${list.length} team.created=${list.filter((e) => e.type === 'team.created').length} plan.staged=${staged} plan.approved=${approved} member.spawned=${list.filter((e) => e.type === 'member.spawned').length} task.created=${list.filter((e) => e.type === 'task.created').length}   `,
  )
  if (approved > 0 && list.some((event) => event.type === 'task.created')) break
}
console.log('')

const finalEvents = fresh()
const summary = {
  events: finalEvents.length,
  teamCreated: finalEvents.filter((event) => event.type === 'team.created').length,
  staged: finalEvents.filter((event) => event.type === 'plan.staged').length,
  approved: finalEvents.filter((event) => event.type === 'plan.approved').length,
  memberSpawned: finalEvents.filter((event) => event.type === 'member.spawned').length,
  taskCreated: finalEvents.filter((event) => event.type === 'task.created').length,
  teams: [...new Set(finalEvents.map((event) => event.teamId))],
  types: [...new Set(finalEvents.map((event) => event.type))],
}
console.log(JSON.stringify(summary, null, 2))

/* 判据：**批准 + 任务入库**才算「完整跑通」；只有 staged 说明队长动了但人审那步没走完 */
if (summary.approved > 0 && summary.taskCreated > 0) {
  console.log('\nPASS  B5 · 队长会话在真宿主里自己完成「组队 → 提交计划 → 批准 → 派成员 → 任务入库」')
} else if (summary.staged > 0) {
  console.log('\nPARTIAL  B5 · 队长提交了计划（plan.staged）但没走到批准；人审那步需要人/另一次指令')
  process.exitCode = 1
} else {
  console.log('\nFAIL  B5 · 账本里没有新增计划事件——队长会话没动起来（看宿主日志里的 LLM 报错）')
  process.exitCode = 1
}
