import { stripTypeScriptTypes } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'E:/Workplace/extension/dsh-myteam/plugin'

function walk(d) {
  const o = []
  for (const n of readdirSync(d)) {
    const f = join(d, n)
    try {
      readdirSync(f)
      o.push(...walk(f))
      continue
    } catch {
      /* not a dir */
    }
    if (n.endsWith('.ts')) o.push(f)
  }
  return o
}
const rw = (c) => c.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g, (_m, h, q, s) => h + q + s + '.mjs' + q)

const drift = []
let errs = 0
const files = walk(join(ROOT, 'src'))
for (const f of files) {
  const rel = relative(join(ROOT, 'src'), f).replace(/\.ts$/, '')
  const lib = join(ROOT, 'lib', rel + '.mjs')
  try {
    const src = readFileSync(f, 'utf8')
    const want = rw(stripTypeScriptTypes(src, { mode: 'strip' }))
    const got = readFileSync(lib, 'utf8')
    if (want !== got) drift.push(rel)
  } catch (e) {
    errs++
    drift.push(rel + ' ERR: ' + String(e).slice(0, 100))
  }
}
console.log('total src files:', files.length)
console.log('MISMATCH:', drift.length, ' ERRORS:', errs)
for (const d of drift.slice(0, 20)) console.log(' -', d)
