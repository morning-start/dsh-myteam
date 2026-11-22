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
import type { EvidenceRef, GateCheckResult, GateVerdict, Task, VerdictOutcome } from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { GlobalPublicationPort, PublicationKind } from '../contracts/publication.ts'
import { HumanAuthorizer } from '../domain/permissions/human-authorizer.ts'
import type { HumanConfirmation } from '../domain/permissions/human-authorizer.ts'
import { createTaskCommand } from './commands.ts'
import { confirmDefinitionPublication, requestDefinitionPublication } from './publication.ts'
import { confirmCaptainTakeover, confirmTeamDisband, previewCaptainTakeover, previewTeamDisband } from './human-actions.ts'
import type { ProjectRuntime } from './project-runtime.ts'
import { recordVerdictCommand } from './task-commands.ts'

/** 面板写方法白名单。新增写能力必须同时在这里登记并补测试。 */
export const PANEL_WRITE_METHODS = ['teamDisband', 'captainTakeover', 'gateVerdict', 'taskCreate', 'definitionPublish'] as const

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
  definitionPublish: 'token',
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
  definitionPublish: '发布定义到全局库：预览引用与覆盖影响面，凭一次性令牌执行。动作 `definition.publish.confirm`（人类专属）。',
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

/** 写通道的外部依赖：只有全局发布需要额外装配（端口注入，不 import infrastructure）。 */
export interface PanelWriteDeps {
  publisher?: GlobalPublicationPort
}

function requirePublisher(deps: PanelWriteDeps): GlobalPublicationPort {
  if (deps.publisher === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局发布器未装配')
  }
  return deps.publisher
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
    case 'gateVerdict':
      fail(ERROR_CODES.INVALID_COMMAND, 'gateVerdict 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'taskCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskCreate 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
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
export function applyPanelWrite(
  runtime: ProjectRuntime,
  authorizer: HumanAuthorizer,
  method: PanelWriteMethod,
  input: { params: Record<string, unknown>; confirmation: HumanConfirmation; reason: string },
  deps: PanelWriteDeps = {},
): PanelWriteApplied {
  switch (method) {
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
 */
export function applyDirectPanelWrite(
  runtime: ProjectRuntime,
  method: PanelWriteMethod,
  input: PanelDirectWriteInput,
): PanelWriteApplied {
  switch (method) {
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
    case 'definitionPublish':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 走确认令牌通道（先预览再确认），不能直接执行`)
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
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}