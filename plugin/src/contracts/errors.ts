/**
 * v2 错误码目录与错误类型。
 *
 * 规则：
 *   - 错误码是**协议**，面板、工具输出、测试和文档都按码断言；码一旦发布不随文案改变。
 *   - 错误信息给人看，可随时改写；调用方不应解析 message。
 *   - `retryable` 表示「原样重试可能成功」。前置条件冲突、权限拒绝、日志损坏都不可重试：
 *     它们要么要求调用方重读并重建意图，要么要求人工修复。
 *   - `details` 只放可 JSON 化的诊断信息，绝不放凭据或确认令牌本体。
 */
import type { JsonValue } from './json.ts'

export const ERROR_CODES = {
  // —— 输入与协议 ——
  INVALID_COMMAND: 'INVALID_COMMAND',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  UNSUPPORTED_PROTOCOL_VERSION: 'UNSUPPORTED_PROTOCOL_VERSION',

  // —— 实体与状态 ——
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  TASK_NOT_READY: 'TASK_NOT_READY',
  TEAM_NOT_ACTIVE: 'TEAM_NOT_ACTIVE',
  MEMBER_NOT_ACTIVE: 'MEMBER_NOT_ACTIVE',
  ATTEMPT_STALE: 'ATTEMPT_STALE',
  SESSION_LOST: 'SESSION_LOST',
  CAPTAIN_OFFLINE: 'CAPTAIN_OFFLINE',
  CAPTAIN_GENERATION_STALE: 'CAPTAIN_GENERATION_STALE',

  // —— 授权 ——
  FORBIDDEN: 'FORBIDDEN',
  HUMAN_ONLY: 'HUMAN_ONLY',
  CAPABILITY_ESCALATION: 'CAPABILITY_ESCALATION',
  HUMAN_CONFIRMATION_INVALID: 'HUMAN_CONFIRMATION_INVALID',
  HUMAN_CONFIRMATION_EXPIRED: 'HUMAN_CONFIRMATION_EXPIRED',
  CONFIRMATION_TARGET_CHANGED: 'CONFIRMATION_TARGET_CHANGED',

  // —— 存储与并发 ——
  PROJECT_NOT_INITIALIZED: 'PROJECT_NOT_INITIALIZED',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  EVENT_LOG_CORRUPT: 'EVENT_LOG_CORRUPT',
  EVENT_LOG_TORN_TAIL: 'EVENT_LOG_TORN_TAIL',
  EVENT_LOG_UNWRITABLE: 'EVENT_LOG_UNWRITABLE',
  WRITER_LEASE_LOST: 'WRITER_LEASE_LOST',
  PROJECT_WRITE_BLOCKED: 'PROJECT_WRITE_BLOCKED',
  PROJECTION_STALE: 'PROJECTION_STALE',

  // —— Effect ——
  EFFECT_OUTCOME_UNKNOWN: 'EFFECT_OUTCOME_UNKNOWN',
  EFFECT_NOT_RETRYABLE: 'EFFECT_NOT_RETRYABLE',
  EFFECT_CANCELLED: 'EFFECT_CANCELLED',

  // —— 全局定义库 ——
  GLOBAL_DEFINITION_MISSING: 'GLOBAL_DEFINITION_MISSING',
  GLOBAL_TARGET_CHANGED: 'GLOBAL_TARGET_CHANGED',
  GLOBAL_PUBLISH_FAILED: 'GLOBAL_PUBLISH_FAILED',
  GLOBAL_AUDIT_MISSING: 'GLOBAL_AUDIT_MISSING',

  // —— 迁移 ——
  MIGRATION_INPUT_UNSUPPORTED: 'MIGRATION_INPUT_UNSUPPORTED',
  MIGRATION_UNKNOWN_EVENT: 'MIGRATION_UNKNOWN_EVENT',
  MIGRATION_BLOCKED: 'MIGRATION_BLOCKED',
  MIGRATION_CONFLICT: 'MIGRATION_CONFLICT',

  // —— 兜底 ——
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** 默认重试语义：只有明确列入此表的错误才允许「原样重试」。 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ERROR_CODES.WRITER_LEASE_LOST,
  ERROR_CODES.PROJECTION_STALE,
])

export interface ErrorShape {
  code: ErrorCode
  message: string
  details?: JsonValue
  retryable: boolean
}

/**
 * 统一的业务错误。
 *
 * 不用 `instanceof Error` 以外的判别方式跨进程传递：RPC 边界上序列化为
 * {@link ErrorShape}，接收端用 {@link isErrorShape} 判形，不依赖原型链。
 */
export class MyTeamError extends Error {
  readonly code: ErrorCode
  readonly details?: JsonValue
  readonly retryable: boolean

  constructor(code: ErrorCode, message: string, options: { details?: JsonValue; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MyTeamError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable ?? RETRYABLE.has(code)
  }

  toShape(): ErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message, retryable: this.retryable }
      : { code: this.code, message: this.message, details: this.details, retryable: this.retryable }
  }
}

/** 抛出业务错误的简写；`never` 返回类型让调用点可以直接用在表达式位置。 */
export function fail(code: ErrorCode, message: string, options?: { details?: JsonValue; retryable?: boolean; cause?: unknown }): never {
  throw new MyTeamError(code, message, options)
}

export function isMyTeamError(value: unknown): value is MyTeamError {
  return value instanceof MyTeamError
}

export function isErrorShape(value: unknown): value is ErrorShape {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ErrorShape>
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.retryable === 'boolean'
  )
}

/**
 * 把任意异常收敛成可传递的错误形状。
 *
 * 非 {@link MyTeamError} 一律归为 INTERNAL，并保留原始 message：把未知异常
 * 冒充成某个业务码会让调用方按错误方向处理（例如把 bug 当成「可重试」）。
 */
export function toErrorShape(error: unknown): ErrorShape {
  if (error instanceof MyTeamError) return error.toShape()
  const message = error instanceof Error ? error.message : String(error)
  return { code: ERROR_CODES.INTERNAL, message, retryable: false }
}