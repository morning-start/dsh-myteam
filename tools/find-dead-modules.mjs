/**
 * 死模块分析：从入口做可达性遍历，列出没有任何入口能到达的 src 模块。
 *
 * 只认静态 import / export-from（本项目不用动态 import 加载 src 模块）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, posix } from 'node:path'

const SRC = resolve('plugin/src')
const ENTRIES = process.argv.slice(2)

if (ENTRIES.length === 0) {
  console.error('用法: node tools/find-dead-modules.mjs <entry.ts> [entry2.ts ...]')
  process.exit(1)
}

/** 递归列出 src 下所有 .ts */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

const all = walk(SRC)
const byRel = new Map(all.map((f) => [posix.normalize(relative(SRC, f).replace(/\\/g, '/')), f]))

/** 抽出一个文件里的静态依赖（相对路径，解析成 src 相对 posix 路径） */
function depsOf(file) {
  const text = readFileSync(file, 'utf8')
  const out = new Set()
  // import ... from '...'   /   export ... from '...'   /   import '...'
  const re = /(?:^|[\s;])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    const spec = m[1]
    if (!spec.startsWith('.')) continue // 裸包名（node: / 第三方）不追踪
    let target = resolve(dirname(file), spec)
    // .ts 后缀显式写了就用，否则补 .ts / /index.ts
    const candidates = [target, target + '.ts', join(target, 'index.ts')]
    const hit = candidates.find((c) => {
      try {
        return statSync(c).isFile()
      } catch {
        return false
      }
    })
    if (!hit) continue
    const rel = posix.normalize(relative(SRC, hit).replace(/\\/g, '/'))
    out.add(rel)
  }
  return out
}

const reachable = new Set()
const queue = ENTRIES.map((e) => posix.normalize(relative(SRC, resolve(e)).replace(/\\/g, '/')))
for (const e of queue) reachable.add(e)

while (queue.length > 0) {
  const cur = queue.pop()
  const file = byRel.get(cur)
  if (!file) continue
  for (const dep of depsOf(file)) {
    if (reachable.has(dep)) continue
    reachable.add(dep)
    queue.push(dep)
  }
}

const dead = [...byRel.keys()].filter((rel) => !reachable.has(rel)).sort()

/**
 * 非插件入口（CLI / 迁移工具）的引用面。
 *
 * 为什么需要：`tools/myteam-*.mjs` 直接 import `plugin/src/**` 的模块（迁移候选导入、
 * cutover 计划、人类动作 CLI 都是这样）。只从 composition 入口做可达性判定，会把
 * 这些「生产在用、但不在宿主装载链上」的模块误判成死代码。所以把 tools/ 下所有
 * 脚本里出现的 `plugin/src/<path>.ts` 说明符也当作根节点。
 */
function toolRoots() {
  const out = new Set()
  const toolsDir = resolve('tools')
  let names = []
  try {
    names = readdirSync(toolsDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!/\.(mjs|js|ts)$/.test(name)) continue
    const text = readFileSync(join(toolsDir, name), 'utf8')
    for (const m of text.matchAll(/['"]((?:\.\.\/)+plugin\/src\/[^'"]+\.ts)['"]/g)) {
      const abs = resolve(toolsDir, m[1])
      out.add(posix.normalize(relative(SRC, abs).replace(/\\/g, '/')))
    }
  }
  return out
}

const roots = toolRoots()
for (const root of roots) {
  if (reachable.has(root)) continue
  reachable.add(root)
  const stack = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    const file = byRel.get(cur)
    if (!file) continue
    for (const dep of depsOf(file)) {
      if (reachable.has(dep)) continue
      reachable.add(dep)
      stack.push(dep)
    }
  }
}

const deadAfterTools = [...byRel.keys()].filter((rel) => !reachable.has(rel)).sort()

/**
 * 已登记为「有测试、无生产接线」的模块（棘轮基线）。
 *
 * 判定口径与 `find-unwired-exports.mjs` 一致：**测试引用不算接线**。这 3 个模块是
 * v2 早期设计留下的应用层组件，目前只有单测在跑、没有任何生产路径调用它们：
 *   - `application/effect-commands.ts`：Effect 状态机用例，工具面与面板都没有对应入口；
 *   - `application/panel-gateway.ts`：会话→工作区根的网关，面板改走 `webServer` 路由后
 *     由 `composition/panel.ts` 内联完成，网关成了第二套实现；
 *   - `application/session-root.ts`：网关的默认根解析器，随网关一起失去调用方。
 * 每条都要写理由；**只许减不许增**——新增死模块仍然会让门禁红。
 */
const KNOWN_DEAD = new Map([
  ['application/effect-commands.ts', 'Effect 用例：工具面/面板均无入口，仅单测覆盖'],
  ['application/panel-gateway.ts', '面板网关：生产走 composition/panel.ts 的 webServer 路由，本文件仅单测覆盖'],
  ['application/session-root.ts', '网关的根解析器：随 panel-gateway 一起失去调用方，仅单测覆盖'],
])

const unexpected = deadAfterTools.filter((rel) => !KNOWN_DEAD.has(rel))

console.log(`总模块: ${byRel.size}`)
console.log(`入口可达: ${reachable.size}`)
console.log(`不可达: ${unexpected.length}`)
for (const d of unexpected) console.log('  DEAD ' + d)
if (roots.size > 0) console.log(`（其中 ${roots.size} 个根节点来自 tools/ 的 CLI 引用）`)
if (deadAfterTools.length > unexpected.length) {
  console.log(`已登记（有测试、无生产接线）: ${deadAfterTools.length - unexpected.length}`)
  for (const d of deadAfterTools.filter((rel) => KNOWN_DEAD.has(rel))) {
    console.log(`  KEEP ${d} — ${KNOWN_DEAD.get(d)}`)
  }
}

// 反向：谁引用了我（给可疑模块用）
const targets = process.env.WHO_IMPORTS
if (targets) {
  for (const t of targets.split(',')) {
    const want = posix.normalize(t.trim())
    const users = [...byRel.entries()].filter(([rel, file]) => rel !== want && depsOf(file).has(want)).map(([rel]) => rel)
    console.log(`\n[who imports ${want}] ${users.length ? users.join(', ') : '（无人引用）'}`)
  }
}
