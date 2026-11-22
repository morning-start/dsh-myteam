import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, hashContent, CanonicalJsonError } from '../src/contracts/json.ts'
import { batchHashOf, encodeBatch, verifyBatch, eventsHashOf } from '../src/contracts/batch.ts'
import { scanLog } from '../src/infrastructure/event-store/log-scan.ts'
import type { EventEnvelope } from '../src/contracts/events.ts'
import { SCHEMA_VERSION } from '../src/contracts/versions.ts'

const PROJECT = 'prj_00000001'
const BATCH = 'bat_00000001'

function event(seq: number, index: number, note = 'progress'): EventEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `evt_${String(seq).padStart(8, '0')}`,
    projectId: PROJECT,
    projectSeq: seq,
    batchId: BATCH,
    batchIndex: index,
    type: 'task.progress',
    actor: { kind: 'system', component: 'test' },
    occurredAt: '2026-01-01T00:00:00.000Z',
    entity: { kind: 'task', id: 'task_00000001' },
    payload: { taskId: 'task_00000001', attemptId: 'att_00000001', note, percent: null },
  }
}

test('规范化 JSON：键序不影响字节', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(hashContent({ b: 1, a: 2 }), hashContent({ a: 2, b: 1 }))
})

test('规范化 JSON：拒绝无法无损表达的值', () => {
  assert.throws(() => canonicalJson({ a: Number.NaN }), CanonicalJsonError)
  assert.throws(() => canonicalJson({ a: [undefined] }), CanonicalJsonError)
  assert.throws(() => canonicalJson({ a: new Date() }), CanonicalJsonError)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalJson(cyclic), CanonicalJsonError)
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
})

test('批次编码：头帧 + 事件帧 + 提交帧自洽', () => {
  const events = [event(1, 0), event(2, 1)]
  const encoded = encodeBatch(events)
  assert.equal(encoded.header.count, 2)
  assert.equal(encoded.commit.lastSeq, 2)
  assert.deepEqual(verifyBatch(encoded.header, events, encoded.commit), [])
  const scan = scanLog(Buffer.from(encoded.text, 'utf8'))
  assert.equal(scan.corruption, null)
  assert.equal(scan.tornTail, null)
  assert.equal(scan.batches.length, 1)
  assert.equal(scan.batches[0]!.events.length, 2)
})

test('批次校验：篡改事件后 hash 不符', () => {
  const events = [event(1, 0)]
  const encoded = encodeBatch(events)
  const tampered = [{ ...events[0]!, payload: { ...events[0]!.payload, note: 'changed' } } as EventEnvelope]
  const problems = verifyBatch(encoded.header, tampered, encoded.commit)
  assert.ok(problems.some((problem) => problem.includes('hash')))
})

test('扫描：截断提交帧 = 可修复尾部', () => {
  const encoded = encodeBatch([event(1, 0), event(2, 1)])
  const truncated = encoded.text.slice(0, encoded.text.length - Math.floor(encoded.commitLine.length / 2))
  const scan = scanLog(Buffer.from(truncated, 'utf8'))
  assert.equal(scan.corruption, null)
  assert.notEqual(scan.tornTail, null)
  assert.equal(scan.batches.length, 0)
})

test('扫描：缺少提交帧 = 可修复尾部', () => {
  const encoded = encodeBatch([event(1, 0)])
  const scan = scanLog(Buffer.from(encoded.body, 'utf8'))
  assert.equal(scan.corruption, null)
  assert.notEqual(scan.tornTail, null)
})

test('扫描：事件被改写但帧完整 = 损坏（不可截断）', () => {
  const encoded = encodeBatch([event(1, 0)])
  const lines = encoded.text.split('\n')
  const rewritten = lines[1]!.replace('"note":"progress"', '"note":"tampered"')
  const scan = scanLog(Buffer.from(lines.map((line, index) => (index === 1 ? rewritten : line)).join('\n'), 'utf8'))
  assert.equal(scan.tornTail, null)
  assert.notEqual(scan.corruption, null)
  assert.match(scan.corruption!.reason, /批次校验失败/)
})

test('扫描：提交帧后出现完整垃圾行 = 损坏', () => {
  const encoded = encodeBatch([event(1, 0)])
  const scan = scanLog(Buffer.from(`${encoded.text}\n{"garbage":true}\n`, 'utf8'))
  assert.equal(scan.tornTail, null)
  assert.notEqual(scan.corruption, null)
})

test('批次 hash：换 projectId 或 batchId 都不能复用', () => {
  const events = [event(1, 0)]
  const encoded = encodeBatch(events)
  const other = batchHashOf({
    projectId: 'prj_99999999',
    batchId: BATCH,
    firstSeq: 1,
    lastSeq: 1,
    count: 1,
    eventsHash: eventsHashOf(events),
  })
  assert.notEqual(other, encoded.commit.batchHash)
})

test('批次编码：序号不连续直接拒绝', () => {
  assert.throws(() => encodeBatch([event(1, 0), event(3, 1)]), /projectSeq/)
  assert.throws(() => encodeBatch([event(1, 1)]), /batchIndex/)
})