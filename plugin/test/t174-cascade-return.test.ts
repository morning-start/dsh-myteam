/**
 * T174 · CHG-210 批 6.4b：**级联释放不能把任务留在原主人手里**。
 *
 * 缺陷现场：`releaseMember` 级联释放子成员时，任务留在 `in_progress`——原主人已经没了，
 * 票据还在，任务既跑不完也领不走（`canClaim` 的 active attempt 判定会挡住重新领取）。
 * 更早的版本连账本都记成 `running: 0`，所以「排空完成」是假的。
 *
 * 修法：释放前把在跑任务交还成 `task.paused`（不是直接回 ready——级联释放是「主人没了」，
 * 不是「主人想继续」；停在 paused 面板才显示得出「这个任务是被释放留下的」）。
 *
 * 本文件测纯函数 `pausedDraftsForRelease`（draft 由 host 在 rollback 块里统一提交）：
 *   ① 有在跑任务 → 生成一条 task.paused（带 attemptId + 可读理由）；
 *   ② 没任务 / 任务不在 in_progress / 成员不存在 → 空数组（不能凭空造事件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pausedDraftsForRelease } from '../src/core/service.ts'
import type { TeamProjection } from '../src/core/scheduler/state.ts'

function projWith(over: { memberTaskId?: string; task?: Record<string, unknown> }): TeamProjection {
  const tasks: Record<string, unknown> = {}
  if (over.task) tasks[over.task.id as string] = over.task
  return {
    teamId: 't1',
    members: { 'm1': { memberId: 'm1', currentTaskId: over.memberTaskId } },
    tasks,
  } as unknown as TeamProjection
}

const RUNNING = { id: 'task-1', state: 'in_progress', attemptId: 'at-1' }

test('t174-1: 成员有在跑任务 → 生成一条 task.paused（带票据与可读理由）', () => {
  const drafts = pausedDraftsForRelease(projWith({ memberTaskId: 'task-1', task: RUNNING }), 'm1', 'lead')
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].type, 'task.paused')
  assert.equal(drafts[0].actor, 'lead')
  assert.equal(drafts[0].payload.taskId, 'task-1')
  assert.equal(drafts[0].payload.attemptId, 'at-1', '必须带票据，否则 checkAttempt 会拒')
  assert.match(String(drafts[0].payload.reason), /cascade-release/, '理由要能看出是级联释放留下的')
})

test('t174-2: 成员没有在跑任务 → 空数组（不能凭空造事件）', () => {
  assert.deepEqual(pausedDraftsForRelease(projWith({}), 'm1', 'lead'), [])
})

test('t174-3: 任务不在 in_progress（如已到门禁）→ 空数组', () => {
  const drafts = pausedDraftsForRelease(projWith({ memberTaskId: 'task-1', task: { id: 'task-1', state: 'gate:review', attemptId: 'at-1' } }), 'm1', 'lead')
  assert.deepEqual(drafts, [], '门禁态的任务不该被暂停——它已经在等人裁决了')
})

test('t174-4: 成员不存在 / 任务已无票据 → 空数组', () => {
  assert.deepEqual(pausedDraftsForRelease(projWith({ memberTaskId: 'task-1', task: RUNNING }), 'm-ghost', 'lead'), [])
  const noAttempt = pausedDraftsForRelease(projWith({ memberTaskId: 'task-1', task: { id: 'task-1', state: 'in_progress' } }), 'm1', 'lead')
  assert.deepEqual(noAttempt, [], '没票据就没什么可撤的')
})
