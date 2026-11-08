/**
 * T134（CHG-164 / 报告 A3）：**describe / batch 两个端点从「纯悬空」到「真消费」**。
 *
 * 背景（未打通清单 A3）：CHG-111 建了 `describe`（能力协商，治「两端方法表漂移」）、
 * CHG-112 建了 `batch`（首屏批量，治「43 条路由没有批量」），**服务端完整实现**，
 * 但客户端只是把它们写进 `makeApi` 的**定义**里，**零调用点**——两个已建成能力纯悬空：
 *   - 旧宿主上「服务端没这个方法」只能等调用时 `undefined` 炸（CHG-104 的整屏卡死）；
 *   - 首屏仍是 `getProject` → `getStoreState` 两次**串行** RPC，白等一个 RTT。
 *
 * 本文件锁五件事（静态契约 + 服务端行为，与 t13c / t85 同一套「按不变量断言」风格）：
 *  ① `describe` 被**调用**（不是只定义），且结果进 `capabilities` 状态；
 *  ② `hasEndpoint` 优先用**服务端**方法表判（缺方法 → 降级），拿不到才退回 `typeof` 探测
 *     （协商失败不能把功能全禁掉）；
 *  ③ `loadProject` 真的用 `batch` 打 `getProject` + `getStoreState`（一次往返）；
 *  ④ 降级两层：`describe` 明说没有 batch / 调用失败 → 记住并走两次调用，**不白试第二次**；
 *  ⑤ 非空洞：`batch` 的 calls 数组里两个 kind 都在，且失败分支不得把 `storeState` 写成 null。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MyTeamPanelFacade } from '../src/panel.ts'

const DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

/** 客户端 `makeApi` 里是否**定义**了某端点（定义 ≠ 消费，这正是本项要区分的） */
function definesEndpoint(name: string): boolean {
  return new RegExp(`^\\s{8}${name}\\s*:`, 'm').test(clientSource)
}

/** 客户端里某端点的**调用点**（`xxx.<name>(` 或 `['<name>'](` 两种形态） */
function callSites(name: string): number[] {
  const pattern = new RegExp(`(?:\\.|\\?\\[\\s*')${name}'?\\s*(?:\\]\\s*)?\\(`, 'g')
  const hits: number[] = []
  for (const match of clientSource.matchAll(pattern)) {
    // 跳过 `name: (query) =>` 这种**定义**形态（定义里不会出现点号/方括号调用）
    const before = clientSource.slice(Math.max(0, match.index - 12), match.index)
    if (/^\s{0,12}$/.test(before) && /^\s{8}[A-Za-z]/.test(before)) continue
    hits.push(match.index)
  }
  return hits
}

test('t134-1: 服务端 describe / batch 都在 marker 表里（前置：两个端点真存在）', () => {
  const descriptor = (MyTeamPanelFacade.prototype as unknown as Record<string, { methods: Array<{ method: string }> }>)[DESCRIPTOR]
  assert.ok(descriptor, '门面必须带 remote-methods 描述符')
  const methods = new Set(descriptor.methods.map((entry) => entry.method))
  for (const name of ['describe', 'batch']) {
    assert.ok(methods.has(name), `服务端必须暴露 ${name}（否则本项无从消费）`)
  }
})

test('t134-2: 客户端 makeApi 定义了 describe / batch（定义存在，才有得消费）', () => {
  for (const name of ['describe', 'batch']) {
    assert.ok(definesEndpoint(name), `makeApi 必须定义 ${name}`)
  }
})

