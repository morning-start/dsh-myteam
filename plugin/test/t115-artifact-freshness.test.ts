/**
 * T115 · P1-1 产物新鲜度指纹（docs/21 §6 P1-1；来源 TeamFlow `store.ts:56-61`、`host/util.ts:717-776`）。
 *
 * 锁四件事：
 *  ① 指纹形态 = `size:mtimeMs`（mtime 取整，浮点尾数不产生假漂移）；
 *  ② 拍基线只记**读得到**的路径，读不到不写键（基线里不出现 undefined 这类「看起来拍过」的键）；
 *  ③ `mergeBaseline` **只补缺失键、不覆盖已有**（重试/续跑沿用首次基线，否则「第一轮写了、
 *    第二轮没写」会把基线洗成第二轮的状态 → 凭第一轮的文件判新鲜）；
 *  ④ 陈旧判据 = 「本阶段没写过它」：基线缺失 / 当前读不到 / 指纹未变 都算陈旧，
 *    只有指纹**变了**才新鲜 —— 治「上游越界写下游产物 → 下游凭旧文件判已交付」的假绿。
 *
 * 纯函数：`stat` 由测试注入（Map 假文件系统），不碰真实磁盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  artifactBaseline,
  artifactFingerprint,
  artifactIsStale,
  mergeBaseline,
} from '../src/core/gates/artifact-freshness.ts'
import type { ArtifactStat } from '../src/core/gates/artifact-freshness.ts'

/** 假文件系统：`stat` 读 Map，`write` 模拟本阶段真实写入（size/mtime 双变） */
function fakeFs(initial: Record<string, ArtifactStat>) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    stat: (path: string) => files.get(path),
    write: (path: string, stat: ArtifactStat) => files.set(path, stat),
    remove: (path: string) => files.delete(path),
  }
}

test('t115-1: 指纹形态 `size:mtimeMs`，mtimeMs 取整（浮点尾数不产生假漂移）', () => {
  assert.equal(artifactFingerprint({ size: 4894, mtimeMs: 1_760_000_000_123.0004 }), '4894:1760000000123')
  // 同一文件的两次 stat 只有浮点尾数不同 → 必须得到同一个指纹（否则每次判都「变了」）
  assert.equal(
    artifactFingerprint({ size: 0, mtimeMs: 1_760_000_000_123.0004 }),
    artifactFingerprint({ size: 0, mtimeMs: 1_760_000_000_123.0006 }),
  )
  // 取整规则：四舍五入（.4 → 下取整、.6 → 上取整）
  assert.equal(artifactFingerprint({ size: 1, mtimeMs: 1_000.4 }), '1:1000')
  assert.equal(artifactFingerprint({ size: 1, mtimeMs: 1_000.6 }), '1:1001')
  // 不可判 → undefined（宁可判不可判，也不编指纹）
  assert.equal(artifactFingerprint(undefined), undefined)
  assert.equal(artifactFingerprint(null), undefined)
  assert.equal(artifactFingerprint({ size: Number.NaN, mtimeMs: 1 }), undefined)
  assert.equal(artifactFingerprint({ size: 1, mtimeMs: Number.POSITIVE_INFINITY }), undefined)
  assert.equal(artifactFingerprint({ size: -1, mtimeMs: 1 }), undefined)
})

test('t115-2: 拍基线只记读得到的路径（读不到的不写键，空路径跳过）', () => {
  const fs = fakeFs({
    'docs/QA-REPORT.md': { size: 120, mtimeMs: 1_000 },
    'docs/ACCEPTANCE.md': { size: 0, mtimeMs: 2_000 },
  })
  const baseline = artifactBaseline(
    ['docs/QA-REPORT.md', 'docs/ACCEPTANCE.md', 'docs/PRD.md', '', '   ', 'docs/QA-REPORT.md'],
    fs.stat,
  )
  assert.deepEqual(baseline, {
    'docs/QA-REPORT.md': '120:1000',
    'docs/ACCEPTANCE.md': '0:2000',
  })
  // 缺失的路径**没有键**（不是 `undefined` 值）：JSON 里「没拍过」与「拍了但文件不在」必须可区分
  assert.equal(Object.prototype.hasOwnProperty.call(baseline, 'docs/PRD.md'), false)
  // 空输入不崩
  assert.deepEqual(artifactBaseline([], fs.stat), {})
})

