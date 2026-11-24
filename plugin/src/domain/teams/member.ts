/**
 * 成员聘任与生命周期（纯规则）。
 *
 * Member 是项目事件里的聘任关系，DSH subagent 只是执行载体。因此：
 *   - 聘任时固化 RoleSnapshot，之后改 RoleDefinition 不影响既有成员；
 *   - 成员能力 = 父成员有效能力收窄后的结果（无父成员时直接取角色能力），
 *     收窄失败即拒绝聘任，不做「先建了再说」；
 *   - 会话可以被释放、换绑，Member 与记忆不随 live handle 消失；
 *   - `memberSessionGeneration` 只增不减：旧 generation 的消息与写入不得进入
 *     新的任期。
 */
import type { CapabilitySet, Member, MemberStatus, RoleDefinition } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { narrowCapabilities, normalizeCapabilities } from '../definitions/role.ts'

/**
 * 成员状态迁移。`archived` 是「退役但可回放」：可恢复成 active，也可再走 released 彻底离开。
 * 反过来 `released` 是终态，什么都不出（出边为空）。
 */
const MEMBER_TRANSITIONS: Readonly<Record<MemberStatus, readonly MemberStatus[]>> = {
  appointed: ['active', 'archived', 'released'],
  active: ['paused', 'archived', 'released'],
  paused: ['active', 'archived', 'released'],
  archived: ['active', 'released'],
  released: [],
}

export function canChangeMemberStatus(from: MemberStatus, to: MemberStatus): boolean {
  return (MEMBER_TRANSITIONS[from] ?? []).includes(to)
}

export function assertMemberStatusChange(from: MemberStatus, to: MemberStatus): void {
  if (!canChangeMemberStatus(from, to)) {
    fail(ERROR_CODES.INVALID_TRANSITION, `成员状态不能从 ${from} 变为 ${to}`, { details: { from, to } })
  }
}

export interface AppointMemberInput {
  id: string
  teamId: string
  role: RoleDefinition
  parent: Member | null
  sessionId: string | null
  now: string
  /** 角色快照可显式指定（迁移场景保留旧快照）；默认取当前角色。 */
  roleSnapshot?: RoleDefinition
}

export interface AppointMemberResult {
  member: Member
  dropped: { tools: string[]; mcp: string[]; skills: string[] }
}

/**
 * 聘任成员。
 *
 * 能力计算：有父成员时对父成员**生效能力**收窄；无父成员时直接使用角色的
 * 能力。角色里声明了父成员不拥有的工具会在这里抛 CAPABILITY_ESCALATION。
 */
export function appointMember(input: AppointMemberInput): AppointMemberResult {
  const snapshot = input.roleSnapshot ?? input.role
  const declared = normalizeCapabilities(input.role.capabilities)
  const narrowed =
    input.parent === null
      ? { capabilities: declared, dropped: { tools: [], mcp: [], skills: [] } }
      : narrowCapabilities(input.parent.capabilities, declared)

  const member: Member = {
    id: input.id,
    teamId: input.teamId,
    roleId: input.role.id,
    roleRevision: input.role.revision,
    roleSnapshot: snapshot,
    parentMemberId: input.parent?.id ?? null,
    status: input.sessionId === null ? 'appointed' : 'active',
    sessionId: input.sessionId,
    memberSessionGeneration: input.sessionId === null ? 0 : 1,
    capabilities: narrowed.capabilities,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }

  return { member, dropped: narrowed.dropped }
}

/** 成员在组织树里的深度：根成员为 1。 */
export function memberDepth(member: Member, byId: ReadonlyMap<string, Member>): number {
  let depth = 1
  let current: Member | undefined = member
  const seen = new Set<string>([member.id])
  while (current?.parentMemberId !== null && current?.parentMemberId !== undefined) {
    const parent = byId.get(current.parentMemberId)
    if (parent === undefined) break
    if (seen.has(parent.id)) {
      fail(ERROR_CODES.CONFLICT, '成员父子关系存在环', { details: { memberId: member.id } })
    }
    seen.add(parent.id)
    depth += 1
    current = parent
  }
  return depth
}

