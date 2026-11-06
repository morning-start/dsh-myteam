import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'
import { validatePlan } from '../src/core/scheduler/state.ts'

let seq = 0
function ev(type: string, payload: Record<string, unknown>, ts = 1000): LedgerEvent {
  return { seq: seq++, ts, actor: 'test', type: type as LedgerEvent['type'], payload }
}

function taskInput(over: Record<string, unknown> = {}) {
  return {
    title: 't', description: 'd', acceptanceCriteria: ['ac'],
    deliverableSpec: { path: 'docs/x.md' }, deps: [],
    requiredRole: 'dev', priority: 'P2', gateChain: ['review', 'archive'],
    ...over,
  }
}

test('T3 fold: full happy path — create → claim → evidence → complete → gates pass → done', () => {
  seq = 0
  const events = [
    ev('team.created', { teamId: 't1', name: 'n', goal: 'g' }),
    ev('rules.version.adopted', { version: 1 }),
    ev('plan.approved', { teamId: 't1', planId: 'p1' }),
    ev('member.spawned', { teamId: 't1', memberId: 'm1', roleId: 'dev', sessionId: 's1', status: 'ok' }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    // backlog → ready 由调度层推导（deps 全 done）——fold 不承载，工具层创建后直接 ready 的场景：
    ev('task.claimed', { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' }),
    ev('task.evidence', { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { kind: 'na', na: { reason: 'doc' } } }),
    ev('task.completed', { teamId: 't1', taskId: 'k1', attemptId: 'a1' }),
    ev('task.gate.result', { teamId: 't1', taskId: 'k1', gate: 'review', verdict: 'pass' }),
    ev('task.deliverable', { teamId: 't1', taskId: 'k1', path: 'docs/x.md' }),
    ev('task.gate.result', { teamId: 't1', taskId: 'k1', gate: 'archive', verdict: 'pass' }),
  ]
  const proj = foldEvents('t1', events)
  assert.equal(proj.state, 'active')
  const t = proj.tasks['k1']
  assert.equal(t.state, 'done')
  assert.equal(t.attemptId, 'a1')
  assert.equal(t.evidenceRefs.length, 1)
  assert.equal(t.deliverables.length, 1)
  assert.equal(t.gateVerdicts['review'], 'pass')
  assert.equal(t.gateVerdicts['archive'], 'pass')
  assert.equal(proj.members['m1'].currentTaskId, undefined) // 被 revoke 清理或 task 完成不影响（完成态成员释放走 revoke）
})

test('T3 fold: escalate → re-scoping with attempt revoked + inbox entry (FR-11.7, scene 17)', () => {
  seq = 0
  const events = [
    ev('rules.version.adopted', { version: 1 }),
    ev('member.spawned', { teamId: 't1', memberId: 'm1', roleId: 'dev', sessionId: 's1', status: 'ok' }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    ev('task.claimed', { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' }),
    ev('task.escalated', { teamId: 't1', taskId: 'k1', attemptId: 'a1', reason: 'too hard', count: 1 }),
  ]
  const proj = foldEvents('t1', events)
  const t = proj.tasks['k1']
  assert.equal(t.state, 're-scoping')
  assert.equal(t.attemptId, undefined)
  assert.equal(t.escalateCount, 1)
  assert.equal(proj.members['m1'].currentTaskId, undefined)
  assert.ok(proj.inbox.some((i) => i.kind === 'escalate'))
  // rescope → ready
  events.push(ev('task.rescoped', { teamId: 't1', taskId: 'k1', patch: { description: 'narrowed' } }, 2000))
  const proj2 = foldEvents('t1', events)
  assert.equal(proj2.tasks['k1'].state, 'ready')
  assert.equal(proj2.tasks['k1'].waitingSince, 2000)
})

test('T3 fold: illegal transition fails loud at replay (replay defense line)', () => {
  seq = 0
  const events = [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.completed', { teamId: 't1', taskId: 'ghost', attemptId: 'a' }),
  ]
  assert.throws(() => foldEvents('t1', events), /task "ghost" not yet created/)
  seq = 0
  const illegal = [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    ev('task.failed', { teamId: 't1', taskId: 'k1', attemptId: 'a1', reason: 'r' }), // backlog → failed 非法
  ]
  assert.throws(() => foldEvents('t1', illegal), /illegal transition backlog → failed/)
})

test('T3 fold: message with taskId lands in perTaskMessages index (R19)', () => {
  seq = 0
  const events = [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    ev('message.sent', { teamId: 't1', messageId: 'msg1', from: 'lead', to: 'm1', taskId: 'k1' }),
    ev('message.sent', { teamId: 't1', messageId: 'msg2', from: 'm1', to: 'm2' }), // 无 taskId
    ev('message.sent', { teamId: 't1', messageId: 'msg3', from: 'human', to: 'inbox', taskId: 'k1' }),
  ]
  const proj = foldEvents('t1', events)
  assert.deepEqual(proj.perTaskMessages['k1'], [2, 4])
  assert.ok(proj.inbox.some((i) => i.kind === 'message'))
})

test('T3 fold: proposal lifecycle (scene 16)', () => {
  seq = 0
  const events = [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    ev('task.proposal', { teamId: 't1', taskId: 'k1', proposalId: 'p1', type: 'split', payload: { parts: 2 } }),
    ev('task.proposal.resolved', { teamId: 't1', proposalId: 'p1', decision: 'approved' }),
  ]
  const proj = foldEvents('t1', events)
  assert.equal(proj.proposals['p1'].status, 'approved')
})

test('T3 fold: cross-check — validatePlan green plan folds without error', () => {
  seq = 0
  const tasks: Record<string, ReturnType<typeof taskInput>> = {
    a: taskInput(),
    b: taskInput({ deps: ['a'] }),
  }
  const check = validatePlan(tasks, 20, ['dev'])
  assert.equal(check.ok, true)
  const events = [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.created', { teamId: 't1', taskId: 'a', task: tasks.a }),
    ev('task.created', { teamId: 't1', taskId: 'b', task: tasks.b }),
  ]
  const proj = foldEvents('t1', events)
  assert.equal(proj.tasks['a'].state, 'backlog')
  assert.equal(proj.tasks['b'].state, 'backlog')
})
