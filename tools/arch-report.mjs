/**
 * 架构梳理报告（可复算面）。
 *
 * 为什么要有它：`docs/03-架构与ADR.md` 写的是**声明的**分层，`tools/check-architecture.mjs`
 * 只守五条硬红线（A1–A5）。两者之间还有一大片「没有明文、但已经长出来」的结构事实：
 * 谁 fan-in 最高、哪个子域偷偷变成枢纽、有没有环形依赖、入口层是不是在往 core 里渗。
 * 这些数字手写进文档必然过期，所以做成脚本 —— **文档里的每个数字都应当能由本脚本复现**。
 *
 * 与 `check-architecture.mjs` 的分工：
 *   - `check-architecture` = 门禁（违规就红，退出码 1，只判 5 条硬红线）
 *   - `arch-report`        = 体检（只报告、恒退 0，供人判读取舍）
 *
 * 三条关键口径（判读时先看这里，否则会把正常结构读成缺陷）：
 *   ① **`core/errors.ts` 是共享内核**（错误码常量表），任何层都可以依赖它 —— 它不算「逆向边」。
 *   ② **type-only 边与 value 边分开**：`import type` 在运行时被擦除，type 环不会造成
 *      装载顺序问题，但它仍然是耦合（改接口会连带），因此单独报、不与 value 环混算。
 *   ③ **子域互依赖不判对错**，只报数字：`index -> scheduler` 这类单向依赖是设计，
 *      两个方向都大才是问题。
 *
 * 运行：node tools/arch-report.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep, posix as pathPosix } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = fileURLToPath(new URL('../plugin/', import.meta.url))
const SRC = join(PLUGIN, 'src')
const posix = (p) => p.split(sep).join('/')

/* ── 分层口径（与 docs/03 §分层 对齐；改这里就要改文档）──────────────────── */

/** 层的判定顺序即优先级：先命中先归属。 */
const LAYERS = [
  { id: 'entry', label: '入口层', test: (rel) => /^(host|panel|smoke|host-workspace)\.ts$/.test(rel) },
  { id: 'remote', label: '远程面', test: (rel) => rel.startsWith('remote/') },
  { id: 'tools', label: '工具声明', test: (rel) => rel.startsWith('tools/') },
  { id: 'shared', label: '共享内核', test: (rel) => rel === 'core/errors.ts' },
  { id: 'infra', label: '基础设施', test: (rel) => rel.startsWith('core/fs/') },
  { id: 'core-root', label: '核心装配', test: (rel) => /^core\/[^/]+\.ts$/.test(rel) },
  { id: 'domain', label: '领域子域', test: (rel) => rel.startsWith('core/') },
]

const layerOf = (rel) => LAYERS.find((layer) => layer.test(rel)) ?? { id: 'other', label: '未归类' }

/** 领域子域名（`core/<domain>/...` → `<domain>`）；非子域返回 `-`。 */
const domainOf = (rel) => {
  const m = /^core\/([^/]+)\/[^/]+\.ts$/.exec(rel)
  return m ? m[1] : '-'
}

/**
 * 层深：**数字越大越底层（越通用）**。合法依赖只能「向下」或同层，
 * 即 `depth(from) <= depth(to)`；`depth(from) > depth(to)` 就是「低层反向依赖高层」。
 *
 * `shared` 排最深（4）—— 错误码常量表是最通用的东西，任何层依赖它都合法，
 * 不因为它物理上躺在 `core/` 里就算逆向。
 */
const LAYER_DEPTH = { entry: 0, remote: 1, tools: 1, 'core-root': 2, infra: 3, domain: 3, shared: 4, other: 9 }

/* ── 采集 ───────────────────────────────────────────────────────────────── */

function walk(dir, ext) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * 抓所有相对说明符并标注 type-only。
 *
 * **不能**用「`import` … `[^;]*` … `from`」这种正则：本项目是**无分号风格**，
 * `[^;]` 等于无界，匹配会跨过多条语句把后面的 `from '…'` 吃进来（实测把
 * `import type { MyTeamHost } from '../host.ts'` 误判成 value 边，进而造出一个假环）。
 *
 * 改为按**语句块**扫：以行首的 `import` / `export` 起头，向下找到第一个带 `from '…'`
 * 的行（多行 import 列表）或用掉本行（副作用 import）。kind 由块首行是否 `import type`
 * 决定；内联 `import { type A, B }` 仍算 value（同一语句里既有类型又有值）。
 */
