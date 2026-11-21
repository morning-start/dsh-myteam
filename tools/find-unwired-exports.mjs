/**
 * CHG-210：**未接线导出**分析——`export` 出去、被测试引用、但**生产代码零调用**。
 *
 * 为什么需要这个门禁（不是「死导出」的重复）：
 *   `find-dead-exports` 的判据是「任何文件都没引用」。而本项目连续查出 8 处**写了、测了、
 *   没接线**：`recoverOnBoot`（重启后僵尸任务）、`claimOrder`（优先级/FIFO 是假的）、
 *   `assertToolResult`（工具输出契约无运行时面）、`instanceof MTError`（错误码全变成
 *   MT_INTERNAL）、`corrupted/compacted` 计数（账本脏过界面上不存在）、`migrated` 标志、
 *   `globalStoreLayout().teamFile`（publish 只写不读）。
 *
 *   它们**不在死导出名单里**，因为测试文件引用了它们——测试证明「它能用」，却证明不了
 *   「它被用了」。这两件事的差集，就是本脚本要找的东西。
 *
 * 判据（三层）：
 *   ① 符号在 `plugin/src/**`（除定义文件）**零引用** —— 生产没接线；
 *   ② 在 `plugin/test/**` **有引用** —— 曾经被当成「已实现」验证过；
 *   ③ 不是入口模块的导出 —— `host.ts` / `panel.ts` / `smoke.ts` 的导出是包对外公开面，
 *      本来就不该在 src 内被引用（与 `find-dead-exports` 同一份白名单）。
 *
 * 已知局限（不假装完备）：
 *   - **只查一层**：A 调 B、B 没接线 → 只报 B，不报 A。传递性未接线要另写工具。
 *   - **同名符号会互相干扰**：两个文件各自导出 `foo`，任一被引用就都不报。
 *   - **注释里的提及算引用**：宁可漏报，不要用正则去猜注释边界。
 *
 * 用法：
 *   node tools/find-unwired-exports.mjs            # 报告
 *   node tools/find-unwired-exports.mjs --strict   # 有命中即 exit 1（CI 用）
 *
 * 白名单：`tools/unwired-exports-allow.json`（已知但有意保留的，必须写理由）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const posix = (p) => p.replace(/\\/g, '/')

const files = []
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'lib' || name === '.debug') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(ts|js|mjs)$/.test(name)) files.push(full)
  }
}
walk(join(root, 'plugin/src'))
walk(join(root, 'plugin/test'))

const texts = new Map(files.map((f) => [posix(relativeFromRoot(f)), readFileSync(f, 'utf8')]))
const srcFiles = [...texts.keys()].filter((f) => f.startsWith('plugin/src/'))
const testFiles = [...texts.keys()].filter((f) => f.startsWith('plugin/test/'))

function relativeFromRoot(full) {
  return join(full).slice(root.length + 1)
}

/** 入口模块：导出是包对外公开面，不参与「src 内是否被引用」的判定 */
const ENTRY_MODULES = new Set([
  'plugin/src/host.ts',
  'plugin/src/panel.ts',
  'plugin/src/smoke.ts',
])

/** 白名单：已知但有意保留（每条必须有理由，否则就是在给旧债发免死金牌） */
const allowPath = join(root, 'tools/unwired-exports-allow.json')
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : {}
const allowEntries = Array.isArray(allow.entries) ? allow.entries : []

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 符号名的出现处数（词边界）。
 *
 * **包含定义文件**：常量/辅助函数常在**自己的文件里**被使用（`export const T = 3` 然后
 * `if (n > T)`），排除定义文件会把它们全判成未接线——这是本脚本第一版的真实误报（86 条里
 * 大半是这个）。所以判定用「出现次数 > 1」：1 次 = 只有定义，≥2 = 定义 + 至少一处引用。
 */
