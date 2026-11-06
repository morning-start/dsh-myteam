import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openLedger,
  appendEvent,
  validateEvent,
  LedgerValidationError,
  RULES_VERSION,
  type LedgerEvent,
} from '../src/core/ledger/ledger.ts'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'myteam-t2-')), 'ledger.jsonl')
}

function seed(filePath: string) {
  appendEvent(filePath, {
    seq: 0, ts: 1, actor: 'host', type: 'rules.version.adopted', payload: { version: RULES_VERSION },
  })
}

const validDraft = {
  actor: 'lead',
  type: 'team.created' as const,
  payload: { teamId: 't1', name: 'demo', goal: 'do something' },
}

test('T2: validateEvent rejects unknown type / missing fields / bad actor', () => {
  assert.throws(() => validateEvent({ ...validDraft, type: 'bogus.type' as never }, 1), LedgerValidationError)
  assert.throws(
    () => validateEvent({ actor: '', type: 'team.created', payload: validDraft.payload }, 1),
    LedgerValidationError,
  )
  assert.throws(
    () => validateEvent({ actor: 'lead', type: 'task.created', payload: { teamId: 't1' } }, 1),
    (e: unknown) => e instanceof LedgerValidationError && e.code === 'MT_LEDGER_MISSING_FIELD',
  )
})

test('T2: first event on empty file must be rules.version.adopted (I3)', () => {
  const file = tempFile()
  assert.throws(() => appendEvent(file, { ...validateEvent(validDraft, 0), ts: 1 }), LedgerValidationError)
  seed(file)
  assert.ok(existsSync(file))
})

test('T2: append + replay keeps seq continuity and content fidelity', () => {
  const file = tempFile()
  seed(file)
  appendEvent(file, { ...validateEvent(validDraft, 1), ts: 2 })
  appendEvent(file, {
    ...validateEvent({ actor: 'human', type: 'plan.clarify', payload: { teamId: 't1', questions: [], round: 1 } }, 2),
    ts: 3,
  })
  const { events, nextSeq, truncated } = openLedger(file)
  assert.equal(truncated, 0)
  assert.equal(nextSeq, 3)
  assert.deepEqual(events.map((e: LedgerEvent) => e.type), ['rules.version.adopted', 'team.created', 'plan.clarify'])
  assert.deepEqual(events.map((e: LedgerEvent) => e.seq), [0, 1, 2])
})

test('T2: crash residue (partial last line) is truncated on reopen, ledger stays consistent', () => {
  const file = tempFile()
  seed(file)
  appendEvent(file, { ...validateEvent(validDraft, 1), ts: 2 })
  const good = readFileSync(file, 'utf8')
  // 模拟崩溃：追加半行 JSON
  writeFileSync(file, `${good}{"seq":2,"ts":3,"actor":"lead","type":"task.crea`, 'utf8')
  const { events, nextSeq, truncated } = openLedger(file)
  assert.equal(truncated, 1)
  assert.equal(events.length, 2)
  assert.equal(nextSeq, 2)
  // 截断后文件以干净换行结尾，且可继续追加
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.ok(!raw.includes('task.crea'))
  appendEvent(file, { ...validateEvent(validDraft, 2), ts: 4 })
  const reopened = openLedger(file)
  assert.equal(reopened.events.length, 3)
  assert.equal(reopened.truncated, 0)
})

test('T2: reopen on missing file yields empty ledger', () => {
  const file = tempFile()
  const { events, nextSeq, truncated } = openLedger(file)
  assert.equal(events.length, 0)
  assert.equal(nextSeq, 0)
  assert.equal(truncated, 0)
})
