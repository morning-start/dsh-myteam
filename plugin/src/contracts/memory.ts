/**
 * 记忆 bank 的命名规则（纯字符串，无 IO）。
 *
 * 团队 bank 与成员私有 bank **不共用命名空间**：`team:<id>` 是公开的团队记忆，
 * `team:<id>:member:<mid>` 是成员私有记忆。前缀重叠是刻意的（便于按团队
 * 枚举），但解析时必须按完整前缀判断，不能只 `startsWith('team:')`。
 */

export function teamBankId(teamId: string): string {
  return `team:${teamId}`
}

export function memberBankId(teamId: string, memberId: string): string {
  return `team:${teamId}:member:${memberId}`
}

export function bankBelongsTo(bankId: string, teamId: string): boolean {
  return bankId === teamBankId(teamId) || bankId.startsWith(`team:${teamId}:member:`)
}

/** 从 bank id 解析归属；格式不认识返回 null（调用方据此拒绝，不猜）。 */
export function parseBankId(bankId: string): { teamId: string; memberId: string | null } | null {
  const memberPrefix = 'team:'
  if (!bankId.startsWith(memberPrefix)) return null
  const rest = bankId.slice(memberPrefix.length)
  const marker = ':member:'
  const index = rest.indexOf(marker)
  if (index === -1) {
    return rest.length === 0 ? null : { teamId: rest, memberId: null }
  }
  const teamId = rest.slice(0, index)
  const memberId = rest.slice(index + marker.length)
  if (teamId.length === 0 || memberId.length === 0) return null
  return { teamId, memberId }
}