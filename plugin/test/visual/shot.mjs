/**
 * 客户端截图：用无头 Chrome + CDP 打开 `plugin/test/visual/harness.html`，每栏截一张。
 *
 * 为什么走 CDP 而不是 `chrome --headless --screenshot`：
 * `--window-size=375,812` **不是** 375 的视口 —— headless 有最小窗口宽度，实测
 * `window.innerWidth` 会变成 512，截图就成了「按 512 排版再裁到 375」。
 * 用 `Emulation.setDeviceMetricsOverride` 才能拿到真窄宽，量出来的才是真机排版。
 *
 * 为什么不点真实实例：那要先驱动 DSH 外壳打开会话、再点「团队视图」标签，一步错整轮白跑；
 * 这个脚本验的是**组件在真样式表下的排版**，宿主装配另有 `tmp/verify-iso.mjs`（46 项 HTTP 判据）。
 *
 * 用法（在仓库根跑）：
 *   node plugin/test/visual/shot.mjs                 # 默认 1280×900，七个场景
 *   node plugin/test/visual/shot.mjs 375 812         # 真 375 视口（CDP 覆盖）
 *   node plugin/test/visual/shot.mjs 1280 900 teams # 只截某一栏
 * 产物：tmp/visual/<宽>x<高>-<场景>.png
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { extname, join, normalize } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'tmp', 'visual')
mkdirSync(OUT, { recursive: true })

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((path) => existsSync(path))
if (CHROME === undefined) {
  console.error('找不到 Chrome/Edge')
  process.exit(1)
}

// 作用域转换与 panel.ts 一致：仓库 CSS 挂在 [data-slot="main"] 下（宿主槽位），
// 夹具里换成 [data-myteam]，免得把壳体框架样式（dsh-shell.css 里 [data-slot] 的规则）
// 也套到夹具容器上 —— 那些规则带外壳宽度约束，会把排版量歪。
writeFileSync(
  join(OUT, 'design.css'),
  readFileSync(join(ROOT, 'design-v2', 'myteam.css'), 'utf8')
    .replace(/\[data-slot="main"\]/gu, '[data-myteam]')
    .replace(/:root\s*\{/gu, '[data-myteam] {'),
  'utf8',
)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0])
  const full = join(ROOT, normalize(path).replace(/^([/\\])+/, ''))
  try {
    const body = await readFile(full)
    response.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

const [widthArg, heightArg, onlyTab] = process.argv.slice(2)
const width = Number(widthArg ?? 1280)
const height = Number(heightArg ?? 900)

const SCENARIOS = [
  { name: 'overview', query: 'tab=overview' },
  { name: 'tasks', query: 'tab=tasks' },
  { name: 'teams', query: 'tab=teams&team=1' },
  { name: 'definitions', query: 'tab=definitions&open=1' },
  { name: 'blueprint', query: 'tab=definitions&openBlueprint=1' },
  { name: 'global-edit', query: 'panel=1&openGlobal=1' },
  { name: 'memory', query: 'tab=memory' },
  { name: 'memory-form', query: 'tab=memory&form=1' },
  { name: 'memory-empty', query: 'tab=memory&empty=1' },
].filter((scenario) => onlyTab === undefined || scenario.name === onlyTab)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 和一个 CDP target 说话：按 id 配平请求/响应，`sessionId` 走 flatten 模式。 */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify(payload))
    })
  }
}

/** 起一个 headless Chrome，返回 { cdp, browser, kill }。 */
async function launch() {
  const profile = join(ROOT, 'tmp', 'chrome-cdp-profile')
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  const browser = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
  ], { stdio: 'ignore' })

  // DevToolsActivePort：第一行端口、第二行浏览器 ws 路径。
  const portFile = join(profile, 'DevToolsActivePort')
  let port = null
  for (let round = 0; round < 100; round += 1) {
    if (existsSync(portFile)) {
      port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
      if (Number.isFinite(port) && port > 0) break
    }
    await sleep(100)
  }
  if (port === null) throw new Error('Chrome 没有写出 DevToolsActivePort')

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  const cdp = new Cdp(socket)
  return {
    cdp,
    kill: () => {
      try {
        browser.kill()
      } catch {
        /* 已经退出 */
      }
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
    },
  }
}

async function shoot(cdp, name, query) {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  const session = attached.sessionId
  try {
    await cdp.send('Page.enable', {}, session)
    await cdp.send('Runtime.enable', {}, session)
    // 真视口：这一句是整段的关键，--window-size 给不到 375。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session)
    await cdp.send('Page.navigate', { url: `${BASE}/plugin/test/visual/harness.html?${query}` }, session)

    // 等夹具报 ready（最多 12 秒），再等两拍让 CSS/字体稳定。
    let ready = false
    for (let round = 0; round < 120; round += 1) {
      await sleep(100)
      const probe = await cdp.send('Runtime.evaluate', {
        expression: "document.body && document.body.dataset ? document.body.dataset.harnessReady === '1' : false",
        returnByValue: true,
      }, session)
      if (probe.result?.value === true) {
        ready = true
        break
      }
    }
    await sleep(200)

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, session)
    const file = join(OUT, `${width}x${height}-${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))

    // 把视口与布局宽度一并报出来：免得再出现「以为在量 375」的自欺。
    const geometry = await cdp.send('Runtime.evaluate', {
      expression: "JSON.stringify({ inner: window.innerWidth, slot: Math.round(document.getElementById('slot').getBoundingClientRect().width), scroll: document.getElementById('slot').scrollWidth })",
      returnByValue: true,
    }, session)
    return { name, file, ready, geometry: geometry.result?.value ?? '' }
  } finally {
    await cdp.send('Target.closeTarget', { targetId: created.targetId })
  }
}

const { cdp, kill } = await launch()
const results = []
try {
  for (const scenario of SCENARIOS) results.push(await shoot(cdp, scenario.name, scenario.query))
} finally {
  kill()
  server.close()
}

for (const result of results) {
  console.log(`${result.ready ? 'OK  ' : 'NOREADY'} ${result.file}  ${result.geometry}`)
}
const failed = results.filter((result) => !result.ready || !existsSync(result.file))
console.log(failed.length === 0 ? `SHOTS_OK ${results.length} 张` : `SHOTS_FAIL ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
