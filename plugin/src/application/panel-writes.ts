/**
 * 面板写通道（人类确认类动作）。
 *
 * 与只读面**分开**：只读方法用 `PANEL_METHODS`，写方法只认这里的白名单，而且
 * 一律走仓里既有的两段确认协议（`HumanAuthorizer` + `human-actions.ts`）：
 *
 *   1. 不带 `action: 'confirm'` → 返回**影响面预览** + 一次性确认令牌；
 *   2. 带令牌与 `action: 'confirm'` → 执行、消费令牌，令牌不可复用。
 *
 * 为什么令牌不能省：预览算出的 `targetHash` / `impactHash` 会在确认时按**当时的
 * 状态重算**，任何变化都会让校验失败——这才是「确认的是你看到的那件事」。
 *
 * 入口身份：本机 Web GUI 是单属主（owner）部署，面板动作记为 `human/owner`、
 * `via: 'panel'`；模型没有这条通道。
 */
import { randomUUID } from 'node:crypto'
import type { ActorRef } from '../contracts/events.ts'
import type { ConfigOverrides, EvidenceRef, FormationSlot, GateCheckResult, GateVerdict, Task, VerdictOutcome } from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { GlobalLibraryEditPort, GlobalPublicationPort, PublicationKind } from '../contracts/publication.ts'
import type { GlobalEntryReader } from './global-edit.ts'
import type { ProjectDestroyPort } from '../contracts/project-destroy.ts'
import { editGlobalDefinition, unpublishGlobalDefinition } from './global-edit.ts'
import { HumanAuthorizer } from '../domain/permissions/human-authorizer.ts'
import type { HumanConfirmation } from '../domain/permissions/human-authorizer.ts'
import {
  appointMemberCommand,
  archiveMemberCommand,
  claimTaskCommand,
  createProjectBlueprint,
  createTaskCommand,
  createTeamCommand,
  releaseMemberCommand,
  restoreMemberCommand,
  saveProjectBlueprintCommand,
  saveProjectRole,
  saveProjectWorkflowCommand,
} from './commands.ts'
import { forgetMemory, rememberMemory } from './memory-commands.ts'
import { approveTeamPlanCommand, discardTeamPlanCommand, proposeTeamPlanCommand } from './commands.ts'
import { confirmTeamPlanApproval, previewTeamPlanApproval } from './human-actions.ts'
import type { MemoryPort } from './ports.ts'
import { confirmDefinitionPublication, requestDefinitionPublication } from './publication.ts'
import { confirmCaptainTakeover, confirmTeamDisband, previewCaptainTakeover, previewTeamDisband } from './human-actions.ts'
import type { ProjectRuntime } from './project-runtime.ts'
import { cancelTaskCommand, recordVerdictCommand, reopenTaskCommand } from './task-commands.ts'

/** 面板写方法白名单。新增写能力必须同时在这里登记并补测试。 */
export const PANEL_WRITE_METHODS = [
  'teamDisband',
  'captainTakeover',
  'gateVerdict',
  'taskCreate',
  'taskMove',
  'teamCreate',
  'memberAppoint',
  'memberRelease',
  'memberArchive',
  'memberRestore',
  'definitionPublish',
  'globalDefinitionSave',
  'globalUnpublish',
  'projectDestroy',
  'definitionSave',
  'memoryRemember',
  'memoryForget',
  'planPropose',
  'planDiscard',
  'planApprove',
] as const

export type PanelWriteMethod = (typeof PANEL_WRITE_METHODS)[number]

/**
 * 写方法的确认方式，决定请求怎么走：
 *
 * - `token`：先预览影响面拿一次性令牌，再凭令牌确认。用于 `HUMAN_ONLY` 动作——
 *   令牌把「你看到的影响面」和「真正执行的那次」绑死，中间状态变了就失败。
 * - `direct`：请求体带 `confirm: true` 直接执行。用于**不是人类专属**、但后果不可
 *   撤销的动作：它们在域里已有自己的前置校验（例如门禁裁决要求任务处于 `review`
 *   且 `attemptId` 是当前 Attempt），硬塞令牌只会造出一层没有信息的仪式。
 */
export type PanelWriteKind = 'token' | 'direct'

export const PANEL_WRITE_KINDS: Readonly<Record<PanelWriteMethod, PanelWriteKind>> = {
  teamDisband: 'token',
  captainTakeover: 'token',
  gateVerdict: 'direct',
  taskCreate: 'direct',
  taskMove: 'direct',
  teamCreate: 'direct',
  memberAppoint: 'direct',
  memberRelease: 'direct',
  memberArchive: 'direct',
  memberRestore: 'direct',
  definitionPublish: 'token',
  globalDefinitionSave: 'token',
  globalUnpublish: 'token',
  projectDestroy: 'token',
  definitionSave: 'direct',
  memoryRemember: 'direct',
  memoryForget: 'direct',
  // 提案与丢弃不改变任何实体（提案只落计划、丢弃零回滚），不需要令牌仪式。
  planPropose: 'direct',
  planDiscard: 'direct',
  // 批准会一次建出整个团队，是 HUMAN_ONLY —— 令牌把「看到的影响面」和「执行的那次」绑死。
  planApprove: 'token',
}

/** 判断一个名字是否为已登记的面板写方法。 */
export function isPanelWriteMethod(value: string): value is PanelWriteMethod {
  return (PANEL_WRITE_METHODS as readonly string[]).includes(value)
}

