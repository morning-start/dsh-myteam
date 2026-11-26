/**
 * 全局发布：把项目里的定义副本发布到全局库（`$DSH_HOME/myteam`）。
 *
 * 两段：
 *  1. `requestDefinitionPublication` 算影响面并落 `definition.publication.requested`
 *     （operationId 就是这次发布，人类的确认令牌绑在它的 targetHash / impactHash 上）；
 *  2. `confirmDefinitionPublication` 验令牌后先落 `authorized`，再写全局库文件与审计，
 *     最后落 `outcome`。写失败也落 `outcome: failed`——账本不能停在「授权了但不知道
 *     结果」，那正是事后最难查的状态。
 *
 * 为什么请求也要落账本：发布是**跨作用域**的写（项目 → 全局库）。只留授权与结果，
 * 「谁想发、当时的引用与覆盖情况是什么」就再也拼不出来。
 *
 * 令牌在确认时按**当时**的定义内容与影响面重算，所以预览之后改过定义就会
 * `CONFIRMATION_TARGET_CHANGED`：确认的必须是看到的那一版。
 */
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'
import type { ActorRef } from '../contracts/events.ts'
import type { GlobalPublicationPort, PublicationKind } from '../contracts/publication.ts'
import { hashContent } from '../contracts/json.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { HumanAuthorizer, HumanConfirmation } from '../domain/permissions/human-authorizer.ts'
import { authorize } from '../domain/permissions/policy.ts'
import { blueprintContentHash } from '../domain/definitions/blueprint.ts'
import { roleContentHash } from '../domain/definitions/role.ts'
import { workflowContentHash } from '../domain/definitions/workflow.ts'

/** 发布影响面：会带上什么、缺什么、会不会覆盖。 */
export interface PublicationImpact {
  references: { kind: string; id: string; revision: number }[]
  missingReferences: string[]
  overwrites: boolean
  irreversible: string[]
}

export interface PublicationTarget {
  kind: PublicationKind
  id: string
  targetHash: string
  definitionRevision: number
}

export interface PublicationPreview {
  operationId: string
  kind: PublicationKind
  id: string
  name: string
  summary: string
  target: PublicationTarget
  impact: PublicationImpact
  targetHash: string
  impactHash: string
}

const KIND_LABEL: Readonly<Record<PublicationKind, string>> = {
  role: '角色',
  workflow: '工作流',
  blueprint: '团队蓝图',
}

function entityKindOf(kind: PublicationKind): 'role-definition' | 'workflow-definition' | 'team-blueprint' {
  if (kind === 'role') return 'role-definition'
  if (kind === 'workflow') return 'workflow-definition'
  return 'team-blueprint'
}

function actorLabel(actor: ActorRef): string {
  if (actor.kind === 'human') return `human:${actor.userId}`
  if (actor.kind === 'captain') return `captain:${actor.sessionId}`
  if (actor.kind === 'member') return `member:${actor.memberId}`
  return actor.kind
}

