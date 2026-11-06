/**
 * dsh-plugin-myteam — 预编译脚本（官方插件契约：装载入口必须是纯 JS）。
 *
 * 用 Node 内置 module.stripTypeScriptTypes 把 src 下全部 .ts 编译到 lib 下对应 .mjs：
 *   - mode 'strip'（擦除型语法；本项目无 enum/namespace/参数属性/装饰器，已核查）
 *   - 相对导入说明符 .ts 结尾 → .mjs（静态 from / 副作用 import / 动态 import）
 *   - package.json main/exports 指向 lib/host.mjs（由本脚本同步校验）
 *
 * 运行：node scripts/build-lib.mjs（Node >= 22.13，无需任何 devDependency）
 */
import { stripTypeScriptTypes } from 'node:module'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')
/** 浏览器直载产物（不经 src 编译）：package.json exports["./client"]；与源码指纹分开记录 */
const clientFile = join(root, 'client', 'client.js')

/**
 * 客户端产物指纹（P2 门禁缺口）：`client/client.js` 由浏览器**直接装载**，不经过 src→lib 构建，
 * 所以 sourceHash 覆盖不到它——改了忘记重跑构建时，面板会静默跑旧客户端。
 * 用原始字节哈希，且**不混进 sourceHash**（两者语义不同，混在一起会让 lib 重建判定失真）。
 */
function clientHashOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 源码指纹（R38 门禁）：全部 src 文件按相对路径排序后「路径\0内容」哈希；t42 复算比对 */
function sourceHashOf(files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    hash.update(relative(srcDir, file).split(sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(file, 'utf8'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      if (readdirSync(full)) { out.push(...walk(full)); continue }
    } catch { /* 不是目录 */ }
    if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 相对 .ts 说明符 → .mjs（静态 from / 副作用 import / 动态 import()） */
function rewriteSpecifiers(code) {
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g,
    (_m, head, quote, spec) => `${head}${quote}${spec}.mjs${quote}`,
  )
}

function main() {
  const files = walk(srcDir)
  if (files.length === 0) throw new Error('src/**/*.ts 为空')
  rmSync(libDir, { recursive: true, force: true })
  mkdirSync(libDir, { recursive: true })
  let failures = 0
  for (const file of files) {
    const rel = relative(srcDir, file)
    const outPath = join(libDir, rel.replace(/\.ts$/i, '.mjs'))
    const code = readFileSync(file, 'utf8')
    let js
    try {
      try {
        js = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl: pathToFileURL(file).href })
      } catch (stripErr) {
        // 擦除失败（非擦除型语法）→ 退回 transform 模式（enum/namespace 等也可编译）
        console.warn(`[strip] ${rel}: ${String(stripErr).split('\n')[0]} → retry transform`)
        js = stripTypeScriptTypes(code, { mode: 'transform', sourceUrl: pathToFileURL(file).href })
      }
    } catch (e) {
      console.error(`[build] FAILED ${rel}: ${e.message}`)
      failures++
      continue
    }
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, rewriteSpecifiers(js), 'utf8')
    console.log(`[build] ${rel.split(sep).join('/')} → ${relative(root, outPath).split(sep).join('/')}`)
  }
  if (failures > 0) throw new Error(`${failures} file(s) failed to compile`)
  // 校验 manifest 指向 lib 入口
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const entry = pkg.exports?.['.']
  const expected = './lib/host.mjs'
  if (entry !== expected || pkg.main !== expected) {
    throw new Error(`package.json 入口应为 "${expected}"（main=${pkg.main}, exports["."]=${entry}）；请修正后重跑`)
  }
  console.log(`[build] OK — ${files.length} module(s) → lib/；入口 ${expected}`)
  // 客户端产物必须存在（浏览器直载；缺失时面板整块不可用，构建期就拦住）
  let clientHash
  try {
    clientHash = clientHashOf(clientFile)
  } catch (e) {
    throw new Error(`client/client.js 不可读（${e.message}）；本插件面板依赖该浏览器直载产物，请补回后重跑`)
  }
  // 一致性门禁凭据（R38 / t42）：改 src 未重跑 bundle 时测试立即失败
  const manifest = {
    schema: 1,
    builtAt: new Date().toISOString(),
    node: process.version,
    entry: expected,
    modules: files.length,
    sourceHash: sourceHashOf(files),
    // P2：浏览器直载产物单独记指纹（t42 复算比对；不一致提示重跑本脚本）
    clientFile: 'client/client.js',
    clientHash,
    files: files.map((f) => relative(srcDir, f).split(sep).join('/')).sort((a, b) => a.localeCompare(b)),
  }
  writeFileSync(join(libDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[build] manifest sourceHash=${manifest.sourceHash.slice(0, 12)}… clientHash=${manifest.clientHash.slice(0, 12)}…`)
}

main()
