/**
 * v2 实体数据形状（只有数据，没有规则）。
 *
 * 放在 contracts 而不是 domain 的原因：同一批形状同时被事件载荷、领域规则、
 * 投影、RPC 和迁移读取。若在 domain 定义、contracts 再声明一份，两边一漂移
 * 就会出现「事件写进去的字段投影不认识」。这里只有字段与枚举，规则一律在
 * domain/{definitions,tasks,teams,config,permissions}。
 */
import type {
  AttemptId,
  BlueprintId,
  EffectId,
  GateVerdictId,
  KnowledgeEntryId,
  MemberId,
  MessageId,
  ProjectId,
  RoleId,
  SessionId,
  TaskId,
  TeamId,
  WorkflowId,
  WorkflowRunId,
} from './ids.ts'

/** 定义资产的来源作用域。`builtin` 是插件内置只读层，不参与全局写。 */
export type DefinitionScope = 'builtin' | 'global' | 'project'

export interface SkillRef {
  skillId: string
  name?: string
  version?: string
  hash?: string
}

/** Tool/MCP 权限只有允许与拒绝两列；`deny` 优先，且不能重新打开上层已拒绝项。 */
export interface CapabilityPolicy {
  allow: string[]
  deny: string[]
}

export interface CapabilitySet {
  tools: CapabilityPolicy
  mcp: CapabilityPolicy
  skills: SkillRef[]
}

/** RoleProfile 只描述「这个角色是什么」，不描述任务、流程或运行状态。 */
export interface RoleProfile {
  name: string
  purpose: string
  instructions: string
  specialties: string[]
}

export interface RoleDefinition {
  id: RoleId
  revision: number
  profile: RoleProfile
  capabilities: CapabilitySet
  createdAt: string
  updatedAt: string
}

/** 门禁规格：可执行命令、是否必须附证据、是否必须产出交付物。 */
export interface GateSpec {
  commands: string[]
  requireEvidence: boolean
  requireArtifacts: boolean
}

export interface DeliverableSpec {
  paths: string[]
  description: string
}

/** TaskTemplate 只是模板：实例化后才成为项目 Task，模板 key 不跨定义唯一。 */
export interface TaskTemplate {
  key: string
  title: string
  description: string
  acceptance: string[]
  requiredRoleId: RoleId | null
  dependsOn: string[]
  gate: GateSpec
  deliverable: DeliverableSpec | null
}

export type CompletionMode = 'all-tasks' | 'required-tasks'

export interface CompletionRule {
  mode: CompletionMode
  requiredKeys: string[]
}

export interface WorkflowDefinition {
  id: WorkflowId
  revision: number
  name: string
  description: string
  templates: TaskTemplate[]
  completion: CompletionRule
  createdAt: string
  updatedAt: string
}

/** 队形槽位：角色引用 + 数量；父槽位用于表达「某角色下的子成员」。 */
export interface FormationSlot {
  /** 槽位 key，只在蓝图内唯一；parentSlotKey 指向它。 */
  key: string
  roleId: RoleId
  count: number
  parentSlotKey: string | null
}

export interface TeamBlueprint {
  id: BlueprintId
  revision: number
  name: string
  description: string
  formation: FormationSlot[]
  workflows: WorkflowId[]
  defaults: ConfigOverrides
  createdAt: string
  updatedAt: string
}

// —— 配置 ——

/** 硬性安全上限：业务配置只能收紧，不能突破。 */
export interface SafetyLimits {
  maxMembersPerTeam: number
  maxMemberDepth: number
  maxChildrenPerMember: number
  maxParallelAttempts: number
  maxEscalationsPerTask: number
  commandTimeoutMs: number
}

export interface TeamConfig {
  limits: {
    maxMembers: number
    maxMemberDepth: number
    maxChildrenPerMember: number
    maxParallelAttempts: number
    maxEscalationsPerTask: number
  }
  gates: {
    requireEvidence: boolean
    requireArtifacts: boolean
    commandTimeoutMs: number
  }
  messaging: {
    allowMemberToMember: boolean
    maxMessagesPerTask: number
  }
}

/** 覆盖层只允许出现可覆盖字段；未知键在校验时报错，不静默保留。 */
export type ConfigOverrides = {
  limits?: Partial<TeamConfig['limits']>
  gates?: Partial<TeamConfig['gates']>
  messaging?: Partial<TeamConfig['messaging']>
}

