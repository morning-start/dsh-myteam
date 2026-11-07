/**
 * T81（CHG-98）：错误码单一来源门禁（审计 A7）。
 *
 * 背景：`MT_*` 改名前是散落在 250 余处调用点的**字符串字面量**，`docs/04` 的散文里
 * 提到一部分，没有任何东西保证两边一致 —— 实测**实现 70 个、文档只覆盖 32 个**，
 * 其中 3 个文档写了但**根本没有实现**（`MT_CLARIFY_OPEN` / `MT_ESCALATE_BUDGET` /
 * `MT_CONFIG_INVALID`），客户端 10 处按码分支的代码在静默失效。
 *
 * 现在 `plugin/src/core/errors.ts` 是唯一来源，本测试守五件事：
 *   1. 源码里出现的每个 `MT_*` 字面量都在 `MT_CODES` 里（防拼错）；
 *   2. `MT_CODES` 里每个码在源码里**至少被用一次**（防孤儿码）；
 *   3. 每个码都有说明（`MT_CODE_DOCS` 不漏项）；
 *   4. `docs/04` 里出现的每个码都在 `MT_CODES` 里（文档不能写不存在的码）；
 *   5. `MT_CODES` 里每个码都出现在 `docs/04`（不能有未文档化的码）。
 *
 * 运行：`cd plugin && node --test test/t81-error-codes.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MT_CODES, MT_CODE_DOCS, isMtCode } from '../src/core/errors.ts'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const srcDir = join(root, 'src')
const errorsFile = join(root, 'src', 'core', 'errors.ts')
const docsPath = join(root, '..', 'docs', '04-API与数据契约.md')

const MT_RE = /MT_[A-Z][A-Z_]*/g

/**
 * 已删除、仅在文档里作为「为什么删」的说明出现的码。
 *
 * 它们**没有任何实现**，也不该出现在客户端分支里；文档保留名字是为了让后来的人
 * 知道「这三个曾经存在过、去哪了」，避免有人照着旧 CHG 再实现一遍。
 * 加东西进这里必须先证明「确实删了」，否则就是给幽灵码开后门。
 */
const REMOVED_CODES = new Set([
  'MT_CLARIFY_OPEN',
  'MT_ESCALATE_BUDGET',
  'MT_CONFIG_INVALID',
])

/** 去掉 HTML 注释再抽码 —— 生成块的起止标记本身就叫 MT_CODES，不能算「用到的码」。 */
function codesIn(text: string): string[] {
  return [...new Set(text.replace(/<!--[\s\S]*?-->/g, '').match(MT_RE) ?? [])]
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let isDir = false
    try { isDir = readdirSync(full).length >= 0 } catch { isDir = false }
    if (isDir) { out.push(...walk(full)); continue }
    if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 源码里所有 MT_ 字面量 → 出现位置列表（用来报错时点名）。 */
function sourceLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(srcDir)) {
    if (file === errorsFile) continue // 定义文件本身不算「使用」
    const rel = relative(srcDir, file).split('\\').join('/')
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(MT_RE)) {
        const list = found.get(match[0]) ?? []
        list.push(`${rel}:${index + 1}`)
        found.set(match[0], list)
      }
    })
  }
  return found
}

const MT_CODES_SET = new Set<string>(MT_CODES)

test('T78: MT_CODES 无重复、全大写、带 MT_ 前缀', () => {
  assert.equal(MT_CODES_SET.size, MT_CODES.length, 'MT_CODES 里有重复项')
  for (const code of MT_CODES) {
    assert.match(code, /^MT_[A-Z][A-Z_]*$/, `码 ${code} 不符合 MT_<域>_<条件> 命名约定`)
  }
})

