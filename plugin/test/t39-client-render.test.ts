/**
 * t39：客户端九栏 + 左栏五栏的**真实渲染**冒烟。
 *
 * 为什么需要它：t30 只证明「模块能加载、注册了三个落点」，任何一屏在渲染期抛错
 * （少一个字段、空数组上取下标、形状变了）它都发现不了——而这类错误在宿主里
 * 表现为「整块面板空白」，最难从日志倒推。
 *
 * 做法：用一个 60 行的最小 React（createElement 直接调用函数组件、useState
 * 保留槽位并触发重渲染、useEffect 只跑一次），配一份假的 `fetch` 按方法名回
 * 固定数据，然后把每个 tab 依次点开、断言渲染出了预期文案。
 *
 * 它是**冒烟**不是快照：只断言「渲染成功 + 关键文案出现」，不锁 DOM 结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

type AnyComponent = (props: Record<string, unknown>) => unknown
type ElementLike = { type: unknown; props: Record<string, unknown>; children: unknown[] }

let dirty = false
let currentComponent: AnyComponent | null = null
let hookCursor = 0
const instances = new WeakMap<AnyComponent, { slots: unknown[]; refs: unknown[]; effects: Set<number>; effectDeps: Map<number, unknown[]> }>()

function instanceOf(component: AnyComponent): { slots: unknown[]; refs: unknown[]; effects: Set<number>; effectDeps: Map<number, unknown[]> } {
  const existing = instances.get(component)
  if (existing !== undefined) return existing
  const created = { slots: [], refs: [], effects: new Set<number>(), effectDeps: new Map<number, unknown[]>() }
  instances.set(component, created)
  return created
}

function nextSlot(): number {
  const index = hookCursor
  hookCursor += 1
  return index
}

/** 依赖数组的浅比较（React 的默认语义）。 */
function sameDeps(left: unknown[], right: unknown[] | undefined): boolean {
  if (right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((item, index) => Object.is(item, right[index]))
}

function invoke(component: AnyComponent, props: Record<string, unknown>): unknown {
  const savedComponent = currentComponent
  const savedCursor = hookCursor
  currentComponent = component
  hookCursor = 0
  try {
    return component(props)
  } finally {
    currentComponent = savedComponent
    hookCursor = savedCursor
  }
}

const React = {
  createElement(type: unknown, props: unknown, ...kids: unknown[]): unknown {
    const merged: Record<string, unknown> = { ...((props ?? {}) as Record<string, unknown>) }
    if (kids.length === 1) merged.children = kids[0]
    else if (kids.length > 1) merged.children = kids
    if (typeof type === 'function') return invoke(type as AnyComponent, merged)
    const element: ElementLike = { type, props: merged, children: kids }
    return element
  },
  Fragment: 'fragment',
  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const instance = instanceOf(currentComponent as AnyComponent)
    const index = nextSlot()
    if (!(index in instance.slots)) {
      instance.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    }
    const set = (next: unknown): void => {
      const value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(instance.slots[index]) : next
      if (Object.is(value, instance.slots[index])) return
      instance.slots[index] = value
      dirty = true
    }
    return [instance.slots[index], set]
  },
  useEffect(run: () => unknown, deps?: unknown[]): void {
    const instance = instanceOf(currentComponent as AnyComponent)
    const index = nextSlot()
    const previous = instance.effectDeps.get(index)
    const ran = instance.effects.has(index)
    if (ran && sameDeps(previous ?? [], deps)) return
    if (ran && previous === undefined && deps === undefined) return
    instance.effects.add(index)
    instance.effectDeps.set(index, deps === undefined ? [] : [...deps])
    run()
  },
  useCallback(fn: unknown, deps?: unknown[]): unknown {
    const instance = instanceOf(currentComponent as AnyComponent)
    const index = nextSlot()
    const stored = instance.refs[index] as { deps: unknown[]; value: unknown } | undefined
    if (stored !== undefined && sameDeps(stored.deps, deps)) return stored.value
    instance.refs[index] = { deps: deps === undefined ? [] : [...deps], value: fn }
    return fn
  },
  useMemo(fn: () => unknown, deps?: unknown[]): unknown {
    const instance = instanceOf(currentComponent as AnyComponent)
    const index = nextSlot()
    const stored = instance.refs[index] as { deps: unknown[]; value: unknown } | undefined
    if (stored !== undefined && sameDeps(stored.deps, deps)) return stored.value
    const value = fn()
    instance.refs[index] = { deps: deps === undefined ? [] : [...deps], value }
    return value
  },
  useRef(initial: unknown): { current: unknown } {
    const instance = instanceOf(currentComponent as AnyComponent)
    const index = nextSlot()
    if (!(index in instance.refs)) instance.refs[index] = { current: initial }
    return instance.refs[index] as { current: unknown }
  },
}

