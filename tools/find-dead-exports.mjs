/**
 * 死导出分析：`export` 出去、但**没有任何其它文件引用**的符号。
 *
 * 判据：符号名在「除定义文件外的全部 src/test/tools 文件」里一次都没出现（词边界匹配）。
 * 只报 `export function/const/class` 与 `export {}` 清单，跳过 `export type/interface`
 * （类型擦除后无运行时成本，且常被 `import type` 用得比较隐晦）。
 *
 * ── 为什么这个文件里一个反斜杠字面量都不写 ────────────────────────────────
 * 它被反复编辑过，正则里的 `\s` / `\w` / `\b` 在传递过程中被存成「反斜杠 + 字母」，
 * 结果是**静默失真**：导出名提取正则永远匹配不上 → `names` 为空 → 每个文件都
 * 「没有导出」→ 门禁看起来绿，其实什么都没查（另一版则把所有导出都报成死导出）。
 * 现在所有转义都由字符码拼出（见 {@link BS}），无论经过几层转义都只有一种含义。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 反斜杠（charCode 92）。不写字面量，避免被重复转义。 */
const BS = String.fromCharCode(92)
const posix = (p) => p.split(BS).join('/')

/** 标识符字符类（正则字符类语法，不含反斜杠）。 */
const ID_CLASS = 'A-Za-z0-9_$'
/** 空白字符类（正则字符类语法，不含反斜杠）。 */
const WS_CLASS = ' ' + BS + 't' + BS + 'n' + BS + 'r'

function isIdChar(ch) {
  return ID_CLASS.indexOf(ch) >= 0 || /[A-Za-z0-9_$]/.test(ch)
}

/** 词边界匹配器：前后必须不是标识符字符。 */
function wordBoundary(name) {
  const escaped = [...name].map((ch) => (isIdChar(ch) ? ch : BS + ch)).join('')
  return new RegExp(`(^|[^${ID_CLASS}])${escaped}([^${ID_CLASS}]|$)`)
}

/**
 * 从源码里取出 `export function/const/class NAME` 与 `export { a, b as c }` 的名字。
 * 用字符串扫描而不是正则：见文件头说明。
 */
function exportedNames(text) {
  const names = []
  const lines = text.split('\n')
  const declPrefix = new RegExp(`^export[${WS_CLASS}]+(?:async[${WS_CLASS}]+)?(?:function|const|class)[${WS_CLASS}]+([A-Za-z_$][A-Za-z0-9_$]*)`)
  const listPrefix = new RegExp(`^export[${WS_CLASS}]*[{]([^}]*)[}]`)
  for (const line of lines) {
    const decl = declPrefix.exec(line)
    if (decl) {
      names.push(decl[1])
      continue
    }
    const list = listPrefix.exec(line)
    if (list) {
      for (const part of list[1].split(',')) {
        const n = part.split(/[ ]+as[ ]+/).pop().trim()
        if (n) names.push(n)
      }
    }
  }
  return names
}

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib' || name === '.debug') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/[.](ts|js|mjs)$/.test(name)) files.push(full)
  }
}
walk('plugin/src')
walk('plugin/test')
// tools/ 下的 CLI（myteam-migrate / myteam-cutover / rehearse-cutover / myteam-human …）
// 直接 import `plugin/src/**` 的导出。不扫它们，这些「生产在用」的导出会被误判成死导出。
walk('tools')

const texts = new Map(files.map((f) => [posix(f), readFileSync(f, 'utf8')]))
const srcFiles = [...texts.keys()].filter((f) => f.startsWith('plugin/src/'))
const dead = []

/**
 * **入口模块**：它们的导出是包对外的公开面（由宿主按 `package.json` 的 `exports`
 * 装载），不会在 src 内部被引用——把它们算成「死」是分析器的假阳性。
 * 来源：`plugin/package.json` 的 `exports`（v2 五层架构下装载面是 `src/composition/*.ts`）。
 */
