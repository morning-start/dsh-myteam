/**
 * v2 事件目录与信封。
 *
 * 一个项目只有一个逻辑事件流（`events/project.jsonl`）。定义、团队、成员、Run、
 * 任务、Attempt、门禁、知识、配置、Effect 与消息都以事件表达；`config/` 与
 * Markdown 只是生成视图。
 *
 * 信封字段的取舍（见 docs/architecture/01 §6.2）：
 *   - `projectSeq` 是项目全序，由写者在追加时分配；事件本身不自带序号；
 *   - `batchId/batchIndex` 让「一个命令改多个实体」成为一个可校验的原子批次；
 *   - `actor` 必须由适配器验证后写入，**payload 里的 actor 字段一律不可信**；
 *   - `entityRevision` 与 `configRevision` 可缺省，因为一个批次可跨多个实体；
 *     对 DAG、配置、Attempt 等命令，前置条件是命令必填项，不是信封必填项。
 */
import type {
  Attempt,
  CaptainAssignmentReason,
  CompletionRule,
  ConfigOverrides,
  EffectiveConfigSnapshot,
  Effect,
  EffectKind,
  EffectRetry,
  EvidenceRef,
  FormationSlot,
  GateSpec,
  GateVerdict,
  KnowledgeEntry,
  LegacyOrigin,
  Member,
  RoleDefinition,
  Task,
  Team,
  TeamBlueprint,
  TeamPlan,
  TeamMessage,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
} from './entities.ts'
import type { ErrorShape } from './errors.ts'
import type {
  BlueprintId,
  EffectId,
  KnowledgeEntryId,
  MemberId,
  OperationId,
  ProjectId,
  RoleId,
  SessionId,
  TaskId,
  TeamId,
  TeamPlanId,
  WorkflowId,
  WorkflowRunId,
} from './ids.ts'
import { SCHEMA_VERSION } from './versions.ts'

/** 事件类型：稳定字符串，不随文案变化。 */
export type EventType =
  | 'project.initialized'
  | 'definition.role.created'
  | 'definition.role.revised'
  | 'definition.role.archived'
  | 'definition.workflow.created'
  | 'definition.workflow.revised'
  | 'definition.workflow.archived'
  | 'definition.blueprint.created'
  | 'definition.blueprint.revised'
  | 'definition.blueprint.archived'
  | 'definition.rebased'
  | 'definition.publication.requested'
  | 'definition.publication.authorized'
  | 'definition.publication.outcome'
  | 'team.created'
  | 'team.updated'
  | 'team.archived'
  | 'team.disbanded'
  | 'team.plan.proposed'
  | 'team.plan.approved'
  | 'team.plan.discarded'
  | 'captain.assigned'
  | 'captain.handoff.proposed'
  | 'captain.handoff.confirmed'
  | 'member.appointed'
  | 'member.session.bound'
  | 'member.status.changed'
  | 'member.archived'
  | 'member.released'
  | 'run.created'
  | 'run.revised'
  | 'run.closed'
  | 'task.created'
  | 'task.updated'
  | 'task.participation.changed'
  | 'task.dependencies.changed'
  | 'task.ready'
  | 'task.claimed'
  | 'task.progress'
  | 'task.evidence'
  | 'task.verdict'
  | 'task.submitted'
  | 'task.completed'
  | 'task.reopened'
  | 'task.cancelled'
  | 'task.blocked'
  | 'attempt.revoked'
  | 'knowledge.proposed'
  | 'knowledge.adopted'
  | 'knowledge.revised'
  | 'knowledge.archived'
  | 'config.defaults.changed'
  | 'config.override.changed'
  | 'config.rebased'
  | 'effect.requested'
  | 'effect.accepted'
  | 'effect.completed'
  | 'effect.failed'
  | 'effect.cancelled'
  | 'effect.outcome-unknown'
  | 'message.posted'

/**
 * 调用者身份。适配器负责验证并构造，领域层只按 kind 与绑定字段判权限。
 *
 * `human.via` 记录用户从哪个可信入口发起（面板动作、命令、确认卡），
 * 但它只用于审计与展示；授权本身由 HumanAuthorizer 的令牌验证，
 * 不靠这个字符串。
 */
export type ActorRef =
  | { kind: 'human'; userId: string; via: 'panel' | 'command' | 'confirmation' }
  | { kind: 'captain'; teamId: TeamId; sessionId: SessionId; generation: number }
  | {
      kind: 'member'
      teamId: TeamId
      memberId: MemberId
      sessionId: SessionId
      memberSessionGeneration: number
      attemptId: string | null
    }
  | { kind: 'system'; component: string }

export type EntityKind =
  | 'project'
  | 'role-definition'
  | 'workflow-definition'
  | 'team-blueprint'
  | 'team-plan'
  | 'team'
  | 'captain-assignment'
  | 'member'
  | 'workflow-run'
  | 'task'
  | 'attempt'
  | 'gate-verdict'
  | 'knowledge-entry'
  | 'config'
  | 'effect'
  | 'message'

