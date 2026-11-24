/**
 * t60：待你确认（`p-approval`）的读面 —— 只报**确实在等人类**的东西。
 *
 * 这一页设计稿分待确认 / 已处理 / 已拒绝，但域里能撑起它的只有两类：
 *   1. 任务停在 `review`（等人下门禁结论）；
 *   2. `definition.publication.requested` 落了但还没 `outcome`。
 *
 * 另外两类（计划批准、队长接管）**画不出来**，`unsupported` 里如实标出来 ——
 * 这条测试同时锁住「不许用假数据凑数」：界面必须能看到这两类未覆盖。
 *
 * 还锁一条投影行为：`outcome` 一到，待确认列表里就必须没有它了（成功失败都算已处理）。
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
import { createTeamCommand, initializeProject } from '../src/application/commands.ts'
import { pendingApprovalsView } from '../src/application/queries.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
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

test('空项目：待确认与已处理都是空的，四类都不再标未覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t60-empty-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '待确认测试' })
      const view = pendingApprovalsView(runtime.state)
      assert.deepEqual(view.pending, [])
      assert.deepEqual(view.decided, [])
      assert.equal(view.counts.pending, 0)
      assert.equal(view.counts.decided, 0)
      // 四类现在都接通了（队长接管 t61、计划批准 t65/t67），不该再有任何「假装有」的标记。
      assert.equal(view.unsupported.planApproval, false, '计划批准已接通（见 t65/t67）')
      assert.equal(view.unsupported.captainTakeover, false, '队长接管已接通（见 t61）')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('待确认的全局发布：requested 之后出现在列表里，outcome 之后消失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t60-publish-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '待确认测试' })
      // 直接落两条事件模拟发布流程：requested → 在列表；outcome → 消失。
      runtime.commit([
        {
          type: 'definition.publication.requested',
          actor: HUMAN,
          entity: { kind: 'role-definition', id: 'role_1' },
          payload: { operationId: 'op_pub_1', target: 'roles/role_1.json', requestedBy: 'human:user-1' },
        },
      ])
      let view = pendingApprovalsView(runtime.state)
      assert.equal(view.pending.length, 1, 'requested 之后应有一条待确认')
      assert.equal(view.pending[0]!.kind, 'publish')
      assert.equal(view.pending[0]!.id, 'op_pub_1')
      assert.equal(view.pending[0]!.title, 'roles/role_1.json')
      assert.equal(view.pending[0]!.by, 'human:user-1')

      runtime.commit([
        {
          type: 'definition.publication.outcome',
          actor: HUMAN,
          entity: { kind: 'role-definition', id: 'role_1' },
          payload: { outcome: 'failed', globalHash: null, operationId: 'op_pub_1' },
        },
      ])
      view = pendingApprovalsView(runtime.state)
      assert.equal(view.pending.length, 0, 'outcome 一到就不该再算待确认（失败也算已处理）')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('待确认的门禁：任务停在 review 时列出；下过裁决后进已处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t60-gate-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '待确认测试' })
      createTeamCommand(runtime, {
        actor: HUMAN,
        name: '甲队',
        goal: '测试',
        blueprint: null,
        captainSessionId: null,
      })
      // 造一个直接停在 review 的任务：用事件最省事，避免依赖完整门禁流程。
      runtime.commit([
        {
          type: 'task.created',
          actor: HUMAN,
          entity: { kind: 'task', id: 'task_r1' },
          payload: {
            task: {
              id: 'task_r1',
              title: '评审中的任务',
              description: '',
              acceptance: ['可验证'],
              status: 'review',
              ownerTeamId: [...runtime.state.teams.keys()][0] ?? null,
              collaborators: [],
              dependencies: [],
              runId: null,
              attemptId: 'attempt_1',
              gate: null,
              deliverable: null,
              revision: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        },
      ])
      let view = pendingApprovalsView(runtime.state)
      const gate = view.pending.find((item) => item.kind === 'gate')
      assert.ok(gate !== undefined, 'review 的任务应出现在待确认里')
      assert.equal(gate!.title, '评审中的任务')
      assert.equal(gate!.detail, '甲队', '要带团队名，便于人判断')

      // 落一条裁决 → 进已处理，待确认里消失
      runtime.commit([
        {
          type: 'task.verdict',
          actor: HUMAN,
          entity: { kind: 'task', id: 'task_r1' },
          payload: {
            verdict: {
              id: 'verdict_1',
              taskId: 'task_r1',
              attemptId: 'attempt_1',
              outcome: 'rejected',
              checks: [],
              evidence: [],
              decidedAt: NOW,
            },
          },
        },
      ])
      view = pendingApprovalsView(runtime.state)
      assert.equal(view.pending.filter((item) => item.kind === 'gate').length, 0, '裁决后不该还在待确认')
      const decided = view.decided.find((item) => item.kind === 'gate')
      assert.ok(decided !== undefined, '裁决后应进已处理')
      assert.equal(decided!.outcome, 'rejected', '拒绝也是一种已处理结果')
      assert.equal(decided!.title, '评审中的任务')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
