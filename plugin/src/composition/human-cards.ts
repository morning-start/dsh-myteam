/**
 * 人类动作卡片的**处理器**（纯逻辑，不碰宿主）。
 *
 * 为什么单独拆出来：`ctx.actionCards.register` 需要 zod schema、随包 skill 和
 * 实测过的 phase 契约才能接；先把「确认时到底做什么」写成可测函数，
 * 宿主接线只做转发，避免把业务判断塞进脆弱的适配层。
 *
 * 安全边界与命令路径一致：确认前重算影响面并比对 targetHash，状态变了就拒绝。
 */
import { HumanAuthorizer } from '../domain/permissions/human-authorizer.ts'
import {
  confirmCaptainTakeover,
  confirmTeamDisband,
  previewCaptainTakeover,
  previewTeamDisband,
} from '../application/human-actions.ts'
import type { ProjectRuntime } from '../application/project-runtime.ts'
import type { ActorRef } from '../contracts/events.ts'
import { randomUUID } from 'node:crypto'

export interface HumanCardDetails {
  action: 'disband' | 'takeover'
  teamId: string
  toSessionId: string
  summary: string
  targetHash: string
}

export type HumanCardResult =
  | { status: 'settled'; decision: { callId: string; action: string; phase: string; data: Record<string, unknown> } }
  | { status: 'refused'; reason: string }

export interface HumanCardDeps {
  /** 打开项目运行时（由调用方按会话工作区解析）。 */
  open: (sessionId: string) => Promise<ProjectRuntime>
  now?: () => string
  createNonce?: () => string
}

function humanActorOf(sessionId: string): ActorRef {
  return { kind: 'human', userId: `session:${sessionId}`, via: 'panel' }
}

/**
 * 处理一次卡片动作。`verb` 只认 `confirm` 与 `cancel`：
 * - `cancel` 不写业务事件，只回报已取消；
 * - `confirm` 走与命令一致的确认流程（重算 + 比对 + issue attestation）。
 */
export async function actOnHumanCard(
  deps: HumanCardDeps,
  invocation: { callId: string; action: string; sessionId: string; details: HumanCardDetails },
  verb: string,
): Promise<HumanCardResult> {
  const { callId, sessionId, details } = invocation
  if (verb === 'cancel') {
    return { status: 'settled', decision: { callId, action: invocation.action, phase: 'cancelled', data: {} } }
  }
  if (verb !== 'confirm') {
    return { status: 'refused', reason: `不认识的动词：${verb}` }
  }
  if (details.action !== 'disband' && details.action !== 'takeover') {
    return { status: 'refused', reason: `不认识的动作：${details.action}` }
  }

  const runtime = await deps.open(sessionId)
  const preview =
    details.action === 'disband'
      ? previewTeamDisband(runtime, { teamId: details.teamId })
      : previewCaptainTakeover(runtime, { teamId: details.teamId, toSessionId: details.toSessionId })

  if (preview.targetHash !== details.targetHash) {
    return { status: 'refused', reason: '项目状态已变化，影响面不再一致，请重新发起' }
  }

  const actor = humanActorOf(sessionId)
  const authorizer = new HumanAuthorizer({
    now: deps.now ?? (() => new Date().toISOString()),
    createNonce: deps.createNonce ?? (() => randomUUID()),
  })
  const confirmation = authorizer.issue(
    {
      operationId: preview.operationId,
      action: preview.action,
      targetHash: preview.targetHash,
      impactHash: preview.impactHash,
    },
    actor,
  )

  if (details.action === 'disband') {
    confirmTeamDisband(runtime, { authorizer }, {
      actor,
      teamId: details.teamId,
      operationId: preview.operationId,
      confirmation,
      reason: 'action card',
    })
  } else {
    confirmCaptainTakeover(runtime, { authorizer }, {
      actor,
      teamId: details.teamId,
      toSessionId: details.toSessionId,
      operationId: preview.operationId,
      confirmation,
    })
  }

  return {
    status: 'settled',
    decision: {
      callId,
      action: invocation.action,
      phase: 'confirmed',
      data: { action: details.action, teamId: details.teamId, summary: details.summary },
    },
  }
}