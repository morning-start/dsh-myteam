/**
 * T91 · CHG-118：设置页配置编辑（FR-14.3 / docs/18 §7）。
 *
 * 覆盖「表单可编辑 + JSON 源视图 + 保存/恢复默认入口 + 两段确认 + 旧宿主降级」：
 *  ① 在线团队：四个常用字段渲染成**可编辑**控件（input 有 onChange、toggle 有 onClick）；
 *  ② 无改动时「保存配置」禁用（`dirty` 才可点）；
 *  ③ JSON 源视图是可编辑 textarea（不是只读 pre），带「应用源视图」；
 *  ④ 源码断言：保存走 `saveTeamConfig({teamId, config})`、`confirm-required` → 确认后带 `confirm:true`、
 *     恢复默认走 `resetTeamConfig({confirm:true})`、旧宿主缺端点 → 明确提示（不假装成功）、
 *     保存成功回写 `onSaved`（面板据此刷新生效配置与看板）；
 *  ⑤ 离线团队：控件只读（`disabled`），不产生写请求；
 *  ⑥ 文案 zh/en 成对（新增 20 个键不得只加一边）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')
const source = readFileSync(clientPath, 'utf8')

const j = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
const js = (type, props, ...children) => j(type, props, ...children)
const reactShim = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

function loadClient() {
  const slots = {
    inject: (name, registerFactory) => ({ name, ...registerFactory() }),
    register: (def, component) => ({ ...def, component }),
  }
  const modules = new Map([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const ctx = { slots, locale: { bind: () => (k) => k, register: () => {} }, effect: (fn) => fn() }
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
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return module
}

/** 深度找所有满足条件的元素（函数组件先渲染） */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function') return findAll(node.type(node.props ?? {}), predicate, out)
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}
const byTestId = (tree, id) => findAll(tree, (node) => node.props?.['data-testid'] === id)[0]
const byLabel = (tree, label) => findAll(tree, (node) => node.props?.['aria-label'] === label)

const T = (k) => k
const CONFIG = {
  status: 'ok',
  source: 'default',
  chain: [],
  warnings: [],
  config: {
    board: { columns: ['backlog', 'ready', 'running', 'gates', 'done'] },
    limits: { maxMembers: 6, memberMaxDepth: 0, maxTasks: 20 },
    gates: { enabled: true, commandTimeoutMs: 120000 },
    memory: { evidenceRequired: true },
  },
}
const team = (online) => ({ teamId: 't1', sessionId: 's1', online, members: [], counts: { tasks: 2, done: 1 } })
const connection = () => ({ rpc: { call: async () => ({ ok: true, value: { status: 'ok' } }) } })

function renderSettings({ online = true, cfg = CONFIG } = {}) {
  const module = loadClient()
  const SettingsTab = module.__testG3?.SettingsTab ?? module.__testG89?.SettingsTab
  assert.equal(typeof SettingsTab, 'function', 'SettingsTab 必须可渲染')
  const tree = SettingsTab({ t: T, config: cfg, offline: !online, team: team(online), connection: connection() })
  return tree
}

test('t91-1: 在线团队 —— 常用字段是可编辑控件，无改动时保存禁用', () => {
  const tree = renderSettings()
  /* 团队规模（数字输入）可编辑 */
  const size = byLabel(tree, 'settings.teamSize')[0]
  assert.ok(size, '团队规模输入框存在')
  assert.equal(size.props.disabled, false, '在线团队可编辑')
  assert.equal(typeof size.props.onChange, 'function', '必须带 onChange')
  size.props.onChange({ target: { value: '4' } })
  size.props.onChange({ target: { value: '' } })
  /* 门禁开关可点 */
  const gates = byLabel(tree, 'settings.gates').find((node) => node.type === 'button')
  assert.ok(gates, '门禁开关存在')
  assert.equal(gates.props.disabled, false)
  assert.equal(typeof gates.props.onClick, 'function')
  gates.props.onClick()
  /* 记忆证据开关 */
  const evidence = byLabel(tree, 'settings.evidenceLabel').find((node) => node.type === 'button')
  assert.equal(typeof evidence?.props?.onClick, 'function')
  /* CHG-173（FR-1.3）：任务来源（DAG）开关——captain/template */
  const planning = byLabel(tree, 'settings.taskPlanning').find((node) => node.type === 'button')
  assert.ok(planning, '任务来源开关存在')
  assert.equal(typeof planning.props.onClick, 'function')
  assert.equal(planning.props['aria-checked'], false, '默认 captain（aria-checked=false）')
  /* 无改动：保存按钮 disabled */
  const save = byTestId(tree, 'settings-save')
  assert.ok(save, '保存按钮存在')
  assert.equal(save.props.disabled, true, '没有改动时不允许保存')
})

test('t91-2: 离线团队 —— 控件只读，不产生写请求', () => {
  const tree = renderSettings({ online: false })
  const size = byLabel(tree, 'settings.teamSize')[0]
  assert.equal(size.props.disabled, true, '离线团队只读')
  const save = byTestId(tree, 'settings-save')
  assert.equal(save.props.disabled, true)
  const reset = byTestId(tree, 'settings-reset')
  assert.equal(reset.props.disabled, true)
})