function importsOf(code) {
  const map = new Map()
  const mark = (spec, kind) => {
    if (!spec.startsWith('.')) return
    if (map.get(spec) === 'value') return
    map.set(spec, kind)
  }
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i]
    if (!/^(import|export)\b/.test(head)) continue
    const isType = /^(?:import|export)\s+type\b/.test(head)

    // 副作用 import：`import './x.ts'`（本行即完整语句，不能向下找 from）
    const bare = /^import\s*['"](\.[^'"]+)['"]/.exec(head)
    if (bare) {
      mark(bare[1], 'value')
      continue
    }

    let block = head
    let j = i
    while (!/\bfrom\s*['"]/.test(block) && j - i < 60) {
      j += 1
      if (j >= lines.length) break
      block += `\n${lines[j]}`
    }
    const m = /\bfrom\s*['"](\.[^'"]+)['"]/.exec(block)
    if (m) {
      mark(m[1], isType ? 'type' : 'value')
      i = j
    }
  }
  // 动态 import()：任何位置都算 value
  for (const m of code.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) mark(m[1], 'value')
  return map
}

/* ── 自检：解析器的边界（无分号 / 多行 import / 副作用 / 动态 / type-only）──────
 *
 * 这一段是**必需的**，不是装饰：本项目的无分号风格会让「`import` … `[^;]*` … `from`」
 * 这类朴素正则跨语句误匹配，实测把 `import type` 误判成 value 边、进而凭空造出一个假环。
 * 自检把五类边界都钉住，改解析器时 `node tools/arch-report.mjs --selftest` 先过。
 */
if (process.argv.includes('--selftest')) {
  const cases = [
    ['无分号紧邻两条语句', "import type { A } from './a.ts'\nimport { b } from './b.ts'\n", { './a.ts': 'type', './b.ts': 'value' }],
    ['多行 import 列表', "import {\n  a,\n  b,\n} from './m.ts'\n", { './m.ts': 'value' }],
    ['副作用 import', "import './side.ts'\nimport x from './next.ts'\n", { './side.ts': 'value', './next.ts': 'value' }],
    ['动态 import', "const m = await import('./dyn.ts')\n", { './dyn.ts': 'value' }],
    ['export from', "export { a } from './r.ts'\nexport type { B } from './t.ts'\n", { './r.ts': 'value', './t.ts': 'type' }],
    ['内联 type 视为 value', "import { type A, b } from './mix.ts'\n", { './mix.ts': 'value' }],
  ]
  let failed = 0
  for (const [name, code, want] of cases) {
    const got = Object.fromEntries([...importsOf(code)].filter(([spec]) => spec.startsWith('.')))
    const ok = JSON.stringify(got) === JSON.stringify(want)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     want ${JSON.stringify(want)}\n     got  ${JSON.stringify(got)}`}`)
    if (!ok) failed += 1
  }
  console.log(failed === 0 ? `[selftest] ${cases.length}/${cases.length} 通过` : `[selftest] ${failed} 条失败`)
  process.exit(failed === 0 ? 0 : 1)
}

const files = walk(SRC, '.ts')
const modules = new Map() // rel -> { rel, loc, exports, layer, domain, imports: Map<rel,'type'|'value'> }

for (const file of files) {
  const rel = posix(relative(SRC, file))
  const code = readFileSync(file, 'utf8')
  const imports = new Map()
  for (const [spec, kind] of importsOf(code)) {
    // 相对说明符按「当前文件的目录」解析，再归一化掉 `a/b/../c`。
    // 必须走 posix 口径：模块键是 posix 相对路径，用 path.resolve 会掺进盘符。
    const to = pathPosix.normalize(pathPosix.join(pathPosix.dirname(rel), spec))
    if (imports.get(to) === 'value') continue
    imports.set(to, kind)
  }
  modules.set(rel, {
    rel,
    loc: code.split('\n').length,
    exports: (code.match(/^\s*export\s+(?:async\s+)?(?:function|const|class|interface|type|let|var)\b/gm) ?? []).length,
    layer: layerOf(rel).id,
    domain: domainOf(rel),
    imports,
  })
}

/* ── 边 ─────────────────────────────────────────────────────────────────── */

const edges = [] // { from, to, kind }
const dangling = []
for (const mod of modules.values()) {
  for (const [to, kind] of mod.imports) {
    if (!modules.has(to)) {
      dangling.push({ from: mod.rel, to })
      continue
    }
    if (to === mod.rel) continue
    edges.push({ from: mod.rel, to, kind })
  }
}

