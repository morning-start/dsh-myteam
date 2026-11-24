/**
 * 人类专属动作：先给影响面，再凭令牌执行。
 *
 * 两段式是刻意的：
 *   `preview*` 只读，算出「你正在同意什么」的两个 hash（目标 + 影响面）；
 *   `confirm*` 复验令牌，再调用普通应用用例。
 *
 * 为什么确认入口不复用普通命令：普通命令的鉴权只回答「这个 actor 种类能不能
 * 做」，而人类专属动作还要回答「是不是**这一次**、**这份内容**被同意了」。
 * 令牌把 operationId、目标 hash、影响面 hash、一次性 nonce 绑在一起，任何一项
 * 变化都必须重新看、重新确认。
 *
 * 预览与确认之间的变化不会被自动合并：hash 对不上就报
 * `CONFIRMATION_TARGET_CHANGED`，让人重新看差异。
 */
import type { JsonValue } from '../contracts/json.ts'
import { hashContent } from '../contracts/json.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import type { HumanAction, HumanAuthorizer, HumanConfirmation } from '../domain/permissions/human-authorizer.ts'
import { authorize } from '../domain/permissions/policy.ts'
import { approveTeamPlanCommand, changeTeamStatusCommand } from './commands.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'

export interface HumanActionPreview {
  action: HumanAction
  operationId: string
  targetHash: string
  impactHash: string
  summary: string
  impact: JsonValue
}

export interface HumanActionDeps {
  authorizer: HumanAuthorizer
}

function teamOf(runtime: ProjectRuntime, teamId: string) {
  const team = runtime.state.teams.get(teamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId } })
  }
  return team
}

function activeAttemptsOf(runtime: ProjectRuntime, teamId: string): string[] {
  return [...runtime.state.attempts.values()]
    .filter((attempt) => attempt.teamId === teamId && attempt.status === 'active')
    .map((attempt) => attempt.id)
    .sort()
}

/** 解散团队的影响面：成员、在途 Attempt、未结束任务、未结算 Effect。 */
export function previewTeamDisband(runtime: ProjectRuntime, input: { teamId: string }): HumanActionPreview {
  const team = teamOf(runtime, input.teamId)
  const state = runtime.state

  const impact = {
    teamId: team.id,
    name: team.name,
    status: team.status,
    members: [...state.members.values()]
      .filter((member) => member.teamId === team.id && member.status !== 'released')
      .map((member) => member.id)
      .sort(),
    activeAttempts: activeAttemptsOf(runtime, team.id),
    unfinishedTasks: [...state.tasks.values()]
      .filter(
        (task) =>
          task.ownerTeamId === team.id && task.status !== 'done' && task.status !== 'cancelled',
      )
      .map((task) => task.id)
      .sort(),
    unsettledEffects: [...state.effects.values()]
      .filter(
        (effect) =>
          effect.teamId === team.id &&
          (effect.status === 'requested' || effect.status === 'accepted' || effect.status === 'outcome-unknown'),
      )
      .map((effect) => effect.id)
      .sort(),
  }

  return {
    action: 'team.disband',
    operationId: runtime.nextId('operation'),
    targetHash: hashContent({ kind: 'team', id: team.id, revision: team.revision }),
    impactHash: hashContent(impact),
    summary: `解散团队「${team.name}」：${impact.members.length} 名成员、${impact.activeAttempts.length} 个在途 Attempt、${impact.unfinishedTasks.length} 个未完成任务`,
    impact: impact as unknown as JsonValue,
  }
}

