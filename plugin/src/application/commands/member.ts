/**
 * 成员生命周期用例：任命、归档、恢复、释放。
 *
 * 归档会先暂停再归档（两条事件、同一 revision 链），恢复只认已归档成员；
 * 释放用于把成员交还给 DSH 会话面。由 {@link ../commands.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { DEFAULT_TEAM_CONFIG } from '../../domain/config/merge.ts'
import { authorize } from '../../domain/permissions/policy.ts'
import { appointMember, assertMemberLimits, assertMemberStatusChange, memberDepth } from '../../domain/teams/member.ts'
import { assertTeamActive } from '../../domain/teams/team.ts'
import type { ActorRef } from '../../contracts/events.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from '../project-runtime.ts'

export function appointMemberCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    teamId: string
    roleId: string
    parentMemberId?: string | null
    sessionId?: string | null
  },
): CommitResult {
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  authorize('member.appoint', input.actor, { teamId: input.teamId })
  assertTeamActive(team)

  const role = state.roles.get(input.roleId)
  if (role === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '角色不存在', { details: { roleId: input.roleId } })
  }
  const parent =
    input.parentMemberId === undefined || input.parentMemberId === null
      ? null
      : (state.members.get(input.parentMemberId) ?? null)
  if (input.parentMemberId !== undefined && input.parentMemberId !== null && parent === null) {
    fail(ERROR_CODES.NOT_FOUND, '父成员不存在', { details: { memberId: input.parentMemberId } })
  }

  const now = runtime.now()
  const memberId = runtime.nextId('member')

  // 数量/深度/子数上限来自该团队生效配置，不是全局常量：不同团队可以不同，
  // 但都已被安全上限钳制过。
  const teamMembers = new Map(
    [...state.members.values()]
      .filter((candidate) => candidate.teamId === input.teamId)
      .map((candidate) => [candidate.id, candidate] as const),
  )
  const effectiveConfig = state.teamConfigs.get(input.teamId)?.values ?? DEFAULT_TEAM_CONFIG
  assertMemberLimits({
    existingMembers: teamMembers.size,
    depth: parent === null ? 1 : memberDepth(parent, teamMembers) + 1,
    parentChildren:
      parent === null
        ? 0
        : [...teamMembers.values()].filter((candidate) => candidate.parentMemberId === parent.id).length,
    config: effectiveConfig.limits,
  })

  const { member } = appointMember({
    id: memberId,
    teamId: input.teamId,
    role,
    parent,
    sessionId: input.sessionId ?? null,
    now,
  })

  const draft: DraftEvent = {
    type: 'member.appointed',
    actor: input.actor,
    entity: { kind: 'member', id: memberId, teamId: input.teamId },
    entityRevision: 1,
    configRevision: team.configRevision,
    payload: { member, roleRevision: role.revision, parentMemberId: member.parentMemberId },
  }
  return runtime.commit([draft])
}

/**
 * 释放成员（`released` 是终态，释放后不能再变）。
 *
 * 为什么要有这个命令：`MemberStatus` 里一直有 `released`、事件类型里也有
 * `member.released`，但没有任何命令能把它写出来 —— 释放/归档成员的屏因此只能看不能动。
 *
 * 前置：团队 active；成员属于该团队；成员**没有进行中的尝试**（先收尾再释放，
 * 否则释放后尝试会挂在一个已经不存在的任期上）；状态迁移按 MEMBER_TRANSITIONS 走。
 */
/**
 * 归档成员（`member.archived`）。
 *
 * 与 {@link releaseMemberCommand} 的区别（见 docs/decisions/成员归档语义.md）：
 *   - 归档是「退役但可回放」：名册留痕、记忆 bank 与证据都保留，之后还能恢复成 active；
 *   - 释放是终态，不提供恢复。
 *
 * 前置条件（照设计稿 p-member-archive 的「先排空、再归档」）：
 *   1. 不能有进行中的 Attempt —— 有两种处理方式：\`drain: 'wait'\`（默认）直接拒绝，
 *      让用户等这一轮结束；\`drain: 'pause'\` 先把成员落成 paused 再归档（同一批次两事件）。
 *   2. 子成员必须已经归档或释放 —— 否则报 CONFLICT 并列出子成员 id，级联必须显式二次确认。
 */
