/**
 * T11（FR-9.1/R12/R4b）：team.config.json 加载 + 三层合并（纯函数 + 单测〔J1〕）。
 *
 * 合并纪律（K5）：
 *   - 数组整条替换，禁止深合并；
 *   - patch 硬上限（host 层）与 config 冲突取更严格者；
 *   - 非法配置（如列映射不覆盖终态）→ 回退默认 + 告警（返回 warnings）。
 * 层级：内置默认 < 项目 team.config.json < 团队模板（CHG-55：建团时按模板落
 * `tasks/<teamId>/team.config.json`，团队级更具体、优先级最高）。
 *
 * CHG-102：落盘根改为项目级 `.dsh-myteam/`，路径统一从 `core/workspace/layout.ts` 取。
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeTextAtomic } from '../fs/write-log.ts'
import { storeLayout, teamConfigPath as teamConfigPathOf } from '../workspace/layout.ts'

export interface TeamConfig {
  board: {
    columns: string[]
    columnMapping: Record<string, string[]>
    cardFields: string[]
    dragRules: 'state-machine'
  }
  pipeline: { swimlaneBy: 'stage' | 'member' | 'priority'; stages: string[]; layout: 'serpentine' | 'linear' }
  dag: { showModel: boolean; collapseGroups: boolean; direction: 'LR' | 'TB' }
  views: { default: string; tabs: string[] }
  limits: { maxMembers: number; memberMaxDepth: number; maxChildren: number; maxTasks: number }
  gates: { enabled: boolean; commandTimeoutMs: number }
  taskTypes: Record<string, { gateChain: string[] }>
  clarify: { maxRounds: number }
  memory: { evidenceRequired: boolean }
  /**
   * CHG-87（FR-5.4）：完成时 scope 审计开关。
   * true = 任务声明了 `writeScopes` 就对照证据块申报的文件对账（越界只留痕不阻断）；
   * false = 关闭审计（非开发团队/纯文档团队可能不想要这层噪音）。
   */
  audit: { writeScopes: boolean }
  /**
   * FR-1.3（CHG-173）：DAG 来源二选一。唯一的**顶层标量**字段：
   *  - `captain`（默认）= 队长按目标推导任务组（现状行为）；
   *  - `template` = submit_plan 未显式给任务时，按 `pipeline.stages` 生成内置固定
   *    流水线模板任务组（线性链，每阶段一任务；AC 与交付物路径是**占位**，
   *    approve 前由队长编辑——诚实标注，不假装想好的计划）。
   */
  taskPlanning: 'captain' | 'template'
}

export const DEFAULT_CONFIG: TeamConfig = {
  board: {
    columns: ['backlog', 'ready', 'running', 'gates', 'done'],
    columnMapping: {
      running: ['in_progress', 're-scoping'],
      gates: ['gate:review', 'gate:verify', 'gate:archive'],
      done: ['done'],
      backlog: ['failed', 'blocked', 'cancelled'], // 终态兜底桶：面板显示在 backlog 列头下的"需人工"分区
    },
    cardFields: ['assignee', 'deps', 'gateState', 'tokens'],
    dragRules: 'state-machine',
  },
  pipeline: { swimlaneBy: 'stage', stages: ['plan', 'dev', 'gates', 'integrate'], layout: 'serpentine' },
  dag: { showModel: true, collapseGroups: true, direction: 'LR' },
  views: { default: 'board', tabs: ['board', 'swimlane', 'dag', 'roster'] },
  /**
   * CHG-187（FR-32 支柱一）：派生树配额。
   *
   * `memberMaxDepth` 默认 **1** = 允许一层子成员（队长召唤的成员可以再带一个子 Agent）；
   * `maxChildren` 默认 **3** = 单个成员最多 3 个直接子成员。
   *
   * **向后兼容（老团队）**：这两个默认值只对**新建团队**（无 `team.config.json` 或配置里没写
   * 这两项）生效。已有团队配置里显式写了 `memberMaxDepth: 0` 的，读时**原样保留 0**
   * （`mergeConfig` 逐子键覆盖，`applyCeilings` 只在超硬上限时钳制）——不重写文件、不改行为。
   * 证据：`t139-10`（老配置读到 0）。
   */
  limits: { maxMembers: 6, memberMaxDepth: 1, maxChildren: 3, maxTasks: 20 },
  gates: { enabled: true, commandTimeoutMs: 120000 },
  taskTypes: {
    default: { gateChain: ['review', 'archive'] },
    dev: { gateChain: ['review', 'verify', 'archive'] },
  },
  clarify: { maxRounds: 3 },
  // 记忆审计（CHG-19，FR-6.2/ADR-009）：true = 无证据指针的记忆条目被审计落账本
  memory: { evidenceRequired: true },
  // scope 完成审计（CHG-87，FR-5.4）：默开——越界只留痕不阻断交付
  audit: { writeScopes: true },
  // DAG 来源（FR-1.3，CHG-173）：默认队长推导；'template' = 按 pipeline.stages 生成模板任务组
  taskPlanning: 'captain',
}

