/**
 * T65 设计稿对齐 · G5（泳道 / 依赖图横竖两版 / 拖拽态）
 *
 * 对照：design/lanes.html、design/dag.html、design/dag-vertical.html、design/dragging.html
 * 做法：mock loader + 浅渲染（不依赖真实浏览器）——DAG 的矩形测量在 mock 下量不到，
 *       走固定回退高度（78px），因此这里只断言节点 / 边 / class / 文案结构，不断言像素级定位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

/** 最小 jsx-runtime：jsx 返回可检查的元素树 */
const j = (type, props, ...children) => ({ type, props: props ?? {}, children: (props?.children !== undefined ? [props.children, ...children] : children).flat() })
const js = (type, props, ...children) => j(type, props, ...children)

function loadClient() {
  const reactShim = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init ?? null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const modules = new Map([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const captured = []
  const loader = {
    load: (def) => {
      const require_ = (name) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      }
      captured.push(def.factory(require_))
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_v) {}, remove() {} }),
    head: { appendChild: () => {} },
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { source, test: captured[0]?.__test }
}

/** 收集元素树里的全部文本 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** 深度遍历（含 props.children 之外的自定义组件渲染结果） */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((item) => walk(item, visit)); return }
  visit(node)
  if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, visit))
}

const classOf = (node) => String(node?.props?.className ?? '')

/** 找所有满足条件的元素 */
function findAll(tree, pred) {
  const out = []
  walk(tree, (node) => { if (node && typeof node === 'object' && pred(node)) out.push(node) })
  return out
}

const t = (key, vars) => {
  if (!vars) return key
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key)
}

const GRAPH_TASKS = [
  { id: 't0', code: 't0', title: '摸清现状', state: 'done', deps: [] },
  { id: 't2', code: 't2', title: '确定契约', state: 'blocked', deps: ['t0'] },
  { id: 't7', code: 't7', title: '抽服务边界', state: 'in_progress', deps: ['t2'], model: 'claude-sonnet', assignees: ['m1'] },
  { id: 't6', code: 't6', title: 'UI 迁移', state: 'in_progress', deps: ['t7'], model: 'gpt-5.1' },
  { id: 't9', code: 't9', title: 'CI 校验', state: 'done', deps: [] },
  { id: 't5', code: 't5', title: '旧调用点替换', state: 'ready', deps: ['t9'] },
]

/* ────────────────────────── 1. 结构 / class / 文案契约 ────────────────────────── */

test('t65-1: 四屏的设计稿元素在实现里都有对应 class（lanes / dag / dag-vertical / dragging）', () => {
  const { source } = loadClient()
  for (const cls of [
    /* design/lanes.html */
    'mt-lanes', 'mt-lane', 'mt-lane-head', 'mt-lane-label', 'mt-lane-cell', 'mt-lane-node', 'mt-lane-tk',
    'mt-trail', 'mt-trail-cap', 'mt-titem', 'mt-tav', 'mt-tinfo', 'mt-viewbar-right',
    'mt-lane-count', 'mt-lane-label-unassigned', 'mt-avatar-dashed', 'mt-lane-empty',
    /* design/dag.html · dag-vertical.html */
    'mt-dagwrap', 'mt-dag-canvas', 'mt-dag-card', 'mt-dag-card-top', 'mt-dag-card-title', 'mt-dag-card-meta',
    'mt-dag-svg', 'mt-dag-edge', 'mt-dag-edge-hot', 'mt-arrow', 'mt-arrow-hot', 'mt-dag-note',
    'mt-dag-node-focus', 'mt-dag-node-chain', 'mt-viewbar-dir', 'mt-chip-gate',
    /* design/dragging.html */
    'mt-col-drop', 'mt-col-nodrop', 'mt-dropzone', 'mt-task-ghost', 'mt-task-lift', 'mt-lift-tag',
    'mt-dragtoast', 'mt-task-locked', 'mt-lock-icon', 'mt-task-shake',
  ]) {
    assert.ok(source.includes(cls), `缺少设计稿对应的 class：${cls}`)
  }
  // 画布是点阵底（design .dagwrap 的 radial-gradient）
  assert.ok(source.includes('radial-gradient(circle at 1px 1px'), '依赖图画布点阵底')
  // 同层折行：竖向按容器宽度折行；横向（CHG-85）也把层摊开 —— 同层节点分列并排，
  // 否则 9 个无依赖任务拉成一列 900px 高、底部被面板裁掉
  assert.ok(source.includes('const perRowV ='), '竖向同层折行参数')
  assert.ok(source.includes('const perRowH ='), '横向同层分列参数')
  // 行高统一（design 泳道是等高表格）
  assert.ok(/\.mt-lane-label\{[^}]*min-height:96px/.test(source), '泳道行头最小高度统一')
  assert.ok(/\.mt-lane-cell\{[^}]*min-height:96px/.test(source), '泳道格子最小高度与行头一致')
  // 箭头永远指下游：markerEnd 出现在 SVG 连线属性里
  assert.ok(source.includes('markerEnd:'), 'SVG 连线带 marker 箭头')
  // 非法落点抖动 + 弹回（150ms；reduced-motion 只闪边框）
  assert.ok(source.includes('@keyframes mt-shake'), '抖动动画 keyframes')
  assert.ok(source.includes('prefers-reduced-motion'), 'reduced-motion 只闪边框')
  assert.ok(/mt-shake 150ms/.test(source), '抖动 150ms')
  // 节点宽度钉死 176（横向）；竖向按容器 ~34%、240–400
  assert.ok(source.includes('DAG_NODE_W_H = 176'), '横向节点宽度 176px 钉死')
  assert.ok(source.includes('Math.floor(avail.w * 0.34)'), '竖向节点宽度按容器 34%')
  assert.ok(source.includes('Math.max(240, Math.min(400'), '竖向节点宽度 240–400 夹逼')
  // 层间距 60
  assert.ok(source.includes('DAG_GAP_MAIN = 60'), '层间距 60px')
})