export function archiveMemberCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; teamId: string; memberId: string; drain?: 'wait' | 'pause' },
): CommitResult {
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  authorize('member.archive', input.actor, { teamId: input.teamId })
  assertTeamActive(team)

  const member = state.members.get(input.memberId)
  if (member === undefined || member.teamId !== input.teamId) {
    fail(ERROR_CODES.NOT_FOUND, '成员不存在', { details: { memberId: input.memberId, teamId: input.teamId } })
  }
  // archived → archived 是幂等拒绝：已经是归档态就别再写一条相同事件。
  assertMemberStatusChange(member.status, 'archived')

  // 子成员先处理：级联不静默发生。
  const children = [...state.members.values()].filter(
    (candidate) => candidate.parentMemberId === member.id
      && candidate.status !== 'archived'
      && candidate.status !== 'released',
  )
  if (children.length > 0) {
    fail(ERROR_CODES.CONFLICT, '成员还有未归档/未释放的子成员，先处理子成员再归档', {
      details: { memberId: member.id, childMemberIds: children.map((child) => child.id) },
    })
  }

  const activeAttempts = [...state.attempts.values()].filter(
    (attempt) => attempt.memberId === member.id && attempt.status === 'active',
  )
  const drain = input.drain ?? 'wait'
  if (activeAttempts.length > 0 && drain === 'wait') {
    fail(ERROR_CODES.CONFLICT, '成员还有进行中的尝试，等这一轮结束，或选择「先暂停再归档」', {
      details: { memberId: member.id, attemptIds: activeAttempts.map((attempt) => attempt.id) },
    })
  }

  const drafts: DraftEvent[] = []
  let revision = member.revision
  // 「先暂停再归档」是两条事件：先落 paused（可解释的中间态），再落 archived。
  if (activeAttempts.length > 0 && drain === 'pause' && member.status !== 'paused') {
    revision += 1
    drafts.push({
      type: 'member.status.changed',
      actor: input.actor,
      entity: { kind: 'member', id: member.id, teamId: team.id },
      entityRevision: revision,
      payload: { teamId: team.id, memberId: member.id, status: 'paused', revision },
    })
  }
  revision += 1
  drafts.push({
    type: 'member.archived',
    actor: input.actor,
    entity: { kind: 'member', id: member.id, teamId: team.id },
    entityRevision: revision,
    payload: { teamId: team.id, memberId: member.id, revision, pausedFirst: drafts.length > 0 },
  })
  return runtime.commit(drafts)
}

/**
 * 恢复归档成员（`archived → active`，落 `member.status.changed`）。
 *
 * 只有归档能恢复：`released` 是终态，`released → active` 不在迁移表里，会在这里被
 * `assertMemberStatusChange` 拒掉。这是「归档可回放、释放不可」这条差异的实际落点。
 *
 * 恢复不碰会话：`memberSessionGeneration` 不变，旧 generation 的写入继续被拒（归档期间
 * 会话已结束，恢复也不会让旧 attemptId 复活）。要重新上线接活，由队长另行绑会话。
 */
export function restoreMemberCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; teamId: string; memberId: string },
): CommitResult {
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  authorize('member.archive', input.actor, { teamId: input.teamId })
  assertTeamActive(team)

  const member = state.members.get(input.memberId)
  if (member === undefined || member.teamId !== input.teamId) {
    fail(ERROR_CODES.NOT_FOUND, '成员不存在', { details: { memberId: input.memberId, teamId: input.teamId } })
  }
  // 只有 archived 能被恢复；其它状态在这里统一报 INVALID_TRANSITION。
  if (member.status !== 'archived') {
    fail(ERROR_CODES.INVALID_TRANSITION, `只有已归档的成员能恢复（当前 ${member.status}）`, {
      details: { memberId: member.id, from: member.status },
    })
  }
  assertMemberStatusChange(member.status, 'active')

  const revision = member.revision + 1
  const draft: DraftEvent = {
    type: 'member.status.changed',
    actor: input.actor,
    entity: { kind: 'member', id: member.id, teamId: team.id },
    entityRevision: revision,
    payload: { teamId: team.id, memberId: member.id, status: 'active', revision },
  }
  return runtime.commit([draft])
}

export function releaseMemberCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; teamId: string; memberId: string },
): CommitResult {
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  authorize('member.release', input.actor, { teamId: input.teamId })
  assertTeamActive(team)

  const member = state.members.get(input.memberId)
  if (member === undefined || member.teamId !== input.teamId) {
    fail(ERROR_CODES.NOT_FOUND, '成员不存在', { details: { memberId: input.memberId, teamId: input.teamId } })
  }
  assertMemberStatusChange(member.status, 'released')

  const activeAttempts = [...state.attempts.values()].filter(
    (attempt) => attempt.memberId === member.id && attempt.status === 'active',
  )
  if (activeAttempts.length > 0) {
    fail(ERROR_CODES.CONFLICT, '成员还有进行中的尝试，先收尾或取消再释放', {
      details: { memberId: member.id, attemptIds: activeAttempts.map((attempt) => attempt.id) },
    })
  }

  const revision = member.revision + 1
  const draft: DraftEvent = {
    type: 'member.released',
    actor: input.actor,
    entity: { kind: 'member', id: member.id, teamId: team.id },
    entityRevision: revision,
    payload: { teamId: team.id, memberId: member.id, revision },
  }
  return runtime.commit([draft])
}