/** patch 层硬上限（升级存活；config 不得超过，冲突取更严格者） */
export const PATCH_CEILINGS = {
  'limits.maxMembers': 6,
  // CHG-187（FR-32）：派生深度硬上限 2（默认 1）——再深就该拆团队，而不是继续套娃
  'limits.memberMaxDepth': 2,
  // CHG-187（FR-32）：单成员子数硬上限 5（默认 3）
  'limits.maxChildren': 5,
  /* CHG-210 批 5.3：**任务数也要有硬顶**。
   * 旧实现只钳前三项，`maxTasks` 可以配到任意大——「配额」形同建议，且与批量建任务
   * 的单批上限（30）互相打架：25 条的批能过批检，团队空时只能落 20 条，第 21 条起逐条报错，
   * 用户得到「部分成功」而不是「你该分两批」。硬顶取 100：足够容纳真实项目，又能拦住
   * 手滑写成 1e9 的配置。 */
  'limits.maxTasks': 100,
} as const

export interface MergeResult {
  config: TeamConfig
  warnings: string[]
  /** true = 至少一层配置非法/未覆盖终态，被忽略（FR-9.1 拒绝式） */
  fellBack: boolean
  /** 真正生效的层（CHG-56：项目层与团队层可分别生效/被忽略） */
  applied: { project: boolean; team: boolean }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 字符串数组（结构校验用；空数组合法——空看板列会被覆盖校验兜住） */
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((item) => typeof item === 'string')
/** 枚举值（结构校验用；只查类型与取值，不查业务范围） */
const oneOf = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v)
const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

/** 数组整条替换的对象浅合并（仅一层 config 深度，键集以 overrides 为准） */
export function mergeConfig(base: TeamConfig, overrides: unknown, warnings: string[]): TeamConfig {
  if (!isPlainObject(overrides)) return base
  const out = structuredClone(base) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in base)) {
      warnings.push(`unknown config key "${key}" ignored`)
      continue
    }
    if (isPlainObject(value) && isPlainObject((base as unknown as Record<string, unknown>)[key])) {
      // 对象段落：按子键合并——子键值为对象则递归浅并，子键值为数组/标量则整条替换（K5）
      const baseSection = (base as unknown as Record<string, unknown>)[key] as Record<string, unknown>
      const mergedSection: Record<string, unknown> = { ...baseSection }
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (isPlainObject(subValue) && isPlainObject(baseSection[subKey])) {
          mergedSection[subKey] = { ...(baseSection[subKey] as Record<string, unknown>), ...(subValue as Record<string, unknown>) }
        } else {
          mergedSection[subKey] = subValue
        }
      }
      out[key] = mergedSection
    } else {
      // 数组/标量：整条替换（K5）
      out[key] = value
    }
  }
  return out as unknown as TeamConfig
}

/** 终态覆盖校验（FR-9.1 非法配置判定）：columnMapping 的归并结果必须覆盖全部终态 */
export function validateCoverage(config: TeamConfig): string[] {
  const warnings: string[] = []
  const terminalStates = ['done', 'failed', 'blocked', 'cancelled']
  const mapped = new Set<string>(config.board.columns)
  for (const states of Object.values(config.board.columnMapping)) {
    for (const s of states) mapped.add(s)
  }
  for (const t of terminalStates) {
    if (!mapped.has(t)) warnings.push(`terminal state "${t}" not covered by columns/columnMapping; fallback engaged`)
  }
  return warnings
}

