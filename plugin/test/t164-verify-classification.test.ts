/**
 * T164 · CHG-210 批 4.2：**verify 门的失败要分得清「没跑起来」和「跑了但挂了」**。
 *
 * 缺陷现场：`classifyVerifyResult` 只回 `'pass' | 'fail'`，于是 `exit 127`（命令不存在）
 * 与「测试真的挂了」在界面上同形。用户看到「verify 门 fail」时不知道该修环境还是改代码，
 * 而且环境缺东西这类失败重试一万次也不会过，只会把打回预算烧光。
 *
 * 本文件钉六类：
 *   ① exit 0 → pass（无 failureKind）
 *   ② exit 非 0 → assertion（最常见，默认归类）
 *   ③ exit 127 → not-run（shell 找不到可执行文件）
 *   ④ 输出里出现 ENOENT / command not found → not-run（127 之外的形态）
 *   ⑤ 超时 → timed-out（不是 assertion：命令没跑完）
 *   ⑥ 被信号杀 → signaled（不是 assertion：进程没正常退出）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyVerifyResult } from '../src/core/gates/command-gate.ts'

test('t164-1: exit 0 → pass，且不带 failureKind', () => {
  const r = classifyVerifyResult({ exitCode: 0, signal: null, timedOut: false })
  assert.equal(r.verdict, 'pass')
  assert.equal(r.failureKind, undefined, 'pass 不该有失败子类')
})

test('t164-2: exit 1 → assertion（测试/断言失败，默认归类）', () => {
  const r = classifyVerifyResult({ exitCode: 1, signal: null, timedOut: false, outputTail: 'not ok 3 - expects 2 to equal 3' })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.failureKind, 'assertion')
})

test('t164-3: exit 127 → not-run（命令不存在，重试不会好）', () => {
  const r = classifyVerifyResult({ exitCode: 127, signal: null, timedOut: false, outputTail: 'sh: 1: node: not found' })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.failureKind, 'not-run')
})

test('t164-4: 输出含 ENOENT / not recognized → not-run（127 之外的形态）', () => {
  for (const tail of [
    "Error: spawn pnpm ENOENT",
    'bash: pnpm: command not found',
    "'pnpm' 不是内部或外部命令，也不是可运行的程序",
  ]) {
    const r = classifyVerifyResult({ exitCode: 1, signal: null, timedOut: false, outputTail: tail })
    assert.equal(r.failureKind, 'not-run', `应识别为没跑起来: ${tail}`)
  }
})

test('t164-5: 超时 → timed-out（不是 assertion）', () => {
  const r = classifyVerifyResult({ exitCode: null, signal: null, timedOut: true })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.failureKind, 'timed-out')
})

test('t164-6: 被信号杀 → signaled（不是 assertion）', () => {
  const r = classifyVerifyResult({ exitCode: null, signal: 'SIGKILL', timedOut: false })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.failureKind, 'signaled')
})

test('t164-7: 分类结果与裁决一致——fail 必有 failureKind，pass 必无', () => {
  const cases = [
    { exitCode: 0, signal: null, timedOut: false },
    { exitCode: 1, signal: null, timedOut: false },
    { exitCode: 127, signal: null, timedOut: false },
    { exitCode: null, signal: 'SIGTERM', timedOut: false },
    { exitCode: null, signal: null, timedOut: true },
  ]
  for (const c of cases) {
    const r = classifyVerifyResult(c)
    assert.equal(r.verdict === 'fail', r.failureKind !== undefined, JSON.stringify(c))
  }
})
