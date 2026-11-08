/**
 * T100 路 CHG-155：**面板不再黑屏**——三条独立缺陷的回归锁。
 *
 * 背景（用户：「任务面板中的依赖图怎么打不开？一打开就黑屏」）：
 *  ① **团队视图 `watch` 紧循环**：客户端不带 `workspaceRoot` → 服务端 `offlineTarget`
 *     立即返回 `MT_VALIDATION` **错误信封**（不抛异常）→ 旧实现只在 `catch` 里 sleep，
 *     成功分支无间隔重发 → 每秒上千次 RPC → 渲染进程占满（黑屏）。
 *  ② **没有渲染错误边界**：任何渲染异常都让整块插槽变空白，深色主题下就是黑屏，且无信息。
 *  ③ **会话视图三视图 `onOpen` 契约不一致**：`DagView` 传 id 字符串，旧实现按对象取 `.id`
 *     → 双击依赖图卡片得到 `"undefined"`，打开不存在的任务。
 *
 * 自证（mock loader，不依赖浏览器 / 宿主）：
 *  - 边界：渲染异常时出可读兜底（标题 + 摘要 + 重试），且 `getDerivedStateFromError` 生效；
 *  - 登记：`main` / `conversation.view` / `conversation.composer.dock` 三个可见表面都套了边界；
 *  - 循环：`watch` 必带 `workspaceRoot`，且**未变化时至少隔 MIN_POLL_MS** 再问；
 *  - 归一：`openConvTask` 同时接受 id 与 task，空 id 不制造假任务；
 *  - 文案：`errors.renderTitle` / `errors.renderRetry` 中英齐全。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

const j = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
const js = (type, props, ...children) => j(type, props, ...children)
/** 注意：**故意不提供 `Component`**——验证边界在只有 hooks 的 shim 下也能构造（宿主 shim 同形） */
const reactShim = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

