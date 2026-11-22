import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { encodeBatch } from '../src/contracts/batch.ts'
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

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'myteam-v2-'))
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

test('事件库：追加后可读，序号连续', () => {
  const dir = tempDir()
  try {
    const store = new FileEventStore(join(dir, 'events', 'project.jsonl'))
    store.append([event(1, 0, 'bat_00000001')])
    store.append([event(2, 0, 'bat_00000002'), event(3, 1, 'bat_00000002')])
    const read = store.readCommitted()
    assert.equal(read.events.length, 3)
    assert.equal(read.nextSeq, 4)
    assert.equal(read.scan.batches.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('事件库：序号跳号被拒绝，且不写坏日志', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'events', 'project.jsonl')
    const store = new FileEventStore(path)
    store.append([event(1, 0, 'bat_00000001')])
    expectCode(() => store.append([event(5, 0, 'bat_00000002')]), 'PRECONDITION_FAILED')
    assert.equal(store.readCommitted().events.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('事件库：撕裂尾部拒绝追加，显式修复后可继续', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'events', 'project.jsonl')
    const store = new FileEventStore(path)
    store.append([event(1, 0, 'bat_00000001')])

    const incomplete = encodeBatch([event(2, 0, 'bat_00000002')])
    appendFileSync(path, incomplete.text.slice(0, incomplete.text.length - 12))

    assert.notEqual(store.scan().tornTail, null)
    expectCode(() => store.readCommitted(), 'EVENT_LOG_TORN_TAIL')
    expectCode(() => store.append([event(2, 0, 'bat_00000003')]), 'EVENT_LOG_TORN_TAIL')

    const repair = store.repairTornTail('2026-01-02T00:00:00.000Z')
    assert.notEqual(repair, null)
    assert.ok(repair!.report.removedBytes > 0)
    assert.ok(existsSync(repair!.report.backupPath))
    assert.ok(readdirSync(join(dir, 'events')).some((name) => name.includes('.torn-')))

    store.append([event(2, 0, 'bat_00000004')])
    assert.equal(store.readCommitted().events.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('事件库：中间帧被篡改 = 损坏，拒绝修复与追加', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'events', 'project.jsonl')
    const store = new FileEventStore(path)
    store.append([event(1, 0, 'bat_00000001')])
    store.append([event(2, 0, 'bat_00000002')])

    const lines = readFileSync(path, 'utf8').split('\n')
    // 第二行是第一个批次的事件帧；改写 payload 但不改 hash。
    lines[1] = lines[1]!.replace('"n1"', '"tampered"')
    writeFileSync(path, lines.join('\n'))

    assert.notEqual(store.scan().corruption, null)
    expectCode(() => store.readCommitted(), 'EVENT_LOG_CORRUPT')
    expectCode(() => store.append([event(3, 0, 'bat_00000003')]), 'PROJECT_WRITE_BLOCKED')
    expectCode(() => store.repairTornTail(), 'EVENT_LOG_CORRUPT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写者租约：独占、释放后 fencing 递增、过期可接管', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'state', 'writer.lock')
    const first = new WriterLeaseManager(path, { owner: 'a' })
    const lease = first.acquire(PROJECT)
    assert.equal(lease.fencing, 1)

    expectCode(() => new WriterLeaseManager(path, { owner: 'b' }).acquire(PROJECT), 'WRITER_LEASE_LOST')

    first.assert(lease)
    first.release(lease)
    const second = new WriterLeaseManager(path, { owner: 'b' })
    const secondLease = second.acquire(PROJECT)
    assert.equal(secondLease.fencing, 2)

    // 模拟过期：同一个文件里写入旧 renewedAt 与一个不存在的 pid。
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT,
        owner: 'dead',
        pid: 999_999,
        fencing: 7,
        acquiredAt: '2020-01-01T00:00:00.000Z',
        renewedAt: '2020-01-01T00:00:00.000Z',
      }),
    )
    const third = new WriterLeaseManager(path, {
      owner: 'c',
      isProcessAlive: () => false,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })
    const takeover = third.acquire(PROJECT)
    assert.equal(takeover.fencing, 8)
    assert.equal(takeover.owner, 'c')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})