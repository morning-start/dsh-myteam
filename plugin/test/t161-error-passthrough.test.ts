/**
 * T161 · CHG-210 批 2：**领域异常的错误码必须活着到用户面前**。
 *
 * 缺陷现场：`commit` 与两个工具入口的 catch 只认 `LedgerValidationError` / `FoldError`，
 * 其余一律压成 `MT_INTERNAL`。于是 `FsError('MT_FS_WRITE_FAILED',
 * '确认该路径可写、磁盘没满，然后重跑（整份替换，不会写坏）')` 这种**自带可执行提示**的码，
 * 到用户面前只剩一句 `Error: EPERM: operation not permitted`——提示白写，用户也失去了
 * 唯一能自救的信息。
 *
 * 本文件钉四件事：
 *   ① `FsError` 的码与提示原样透传（它**不继承** `MTError`，按 `instanceof` 认会漏）；
 *   ② `MTError` 同样透传；
 *   ③ 普通 `Error` 仍是 `MT_INTERNAL`（不能为了让码好看就把未知异常伪装成领域错误）；
 *   ④ 非 Error 值（字符串/undefined）不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolFailureOf } from '../src/core/service.ts'
import { FsError } from '../src/core/fs/atomic-write.ts'
import { MTError } from '../src/core/errors.ts'

test('t161-1: FsError 的码与提示原样透传（不再被压成 MT_INTERNAL）', () => {
  const r = toolFailureOf(new FsError('MT_FS_WRITE_FAILED', '确认该路径可写、磁盘没满，然后重跑'))
  assert.equal(r.status, 'error')
  assert.equal(r.code, 'MT_FS_WRITE_FAILED', 'FsError 与 MTError 互不继承，必须按 code 形状认')
  assert.match(r.message, /可写/, '可执行提示不能在翻译时丢掉')
})

test('t161-2: MTError 同样透传', () => {
  const r = toolFailureOf(new MTError('MT_TASK_CYCLE', '依赖成环：a → b → a'))
  assert.equal(r.code, 'MT_TASK_CYCLE')
  assert.match(r.message, /依赖成环/)
})

test('t161-3: 普通 Error 仍是 MT_INTERNAL（不伪装成领域码）', () => {
  const r = toolFailureOf(new Error('boom'))
  assert.equal(r.code, 'MT_INTERNAL')
  assert.match(r.message, /boom/)
})

test('t161-4: 非 Error 值也能翻译（不抛）', () => {
  assert.equal(toolFailureOf('weird').code, 'MT_INTERNAL')
  assert.equal(toolFailureOf(undefined).code, 'MT_INTERNAL')
  assert.match(toolFailureOf('weird').message, /weird/)
})

test('t161-5: 只读目录写账本 —— 端到端拿到的是文件系统码，不是 MT_INTERNAL', () => {
  /* 端到端只验「形态」：真实只读目录在 CI/Windows 上不稳定（Windows 的目录只读位不生效），
   * 所以这里构造与 appendEvent 抛出的**同一类**异常，走同一条 commitFailureOf 分支。
   * 真磁盘权限的端到端留给 `t135-atomic-write` 的权限断言。 */
  const r = toolFailureOf(new FsError('MT_FS_SYMLINK_REFUSED', '拒绝对符号链接做整份替换'))
  assert.equal(r.code, 'MT_FS_SYMLINK_REFUSED')
})