test('t134-3: describe 被真调用——结果写进 capabilities 状态（不是纯定义悬空）', () => {
  /* ① 取值形态：`const describeFn = discoveryApi?.describe`（可选链，旧宿主不炸） */
  assert.match(
    clientSource,
    /const describeFn = discoveryApi\?\.describe/,
    'describe 必须经可选链取用（宿主可能是旧版本，直接点会 TypeError 卡死面板）',
  )
  /* ② 真调用 + 结果落状态 */
  const start = clientSource.indexOf('const describeFn = discoveryApi?.describe')
  assert.ok(start > 0, '找不到 describe 取值点')
  const block = clientSource.slice(start, start + 900)
  assert.match(block, /describeFn\(\{\}\)/, 'describe 必须被调用（零调用 = 本项要修的悬空）')
  assert.match(block, /setCapabilities\(/, 'describe 的结果必须进 capabilities 状态，否则协商等于没做')
  /* ③ 方法表形态：服务端返回的 methods 数组 → Set（O(1) 判定） */
  assert.match(block, /new Set\(methods\)/, 'methods 必须转成 Set 才能按名字 O(1) 判定')
})

test('t134-4: hasEndpoint 优先用服务端方法表，拿不到才退回 typeof 探测', () => {
  const start = clientSource.indexOf('const hasEndpoint = react.useCallback(')
  assert.ok(start > 0, '找不到 hasEndpoint（能力协商的判定入口）')
  const block = clientSource.slice(start, start + 400)
  /* 协商成功（methods 非 null）→ 按服务端表判：这是「治两端漂移」的全部价值 */
  assert.match(block, /caps && caps\.methods/, '有服务端方法表时必须优先用它判')
  assert.match(block, /caps\.methods\.has\(name\)/, '判定必须是 methods.has(name)')
  /* 协商失败（旧宿主/网络错）→ 退回 typeof：**未知不等于不支持**，不能据此禁用功能 */
  assert.match(block, /typeof discoveryApi\?\.\[name\] === 'function'/, '拿不到方法表时退回 typeof 探测（保守：不禁用）')
})

test('t134-5: 首屏一次往返——loadProject 用 batch 打 getProject + getStoreState', () => {
  const start = clientSource.indexOf('const loadProject = react.useCallback(')
  assert.ok(start > 0, '找不到 loadProject')
  const block = clientSource.slice(start, start + 3000)
  /* ① 真的用了 batch（不是只写了个 if） */
  assert.match(block, /discoveryApi\.batch\(\{/, '首屏必须走 batch（CHG-112 建它就是为了少往返）')
  /* ② calls 数组里两个 kind 都在——少一个就等于没批量 */
  assert.match(block, /kind: 'getProject'/, 'batch 里必须有 getProject')
  assert.match(block, /kind: 'getStoreState'/, 'batch 里必须有 getStoreState（否则存不下往返）')
  /* ③ 结果按位置取，且顺序与入参一致（服务端契约：results 顺序与 calls 一致） */
  assert.match(block, /const results = Array\.isArray\(r\?\.results\) \? r\.results : \[\]/, '必须按结果数组取，不信 r.value')
  assert.match(block, /const first = results\[0\]/, '必须按位置取第一条')
})

test('t134-6: 降级两层——describe 说没有 / 调用失败，都要记住并退回两次调用', () => {
  /* ① describe 明说没有 batch → 直接关闭批量（不白试） */
  const capStart = clientSource.indexOf('const describeFn = discoveryApi?.describe')
  const capBlock = clientSource.slice(capStart, capStart + 900)
  assert.match(
    capBlock,
    /if \(methods && !methods\.includes\('batch'\)\) batchAllowedRef\.current = false/,
    'describe 说服务端没有 batch → 本会话不再尝试（否则每次首屏都白跑一次失败的往返）',
  )
  /* ② 调用失败（旧宿主 MT_UNKNOWN_METHOD / 异常）→ 同样记住 */
  const loadStart = clientSource.indexOf('const loadProject = react.useCallback(')
  const loadBlock = clientSource.slice(loadStart, loadStart + 3000)
  const downgrades = loadBlock.match(/batchAllowedRef\.current = false/g) ?? []
  assert.ok(downgrades.length >= 2, `两条失败路径（信封错误 / 抛异常）都必须降级，实际 ${downgrades.length} 处`)
  /* ③ 降级后**必须回到单次调用**，不能什么都不做（否则首屏空白） */
  assert.match(loadBlock, /const p = await discoveryApi\.getProject\(\{ workspaceRoot: root \}\)/, '降级后必须真的去单次拉')
})

test('t134-7: 非空洞——失败不得把 storeState 写成 null，且两端取值语义一致', () => {
  /* 扫描门禁非空校验：client.js 必须真的被读到（路径写错时「零命中 = 通过」就是摆设） */
  assert.ok(clientSource.length > 500_000, `client.js 读取异常（${clientSource.length} 字节）`)
  assert.ok(callSites('batch').length > 0 || clientSource.includes('discoveryApi.batch('), 'batch 必须有调用点')

  const loadStart = clientSource.indexOf('const loadProject = react.useCallback(')
  const loadBlock = clientSource.slice(loadStart, loadStart + 3000)
  assert.ok(!loadBlock.includes('setStoreState(null)'), '失败不得写成 null（null = 永久「加载中」，t85-3 的原始缺陷）')
  /* 两条路径（batch / 单次）对 storeState 的写法必须同形：status==='ok' 才认，否则 undefined */
  const assigns = loadBlock.match(/setStoreState\([^)]*\)/g) ?? []
  assert.ok(assigns.length >= 2, `batch 与单次两条路径都要写 storeState，实际 ${assigns.length} 处`)
  for (const assign of assigns) {
    assert.match(assign, /undefined|status === 'ok'/, `storeState 只允许「ok 或 undefined」，实际：${assign}`)
  }
})