test('T78: 源码里出现的每个 MT_ 字面量都在 MT_CODES 里（防拼错）', () => {
  const unknown: string[] = []
  for (const [code, where] of sourceLiterals()) {
    if (!MT_CODES_SET.has(code)) unknown.push(`${code}（${where.slice(0, 3).join(', ')}）`)
  }
  assert.deepEqual(unknown, [],
    `这些 MT_ 字面量不在 errors.ts 的 MT_CODES 里 —— 拼错了，或者该加进清单：\n${unknown.join('\n')}`)
})

test('T78: MT_CODES 里每个码在源码里至少被用一次（防孤儿码）', () => {
  const used = sourceLiterals()
  const orphans = MT_CODES.filter((code) => !used.has(code))
  assert.deepEqual(orphans, [],
    `这些码在 MT_CODES 里但源码从未使用 —— 删掉，或检查是否改名后忘了改：\n${orphans.join('\n')}`)
})

test('T78: 每个码都有说明（MT_CODE_DOCS 不漏项、不为空）', () => {
  const missing = MT_CODES.filter((code) => {
    const doc = MT_CODE_DOCS[code]
    return typeof doc !== 'string' || doc.trim().length < 4
  })
  assert.deepEqual(missing, [], `这些码缺说明（排障时不知道怎么解释）：\n${missing.join('\n')}`)

  const extra = Object.keys(MT_CODE_DOCS).filter((code) => !MT_CODES_SET.has(code))
  assert.deepEqual(extra, [], `MT_CODE_DOCS 里有 MT_CODES 不存在的键：\n${extra.join('\n')}`)
})

test('T78: docs/04 里出现的每个码都在 MT_CODES 里（文档不能写不存在的码）', () => {
  const docs = readFileSync(docsPath, 'utf8')
  const phantom = codesIn(docs)
    .filter((code) => !MT_CODES_SET.has(code) && !REMOVED_CODES.has(code))
    .sort()
  assert.deepEqual(phantom, [],
    `docs/04 写了这些**根本没有实现**的码（客户端会写出永不触发的分支）：\n${phantom.join('\n')}\n` +
    '删掉它们，并跑 `node tools/gen-error-docs.mjs` 重生成清单。')
})

test('T78: MT_CODES 里每个码都出现在 docs/04（不能有未文档化的码）', () => {
  const documented = new Set(codesIn(readFileSync(docsPath, 'utf8')))
  const undocumented = MT_CODES.filter((code) => !documented.has(code))
  assert.deepEqual(undocumented, [],
    `这些码没进文档（跑 \`node tools/gen-error-docs.mjs\` 重生成）：\n${undocumented.join('\n')}`)
})

test('T78: docs/04 的错误码清单与 errors.ts 同步（生成块未被手改）', () => {
  const docs = readFileSync(docsPath, 'utf8')
  assert.ok(docs.includes('<!-- BEGIN:MT_CODES（由 tools/gen-error-docs.mjs 生成，勿手改）-->'),
    'docs/04 缺生成块起点标记 —— 跑 `node tools/gen-error-docs.mjs`')
  assert.ok(docs.includes('<!-- END:MT_CODES -->'),
    'docs/04 缺生成块终点标记 —— 跑 `node tools/gen-error-docs.mjs`')

  // 生成块里出现的码必须**刚好**是 MT_CODES 全集（多一个少一个都算漂移）
  const begin = docs.indexOf('<!-- BEGIN:MT_CODES')
  const end = docs.indexOf('<!-- END:MT_CODES -->')
  const inBlock = codesIn(docs.slice(begin, end)).sort()
  assert.deepEqual(inBlock, [...MT_CODES].sort(),
    '生成块里的码与 MT_CODES 不一致 —— 文档被手改了，或忘了重生成')
})

test('T78: isMtCode 守卫在边界上真的能拦住（不是恒真/恒假）', () => {
  assert.equal(isMtCode('MT_VALIDATION'), true)
  assert.equal(isMtCode('MT_FAKE_CODE'), false)
  assert.equal(isMtCode('mt_validation'), false, '大小写敏感')
  assert.equal(isMtCode(undefined), false)
  assert.equal(isMtCode(42), false)
})
