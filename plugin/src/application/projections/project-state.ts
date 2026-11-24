/**
 * 项目内存投影：事件的确定性重放结果。
 *
 * 投影是**派生缓存**：删掉可以重建，手改没有意义。因此这里没有 IO、没有
 * 时间、没有随机数——同一串事件永远得到同一份状态，这是恢复与迁移对账的
 * 前提。
 *
 * 投影只做「把事件折叠成当前视图」，不做业务判断：状态机、防环、权限都在
 * 领域层。投影里出现条件分支（例如「某些状态下忽略这条事件」）只是为了让
 * 视图自洽，不是第二套规则。
 */
import type {
  Attempt,
  CaptainAssignment,
  CompletionRule,
  EffectiveConfigSnapshot,
  Effect,
  EvidenceRef,
  GateVerdict,
  KnowledgeEntry,
  Member,
  RoleDefinition,
  Task,
  Team,
  TeamBlueprint,
  TeamMessage,
  WorkflowDefinition,
  WorkflowRun,
} from '../../contracts/entities.ts'
import type { EventEnvelope, EventType, DefinitionOrigin } from '../../contracts/events.ts'
import { roleContentHash } from '../../domain/definitions/role.ts'
import { workflowContentHash } from '../../domain/definitions/workflow.ts'
import { blueprintContentHash } from '../../domain/definitions/blueprint.ts'

export interface DefinitionMeta {
  kind: 'role' | 'workflow' | 'blueprint'
  id: string
  revision: number
  origin: DefinitionOrigin | null
  baseHash: string
  contentHash: string
  archived: boolean
  published: { operationId: string; globalHash: string; publishedAt: string } | null
}

/**
 * 一条**待确认**的全局发布请求。
 *
 * 为什么要在投影里留这份状态：`definition.publication.requested` 之前是 no-op ——
 * 请求落了事件，但投影不记，于是「谁在等人类确认发布」这件事**查不出来**，
 * 界面上只能靠当场签的那个令牌（刷新就没了）。
 *
 * 这里只存「还等着」的那些：`outcome` 一到就删掉（不管成功还是失败），
 * 历史由全局审计负责，不在项目投影里堆。
 */
export interface PendingPublication {
  operationId: string
  kind: 'role' | 'workflow' | 'blueprint'
  /** 定义 id（不是文件名）。 */
  id: string
  /** 目标文件名，给人看。 */
  target: string
  requestedBy: string
  requestedAt: string
}

/**
 * 一份**待人类确认**的队长接管提案。
 *
 * 提案不改变队长（generation 不动）；人类确认时才 +1 并落 `captain.handoff.confirmed`。
 * 提案会因为「队长被换掉了」而失效 —— 所以 `captain.assigned` / `confirmed` 都要把它清掉。
 */
export interface PendingHandoff {
  teamId: string
  /** 提案时的队长 generation；确认时据此判断提案有没有过期。 */
  fromGeneration: number
  toSessionId: string
  proposedBy: string
  proposedAt: string
}

export interface ProjectState {
  projectId: string
  name: string
  /** 已应用到的 projectSeq；0 表示还没初始化。 */
  seq: number
  createdAt: string

  roles: Map<string, RoleDefinition>
  workflows: Map<string, WorkflowDefinition>
  blueprints: Map<string, TeamBlueprint>
  definitionMeta: Map<string, DefinitionMeta>

  teams: Map<string, Team>
  captains: Map<string, CaptainAssignment>
  members: Map<string, Member>

  runs: Map<string, WorkflowRun>
  /** 每个 Run 实例化时固化的完成条件（定义后改不影响既有 Run）。 */
  runCompletions: Map<string, CompletionRule>
  tasks: Map<string, Task>
  attempts: Map<string, Attempt>
  verdicts: Map<string, GateVerdict>
  evidence: Map<string, EvidenceRef[]>

  knowledge: Map<string, KnowledgeEntry>
  effects: Map<string, Effect>
  messages: TeamMessage[]

  configDefaults: Record<string, unknown>
  configRevision: number
  /** 项目级 DAG 版本：只随图结构（建任务、改依赖、实例化 Run）变化。 */
  graphRevision: number
  teamConfigs: Map<string, EffectiveConfigSnapshot>
  /** 待人类确认的全局发布（按 operationId）。`outcome` 一到就删。 */
  pendingPublications: Map<string, PendingPublication>
  /** 待人类确认的队长接管（按 teamId）。确认或被新指派覆盖时删。 */
  pendingHandoffs: Map<string, PendingHandoff>
}