export interface EntityRef {
  kind: EntityKind
  id: string
  teamId?: TeamId
}

/** 定义资产的最初复制来源；项目内新建时为 null。 */
export interface DefinitionOrigin {
  scope: 'builtin' | 'global' | 'project'
  id: string
  revision: number
  hash: string
}

export interface PublicationTarget {
  kind: 'role' | 'workflow' | 'blueprint'
  id: string
  /** 发布目标当前内容的规范化 hash；确认令牌与它绑定。 */
  targetHash: string
  definitionRevision: number
}

export interface PublicationImpact {
  references: { kind: string; id: string; revision: number }[]
  missingReferences: string[]
  overwrites: boolean
  irreversible: string[]
}

export interface EffectRequestInput {
  kind: EffectKind
  retry: EffectRetry
  teamId: TeamId | null
  idempotencyKey: string
  payload: Record<string, unknown>
}

export interface EventPayloads {
  'project.initialized': { name: string; createdAt: string }

  'definition.role.created': { role: RoleDefinition; origin: DefinitionOrigin | null }
  'definition.role.revised': { role: RoleDefinition; previousHash: string }
  'definition.role.archived': { roleId: RoleId; revision: number }

  'definition.workflow.created': { workflow: WorkflowDefinition; origin: DefinitionOrigin | null }
  'definition.workflow.revised': { workflow: WorkflowDefinition; previousHash: string }
  'definition.workflow.archived': { workflowId: WorkflowId; revision: number }

  'definition.blueprint.created': { blueprint: TeamBlueprint; origin: DefinitionOrigin | null }
  'definition.blueprint.revised': { blueprint: TeamBlueprint; previousHash: string }
  'definition.blueprint.archived': { blueprintId: BlueprintId; revision: number }

  /** 显式把项目定义对齐到新的上游基准；不自动发生。 */
  'definition.rebased': {
    target: { kind: 'role' | 'workflow' | 'blueprint'; id: string }
    revision: number
    baseHash: string
    upstreamHash: string
  }

  'definition.publication.requested': {
    operationId: OperationId
    target: PublicationTarget
    impact: PublicationImpact
    requestedBy: string
  }
  'definition.publication.authorized': {
    operationId: OperationId
    targetHash: string
    nonceHash: string
    expiresAt: string
    confirmedBy: string
  }
  'definition.publication.outcome': {
    operationId: OperationId
    outcome: 'published' | 'failed'
    globalHash: string | null
    error: ErrorShape | null
  }

  'team.created': {
    team: Team
    /**
     * 建团时的队长会话。迁移来的历史团队没有可信会话，这里必须是 `null`：
     * 旧 sessionId 已失效，伪造一个会让「谁能发指令」变得不可判定。
     */
    captain: { sessionId: SessionId; generation: number } | null
    formation: FormationSlot[]
  }
  'team.updated': { teamId: TeamId; revision: number; name?: string; goal?: string }
  'team.archived': { teamId: TeamId; revision: number }
  'team.disbanded': { teamId: TeamId; revision: number; reason: string }

  /**
   * 开队计划：只落计划，不建团队/成员/Run。
   * 批准事件带 teamId 与 runId —— 计划被消费后，账本仍能追出「它建出了谁」。
   */
  'team.plan.proposed': { plan: TeamPlan }
  'team.plan.approved': {
    planId: TeamPlanId
    teamId: TeamId
    planHash: string
    runId: WorkflowRunId | null
  }
  'team.plan.discarded': { planId: TeamPlanId; reason: string; discardedBy: string }

  'captain.assigned': {
    teamId: TeamId
    sessionId: SessionId
    generation: number
    reason: CaptainAssignmentReason
  }
  'captain.handoff.proposed': {
    teamId: TeamId
    fromGeneration: number
    toSessionId: SessionId
    proposedBy: string
  }
  'captain.handoff.confirmed': {
    teamId: TeamId
    generation: number
    toSessionId: SessionId
    confirmedBy: string
  }

  'member.appointed': {
    member: Member
    roleRevision: number
    parentMemberId: MemberId | null
  }
  'member.session.bound': {
    teamId: TeamId
    memberId: MemberId
    sessionId: SessionId
    memberSessionGeneration: number
    previousSessionId: SessionId | null
    captainGeneration: number
    roleRevision: number
  }
  'member.status.changed': {
    teamId: TeamId
    memberId: MemberId
    revision: number
    status: Member['status']
    reason: string
  }
  'member.archived': { teamId: TeamId; memberId: MemberId; revision: number }
  'member.released': { teamId: TeamId; memberId: MemberId; revision: number }

