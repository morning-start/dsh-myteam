import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWorkplaceDirs, ensureGitignoreManagedBlock, WORKPLACE_DIRS } from '../src/host.js'

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'myteam-t1-'))
}

test('T1: ensureWorkplaceDirs creates all four partitions idempotently', () => {
  const ws = tempWorkspace()
  const first = ensureWorkplaceDirs(ws)
  assert.ok(first.created.length >= Object.keys(WORKPLACE_DIRS).length - 1) // root included
  // CHG-86：分区必须挂在 .team-workplace/ 下（FR-9.3），不是工作区根目录
  for (const dir of Object.values(WORKPLACE_DIRS)) {
    const expected = dir === WORKPLACE_DIRS.root ? join(ws, dir) : join(ws, '.team-workplace', dir)
    assert.ok(existsSync(expected), `missing ${dir} at ${expected}`)
  }
  // 反向断言：不允许在工作区根目录下留下 config/ state/ archive/ export/ 四个污染目录
  for (const dir of Object.values(WORKPLACE_DIRS)) {
    if (dir === WORKPLACE_DIRS.root) continue
    assert.ok(!existsSync(join(ws, dir)), `partition ${dir} must not be created at workspace root`)
  }
  assert.ok(existsSync(join(ws, '.team-workplace', 'structure.md')), 'structure.md seeded')
  // 幂等：第二次调用不再新建
  const second = ensureWorkplaceDirs(ws)
  assert.equal(second.created.length, 0)
})

test('T1: gitignore managed block is append-only and idempotent (R11)', () => {
  const ws = tempWorkspace()
  // 用户已有规则 + 尾部无换行 → 追加时补分隔，不破坏原内容
  writeFileSync(join(ws, '.gitignore'), 'node_modules/', 'utf8')
  const warnings = []
  const first = ensureGitignoreManagedBlock(ws, (m) => warnings.push(m))
  assert.equal(first.changed, true)
  const content = readFileSync(join(ws, '.gitignore'), 'utf8')
  assert.ok(content.startsWith('node_modules/'), 'user content untouched')
  assert.ok(content.includes('# >>> dsh-plugin-myteam managed block >>>'))
  assert.ok(content.includes('.team-workplace/state/'))
  assert.ok(content.includes('.team-workplace/archive/'))
  assert.ok(!content.includes('.team-workplace/config/'), 'config stays committable')
  // 用户已有等价规则 → 告警但托管块仍写入（重复忽略无害）
  assert.ok(warnings.length === 0, `unexpected warnings: ${warnings}`)
  // 幂等：第二次不重复追加
  const second = ensureGitignoreManagedBlock(ws)
  assert.equal(second.changed, false)
  const after = readFileSync(join(ws, '.gitignore'), 'utf8')
  assert.equal(after.split('# >>> dsh-plugin-myteam managed block >>>').length - 1, 1)
})

test('T1: creates .gitignore when absent', () => {
  const ws = tempWorkspace()
  ensureGitignoreManagedBlock(ws)
  const content = readFileSync(join(ws, '.gitignore'), 'utf8')
  assert.ok(content.includes('.team-workplace/state/'))
})
