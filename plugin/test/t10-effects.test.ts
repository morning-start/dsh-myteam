import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { initializeProject } from '../src/application/commands.ts'
import {
  acceptEffectCommand,
  cancelEffectCommand,
  completeEffectCommand,
  effectQueue,
  markEffectUnknownCommand,
  requestEffectCommand,
} from '../src/application/effect-commands.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'

const PROJECT = 'prj_00000001'
const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'panel' }
const SYSTEM: ActorRef = { kind: 'system', component: 'effect-runner' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  return ProjectRuntime.open({
    projectId: PROJECT,
    eventStore: new FileEventStore(join(dir, 'events', 'project.jsonl')),
    writerLock: new WriterLeaseManager(join(dir, 'state', 'writer.lock')),
    clock: { now: () => NOW },
    ids: newId,
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

test('Effect：requested → accepted → completed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-effect-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: 'Effect' })
      const requested = requestEffectCommand(runtime, {
        actor: SYSTEM,
        kind: 'send-message',
        retry: 'reconcilable',
        teamId: null,
        idempotencyKey: 'msg:task_1:member_1:1',
        payload: { to: 'mem_00000001', body: 'hello' },
      })
      const effectId = (requested.events[0]!.payload as { effect: { id: string } }).effect.id

      assert.deepEqual(effectQueue(runtime.state).startable.map((effect) => effect.id), [effectId])

      acceptEffectCommand(runtime, { actor: SYSTEM, effectId, externalId: 'inbox_42' })
      assert.equal(runtime.state.effects.get(effectId)!.status, 'accepted')
      assert.equal(runtime.state.effects.get(effectId)!.externalId, 'inbox_42')
      assert.deepEqual(effectQueue(runtime.state).inFlight.map((effect) => effect.id), [effectId])

      completeEffectCommand(runtime, { actor: SYSTEM, effectId, result: { delivered: true } })
      assert.equal(runtime.state.effects.get(effectId)!.status, 'completed')
      assert.deepEqual(effectQueue(runtime.state).startable, [])
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Effect：未知结果不是失败，对账后可补记完成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-effect-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: 'Effect' })
      const requested = requestEffectCommand(runtime, {
        actor: SYSTEM,
        kind: 'spawn-member',
        retry: 'non-idempotent',
        teamId: null,
        idempotencyKey: 'spawn:mem_1',
        payload: {},
      })
      const effectId = (requested.events[0]!.payload as { effect: { id: string } }).effect.id
      acceptEffectCommand(runtime, { actor: SYSTEM, effectId, externalId: 'child_7' })
      markEffectUnknownCommand(runtime, { actor: SYSTEM, effectId, reason: '进程中断，未拿到结果' })

      assert.equal(runtime.state.effects.get(effectId)!.status, 'outcome-unknown')
      assert.deepEqual(effectQueue(runtime.state).unknown.map((effect) => effect.id), [effectId])

      // 对账证明已成功：只补记结果，不重放。
      completeEffectCommand(runtime, { actor: SYSTEM, effectId, result: { recoveredFrom: 'session-log' } })
      assert.equal(runtime.state.effects.get(effectId)!.status, 'completed')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Effect：同一幂等键不能并发请求', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-effect-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: 'Effect' })
      const base = {
        actor: SYSTEM,
        kind: 'send-message' as const,
        retry: 'reconcilable' as const,
        teamId: null,
        idempotencyKey: 'msg:dup',
        payload: {},
      }
      requestEffectCommand(runtime, base)
      expectCode(() => requestEffectCommand(runtime, base), 'CONFLICT')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Effect：非法状态跳转与系统越权都被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-effect-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: 'Effect' })
      const requested = requestEffectCommand(runtime, {
        actor: SYSTEM,
        kind: 'send-message',
        retry: 'reconcilable',
        teamId: null,
        idempotencyKey: 'msg:jump',
        payload: {},
      })
      const effectId = (requested.events[0]!.payload as { effect: { id: string } }).effect.id

      expectCode(
        () => completeEffectCommand(runtime, { actor: SYSTEM, effectId, result: {} }),
        'INVALID_TRANSITION',
      )

      cancelEffectCommand(runtime, { actor: SYSTEM, effectId, reason: '任务取消' })
      assert.equal(runtime.state.effects.get(effectId)!.status, 'cancelled')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})