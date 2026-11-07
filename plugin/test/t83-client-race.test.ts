/**
 * T83 · 面板客户端三处运行时缺陷的回归锁（CHG-99 / 审计 C13 · C3 · C14）。
 *
 * 为什么是「源码正则断言」而不是渲染断言：测试环境没有真浏览器（无 DOM、无
 * MutationObserver、无 matchMedia），`client.js` 是手写单文件、不是可编译产物。
 * 现有 `t13c-client.test.ts` 用 react shim 做浅渲染，本文件补的是**并发与样式纪律**
 * 这两类「只能靠代码结构证明」的契约：
 *
 *  - C3（竞态）：`loadProject` 必须有请求序号 + 项目根快照双守卫，且守卫在 `setProject`
 *    之前；错误分支同样要守卫（过期响应的 error 也不能盖当前项目）。
 *  - C13（深色）：必须读宿主**解析后**的 `body[data-ds-dark-theme]`（MutationObserver +
 *    useSyncExternalStore），13 组双写的 `@media (prefers-color-scheme: dark)` 孪生块必须
 *    删干净，深色规则只挂在 `.mt-*[data-theme="dark"]` 表面根上（不污染宿主 `:root`）。
 *  - C14（动效）：reduced-motion 覆盖率 8/8 —— 一条通配兜底覆盖全部 transition/animation，
 *    外加 `.mt-task-shake` 的静态 outline（H4 三通道：运动去掉、语义通道保留）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/** 取某个函数/常量的源码片段（从 `from` 到 `to`，找不到就是测试写错 → 直接炸） */
function sliceBetween(from: string, to: string): string {
  const start = source.indexOf(from)
  assert.ok(start >= 0, `源码里找不到起点：${from}`)
  const end = source.indexOf(to, start)
  assert.ok(end > start, `源码里找不到终点：${to}`)
  return source.slice(start, end)
}

test('t76r-1: C3 · loadProject 有请求序号（useRef 而非 useState，不额外渲染）', () => {
  assert.ok(source.includes('const loadSeqRef = useRefSafe(0)'), '序号用 ref 承载（useState 会多一轮渲染）')
  assert.ok(!/loadSeqRef\s*=\s*react\.useState/.test(source), 'loadSeq 不得用 useState')
  const body = sliceBetween('const loadProject = react.useCallback', '}, [discoveryApi, t])')
  assert.ok(body.includes('const seq = ++loadSeqRef.current'), '发请求前自增并快照序号')
  assert.ok(
    body.indexOf('const seq = ++loadSeqRef.current') < body.indexOf('getProject('),
    '序号必须在发请求**之前**取（否则并发时两次请求拿到同一个号）',
  )
})

test('t76r-2: C3 · 落库前双守卫（序号 + root 未变），且守卫在 setProject 之前', () => {
  const body = sliceBetween('const loadProject = react.useCallback', '}, [discoveryApi, t])')
  assert.ok(body.includes('seq !== loadSeqRef.current'), '序号守卫：旧响应被新请求顶掉')
  assert.ok(body.includes('root !== projectRootRef.current'), 'root 守卫：切项目时旧 root 的响应必须丢弃')
  assert.ok(body.includes('const stale = () =>'), '守卫收敛成一个 stale() 判据（两处调用同一口径）')
  const firstGuard = body.indexOf('if (stale()) return')
  assert.ok(firstGuard > 0, '成功分支有守卫')
  assert.ok(firstGuard < body.indexOf('setProject(p)'), '守卫必须在 setProject 之前（否则先写后判 = 白写）')
  /* 错误分支同样要守卫：过期响应的 error 也不能 setError（否则切项目后弹一个上一个项目的错） */
  const catchAt = body.indexOf('} catch (e) {')
  assert.ok(catchAt > 0, '有 catch 分支')
  const catchBody = body.slice(catchAt, body.indexOf('setError(String(e?.message ?? e))', catchAt))
  assert.ok(catchBody.includes('if (stale()) return'), '错误分支在 setError 之前也要守卫')
})

test('t76r-3: C3 · projectRoot 有渲染期镜像 ref（异步回调里读到的必须是当前值）', () => {
  assert.ok(source.includes('const projectRootRef = useRefSafe(projectRoot)'), 'projectRoot 镜像用 ref')
  const mirrorAt = source.indexOf('projectRootRef.current = projectRoot')
  assert.ok(mirrorAt > 0, '每次渲染把 projectRoot 同步进 ref')
  assert.ok(mirrorAt < source.indexOf('const loadProject = react.useCallback'), '镜像在 loadProject 之前就位')
})