test('t115-3: mergeBaseline 只补缺失键、不覆盖已有（重试/续跑沿用首次基线）', () => {
  const first = { 'docs/QA-REPORT.md': '120:1000' }
  const retry = { 'docs/QA-REPORT.md': '999:9999', 'docs/ACCEPTANCE.md': '7:7000' }
  const merged = mergeBaseline(first, retry)
  assert.deepEqual(merged, {
    // 首次基线保留：否则「第二轮重拍」会把第一轮的写入洗成基线
    'docs/QA-REPORT.md': '120:1000',
    'docs/ACCEPTANCE.md': '7:7000',
  })
  // 纯函数：不改入参
  assert.deepEqual(first, { 'docs/QA-REPORT.md': '120:1000' })
  assert.deepEqual(retry, { 'docs/QA-REPORT.md': '999:9999', 'docs/ACCEPTANCE.md': '7:7000' })
  // 缺省侧
  assert.deepEqual(mergeBaseline(undefined, undefined), {})
  assert.deepEqual(mergeBaseline({ 'a.md': '1:1' }, undefined), { 'a.md': '1:1' })
  assert.deepEqual(mergeBaseline(undefined, { 'a.md': '1:1' }), { 'a.md': '1:1' })
})

test('t115-4: 基线缺失该路径 → 陈旧（没拍过就不能认交付）', () => {
  const baseline = artifactBaseline(['docs/QA-REPORT.md'], () => ({ size: 1, mtimeMs: 1 }))
  assert.equal(artifactIsStale(baseline, 'docs/ACCEPTANCE.md', { size: 1, mtimeMs: 1 }), true)
  // 完全没有基线（调用方没传）→ 不可判 → 陈旧
  assert.equal(artifactIsStale(undefined, 'docs/QA-REPORT.md', { size: 1, mtimeMs: 1 }), true)
  assert.equal(artifactIsStale(null, 'docs/QA-REPORT.md', { size: 1, mtimeMs: 1 }), true)
  // 空路径不可判
  assert.equal(artifactIsStale(baseline, '', { size: 1, mtimeMs: 1 }), true)
})

test('t115-5: 指纹变了才新鲜（相同=陈旧、不同=新鲜、当前读不到=陈旧）', () => {
  const baseline = { 'docs/QA-REPORT.md': '120:1000' }
  // 未变：本阶段没写过它 → 陈旧
  assert.equal(artifactIsStale(baseline, 'docs/QA-REPORT.md', { size: 120, mtimeMs: 1000 }), true)
  // 变了（大小变 / 时间变，任一即新鲜）：本阶段写过它 → 不陈旧
  assert.equal(artifactIsStale(baseline, 'docs/QA-REPORT.md', { size: 121, mtimeMs: 1000 }), false)
  assert.equal(artifactIsStale(baseline, 'docs/QA-REPORT.md', { size: 120, mtimeMs: 1001 }), false)
  // 当前读不到（文件被删）→ 陈旧
  assert.equal(artifactIsStale(baseline, 'docs/QA-REPORT.md', undefined), true)
})

test('t115-6: 假绿场景——上游越界写下游产物，下游凭旧文件不能判已交付', () => {
  // 架构阶段越界写了 QA/验收产物（TF 实锤 tf-mv9o5fkk-orjou4）
  const fs = fakeFs({
    'docs/QA-REPORT.md': { size: 900, mtimeMs: 5_000 },
    'docs/ACCEPTANCE.md': { size: 640, mtimeMs: 5_100 },
  })
  // 下游阶段开始时拍基线（此时文件已存在，且是上游写的）
  const baseline = artifactBaseline(['docs/QA-REPORT.md', 'docs/ACCEPTANCE.md'], fs.stat)

  // 下游阶段自己什么都没写 → 指纹未变 → 两个产物都陈旧 → 不能拿来判交付
  assert.equal(artifactIsStale(baseline, 'docs/QA-REPORT.md', fs.stat('docs/QA-REPORT.md')), true)
  assert.equal(artifactIsStale(baseline, 'docs/ACCEPTANCE.md', fs.stat('docs/ACCEPTANCE.md')), true)

  // 下游阶段真的补写了 QA 报告 → 只有它变新鲜（验收产物仍陈旧）
  fs.write('docs/QA-REPORT.md', { size: 950, mtimeMs: 9_000 })
  assert.equal(artifactIsStale(baseline, 'docs/QA-REPORT.md', fs.stat('docs/QA-REPORT.md')), false)
  assert.equal(artifactIsStale(baseline, 'docs/ACCEPTANCE.md', fs.stat('docs/ACCEPTANCE.md')), true)
})

test('t115-7: 阶段开始后才出现的文件不在基线里 → 保守判陈旧（接线需按候选清单拍基线）', () => {
  const fs = fakeFs({})
  const baseline = artifactBaseline(['docs/PRD.md'], fs.stat)
  // 阶段中新建的文件：本 API 不知道它「以前不存在」，只能判陈旧（不可判即不认交付）
  fs.write('docs/PRD.md', { size: 300, mtimeMs: 7_000 })
  assert.equal(artifactIsStale(baseline, 'docs/PRD.md', fs.stat('docs/PRD.md')), true)
  // 接线建议：候选清单在阶段开始时枚举，新建产物要么由调用方拍哨兵基线，要么走「文件存在即交付」的
  // 显式分支——不要在 artifactIsStale 里加「缺键 = 新鲜」的例外（那正好放过上游越界写的文件）
})