export interface EffectiveConfigSnapshot {
  configRevision: number
  values: TeamConfig
  mergeAlgorithmVersion: string
  safetyLimitsVersion: string
  contentHash: string
  /** 被安全上限钳制掉的请求值；为空表示没有发生钳制。 */
  clamped: { field: string; requested: number; applied: number }[]
  /** 组成该快照的三层来源 revision，便于解释「这个值从哪来」。 */
  sources: {
    projectDefaultsRevision: number
    blueprintRevision: number | null
    teamOverridesRevision: number
  }
}

// —— 团队与成员 ——

export type TeamStatus = 'active' | 'archived' | 'disbanded'

export interface DefinitionRef {
  id: string
  revision: number
}

export interface Team {
  id: TeamId
  name: string
  goal: string
  status: TeamStatus
  blueprint: DefinitionRef | null
  configRevision: number
  revision: number
  createdAt: string
  updatedAt: string
}

/**
 * 一份**待人类批准**的开队计划。
 *
 * 为什么计划是独立聚合、而不是「草稿态的团队」（见 docs/decisions/团队计划批准.md §3）：
 * 设计稿要求「批准前不产生任何会话与花费」。如果先建团队与成员占位，这条就变成
 * **靠下游容错**（看板、名册、配置、Run 都得容忍「无会话成员」），而且丢弃后留下残留实体。
 * 把计划做成独立聚合，「批准前什么都没建」是结构保证，丢弃只需清掉这一条。
 *
 * 计划被批准后即被**消费**（不再存在）；「批准后不可回到草稿」因此天然成立。
 */
export interface TeamPlan {
  id: TeamPlanId
  /** 计划要建的团队名与目标。 */
  name: string
  goal: string
  /** 蓝图引用（含 revision：批准绑这一版）。 */
  blueprint: DefinitionRef | null
  /**
   * 队形快照。蓝图里的 formation 允许在向导里改，改的是**这份副本**；
   * 队长不在 formation 里（每队一个任期，单独由 captainSessionId 表达）。
   */
  formation: FormationSlot[]
  /** 默认工作流（第一次开 Run 用）；null 表示批准后不自动开 Run。 */
  workflow: DefinitionRef | null
  /** 队长会话：提案人的会话。 */
  captainSessionId: SessionId
  /** 配置覆盖：蓝图默认 + 向导调整后的最终值。 */
  overrides: ConfigOverrides
  /**
   * 计划内容 hash。批准令牌绑它 —— 队形/工作流/配置任何一项被改过，hash 就变，
   * 令牌立刻失效。只绑 planId 是不够的：内容可以在预览与确认之间被改。
   */
  planHash: string
  proposedBy: string
  proposedAt: string
}

export type CaptainAssignmentReason = 'initial' | 'handoff' | 'recovery'

export interface CaptainAssignment {
  teamId: TeamId
  sessionId: SessionId
  generation: number
  reason: CaptainAssignmentReason
  assignedAt: string
}

/**
 * 成员状态。
 *
 * `archived` 与 `released` **不是一回事**（见 docs/decisions/成员归档语义.md）：
 *   - archived：退役但可回放 —— 名册留痕、记忆 bank 与证据都保留、允许恢复；
 *   - released：终态，成员彻底离开，不提供恢复。
 */
export type MemberStatus = 'appointed' | 'active' | 'paused' | 'archived' | 'released'

export interface Member {
  id: MemberId
  teamId: TeamId
  roleId: RoleId
  roleRevision: number
  /** 聘任时固化的角色快照：之后改 RoleDefinition 不影响既有成员。 */
  roleSnapshot: RoleDefinition
  parentMemberId: MemberId | null
  status: MemberStatus
  sessionId: SessionId | null
  memberSessionGeneration: number
  capabilities: CapabilitySet
  revision: number
  createdAt: string
  updatedAt: string
}

// —— 任务与执行 ——

export type TaskStatus =
  | 'planned'
  | 'ready'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled'

export type ParticipationRole = 'owner' | 'collaborator'

export interface Participation {
  teamId: TeamId
  role: ParticipationRole
}

/** Attempt 是一次认领的执行世代；generation 单调递增，旧世代写入一律拒绝。 */
export type AttemptStatus = 'active' | 'completed' | 'failed' | 'revoked'

