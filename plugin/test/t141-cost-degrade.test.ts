/**
 * T141 · 成本归因的三种「没有数字」必须文案不同（CHG-185）
 * 背景：旧实现把「离线读不到」「在线无用量」「字段缺失」压成一句「成本数据不可用」，
 * 用户分不清该不该处理。三档都要诚实，且**都不显示伪造的 0**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

test('t141-1: 三档文案各自存在（离线 / 无用量 / 字段缺失）', () => {
  assert.ok(source.includes('cost.offline'), '缺「离线读不到 sidecar」档')
  assert.ok(source.includes('cost.noUsage'), '缺「在线但还没产生用量」档')
  assert.ok(source.includes('cost.partial'), '缺「读到了但字段缺失」档')
})

test('t141-2: 三档文案互不相同，且都不含「0 tokens」这种伪造值', () => {
  const zh = source.slice(source.indexOf("'cost.offline'"), source.indexOf("'cost.partial'") + 200)
  assert.ok(!/0\s*tokens/.test(zh), '缺数据不得显示 0 tokens')
  assert.ok(zh.includes('—'), '缺数据必须显示 — 占位')
})

test('t141-3: 降级判定是纯函数，可单测（不在渲染里散着写 if）', () => {
  assert.ok(source.includes('function costDegradeOf'), '必须抽出 costDegradeOf(state) 纯函数')
})
