/**
 * T138 · 静态门禁：**Hook 不能落在早退之后**（React #310 的根因）
 *
 * 背景（CHG-178 / U1）：
 *   `Panel` 里 `const [guestBusy, setGuestBusy] = react.useState(false)` 写在两个早退
 *   （`scope === 'global'` 的预设/技能子页、全局角色库、`if (!pv)` 加载态）**之后**。
 *   「全局」作用域走早退 → 后面的 hook 一个都不调用；切到「项目」作用域不再早退 →
 *   hook 数量变多 → React 抛 **#310（Rendered more hooks than during the previous render）**，
 *   整块面板被错误边界接住，用户看到的是「面板渲染失败」。
 *
 *   这个缺陷**单测全绿、逐屏截图也看不出来**（截图只能截到已经崩掉的那一屏），
 *   只有「全局 → 项目」切一次才会炸。所以把它变成静态门禁：
 *
 * 规则：对 `plugin/client/client.js` 里每个函数体，收集**任何深度**的 `return`；
 *   若某个 `react.useXxx(` 调用之前，同一函数体内已存在 `return`（早退），即判失败。
 *   嵌套函数里的 `return` 不算（`return` 只挂到最近的函数体上）。
 *
 * 为什么不能只判「顶层 return」：早退一般写成 `if (cond) { ... return ... }`，
 *   return 在 if 块里、不在函数体顶层——第一版扫描器就是这么漏掉 11839 行的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

/** 极简词法：只需要「括号配对」+「不把字符串/注释/模板里的字符当代码」 */
function tokenize(text) {
  const tokens = []
  let i = 0
  const n = text.length
  const modeStack = ['code']
  const braceStack = []
  let line = 1
  let prev = null
  const isIdStart = (c) => /[A-Za-z_$]/.test(c)
  const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c)

  while (i < n) {
    const c = text[i]
    const mode = modeStack[modeStack.length - 1]
    if (c === '\n') { line++; i++; continue }
    if (mode === 'template') {
      if (c === '\\') { i += 2; continue }
      if (c === '`') { modeStack.pop(); tokens.push({ type: 'template', value: '`', line }); prev = '`'; i++; continue }
      if (c === '$' && text[i + 1] === '{') { modeStack.push('code'); braceStack.push(0); i += 2; continue }
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++ } i += 2; continue }
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < n && text[i] !== quote) { if (text[i] === '\\') i++; else if (text[i] === '\n') line++; i++ }
      i++
      tokens.push({ type: 'string', value: quote + quote, line })
      prev = 'string'
      continue
    }
    if (c === '`') { modeStack.push('template'); i++; prev = '`'; continue }
    if (c === '/') {
      const regexAllowed = !prev || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await'].includes(prev)
      if (regexAllowed) {
        i++
        let inClass = false
        while (i < n) {
          const ch = text[i]
          if (ch === '\\') { i += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) { i++; break }
          else if (ch === '\n') break
          i++
        }
        while (i < n && /[a-z]/.test(text[i])) i++
        tokens.push({ type: 'regex', value: '/re/', line })
        prev = 'regex'
        continue
      }
    }
    if (isIdStart(c)) {
      let j2 = i + 1
      while (j2 < n && isIdPart(text[j2])) j2++
      const word = text.slice(i, j2)
      tokens.push({ type: 'ident', value: word, line })
      prev = word
      i = j2
      continue
    }
    if (/[0-9]/.test(c)) {
      let j2 = i + 1
      while (j2 < n && /[0-9a-zA-Z._]/.test(text[j2])) j2++
      tokens.push({ type: 'number', value: text.slice(i, j2), line })
      prev = 'number'
      i = j2
      continue
    }
    if (c === '{') { if (braceStack.length) braceStack[braceStack.length - 1]++; tokens.push({ type: 'punct', value: '{', line }); prev = '{'; i++; continue }
    if (c === '}') {
      if (braceStack.length) {
        braceStack[braceStack.length - 1]--
        if (braceStack[braceStack.length - 1] < 0) { braceStack.pop(); modeStack.pop(); i++; prev = '}'; continue }
      }
      tokens.push({ type: 'punct', value: '}', line })
      prev = '}'
      i++
      continue
    }
    const two = text.slice(i, i + 2)
    if (['=>', '&&', '||', '??', '==', '!=', '<=', '>='].includes(two)) { tokens.push({ type: 'punct', value: two, line }); prev = two; i += 2; continue }
    tokens.push({ type: 'punct', value: c, line })
    prev = c
    i++
  }
  return tokens
}

const matchBack = (tokens, idx, open, close) => {
  let depth = 0
  for (let k = idx; k >= 0; k--) {
    if (tokens[k].value === close) depth++
    else if (tokens[k].value === open) { depth--; if (depth === 0) return k }
  }
  return -1
}

