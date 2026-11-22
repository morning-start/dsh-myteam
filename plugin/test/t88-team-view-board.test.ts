/**
 * T88 · CHG-115：团队视图「做实」——看板 / 流程 / 依赖图**同源换挂载点**。
 *
 * 背景（design-v2/README.md §五）：会话页不重复造面板。团队视图此前只有摘要 + 出口，
 * 看板本体只在面板里；本轮把看板抽成 `BoardView`（TaskCard + 列 + 拖拽/新建
 * 全部由 props 开关），面板与会话视图挂同一个组件：
 *  - 面板传 `drag` / `onAdd` → 可拖拽、可列内新建；
 *  - 会话视图不传 → **只读看板**（无拖拽、无列内新建），另两视图复用 LanesView / DagView。
 *
 * 自证（mock loader，不依赖浏览器/宿主）：
 *  ① 只读看板：6 列、卡在对应列、无 `.mt-col-add`、卡片不可拖；
 *  ② 传 onAdd 才出现列内新建；传 drag 才可拖拽（面板行为不回归）；
 *  ③ 会话视图源码：三视图切换 + 只读 TaskDetail 抽屉 + `rawTasks` 数据源；
 *  ④ `useConvBoard` 给三视图补的复合键与兜底数组；
 *  ⑤ 任务详情只读（readOnly: true），写操作仍只在面板里。
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
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { module, source, ctx }
}

function collectClasses(tree, out = new Set()) {
  if (!tree || typeof tree !== 'object') return out
  if (typeof tree.type === 'function') return collectClasses(tree.type(tree.props ?? {}), out)
  const props = tree.props ?? {}
  if (typeof props.className === 'string') for (const name of props.className.split(/\s+/)) if (name) out.add(name)
  for (const child of tree.children ?? []) collectClasses(child, out)
  return out
}
function collectText(tree, out = []) {
  if (tree === null || tree === undefined || tree === false) return out
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out }
  if (typeof tree !== 'object') return out
  if (typeof tree.type === 'function') return collectText(tree.type(tree.props ?? {}), out)
  for (const child of tree.children ?? []) collectText(child, out)
  return out
}
/** 渲染函数组件后按 className 找第一个节点（jsx 树里 type 可能是函数） */
function findNode(node, className) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.type === 'function') return findNode(node.type(node.props ?? {}), className)
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, className)
    if (hit) return hit
  }
  return null
}

const T = (k) => k
const TASKS = [
  { key: 't1/1', id: '1', code: '1', title: '结算页拆分', state: 'ready', priority: 'P0', assignees: ['m1'], deps: [], participants: [], evidenceCount: 0, escalateCount: 0 },
  { key: 't1/2', id: '2', code: '2', title: '回归测试', state: 'in_progress', priority: 'P1', assignees: ['m2'], deps: ['1'], participants: [], evidenceCount: 1, escalateCount: 0 },
  { key: 't1/3', id: '3', code: '3', title: '旧接口下线', state: 'done', priority: 'P2', assignees: ['m1'], deps: ['2'], participants: [], evidenceCount: 0, escalateCount: 0 },
]

test('t88-1: 只读看板 —— 6 列、卡在对应列、无列内新建、不可拖拽', () => {
  const { module } = loadClient()
  const BoardView = module.__testG6.BoardView
  assert.equal(typeof BoardView, 'function', 'BoardView 是可渲染组件')
  const tree = BoardView({ t: T, tasks: TASKS, memberName: (id) => id, teamName: () => 'Team' })
  const classes = collectClasses(tree)
  assert.ok(classes.has('mt-board'), '看板根')
  assert.ok(classes.has('mt-columns'), '列容器')
  assert.ok(classes.has('mt-task'), '任务卡')
  assert.ok(!classes.has('mt-col-add'), '只读视图不得渲染列内新建')
  /* 卡片的 draggable 只在传 drag 时有值 */
  const card = findNode(tree, 'mt-task')
  assert.ok(card, '至少一张任务卡')
  assert.equal(card.props.draggable, undefined, '只读视图卡片不可拖')
})

