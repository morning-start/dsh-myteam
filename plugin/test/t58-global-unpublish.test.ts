/**
 * t58：全局库「下架」（unpublish）—— 只影响目录可见性，不删文件。
 *
 * 设计稿 g-role / g-workflow / g-blueprint 的原话：「下架只是不再出现在目录里；
 * 已被引用的工作流与蓝图仍能读到这一版。」所以这一层要钉住三件事：
 *   1. 下架后 readGlobalLibrary 里看不到它，但**文件还在**（引用方读得到）；
 *   2. 下架写 definition.unpublish 审计，带 globalHash 与 editor；
 *   3. expectedHash 不符 → CONFLICT，且不写隐藏索引（不能把别人刚改的版本藏掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGlobalEditor, globalEntryFile } from '../src/infrastructure/global-library/write.ts'
import { readGlobalLibrary } from '../src/infrastructure/global-library/library.ts'
import { MyTeamError } from '../src/contracts/errors.ts'

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'myteam-unpub-'))
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ROLE = { profile: { name: '实现者', purpose: '实现', instructions: '按 AC' }, capabilities: { tools: { allow: ['read'], deny: [] } } }

function seedRole(root: string): string {
  const editor = createGlobalEditor(root)
  const written = editor.writeFile({
    kind: 'role',
    id: 'role_1',
    definition: ROLE,
    revision: 1,
    operationId: 'op_1',
    expectedHash: null,
    editedAt: '2026-01-01T00:00:00.000Z',
    editor: 'owner',
  })
  return written.globalHash
}

test('下架后目录里看不到，但文件还在（引用方读得到）', () => {
  withRoot((root) => {
    const hash = seedRole(root)
    assert.equal(readGlobalLibrary(root).entries.length, 1, '下架前目录里有一条')

    createGlobalEditor(root).unpublish({
      kind: 'role',
      id: 'role_1',
      operationId: 'op_hide',
      expectedHash: hash,
      unpublishedAt: '2026-01-02T00:00:00.000Z',
      editor: 'owner',
    })

    const view = readGlobalLibrary(root)
    assert.equal(view.entries.length, 0, '下架后目录里不再出现')
    assert.equal(view.counts.role, 0)
    assert.ok(existsSync(join(root, globalEntryFile('role', 'role_1'))), '文件必须还在 —— 下架不是删除')
  })
})

test('下架写 definition.unpublish 审计（带 globalHash 与 editor）', () => {
  withRoot((root) => {
    const hash = seedRole(root)
    createGlobalEditor(root).unpublish({
      kind: 'role',
      id: 'role_1',
      operationId: 'op_hide',
      expectedHash: hash,
      unpublishedAt: '2026-01-02T00:00:00.000Z',
      editor: 'owner',
    })
    const lines = readFileSync(join(root, 'audit', 'global-operations.jsonl'), 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const last = lines[lines.length - 1]!
    assert.equal(last.action, 'definition.unpublish')
    assert.equal(last.status, 'unpublished')
    assert.equal(last.globalHash, hash)
    assert.equal(last.editor, 'owner')
  })
})

test('expectedHash 不符 → CONFLICT，且不写隐藏索引', () => {
  withRoot((root) => {
    seedRole(root)
    assert.throws(
      () => createGlobalEditor(root).unpublish({
        kind: 'role',
        id: 'role_1',
        operationId: 'op_hide',
        expectedHash: 'sha256:deadbeef',
        unpublishedAt: '2026-01-02T00:00:00.000Z',
        editor: 'owner',
      }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFLICT',
    )
    assert.equal(readGlobalLibrary(root).entries.length, 1, '冲突时不能把它藏掉')
    assert.equal(existsSync(join(root, '_hidden.json')), false, '冲突时不该写隐藏索引')
  })
})

test('hiddenIds 按 kind 返回已下架 id（界面要显示「已下架」时可查）', () => {
  withRoot((root) => {
    const hash = seedRole(root)
    const editor = createGlobalEditor(root)
    editor.unpublish({
      kind: 'role',
      id: 'role_1',
      operationId: 'op_hide',
      expectedHash: hash,
      unpublishedAt: '2026-01-02T00:00:00.000Z',
      editor: 'owner',
    })
    assert.deepEqual(editor.hiddenIds('role'), ['role_1'])
    assert.deepEqual(editor.hiddenIds('workflow'), [])
  })
})
