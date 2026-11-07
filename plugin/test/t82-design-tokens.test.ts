/**
 * T82（CHG-98）：设计稿 token ↔ 宿主 alias 的映射门禁（审计 C11）。
 *
 * 背景：`design/tokens.css` 原来有 108 个自建色板变量、**零**处 `--dsw-alias-*`，
 * 靠 `design-notes.md` §六 的人工对照表映射到宿主。宿主把 blue-450 调成 blue-500 时，
 * 生产侧 780 处 `--dsw-alias-*` 自动跟随，设计稿 108 个变量停在旧值 —— 评审拿设计稿
 * 对照生产，颜色对不上，原因藏在 27 个 HTML 之外。
 *
 * 修法：凡宿主确有对应 alias 的角色，定义写成 `var(--dsw-alias-xxx, 原值)`。
 * 本测试守三件事：
 *   1. 映射覆盖率达到下限（防有人改回去）；
 *   2. 不存在「纯 hex 且无 fallback」的本该映射的变量；
 *   3. 成员四色（宿主无对应物）必须保留，别被误删。
 *
 * 运行：`cd plugin && node --test test/t82-design-tokens.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tokensPath = join(root, '..', 'design', 'tokens.css')
const notesPath = join(root, '..', 'design', 'design-notes.md')

function readTokens(): string {
  assert.ok(existsSync(tokensPath), `缺 design/tokens.css（设计变量单一来源）: ${tokensPath}`)
  return readFileSync(tokensPath, 'utf8')
}

/**
 * 宿主真实存在的 alias 中，**本项目设计稿确实用得上**的那些。
 *
 * 与 `grep -o 'dsw-alias-[a-z0-9-]*' plugin/client/client.js | sort -u` 的 16 个对齐，
 * 但剔除 `border-accent` —— 它是**描边**主色，没有对应的 `bg-accent`，
 * 拿它当 `--primary`（实底填充）会取错色，所以主色阶整组保留字面值（见 MUST_STAY_LITERAL）。
 * 新增宿主 token 且本项目要用时，在这里加一项；同时 `tokens.css` 里补映射。
 */
const HOST_ALIASES = [
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'surface-raised',
  'label-primary', 'label-secondary', 'label-tertiary', 'label-emphasis',
  'border-l2', 'border-l3', 'border-warning', 'line-soft',
  'state-ok-primary', 'state-warning-primary', 'state-error-primary',
] as const

/** 必须有宿主映射的角色（缺一个就是漂移复发）。 */
const MUST_MAP = [
  '--bg', '--surface', '--surface-2', '--surface-3',
  '--line', '--line-soft', '--line-strong',
  '--text', '--text-2', '--muted', '--muted-2',
  '--run', '--gate', '--gate-line', '--done', '--fail',
] as const

/** 本项目特有、宿主无对应物 → 必须保留字面值。 */
const MUST_STAY_LITERAL = [
  '--m1-bg', '--m1-line', '--m1-ink',
  '--m2-bg', '--m2-line', '--m2-ink',
  '--m3-bg', '--m3-line', '--m3-ink',
  '--m4-bg', '--m4-line', '--m4-ink',
  '--primary', '--primary-deep', '--primary-hover', '--primary-solid',
] as const

test('T79: 每个宿主 alias 在 tokens.css 里都被引用（映射不是摆设）', () => {
  const css = readTokens()
  const missing = HOST_ALIASES.filter((alias) => !css.includes(`--dsw-alias-${alias}`))
  assert.deepEqual(missing, [], `这些宿主 alias 没被设计稿引用：${missing.join(', ')}`)
})

test('T79: 必须映射的角色都写成 var(--dsw-alias-*, fallback)', () => {
  const css = readTokens()
  const missing: string[] = []
  for (const name of MUST_MAP) {
    // 匹配 `--name:` 后面 200 字符内出现 var(--dsw-alias-
    const re = new RegExp(`${name}\\s*:\\s*var\\(--dsw-alias-[a-z0-9-]+,\\s*[^)]+\\)`, 'm')
    if (!re.test(css)) missing.push(name)
  }
  assert.deepEqual(missing, [], `这些角色没映射到宿主 alias（漂移复发）：${missing.join(', ')}`)
})

test('T79: 成员四色与主色阶保留字面值（宿主无对应物，别误删）', () => {
  const css = readTokens()
  const missing = MUST_STAY_LITERAL.filter((name) => !new RegExp(`${name}\\s*:`).test(css))
  assert.deepEqual(missing, [], `这些本项目特有变量被删了：${missing.join(', ')}`)
  // 反向：它们不该被映射到宿主 alias（宿主没有这些角色）
  const wronglyMapped = MUST_STAY_LITERAL.filter((name) =>
    new RegExp(`${name}\\s*:\\s*var\\(--dsw-alias-`, 'm').test(css))
  assert.deepEqual(wronglyMapped, [],
    `这些变量被硬映射到了宿主 alias，但宿主没有对应角色（会取错色）：${wronglyMapped.join(', ')}`)
})

test('T79: 映射覆盖率达标（≥15 处 var(--dsw-alias-），深浅两段各半', () => {
  const css = readTokens()
  const total = (css.match(/var\(--dsw-alias-/g) ?? []).length
  assert.ok(total >= 15, `var(--dsw-alias-*) 只有 ${total} 处，应 ≥15（对照 CHG-98 的 16 个角色 × 深浅两段）`)

  // 深色段（@media prefers-color-scheme 之后）也必须映射，否则深色不跟随宿主
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)')
  assert.ok(darkStart > 0, '找不到深色段')
  const darkPart = css.slice(darkStart)
  const darkMapped = (darkPart.match(/var\(--dsw-alias-/g) ?? []).length
  assert.ok(darkMapped >= 7,
    `深色段只有 ${darkMapped} 处宿主映射，应 ≥7 —— 否则宿主切深色时设计稿不跟随`)
})

test('T79: design-notes 说明了映射策略（不再有「变量名不动」的错误表述）', () => {
  const notes = readFileSync(notesPath, 'utf8')
  assert.ok(notes.includes('var(--dsw-alias-xxx, 本项目原值)'),
    'design-notes 应说明设计稿内部名到宿主 alias 的映射写法')
  assert.ok(notes.includes('t82-design-tokens.test.ts'),
    'design-notes 应指向本测试（防回归的入口）')
  assert.ok(!notes.includes('变量名不动'),
    '「变量名不动」是错误表述：生产侧用的是 --dsw-alias-*，设计稿内部名并不存在于生产')
})
