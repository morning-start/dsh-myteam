/**
 * 从 `plugin/src/core/errors.ts` 生成 `docs/04-API与数据契约.md` 的「错误码」一节。
 *
 * 为什么要有这个脚本（CHG-98，审计 A7）：
 *   改名前 `MT_*` 是散落在 250 余处调用点的字符串字面量，文档只覆盖了 32 个，
 *   客户端 10 处按码分支的代码在静默失效。现在 `errors.ts` 是唯一来源，
 *   文档由本脚本生成 —— **手改文档会被下一次生成覆盖，也会被 t78 判红**。
 *
 * 用法：
 *   node tools/gen-error-docs.mjs           # 写回 docs/04
 *   node tools/gen-error-docs.mjs --check   # 只校验是否已同步（CI / 测试用，不写文件）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const errorsPath = join(repoRoot, 'plugin', 'src', 'core', 'errors.ts')
const docsPath = join(repoRoot, 'docs', '04-API与数据契约.md')

const BEGIN = '<!-- BEGIN:MT_CODES（由 tools/gen-error-docs.mjs 生成，勿手改）-->'
const END = '<!-- END:MT_CODES -->'

/** 把 errors.ts 编成 JS 再动态 import，避免手写解析器。 */
async function loadCodeTable() {
  const ts = readFileSync(errorsPath, 'utf8')
  const js = stripTypeScriptTypes(ts, { mode: 'strip' })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)
  return { codes: mod.MT_CODES, docs: mod.MT_CODE_DOCS }
}

/** 域前缀 → 中文域名的展示分组（顺序即文档顺序）。 */
const DOMAINS = [
  { label: '跨域通用', test: (c) => !/^MT_(LEDGER|TASK|ATTEMPT|CROSS|DEPENDENCY|DRAIN|EVIDENCE|MEMBER|NO_AGENTS|NOT_CLAIMABLE|REJECT|REVISION|TEAM|VERIFY|ARCHIVE|KB|ROLE|ROSTER|PRESET|HANDOFF|CONTRIBUTION|PLUGIN)_/.test(c) },
  { label: '账本（append-only JSONL）', test: (c) => c.startsWith('MT_LEDGER_') },
  { label: '任务与状态机', test: (c) => /^MT_(TASK|ATTEMPT|CROSS|DEPENDENCY|DRAIN|EVIDENCE|MEMBER|NO_AGENTS|NOT_CLAIMABLE|REJECT|REVISION|TEAM_STATE|VERIFY)(_|$)/.test(c) },
  { label: '归档', test: (c) => c === 'MT_ARCHIVE_FAILED' },
  { label: '知识库', test: (c) => c.startsWith('MT_KB_') },
  { label: '角色库', test: (c) => c.startsWith('MT_ROLE_') },
  { label: '名册', test: (c) => c.startsWith('MT_ROSTER_') },
  { label: '团队模板 / 预设', test: (c) => c.startsWith('MT_PRESET_') || c.startsWith('MT_TEAM_TEMPLATE_') },
  { label: '会话移交', test: (c) => c.startsWith('MT_HANDOFF_') },
  { label: '插件贡献契约', test: (c) => c.startsWith('MT_CONTRIBUTION_') || c.startsWith('MT_PLUGIN_') },
]

function render({ codes, docs }) {
  const seen = new Set()
  const lines = []
  const unmapped = []

  lines.push(BEGIN)
  lines.push('')
  lines.push('## 错误码（`MT_*`）')
  lines.push('')
  lines.push(`> **本表由 \`tools/gen-error-docs.mjs\` 从 \`plugin/src/core/errors.ts\` 生成，共 ${codes.length} 个。**`)
  lines.push('> 手改会被覆盖，且 `plugin/test/t81-error-codes.test.ts` 会判红。')
  lines.push('>')
  lines.push('> **加码流程**：① `errors.ts` 加一行（含说明）→ ② `node tools/gen-error-docs.mjs` → ③ `cd plugin && npm test`。')
  lines.push('>')
  lines.push('> 客户端按码分支的地方（`plugin/client/client.js`）必须只认本表里的码；')
  lines.push('> 服务端新增码时若客户端要分支，同步改客户端并在 CHG 里记一笔。')
  lines.push('')

  for (const { label, test } of DOMAINS) {
    const group = codes.filter((c) => !seen.has(c) && test(c))
    if (group.length === 0) continue
    group.forEach((c) => seen.add(c))
    lines.push(`### ${label}（${group.length}）`)
    lines.push('')
    lines.push('| 码 | 什么时候会看到它 |')
    lines.push('|---|---|')
    for (const c of group) {
      const doc = docs[c]
      if (typeof doc !== 'string' || doc.trim() === '') {
        unmapped.push(c)
        lines.push(`| \`${c}\` | **（缺说明）** |`)
        continue
      }
      lines.push(`| \`${c}\` | ${doc.replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
  }

  const missed = codes.filter((c) => !seen.has(c))
  if (missed.length > 0) {
    lines.push(`### 未归类（${missed.length}）`)
    lines.push('')
    lines.push('> 这些码没命中 `DOMAINS` 的任何前缀规则 —— 请在 `tools/gen-error-docs.mjs` 的 `DOMAINS` 里补一条。')
    lines.push('')
    lines.push('| 码 | 什么时候会看到它 |')
    lines.push('|---|---|')
    for (const c of missed) lines.push(`| \`${c}\` | ${docs[c] ?? '**（缺说明）**'} |`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(END)
  return { text: lines.join('\n'), unmapped: [...new Set([...unmapped, ...missed])] }
}

const table = await loadCodeTable()
const { text, unmapped } = render(table)

const checkOnly = process.argv.includes('--check')
const original = readFileSync(docsPath, 'utf8')

if (unmapped.length > 0) {
  console.error(`[gen-error-docs] ${unmapped.length} 个码缺说明，拒绝生成：${unmapped.join(', ')}`)
  process.exit(1)
}

const hasBlock = original.includes(BEGIN) && original.includes(END)
const next = hasBlock
  ? original.replace(new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), text)
  : `${original.trimEnd()}\n\n${text}\n`

if (checkOnly) {
  if (!hasBlock) {
    console.error('[gen-error-docs] docs/04 里没有错误码标记块 —— 先跑一次不带 --check 的生成。')
    process.exit(1)
  }
  if (next !== original) {
    console.error('[gen-error-docs] docs/04 与 errors.ts 不同步 —— 请跑 `node tools/gen-error-docs.mjs`。')
    process.exit(1)
  }
  console.log(`[gen-error-docs] 已同步（${table.codes.length} 个码）。`)
  process.exit(0)
}

writeFileSync(docsPath, next, 'utf8')
console.log(`[gen-error-docs] 写入 ${table.codes.length} 个码 → docs/04-API与数据契约.md`)
