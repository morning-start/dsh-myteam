/**
 * T101 路 CHG-156 / CHG-167：团队视图 = **对话式居中阅读列**（不是满宽面板）。
 *
 * 背景（用户：「团队视图应该改成类似对话式的居中结构」）：
 * 原来 `.mt-conv` 是 `padding:14px 16px` 的满宽面板 —— 2108px 宽屏下一行 2000px，
 * 与「对话」tab 的消息列完全不是一种排版：左边贴边、右边大片空白，读起来没有焦点。
 *
 * 口径（对齐宿主对话列）：
 *  - 正文居中，窄屏退回 **28px** 边距；
 *  - 用 `padding-inline: max(28px, calc((100% - <列宽>) / 2))` 居中，
 *    **不用** `max-width + margin-inline:auto`（后者让滚动条贴到内容上，与宿主对话列不是同一种居中方式）；
 *  - 区块（`.mt-conv-section`）不再各自居中——两处居中 = 边距漂移。
 *
 * CHG-167（用户：「宽度太窄了，扩展一下宽度。保持居中」）：
 * 列宽 **720 → 1400**。720 是「纯文字对话」的阅读列宽，但团队视图首页是**多列看板 + 四张统计卡
 * + 总览分段条**：720 下四列泳道挤成窄缝、卡标题逐字折行。看板类界面的「一眼看全局」靠宽度，
 * 不靠行长。本文件同时锁住**「居中方式」与「列宽的两个边界」**（宽屏够宽 / 窄屏不溢出）。
 *
 * 自证：静态断言样式表里的这几条（防回潮）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/** 团队视图正文列宽（px）。改这个数字必须同时改下面两条边界断言。 */
const CONV_COLUMN_PX = 1400

/** 取某条 CSS 规则（选择器 → 声明串） */
const ruleOf = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`'${escaped}\\{([^}]*)\\}'`))
  return match ? match[1] : null
}

test('T101 ① 团队视图根：1400px 居中 + 28px 窄屏边距（用 padding-inline，不用 margin auto）', () => {
  const rule = ruleOf('.mt-conv')
  assert.ok(rule, '`.mt-conv` 规则必须存在')
  assert.match(
    rule,
    new RegExp(`padding-inline:max\\(28px,calc\\(\\(100% - ${CONV_COLUMN_PX}px\\) / 2\\)\\)`),
    `正文列必须 ${CONV_COLUMN_PX}px 居中、窄屏 28px 边距`,
  )
  assert.match(rule, /padding-block:20px 40px/, '上下留白：20px 起、底部 40px（对话列同款）')
  assert.doesNotMatch(rule, /margin-inline:auto/, '不能用 margin 居中（滚动条会贴到内容上）')
  assert.doesNotMatch(rule, /padding:14px 16px/, '旧的满宽 16px 边距不得回潮')
})

test('T101 ①b 列宽边界：够宽（看板不挤）且窄屏不溢出（max(28px,…) 兜底）', () => {
  /* ① 下界：720px 是「纯文字对话」列宽，团队视图首页要放四列泳道 + 四张卡 → 必须 > 1000px，
   *    否则任务卡标题会逐字折行（用户实测的「宽度太窄」）。 */
  assert.ok(CONV_COLUMN_PX >= 1000, `团队视图列宽 ${CONV_COLUMN_PX}px 过窄：看板列会挤成窄缝`)
  /* ② 上界：再宽就回到「一行 2000px 没人读」的老问题（CHG-156 的动机）。 */
  assert.ok(CONV_COLUMN_PX <= 1400, `团队视图列宽 ${CONV_COLUMN_PX}px 过宽：回到满宽面板的阅读问题`)
  /* ③ 不溢出：视口 < 列宽+56 时 calc() 为负，必须靠 max(28px, …) 兜底而不是出现负边距 */
  const rule = ruleOf('.mt-conv')
  assert.match(rule, /max\(28px,/, '窄屏必须有正边距兜底（负 padding 会让内容溢出容器）')
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

test('T101 ④ 空态内容列（CHG-180~182）：面板铺满会话区，内容**左对齐** + 1080px 宽列', () => {
  /* 三轮收敛（每轮都是用户看真机截图提的）：
   *   CHG-180 内容跟阅读列一样左对齐 → 右侧 700+px 空白，像「只写了一半」；
   *   CHG-181 把根收窄到 760px 居中 → 面板只占中间一条（红框那片被浪费）；
   *   CHG-182（用户：「不是完全居中，是类似（记忆页）这样的方式，但是优化一下宽度，要更宽」）：
   *   **面板铺满 + 内容左对齐 + 列宽 1080px**（比 760 宽、比 1400 窄），四张计数卡等分铺满列宽。 */
  const rule = ruleOf('.mt-conv-empty')
  assert.ok(rule, '`.mt-conv-empty` 规则必须存在（空态修饰根）')
  assert.match(rule, /text-align:left/, '空态文字左对齐（不是完全居中）')
  assert.doesNotMatch(rule, /justify-content:center/, '不做整块垂直居中（跟「记忆」页一致的顶对齐）')
  assert.doesNotMatch(rule, /max-width:/, '面板根不得收窄（面板要铺满会话区）')
  assert.doesNotMatch(rule, /margin-inline:auto/, '面板根不再靠 margin 收窄')
  /* 内容列宽落在 head / body 上：1080px、左对齐（没有 margin auto） */
  for (const sel of ['.mt-conv-empty .mt-conv-head', '.mt-conv-empty .mt-conv-body']) {
    const content = ruleOf(sel)
    assert.match(content, /max-width:1080px/, `${sel} 内容列 1080px`)
    assert.doesNotMatch(content, /margin-inline:auto/, `${sel} 左对齐（不再 margin auto 居中）`)
  }
  /* 计数卡等分铺满整列（「记忆」页四张卡的口径），不是挤在左边一小撮 */
  assert.match(ruleOf('.mt-conv-empty .mt-conv-stats'), /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, '四张计数卡等分铺满列宽')
  /* 只有空态那个分支挂 `.mt-conv-empty`；有数据的团队视图仍走阅读列 */
  const emptyHits = source.match(/className: 'mt-conv mt-conv-empty'/g) ?? []
  assert.equal(emptyHits.length, 1, '空态根必须**恰好一处**带 mt-conv-empty')
})