/** 反复渲染直到没有 setState 再触发（最多 40 轮，防跑飞）。 */
async function mount(component: AnyComponent, props: Record<string, unknown>): Promise<unknown> {
  let tree: unknown
  for (let round = 0; round < 40; round += 1) {
    dirty = false
    tree = invoke(component, props)
    // 让 effect 里发出的 fetch 落地；它若 setState 会把 dirty 再置回 true。
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) break
  }
  return tree
}

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const element = node as ElementLike
  if (element.props !== undefined) collectText(element.props.children, out)
  if (element.children !== undefined) collectText(element.children, out)
  return out
}

function textOf(node: unknown): string {
  return collectText(node).join('')
}

/** 在渲染树里找 `role="tab"` 且文本含 label 的按钮。 */
function findTab(node: unknown, label: string): ElementLike | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTab(item, label)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as ElementLike
  if (element.props?.role === 'tab' && textOf(element.children.length > 0 ? element.children : element.props.children).includes(label)) {
    return element
  }
  return findTab(element.children ?? element.props?.children ?? null, label)
}

/** 在渲染树里找文本含 label 的按钮（不限 role=tab）。 */
function findButton(node: unknown, label: string): ElementLike | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButton(item, label)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as ElementLike
  if (element.type === 'button' && textOf(element.children ?? element.props.children).includes(label)) return element
  return findButton(element.children ?? element.props.children ?? null, label)
}

/** 按 placeholder 找输入框。 */
function findByPlaceholder(node: unknown, placeholder: string): ElementLike | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByPlaceholder(item, placeholder)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as ElementLike
  if (element.props?.placeholder === placeholder) return element
  return findByPlaceholder(element.children ?? element.props?.children ?? null, placeholder)
}

/** 数一数渲染树里 match 到的节点（断言「同一份共用件被复用了几次」用）。 */
function countNodes(node: unknown, match: (element: ElementLike) => boolean): number {
  if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + countNodes(item, match), 0)
  if (node === null || typeof node !== 'object') return 0
  const element = node as ElementLike
  const self = match(element) ? 1 : 0
  return self + countNodes(element.children ?? element.props?.children ?? null, match)
}

/** 按 className 包含某个片段找元素（找「可点开的列表行」这类没有 role 的节点用）。 */
function findByClass(node: unknown, fragment: string): ElementLike | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByClass(item, fragment)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const element = node as ElementLike
  if (String(element.props?.className ?? '').includes(fragment)) return element
  return findByClass(element.children ?? element.props?.children ?? null, fragment)
}

interface Harness {
  view: AnyComponent
  panel: AnyComponent
  calls: string[]
  writes: string[]
  writeBody: Record<string, unknown> | null
  restore: () => void
}

