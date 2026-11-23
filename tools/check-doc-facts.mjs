/**
 * 文档事实体检：文档里写的**可数事实**必须等于代码算出来的数。
 *
 * 为什么需要它：`docs/architecture/07 §2` 是全部文档的「现状事实」真源，其它文档
 * 引用它而不重复数字。但数字会漂 —— 2026-11-24 实测就漂了三处：
 * 「46 个测试文件」实际 52、「写面 7 项」实际 12、「打包 308 kB」实际 325.3 kB。
 * 它们不是笔误，是**没人算**：测试加了、写方法加了、包大了，文档不会自己知道。
 *
 * 做法：从代码直接数（不读其它文档），再和 07 §2 表格里写的数字逐项对。
 * 只认 07 §2 —— 那是唯一允许写这些数字的地方，别处写了就查不到，也就会再漂。
 *
 * 检查项与算法：
 *   - 模块数：`plugin/src/**\/*.ts`（含 .d.ts，与 check-architecture 的 files= 同口径）；
 *   - 测试文件数：`plugin/test/*.test.ts`；
 *   - 读方法数：`PANEL_METHODS` 长度；免会话数：`GLOBAL_PANEL_METHODS` 长度；
 *   - 写方法数：`PANEL_WRITE_METHODS` 长度，并按 `token` / `direct` 分类计数；
 *   - 工具数：`tool-specs.ts` 里 captain / member 两张表的条目数。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FACTS_DOC = 'docs/architecture/07-文档现状对账-2.0.0.md'

const problems = []
const notes = []

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 取 `export const NAME = [ ... ] as const` 里的字符串条目（只认字面量，不做求值）。 */
function stringArray(source, name) {
  const start = source.indexOf(`export const ${name} = [`)
  if (start < 0) return null
  const end = source.indexOf('] as const', start)
  if (end < 0) return null
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const panelContract = readFileSync('plugin/src/application/panel-contract.ts', 'utf8')
const panelWrites = readFileSync('plugin/src/application/panel-writes.ts', 'utf8')
const toolSpecs = readFileSync('plugin/src/application/tool-specs.ts', 'utf8')

const readMethods = stringArray(panelContract, 'PANEL_METHODS')
const globalMethods = stringArray(panelContract, 'GLOBAL_PANEL_METHODS')
const writeMethods = stringArray(panelWrites, 'PANEL_WRITE_METHODS')

if (!readMethods || !globalMethods || !writeMethods) {
  console.log('DOC_FACTS_FAIL 读不到方法表（panel-contract.ts / panel-writes.ts 结构变了）')
  process.exit(1)
}

// token / direct 分类：在 PANEL_WRITE_METHODS 之后的对象字面量里逐个取。
const kindsBlock = panelWrites.slice(panelWrites.indexOf('PANEL_WRITE_METHODS'), panelWrites.indexOf('export type PanelWriteKind') >= 0
  ? panelWrites.indexOf('export type PanelWriteKind')
  : undefined)
const tokenWrites = writeMethods.filter((m) => new RegExp(`${m}:\\s*'token'`).test(panelWrites))
const directWrites = writeMethods.filter((m) => new RegExp(`${m}:\\s*'direct'`).test(panelWrites))

// 工具：tool-specs.ts 里按 `name: 'myteam_xxx'` 统计，再用前缀区分队长/成员。
const toolNames = [...toolSpecs.matchAll(/name:\s*'(myteam_[a-z_]+)'/g)].map((m) => m[1])
const uniqueTools = [...new Set(toolNames)]
const memberToolNames = ['myteam_progress', 'myteam_evidence', 'myteam_submit_review']
const memberTools = uniqueTools.filter((n) => memberToolNames.includes(n))
const captainTools = uniqueTools.filter((n) => !memberToolNames.includes(n))

const actual = {
  modules: walk('plugin/src').length,
  testFiles: readdirSync('plugin/test').filter((n) => n.endsWith('.test.ts')).length,
  readMethods: readMethods.length,
  globalMethods: globalMethods.length,
  writeMethods: writeMethods.length,
  tokenWrites: tokenWrites.length,
  directWrites: directWrites.length,
  captainTools: captainTools.length,
  memberTools: memberTools.length,
}

if (tokenWrites.length + directWrites.length !== writeMethods.length) {
  problems.push(`写方法的确认方式没认全：token ${tokenWrites.length} + direct ${directWrites.length} ≠ ${writeMethods.length}`)
}

// ---- 与 07 §2 表格对账 ----
const doc = readFileSync(FACTS_DOC, 'utf8')
const section = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'))

/** 从「面」列取行，返回该行整段文本。 */
function row(label) {
  const line = section.split('\n').find((l) => l.startsWith(`| ${label} |`))
  return line ?? null
}

function expect(label, regex, expected, describe) {
  const line = row(label)
  if (!line) {
    problems.push(`07 §2 找不到「${label}」这一行（表结构变了？）`)
    return
  }
  const m = line.match(regex)
  if (!m) {
    problems.push(`07 §2「${label}」这行没有写出 ${describe}（要写具体数字，别写「若干」）`)
    return
  }
  const written = m.slice(1).filter(Boolean).map(Number)
  const want = Array.isArray(expected) ? expected : [expected]
  for (let i = 0; i < want.length; i += 1) {
    if (written[i] !== want[i]) {
      problems.push(`07 §2「${label}」写的是 ${written[i]}，代码算出来是 ${want[i]}（${describe}）`)
    }
  }
}

expect('代码', /(\d+)\s*模块/, actual.modules, '模块数')
expect('测试', /(\d+)\s*个文件/, actual.testFiles, '测试文件数')
expect('面板读面', /(\d+)\s*个只读方法/, actual.readMethods, '只读方法数')
expect('面板读面', /含\s*(\d+)\s*个免会话/, actual.globalMethods, '免会话方法数')
expect('工具面', /队长\s*(\d+)\s*个\s*\+\s*成员\s*(\d+)\s*个/, [actual.captainTools, actual.memberTools], '工具数')
expect('写面', /(\d+)\s*项：令牌类\s*(\d+)[^+]*\+\s*直接确认类\s*(\d+)/,
  [actual.writeMethods, actual.tokenWrites, actual.directWrites], '写方法数')

notes.push(`模块 ${actual.modules} ｜ 测试文件 ${actual.testFiles} ｜ 读方法 ${actual.readMethods}（免会话 ${actual.globalMethods}）`)
notes.push(`写方法 ${actual.writeMethods}（token ${actual.tokenWrites} / direct ${actual.directWrites}）｜ 工具 ${actual.captainTools}+${actual.memberTools}`)

if (problems.length > 0) {
  console.log(`DOC_FACTS_FAIL ${problems.length} 处`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`DOC_FACTS_OK ${notes.join(' ｜ ')}`)