const valueEdges = edges.filter((e) => e.kind === 'value')
const typeEdges = edges.filter((e) => e.kind === 'type')

/* ── 指标 ───────────────────────────────────────────────────────────────── */

const fanIn = new Map(modules.keys().map((rel) => [rel, 0]))
const fanOut = new Map(modules.keys().map((rel) => [rel, 0]))
const typeFanIn = new Map(modules.keys().map((rel) => [rel, 0]))
const crossLayer = new Map()
const domainMatrix = new Map()
const upward = []

for (const { from, to, kind } of edges) {
  fanIn.set(to, (fanIn.get(to) ?? 0) + 1)
  fanOut.set(from, (fanOut.get(from) ?? 0) + 1)
  if (kind === 'type') typeFanIn.set(to, (typeFanIn.get(to) ?? 0) + 1)
  const a = modules.get(from)
  const b = modules.get(to)
  const layerKey = `${a.layer}->${b.layer}${kind === 'type' ? ' (type)' : ''}`
  crossLayer.set(layerKey, (crossLayer.get(layerKey) ?? 0) + 1)
  const domainKey = `${a.domain}->${b.domain}`
  domainMatrix.set(domainKey, (domainMatrix.get(domainKey) ?? 0) + 1)
  if (kind === 'value' && (LAYER_DEPTH[a.layer] ?? 9) > (LAYER_DEPTH[b.layer] ?? 9)) {
    upward.push({ from, to, aLayer: a.layer, bLayer: b.layer })
  }
}

/* ── 环（Tarjan SCC，value 边与 type 边分开算）──────────────────────────── */

function findCycles(list) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const sccs = []
  let counter = 0
  const adj = new Map(modules.keys().map((rel) => [rel, []]))
  for (const { from, to } of list) adj.get(from).push(to)

  function strongconnect(v) {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)))
      }
    }
    if (low.get(v) === index.get(v)) {
      const group = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        group.push(w)
      } while (w !== v)
      if (group.length > 1) sccs.push(group.sort())
    }
  }
  for (const rel of modules.keys()) if (!index.has(rel)) strongconnect(rel)
  return sccs
}

const valueCycles = findCycles(valueEdges)
const allCycles = findCycles(edges)

/* ── 入口可达性（反查「谁能走到它」）───────────────────────────────────── */

const ENTRY = [...modules.keys()].filter((rel) => layerOf(rel).id === 'entry')
const reachable = new Set()
const queue = [...ENTRY]
while (queue.length > 0) {
  const cur = queue.shift()
  if (reachable.has(cur)) continue
  reachable.add(cur)
  for (const next of modules.get(cur)?.imports.keys() ?? []) if (modules.has(next)) queue.push(next)
}
const unreachable = [...modules.keys()].filter((rel) => !reachable.has(rel))

/* ── 输出 ───────────────────────────────────────────────────────────────── */

const totalLoc = [...modules.values()].reduce((sum, m) => sum + m.loc, 0)
const byLayer = (id) => [...modules.values()].filter((m) => m.layer === id)
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)

