/**
 * T29（CHG-50）：团队预设库 —— 三层来源只读目录（builtin / global / project）。
 *
 * 预设是团队模板（开箱即用团队）：**标准队长（myteam-captain，所有团队相同，不在队员名册里）
 * + 队员列表（每名队员可单独绑定技能与 MCP）** + 看板列 + 泳道 + 门禁链 + 任务类型。
 * 与角色库的分层差异（CHG-52 用户定案）：
 *   - **全局只保留角色**（角色定位能力），不存团队模板；
 *   - 团队模板只在**项目层**（任务维度）组合角色得到；
 *   - builtin：随插件分发、只读的开箱团队（标准队长 + 3 名队员）；
 *   - project：`<workspaceRoot>/.team-workplace/config/presets/*.json`。
 *
 * 纪律：
 *   - 面板/门面**只读**；模板的创建/复制/fork/删除走队长工具（CHG-57），面板不写盘；
 *   - 非法 JSON / 缺字段只跳过该文件并记 warning，不抛错（一个坏文件不能拖垮目录）；
 *   - 同 id 跨层不合并（三层各是一份来源，运行时归属由使用方决定）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG } from '../config/team-config.ts'

export type PresetOrigin = 'builtin' | 'project'

export interface PresetMember {
  roleId: string
  instanceName?: string
  /** 该队员绑定的技能（空 = 继承角色配置） */
  skills?: string[]
  /** 该队员可见的 MCP allowlist（空 = 继承角色配置） */
  mcpAllowlist?: string[]
}

export interface PresetDefinition {
  id: string
  name: string
  description?: string
  /** 队长固定为标准预设（myteam-captain），不在此列表里；members = 队员（开箱团队为 3 名） */
  members: PresetMember[]
  board?: { columns?: string[]; columnMapping?: Record<string, string[]> }
  pipeline?: { swimlaneBy?: string; stages?: string[]; layout?: string }
  gates?: { enabled?: boolean; commandTimeoutMs?: number }
  taskTypes?: Record<string, { gateChain: string[] }>
  version?: number
}

export interface PresetEntry {
  origin: PresetOrigin
  definition: PresetDefinition
  filePath?: string
  warnings: string[]
}

export interface PresetCatalog {
  entries: PresetEntry[]
  warnings: string[]
  dirs: { builtin: string; project: string }
}

/** 内置开箱团队：标准队长（myteam-captain 预设）+ 3 名队员；队员可各自绑定不同技能与 MCP */
export const BUILTIN_PRESETS: PresetDefinition[] = [
  {
    id: 'starter-team',
    name: '开箱团队',
    description: '标准队长 + 3 名队员（需求验证员 / 开发者 / 验收员）。队长固定为 myteam-captain 预设；每名队员可单独绑定技能与 MCP。',
    members: [
      { roleId: 'req-validator', instanceName: 'req-validator' },
      { roleId: 'developer', instanceName: 'developer' },
      { roleId: 'acceptor', instanceName: 'acceptor' },
    ],
    board: { columns: DEFAULT_CONFIG.board.columns, columnMapping: DEFAULT_CONFIG.board.columnMapping },
    pipeline: DEFAULT_CONFIG.pipeline,
    gates: DEFAULT_CONFIG.gates,
    taskTypes: DEFAULT_CONFIG.taskTypes,
    version: 1,
  },
]

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function presetDirs(workspaceRoot: string): PresetCatalog['dirs'] {
  return {
    builtin: '（插件内置）',
    project: join(workspaceRoot, '.team-workplace', 'config', 'presets'),
  }
}

