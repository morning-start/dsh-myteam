/**
 * 可复用定义用例：角色 / 工作流 / 蓝图的建立与修订。
 *
 * 三者都是跨项目复用的定义资产，修订同样走「带 expectedRevision 的保存命令」，
 * 避免并发编辑互相覆盖。由 {@link ../commands.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { normalizeRole, roleContentHash, validateRole } from '../../domain/definitions/role.ts'
import { normalizeWorkflow, validateWorkflow, workflowContentHash } from '../../domain/definitions/workflow.ts'
import { blueprintContentHash, normalizeBlueprint, validateBlueprint } from '../../domain/definitions/blueprint.ts'
import { authorize } from '../../domain/permissions/policy.ts'
import type { CapabilitySet, CompletionRule, ConfigOverrides, FormationSlot, RoleDefinition, TaskTemplate, TeamBlueprint, WorkflowDefinition } from '../../contracts/entities.ts'
import type { ActorRef } from '../../contracts/events.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from '../project-runtime.ts'

export function createProjectRole(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    profile: RoleDefinition['profile']
    capabilities: CapabilitySet
  },
): CommitResult {
  authorize('definition.write', input.actor)
  const now = runtime.now()
  const id = runtime.nextId('role')
  const role: RoleDefinition = normalizeRole({
    id,
    revision: 1,
    profile: input.profile,
    capabilities: input.capabilities,
    createdAt: now,
    updatedAt: now,
  })
  const problems = validateRole(role)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '角色定义不合法', { details: { problems } })
  }
  const draft: DraftEvent = {
    type: 'definition.role.created',
    actor: input.actor,
    entity: { kind: 'role-definition', id },
    entityRevision: 1,
    payload: { role, origin: null },
  }
  return runtime.commit([draft])
}

/**
 * 保存（修订）已存在的项目角色定义：revision 递增，`previousHash` 记旧内容哈希。
 *
 * 为什么要有：创建命令与 `definition.role.revised` 事件、投影都早就存在，但没有任何命令
 * 能发出它 —— 设计稿的「编辑角色」屏因此没有可调的能力（只能新建，不能改）。
 */
export function saveProjectRole(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; id: string; profile: RoleDefinition['profile']; capabilities: CapabilitySet },
): CommitResult {
  authorize('definition.write', input.actor)
  const existing = runtime.state.roles.get(input.id)
  if (existing === undefined) fail(ERROR_CODES.NOT_FOUND, '角色定义不存在', { details: { roleId: input.id } })
  const role: RoleDefinition = normalizeRole({
    id: existing.id,
    revision: existing.revision + 1,
    profile: input.profile,
    capabilities: input.capabilities,
    createdAt: existing.createdAt,
    updatedAt: runtime.now(),
  })
  const problems = validateRole(role)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '角色定义不合法', { details: { problems } })
  }
  const draft: DraftEvent = {
    type: 'definition.role.revised',
    actor: input.actor,
    entity: { kind: 'role-definition', id: role.id },
    entityRevision: role.revision,
    payload: { role, previousHash: roleContentHash(existing) },
  }
  return runtime.commit([draft])
}

/** 保存（修订）已存在的工作流定义；语义同 {@link saveProjectRole}。 */
export function saveProjectWorkflowCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    id: string
    name: string
    description: string
    templates: TaskTemplate[]
    completion?: CompletionRule
  },
): CommitResult {
  authorize('definition.write', input.actor)
  const existing = runtime.state.workflows.get(input.id)
  if (existing === undefined) fail(ERROR_CODES.NOT_FOUND, '工作流定义不存在', { details: { workflowId: input.id } })
  const workflow: WorkflowDefinition = normalizeWorkflow({
    id: existing.id,
    revision: existing.revision + 1,
    name: input.name,
    description: input.description,
    templates: input.templates,
    completion: input.completion ?? existing.completion,
    createdAt: existing.createdAt,
    updatedAt: runtime.now(),
  })
  const problems = validateWorkflow(workflow)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '工作流定义不合法', { details: { problems } })
  }
  const draft: DraftEvent = {
    type: 'definition.workflow.revised',
    actor: input.actor,
    entity: { kind: 'workflow-definition', id: workflow.id },
    entityRevision: workflow.revision,
    payload: { workflow, previousHash: workflowContentHash(existing) },
  }
  return runtime.commit([draft])
}

