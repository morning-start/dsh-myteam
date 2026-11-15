/**
 * 客户端构建：把 `client/src/*.js` 片段**纯文本拼接**成 `client/client.js`。
 *
 * 为什么是拼接而不是打包：
 *  - 宿主 `__ModuleLoader__` 只提供 `react` / `react/jsx-runtime` 这类**裸模块名**；
 *    `client.js` 是被 `new Function('window','document',source)` 当脚本执行的，
 *    **没有**跨文件 `require` 可用。
 *  - 131 个测试断言 `source.includes('...')`，任何转译（压缩/重命名）都会让断言失效。
 *  - 所以片段必须**逐字节**保留，拼接结果 = 原文件（`--check` 会校验）。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 生成 client/client.js
 *   node scripts/build-client.mjs --check   # 只校验产物与片段一致（CI 用）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_DIR = join(ROOT, 'client', 'src')
const OUT = join(ROOT, 'client', 'client.js')

if (!existsSync(SRC_DIR)) {
  console.error(`✗ 找不到片段目录：${SRC_DIR}`)
  process.exit(1)
}

/* 顺序 = 文件名排序（00- 到 99-），片段之间有隐式依赖，不能乱 */
const files = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort()

if (files.length === 0) {
  console.error('✗ 片段目录里没有 .js 文件')
  process.exit(1)
}

const text = files.map((f) => readFileSync(join(SRC_DIR, f), 'utf8')).join('\n')

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`✗ 产物不存在：${OUT}（先跑一次不带 --check 的构建）`)
    process.exit(1)
  }
  const current = readFileSync(OUT, 'utf8')
  if (current !== text) {
    console.error(`✗ 产物与片段不一致：${OUT}`)
    console.error(`  片段拼接 ${text.split('\n').length} 行 / 产物 ${current.split('\n').length} 行`)
    console.error('  跑 `node scripts/build-client.mjs` 重新生成')
    process.exit(1)
  }
  console.log(`✓ client.js 与 ${files.length} 个片段一致（${text.split('\n').length} 行）`)
  process.exit(0)
}

writeFileSync(OUT, text, 'utf8')
console.log(`✓ 已生成 ${OUT}`)
console.log(`  ${files.length} 个片段 / ${text.split('\n').length} 行 / ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`)
for (const f of files) {
  const n = readFileSync(join(SRC_DIR, f), 'utf8').split('\n').length
  console.log(`    ${f.padEnd(24)} ${String(n).padStart(5)} 行`)
}