/** 更严格者胜（C5 同源思想）：maxMembers/memberMaxDepth 不得超过 patch 硬上限 */
export function applyCeilings(config: TeamConfig, warnings: string[]): TeamConfig {
  const out = structuredClone(config)
  if (out.limits.maxMembers > PATCH_CEILINGS['limits.maxMembers']) {
    warnings.push(`limits.maxMembers ${out.limits.maxMembers} exceeds patch ceiling ${PATCH_CEILINGS['limits.maxMembers']}; clamped`)
    out.limits.maxMembers = PATCH_CEILINGS['limits.maxMembers']
  }
  if (out.limits.memberMaxDepth > PATCH_CEILINGS['limits.memberMaxDepth']) {
    warnings.push(`limits.memberMaxDepth ${out.limits.memberMaxDepth} exceeds patch ceiling ${PATCH_CEILINGS['limits.memberMaxDepth']}; clamped`)
    out.limits.memberMaxDepth = PATCH_CEILINGS['limits.memberMaxDepth']
  }
  if (out.limits.maxChildren > PATCH_CEILINGS['limits.maxChildren']) {
    warnings.push(`limits.maxChildren ${out.limits.maxChildren} exceeds patch ceiling ${PATCH_CEILINGS['limits.maxChildren']}; clamped`)
    out.limits.maxChildren = PATCH_CEILINGS['limits.maxChildren']
  }
  return out
}

/** 结构快检（拒绝式但只拒"类型明显错误"）：段落缺失合法（merge 补默认）；
 * 已知段落若存在但类型错误 → 非法（防 garbage JSON 拖垮面板，也防设置页把坏值写进去）。
 *
 * CHG-117：从「只查段落是对象」收紧到**每个字段的类型/枚举**（与
 * `plugin/schema/team-config.schema.json` 同形）。只查类型与取值，**不查业务范围**
 * （`limits` 越界由 `applyCeilings` 钳制，不在这里拒绝）。 */
export function isStructurallyValidConfig(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  // 顶层标量（CHG-173）：taskPlanning 是 TeamConfig 里唯一的非段落字段——合并走「整条替换」，
  // 校验只查枚举取值。放在段落校验**之前**：段落循环假定值是对象，标量不能进那个循环。
  const scalars: Record<string, (v: unknown) => boolean> = {
    taskPlanning: (v) => oneOf(v, ['captain', 'template']),
  }
  for (const [key, check] of Object.entries(scalars)) {
    if (!(key in value)) continue
    if (!check(value[key])) return false
  }
  const sections: Record<string, (v: Record<string, unknown>) => boolean> = {
    board: (v) => (v.columns === undefined || isStringList(v.columns))
      && (v.columnMapping === undefined || (isPlainObject(v.columnMapping) && Object.values(v.columnMapping).every(isStringList)))
      && (v.cardFields === undefined || isStringList(v.cardFields))
      && (v.dragRules === undefined || v.dragRules === 'state-machine'),
    pipeline: (v) => (v.swimlaneBy === undefined || oneOf(v.swimlaneBy, ['stage', 'member', 'priority']))
      && (v.stages === undefined || isStringList(v.stages))
      && (v.layout === undefined || oneOf(v.layout, ['serpentine', 'linear'])),
    dag: (v) => (v.showModel === undefined || typeof v.showModel === 'boolean')
      && (v.collapseGroups === undefined || typeof v.collapseGroups === 'boolean')
      && (v.direction === undefined || oneOf(v.direction, ['LR', 'TB'])),
    views: (v) => (v.default === undefined || oneOf(v.default, ['board', 'swimlane', 'dag', 'roster']))
      && (v.tabs === undefined || isStringList(v.tabs)),
    limits: (v) => (v.maxMembers === undefined || isFiniteNumber(v.maxMembers))
      && (v.memberMaxDepth === undefined || isFiniteNumber(v.memberMaxDepth))
      && (v.maxChildren === undefined || isFiniteNumber(v.maxChildren))
      && (v.maxTasks === undefined || isFiniteNumber(v.maxTasks)),
    gates: (v) => (v.enabled === undefined || typeof v.enabled === 'boolean')
      && (v.commandTimeoutMs === undefined || isFiniteNumber(v.commandTimeoutMs)),
    taskTypes: (v) => Object.values(v).every((entry) => isPlainObject(entry) && (entry.gateChain === undefined || isStringList(entry.gateChain))),
    clarify: (v) => v.maxRounds === undefined || isFiniteNumber(v.maxRounds),
    memory: (v) => v.evidenceRequired === undefined || typeof v.evidenceRequired === 'boolean',
    audit: (v) => v.writeScopes === undefined || typeof v.writeScopes === 'boolean',
  }
  for (const [section, check] of Object.entries(sections)) {
    if (!(section in value)) continue
    const sectionValue = value[section]
    if (!isPlainObject(sectionValue) || !check(sectionValue)) return false
  }
  return true
}

