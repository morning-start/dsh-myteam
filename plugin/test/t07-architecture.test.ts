import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkArchitecture } from '../../tools/check-architecture.mjs'
import { EVENT_TYPES } from '../src/contracts/events.ts'
import { HANDLED_EVENT_TYPES } from '../src/application/projections/project-state.ts'

test('架构门禁：当前 v2 源码零违规', () => {
  const { files, violations } = checkArchitecture()
  assert.ok(files >= 15, `应至少检查 15 个源文件，实际 ${files}`)
  assert.deepEqual(
    violations.map((violation) => `${violation.rule} ${violation.file}:${violation.line} ${violation.message}`),
    [],
  )
})

test('架构门禁：能抓出反向依赖与宿主模块', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-arch-'))
  try {
    mkdirSync(join(dir, 'contracts'), { recursive: true })
    mkdirSync(join(dir, 'domain'), { recursive: true })
    writeFileSync(join(dir, 'domain', 'rule.ts'), 'export const value = 1\n')
    writeFileSync(
      join(dir, 'contracts', 'bad.ts'),
      [
        "import { readFileSync } from 'node:fs'",
        "import { value } from '../domain/rule.ts'",
        "import zod from 'zod'",
        'export const x = () => console.log(readFileSync, value, zod)',
      ].join('\n'),
    )
    const { violations } = checkArchitecture(dir)
    const rules = violations.map((violation) => violation.rule).sort()
    assert.ok(rules.includes('V2'), '应报反向依赖')
    assert.ok(rules.includes('V3'), '应报宿主模块')
    assert.ok(rules.includes('V4'), '应报第三方包')
    assert.ok(rules.includes('V5'), '应报 console.log')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('事件目录：每个事件类型都有投影处理', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [...HANDLED_EVENT_TYPES].sort())
})