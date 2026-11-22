/**
 * 授权矩阵（纯判定，不做 IO、不查投影）。
 *
 * 安全边界在应用服务，不在工具可见性：工具 schema 不给模型某个能力只是体验层，
 * 服务端仍要对同一动作做同样的判定（docs/architecture/01 §3.3）。
 *
 * 人类专属动作（`HUMAN_ONLY`）不是「队长不能点」的界面规则，而是：
 * 任何非 human 调用一律 HUMAN_ONLY，且 human 调用还需要 HumanAuthorizer 的
 * 一次性令牌在服务端复验。这里只回答「这个 actor 种类能不能做这类动作」。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type { ActorRef } from '../../contracts/events.ts'

export type Action =
  | 'project.read'
  | 'definition.write'
  | 'definition.copy-from-global'
  | 'definition.publish.request'
  | 'definition.publish.confirm'
  | 'team.create'
  | 'team.update'
  | 'team.archive'
  | 'team.disband'
  | 'captain.assign'
  | 'captain.handoff.propose'
  | 'captain.handoff.confirm'
  | 'member.appoint'
  | 'member.release'
  | 'member.pause'
  | 'run.create'
  | 'run.revise'
  | 'task.create'
  | 'task.update'
  | 'task.dependencies.change'
  | 'task.claim'
  | 'task.progress'
  | 'task.evidence'
  | 'task.submit-review'
  | 'task.complete'
  | 'task.reopen'
  | 'task.cancel'
  | 'knowledge.propose'
  | 'knowledge.adopt'
  | 'knowledge.archive'
  | 'config.write'
  | 'config.rebase'
  | 'memory.read'
  | 'memory.write'
  | 'memory.forget'
  | 'message.post'
  | 'effect.settle'
  | 'plan.approve'
  | 'migration.cutover'

/** 只有人类可以发起。agent 无法通过任何工具参数获得这些动作。 */
export const HUMAN_ONLY: ReadonlySet<Action> = new Set<Action>([
  'definition.publish.confirm',
  'team.disband',
  'captain.handoff.confirm',
  'plan.approve',
  'migration.cutover',
])

/** 队长可发起的项目级动作。 */
const CAPTAIN_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'project.read',
  'definition.write',
  'definition.copy-from-global',
  'definition.publish.request',
  'team.create',
  'team.update',
  'team.archive',
  'captain.assign',
  'captain.handoff.propose',
  'member.appoint',
  'member.release',
  'member.pause',
  'run.create',
  'run.revise',
  'task.create',
  'task.update',
  'task.dependencies.change',
  'task.claim',
  'task.reopen',
  'task.cancel',
  'knowledge.propose',
  'knowledge.adopt',
  'knowledge.archive',
  'config.write',
  'config.rebase',
  'memory.read',
  'memory.write',
  'memory.forget',
  'message.post',
  'effect.settle',
])

/** 系统身份（Effect Runner）只能结算 Effect，不能发起任何业务动作。 */
const SYSTEM_ACTIONS: ReadonlySet<Action> = new Set<Action>(['effect.settle'])

/**
 * 成员可发起的动作。
 *
 * 成员不能改定义、不能建任务、不能完成自己的任务（完成要队长侧门禁裁决），
 * 也不能采纳知识——采纳会改变全队可见的知识面。
 */
const MEMBER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'project.read',
  'task.claim',
  'task.progress',
  'task.evidence',
  'task.submit-review',
  'knowledge.propose',
  'memory.read',
  'memory.write',
  'message.post',
])

export interface PermissionContext {
  /** 动作涉及的项目团队；用于核对队长/成员的团队绑定。 */
  teamId?: string
  /** 动作涉及的角色/成员 id；用于核对成员只能操作自己的 Attempt。 */
  memberId?: string
  /** 当前 Attempt 的持有者；提交进度/证据时必须等于成员本人。 */
  attemptMemberId?: string
}

/**
 * 判定并抛出。通过时返回 undefined。
 *
 * 团队绑定校验：队长只能操作自己团队的实体，成员只能操作本团队且属于自己
 * 的 Attempt。跨团队动作（例如协作团队提交本团队执行子集）由应用层先解析
 * 出 `teamId`，仍然走同一条判定。
 */
export function authorize(action: Action, actor: ActorRef, context: PermissionContext = {}): void {
  if (HUMAN_ONLY.has(action) && actor.kind !== 'human') {
    fail(ERROR_CODES.HUMAN_ONLY, `动作 ${action} 只能由人类在可信入口发起`, {
      details: { action, actorKind: actor.kind },
    })
  }

  switch (actor.kind) {
    case 'human':
      return
    case 'system':
      if (SYSTEM_ACTIONS.has(action)) return
      fail(ERROR_CODES.FORBIDDEN, `系统身份不能发起业务动作 ${action}`, { details: { action } })
      break
    case 'captain': {
      if (!CAPTAIN_ACTIONS.has(action)) {
        fail(ERROR_CODES.FORBIDDEN, `队长不能发起动作 ${action}`, { details: { action } })
      }
      if (context.teamId !== undefined && context.teamId !== actor.teamId) {
        fail(ERROR_CODES.FORBIDDEN, '队长不能操作其他团队的实体', {
          details: { action, actorTeamId: actor.teamId, targetTeamId: context.teamId },
        })
      }
      return
    }
    case 'member': {
      if (!MEMBER_ACTIONS.has(action)) {
        fail(ERROR_CODES.FORBIDDEN, `成员不能发起动作 ${action}`, { details: { action } })
      }
      if (context.teamId !== undefined && context.teamId !== actor.teamId) {
        fail(ERROR_CODES.FORBIDDEN, '成员不能操作其他团队的实体', {
          details: { action, actorTeamId: actor.teamId, targetTeamId: context.teamId },
        })
      }
      if (context.memberId !== undefined && context.memberId !== actor.memberId) {
        fail(ERROR_CODES.FORBIDDEN, '成员只能操作自己的实体', { details: { action } })
      }
      if (context.attemptMemberId !== undefined && context.attemptMemberId !== actor.memberId) {
        fail(ERROR_CODES.FORBIDDEN, '成员只能提交自己 Attempt 的事实', { details: { action } })
      }
      return
    }
  }
}

/** 只判定不抛错，供面板预置按钮可用态。 */
export function can(action: Action, actor: ActorRef, context: PermissionContext = {}): boolean {
  try {
    authorize(action, actor, context)
    return true
  } catch {
    return false
  }
}

/** 动作是否属于人类专属（面板据此显示「仅你可见」而不是伪装成禁用按钮）。 */
export function isHumanOnly(action: Action): boolean {
  return HUMAN_ONLY.has(action)
}