export function confirmTeamDisband(
  runtime: ProjectRuntime,
  deps: HumanActionDeps,
  input: {
    actor: ActorRef
    teamId: string
    operationId: string
    confirmation: HumanConfirmation
    reason: string
  },
): CommitResult {
  authorize('team.disband', input.actor, { teamId: input.teamId })
  const team = teamOf(runtime, input.teamId)
  if (team.status === 'disbanded') {
    fail(ERROR_CODES.CONFLICT, '团队已解散', { details: { teamId: team.id } })
  }

  // 用**当前**状态重算影响面：预览之后有任何变化都会让 hash 对不上。
  const current = previewTeamDisband(runtime, { teamId: input.teamId })
  deps.authorizer.verify(input.confirmation, {
    operationId: input.operationId,
    action: 'team.disband',
    targetHash: current.targetHash,
    impactHash: current.impactHash,
  })
  deps.authorizer.consume(input.confirmation)

  return changeTeamStatusCommand(runtime, {
    actor: input.actor,
    teamId: input.teamId,
    status: 'disbanded',
    reason: input.reason,
  })
}

/** 队长接管的影响面：当前队长会话、下一代 generation、在途 Attempt。 */
export function previewCaptainTakeover(
  runtime: ProjectRuntime,
  input: { teamId: string; toSessionId: string },
): HumanActionPreview {
  const team = teamOf(runtime, input.teamId)
  const current = runtime.state.captains.get(team.id) ?? null
  if (input.toSessionId.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '接管必须指定新队长会话')
  }
  if (current !== null && current.sessionId === input.toSessionId) {
    fail(ERROR_CODES.CONFLICT, '该会话已经是当前队长', { details: { sessionId: input.toSessionId } })
  }

  const impact = {
    teamId: team.id,
    fromSessionId: current?.sessionId ?? null,
    fromGeneration: current?.generation ?? 0,
    toSessionId: input.toSessionId,
    nextGeneration: (current?.generation ?? 0) + 1,
    activeAttempts: activeAttemptsOf(runtime, team.id),
  }

  return {
    action: 'captain.takeover',
    operationId: runtime.nextId('operation'),
    targetHash: hashContent({
      kind: 'captain-assignment',
      teamId: team.id,
      sessionId: current?.sessionId ?? null,
      generation: current?.generation ?? 0,
    }),
    impactHash: hashContent(impact),
    summary:
      current === null
        ? `为团队「${team.name}」指定首任队长（generation 1）`
        : `把团队「${team.name}」的队长从 ${current.sessionId} 切换到 ${input.toSessionId}（generation ${impact.nextGeneration}）`,
    impact: impact as unknown as JsonValue,
  }
}

export function confirmCaptainTakeover(
  runtime: ProjectRuntime,
  deps: HumanActionDeps,
  input: {
    actor: ActorRef
    teamId: string
    toSessionId: string
    operationId: string
    confirmation: HumanConfirmation
  },
): CommitResult {
  authorize('captain.handoff.confirm', input.actor, { teamId: input.teamId })
  const team = teamOf(runtime, input.teamId)
  if (team.status !== 'active') {
    fail(ERROR_CODES.TEAM_NOT_ACTIVE, `团队状态为 ${team.status}，不能接管`, { details: { teamId: team.id } })
  }

  const current = previewCaptainTakeover(runtime, { teamId: input.teamId, toSessionId: input.toSessionId })
  deps.authorizer.verify(input.confirmation, {
    operationId: input.operationId,
    action: 'captain.takeover',
    targetHash: current.targetHash,
    impactHash: current.impactHash,
  })
  deps.authorizer.consume(input.confirmation)

  const impact = current.impact as { nextGeneration: number; toSessionId: string }
  const draft: DraftEvent = {
    type: 'captain.handoff.confirmed',
    actor: input.actor,
    entity: { kind: 'captain-assignment', id: input.teamId, teamId: input.teamId },
    payload: {
      teamId: input.teamId,
      generation: impact.nextGeneration,
      toSessionId: impact.toSessionId,
      confirmedBy: input.actor.kind === 'human' ? input.actor.userId : 'unknown',
    },
  }
  return runtime.commit([draft])
}

