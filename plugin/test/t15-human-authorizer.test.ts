import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { HumanAuthorizer } from '../src/domain/permissions/human-authorizer.ts'
import type { ConfirmationRequest } from '../src/domain/permissions/human-authorizer.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const CAPTAIN: ActorRef = { kind: 'captain', teamId: 'team_00000001', sessionId: 'ses_1', generation: 1 }

const REQUEST: ConfirmationRequest = {
  operationId: 'op_00000001',
  action: 'definition.publish',
  targetHash: 'sha256:aaa',
  impactHash: 'sha256:bbb',
}

function make(now = '2026-01-01T00:00:00.000Z'): HumanAuthorizer {
  let counter = 0
  return new HumanAuthorizer({
    now: () => now,
    createNonce: () => `nonce-${++counter}`,
    ttlMs: 60_000,
  })
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

test('确认：人类签发，绑定目标与影响面', () => {
  const authorizer = make()
  const confirmation = authorizer.issue(REQUEST, HUMAN)
  assert.equal(confirmation.targetHash, REQUEST.targetHash)
  assert.equal(confirmation.impactHash, REQUEST.impactHash)
  assert.equal(confirmation.confirmedBy, 'user-1')
  assert.equal(confirmation.expiresAt, '2026-01-01T00:01:00.000Z')
  assert.doesNotThrow(() => authorizer.verify(confirmation, REQUEST))
})

test('确认：agent 不能签发', () => {
  const authorizer = make()
  expectCode(() => authorizer.issue(REQUEST, CAPTAIN), 'HUMAN_ONLY')
})

test('确认：目标或影响面变化后令牌失效', () => {
  const authorizer = make()
  const confirmation = authorizer.issue(REQUEST, HUMAN)

  expectCode(
    () => authorizer.verify(confirmation, { ...REQUEST, targetHash: 'sha256:changed' }),
    'CONFIRMATION_TARGET_CHANGED',
  )
  expectCode(
    () => authorizer.verify(confirmation, { ...REQUEST, impactHash: 'sha256:changed' }),
    'CONFIRMATION_TARGET_CHANGED',
  )
})

test('确认：过期与操作不匹配分别报错', () => {
  const authorizer = make('2026-01-01T00:00:00.000Z')
  const confirmation = authorizer.issue(REQUEST, HUMAN)

  const later = new HumanAuthorizer({
    now: () => '2026-01-01T00:02:00.000Z',
    createNonce: () => 'nonce-late',
    ttlMs: 60_000,
  })
  expectCode(() => later.verify(confirmation, REQUEST), 'HUMAN_CONFIRMATION_EXPIRED')

  expectCode(
    () => authorizer.verify(confirmation, { ...REQUEST, operationId: 'op_other' }),
    'HUMAN_CONFIRMATION_INVALID',
  )
})

test('确认：一次性 nonce，消费后不能复用', () => {
  const authorizer = make()
  const confirmation = authorizer.issue(REQUEST, HUMAN)
  authorizer.verify(confirmation, REQUEST)
  authorizer.consume(confirmation)
  assert.equal(authorizer.consumedCount(), 1)

  expectCode(() => authorizer.verify(confirmation, REQUEST), 'HUMAN_CONFIRMATION_INVALID')
})

test('确认：重复 nonce 在签发阶段就被拒绝', () => {
  let fixed = 'same-nonce'
  const authorizer = new HumanAuthorizer({ now: () => '2026-01-01T00:00:00.000Z', createNonce: () => fixed, ttlMs: 60_000 })
  const first = authorizer.issue(REQUEST, HUMAN)
  authorizer.consume(first)
  fixed = 'same-nonce'
  expectCode(() => authorizer.issue(REQUEST, HUMAN), 'HUMAN_CONFIRMATION_INVALID')
})