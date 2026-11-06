/**
 * T70（QA-1）：账本重放完整性——中部坏行不得静默丢数据（FR-4.6「重放必须无损」）。
 *
 * 缺陷（修复前 openLedger）：循环遇坏行即 `break`，重写时又只 `slice(0, length - 1)` 砍最后一行，
 * 于是**坏行在中间**时，坏行之后的全部合法事件既不被重放、又被重写文件永久抹掉。
 *
 * 修复后的契约：
 * - 尾部残行（其后没有内容）→ 截断该行，计入 `truncated`（语义不变）。
 * - 中部坏行 → 跳过该行继续解析，计入 `corrupted`，**其后事件全部保留**。
 * - 重写只保留能完整解析的事件行；`nextSeq` 基于保留的尾部事件。
 * - seq 断点/回退不丢事件，只计入 `corrupted` 供调用方告警。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, appendEvent, validateEvent, RULES_VERSION } from '../src/core/ledger/ledger.ts'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'myteam-t70-')), 'ledger.jsonl')
}

/** 一行合法事件（payload 内容不影响账本层，账面只要结构完整） */
function ev(seq: number, type = 'task.progress', payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ seq, ts: 1000 + seq, actor: 'lead', type, payload })
}

/** 非空行（用于断言重写后的文件行） */
function nonEmptyLines(raw: string): string[] {
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

test('T70: 中部坏行被跳过，坏行之后的事件全部保留（核心回归：旧实现静默丢数据）', () => {
  const file = tempFile()
  writeFileSync(
    file,
    [
      ev(0, 'rules.version.adopted', { version: RULES_VERSION }),
      ev(1, 'team.created', { teamId: 't1', name: 'demo', goal: 'g' }),
      '{"seq":2,"ts":1002,"actor":"lead","type":"task.prog', // 崩溃半行（中部）
      ev(3, 'task.progress', { teamId: 't1', taskId: 'k1', attemptId: 'a1' }),
      ev(4, 'task.completed', { teamId: 't1', taskId: 'k1', attemptId: 'a1' }),
    ].join('\n') + '\n',
    'utf8',
  )
  const r = openLedger(file)
  assert.deepEqual(r.events.map((e) => e.seq), [0, 1, 3, 4], '坏行之后的事件必须保留（旧实现只剩前 2 条）')
  assert.equal(r.truncated, 0, '中部坏行不是尾部残行，truncated 语义不变')
  assert.equal(r.corrupted, 1)
  assert.equal(r.compacted, true)
  assert.equal(r.nextSeq, 5)

  // 重写后文件只含可解析事件行，且以换行结尾（可继续 append）
  const rewritten = readFileSync(file, 'utf8')
  assert.equal(nonEmptyLines(rewritten).length, 4)
  assert.ok(rewritten.endsWith('\n'))
  assert.ok(!rewritten.includes('task.prog"'), '坏行必须被剔除')
  assert.deepEqual(
    nonEmptyLines(rewritten).map((l) => JSON.parse(l).seq),
    [0, 1, 3, 4],
    '重写必须保真（原行原样保留，不重新序列化）',
  )

  // 幂等：再开一次已修复的账本 → 不再重写（坏行已剔除）
  const again = openLedger(file)
  assert.equal(again.compacted, false, '已修复的账本不应再次重写')
  assert.equal(again.truncated, 0)
  assert.deepEqual(again.events.map((e) => e.seq), [0, 1, 3, 4])
  // 坏行占用的 seq 2 成为**永久空洞**：seq 是审计锚点，重写时有意不重编号，
  // 因此每次重放都以 corrupted 如实告警（不静默、不丢事件）。
  assert.equal(again.corrupted, 1, 'seq 空洞必须持续告警（MT_LEDGER_CORRUPT 级）')
})

test('T70: 中部坏行 + 尾部残行同时存在时各自计数，且重写后 seq 可继续追加', () => {
  const file = tempFile()
  // 末尾无换行：最后一行是写一半的残留
  writeFileSync(
    file,
    [ev(0, 'rules.version.adopted', { version: RULES_VERSION }), 'garbage{{{', ev(2, 'team.created', { teamId: 't1', name: 'n', goal: 'g' }), '{"seq":3,"ts":1003,'].join('\n'),
    'utf8',
  )
  const r = openLedger(file)
  assert.deepEqual(r.events.map((e) => e.seq), [0, 2])
  assert.equal(r.corrupted, 1, '中部坏行')
  assert.equal(r.truncated, 1, '尾部残行')
  assert.equal(r.nextSeq, 3)

  appendEvent(file, { ...validateEvent({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k9', task: {} } }, r.nextSeq), ts: 2000 })
  const reopened = openLedger(file)
  assert.deepEqual(reopened.events.map((e) => e.seq), [0, 2, 3], '追加后仍能完整重放')
  assert.equal(reopened.truncated, 0)
  assert.equal(reopened.nextSeq, 4)
  assert.equal(reopened.corrupted, 1, '坏行占用的 seq 1 是永久空洞（如实告警，不重编号）')
})

test('T70: 仅尾部残行时保持原语义（truncated=1 / corrupted=0 / 截断后可继续追加）', () => {
  const file = tempFile()
  writeFileSync(
    file,
    [ev(0, 'rules.version.adopted', { version: RULES_VERSION }), ev(1, 'team.created', { teamId: 't1', name: 'n', goal: 'g' }), '{"seq":2,"ts":1002,'].join('\n'),
    'utf8',
  )
  const r = openLedger(file)
  assert.equal(r.truncated, 1)
  assert.equal(r.corrupted, 0)
  assert.deepEqual(r.events.map((e) => e.seq), [0, 1])
  assert.equal(r.nextSeq, 2)
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
})

test('T70: JSON 合法但不是事件的行（非对象 / 缺字段）按坏行跳过，不抛异常带崩重放', () => {
  const file = tempFile()
  writeFileSync(
    file,
    [
      ev(0, 'rules.version.adopted', { version: RULES_VERSION }),
      '{"foo":1}', // 缺 seq/ts/type
      'null',
      '[1,2]',
      ev(1, 'team.created', { teamId: 't1', name: 'n', goal: 'g' }),
    ].join('\n') + '\n',
    'utf8',
  )
  // 旧实现：parseLine 抛 MT_LEDGER_CORRUPT 冒泡出 openLedger（整个冷启动失败）
  const r = openLedger(file)
  assert.deepEqual(r.events.map((e) => e.seq), [0, 1], '合法事件一条都不能丢')
  assert.equal(r.corrupted, 3)
  assert.equal(r.truncated, 0)
  assert.equal(r.nextSeq, 2)
  assert.equal(nonEmptyLines(readFileSync(file, 'utf8')).length, 2)
})

test('T70: seq 断点（无坏行）不丢事件，只计入 corrupted 暴露给调用方', () => {
  const file = tempFile()
  const content = [ev(0, 'rules.version.adopted', { version: RULES_VERSION }), ev(1, 'team.created', { teamId: 't1', name: 'n', goal: 'g' }), ev(5, 'task.created', { teamId: 't1', taskId: 'k5', task: {} })].join('\n') + '\n'
  writeFileSync(file, content, 'utf8')
  const r = openLedger(file)
  assert.deepEqual(r.events.map((e) => e.seq), [0, 1, 5], '断点不丢事件（审计保真优先）')
  assert.equal(r.corrupted, 1, 'seq 断点 = MT_LEDGER_CORRUPT 级问题，必须暴露')
  assert.equal(r.truncated, 0)
  assert.equal(r.compacted, false, '没有坏行就不该重写文件')
  assert.equal(r.nextSeq, 6)
  assert.equal(readFileSync(file, 'utf8'), content, '无坏行时文件必须原样未动')
})

test('T70: seq 回退不丢事件，只计入 corrupted', () => {
  const file = tempFile()
  writeFileSync(
    file,
    [
      ev(0, 'rules.version.adopted', { version: RULES_VERSION }),
      ev(1, 'team.created', { teamId: 't1', name: 'n', goal: 'g' }),
      ev(1, 'task.created', { teamId: 't1', taskId: 'dup', task: {} }), // 回退
    ].join('\n') + '\n',
    'utf8',
  )
  const r = openLedger(file)
  assert.equal(r.events.length, 3)
  assert.equal(r.corrupted, 1)
  assert.equal(r.nextSeq, 2)
})

test('T70: 末行合法但缺换行时补换行（避免下次 append 粘行），且不虚报 truncated', () => {
  const file = tempFile()
  writeFileSync(file, [ev(0, 'rules.version.adopted', { version: RULES_VERSION }), ev(1, 'team.created', { teamId: 't1', name: 'n', goal: 'g' })].join('\n'), 'utf8')
  const r = openLedger(file)
  assert.equal(r.events.length, 2)
  assert.equal(r.truncated, 0, '合法末行不是残行')
  assert.equal(r.corrupted, 0)
  assert.equal(r.compacted, true)
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
  // 粘行回归：补齐换行后追加的事件必须独立成行可重放
  appendEvent(file, { ...validateEvent({ actor: 'lead', type: 'team.updated', payload: { teamId: 't1' } }, r.nextSeq), ts: 3000 })
  const reopened = openLedger(file)
  assert.deepEqual(reopened.events.map((e) => e.seq), [0, 1, 2])
  assert.equal(reopened.corrupted, 0)
})

test('T70: 干净账本不重写、零计数（不制造无谓写入）', () => {
  const file = tempFile()
  appendEvent(file, { seq: 0, ts: 1000, actor: 'host', type: 'rules.version.adopted', payload: { version: RULES_VERSION } })
  const content = readFileSync(file, 'utf8')
  const r = openLedger(file)
  assert.equal(r.truncated, 0)
  assert.equal(r.corrupted, 0)
  assert.equal(r.compacted, false)
  assert.equal(readFileSync(file, 'utf8'), content)
})
