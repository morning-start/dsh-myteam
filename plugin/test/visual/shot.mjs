/**
 * 客户端截图：用无头 Chrome 打开 `plugin/test/visual/harness.html`，每栏截一张。
 *
 * 为什么不走 CDP 点真实实例：那要先驱动 DSH 外壳打开会话、再点「团队视图」标签，
 * 一步错整轮白跑；这个脚本验的是**组件在真样式表下的排版**，宿主装配另有
 * `tmp/verify-iso.mjs`（46 项 HTTP 判据）覆盖。
 *
 * 用法（在仓库根跑）：
 *   node plugin/test/visual/shot.mjs                 # 默认 1280×900，七个场景
 *   node plugin/test/visual/shot.mjs 375 812         # 换尺寸（手机）
 *   node plugin/test/visual/shot.mjs 1280 900 teams # 只截某一栏
 * 产物：tmp/visual/<尺寸>-<场景>.png
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
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
const port = server.address().port
const BASE = `http://127.0.0.1:${port}`

const [widthArg, heightArg, onlyTab] = process.argv.slice(2)
const width = Number(widthArg ?? 1280)
const height = Number(heightArg ?? 900)

const SCENARIOS = [
  { name: 'overview', query: 'tab=overview' },
  { name: 'tasks', query: 'tab=tasks' },
  { name: 'teams', query: 'tab=teams&team=1' },
  { name: 'definitions', query: 'tab=definitions&open=1' },
  { name: 'memory', query: 'tab=memory' },
  { name: 'memory-form', query: 'tab=memory&form=1' },
  { name: 'memory-empty', query: 'tab=memory&empty=1' },
].filter((scenario) => onlyTab === undefined || scenario.name === onlyTab)

function shot(name, query) {
  const file = join(OUT, `${width}x${height}-${name}.png`)
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + join(ROOT, 'tmp', 'chrome-profile'),
    `--window-size=${width},${height}`,
    '--virtual-time-budget=6000',
    `--screenshot=${file}`,
    `${BASE}/plugin/test/visual/harness.html?${query}`,
  ]
  return new Promise((resolve) => {
    const child = spawn(CHROME, args, { stdio: 'ignore' })
    child.on('exit', (code) => resolve({ name, file, code }))
  })
}

const results = []
for (const scenario of SCENARIOS) results.push(await shot(scenario.name, scenario.query))

server.close()

for (const result of results) {
  console.log(`${result.code === 0 && existsSync(result.file) ? 'OK  ' : 'FAIL'} ${result.file}`)
}
const failed = results.filter((result) => result.code !== 0 || !existsSync(result.file))
console.log(failed.length === 0 ? `SHOTS_OK ${results.length} 张` : `SHOTS_FAIL ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