function stringsOf(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

interface ResolvedContent {
  definition: unknown
  revision: number
  hash: string
  name: string
  references: { kind: string; id: string; revision: number }[]
  missing: string[]
}

/** 取定义本体、内容 hash、引用与缺失引用。 */
function resolveContent(runtime: ProjectRuntime, kind: PublicationKind, id: string): ResolvedContent {
  const state = runtime.state
  if (kind === 'role') {
    const role = state.roles.get(id)
    if (role === undefined) fail(ERROR_CODES.NOT_FOUND, '角色定义不存在', { details: { kind, id } })
    return { definition: role, revision: role.revision, hash: roleContentHash(role), name: role.profile.name, references: [], missing: [] }
  }
  if (kind === 'workflow') {
    const workflow = state.workflows.get(id)
    if (workflow === undefined) fail(ERROR_CODES.NOT_FOUND, '工作流定义不存在', { details: { kind, id } })
    const roleIds = stringsOf(workflow.templates.map((template) => template.requiredRoleId))
    return {
      definition: workflow,
      revision: workflow.revision,
      hash: workflowContentHash(workflow),
      name: workflow.name,
      references: roleIds.map((roleId) => ({ kind: 'role', id: roleId, revision: state.roles.get(roleId)?.revision ?? 0 })),
      missing: roleIds.filter((roleId) => !state.roles.has(roleId)).map((roleId) => `role:${roleId}`),
    }
  }
  const blueprint = state.blueprints.get(id)
  if (blueprint === undefined) fail(ERROR_CODES.NOT_FOUND, '团队蓝图不存在', { details: { kind, id } })
  const roleIds = stringsOf(blueprint.formation.map((slot) => (slot as { roleId?: string | null }).roleId ?? null))
  const workflowIds = stringsOf(blueprint.workflows)
  return {
    definition: blueprint,
    revision: blueprint.revision,
    hash: blueprintContentHash(blueprint),
    name: blueprint.name,
    references: [
      ...roleIds.map((roleId) => ({ kind: 'role', id: roleId, revision: state.roles.get(roleId)?.revision ?? 0 })),
      ...workflowIds.map((workflowId) => ({ kind: 'workflow', id: workflowId, revision: state.workflows.get(workflowId)?.revision ?? 0 })),
    ],
    missing: [
      ...roleIds.filter((roleId) => !state.roles.has(roleId)).map((roleId) => `role:${roleId}`),
      ...workflowIds.filter((workflowId) => !state.workflows.has(workflowId)).map((workflowId) => `workflow:${workflowId}`),
    ],
  }
}

interface Described {
  content: ResolvedContent
  target: PublicationTarget
  impact: PublicationImpact
  summary: string
  targetHash: string
  impactHash: string
}

function describe(runtime: ProjectRuntime, publisher: GlobalPublicationPort, kind: PublicationKind, id: string): Described {
  const content = resolveContent(runtime, kind, id)
  const overwrites = publisher.exists(kind, id)
  const impact: PublicationImpact = {
    references: content.references,
    missingReferences: content.missing,
    overwrites,
    irreversible: [
      overwrites ? '全局库里已有同名定义，这次会覆盖，旧内容不保留' : '全局库会多出一份定义，项目侧删不掉',
      '发布只写全局库，不改动项目内的定义副本',
    ],
  }
  const label = KIND_LABEL[kind]
  const summary = `发布${label}「${content.name}」到全局库：引用 ${content.references.length} 项、缺失 ${content.missing.length} 项${overwrites ? '、将覆盖已有版本' : ''}`
  return {
    content,
    target: { kind, id, targetHash: content.hash, definitionRevision: content.revision },
    impact,
    summary,
    targetHash: content.hash,
    impactHash: hashContent(impact),
  }
}

/**
 * 第一步：申请发布，落 `requested` 事件并返回影响面。
 *
 * 动作是 `definition.publish.request`（队长可发起，人类也可以）；真正写全局库要等人类确认。
 * @param runtime - 项目运行时（已刷新到最新账本）。
 * @param deps - 全局库端口（只用到 `exists` 判断覆盖）。
 * @param input - 发起人、定义种类与 id。
 */
export function requestDefinitionPublication(
  runtime: ProjectRuntime,
  deps: { publisher: GlobalPublicationPort },
  input: { actor: ActorRef; kind: PublicationKind; id: string },
): PublicationPreview {
  authorize('definition.publish.request', input.actor)
  const described = describe(runtime, deps.publisher, input.kind, input.id)
  const operationId = runtime.nextId('operation')

  const draft: DraftEvent = {
    type: 'definition.publication.requested',
    actor: input.actor,
    entity: { kind: entityKindOf(input.kind), id: input.id },
    payload: {
      operationId,
      target: described.target,
      impact: described.impact,
      requestedBy: actorLabel(input.actor),
    },
  }
  runtime.commit([draft])

  return {
    operationId,
    kind: input.kind,
    id: input.id,
    name: described.content.name,
    summary: described.summary,
    target: described.target,
    impact: described.impact,
    targetHash: described.targetHash,
    impactHash: described.impactHash,
  }
}

/**
 * 第二步：人类确认后写全局库。
 *
 * 顺序固定：验令牌 → 落 `authorized` → 写文件与审计 → 落 `outcome`。
 * 写失败也落 `outcome: failed` 再抛错，避免「授权了但不知道结果」。
 *
 * @param runtime - 项目运行时（已刷新；定义若在预览后被改过，令牌会失效）。
 * @param deps - 令牌校验器与全局库端口。
 * @param input - 确认人、operationId、定义种类与 id、一次性令牌。
 */
export function confirmDefinitionPublication(
  runtime: ProjectRuntime,
  deps: { authorizer: HumanAuthorizer; publisher: GlobalPublicationPort },
  input: {
    actor: ActorRef
    operationId: string
    kind: PublicationKind
    id: string
    confirmation: HumanConfirmation
  },
): { outcome: 'published'; file: string; globalHash: string; commit: CommitResult } {
  authorize('definition.publish.confirm', input.actor)
  const described = describe(runtime, deps.publisher, input.kind, input.id)
  deps.authorizer.verify(input.confirmation, {
    operationId: input.operationId,
    action: 'definition.publish.confirm',
    targetHash: described.targetHash,
    impactHash: described.impactHash,
  })
  deps.authorizer.consume(input.confirmation)

  const entity = { kind: entityKindOf(input.kind), id: input.id } as const
  runtime.commit([
    {
      type: 'definition.publication.authorized',
      actor: input.actor,
      entity,
      payload: {
        operationId: input.operationId,
        targetHash: described.targetHash,
        nonceHash: input.confirmation.nonceHash,
        expiresAt: input.confirmation.expiresAt,
        confirmedBy: actorLabel(input.actor),
      },
    },
  ])

  try {
    const written = deps.publisher.publish({
      kind: input.kind,
      id: input.id,
      definition: described.content.definition,
      operationId: input.operationId,
      revision: described.content.revision,
      sourceProjectId: runtime.projectId,
      publishedAt: runtime.now(),
    })
    const commit = runtime.commit([
      {
        type: 'definition.publication.outcome',
        actor: input.actor,
        entity,
        payload: { operationId: input.operationId, outcome: 'published', globalHash: written.globalHash, error: null },
      },
    ])
    return { outcome: 'published', file: written.file, globalHash: written.globalHash, commit }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    runtime.commit([
      {
        type: 'definition.publication.outcome',
        actor: input.actor,
        entity,
        payload: {
          operationId: input.operationId,
          outcome: 'failed',
          globalHash: null,
          error: { code: ERROR_CODES.GLOBAL_PUBLISH_FAILED, message, retryable: true },
        },
      },
    ])
    fail(ERROR_CODES.GLOBAL_PUBLISH_FAILED, `写全局库失败：${message}`, {
      details: { operationId: input.operationId, kind: input.kind, id: input.id },
      retryable: true,
      cause: error,
    })
  }
}