export function emptyProjectState(projectId: string): ProjectState {
  return {
    projectId,
    name: '',
    seq: 0,
    createdAt: '',
    roles: new Map(),
    workflows: new Map(),
    blueprints: new Map(),
    definitionMeta: new Map(),
    teams: new Map(),
    captains: new Map(),
    members: new Map(),
    runs: new Map(),
    runCompletions: new Map(),
    tasks: new Map(),
    attempts: new Map(),
    verdicts: new Map(),
    evidence: new Map(),
    knowledge: new Map(),
    effects: new Map(),
    messages: [],
    configDefaults: {},
    configRevision: 0,
    graphRevision: 1,
    teamConfigs: new Map(),
    pendingPublications: new Map(),
    pendingHandoffs: new Map(),
  }
}

/** 投影实际处理的事件类型；与目录的一致性由架构测试保证。 */
export const HANDLED_EVENT_TYPES: readonly EventType[] = [
  'project.initialized',
  'definition.role.created',
  'definition.role.revised',
  'definition.role.archived',
  'definition.workflow.created',
  'definition.workflow.revised',
  'definition.workflow.archived',
  'definition.blueprint.created',
  'definition.blueprint.revised',
  'definition.blueprint.archived',
  'definition.rebased',
  'definition.publication.requested',
  'definition.publication.authorized',
  'definition.publication.outcome',
  'team.created',
  'team.updated',
  'team.archived',
  'team.disbanded',
  'captain.assigned',
  'captain.handoff.proposed',
  'captain.handoff.confirmed',
  'member.appointed',
  'member.session.bound',
  'member.status.changed',
  'member.archived',
  'member.released',
  'run.created',
  'run.revised',
  'run.closed',
  'task.created',
  'task.updated',
  'task.participation.changed',
  'task.dependencies.changed',
  'task.ready',
  'task.claimed',
  'task.progress',
  'task.evidence',
  'task.verdict',
  'task.submitted',
  'task.completed',
  'task.reopened',
  'task.cancelled',
  'task.blocked',
  'attempt.revoked',
  'knowledge.proposed',
  'knowledge.adopted',
  'knowledge.revised',
  'knowledge.archived',
  'config.defaults.changed',
  'config.override.changed',
  'config.rebased',
  'effect.requested',
  'effect.accepted',
  'effect.completed',
  'effect.failed',
  'effect.cancelled',
  'effect.outcome-unknown',
  'message.posted',
]

/** 重建：从空状态重放全部已提交事件。 */
export function rebuildProjectState(projectId: string, events: readonly EventEnvelope[]): ProjectState {
  const state = emptyProjectState(projectId)
  for (const event of events) applyEvent(state, event)
  return state
}

function definitionKey(kind: DefinitionMeta['kind'], id: string): string {
  return `${kind}:${id}`
}

function requireTask(state: ProjectState, taskId: string): Task {
  const task = state.tasks.get(taskId)
  if (task === undefined) throw new Error(`投影缺少任务 ${taskId}（事件顺序或迁移数据不一致）`)
  return task
}

function requireTeam(state: ProjectState, teamId: string): Team {
  const team = state.teams.get(teamId)
  if (team === undefined) throw new Error(`投影缺少团队 ${teamId}`)
  return team
}

function requireMember(state: ProjectState, memberId: string): Member {
  const member = state.members.get(memberId)
  if (member === undefined) throw new Error(`投影缺少成员 ${memberId}`)
  return member
}

function requireEffect(state: ProjectState, effectId: string): Effect {
  const effect = state.effects.get(effectId)
  if (effect === undefined) throw new Error(`投影缺少 Effect ${effectId}`)
  return effect
}

/**
 * 应用单条事件。
 *
 * 未知类型直接抛错：静默跳过会让「事件已提交、视图没变化」成为常态，
 * 排查成本远高于一次明确的恢复失败。
 */
