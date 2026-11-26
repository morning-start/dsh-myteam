/**
 * 真机点一遍（live）：起隔离实例 → 用 CDP 打开真实页面 → 点开会话里的「团队视图」标签
 * → 逐栏点开 → 截图 + 断言关键文案。
 *
 * 与 `plugin/test/visual/shot.mjs` 的分工（两者都要有，不能互相替代）：
 *   - `shot.mjs`：直接挂载客户端组件，验「组件在真样式表下的排版」。快、可离线、
 *     但它绕过了宿主装配（会话 tab、面板路由、认证）。
 *   - 本脚本：真起 `dsh web`（隔离 DSH_HOME + 独立 profile + 独立端口），在浏览器里
 *     **真点**那个 tab。验的是「宿主装好之后，用户点得到、点开有东西」。
 *
 * 这一步之前是唯一的验证盲区：46 项 HTTP 判据只证明接口通，不证明界面在真宿主里能点。
 *
 * 用法：
 *   node tools/verify-live.mjs            起实例、点一遍、截图、停掉
 *   node tools/verify-live.mjs --keep     跑完不停实例（方便自己接着点）
 *
 * 退出码：0 全通过；1 有失败项。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 按脚本位置定位仓库根：从任何 cwd 调都能跑。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3101
const BASE = `http://127.0.0.1:${PORT}`
const ISO = join(ROOT, 'tmp', 'iso-home-live')
const WS = join(ROOT, 'tmp', 'live-shot-ws')
const LOG = join(ROOT, 'tmp', 'live-verify.log')
const ERR = join(ROOT, 'tmp', 'live-verify.err')
const OUT = join(ROOT, 'tmp', 'live')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const KEEP = process.argv.includes('--keep')
/**
 * 复用已有隔离 home。
 *
 * 为什么需要：隔离 home 的凭据是空的，实例调不动模型，「请选择模型」也是空的 ——
 * 于是发不出消息、产生不了会话，「团队视图」那段就验不到。让人手动在这个 home 里
 * 加一次模型之后，跑验证必须**保留**这个 home，否则每次都删掉、白加。
 */
