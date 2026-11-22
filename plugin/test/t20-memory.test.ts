import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqliteMemoryStore } from '../src/infrastructure/memory-store/sqlite-memory.ts'
import { forgetMemory, recallMemory, rememberMemory } from '../src/application/memory-commands.ts'
import type { MemoryContext } from '../src/application/memory-commands.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { memberBankId, teamBankId } from '../src/contracts/memory.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'panel' }
const CAPTAIN: ActorRef = { kind: 'captain', teamId: 'team_1', sessionId: 'ses_c', generation: 1 }
const MEMBER: ActorRef = {
  kind: 'member',
  teamId: 'team_1',
  memberId: 'mem_1',
  sessionId: 'ses_m',
  memberSessionGeneration: 1,
  attemptId: null,
}

function context(): { ctx: MemoryContext; store: SqliteMemoryStore } {
  const store = new SqliteMemoryStore(':memory:')
  return { ctx: { memory: store, ids: newId, now: NOW }, store }
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

test('记忆：成员只读写自己的 bank，队长可读团队 bank', () => {
  const { ctx, store } = context()
  try {
    const teamEntry = rememberMemory(ctx, { actor: HUMAN, teamId: 'team_1', text: '团队约定：先写测试' })
    assert.equal(teamEntry.bankId, teamBankId('team_1'))

    const privateEntry = rememberMemory(ctx, { actor: MEMBER, teamId: 'team_1', text: '我在改登录模块' })
    assert.equal(privateEntry.bankId, memberBankId('team_1', 'mem_1'))

    const memberRecall = recallMemory(ctx, { actor: MEMBER, teamId: 'team_1' })
    assert.equal(memberRecall.length, 1, '成员看不到团队 bank')
    assert.equal(memberRecall[0]!.text, '我在改登录模块')

    const captainTeamRecall = recallMemory(ctx, { actor: CAPTAIN, teamId: 'team_1' })
    assert.equal(captainTeamRecall.length, 1, '不指定成员时读团队 bank')
    assert.equal(captainTeamRecall[0]!.text, '团队约定：先写测试')

    const captainPrivate = recallMemory(ctx, { actor: CAPTAIN, teamId: 'team_1', memberId: 'mem_1' })
    assert.equal(captainPrivate.length, 1, '队长可读本团队成员 bank')
  } finally {
    store.close()
  }
})

test('记忆：跨团队与跨成员越权被拒绝', () => {
  const { ctx, store } = context()
  try {
    expectCode(() => rememberMemory(ctx, { actor: MEMBER, teamId: 'team_2', text: 'x' }), 'FORBIDDEN')
    expectCode(
      () => rememberMemory(ctx, { actor: MEMBER, teamId: 'team_1', memberId: 'mem_2', text: 'x' }),
      'FORBIDDEN',
    )
    expectCode(
      () => recallMemory(ctx, { actor: CAPTAIN, teamId: 'team_2' }),
      'FORBIDDEN',
    )

    // 其他成员的 bank 里读不到自己的条目：按 bank 过滤后就是不存在。
    const entry = rememberMemory(ctx, { actor: MEMBER, teamId: 'team_1', text: '私有' })
    const other = recallMemory(ctx, { actor: CAPTAIN, teamId: 'team_1', memberId: 'mem_2' })
    assert.equal(other.length, 0)
    expectCode(() => ctx.memory.get(memberBankId('team_1', 'mem_2'), entry.id), 'NOT_FOUND')
  } finally {
    store.close()
  }
})

test('记忆：软删除留痕，硬删除仅人类且彻底消失', () => {
  const { ctx, store } = context()
  try {
    const entry = rememberMemory(ctx, { actor: MEMBER, teamId: 'team_1', text: '临时结论' })

    // 成员没有 memory.forget 权限。
    expectCode(() => forgetMemory(ctx, { actor: MEMBER, teamId: 'team_1', id: entry.id, reason: 'x' }), 'FORBIDDEN')

    forgetMemory(ctx, { actor: HUMAN, teamId: 'team_1', memberId: 'mem_1', id: entry.id, reason: '过时了' })
    assert.equal(recallMemory(ctx, { actor: HUMAN, teamId: 'team_1', memberId: 'mem_1' }).length, 0)
    const historical = recallMemory(ctx, {
      actor: HUMAN,
      teamId: 'team_1',
      memberId: 'mem_1',
      includeForgotten: true,
    })
    assert.equal(historical.length, 1)
    assert.notEqual(historical[0]!.forgottenAt, null)
    assert.equal(historical[0]!.revision, 2)

    forgetMemory(ctx, { actor: HUMAN, teamId: 'team_1', memberId: 'mem_1', id: entry.id, reason: '彻底删除', hard: true })
    expectCode(() => ctx.memory.get(memberBankId('team_1', 'mem_1'), entry.id), 'NOT_FOUND')
  } finally {
    store.close()
  }
})