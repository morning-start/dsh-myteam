/**
 * t51：面板写「移动任务」（L0-G5）。
 *
 * 为什么只做三个方向：设计稿的拖拽看起来能拖到任意列，但域里的状态机不是任意的 ——
 * 「完成」必须走门禁裁决（gateVerdict + 证据），拖过去就等于绕过门禁。所以这里只开
 * 三个合法方向：取消（→ cancelled）、重开（→ ready）、认领（→ claimed，要指定成员）；
 * 其它目标一律 INVALID_PAYLOAD 并说明原因，而不是偷偷改一个状态。
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
  appointMemberCommand,
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { applyDirectPanelWrite } from '../src/application/panel-writes.ts'
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

function seed(runtime: ProjectRuntime): { teamId: string; memberId: string; taskId: string } {
  initializeProject(runtime, { actor: HUMAN, name: '移动任务项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
  const team = createTeamCommand(runtime, { actor: HUMAN, name: '甲队', goal: 'g', captainSessionId: 'ses_a' })
  const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id
  const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_m1' })
  const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id
  const task = createTaskCommand(runtime, {
    actor: HUMAN,
    title: '可移动的任务',
    description: '',
    acceptance: ['可以取消'],
    ownerTeamId: teamId,
  })
  const taskId = (task.events[0]!.payload as { task: { id: string } }).task.id
  return { teamId, memberId, taskId }
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

test('移动任务：取消 → cancelled；重开 → ready；都落成事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-task-move-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { taskId } = seed(runtime)
      const cancelled = applyDirectPanelWrite(runtime, 'taskMove', {
        confirm: true,
        params: { taskId, targetStatus: 'cancelled', reason: '用户取消' },
      })
      assert.deepEqual(cancelled.committed, { taskId, status: 'cancelled' })
      assert.equal(runtime.state.tasks.get(taskId)!.status, 'cancelled')

      const reopened = applyDirectPanelWrite(runtime, 'taskMove', {
        confirm: true,
        params: { taskId, targetStatus: 'ready', reason: '重新开工' },
      })
      assert.deepEqual(reopened.committed, { taskId, status: 'ready' })
      assert.equal(runtime.state.tasks.get(taskId)!.status, 'ready')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('移动任务：认领要成员；缺 memberId 拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-task-move-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { taskId, memberId } = seed(runtime)
      expectCode(
        () => applyDirectPanelWrite(runtime, 'taskMove', { confirm: true, params: { taskId, targetStatus: 'claimed' } }),
        'INVALID_PAYLOAD',
      )
      const claimed = applyDirectPanelWrite(runtime, 'taskMove', {
        confirm: true,
        params: { taskId, targetStatus: 'claimed', memberId },
      })
      assert.deepEqual(claimed.committed, { taskId, status: 'claimed', memberId })
      assert.equal(runtime.state.tasks.get(taskId)!.status, 'claimed')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('移动任务：done 与未知目标都拒绝（完成必须走门禁裁决）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-task-move-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { taskId } = seed(runtime)
      expectCode(
        () => applyDirectPanelWrite(runtime, 'taskMove', { confirm: true, params: { taskId, targetStatus: 'done' } }),
        'INVALID_PAYLOAD',
      )
      expectCode(
        () => applyDirectPanelWrite(runtime, 'taskMove', { confirm: true, params: { taskId, targetStatus: 'blocked' } }),
        'INVALID_PAYLOAD',
      )
      assert.equal(runtime.state.tasks.get(taskId)!.status, 'ready', '被拒绝的移动不能改状态')
      expectCode(
        () => applyDirectPanelWrite(runtime, 'taskMove', { confirm: false, params: { taskId, targetStatus: 'cancelled' } }),
        'INVALID_PAYLOAD',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})