function countRefs(name, pool) {
  const re = new RegExp(`(^|[^\\w$.])${escapeRe(name)}([^\\w$]|$)`, 'g')
  let count = 0
  for (const f of pool) {
    const text = texts.get(f)
    if (!text) continue
    count += [...text.matchAll(re)].length
  }
  return count
}

const findings = []
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
    // >1：定义本身算一次，再来一次才是「有人用它」
    const srcRefs = countRefs(name, srcFiles)
    if (srcRefs > 1) continue // 生产有引用 = 已接线
    const testRefs = countRefs(name, testFiles)
    if (testRefs === 0) continue // 谁都不引用 = find-dead-exports 的领域
    findings.push({ file, name, testRefs })
  }
}

/** 行号（给报告用；找不到定义行就留空） */
function lineOf(file, name) {
  const lines = texts.get(file).split('\n')
  const idx = lines.findIndex((line) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${escapeRe(name)}\\b`).test(line))
  return idx >= 0 ? idx + 1 : 0
}

const keepKeys = new Set(allowEntries.filter((e) => e.status === 'keep').map((e) => `${e.file}::${e.name}`))
const todoEntries = allowEntries.filter((e) => e.status === 'todo')
const todoKeys = new Set(todoEntries.map((e) => `${e.file}::${e.name}`))

const found = new Set(findings.map((f) => `${f.file}::${f.name}`))
/** 未登记的命中 = 本次改动新引入的未接线 */
const newDebt = findings.filter((f) => !keepKeys.has(`${f.file}::${f.name}`) && !todoKeys.has(`${f.file}::${f.name}`))
/** 已登记待办的命中 = 存量债 */
const knownDebt = findings.filter((f) => todoKeys.has(`${f.file}::${f.name}`))
/** 登记了但本次没命中 = 已接线/已删，基线可以下调 */
const cleared = todoEntries.filter((e) => !found.has(`${e.file}::${e.name}`))
const maxTodo = Number(allow.maxTodo ?? todoEntries.length)

console.log(`生产源文件 ${srcFiles.length} 个 ｜ 测试文件 ${testFiles.length} 个 ｜ 入口模块 ${ENTRY_MODULES.size} 个（跳过）`)
console.log(`未接线导出（生产零调用、但有测试引用）: ${findings.length}（有意保留 ${findings.length - newDebt.length - knownDebt.length} / 存量债 ${knownDebt.length} / 新增 ${newDebt.length}）`)

if (newDebt.length > 0) {
  console.log('\n新增（必须接线，或登记进 tools/unwired-exports-allow.json 并写理由）:')
  for (const f of newDebt) console.log(`  ${f.file}:${lineOf(f.file, f.name)}  ->  ${f.name}   （测试引用 ${f.testRefs} 处）`)
}
if (knownDebt.length > 0) {
  console.log(`\n存量债 ${knownDebt.length} / 上限 ${maxTodo}:`)
  for (const f of knownDebt) {
    const reason = todoEntries.find((e) => e.file === f.file && e.name === f.name)?.reason ?? ''
    console.log(`  ${f.file}  ->  ${f.name}`)
    if (reason) console.log(`      理由: ${reason}`)
  }
}
if (cleared.length > 0) {
  console.log(`\n✓ 已清理 ${cleared.length} 条（把 maxTodo 下调到 ${knownDebt.length}）:`)
  for (const e of cleared) console.log(`  ${e.file}  ->  ${e.name}`)
}

const strict = process.argv.includes('--strict')
const overBudget = knownDebt.length > maxTodo
if (strict && (newDebt.length > 0 || overBudget)) {
  if (newDebt.length > 0) console.error(`\n✗ 新增 ${newDebt.length} 个未接线导出——写好了就要接线，接不上就登记理由`)
  if (overBudget) console.error(`\n✗ 存量债 ${knownDebt.length} 超过棘轮上限 ${maxTodo}——只许减不许增`)
  process.exit(1)
}