const result = {
  moduleCount: modules.size,
  edgeCount: edges.length,
  valueEdgeCount: valueEdges.length,
  typeEdgeCount: typeEdges.length,
  totalLoc,
  entryShare: Number(((byLayer('entry').reduce((s, m) => s + m.loc, 0) / totalLoc) * 100).toFixed(1)),
  layers: LAYERS.map((layer) => ({
    id: layer.id,
    label: layer.label,
    modules: byLayer(layer.id).length,
    loc: byLayer(layer.id).reduce((s, m) => s + m.loc, 0),
  })),
  crossLayer: [...crossLayer.entries()].sort((a, b) => b[1] - a[1]),
  upward,
  valueCycles,
  typeOnlyCycles: allCycles.filter((c) => !valueCycles.some((v) => v.join() === c.join())),
  dangling,
  unreachable,
  topFanIn: top(fanIn, 12),
  topFanOut: top(fanOut, 10),
  topTypeFanIn: top(typeFanIn, 8),
  topByLoc: [...modules.values()].sort((a, b) => b.loc - a.loc).slice(0, 12).map((m) => [m.rel, m.loc]),
  topByExports: [...modules.values()].sort((a, b) => b.exports - a.exports).slice(0, 10).map((m) => [m.rel, m.exports]),
  domainMatrix: [...domainMatrix.entries()]
    .filter(([key]) => !key.startsWith('-') && !key.endsWith('->-'))
    .sort((a, b) => b[1] - a[1]),
  domains: [...new Set([...modules.values()].map((m) => m.domain))]
    .filter((d) => d !== '-')
    .sort()
    .map((id) => {
      const mods = [...modules.values()].filter((m) => m.domain === id)
      const out = edges.filter((e) => modules.get(e.from).domain === id && modules.get(e.to).domain !== id).length
      const inn = edges.filter((e) => modules.get(e.to).domain === id && modules.get(e.from).domain !== id).length
      return { id, modules: mods.length, loc: mods.reduce((s, m) => s + m.loc, 0), out, in: inn }
    }),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const lines = []
const pad = (s, n) => String(s).padEnd(n, '　')
lines.push(`模块 ${result.moduleCount} · 依赖边 ${result.edgeCount}（value ${result.valueEdgeCount} / type ${result.typeEdgeCount}） · 源码 ${result.totalLoc} 行`)
lines.push('')
lines.push('## 分层')
for (const layer of result.layers) {
  const share = ((layer.loc / result.totalLoc) * 100).toFixed(1)
  lines.push(`  ${pad(layer.label, 6)} ${String(layer.modules).padStart(3)} 个  ${String(layer.loc).padStart(6)} 行  ${share.padStart(5)}%`)
}
lines.push(`  ${pad('入口占比', 6)} ${String(result.entryShare).padStart(5)}%  ← 越接近 100% 说明业务都堆在入口文件里`)
lines.push('')
lines.push('## 层间依赖边')
for (const [key, count] of result.crossLayer) lines.push(`  ${key.padEnd(30)} ${String(count).padStart(4)}`)
lines.push('')
lines.push(`## 逆向边（低层依赖高层，value 边）: ${result.upward.length}`)
for (const edge of result.upward) lines.push(`  ${edge.from} (${edge.aLayer}) -> ${edge.to} (${edge.bLayer})`)
lines.push('')
lines.push(`## 环形依赖 — value 边（运行时会真的互相装载）: ${result.valueCycles.length}`)
for (const cycle of result.valueCycles) lines.push(`  ${cycle.join(' ⇄ ')}`)
lines.push(`## 环形依赖 — 仅 type 边（擦除后无害，但接口耦合仍在）: ${result.typeOnlyCycles.length}`)
for (const cycle of result.typeOnlyCycles) lines.push(`  ${cycle.join(' ⇄ ')}`)
lines.push('')
lines.push(`## 入口不可达（疑似死代码）: ${result.unreachable.length}`)
for (const rel of result.unreachable) lines.push(`  ${rel}`)
lines.push('')
lines.push(`## 悬空说明符（解析不到文件）: ${result.dangling.length}`)
for (const item of result.dangling) lines.push(`  ${item.from} -> ${item.to}`)
lines.push('')
lines.push('## fan-in 最高（谁被最多人依赖 = 枢纽）')
for (const [rel, count] of result.topFanIn) lines.push(`  ${String(count).padStart(3)}  ${rel}`)
lines.push('')
lines.push('## type-only fan-in 最高（改接口会连带多少人）')
for (const [rel, count] of result.topTypeFanIn) lines.push(`  ${String(count).padStart(3)}  ${rel}`)
lines.push('')
lines.push('## fan-out 最高（谁最知道别人的事）')
for (const [rel, count] of result.topFanOut) lines.push(`  ${String(count).padStart(3)}  ${rel}`)
lines.push('')
lines.push('## 体量最大')
for (const [rel, loc] of result.topByLoc) lines.push(`  ${String(loc).padStart(5)} 行  ${rel}`)
lines.push('')
lines.push('## 导出面最宽（对外承诺最多）')
for (const [rel, count] of result.topByExports) lines.push(`  ${String(count).padStart(3)} 个  ${rel}`)
lines.push('')
lines.push('## 领域子域互依赖（跨子域边）')
for (const [key, count] of result.domainMatrix) lines.push(`  ${key.padEnd(30)} ${String(count).padStart(4)}`)
lines.push('')
lines.push('## 子域概览（模块数 / 行数 / 出边 / 入边）')
for (const d of result.domains) {
  lines.push(`  ${d.id.padEnd(16)} ${String(d.modules).padStart(2)} 个  ${String(d.loc).padStart(5)} 行  出 ${String(d.out).padStart(3)}  入 ${String(d.in).padStart(3)}`)
}

console.log(lines.join('\n'))
