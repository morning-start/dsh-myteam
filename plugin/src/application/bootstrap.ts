/**
 * 项目引导：新建项目时补上「项目已创建 + 内置角色」这两步。
 *
 * 为什么需要：v2 的 RoleDefinition 是独立资产，空项目里没有任何角色，
 * 队长连成员都聘不了（`appoint_member` 找不到 roleId）。宿主在首次打开
 * 空项目时做一次初始化，让「建队 → 聘人」这条链从第一天就能走。
 *
 * 幂等：只在 `seq === 0` 时初始化项目；只在没有任何角色时补内置角色。
 * 迁移来的项目已有事件与角色，不会被覆盖。
 */
import type { ActorRef } from '../contracts/events.ts'
import type { CapabilitySet, RoleDefinition } from '../contracts/entities.ts'
import { createProjectRole, initializeProject } from './commands.ts'
import type { ProjectRuntime } from './project-runtime.ts'

/**
 * 引导动作以宿主身份记账：项目第一次打开时还没有人类用户在场，
 * 用一个明确的、可审计的非人格身份，而不是伪造某个用户。
 */
export const HOST_BOOTSTRAP_ACTOR: ActorRef = { kind: 'human', userId: 'dsh-host', via: 'host' }

interface BuiltinRole {
  profile: RoleDefinition['profile']
  capabilities: CapabilitySet
}

/** 内置角色：只给最小能力，具体项目可以再定义更细的角色。 */
export const BUILTIN_ROLES: BuiltinRole[] = [
  {
    profile: { name: '实现者', purpose: '按验收标准完成实现', instructions: '先读任务与验收标准，再动手；提交前附证据。', specialties: [] },
    capabilities: {
      tools: { allow: ['read', 'write', 'edit', 'pwsh', 'bash'], deny: [] },
      mcp: { allow: [], deny: [] },
      skills: [],
    },
  },
  {
    profile: { name: '审查者', purpose: '独立复核实现与证据', instructions: '按验收标准逐条核对，指出缺口而不是重写。', specialties: [] },
    capabilities: {
      tools: { allow: ['read', 'pwsh', 'bash'], deny: ['write', 'edit'] },
      mcp: { allow: [], deny: [] },
      skills: [],
    },
  },
]

function projectNameOf(rootDir: string): string {
  const parts = rootDir.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length === 0 ? 'project' : parts[parts.length - 1]!
}

export function bootstrapProject(runtime: ProjectRuntime, rootDir: string): { initialized: boolean; seededRoles: number } {
  let initialized = false
  if (runtime.state.seq === 0) {
    initializeProject(runtime, { actor: HOST_BOOTSTRAP_ACTOR, name: projectNameOf(rootDir) })
    initialized = true
  }

  let seededRoles = 0
  if (runtime.state.roles.size === 0) {
    for (const role of BUILTIN_ROLES) {
      createProjectRole(runtime, { actor: HOST_BOOTSTRAP_ACTOR, profile: role.profile, capabilities: role.capabilities })
      seededRoles += 1
    }
  }
  return { initialized, seededRoles }
}