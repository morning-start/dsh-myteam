/**
 * CHG-72（FR-26/27/29/30/31）客户端契约：面板内闭环入口必须真的接上端点与预填会话，
 * 不能只是画了几个按钮。
 *
 * 静态契约（不依赖浏览器）+ 词表对等（zh/en 同一批 key，缺 en 会回落到 key 本身）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('t47-1: 面板写入口接上网关端点（saveRole / createTask / updateTask / assignTask / participateTask）', () => {
  // 角色写 = 根级端点（只带 workspaceRoot）；任务写 = 会话门面（call 拼 myteam/<method>，带 agentId）
  assert.match(source, /saveRole: \(query\) => rpcCall\(connection, 'myteam\/saveRole', \{ query \}\)/)
  for (const method of ['createTask', 'updateTask', 'assignTask', 'participateTask']) {
    assert.match(source, new RegExp(`${method}: \\(query\\) => call\\('${method}', query\\)`), `${method} 必须走会话门面端点`)
  }
})

test('t47-2: 建队引导 = 打开团队模式会话 + 预填首条消息（不新增建队写路径）', () => {
  assert.match(source, /agentPreset: 'myteam-captain'/)
  assert.match(source, /startSession\(target\.workspaceId, \{ agentPreset: 'myteam-captain', prompt, whenDraftExists: 'replace' \}\)/)
  assert.match(source, /myteam_submit_plan 提交草稿/)
  // uiWorkspace 是「未 inject 就抛错」的 cordis 服务属性，必须经 ctx.get 取（否则按钮点了没反应）
  assert.match(source, /ctx\.get\('uiWorkspace'\)/)
  // 工作区入口缺失时降级为「复制指令」，不能静默失败
  // CHG-202g：词条已由 `team.new.unavailable` 更名为 `g6.wizard.unavailable`（建队向导 G6 那一版），
  // 旧 key 只剩两张表里的定义、没有任何渲染点——按死词条删除，断言跟着改成现名。
  assert.match(source, /g6\.wizard\.unavailable/)
  assert.match(source, /copyText\(prompt\)/)
})

test('t47-3: 角色表单 / 任务表单 / 建队引导三抽屉存在，且角色表单带两段确认提示', () => {
  assert.match(source, /function RoleFormDrawer\(/)
  assert.match(source, /function TaskFormDrawer\(/)
  assert.match(source, /function TeamCreateDrawer\(/)
  assert.match(source, /result\?\.status === 'confirm-required'/)
  assert.match(source, /role\.confirmOverwrite/)
  assert.match(source, /interestWords: split\(interest\)\.slice\(0, 8\)/)
})

test('t47-4: 任务表单的结构守卫提示 + 只保存元数据出口（避免静默丢字段）', () => {
  /* CHG-202x（P1-1）：`verifyCommand` 也是任务定义的一部分（改它同样要在跑任务走 rescope 出口） */
  assert.match(source, /const structuralKeys = \['acceptanceCriteria', 'deps', 'requiredRole', 'gateChain', 'deliverableSpec', 'verifyCommand'\]/)
  assert.match(source, /if \(running && structuralKeys\.length > 0 && !metaOnly\)/)
  assert.match(source, /task\.saveMetaOnly/)
  assert.match(source, /task\.structuralBlocked/)
})

test('t47-5: 无人可领诊断在卡片/列表/详情三处渲染，四类原因都有词条', () => {
  assert.match(source, /function DiagChips\(/)
  assert.match(source, /j\(DiagChips, \{ t, diagnosis: task\.diagnosis \}\)/)
  assert.match(source, /j\(DiagChips, \{ t, diagnosis: detail\.diagnosis \}\)/)
  for (const key of ['diag.team-inactive', 'diag.deps-pending', 'diag.no-role', 'diag.role-busy']) {
    assert.ok(source.includes(`'${key}'`), `缺词条 ${key}`)
  }
  assert.match(source, /\.mt-diag-chip\{/)
})

test('t47-6: 新增词条 zh/en 对等（缺失时界面会直接显示 key）', () => {
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('/* ── M2 RPC 通道', enStart)
  assert.ok(zhStart >= 0 && enStart > zhStart && enEnd > enStart, '词典切片可定位')
  const keysOf = (text) => new Set([...text.matchAll(/^\s+'([^']+)':/gm)].map((match) => match[1]))
  const zh = keysOf(source.slice(zhStart, enStart))
  const en = keysOf(source.slice(enStart, enEnd))
  const added = [...zh].filter((key) => /^(team\.(new|draft)|role\.(new|edit|fork|formTitle|confirmOverwrite|saveHint|builtinReadonly|invalid|saved)|task\.(new|edit|save|field\.|formTitle|needOnline|created|updated|structuralBlocked|saveMetaOnly|formHint|noTeam)|diag\.)/.test(key))
  assert.ok(added.length >= 20, `新增词条应成组出现，实际 ${added.length}`)
  const missing = added.filter((key) => !en.has(key))
  assert.deepEqual(missing, [], `en 缺词条：${missing.join(', ')}`)
})

test('t47-7: 项目视图只认会话工作目录——没有项目候选兜底（CHG-202b）', () => {
  /* 用户定案：「会话模式下的 UI 应该自己打开当前会话所在工作目录的位置，而不是什么能指定的
   * 项目位置」。
   *
   * 所以这里从「断言候选兜底存在」翻成「断言它被删掉」：项目根**只能**来自
   * `getProjectScope()`（会话 → 工作目录）。留着 `rootCandidates` 就是留了第二真源——
   * 解析不出时会静默打开别人家的工作区，用户以为自己在看本项目（「所有项目看起来都一样」）。
   * 没有团队的新项目照样能建队/建角色：那是**空数据**，不是「换一个项目」。 */
  assert.doesNotMatch(source, /const rootCandidates = react\.useMemo\(/, '项目候选列表必须删除（第二真源）')
  assert.doesNotMatch(source, /const roots = rootCandidates/, '不能再用候选列表渲染项目下拉')
  assert.doesNotMatch(source, /setProjectRoot\(rootCandidates\[0\]\)/, '不能拿候选列表第一个顶上')
  assert.match(source, /getProjectScope: \(\) => rpcCall\(connection, 'myteam\/getProjectScope', \{ agentId: sessionId \}\)/, '项目根只能来自会话解析')
  assert.match(source, /className: 'mt-project-name'/, '顶部只读展示项目名（不给切换入口）')
  assert.match(source, /'project\.unresolved'/, '解析不出工作目录时如实说，不猜项目')
})
