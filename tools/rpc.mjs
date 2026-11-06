// 通用 RPC 客户端：node rpc.mjs <endpoint> [argsJson]
// cookie 用 v1（index ?token 铸），缓存于 tmp/.rpc-cookie-node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const BASE = 'http://127.0.0.1:3080'
const TOKEN = 'rBG9yKIRtaSRA7ldIKffKQYiVgBWoyszfzX91hnVNmU'
const COOKIE_FILE = new URL('./.rpc-cookie-node', import.meta.url)

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

const endpoint = process.argv[2]
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
let cookie = await getCookie()

async function call() {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `rpc-${Date.now()}`,
    method: endpoint,
    payload: { args },
  })
  return fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: Buffer.from(body, 'utf8'),
  })
}

let r = await call()
if (r.status === 401) {
  cookie = await mintCookie()
  r = await call()
}
const text = await r.text()
console.log(`HTTP ${r.status}`)
console.log(text)
