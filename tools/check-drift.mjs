/**
 * src ↔ lib 漂移检查（R38 的独立复算面；D9 的产物卫生旁证）。
 *
 * 为什么以前 100% 假阳性（`MISMATCH: 36/36`）：
 *   它自己又写了一份「stripTypeScriptTypes + 说明符改写」，但**漏传了构建传的 `sourceUrl`**，
 *   而该选项会在产物末尾追加 `//# sourceURL=…` 行——两边永远差一行，门禁等于没有。
 * 现在直接复用 `plugin/scripts/build-lib.mjs` 导出的 `compileSource`：
 *   编译口径只有一个来源，两边不可能再漂移。
 *
 * 另外把 `//# sourceURL=` 行从两边都归一化掉——它是构建元数据（完全由文件路径决定），
 * 不是代码漂移。这样 lib/ 还是「旧构建（绝对路径 sourceURL）」时不会全红，
 * 改为单独一行告警说明「需要重跑 bundle」（D9 的绝对路径泄漏由构建期门禁负责拦）。
 *
 * 运行：node tools/check-drift.mjs
 *   退出码：MISMATCH 为 0 时 0，否则 1（可直接当 CI 门禁）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSource } from '../plugin/scripts/build-lib.mjs'

const PLUGIN = fileURLToPath(new URL('../plugin/', import.meta.url))
const SRC = join(PLUGIN, 'src')
const LIB = join(PLUGIN, 'lib')

function walk(dir, ext) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

const posix = (p) => p.split(sep).join('/')

/** 只比代码：丢掉由构建注入的 `//# sourceURL=` 元数据行 */
const stripBuildMeta = (code) => code.replace(/^[ \t]*\/\/# sourceURL=.*$/gm, '')

const drift = []
const absSourceUrl = []
const files = walk(SRC, '.ts')

for (const file of files) {
  const rel = posix(relative(SRC, file))
  const lib = join(LIB, rel.replace(/\.ts$/, '.mjs'))
  try {
    const want = stripBuildMeta(compileSource(readFileSync(file, 'utf8'), rel))
    const got = readFileSync(lib, 'utf8')
    if (/^[ \t]*\/\/# sourceURL=file:\/\//m.test(got)) absSourceUrl.push(rel)
    if (want !== stripBuildMeta(got)) drift.push(rel)
  } catch (e) {
    drift.push(`${rel} ERR: ${String(e).split('\n')[0].slice(0, 120)}`)
  }
}

console.log('total src files:', files.length)
console.log('MISMATCH:', drift.length)
for (const d of drift.slice(0, 20)) console.log(' -', d)
if (absSourceUrl.length > 0) {
  console.warn(
    `[warn] lib/ 里还有 ${absSourceUrl.length}/${files.length} 个产物带绝对路径 sourceURL（D9）——` +
      '重跑 `cd plugin && npm run bundle` 才会消失；本检查只比代码，故不计入 MISMATCH',
  )
}
process.exitCode = drift.length > 0 ? 1 : 0