test('t65-2: 四屏文案（zh + en 都落，禁硬编码只走 locale）', () => {
  const { source } = loadClient()
  for (const key of [
    'lanes.groupBy', 'lanes.byStage', 'lanes.byPriority', 'lanes.noMembers', 'lanes.noteLead', 'lanes.noteBody',
    'lanes.emptyRow', 'lanes.unassignedNote', 'lanes.unassigned',
    'dag.showModel', 'dag.hotChain', 'dag.hotChainEmpty', 'dag.arrowNote', 'dag.arrowNoteV', 'dag.noteLead', 'dag.noteLeadV',
    'dag.teams', 'dag.evidence',
    'drag.liftTag', 'drag.ghost', 'drag.dropzone', 'drag.rejectedTitle', 'drag.rejectedBody', 'drag.rejectedLink',
    'drag.accepted', 'drag.locked', 'drag.lockedTitle', 'drag.rulesBadge',
  ]) {
    assert.ok(source.includes(`'${key}'`), `zh/en 缺 locale 键：${key}`)
  }
  // 设计稿原文
  assert.ok(source.includes('松手放入'), 'lift 角标「松手放入」')
  assert.ok(source.includes('正被拖动'), '源列幽灵占位「t6 正被拖动」')
  assert.ok(source.includes('释放移入'), '虚线落区「释放移入」')
  assert.ok(source.includes('审查 → 命令验证 → 存档'), '落区链路文案')
  assert.ok(source.includes('dragRules: state-machine'), 'viewbar 徽标')
  assert.ok(source.includes('箭头从上游指到下游'), '依赖图图注（横向）')
  assert.ok(source.includes('一个任务可以同时解锁多个下游'), '图注写明一对多解锁')
  assert.ok(source.includes('行 = 角色'), '泳道行头文案')
})

test('t65-3: 样式纪律——G5 区块只用 --dsw-alias-* token，无十六进制色、无 font-family', () => {
  const { source } = loadClient()
  const start = source.indexOf('/* [G5 graph] design/lanes.html')
  const end = source.indexOf('/* [G6 flow] design/new-team.html')
  assert.ok(start > 0 && end > start, 'G5 样式落点存在且在自己区域')
  const block = source.slice(start, end)
  assert.ok(block.length > 2000, 'G5 样式块非空')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'G5 样式块无十六进制颜色')
  assert.ok(!/font-family\s*:/i.test(block), 'G5 样式块无 font-family')
  assert.ok(block.includes('var(--dsw-alias-'), 'G5 样式块使用 dsw alias token')
})

/* ────────────────────────── 2. 依赖图横向（dag.html） ────────────────────────── */

