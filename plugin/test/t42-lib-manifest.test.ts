/**
 * T42（CHG-60）：src ↔ lib 一致性门禁（R38）。
 *
 * 背景：`main` 指向 `lib/host.mjs`，lib 随包分发；改 src 忘 `npm run bundle` 时
 * 装载会静默跑旧产物。构建脚本在 lib/ 下写 `build-manifest.json`（源码指纹 + 模块清单），
 * 本测试复算指纹——不一致即失败，并把「跑 npm run bundle」写进断言消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

function walk(dir, ext) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let isDir = false
    try { isDir = readdirSync(full).length >= 0 } catch { isDir = false }
    if (isDir) { out.push(...walk(full, ext)); continue }
    if (name.endsWith(ext)) out.push(full)
  }
  return out
}

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

const REBUILD_HINT = 'src 与 lib 不一致——请先 `cd plugin && npm run bundle` 再跑测试（R38 门禁）'
const CLIENT_REBUILD_HINT = 'client/client.js 与 manifest.clientHash 不一致——改 client.js 后需重跑 `cd plugin && node scripts/build-lib.mjs`（浏览器直载产物同样受一致性门禁约束）'

test('T42: lib/build-manifest.json 存在且源码指纹与当前 src 一致', () => {
  const manifestPath = join(libDir, 'build-manifest.json')
  assert.ok(existsSync(manifestPath), `缺 lib/build-manifest.json——${REBUILD_HINT}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.entry, './lib/host.mjs')
  const srcFiles = walk(srcDir, '.ts')
  assert.equal(manifest.modules, srcFiles.length, `manifest 模块数 ${manifest.modules} ≠ src ${srcFiles.length}；${REBUILD_HINT}`)
  assert.deepEqual(manifest.files, srcFiles.map((f) => relative(srcDir, f).split(sep).join('/')).sort((a, b) => a.localeCompare(b)))
  assert.equal(manifest.sourceHash, sourceHashOf(srcFiles), REBUILD_HINT)
})

test('T42: 每个 src 模块都有对应 lib 产物，且 lib 内无 .ts 说明符（R1）', () => {
  const missing = []
  const badSpecifier = []
  for (const file of walk(srcDir, '.ts')) {
    const rel = relative(srcDir, file).split(sep).join('/')
    const out = join(libDir, rel.replace(/\.ts$/, '.mjs'))
    if (!existsSync(out)) { missing.push(rel); continue }
    const code = readFileSync(out, 'utf8')
    // 相对导入必须已改写为 .mjs（装载入口是纯 JS，裸露 .ts 说明符在发布包装载会失败）
    if (/from\s*['"]\.{1,2}\/[^'"]+\.ts['"]/.test(code)) badSpecifier.push(rel)
  }
  assert.deepEqual(missing, [], `这些模块没有 lib 产物；${REBUILD_HINT}`)
  assert.deepEqual(badSpecifier, [], '这些产物仍含 .ts 说明符；重跑 npm run bundle')
})

test('T42: lib 产物数 = src 模块数（rm 后全量重建，无残留旧模块）', () => {
  const manifest = JSON.parse(readFileSync(join(libDir, 'build-manifest.json'), 'utf8'))
  const libModules = walk(libDir, '.mjs')
  assert.equal(libModules.length, manifest.modules, `lib 实际 ${libModules.length} 个 .mjs ≠ manifest ${manifest.modules}；残留旧模块或漏构建`)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.main, './lib/host.mjs')
  assert.equal(pkg.exports['.'], './lib/host.mjs')
})

/**
 * P2 门禁缺口：`client/client.js` 是浏览器**直载**产物（package.json exports["./client"]），
 * 不经过 src→lib 构建，因此旧的 sourceHash 覆盖不到它——改了忘记重跑构建时，面板会静默跑旧客户端。
 * 构建脚本现在把它的 sha256 单独记进 `clientHash`（不混进 sourceHash），这里复算比对。
 */
test('T42: client/client.js 指纹与 manifest.clientHash 一致（浏览器直载产物纳入门禁）', () => {
  const manifestPath = join(libDir, 'build-manifest.json')
  assert.ok(existsSync(manifestPath), `缺 lib/build-manifest.json——${REBUILD_HINT}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const clientPath = join(root, 'client', 'client.js')
  assert.ok(existsSync(clientPath), `缺 client/client.js（面板浏览器直载入口）；${CLIENT_REBUILD_HINT}`)
  assert.equal(manifest.clientFile, 'client/client.js', `manifest.clientFile 应为 "client/client.js"；${CLIENT_REBUILD_HINT}`)
  const actual = createHash('sha256').update(readFileSync(clientPath)).digest('hex')
  assert.equal(manifest.clientHash, actual, CLIENT_REBUILD_HINT)
})
