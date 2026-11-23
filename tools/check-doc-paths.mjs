/**
 * 文档路径体检：**正文里用行内代码写的仓库路径**必须真的存在。
 *
 * 为什么需要它：`check-doc-links.mjs` 只看 `[文字](链接)`，而文档里绝大多数代码引用是
 * 行内代码（`` `plugin/src/domain/permissions/narrowing.ts` ``）。这类引用断了没有任何东西
 * 会响 —— 2026-11-24 就踩到：`contracts/capabilities.md` 把能力收窄规则指到
 * `domain/permissions/narrowing.ts`，那个文件根本不存在（实际在
 * `domain/definitions/role.ts` 的 `narrowCapabilities()`）。读者按它去找代码会直接走空。
 *
 * 范围（只看「描述现状」的文档）：
 *   - `docs/README.md`、`docs/architecture/`、`docs/contracts/`、`docs/features/`。
 * 不看的目录及原因：
 *   - `docs/audits/`：带日期的历史证据，写的是当时那棵树；
 *   - `docs/delivery/`：进度/发版记录，含「计划要建的文件」；
 *   - `docs/research/`：调研别家项目，`src/tools/defs.ts` 那种路径不是本仓库的。
 *
 * 解析规则：先按仓库根解析；不成再按 `plugin/` 解析（文档里 `src/application/x.ts`
 * 常年指 `plugin/src/application/x.ts`）。
 *
 * 故意提到已删文件（例如「已删掉工具 `tools/gen-error-docs.mjs`」）登记在 ALLOW 里，
 * 每条都要写为什么 —— 没有理由的例外就是下一次误导读者的入口。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SCOPE_DIRS = ['docs/architecture', 'docs/contracts', 'docs/features']
const SCOPE_FILES = ['docs/README.md']

/** 正文里合法提及「已经不存在的东西」的例外。key = `文档路径 :: 路径字面量`。 */
const ALLOW = new Map([
  ['docs/architecture/07-文档现状对账-2.0.0.md :: tools/gen-error-docs.mjs',
    '这句是在记「B3 已删掉失效的生成器」，删掉才是事实；改成存在的文件反而是错的。'],
  ['docs/contracts/README.md :: plugin/src/core/errors.ts',
    '这句举例说「旧路径出现在正文就改掉」，逐字保留才有意义。'],
  ['docs/architecture/05-面板RPC适配设计.md :: plugin/src/panel.ts',
    '这句是「v1 的实现（panel.ts，1458 行）踩过这条坑」，写的是已删除的 v1 文件。'],
  ['docs/architecture/02-文档重构与迁移蓝图.md :: docs/historical/dsh-myteam-requirements.md',
    '迁移映射表的「旧位置」列，记的就是它已搬走。'],
  ['docs/architecture/02-文档重构与迁移蓝图.md :: docs/agent-team-practices-checklist.md',
    '迁移映射表的「旧位置」列，记的就是它已搬走。'],
  ['docs/architecture/02-文档重构与迁移蓝图.md :: docs/superpowers/plans/2026-11-13-v4-closure.md',
    '迁移映射表的「旧位置」列，记的就是它已搬走。'],
  ['docs/architecture/02-文档重构与迁移蓝图.md :: docs/historical/2026-11-13-v4-closure.md',
    '迁移映射表的「新位置」列，指向的 historical 目录已整体删除，留作追溯。'],
])

// 行内代码里形如「仓库路径」的字面量：以已知顶级目录开头、带扩展名。
const PATH_RE = /`((?:plugin|tools|design-v2|src|docs)\/[\w.@/-]+\.(?:ts|mjs|js|json|yml|yaml|css|html|md))`/g

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

const files = [...SCOPE_FILES.filter((f) => existsSync(f))]
for (const dir of SCOPE_DIRS) walk(dir, files)

function resolves(literal) {
  if (existsSync(resolve('.', literal))) return true
  // 文档里 `src/...` 通常指插件源码根。
  if (literal.startsWith('src/') && existsSync(resolve('plugin', literal))) return true
  return false
}

const problems = []
const allowed = []
let checked = 0
const seen = new Set()

for (const file of files) {
  const docPath = relative('.', file).split('\\').join('/')
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(PATH_RE)) {
    const literal = match[1]
    checked += 1
    if (resolves(literal)) continue
    const key = `${docPath} :: ${literal}`
    if (seen.has(key)) continue
    seen.add(key)
    const why = ALLOW.get(key)
    if (why) allowed.push(`${key}（${why}）`)
    else problems.push(`${docPath}  →  ${literal}`)
  }
}

if (problems.length > 0) {
  console.log(`DOC_PATHS_FAIL ${problems.length} 条（行内代码写的仓库路径不存在）`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  console.log('  改法：指向真正实现该规则的文件，或从正文删掉这句；')
  console.log('  确实要提「已经删掉的文件」，在 ALLOW 里登记并写清理由。')
  process.exit(1)
}
console.log(`DOC_PATHS_OK ${checked} 条行内路径${allowed.length ? `（${allowed.length} 条登记例外）` : ''}`)