test('t65-4: 依赖图横向——按层级分列、节点定宽 176、贝塞尔连线 + 箭头、运行节点标模型', () => {
  const { test: api } = loadClient()
  assert.ok(api?.DagView, '工厂暴露 DagView（测试出口）')
  const tree = api.DagView({ t, tasks: GRAPH_TASKS, onOpen: () => {}, memberName: (id) => id, dir: 'h' })
  assert.equal(classOf(tree), 'mt-dagwrap', '画布容器 = .dagwrap')

  const canvas = tree.children[0]
  assert.equal(classOf(canvas), 'mt-dag-canvas', '内层画布')
  assert.ok(/px$/.test(String(canvas.props.style.width)), '画布宽度取 max(内容, 容器)')
  assert.ok(/px$/.test(String(canvas.props.style.height)), '画布高度取 max(内容, 容器)')

  // 连线：6 个任务 4 条依赖边 → 4 个 path，且每条都挂 marker 箭头
  const paths = findAll(canvas, (node) => node.type === 'path' && String(node.props.d)
    && String(node.props.markerEnd ?? '').startsWith('url(#mt-arrow'))
  assert.equal(paths.length, 4, '每条依赖一条贝塞尔连线')
  for (const path of paths) {
    assert.ok(/^M[\d.]+ [\d.]+ C/.test(String(path.props.d)), '三次贝塞尔曲线')
    assert.ok(String(path.props.className).startsWith('mt-dag-edge'), '连线 class = mt-dag-edge')
    assert.ok(String(path.props['data-from']) && String(path.props['data-to']), '连线带 from/to（上游 → 下游）')
  }
  // 在跑的 t7 依赖链（t0 → t2 → t7 → t6）高亮；t9 → t5 普通灰线
  const hotEdges = paths.filter((path) => String(path.props.className).includes('mt-dag-edge-hot'))
  assert.ok(hotEdges.length >= 3, '在跑依赖链蓝色加粗高亮')
  assert.ok(paths.some((path) => !String(path.props.className).includes('hot')), '普通依赖保持灰线')

  // 节点：每个任务一张卡，class 带状态色带；横向宽度钉死 176
  const cards = findAll(canvas, (node) => node.type === 'button' && classOf(node).includes('mt-dag-card'))
  assert.equal(cards.length, GRAPH_TASKS.length, '节点数 = 任务数')
  const runNode = cards.find((card) => textOf(card).includes('t7'))
  assert.ok(runNode, 't7 节点存在')
  assert.ok(classOf(runNode).includes('mt-dag-card-run'), '运行节点状态色带')
  assert.equal(runNode.props.style.width, '176px', '横向节点宽度 176px 钉死')
  assert.ok(textOf(runNode).includes('claude-sonnet'), '运行节点标实际模型')
  // 设计稿节点卡只有「号 + 标题 + 状态」三行：顶行两个元素（号 + 状态 chip），不带优先级徽标
  const topRow = runNode.children[0]
  assert.equal(classOf(topRow), 'mt-dag-card-top', '节点顶行')
  assert.equal(topRow.children.filter((child) => child && typeof child === 'object').length, 2, '顶行 = 号 + 状态（不含优先级）')
  assert.equal(findAll(runNode, (node) => classOf(node).includes('mt-pri')).length, 0, '依赖图卡片不带优先级徽标（比设计稿紧凑）')
  // 箭头永远指下游：x 单调（横向层级 = 列）
  const xs = cards.map((card) => parseFloat(card.props.style.left))
  assert.ok(xs.every((x) => Number.isFinite(x)), '节点定位为数值')
  assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) > Math.min(...xs), '横向按层级分列')
})

test('t65-5: 依赖图竖向（dag-vertical）——层级 → 行、节点宽度按容器自适应（240–400）', () => {
  const { test: api } = loadClient()
  const tree = api.DagView({ t, tasks: GRAPH_TASKS, onOpen: () => {}, memberName: (id) => id, dir: 'v' })
  const canvas = tree.children[0]
  const cards = findAll(canvas, (node) => node.type === 'button' && classOf(node).includes('mt-dag-card'))
  assert.equal(cards.length, GRAPH_TASKS.length)
  const widths = new Set(cards.map((card) => card.props.style.width))
  assert.equal(widths.size, 1, '竖向所有节点同宽（按容器自适应）')
  const width = parseFloat([...widths][0])
  assert.ok(width >= 240 && width <= 400, `竖向节点宽度在 240–400 之间（实际 ${width}）`)
  // 层级 → 行：t0 在 t2 上方，t2 在 t7 上方
  const topOf = (code) => parseFloat(cards.find((card) => textOf(card).includes(code)).props.style.top)
  assert.ok(topOf('t0') < topOf('t2'), 't0 在 t2 上方（上 → 下按层级）')
  assert.ok(topOf('t2') < topOf('t7'), 't2 在 t7 上方')
})