test('t76r-4: C13 · 深色信号改读宿主 body[data-ds-dark-theme]（含老宿主降级）', () => {
  assert.ok(source.includes("const DARK_ATTRIBUTE = 'data-ds-dark-theme'"), '宿主信号源 = body[data-ds-dark-theme]')
  assert.ok(source.includes('body.hasAttribute(DARK_ATTRIBUTE)'), '快照读 body 属性')
  assert.ok(source.includes('new MutationObserver('), '订阅用 MutationObserver 监听 body 属性变化')
  assert.ok(source.includes('react.useSyncExternalStore'), '用 useSyncExternalStore 接进 React')
  assert.ok(source.includes('observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })'), '只监听主题属性')
  /* 降级是必需项：老宿主从不发布该属性 → 回退系统偏好 */
  assert.ok(source.includes('const systemPrefersDark = ()'), '系统偏好降级通道')
  assert.ok(source.includes('hostPublishesResolvedTheme()'), '先判「宿主是否发布解析后主题」再决定是否回退')
  /* 14 组双写的媒体查询孪生块必须删干净（只留 fallback 那一处 matchMedia 字面量） */
  const mediaQueries = source.match(/prefers-color-scheme/g) ?? []
  assert.ok(mediaQueries.length <= 2, `@media (prefers-color-scheme: dark) 孪生块应清零，实际残留 ${mediaQueries.length} 处`)
  assert.ok(!source.includes('@media (prefers-color-scheme'), '不允许再用媒体查询做深色覆盖（宿主手动切深色不触发）')
})

test('t76r-5: C13 · 深色规则只挂在 .mt-*[data-theme="dark"] 表面根上（不污染宿主 :root）', () => {
  assert.ok(source.includes('const DARK_SURFACE ='), '统一的表面根选择器常量')
  const SURFACE_RE = /:is\(\.mt-panel,\.mt-conv,\.mt-dockrow,\.mt-entry,\.mt-toolcard\)\[data-theme="dark"\]/
  assert.ok(SURFACE_RE.test(source), '表面根 = 面板各插槽的根节点（没有共同祖先，只能逐个挂）')
  assert.ok(!/^\s*':root\[data-theme/m.test(source), '不再往宿主 :root 上挂 data-theme（会污染面板之外）')
  const usages = source.match(/\$\{DARK_SURFACE\}/g) ?? []
  assert.ok(usages.length >= 13, `深色覆盖组应完整保留（实际 ${usages.length} 组，修复前 13 组 color-mix/color-scheme）`)
  /* 每个表面根组件都要把 data-theme 写出去，否则对应插槽里的覆盖不生效
   * CHG-104：未初始化引导改为**非阻塞横幅**，mt-panel 回到 6 处（不再有整屏空态）
   * CHG-107：团队视图两态（空态 / 有团队）各一个根，mt-conv 1 → 2 */
  for (const [cls, count] of [['mt-panel', 6], ['mt-conv', 2], ['mt-dockrow', 1], ['mt-toolcard', 3], ['mt-entry', 1]] as const) {
    const hits = source.match(new RegExp(`className: '${cls}', \\.\\.\\.themeAttr`, 'g')) ?? []
    assert.equal(hits.length, count, `${cls} 根节点都要带 data-theme（期望 ${count} 处，实际 ${hits.length} 处）`)
  }
})

test('t76r-6: C14 · reduced-motion 覆盖 8/8（通配兜底 + 抖动静态边框）', () => {
  const blocks = source.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? []
  assert.equal(blocks.length, 2, `只留两条：通配兜底 + .mt-task-shake 静态边框（实际 ${blocks.length} 条）`)
  assert.ok(
    source.includes('@media (prefers-reduced-motion: reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}'),
    '通配兜底：一次覆盖全部 transition（5 处）与 animation（3 个 @keyframes）',
  )
  assert.ok(
    source.includes('@media (prefers-reduced-motion: reduce){.mt-task-shake{animation:none;outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px}}'),
    '非法落点保留静态 outline —— H4 三通道：运动去掉，语义通道不能丢',
  )
  /* 逐条的 reduced-motion 块已删（改为通配），只剩上面两条 */
  assert.ok(!source.includes('prefers-reduced-motion: reduce){.mt-gate-spin'), 'gate-spin 由通配覆盖')
  assert.ok(!source.includes('prefers-reduced-motion: reduce){.mt-skeleton-dot'), 'skeleton 由通配覆盖')
  /* 5 处 transition 仍完整存在（删的是它们的 reduced-motion 覆盖，不是 transition 本身） */
  for (const cls of ['mt-toggle::after', 'mt-card2-hoverable', 'mt-team-card', 'mt-titem', 'mt-dag-card']) {
    assert.ok(source.includes(`.${cls}{`), `transition 选择器仍在：.${cls}`)
  }
})
