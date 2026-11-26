/**
 * 团队生效配置：分层合并 + 安全上限钳制 + 不可变快照。
 *
 * 生效顺序（docs/architecture/01 §8.1）：
 *
 *   平台/插件安全上限（最终钳制）
 *     ← 内置默认
 *     ← 项目默认快照
 *     ← 蓝图默认快照
 *     ← 团队运行覆盖
 *   = 团队 Effective Config Revision
 *
 * 三条规则值得单独说明：
 *   1. 安全上限**钳制**而不是拒绝：配置写错不该让团队整队停摆，但被钳制的
 *      请求值必须记录在快照的 `clamped` 里，面板要能说清「你写的 999 实际生效 20」。
 *   2. 未知键**报错**而不是保留：保留会让拼错的配置看起来生效，实际被忽略。
 *   3. 快照是不可变值 + 内容 hash：事件里存的是快照，不是「读当前文件」。
 */
import type {
  ConfigOverrides,
  EffectiveConfigSnapshot,
  SafetyLimits,
  TeamConfig,
} from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { hashContent } from '../../contracts/json.ts'
import { MERGE_ALGORITHM_VERSION, SAFETY_LIMITS_VERSION } from '../../contracts/versions.ts'

/** 平台安全上限：任何团队配置都不能突破。 */
export const SAFETY_LIMITS: SafetyLimits = {
  maxMembersPerTeam: 20,
  maxMemberDepth: 4,
  maxChildrenPerMember: 8,
  maxParallelAttempts: 16,
  maxEscalationsPerTask: 5,
  commandTimeoutMs: 600_000,
}

/** 内置默认：没有项目默认、没有蓝图默认时的起点。 */
export const DEFAULT_TEAM_CONFIG: TeamConfig = {
  limits: {
    maxMembers: 8,
    maxMemberDepth: 3,
    maxChildrenPerMember: 4,
    maxParallelAttempts: 4,
    maxEscalationsPerTask: 2,
  },
  gates: {
    requireEvidence: true,
    requireArtifacts: true,
    commandTimeoutMs: 120_000,
  },
  messaging: {
    allowMemberToMember: true,
    maxMessagesPerTask: 40,
  },
}

const LIMIT_KEYS = [
  'maxMembers',
  'maxMemberDepth',
  'maxChildrenPerMember',
  'maxParallelAttempts',
  'maxEscalationsPerTask',
] as const
const GATE_BOOLEAN_KEYS = ['requireEvidence', 'requireArtifacts'] as const
const GATE_NUMBER_KEYS = ['commandTimeoutMs'] as const
const MESSAGING_BOOLEAN_KEYS = ['allowMemberToMember'] as const
const MESSAGING_NUMBER_KEYS = ['maxMessagesPerTask'] as const

/**
 * 「这个键在已知键集合里吗」。
 *
 * 直接写 `KNOWN.includes(key)` 在 `as const` 元组上会被 tsc 拒绝：`includes` 的参数
 * 被收窄成字面量联合类型，而调用方给的是 `string`（来自 `Object.keys`）。这里把参数
 * 放宽成 `readonly string[]`，语义不变，类型才对得上。
 */
function isKnownKey(known: readonly string[], key: string): boolean {
  return known.includes(key)
}

/**
 * 校验一层覆盖。返回问题清单，由调用方决定是拒绝命令还是只展示。
 *
 * 未知键与类型错误是两类问题：前者通常是拼写，后者通常是面板传错类型，
 * 两者都不该被静默吞掉。
 */
export function validateOverrides(overrides: ConfigOverrides, layer: string): string[] {
  const problems: string[] = []
  const allowedSections = new Set(['limits', 'gates', 'messaging'])

  for (const key of Object.keys(overrides)) {
    if (!allowedSections.has(key)) problems.push(`${layer} 含未知配置段：${key}`)
  }

  if (overrides.limits !== undefined) {
    for (const key of Object.keys(overrides.limits)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
        problems.push(`${layer}.limits 含未知键：${key}`)
      }
    }
    for (const key of LIMIT_KEYS) {
      const value = overrides.limits[key]
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        problems.push(`${layer}.limits.${key} 必须是正整数`)
      }
    }
  }

  if (overrides.gates !== undefined) {
    for (const key of Object.keys(overrides.gates)) {
      if (!isKnownKey([...GATE_BOOLEAN_KEYS, ...GATE_NUMBER_KEYS], key)) {
        problems.push(`${layer}.gates 含未知键：${key}`)
      }
    }
    for (const key of GATE_BOOLEAN_KEYS) {
      const value = overrides.gates[key]
      if (value !== undefined && typeof value !== 'boolean') {
        problems.push(`${layer}.gates.${key} 必须是布尔值`)
      }
    }
    const timeout = overrides.gates.commandTimeoutMs
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1)) {
      problems.push(`${layer}.gates.commandTimeoutMs 必须是正整数`)
    }
  }

  if (overrides.messaging !== undefined) {
    for (const key of Object.keys(overrides.messaging)) {
      if (!isKnownKey([...MESSAGING_BOOLEAN_KEYS, ...MESSAGING_NUMBER_KEYS], key)) {
        problems.push(`${layer}.messaging 含未知键：${key}`)
      }
    }
    for (const key of MESSAGING_BOOLEAN_KEYS) {
      const value = overrides.messaging[key]
      if (value !== undefined && typeof value !== 'boolean') {
        problems.push(`${layer}.messaging.${key} 必须是布尔值`)
      }
    }
    const maxMessages = overrides.messaging.maxMessagesPerTask
    if (maxMessages !== undefined && (!Number.isInteger(maxMessages) || maxMessages < 1)) {
      problems.push(`${layer}.messaging.maxMessagesPerTask 必须是正整数`)
    }
  }

  return problems
}

