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
  // 防御：旧宿主 lib 没注册方法时不能调用
  assert.match(
    clientSource,
    /typeof discoveryApi\.getStoreState !== 'function'[\s\S]{0,120}?setStoreState\(undefined\)/,
    '缺方法时必须短路为 undefined（未知），否则调 undefined 会 throw 并卡死面板',
  )
  // 失败兜底必须是 undefined（未知 = 照常渲染），不是 null（null = 永久加载中）
  const effect = clientSource.slice(clientSource.indexOf('typeof discoveryApi.getStoreState'), clientSource.indexOf('}, [projectRoot, discoveryApi])'))
  assert.ok(effect.includes('.catch('), '必须有 catch 兜底')
  assert.match(effect, /catch\(\(\) => \{ if \(alive\) setStoreState\(undefined\) \}\)/, 'catch 必须降级为 undefined')
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
  assert.ok(pageReturn.includes('projectTabs,'), 'tab 必须照常渲染')
  assert.ok(pageReturn.includes('storeBanner,'), '横幅必须渲染进面板（topbar + tabs 之后）')
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
