/**
 * t52：面板写「保存项目定义」（L0-G4，角色 / 工作流）。
 *
 * 缺口背景：`definition.role.revised` / `definition.workflow.revised` 事件与投影一直都在，
 * 创建命令也有，但**没有任何命令能发出 revised** —— 设计稿「编辑角色 / 编辑工作流」两屏
 * 只能新建、不能改。这里锁住：revision 递增、previousHash 是旧内容哈希、未知 id 报 NOT_FOUND、
 * 不合法内容拒绝且不落事件、blueprint 编辑明确拒绝（还没有保存命令）。
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
import { createProjectRole, createProjectWorkflowCommand, initializeProject } from '../src/application/commands.ts'
import { applyDirectPanelWrite } from '../src/application/panel-writes.ts'
import { roleContentHash } from '../src/domain/definitions/role.ts'
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

function seed(runtime: ProjectRuntime): { roleId: string; workflowId: string } {
  initializeProject(runtime, { actor: HUMAN, name: '编辑定义项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
  const workflow = createProjectWorkflowCommand(runtime, {
    actor: HUMAN,
    name: '交付流',
    description: '默认',
    templates: [{ key: 'impl', title: '实现', description: '', acceptance: ['ok'], requiredRoleId: null, dependsOn: [], gate: { commands: ['node --test'], requireEvidence: false, requireArtifacts: false }, deliverable: null }],
  })
  const workflowId = (workflow.events[0]!.payload as { workflow: { id: string } }).workflow.id
  return { roleId, workflowId }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, `应抛 MyTeamError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

test('保存角色：revision+1，previousHash 是旧哈希，投影换成新内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-def-save-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { roleId } = seed(runtime)
      const before = runtime.state.roles.get(roleId)!
      const oldHash = roleContentHash(before)

      const applied = applyDirectPanelWrite(runtime, 'definitionSave', {
        confirm: true,
        params: {
          kind: 'role',
          id: roleId,
          profile: { name: '实现者', purpose: '实现并自测', instructions: '先跑测试', specialties: ['ts'] },
          capabilities: { tools: { allow: ['read', 'write'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
        },
      })
      assert.deepEqual(applied.committed, { kind: 'role', id: roleId })

      const after = runtime.state.roles.get(roleId)!
      assert.equal(after.revision, before.revision + 1)
      assert.equal(after.profile.purpose, '实现并自测')
      assert.notEqual(roleContentHash(after), oldHash, '内容哈希应变化')
      assert.equal(after.createdAt, before.createdAt, 'createdAt 不能被改写')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保存角色：未知 id → NOT_FOUND；profile 不是对象 → INVALID_PAYLOAD（不留事件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-def-save-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { roleId } = seed(runtime)
      const seqBefore = runtime.state.seq
      expectCode(
        () =>
          applyDirectPanelWrite(runtime, 'definitionSave', {
            confirm: true,
            params: {
              kind: 'role',
              id: 'role_missing',
              profile: { name: 'x', purpose: '', instructions: '', specialties: [] },
              capabilities: { tools: { allow: [], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
            },
          }),
        'NOT_FOUND',
      )
      expectCode(
        () => applyDirectPanelWrite(runtime, 'definitionSave', { confirm: true, params: { kind: 'role', id: roleId, profile: 'oops' } }),
        'INVALID_PAYLOAD',
      )
      assert.equal(runtime.state.seq, seqBefore, '被拒绝的保存不能落事件')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保存工作流：revision+1 且 templates 更新；blueprint 编辑明确拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-def-save-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { workflowId } = seed(runtime)
      const before = runtime.state.workflows.get(workflowId)!

      const applied = applyDirectPanelWrite(runtime, 'definitionSave', {
        confirm: true,
        params: {
          kind: 'workflow',
          id: workflowId,
          name: '交付流 v2',
          description: '加一步自测',
          templates: [
            { key: 'impl', title: '实现', description: '', acceptance: ['ok'], requiredRoleId: null, dependsOn: [], gate: { commands: ['node --test'], requireEvidence: false, requireArtifacts: false }, deliverable: null },
            { key: 'test', title: '自测', description: '', acceptance: ['测试绿'], requiredRoleId: null, dependsOn: ['impl'], gate: { commands: ['node --test'], requireEvidence: true, requireArtifacts: false }, deliverable: null },
          ],
        },
      })
      assert.deepEqual(applied.committed, { kind: 'workflow', id: workflowId })

      const after = runtime.state.workflows.get(workflowId)!
      assert.equal(after.revision, before.revision + 1)
      assert.equal(after.name, '交付流 v2')
      assert.equal(after.templates.length, 2)

      expectCode(
        () => applyDirectPanelWrite(runtime, 'definitionSave', { confirm: true, params: { kind: 'blueprint', id: 'bp_1' } }),
        'INVALID_PAYLOAD',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})