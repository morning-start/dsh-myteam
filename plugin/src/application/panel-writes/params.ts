/**
 * 入参解析与校验：把面板来的 `unknown` 参数收窄成领域类型。
 *
 * 缺参数、类型不对、枚举取值越界，统一在这里报 `INVALID_PAYLOAD`，
 * 预览与执行两条路径共用同一套收窄——否则「预览通过、执行才炸」这种分叉必然出现。
 *
 * 这些函数跨模块使用（previews / apply 都要），所以导出；它们是本层的内部契约，
 * 不是包对外的 API。由 {@link ../panel-writes.ts} 统一重导出。
 */
import type { ConfigOverrides, EvidenceRef, FormationSlot, GateCheckResult, VerdictOutcome } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type { PanelWriteDeps } from './deps.ts'

export function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `缺少参数 ${key}`)
  }
  return value
}

export function requireRootDir(deps: PanelWriteDeps): string {
  if (deps.rootDir === undefined || deps.rootDir.length === 0) {
    fail(ERROR_CODES.INTERNAL, '项目根未装配，不能销毁')
  }
  return deps.rootDir
}

export function requireTeamId(params: Record<string, unknown>): string {
  return requireString(params, 'teamId')
}

const VERDICT_OUTCOMES: readonly VerdictOutcome[] = ['pass', 'fail', 'blocked']
const EVIDENCE_KINDS: readonly EvidenceRef['kind'][] = ['file', 'command', 'session', 'url', 'artifact']

export function requireOutcome(params: Record<string, unknown>): VerdictOutcome {
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

export function optionalString(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    fail(ERROR_CODES.INVALID_PAYLOAD, `${key} 必须是字符串`)
  }
  return value
}

export function requireStringArray(params: Record<string, unknown>, key: string): string[] {
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

export function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  if (params[key] === undefined) return undefined
  return requireStringArray(params, key)
}

/** 队形参数：数组，每项 { key, roleId, count, parentSlotKey? }。 */
export function requireFormation(params: Record<string, unknown>): FormationSlot[] {
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
export function requireOverrides(params: Record<string, unknown>): ConfigOverrides {
  const raw = params.overrides
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'overrides 必须是对象')
  }
  return raw as ConfigOverrides
}

export function requireChecks(params: Record<string, unknown>): GateCheckResult[] {
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

export function requireEvidenceList(params: Record<string, unknown>): EvidenceRef[] {
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
