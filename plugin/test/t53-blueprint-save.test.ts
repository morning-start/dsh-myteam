/**
 * t53：项目蓝图的创建与修订（L0-G4b）。
 *
 * 缺口背景：`definition.blueprint.created/revised` 事件、投影、panel 的
 * `definitions` 读面（`kind: 'blueprint'` + `detail`）全都存在，但**一直没有命令能发出它**——
 * 所以「从蓝图建团队」只有内置蓝图可用，人类既建不了也改不了自己的蓝图，
 * 设计稿 `g-blueprint-edit` 因此点不动。这里锁住三件事：
 *
 *   1. 建蓝图要过引用校验（角色/工作流必须存在、队形不能成环、数量必须为正）；
 *   2. 修订时 revision 递增、`previousHash` 是**旧内容**的哈希；
 *   3. 未知 id 报 NOT_FOUND，不合法内容拒绝且不落事件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import {
  createProjectBlueprint,
  createProjectRole,
  createProjectWorkflowCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { applyDirectPanelWrite } from '../src/application/panel-writes.ts'
import { blueprintContentHash } from '../src/domain/definitions/blueprint.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  const manifest = ensureProjectManifest(dir, { projectId: newId('project'), createdAt: NOW })
  return ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(dir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(dir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
}

function withRuntime(body: (runtime: ProjectRuntime) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t53-'))
  try {
    body(openRuntime(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(runtime: ProjectRuntime): { roleId: string; workflowId: string } {
  initializeProject(runtime, { actor: HUMAN, name: '蓝图项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
  const workflow = createProjectWorkflowCommand(runtime, {
    actor: HUMAN,
    name: '交付流',
    description: '',
    templates: [
      {
        key: 'impl',
        title: '实现',
        description: '',
        acceptance: ['可验证'],
        requiredRoleId: null,
        dependsOn: [],
        gate: { commands: ['node --test'], requireEvidence: false, requireArtifacts: false },
        deliverable: null,
      },
    ],
  })
  const workflowId = (workflow.events[0]!.payload as { workflow: { id: string } }).workflow.id
  return { roleId, workflowId }
}

test('建蓝图：队形引用已存在的角色与工作流 → 落 definition.blueprint.created', () => {
  withRuntime((runtime) => {
    const { roleId, workflowId } = seed(runtime)
    const result = createProjectBlueprint(runtime, {
      actor: HUMAN,
      name: '两人小队',
      description: '一个实现者 + 一个审查者',
      formation: [
        { key: 'impl', roleId, count: 1, parentSlotKey: null },
        { key: 'review', roleId, count: 1, parentSlotKey: 'impl' },
      ],
      workflows: [workflowId],
      defaults: {},
    })

    assert.equal(result.events.length, 1)
    assert.equal(result.events[0]!.type, 'definition.blueprint.created')
    const payload = result.events[0]!.payload as { blueprint: { id: string; revision: number; name: string } }
    assert.equal(payload.blueprint.revision, 1)
    assert.equal(payload.blueprint.name, '两人小队')
    assert.ok(runtime.state.blueprints.has(payload.blueprint.id), '投影里应能查到这张蓝图')
  })
})

test('建蓝图：引用不存在的角色 → 拒绝，且不落事件', () => {
  withRuntime((runtime) => {
    const { workflowId } = seed(runtime)
    const before = runtime.state.seq
    assert.throws(
      () => createProjectBlueprint(runtime, {
        actor: HUMAN,
        name: '坏蓝图',
        description: '',
        formation: [{ key: 'ghost', roleId: 'role_not_exist', count: 1, parentSlotKey: null }],
        workflows: [workflowId],
        defaults: {},
      }),
      (error: unknown) => error instanceof MyTeamError
        && error.code === 'INVALID_PAYLOAD'
        && /角色不存在/.test(JSON.stringify((error as { details?: unknown }).details ?? {})),
    )
    assert.equal(runtime.state.seq, before, '被拒绝的请求不能落事件')
  })
})

test('建蓝图：队形父子成环 → 拒绝', () => {
  withRuntime((runtime) => {
    const { roleId, workflowId } = seed(runtime)
    assert.throws(
      () => createProjectBlueprint(runtime, {
        actor: HUMAN,
        name: '环形蓝图',
        description: '',
        formation: [
          { key: 'a', roleId, count: 1, parentSlotKey: 'b' },
          { key: 'b', roleId, count: 1, parentSlotKey: 'a' },
        ],
        workflows: [workflowId],
        defaults: {},
      }),
      (error: unknown) => error instanceof MyTeamError
        && error.code === 'INVALID_PAYLOAD'
        && /环/.test(JSON.stringify((error as { details?: unknown }).details ?? {})),
    )
  })
})

test('修订蓝图：revision 递增，previousHash 是旧内容的哈希', () => {
  withRuntime((runtime) => {
    const { roleId, workflowId } = seed(runtime)
    const created = createProjectBlueprint(runtime, {
      actor: HUMAN,
      name: '两人小队',
      description: '第一版',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
      workflows: [workflowId],
      defaults: {},
    })
    const blueprintId = (created.events[0]!.payload as { blueprint: { id: string } }).blueprint.id
    const before = runtime.state.blueprints.get(blueprintId)
    assert.ok(before !== undefined)

    const saved = applyDirectPanelWrite(runtime, 'definitionSave', {
      confirm: true,
      params: {
        kind: 'blueprint',
        id: blueprintId,
        name: '三人小队',
        description: '第二版',
        formation: [
          { key: 'impl', roleId, count: 2, parentSlotKey: null },
          { key: 'review', roleId, count: 1, parentSlotKey: 'impl' },
        ],
        workflows: [workflowId],
      },
    })

    assert.equal(saved.method, 'definitionSave')
    const after = runtime.state.blueprints.get(blueprintId)
    assert.ok(after !== undefined)
    assert.equal(after!.revision, 2)
    assert.equal(after!.name, '三人小队')

    const events = runtime.readEvents()
    assert.ok(events.length > 0)
    const last = events[events.length - 1]!
    assert.equal(last.type, 'definition.blueprint.revised')
    const payload = last.payload as { previousHash: string }
    assert.equal(payload.previousHash, blueprintContentHash(before!), 'previousHash 必须是旧内容哈希')
  })
})

test('修订蓝图：未知 id → NOT_FOUND；角色/工作流仍然必须带 id', () => {
  withRuntime((runtime) => {
    seed(runtime)
    assert.throws(
      () => applyDirectPanelWrite(runtime, 'definitionSave', {
        confirm: true,
        params: { kind: 'blueprint', id: 'bp_missing', name: 'x', description: '', formation: [], workflows: [] },
      }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'NOT_FOUND',
    )
    assert.throws(
      () => applyDirectPanelWrite(runtime, 'definitionSave', {
        confirm: true,
        params: { kind: 'role', profile: { name: 'x' }, capabilities: {} },
      }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_PAYLOAD',
      '角色保存仍然要求 id',
    )
  })
})

test('面板建蓝图：不带 id 视为新建（返回新 id）', () => {
  withRuntime((runtime) => {
    const { roleId, workflowId } = seed(runtime)
    const result = applyDirectPanelWrite(runtime, 'definitionSave', {
      confirm: true,
      params: {
        kind: 'blueprint',
        name: '面板建的蓝图',
        description: '',
        formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
        workflows: [workflowId],
      },
    })
    const committed = result.committed as { id?: string } | undefined
    assert.ok(typeof committed?.id === 'string' && committed.id.length > 0, '要回新蓝图的 id')
    assert.ok(runtime.state.blueprints.has(committed!.id!), '投影里应能查到它')
  })
})
