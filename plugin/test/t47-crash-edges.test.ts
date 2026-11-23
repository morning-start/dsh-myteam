/**
 * t47：崩溃边界的**协议级**断言（roadmap R-4 的确定性部分）。
 *
 * 为什么：真机「在提交前后注入进程崩溃」还没做，但日志协议对每种半截写怎么分类是
 * 可枚举的。这组用例把「截断点 → 撕裂 / 损坏」钉死，免得以后改编码格式时把
 * 「可修复的 uncommitted 尾部」误判成损坏（用户被迫手工修文件），或者反过来把真损坏
 * 当撕裂截掉（丢已提交的事件）。
 *
 * 判据（与 file-store / log-scan 的契约一致）：
 *   - 批次中间被截断（头帧已写、提交帧未写）→ 撕裂，可显式修复；
 *   - 批次头帧本身只写了半截 → 损坏，不自动修（没有可信的起始边界）；
 *   - 已提交批次之后出现完整但无法解析的行 → 损坏，不自动修。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { committedBytes, committedEvents, nextProjectSeq, scanLog } from '../src/infrastructure/event-store/log-scan.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import type { EventEnvelope } from '../src/contracts/events.ts'
import { SCHEMA_VERSION } from '../src/contracts/versions.ts'

const PROJECT = 'prj_00000001'

function event(seq: number, index: number, batchId: string): EventEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `evt_${String(seq).padStart(8, '0')}`,
    projectId: PROJECT,
    projectSeq: seq,
    batchId,
    batchIndex: index,
    type: 'task.progress',
    actor: { kind: 'system', component: 'test' },
    occurredAt: '2026-01-01T00:00:00.000Z',
    entity: { kind: 'task', id: 'task_00000001' },
    payload: { taskId: 'task_00000001', attemptId: 'att_00000001', note: `n${seq}`, percent: null },
  }
}

/** 两批共 3 条事件；返回字节与每行的起始偏移（行序：批1 头/事件/提交，批2 头/事件/事件/提交）。 */
function makeLog(): { dir: string; file: string; bytes: Buffer; lineOffsets: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t47-'))
  const file = join(dir, 'events', 'project.jsonl')
  const store = new FileEventStore(file)
  store.append([event(1, 0, 'bat_00000001')])
  store.append([event(2, 0, 'bat_00000002'), event(3, 1, 'bat_00000002')])
  const bytes = readFileSync(file)
  const lines = bytes.toString('utf8').split('\n')
  const lineOffsets: number[] = []
  let cursor = 0
  for (const line of lines.slice(0, -1)) {
    lineOffsets.push(cursor)
    cursor += line.length + 1
  }
  return { dir, file, bytes, lineOffsets }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, `应抛 MyTeamError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

test('崩溃边界：完整日志读得干净，序号与字节数对得上', () => {
  const { dir, file, bytes } = makeLog()
  try {
    const scan = scanLog(bytes)
    assert.equal(scan.tornTail, null)
    assert.equal(scan.corruption, null)
    assert.equal(scan.batches.length, 2)
    assert.equal(committedEvents(scan).length, 3)
    assert.equal(nextProjectSeq(scan), 4)
    assert.equal(committedBytes(scan), bytes.length)
    assert.equal(readFileSync(file).length, bytes.length, '读日志不该改文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('崩溃边界：提交帧只写了一半 → 撕裂（可显式修复），已提交批次仍可读', () => {
  const { dir, file, bytes } = makeLog()
  try {
    const torn = bytes.subarray(0, bytes.length - 10)
    const scan = scanLog(torn)
    assert.notEqual(scan.tornTail, null, '提交帧中间截断必须判成撕裂')
    assert.equal(scan.corruption, null)
    assert.equal(scan.batches.length, 1, '只认第 1 批')
    assert.equal(committedEvents(scan).length, 1)

    const store = new FileEventStore(file)
    // 把「崩溃后磁盘上的样子」落到文件里，再走 store 的真实读路径。
    writeFileSync(file, torn)
    expectCode(() => store.readCommitted(), 'EVENT_LOG_TORN_TAIL')
    expectCode(() => store.append([event(2, 0, 'bat_00000003')]), 'EVENT_LOG_TORN_TAIL')

    const repair = store.repairTornTail('2026-01-03T00:00:00.000Z')
    assert.notEqual(repair, null)
    assert.ok(repair!.report.removedBytes > 0)
    const after = store.readCommitted()
    assert.equal(after.events.length, 1, '修复只应丢掉未提交尾部')
    assert.equal(after.nextSeq, 2)
    store.append([event(2, 0, 'bat_00000003')])
    assert.equal(store.readCommitted().events.length, 2, '修复后必须能继续写')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('崩溃边界：批次头帧只写了一半 → 判损坏，不自动修', () => {
  const { dir, bytes, lineOffsets } = makeLog()
  try {
    const headerStart = lineOffsets[3]!
    const scan = scanLog(bytes.subarray(0, headerStart + 3))
    assert.equal(scan.tornTail, null, '没有可信的起始边界，不能当撕裂')
    assert.notEqual(scan.corruption, null)
    assert.equal(scan.batches.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('崩溃边界：已提交批次后出现完整垃圾行 → 判损坏，拒绝修复', () => {
  const { dir, file } = makeLog()
  try {
    appendFileSync(file, '{"not":"a batch frame"}\n')
    const store = new FileEventStore(file)
    const scan = store.scan()
    assert.equal(scan.tornTail, null)
    assert.notEqual(scan.corruption, null)
    expectCode(() => store.readCommitted(), 'EVENT_LOG_CORRUPT')
    expectCode(() => store.repairTornTail(), 'EVENT_LOG_CORRUPT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})