/**
 * CHG-73（FR-27/28/29/31）客户端契约：P2 的执行期闭环必须真的接上端点与两段确认，
 * 不能只是画了按钮。
 *
 * 静态契约（不依赖浏览器）+ zh/en 词条对等（缺 en 会直接显示 key）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('t49-1: P2 端点全部接上（rescope/cancel/batch 走会话门面，deleteRole/getCapabilityCatalog 走根级）', () => {
  for (const method of ['rescopeTask', 'cancelTask', 'batchTaskOp']) {
    assert.match(source, new RegExp(`${method}: \\(query\\) => call\\('${method}', query\\)`), `${method} 必须走会话门面端点`)
  }
  assert.match(source, /deleteRole: \(query\) => rpcCall\(connection, 'myteam\/deleteRole', \{ query \}\)/)
  assert.match(source, /getCapabilityCatalog: \(query\) => rpcCall\(connection, 'myteam\/getCapabilityCatalog', \{ query \}\)/)
})

test('t49-2: RescopeDialog —— 理由必填、只提交真正改动过的结构字段、可选重派', () => {
  assert.match(source, /function RescopeDialog\(/)
  assert.match(source, /if \(!trimmed\) \{ setErr\(t\('task\.rescopeNeedReason'\)\); return \}/)
  // 只把与当前值不同的字段放进 patch（避免"打开就提交一份全量补丁"）
  assert.match(source, /if \(nextTitle\.trim\(\) !== \(src\.title \?\? ''\)\) patch\.title = nextTitle\.trim\(\)/)
  assert.match(source, /if \(\[\.\.\.deps\]\.join\(','\) !== \(src\.deps \?\? \[\]\)\.join\(','\)\) patch\.deps = \[\.\.\.deps\]/)
  assert.match(source, /\.\.\.\(Object\.keys\(patch\)\.length > 0 \? \{ patch \} : \{\}\)/)
  assert.match(source, /\.\.\.\(memberIds\.size > 0 \? \{ memberIds: \[\.\.\.memberIds\] \} : \{\}\)/)
  assert.match(source, /if \(r\?\.status !== 'rescoped'\)/)
})

test('t49-3: CancelDialog —— 两段确认（先拿 impact，再 confirm:true）、下游策略两档', () => {
  assert.match(source, /function CancelDialog\(/)
  assert.match(source, /if \(!trimmed\) \{ setErr\(t\('cancel\.needReason'\)\); return \}/)
  assert.match(source, /if \(r\?\.status === 'confirm-required'\) \{ setImpact\(r\.impact \?\? \{\}\); return \}/)
  assert.match(source, /const r = await api\.cancelTask\(\{ teamId, taskId, reason: trimmed, downstream \}\)/)
  assert.match(source, /downstream, confirm: true \}\)/)
  // 策略说明与影响面都要给人看
  for (const key of ['cancel.leave', 'cancel.cascade', 'cancel.impact', 'cancel.hasAttempt', 'cancel.noAttempt']) {
    assert.ok(source.includes(`'${key}'`), `缺词条 ${key}`)
  }
})

test('t49-4: 批量编排 —— 四种操作、取消要两段确认、离线任务跳过并说明', () => {
  assert.match(source, /function BatchBar\(/)
  assert.match(source, /if \(\(op === 'cancel' \|\| op === 'rescope'\) && !String\(reason\)\.trim\(\)\)/)
  assert.match(source, /if \(op === 'assign' && memberIds\.size === 0\)/)
  assert.match(source, /const r = await makeApi\(connection, team\.sessionId\)\.batchTaskOp\(query\)/)
  // 批量取消：先不带 confirm 拿 impact，确认后才执行；离线团队的任务不进批次
  assert.match(source, /code: 'MT_OFFLINE', message: t\('batch\.offlineSkipped'\)/)
  for (const key of ['batch.cancel', 'batch.rescope', 'batch.assign', 'batch.priority', 'batch.confirm', 'batch.impact']) {
    assert.ok(source.includes(`'${key}'`), `缺词条 ${key}`)
  }
})

test('t49-5: 任务详情 —— 动作条按服务端 actions 显示、证据过期横幅、改动记录、取消留痕', () => {
  assert.match(source, /const stale = detail\.evidenceStale/)
  assert.match(source, /const cancellation = detail\.cancellation/)
  assert.match(source, /children: t\('detail\.evidenceStale'\)/)
  assert.match(source, /children: `\$\{t\('detail\.cancelled'\)\.replace\('\{time\}', fmtClock\(cancellation\.ts\)\)/)
  assert.match(source, /j\(EditHistory, \{ t, edits: detail\.edits \?\? \[\], memberName \}\)/)
  // 写操作只在在线团队可用（离线只读）
  assert.match(source, /onRescope: openTask\.online \? openRescopeDialog : undefined/)
  assert.match(source, /onCancel: openTask\.online \? openCancelDialog : undefined/)
})

test('t49-6: 看板卡 / 列表 —— 证据过期徽标 + 上游已取消诊断（不叫"待办"）', () => {
  assert.match(source, /const stale = task\.evidenceStale/)
  assert.ok(source.includes("'board.evidenceStale'"))
  assert.match(source, /if \(code === 'dep-cancelled'\) return t\('diag\.dep-cancelled'\)/)
  assert.ok(source.includes("'diag.dep-cancelled'"))
  assert.match(source, /\.mt-chip-cancelled/)
})

test('t49-7: 角色删除与技能/MCP 目录 —— canDelete 门控、两段确认、目录多选可自由输入', () => {
  assert.match(source, /function CapabilityPicker\(/)
  assert.match(source, /discoveryApi\.getCapabilityCatalog\(\{ workspaceRoot: projectRoot \}\)/)
  assert.match(source, /const canDeleteOpenRole = Boolean\(openRoleEntry\)/)
  assert.match(source, /discoveryApi\.deleteRole\(\{ workspaceRoot: projectRoot, roleId, confirm \}\)/)
  assert.ok(source.includes("'role.deleteUsage'"))
  assert.ok(source.includes("'role.deletePresets'"))
  // 目录只是提示：允许自由输入（不是白名单）
  assert.ok(source.includes("'role.catalogFree'"), '需保留自由输入占位词条')
  assert.ok(source.includes("'role.catalogHint'"), '需保留"目录是提示"的说明词条')
  assert.match(source, /const commit = \(\) => \{/)
})

test('t49-8: 新建任务一次写入 assignees/participants（不再串三个调用）', () => {
  const start = source.indexOf('const created = await api.createTask({')
  assert.ok(start > 0, '任务表单应调用 createTask')
  const body = source.slice(start, start + 700)
  assert.match(body, /assignees: \[\.\.\.assignees\]/)
  assert.match(body, /participants: \[\.\.\.coops\]\.map\(\(coopId\) => \(\{ teamId: coopId \}\)\)/)
  // 保存路径里不应再出现"创建后逐个 assignTask/participateTask"的旧三连
  assert.ok(!/created\.taskId[\s\S]{0,400}api\.assignTask\(/.test(body), '不应再串 assignTask')
  assert.ok(!/created\.taskId[\s\S]{0,400}api\.participateTask\(/.test(body), '不应再串 participateTask')
})

test('t49-9: CHG-73 新增词条 zh/en 对等', () => {
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const enEnd = source.indexOf('/* ── M2 RPC 通道', enStart)
  assert.ok(zhStart >= 0 && enStart > zhStart && enEnd > enStart, '词典切片可定位')
  const keysOf = (text) => new Set([...text.matchAll(/^\s+'([^']+)':/gm)].map((match) => match[1]))
  const zh = keysOf(source.slice(zhStart, enStart))
  const en = keysOf(source.slice(enStart, enEnd))
  const added = [...zh].filter((key) => /^(rescope\.|cancel\.|batch\.|detail\.(edits|editReason|evidenceStale|cancelled)|board\.(evidenceStale|staleTitle)|role\.delete|diag\.dep-cancelled|multi\.)/.test(key))
  assert.ok(added.length >= 30, `CHG-73 词条应成组出现，实际 ${added.length}`)
  const missing = added.filter((key) => !en.has(key))
  assert.deepEqual(missing, [], `en 缺词条：${missing.join(', ')}`)
  // 文案歧义修正：角色删除的确认按钮与批量条取消按钮各有专用词条（不再借用 cancel.confirm / batch.cancel）
  for (const key of ['role.deleteConfirmBtn', 'batch.cancelTask']) {
    assert.ok(zh.has(key), `缺词条 ${key}`)
    assert.ok(en.has(key), `en 缺词条 ${key}`)
  }
  assert.match(source, /t\('role\.deleteConfirmBtn'\)/)
  assert.match(source, /t\('batch\.cancelTask'\)/)
})

test('t49-10: 新增样式只用宿主 token（--dsw-alias-*），不引入硬编码颜色', () => {
  const start = source.indexOf("'.mt-batchbar{")
  assert.ok(start > 0, '批量操作条样式应存在')
  const css = source.slice(start, start + 2600)
  assert.match(css, /var\(--dsw-alias-/)
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), '新增样式不应出现硬编码 hex 颜色')
})