  'run.created': { run: WorkflowRun; completion: CompletionRule; graphRevision: number }
  'run.revised': {
    runId: WorkflowRunId
    revision: number
    completionRevision: number
    taskIds: TaskId[]
    templateKeyToTaskId: Record<string, TaskId>
    completion: CompletionRule
  }
  'run.closed': { runId: WorkflowRunId; status: WorkflowRunStatus; reason: string }

  'task.created': { task: Task; graphRevision: number }
  'task.updated': {
    taskId: TaskId
    revision: number
    title?: string
    description?: string
    acceptance?: string[]
    requiredRoleId?: RoleId | null
    gate?: GateSpec
    deliverable?: Task['deliverable']
  }
  'task.participation.changed': {
    taskId: TaskId
    revision: number
    ownerTeamId: TeamId | null
    collaborators: Task['collaborators']
  }
  'task.dependencies.changed': {
    taskId: TaskId
    revision: number
    dependencies: TaskId[]
    graphRevision: number
  }
  /** 上游完成后由系统放开：planned → ready。 */
  'task.ready': { taskId: TaskId; revision: number }
  'task.claimed': { taskId: TaskId; attempt: Attempt; graphRevision: number }
  'task.progress': { taskId: TaskId; attemptId: string; note: string; percent: number | null }
  'task.evidence': { taskId: TaskId; attemptId: string; evidence: EvidenceRef[] }
  'task.verdict': { verdict: GateVerdict }
  'task.submitted': { taskId: TaskId; attemptId: string }
  'task.completed': {
    taskId: TaskId
    attemptId: string
    revision: number
    verdictId: string | null
  }
  'task.reopened': { taskId: TaskId; revision: number; reason: string }
  'task.cancelled': { taskId: TaskId; revision: number; reason: string }
  'task.blocked': { taskId: TaskId; revision: number; reason: string }
  'attempt.revoked': { taskId: TaskId; attemptId: string; reason: string }

  'knowledge.proposed': { entry: KnowledgeEntry }
  'knowledge.adopted': { entryId: KnowledgeEntryId; revision: number; adoptedBy: string }
  'knowledge.revised': { entry: KnowledgeEntry }
  'knowledge.archived': { entryId: KnowledgeEntryId; revision: number }

  'config.defaults.changed': {
    configRevision: number
    config: ConfigOverrides
  }
  'config.override.changed': {
    teamId: TeamId
    configRevision: number
    overrides: ConfigOverrides
    snapshot: EffectiveConfigSnapshot
  }
  'config.rebased': {
    teamId: TeamId
    configRevision: number
    previousRevision: number
    snapshot: EffectiveConfigSnapshot
  }

  'effect.requested': { effect: Effect }
  'effect.accepted': { effectId: EffectId; externalId: string; acceptedAt: string }
  'effect.completed': {
    effectId: EffectId
    result: Record<string, unknown>
    completedAt: string
  }
  'effect.failed': { effectId: EffectId; error: ErrorShape; failedAt: string }
  'effect.cancelled': { effectId: EffectId; reason: string; cancelledAt: string }
  'effect.outcome-unknown': { effectId: EffectId; reason: string; observedAt: string }

  'message.posted': { message: TeamMessage }
}

export type EventPayload<T extends EventType> = EventPayloads[T]

export interface EventEnvelope<T extends EventType = EventType> {
  schemaVersion: typeof SCHEMA_VERSION
  eventId: string
  projectId: ProjectId
  /** 项目全序；0 保留给「尚未提交」，durable 事件从 1 开始。 */
  projectSeq: number
  batchId: string
  batchIndex: number
  type: T
  actor: ActorRef
  occurredAt: string
  causationId?: string
  correlationId?: string
  entity: EntityRef
  entityRevision?: number
  configRevision?: number
  payload: EventPayloads[T]
  legacy?: LegacyOrigin
}

/** 具体类型的事件，等价于 `EventEnvelope<'task.created'>`。 */
export type EventOf<T extends EventType> = EventEnvelope<T>

/** 目录里出现过的全部事件类型，测试用它证明「每个类型都有投影或显式忽略」。 */
/**
 * 全部事件类型的**运行时**清单。
 *
 * 为什么要和上面的 `EventType` 联合手工同步：扫描器用它判定「这行是不是已知事件」，
 * 未知类型会被当成日志损坏（`PROJECT_WRITE_BLOCKED`），整个项目停止写入。
 *
 * **真实踩过**：加 `team.plan.*` 时只改了联合、忘了这里，第一次 commit 写进去、
 * 第二次 commit 重扫就判损坏 —— 而且报错说的是「日志损坏」，完全指不到根因。
 * 现在由 `t63` 守着：两张表必须完全一致，缺一个就红。
 */
export const EVENT_TYPES: readonly EventType[] = [
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
  'team.plan.proposed',
  'team.plan.approved',
  'team.plan.discarded',
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

/** 运行期判定：读到未知 type 时按损坏处理，而不是当成「无害的新事件」跳过。 */
export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}