function loadClient() {
  const registered = []
  const slots = {
    inject: (name, registerFactory) => {
      const reg = registerFactory()
      registered.push({ name, ...reg })
      return reg
    },
    register: (def, component) => ({ ...def, component }),
  }
  const modules = new Map([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const ctx = {
    slots,
    connection: { rpc: { call: async () => ({ ok: true, value: undefined }) } },
    locale: { bind: () => (k) => k, register: () => {} },
    effect: (fn) => fn(),
    get: () => undefined,
  }
  let module
  const loader = {
    load: (def) => {
      const require_ = (name) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      }
      module = def.factory(require_)
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_v) {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { toggleAttribute: () => {}, style: { setProperty: () => {} } },
    documentElement: { dataset: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { module, source, registered }
}

const { module, source, registered } = loadClient()

test('T100 ① 错误边界：渲染异常 → 可读兜底（标题 + 摘要 + 重试），不是黑屏', () => {
  const { MyTeamRenderBoundary } = module.__testResilience
  assert.equal(typeof MyTeamRenderBoundary, 'function', '必须导出错误边界，供 mock loader 断言')

  /* getDerivedStateFromError 把异常收进 state（React 的兜底钩子） */
  const next = MyTeamRenderBoundary.getDerivedStateFromError(new Error('boom'))
  assert.ok(next && next.error instanceof Error, 'getDerivedStateFromError 必须产出 { error }')

  /* 无异常：原样渲染 children（不改变正常路径） */
  const healthy = new MyTeamRenderBoundary({ t: (k) => k, children: 'ok' })
  assert.equal(healthy.render(), 'ok')

  /* 有异常：可读兜底 + 重试按钮；locale 拿不到时降级中文常量 */
  const broken = new MyTeamRenderBoundary({ t: () => undefined, children: 'ok' })
  broken.state = { error: new Error('render exploded') }
  const tree = broken.render()
  assert.equal(tree.props.role, 'alert', '兜底必须是可被读屏播报的 alert 区域')
  const texts = JSON.stringify(tree.children)
  assert.match(texts, /面板渲染失败/, '必须写出「面板渲染失败」而不是空白')
  assert.match(texts, /render exploded/, '必须带错误摘要，便于定位真因')
  assert.ok(tree.children.some((child) => child?.type === 'button'), '必须给「重试」按钮')

  /* 组件栈：定位「谁在循环」的唯一线索（#185 尤其需要）——最多 3 帧，一行内串起来 */
  const withStack = new MyTeamRenderBoundary({ t: () => undefined, children: 'ok' })
  withStack.state = { error: new Error('Maximum update depth exceeded'), info: { componentStack: '\n    at Panel\n    at DagView\n    at TaskList\n    at App' } }
  const stackText = JSON.stringify(withStack.render().children)
  assert.match(stackText, /Panel ← DagView ← TaskList/, '必须显示组件栈前 3 帧')
  assert.doesNotMatch(stackText, /App/, '栈只留前 3 帧（再长没人看）')

  /* 重试只清 error + info，不重载页面 */
  let cleared = null
  const retryable = new MyTeamRenderBoundary({ t: (k) => k, children: 'ok' })
  retryable.state = { error: new Error('x'), info: { componentStack: 'at X' } }
  retryable.setState = (patch) => { cleared = patch }
  retryable.retry()
  assert.deepEqual(cleared, { error: null, info: null })
})

test('T100 ② 三个可见表面都套了渲染错误边界（main / conversation.view / composer.dock）', () => {
  const { withRenderBoundary } = module.__testResilience
  const wrapped = withRenderBoundary(function Demo() { return null })
  assert.equal(wrapped.displayName, 'MyTeamBoundary(Demo)')

  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    connection: { rpc: { call: async () => ({ ok: true, value: undefined }) } },
    locale: { bind: () => (k) => k, register: () => {} },
    slots: {
      inject: (name, factory) => {
        const reg = factory()
        registered.push({ name, ...reg })
        return reg
      },
      register: (def, component) => ({ ...def, component }),
    },
  }
  module.apply(ctx)

  const componentOf = (name) => registered.filter((entry) => entry.name === name).map((entry) => entry.component)
  for (const name of ['main', 'conversation.view', 'conversation.composer.dock']) {
    const components = componentOf(name)
    assert.ok(components.length > 0, `${name} 必须登记`)
    assert.ok(
      components.some((component) => String(component?.displayName ?? '').startsWith('MyTeamBoundary(')),
      `${name} 必须包在渲染错误边界里（否则一抛错就是黑屏）`,
    )
  }
})

test('T100 ③ watch 长轮询：带 workspaceRoot + 未变化至少隔 1s（不再紧循环）', () => {
  /* 静态锁：两条缺一不可（只带参数不带退避，服务端回错误信封时仍会紧循环） */
  assert.match(source, /workspaceRoot\s*\?\s*\{\s*workspaceRoot\s*\}\s*:\s*\{\s*\}/, 'watch 请求必须带 workspaceRoot')
  assert.match(source, /const MIN_POLL_MS = \d+/, '必须有最小轮询间隔常量')
  assert.match(source, /if \(elapsed < MIN_POLL_MS\) await sleep\(MIN_POLL_MS - elapsed\)/, '未变化时必须退避')
  /* 旧写法（无间隔直接重开）不得回潮 */
  assert.doesNotMatch(source, /if \(r\?\.changed\) setTick\(\(value\) => value \+ 1\)\n\s*\} catch/, '旧的无退避循环不得回潮')
  /* 守卫：循环体必须有 catch → sleep(3000) 的错误退避 */
  assert.match(source, /catch \{\s*await sleep\(3000\)\s*\}/, 'RPC 抛错时也要退避')
})

test('T100 ④ 会话视图三视图 onOpen 归一：id 与 task 都收，空 id 不制造假任务', () => {
  assert.match(source, /const openConvTask = \(target\) => \{/, '必须有归一的 openConvTask')
  assert.match(source, /typeof target === 'object' \? target\.id : target/, '必须同时接受 task 对象与 id 字符串')
  /* 三个视图一律用归一后的回调（不允许再出现 String(task.id) 的旧写法） */
  assert.equal((source.match(/onOpen: openConvTask/g) ?? []).length, 3, '看板 / 流程 / 依赖图都要用 openConvTask')
  assert.doesNotMatch(source, /onOpen: \(task\) => setOpenTaskId\(String\(task\.id\)\)/, '旧写法不得回潮')
})

test('T100 ⑤ 兜底文案中英齐全（渲染异常时按语言显示）', () => {
  const zhBlock = source.slice(source.indexOf('Object.assign(zh, {'), source.indexOf('Object.assign(en, {'))
  const enBlock = source.slice(source.indexOf('Object.assign(en, {'))
  for (const key of ['errors.renderTitle', 'errors.renderRetry', 'errors.renderWhere']) {
    assert.ok(zhBlock.includes(`'${key}'`), `zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}'`), `en 缺 ${key}`)
  }
})

test('T100 ⑥ 依赖图测量不再自激（React #185）：不把自己的输出当输入 + 熔断', () => {
  /* ① 依赖里不能有 heights / avail —— 那是 effect 自己的输出，当依赖就是同步更新环 */
  const depsMatch = source.match(/\}, \[tasks, dir, ready\]\)/)
  assert.ok(depsMatch, 'DagView 的测量 effect 依赖必须只有 [tasks, dir, ready]')
  assert.doesNotMatch(source, /\}, \[tasks, dir, heights, avail\.w, avail\.h, ready\]\)/, '旧的「输出当输入」依赖不得回潮')

  /* ② 值没变就不 setState（否则每帧都重排） */
  assert.match(source, /if \(!sizeChanged && !heightsChanged\) \{/, '必须有不变化的快速返回')
  assert.match(source, /layoutPassRef\.current = 0/, '稳定后必须把熔断计数归零')

  /* ③ 熔断：同一布局签名最多重排 N 次 */
  assert.match(source, /const DAG_MAX_LAYOUT_PASSES = \d+/, '必须有重排熔断常量')
  assert.match(source, /if \(layoutPassRef\.current >= DAG_MAX_LAYOUT_PASSES\) return/, '必须有熔断分支')

  /* ④ 布局签名换了才清零（换方向 / 换任务集要能重新测） */
  assert.match(source, /if \(sig !== layoutSigRef\.current\) \{/, '布局签名比较必须存在')
})
