/**
 * 全局库直改用例（G2）—— 在全局库上直接改一个定义，不经过任何项目。
 *
 * 与 `publication.ts` 的分工：
 *   - 发布（publish）：项目副本 → 全局库，读 `runtime.state` 里的定义；
 *   - 直改（edit）：全局库 → 全局库，读**全局目录**里的定义，与项目无关。
 *
 * 两条路都写同一个 `audit/global-operations.jsonl`，只是 action 不同。
 *
 * 为什么蓝图引用要按全局目录解析：全局蓝图引用的必须是**全局角色/工作流**。若复用项目
 * `state.roles` 判断「引用能不能解析」，就会放过「全局蓝图引用了一个只存在于某个项目里的
 * 角色」—— 那种数据一旦写进全局库，别的项目建团时必然断引用。
 */
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import type {
  GlobalEditResult,
  GlobalLibraryEditPort,
  PublicationKind,
} from '../contracts/publication.ts'
import { normalizeBlueprint, validateBlueprint } from '../domain/definitions/blueprint.ts'
import { normalizeRole, roleContentHash, validateRole } from '../domain/definitions/role.ts'
import { blueprintContentHash } from '../domain/definitions/blueprint.ts'
import { normalizeWorkflow, validateWorkflow, workflowContentHash } from '../domain/definitions/workflow.ts'
import type { RoleDefinition, TeamBlueprint, WorkflowDefinition } from '../contracts/entities.ts'

/** 全局目录里的一员，只取校验要用的部分。 */
export interface GlobalEntryRef {
  kind: PublicationKind
  id: string
  revision: number
}

/** 读全局目录：直改用它判断「谁在引用谁」，不碰项目投影。 */
export interface GlobalEntryReader {
  /** 列出某类全局条目的引用信息；用于蓝图/工作流的引用校验。 */
  list(kind: PublicationKind): GlobalEntryRef[]
}

export interface EditGlobalDefinitionInput {
  actor: ActorRef
  kind: PublicationKind
  id: string
  /** 新内容本体（不含 id/revision，由这里补齐）。 */
  definition: unknown
  /** 调用方看到的当前文件 hash；新建传 null。 */
  expectedHash: string | null
  operationId: string
  editedAt: string
  editor: string
}

export interface EditGlobalDefinitionResult {
  outcome: 'edited'
  kind: PublicationKind
  id: string
  revision: number
  file: string
  globalHash: string
  previousHash: string | null
  contentHash: string
}

/** 当前全局文件的内容 hash 是否与调用方看到的一致。 */
function assertNotStale(editor: GlobalLibraryEditPort, kind: PublicationKind, id: string, expectedHash: string | null): void {
  const actual = editor.readFileHash(kind, id)
  if (actual !== expectedHash) {
    const shorten = (hash: string | null) => (hash === null ? '不存在' : hash.slice(0, 16) + '…')
    fail(
      ERROR_CODES.CONFLICT,
      `全局库里的 ${kind}/${id}.json 已经被别人改过了（期望 ${shorten(expectedHash)}，实际 ${shorten(actual)}）；重新载入后再改`,
      { details: { kind, id, expectedHash, actualHash: actual } },
    )
  }
}

/**
 * 直改一个全局定义。
 *
 * 流程：冲突检测 → 领域校验（按种类）→ 写文件 + 审计。
 * 校验复用项目的 domain 校验器，**蓝图/工作流的引用解析器换成全局目录**。
 */