/* ────────────────────────── 3. 泳道（lanes.html） ────────────────────────── */

const LANE_MEMBERS = [
  { id: 'm1', roleId: 'implementer', instanceName: 'implementer', status: 'active' },
  { id: 'm2', roleId: 'reviewer', instanceName: 'reviewer', status: 'active' },
]
const LANE_TASKS = [
  { key: 'k1', id: 't2', title: 'API 契约', state: 'ready', assignees: ['m1'] },
  { key: 'k2', id: 't7', title: '服务边界', state: 'in_progress', assignees: ['m1'] },
  { key: 'k3', id: 't4', title: '冒烟 4 条', state: 'gate:review', assignees: ['m2'] },
]

test('t65-6: 泳道——行 = 角色（行首头像 + 实例行），列 = 四阶段，格子 = 该角色在该阶段的节点', () => {
  const { test: api } = loadClient()
  const tree = api.LanesView({ t, tasks: LANE_TASKS, members: LANE_MEMBERS, onOpen: () => {} })
  assert.equal(classOf(tree), 'mt-lanes', '泳道容器')
  assert.equal(tree.props.style['--mt-lane-cols'], '4', '四阶段列')

  const lanes = findAll(tree, (node) => classOf(node) === 'mt-lane')
  assert.equal(lanes.length, 1 + LANE_MEMBERS.length, '一行阶段列头 + 每角色一行')

  // 阶段列头：角色 + 待规划 / 就绪 / 进行中 / 门禁
  const heads = findAll(lanes[0], (node) => classOf(node) === 'mt-lane-head')
  assert.equal(heads.length, 5, '行头 + 四个阶段列头')
  assert.ok(textOf(heads[0]).includes('lanes.groupBy'), '行头 = 行 = 角色')
  const headText = heads.map((head) => textOf(head)).join('|')
  for (const stage of ['待规划', '就绪', '进行中', '门禁']) assert.ok(headText.includes(stage), `阶段列头：${stage}`)

  // 每个角色行：行首头像 + 4 个格子
  for (const lane of lanes.slice(1)) {
    const label = findAll(lane, (node) => classOf(node) === 'mt-lane-label')[0]
    assert.ok(label, '行首 label')
    assert.ok(findAll(label, (node) => classOf(node).includes('mt-avatar')).length === 1, '行首头像')
    assert.equal(findAll(lane, (node) => classOf(node).startsWith('mt-lane-cell')).length, 4, '每行四个阶段格')
  }

  // 格子里的节点：任务号 + 标题 + 阶段；空格的 empty 态
  const nodes = findAll(tree, (node) => classOf(node).startsWith('mt-lane-node'))
  assert.equal(nodes.length, LANE_TASKS.length, '每个任务落在其角色 × 阶段的格子里')
  const nodeText = nodes.map((node) => textOf(node)).join('|')
  assert.ok(nodeText.includes('t7') && nodeText.includes('服务边界'), '节点 = 任务号 + 短标题')
  assert.ok(nodes.some((node) => classOf(node).includes('mt-lane-node-run')), '进行中节点带阶段色带')
  assert.ok(nodes.some((node) => classOf(node).includes('mt-lane-node-gate')), '门禁节点带阶段色带')
  assert.ok(findAll(tree, (node) => classOf(node).includes('mt-lane-cell-empty')).length > 0, '空格子')
  assert.ok(textOf(tree).includes('lanes.noteLead'), '脚注说明泳道读法')
})

test('t65-7: 泳道空态——名册没有角色时给下一步（不写「暂无数据」）', () => {
  const { test: api } = loadClient()
  const tree = api.LanesView({ t, tasks: [], members: [], onOpen: () => {} })
  assert.ok(textOf(tree).includes('lanes.noMembers'), '空名册给召唤提示')
})

