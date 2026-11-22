/**
 * 角色定义：RoleProfile + CapabilitySet。
 *
 * 三条不可让渡的规则（docs/architecture/03 §3、01 §3.4）：
 *   1. 能力只收窄。子成员的工具集必须是父成员有效工具集的子集；
 *   2. deny 优先，且不能被下层「重新打开」；
 *   3. 内容 hash 走规范化 JSON，所以「同一角色」在项目、全局与迁移三条路径上
 *      指纹一致；修订是否真的变化，由 hash 判断，而不是调用方声称。
 *
 * 这里不生成 id、不读时间：定义内容是输入，hash 是输出。
 */
import type { CapabilityPolicy, CapabilitySet, RoleDefinition, RoleProfile, SkillRef } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { hashContent } from '../../contracts/json.ts'

/** 通配符：显式授予「上层允许的全部」。空 allow 表示没有任何工具，不表示全部。 */
export const TOOL_WILDCARD = '*'

function normalizedList(values: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length > 0) seen.add(trimmed)
  }
  return [...seen].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function normalizePolicy(policy: CapabilityPolicy): CapabilityPolicy {
  return { allow: normalizedList(policy.allow), deny: normalizedList(policy.deny) }
}

function normalizeSkills(skills: readonly SkillRef[]): SkillRef[] {
  const byId = new Map<string, SkillRef>()
  for (const skill of skills) {
    const skillId = skill.skillId.trim()
    if (skillId.length === 0) continue
    const normalized: SkillRef = { skillId }
    if (skill.name !== undefined && skill.name.trim().length > 0) normalized.name = skill.name.trim()
    if (skill.version !== undefined && skill.version.trim().length > 0) normalized.version = skill.version.trim()
    if (skill.hash !== undefined && skill.hash.trim().length > 0) normalized.hash = skill.hash.trim()
    const existing = byId.get(skillId)
    // 同一 skillId 出现多次时保留更具体的版本引用，而不是让后写的静默覆盖。
    if (existing === undefined || (existing.version === undefined && normalized.version !== undefined)) {
      byId.set(skillId, normalized)
    }
  }
  return [...byId.values()].sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0))
}

export function normalizeRoleProfile(profile: RoleProfile): RoleProfile {
  return {
    name: profile.name.trim(),
    purpose: profile.purpose.trim(),
    instructions: profile.instructions.trim(),
    specialties: normalizedList(profile.specialties),
  }
}

export function normalizeCapabilities(capabilities: CapabilitySet): CapabilitySet {
  return {
    tools: normalizePolicy(capabilities.tools),
    mcp: normalizePolicy(capabilities.mcp),
    skills: normalizeSkills(capabilities.skills),
  }
}

export function normalizeRole(role: RoleDefinition): RoleDefinition {
  return {
    ...role,
    profile: normalizeRoleProfile(role.profile),
    capabilities: normalizeCapabilities(role.capabilities),
  }
}

/** 角色内容 hash：只含「是什么」，不含 revision/时间戳（它们不是内容）。 */
export function roleContentHash(role: RoleDefinition): string {
  const normalized = normalizeRole(role)
  return hashContent({ profile: normalized.profile, capabilities: normalized.capabilities })
}

export function validateRole(role: RoleDefinition): string[] {
  const problems: string[] = []
  const profile = normalizeRoleProfile(role.profile)
  if (profile.name.length === 0) problems.push('角色名称不能为空')
  if (profile.purpose.length === 0) problems.push('角色目的不能为空')
  if (profile.instructions.length === 0) problems.push('角色指令不能为空')

  const capabilities = normalizeCapabilities(role.capabilities)
  for (const name of capabilities.tools.allow) {
    if (name !== TOOL_WILDCARD && capabilities.tools.deny.includes(name)) {
      problems.push(`工具 ${name} 同时出现在 allow 与 deny`)
    }
  }
  for (const name of capabilities.mcp.allow) {
    if (name !== TOOL_WILDCARD && capabilities.mcp.deny.includes(name)) {
      problems.push(`MCP ${name} 同时出现在 allow 与 deny`)
    }
  }
  return problems
}

/**
 * 父层的有效授权判定。
 *
 * 不能用「枚举父 allow 里的名字」来实现：`*` 表示全集，而领域层没有「全部
 * 工具名」的清单（工具由 DSH 注册，随时可变）。因此按谓词判断：`*` 视为
 * 「除 deny 之外全允许」，具体名字逐个查。
 */
function policyAllows(policy: CapabilityPolicy, name: string): boolean {
  if (policy.deny.includes(name)) return false
  if (policy.allow.includes(TOOL_WILDCARD)) return true
  return policy.allow.includes(name)
}

export interface NarrowedCapabilities {
  capabilities: CapabilitySet
  /** 被上层拒绝或未授权而剔除的条目，用于面板解释「为什么这个成员没有某工具」。 */
  dropped: { tools: string[]; mcp: string[]; skills: string[] }
}