function normalizePreset(raw: unknown, origin: PresetOrigin, filePath: string | undefined, warnings: string[]): PresetDefinition | undefined {
  if (!raw || typeof raw !== 'object') {
    warnings.push(`${filePath ?? origin}: preset must be a JSON object`)
    return undefined
  }
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id : ''
  const name = typeof obj.name === 'string' ? obj.name : ''
  if (!SAFE_ID.test(id) || id.includes('..')) {
    warnings.push(`${filePath ?? origin}: invalid preset id ${JSON.stringify(obj.id)} (safe id required)`)
    return undefined
  }
  if (!name) {
    warnings.push(`${filePath ?? origin}: preset "${id}" is missing name`)
    return undefined
  }
  // 队员列表：新格式 members；兼容旧格式 roster（队长隐式、若出现则忽略）
  const rawMembers = Array.isArray(obj.members) ? obj.members : Array.isArray(obj.roster) ? obj.roster : []
  const members: PresetMember[] = rawMembers.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const rec = item as Record<string, unknown>
    const roleId = typeof rec.roleId === 'string' ? String(rec.roleId) : ''
    if (!roleId || roleId === 'captain') return []
    const instanceName = typeof rec.instanceName === 'string' ? String(rec.instanceName) : undefined
    const skills = Array.isArray(rec.skills) ? rec.skills.filter((skill): skill is string => typeof skill === 'string') : []
    const mcpAllowlist = Array.isArray(rec.mcpAllowlist) ? rec.mcpAllowlist.filter((name): name is string => typeof name === 'string') : []
    return [{
      roleId,
      ...(instanceName ? { instanceName } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(mcpAllowlist.length > 0 ? { mcpAllowlist } : {}),
    }]
  })
  if (members.length === 0) warnings.push(`${filePath ?? origin}: preset "${id}" has no members`)
  if (members.length > 6) warnings.push(`${filePath ?? origin}: preset "${id}" has ${members.length} members (team limit is 6)`)
  const boardRaw = (obj.board ?? {}) as Record<string, unknown>
  const pipelineRaw = (obj.pipeline ?? {}) as Record<string, unknown>
  const gatesRaw = (obj.gates ?? {}) as Record<string, unknown>
  const taskTypesRaw = (obj.taskTypes ?? {}) as Record<string, unknown>
  return {
    id,
    name,
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    members,
    ...(Array.isArray(boardRaw.columns) || (boardRaw.columnMapping && typeof boardRaw.columnMapping === 'object')
      ? {
        board: {
          ...(Array.isArray(boardRaw.columns) ? { columns: boardRaw.columns.filter((col): col is string => typeof col === 'string') } : {}),
          ...(boardRaw.columnMapping && typeof boardRaw.columnMapping === 'object' ? { columnMapping: boardRaw.columnMapping as Record<string, string[]> } : {}),
        },
      }
      : {}),
    ...(Object.keys(pipelineRaw).length > 0
      ? {
        pipeline: {
          ...(typeof pipelineRaw.swimlaneBy === 'string' ? { swimlaneBy: pipelineRaw.swimlaneBy } : {}),
          ...(Array.isArray(pipelineRaw.stages) ? { stages: pipelineRaw.stages.filter((stage): stage is string => typeof stage === 'string') } : {}),
          ...(typeof pipelineRaw.layout === 'string' ? { layout: pipelineRaw.layout } : {}),
        },
      }
      : {}),
    ...(Object.keys(gatesRaw).length > 0
      ? {
        gates: {
          ...(typeof gatesRaw.enabled === 'boolean' ? { enabled: gatesRaw.enabled } : {}),
          ...(typeof gatesRaw.commandTimeoutMs === 'number' ? { commandTimeoutMs: gatesRaw.commandTimeoutMs } : {}),
        },
      }
      : {}),
    ...(Object.keys(taskTypesRaw).length > 0
      ? {
        taskTypes: Object.fromEntries(
          Object.entries(taskTypesRaw).flatMap(([key, value]) => {
            const chain = (value as Record<string, unknown>)?.gateChain
            return Array.isArray(chain) ? [[key, { gateChain: chain.filter((item): item is string => typeof item === 'string') }]] : []
          }),
        ),
      }
      : {}),
    ...(typeof obj.version === 'number' ? { version: obj.version } : {}),
  }
}