test('t91-3: JSON 源视图可编辑 —— textarea + 应用按钮（不是只读 pre）', () => {
  const module = loadClient()
  const SettingsTab = module.__testG89.SettingsTab
  /* 直接渲染带 showJson 的路径：先点 JSON 按钮再取树（state 是 noop，改用源码断言 + 渲染首屏） */
  const tree = SettingsTab({ t: T, config: CONFIG, offline: false, team: team(true), connection: connection() })
  const jsonBtn = findAll(tree, (node) => node.props?.['aria-pressed'] !== undefined && node.type === 'button')
  assert.ok(jsonBtn.length > 0, 'JSON 源视图切换按钮存在')
  /* 源码：源视图是 textarea（可编辑）且带应用按钮 */
  assert.ok(source.includes("j('textarea', {\n            className: 'mt-json'"), '源视图必须是可编辑 textarea')
  assert.ok(source.includes("t('settings.jsonApply')"), '应用源视图按钮')
  assert.ok(source.includes('textarea.mt-json{'), 'textarea 样式存在')
})

test('t91-4: 源码契约 —— 保存 / 两段确认 / 恢复默认 / 旧宿主降级 / onSaved 回写', () => {
  assert.ok(source.includes('api.saveTeamConfig({ teamId: team.teamId, config: draft'), '保存带团队与草稿')
  assert.ok(source.includes("...(confirm ? { confirm: true } : {})"), '第二段带 confirm:true')
  assert.ok(source.includes("r?.status === 'confirm-required'"), '两段确认分支')
  assert.ok(source.includes('pendingSave'), '影响面暂停态')
  assert.ok(source.includes('api.resetTeamConfig({ teamId: team.teamId, confirm: true })'), '恢复默认两段确认')
  assert.ok(source.includes("typeof api.saveTeamConfig !== 'function'"), '旧宿主缺端点 → 明确提示（不假装成功）')
  assert.ok(source.includes("t('settings.unavailable')"), '降级文案')
  assert.ok(source.includes('onSaved?.(view'), '保存后回写生效视图')
  assert.ok(source.includes('onSaved: (view) => {'), '面板接线 onSaved')
  assert.ok(source.includes('setBoard(undefined)'), '配置变更后重拉看板')
})

test('t91-5: 新增文案 zh/en 成对（20 个键不得只加一边）', () => {
  const keys = [
    'settings.editHint', 'settings.formTitle', 'settings.formNote', 'settings.save', 'settings.saved',
    'settings.saveFailed', 'settings.jsonApply', 'settings.jsonInvalid', 'settings.jsonNote', 'settings.dirty',
    'settings.confirmSave', 'settings.confirmSaveBody', 'settings.impactMembers', 'settings.impactTasks',
    'settings.resetBtn', 'settings.resetConfirm', 'settings.resetConfirmBody', 'settings.resetDone', 'settings.unavailable',
    'settings.jsonView',
  ]
  for (const key of keys) {
    const hits = source.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh/en 各一条（实际 ${hits}）`)
  }
})

test('t91-6: R41-③ —— 内置工具隐藏显示「实际生效」，假开关禁回潮', () => {
  /* ① 源码契约：旧假开关（永远关闭且禁用的 toggle）不得回潮 + 新四态文案 zh/en 成对 */
  assert.ok(!source.includes("[toggle(false, t('settings.hideTools'))]"), '假开关不得回潮')
  assert.ok(source.includes('config.runtime?.builtinToolsHide'), '设置页读外层载荷的 runtime.builtinToolsHide（cfg 是内层 team config）')
  for (const key of ['settings.hideToolsEff', 'settings.hideToolsOff', 'settings.hideToolsNoRestrict', 'settings.hideToolsList']) {
    const hits = source.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh/en 各一条（实际 ${hits}）`)
  }
  assert.ok(source.includes('.mt-hideeff-warn'), '未生效警示走 token 类（零硬编码色值）')
  assert.ok(!source.includes('原始调用记录'), '旧错误语义文案不得回潮（隐藏的是宿主内置工具，不是调用记录）')
  /* ② 行为：生效态显示 n/total + deny 清单 */
  const withRuntime = renderSettings({ cfg: { ...CONFIG, runtime: { builtinToolsHide: { enabled: true, restricted: true, configured: ['a', 'b'], effective: ['a'] } } } })
  assert.ok(findAll(withRuntime, (n) => n.props?.children === 'settings.hideToolsEff').length > 0, '生效态显示计数')
  assert.ok(findAll(withRuntime, (n) => n.props?.children === 'settings.hideToolsList').length > 0, '生效态显示实际 deny 清单')
  /* restricted=false：明说「隐藏未执行」（不假装生效） */
  const noRestrict = renderSettings({ cfg: { ...CONFIG, runtime: { builtinToolsHide: { enabled: true, restricted: false, configured: ['a'], effective: [] } } } })
  assert.ok(findAll(noRestrict, (n) => n.props?.children === 'settings.hideToolsNoRestrict').length > 0, '无 restrict 明说未执行')
  /* enabled=false：明说未启用 */
  const off = renderSettings({ cfg: { ...CONFIG, runtime: { builtinToolsHide: { enabled: false, restricted: false, configured: ['a'], effective: [] } } } })
  assert.ok(findAll(off, (n) => n.props?.children === 'settings.hideToolsOff').length > 0, '关闭态明说未启用')
  /* 无 runtime（离线/旧宿主）：显示「—」不编 0 */
  assert.ok(findAll(renderSettings(), (n) => n.props?.children === '—').length > 0, '未知显示 — 不编 0')
})
