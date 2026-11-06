import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wakeDecisionsFor, changeSince } from '../src/core/scheduler/wake.ts'
import { checkArchiveGate, recoveryAction, recoveryEventFor } from '../src/core/scheduler/recovery.ts'

test('T10: only four causal wakes fire; others silent (FR-4.4/NFR-7.1)', () => {
  // assign 唤醒目标成员
  assert.deepEqual(
    wakeDecisionsFor({ type: 'task.assigned', payload: { memberId: 'm1' } }),
    [{ memberId: 'm1', cause: 'assign' }],
  )
  // message 唤醒收件人
  assert.deepEqual(
    wakeDecisionsFor({ type: 'message.sent', payload: { to: 'm2' } }),
    [{ memberId: 'm2', cause: 'message' }],
  )
  // inbox 消息不唤醒成员
  assert.deepEqual(wakeDecisionsFor({ type: 'message.sent', payload: { to: 'inbox' } }), [])
  // revoke 唤醒被撤销者（需 prevAssignee）
  assert.deepEqual(
    wakeDecisionsFor({ type: 'task.attempt.revoked', payload: { taskId: 'k', attemptId: 'a', prevAssignee: 'm3' } }),
    [{ memberId: 'm3', cause: 'revoke' }],
  )
  assert.deepEqual(wakeDecisionsFor({ type: 'task.attempt.revoked', payload: { taskId: 'k', attemptId: 'a' } }), [])
  // restore 唤醒本人
  assert.deepEqual(wakeDecisionsFor({ type: 'member.restored', payload: { memberId: 'm4' } }), [{ memberId: 'm4', cause: 'resume' }])
  // claim/progress/gate/completed 不唤醒任何人（零请求）
  for (const type of ['task.claimed', 'task.progress', 'task.gate.result', 'task.completed', 'task.evidence']) {
    assert.deepEqual(wakeDecisionsFor({ type, payload: { memberId: 'm1', taskId: 'k' } }), [], `${type} must not wake`)
  }
})

test('T10: changeSince returns failure hint without body (NFR-7.7)', () => {
  const events = [
    { seq: 1, type: 'task.created', payload: { taskId: 'k1' } },
    { seq: 2, type: 'task.progress', payload: { taskId: 'k1' } },
    { seq: 3, type: 'task.progress', payload: { taskId: 'k2' } },
    { seq: 4, type: 'task.escalated', payload: { taskId: 'k1' } },
  ]
  assert.deepEqual(changeSince(events, 0), { changed: true, cause: 'progress' })
  assert.deepEqual(changeSince(events, 1, 'k1'), { changed: true, cause: 'progress' })
  assert.deepEqual(changeSince(events, 2, 'k1'), { changed: true, cause: 'escalate' })
  assert.deepEqual(changeSince(events, 4, 'k1'), { changed: false })
  // 无任务过滤：任意相关事件触发
  assert.equal(changeSince(events, 3).changed, true)
})

test('T8: archive gate checks deliverable existence (FR-10.4, scene 12)', () => {
  const spec = { path: 'docs/x.md' }
  const pass = checkArchiveGate(spec, [{ path: 'docs/x.md' }], (p) => p === 'docs/x.md')
  assert.equal(pass.pass, true)
  const fail = checkArchiveGate(spec, [], () => false)
  assert.equal(fail.pass, false)
  assert.ok(fail.reason!.includes('not found on disk'))
  const noSpec = checkArchiveGate(undefined, [])
  assert.equal(noSpec.pass, false)
  assert.ok(noSpec.reason!.includes('deliverableSpec'))
})

test('T16: recovery decision table picks one path in priority order (FR-4.6)', () => {
  // 成员活着 → 原地重激活
  assert.deepEqual(
    recoveryAction({ state: 'in_progress', attemptId: 'a', assignee: 'm1', memberLive: true }),
    { kind: 're-activate-in-place' },
  )
  // 成员不在 → 新 attempt 重试
  assert.deepEqual(
    recoveryAction({ state: 'in_progress', attemptId: 'a', assignee: 'm1', memberLive: false }),
    { kind: 're-activate-new-attempt' },
  )
  // 无 attempt → blocked
  assert.deepEqual(recoveryAction({ state: 'in_progress', memberLive: false }), { kind: 'to-blocked' })
  // ready/backlog/re-scoping → noop
  assert.deepEqual(recoveryAction({ state: 'ready', memberLive: false }), { kind: 'noop' })
  assert.deepEqual(recoveryAction({ state: 're-scoping', memberLive: false }), { kind: 'noop' })
  // 终态 → noop
  assert.deepEqual(recoveryAction({ state: 'done', memberLive: false }), { kind: 'noop' })
  assert.deepEqual(recoveryAction({ state: 'failed', memberLive: false }), { kind: 'noop' })
  // gate 态成员不在 → 新 attempt
  assert.deepEqual(recoveryAction({ state: 'gate:review', attemptId: 'a', memberLive: false }), { kind: 're-activate-new-attempt' })
  // 恢复事件：新 attempt 重试 → revoke 事件；blocked → rescoped 标记
  assert.equal(recoveryEventFor({ kind: 're-activate-new-attempt' }, 'k1')?.type, 'task.attempt.revoked')
  assert.equal(recoveryEventFor({ kind: 'noop' }, 'k1'), undefined)
})