/** 合并一层覆盖到基础值。不做校验，调用方应先 {@link validateOverrides}。 */
export function mergeConfig(base: TeamConfig, overrides: ConfigOverrides): TeamConfig {
  return {
    limits: { ...base.limits, ...(overrides.limits ?? {}) },
    gates: { ...base.gates, ...(overrides.gates ?? {}) },
    messaging: { ...base.messaging, ...(overrides.messaging ?? {}) },
  }
}

export interface ClampResult {
  values: TeamConfig
  clamped: { field: string; requested: number; applied: number }[]
}

/**
 * 按安全上限钳制。
 *
 * 只钳制「上限类」数值：超时时间也按上限收，避免一条命令把整个项目拖住。
 * 布尔项不参与钳制（它们不是数量）。
 */
export function clampToSafety(config: TeamConfig, limits: SafetyLimits = SAFETY_LIMITS): ClampResult {
  const clamped: ClampResult['clamped'] = []
  const values: TeamConfig = {
    limits: { ...config.limits },
    gates: { ...config.gates },
    messaging: { ...config.messaging },
  }

  const applyLimit = (field: keyof TeamConfig['limits'], ceiling: number) => {
    const requested = values.limits[field]
    if (requested > ceiling) {
      values.limits[field] = ceiling
      clamped.push({ field: `limits.${field}`, requested, applied: ceiling })
    }
  }

  applyLimit('maxMembers', limits.maxMembersPerTeam)
  applyLimit('maxMemberDepth', limits.maxMemberDepth)
  applyLimit('maxChildrenPerMember', limits.maxChildrenPerMember)
  applyLimit('maxParallelAttempts', limits.maxParallelAttempts)
  applyLimit('maxEscalationsPerTask', limits.maxEscalationsPerTask)

  if (values.gates.commandTimeoutMs > limits.commandTimeoutMs) {
    clamped.push({
      field: 'gates.commandTimeoutMs',
      requested: values.gates.commandTimeoutMs,
      applied: limits.commandTimeoutMs,
    })
    values.gates.commandTimeoutMs = limits.commandTimeoutMs
  }

  return { values, clamped }
}

export interface EffectiveConfigInput {
  projectDefaults: ConfigOverrides
  blueprintDefaults: ConfigOverrides | null
  teamOverrides: ConfigOverrides
  configRevision: number
  sources: EffectiveConfigSnapshot['sources']
  safetyLimits?: SafetyLimits
}

/**
 * 计算生效配置快照。
 *
 * 同一组输入永远得到同一份 values 与同一个 hash：快照可以安全地放进事件，
 * 也可以在迁移/恢复后重算并逐字节比对。
 */
export function computeEffectiveConfig(input: EffectiveConfigInput): EffectiveConfigSnapshot {
  const problems = [
    ...validateOverrides(input.projectDefaults, '项目默认'),
    ...(input.blueprintDefaults === null ? [] : validateOverrides(input.blueprintDefaults, '蓝图默认')),
    ...validateOverrides(input.teamOverrides, '团队覆盖'),
  ]
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '配置层包含非法字段', { details: { problems } })
  }

  const merged = mergeConfig(
    mergeConfig(mergeConfig(DEFAULT_TEAM_CONFIG, input.projectDefaults), input.blueprintDefaults ?? {}),
    input.teamOverrides,
  )
  const { values, clamped } = clampToSafety(merged, input.safetyLimits ?? SAFETY_LIMITS)

  return {
    configRevision: input.configRevision,
    values,
    mergeAlgorithmVersion: MERGE_ALGORITHM_VERSION,
    safetyLimitsVersion: SAFETY_LIMITS_VERSION,
    contentHash: configContentHash(values),
    clamped,
    sources: input.sources,
  }
}

/** 只对生效值取 hash；revision 与来源不属于「配置内容」。 */
export function configContentHash(values: TeamConfig): string {
  return hashContent(values)
}

/**
 * 快照是否仍然自洽：重算 values 的 hash 与记录值一致。
 *
 * 恢复或迁移时用它发现「快照被改过」——快照不可变，hash 对不上就说明
 * 数据不是当初写进去的那份。
 */
export function isSnapshotConsistent(snapshot: EffectiveConfigSnapshot): boolean {
  return configContentHash(snapshot.values) === snapshot.contentHash
}