export function editGlobalDefinition(
  deps: { editor: GlobalLibraryEditPort; globalEntries: GlobalEntryReader },
  input: EditGlobalDefinitionInput,
): EditGlobalDefinitionResult {
  assertNotStale(deps.editor, input.kind, input.id, input.expectedHash)

  if (input.kind === 'role') {
    const role = normalizeRole({
      ...(input.definition as RoleDefinition),
      id: input.id,
      revision: 1,
    })
    const problems = validateRole(role)
    if (problems.length > 0) fail(ERROR_CODES.INVALID_PAYLOAD, '角色定义不合法', { details: { problems } })
    const written = deps.editor.writeFile({
      kind: 'role',
      id: input.id,
      definition: role,
      revision: role.revision,
      operationId: input.operationId,
      expectedHash: input.expectedHash,
      editedAt: input.editedAt,
      editor: input.editor,
    })
    return {
      outcome: 'edited',
      kind: 'role',
      id: input.id,
      revision: role.revision,
      contentHash: roleContentHash(role),
      ...pick(written),
    }
  }

  if (input.kind === 'workflow') {
    const workflow = normalizeWorkflow({
      ...(input.definition as WorkflowDefinition),
      id: input.id,
      revision: 1,
    })
    // 工作流模板引用的角色也必须在全局目录里 —— 与蓝图同一条道理。
    const globalRoleIds = new Set(deps.globalEntries.list('role').map((entry) => entry.id))
    const missingRoles = workflow.templates
      .map((template) => template.requiredRoleId)
      .filter((roleId): roleId is string => roleId !== null && roleId !== undefined)
      .filter((roleId) => !globalRoleIds.has(roleId))
    if (missingRoles.length > 0) {
      fail(ERROR_CODES.NOT_FOUND, '工作流引用的角色不在全局库里', { details: { missingRoles } })
    }
    const problems = validateWorkflow(workflow)
    if (problems.length > 0) fail(ERROR_CODES.INVALID_PAYLOAD, '工作流定义不合法', { details: { problems } })
    const written = deps.editor.writeFile({
      kind: 'workflow',
      id: input.id,
      definition: workflow,
      revision: workflow.revision,
      operationId: input.operationId,
      expectedHash: input.expectedHash,
      editedAt: input.editedAt,
      editor: input.editor,
    })
    return {
      outcome: 'edited',
      kind: 'workflow',
      id: input.id,
      revision: workflow.revision,
      contentHash: workflowContentHash(workflow),
      ...pick(written),
    }
  }

  // blueprint
  const blueprint = normalizeBlueprint({
    ...(input.definition as TeamBlueprint),
    id: input.id,
    revision: 1,
  })
  const globalRoles = new Map(deps.globalEntries.list('role').map((entry) => [entry.id, entry]))
  const globalWorkflows = new Map(deps.globalEntries.list('workflow').map((entry) => [entry.id, entry]))
  const problems = validateBlueprint(
    blueprint,
    (roleId) => globalRoles.get(roleId),
    (workflowId) => globalWorkflows.get(workflowId),
  )
  if (problems.length > 0) fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图不合法（引用必须是全局库里的角色/工作流）', { details: { problems } })
  const written = deps.editor.writeFile({
    kind: 'blueprint',
    id: input.id,
    definition: blueprint,
    revision: blueprint.revision,
    operationId: input.operationId,
    expectedHash: input.expectedHash,
    editedAt: input.editedAt,
    editor: input.editor,
  })
  return {
    outcome: 'edited',
    kind: 'blueprint',
    id: input.id,
    revision: blueprint.revision,
    contentHash: blueprintContentHash(blueprint),
    ...pick(written),
  }
}

function pick(written: GlobalEditResult): { file: string; globalHash: string; previousHash: string | null } {
  return { file: written.file, globalHash: written.globalHash, previousHash: written.previousHash }
}

export interface UnpublishGlobalInput {
  actor: ActorRef
  kind: PublicationKind
  id: string
  /** 调用方看到的当前文件 hash。 */
  expectedHash: string
  operationId: string
  unpublishedAt: string
  editor: string
}

/**
 * 下架一个全局定义（`definition.unpublish`）—— 只影响目录可见性，不删文件。
 *
 * 为什么不做「真删除」：事件与文件都保留才能让引用方继续读到这一版；真删会让
 * 已经引用它的工作流/蓝图/团队断引用，那不是「下架」，是破坏。
 */
export function unpublishGlobalDefinition(
  deps: { editor: GlobalLibraryEditPort },
  input: UnpublishGlobalInput,
): { outcome: 'unpublished'; kind: PublicationKind; id: string; file: string } {
  const actual = deps.editor.readFileHash(input.kind, input.id)
  if (actual === null) {
    fail(ERROR_CODES.NOT_FOUND, '全局库里没有这份定义', { details: { kind: input.kind, id: input.id } })
  }
  if (actual !== input.expectedHash) {
    const shorten = (hash: string | null) => (hash === null ? '不存在' : hash.slice(0, 16) + '…')
    fail(
      ERROR_CODES.CONFLICT,
      `全局库里的 ${input.kind}/${input.id}.json 已经被别人改过了（期望 ${shorten(input.expectedHash)}，实际 ${shorten(actual)}）；重新载入后再下架`,
      { details: { kind: input.kind, id: input.id, expectedHash: input.expectedHash, actualHash: actual } },
    )
  }
  const result = deps.editor.unpublish({
    kind: input.kind,
    id: input.id,
    operationId: input.operationId,
    expectedHash: input.expectedHash,
    unpublishedAt: input.unpublishedAt,
    editor: input.editor,
  })
  return { outcome: 'unpublished', kind: input.kind, id: input.id, file: result.file }
}
