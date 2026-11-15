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

test('t53-4: B 批量新建抽屉已移除，但 createTasks 门面仍在（供队长/CLI 用）', () => {
  // CHG-202v：用户定案「任务不能手动建」→ 抽屉连同 74-batch.js 整个删除。
  // 这里只保留「会话门面暴露 createTasks」这一条契约（它不是 UI，是 RPC 能力）。
  assert.match(source, /createTasks: \(query\) => call\('createTasks', query\)/, 'makeApi 暴露 createTasks（会话门面）')
  assert.ok(!source.includes('function BatchCreateDrawer'), '抽屉组件已删除')
  assert.ok(!source.includes("t('batchCreate."), '批量新建词条已无渲染点')
})

test('t53-5: B 任务页不再有任何手动创建入口', () => {
  // CHG-202u（用户定案「任务不能手动建，但是可以手动删除」）：三个创建入口全部移除
  assert.ok(!source.includes("children: t('tasks.newBatch')"), '工具条不再有「批量新建」入口')
  assert.ok(!source.includes("children: t('task.new')"), '工具条不再有「新建任务」入口')
  assert.ok(!/onAdd: \(\) => \{[\s\S]{0,400}?openTaskEditor\(\{ mode: 'create'/.test(source), '列头「＋」直达新建已移除')
  // 抽屉状态机也一并删除（CHG-202v）
  assert.ok(!source.includes('const [batchCreate, setBatchCreate] = react.useState(false)'), 'batchCreate 状态已删除')
  assert.ok(!source.includes('const openBatchCreator = '), 'openBatchCreator 已删除')
  assert.ok(!source.includes('const onBatchCreated = '), 'onBatchCreated 已删除')
  // CHG-202x（P0-1）：删除能力**真实现**了（t145 用真账本 + 真渲染锁住）。
  // 这里不再拿「源码里出现某个字符串」当证据——那正是当初的假绿：
  // 唯一匹配那条注释的地方就是它自己，能力一行都没实现。
  assert.ok(source.includes("t('detail.deleteTaskBtn')"), '任务详情必须有删除按钮')
  assert.match(source, /onDelete: openTask\.online \? deleteTaskFlow : undefined/, '删除写路径必须接到队长会话')
})

test('t53-6: C 诊断一键修复 —— assignable / roleSwap / spawnRole 三分支', () => {
  assert.match(source, /function DiagFix\(/, '一键修复组件')
  assert.match(source, /const assignable = fix\.assignable \?\? \[\]/)
  assert.match(source, /const roleSwap = fix\.roleSwap \?\? \[\]/)
  assert.match(source, /const spawnRole = fix\.spawnRole/)
  // assignable → assignTask（单选一个成员）；CHG-89：与编辑表单共用同一份版本快照
  assert.match(source, /const r = await api\.assignTask\(\{[\s\S]{0,260}?memberIds: \[option\.memberId\],[\s\S]{0,260}?expectedRevision/)
  assert.ok(source.includes("t('diag.fixAssign')"), '一键指派按钮文案')
  // roleSwap → updateTask patch {requiredRole}（选中即改）；CHG-89：同样回传 expectedRevision
  assert.match(source, /const r = await api\.updateTask\(\{[\s\S]{0,260}?patch: \{ requiredRole: roleId \},[\s\S]{0,260}?expectedRevision/)
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
  assert.match(source, /j\(DiagFix, \{ t, api, teamId, taskId, diagnosis: detail\.diagnosis, readOnly, onFixed: onDiagnosisFixed, expectedRevision: detail\.revision \}\)/)
  assert.match(source, /const onDiagnosisFixed = async \(message\) => \{/)
})

test('t53-7: 离线/只读 —— 一键修复的禁用与 title', () => {
  // CHG-202u/v：工具条的新建入口与批量新建抽屉都已整块删除（任务由队长规划）
  assert.ok(!source.includes("className: 'mt-taskhead-actions'"), '工具条动作区已删除')
  assert.ok(!source.includes("t('batchCreate."), '批量新建词条已无渲染点')
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
  // CHG-202v：`batchCreate.*` 与 `tasks.newBatch` 已随批量新建抽屉一起删除，
  // 这里只复核**仍在用**的那批词条 zh/en 对等。
  const added = [...zh].filter((key) => /^(batch\.(leave|rewire|rewireTo|rewireNone|rewireDone|rewireHint|impactRewire|rewiredDone)|diag\.fix)/.test(key))
  assert.ok(added.length >= 8, `CHG-76 词条应成组出现，实际 ${added.length}`)
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
  // CHG-202v：`.mt-drawgrid` 随批量新建抽屉删除（死 CSS 清理）
  assert.ok(!css.includes('.mt-drawgrid{'), '草稿栅格样式已随抽屉删除')
  assert.match(css, /\.mt-diag-fix \.mt-select\{[^}]*max-width:100%/, '下拉不超宽')
})
