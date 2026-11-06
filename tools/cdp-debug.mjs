/**
 * CDP 调试夹具（本地开发用，非插件产物）。
 *
 * 用法：node tools/cdp-debug.mjs <scenario.mjs> <url>
 *   - 复用/新建一个 page target（端口 9222），导航到 <url>，等 load 后执行 scenario
 *   - scenario: export default async ({ ev, shot, wait, logs, page }) => any
 *   - 结束后打印 scenario 返回值 + 控制台/异常/网络失败日志
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const CDP = 'http://127.0.0.1:9222'
const [scenarioPath, url] = process.argv.slice(2)
if (!scenarioPath || !url) {
  console.error('usage: node tools/cdp-debug.mjs <scenario.mjs> <url>')
  process.exit(2)
}

async function listTargets() {
  const res = await fetch(`${CDP}/json/list`)
  return res.json()
}

async function newTarget(targetUrl) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  return res.json()
}

let target = (await listTargets()).find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
if (!target) target = await newTarget('about:blank')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const logs = []
const waiters = []
function emit(method, params) {
  for (const w of [...waiters]) {
    if (w.method === method) {
      w.resolve(params)
      waiters.splice(waiters.indexOf(w), 1)
    }
  }
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    logs.push({ kind: 'console', type: msg.params.type, text: text.length > 400 ? `${text.slice(0, 400)}…` : text })
  } else if (msg.method === 'Log.entryAdded') {
    const t = msg.params.entry.text
    logs.push({ kind: 'log', level: msg.params.entry.level, text: t.length > 400 ? `${t.slice(0, 400)}…` : t, url: msg.params.entry.url })
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    const detail = d.exception?.description
    logs.push({ kind: 'exception', text: d.text, detail: detail && detail.length > 400 ? `${detail.slice(0, 400)}…` : detail })
  } else if (msg.method === 'Network.loadingFailed') {
    logs.push({ kind: 'netfail', text: `${msg.params.type} ${msg.params.errorText}`, url: msg.params.requestId })
  }
  emit(msg.method, msg.params)
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function once(method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const w = { method, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) {
        waiters.splice(i, 1)
        reject(new Error(`timeout waiting ${method}`))
      }
    }, timeoutMs).unref?.()
  })
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
const [vw, vh] = (process.env.CDP_SIZE ?? '1440x900').split('x').map(Number)
await send('Emulation.setDeviceMetricsOverride', { width: vw || 1440, height: vh || 900, deviceScaleFactor: 1, mobile: false })

const loaded = once('Page.loadEventFired', 20000).catch(() => null)
await send('Page.navigate', { url })
await loaded
await new Promise((r) => setTimeout(r, 1500))

mkdirSync('.debug', { recursive: true })

const ctx = {
  logs,
  page: { targetId: target.id, url },
  ev: async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  shot: async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const path = join('.debug', `${name}.png`)
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  },
}

let result
try {
  const mod = await import(pathToFileURL(join(process.cwd(), scenarioPath)).href)
  result = await mod.default(ctx)
} catch (e) {
  console.error('[scenario error]', e.message)
  process.exitCode = 1
} finally {
  console.log('=== RESULT ===')
  console.log(JSON.stringify(result, null, 2))
  console.log('=== LOGS ===')
  for (const l of logs) console.log(JSON.stringify(l))
  ws.close()
}
