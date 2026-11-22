/**
 * 旧资料删除前检查：读 `docs/delivery/11-文档替换清单.md`，按状态汇总并给出可删清单。
 *
 *   node tools/check-doc-replacement.mjs            # 汇总（不改任何文件）
 *   node tools/check-doc-replacement.mjs --strict   # 存在「待补写」即非零退出
 *
 * 删除动作**故意不提供**：删旧文档必须由人逐条确认（清单里的「待确认」项），
 * 脚本只负责把「现在能不能删」变成可核对的结论。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INVENTORY = join(ROOT, 'docs', 'delivery', '11-文档替换清单.md')

const STATUSES = ['已替代', '部分替代', '待补写', '待确认']

function statusOf(cells) {
  for (const status of STATUSES) {
    if (cells.some((cell) => cell.includes(status))) return status
  }
  return null
}

const lines = readFileSync(INVENTORY, 'utf8').split(/\r?\n/)
const rows = []
let section = '(未分区)'
for (const line of lines) {
  const heading = line.match(/^##\s+(.+)$/)
  if (heading !== null) {
    section = heading[1].trim()
    continue
  }
  if (!line.startsWith('|')) continue
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
  if (cells.length < 3) continue
  if (cells[0] === '旧文档' || cells[0].replace(/\s/g, '') === '') continue
  if (/^-+$/.test(cells[0].replace(/[:\s]/g, ''))) continue
  const status = statusOf(cells)
  if (status === null) continue
  const file = cells[0].replace(/`/g, '')
  rows.push({ section, file, status })
}

const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]))
for (const row of rows) counts[row.status] += 1

const deletable = rows.filter((row) => row.status === '已替代').map((row) => row.file)
const blocking = rows.filter((row) => row.status === '待补写')
const needConfirm = rows.filter((row) => row.status === '待确认')
const partial = rows.filter((row) => row.status === '部分替代')

console.log(`清单条目：${rows.length}`)
for (const status of STATUSES) console.log(`  ${status}：${counts[status]}`)

if (deletable.length > 0) {
  console.log('\n可直接删除（已替代）：')
  for (const file of deletable) console.log(`  - ${file}`)
}
if (partial.length > 0) {
  console.log('\n可删但会有信息缺口（部分替代）：')
  for (const row of partial) console.log(`  - ${row.file}`)
}
if (blocking.length > 0) {
  console.log('\n不能删（待补写）：')
  for (const row of blocking) console.log(`  - ${row.file}`)
}
if (needConfirm.length > 0) {
  console.log('\n需人工确认（待确认）：')
  for (const row of needConfirm) console.log(`  - ${row.file}`)
}

if (process.argv.includes('--strict') && blocking.length > 0) {
  console.log(`\nBLOCKED：还有 ${blocking.length} 份旧文档没有替代品`)
  process.exit(1)
}
console.log('\nDOC_REPLACEMENT_OK')