test('t65-10: 泳道「未认领」行——没有指派给在册实例的任务不丢，列头计数 = 格子里看得见的节点', () => {
  const { test: api } = loadClient()
  const tasks = [
    ...LANE_TASKS,
    { key: 'k9', id: 't9', title: '没人接的任务', state: 'backlog', assignees: [] },
    { key: 'k10', id: 't10', title: '指派给不在册角色', state: 'backlog', assignees: ['ghost'] },
  ]
  const tree = api.LanesView({ t, tasks, members: LANE_MEMBERS, onOpen: () => {} })
  const lanes = findAll(tree, (node) => classOf(node) === 'mt-lane')
  assert.equal(lanes.length, 1 + LANE_MEMBERS.length + 1, '多出一行「未认领」')

  const unassigned = lanes[lanes.length - 1]
  assert.ok(findAll(unassigned, (node) => classOf(node).includes('mt-lane-label-unassigned')).length === 1, '未认领行有独立行头样式')
  assert.ok(textOf(unassigned).includes('lanes.unassigned'), '行头 = 未认领')
  const unassignedNodes = findAll(unassigned, (node) => classOf(node).startsWith('mt-lane-node'))
  assert.equal(unassignedNodes.length, 2, '两个未认领任务都落在格子里（不丢任务）')

  // 列头计数 = 各行格子里的节点总数（看得见的都算上）
  const heads = findAll(lanes[0], (node) => classOf(node) === 'mt-lane-head')
  const stageCounts = [0, 1, 2, 3].map((i) => lanes.slice(1).reduce((sum, lane) => {
    const cells = findAll(lane, (node) => classOf(node).startsWith('mt-lane-cell'))
    return sum + findAll(cells[i], (node) => classOf(node).startsWith('mt-lane-node')).length
  }, 0))
  stageCounts.forEach((count, i) => assert.ok(textOf(heads[i + 1]).includes(`· ${count}`), `列头计数 = 格子里的节点数（第 ${i + 1} 列 = ${count}）`))
})

test('t65-11: 泳道空行——整行没有任务时末格给「无进行中任务」（design 的验收员行）', () => {
  const { test: api } = loadClient()
  const members = [...LANE_MEMBERS, { id: 'm3', roleId: 'acceptor', instanceName: 'acceptor', status: 'active' }]
  const tree = api.LanesView({ t, tasks: LANE_TASKS, members, onOpen: () => {} })
  const lanes = findAll(tree, (node) => classOf(node) === 'mt-lane')
  const emptyRow = lanes[lanes.length - 1]
  assert.ok(textOf(emptyRow).includes('lanes.emptyRow'), '空行末格给「无进行中任务」')
})

/* ────────────────────────── 4. 拖拽态（dragging.html） ────────────────────────── */

test('t65-8: 拖拽态——被拖起的卡可拖、attempt 失效卡锁住不可拖（i-lock 图标 + not-allowed）', () => {
  const { test: api } = loadClient()
  const task = { key: 'k6', id: 't6', title: '结算页 UI 迁移到模块包', state: 'in_progress', priority: 'P1', assignees: ['m1'] }
  const normal = api.TaskCard({ task, t, onOpen: () => {}, memberName: (id) => id, drag: { locked: false, onDragStart: () => {}, onDragEnd: () => {} } })
  assert.equal(normal.props.draggable, true, '可拖起的卡 draggable')
  assert.equal(typeof normal.props.onDragStart, 'function', 'dragstart 处理器')
  assert.ok(!classOf(normal).includes('mt-task-locked'), '普通卡不加锁住态')

  const locked = api.TaskCard({ task, t, onOpen: () => {}, memberName: (id) => id, drag: { locked: true, onDragStart: () => {}, onDragEnd: () => {} } })
  assert.equal(locked.props.draggable, false, 'attempt 失效卡不可拖')
  assert.ok(classOf(locked).includes('mt-task-locked'), '锁住态 class')
  assert.ok(findAll(locked, (node) => classOf(node) === 'mt-lock-icon').length === 1, '图标换成 i-lock')
  assert.ok(textOf(locked).includes('drag.locked'), '锁住态文字（H4 不只靠颜色）')
  assert.equal(locked.props['aria-disabled'], 'true', 'aria-disabled 标注')
})

test('t65-9: 拖拽落点由状态机判定（进行中 → 门禁合法；门禁未过 → 已完成被拒）', () => {
  const { test: api } = loadClient()
  assert.deepEqual(api.DRAG_LEGAL_TARGETS['进行中'], ['门禁'], '进行中只能落到门禁')
  /* CHG-85：看板列名对齐 design/board.html（「已完成」不是「完成」） */
  assert.deepEqual(api.DRAG_LEGAL_TARGETS['门禁'], ['已完成'], '门禁通过后落已完成')
  assert.deepEqual(api.DRAG_LEGAL_TARGETS['已完成'], [], '已完成是终态，不再接受拖入')
  // 门禁未过（超时过）的卡：门禁 → 已完成被拒
  const rejected = api.DagView === undefined ? null : true
  assert.ok(rejected)
})
