/**
 * 死导出分析：`export` 出去、但**没有任何其它文件引用**的符号。
 *
 * 判据：符号名在「除定义文件外的全部 src/test 文件」里一次都没出现（词边界匹配）。
 * 只报 `export function/const/class` 与 `export {}` 清单，跳过 `export type/interface`
 * （类型擦除后无运行时成本，且常被 `import type` 用得比较隐晦）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const posix = (p) => p.replace(/\\/g, '/')
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib' || name === '.debug') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(ts|js|mjs)$/.test(name)) files.push(full)
  }
}
walk('plugin/src')
walk('plugin/test')

const texts = new Map(files.map((f) => [posix(f), readFileSync(f, 'utf8')]))
const srcFiles = [...texts.keys()].filter((f) => f.startsWith('plugin/src/'))
const dead = []

/**
 * **入口模块**：它们的导出是包对外的公开面（被 `lib/*.mjs` 包装或由宿主按路径加载），
 * 不会在 src 内部被引用——把它们算成「死」是分析器的假阳性。
 * 来源：`plugin/package.json` 的 `exports` + `smoke.mjs`（动态冒烟 CLI 入口）。
 */
const ENTRY_MODULES = new Set([
  'plugin/src/host.ts',   // package.json exports "." / "./host"
  'plugin/src/panel.ts',  // package.json exports "./panel"
  'plugin/src/smoke.ts',  // smoke.mjs（动态冒烟 CLI）
])

for (const file of srcFiles) {
  if (!file.endsWith('.ts')) continue
  if (ENTRY_MODULES.has(file)) continue
  const text = texts.get(file)
  const names = []
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1])
  for (const m of text.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (n) names.push(n)
    }
  }
  for (const name of new Set(names)) {
    const re = new RegExp(`(^|[^\\w$.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`)
    const usedElsewhere = [...texts.entries()].some(([f, t]) => f !== file && re.test(t))
    if (!usedElsewhere) dead.push(`${file}  ->  ${name}`)
  }
}

console.log(`源文件 ${srcFiles.length} 个，扫描文件 ${texts.size} 个`)
console.log(`死导出: ${dead.length}`)
for (const d of dead) console.log('  ' + d)
