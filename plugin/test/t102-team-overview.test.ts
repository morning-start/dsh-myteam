/**
 * T102 路 CHG-157：**团队总览卡**——对齐用户给的 AgentTeams 样例能力：
 *  ① 元信息行「N 名成员 · X/Y 已交付 · N 条消息」；
 *  ② 队长汇总行「已派发 N 项任务给 M 名成员 · K 人执行中」；
 *  ③ 「总进度」分段条（一格一任务，六桶着色）+ 图例计数；
 *  ④ 叙述行「t66、t95 等待前置，其余已开工」。
 *
 * 数据全部来自 getBoard（members.currentTaskId / tasks.state+deps+assignees / messageCount），
 * 不新增服务端读取；messageCount 由 views.ts 的 messageCountOf 按 seq 去重（perTaskMessages ∪ inbox）。
 *
 * 自证（mock loader）：
 *  - 分桶矩阵：done/run（含 gate:*、re-scoping、running）/stuck/waiting（优先于 assigned）/assigned/idle；
 *  - 在跑人数：名册带 currentTaskId 按人数；离线名册（无字段）退回进行中任务数——不编 0 也不编人名；
 *  - 叙述行：等待前置点名列前三（>3 折叠成「等 N 项」）、尾巴按 idle 分流、全交付/待认领/全开工；
 *  - 渲染：格子数 = 任务数、图例六项、meta/lead 文案、未加载不渲染；
 *  - 服务端：messageCountOf 按 seq 去重（同一条 to=inbox 且带 taskId 的消息只记一次）。
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
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn, useMemo: (fn) => fn(), useSyncExternalStore: (_sub, get) => get(),
}

function loadClient() {
  const modules = new Map([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  let module
  const loader = {
    load: (def) => {
      module = def.factory((name) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      })
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_v) {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { toggleAttribute: () => {}, style: { setProperty: () => {} } },
    documentElement: { dataset: {} },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  const source = readFileSync(clientPath, 'utf8')
  new Function('window', 'document', source)({ __ModuleLoader__: loader }, documentObj)
  return { module, source }
}

const { module, source } = loadClient()
const { TeamOverviewCard, teamOverviewOf, ovBucketOf, ovNarrativeText } = module.__testG6

const zh = (key) => ({
  'ov.members': '{n} 名成员', 'ov.doneScore': '已交付 {x}/{y}', 'ov.messages': '{n} 条消息',
  'ov.progress': '总进度', 'ov.lead': '已派发 {n} 项任务给 {m} 名成员 · {k} 人执行中', 'ov.leadEmpty': '尚未派发任务',
  'ov.legend.done': '已交付', 'ov.legend.run': '进行中', 'ov.legend.assigned': '已认领',
  'ov.legend.waiting': '等待依赖', 'ov.legend.stuck': '未完成', 'ov.legend.idle': '未认领',
  'ov.waiting': '{codes} 等待前置', 'ov.waitingMore': '{codes} 等 {n} 项等待前置',
  'ov.waitingTailRun': '，其余已开工', 'ov.waitingTailIdle': '，{n} 项待认领',
  'ov.allRunning': '全部已开工', 'ov.allDone': '全部已交付', 'ov.idleNote': '全部可开工 · {n} 项待认领',
}[key] ?? key)

test('T102 ① 分桶矩阵：六桶各归其位，waiting 压过 assigned', () => {
  const done = new Set(['d1'])
  const mk = (id, state, over = {}) => ({ id, state, deps: [], assignees: [], ...over })
  assert.equal(ovBucketOf(mk('a', 'done'), done), 'done')
  for (const state of ['in_progress', 're-scoping', 'running', 'gate:review', 'gate:archive']) {
    assert.equal(ovBucketOf(mk('a', state), done), 'run', `${state} 应归进行中`)
  }
  for (const state of ['failed', 'blocked', 'cancelled']) {
    assert.equal(ovBucketOf(mk('a', state), done), 'stuck', `${state} 应归未完成`)
  }
  /* 有未完成上游 → waiting（哪怕已指派）；上游全 done → assigned */
  assert.equal(ovBucketOf(mk('a', 'ready', { deps: ['d1'], assignees: ['m1'] }), done), 'assigned')
  assert.equal(ovBucketOf(mk('a', 'ready', { deps: ['d1', 'x9'], assignees: ['m1'] }), done), 'waiting')
  assert.equal(ovBucketOf(mk('a', 'backlog', { deps: [] }), done), 'idle')
})

