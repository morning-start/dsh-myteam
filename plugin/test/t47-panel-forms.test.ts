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
  assert.match(source, /team\.new\.unavailable/)
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
  assert.match(source, /const structuralKeys = \['acceptanceCriteria', 'deps', 'requiredRole', 'gateChain', 'deliverableSpec'\]/)
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

test('t47-7: 没有团队的新项目也能进入项目作用域（工作区列表兜底，建队/建角色不被空数据卡死）', () => {
  assert.match(source, /const rootCandidates = react\.useMemo\(/)
  assert.match(source, /teamRoots\.length > 0\) return teamRoots\.sort\(\)/)
  assert.match(source, /workspaces\?\.list\?\.getSnapshot\?\.\(\)\?\.items/)
  assert.match(source, /const roots = rootCandidates/)
})
