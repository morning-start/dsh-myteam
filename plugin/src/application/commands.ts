/**
 * 项目用例（命令层）：只做「解析意图 → 领域校验 → 产出事件」。
 *
 * 这里没有文件、没有 DSH、没有面板协议；同一个函数被队长工具、面板 RPC 和
 * 测试调用，因此三者不可能出现「面板能建、工具不能建」这种分叉。
 */
import type {
  Attempt,
  CapabilitySet,
  CompletionRule,
  ConfigOverrides,
  RoleDefinition,
  Task,
  TaskTemplate,
  WorkflowDefinition,
} from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import { computeEffectiveConfig, DEFAULT_TEAM_CONFIG } from '../domain/config/merge.ts'
import { normalizeRole, validateRole } from '../domain/definitions/role.ts'
import { normalizeWorkflow, validateWorkflow } from '../domain/definitions/workflow.ts'
import { assertBlueprintResolvable } from '../domain/definitions/blueprint.ts'
import { authorize } from '../domain/permissions/policy.ts'
import { cycleIfEdgesChanged, graphOf } from '../domain/tasks/dag.ts'
import { assertCurrentAttempt, createPlannedTask, isClaimable } from '../domain/tasks/task.ts'
import { appointMember, assertMemberActive, assertMemberLimits, assertMemberStatusChange, memberDepth } from '../domain/teams/member.ts'
import { assertGraphRevision, assertTeamActive, assertTeamStatusChange, createTeam } from '../domain/teams/team.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'

export function initializeProject(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; name: string },
): CommitResult {
  if (runtime.state.seq !== 0) {
    fail(ERROR_CODES.ALREADY_EXISTS, '项目已经初始化，不能重复初始化')
  }
  if (input.actor.kind === 'member') {
    fail(ERROR_CODES.FORBIDDEN, '成员不能初始化项目')
  }
  const now = runtime.now()
  const draft: DraftEvent = {
    type: 'project.initialized',
    actor: input.actor,
    entity: { kind: 'project', id: runtime.projectId },
    payload: { name: input.name.trim(), createdAt: now },
  }
  return runtime.commit([draft])
}

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

export function createTeamCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    name: string
    goal: string
    captainSessionId: string
    blueprintId?: string
    overrides?: ConfigOverrides
  },
): CommitResult {
  authorize('team.create', input.actor)
  const state = runtime.state
  const now = runtime.now()

  let blueprintDefaults: ConfigOverrides | null = null
  let blueprintRef: { id: string; revision: number } | null = null
  if (input.blueprintId !== undefined) {
    const blueprint = state.blueprints.get(input.blueprintId)
    if (blueprint === undefined) {
      fail(ERROR_CODES.NOT_FOUND, '蓝图不存在', { details: { blueprintId: input.blueprintId } })
    }
    assertBlueprintResolvable(
      blueprint,
      (roleId) => state.roles.get(roleId),
      (workflowId) => state.workflows.get(workflowId),
    )
    blueprintDefaults = blueprint.defaults
    blueprintRef = { id: blueprint.id, revision: blueprint.revision }
  }

  const configRevision = state.configRevision + 1
  const snapshot = computeEffectiveConfig({
    projectDefaults: state.configDefaults as ConfigOverrides,
    blueprintDefaults,
    teamOverrides: input.overrides ?? {},
    configRevision,
    sources: {
      projectDefaultsRevision: state.configRevision,
      blueprintRevision: blueprintRef?.revision ?? null,
      teamOverridesRevision: 1,
    },
  })

  const teamId = runtime.nextId('team')
  const team = createTeam({
    id: teamId,
    name: input.name,
    goal: input.goal,
    blueprint: blueprintRef,
    configRevision: snapshot.configRevision,
    now,
  })

  const drafts: DraftEvent[] = [
    {
      type: 'config.override.changed',
      actor: input.actor,
      entity: { kind: 'config', id: teamId, teamId },
      payload: { teamId, configRevision, overrides: input.overrides ?? {}, snapshot },
    },
    {
      type: 'team.created',
      actor: input.actor,
      entity: { kind: 'team', id: teamId },
      entityRevision: 1,
      configRevision,
      payload: {
        team,
        captain: { sessionId: input.captainSessionId, generation: 1 },
        formation: [],
      },
    },
  ]

  return runtime.commit(drafts)
}