export interface MemberLimitInput {
  existingMembers: number
  depth: number
  parentChildren: number
  config: { maxMembers: number; maxMemberDepth: number; maxChildrenPerMember: number }
}

/** 聘任前校验数量/深度/子数上限。超限拒绝，不自动裁剪组织树。 */
export function assertMemberLimits(input: MemberLimitInput): void {
  const problems: string[] = []
  if (input.existingMembers + 1 > input.config.maxMembers) {
    problems.push(`团队人数上限为 ${input.config.maxMembers}`)
  }
  if (input.depth > input.config.maxMemberDepth) {
    problems.push(`成员层级上限为 ${input.config.maxMemberDepth}`)
  }
  if (input.parentChildren + 1 > input.config.maxChildrenPerMember) {
    problems.push(`单个成员的下属上限为 ${input.config.maxChildrenPerMember}`)
  }
  if (problems.length > 0) {
    fail(ERROR_CODES.PRECONDITION_FAILED, '成员聘任超出团队配置上限', { details: { problems } })
  }
}

/**
 * 绑定/换绑会话。
 *
 * `memberSessionGeneration + 1`：换绑不是「改个字段」，它让旧会话的迟到消息
 * 因 generation 陈旧而被拒。重复绑定同一个 sessionId 直接拒绝，避免面板
 * 连点两次把 generation 推高、把正常消息误判为陈旧。
 */
export function bindMemberSession(member: Member, sessionId: string, now: string): Member {
  if (member.status === 'released') {
    fail(ERROR_CODES.MEMBER_NOT_ACTIVE, '已释放的成员不能再绑定会话', { details: { memberId: member.id } })
  }
  if (member.sessionId === sessionId) {
    fail(ERROR_CODES.CONFLICT, '该会话已经绑定到这个成员', { details: { memberId: member.id, sessionId } })
  }
  return {
    ...member,
    sessionId,
    memberSessionGeneration: member.memberSessionGeneration + 1,
    status: member.status === 'appointed' ? 'active' : member.status,
    revision: member.revision + 1,
    updatedAt: now,
  }
}

export function changeMemberStatus(member: Member, status: MemberStatus, now: string): Member {
  assertMemberStatusChange(member.status, status)
  return { ...member, status, revision: member.revision + 1, updatedAt: now }
}

/** 成员可接收新任务的条件：在册且未被暂停/释放。 */
/**
 * 成员能不能接新活。三个状态不能：已释放（终态）、已暂停、**已归档**（退役但可回放，
 * 回放的是历史，不是派人接活）。`appointed`（聘任了还没绑会话）留在这里放行，
 * 由会话绑定那层再拒——那是「还没上线」，不是「已退役」。
 */
export function assertMemberActive(member: Member): void {
  if (member.status === 'released' || member.status === 'paused' || member.status === 'archived') {
    fail(ERROR_CODES.MEMBER_NOT_ACTIVE, `成员状态为 ${member.status}，不能接收新任务`, {
      details: { memberId: member.id, status: member.status },
    })
  }
}

/** 会话绑定一致性：成员收到的消息必须带当前 memberSessionGeneration。 */
export function assertSessionGeneration(member: Member, sessionId: string, generation: number): void {
  if (member.sessionId !== sessionId || member.memberSessionGeneration !== generation) {
    fail(ERROR_CODES.SESSION_LOST, '成员会话绑定已变化，旧会话写入被拒绝', {
      details: {
        memberId: member.id,
        expectedSessionId: member.sessionId,
        expectedGeneration: member.memberSessionGeneration,
        providedSessionId: sessionId,
        providedGeneration: generation,
      },
    })
  }
}

/** 成员的有效能力（聘任时已收窄，这里只做只读暴露，防止调用方拿到可变引用）。 */
export function memberCapabilities(member: Member): CapabilitySet {
  return {
    tools: { allow: [...member.capabilities.tools.allow], deny: [...member.capabilities.tools.deny] },
    mcp: { allow: [...member.capabilities.mcp.allow], deny: [...member.capabilities.mcp.deny] },
    skills: member.capabilities.skills.map((skill) => ({ ...skill })),
  }
}