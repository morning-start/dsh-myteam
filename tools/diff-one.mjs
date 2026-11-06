import { stripTypeScriptTypes } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'E:/Workplace/extension/dsh-myteam/plugin'
const rw = (c) => c.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g, (_m, h, q, s) => h + q + s + '.mjs' + q)

const src = readFileSync(ROOT + '/src/core/ledger/ledger.ts', 'utf8')
const want = rw(stripTypeScriptTypes(src, { mode: 'strip' }))
const got = readFileSync(ROOT + '/lib/core/ledger/ledger.mjs', 'utf8')

const wl = want.split('\n')
const gl = got.split('\n')
console.log('want lines', wl.length, 'got lines', gl.length)

// print first divergence region
let i = 0
while (i < Math.min(wl.length, gl.length) && wl[i] === gl[i]) i++
console.log('first divergence at line', i + 1)
console.log('--- WANT (expected from src) ---')
console.log(wl.slice(Math.max(0, i - 3), i + 8).map((l, j) => `${i - 3 + j + 1}|${l}`).join('\n'))
console.log('--- GOT (current lib) ---')
console.log(gl.slice(Math.max(0, i - 3), i + 8).map((l, j) => `${i - 3 + j + 1}|${l}`).join('\n'))
writeFileSync(ROOT + '/../tmp/expected-ledger.mjs', want, 'utf8')