/**
 * 把子成员声明收窄到父成员的有效能力内。
 *
 * 语义：
 *   - 父有效集按谓词判定：deny 命中即拒绝，`*` 视为其余全允许；
 *   - 子请求越出父有效集 → 抛 CAPABILITY_ESCALATION（这是配置错误或越权，
 *     不能静默裁剪成「碰巧能用」）；
 *   - 结果 deny = 父 deny ∪ 子 deny（下层只能加不能减）；
 *   - 子请求 `*` 时结果保留 `*`（父也必须是 `*` 才可能通过）；
 *   - 子 skills 必须是父 skills 的子集，版本/hash 只能收紧不能改指。
 *
 * 空 allow 表示「没有任何工具」。想要继承父集请写 `['*']`——把「没写」和
 * 「全都要」区分开，是为了避免漏配一次就得到全部工具。
 */
export function narrowCapabilities(parent: CapabilitySet, child: CapabilitySet): NarrowedCapabilities {
  const parentNormalized = normalizeCapabilities(parent)
  const childNormalized = normalizeCapabilities(child)

  const escalation: string[] = []
  const grantedTools: string[] = []
  const droppedTools: string[] = []

  for (const tool of childNormalized.tools.allow) {
    if (tool === TOOL_WILDCARD) {
      if (!parentNormalized.tools.allow.includes(TOOL_WILDCARD)) {
        escalation.push('通配符 * 只在上层也使用 * 时才可继承')
      }
      continue
    }
    if (policyAllows(parentNormalized.tools, tool)) {
      grantedTools.push(tool)
    } else if (parentNormalized.tools.deny.includes(tool)) {
      escalation.push(`工具 ${tool} 已被上层显式拒绝`)
    } else {
      escalation.push(`工具 ${tool} 不在父成员授权范围内`)
    }
  }
  for (const tool of childNormalized.tools.deny) {
    if (parentNormalized.tools.deny.includes(tool)) droppedTools.push(tool)
  }

  const grantedMcp: string[] = []
  for (const server of childNormalized.mcp.allow) {
    if (server === TOOL_WILDCARD) {
      if (!parentNormalized.mcp.allow.includes(TOOL_WILDCARD)) {
        escalation.push('MCP 通配符 * 只在上层也使用 * 时才可继承')
      }
      continue
    }
    if (policyAllows(parentNormalized.mcp, server)) {
      grantedMcp.push(server)
    } else if (parentNormalized.mcp.deny.includes(server)) {
      escalation.push(`MCP ${server} 已被上层显式拒绝`)
    } else {
      escalation.push(`MCP ${server} 不在父成员授权范围内`)
    }
  }

  const parentSkills = new Map(parentNormalized.skills.map((skill) => [skill.skillId, skill]))
  const grantedSkills: SkillRef[] = []
  const droppedSkills: string[] = []
  for (const skill of childNormalized.skills) {
    const owned = parentSkills.get(skill.skillId)
    if (owned === undefined) {
      escalation.push(`技能 ${skill.skillId} 不在父成员授权范围内`)
      continue
    }
    if (owned.version !== undefined && skill.version !== undefined && owned.version !== skill.version) {
      escalation.push(`技能 ${skill.skillId} 版本 ${skill.version} 与父成员 ${owned.version} 不一致`)
      continue
    }
    if (owned.hash !== undefined && skill.hash !== undefined && owned.hash !== skill.hash) {
      escalation.push(`技能 ${skill.skillId} hash 与父成员不一致`)
      continue
    }
    grantedSkills.push(skill)
  }

  if (escalation.length > 0) {
    fail(ERROR_CODES.CAPABILITY_ESCALATION, '子成员能力只能收窄，不能超出父成员授权', {
      details: { escalation },
    })
  }

  const keepToolWildcard = childNormalized.tools.allow.includes(TOOL_WILDCARD)
  const keepMcpWildcard = childNormalized.mcp.allow.includes(TOOL_WILDCARD)

  const result: CapabilitySet = {
    tools: {
      allow: normalizedList([...(keepToolWildcard ? [TOOL_WILDCARD] : []), ...grantedTools]),
      deny: normalizedList([...parentNormalized.tools.deny, ...childNormalized.tools.deny]),
    },
    mcp: {
      allow: normalizedList([...(keepMcpWildcard ? [TOOL_WILDCARD] : []), ...grantedMcp]),
      deny: normalizedList([...parentNormalized.mcp.deny, ...childNormalized.mcp.deny]),
    },
    skills: normalizeSkills(grantedSkills),
  }

  return {
    capabilities: result,
    dropped: { tools: normalizedList(droppedTools), mcp: [], skills: normalizedList(droppedSkills) },
  }
}

/** 工具可见性查询（体验层）；安全边界仍由应用服务鉴权。 */
export function allowsTool(capabilities: CapabilitySet, toolName: string): boolean {
  const normalized = normalizeCapabilities(capabilities)
  if (normalized.tools.deny.includes(toolName)) return false
  if (normalized.tools.allow.includes(TOOL_WILDCARD)) return true
  return normalized.tools.allow.includes(toolName)
}

export function allowsMcpServer(capabilities: CapabilitySet, serverName: string): boolean {
  const normalized = normalizeCapabilities(capabilities)
  if (normalized.mcp.deny.includes(serverName)) return false
  if (normalized.mcp.allow.includes(TOOL_WILDCARD)) return true
  return normalized.mcp.allow.includes(serverName)
}