import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PANEL_METHODS, PANEL_METHOD_DOCS } from '../src/application/panel-contract.ts'
import { PROTOCOL_VERSION } from '../src/contracts/versions.ts'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const GENERATOR = join(PLUGIN_DIR, '..', 'tools', 'gen-panel-contract.mjs')

test('面板契约：方法名唯一且都有说明', () => {
  assert.equal(new Set(PANEL_METHODS).size, PANEL_METHODS.length)
  for (const method of PANEL_METHODS) {
    assert.ok(PANEL_METHOD_DOCS[method] !== undefined && PANEL_METHOD_DOCS[method].length > 0, `${method} 缺少说明`)
  }
  assert.equal(PROTOCOL_VERSION, 2)
})

test('面板契约文档与代码一致（--check）', () => {
  const output = execFileSync(process.execPath, [GENERATOR, '--check'], { cwd: PLUGIN_DIR, encoding: 'utf8' })
  assert.match(output, /PANEL_CONTRACT_OK/)
})