test('t88-2: 面板形态 —— 传 onAdd / drag 才启用新建与拖拽（面板行为不回归）', () => {
  const { module } = loadClient()
  const BoardView = module.__testG6.BoardView
  const added = []
  const tree = BoardView({
    t: T,
    tasks: TASKS,
    memberName: (id) => id,
    teamName: () => 'Team',
    onAdd: (col) => added.push(col),
    drag: {
      task: null,
      dragged: null,
      canDrop: () => true,
      liftCard: null,
      cardFor: () => ({ locked: false, shake: false }),
    },
  })
  const classes = collectClasses(tree)
  assert.ok(classes.has('mt-col-add'), '可写形态有列内新建')
  const add = findNode(tree, 'mt-col-add')
  add.props.onClick()
  assert.deepEqual(added, ['待规划'], '列内新建回调带列名')
  /* 有 drag 时卡片可拖 */
  const card = findNode(tree, 'mt-task')
  assert.equal(card.props.draggable, true, '可写形态卡片可拖') /* 只读时 drag 未定义 */
})

test('t88-3: 会话视图源码 —— 三视图同源 + 只读详情抽屉 + rawTasks 数据源', () => {
  const { source } = loadClient()
  assert.ok(source.includes('j(BoardView, { t, tasks: board.rawTasks'), '看板挂载点在会话视图')
  assert.ok(source.includes('j(LanesView, { t, tasks: board.rawTasks'), '流程视图复用 LanesView')
  assert.ok(source.includes('j(DagView, { t, tasks: board.rawTasks'), '依赖图复用 DagView')
  assert.ok(source.includes("t('g6.tasks.viewBoard')") && source.includes("t('g6.tasks.viewFlow')") && source.includes("t('g6.tasks.viewDag')"), '三视图切换条')
  assert.ok(source.includes('readOnly: true'), '任务详情在会话视图只读')
  /*
   * CHG-141（**判空回归锁**）：`rawTasks` 在数据未到达时是 `undefined`，
   * 旧实现直接 `tasks.filter(...)` → 整屏白（用户报的「依赖视图渲染有问题」根因）。
   * 两个视图（看板 / 泳道）都必须在入口归一成数组。
   */
  assert.ok(source.includes('const tasks = Array.isArray(rawTasks) ? rawTasks : []'), '看板/泳道必须判空 tasks（归一成数组）')
  assert.equal(source.split('const tasks = Array.isArray(rawTasks) ? rawTasks : []').length - 1, 2, 'BoardView 与 LanesView 都必须判空')
  assert.ok(source.includes("onClose: () => setOpenTaskId(null)"), '详情抽屉可关闭')
  /* 只读挂载：不传 drag / onAdd */
  assert.ok(!source.includes('j(BoardView, { t, tasks: board.rawTasks, memberName: memberNameOf, teamName: () => team.name || team.teamId, onOpen: (task) => setOpenTaskId(String(task.id)), drag:'), '会话视图不得传拖拽')
})

test('t88-4: useConvBoard 给三视图补复合键与兜底数组', () => {
  const { source } = loadClient()
  assert.ok(source.includes('rawTasks'), '看板三视图共用 rawTasks')
  assert.ok(source.includes('key: `${teamId}/${String(task.id)}`'), '复合键与面板任务页同构')
  assert.ok(source.includes('ownerTeamId: teamId'), 'ownerTeamId 兜底')
  assert.ok(source.includes('assignees: Array.isArray(task.assignees) ? task.assignees : task.assignee ? [task.assignee] : []'), 'assignees 兜底')
  assert.ok(source.includes('deps: Array.isArray(task.deps) ? task.deps : []'), 'deps 兜底')
})

test('t88-5: 视图条与看板都只用 token（无十六进制 / 无 font-family）', () => {
  const { source } = loadClient()
  for (const rule of ['.mt-conv-board', '.mt-viewlinks', '.mt-col']) {
    assert.ok(source.includes(`'${rule}`), `缺样式 ${rule}`)
  }
  /* 新增的三条规则不得写死颜色 */
  const added = source.split('\n').filter((line) => line.includes('.mt-conv-board'))
  assert.ok(added.length >= 3, '新增规则存在')
  for (const line of added) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(line), `样式不得写死颜色：${line.trim()}`)
    assert.ok(!/font-family/.test(line), '样式不得写 font-family')
  }
})
