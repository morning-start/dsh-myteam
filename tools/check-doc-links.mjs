/**
 * 文档链接体检：所有 markdown 里的**相对链接**必须解析得到（锚点只查文件，不查 fragment）。
 *
 * 只查仓库内相对路径；`http(s)://` / `mailto:` 跳过（外链不做网络请求）。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = process.cwd()
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.debug' || name === 'lib' || name === 'refs') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.md')) files.push(full)
  }
}
walk(ROOT)

const bad = []
let checked = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = m[2]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const clean = target.split('#')[0]
    if (!clean) continue
    checked++
    const resolved = resolve(dirname(file), clean)
    if (!existsSync(resolved)) {
      bad.push(`${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}  →  ${target}`)
    }
  }
}

console.log(`文档 ${files.length} 个 ｜ 相对链接 ${checked} 条 ｜ 断链 ${bad.length}`)
for (const b of bad) console.log('  ✗ ' + b)
process.exit(bad.length === 0 ? 0 : 1)