/** 蓝图的引用解析器：只认项目里已有的角色/工作流（引用断裂必须阻断，不能猜）。 */
function blueprintResolvers(runtime: ProjectRuntime): {
  resolveRole: (roleId: string) => { revision: number } | undefined
  resolveWorkflow: (workflowId: string) => { revision: number } | undefined
} {
  return {
    resolveRole: (roleId) => runtime.state.roles.get(roleId),
    resolveWorkflow: (workflowId) => runtime.state.workflows.get(workflowId),
  }
}

/**
 * 新建项目蓝图（队形 × 引用 + 引用的工作流 + 默认配置覆盖）。
 *
 * 为什么要有：事件类型（`definition.blueprint.created`）和投影早就支持蓝图，
 * 但**一直没有命令能发出它** —— 于是「从蓝图建团队」只有内置蓝图能用，人类既建不了
 * 也改不了自己的蓝图（设计稿 g-blueprint-edit 因此点不动）。
 */
export function createProjectBlueprint(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    name: string
    description: string
    formation: FormationSlot[]
    workflows: string[]
    defaults: ConfigOverrides
  },
): CommitResult {
  authorize('definition.write', input.actor)
  const now = runtime.now()
  const blueprint: TeamBlueprint = normalizeBlueprint({
    id: runtime.nextId('blueprint'),
    revision: 1,
    name: input.name,
    description: input.description,
    formation: input.formation,
    workflows: input.workflows,
    defaults: input.defaults,
    createdAt: now,
    updatedAt: now,
  })
  const { resolveRole, resolveWorkflow } = blueprintResolvers(runtime)
  const problems = validateBlueprint(blueprint, resolveRole, resolveWorkflow)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图不合法', { details: { problems } })
  }
  const draft: DraftEvent = {
    type: 'definition.blueprint.created',
    actor: input.actor,
    entity: { kind: 'blueprint-definition', id: blueprint.id },
    entityRevision: 1,
    payload: { blueprint, origin: null },
  }
  return runtime.commit([draft])
}

/** 保存（修订）已存在的项目蓝图；语义同 {@link saveProjectRole}。 */
export function saveProjectBlueprintCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    id: string
    name: string
    description: string
    formation: FormationSlot[]
    workflows: string[]
    defaults: ConfigOverrides
  },
): CommitResult {
  authorize('definition.write', input.actor)
  const existing = runtime.state.blueprints.get(input.id)
  if (existing === undefined) fail(ERROR_CODES.NOT_FOUND, '蓝图不存在', { details: { blueprintId: input.id } })
  const blueprint: TeamBlueprint = normalizeBlueprint({
    id: existing.id,
    revision: existing.revision + 1,
    name: input.name,
    description: input.description,
    formation: input.formation,
    workflows: input.workflows,
    defaults: input.defaults,
    createdAt: existing.createdAt,
    updatedAt: runtime.now(),
  })
  const { resolveRole, resolveWorkflow } = blueprintResolvers(runtime)
  const problems = validateBlueprint(blueprint, resolveRole, resolveWorkflow)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图不合法', { details: { problems } })
  }
  const draft: DraftEvent = {
    type: 'definition.blueprint.revised',
    actor: input.actor,
    entity: { kind: 'blueprint-definition', id: blueprint.id },
    entityRevision: blueprint.revision,
    payload: { blueprint, previousHash: blueprintContentHash(existing) },
  }
  return runtime.commit([draft])
}

export function createProjectWorkflowCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    name: string
    description: string
    templates: TaskTemplate[]
    completion?: CompletionRule
  },
): CommitResult {
  authorize('definition.write', input.actor)
  const now = runtime.now()
  const workflow: WorkflowDefinition = normalizeWorkflow({
    id: runtime.nextId('workflow'),
    revision: 1,
    name: input.name,
    description: input.description,
    templates: input.templates,
    completion: input.completion ?? { mode: 'all-tasks', requiredKeys: [] },
    createdAt: now,
    updatedAt: now,
  })
  const problems = validateWorkflow(workflow)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '工作流定义不合法', { details: { problems } })
  }

  const draft: DraftEvent = {
    type: 'definition.workflow.created',
    actor: input.actor,
    entity: { kind: 'workflow-definition', id: workflow.id },
    entityRevision: 1,
    payload: { workflow, origin: null },
  }
  return runtime.commit([draft])
}