const ENTRY_MODULES = new Set([
  'plugin/src/composition/host.ts', // exports "." / "./host"（经根 index.js 转发）
  'plugin/src/composition/member.ts', // exports "./member"
  'plugin/src/composition/panel.ts', // exports "./panel"
  'plugin/src/composition/human-command.ts', // exports "./commands"
  'plugin/src/composition/human-actions-skill.ts', // exports "./human-actions-skill"
  'plugin/src/composition/human-card-kind.ts', // exports "./human-cards"
])

for (const file of srcFiles) {
  if (!file.endsWith('.ts')) continue
  if (ENTRY_MODULES.has(file)) continue
  const text = texts.get(file)
  for (const name of new Set(exportedNames(text))) {
    const re = wordBoundary(name)
    const usedElsewhere = [...texts.entries()].some(([f, t]) => f !== file && re.test(t))
    if (!usedElsewhere) dead.push({ file, name })
  }
}

/**
 * 棘轮基线：`tools/dead-exports-allow.json`。
 *
 * 为什么需要：这个扫描器只按「符号名是否出现在其它文件的文本里」判定，所以
 * 「导出给测试断言用的常量」「文档生成器按名字读取的表」都会落进来。全部当失败
 * 会让门禁常年红；全部放过又等于没有门禁。所以：登记过的算 keep，**没登记的新增
 * 必须接线或写理由**，todo 只减不增。
 */
const allowPath = join(import.meta.dirname, 'dead-exports-allow.json')
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : {}
const allowEntries = Array.isArray(allow.entries) ? allow.entries : []
const keyOf = (e) => `${e.file}::${e.name}`
const keepKeys = new Set(allowEntries.filter((e) => e.status === 'keep').map(keyOf))
const todoEntries = allowEntries.filter((e) => e.status === 'todo')
const todoKeys = new Set(todoEntries.map(keyOf))
const maxTodo = Number(allow.maxTodo ?? todoEntries.length)

const newDebt = dead.filter((d) => !keepKeys.has(keyOf(d)) && !todoKeys.has(keyOf(d)))
const knownDebt = dead.filter((d) => todoKeys.has(keyOf(d)))
const found = new Set(dead.map(keyOf))
const cleared = todoEntries.filter((e) => !found.has(keyOf(e)))

console.log(`源文件 ${srcFiles.length} 个，扫描文件 ${texts.size} 个`)
console.log(
  `死导出: ${dead.length}（有意保留 ${dead.length - newDebt.length - knownDebt.length} / 存量债 ${knownDebt.length} / 新增 ${newDebt.length}）`,
)
if (newDebt.length > 0) {
  console.log('\n新增（必须接线，或登记进 tools/dead-exports-allow.json 并写理由）:')
  for (const d of newDebt) console.log(`  ${d.file}  ->  ${d.name}`)
}
if (knownDebt.length > 0) {
  console.log(`\n存量债 ${knownDebt.length} / 上限 ${maxTodo}:`)
  for (const d of knownDebt) console.log(`  ${d.file}  ->  ${d.name}`)
}
if (cleared.length > 0) {
  console.log(`\n✓ 已清理 ${cleared.length} 条（把 maxTodo 下调到 ${knownDebt.length}）:`)
  for (const e of cleared) console.log(`  ${e.file}  ->  ${e.name}`)
}

const strict = process.argv.includes('--strict')
const overBudget = knownDebt.length > maxTodo
if (strict && (newDebt.length > 0 || overBudget)) {
  if (newDebt.length > 0) console.error(`\n✗ 新增 ${newDebt.length} 个死导出——接不上线就登记理由`)
  if (overBudget) console.error(`\n✗ 存量债 ${knownDebt.length} 超过棘轮上限 ${maxTodo}——只许减不许增`)
  process.exit(1)
}
process.exitCode = newDebt.length > 0 || overBudget ? 1 : 0
