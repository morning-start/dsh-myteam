/**
 * T85（CHG-104）：面板「加载不出来」的回归锁。
 *
 * 用户反馈原话：「myteam 的 UI 怎么加载不出来？……有过很多次这个错误了」。
 *
 * 根因（这次）：CHG-102 给**服务端门面**加了 `getStoreState` / `initStore`，
 * 但**客户端的 `makeApi` 名字表没加** → `discoveryApi.getStoreState` 是 `undefined`
 * → 调用即 TypeError → `.catch` 里 `setStoreState(null)` → 面板整屏停在「加载中」，
 * 没有出口。这类「两端方法表不同步」的错误已经反复出现，必须用测试锁死。
 *
 * 本文件锁四件事：
 *  ① **服务端 marker ⊆ 客户端 api 表**（漏一个就红）；
 *  ② 存储状态读取**不得阻塞渲染**（没有 `storeState === null` 的 early return）；
 *  ③ 读取失败/方法缺失必须**降级为「未知」**（undefined），不能变成永久加载；
 *  ④ 未初始化时是**横幅**（`storeBanner`），tab 内容照常渲染。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MyTeamPanelFacade } from '../src/panel.ts'

const DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

/** 服务端门面声明的所有远程方法名 */
function serverMethods(): string[] {
  const descriptor = (MyTeamPanelFacade.prototype as unknown as Record<string, { methods: Array<{ method: string }> }>)[DESCRIPTOR]
  assert.ok(descriptor, '门面必须带 remote-methods 描述符')
  return descriptor.methods.map((entry) => entry.method)
}

/** 客户端 makeApi 返回对象上声明的键（只取 `名字: (` 形态） */
function clientApiMethods(): string[] {
  const start = clientSource.indexOf('function makeApi(')
  assert.ok(start > 0, '找不到 makeApi')
  // 从 `return {` 起算到配对的 `}`（顶层缩进 6 空格的收尾）
  const returnAt = clientSource.indexOf('return {', start)
  assert.ok(returnAt > start, 'makeApi 必须 return 一个 api 对象')
  const body = clientSource.slice(returnAt, clientSource.indexOf('\n    }', returnAt))
  const names = new Set<string>()
  for (const match of body.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*)\s*:/gm)) names.add(match[1])
  return [...names]
}

test('t85-1: 服务端每个门面方法都必须在客户端 api 表里（漏一个 = UI 卡死在加载中）', () => {
  const server = new Set(serverMethods())
  const client = new Set(clientApiMethods())
  assert.ok(server.size > 30, `服务端方法数异常：${server.size}`)
  const missing = [...server].filter((name) => !client.has(name))
  assert.deepEqual(missing, [], `客户端 makeApi 缺少这些方法（调用即 TypeError）：${missing.join(', ')}`)
})

test('t85-2: 客户端 api 表不得发明服务端没有的方法（反向漂移同样是 bug）', () => {
  const server = new Set(serverMethods())
  const extra = clientApiMethods().filter((name) => !server.has(name))
  assert.deepEqual(extra, [], `客户端调用了服务端不存在的门面方法：${extra.join(', ')}`)
})