/** 这个 `{` 是不是函数体？（if/for/while/switch/catch 的块不算） */
const fnInfoOf = (tokens, braceIdx) => {
  const prevTok = tokens[braceIdx - 1]
  if (!prevTok) return null
  if (prevTok.value === '=>') {
    const before = tokens[braceIdx - 2]
    if (before && before.value === ')') {
      const open = matchBack(tokens, braceIdx - 2, '(', ')')
      const left = open > 0 ? tokens[open - 1] : null
      return { kind: 'arrow', name: left && left.type === 'ident' && !['const', 'let', 'var'].includes(left.value) ? left.value : null }
    }
    if (before && before.type === 'ident') return { kind: 'arrow', name: before.value }
    return { kind: 'arrow', name: null }
  }
  if (prevTok.value === ')') {
    const open = matchBack(tokens, braceIdx - 1, '(', ')')
    if (open < 0) return null
    const before = tokens[open - 1]
    if (before && before.value === 'function') return { kind: 'function', name: tokens[open - 2]?.value ?? null }
    if (before && before.type === 'ident' && !['if', 'for', 'while', 'switch', 'catch', 'with'].includes(before.value)) return { kind: 'method', name: before.value }
    return null
  }
  if (prevTok.value === 'function') return { kind: 'function', name: tokens[braceIdx - 2]?.value ?? null }
  return null
}

const isHookCallAt = (tokens, idx) => {
  const [a, b, c, d] = [tokens[idx], tokens[idx + 1], tokens[idx + 2], tokens[idx + 3]]
  return Boolean(a && a.type === 'ident' && a.value === 'react' && b && b.value === '.' && c && c.type === 'ident' && /^use[A-Z]/.test(c.value) && d && d.value === '(')
}

/** 扫出「早退之后仍调用 hook」的位置 */
export function findHooksAfterEarlyReturn(source) {
  const tokens = tokenize(source)
  const blockStack = []
  const fnReturns = new Map()
  const findings = []
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]
    if (tok.value === '{') { blockStack.push({ idx, fn: fnInfoOf(tokens, idx) }); continue }
    if (tok.value === '}') { blockStack.pop(); continue }
    if (tok.type === 'ident' && tok.value === 'return') {
      const fnBlock = [...blockStack].reverse().find((b) => b.fn)
      if (fnBlock) {
        if (!fnReturns.has(fnBlock.idx)) fnReturns.set(fnBlock.idx, [])
        fnReturns.get(fnBlock.idx).push(idx)
      }
      continue
    }
    if (isHookCallAt(tokens, idx)) {
      const fnBlock = [...blockStack].reverse().find((b) => b.fn)
      if (!fnBlock) continue
      const returns = (fnReturns.get(fnBlock.idx) ?? []).filter((r) => r < idx)
      if (returns.length > 0) {
        findings.push({
          line: tok.line,
          hook: tokens[idx + 2].value,
          fn: fnBlock.fn.name ?? '(anonymous)',
          fnLine: tokens[fnBlock.idx].line,
          earlyReturnLine: tokens[returns[returns.length - 1]].line,
        })
      }
    }
  }
  return findings
}

test('t138-0: 扫描器自检——早退后的 hook 必须被抓到（否则门禁是摆设）', () => {
  const sample = [
    'function Panel({ scope }) {',
    '  const [a] = react.useState(1)',
    '  if (scope === "global") {',
    '    return null',
    '  }',
    '  const [b] = react.useState(2)',
    '  return a + b',
    '}',
  ].join('\n')
  const found = findHooksAfterEarlyReturn(sample)
  assert.equal(found.length, 1)
  assert.equal(found[0].hook, 'useState')
  assert.equal(found[0].fn, 'Panel')
  assert.equal(found[0].line, 6)
})

test('t138-1: 嵌套函数里的 return 不算早退（不算父组件的 hook 顺序变化）', () => {
  const sample = [
    'function Panel() {',
    '  const [a] = react.useState(1)',
    '  const onOk = () => {',
    '    if (!a) return',
    '    console.log(a)',
    '  }',
    '  const [b] = react.useState(2)',
    '  return [a, b, onOk]',
    '}',
  ].join('\n')
  assert.deepEqual(findHooksAfterEarlyReturn(sample), [])
})

test('t138-2: client.js 里没有任何 hook 落在早退之后（React #310 静态门禁）', () => {
  const source = readFileSync(clientPath, 'utf8')
  const findings = findHooksAfterEarlyReturn(source)
  const detail = findings
    .map((f) => `  ${f.hook} @ client.js:${f.line} —— 在 ${f.fn}（函数体 L${f.fnLine}）的早退 L${f.earlyReturnLine} 之后`)
    .join('\n')
  assert.deepEqual(
    findings,
    [],
    `发现 ${findings.length} 处「早退之后才调用的 Hook」——切换作用域时 hook 数量会变，React 抛 #310 整屏崩：\n${detail}\n` +
    '修法：把 hook 声明上移到组件顶部（所有早退之前），副作用/回调留在原处。',
  )
})