/** 加载客户端，注入假 fetch，返回两个入口组件。 */
function loadClient(data: Record<string, unknown>): Harness {
  const code = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')
  let captured: { id: string; factory: (require: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null
  const fakeWindow = { __ModuleLoader__: { load: (value: unknown) => { captured = value as typeof captured } } }
  const fakeDocument = {
    baseURI: 'http://127.0.0.1:4399/',
    createElement: () => ({ dataset: {}, remove: () => undefined }),
    head: { appendChild: () => undefined },
  }
  new Function('window', 'document', code)(fakeWindow, fakeDocument)
  assert.ok(captured !== null, '客户端应调用 __ModuleLoader__.load')

  const exported = captured!.factory((name: string) => (name === 'react' ? React : {}))
  const registrations: { options: { name: string }; Component: AnyComponent }[] = []
  exported.apply({
    effect: (fn: () => unknown) => {
      fn()
      return () => undefined
    },
    slots: {
      inject: (_name: string, callback: () => void) => {
        callback()
        return () => undefined
      },
      register: (options: { name: string }, Component: AnyComponent) => {
        registrations.push({ options, Component })
        return () => undefined
      },
    },
    layout: { selectPanel: () => undefined },
  })

  const view = registrations.find((entry) => entry.options.name === 'conversation.view')?.Component
  const panel = registrations.find((entry) => entry.options.name === 'main')?.Component
  assert.ok(view !== undefined, '缺会话「团队视图」组件')
  assert.ok(panel !== undefined, '缺左栏 main 面板组件')

  const calls: string[] = []
  const writes: string[] = []
  let writeBody: Record<string, unknown> | null = null
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    const method = url.slice(url.lastIndexOf('__myteam/') + '__myteam/'.length).split('?')[0] ?? ''
    if (method.startsWith('write/')) {
      const name = method.slice('write/'.length)
      writes.push(name)
      writeBody = init?.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>)
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            data: {
              method: name,
              operationId: 'op_1',
              summary: `预览 ${name}：影响 1 名成员`,
              impact: { members: ['member_1'], activeAttempts: [], unfinishedTasks: [], unsettledEffects: [] },
              confirmation: { operationId: 'op_1', action: 'team.disband', nonce: 'n1', targetHash: 't', impactHash: 'i', expiresAt: '2026-01-01T00:00:00.000Z' },
              committed: { task: { id: 'task_new', status: 'ready' } },
            },
          }),
      }
    }
    calls.push(method)
    const payload = method in data ? data[method] : undefined
    if (payload === undefined) {
      return { status: 404, text: async () => JSON.stringify({ ok: false, error: { message: `未预置 ${method}` } }) }
    }
    return { status: 200, text: async () => JSON.stringify({ ok: true, data: payload }) }
  }) as typeof fetch

  return {
    view: view!,
    panel: panel!,
    calls,
    writes,
    get writeBody() {
      return writeBody
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const EMPTY: Record<string, unknown> = {
  status: { name: '示例视图', counts: { teams: 0, tasks: 0, runs: 0, knowledge: 0 }, observedProjectSeq: 3, graphRevision: 1, configRevision: 1 },
  overview: { name: '示例视图', totals: { all: 0, done: 0, blocked: 0, review: 0 }, attention: { review: 0, blocked: 0, unknownEffects: 0 }, teams: [], graphRevision: 1, observedProjectSeq: 3 },
  board: { columns: [], totals: { all: 0 }, graphRevision: 1 },
  definitions: { items: [] },
  migration: { verdict: 'ready', headline: '没有可迁移的 v1 数据', markdown: '# 迁移\n无内容' },
  runs: { items: [] },
  effects: { items: [], counts: { requested: 0, accepted: 0, completed: 0, failed: 0, cancelled: 0, 'outcome-unknown': 0 } },
  knowledge: { items: [] },
  memory: { file: 'memory/myteam.db', exists: true, banks: [], entries: [], warnings: [] },
  audit: { items: [], nextBeforeSeq: null },
  settings: { configRevision: 1, defaults: {}, teams: [] },
  globalLibrary: { root: '/tmp/.dsh/myteam', exists: true, counts: { role: 0, workflow: 0, blueprint: 0, team: 0 }, entries: [], warnings: [] },
  globalAudit: { root: '/tmp/.dsh/myteam', exists: true, items: [], truncated: false, warnings: [] },
}

const FILLED: Record<string, unknown> = {
  ...EMPTY,
  overview: {
    name: '示例视图',
    totals: { all: 1, done: 0, blocked: 0, review: 1 },
    attention: { review: 1, blocked: 0, unknownEffects: 0 },
    teams: [
      { id: 'team_1', name: '甲队', status: 'active', members: 1, tasks: 1, captain: { sessionId: 'ses_captain_1', generation: 1 } },
    ],
    graphRevision: 4,
    observedProjectSeq: 9,
  },
  board: {
    columns: [
      {
        status: 'review',
        count: 1,
        tasks: [
          {
            id: 'task_1',
            title: '评审中的任务',
            status: 'review',
            ownerTeamId: 'team_1',
            ownerTeamName: '甲队',
            runId: null,
            blockedBy: [],
            dependencies: [],
            attemptId: 'attempt_1',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
    totals: { all: 1 },
    graphRevision: 4,
  },
  runs: {
    items: [
      { id: 'run_1', workflowId: 'wf_1', workflowRevision: 2, teamId: 'team_1', status: 'active', completionRevision: 1, revision: 3, taskCount: 4, createdAt: 'x', updatedAt: 'y' },
    ],
  },
  effects: {
    items: [{ id: 'eff_1', kind: 'spawn-member', status: 'completed' }],
    counts: { requested: 0, accepted: 1, completed: 1, failed: 0, cancelled: 0, 'outcome-unknown': 0 },
  },
  run: {
    run: { id: 'run_1', workflowId: 'wf_1', workflowRevision: 2, completionRevision: 1, revision: 3, status: 'active', taskIds: ['task_1'] },
    completion: { templateTasks: { impl: 'task_1' } },
    tasks: [{ id: 'task_1', title: '评审中的任务', status: 'review', templateKey: 'impl' }],
  },
  definitions: {
    items: [
      {
        kind: 'role',
        id: 'role_1',
        name: '实现者',
        detail: { profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] }, capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: ['run-tests'] } },
        revision: 3,
        contentHash: 'abcdef123456',
        baseHash: 'abcdef123456',
        origin: null,
        archived: false,
        published: null,
        localChanged: true,
        upstreamChanged: null,
        updateAvailable: null,
      },
    ],
  },
  knowledge: {
    items: [
      { id: 'k_1', title: '门禁要留证据', body: '证据链', status: 'adopted', revision: 2, evidence: [{ kind: 'command', ref: 'npm test' }], supersedes: null, createdAt: 'x', updatedAt: 'y' },
    ],
  },
  memory: {
    file: 'memory/myteam.db',
    exists: true,
    banks: [{ bankId: 'default', live: 1, total: 2, lastUpdated: 'y' }],
    entries: [
      { id: 'm_1', bankId: 'default', text: '成员提交前先跑测试', tags: ['gate'], evidence: [], revision: 1, createdAt: 'x', updatedAt: 'y', forgotten: false },
    ],
    warnings: [],
  },
  audit: {
    items: [
      { seq: 12, at: '2026-01-01T00:00:00.000Z', type: 'task.verdict', batchId: 'b1', actor: { kind: 'human', id: 'owner' }, entity: { kind: 'gate-verdict', id: 'v1' } },
    ],
    nextBeforeSeq: 11,
  },
  settings: {
    configRevision: 3,
    defaults: { maxMembers: 8 },
    teams: [{ teamId: 'team_1', configRevision: 3, contentHash: 'abcdef123456', mergeAlgorithmVersion: 'v1', safetyLimitsVersion: 'v1', clamped: false }],
  },
  task: {
    task: {
      id: 'task_1',
      title: '评审中的任务',
      status: 'review',
      attemptId: 'attempt_1',
      ownerTeamId: 'team_1',
      dependencies: [],
      acceptance: ['返回 ok'],
      description: '',
    },
    team: { id: 'team_1', name: '甲队' },
    run: null,
    attempt: { id: 'attempt_1', status: 'active', memberId: 'member_1' },
    verdict: null,
    evidence: [],
    dependencies: [],
    dependents: [],
  },
  team: {
    team: { id: 'team_1', name: '甲队', status: 'active' },
    captain: { sessionId: 'ses_captain_1', generation: 1 },
    members: [{ id: 'member_1', roleId: 'role_1', status: 'active', parentMemberId: null }],
    tasks: [{ id: 'task_1', title: '评审中的任务', status: 'review' }],
    roles: [{ id: 'role_1', name: '实现者' }],
    config: null,
  },
  globalLibrary: {
    root: '/tmp/.dsh/myteam',
    exists: true,
    counts: { role: 1, workflow: 0, blueprint: 0, team: 0 },
    entries: [{ kind: 'role', id: 'r1', name: '实现者', revision: 3, file: 'roles/r1.json', legacy: false }],
    warnings: [],
  },
  globalAudit: {
    root: '/tmp/.dsh/myteam',
    exists: true,
    items: [{ at: '2026-01-01T00:00:00.000Z', operationId: 'op_1', action: 'definition.publish', target: 'roles/r1.json', status: 'published', record: {} }],
    truncated: false,
    warnings: [],
  },
}

const PROJECT_TABS: [string, string][] = [
  ['任务', '待规划'],
  ['团队', '这个项目还没有团队'],
  ['流程', '还没有工作流运行'],
  ['定义', '这个项目还没有定义副本'],
  ['知识', '这个项目还没有知识条目'],
  ['记忆', '记忆库是空的'],
  ['审计', '这个项目还没有事件'],
  ['设置', '还没有团队的生效配置'],
]

const PROJECT_TABS_FILLED: [string, string][] = [
  ['任务', '评审中的任务'],
  ['流程', 'run_1'],
  ['定义', '实现者'],
  ['知识', '门禁要留证据'],
  ['记忆', '成员提交前先跑测试'],
  ['审计', 'task.verdict'],
  ['设置', 'maxMembers'],
]

const GLOBAL_TABS: [string, string][] = [
  ['角色', '角色里还没有全局条目'],
  ['工作流', '工作流里还没有全局条目'],
  ['蓝图', '蓝图里还没有全局条目'],
  ['发布', '还没有全局操作记录'],
]

const GLOBAL_TABS_FILLED: [string, string][] = [
  ['角色', '实现者'],
  ['发布', 'definition.publish'],
]

async function clickThrough(
  component: AnyComponent,
  props: Record<string, unknown>,
  tabs: [string, string][],
  firstExpect: string,
): Promise<void> {
  let tree = await mount(component, props)
  assert.ok(textOf(tree).includes(firstExpect), `首屏没渲染出「${firstExpect}」：${textOf(tree).slice(0, 240)}`)

  for (const [label, expected] of tabs) {
    const tab = findTab(tree, label)
    assert.ok(tab !== null, `找不到「${label}」栏按钮`)
    const onClick = tab!.props.onClick
    assert.equal(typeof onClick, 'function', `「${label}」按钮没有 onClick`)
    ;(onClick as () => void)()
    tree = await mount(component, props)
    const text = textOf(tree)
    assert.ok(text.includes(expected), `「${label}」栏没渲染出「${expected}」；实际：${text.slice(0, 300)}`)
  }
}

test('团队视图九栏：空数据下每栏都能渲染，且空态说清为什么空', async () => {
  const harness = loadClient(EMPTY)
  try {
    await clickThrough(harness.view, { sessionId: 'ses_1' }, PROJECT_TABS, '看板、审计、设置读的是同一份项目投影')
    assert.ok(harness.calls.includes('runs'), '切到「流程」应真的请求 runs')
    assert.ok(harness.calls.includes('audit'), '切到「审计」应真的请求 audit')
  } finally {
    harness.restore()
  }
})

test('流程栏：运行行能点开详情（run），下方显示副作用计数（effects）', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const tab = findTab(tree, '流程')
    assert.ok(tab !== null, '找不到「流程」栏')
    ;(tab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    let text = textOf(tree)
    assert.ok(harness.calls.includes('effects'), '切到「流程」应真的请求 effects')
    assert.ok(text.includes('副作用'), `流程栏应出现副作用区块：${text.slice(0, 240)}`)
    assert.ok(text.includes('completed 1'), '副作用三态计数要渲染出来')

    const row = findByClass(tree, 'item pick')
    assert.ok(row !== null, '运行行应带可点开的 class（item pick）')
    ;(row!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    text = textOf(tree)
    assert.ok(harness.calls.includes('run'), '点运行行应真的请求 run 详情')
    assert.ok(text.includes('完成规则'), `运行详情应显示完成规则：${text.slice(0, 240)}`)
    assert.ok(text.includes('templateKey impl'), '详情要把 templateKey → task 映射渲染出来')
  } finally {
    harness.restore()
  }
})

test('设置栏：底部带 v1 迁移影响面（migration），空态也说清为什么空', async () => {
  const harness = loadClient(EMPTY)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const tab = findTab(tree, '设置')
    assert.ok(tab !== null, '找不到「设置」栏')
    ;(tab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    assert.ok(harness.calls.includes('migration'), '切到「设置」应真的请求 migration')
    assert.ok(textOf(tree).includes('没有可迁移的 v1 数据'), '迁移影响面要渲染出来，不能留白')
  } finally {
    harness.restore()
  }
})

test('L1 共用件：概览的四张指标卡、审计的列表行、任务的表单域都走同一份组件', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    // 指标卡（.rc）走同一个组件：四张各自的标签都要落在带 rc 的节点里。
    for (const label of ['团队', '任务', '等你确认', '受阻']) {
      const cards = countNodes(tree, (element) => {
        const tokens = String(element.props?.className ?? '').split(/\s+/)
        return tokens.includes('rc') && textOf(element.children ?? element.props?.children).includes(label)
      })
      assert.ok(cards >= 1, `指标卡缺「${label}」`)
      assert.ok(text.includes(label), `概览文本缺「${label}」`)
    }

    const auditTab = findTab(tree, '审计')
    assert.ok(auditTab !== null, '找不到「审计」栏')
    ;(auditTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    const rows = countNodes(tree, (element) => String(element.props?.className ?? '').split(' ').includes('item'))
    assert.equal(rows, (FILLED.audit as { items: unknown[] }).items.length, '审计栏每行都应是一个共用列表行')

    const tasksTab = findTab(tree, '任务')
    assert.ok(tasksTab !== null, '找不到「任务」栏')
    ;(tasksTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    const newTask = findButton(tree, '新任务')
    assert.ok(newTask !== null, '任务栏应有「新任务」按钮')
    ;(newTask!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    const fields = countNodes(tree, (element) => String(element.props?.className ?? '').split(/\s+/).includes('fld'))
    assert.ok(fields >= 2, `新任务表单应至少有两个表单域，实际 ${fields}`)
  } finally {
    harness.restore()
  }
})

test('团队视图九栏：有数据时列表行渲染出关键字段（不只看空态）', async () => {
  const harness = loadClient(FILLED)
  try {
    await clickThrough(harness.view, { sessionId: 'ses_1' }, PROJECT_TABS_FILLED, '看板、审计、设置读的是同一份项目投影')
  } finally {
    harness.restore()
  }
})

test('左栏全局库五栏：两种数据下都能渲染，且不带会话也发请求', async () => {
  const empty = loadClient(EMPTY)
  try {
    await clickThrough(empty.panel, { ctx: {} }, GLOBAL_TABS, '全局库还是空的')
    assert.ok(empty.calls.includes('globalLibrary'), '全局栏应请求 globalLibrary')
    assert.ok(empty.calls.includes('globalAudit'), '发布栏应请求 globalAudit')
  } finally {
    empty.restore()
  }

  const filled = loadClient(FILLED)
  try {
    await clickThrough(filled.panel, { ctx: {} }, GLOBAL_TABS_FILLED, '读到的定义都是完整的')
  } finally {
    filled.restore()
  }
})

test('任务栏「新任务」：填标题提交 → 只发一次 taskCreate，且带 confirm: true', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })

    const tasksTab = findTab(tree, '任务')
    assert.ok(tasksTab !== null, '缺「任务」栏')
    ;(tasksTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const openForm = findButton(tree, '新任务')
    assert.ok(openForm !== null, '任务栏缺「新任务」按钮')
    ;(openForm!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const titleInput = findByPlaceholder(tree, '任务标题')
    assert.ok(titleInput !== null, '表单缺标题输入框')
    ;(titleInput!.props.onChange as (event: unknown) => void)({ target: { value: '面板建的任务' } })
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const create = findButton(tree, '创建')
    assert.ok(create !== null, '表单缺「创建」按钮')
    ;(create!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    assert.deepEqual(harness.writes, ['taskCreate'], '一次点击只能发一次写请求')
    assert.equal(harness.writeBody?.confirm, true, 'direct 类写动作必须带 confirm: true')
    const params = harness.writeBody?.params as Record<string, unknown>
    assert.equal(params.title, '面板建的任务')
    assert.equal(params.teamId, 'team_1', '默认选第一个团队')
    assert.ok(textOf(tree).includes('共 1 个任务'), '提交成功后表单收起、看板回到列表')
  } finally {
    harness.restore()
  }
})

test('任务详情：评审中的任务能提交门禁裁决（gateVerdict + confirm: true）', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })

    const tasksTab = findTab(tree, '任务')
    assert.ok(tasksTab !== null)
    ;(tasksTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const card = findButton(tree, '评审中的任务')
    assert.ok(card !== null, '看板卡片应能点开任务详情')
    ;(card!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const command = findByPlaceholder(tree, '检查命令（必填，例如 node --test）')
    assert.ok(command !== null, '评审中的任务详情应出现裁决表单')
    ;(command!.props.onChange as (event: unknown) => void)({ target: { value: 'node --test' } })
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const submit = findButton(tree, '提交裁决')
    assert.ok(submit !== null, '缺「提交裁决」按钮')
    ;(submit!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    assert.deepEqual(harness.writes, ['gateVerdict'], '一次提交只发一次裁决')
    assert.equal(harness.writeBody?.confirm, true, 'direct 类写动作必须带 confirm: true')
    const params = harness.writeBody?.params as Record<string, unknown>
    assert.equal(params.attemptId, 'attempt_1', '裁决必须绑定当前 Attempt')
    const checks = params.checks as { command: string; exitCode: number | null }[]
    assert.equal(checks[0]!.command, 'node --test')
    assert.equal(checks[0]!.exitCode, 0)
  } finally {
    harness.restore()
  }
})

test('团队栏：解散团队走两段确认（先预览拿令牌，再带 action=confirm 执行）', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })

    const teamsTab = findTab(tree, '团队')
    assert.ok(teamsTab !== null)
    ;(teamsTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const teamButton = findButton(tree, '甲队')
    assert.ok(teamButton !== null, '应能选中团队')
    ;(teamButton!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const dissolve = findButton(tree, '解散团队')
    assert.ok(dissolve !== null, '团队详情缺「解散团队」入口')
    ;(dissolve!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    assert.deepEqual(harness.writes, ['teamDisband'], '第一段只预览，不能直接执行')
    assert.equal(harness.writeBody?.action, undefined, '预览请求不能带 action')
    assert.ok(textOf(tree).includes('待确认'), '预览要显示影响面与「待确认」')
    assert.ok(textOf(tree).includes('影响 1 名成员'), '预览要显示服务端给的 summary')

    const commit = findButton(tree, '确认执行')
    assert.ok(commit !== null, '预览后缺「确认执行」')
    ;(commit!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    assert.deepEqual(harness.writes, ['teamDisband', 'teamDisband'])
    assert.equal(harness.writeBody?.action, 'confirm', '第二段必须带 action=confirm')
    assert.ok(harness.writeBody?.confirmation !== undefined, '第二段必须带一次性令牌')
  } finally {
    harness.restore()
  }
})

test('定义栏：发布到全局库也走两段确认，且 params 带 kind/id', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })

    const definitionsTab = findTab(tree, '定义')
    assert.ok(definitionsTab !== null)
    ;(definitionsTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    const publish = findButton(tree, '发布')
    assert.ok(publish !== null, '定义条目缺「发布」入口')
    ;(publish!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })

    assert.deepEqual(harness.writes, ['definitionPublish'], '第一段只预览')
    assert.equal(harness.writeBody?.action, undefined)
    const params = harness.writeBody?.params as Record<string, unknown>
    assert.equal(params.kind, 'role')
    assert.equal(params.id, 'role_1')
    assert.ok(textOf(tree).includes('待确认'), '预览后要等确认')

    const commit = findButton(tree, '确认执行')
    assert.ok(commit !== null)
    ;(commit!.props.onClick as () => void)()
    await mount(harness.view, { sessionId: 'ses_1' })
    assert.deepEqual(harness.writes, ['definitionPublish', 'definitionPublish'])
    assert.equal(harness.writeBody?.action, 'confirm')
  } finally {
    harness.restore()
  }
})