const REUSE_HOME = process.argv.includes('--reuse-home')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}
/** 未验证：既不算通过也不算失败，但必须在报告里出现（假装 PASS 比 FAIL 更糟）。 */
const skipped = []
function skip(name, why) {
  skipped.push({ name, why })
  console.log(`SKIP  ${name}  — ${why}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function launchBrowser() {
  const profile = join(ROOT, 'tmp', 'chrome-live-profile')
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
  return {
    cdp: new Cdp(socket),
    kill: () => {
      try { browser.kill() } catch { /* 已退出 */ }
      try { socket.close() } catch { /* 已关闭 */ }
    },
  }
}

/** 启动日志里捞一次性 token，换 cookie。 */
async function mintCookie() {
  const raw = readFileSync(LOG)
  const text = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')
  const token = /[?&]token=([^\s&"']+)/u.exec(text)?.[1]
  if (token === undefined) throw new Error('启动日志里没有 token')
  const response = await fetch(`${BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (cookie === '') throw new Error(`mint cookie 失败：HTTP ${response.status}`)
  return cookie
}

let launcher = null
let browser = null

try {
  mkdirSync(OUT, { recursive: true })

  // ── 0. 隔离 home + 工作区副本 ──────────────────────────────────────────────
  if (REUSE_HOME) {
    check('复用已有隔离 home（保留手动加的模型）', existsSync(ISO), ISO)
  } else {
    rmSync(ISO, { recursive: true, force: true })
  }
  mkdirSync(ISO, { recursive: true })
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  // 刻意**不**复制仓库的 .dsh-myteam：那份是 v1 数据（2026-11 之前建的），
  // 而当前代码只支持 v2 —— 复制过来只会让每栏都显示「未初始化」，验不到真正的界面。
  // 空目录交给插件自己 bootstrap 出 v2，这样九栏的空态才是真的。
  check('隔离工作区就绪（空目录，让插件 bootstrap v2）', existsSync(WS), WS)

  // ── 0b. 把隔离 home 的默认工作区指向我们的副本 ────────────────────────────
  // 坑：`DSH_HOME` 只隔离了会话/凭据/profile，**工作区路径没有隔离**。
  // 隔离 home 新建时，宿主会登记一个默认工作区，路径是
  // `C:\Users\<user>\Documents\deepseek-harness\default-workspace` —— 用户的真实目录。
  // 不把它改掉，会话 cwd 就落在真实目录上，验证会读到/写到用户的项目数据。
  // 这里改的是**隔离 home 内**的 storages/workspace.json（属于我们自己的副本，不动用户那份）。
  //
  // ⚠️ 2026-11-26 实测踩到：旧版只在 workspace.json **已存在**时打补丁，首次启动时它
  // 还不存在 → 直接跳过 → 宿主随后自建了一个指向真实目录的条目 → 会话 cwd 落在
  // `C:\Users\<user>\Documents\deepseek-harness\default-workspace`，那里是 v1 数据，
  // 面板每栏都显示「未初始化」，两项真机检查因此失败。现在**预置**一份，启动前就指好。
  const wsJsonPath = join(ISO, 'storages', 'workspace.json')
  const WS_ID = 'iso-workspace-fixed'
  if (existsSync(wsJsonPath)) {
    const parsed = JSON.parse(readFileSync(wsJsonPath, 'utf8'))
    let patched = 0
    const entries = Object.values(parsed.tables?.workspaces ?? {})
    for (const entry of entries) {
      if (typeof entry.path === 'string' && !entry.path.startsWith(WS)) {
        entry.path = WS
        entry.title = 'iso-workspace'
        patched += 1
      }
    }
    writeFileSync(wsJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    // 复用时通常已经是副本路径（patched = 0），那也是对的 —— 不能因此判失败。
    const allIsolated = entries.every((entry) => typeof entry.path !== 'string' || entry.path.startsWith(WS))
    check(
      '隔离 home 的默认工作区指向副本（不碰用户真实目录）',
      allIsolated,
      patched > 0 ? `本次改 ${String(patched)} 个` : '已是副本路径',
    )
  } else {
    // 首次启动：预置一份，让宿主从一开始就用副本路径，而不是先建一个真实目录的条目。
    mkdirSync(join(ISO, 'storages'), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      wsJsonPath,
      JSON.stringify(
        {
          unit: { name: 'workspace', version: 2 },
          global: {
            initialized: true,
            workspaceIds: [WS_ID],
            archivedSessionIds: [],
            pinnedSessionIds: [],
            defaultWorkspaceId: WS_ID,
          },
          tables: {
            workspaces: {
              [WS_ID]: { path: WS, title: 'iso-workspace', sessionIds: [], createdAt: now, updatedAt: now },
            },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    check('把隔离 home 的默认工作区指向副本（不碰用户真实目录）', true, '预置 workspace.json（首次启动）')
  }

  // ── 1. 起隔离实例（自己的 DSH_HOME / profile / 端口）────────────────────────
  rmSync(LOG, { force: true })
  rmSync(ERR, { force: true })
  const out = openSync(LOG, 'a')
  const err = openSync(ERR, 'a')
  launcher = spawn('cmd.exe', ['/c', join(ROOT, 'tools', 'boot-iso-web.cmd'), String(PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      DSH_HOME: ISO,
      ISO_PROFILE: 'iso-myteam-live',
    },
  })
  launcher.unref()
  closeSync(out)
  closeSync(err)

  let up = false
  for (let index = 0; index < 120; index += 1) {
    await sleep(1000)
    try {
      await fetch(`${BASE}/`, { redirect: 'manual' })
      up = true
      break
    } catch {
      /* 还没起来 */
    }
  }
  check('隔离实例起来', up, `${BASE}`)
  if (!up) throw new Error('实例没起来，看 tmp/live-verify.log')

  const cookie = await mintCookie()
  check('拿到会话 cookie', cookie.length > 0)

  // ── 2. 真浏览器打开，注入 cookie，点开会话 ─────────────────────────────────
  browser = await launchBrowser()
  const { cdp } = browser
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  const session = attached.sessionId
  await cdp.send('Page.enable', {}, session)
  await cdp.send('Runtime.enable', {}, session)
  await cdp.send('Network.enable', {}, session)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, session)

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
    return result.result?.value
  }
  const shot = async (name) => {
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' }, session)
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(data.data, 'base64'))
    return file
  }

  // 设 cookie 再进页面（避免被重定向到 token 页）
  await cdp.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: BASE }, session)
  await cdp.send('Page.navigate', { url: BASE }, session)
  await sleep(4000)

  const title = await evaluate('document.title')
  check('页面打开（有标题）', typeof title === 'string' && title.length > 0, String(title))
  await shot('01-shell')

  // 首启有**两层**弹窗：「预览版说明」→「开始使用」（后者只有关闭按钮）。
  // 只点一次不够 —— 截图里第二层还在，把整页挡住，后面全都点不到。
  // 这里循环关：点「继续」，再点关闭按钮 / 按 Escape，直到页面上没有 role="dialog"。
  let dismissedRounds = 0
  for (let round = 0; round < 6; round += 1) {
    const step = await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]')
      if (dialog === null) return 'clean'
      const buttons = [...dialog.querySelectorAll('button')]
      const go = buttons.find((el) => (el.textContent ?? '').trim() === '继续')
      if (go !== undefined) { go.click(); return 'clicked:继续' }
      const close = buttons.find((el) => {
        const label = (el.getAttribute('aria-label') ?? '') + (el.getAttribute('title') ?? '')
        const text = (el.textContent ?? '').trim()
        return /关闭|close/i.test(label) || text === '×' || text === '✕' || text === ''
      })
      if (close !== undefined) { close.click(); return 'clicked:close' }
      return 'stuck'
    })()`)
    if (step === 'clean') break
    if (step === 'stuck') {
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(300)
      continue
    }
    dismissedRounds += 1
    await sleep(900)
  }
  const stillDialog = await evaluate(`document.querySelector('[role="dialog"], [aria-modal="true"]') !== null`)
  check('关掉首启弹窗（两层都关）', stillDialog === false, stillDialog === true ? '还有弹窗没关掉' : `关掉 ${String(dismissedRounds)} 层`)
  await shot('01b-after-modal')

  // ── 3. 进到一个会话 ────────────────────────────────────────────────────────
  // 两条弯路都记在这里，免得下次重走：
  //   1. 点「新会话」只到欢迎屏，不会建会话；「团队视图」的 tab 位只在**会话里**才有。
  //   2. `session/create` 能造出会话（磁盘上确实多了 session-xxx 目录），但它**不会被写进
  //      storages/workspace.json 的 sessionIds** —— 而左侧栏只列那里登记过的会话，
  //      所以页面上看不到那一行，点不到。
  // 结论：验收要走「界面里本来就有的会话」。隔离 home 首次启动会自动建一个
  // default-workspace 会话，直接点它。
  // ── 3a. 全局库面板（root scope，不需要会话）────────────────────────────────
  // 左侧栏的 myteam 入口打开的是左栏 main 面板 = 全局库，它是 root scope 的，
  // 不依赖会话就能渲染 —— 这是「客户端在真宿主里能不能画出来」最直接的一枪。
  const openedMyteam = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], a, li, div, span')]
    const target = nodes.find((el) => {
      const text = (el.textContent ?? '').trim()
      if (text !== 'myteam') return false
      return ![...el.children].some((child) => (child.textContent ?? '').trim() === 'myteam')
    })
    if (target === undefined) return 'no-entry'
    target.click()
    return 'clicked'
  })()`)
  check('左侧栏有 myteam 入口', openedMyteam !== 'no-entry', String(openedMyteam))
  await sleep(3500)
  await shot('02-global-library')

  const globalText = await evaluate(`(() => {
    const root = document.querySelector('[data-myteam]') ?? document.body
    const clone = root.cloneNode(true)
    for (const node of clone.querySelectorAll('script, style, template, noscript')) node.remove()
    return (clone.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 700)
  })()`)
  const globalStr = String(globalText)
  check('全局库面板真的渲染出来了', globalStr.includes('全局库'), globalStr.slice(0, 150) + '…')
  check('全局库面板带四栏导航', ['概览', '角色', '工作流', '蓝图', '发布'].filter((label) => globalStr.includes(label)).length >= 3,
    globalStr.slice(0, 200) + '…')
  check('全局库面板没有渲染期错误', !/渲染失败|Cannot read|is not a function|读不到这份数据/.test(globalStr))

  // 全局库四栏逐个点开（真点）
  for (const lane of ['角色', '工作流', '蓝图', '发布']) {
    const clicked = await evaluate(`(() => {
      const scopes = [document.querySelector('[data-myteam]'), document]
      for (const scope of scopes) {
        if (scope === null) continue
        const nodes = [...scope.querySelectorAll('[role="tab"], button, a, span, div')]
        const target = nodes.find((el) => {
          if ((el.textContent ?? '').trim() !== ${JSON.stringify(lane)}) return false
          return ![...el.children].some((child) => (child.textContent ?? '').trim() === ${JSON.stringify(lane)})
        })
        if (target !== undefined) { target.click(); return 'ok' }
      }
      return 'missing'
    })()`)
    await sleep(1200)
    const laneText = await evaluate(`(() => {
      const root = document.querySelector('[data-myteam]') ?? document.body
      const clone = root.cloneNode(true)
      for (const node of clone.querySelectorAll('script, style, template, noscript')) node.remove()
      return (clone.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300)
    })()`)
    const ok = clicked === 'ok' && String(laneText).trim().length > 30 && !/渲染失败|读不到这份数据/.test(String(laneText))
    check(`全局库栏「${lane}」能点开且有内容`, ok, clicked === 'missing' ? '找不到这一栏' : String(laneText).slice(0, 80) + '…')
    if (!ok) await shot(`fail-global-${lane}`)
  }

  // ── 3b. 「团队视图」：未验证 ────────────────────────────────────────────────
  // 结论先写：**隔离实例里点不进会话，所以「团队视图」这一段没验到。**
  //
  // 试过并失败的路径（都留在这里，免得下次重走）：
  //   1. 点左侧栏「新会话」→ 只到欢迎屏，不建会话；
  //   2. `POST /api/session/create` → 会话真的建出来了（磁盘上多一个 session-xxx 目录），
  //      但它不会被写进 `storages/workspace.json` 的 sessionIds，左侧栏不列，点不到；
  //   3. `/?session=<id>`、`/#/session/<id>`、`/session/<id>` 三种 URL → 都不进会话
  //      （第三个直接 404），宿主是纯前端状态机，没有可直达的路由；
  //   4. 读 workspace.json 里宿主自己登记的会话 id 再导航 → 仍然进不去，
  //      左侧栏显示「无匹配会话」（即使那个 id 确实登记在 sessionIds 里）；
  //   5. 「新会话」→ 往输入框打字 → 回车发送 → 仍停在欢迎屏。
  //
  // 上面五条都是在「没有模型凭据」的前提下失败的。凭据补上之后，只有一条真实路径：
  // 点「新会话」→ **选模型**（不选就发不出去）→ 输入框打字 → 回车 → 等回合一开，会话就出现了。
  const fresh = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const target = buttons.find((el) => (el.textContent ?? '').trim().startsWith('新会话'))
    if (target === undefined) return 'no-button'
    target.click()
    return 'clicked'
  })()`)
  check('点「新会话」', fresh === 'clicked', String(fresh))
  await sleep(2000)

  // 模型：隔离 home 里已经配好了就不再需要选（截图右下角会直接显示具体模型名）。
  // 只有没配的时候才需要点开选择器。这里只做一次探测，不再强行点。
  const modelState = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => /请选择模型|选择模型/.test((el.textContent ?? '')))
    return trigger === undefined ? 'already-configured' : 'needs-pick'
  })()`)
  console.log('  [diag] 模型状态: ' + String(modelState))
  if (modelState === 'needs-pick') {
    const picked = await evaluate(`(() => {
      const trigger = [...document.querySelectorAll('button, [role="button"]')]
        .find((el) => /请选择模型|选择模型/.test((el.textContent ?? '')))
      if (trigger === undefined) return 'no-trigger'
      trigger.click()
      return 'opened'
    })()`)
    await sleep(1200)
    // 弹层里的选项：取「有 role=option/menuitem」的优先；没有再退回叶子节点。
    const chosen = await evaluate(`(() => {
      const options = [...document.querySelectorAll('[role="option"], [role="menuitem"]')]
      if (options.length > 0) {
        options[0].click()
        return (options[0].textContent ?? '').trim().slice(0, 40)
      }
      return 'no-option'
    })()`)
    console.log('  [diag] 选模型: ' + String(picked) + ' → ' + String(chosen))
    await sleep(1200)
  }

  // ── 真实输入：CDP 鼠标点输入框 + CDP 键盘 insertText + 回车 ────────────────
  // 先拿到输入框的位置（优先 contenteditable，其次 textarea）。
  const box = await evaluate(`(() => {
    const candidates = [
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('textarea'),
    ]
    const area = candidates[candidates.length - 1]   // 取最后一个：通常是底部那个输入框
    if (area === undefined) return null
    const rect = area.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(rect.left + Math.min(rect.width / 2, 120)),
      y: Math.round(rect.top + rect.height / 2),
      tag: area.tagName,
      w: Math.round(rect.width),
    })
  })()`)
  console.log('  [diag] 输入框: ' + String(box))
  if (box === null || box === 'null') {
    skip('「团队视图」标签在真宿主里点开', '找不到输入框')
  } else {
    const rect = JSON.parse(box)
    // 点进去（真实鼠标事件）
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: rect.x, y: rect.y, button: 'left', clickCount: 1,
      }, session)
    }
    await sleep(500)
    // 真实文本输入（走 IME 路径，不受 React 受控逻辑影响）
    await cdp.send('Input.insertText', { text: '你好' }, session)
    await sleep(800)

    // 确认文本真的进去了：在页面里读一次输入框内容
    const typedOk = await evaluate(`(() => {
      const candidates = [
        ...document.querySelectorAll('[contenteditable="true"]'),
        ...document.querySelectorAll('textarea'),
      ]
      const area = candidates[candidates.length - 1]
      if (area === undefined) return 'gone'
      const text = area.tagName === 'TEXTAREA' ? area.value : (area.textContent ?? '')
      return text.trim().length > 0 ? 'has-text' : 'empty'
    })()`)
    check('输入框真的收到文字（CDP 真实键盘）', typedOk === 'has-text', String(typedOk))
    await shot('03-typed')

    // 真实回车
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      }, session)
    }
    console.log('  [diag] 已发送真实回车')
  }

  // 等回合一开。会话一建出来，会话级 tab（「团队视图」）就会出现。
  let hasTab = false
  for (let round = 0; round < 30; round += 1) {
    await sleep(1500)
    const probe = await evaluate(`(() => {
      const text = document.body.textContent ?? ''
      return text.includes('团队视图') ? 'yes' : 'no'
    })()`)
    if (probe === 'yes') {
      hasTab = true
      break
    }
  }
  check('发一条消息后出现「团队视图」标签', hasTab, hasTab ? '会话已建立' : '30 次轮询仍没出现（见下方未验证说明）')
  await shot('03-team-view-appeared')

  if (!hasTab) {
    skip('「团队视图」标签在真宿主里点开', '发消息后仍未产生会话；需人工确认该实例的模型是否可用')
  }

  // 会话建立了才做逐栏检查 —— 但先得**点开「团队视图」标签**，否则读到的是对话界面。
  let tabOpened = false
  if (hasTab) {
    const clickTab = await evaluate(`(() => {
      // 精确文本「团队视图」，且只取叶子节点（避免点到外层容器）。
      const nodes = [...document.querySelectorAll('[role="tab"], button, a, span, div')]
      const target = nodes.find((el) => {
        if ((el.textContent ?? '').trim() !== '团队视图') return false
        return ![...el.children].some((child) => (child.textContent ?? '').trim() === '团队视图')
      })
      if (target === undefined) return 'missing'
      target.click()
      return 'clicked'
    })()`)
    await sleep(4000)
    const panelReady = await evaluate(`(() => {
      const root = document.querySelector('[data-myteam]')
      if (root === null) return 'no-root'
      const text = (root.textContent ?? '').replace(/\s+/g, ' ')
      return text.length > 60 ? 'rendered' : 'empty'
    })()`)
    tabOpened = clickTab === 'clicked' && panelReady === 'rendered'
    check('点开「团队视图」标签并有内容', tabOpened, `${String(clickTab)} → ${String(panelReady)}`)
    await shot('04-team-view-panel')

    if (tabOpened) {
      const panelText = await evaluate(`(() => {
        const root = document.querySelector('[data-myteam]')
        const clone = root.cloneNode(true)
        for (const node of clone.querySelectorAll('script, style, template, noscript')) node.remove()
        return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      })()`)
      const text = String(panelText)
      check('团队视图面板没有渲染期错误', !/读不到这份数据|渲染失败|Cannot read|is not a function/.test(text), text.slice(0, 150) + '…')
      check('团队视图面板带九栏导航',
        ['概览', '任务', '团队', '流程', '定义', '知识', '记忆', '审计', '设置'].filter((label) => text.includes(label)).length >= 7,
        text.slice(0, 220) + '…')
    }
  }

  const lanesVerified = tabOpened

  if (lanesVerified) {
    const LANES = ['任务', '团队', '流程', '定义', '知识', '记忆', '审计', '设置']
    for (const lane of LANES) {
      const clicked = await evaluate(`(() => {
        const scopes = [document.querySelector('[data-myteam]'), document]
        for (const scope of scopes) {
          if (scope === null) continue
          const nodes = [...scope.querySelectorAll('[role="tab"], button, a, span, div')]
          // 只取「叶子」节点：文本恰好等于栏名，且没有同文本的子元素（避免点到外层容器）。
          const target = nodes.find((el) => {
            if ((el.textContent ?? '').trim() !== ${JSON.stringify(lane)}) return false
            return ![...el.children].some((child) => (child.textContent ?? '').trim() === ${JSON.stringify(lane)})
          })
          if (target !== undefined) {
            target.click()
            return 'ok'
          }
        }
        return 'missing'
      })()`)
      await sleep(1200)
      const laneText = await evaluate(`(() => {
        const root = document.querySelector('[data-myteam]') ?? document.body
        const clone = root.cloneNode(true)
        for (const node of clone.querySelectorAll('script, style, template, noscript')) node.remove()
        return (clone.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 400)
      })()`)
      const laneStr = String(laneText)
      const ok = clicked === 'ok' && laneStr.trim().length > 30 && !/读不到这份数据|渲染失败/.test(laneStr)
      check(`栏「${lane}」能点开且有内容`, ok, clicked === 'missing' ? '找不到这一栏' : `${laneStr.slice(0, 60)}…`)
      if (!ok) await shot(`fail-${lane}`)
    }
  }
  // 建团队表单的两种建法（p-team-new）：直接建 / 先落计划。
  // 这两条是 2026-11-25 新接的（planPropose 之前客户端 0 处调用），
  // 单测只证明「点了会发什么请求」，这里证明「在真宿主里点得到」。
  if (lanesVerified) {
    const backToTeams = await evaluate(`(() => {
      const scope = document.querySelector('[data-myteam]')
      if (scope === null) return 'no-panel'
      const nodes = [...scope.querySelectorAll('[role="tab"], button, a, span, div')]
      const target = nodes.find((el) => {
        if ((el.textContent ?? '').trim() !== '团队') return false
        return ![...el.children].some((child) => (child.textContent ?? '').trim() === '团队')
      })
      if (target === undefined) return 'no-tab'
      target.click()
      return 'ok'
    })()`)
    await sleep(1200)
    const openForm = await evaluate(`(() => {
      const scope = document.querySelector('[data-myteam]')
      if (scope === null) return 'no-panel'
      const nodes = [...scope.querySelectorAll('button')]
      const target = nodes.find((el) => (el.textContent ?? '').trim() === '建团队')
      if (target === undefined) return 'no-button'
      target.click()
      return 'ok'
    })()`)
    await sleep(1200)
    const formText = await evaluate(`(() => {
      const root = document.querySelector('[data-myteam]')
      if (root === null) return ''
      const clone = root.cloneNode(true)
      for (const node of clone.querySelectorAll('script, style, template, noscript')) node.remove()
      return (clone.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 1200)
    })()`)
    const formStr = String(formText)
    check('团队栏「建团队」表单能打开',
      backToTeams === 'ok' && openForm === 'ok' && formStr.includes('团队名字'),
      `回到团队栏=${String(backToTeams)}；开表单=${String(openForm)} → ${formStr.slice(0, 80)}…`)
    check('建团队表单有两种建法（直接建 / 先落计划）',
      formStr.includes('直接建') && formStr.includes('先落计划'),
      formStr.includes('先落计划') ? '两种都在' : '缺「先落计划」')
    await shot('05-team-create-form')
  }

  // 待你确认整页（p-approval）：从概览横幅的「逐项确认」进。
  // 空项目没有待确认项，横幅不渲染 —— 那就断言「没有横幅」也是对的（0 件不该出现）。
  if (lanesVerified) {
    const backToOverview = await evaluate(`(() => {
      const scope = document.querySelector('[data-myteam]')
      if (scope === null) return 'no-panel'
      const nodes = [...scope.querySelectorAll('[role="tab"], button, a, span, div')]
      const target = nodes.find((el) => {
        if ((el.textContent ?? '').trim() !== '概览') return false
        return ![...el.children].some((child) => (child.textContent ?? '').trim() === '概览')
      })
      if (target === undefined) return 'no-tab'
      target.click()
      return 'ok'
    })()`)
    await sleep(1200)
    const overviewText = await evaluate(`(() => {
      const root = document.querySelector('[data-myteam]')
      if (root === null) return ''
      const clone = root.cloneNode(true)
      for (const node of clone.querySelectorAll('script, style, template, noscript')) node.remove()
      return (clone.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 1200)
    })()`)
    const ovStr = String(overviewText)
    const hasBanner = ovStr.includes('逐项确认')
    const waitingZero = ovStr.includes('0 件待确认') || ovStr.includes('等你确认0')
    check('概览：0 件待确认时不出现「逐项确认」横幅',
      backToOverview === 'ok' && (!hasBanner || !waitingZero),
      `${String(backToOverview)}；横幅=${hasBanner ? '有' : '无'}`)
    await shot('06-overview')
  }

  await shot('04-last-lane')

  console.log(`\n截图：${OUT}`)
  console.log(`隔离 home：${ISO}${REUSE_HOME ? '（已复用）' : '（本次重建）'}`)
} catch (error) {
  check('执行过程未抛错', false, error instanceof Error ? error.message : String(error))
} finally {
  if (browser !== null) browser.kill()
  if (!KEEP && launcher !== null) {
    // 只停自己端口上的实例：按命令行里的端口号匹配，绝不 taskkill 全部 node。
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--port ${PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' })
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? 'LIVE_OK' : 'LIVE_FAIL'} ${results.length - failed.length}/${results.length}`)
if (failed.length > 0) {
  for (const item of failed) console.log(`  ✗ ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`)
}
if (skipped.length > 0) {
  console.log(`未验证 ${skipped.length} 项（不计入通过率）：`)
  for (const item of skipped) console.log(`  – ${item.name}：${item.why}`)
}
process.exit(failed.length === 0 ? 0 : 1)