export interface Attempt {
  id: AttemptId
  taskId: TaskId
  teamId: TeamId
  memberId: MemberId
  generation: number
  configRevision: number
  roleRevision: number
  sessionId: SessionId
  status: AttemptStatus
  startedAt: string
  endedAt: string | null
}

export type VerdictOutcome = 'pass' | 'fail' | 'blocked'

export interface GateCheckResult {
  command: string
  exitCode: number | null
  stdoutHash: string | null
  summary: string
}

export interface GateVerdict {
  id: GateVerdictId
  taskId: TaskId
  attemptId: AttemptId
  outcome: VerdictOutcome
  checks: GateCheckResult[]
  evidence: EvidenceRef[]
  decidedAt: string
}

export interface EvidenceRef {
  kind: 'file' | 'command' | 'session' | 'url' | 'artifact'
  ref: string
  excerpt?: string
  hash?: string
}

export interface Task {
  id: TaskId
  title: string
  description: string
  acceptance: string[]
  status: TaskStatus
  ownerTeamId: TeamId | null
  collaborators: Participation[]
  /** 依赖边归下游任务所有；内容是本任务的 project taskId 列表。 */
  dependencies: TaskId[]
  runId: WorkflowRunId | null
  templateKey: string | null
  requiredRoleId: RoleId | null
  gate: GateSpec
  deliverable: DeliverableSpec | null
  attemptId: AttemptId | null
  revision: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type WorkflowRunStatus = 'active' | 'completed' | 'cancelled'

export interface WorkflowRun {
  id: WorkflowRunId
  workflowId: WorkflowId
  workflowRevision: number
  teamId: TeamId
  status: WorkflowRunStatus
  /** 完成规则每次变化都推进，防止「新增任务让完成条件无记录漂移」。 */
  completionRevision: number
  taskIds: TaskId[]
  templateKeyToTaskId: Record<string, TaskId>
  revision: number
  createdAt: string
  updatedAt: string
}

// —— 知识 ——

export type KnowledgeStatus = 'proposed' | 'adopted' | 'archived'

export interface KnowledgeEntry {
  id: KnowledgeEntryId
  title: string
  body: string
  evidence: EvidenceRef[]
  status: KnowledgeStatus
  supersedes: KnowledgeEntryId | null
  revision: number
  createdAt: string
  updatedAt: string
}

// —— Effect 与消息 ——

export type EffectKind =
  | 'spawn-member'
  | 'resume-member'
  | 'release-member'
  | 'send-message'
  | 'run-gate-command'
  | 'materialize-config'
  | 'materialize-knowledge'
  | 'publish-global'

/** 重试类别决定「结果未知」时能不能重放；幂等键只用于关联，不代替核验。 */
export type EffectRetry = 'idempotent' | 'reconcilable' | 'non-idempotent'

export type EffectStatus =
  | 'requested'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome-unknown'

export interface Effect {
  id: EffectId
  kind: EffectKind
  retry: EffectRetry
  status: EffectStatus
  idempotencyKey: string
  teamId: TeamId | null
  payload: Record<string, unknown>
  externalId: string | null
  result: Record<string, unknown> | null
  requestedAt: string
  settledAt: string | null
}

export interface MessageSender {
  kind: 'captain' | 'member' | 'human' | 'system'
  id: string
}

export interface MessageTarget {
  kind: 'team' | 'member'
  id: string
}

export interface TeamMessage {
  id: MessageId
  teamId: TeamId
  from: MessageSender
  to: MessageTarget
  subject: string
  body: string
  createdAt: string
  effectId: EffectId | null
}

// —— 项目与迁移 ——

export interface ProjectManifest {
  projectId: ProjectId
  name: string
  layoutVersion: number
  schemaVersion: number
  createdAt: string
}

/**
 * 迁移来源。`projectSeq` 之后的 `seq` 是旧账本序号，仅用于追溯；
 * `syntheticOrder` 标记该行来自多团队合成顺序，不是旧账本的原始全序。
 */
export interface LegacyOrigin {
  source: 'team-workplace' | 'ledger-tasks' | 'ledger-state-teams' | 'global-library' | 'memory-sqlite' | 'knowledge-md'
  teamId?: string
  sourceLine?: number
  sourceSeq?: number
  sourceTs?: string
  sourceHash?: string
  syntheticOrder?: boolean
  unknownConfigRevision?: boolean
}