export function createTaskCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    title: string
    description: string
    acceptance: string[]
    ownerTeamId: string
    dependencies?: string[]
    requiredRoleId?: string | null
    gate?: { commands: string[]; requireEvidence: boolean; requireArtifacts: boolean }
    deliverable?: { paths: string[]; description: string } | null
  },
): CommitResult {
  authorize('task.create', input.actor, { teamId: input.ownerTeamId })
  const state = runtime.state
  const team = state.teams.get(input.ownerTeamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '主责团队不存在', { details: { teamId: input.ownerTeamId } })
  }
  assertTeamActive(team)

  const dependencies = [...new Set(input.dependencies ?? [])]
  for (const dependency of dependencies) {
    if (!state.tasks.has(dependency)) {
      fail(ERROR_CODES.NOT_FOUND, '依赖的任务不存在', { details: { taskId: dependency } })
    }
  }

  const taskId = runtime.nextId('task')
  const graph = graphOf([...state.tasks.values()].map((task) => [task.id, task.dependencies] as const))
  const cycle = cycleIfEdgesChanged(graph, taskId, dependencies)
  if (cycle !== null) {
    fail(ERROR_CODES.DEPENDENCY_CYCLE, '这次依赖会把任务图接成环', { details: { cycle } })
  }

  const now = runtime.now()
  const task = createPlannedTask({
    id: taskId,
    title: input.title,
    description: input.description,
    acceptance: input.acceptance,
    ownerTeamId: input.ownerTeamId,
    dependencies,
    requiredRoleId: input.requiredRoleId ?? null,
    gate: input.gate ?? { commands: [], requireEvidence: true, requireArtifacts: false },
    deliverable: input.deliverable ?? null,
    now,
  })
  // 没有依赖的任务在创建时就可以被认领；有依赖的先保持 planned。
  if (dependencies.length === 0) task.status = 'ready'

  const draft: DraftEvent = {
    type: 'task.created',
    actor: input.actor,
    entity: { kind: 'task', id: taskId, teamId: input.ownerTeamId },
    entityRevision: 1,
    configRevision: team.configRevision,
    payload: { task, graphRevision: state.graphRevision + 1 },
  }
  return runtime.commit([draft])
}

export function claimTaskCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    taskId: string
    memberId: string
    expectedGraphRevision?: number
  },
): CommitResult {
  const state = runtime.state
  const task = state.tasks.get(input.taskId)
  if (task === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '任务不存在', { details: { taskId: input.taskId } })
  }
  authorize('task.claim', input.actor, {
    teamId: task.ownerTeamId ?? undefined,
    memberId: input.memberId,
    attemptMemberId: input.memberId,
  })

  const team = task.ownerTeamId === null ? undefined : state.teams.get(task.ownerTeamId)
  if (input.expectedGraphRevision !== undefined) {
    assertGraphRevision(state.graphRevision, input.expectedGraphRevision)
  }
  if (!isClaimable(task.status)) {
    fail(ERROR_CODES.TASK_NOT_READY, `任务状态为 ${task.status}，当前不能认领`, {
      details: { taskId: task.id, status: task.status },
    })
  }

  const member = state.members.get(input.memberId)
  if (member === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '成员不存在', { details: { memberId: input.memberId } })
  }
  assertMemberActive(member)
  if (member.teamId !== task.ownerTeamId && !task.collaborators.some((item) => item.teamId === member.teamId)) {
    fail(ERROR_CODES.FORBIDDEN, '成员所属团队不是该任务的参与团队')
  }
  if (task.requiredRoleId !== null && task.requiredRoleId !== member.roleId) {
    fail(ERROR_CODES.FORBIDDEN, '成员角色与任务要求不符', {
      details: { requiredRoleId: task.requiredRoleId, memberRoleId: member.roleId },
    })
  }
  if (member.sessionId === null) {
    fail(ERROR_CODES.SESSION_LOST, '成员还没有可用的会话，不能认领任务')
  }
  if (task.attemptId !== null) {
    const current = state.attempts.get(task.attemptId)
    if (current !== undefined) assertCurrentAttempt(task, current)
  }

  const previousAttempts = [...state.attempts.values()].filter((attempt) => attempt.taskId === task.id)
  const generation = previousAttempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1

  const now = runtime.now()
  const attempt: Attempt = {
    id: runtime.nextId('attempt'),
    taskId: task.id,
    teamId: member.teamId,
    memberId: member.id,
    generation,
    configRevision: team?.configRevision ?? state.configRevision,
    roleRevision: member.roleRevision,
    sessionId: member.sessionId,
    status: 'active',
    startedAt: now,
    endedAt: null,
  }

  const draft: DraftEvent = {
    type: 'task.claimed',
    actor: input.actor,
    entity: { kind: 'attempt', id: attempt.id, teamId: member.teamId },
    entityRevision: task.revision + 1,
    configRevision: attempt.configRevision,
    payload: { taskId: task.id, attempt, graphRevision: state.graphRevision },
  }
  return runtime.commit([draft])
}

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

