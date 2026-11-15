/**
 * T87 · CHG-114：入口 → 工作台的上下文交接。
 *
 * 背景：全局/项目不拆两个宿主表面（CHG-114 裁决），但「团队视图」tab 和 composer chip
 * 两个入口此前调的是 `ctx.get('uiWorkspace')?.openPanel?.(PANEL_KEY)`——宿主 `uiWorkspace`
 * 服务上没有 `openPanel` 方法（面板选择是 `ctx.layout.selectPanel(id)`），可选链把失败
 * 吞成 undefined：**点了没反应**，团队视图成了死端。就算修好，Panel 的 `scope` 初值
 * 写死 `'global'`，从团队会话进来也会回到全局库。
 *
 * 自证（mock loader，不依赖浏览器/宿主）：
 *  ① `entryNavForTeam` 纯函数：有团队 → 项目作用域 + 团队页；无团队 → 全局；
 *  ② `openWorkbench` 调 `ctx.layout.selectPanel('myteam')`，**不再**碰 `uiWorkspace.openPanel`；
 *  ③ 交接一次性：Panel 消费一次即清空（重复消费返回 null）；
 *  ④ 宿主缺 layout 服务 / `selectPanel` 抛错 → 返回 false 且不把异常抛给宿主、不留残余交接；
 *  ⑤ `resolveNavForSession` 按 sessionId 命中团队；命中不了 / 传输失败 → 回全局；
 *  ⑥ 源码静态：两个入口都走 `openWorkbench`，Panel 的初始作用域/团队/项目根来自交接。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

/** 最小 jsx-runtime（同 t13c/t66 口径）：返回可检查的元素树 */
const j = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
/** 最小 react shim：本文件只消费纯函数面，组件不渲染 */
const reactShim = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/** 加载 client.js（模拟宿主 Loader），返回 { module, source } */
function loadClient() {
  const slots = {
    inject: (name, registerFactory) => {
      const reg = registerFactory()
      return { name, ...reg }
    },
    register: (def, component) => ({ ...def, component }),
  }
  const modules = new Map([
    ['react/jsx-runtime', { jsx: j, jsxs: j }],
    ['react', reactShim],
  ])
  const ctx = {
    slots,
    locale: { bind: () => (k) => k, register: () => {} },
    effect: (fn) => fn(),
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
    createElement: () => ({ dataset: {}, set textContent(_v) {}, style: {} }),
    head: { appendChild: () => {} },
    documentElement: { style: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { module, source }
}

test('t87-1: entryNavForTeam —— 团队摘要 → 项目作用域 + 团队页（无团队回全局）', () => {
  const { module } = loadClient()
  const { entryNavForTeam } = module.__testEntry
  assert.deepEqual(entryNavForTeam({ teamId: 't1', workspaceRoot: 'D:/p' }), {
    scope: 'project',
    workspaceRoot: 'D:/p',
    teamId: 't1',
    projectTab: 'teams',
    teamTab: 'members',
  })
  /* 旧宿主 describe 不提供 workspaceRoot：仍落项目作用域，根由 Panel 的候选列表兜底 */
  assert.deepEqual(entryNavForTeam({ teamId: 't1' }), {
    scope: 'project',
    workspaceRoot: '',
    teamId: 't1',
    projectTab: 'teams',
    teamTab: 'members',
  })
  assert.deepEqual(entryNavForTeam(undefined), { scope: 'global' })
  assert.deepEqual(entryNavForTeam(null), { scope: 'global' })
  assert.deepEqual(entryNavForTeam({}), { scope: 'global' })
})

test('t87-2: openWorkbench —— 调宿主 ctx.layout.selectPanel，并交接一次性上下文', () => {
  const { module } = loadClient()
  const { openWorkbench, takePendingNav, PANEL_KEY } = module.__testEntry
  const calls = []
  const ctx = { get: (name) => (name === 'layout' ? { selectPanel: (id) => calls.push(id) } : undefined) }
  assert.equal(openWorkbench(ctx, { scope: 'project', teamId: 't1' }), true)
  assert.deepEqual(calls, [PANEL_KEY], '宿主面板选择 API = ctx.layout.selectPanel(panelKey)')
  assert.deepEqual(takePendingNav(), { scope: 'project', teamId: 't1' })
  assert.equal(takePendingNav(), null, '交接只消费一次')
})

test('t87-3: 没有 layout 服务 / selectPanel 抛错 —— 不崩、不留残余交接', () => {
  const { module } = loadClient()
  const { openWorkbench, takePendingNav } = module.__testEntry
  /* 老宿主 / 测试桩：没有 layout 服务 → 如实返回 false（入口不会假装打开） */
  assert.equal(openWorkbench({}, { scope: 'global' }), false)
  assert.equal(takePendingNav(), null, '没调到宿主 API 时不留残余交接')
  /* 面板未注册：selectPanel 抛错 → 吞掉并告警（插件跑在真实桌面，不能连坐整屏） */
  const boom = { get: () => ({ selectPanel: () => { throw new Error('main panel "myteam" is not registered') } }) }
  assert.equal(openWorkbench(boom, { scope: 'project', teamId: 't1' }), false)
  assert.equal(takePendingNav(), null, '失败也不留残余交接')
})

test('t87-4: resolveNavForSession —— 按 sessionId 命中团队；命中不了/传输失败回全局', async () => {
  const { module } = loadClient()
  const { resolveNavForSession } = module.__testEntry
  const connection = {
    rpc: {
      call: async () => ({
        ok: true,
        value: {
          status: 'ok',
          teams: [
            { sessionId: 's1', teamId: 't1', workspaceRoot: 'D:/p' },
            { sessionId: 's9', teamId: 't9', workspaceRoot: 'D:/other' },
          ],
        },
      }),
    },
  }
  assert.deepEqual(await resolveNavForSession(connection, 's1'), {
    scope: 'project',
    workspaceRoot: 'D:/p',
    teamId: 't1',
    projectTab: 'teams',
    teamTab: 'members',
  })
  assert.deepEqual(await resolveNavForSession(connection, 'nope'), { scope: 'global' }, '非队长会话回全局库')
  assert.deepEqual(await resolveNavForSession(undefined, 's1'), { scope: 'global' }, '没有 connection 不空转')
  assert.deepEqual(await resolveNavForSession({ rpc: { call: async () => { throw new Error('offline') } } }, 's1'), { scope: 'global' }, '传输失败回全局')
})

test('t87-5: 源码静态 —— 两个入口都走 openWorkbench，Panel 初值来自交接', () => {
  const { source } = loadClient()
  /* ① 宿主 API 纠正（注释里说明历史可以，**活代码**不得再调不存在的方法） */
  assert.ok(source.includes("ctx.get('layout')"), '面板选择走 ui-layout 服务')
  assert.ok(source.includes('layout.selectPanel(PANEL_KEY)'), 'selectPanel 用面板 key')
  assert.ok(!source.includes('workspace?.openPanel?.'), '不得再调宿主不存在的 uiWorkspace.openPanel')
  /* ② 两个入口都带上下文 */
  assert.ok(source.includes('openWorkbench(ctx, entryNavForTeam(team))'), '团队视图入口带本团队上下文')
  assert.ok(source.includes('openWorkbench(ctx, entryNav)'), 'composer chip 也走同一个入口')
  /* ③ Panel 初值来自交接 */
  assert.ok(source.includes('entryNavRef.current = { nav: takePendingNav() }'), 'Panel 挂载时消费交接')
  /* CHG-201：作用域由**挂载点**决定（全局页 / 项目页两个物理表面），不再由交接的 scope 决定 */
  assert.ok(source.includes("const scope = mode === 'project' ? 'project' : 'global'"), '作用域来自挂载点')
  assert.ok(source.includes('entryNav?.teamId ?? null'), '初始团队来自交接')
  assert.ok(source.includes('entryNav?.projectTab ?? \'tasks\''), '初始项目 tab 来自交接')
})