test('t85-3: 存储状态读取失败 → 降级为「未知」，不得变成永久加载', () => {
  /* CHG-164（报告 A3）：取数已并入 `loadProject`（首屏 batch + 降级并行），不再有独立的
   * `useEffect(() => … getStoreState …)`。**不变量不变**：方法缺失/调用失败都必须短路成
   * `undefined`（未知 = 照常渲染），不能是 `null`（= 永久「加载中」）。
   * 断言从「按字面量切片」改为「按不变量」：先定位 `loadProject` 里的存储状态分支。 */
  assert.match(
    clientSource,
    /!hasEndpoint\('getStoreState'\)\) \{ setStoreState\(undefined\); return \}/,
    '缺方法时必须短路为 undefined（未知），否则调 undefined 会 throw 并卡死面板',
  )
  // 失败兜底必须是 undefined（未知 = 照常渲染），不是 null（null = 永久加载中）
  const start = clientSource.indexOf("if (!hasEndpoint('getStoreState'))")
  assert.ok(start > 0, '找不到存储状态降级分支')
  const effect = clientSource.slice(start, start + 600)
  assert.ok(effect.includes('.catch('), '必须有 catch 兜底')
  assert.match(effect, /catch\(\(\) => \{ if \(!stale\(\)\) setStoreState\(undefined\) \}\)/, 'catch 必须降级为 undefined')
  assert.ok(!effect.includes('setStoreState(null)'), '不得再把失败写成 null（null 会渲染成永久「加载中」）')
})