test('T102 ② 在跑人数：名册带 currentTaskId 按人数；离线名册退回进行中任务数', () => {
  const tasks = [
    { id: 't1', state: 'in_progress', deps: [], assignees: [] },
    { id: 't2', state: 'done', deps: [], assignees: [] },
  ]
  const online = teamOverviewOf(tasks, [
    { id: 'm1', currentTaskId: 't1' },
    { id: 'm2', currentTaskId: undefined },
  ], 3)
  assert.equal(online.liveCount, 1, '1 人有 currentTaskId = 1 人执行中')
  assert.equal(online.messageCount, 3)
  assert.equal(online.doneCount, 1)
  assert.equal(online.memberCount, 2)
  const offline = teamOverviewOf(tasks, [{ id: 'm1' }, { id: 'm2' }], null)
  assert.equal(offline.liveCount, 0, '名册在但没人持有任务 = 如实的 0（不退回任务数编人）')
  assert.equal(offline.messageCount, null, '旧宿主没有 messageCount → null（显示 —），不编 0')
  const noRoster = teamOverviewOf(tasks, [], null)
  assert.equal(noRoster.liveCount, 1, '名册为空 → 退回进行中任务数（没有成员数据时的唯一如实口径）')
  assert.equal(teamOverviewOf(undefined, undefined, undefined).total, 0, '空入参不抛')
})

test('T102 ③ 叙述行：等待前置点名列前三，尾巴按待认领分流；全交付/待认领/全开工', () => {
  const mk = (id, state, over = {}) => ({ id, code: id, state, deps: [], assignees: [], ...over })
  const done = ['d1', 'd2', 'd3', 'd4'].map((id) => mk(id, 'done'))
  /* 5 项等待前置：点前 3 个 code + 「等 5 项」 */
  const waiting5 = ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => mk(id, 'ready', { deps: ['x9'] }))
  const o5 = teamOverviewOf([...done, ...waiting5], [], null)
  assert.match(ovNarrativeText(o5, zh), /w1、w2、w3 等 5 项等待前置/, '点前三 + 折叠计数')
  /* 2 项等待 + 有待认领：尾巴报待认领，不谎称「其余已开工」 */
  const idle2 = ['i1', 'i2'].map((id) => mk(id, 'backlog'))
  const o2 = teamOverviewOf([...done, ...waiting5.slice(0, 2), ...idle2], [], null)
  assert.match(ovNarrativeText(o2, zh), /w1、w2 等待前置，2 项待认领/)
  /* 全部 done → 全部已交付 */
  assert.equal(ovNarrativeText(teamOverviewOf(done, [], null), zh), '全部已交付')
  /* 无等待、有待认领 → 待认领口径 */
  assert.match(ovNarrativeText(teamOverviewOf([...done, ...idle2], [], null), zh), /全部可开工 · 2 项待认领/)
  /* 无等待无待认领 → 全部已开工 */
  const running = [mk('r1', 'in_progress', { assignees: ['m1'] })]
  assert.equal(ovNarrativeText(teamOverviewOf([...done, ...running], [], null), zh), '全部已开工')
  /* 空团队 → 不显示叙述行 */
  assert.equal(ovNarrativeText(teamOverviewOf([], [], null), zh), null)
})

