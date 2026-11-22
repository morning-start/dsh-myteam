/**
 * T82（CHG-98 → v2 重写）：设计稿 token 的单一来源与宿主 alias 映射门禁（审计 C11）。
 *
 * 历史：v1 设计稿（`design/`）曾有 108 个自建变量、零处 `--dsw-alias-*`，靠人工对照表
 * 映射宿主；宿主换色时设计稿不动，评审对不上色。CHG-98 用「var(--dsw-alias-*, 原值)」修掉。
 *
 * v2 重写后，设计稿是 `design-v2/`：
 *   - 颜色与阴影**只**存在于 `tokens.css`（`--mt-*` 语义层叠在宿主 `--dsh-*` 之上）；
 *   - `myteam.css` 只许用变量，不许写裸色值；
 *   - 宿主有对应 alias 的角色仍写成 `var(--dsw-alias-*, fallback)`，深浅两段都要写；
 *   - 每一屏都必须先引 `tokens.css` 再引 `myteam.css`。
 *
 * 本测试守这五件事。运行：`cd plugin && node --test test/t82-design-tokens.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const designDir = join(root, '..', 'design-v2')
const tokensPath = join(designDir, 'tokens.css')
const cssPath = join(designDir, 'myteam.css')
const readmePath = join(designDir, 'README.md')

function read(p: string, label: string): string {
  assert.ok(existsSync(p), `缺 ${label}: ${p}`)
  return readFileSync(p, 'utf8')
}

/** 取 `:root` 段（到 [data-theme="dark"] 之前）与深色段；统计前先剥掉注释。 */
function splitThemes(css: string): { light: string; dark: string } {
  const darkMark = css.indexOf('[data-theme="dark"]')
  assert.ok(darkMark > 0, 'tokens.css 缺 [data-theme="dark"] 深色段')
  const clean = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  return { light: clean(css.slice(0, darkMark)), dark: clean(css.slice(darkMark)) }
}

const defined = (css: string): string[] =>
  [...css.matchAll(/(--mt-[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string)

test('T82: tokens.css 是唯一的色值来源，myteam.css 里没有裸色值', () => {
  const css = read(cssPath, 'myteam.css')
  const raw = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
  assert.deepEqual(raw, [], `myteam.css 里出现了裸色值（应写进 tokens.css）：${raw.join(', ')}`)
})

test('T82: myteam.css 用到的每个 --mt-* 都在 tokens.css 里有定义', () => {
  const css = read(cssPath, 'myteam.css')
  const tokens = read(tokensPath, 'tokens.css')
  const used = [...new Set([...css.matchAll(/var\((--mt-[a-z0-9-]+)/g)].map((m) => m[1] as string))]
  const known = new Set(defined(splitThemes(tokens).light))
  const missing = used.filter((name) => !known.has(name))
  assert.deepEqual(missing, [], `这些变量在页面里用了但 tokens.css 没定义：${missing.join(', ')}`)
  assert.ok(used.length >= 8, `只用到 ${used.length} 个 --mt-* 变量，令牌层像是被架空了`)
})

test('T82: 深浅两段都写全同名变量（切深色不会丢令牌）', () => {
  const { light, dark } = splitThemes(read(tokensPath, 'tokens.css'))
  const lightNames = new Set(defined(light))
  const darkNames = new Set(defined(dark))
  const missing = [...lightNames].filter((name) => !darkNames.has(name))
  assert.deepEqual(missing, [], `深色段缺这些变量：${missing.join(', ')}`)
})

test('T82: 宿主 alias 映射两段都在（跟随宿主主题，不是摆设）', () => {
  const { light, dark } = splitThemes(read(tokensPath, 'tokens.css'))
  const mapped = (css: string) => [...css.matchAll(/var\(--dsw-alias-[a-z0-9-]+/g)].length
  assert.ok(mapped(light) >= 5, `浅色段只有 ${mapped(light)} 处 var(--dsw-alias-*)，应 ≥5`)
  assert.ok(mapped(dark) >= 5, `深色段只有 ${mapped(dark)} 处 var(--dsw-alias-*)，应 ≥5`)
  // 映射必须带 fallback，否则独立打开设计稿会取不到色
  const noFallback = light.match(/var\(--dsw-alias-[a-z0-9-]+\)/g) ?? []
  assert.deepEqual(noFallback, [], `这些宿主 alias 没写 fallback：${noFallback.join(', ')}`)
})

test('T82: 每一屏都先引 tokens.css 再引 myteam.css', () => {
  const screens = readdirSync(designDir).filter((f) => f.endsWith('.html'))
  assert.ok(screens.length >= 20, `design-v2 只有 ${screens.length} 屏，像是目录指错了`)
  const bad: string[] = []
  for (const file of screens) {
    const html = readFileSync(join(designDir, file), 'utf8')
    const tokensAt = html.indexOf('href="tokens.css"')
    const cssAt = html.indexOf('href="myteam.css"')
    if (tokensAt < 0 || cssAt < 0 || tokensAt > cssAt) bad.push(file)
  }
  assert.deepEqual(bad, [], `这些屏的样式引入顺序不对（tokens.css 必须在 myteam.css 之前）：${bad.join(', ')}`)
})

test('T82: README 说明了 token 规则并指向本测试', () => {
  const readme = read(readmePath, 'design-v2/README.md')
  assert.ok(readme.includes('tokens.css'), 'README 应说明 tokens.css 是唯一色值来源')
  assert.ok(readme.includes('--dsw-alias-') || readme.includes('--dsh-'), 'README 应说明与宿主变量的关系')
  assert.ok(readme.includes('t82-design-tokens.test.ts'), 'README 应指向本测试（防回归入口）')
})
