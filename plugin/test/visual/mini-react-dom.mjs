/**
 * 浏览器里的最小 React（+ 一个只会「全量重建」的渲染器），**只给可视化夹具用**。
 *
 * 为什么另写一个，而不是把 t39 那套垫片抽出来共用：
 * t39 的垫片只把组件调用成一棵**元素树**（然后断言文本），根本不建 DOM；
 * 这里要的是「真 CSS 下的真实盒子」，必须产出真元素。两者目标不同，硬共用只会让两边都变形。
 * 共同点只在约定：`createElement` + `useState/useEffect/useRef/useCallback`。
 *
 * 刻意不做的事（夹具不需要，做了反而容易掩盖问题）：
 *   - 不做 diff / reconciliation：任何 setState 都整棵树重建（截图工具，不在乎性能）；
 *   - 不管 `key`：列表顺序完全由数据决定；
 *   - 不实现 Fragment / memo / context / useMemo：client.js 一个都没用到。
 *
 * 两个关键设计（都踩过坑）：
 *   1. hook 槽位按「组件函数 + 本轮第几次出现」分配，不按渲染路径 ——
 *      路径会随条件分支变化（表单展开/收起），一变槽位就串了，state 互相污染。
 *   2. 槽位统一是 `{ kind, value }` 的形状 —— 早期版本让 useCallback 直接存对象，
 *      结果 `kind` 判断永远不成立、每次渲染都换新函数身份，`useEffect([load])` 就无限重启
 *      （表现是 fetch 打不完、渲染次数爆表）。
 */

const STATE = {
  root: null,
  slots: new Map(),
  pending: 0,
  scheduled: false,
  renderer: null,
  effects: [],
}

const RENDER_CAP = 120

let hookCursor = 0
let currentKey = 'root'
let occurrenceCounters = new Map()
let renderCount = 0

function scheduleRender() {
  STATE.pending += 1
  if (STATE.scheduled) return
  STATE.scheduled = true
  queueMicrotask(() => {
    STATE.scheduled = false
    if (STATE.renderer !== null) STATE.renderer()
  })
}

function nextSlot(kind, init) {
  let slots = STATE.slots.get(currentKey)
  if (slots === undefined) {
    slots = []
    STATE.slots.set(currentKey, slots)
  }
  const index = hookCursor
  hookCursor += 1
  const created = slots[index] === undefined
  if (created) slots[index] = { kind, value: init() }
  return { slots, index, created }
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((item, index) => Object.is(item, right[index]))
}

export const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    const flat = children.length === 0 ? merged.children : children.length === 1 ? children[0] : children
    if (flat !== undefined) merged.children = flat
    return { type, props: merged }
  },

  useState(initial) {
    const { slots, index } = nextSlot('state', () => (typeof initial === 'function' ? initial() : initial))
    const set = (next) => {
      const value = typeof next === 'function' ? next(slots[index].value) : next
      if (Object.is(value, slots[index].value)) return
      slots[index].value = value
      scheduleRender()
    }
    return [slots[index].value, set]
  },

  useRef(initial) {
    const { slots, index } = nextSlot('ref', () => ({ current: initial }))
    return slots[index].value
  },

  useCallback(fn, deps) {
    const { slots, index } = nextSlot('callback', () => ({ fn, deps }))
    const slot = slots[index]
    if (!sameDeps(slot.value.deps, deps)) slot.value = { fn, deps }
    return slot.value.fn
  },

  useEffect(fn, deps) {
    const { slots, index, created } = nextSlot('effect', () => ({ fn, deps, cleanup: undefined }))
    const slot = slots[index]
    // created 的那一次也必须排队跑：首次渲染时 deps 与刚写进去的完全相同，
    // 只靠「deps 变了」判断会让 effect 一次都不跑（表现为界面永远停在 loading）。
    if (created || !sameDeps(slot.value.deps, deps)) {
      slot.value = { fn, deps, cleanup: slot.value.cleanup }
      STATE.effects.push({ key: currentKey, index })
    }
  },
}

function applyProps(element, props) {
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'key') continue
    if (name === 'className') {
      element.setAttribute('class', String(value ?? ''))
      continue
    }
    if (name === 'style') {
      if (value !== null && typeof value === 'object') {
        for (const [prop, raw] of Object.entries(value)) {
          element.style[prop] = typeof raw === 'number' ? `${raw}px` : String(raw)
        }
      }
      continue
    }
    if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2).toLowerCase(), value)
      continue
    }
    if (value === undefined || value === null || value === false) continue
    if (name === 'value' || name === 'checked' || name === 'disabled') {
      element[name] = value
      continue
    }
    element.setAttribute(name, value === true ? '' : String(value))
  }
}

function renderChild(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (Array.isArray(node)) {
    const holder = document.createDocumentFragment()
    for (const child of node) {
      const rendered = renderChild(child)
      if (rendered !== null) holder.appendChild(rendered)
    }
    return holder
  }
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node))
  if (typeof node !== 'object') return null

  const { type, props } = node
  if (typeof type === 'function') {
    const previousKey = currentKey
    const previousCursor = hookCursor
    const seen = occurrenceCounters.get(type) ?? 0
    occurrenceCounters.set(type, seen + 1)
    currentKey = `${type.name || 'anon'}#${seen}`
    hookCursor = 0
    let output
    try {
      output = type(props)
    } finally {
      currentKey = previousKey
      hookCursor = previousCursor
    }
    return renderChild(output)
  }
  if (typeof type === 'string') {
    const element = document.createElement(type)
    applyProps(element, props)
    if (props.children !== undefined) {
      const rendered = renderChild(props.children)
      if (rendered !== null) element.appendChild(rendered)
    }
    return element
  }
  return null
}

function renderRoot() {
  renderCount += 1
  if (renderCount > RENDER_CAP) {
    document.body.dataset.harnessOverflow = String(renderCount)
    return
  }
  STATE.effects = []
  occurrenceCounters = new Map()

  // 根组件也要走 renderChild：它会重置 hookCursor 并按组件身份分配槽位。
  // 直接调用 STATE.component(...) 会让第二轮渲染从上一轮的 hook 游标继续，
  // 于是每个 hook 都落到空槽位上 —— 表现就是 effect 每轮都重新排队、fetch 打不完。
  const rendered = renderChild({ type: STATE.component, props: STATE.props })
  const container = STATE.root
  container.textContent = ''
  if (rendered !== null) container.appendChild(rendered)

  const effects = STATE.effects
  STATE.effects = []
  for (const { key, index } of effects) {
    const slot = STATE.slots.get(key)?.[index]
    if (slot === undefined || slot.kind !== 'effect') continue
    const previousKey = currentKey
    currentKey = key
    try {
      const cleanup = slot.value.fn()
      slot.value.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    } finally {
      currentKey = previousKey
    }
  }
}

/** 挂载：从空树开始渲染，等状态稳定（异步 effect 落地后再刷几轮），有上限。 */
export async function mount(Component, props, container) {
  STATE.root = container
  STATE.component = Component
  STATE.props = props ?? {}
  STATE.slots = new Map()
  STATE.pending = 0
  STATE.renderer = renderRoot
  renderCount = 0

  renderRoot()
  for (let round = 0; round < 40; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (STATE.pending === 0) break
    STATE.pending = 0
    renderRoot()
  }
  document.body.dataset.renders = String(renderCount)
}