/** 写方法的确认方式。 */
export function panelWriteKind(method: PanelWriteMethod): PanelWriteKind {
  return PANEL_WRITE_KINDS[method]
}

/** 每个写方法的一句话说明；由 `tools/gen-panel-contract.mjs` 生成契约文档。 */
export const PANEL_WRITE_DOCS: Readonly<Record<PanelWriteMethod, string>> = {
  teamDisband: '解散团队：预览成员与任务影响面，凭一次性令牌执行。动作 `team.disband`（人类专属）。',
  captainTakeover: '队长接管：预览世代递增与生效成员，凭一次性令牌执行。动作 `captain.takeover`（人类专属）。',
  gateVerdict: '门禁裁决：对评审中的任务写入 pass / fail / blocked 与检查结果，需 `confirm: true`。',
  taskCreate: '新建任务：标题、验收标准、依赖与所需角色，建在指定团队下，需 `confirm: true`。',
  taskMove: '移动任务：只支持取消 / 重开 / 认领三个方向的合法迁移；完成必须走门禁裁决，需 `confirm: true`。',
  teamCreate: '建团队：名字、目标、队长会话（可选蓝图初始化角色与配置），需 `confirm: true`。',
  memberAppoint: '召唤成员：团队 + 角色（可选父成员与会话）→ 聘任并固化角色快照，需 `confirm: true`。',
  memberRelease: '释放成员（终态）：成员不能有进行中的尝试；释放后不再接活，需 `confirm: true`。',
  memberArchive: '归档成员（退役但可回放）：名册留痕、记忆与证据保留、可恢复；有进行中尝试时要么等结束（drain=wait），要么先暂停再归档（drain=pause）；子成员须先处理，需 `confirm: true`。',
  memberRestore: '恢复已归档成员（archived → active）；只对归档态有效，已释放不可恢复，需 `confirm: true`。',
  definitionSave: '保存项目定义（角色 / 工作流）：revision 递增并记 previousHash，需 `confirm: true`。',
  definitionPublish: '发布定义到全局库：预览引用与覆盖影响面，凭一次性令牌执行。动作 `definition.publish.confirm`（人类专属）。',
  globalDefinitionSave: '直改全局库里的定义（不经项目）：预览引用与被引用、冲突检测（expectedHash），凭一次性令牌执行。动作 `definition.global.write`（人类专属）。',
  globalUnpublish: '下架全局库里的定义：只从目录里隐藏，文件保留、引用方仍能读；冲突检测后凭一次性令牌执行。动作 `definition.global.write`（人类专属）。',
  projectDestroy: '删除项目数据（事件日志 / 记忆库 / 投影 / 租约），**不可撤销**：先预览逐项影响面，输入项目名后才能凭一次性令牌执行。动作 `project.destroy`（人类专属）。',
  memoryRemember: '写一条长期记忆到团队 bank 或某个成员 bank，需 `confirm: true`。',
  memoryForget: '遗忘一条记忆（默认软删留痕，`hard` 才真删），需 `confirm: true`。',
  planPropose: '提案开队计划：名字、目标、队长会话、队形与默认工作流，只落计划不建实体，需 `confirm: true`。',
  planDiscard: '丢弃待批准的计划：只落一条 `team.plan.discarded`，不产生任何会话与花费，需 `confirm: true`。',
  planApprove: '批准开队计划：预览影响面（几名成员、几个任务、开不开 Run），凭一次性令牌执行。动作 `plan.approve`（人类专属）。',
}

/** 面板动作的 actor：单属主部署下的人类入口。 */
export const PANEL_HUMAN: ActorRef = { kind: 'human', userId: 'owner', via: 'panel' }

/** 建一个令牌签发器（一次性 nonce、10 分钟有效）。 */
export function createPanelWriteAuthorizer(): HumanAuthorizer {
  return new HumanAuthorizer({
    now: () => new Date().toISOString(),
    createNonce: () => randomUUID(),
    ttlMs: 10 * 60_000,
  })
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `缺少参数 ${key}`)
  }
  return value
}

function requireRootDir(deps: PanelWriteDeps): string {
  if (deps.rootDir === undefined || deps.rootDir.length === 0) {
    fail(ERROR_CODES.INTERNAL, '项目根未装配，不能销毁')
  }
  return deps.rootDir
}

function requireTeamId(params: Record<string, unknown>): string {
  return requireString(params, 'teamId')
}

const VERDICT_OUTCOMES: readonly VerdictOutcome[] = ['pass', 'fail', 'blocked']
const EVIDENCE_KINDS: readonly EvidenceRef['kind'][] = ['file', 'command', 'session', 'url', 'artifact']

function requireOutcome(params: Record<string, unknown>): VerdictOutcome {
  const value = params.outcome
  if (typeof value !== 'string' || !(VERDICT_OUTCOMES as readonly string[]).includes(value)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `outcome 必须是 ${VERDICT_OUTCOMES.join(' / ')} 之一`, {
      details: { outcome: value === undefined ? null : String(value) },
    })
  }
  return value as VerdictOutcome
}

function requireObjectArray(params: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = params[key]
  if (!Array.isArray(value)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `${key} 必须是数组`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(ERROR_CODES.INVALID_PAYLOAD, `${key}[${index}] 必须是对象`)
    }
    return item as Record<string, unknown>
  })
}

function optionalString(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    fail(ERROR_CODES.INVALID_PAYLOAD, `${key} 必须是字符串`)
  }
  return value
}

function requireStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key]
  if (!Array.isArray(value)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `${key} 必须是字符串数组`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail(ERROR_CODES.INVALID_PAYLOAD, `${key}[${index}] 必须是非空字符串`)
    }
    return item
  })
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  if (params[key] === undefined) return undefined
  return requireStringArray(params, key)
}

/** 队形参数：数组，每项 { key, roleId, count, parentSlotKey? }。 */
function requireFormation(params: Record<string, unknown>): FormationSlot[] {
  const raw = params.formation
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'formation 必须是非空数组')
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object') {
      fail(ERROR_CODES.INVALID_PAYLOAD, `formation[${String(index)}] 必须是对象`)
    }
    const record = item as Record<string, unknown>
    const key = requireString(record, 'key')
    const roleId = requireString(record, 'roleId')
    const count = record.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      fail(ERROR_CODES.INVALID_PAYLOAD, `formation[${String(index)}].count 必须是正整数`)
    }
    const parentSlotKey = optionalString(record, 'parentSlotKey') ?? null
    return { key, roleId, count, parentSlotKey }
  })
}

/** 配置覆盖：可选对象；缺省为空对象（批准时再叠蓝图默认值）。 */
function requireOverrides(params: Record<string, unknown>): ConfigOverrides {
  const raw = params.overrides
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'overrides 必须是对象')
  }
  return raw as ConfigOverrides
}

function requireChecks(params: Record<string, unknown>): GateCheckResult[] {
  return requireObjectArray(params, 'checks').map((item, index) => {
    const command = requireString(item, 'command')
    const summary = optionalString(item, 'summary') ?? ''
    const exitCode = item.exitCode
    if (exitCode !== undefined && exitCode !== null && typeof exitCode !== 'number') {
      fail(ERROR_CODES.INVALID_PAYLOAD, `checks[${index}].exitCode 必须是数字或 null`)
    }
    return {
      command,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      stdoutHash: optionalString(item, 'stdoutHash') ?? null,
      summary,
    }
  })
}

function requireEvidenceList(params: Record<string, unknown>): EvidenceRef[] {
  return requireObjectArray(params, 'evidence').map((item, index) => {
    const kind = item.kind
    if (typeof kind !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      fail(ERROR_CODES.INVALID_PAYLOAD, `evidence[${index}].kind 必须是 ${EVIDENCE_KINDS.join(' / ')} 之一`)
    }
    return {
      kind: kind as EvidenceRef['kind'],
      ref: requireString(item, 'ref'),
      ...(optionalString(item, 'excerpt') === undefined ? {} : { excerpt: optionalString(item, 'excerpt') }),
      ...(optionalString(item, 'hash') === undefined ? {} : { hash: optionalString(item, 'hash') }),
    }
  })
}

export interface PanelWritePreview {
  method: PanelWriteMethod
  operationId: string
  summary: string
  impact: unknown
  /** 一次性确认令牌：只有预览这一次返回，服务端只留 hash。 */
  confirmation: HumanConfirmation
}

export interface PanelWriteApplied {
  method: PanelWriteMethod
  operationId: string
  committed: unknown
}

/** 写通道的外部依赖：全局发布要写入器，记忆要存储实现与项目根（都是端口注入）。 */
export interface PanelWriteDeps {
  publisher?: GlobalPublicationPort
  /** 全局库直改端口（definition.publish 之外的第二条全局写路径）。 */
  globalEditor?: GlobalLibraryEditPort
  /** 全局目录读取器：直改时校验引用用（只看全局库，不看项目）。 */
  globalEntries?: GlobalEntryReader
  /**
   * 项目数据销毁器。**必须由装配层注入**，并且它的审计文件是全局审计
   * （`$DSH_HOME/myteam/audit/global-operations.jsonl`）—— 项目的账本正是被删的东西，
   * 销毁记录不能写在里面。
   */
  destroyer?: ProjectDestroyPort
  /** 关掉某个工作区的运行时（释放写者租约）。销毁前必须调。 */
  closeProject?: (rootDir: string) => Promise<void>
  /** 项目根：记忆库按项目落盘（`memory/myteam.db`）。 */
  rootDir?: string
  /** 打开记忆存储；由装配层注入，application 不 import infrastructure。 */
  openMemory?: (rootDir: string) => MemoryPort
}

function requireDestroyer(deps: PanelWriteDeps): ProjectDestroyPort {
  if (deps.destroyer === undefined) {
    fail(ERROR_CODES.INTERNAL, '项目销毁器未装配')
  }
  return deps.destroyer
}

/** 销毁预览：逐项列出要删的东西与不可逆后果。 */
function previewProjectDestroy(
  deps: PanelWriteDeps,
  rootDir: string,
): { operationId: string; targetHash: string; impactHash: string; summary: string; impact: unknown } {
  const destroyer = requireDestroyer(deps)
  const preview = destroyer.preview(rootDir)
  const impact = {
    target: rootDir,
    name: preview.name,
    projectId: preview.projectId,
    targets: preview.targets,
    totalBytes: preview.totalBytes,
    irreversible: preview.irreversible,
  }
  const operationId = 'project-destroy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  return {
    operationId,
    // targetHash 绑「要删的这个项目」：项目名 + projectId + 总字节数。
    // 目标变了（比如删之前又写了一堆事件）就拒，避免「看的是 12 KB、删的是 40 MB」。
    targetHash: stableHash({ name: preview.name, projectId: preview.projectId, bytes: preview.totalBytes }),
    impactHash: stableHash(impact),
    summary: '删除项目「' + preview.name + '」的全部数据（' + String(preview.targets.length) + ' 项 · ' +
      String(Math.round(preview.totalBytes / 1024)) + ' KB）：不可撤销',
    impact,
  }
}

