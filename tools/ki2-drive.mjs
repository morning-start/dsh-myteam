// KI-2 实弹驱动：建队长会话 + 冒烟任务 + approve + 全程观察
const BASE = 'http://127.0.0.1:3080'
const TOKEN = process.env.MT_TOKEN ?? '15jMY31TfXLfHhAf9-JH_jVhMzQdo0WiRYH2FmppIBw'
const COOKIE_FILE = new URL('./.rpc-cookie-node', import.meta.url)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

async function mintCookie() {
  const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
  const sc = r.headers.get('set-cookie') ?? ''
  if (!sc) throw new Error(`mint failed: HTTP ${r.status}`)
  const pair = sc.split(';')[0]
  writeFileSync(COOKIE_FILE, pair)
  return pair
}
async function getCookie() {
  if (existsSync(COOKIE_FILE)) return readFileSync(COOKIE_FILE, 'utf8').trim()
  return mintCookie()
}
async function rpc(endpoint, args) {
  const cookie = await getCookie()
  const body = JSON.stringify({ type: 'client-request', rpcId: `rpc-${Date.now()}`, method: endpoint, payload: { args } })
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: Buffer.from(body, 'utf8'),
  })
  const text = await r.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  return { status: r.status, parsed }
}

const cmd = process.argv[2]
if (cmd === 'create') {
  const r = await rpc('session/create', { request: { cwd: 'E:\\Workplace\\extension\\dsh-myteam', agentPreset: 'myteam-captain' } })
  console.log(JSON.stringify(r.parsed, null, 1))
} else if (cmd === 'prompt') {
  const sessionId = process.argv[3]
  const text = process.argv[4]
  const r = await rpc('session/prompt', { request: { requestId: `ki2-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
  console.log(JSON.stringify(r.parsed, null, 1))
} else if (cmd === 'projections') {
  const sessionId = process.argv[3]
  const r = await rpc('session/projections', { request: { sessionId } })
  const s = JSON.stringify(r.parsed)
  console.log(s.length > 4000 ? s.slice(0, 4000) : s)
} else {
  const endpoint = cmd
  let args = {}
  if (process.argv[3]) {
    // 支持文件参数（@path 前缀）避免 shell 转义
    const src = process.argv[3].startsWith('@') ? readFileSync(process.argv[3].slice(1), 'utf8') : process.argv[3]
    args = JSON.parse(src)
  }
  const r = await rpc(endpoint, args)
  console.log(`HTTP ${r.status}`)
  console.log(JSON.stringify(r.parsed, null, 1))
}
