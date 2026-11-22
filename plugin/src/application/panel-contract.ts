/**
 * 面板契约：方法名、协议版本与请求/响应形状。
 *
 * 契约与实现分开，是因为它同时被三方消费：浏览器面板、测试和将来的 CLI。
 * 方法名是**稳定标识**，一旦发布不改；新增能力只能加方法。
 *
 * 只读方法不伪装成写入口：写操作（批准、发布、解散、接管）必须走
 * 人类确认通道，不在这里以「顺手加个 method」的方式出现。
 */
import type { ErrorShape } from '../contracts/errors.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { JsonValue } from '../contracts/json.ts'
import { PROTOCOL_VERSION } from '../contracts/versions.ts'

export const PANEL_METHODS = [
  'status',
  'overview',
  'board',
  'task',
  'team',
  'definitions',
  'migration',
] as const

export type PanelMethod = (typeof PANEL_METHODS)[number]

export interface PanelRequest {
  protocolVersion?: number
  method: PanelMethod
  params?: Record<string, unknown>
}

export type PanelResponse =
  | { ok: true; data: JsonValue }
  | { ok: false; error: ErrorShape }

export function isPanelMethod(value: unknown): value is PanelMethod {
  return typeof value === 'string' && (PANEL_METHODS as readonly string[]).includes(value)
}

/**
 * 校验请求。
 *
 * 协议版本**显式不匹配就拒绝**：面板是随宿主一起加载的，出现版本错配时
 * 「尽力解释」只会把字段缺失变成界面空白。调用方应刷新页面而不是重试。
 */
export function validateRequest(input: unknown): PanelRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '面板请求必须是对象')
  }
  const record = input as Record<string, unknown>

  if (record.protocolVersion !== undefined) {
    if (record.protocolVersion !== PROTOCOL_VERSION) {
      fail(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, `面板协议版本为 ${String(record.protocolVersion)}，服务端为 ${PROTOCOL_VERSION}`, {
        details: { serverProtocolVersion: PROTOCOL_VERSION },
      })
    }
  }
  if (!isPanelMethod(record.method)) {
    fail(ERROR_CODES.INVALID_COMMAND, `未知面板方法：${String(record.method)}`, {
      details: { supported: [...PANEL_METHODS] },
    })
  }
  const params = record.params
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'params 必须是对象')
  }

  return {
    ...(record.protocolVersion === undefined ? {} : { protocolVersion: record.protocolVersion }),
    method: record.method,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  }
}