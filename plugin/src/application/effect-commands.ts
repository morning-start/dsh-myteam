/**
 * Effect 用例：请求、受理、完成、失败、取消、结果未知。
 *
 * 状态语义（docs/architecture/01 §10.4）：
 *
 *   requested → accepted → completed
 *       │           │           └─ 外部动作已产生可核验结果
 *       │           └─ 外部系统已受理（如 inbox messageId）
 *       └─ 事件已 durable，准备执行
 *
 * 三条硬规则：
 *   1. 「消息已发送」不等于「已消费」；`accepted` 只证明对方受理；
 *   2. `outcome-unknown` 不是终态，也不是失败：必须先对账，证明未执行才允许
 *      以同一幂等键重试，证明成功只补记结果；
 *   3. 幂等键只用于关联与去重，**不能替代**外部结果核验。
 */
import type { Effect, EffectKind, EffectRetry, EffectStatus } from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import type { ErrorShape } from '../contracts/errors.ts'
import { authorize } from '../domain/permissions/policy.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'
import type { ProjectState } from './projections/project-state.ts'

const ALLOWED: Readonly<Record<EffectStatus, readonly EffectStatus[]>> = {
  requested: ['accepted', 'failed', 'cancelled'],
  accepted: ['completed', 'failed', 'outcome-unknown', 'cancelled'],
  'outcome-unknown': ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

function requireEffect(runtime: ProjectRuntime, effectId: string): Effect {
  const effect = runtime.state.effects.get(effectId)
  if (effect === undefined) {
    fail(ERROR_CODES.NOT_FOUND, 'Effect 不存在', { details: { effectId } })
  }
  return effect
}

function assertEffectTransition(effect: Effect, next: EffectStatus): void {
  if (!(ALLOWED[effect.status] ?? []).includes(next)) {
    fail(ERROR_CODES.INVALID_TRANSITION, `Effect 不能从 ${effect.status} 变为 ${next}`, {
      details: { effectId: effect.id, from: effect.status, to: next },
    })
  }
}

export function requestEffectCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    kind: EffectKind
    retry: EffectRetry
    teamId: string | null
    idempotencyKey: string
    payload: Record<string, unknown>
  },
): CommitResult {
  authorize('effect.settle', input.actor, input.teamId === null ? {} : { teamId: input.teamId })

  const duplicate = [...runtime.state.effects.values()].find(
    (effect) =>
      effect.idempotencyKey === input.idempotencyKey &&
      (effect.status === 'requested' || effect.status === 'accepted' || effect.status === 'outcome-unknown'),
  )
  if (duplicate !== undefined) {
    fail(ERROR_CODES.CONFLICT, '同一幂等键已有未结算的 Effect', {
      details: { effectId: duplicate.id, idempotencyKey: input.idempotencyKey, status: duplicate.status },
    })
  }

  const now = runtime.now()
  const effect: Effect = {
    id: runtime.nextId('effect'),
    kind: input.kind,
    retry: input.retry,
    status: 'requested',
    idempotencyKey: input.idempotencyKey,
    teamId: input.teamId,
    payload: input.payload,
    externalId: null,
    result: null,
    requestedAt: now,
    settledAt: null,
  }

  const draft: DraftEvent = {
    type: 'effect.requested',
    actor: input.actor,
    entity: { kind: 'effect', id: effect.id, teamId: input.teamId ?? undefined },
    payload: { effect },
  }
  return runtime.commit([draft])
}

export function acceptEffectCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; effectId: string; externalId: string },
): CommitResult {
  const effect = requireEffect(runtime, input.effectId)
  authorize('effect.settle', input.actor, effect.teamId === null ? {} : { teamId: effect.teamId })
  assertEffectTransition(effect, 'accepted')
  if (input.externalId.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '受理结果必须给出外部 id')
  }

  const draft: DraftEvent = {
    type: 'effect.accepted',
    actor: input.actor,
    entity: { kind: 'effect', id: effect.id, teamId: effect.teamId ?? undefined },
    payload: { effectId: effect.id, externalId: input.externalId, acceptedAt: runtime.now() },
  }
  return runtime.commit([draft])
}

export function completeEffectCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; effectId: string; result: Record<string, unknown> },
): CommitResult {
  const effect = requireEffect(runtime, input.effectId)
  authorize('effect.settle', input.actor, effect.teamId === null ? {} : { teamId: effect.teamId })
  assertEffectTransition(effect, 'completed')

  const draft: DraftEvent = {
    type: 'effect.completed',
    actor: input.actor,
    entity: { kind: 'effect', id: effect.id, teamId: effect.teamId ?? undefined },
    payload: { effectId: effect.id, result: input.result, completedAt: runtime.now() },
  }
  return runtime.commit([draft])
}

export function failEffectCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; effectId: string; error: ErrorShape },
): CommitResult {
  const effect = requireEffect(runtime, input.effectId)
  authorize('effect.settle', input.actor, effect.teamId === null ? {} : { teamId: effect.teamId })
  assertEffectTransition(effect, 'failed')

  const draft: DraftEvent = {
    type: 'effect.failed',
    actor: input.actor,
    entity: { kind: 'effect', id: effect.id, teamId: effect.teamId ?? undefined },
    payload: { effectId: effect.id, error: input.error, failedAt: runtime.now() },
  }
  return runtime.commit([draft])
}

/**
 * 标记结果未知。
 *
 * 这不是失败：外部系统可能已经执行，只是我们没拿到可核验的证据。标成
 * `outcome-unknown` 后只能走对账，不能直接重试。
 */
export function markEffectUnknownCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; effectId: string; reason: string },
): CommitResult {
  const effect = requireEffect(runtime, input.effectId)
  authorize('effect.settle', input.actor, effect.teamId === null ? {} : { teamId: effect.teamId })
  assertEffectTransition(effect, 'outcome-unknown')

  const draft: DraftEvent = {
    type: 'effect.outcome-unknown',
    actor: input.actor,
    entity: { kind: 'effect', id: effect.id, teamId: effect.teamId ?? undefined },
    payload: { effectId: effect.id, reason: input.reason, observedAt: runtime.now() },
  }
  return runtime.commit([draft])
}

export function cancelEffectCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; effectId: string; reason: string },
): CommitResult {
  const effect = requireEffect(runtime, input.effectId)
  authorize('effect.settle', input.actor, effect.teamId === null ? {} : { teamId: effect.teamId })
  assertEffectTransition(effect, 'cancelled')

  const draft: DraftEvent = {
    type: 'effect.cancelled',
    actor: input.actor,
    entity: { kind: 'effect', id: effect.id, teamId: effect.teamId ?? undefined },
    payload: { effectId: effect.id, reason: input.reason, cancelledAt: runtime.now() },
  }
  return runtime.commit([draft])
}

export interface EffectQueue {
  /** 可以启动：requested 且没有执行开始记录。 */
  startable: Effect[]
  /** 已受理但未完成：需要等待或对账。 */
  inFlight: Effect[]
  /** 结果未知：只能对账，不能盲目重放。 */
  unknown: Effect[]
}

/**
 * 启动前扫描的队列。Effect Runner 在启动和重试前只看这个视图：
 * `requested` 才可启动；`accepted` 等结果；`outcome-unknown` 先对账。
 */
export function effectQueue(state: ProjectState): EffectQueue {
  const all = [...state.effects.values()]
  return {
    startable: all.filter((effect) => effect.status === 'requested'),
    inFlight: all.filter((effect) => effect.status === 'accepted'),
    unknown: all.filter((effect) => effect.status === 'outcome-unknown'),
  }
}