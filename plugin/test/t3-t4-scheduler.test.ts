import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLegalTransition,
  validatePlan,
  canClaim,
  claimOrder,
  emptyProjection,
  type TaskInput,
  type TaskProjection,
} from '../src/core/scheduler/state.ts'

const baseTask: TaskInput = {
  title: 't',
  description: 'd',
  acceptanceCriteria: ['ac1'],
  deps: [],
  requiredRole: 'dev',
  priority: 'P2',
}

const leafSpec = { path: 'docs/x.md' }

test('T3: transition table blocks illegal moves (state machine, PRD §7.1)', () => {
  assert.ok(isLegalTransition('backlog', 'ready'))
  assert.ok(isLegalTransition('in_progress', 're-scoping'))
  assert.ok(isLegalTransition('re-scoping', 'ready'))
  assert.ok(isLegalTransition('re-scoping', 'blocked'))
  assert.ok(!isLegalTransition('backlog', 'done'), 'cannot skip to done')
  assert.ok(!isLegalTransition('done', 'in_progress'), 'done is terminal')
  assert.ok(!isLegalTransition('failed', 'ready'), 'failed is terminal, downstream never unlocks')
  assert.ok(!isLegalTransition('ready', 'gate:review'), 'gates only from in_progress')
})

test('T3: plan validation — cycle / missing AC / role not in roster / orphan (FR-11.2)', () => {
  const cyclic: Record<string, TaskInput> = {
    a: { ...baseTask, deps: ['b'], deliverableSpec: leafSpec },
    b: { ...baseTask, deps: ['a'], deliverableSpec: leafSpec },
  }
  const r1 = validatePlan(cyclic, 20, ['dev'])
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.message.includes('cycle')))

  const noAc: Record<string, TaskInput> = {
    a: { ...baseTask, acceptanceCriteria: [], deliverableSpec: leafSpec },
    b: { ...baseTask, deps: ['a'], deliverableSpec: leafSpec },
  }
  const r2 = validatePlan(noAc, 20, ['dev'])
  assert.ok(r2.errors.some((e) => e.message.includes('acceptanceCriteria')))

  const badRole: Record<string, TaskInput> = {
    a: { ...baseTask, requiredRole: 'ghost', deliverableSpec: leafSpec },
    b: { ...baseTask, deps: ['a'], deliverableSpec: leafSpec },
  }
  const r3 = validatePlan(badRole, 20, ['dev'])
  assert.ok(r3.errors.some((e) => e.message.includes('not in roster')))

  const orphan: Record<string, TaskInput> = {
    a: { ...baseTask, deliverableSpec: leafSpec },
    b: { ...baseTask, deliverableSpec: leafSpec },
  }
  const r4 = validatePlan(orphan, 20, ['dev'])
  assert.ok(r4.errors.some((e) => e.message.includes('orphan')))

  const missingDep: Record<string, TaskInput> = {
    a: { ...baseTask, deps: ['nope'], deliverableSpec: leafSpec },
  }
  const r5 = validatePlan(missingDep, 20, ['dev'])
  assert.ok(r5.errors.some((e) => e.message.includes('does not exist')))

  const noDeliverable: Record<string, TaskInput> = {
    a: { ...baseTask },
    b: { ...baseTask, deps: ['a'], deliverableSpec: leafSpec },
  }
  const r6 = validatePlan(noDeliverable, 20, ['dev'])
  assert.ok(r6.errors.some((e) => e.message.includes('deliverableSpec')))

  const good: Record<string, TaskInput> = {
    a: { ...baseTask, deliverableSpec: leafSpec },
    b: { ...baseTask, deps: ['a'], deliverableSpec: leafSpec },
  }
  const r7 = validatePlan(good, 20, ['dev'])
  assert.equal(r7.ok, true, JSON.stringify(r7.errors))
})

function proj(id: string, over: Partial<TaskProjection> = {}): TaskProjection {
  return {
    id,
    input: { ...baseTask },
    state: 'ready',
    escalateCount: 0,
    gates: [],
    gateVerdicts: {},
    evidenceRefs: [],
    deliverables: [],
    createdAt: 1000,
    ...over,
  }
}

test('T4: canClaim — role match + ready + active member (FR-11.5)', () => {
  const member = { roleId: 'dev', status: 'active' as const }
  assert.deepEqual(canClaim(proj('t1', { input: { ...baseTask } }), member, 0), { claimable: true, reasons: [] })
  const blocked = canClaim(proj('t1', { state: 'in_progress' }), member, 0)
  assert.equal(blocked.claimable, false)
  const wrongRole = canClaim(proj('t1', { input: { ...baseTask, requiredRole: 'writer' } }), member, 0)
  assert.equal(wrongRole.claimable, false)
  const suspended = canClaim(proj('t1'), { roleId: 'dev', status: 'suspended' }, 0)
  assert.equal(suspended.claimable, false)
})

test('T4: claimOrder — priority first, FIFO within same priority (anti-starvation)', () => {
  const tasks = [
    proj('p2-old', { input: { ...baseTask, priority: 'P2' }, waitingSince: 100 }),
    proj('p2-new', { input: { ...baseTask, priority: 'P2' }, waitingSince: 200 }),
    proj('p3', { input: { ...baseTask, priority: 'P3' }, waitingSince: 50 }),
    proj('p0', { input: { ...baseTask, priority: 'P0' }, waitingSince: 999 }),
  ]
  assert.deepEqual(claimOrder(tasks), ['p0', 'p2-old', 'p2-new', 'p3'])
})

test('T3: emptyProjection defaults', () => {
  const p = emptyProjection('t1')
  assert.equal(p.state, 'draft')
  assert.equal(p.revision, 0)
  assert.deepEqual(p.tasks, {})
})
