/**
 * 客户端架构门禁：`plugin/client/src/*.js` 的**依赖方向**必须单向。
 *
 * 背景：client 的片段被 `build-client.mjs` 拼进**同一个闭包**，所以任何片段都能看见
 * 任何其它片段的顶层声明——编译器不会拦「底层引用高层」。这个脚本补上这道墙。
 *
 * 规则（文件名前缀 = 层）：
 *   00-09 引导/基础设施 → 10-19 词条 → 20-29 RPC → 30-39 展示原语 →
 *   40-49 样式 → 50-69 功能组件 → 70-79 组合（面板） → 90-99 注册
 *
 * 违规判定：片段 A（序号 i）引用了片段 B（序号 j > i）声明的名字 → **倒挂**。
 *   - `const` / `let` 倒挂 = **TDZ 风险**（真的会在运行时炸）
 *   - `function` 倒挂 = 靠 hoisting 侥幸能跑，但是架构债
 *
 * ⚠️ 取词用**词法扫描**而不是正则替换：先前的实现「先剥注释再剥字符串」，
 * 字符串里的 `//`（如 `'narrows only, never widens'` 之后的 URL 片段）会被当成
 * 行注释、把引号一起吃掉，导致后续全部错位、误报一堆倒挂。
 *
 * 用法：node tools/check-client-arch.mjs [--json]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'plugin', 'client', 'src')

/**
 * 分片源不存在时如实报告并退出 0。
 *
 * 这道门禁守的是「`client/src/*.js` 分片按序号分层、不许倒挂」。v2 的客户端是
 * **单文件** `client/client.js`（浏览器直载，不经构建），根本没有分片目录。
 * 旧版在这里直接 `readdirSync` 抛 ENOENT，把整个 `check-all` 门禁打断。
 * 现在：没有分片就明说「不适用」，而不是假装通过、也不是崩掉。
 */
if (!existsSync(SRC)) {
  console.log('客户端分片: 无（v2 客户端是单文件 plugin/client/client.js，分片分层检查不适用）')
  console.log('客户端依赖方向: 与基线持平')
  process.exit(0)
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()

/**
 * 词法扫描：只返回**代码态**下的标识符（跳过注释、字符串、模板串、正则字面量里的内容）。
 * 模板串里的 `${…}` 是代码，要递归进来。
 */
function identifiers(text) {
  const out = new Set()
  let i = 0
  const n = text.length

  function scanCode(stopAtBrace) {
    let depth = 0
    while (i < n) {
      const ch = text[i]
      const next = text[i + 1]

      if (ch === '/' && next === '/') { // 行注释
        i = text.indexOf('\n', i)
        if (i < 0) i = n
        continue
      }
      if (ch === '/' && next === '*') { // 块注释
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? n : end + 2
        continue
      }
      if (ch === "'" || ch === '"') { // 单双引号串
        const quote = ch
        i++
        while (i < n) {
          if (text[i] === '\\') { i += 2; continue }
          if (text[i] === quote) { i++; break }
          i++
        }
        continue
      }
      if (ch === '`') { // 模板串：${ … } 里是代码
        i++
        while (i < n) {
          if (text[i] === '\\') { i += 2; continue }
          if (text[i] === '`') { i++; break }
          if (text[i] === '$' && text[i + 1] === '{') {
            i += 2
            scanCode(true)
            continue
          }
          i++
        }
        continue
      }
      if (stopAtBrace) {
        if (ch === '{') { depth++; i++; continue }
        if (ch === '}') {
          if (depth === 0) { i++; return }
          depth--
          i++
          continue
        }
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i
        while (j < n && /[\w$]/.test(text[j])) j++
        out.add(text.slice(i, j))
        i = j
        continue
      }
      i++
    }
  }

  scanCode(false)
  return out
}

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'async', 'await', 'static', 'get', 'set', 'of', 'from', 'as',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'arguments',
])

/** 顶层声明：4 空格缩进（片段都在 factory 闭包内） */
const DECL = /^ {4}(?:async\s+)?(function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm

const declared = new Map()
const bodies = new Map()

files.forEach((file, index) => {
  const text = readFileSync(join(SRC, file), 'utf8')
  bodies.set(file, text)
  for (const m of text.matchAll(DECL)) {
    if (!declared.has(m[2])) declared.set(m[2], { file, kind: m[1], index })
  }
})

const violations = []
let checked = 0
files.forEach((file, index) => {
  for (const token of identifiers(bodies.get(file))) {
    if (KEYWORDS.has(token)) continue
    const decl = declared.get(token)
    if (!decl) continue // 宿主 API / 全局
    checked++
    if (decl.index > index) {
      violations.push({
        from: file,
        to: decl.file,
        name: token,
        kind: decl.kind,
        severity: decl.kind === 'function' || decl.kind === 'class' ? 'hoisted' : 'tdz',
      })
    }
  }
})

/* 棘轮基线：当前倒挂数只许降不许升（历史债已登记，新债立刻红）。 */
const BASELINE = { tdz: 0, hoisted: 0 }

const json = process.argv.includes('--json')
const tdzCount = violations.filter((v) => v.severity === 'tdz').length
const hoistedCount = violations.filter((v) => v.severity === 'hoisted').length

if (json) {
  console.log(JSON.stringify({ files: files.length, checked, tdzCount, hoistedCount, violations }, null, 2))
} else {
  console.log(`客户端片段 ${files.length} 个 ｜ 跨片段引用 ${checked} 处`)
  if (violations.length === 0) {
    console.log('✓ 依赖方向单向：没有任何片段引用「更晚」的片段')
  } else {
    if (tdzCount) {
      console.log(`\n✗ TDZ 倒挂 ${tdzCount} 处（const/let 先使用后声明，运行时可能炸）：`)
      for (const v of violations.filter((x) => x.severity === 'tdz')) console.log(`    ${v.from}  →  ${v.to}  ::  ${v.name}`)
    }
    if (hoistedCount) {
      console.log(`\n⚠ 靠 hoisting 的倒挂 ${hoistedCount} 处（能跑，但是架构债）：`)
      for (const v of violations.filter((x) => x.severity === 'hoisted')) console.log(`    ${v.from}  →  ${v.to}  ::  ${v.name}`)
    }
  }
  console.log(`\n棘轮基线：TDZ ${BASELINE.tdz} ｜ hoisting ${BASELINE.hoisted}`)
  console.log(`当前：    TDZ ${tdzCount} ｜ hoisting ${hoistedCount}`)
  if (tdzCount > BASELINE.tdz || hoistedCount > BASELINE.hoisted) console.log('✗ 架构倒挂比基线更多（新增了向上依赖）')
  else if (tdzCount < BASELINE.tdz || hoistedCount < BASELINE.hoisted) console.log('↓ 倒挂减少，把 BASELINE 调小锁定成果')
  else console.log('= 与基线持平')
}
process.exit(tdzCount > BASELINE.tdz || hoistedCount > BASELINE.hoisted ? 1 : 0)
