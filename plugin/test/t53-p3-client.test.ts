/**
 * CHG-76（P3 收口）客户端契约：三块必须真的接上端点与两段确认，不能只画按钮。
 *
 *  A. 批量条三档下游策略（leave / cancel / rewire）+ 新上游下拉 + 三档影响面 + 已改挂汇总
 *  B. 任务页「批量新建」草稿抽屉：createTasks 预览（不带 confirm）→ 创建（confirm）→ notice
 *  C. 详情页诊断「一键修复」：assignable → assignTask / roleSwap → updateTask(requiredRole) / spawnRole 提示
 *
 * 静态契约（不依赖浏览器）+ 新增词条 zh/en 对等（缺 en 会直接显示 key）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('t53-1: A 批量改挂档 —— 三档策略 + 新上游下拉 + rewireTo 透传', () => {
  assert.match(source, /function BatchBar\(/, '批量条组件')
  // 三档单选（默认 leave；cancel 级联；rewire 改挂新上游）
  assert.ok(source.includes("['leave', 'cancel', 'rewire']"), '三档策略取值')
  assert.match(source, /const \[strategy, setStrategy\] = react\.useState\('leave'\)/)
  assert.match(source, /const \[rewireTo, setRewireTo\] = react\.useState\(''\)/)
  // rewire 档：选了具体上游才带 rewireTo；不选 = 解除依赖
  assert.match(source, /const rewireArgs = strategy === 'rewire' && rewireTo \? \{ rewireTo \} : \{\}/)
  assert.match(source, /\.\.\.\(op === 'cancel' \? \{ downstream: strategy, \.\.\.rewireArgs \} : \{\}\)/)
  // 确认请求也带同一档（两段确认）
  assert.match(source, /const r = await runBatch\('cancel', \{ reason: String\(reason\)\.trim\(\), downstream: strategy, \.\.\.rewireArgs \}, true\)/)
  // 门面请求透传
  assert.match(source, /if \(op === 'cancel' && extra\?\.downstream\) query\.downstream = extra\.downstream/)
  assert.match(source, /if \(op === 'cancel' && extra\?\.rewireTo\) query\.rewireTo = extra\.rewireTo/)
  // rewireTo 是单值：跨团队混选时这一档禁用（否则每个团队都收到同一个非法上游 → 整批 MT_VALIDATION）
  assert.match(source, /strategy === 'rewire' && ownerTeams\.length > 1/)
  assert.ok(source.includes("t('batch.rewireOneTeam')"), '跨团队改挂提示')
})

test('t53-2: A 新上游候选 —— 同团队、排除所选、排除 cancelled/failed、done 可选并标注', () => {
  const start = source.indexOf('const selectedIds = new Set(picked.map((task) => task.id))')
  assert.ok(start > 0, '候选计算存在')
  const body = source.slice(start, start + 900)
  assert.match(body, /ownerTeamSet\.has\(task\.ownerTeamId\) && !selectedIds\.has\(task\.id\)/, '同团队且不在所选集合')
  assert.ok(body.includes("!['cancelled', 'failed'].includes(String(task.state ?? ''))"), '排除 cancelled/failed')
  assert.match(body, /done: String\(task\.state \?\? ''\) === 'done'/, 'done 可选并标记')
  assert.ok(source.includes("t('batch.rewireDone')"), 'done 标注词条')
  assert.ok(source.includes("t('batch.rewireNone')"), '首项「不选：解除依赖」')
})

test('t53-3: A 三档影响面文案 + 改挂明细 + 已改挂 N 个任务（results.flatMap(rewired)）', () => {
  assert.match(source, /t\(strategy === 'cancel' \? 'batch\.impactCascade' : strategy === 'rewire' \? 'batch\.impactRewire' : 'batch\.impact'\)/)
  for (const key of ['batch.impact', 'batch.impactCascade', 'batch.impactRewire']) {
    assert.ok(source.includes(`'${key}'`), `缺词条 ${key}`)
  }
  // 实测形状：impact.rewireByTask = 每个所选任务各自要被改挂的直接下游
  assert.match(source, /rewireByTask: \[\.\.\.acc\.rewireByTask, \.\.\.\(item\?\.impact\?\.rewireByTask \?\? \[\]\)\]/)
  assert.ok(source.includes("t('batch.rewireByTask')"), '改挂明细标签')
  assert.ok(source.includes("t('batch.rewireNoDeps')"), '无直接下游文案')
  // 已改挂 = results.flatMap(r => r.rewired ?? []).length（added 缺省 = 解除依赖，同样计数）
  assert.match(source, /const rewiredCount = results\.flatMap\(\(item\) => \(Array\.isArray\(item\?\.rewired\) \? item\.rewired : \[\]\)\)\.length/)
  assert.match(source, /t\('batch\.rewiredDone'\)\.replace\('\{n\}', String\(rewiredCount\)\)/)
  // 逐条 results 必须带回（否则汇总不到 rewired）
  assert.match(source, /\{ kind: 'done', ok, failed: results\.length - ok, results \}/)
  // 整批拒绝（rewireTo 指向本批被取消任务）的 MT_VALIDATION message 原样显示
  assert.match(source, /const failureNotes = \[\.\.\.new Set\(results/)
  assert.ok(source.includes("t('batch.failedItems')"), '失败原因文案')
})

test('t53-4: B 批量新建 —— createTasks 门面、预览不带 confirm、创建带 confirm', () => {
  assert.match(source, /createTasks: \(query\) => call\('createTasks', query\)/, 'makeApi 暴露 createTasks（会话门面）')
  assert.match(source, /function BatchCreateDrawer\(/, '抽屉组件')
  assert.match(source, /const callCreate = \(confirm\) => makeApi\(connection, team\.sessionId\)\.createTasks\(\{/)
  assert.match(source, /\.\.\.\(confirm \? \{ confirm: true \} : \{\}\)/, '只有创建才带 confirm')
  assert.match(source, /const r = await callCreate\(false\)/, '预览不带 confirm')
  assert.match(source, /const r = await callCreate\(true\)/, '创建带 confirm')
  // 行号 → after[]（本批 1-based）；非数字 → 既有任务 id
  assert.match(source, /\.\.\.\(after\.length > 0 \? \{ after \} : \{\}\)/)
  assert.match(source, /\.\.\.\(ids\.length > 0 \? \{ deps: ids \} : \{\}\)/)
  assert.match(source, /n <= rows\.length && n !== index \+ 1/, 'after 只接受本批行号且排除自己')
  // 实测形状：rolesMissing 会在创建时逐条失败（requiredRole 不在名册），文案必须说清
  assert.match(source, /t\('batchCreate\.rolesMissing'\)\.replace\('\{roles\}', \(impact\.rolesMissing \?\? \[\]\)/)
  // 预览 impact.warnings 是逐条带序号的字符串（服务端自动补齐 AC/交付物），一条一行列出
  assert.match(source, /\.\.\.\(impact\.warnings \?\? \[\]\)\.map\(\(item, i\) => j\('span', \{ key: `\$\{i\}`, children: String\(item\) \}\)\)/)
  // 确认响应部分失败不中断：逐条 results（index/ok/code/message）把失败原因并进 notice
  assert.match(source, /const failureNotes = \[\.\.\.new Set\(\(r\.results \?\? \[\]\)/)
  assert.ok(source.includes("'batchCreate.failedItems'"), '失败条目文案')
})

test('t53-5: B 草稿行可增删 + 抽屉互斥 + 工具条入口 + 成功 notice', () => {
  // 行一改就清掉旧预览（避免"看着过期影响面点创建"）
  assert.match(source, /const addRow = \(\) => \{ setImpact\(null\); return setRows\(\(prev\) => \[\.\.\.prev, newBatchDraftRow/)
  assert.match(source, /const removeRow = \(key\) => \{ setImpact\(null\); return setRows\(\(prev\) => \(prev\.length <= 1 \? prev : prev\.filter/)
  assert.match(source, /const updateRow = \(key, patch\) => \{ setImpact\(null\); return setRows\(/)
  assert.match(source, /const \[batchCreate, setBatchCreate\] = react\.useState\(false\)/, '复用既有状态（不引入新状态库）')
  assert.match(source, /const openBatchCreator = \(\) => \{ setBatchCreate\(true\); setTaskForm\(null\); setRoleForm\(null\); setTeamCreate\(false\); setOpenRole\(null\); setOpenTask\(null\) \}/)
  // 既有 opener 也要关掉批量新建（互斥）
  assert.match(source, /const openTaskEditor = \(form\) => \{ setTaskForm\(form\); setRoleForm\(null\); setTeamCreate\(false\); setOpenRole\(null\); setOpenTask\(null\); setBatchCreate\(false\) \}/)
  assert.match(source, /const closeDrawers = \(\) => \{ setTeamCreate\(false\); setRoleForm\(null\); setTaskForm\(null\); setBatchCreate\(false\) \}/)
  assert.match(source, /batchCreate \? j\(BatchCreateDrawer, \{/)
  assert.match(source, /children: t\('tasks\.newBatch'\)/, '工具条「批量新建」')
  assert.match(source, /const onBatchCreated = async \(message\) => \{/, '创建成功回调')
  assert.match(source, /t\('batchCreate\.done'\)\.replace\('\{n\}', String\(created\)\)\.replace\('\{failed\}', String\(failed\)\)/)
})

test('t53-6: C 诊断一键修复 —— assignable / roleSwap / spawnRole 三分支', () => {
  assert.match(source, /function DiagFix\(/, '一键修复组件')
  assert.match(source, /const assignable = fix\.assignable \?\? \[\]/)
  assert.match(source, /const roleSwap = fix\.roleSwap \?\? \[\]/)
  assert.match(source, /const spawnRole = fix\.spawnRole/)
  // assignable → assignTask（单选一个成员）
  assert.match(source, /const r = await api\.assignTask\(\{ teamId, taskId, memberIds: \[option\.memberId\] \}\)/)
  assert.ok(source.includes("t('diag.fixAssign')"), '一键指派按钮文案')
  // roleSwap → updateTask patch {requiredRole}（选中即改）
  assert.match(source, /const r = await api\.updateTask\(\{ teamId, taskId, patch: \{ requiredRole: roleId \} \}\)/)
  assert.ok(source.includes("t('diag.fixRoleSwapOption')"), '角色下拉（含空闲数）')
  // spawnRole → 纯提示（不自动执行）
  assert.ok(source.includes("t('diag.fixSpawn')") && source.includes("t('diag.fixSpawnHint')"), '去召唤提示')
  // 实测形状：assignable / roleSwap / spawnRole 可能同时存在（deps-pending 时 assignable 也可能非空）→ 不互斥
  assert.ok(!source.includes('spawnRole && assignable.length === 0 && roleSwap.length === 0'), '三者不得互相排斥')
  // spawnRole 独立渲染；措辞按诊断码分（no-role = 名册缺人 / role-busy = 增援）
  assert.match(source, /spawnRole\s*\n\s*\? \(\(\) => \{/, 'spawnRole 独立渲染')
  assert.match(source, /const roleBusy = \(diagnosis\?\.codes \?\? \[\]\)\.includes\('role-busy'\)/, 'role-busy 与 no-role 措辞分开')
  assert.ok(source.includes("t('diag.fixReinforce')") && source.includes("t('diag.fixReinforceHint')"), '增援措辞')
  assert.ok(!/api\.(spawn|createMember|memberOp)\(/.test(source.slice(source.indexOf('function DiagFix('), source.indexOf('function DiagFix(') + 4000)), 'spawnRole 不触发写调用')
  // 详情页渲染 + 修复成功后刷新
  assert.match(source, /j\(DiagFix, \{ t, api, teamId, taskId, diagnosis: detail\.diagnosis, readOnly, onFixed: onDiagnosisFixed \}\)/)
  assert.match(source, /const onDiagnosisFixed = async \(message\) => \{/)
})

test('t53-7: 离线/只读 —— 批量新建与一键修复都禁用并给 title', () => {
  // 工具条按钮：没有在线团队 → disabled，title 用离线说明
  assert.match(source, /disabled: \(pv\.teams \?\? \[\]\)\.filter\(\(team\) => team\.online && team\.sessionId\)\.length === 0/)
  assert.match(source, /title: \(pv\.teams \?\? \[\]\)\.some\(\(team\) => team\.online && team\.sessionId\) \? t\('batchCreate\.title'\) : t\('batchCreate\.offline'\)/)
  // 抽屉内预览/创建按钮同样禁用
  assert.match(source, /j\('button', \{ className: 'mt-btn', disabled: busy \|\| !online, onClick: preview, children: busy \? t\('state\.loading'\) : t\('batchCreate\.preview'\) \}\)/)
  assert.match(source, /j\('button', \{ className: 'mt-btn mt-btn-primary', disabled: busy \|\| !online, onClick: submit, children: busy \? t\('state\.loading'\) : t\('batchCreate\.submit'\) \}\)/)
  // 一键修复：只读 → disabled + 只读 title
  assert.match(source, /const tip = readOnly \? t\('task\.readonlyTitle'\) : undefined/)
  assert.match(source, /disabled: readOnly \|\| busy,/)
  assert.match(source, /title: tip \?\? t\('diag\.fixAssign'\)/)
})

test('t53-8: 未新增门面端点（只加 createTasks），其余复用既有端点', () => {
  assert.ok(!/myteam\/(rewireBatch|batchRewire|fixTask|batchCreateTasks|autoFix)/.test(source), '不得新增门面端点')
  for (const method of ['batchTaskOp', 'assignTask', 'updateTask']) {
    assert.ok(source.includes(`${method}: (query) => call('${method}', query)`), `${method} 复用既有门面`)
  }
  assert.ok(source.includes("createTasks: (query) => call('createTasks', query)"), '唯一新增：createTasks')
})

test('t53-9: CHG-76 新增词条 zh/en 对等', () => {
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('/* ── M2 RPC', enStart)
  assert.ok(zhStart >= 0 && enStart > zhStart && enEnd > enStart, '词典切片可定位')
  const keysOf = (text) => new Set([...text.matchAll(/^\s+'([^']+)':/gm)].map((match) => match[1]))
  const zh = keysOf(source.slice(zhStart, enStart))
  const en = keysOf(source.slice(enStart, enEnd))
  const added = [...zh].filter((key) => /^(batch\.(leave|rewire|rewireTo|rewireNone|rewireDone|rewireHint|impactRewire|rewiredDone)|tasks\.newBatch|batchCreate\.|diag\.fix)/.test(key))
  assert.ok(added.length >= 40, `CHG-76 新增词条应成组出现，实际 ${added.length}`)
  const missing = added.filter((key) => !en.has(key))
  assert.deepEqual(missing, [], `en 缺词条：${missing.join(', ')}`)
})

test('t53-10: 新增 UI 只用宿主 token 且窄容器不横向溢出（flex-wrap / auto-fit / max-width）', () => {
  const start = source.indexOf("'.mt-diag-fix{")
  assert.ok(start > 0, '诊断修复样式存在')
  const css = source.slice(start, start + 1400)
  assert.match(css, /var\(--dsw-alias-/)
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), '新增样式不应出现硬编码 hex 颜色')
  assert.match(css, /\.mt-diag-fix\{[^}]*flex-wrap:wrap/, '诊断修复区可换行')
  assert.match(css, /\.mt-drawgrid\{[^}]*repeat\(auto-fit,minmax\(/, '草稿行等宽栅格自适应')
  assert.match(css, /\.mt-diag-fix \.mt-select\{[^}]*max-width:100%/, '下拉不超宽')
})