export function applyEvent(state: ProjectState, event: EventEnvelope): void {
  state.seq = event.projectSeq

  switch (event.type) {
    case 'project.initialized': {
      const payload = event.payload as { name: string; createdAt: string }
      state.name = payload.name
      state.createdAt = payload.createdAt
      return
    }

    case 'definition.role.created':
    case 'definition.role.revised': {
      const payload = event.payload as { role: RoleDefinition; origin?: DefinitionOrigin | null }
      state.roles.set(payload.role.id, payload.role)
      const existing = state.definitionMeta.get(definitionKey('role', payload.role.id))
      state.definitionMeta.set(definitionKey('role', payload.role.id), {
        kind: 'role',
        id: payload.role.id,
        revision: payload.role.revision,
        origin: payload.origin ?? existing?.origin ?? null,
        baseHash: payload.origin?.hash ?? existing?.baseHash ?? roleContentHash(payload.role),
        contentHash: roleContentHash(payload.role),
        archived: false,
        published: existing?.published ?? null,
      })
      return
    }
    case 'definition.role.archived': {
      const payload = event.payload as { roleId: string }
      const meta = state.definitionMeta.get(definitionKey('role', payload.roleId))
      if (meta !== undefined) state.definitionMeta.set(meta.kind + ':' + meta.id, { ...meta, archived: true })
      return
    }

    case 'definition.workflow.created':
    case 'definition.workflow.revised': {
      const payload = event.payload as { workflow: WorkflowDefinition; origin?: DefinitionOrigin | null }
      state.workflows.set(payload.workflow.id, payload.workflow)
      const existing = state.definitionMeta.get(definitionKey('workflow', payload.workflow.id))
      state.definitionMeta.set(definitionKey('workflow', payload.workflow.id), {
        kind: 'workflow',
        id: payload.workflow.id,
        revision: payload.workflow.revision,
        origin: payload.origin ?? existing?.origin ?? null,
        baseHash: payload.origin?.hash ?? existing?.baseHash ?? workflowContentHash(payload.workflow),
        contentHash: workflowContentHash(payload.workflow),
        archived: false,
        published: existing?.published ?? null,
      })
      return
    }
    case 'definition.workflow.archived': {
      const payload = event.payload as { workflowId: string }
      const meta = state.definitionMeta.get(definitionKey('workflow', payload.workflowId))
      if (meta !== undefined) state.definitionMeta.set(`workflow:${meta.id}`, { ...meta, archived: true })
      return
    }

    case 'definition.blueprint.created':
    case 'definition.blueprint.revised': {
      const payload = event.payload as { blueprint: TeamBlueprint; origin?: DefinitionOrigin | null }
      state.blueprints.set(payload.blueprint.id, payload.blueprint)
      const existing = state.definitionMeta.get(definitionKey('blueprint', payload.blueprint.id))
      state.definitionMeta.set(definitionKey('blueprint', payload.blueprint.id), {
        kind: 'blueprint',
        id: payload.blueprint.id,
        revision: payload.blueprint.revision,
        origin: payload.origin ?? existing?.origin ?? null,
        baseHash: payload.origin?.hash ?? existing?.baseHash ?? blueprintContentHash(payload.blueprint),
        contentHash: blueprintContentHash(payload.blueprint),
        archived: false,
        published: existing?.published ?? null,
      })
      return
    }
    case 'definition.blueprint.archived': {
      const payload = event.payload as { blueprintId: string }
      const meta = state.definitionMeta.get(definitionKey('blueprint', payload.blueprintId))
      if (meta !== undefined) state.definitionMeta.set(`blueprint:${meta.id}`, { ...meta, archived: true })
      return
    }

    case 'definition.rebased': {
      const payload = event.payload as { target: { kind: DefinitionMeta['kind']; id: string }; baseHash: string }
      const key = definitionKey(payload.target.kind, payload.target.id)
      const meta = state.definitionMeta.get(key)
      if (meta !== undefined) state.definitionMeta.set(key, { ...meta, baseHash: payload.baseHash })
      return
    }

    case 'definition.publication.requested': {
      // 记下「谁在等人类确认发布」——之前这里是 no-op，导致这件事查不出来。
      const payload = event.payload as {
        operationId: string
        target: string
        requestedBy?: string
      }
      const entityKind = event.entity.kind
      const kind: PendingPublication['kind'] =
        entityKind === 'role-definition' ? 'role' : entityKind === 'workflow-definition' ? 'workflow' : 'blueprint'
      state.pendingPublications.set(payload.operationId, {
        operationId: payload.operationId,
        kind,
        id: event.entity.id,
        target: payload.target,
        requestedBy: payload.requestedBy ?? 'unknown',
        requestedAt: event.occurredAt,
      })
      return
    }

    case 'definition.publication.authorized':
      // 授权只是流程推进，请求仍在等 outcome —— 不清。
      return

    case 'definition.publication.outcome': {
      const payload = event.payload as {
        outcome: 'published' | 'failed'
        globalHash: string | null
        operationId: string
      }
      // 有了 outcome 就不算「待确认」了（成功失败都算已处理）。
      state.pendingPublications.delete(payload.operationId)
      if (payload.outcome !== 'published' || payload.globalHash === null) return
      for (const [key, meta] of state.definitionMeta) {
        if (meta.published?.operationId === payload.operationId) {
          state.definitionMeta.set(key, {
            ...meta,
            baseHash: payload.globalHash,
            published: { operationId: payload.operationId, globalHash: payload.globalHash, publishedAt: event.occurredAt },
          })
        }
      }
      return
    }

    case 'team.created': {
      const payload = event.payload as { team: Team; captain: { sessionId: string; generation: number } | null }
      state.teams.set(payload.team.id, payload.team)
      if (payload.captain !== null) {
        state.captains.set(payload.team.id, {
          teamId: payload.team.id,
          sessionId: payload.captain.sessionId,
          generation: payload.captain.generation,
          reason: 'initial',
          assignedAt: event.occurredAt,
        })
      }
      return
    }
    case 'team.updated': {
      const payload = event.payload as { teamId: string; revision: number; name?: string; goal?: string }
      const team = requireTeam(state, payload.teamId)
      state.teams.set(payload.teamId, {
        ...team,
        name: payload.name ?? team.name,
        goal: payload.goal ?? team.goal,
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'team.archived':
    case 'team.disbanded': {
      const payload = event.payload as { teamId: string; revision: number }
      const team = requireTeam(state, payload.teamId)
      state.teams.set(payload.teamId, {
        ...team,
        status: event.type === 'team.archived' ? 'archived' : 'disbanded',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }

    case 'captain.assigned': {
      const payload = event.payload as CaptainAssignment
      state.captains.set(payload.teamId, { ...payload, assignedAt: event.occurredAt })
      return
    }
    case 'captain.handoff.proposed': {
      const payload = event.payload as {
        teamId: string
        fromGeneration: number
        toSessionId: string
        proposedBy: string
      }
      state.pendingHandoffs.set(payload.teamId, {
        teamId: payload.teamId,
        fromGeneration: payload.fromGeneration,
        toSessionId: payload.toSessionId,
        proposedBy: payload.proposedBy,
        proposedAt: event.occurredAt,
      })
      return
    }
    case 'captain.handoff.confirmed': {
      const payload = event.payload as { teamId: string; generation: number; toSessionId: string }
      // 确认之后提案就不再是「待确认」了。
      state.pendingHandoffs.delete(payload.teamId)
      state.captains.set(payload.teamId, {
        teamId: payload.teamId,
        sessionId: payload.toSessionId,
        generation: payload.generation,
        reason: 'handoff',
        assignedAt: event.occurredAt,
      })
      return
    }

    case 'member.appointed': {
      const payload = event.payload as { member: Member }
      state.members.set(payload.member.id, payload.member)
      return
    }
    case 'member.session.bound': {
      const payload = event.payload as {
        memberId: string
        sessionId: string
        memberSessionGeneration: number
      }
      const member = requireMember(state, payload.memberId)
      state.members.set(payload.memberId, {
        ...member,
        sessionId: payload.sessionId,
        memberSessionGeneration: payload.memberSessionGeneration,
        status: member.status === 'appointed' ? 'active' : member.status,
        revision: member.revision + 1,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'member.status.changed': {
      const payload = event.payload as { memberId: string; revision: number; status: Member['status'] }
      const member = requireMember(state, payload.memberId)
      state.members.set(payload.memberId, {
        ...member,
        status: payload.status,
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'member.archived': {
      const payload = event.payload as { memberId: string; revision: number }
      const member = requireMember(state, payload.memberId)
      state.members.set(payload.memberId, {
        ...member,
        status: 'archived',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }

    case 'member.released': {
      const payload = event.payload as { memberId: string; revision: number }
      const member = requireMember(state, payload.memberId)
      state.members.set(payload.memberId, {
        ...member,
        status: 'released',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }

    case 'run.created': {
      const payload = event.payload as { run: WorkflowRun; completion: CompletionRule; graphRevision: number }
      state.runs.set(payload.run.id, payload.run)
      state.runCompletions.set(payload.run.id, payload.completion)
      state.graphRevision = Math.max(state.graphRevision, payload.graphRevision)
      return
    }
    case 'run.revised': {
      const payload = event.payload as {
        runId: string
        revision: number
        completionRevision: number
        taskIds: string[]
        templateKeyToTaskId: Record<string, string>
      }
      const run = state.runs.get(payload.runId)
      if (run === undefined) throw new Error(`投影缺少 Run ${payload.runId}`)
      state.runs.set(payload.runId, {
        ...run,
        revision: payload.revision,
        completionRevision: payload.completionRevision,
        taskIds: [...payload.taskIds],
        templateKeyToTaskId: { ...payload.templateKeyToTaskId },
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'run.closed': {
      const payload = event.payload as { runId: string; status: WorkflowRun['status'] }
      const run = state.runs.get(payload.runId)
      if (run === undefined) throw new Error(`投影缺少 Run ${payload.runId}`)
      state.runs.set(payload.runId, { ...run, status: payload.status, updatedAt: event.occurredAt })
      return
    }

    case 'task.created': {
      const payload = event.payload as { task: Task; graphRevision: number }
      state.tasks.set(payload.task.id, payload.task)
      state.graphRevision = Math.max(state.graphRevision, payload.graphRevision)
      return
    }
    case 'task.updated': {
      const payload = event.payload as {
        taskId: string
        revision: number
        title?: string
        description?: string
        acceptance?: string[]
        requiredRoleId?: string | null
        gate?: Task['gate']
        deliverable?: Task['deliverable']
      }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, {
        ...task,
        title: payload.title ?? task.title,
        description: payload.description ?? task.description,
        acceptance: payload.acceptance ?? task.acceptance,
        requiredRoleId: payload.requiredRoleId === undefined ? task.requiredRoleId : payload.requiredRoleId,
        gate: payload.gate ?? task.gate,
        deliverable: payload.deliverable === undefined ? task.deliverable : payload.deliverable,
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'task.participation.changed': {
      const payload = event.payload as {
        taskId: string
        revision: number
        ownerTeamId: string | null
        collaborators: Task['collaborators']
      }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, {
        ...task,
        ownerTeamId: payload.ownerTeamId,
        collaborators: payload.collaborators,
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'task.dependencies.changed': {
      const payload = event.payload as { taskId: string; revision: number; dependencies: string[]; graphRevision: number }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, {
        ...task,
        dependencies: [...payload.dependencies],
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      state.graphRevision = Math.max(state.graphRevision, payload.graphRevision)
      return
    }
    case 'task.ready': {
      const payload = event.payload as { taskId: string; revision: number }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, {
        ...task,
        status: 'ready',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'task.claimed': {
      const payload = event.payload as { taskId: string; attempt: Attempt }
      const task = requireTask(state, payload.taskId)
      state.attempts.set(payload.attempt.id, payload.attempt)
      state.tasks.set(payload.taskId, {
        ...task,
        status: 'claimed',
        attemptId: payload.attempt.id,
        revision: task.revision + 1,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'task.progress': {
      const payload = event.payload as { taskId: string }
      const task = requireTask(state, payload.taskId)
      if (task.status === 'claimed') {
        state.tasks.set(payload.taskId, { ...task, status: 'in_progress', updatedAt: event.occurredAt })
      }
      return
    }
    case 'task.evidence': {
      const payload = event.payload as { taskId: string; evidence: EvidenceRef[] }
      const current = state.evidence.get(payload.taskId) ?? []
      state.evidence.set(payload.taskId, [...current, ...payload.evidence])
      return
    }
    case 'task.verdict': {
      const payload = event.payload as { verdict: GateVerdict }
      state.verdicts.set(payload.verdict.taskId, payload.verdict)
      return
    }
    case 'task.submitted': {
      const payload = event.payload as { taskId: string }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, { ...task, status: 'review', updatedAt: event.occurredAt })
      return
    }
    case 'task.completed': {
      const payload = event.payload as { taskId: string; revision: number; attemptId: string }
      const task = requireTask(state, payload.taskId)
      const attempt = state.attempts.get(payload.attemptId)
      if (attempt !== undefined) {
        state.attempts.set(attempt.id, { ...attempt, status: 'completed', endedAt: event.occurredAt })
      }
      state.tasks.set(payload.taskId, {
        ...task,
        status: 'done',
        revision: payload.revision,
        attemptId: null,
        completedAt: event.occurredAt,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'task.reopened': {
      const payload = event.payload as { taskId: string; revision: number }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, {
        ...task,
        status: 'ready',
        attemptId: null,
        completedAt: null,
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'task.cancelled':
    case 'task.blocked': {
      const payload = event.payload as { taskId: string; revision: number }
      const task = requireTask(state, payload.taskId)
      state.tasks.set(payload.taskId, {
        ...task,
        status: event.type === 'task.cancelled' ? 'cancelled' : 'blocked',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'attempt.revoked': {
      const payload = event.payload as { taskId: string; attemptId: string }
      const attempt = state.attempts.get(payload.attemptId)
      if (attempt !== undefined) {
        state.attempts.set(attempt.id, { ...attempt, status: 'revoked', endedAt: event.occurredAt })
      }
      const task = state.tasks.get(payload.taskId)
      if (task !== undefined && task.attemptId === payload.attemptId) {
        state.tasks.set(task.id, { ...task, status: 'ready', attemptId: null, updatedAt: event.occurredAt })
      }
      return
    }

    case 'knowledge.proposed':
    case 'knowledge.revised': {
      const payload = event.payload as { entry: KnowledgeEntry }
      state.knowledge.set(payload.entry.id, payload.entry)
      return
    }
    case 'knowledge.adopted': {
      const payload = event.payload as { entryId: string; revision: number }
      const entry = state.knowledge.get(payload.entryId)
      if (entry === undefined) throw new Error(`投影缺少知识条目 ${payload.entryId}`)
      state.knowledge.set(payload.entryId, {
        ...entry,
        status: 'adopted',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }
    case 'knowledge.archived': {
      const payload = event.payload as { entryId: string; revision: number }
      const entry = state.knowledge.get(payload.entryId)
      if (entry === undefined) throw new Error(`投影缺少知识条目 ${payload.entryId}`)
      state.knowledge.set(payload.entryId, {
        ...entry,
        status: 'archived',
        revision: payload.revision,
        updatedAt: event.occurredAt,
      })
      return
    }

    case 'config.defaults.changed': {
      const payload = event.payload as { configRevision: number; config: Record<string, unknown> }
      state.configDefaults = payload.config
      state.configRevision = payload.configRevision
      return
    }
    case 'config.override.changed':
    case 'config.rebased': {
      const payload = event.payload as { teamId: string; configRevision: number; snapshot: EffectiveConfigSnapshot }
      state.teamConfigs.set(payload.teamId, payload.snapshot)
      state.configRevision = Math.max(state.configRevision, payload.configRevision)
      const team = state.teams.get(payload.teamId)
      if (team !== undefined) {
        state.teams.set(payload.teamId, { ...team, configRevision: payload.configRevision })
      }
      return
    }

    case 'effect.requested': {
      const payload = event.payload as { effect: Effect }
      state.effects.set(payload.effect.id, payload.effect)
      return
    }
    case 'effect.accepted': {
      const payload = event.payload as { effectId: string; externalId: string }
      const effect = requireEffect(state, payload.effectId)
      state.effects.set(payload.effectId, { ...effect, status: 'accepted', externalId: payload.externalId })
      return
    }
    case 'effect.completed': {
      const payload = event.payload as { effectId: string; result: Record<string, unknown> }
      const effect = requireEffect(state, payload.effectId)
      state.effects.set(payload.effectId, {
        ...effect,
        status: 'completed',
        result: payload.result,
        settledAt: event.occurredAt,
      })
      return
    }
    case 'effect.failed': {
      const payload = event.payload as { effectId: string }
      const effect = requireEffect(state, payload.effectId)
      state.effects.set(payload.effectId, { ...effect, status: 'failed', settledAt: event.occurredAt })
      return
    }
    case 'effect.cancelled': {
      const payload = event.payload as { effectId: string }
      const effect = requireEffect(state, payload.effectId)
      state.effects.set(payload.effectId, { ...effect, status: 'cancelled', settledAt: event.occurredAt })
      return
    }
    case 'effect.outcome-unknown': {
      const payload = event.payload as { effectId: string }
      const effect = requireEffect(state, payload.effectId)
      state.effects.set(payload.effectId, { ...effect, status: 'outcome-unknown' })
      return
    }

    case 'message.posted': {
      const payload = event.payload as { message: TeamMessage }
      state.messages.push(payload.message)
      return
    }

    default: {
      const exhaustive: never = event.type
      throw new Error(`未处理的事件类型：${String(exhaustive)}`)
    }
  }
}