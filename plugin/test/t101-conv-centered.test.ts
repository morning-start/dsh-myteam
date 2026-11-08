/**
 * T101 路 CHG-156：团队视图 = **对话式居中阅读列**（不是满宽面板）。
 *
 * 背景（用户：「团队视图应该改成类似对话式的居中结构」）：
 * 原来 `.mt-conv` 是 `padding:14px 16px` 的满宽面板 —— 2108px 宽屏下一行 2000px，
 * 与「对话」tab 的消息列完全不是一种排版：左边贴边、右边大片空白，读起来没有焦点。
 *
 * 口径（对齐宿主对话列）：
 *  - 正文最多 **720px** 居中，窄屏退回 **28px** 边距；
 *  - 用 `padding-inline: max(28px, calc((100% - 720px) / 2))` 居中，
 *    **不用** `max-width + margin-inline:auto`（后者让滚动条贴到内容上，与宿主对话列不是同一种居中方式）；
 *  - 区块（`.mt-conv-section`）不再各自居中——两处居中 = 边距漂移。
 *
 * 自证：静态断言样式表里的这三条（防回潮）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/** 取某条 CSS 规则（选择器 → 声明串） */
const ruleOf = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`'${escaped}\\{([^}]*)\\}'`))
  return match ? match[1] : null
}

test('T101 ① 团队视图根：720px 居中 + 28px 窄屏边距（用 padding-inline，不用 margin auto）', () => {
  const rule = ruleOf('.mt-conv')
  assert.ok(rule, '`.mt-conv` 规则必须存在')
  assert.match(
    rule,
    /padding-inline:max\(28px,calc\(\(100% - 720px\) \/ 2\)\)/,
    '正文列必须 720px 居中、窄屏 28px 边距',
  )
  assert.match(rule, /padding-block:20px 40px/, '上下留白：20px 起、底部 40px（对话列同款）')
  assert.doesNotMatch(rule, /margin-inline:auto/, '不能用 margin 居中（滚动条会贴到内容上）')
  assert.doesNotMatch(rule, /padding:14px 16px/, '旧的满宽 16px 边距不得回潮')
})

test('T101 ② 区块不再各自居中（只有根负责居中，避免两处居中打架）', () => {
  const rule = ruleOf('.mt-conv-section')
  assert.ok(rule, '`.mt-conv-section` 规则必须存在')
  assert.match(rule, /max-width:none/, '区块宽度交给根 padding，不再自设 max-width')
  assert.doesNotMatch(rule, /margin:0 auto/, '区块不再 margin auto 居中')
  assert.doesNotMatch(rule, /max-width:764px/, '旧的 764px 区块宽度不得回潮')
})

test('T101 ③ 根上不再有满宽 padding 的旧写法（任何一处回潮都会让列宽再次漂移）', () => {
  const occurrences = source.match(/'\.mt-conv\{[^}]*\}'/g) ?? []
  assert.equal(occurrences.length, 1, '`.mt-conv` 只应有一条根规则')
  assert.doesNotMatch(occurrences[0], /padding:14px 16px/, '满宽 padding 不得回潮')
})
