/**
 * 从 DSH 会话解析出 myteam 调用者身份。
 *
 * 信任边界：工具参数里的 `teamId` / `memberId` / `actor` **一律不可信**。
 * 身份只能来自「这个 session 在项目事件里被登记为哪个队长/成员」。
 * 解析不到就是 FORBIDDEN，不做「猜一个最近的团队」这种兜底。
 */
import type { ActorRef } from '../contracts/events.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ProjectState } from './projections/project-state.ts'

export function resolveAgentActor(state: ProjectState, sessionId: string): ActorRef {
  for (const assignment of state.captains.values()) {
    if (assignment.sessionId === sessionId) {
      return {
        kind: 'captain',
        teamId: assignment.teamId,
        sessionId,
        generation: assignment.generation,
      }
    }
  }
  for (const member of state.members.values()) {
    if (member.sessionId === sessionId) {
      return {
        kind: 'member',
        teamId: member.teamId,
        memberId: member.id,
        sessionId,
        memberSessionGeneration: member.memberSessionGeneration,
        attemptId: null,
      }
    }
  }
  fail(ERROR_CODES.FORBIDDEN, '当前会话不是该项目的队长或成员', { details: { sessionId } })
}

export function resolveMemberActor(state: ProjectState, sessionId: string): ActorRef {
  const actor = resolveAgentActor(state, sessionId)
  if (actor.kind !== 'member') {
    fail(ERROR_CODES.FORBIDDEN, '队长不能以成员身份提交执行事实')
  }
  return actor
}