export function rebaseTeamConfigCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    teamId: string
    overrides: ConfigOverrides
    expectedConfigRevision: number
  },
): CommitResult {
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  }
  authorize('config.rebase', input.actor, { teamId: input.teamId })
  assertTeamActive(team)

  if (team.configRevision !== input.expectedConfigRevision) {
    fail(ERROR_CODES.PRECONDITION_FAILED, '团队配置已被修改，请重读差异后重试', {
      details: { expectedConfigRevision: input.expectedConfigRevision, currentConfigRevision: team.configRevision },
    })
  }

  const blueprint =
    team.blueprint === null ? undefined : state.blueprints.get(team.blueprint.id)
  const configRevision = team.configRevision + 1
  const snapshot = computeEffectiveConfig({
    projectDefaults: state.configDefaults as ConfigOverrides,
    blueprintDefaults: blueprint?.defaults ?? null,
    teamOverrides: input.overrides,
    configRevision,
    sources: {
      projectDefaultsRevision: state.configRevision,
      blueprintRevision: team.blueprint?.revision ?? null,
      teamOverridesRevision: configRevision,
    },
  })

  const draft: DraftEvent = {
    type: 'config.rebased',
    actor: input.actor,
    entity: { kind: 'config', id: input.teamId, teamId: input.teamId },
    payload: {
      teamId: input.teamId,
      configRevision,
      previousRevision: team.configRevision,
      snapshot,
    },
  }
  return runtime.commit([draft])
}

export function changeTeamStatusCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; teamId: string; status: 'active' | 'archived' | 'disbanded'; reason?: string },
): CommitResult {
  const team = runtime.state.teams.get(input.teamId)
  if (team === undefined) fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  if (input.status === 'disbanded') authorize('team.disband', input.actor, { teamId: input.teamId })
  else authorize('team.archive', input.actor, { teamId: input.teamId })
  assertTeamStatusChange(team.status, input.status)

  const revision = team.revision + 1
  const draft: DraftEvent =
    input.status === 'disbanded'
      ? {
          type: 'team.disbanded',
          actor: input.actor,
          entity: { kind: 'team', id: input.teamId },
          entityRevision: revision,
          payload: { teamId: input.teamId, revision, reason: input.reason ?? '用户确认解散' },
        }
      : {
          type: 'team.archived',
          actor: input.actor,
          entity: { kind: 'team', id: input.teamId },
          entityRevision: revision,
          payload: { teamId: input.teamId, revision },
        }
  return runtime.commit([draft])
}

/** 只读辅助：把投影里的任务折成图，供查询与测试使用。 */
export function taskGraphOf(state: { tasks: Map<string, Task> }): ReturnType<typeof graphOf> {
  return graphOf([...state.tasks.values()].map((task) => [task.id, task.dependencies] as const))
}