/** 令牌里的 action 必须与调用方声明一致，防止「拿 A 的令牌做 B」。 */
/**
 * 预览批准开队计划的影响面（`plan.approve`，人类专属）。
 *
 * 令牌的 `targetHash` 就是 **planHash**：计划内容（队形/工作流/配置）任何一项被改过，
 * hash 就变，令牌立刻失效。只绑 planId 是不够的 —— 内容可以在预览与确认之间被改。
 *
 * `impactHash` 绑影响面：会建几名成员、几个任务、开不开 Run。
 */
export function previewTeamPlanApproval(
  runtime: ProjectRuntime,
  input: { planId: string },
): HumanActionPreview {
  const plan = runtime.state.teamPlans.get(input.planId)
  if (plan === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '没有这份待批准的计划（可能已经批准或丢弃）', {
      details: { planId: input.planId },
    })
  }
  const plannedMembers = plan.formation.reduce((sum, slot) => sum + slot.count, 0)
  const workflow = plan.workflow === null ? null : runtime.state.workflows.get(plan.workflow.id)
  const plannedTasks = workflow === null || workflow === undefined ? 0 : workflow.templates.length

  const impact = {
    planId: plan.id,
    planHash: plan.planHash,
    teamName: plan.name,
    plannedMembers,
    plannedTasks,
    startsRun: plan.workflow !== null && workflow !== undefined,
    workflowId: plan.workflow?.id ?? null,
    captainSessionId: plan.captainSessionId,
  }

  return {
    action: 'plan.approve',
    operationId: runtime.nextId('operation'),
    targetHash: plan.planHash,
    impactHash: hashContent(impact),
    summary:
      `批准计划「${plan.name}」：建 ${String(plannedMembers)} 名成员` +
      (impact.startsRun ? `、开 Run 并落 ${String(plannedTasks)} 个任务` : ''),
    impact: impact as unknown as JsonValue,
  }
}

/**
 * 第二步：人类确认后批准计划。
 *
 * 顺序固定：**先复验令牌**（targetHash 是 planHash，内容改过就失效）→ 消费令牌 → 执行批准。
 * 校验不能省，否则伪造令牌可以凭空建出整个团队。
 */
export function confirmTeamPlanApproval(
  runtime: ProjectRuntime,
  deps: HumanActionDeps,
  input: {
    actor: ActorRef
    planId: string
    planHash: string
    startRun: boolean
    operationId: string
    confirmation: HumanConfirmation
  },
): { teamId: string; memberIds: string[]; runId: string | null; taskIds: string[] } {
  authorize('plan.approve', input.actor)
  const current = runtime.state.teamPlans.get(input.planId)
  if (current === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '没有这份待批准的计划（可能已经批准或丢弃）', {
      details: { planId: input.planId },
    })
  }
  if (current.planHash !== input.planHash) {
    fail(ERROR_CODES.CONFIRMATION_TARGET_CHANGED, '计划内容与预览时不一致，请重新预览再批准', {
      details: { planId: input.planId, expectedHash: input.planHash, actualHash: current.planHash },
    })
  }

  const preview = previewTeamPlanApproval(runtime, { planId: input.planId })
  deps.authorizer.verify(input.confirmation, {
    operationId: input.operationId,
    action: 'plan.approve',
    targetHash: preview.targetHash,
    impactHash: preview.impactHash,
  })
  deps.authorizer.consume(input.confirmation)

  const approved = approveTeamPlanCommand(runtime, {
    actor: input.actor,
    planId: input.planId,
    planHash: input.planHash,
    startRun: input.startRun,
  })
  return {
    teamId: approved.teamId,
    memberIds: approved.memberIds,
    runId: approved.runId,
    taskIds: approved.taskIds,
  }
}

export function assertActionMatches(confirmation: HumanConfirmation, action: HumanAction): void {
  if (confirmation.action !== action) {
    fail(ERROR_CODES.HUMAN_CONFIRMATION_INVALID, '确认令牌的动作与请求不一致', {
      details: { tokenAction: confirmation.action, requestedAction: action },
    })
  }
}