/** 跨团队依赖的样本：甲队的 task_1 被乙队的 task_2 卡住（blockedBy 指向另一团队）。 */
const CROSS: Record<string, unknown> = {
  ...FILLED,
  board: {
    columns: [
      {
        status: 'in_progress',
        count: 2,
        tasks: [
          { id: 'task_1', title: '结算接口', status: 'in_progress', ownerTeamId: 'team_1', ownerTeamName: '甲队', runId: null, blockedBy: ['task_2'], dependencies: ['task_2'], attemptId: null, updatedAt: 'x' },
          { id: 'task_2', title: '核对单点', status: 'in_progress', ownerTeamId: 'team_2', ownerTeamName: '乙队', runId: null, blockedBy: [], dependencies: [], attemptId: null, updatedAt: 'x' },
        ],
      },
    ],
    totals: { all: 2 },
    graphRevision: 5,
  },
}

test('L2-B1 概览：四张卡 / 团队 / 跨团队依赖 / 最近事件四节都在，空态说清楚', async () => {
  const harness = loadClient(FILLED)
  try {
    const tree = await mount(harness.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    for (const label of ['团队', '跨团队依赖', '最近事件']) {
      assert.ok(text.includes(label), `概览缺「${label}」这一节`)
    }
    assert.ok(text.includes('任务之间还没有跨团队依赖'), `空态没说清：${text.slice(0, 200)}`)
  } finally {
    harness.restore()
  }
})

test('L2-B1 概览：跨团队依赖能把两个团队和谁卡住谁列出来', async () => {
  const harness = loadClient(CROSS)
  try {
    const tree = await mount(harness.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    assert.ok(text.includes('核对单点'), `依赖行缺前置任务：${text.slice(0, 240)}`)
    assert.ok(text.includes('乙队'), '依赖行缺前置团队')
    assert.ok(text.includes('被 核对单点 阻塞'), '依赖行缺阻塞说明')
    assert.ok(!text.includes('任务之间还没有跨团队依赖'), '有边时不该再显示空态')
  } finally {
    harness.restore()
  }
})

test('L2-B1 任务 / 团队 / 定义 / 流程四页：关键字段与空态都在', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const open = async (label: string) => {
      const tab = findTab(tree, label)
      assert.ok(tab !== null, `找不到「${label}」栏`)
      ;(tab!.props.onClick as () => void)()
      // 条件请求的栏（知识/记忆/审计/设置）点开后要等异步数据落地，多挂几帧直到出现内容。
      for (let round = 0; round < 8; round += 1) {
        tree = await mount(harness.view, { sessionId: 'ses_1' })
        const now = textOf(tree)
        if (now.length > 400) return now
      }
      return textOf(tree)
    }

    const tasks = await open('任务')
    assert.ok(tasks.includes('共 1 个任务'), `任务栏缺总计：${tasks.slice(0, 200)}`)
    for (const lane of ['待规划', '进行中', '待评审', '已完成']) {
      assert.ok(tasks.includes(lane), `任务栏缺列「${lane}」`)
    }

    const teams = await open('团队')
    assert.ok(teams.includes('甲队') && teams.includes('成员'), `团队栏缺关键字段：${teams.slice(0, 200)}`)

    const defs = await open('定义')
    assert.ok(defs.includes('实现者') && defs.includes('rev '), `定义栏缺关键字段：${defs.slice(0, 200)}`)

    const runs = await open('流程')
    assert.ok(runs.includes('wf_1') && runs.includes('副作用'), `流程栏缺关键字段：${runs.slice(0, 200)}`)
  } finally {
    harness.restore()
  }
})

