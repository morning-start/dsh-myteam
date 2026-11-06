// 诊断 /api 鉴权：逐步铸 cookie 并复用，打印每步关键头
const BASE = 'http://127.0.0.1:3080'
const TOKEN = 'rBG9yKIRtaSRA7ldIKffKQYiVgBWoyszfzX91hnVNmU'

async function mintCookie() {
  const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
  const sc = r.headers.get('set-cookie') ?? ''
  console.log('[mint] status', r.status, 'set-cookie:', sc.slice(0, 80))
  return sc.split(';')[0]
}

const cookie = await mintCookie()
console.log('[use] cookie:', cookie.slice(0, 60), '...')

const body = JSON.stringify({
  type: 'client-request',
  rpcId: 'diag-1',
  method: 'myteam/listTeams',
  payload: { args: {} },
})
const r2 = await fetch(`${BASE}/api/myteam/listTeams`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body,
})
console.log('[rpc] status', r2.status)
const text = await r2.text()
console.log('[rpc] body:', text.slice(0, 300))