function requireGlobalEditor(deps: PanelWriteDeps): GlobalLibraryEditPort {
  if (deps.globalEditor === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局库直改端口未装配')
  }
  return deps.globalEditor
}

function requireGlobalEntries(deps: PanelWriteDeps): GlobalEntryReader {
  if (deps.globalEntries === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局目录读取器未装配')
  }
  return deps.globalEntries
}

/**
 * 全局直改的预览（令牌第一步）。
 *
 * 影响面只有两件事：**引用谁**（这份定义引用的全局角色/工作流，会不会有缺的）与
 * **被谁引用**（别的全局蓝图/工作流指着它，改完它们会「有更新」）。后者现在只能给数量，
 * 因为全局目录读取器按 kind 列条目时还没有反查索引 —— 这里如实写「N 条同名引用」而不是编一张清单。
 */
function previewGlobalEdit(
  deps: PanelWriteDeps,
  input: { kind: PublicationKind; id: string; definition: unknown },
): { operationId: string; targetHash: string; impactHash: string; summary: string; impact: unknown } {
  const editor = requireGlobalEditor(deps)
  const entries = requireGlobalEntries(deps)
  if (input.definition === undefined) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '缺少参数 definition')
  }
  const actualHash = editor.readFileHash(input.kind, input.id)
  const targetHash = actualHash === null ? 'sha256:absent' : actualHash

  const asRecord = input.definition as Record<string, unknown>
  const formation = Array.isArray(asRecord.formation) ? (asRecord.formation as Array<{ roleId?: string }>) : []
  const templates = Array.isArray(asRecord.templates) ? (asRecord.templates as Array<{ requiredRoleId?: string | null }>) : []
  const workflows = Array.isArray(asRecord.workflows) ? (asRecord.workflows as string[]) : []
  const roleIds = [
    ...formation.map((slot) => slot.roleId).filter((roleId): roleId is string => typeof roleId === 'string'),
    ...templates.map((template) => template.requiredRoleId).filter((roleId): roleId is string => typeof roleId === 'string'),
  ]
  const globalRoleIds = new Set(entries.list('role').map((entry) => entry.id))
  const globalWorkflowIds = new Set(entries.list('workflow').map((entry) => entry.id))
  const missingReferences = [
    ...roleIds.filter((roleId) => !globalRoleIds.has(roleId)).map((roleId) => 'role:' + roleId),
    ...workflows.filter((workflowId) => !globalWorkflowIds.has(workflowId)).map((workflowId) => 'workflow:' + workflowId),
  ]
  const impact = {
    target: input.kind + '/' + input.id,
    createsFile: actualHash === null,
    overwrites: actualHash !== null,
    missingReferences,
    irreversible: [
      actualHash === null ? '全局库会多出一份定义' : '会覆盖全局库里的同名定义，旧内容不保留（审计里留 previousHash）',
      '改的是全局库文件，所有引用它的项目/团队下次读到新版本',
    ],
  }
  const operationId = 'global-edit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  return {
    operationId,
    targetHash,
    impactHash: stableHash(impact),
    summary:
      (actualHash === null ? '新建' : '修改') + '全局' + input.kind + '「' + input.id + '」' +
      (missingReferences.length > 0 ? '：' + String(missingReferences.length) + ' 处引用在全局库里找不到' : '：引用都能解析'),
    impact,
  }
}

/** 影响面的稳定 hash：字段顺序固定，便于「同一影响面换同一令牌」。 */
function stableHash(value: unknown): string {
  const text = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort())
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return 'impact:' + (hash >>> 0).toString(16)
}

/** 下架的预览：说清「会被从目录里隐藏」与「文件与引用不受影响」。 */
function previewGlobalUnpublish(
  deps: PanelWriteDeps,
  input: { kind: PublicationKind; id: string },
): { operationId: string; targetHash: string; impactHash: string; summary: string; impact: unknown } {
  const editor = requireGlobalEditor(deps)
  const actual = editor.readFileHash(input.kind, input.id)
  if (actual === null) {
    fail(ERROR_CODES.NOT_FOUND, '全局库里没有这份定义', { details: { kind: input.kind, id: input.id } })
  }
  const impact = {
    target: input.kind + '/' + input.id,
    hidesFromCatalog: true,
    deletesFile: false,
    reversible: true,
    irreversible: [
      '目录里不再出现这份定义（新建团队/复制时选不到）',
      '文件与审计都保留；已经引用它的工作流、蓝图、团队照常能读到这一版',
    ],
  }
  const operationId = 'global-unpub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  return {
    operationId,
    targetHash: actual,
    impactHash: stableHash(impact),
    summary: '下架全局' + input.kind + '「' + input.id + '」：只从目录隐藏，引用方不受影响',
    impact,
  }
}

function requirePublisher(deps: PanelWriteDeps): GlobalPublicationPort {
  if (deps.publisher === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局发布器未装配')
  }
  return deps.publisher
}

function requireMemory(deps: PanelWriteDeps): { memory: MemoryPort; rootDir: string } {
  if (deps.rootDir === undefined || deps.openMemory === undefined) {
    fail(ERROR_CODES.INTERNAL, '记忆存储未装配')
  }
  return { memory: deps.openMemory(deps.rootDir), rootDir: deps.rootDir }
}

