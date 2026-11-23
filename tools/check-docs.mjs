#!/usr/bin/env node
/**
 * 文档治理体检（B5）：把「文档目录的规矩」变成可跑的一条命令。
 *
 * 为什么需要它：链接断没断有 `check-doc-links.mjs`，行内代码写的源码路径对不对有
 * `check-doc-paths.mjs`，正文里的可数事实有没有漂有 `check-doc-facts.mjs`，生成物有没有漂移有 `gen-* --check`，
 * 但下面这几类**只在评审时靠人眼**的问题一直没人守，2026-11-23 一轮里全踩到了：
 *   - 索引把「已实现的文档」写成 `proposed`（读者以为还没做）；
 *   - 索引指向一个已经不存在的目录（`docs/historical/`）；
 *   - 生成物被人手改过（顶部写着「不要手改」，没人校验这一点）；
 *   - 审计目录里出现没有日期的「证据」（无法判断对应哪一版）；
 *   - docs 根目录开始散落单个 md 文件。
 *
 * 判据都是机械的，不猜语义：
 *   1. 每个 docs 子目录必须有 README.md（唯一导航入口）；
 *   2. docs 根目录只允许 README.md；
 *   3. 头部 `> 状态：<token>` 的 token 必须在允许集合里；
 *   4. `docs/README` 的「现行阅读入口」一节不允许链接到 `proposed` 的文档；
 *   5. `docs/audits/` 的每篇必须写出日期（20xx-xx-xx）；
 *   6. 三份生成契约必须保留「不要手改」标记（防被手糊掉后无人察觉）。
 *
 * 用法：node tools/check-docs.mjs        # 通过打印 DOCS_OK，失败退 1
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS = join(ROOT, 'docs')
const ALLOWED_STATUS = new Set([
  'as-is',
  'accepted',
  'proposed',
  'superseded',
  'historical',
  'generated',
  'draft',
  'in-progress',
])
const GENERATED = ['panel-rpc.md', 'tool-surface.md', 'config-schema.md']
const problems = []

/** 递归列出 docs 下的 md（跳过 hidden 目录）。 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

const files = walk(DOCS)
const rel = (file) => relative(ROOT, file).replaceAll('\\', '/')

// 1. 每个子目录有 README.md
for (const name of readdirSync(DOCS)) {
  const full = join(DOCS, name)
  if (!statSync(full).isDirectory() || name.startsWith('.')) continue
  if (!files.includes(join(full, 'README.md'))) problems.push(`${rel(full)}/ 缺 README.md（每个目录一个导航入口）`)
}

// 2. docs 根目录只允许 README.md
for (const file of files) {
  if (dirname(file) !== DOCS) continue
  if (file !== join(DOCS, 'README.md')) problems.push(`${rel(file)} 放在 docs 根目录：先定编入哪个子目录`)
}

// 3 / 5 / 6. 逐篇检查
const statusOf = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const head = text.split('\n').slice(0, 12)

  const statusLine = head.find((line) => /^>\s*状态：/.test(line))
  if (statusLine !== undefined) {
    const token = statusLine.match(/^>\s*状态：\s*`([^`]+)`/)
    if (token === null) {
      problems.push(`${rel(file)} 的状态行没写成 \`token\`：${statusLine.slice(0, 60)}`)
    } else if (!ALLOWED_STATUS.has(token[1])) {
      problems.push(`${rel(file)} 的状态 \`${token[1]}\` 不在允许集合（${[...ALLOWED_STATUS].join(' / ')}）`)
    } else {
      statusOf.set(file, token[1])
    }
  }

  if (file.startsWith(join(DOCS, 'audits')) && file.endsWith('README.md') === false && !/20\d\d-\d\d-\d\d/.test(text)) {
    problems.push(`${rel(file)} 在 audits/ 里却没写日期（20xx-xx-xx），无法判断对应哪一版`)
  }

  if (GENERATED.includes(file.split(/[\\/]/).pop()) && !/不要手改|勿手改/.test(text.slice(0, 800))) {
    problems.push(`${rel(file)} 是生成物，却找不到「不要手改」标记`)
  }
}

// 4. 现行阅读入口不许指向 proposed
const indexFile = join(DOCS, 'README.md')
const indexText = readFileSync(indexFile, 'utf8')
const section = indexText.split(/^##\s*1\./m)[1]?.split(/^##\s*2\./m)[0] ?? ''
for (const match of section.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
  const target = resolve(DOCS, match[1])
  const status = statusOf.get(target)
  if (status === 'proposed') {
    problems.push(`docs/README 的「现行阅读入口」链接到 proposed 文档：${match[1]}（读者会以为还没实现）`)
  }
}

if (problems.length > 0) {
  console.error(`[check-docs] ${problems.length} 处不合规：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`DOCS_OK ${files.length} docs`)