/**
 * 顶层入口（CHG-55/56）：内置默认 ← 项目 config → 团队级 config。
 * 逐层应用：非法/不覆盖终态的层被忽略并告警，已生效的浅层保留（拒绝式但不误伤）。
 * 最后统一做硬上限钳制。
 */
export function loadEffectiveConfig(projectConfigRaw: unknown, teamConfigRaw?: unknown): MergeResult {
  const warnings: string[] = []
  const applied = { project: false, team: false }
  let config = DEFAULT_CONFIG
  let fellBack = false
  const applyLayer = (raw: unknown, layer: keyof MergeResult['applied'], label: string): void => {
    if (raw === undefined || raw === null) return
    if (!isStructurallyValidConfig(raw)) {
      warnings.push(`${label} structurally invalid; layer ignored`)
      fellBack = true
      return
    }
    const candidate = mergeConfig(config, raw, warnings)
    const coverage = validateCoverage(candidate)
    if (coverage.length > 0) {
      warnings.push(...coverage.map((w) => `${label}: ${w}`))
      fellBack = true
      return
    }
    config = candidate
    applied[layer] = true
  }
  applyLayer(projectConfigRaw, 'project', 'project team.config.json')
  applyLayer(teamConfigRaw, 'team', 'team team.config.json')
  const clamped = applyCeilings(config, warnings)
  return { config: clamped, warnings, fellBack, applied }
}

/** 项目级配置落点（CHG-56 / CHG-102）：`<project>/.dsh-myteam/config/team.config.json` */
function projectConfigPath(workspaceRoot: string): string {
  return storeLayout(workspaceRoot).teamConfig
}

/** 读项目级配置（缺失/坏 JSON 返回 undefined） */
export function readProjectConfigRaw(workspaceRoot: string): unknown {
  return readJsonIfExists(projectConfigPath(workspaceRoot))
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 团队级配置落点（CHG-55 / CHG-102）：与账本同目录，随团队生命周期走 */
export function teamConfigPath(workspaceRoot: string, teamId: string): string {
  return teamConfigPathOf(workspaceRoot, teamId)
}

/** 读团队级配置（缺失/坏 JSON 返回 undefined；坏 JSON 不抛错，由上层回退默认） */
export function readTeamConfigRaw(workspaceRoot: string, teamId: string): unknown {
  return readJsonIfExists(teamConfigPath(workspaceRoot, teamId))
}

/** 原子写团队级配置（tmp + rename；父目录自动创建） */
export function writeTeamConfigRaw(workspaceRoot: string, teamId: string, value: unknown): string {
  const path = teamConfigPath(workspaceRoot, teamId)
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { ensureParent: true })
  return path
}

/** 团队模板 → 生效配置覆盖（CHG-55）：只取模板显式声明的段落，未声明段走插件默认 */
export function configOverrideFromPreset(preset: {
  board?: { columns?: string[]; columnMapping?: Record<string, string[]> }
  pipeline?: { swimlaneBy?: string; stages?: string[]; layout?: string }
  gates?: { enabled?: boolean; commandTimeoutMs?: number }
  taskTypes?: Record<string, { gateChain: string[] }>
}): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = {}
  if (preset.board && (preset.board.columns || preset.board.columnMapping)) {
    overrides.board = {
      ...(preset.board.columns ? { columns: preset.board.columns } : {}),
      ...(preset.board.columnMapping ? { columnMapping: preset.board.columnMapping } : {}),
    }
  }
  if (preset.pipeline) overrides.pipeline = preset.pipeline
  if (preset.gates) overrides.gates = preset.gates
  if (preset.taskTypes) overrides.taskTypes = preset.taskTypes
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

