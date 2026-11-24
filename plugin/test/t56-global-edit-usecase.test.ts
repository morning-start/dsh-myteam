/**
 * t56：全局库直改用例（G2）—— `editGlobalDefinition` 的校验与作用域规则。
 *
 * 与 t55 的分工：t55 只测端口（写盘、审计、hash 冲突）；这里测**用例**：
 *   - 非法定义被拒，且**不落盘**（不能「校验失败但文件已经写了」）；
 *   - 蓝图/工作流引用必须能在**全局目录**里解析 —— 引用一个只存在于项目里的角色要拒；
 *   - 冲突检测（expectedHash 不符）在最前面，连校验都不做。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGlobalEditor, createGlobalPublisher, globalEntryFile } from '../src/infrastructure/global-library/write.ts'
import { editGlobalDefinition } from '../src/application/global-edit.ts'
import type { GlobalEntryRef, GlobalEntryReader } from '../src/application/global-edit.ts'
import type { PublicationKind } from '../src/contracts/publication.ts'
import { MyTeamError } from '../src/contracts/errors.ts'

const HUMAN = { kind: 'human', userId: 'owner', via: 'confirmation' } as const

function withRoot(body: (root: string, entries: GlobalEntryReader) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'myteam-global-edit62-'))
  try {
    // 一个只在内存里的「全局目录」读取器：测试自己声明有哪些全局角色/工作流。
    const store = new Map<PublicationKind, GlobalEntryRef[]>()
    const entries: GlobalEntryReader = {
      list: (kind) => store.get(kind) ?? [],
    }
    ;(globalThis as Record<string, unknown>).__decl = (kind: PublicationKind, list: GlobalEntryRef[]) =>
      store.set(kind, list)
    body(root, entries)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ROLE = (name: string, allow: string[]) => ({
  profile: { name, purpose: '实现', instructions: '按 AC', specialties: [] },
  capabilities: { tools: { allow, deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
})

function baseInput(overrides: Record<string, unknown>) {
  return {
    actor: HUMAN,
    kind: 'role' as PublicationKind,
    id: 'role_1',
    expectedHash: null,
    operationId: 'op_1',
    editedAt: '2026-01-01T00:00:00.000Z',
    editor: 'owner',
    ...overrides,
  }
}

test('全局角色直改：合法内容写进去，revision 变成 1（直改只写全局，不带项目 revision）', () => {
  withRoot((root, entries) => {
    const result = editGlobalDefinition(
      { editor: createGlobalEditor(root), globalEntries: entries },
      baseInput({ definition: ROLE('实现者', ['read']) }),
    )
    assert.equal(result.outcome, 'edited')
    assert.equal(result.revision, 1)
    assert.ok(existsSync(join(root, globalEntryFile('role', 'role_1'))))
  })
})

test('非法角色（profile 名称为空）被拒，且不落盘', () => {
  withRoot((root, entries) => {
    assert.throws(
      () => editGlobalDefinition(
        { editor: createGlobalEditor(root), globalEntries: entries },
        baseInput({ definition: ROLE('', ['read']) }),
      ),
      (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_PAYLOAD',
    )
    assert.equal(existsSync(join(root, globalEntryFile('role', 'role_1'))), false, '校验失败不能留文件')
  })
})

test('蓝图引用项目角色（不在全局目录）→ 拒绝，且不落盘', () => {
  withRoot((root, entries) => {
    ;(globalThis as Record<string, unknown>).__decl('role', []) // 全局目录里一个角色都没有
    ;(globalThis as Record<string, unknown>).__decl('workflow', [])
    const blueprint = {
      name: '两人小队',
      description: '',
      formation: [{ key: 'impl', roleId: 'project_only_role', count: 1, parentSlotKey: null }],
      workflows: [],
      defaults: {},
    }
    assert.throws(
      () => editGlobalDefinition(
        { editor: createGlobalEditor(root), globalEntries: entries },
        baseInput({ kind: 'blueprint', id: 'bp_1', definition: blueprint }),
      ),
      (error: unknown) => error instanceof MyTeamError
        && error.code === 'INVALID_PAYLOAD'
        && JSON.stringify((error as { details?: unknown }).details ?? {}).includes('角色不存在'),
    )
    assert.equal(existsSync(join(root, globalEntryFile('blueprint', 'bp_1'))), false, '引用解析失败不能留文件')
  })
})

test('蓝图引用全局角色 → 通过', () => {
  withRoot((root, entries) => {
    ;(globalThis as Record<string, unknown>).__decl('role', [{ kind: 'role', id: 'global_role', revision: 1 }])
    ;(globalThis as Record<string, unknown>).__decl('workflow', [])
    const blueprint = {
      name: '两人小队',
      description: '',
      formation: [{ key: 'impl', roleId: 'global_role', count: 1, parentSlotKey: null }],
      workflows: [],
      defaults: {},
    }
    const result = editGlobalDefinition(
      { editor: createGlobalEditor(root), globalEntries: entries },
      baseInput({ kind: 'blueprint', id: 'bp_1', definition: blueprint }),
    )
    assert.equal(result.outcome, 'edited')
    assert.ok(existsSync(join(root, globalEntryFile('blueprint', 'bp_1'))), '引用能解析就该写进去')
  })
})

test('工作流引用不在全局目录的角色 → 拒绝', () => {
  withRoot((root, entries) => {
    ;(globalThis as Record<string, unknown>).__decl('role', [])
    const workflow = {
      name: '交付流',
      description: '',
      templates: [
        {
          key: 'impl',
          title: '实现',
          description: '',
          acceptance: ['可验证'],
          requiredRoleId: 'missing_role',
          dependsOn: [],
          gate: { commands: [], requireEvidence: false, requireArtifacts: false },
          deliverable: null,
        },
      ],
      completion: { mode: 'all-tasks', requiredKeys: [] },
    }
    assert.throws(
      () => editGlobalDefinition(
        { editor: createGlobalEditor(root), globalEntries: entries },
        baseInput({ kind: 'workflow', id: 'wf_1', definition: workflow }),
      ),
      (error: unknown) => error instanceof MyTeamError && error.code === 'NOT_FOUND',
    )
  })
})

test('expectedHash 不符 → CONFLICT，且连校验都不做（坏内容也不会先报 INVALID_PAYLOAD）', () => {
  withRoot((root, entries) => {
    const editor = createGlobalEditor(root)
    // 先写一版，让磁盘上有文件
    editGlobalDefinition({ editor, globalEntries: entries }, baseInput({ definition: ROLE('实现者', ['read']) }))

    assert.throws(
      () => editGlobalDefinition(
        { editor, globalEntries: entries },
        baseInput({
          expectedHash: 'sha256:deadbeef',
          definition: ROLE('', ['read']), // 同时是坏内容
        }),
      ),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFLICT',
      '冲突要先于校验报出来',
    )
    const onDisk = JSON.parse(readFileSync(join(root, globalEntryFile('role', 'role_1')), 'utf8')) as { profile: { name: string } }
    assert.equal(onDisk.profile.name, '实现者', '冲突时文件不能被改')
  })
})