test('L2-F 依赖图：有边时画层级与前置，没有边时说清空', async () => {
  const empty = loadClient(FILLED)
  try {
    let tree = await mount(empty.view, { sessionId: 'ses_1' })
    const tab = findTab(tree, '任务')
    assert.ok(tab !== null, '找不到「任务」栏')
    ;(tab!.props.onClick as () => void)()
    tree = await mount(empty.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    assert.ok(text.includes('依赖图'), `任务栏应带依赖图分节：${text.slice(0, 240)}`)
    assert.ok(text.includes('任务之间还没有依赖'), '无边时要有空态')
  } finally {
    empty.restore()
  }

  const cross = loadClient(CROSS)
  try {
    let tree = await mount(cross.view, { sessionId: 'ses_1' })
    const tab = findTab(tree, '任务')
    assert.ok(tab !== null, '找不到「任务」栏')
    ;(tab!.props.onClick as () => void)()
    tree = await mount(cross.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    assert.ok(text.includes('2 个任务 · 1 条依赖'), `依赖图计数不对：${text.slice(0, 260)}`)
    assert.ok(text.includes('← 核对单点'), '依赖行要写出前置任务')
    assert.ok(text.includes('L1'), '被依赖的任务应下沉一层')
    assert.ok(!text.includes('任务之间还没有依赖'), '有边时不该显示空态')
  } finally {
    cross.restore()
  }
})

/** 泳道样本：Run run_1 挂两个任务（一个 review、一个 done），另有一条空 Run。 */
const LANES: Record<string, unknown> = {
  ...FILLED,
  runs: {
    items: [
      { id: 'run_1', workflowId: 'wf_1', workflowRevision: 2, teamId: 'team_1', status: 'active', completionRevision: 1, revision: 3, taskCount: 2, createdAt: 'x', updatedAt: 'y' },
      { id: 'run_2', workflowId: 'wf_2', workflowRevision: 1, teamId: 'team_1', status: 'active', completionRevision: 1, revision: 1, taskCount: 1, createdAt: 'x', updatedAt: 'y' },
    ],
  },
  board: {
    columns: [
      {
        status: 'review',
        count: 1,
        tasks: [
          { id: 'task_1', title: '实现结算', status: 'review', ownerTeamId: 'team_1', ownerTeamName: '甲队', runId: 'run_1', blockedBy: [], dependencies: [], attemptId: null, updatedAt: 'x' },
        ],
      },
      {
        status: 'done',
        count: 1,
        tasks: [
          { id: 'task_2', title: '写单测', status: 'done', ownerTeamId: 'team_1', ownerTeamName: '甲队', runId: 'run_1', blockedBy: [], dependencies: [], attemptId: null, updatedAt: 'x' },
        ],
      },
    ],
    totals: { all: 2 },
    graphRevision: 3,
  },
}

test('L2-F 流程泳道：按 Run 分行，空 Run 说清「没挂任务」', async () => {
  const harness = loadClient(LANES)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const tab = findTab(tree, '流程')
    assert.ok(tab !== null, '找不到「流程」栏')
    ;(tab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    assert.ok(text.includes('流程泳道'), `流程栏应带泳道分节：${text.slice(0, 240)}`)
    assert.ok(text.includes('2 条 Run'), '泳道分节要写 Run 数')
    assert.ok(text.includes('实现结算') && text.includes('写单测'), '泳道里要列出该 Run 的任务')
    assert.ok(text.includes('这条 Run 还没有挂任务'), '空的 Run 要说清，不要留白')
  } finally {
    harness.restore()
  }
})

test('L2-F 待你确认：有 review/blocked 时列出，没有时说「没有等你确认的事」', async () => {
  const empty = loadClient(EMPTY)
  try {
    const tree = await mount(empty.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    assert.ok(text.includes('待你确认'), `概览应带待确认分节：${text.slice(0, 200)}`)
    assert.ok(text.includes('没有等你确认的事'), '0 件时要有空态')
  } finally {
    empty.restore()
  }

  const filled = loadClient(FILLED)
  try {
    const tree = await mount(filled.view, { sessionId: 'ses_1' })
    const text = textOf(tree)
    assert.ok(text.includes('待你确认'), '概览应带待确认分节')
    assert.ok(text.includes('1 件'), `计数应反映 attention：${text.slice(0, 260)}`)
    assert.ok(text.includes('评审中的任务'), '待确认里要列出 review 任务')
    assert.ok(!text.includes('没有等你确认的事'), '有事项时不该显示空态')
  } finally {
    filled.restore()
  }
})

test('L2-C 名册树：按父子层级渲染，孤儿成员也列出来', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const teamsTab = findTab(tree, '团队')
    assert.ok(teamsTab !== null, '找不到「团队」栏')
    ;(teamsTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    const pick = findButton(tree, '甲队')
    assert.ok(pick !== null, '团队栏应有团队按钮')
    ;(pick!.props.onClick as () => void)()
    let teamsText = ''
    for (let round = 0; round < 6; round += 1) {
      tree = await mount(harness.view, { sessionId: 'ses_1' })
      teamsText = textOf(tree)
      if (teamsText.includes('member_1')) break
    }
    assert.ok(teamsText.includes('实现者'), '名册树应显示角色名：' + teamsText.slice(0, 260))
    assert.ok(teamsText.includes('member_1'), '名册树应显示成员 id')
  } finally {
    harness.restore()
  }
})

test('L2-C 角色详情：定义行可点开（交互契约；正文由 t14 的 detail 断言守着）', async () => {
  const harness = loadClient(FILLED)
  try {
    let tree = await mount(harness.view, { sessionId: 'ses_1' })
    const defTab = findTab(tree, '定义')
    assert.ok(defTab !== null, '找不到「定义」栏')
    ;(defTab!.props.onClick as () => void)()
    tree = await mount(harness.view, { sessionId: 'ses_1' })
    const row = findByClass(tree, 'item pick')
    assert.ok(row !== null, '定义行应可点开（item pick）')
    assert.equal(typeof row!.props.onClick, 'function', '可点开的定义行必须有 onClick')
  } finally {
    harness.restore()
  }
})