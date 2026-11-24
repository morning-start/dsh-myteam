/**
 * t55：全局库直改端口（G1）—— `createGlobalEditor` 的写盘、审计与冲突检测。
 *
 * 背景：全局库原来唯一的写通道是「发布」（项目副本 → 全局库）。I 组三页
 * （`g-role-edit` / `g-workflow-edit` / `g-blueprint-edit`）要的是「直接在全局库上改」，
 * 这条路不存在。方案见 docs/decisions/全局库编辑写通道.md（已拍板：token 确认 / 仅人类 /
 * 冲突拒绝不合并）。
 *
 * 这一层只测**端口**，不测用例与面板：
 *   1. 新建：文件写进去，审计里有 definition.edit 且 previousHash=null；
 *   2. 覆盖：previousHash 是旧文件 hash，globalHash 变化；
 *   3. 冲突：expectedHash 与磁盘不一致 → CONFLICT，且**文件与审计都不动**；
 *   4. readFileHash：不存在返回 null，存在返回真实 hash；
 *   5. 与发布共用审计文件：publish 与 edit 混写后，两种 action 都在同一个 jsonl 里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGlobalEditor, createGlobalPublisher, globalEntryFile } from '../src/infrastructure/global-library/write.ts'
import { MyTeamError } from '../src/contracts/errors.ts'

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'myteam-global-edit-'))
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ROLE = (name: string, revision: number) => ({
  id: 'role_1',
  revision,
  profile: { name, purpose: '实现', instructions: '按 AC 做', specialties: [] },
  capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

function readAudit(root: string): Array<Record<string, unknown>> {
  const file = join(root, 'audit', 'global-operations.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('readFileHash：不存在返回 null，写了之后返回真实 hash', () => {
  withRoot((root) => {
    const editor = createGlobalEditor(root)
    assert.equal(editor.readFileHash('role', 'role_1'), null)

    editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('实现者', 1),
      revision: 1,
      operationId: 'op_1',
      expectedHash: null,
      editedAt: '2026-01-01T00:00:00.000Z',
      editor: 'owner',
    })
    const hash = editor.readFileHash('role', 'role_1')
    assert.ok(typeof hash === 'string' && hash.startsWith('sha256:'), '写完之后应能读到 hash')
  })
})

test('新建：文件落盘、审计 action=definition.edit 且 previousHash=null', () => {
  withRoot((root) => {
    const editor = createGlobalEditor(root)
    const result = editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('实现者', 1),
      revision: 1,
      operationId: 'op_new',
      expectedHash: null,
      editedAt: '2026-01-01T00:00:00.000Z',
      editor: 'owner',
    })

    assert.equal(result.file, globalEntryFile('role', 'role_1'))
    assert.equal(result.previousHash, null)
    assert.ok(existsSync(join(root, globalEntryFile('role', 'role_1'))), '文件应真的写进去')

    const audit = readAudit(root)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.action, 'definition.edit')
    assert.equal(audit[0]!.previousHash, null)
    assert.equal(audit[0]!.editor, 'owner')
    assert.equal(audit[0]!.globalHash, result.globalHash)
  })
})

test('覆盖：previousHash 是旧文件 hash，globalHash 随内容变化', () => {
  withRoot((root) => {
    const editor = createGlobalEditor(root)
    const first = editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('实现者', 1),
      revision: 1,
      operationId: 'op_1',
      expectedHash: null,
      editedAt: '2026-01-01T00:00:00.000Z',
      editor: 'owner',
    })

    const second = editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('实现者（改）', 2),
      revision: 2,
      operationId: 'op_2',
      expectedHash: first.globalHash,
      editedAt: '2026-01-02T00:00:00.000Z',
      editor: 'owner',
    })

    assert.equal(second.previousHash, first.globalHash, 'previousHash 必须是旧文件 hash')
    assert.notEqual(second.globalHash, first.globalHash, '内容变了 hash 必须变')

    const audit = readAudit(root)
    assert.equal(audit.length, 2)
    assert.equal(audit[1]!.previousHash, first.globalHash)
  })
})

test('冲突：expectedHash 与磁盘不一致 → CONFLICT，文件与审计都不动', () => {
  withRoot((root) => {
    const editor = createGlobalEditor(root)
    editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('实现者', 1),
      revision: 1,
      operationId: 'op_1',
      expectedHash: null,
      editedAt: '2026-01-01T00:00:00.000Z',
      editor: 'owner',
    })
    const before = readFileSync(join(root, globalEntryFile('role', 'role_1')), 'utf8')
    const auditBefore = readAudit(root).length

    assert.throws(
      () => editor.writeFile({
        kind: 'role',
        id: 'role_1',
        definition: ROLE('被别人改过', 9),
        revision: 9,
        operationId: 'op_conflict',
        expectedHash: 'sha256:deadbeefdeadbeef', // 不是磁盘上的 hash
        editedAt: '2026-01-03T00:00:00.000Z',
        editor: 'owner',
      }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFLICT',
    )

    assert.equal(readFileSync(join(root, globalEntryFile('role', 'role_1')), 'utf8'), before, '冲突时文件不能被改')
    assert.equal(readAudit(root).length, auditBefore, '冲突时不能写审计')
  })
})

test('发布与直改共用同一个审计文件：两种 action 都在 jsonl 里', () => {
  withRoot((root) => {
    const publisher = createGlobalPublisher(root)
    publisher.publish({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('发布进来的', 1),
      operationId: 'op_pub',
      revision: 1,
      sourceProjectId: 'project_1',
      publishedAt: '2026-01-01T00:00:00.000Z',
    })

    const editor = createGlobalEditor(root)
    const hash = editor.readFileHash('role', 'role_1')
    assert.ok(hash !== null, '发布过的文件应该能读到')
    editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: ROLE('直改后的', 2),
      revision: 2,
      operationId: 'op_edit',
      expectedHash: hash!,
      editedAt: '2026-01-02T00:00:00.000Z',
      editor: 'owner',
    })

    const actions = readAudit(root).map((entry) => entry.action)
    assert.deepEqual(actions, ['definition.publish', 'definition.edit'], '两条路写进同一个审计文件，各自 action 不同')
    assert.equal(readdirSync(join(root, 'audit')).length, 1, '只该有一个审计文件，不允许分叉')
  })
})

test('蓝图目录：直改写进 blueprints/，不串到 roles/', () => {
  withRoot((root) => {
    const editor = createGlobalEditor(root)
    const result = editor.writeFile({
      kind: 'blueprint',
      id: 'bp_1',
      definition: { id: 'bp_1', revision: 1, name: '两人小队', description: '', formation: [], workflows: [], defaults: {} },
      revision: 1,
      operationId: 'op_bp',
      expectedHash: null,
      editedAt: '2026-01-01T00:00:00.000Z',
      editor: 'owner',
    })
    assert.equal(result.file, 'blueprints/bp_1.json')
    assert.ok(existsSync(join(root, 'blueprints', 'bp_1.json')))
    assert.equal(existsSync(join(root, 'roles', 'bp_1.json')), false)
  })
})
