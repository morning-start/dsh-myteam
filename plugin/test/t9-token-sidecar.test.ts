import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  zeroBuckets,
  addBuckets,
  dayKeyOf,
  cacheHitRate,
  accumulate,
  emptyTokensFile,
  type TokensFile,
} from '../src/core/ledger/token-sidecar.ts'

test('T9: dayKey uses host-local timezone (CHG-16 ruling 5)', () => {
  // 本地时区 2026-10-25 15:00 → "2026-10-25"
  const ts = new Date(2026, 9, 25, 15, 0, 0).getTime()
  assert.equal(dayKeyOf(ts), '2026-10-25')
  // 跨日边界：本地 23:59 与次日 00:01 分属两桶
  const lateNight = new Date(2026, 9, 25, 23, 59).getTime()
  const nextMorning = new Date(2026, 9, 26, 0, 1).getTime()
  assert.notEqual(dayKeyOf(lateNight), dayKeyOf(nextMorning))
})

test('T9: accumulate merges buckets per member per day; totals consistent', () => {
  let file: TokensFile = emptyTokensFile('t1')
  const u1 = { uncachedInput: 100, cacheRead: 900, cacheWrite: 50, output: 200 }
  const u2 = { uncachedInput: 30, cacheRead: 0, cacheWrite: 0, output: 40 }
  file = accumulate(file, 'm1', '2026-10-25', u1)
  file = accumulate(file, 'm1', '2026-10-25', u2)
  file = accumulate(file, 'm2', '2026-10-25', u1)
  assert.deepEqual(file.days['2026-10-25']['m1'], { uncachedInput: 130, cacheRead: 900, cacheWrite: 50, output: 240, calls: 2 })
  assert.deepEqual(file.totals['m1'], { uncachedInput: 130, cacheRead: 900, cacheWrite: 50, output: 240, calls: 2 })
  assert.deepEqual(file.totals['m2'], { uncachedInput: 100, cacheRead: 900, cacheWrite: 50, output: 200, calls: 1 })
  // 纯函数：原 file 未被原地修改
  assert.deepEqual(file.days['2026-10-25']['m1']!.calls, 2)
})

test('T9: cacheHitRate derivation (REV-5)', () => {
  assert.equal(cacheHitRate({ uncachedInput: 100, cacheRead: 900, cacheWrite: 50, output: 0, calls: 1 }), 900 / 1050)
  assert.equal(cacheHitRate(zeroBuckets()), undefined)
})

test('T9: addBuckets is pure and zero identity works', () => {
  const a = { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4, calls: 5 }
  assert.deepEqual(addBuckets(zeroBuckets(), a), a)
  const b = addBuckets(a, a)
  assert.deepEqual(b, { uncachedInput: 2, cacheRead: 4, cacheWrite: 6, output: 8, calls: 10 })
})