const PUBLICATION_KINDS = ['role', 'workflow', 'blueprint'] as const

function requirePublicationKind(params: Record<string, unknown>): PublicationKind {
  const value = params.kind
  if (typeof value !== 'string' || !(PUBLICATION_KINDS as readonly string[]).includes(value)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `kind 必须是 ${PUBLICATION_KINDS.join(' / ')} 之一`)
  }
  return value as PublicationKind
}

/**
 * 第一步：预览影响面并签发确认令牌。
 * @param runtime - 项目运行时（已打开）。
 * @param authorizer - 令牌签发器（与确认共用同一实例）。
 * @param method - 白名单方法名。
 * @param params - 方法参数。
 * @param deps - 额外端口（全局发布用）。
 */
export function previewPanelWrite(
  runtime: ProjectRuntime,
  authorizer: HumanAuthorizer,
  method: PanelWriteMethod,
  params: Record<string, unknown>,
  deps: PanelWriteDeps = {},
): PanelWritePreview {
  switch (method) {
    case 'globalUnpublish': {
      const kind = requirePublicationKind(input.params)
      const id = requireString(input.params, 'id')
      const expectedHash = typeof input.params.expectedHash === 'string' ? input.params.expectedHash : ''
      if (expectedHash.length === 0) fail(ERROR_CODES.INVALID_PAYLOAD, '下架必须带 expectedHash')
      const current = requireGlobalEditor(deps).readFileHash(kind, id)
      if (current === null) fail(ERROR_CODES.NOT_FOUND, '全局库里没有这份定义', { details: { kind, id } })
      authorizer.verify(input.confirmation, {
        operationId: input.confirmation.operationId,
        action: 'definition.global.write',
        targetHash: current,
        impactHash: input.confirmation.impactHash,
      })
      authorizer.consume(input.confirmation)
      const result = unpublishGlobalDefinition(
        { editor: requireGlobalEditor(deps) },
        {
          actor: PANEL_HUMAN,
          kind,
          id,
          expectedHash,
          operationId: input.confirmation.operationId,
          unpublishedAt: runtime.now(),
          editor: 'panel:owner',
        },
      )
      return { method, operationId: result.id, committed: result }
    }
    case 'globalDefinitionSave': {
      const preview = previewGlobalEdit(deps, {
        kind: requirePublicationKind(params),
        id: requireString(params, 'id'),
        definition: params.definition,
      })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'definition.global.write',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'projectDestroy': {
      // 项目数据销毁：两步式。第一步出影响面并签令牌，不删任何东西。
      const preview = previewProjectDestroy(deps, requireRootDir(deps))
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'project.destroy',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'globalUnpublish': {
      const preview = previewGlobalUnpublish(deps, {
        kind: requirePublicationKind(params),
        id: requireString(params, 'id'),
      })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'definition.global.write',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'planApprove': {
      const preview = previewTeamPlanApproval(runtime, { planId: requireString(params, 'planId') })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'plan.approve',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'teamDisband': {
      const preview = previewTeamDisband(runtime, { teamId: requireTeamId(params) })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'team.disband',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'captainTakeover': {
      const teamId = requireTeamId(params)
      const toSessionId = requireString(params, 'toSessionId')
      const preview = previewCaptainTakeover(runtime, { teamId, toSessionId })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'captain.takeover',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'planPropose':
    case 'planDiscard':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）`)
    case 'gateVerdict':
      fail(ERROR_CODES.INVALID_COMMAND, 'gateVerdict 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'taskCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskCreate 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'taskMove':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskMove 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'teamCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'teamCreate 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberAppoint':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberAppoint 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberArchive':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberArchive 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberRestore':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRestore 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberRelease':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRelease 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memoryRemember':
    case 'memoryForget':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）`)
    case 'definitionSave':
      fail(ERROR_CODES.INVALID_COMMAND, 'definitionSave 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'definitionPublish': {
      const preview = requestDefinitionPublication(runtime, { publisher: requirePublisher(deps) }, {
        actor: PANEL_HUMAN,
        kind: requirePublicationKind(params),
        id: requireString(params, 'id'),
      })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'definition.publish.confirm',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}

/**
 * 第二步：凭令牌确认并执行。
 * @param runtime - 项目运行时（已打开，状态须是最新）。
 * @param authorizer - 与预览同一实例（令牌登记在它里面）。
 * @param method - 白名单方法名。
 * @param input - 令牌、参数与人类填写的理由。
 * @param deps - 额外端口（全局发布用）。
 */
export async function applyPanelWrite(
  runtime: ProjectRuntime,
  authorizer: HumanAuthorizer,
  method: PanelWriteMethod,
  input: { params: Record<string, unknown>; confirmation: HumanConfirmation; reason: string },
  deps: PanelWriteDeps = {},
): Promise<PanelWriteApplied> {
  switch (method) {
    case 'planApprove': {
      const planId = requireString(input.params, 'planId')
      const planHash = requireString(input.params, 'planHash')
      const result = confirmTeamPlanApproval(runtime, { authorizer }, {
        actor: PANEL_HUMAN,
        planId,
        planHash,
        startRun: input.params.startRun !== false,
        operationId: input.confirmation.operationId,
        confirmation: input.confirmation,
      })
      return { method, operationId: input.confirmation.operationId, committed: result }
    }
    case 'globalDefinitionSave': {
      // 第二步：**必须自己复验令牌**。预览时签的 targetHash 是「当时的文件 hash」，
      // 已通过 expectedHash 把它带回来 —— 这里重新算一遍当前文件 hash 与令牌绑定，
      // 目标/影响面任一变化都拒（这道校验不能省，否则伪造令牌可以直写全局库）。
      const kind = requirePublicationKind(input.params)
      const id = requireString(input.params, 'id')
      const raw = input.params.expectedHash
      if (raw !== null && typeof raw !== 'string') {
        fail(ERROR_CODES.INVALID_PAYLOAD, 'expectedHash 必须是字符串或 null')
      }
      const currentHash = requireGlobalEditor(deps).readFileHash(kind, id)
      const currentTargetHash = currentHash === null ? 'sha256:absent' : currentHash
      const preview = previewGlobalEdit(deps, { kind, id, definition: input.params.definition })
      authorizer.verify(input.confirmation, {
        operationId: input.confirmation.operationId,
        action: 'definition.global.write',
        targetHash: currentTargetHash,
        impactHash: preview.impactHash,
      })
      authorizer.consume(input.confirmation)
      const result = editGlobalDefinition(
        { editor: requireGlobalEditor(deps), globalEntries: requireGlobalEntries(deps) },
        {
          actor: PANEL_HUMAN,
          kind,
          id,
          definition: input.params.definition,
          expectedHash: raw,
          operationId: input.confirmation.operationId,
          editedAt: runtime.now(),
          editor: 'panel:owner',
        },
      )
      return { method, operationId: result.id, committed: result }
    }
    case 'teamDisband': {
      const teamId = requireTeamId(input.params)
      const result = confirmTeamDisband(runtime, { authorizer }, {
        actor: PANEL_HUMAN,
        teamId,
        operationId: input.confirmation.operationId,
        confirmation: input.confirmation,
        reason: input.reason,
      })
      return { method, operationId: input.confirmation.operationId, committed: result }
    }
    case 'captainTakeover': {
      const teamId = requireTeamId(input.params)
      const toSessionId = requireString(input.params, 'toSessionId')
      const result = confirmCaptainTakeover(runtime, { authorizer }, {
        actor: PANEL_HUMAN,
        teamId,
        toSessionId,
        operationId: input.confirmation.operationId,
        confirmation: input.confirmation,
      })
      return { method, operationId: input.confirmation.operationId, committed: result }
    }
    case 'gateVerdict':
      fail(ERROR_CODES.INVALID_COMMAND, 'gateVerdict 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'taskCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskCreate 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'taskMove':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskMove 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'teamCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'teamCreate 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberAppoint':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberAppoint 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberArchive':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberArchive 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberRestore':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRestore 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberRelease':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRelease 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memoryRemember':
    case 'memoryForget':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 不使用确认令牌，请走 applyDirectPanelWrite`)
    case 'definitionSave':
      fail(ERROR_CODES.INVALID_COMMAND, 'definitionSave 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'definitionPublish': {
      const result = confirmDefinitionPublication(runtime, { authorizer, publisher: requirePublisher(deps) }, {
        actor: PANEL_HUMAN,
        operationId: input.confirmation.operationId,
        kind: requirePublicationKind(input.params),
        id: requireString(input.params, 'id'),
        confirmation: input.confirmation,
      })
      return {
        method,
        operationId: input.confirmation.operationId,
        committed: { file: result.file, globalHash: result.globalHash },
      }
    }
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}

/** 直接执行类写动作的入参：`confirm` 是面板层的显式确认位。 */
export interface PanelDirectWriteInput {
  params: Record<string, unknown>
  /** 前端必须在用户点过「提交」之后才置 true；缺省或 false 一律拒绝。 */
  confirm: boolean
}

/**
 * 直接执行类写动作。
 *
 * 与 `applyPanelWrite` 的区别只在确认方式：这里没有令牌，`confirm: true` 就是
 * 「我已经看过并同意」。所以**每个方法都必须自己守住语义**——`gateVerdict` 依赖
 * `recordVerdictCommand` 的两道域校验（任务须在 `review`、`attemptId` 须为当前
 * Attempt），而不是依赖调用方老实。
 *
 * @param runtime - 项目运行时（已刷新到最新账本）。
 * @param method - 白名单方法名，且其 `PanelWriteKind` 必须是 `direct`。
 * @param input - 参数与确认位。
 * @param deps - 额外端口（写记忆需要存储实现与项目根）。
 */
export function applyDirectPanelWrite(
  runtime: ProjectRuntime,
  method: PanelWriteMethod,
  input: PanelDirectWriteInput,
  deps: PanelWriteDeps = {},
): PanelWriteApplied {
  switch (method) {
    case 'planPropose': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '提案计划需要 confirm: true（会写进事件账本）')
      }
      const proposed = proposeTeamPlanCommand(runtime, {
        actor: PANEL_HUMAN,
        name: requireString(input.params, 'name'),
        goal: optionalString(input.params, 'goal') ?? '',
        captainSessionId: requireString(input.params, 'captainSessionId'),
        blueprintId: optionalString(input.params, 'blueprintId'),
        formation: requireFormation(input.params),
        workflowId: optionalString(input.params, 'workflowId'),
        overrides: requireOverrides(input.params),
      })
      return { method, operationId: proposed.plan.id, committed: { plan: proposed.plan } }
    }
    case 'planDiscard': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '丢弃计划需要 confirm: true（会写进事件账本）')
      }
      const planId = requireString(input.params, 'planId')
      discardTeamPlanCommand(runtime, {
        actor: PANEL_HUMAN,
        planId,
        reason: optionalString(input.params, 'reason') ?? '',
      })
      return { method, operationId: planId, committed: { discarded: true } }
    }
    case 'gateVerdict': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '门禁裁决需要 confirm: true（一次判定会写进事件账本，不能撤销）')
      }
      const taskId = requireString(input.params, 'taskId')
      const attemptId = requireString(input.params, 'attemptId')
      const outcome = requireOutcome(input.params)
      const checks = requireChecks(input.params)
      const evidence = requireEvidenceList(input.params)

      const result = recordVerdictCommand(runtime, {
        actor: PANEL_HUMAN,
        taskId,
        attemptId,
        outcome,
        checks,
        evidence,
      })
      const verdict = (result.events.find((event) => event.type === 'task.verdict')!.payload as { verdict: GateVerdict })
        .verdict
      return {
        method,
        operationId: verdict.id,
        committed: {
          verdict,
          taskStatus: runtime.state.tasks.get(taskId)?.status ?? null,
        },
      }
    }
    case 'teamDisband':
    case 'captainTakeover':
    case 'globalDefinitionSave':
    case 'globalUnpublish':
    case 'projectDestroy':
    case 'definitionPublish':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 走确认令牌通道（先预览再确认），不能直接执行`)
    case 'memoryRemember': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '写记忆需要 confirm: true')
      }
      // 先把参数验完再开库：参数错误不该在磁盘上留下一个空记忆库。
      const teamId = requireTeamId(input.params)
      const memberId = optionalString(input.params, 'memberId')
      const text = requireString(input.params, 'text')
      const tags = optionalStringArray(input.params, 'tags')
      const evidence = optionalStringArray(input.params, 'evidence')
      const { memory } = requireMemory(deps)
      try {
        const record = rememberMemory(
          { memory, ids: (kind) => runtime.nextId(kind), now: runtime.now() },
          {
            actor: PANEL_HUMAN,
            teamId,
            ...(memberId === undefined ? {} : { memberId }),
            text,
            ...(tags === undefined ? {} : { tags }),
            ...(evidence === undefined ? {} : { evidence }),
          },
        )
        return { method, operationId: record.id, committed: record }
      } finally {
        memory.close()
      }
    }
    case 'memoryForget': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '遗忘记忆需要 confirm: true')
      }
      // 同样先验参数：缺 id 时不该动到库。
      const teamId = requireTeamId(input.params)
      const memberId = optionalString(input.params, 'memberId')
      const id = requireString(input.params, 'id')
      const hard = input.params.hard === true
      const { memory } = requireMemory(deps)
      try {
        forgetMemory(
          { memory, ids: (kind) => runtime.nextId(kind), now: runtime.now() },
          {
            actor: PANEL_HUMAN,
            teamId,
            ...(memberId === undefined ? {} : { memberId }),
            id,
            reason: optionalString(input.params, 'reason') ?? '面板遗忘',
            hard,
          },
        )
        return { method, operationId: id, committed: { id, hard } }
      } finally {
        memory.close()
      }
    }
    case 'taskCreate': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '新建任务需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const title = requireString(input.params, 'title')
      const description = optionalString(input.params, 'description') ?? ''
      const acceptance = requireStringArray(input.params, 'acceptance')
      const dependencies = optionalStringArray(input.params, 'dependencies')

      const result = createTaskCommand(runtime, {
        actor: PANEL_HUMAN,
        title,
        description,
        acceptance,
        ownerTeamId: teamId,
        ...(dependencies === undefined ? {} : { dependencies }),
      })
      const task = (result.events.find((event) => event.type === 'task.created')!.payload as { task: Task }).task
      return {
        method,
        operationId: task.id,
        committed: {
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            ownerTeamId: task.ownerTeamId,
            dependencies: task.dependencies,
            requiredRoleId: task.requiredRoleId,
          },
        },
      }
    }
    case 'definitionSave': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '保存定义需要 confirm: true')
      const kind = requireString(input.params, 'kind')
      // 蓝图允许不带 id（= 新建）；角色/工作流必须带 id（走修订）。
      const id = kind === 'blueprint'
        ? (optionalString(input.params, 'id') ?? '')
        : requireString(input.params, 'id')
      if (kind === 'role') {
        const profile = input.params.profile
        if (typeof profile !== 'object' || profile === null) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '角色 profile 必须是对象', { details: { kind, id } })
        }
        saveProjectRole(runtime, {
          actor: PANEL_HUMAN,
          id,
          profile: profile as never,
          capabilities: (input.params.capabilities ?? { tools: { allow: [], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] }) as never,
        })
        return { method, operationId: id, committed: { kind, id } }
      }
      if (kind === 'workflow') {
        const templates = input.params.templates
        if (!Array.isArray(templates)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '工作流 templates 必须是数组', { details: { kind, id } })
        }
        saveProjectWorkflowCommand(runtime, {
          actor: PANEL_HUMAN,
          id,
          name: requireString(input.params, 'name'),
          description: optionalString(input.params, 'description') ?? '',
          templates: templates as never,
          ...(input.params.completion === undefined ? {} : { completion: input.params.completion as never }),
        })
        return { method, operationId: id, committed: { kind, id } }
      }
      if (kind === 'blueprint') {
        const formation = input.params.formation
        if (!Array.isArray(formation)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图 formation 必须是数组', { details: { kind, id } })
        }
        const workflows = input.params.workflows
        if (!Array.isArray(workflows)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图 workflows 必须是数组', { details: { kind, id } })
        }
        const fields = {
          actor: PANEL_HUMAN,
          name: requireString(input.params, 'name'),
          description: optionalString(input.params, 'description') ?? '',
          formation: formation as never,
          workflows: workflows as string[],
          defaults: (input.params.defaults ?? {}) as never,
        }
        // id 为空视为「新建」：面板建蓝图不需要先有一个空壳。
        if (id.length === 0) {
          const created = createProjectBlueprint(runtime, fields)
          const event = created.events.find((entry) => entry.type === 'definition.blueprint.created')
          const blueprint = (event?.payload as { blueprint?: { id: string } } | undefined)?.blueprint
          return { method, operationId: blueprint?.id ?? '', committed: { kind, id: blueprint?.id ?? '' } }
        }
        saveProjectBlueprintCommand(runtime, { ...fields, id })
        return { method, operationId: id, committed: { kind, id } }
      }
      fail(ERROR_CODES.INVALID_PAYLOAD, 'definitionSave 只支持 kind = role / workflow / blueprint', {
        details: { kind },
      })
    }
    case 'taskMove': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '移动任务需要 confirm: true')
      const taskId = requireString(input.params, 'taskId')
      const targetStatus = requireString(input.params, 'targetStatus')
      const reason = optionalString(input.params, 'reason') ?? '面板移动任务'
      if (targetStatus === 'cancelled') {
        cancelTaskCommand(runtime, { actor: PANEL_HUMAN, taskId, reason })
        return { method, operationId: taskId, committed: { taskId, status: 'cancelled' } }
      }
      if (targetStatus === 'ready') {
        reopenTaskCommand(runtime, { actor: PANEL_HUMAN, taskId, reason })
        return { method, operationId: taskId, committed: { taskId, status: 'ready' } }
      }
      if (targetStatus === 'claimed') {
        const memberId = requireString(input.params, 'memberId')
        claimTaskCommand(runtime, { actor: PANEL_HUMAN, taskId, memberId })
        return { method, operationId: taskId, committed: { taskId, status: 'claimed', memberId } }
      }
      fail(ERROR_CODES.INVALID_PAYLOAD, 'taskMove 只支持 targetStatus = cancelled / ready / claimed；完成（done）必须走门禁裁决', {
        details: { targetStatus },
      })
    }
    case 'teamCreate': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '建团队需要 confirm: true')
      const name = requireString(input.params, 'name')
      const goal = requireString(input.params, 'goal')
      const captainSessionId = requireString(input.params, 'captainSessionId')
      const blueprintId = optionalString(input.params, 'blueprintId')
      const result = createTeamCommand(runtime, {
        actor: PANEL_HUMAN,
        name,
        goal,
        captainSessionId,
        ...(blueprintId === undefined ? {} : { blueprintId }),
      })
      const created = result.events.find((event) => event.type === 'team.created')
      if (created === undefined) fail(ERROR_CODES.INTERNAL, '建团队没有产生 team.created 事件')
      const team = (created.payload as { team: { id: string; name: string } }).team
     return { method, operationId: team.id, committed: { teamId: team.id, name: team.name, captainSessionId } }
    }
    case 'memberAppoint': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '召唤成员需要 confirm: true')
      const teamId = requireString(input.params, 'teamId')
      const roleId = requireString(input.params, 'roleId')
      const parentMemberId = optionalString(input.params, 'parentMemberId')
      const sessionId = optionalString(input.params, 'sessionId')
      const result = appointMemberCommand(runtime, {
        actor: PANEL_HUMAN,
        teamId,
        roleId,
        ...(parentMemberId === undefined ? {} : { parentMemberId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      const appointed = result.events.find((event) => event.type === 'member.appointed')
      if (appointed === undefined) fail(ERROR_CODES.INTERNAL, '召唤成员没有产生 member.appointed 事件')
      const member = (appointed.payload as { member: { id: string; status: string } }).member
      return { method, operationId: member.id, committed: { memberId: member.id, teamId, roleId, status: member.status } }
    }
    case 'memberArchive': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '归档成员需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const memberId = requireString(input.params, 'memberId')
      const drainRaw = optionalString(input.params, 'drain')
      if (drainRaw !== undefined && drainRaw !== 'wait' && drainRaw !== 'pause') {
        fail(ERROR_CODES.INVALID_PAYLOAD, 'drain 只能是 wait 或 pause', { details: { drain: drainRaw } })
      }
      archiveMemberCommand(runtime, {
        actor: PANEL_HUMAN,
        teamId,
        memberId,
        ...(drainRaw === undefined ? {} : { drain: drainRaw }),
      })
      return { method, operationId: memberId, committed: { memberId, teamId, status: 'archived' } }
    }
    case 'memberRestore': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '恢复成员需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const memberId = requireString(input.params, 'memberId')
      restoreMemberCommand(runtime, { actor: PANEL_HUMAN, teamId, memberId })
      return { method, operationId: memberId, committed: { memberId, teamId, status: 'active' } }
    }
    case 'memberRelease': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '释放成员需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const memberId = requireString(input.params, 'memberId')
      const result = releaseMemberCommand(runtime, { actor: PANEL_HUMAN, teamId, memberId })
      const released = result.events.find((event) => event.type === 'member.released')
      if (released === undefined) {
        fail(ERROR_CODES.INTERNAL, '释放成员没有产生 member.released 事件', { details: { memberId } })
      }
      return { method, operationId: memberId, committed: { memberId, teamId, status: 'released' } }
    }
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}
