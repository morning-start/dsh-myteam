/**
 * 死词条分析：只从 `const zh = {...}` / `const en = {...}` 两个**词条表**里取 key，
 * 再统计全仓对每个 key 的引用。
 *
 * 为什么要限定范围：`'aria-label'` / `'data-testid'` 这类 JSX 属性名也是
 * `'xxx':` 形状，全文正则会把它们误当成词条。
 *
 * ── CHG-202x（P0 收口）：**修掉一个假阳性 bug** ────────────────────────────────
 * 旧版只统计 `t('key')` 字面量调用，于是**经查表取词条**的写法全被误判成死词条：
 *   - `FIELD_LABEL_KEY = { deps: 'field.deps', … }` → 之后 `t(FIELD_LABEL_KEY[f])`
 *   - `roster.menu.*` 由字符串前缀拼出
 * 结果报了 36 条「死词条」，其中 35 条**其实活在源码里**——一份会误报的分析器
 * 证明不了「死代码 0」。现在的口径：
 *   ① 引用 = 该 key 作为**字符串字面量**出现在任何被扫描文件里（不含两张词条表自身）；
 *   ② 动态前缀（`t(\`prefix.\${x}\`)` / `t('prefix.' + x)`）整体算「可能用到」；
 *   ③ 两者都不满足才算死。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CLIENT = resolve('plugin/client/client.js')
const lines = readFileSync(CLIENT, 'utf8').split(/\r?\n/)

/** 从 `const <name> = {` 那一行开始，括号配平取出表体行（含起止行号） */
function tableRange(name) {
  const start = lines.findIndex((l) => new RegExp(`^\\s*const ${name} = \\{`).test(l))
  if (start < 0) throw new Error(`找不到词条表 ${name}`)
  let depth = 0
  let started = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true } else if (ch === '}') depth--
    }
    if (started && depth === 0) return { start, end: i, lines: lines.slice(start, i + 1) }
  }
  throw new Error(`词条表 ${name} 括号不配平`)
}

const zhRange = tableRange('zh')
const enRange = tableRange('en')
const keyOf = (tableLines) => new Set(tableLines.flatMap((l) => [...l.matchAll(/^\s+'([^']+)':/g)].map((m) => m[1])))
const zhKeys = keyOf(zhRange.lines)
const enKeys = keyOf(enRange.lines)

/** 词条表自身的行号（扫描时要排除，否则每个 key 都会「命中自己」） */
const tableLinesOf = (file) => (file === CLIENT ? new Set([...range(zhRange.start, zhRange.end), ...range(enRange.start, enRange.end)]) : new Set())
function* range(a, b) { for (let i = a; i <= b; i++) yield i }

// 全仓（客户端 + 服务端 + tools + 测试）的引用
const used = new Set()
const dynamic = []
/** 所有被扫描文件的**非词条表**正文（字面量引用判定用） */
const corpus = []
function scan(file) {
  const raw = readFileSync(file, 'utf8').split(/\r?\n/)
  const skip = tableLinesOf(file)
  const text = raw.filter((_, i) => !skip.has(i)).join('\n')
  corpus.push(text)
  for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1])
  for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1])
  for (const m of text.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) dynamic.push(m[1])
  // 字符串拼接：t('prefix.' + x) —— 前缀要整体当「可能用到」
  for (const m of text.matchAll(/\bt\(\s*'([^']*)'\s*\+/g)) dynamic.push(m[1])
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.debug' || name === 'lib') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(js|mjs|ts)$/.test(name)) scan(full)
  }
}
scan(CLIENT)
for (const d of ['plugin/test', 'plugin/scripts', 'tools']) {
  try { walk(resolve(d)) } catch { /* 目录可能不存在 */ }
}
const blob = corpus.join('\n')

const isDyn = (k) => dynamic.some((p) => p.length > 0 && k.startsWith(p))
/** 字面量引用：'key' 出现在任何被扫描文件的正文里（查表 / 拼接前缀之外的兜底口径） */
const isLiteral = (k) => blob.includes(`'${k}'`) || blob.includes(`"${k}"`) || blob.includes(`\`${k}\``)
const deadZh = [...zhKeys].filter((k) => !used.has(k) && !isDyn(k) && !isLiteral(k)).sort()
const deadEn = [...enKeys].filter((k) => !used.has(k) && !isDyn(k) && !isLiteral(k)).sort()
const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))

console.log(`zh 词条: ${zhKeys.size}`)
console.log(`en 词条: ${enKeys.size}`)
console.log(`被 t() 字面量引用: ${used.size} ｜ 动态前缀: ${dynamic.filter(Boolean).length}`)
console.log(`只 zh 有: ${onlyZh.length}${onlyZh.length ? ' -> ' + onlyZh.join(', ') : ''}`)
console.log(`只 en 有: ${onlyEn.length}${onlyEn.length ? ' -> ' + onlyEn.join(', ') : ''}`)

console.log(`\n死词条（zh 侧）: ${deadZh.length}`)
for (const d of deadZh) console.log('  DEAD ' + d)
if (deadEn.length > 0) {
  console.log(`\n死词条（en 侧）: ${deadEn.length}`)
  for (const d of deadEn) console.log('  DEAD-EN ' + d)
}
process.exitCode = deadZh.length + deadEn.length + onlyZh.length + onlyEn.length > 0 ? 1 : 0
