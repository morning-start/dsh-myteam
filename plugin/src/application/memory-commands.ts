/**
 * 长期记忆用例：记住、召回、遗忘。
 *
 * bank 归属在这里先判一次（按调用者身份解析出唯一合法的 bank），存储层再判
 * 一次（跨 bank 读取视为不存在）。两层都做，是因为任何一层单独出错都会
 * 变成「能看到/删掉别人记忆」。
 *
 * 遗忘分软硬：软删除留痕（可审计、可解释），硬删除只在用户明确要求时使用。
 */
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import { memberBankId, teamBankId } from '../contracts/memory.ts'
import { authorize } from '../domain/permissions/policy.ts'
import type { IdPort, MemoryEntryRecord, MemoryPort } from './ports.ts'

export interface MemoryContext {
  memory: MemoryPort
  ids: IdPort
  now: string
}

/**
 * 解析调用者能用的 bank。
 *
 * - human：可以指定团队 bank 或某个成员 bank；
 * - captain：只能自己团队，可以写团队 bank 或本团队成员的私有 bank；
 * - member：只能自己的私有 bank（不传 memberId 时自动落到自己）。
 */
function resolveBank(actor: ActorRef, teamId: string, memberId: string | undefined): string {
  if (actor.kind === 'human') {
    return memberId === undefined ? teamBankId(teamId) : memberBankId(teamId, memberId)
  }
  if (actor.kind === 'system') {
    fail(ERROR_CODES.FORBIDDEN, '系统身份不能读写记忆')
  }
  if (actor.teamId !== teamId) {
    fail(ERROR_CODES.FORBIDDEN, '不能访问其他团队的记忆 bank', {
      details: { actorTeamId: actor.teamId, requestedTeamId: teamId },
    })
  }
  if (actor.kind === 'member') {
    if (memberId !== undefined && memberId !== actor.memberId) {
      fail(ERROR_CODES.FORBIDDEN, '成员只能访问自己的私有记忆', { details: { requestedMemberId: memberId } })
    }
    return memberBankId(teamId, actor.memberId)
  }
  return memberId === undefined ? teamBankId(teamId) : memberBankId(teamId, memberId)
}

export function rememberMemory(
  context: MemoryContext,
  input: {
    actor: ActorRef
    teamId: string
    memberId?: string
    text: string
    tags?: string[]
    evidence?: string[]
  },
): MemoryEntryRecord {
  authorize('memory.write', input.actor, { teamId: input.teamId, memberId: input.memberId })
  const bankId = resolveBank(input.actor, input.teamId, input.memberId)
  return context.memory.remember({
    id: context.ids('memory'),
    bankId,
    text: input.text,
    tags: input.tags ?? [],
    evidence: input.evidence ?? [],
    now: context.now,
  })
}

export function recallMemory(
  context: MemoryContext,
  input: { actor: ActorRef; teamId: string; memberId?: string; query?: string; limit?: number; includeForgotten?: boolean },
): MemoryEntryRecord[] {
  authorize('memory.read', input.actor, { teamId: input.teamId, memberId: input.memberId })
  const bankId = resolveBank(input.actor, input.teamId, input.memberId)
  return context.memory.recall({
    bankId,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.includeForgotten === undefined ? {} : { includeForgotten: input.includeForgotten }),
  })
}

export function forgetMemory(
  context: MemoryContext,
  input: { actor: ActorRef; teamId: string; memberId?: string; id: string; reason: string; hard?: boolean },
): void {
  authorize('memory.forget', input.actor, { teamId: input.teamId, memberId: input.memberId })
  const bankId = resolveBank(input.actor, input.teamId, input.memberId)
  if (input.hard === true && input.actor.kind !== 'human') {
    fail(ERROR_CODES.HUMAN_ONLY, '硬删除记忆只能由人类发起', { details: { id: input.id } })
  }
  context.memory.forget({
    bankId,
    id: input.id,
    reason: input.reason,
    hard: input.hard === true,
    now: context.now,
  })
}