test('t85-4: 面板不得因为存储状态 early return（未初始化也要能看）', () => {
  // 修复前的两处整屏 return：`storeState === null` 与 `initialized === false`
  assert.ok(
    !/if \(scope === 'project' && storeState === null\) \{/.test(clientSource),
    'storeState 未知时不得整屏替换成「加载中」',
  )
  assert.ok(
    !/if \(scope === 'project' && storeState && storeState\.initialized === false\) \{\s*return/.test(clientSource),
    '未初始化时不得整屏 return（用户要求：空团队项目也要能展示）',
  )
  // 必须是横幅，而且真的挂在页面上
  assert.match(clientSource, /const storeBanner = scope === 'project' && storeState && storeState\.initialized === false/, '需要非阻塞横幅')
  const contentAt = clientSource.indexOf('const content = projectTab')
  assert.ok(contentAt > 0, '找不到项目内容选择')
  // 从「内容选择」往后取到工作区容器（注意：mt-workspace 在文件别处也出现过，必须带起点）
  const pageReturn = clientSource.slice(contentAt, clientSource.indexOf('mt-workspace', contentAt))
  /* CHG-202d：tab 条并进顶栏那一行了（`projectTabs` 成了 `topbar` 的第一个孩子），
   * 面板根上不再单独渲染 `projectTabs,`——断言「顶栏渲染了」+「tab 确实在顶栏里」。 */
  assert.ok(pageReturn.includes('topbar,'), '顶栏必须照常渲染')
  assert.match(clientSource, /className: 'mt-topbar', children: \[\s*\n?\s*projectTabs,/, 'tab 必须并进顶栏那一行（CHG-202d）')
  assert.ok(pageReturn.includes('storeBanner,'), '横幅必须渲染进面板（topbar 之后）')
})

test('t85-5: 未初始化横幅提供「初始化」出口，且初始化是幂等的项目级写', () => {
  assert.ok(clientSource.includes("t('store.init')"), '横幅必须有初始化按钮')
  assert.match(clientSource, /const initStore = async \(\) => \{[\s\S]{0,400}?discoveryApi\.initStore\(\{ workspaceRoot: projectRoot \}\)/, '初始化必须调 initStore 端点')
  assert.ok(clientSource.includes("'store.emptyTitle'"), '横幅标题词条')
  assert.ok(clientSource.includes("'role.scope.global'"), 'CHG-103 作用域词条仍在')
})

test('t85-6: 横幅样式存在且不与既有选择器重名（t62-10 守门的前提）', () => {
  for (const cls of ['.mt-banner-info{', '.mt-banner-text{', '.mt-banner-path{']) {
    const hits = clientSource.split(cls).length - 1
    assert.equal(hits, 1, `${cls} 必须恰好定义一次（实际 ${hits}）`)
  }
})

test('t85-7: describe 能力协商——返回宿主真实方法表，客户端据此降级（CHG-111）', async () => {
  const facade = new MyTeamPanelFacade({ agents: { list: () => [] }, logger: { info() {}, warn() {} } })
  const result = await facade.describe({ workspaceRoot: 'C:\\ws' })
  assert.equal(result.status, 'ok')
  assert.ok(result.version >= 1, '协议版本')
  assert.ok(Array.isArray(result.methods) && result.methods.length >= 40, '方法表非空')
  assert.ok(result.methods.includes('describe'), '自己也在表里（可自描述）')
  assert.ok(result.methods.includes('reloadContributions'), '旧方法仍在（只增不减）')
  assert.equal(result.count, result.methods.length, 'count 与方法表一致')
  // 客户端 api 表必须包含 describe（否则协商本身调不到）
  const api = clientApiMethods()
  assert.ok(api.includes('describe'), '客户端 makeApi 必须暴露 describe')
})

test("t85-8: batch 批量调用——逐条返回、未知方法只坏一条、agent 作用域方法拒绝（CHG-112）", async () => {
  const facade = new MyTeamPanelFacade({ agents: { list: () => [] }, logger: { info() {}, warn() {} } })
  const ok = await facade.batch({ calls: [{ kind: "describe", args: {} }, { kind: "getStoreState", args: { workspaceRoot: "C:\\ws" } }] })
  assert.equal(ok.status, "ok")
  assert.equal(ok.results.length, 2, "逐条返回")
  assert.equal(ok.results[0].ok, true, "describe 成功")
  assert.equal(ok.results[1].ok, true, "getStoreState 成功")
  const bad = await facade.batch({ calls: [{ kind: "noSuchMethod" }, { kind: "getBoard" }, { kind: "describe" }] })
  assert.equal(bad.status, "ok", "整体不失败")
  assert.equal(bad.results[0].ok, false)
  assert.equal(bad.results[0].error.code, "MT_BATCH_NOT_ROOT", "未知/非根级方法只坏这一条")
  assert.equal(bad.results[1].ok, false, "getBoard 是 agent 作用域，批里不许调")
  assert.equal(bad.results[2].ok, true, "其它条不受影响")
  const empty = await facade.batch({ calls: [] })
  assert.equal(empty.status, "error")
  assert.equal(empty.code, "MT_VALIDATION")
  assert.ok(clientApiMethods().includes("batch"), "客户端 makeApi 必须暴露 batch")
})

test('t85-9: watch 长轮询——新事件立刻返回 / 无事件超时空返回 / 非法参数拒绝（CHG-113）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync: wf } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mt85watch-'))
  const ledgerDir = join(root, '.dsh-myteam', 'tasks', 't-watch')
  mkdirSync(ledgerDir, { recursive: true })
  const ledger = join(ledgerDir, 'ledger.jsonl')
  wf(ledger, [
    JSON.stringify({ seq: 1, ts: 1, type: 'team.created', payload: { teamId: 't-watch' } }),
    JSON.stringify({ seq: 2, ts: 2, type: 'task.created', payload: { taskId: 'a' } }),
    '',
  ].join('\n'), 'utf8')

  const facade = new MyTeamPanelFacade({ agents: { list: () => [] }, logger: { info() {}, warn() {} } })

  // ① sinceSeq=0 → 立刻返回全部事件（changed:true）
  const fresh = await facade.watch({ workspaceRoot: root, teamId: 't-watch', sinceSeq: 0, timeoutMs: 500 })
  assert.equal(fresh.status, 'ok')
  assert.equal(fresh.changed, true, '有新事件立刻返回')
  assert.equal(fresh.events.length, 2, '两条事件都带回')
  assert.ok(fresh.seq >= 2, 'seq 单调到最新')

  // ② 追平后 → 挂到超时再返回 changed:false（空事件）
  const idle = await facade.watch({ workspaceRoot: root, teamId: 't-watch', sinceSeq: fresh.seq, timeoutMs: 250 })
  assert.equal(idle.status, 'ok')
  assert.equal(idle.changed, false, '无新事件时超时空返回')
  assert.deepEqual(idle.events, [], '不重复回旧事件')

  // ③ 非法参数
  const badSeq = await facade.watch({ workspaceRoot: root, teamId: 't-watch', sinceSeq: -1 })
  assert.equal(badSeq.status, 'error')
  assert.equal(badSeq.code, 'MT_VALIDATION')
  const badTeam = await facade.watch({ workspaceRoot: root, teamId: '../etc' })
  assert.equal(badTeam.status, 'error', '路径穿越拒绝')
  const noRoot = await facade.watch({ teamId: 't-watch' })
  assert.equal(noRoot.status, 'error', '缺 workspaceRoot 拒绝')

  // ④ 客户端必须暴露 watch，且 watch 是根级方法（可进 batch）
  assert.ok(clientApiMethods().includes('watch'), '客户端 makeApi 必须暴露 watch')
  const batched = await facade.batch({ calls: [{ kind: 'watch', args: { workspaceRoot: root, teamId: 't-watch', sinceSeq: 2, timeoutMs: 200 } }] })
  assert.equal(batched.results[0].ok, true, 'watch 可进 batch（根级方法）')
})

test('t85-10: 面板与团队视图都用 watch 自动追平（5s 轮询降级为回退）（CHG-113）', () => {
  // ① 面板：watch 循环存在，且 5s 轮询只在「宿主没有 watch」时启用
  assert.ok(
    /if \(typeof discoveryApi\.watch !== 'function'\) return undefined/.test(clientSource),
    '面板：没有 watch 时直接返回（不重复轮询）',
  )
  assert.ok(
    /const r = await discoveryApi\.watch\(\{[^}]*workspaceRoot: projectRoot, teamId,[^}]*sinceSeq: since, timeoutMs: 20000 \}\)/.test(clientSource),
    '面板：watch 循环带 sinceSeq/timeoutMs',
  )
  assert.ok(
    /if \(r\?\.changed\) \{\s*await loadProject\(projectRoot\)/.test(clientSource),
    '面板：changed 才重拉看板（空闲零请求）',
  )
  // ② 回退分支：只有无 watch 才起 setInterval
  const fallbackAt = clientSource.indexOf('回退：只有宿主没有')
  assert.ok(fallbackAt > 0, '回退注释存在')
  const fallback = clientSource.slice(fallbackAt, clientSource.indexOf('}, [loadTeams, loadProject, projectRoot, discoveryApi])'))
  assert.ok(fallback.includes("if (typeof discoveryApi.watch === 'function') return undefined"), '回退分支必须有守卫')
  assert.ok(fallback.includes('setInterval(tick, POLL_MS)'), '回退分支保留 5s 轮询')
  // ③ 团队视图：useConvBoard 由 watch 推进 tick
  assert.ok(
    /const api = makeApi\(connection, sessionId\)[\s\S]{0,200}?if \(typeof api\.watch !== 'function'\) return undefined/.test(clientSource),
    '团队视图：无 watch 时保持一次性加载',
  )
  assert.ok(
    /* CHG-155：变化分支 push 完 tick 直接 continue；未变化时必须退避（MIN_POLL_MS） */
    /if \(r\?\.changed\) \{ setTick\(\(value\) => value \+ 1\); continue \}/.test(clientSource),
    '团队视图：changed 推进 tick 重拉',
  )
  assert.ok(
    /if \(elapsed < MIN_POLL_MS\) await sleep\(MIN_POLL_MS - elapsed\)/.test(clientSource),
    '团队视图：未变化时至少隔 MIN_POLL_MS（CHG-155 紧循环回归锁）',
  )
  // ④ 两处都要在后台暂停（不请求网关）
  const hiddenCount = (clientSource.match(/if \(isHidden\(\)\) \{ await sleep\(1000\); continue \}/g) ?? []).length
  assert.equal(hiddenCount, 2, '面板与团队视图都要在 hidden 时暂停（实际 ' + hiddenCount + ' 处）')
})
