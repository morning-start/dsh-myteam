/**
 * 文档链接体检：所有 markdown 里的**相对链接**必须解析得到（锚点只查文件，不查 fragment）。
 *
 * 只查仓库内相对路径；`http(s)://` / `mailto:` 跳过（外链不做网络请求）。
 *
 * v2 重写期间有两类链接不计入断链：
 *   - 指向 v1 源码（`plugin/src/**`、`plugin/client/**`、`plugin/schema/**`）：
 *     v1 实现已移出工作树，完整保存在标签 `v1-backup`；
 *   - 指向运行期数据（`.dsh-myteam/**`）：本来就不入库，新检出里不存在。
 * 它们仍在文档里作为证据，单独计数；R7 文档替换时一并处理。
 * 除此之外的任何失效链接都是真断链，门禁失败。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', '.debug', 'lib', 'refs', '.agents', '.tmp', 'tmp'])

const NON_REPO_PATTERNS = [
  /plugin\/src\//,
  /plugin\/client\//,
  /plugin\/schema\//,
  /plugin\/locale\//,
  /plugin\/lib\//,
  /(^|\/)\.dsh-myteam\//,
]

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
// `.agents/` 里是 linked worktree（各自的仓库根），相对链接只在那个根里成立；
    // `.tmp/` / `tmp/` 是抓取与调试草稿，都不属于本文档树。
    if (name === 'node_modules' || name === '.git' || name === '.debug' || name === 'lib'
      || name === 'refs' || name === '.agents' || name === '.tmp' || name === 'tmp') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.md')) files.push(full)
  }
}
walk(ROOT)

const broken = []
const externalRefs = []
let checked = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const relativePath = relative(ROOT, file).split('\\').join('/')
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = match[2]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const clean = target.split('#')[0]
    if (!clean) continue
    checked += 1

    const resolved = resolve(dirname(file), clean)
    if (existsSync(resolved)) continue

    const record = `${relativePath}  →  ${target}`
    if (NON_REPO_PATTERNS.some((pattern) => pattern.test(clean))) externalRefs.push(record)
    else broken.push(record)
  }
}

console.log(
  `文档 ${files.length} 个 ｜ 相对链接 ${checked} 条 ｜ 断链 ${broken.length} ｜ v1/运行期引用 ${externalRefs.length}`,
)
for (const item of broken) console.log(`  ✗ ${item}`)
if (externalRefs.length > 0 && process.env.MYTEAM_SHOW_V1_REFS === '1') {
  for (const item of externalRefs) console.log(`  · ${item}`)
}

process.exit(broken.length === 0 ? 0 : 1)