test('T102 ④ 渲染：格子数 = 任务数、图例六项、meta/lead 文案、未加载不渲染', () => {
  const tasks = [
    { id: 't1', code: 't1', state: 'done', deps: [], assignees: [] },
    { id: 't2', code: 't2', state: 'in_progress', deps: [], assignees: ['m1'] },
    { id: 't3', code: 't3', state: 'ready', deps: ['t9'], assignees: ['m1'] },
    { id: 't4', code: 't4', state: 'ready', deps: [], assignees: [] },
  ]
  const tree = TeamOverviewCard({ t: zh, tasks, members: [{ id: 'm1', currentTaskId: 't2' }, { id: 'm2' }], messageCount: 7, loaded: true })
  assert.equal(tree.props.className, 'mt-ov')
  const json = JSON.stringify(tree)
  assert.match(json, /2 名成员 · 已交付 1\/4 · 7 条消息/, '元信息行：成员/完成分数/消息')
  assert.match(json, /已派发 4 项任务给 2 名成员 · 1 人执行中/, '队长汇总行')
  assert.match(json, /t3 等待前置，1 项待认领/, '叙述行')
  const bar = tree.children.find((child) => child?.props?.className === 'mt-ov-progress')
  const segbar = bar.children.find((child) => child?.props?.className === 'mt-segbar mt-ovbar')
  assert.equal(segbar.children.filter(Boolean).length, 4, '一格一任务')
  assert.ok(segbar.children.every((cell) => /mt-ov-seg-(done|run|assigned|waiting|stuck|idle)/.test(cell.props.className)), '格子必须带桶配色类')
  const legend = tree.children.find((child) => child?.props?.className === 'mt-ov-legend')
  assert.equal(legend.children.length, 6, '图例六桶（含 0 计数，0 是真实值）')
  assert.equal(TeamOverviewCard({ t: zh, tasks, members: [], messageCount: null, loaded: false }), null, '未加载不渲染')
})

test('T102 ⑤ 挂载与文案：总览卡挂在会话视图，zh/en 键齐全', () => {
  assert.match(source, /j\(TeamOverviewCard, \{ t, tasks: board\.rawTasks, members: board\.members, messageCount: board\.messageCount, loaded: board\.loaded \}\)/, '必须挂在会话视图')
  assert.match(source, /messageCount: typeof data\?\.board\?\.messageCount === 'number'/, 'useConvBoard 必须透传 messageCount（旧宿主 → null）')
  const zhBlock = source.slice(source.indexOf('Object.assign(zh, {'), source.indexOf('Object.assign(en, {'))
  const enBlock = source.slice(source.indexOf('Object.assign(en, {'))
  for (const key of ['ov.members', 'ov.doneScore', 'ov.messages', 'ov.progress', 'ov.lead', 'ov.leadEmpty',
    'ov.legend.done', 'ov.legend.run', 'ov.legend.assigned', 'ov.legend.waiting', 'ov.legend.stuck', 'ov.legend.idle',
    'ov.waiting', 'ov.waitingMore', 'ov.waitingTailRun', 'ov.waitingTailIdle', 'ov.allRunning', 'ov.allDone', 'ov.idleNote']) {
    assert.ok(zhBlock.includes(`'${key}'`), `zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}'`), `en 缺 ${key}`)
  }
  /* 服务端：messageCount 进 BoardView + 缓存命中回填（消息事件只动 inbox/perTaskMessages，不回填就是旧数） */
  const viewsSource = readFileSync(join(here, '..', 'src', 'remote', 'views.ts'), 'utf8')
  assert.match(viewsSource, /messageCount: number/, 'BoardView 接口必须有 messageCount')
  assert.match(viewsSource, /entry\.view\.messageCount = messageCountOf\(proj\)/, '缓存命中必须回填 messageCount')
  assert.match(viewsSource, /messageCount: messageCountOf\(proj\)/, '看板构建必须写入 messageCount')
})
