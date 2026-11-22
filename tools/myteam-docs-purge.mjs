/**
 * 旧资料清除工具（默认只演练，不删文件）。
 *
 *   node tools/myteam-docs-purge.mjs                 # 演练：列出将删除的文件
 *   node tools/myteam-docs-purge.mjs --include-partial
 *                                                    # 连「部分替代」一起列
 *   node tools/myteam-docs-purge.mjs --apply --confirm
 *                                                    # 真删（需 --confirm）
 *
 * 规则来自 `docs/delivery/11-文档替换清单.md`：
 *   - 有「待补写」→ 拒绝删除（没有替代品的内容不能丢）；
 *   - 「待确认」一律不动（那是留给用户逐条拍板的）；
 *   - 只删 `docs/historical/` 与 `docs/contracts/` 下确实存在的文件。
 *
 * 删完不会自动提交：先跑 check-doc-links 与 check-doc-replacement，确认无断链后
 * 再由人复核、提交。Git 历史里仍可恢复。
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INVENTORY = join(ROOT, 'docs', 'delivery', '11-文档替换清单.md')

const apply = process.argv.includes('--apply')
const confirm = process.argv.includes('--confirm')
const includePartial = process.argv.includes('--include-partial')

const STATUSES = ['已替代', '部分替代', '待补写', '待确认', '已删除']

function statusOf(cells) {
  for (const status of STATUSES) if (cells.some((cell) => cell.includes(status))) return status
  return null
}

function sectionDir(heading) {
  if (heading.includes('historical')) return join(ROOT, 'docs', 'historical')
  if (heading.includes('contracts')) return join(ROOT, 'docs', 'contracts')
  return null
}

const lines = readFileSync(INVENTORY, 'utf8').split(/\r?\n/)
let section = ''
const targets = []
const blocked = []

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
  if (cells.length < 3 || cells[0] === '旧文档') continue
  const status = statusOf(cells)
  if (status === null) continue
  const file = cells[0].replace(/`/g, '')
  if (status === '待补写') blocked.push(file)
  if (status === '待确认') continue
  if (status === '部分替代' && !includePartial) continue
  const dir = sectionDir(section)
  if (dir === null) continue
  const absolute = join(dir, file)
  if (existsSync(absolute)) targets.push({ file, absolute, status })
}

if (blocked.length > 0) {
  console.error(`拒绝执行：还有 ${blocked.length} 份旧文档没有替代品`)
  for (const file of blocked) console.error(`  - ${file}`)
  process.exit(1)
}

console.log(`准备删除 ${targets.length} 个文件：`)
for (const target of targets) console.log(`  - [${target.status}] ${target.file}`)

if (!apply) {
  console.log('\n（演练）未删除任何文件。确认无误后加 --apply --confirm。')
  process.exit(0)
}
if (!confirm) {
  console.error('\n--apply 需要同时给 --confirm')
  process.exit(2)
}

for (const target of targets) {
  rmSync(target.absolute, { force: true })
  console.log(`已删除 ${target.file}`)
}
console.log('\n删除完成。下一步：')
console.log('  node tools/check-doc-links.mjs')
console.log('  node tools/check-doc-replacement.mjs --strict')
console.log('确认无断链后再提交。')