/** 读取单层目录（不存在返回空；坏文件只记 warning） */
export function readPresetsFromDir(dir: string, origin: PresetOrigin, warnings: string[]): PresetEntry[] {
  if (!existsSync(dir)) return []
  const out: PresetEntry[] = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const filePath = join(dir, file)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      warnings.push(`${filePath}: invalid JSON, skipped`)
      continue
    }
    const entryWarnings: string[] = []
    const definition = normalizePreset(raw, origin, filePath, entryWarnings)
    warnings.push(...entryWarnings)
    if (definition) out.push({ origin, definition, filePath, warnings: entryWarnings })
  }
  return out
}

/** 团队模板目录（builtin + project；全局只存角色，不存团队模板，CHG-52） */
export function readPresetCatalog(workspaceRoot: string): PresetCatalog {
  const dirs = presetDirs(workspaceRoot)
  const warnings: string[] = []
  const builtin: PresetEntry[] = BUILTIN_PRESETS.map((definition) => ({
    origin: 'builtin' as const,
    definition: structuredClone(definition),
    warnings: [],
  }))
  const project = readPresetsFromDir(dirs.project, 'project', warnings)
  const entries = [...project, ...builtin].sort((a, b) => a.definition.id.localeCompare(b.definition.id))
  return { entries, warnings, dirs }
}

/* ── 项目模板写路径（CHG-57）：内置只读、覆写两段确认、删除确认 ── */

export const BUILTIN_PRESET_IDS: ReadonlySet<string> = new Set(BUILTIN_PRESETS.map((preset) => preset.id))

export function projectPresetPath(workspaceRoot: string, presetId: string): string {
  return join(presetDirs(workspaceRoot).project, `${presetId}.json`)
}

export function readProjectPreset(workspaceRoot: string, presetId: string): PresetDefinition | undefined {
  const path = projectPresetPath(workspaceRoot, presetId)
  if (!existsSync(path)) return undefined
  const warnings: string[] = []
  try {
    return normalizePreset(JSON.parse(readFileSync(path, 'utf8')), 'project', path, warnings)
  } catch {
    return undefined
  }
}

export type PresetWriteResult =
  | { ok: true; definition: PresetDefinition; path: string; created: boolean }
  | { ok: false; code: string; message: string }

/** 校验模板定义（结构 + 名册上限；队长隐式、members 里出现 captain 会被忽略） */
export function validatePresetDefinition(raw: unknown): PresetDefinition | { errors: string[] } {
  const warnings: string[] = []
  const definition = normalizePreset(raw, 'project', 'preset', warnings)
  if (!definition) return { errors: warnings.length > 0 ? warnings : ['preset must be a JSON object with id/name'] }
  const errors: string[] = []
  if (definition.members.length === 0) errors.push('preset must have at least 1 member (captain is implicit)')
  if (definition.members.length > 6) errors.push(`preset has ${definition.members.length} members (team limit is 6)`)
  return errors.length > 0 ? { errors } : definition
}

/** 写项目模板（内置 id 拒写；已存在需 overwrite；version 由调用方决定） */
export function writeProjectPreset(workspaceRoot: string, definition: PresetDefinition, opts: { overwrite?: boolean } = {}): PresetWriteResult {
  if (BUILTIN_PRESET_IDS.has(definition.id)) {
    return { ok: false, code: 'MT_PRESET_BUILTIN', message: `preset "${definition.id}" is builtin (read-only); copy it to a new id instead` }
  }
  if (!SAFE_ID.test(definition.id) || definition.id.includes('..')) {
    return { ok: false, code: 'MT_VALIDATION', message: `invalid preset id "${definition.id}" (safe id required)` }
  }
  const path = projectPresetPath(workspaceRoot, definition.id)
  const exists = existsSync(path)
  if (exists && opts.overwrite !== true) {
    return { ok: false, code: 'MT_PRESET_EXISTS', message: `preset "${definition.id}" already exists; pass overwrite=true to update it` }
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(definition, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return { ok: true, definition, path, created: !exists }
}

/** 删除项目模板（文件不存在返回 false；内置 id 由调用方先拒） */
export function deleteProjectPreset(workspaceRoot: string, presetId: string): boolean {
  const path = projectPresetPath(workspaceRoot, presetId)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}
