/**
 * T125 · P2-5 计量覆盖率三态（CHG-153 / docs/21 §6 P2-5；来源 TC `src/tools/run-history.ts:30-65`）。
 *
 * 锁五件事：
 *  ① 三态矩阵：全计量 → `full`；部分计量 → `partial`；零调用 / 全部未计量 → `none`；
 *  ② 边界：`calls=0`、`meteredCalls` 缺省（未知）、坏数据（NaN / 负数 / 小数 / 计数 > calls）一律保守；
 *  ③ 旧 `tokens.json` 兼容：没有 `meteredCalls` 字段 → **`partial`**（不能谎报 `full`）；
 *  ④ 与总量解耦：`coverageOf` 只读、不改四桶与 `calls`；覆盖率**不落盘**（现算，单一真相来源）；
 *  ⑤ `addBuckets` / `accumulate` 只在调用方给出计数时携带（缺省保持「未知」，不编 0）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addBuckets,
  accumulate,
  coverageOf,
  describeCoverage,
  emptyTokensFile,
  zeroBuckets,
} from '../src/core/ledger/token-sidecar.ts'
import type { TokenBuckets, TokensFile, TokenCoverage } from '../src/core/ledger/token-sidecar.ts'

const bucket = (overrides: Partial<TokenBuckets> = {}): TokenBuckets => ({ ...zeroBuckets(), ...overrides })

test('t125-1: 三态矩阵——全计量 / 部分计量 / 全部未计量 / 零调用', () => {
  // 全计量：calls > 0 且每个已计数调用都拿到 usage
  assert.equal(coverageOf(bucket({ calls: 3, meteredCalls: 3, unmeteredCalls: 0 })), 'full')
  // 部分计量：有过计量也有过未计量
  assert.equal(coverageOf(bucket({ calls: 3, meteredCalls: 2, unmeteredCalls: 1 })), 'partial')
  // 全部未计量：有调用但一次 usage 都没拿到 → none（不是 partial：没有「部分覆盖」可言）
  assert.equal(coverageOf(bucket({ calls: 3, meteredCalls: 0, unmeteredCalls: 3 })), 'none')
  // 零调用：没有可覆盖的样本
  assert.equal(coverageOf(zeroBuckets()), 'none')
})

test('t125-2: coverageOf 边界——calls=0 / 缺省计数 / 坏数据都保守，不谎报 full', () => {
  assert.equal(coverageOf(bucket({ calls: 0, meteredCalls: 0, unmeteredCalls: 0 })), 'none')
  // 旧数据形态：有 calls、没有计量计数 → 未知 → 保守 partial
  assert.equal(coverageOf(bucket({ calls: 2 })), 'partial')
  // 只记了已计量、未计量缺省：metered < calls → 仍有未覆盖样本 → partial
  assert.equal(coverageOf(bucket({ calls: 2, meteredCalls: 1 })), 'partial')
  // 非有限 / 缺失的 calls → none（没有可覆盖的调用）
  assert.equal(coverageOf(bucket({ calls: Number.NaN, meteredCalls: 1 })), 'none')
  assert.equal(coverageOf(bucket({ calls: -3, meteredCalls: 1 })), 'none')
  // 非有限的 meteredCalls → 未知 → partial
  assert.equal(coverageOf(bucket({ calls: 2, meteredCalls: Number.NaN })), 'partial')
  // 坏数据：meteredCalls > calls（不可能是全计量）→ 保守 partial，等人工核对
  assert.equal(coverageOf(bucket({ calls: 2, meteredCalls: 3, unmeteredCalls: 0 })), 'partial')
  // 计数归一：小数截断、负数归 0（不让坏数据让三态抖动）
  assert.equal(coverageOf(bucket({ calls: 2, meteredCalls: 2.9, unmeteredCalls: 0 })), 'full')
  assert.equal(coverageOf(bucket({ calls: 2, meteredCalls: -1, unmeteredCalls: 2 })), 'none')
  // 未计量缺省但计量数已等于 calls：仍可证明全计量
  assert.equal(coverageOf(bucket({ calls: 2, meteredCalls: 2 })), 'full')
  // 完全缺失 / null
  assert.equal(coverageOf(undefined), 'none')
  assert.equal(coverageOf(null), 'none')
})

test('t125-3: 旧 tokens.json 兼容——无计量字段 → 保守 partial（不谎报 full）', () => {
  // 旧版落盘结构：只有四桶 + calls，没有 meteredCalls / unmeteredCalls
  const legacy: TokensFile = {
    version: 1,
    teamId: 't1',
    updatedAt: 0,
    days: { '2026-11-01': { m1: { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4, calls: 2 } } },
    totals: {
      m1: { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4, calls: 2 },
      m2: { uncachedInput: 5, cacheRead: 6, cacheWrite: 7, output: 8, calls: 1 },
    },
    note: '',
  }
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.totals['m1'], 'meteredCalls'), false)
  assert.equal(coverageOf(legacy.totals['m1']), 'partial')
  assert.equal(coverageOf(legacy.totals['m2']), 'partial')
  assert.equal(coverageOf(legacy.days['2026-11-01']['m1']), 'partial')
  // 空文件（没有任何成员桶）→ 没有可覆盖的样本
  assert.equal(coverageOf(emptyTokensFile('t1').totals['m1']), 'none')
})

test('t125-4: 与总量解耦——coverageOf 只读，四桶与 calls 前后 deepEqual', () => {
  const buckets = bucket({ uncachedInput: 100, cacheRead: 900, cacheWrite: 50, output: 200, calls: 2, meteredCalls: 1, unmeteredCalls: 1 })
  const snapshot = { ...buckets }
  assert.equal(coverageOf(buckets), 'partial')
  // 覆盖率是派生读数：不修改入参（总量口径一个字都不变）
  assert.deepEqual(buckets, snapshot)
  // 同一组 buckets 反复求值稳定（无状态）
  assert.equal(coverageOf(buckets), 'partial')
  assert.equal('\n' + JSON.stringify(buckets), '\n' + JSON.stringify(snapshot))
  // 覆盖率不落盘：tokens.json 结构里没有 coverage 字段（单一真相来源 = 四桶 + 计数）
  const file = emptyTokensFile('t1')
  const json = JSON.stringify(file)
  assert.equal(json.includes('coverage'), false)
  assert.equal(json.includes('meteredCalls'), false)
  assert.deepEqual(Object.keys(file).sort(), ['days', 'note', 'teamId', 'totals', 'updatedAt', 'version'])
})

test('t125-5: addBuckets 兼容——缺省计数不产字段（旧测试的桶形状不变）', () => {
  const five: TokenBuckets = { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4, calls: 5 }
  // 两侧都没有计量计数 → 结果没有这两个键（不能编 0：编 0 = 「确定未计量」，同样是撒谎）
  const merged = addBuckets(zeroBuckets(), five)
  assert.deepEqual(merged, five)
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'meteredCalls'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'unmeteredCalls'), false)
  // 单侧给出 → 保留该计数（缺省侧按 0 参与求和，但不新增另一侧的键）
  const withMetered = addBuckets({ ...five, meteredCalls: 2 }, five)
  assert.equal(withMetered.meteredCalls, 2)
  assert.equal(Object.prototype.hasOwnProperty.call(withMetered, 'unmeteredCalls'), false)
  // 两侧都有 → 求和
  const both = addBuckets({ ...five, meteredCalls: 2, unmeteredCalls: 1 }, { ...five, meteredCalls: 1, unmeteredCalls: 2 })
  assert.equal(both.meteredCalls, 3)
  assert.equal(both.unmeteredCalls, 3)
  assert.equal(both.calls, 10)
})

test('t125-6: accumulate 记录计量计数并求和——全计量 → full，混合 → partial', () => {
  let file: TokensFile = emptyTokensFile('t1')
  const metered = { uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 5, meteredCalls: 1, unmeteredCalls: 0 }
  file = accumulate(file, 'm1', '2026-11-08', metered)
  file = accumulate(file, 'm1', '2026-11-08', metered)
  assert.equal(file.totals['m1'].calls, 2)
  assert.equal(file.totals['m1'].meteredCalls, 2)
  assert.equal(file.totals['m1'].unmeteredCalls, 0)
  assert.equal(coverageOf(file.totals['m1']), 'full')
  assert.equal(coverageOf(file.days['2026-11-08']['m1']), 'full')
  // 混合：再来一次未计量调用 → partial（总量照常 +1，覆盖率降级）
  file = accumulate(file, 'm1', '2026-11-08', { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1, meteredCalls: 0, unmeteredCalls: 1 })
  assert.equal(file.totals['m1'].calls, 3)
  assert.equal(coverageOf(file.totals['m1']), 'partial')
  assert.equal(file.totals['m1'].uncachedInput, 21)
})

test('t125-7: accumulate 缺省计量字段 → 保持未知（桶里没有键，覆盖率保守 partial）', () => {
  const file = accumulate(emptyTokensFile('t1'), 'm1', '2026-11-08', { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
  const b = file.totals['m1']
  assert.equal(b.calls, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'meteredCalls'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'unmeteredCalls'), false)
  assert.equal(coverageOf(b), 'partial')
})

test('t125-8: describeCoverage——三态中文文案互不相同且点明口径，脏值有兜底', () => {
  const full = describeCoverage('full')
  const partial = describeCoverage('partial')
  const none = describeCoverage('none')
  assert.notEqual(full, partial)
  assert.notEqual(partial, none)
  assert.notEqual(full, none)
  assert.match(full, /全量/)
  assert.match(partial, /部分/)
  assert.match(none, /无计量/)
  // 运行期脏值（持久化文件被手改）不抛异常、不静默返回空串
  assert.match(describeCoverage('bogus' as TokenCoverage), /未知/)
})
