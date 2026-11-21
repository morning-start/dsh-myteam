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

console.log(`总模块: ${byRel.size}`)
console.log(`入口可达: ${reachable.size}`)
console.log(`不可达: ${dead.length}`)
for (const d of dead) console.log('  DEAD ' + d)

// 反向：谁引用了我（给可疑模块用）
const targets = process.env.WHO_IMPORTS
if (targets) {
  for (const t of targets.split(',')) {
    const want = posix.normalize(t.trim())
    const users = [...byRel.entries()].filter(([rel, file]) => rel !== want && depsOf(file).has(want)).map(([rel]) => rel)
    console.log(`\n[who imports ${want}] ${users.length ? users.join(', ') : '（无人引用）'}`)
  }
}
