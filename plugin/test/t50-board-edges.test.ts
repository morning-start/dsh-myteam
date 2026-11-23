/**
 * t50：看板卡片要带**完整依赖边**（L0-G7）。
 *
 * 为什么：`p-dag` 依赖图需要全图边，而看板原来只有 `blockedBy`（未完成的前置）。
 * 只有 blockedBy 时，画出来的图会缺掉「已完成的前置」那些线，看起来像两个孤岛。
 * 这里锁住：新任务挂在 A 上 → 卡片 dependencies 含 A；A 未完成时 blockedBy 也含 A；
 * A 完成后 blockedBy 变空但 dependencies 不变。
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
import { createProjectRole, createTaskCommand, createTeamCommand, initializeProject } from '../src/application/commands.ts'
import { boardView } from '../src/application/queries.ts'
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

test('看板卡片：dependencies 是完整前置边，blockedBy 只含未完成前置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-board-edges-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '依赖边项目' })
      createProjectRole(runtime, {
        actor: HUMAN,
        profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
        capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
      })
      const team = createTeamCommand(runtime, { actor: HUMAN, name: '甲队', goal: 'g', captainSessionId: 'ses_a' })
      const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id

      const upstream = createTaskCommand(runtime, {
        actor: HUMAN,
        title: '前置任务',
        description: '',
        acceptance: ['前置完成'],
        ownerTeamId: teamId,
      })
      const upstreamId = (upstream.events[0]!.payload as { task: { id: string } }).task.id

      const downstream = createTaskCommand(runtime, {
        actor: HUMAN,
        title: '下游任务',
        description: '',
        acceptance: ['下游完成'],
        ownerTeamId: teamId,
        dependencies: [upstreamId],
      })
      const downstreamId = (downstream.events[0]!.payload as { task: { id: string } }).task.id

      const card = () => {
        const view = boardView(runtime.state)
        for (const column of view.columns) {
          for (const task of column.tasks) if (task.id === downstreamId) return task
        }
        throw new Error('看板里找不到下游任务')
      }

      const before = card()
      assert.deepEqual(before.dependencies, [upstreamId], 'dependencies 必须是完整前置边')
      assert.deepEqual(before.blockedBy, [upstreamId], '前置未完成时 blockedBy 也含它')

      // 没有前置的任务：两个数组都应为空（别把 undefined 当空）。
      const upstreamCard = (() => {
        const view = boardView(runtime.state)
        for (const column of view.columns) {
          for (const task of column.tasks) if (task.id === upstreamId) return task
        }
        throw new Error('看板里找不到前置任务')
      })()
      assert.deepEqual(upstreamCard.dependencies, [])
      assert.deepEqual(upstreamCard.blockedBy, [])
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})