/**
 * T25（CHG-46）：离线只读视图 —— 不依赖队长会话，直接从工作区账本折叠出看板/任务详情。
 *
 * 背景：CHG-45 让面板能看到离线团队（跨工作区索引），但点击只能提示「会话未运行」，
 * 看不到任何任务（docs/11 §七 P4）。本模块把「读账本 → 折叠 → 视图」搬到门面进程内：
 *
 *   workspaceRoot/.team-workplace/state/teams/<teamId>/ledger.jsonl
 *     └─ readEventsTolerant（坏行跳过）→ foldTolerant（坏事件跳过）→ buildBoardView
 *
 * 纪律：
 *  - 只读：不写账本/投影/索引，不构造 TeamService（没有单写者，也不参与调度）；
 *  - 容错：坏行/非法转移不抛给 UI，降级为 degraded 标记 + 计数（账本仍可读）；
 *  - 路径安全：teamId 走白名单字符集，workspaceRoot 必须是绝对路径，禁止拼出子目录穿越。
 */
import { dirname, isAbsolute, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { applyEvent } from '../scheduler/fold.ts'
import { emptyProjection, type TeamProjection } from '../scheduler/state.ts'
import type { LedgerEvent } from '../ledger/ledger.ts'
import type { TokensFile } from '../ledger/token-sidecar.ts'
import { loadEffectiveConfig, readProjectConfigRaw, readTeamConfigRaw } from '../config/team-config.ts'
import { buildConfigPayload, type ConfigPayload } from '../config/config-view.ts'
import { readPresetCatalog, type PresetCatalog } from '../presets/preset-store.ts'
import { buildAuditView, buildBoardView, buildProjectView, buildTaskDetailView, buildTokensView, type BoardView, type ProjectView, type TaskDetailView } from '../../remote/views.ts'
import { readEventsTolerant, resolveMyteamHome } from './team-index.ts'
import { listRoleCatalog, readProjectRoleCard, type RoleStorePaths } from '../roles/role-store.ts'

/** 团队 id 白名单：字母数字开头，只允许字母数字/点/下划线/连字符（点号单独不放行，避免 ..） */
const SAFE_TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface OfflineMeta {
  /** 最后一条账本事件时间（0 = 空账本） */
  updatedAt: number
  lastSeq: number
  /** JSON 坏行数（账本追加中途崩溃等） */
  badLines: number
  /** 折叠时被跳过的事件数（非法转移/未知 payload） */
  skippedEvents: number
  degraded: boolean
}

export interface OfflineBoardResult {
  teamId: string
  workspaceRoot: string
  board: BoardView
  /**
   * CHG-62（CHG-86 补类型）：离线设置页也要能看生效配置——
   * 载荷与 `getConfig` 同构（`buildConfigPayload`），此前只在此处漏声明字段（tsc TS2353）。
   */
  config: ConfigPayload
  meta: OfflineMeta
}

export function isSafeTeamId(teamId: string): boolean {
  return SAFE_TEAM_ID.test(teamId) && !teamId.includes('..')
}

/** 团队账本路径；非法参数返回 undefined（门面据此返回 validation 错误，不抛异常） */
export function teamLedgerPath(workspaceRoot: string, teamId: string): string | undefined {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return undefined
  if (!isSafeTeamId(teamId)) return undefined
  return join(workspaceRoot, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl')
}

export interface TolerantFold {
  proj: TeamProjection
  skippedEvents: number
}

/**
 * 逐事件折叠：单条事件非法只跳过该条，保留此前已折叠的状态。
 * 与 foldEvents 的差别仅在错误策略（全量折叠用于写路径，必须 fail-fast）。
 */
export function foldTolerant(teamId: string, events: LedgerEvent[]): TolerantFold {
  const proj = emptyProjection(teamId)
  let skippedEvents = 0
  for (const event of events) {
    try {
      applyEvent(proj, event)
    } catch {
      skippedEvents += 1
    }
  }
  return { proj, skippedEvents }
}

interface LedgerRead {
  events: LedgerEvent[]
  badLines: number
  meta: OfflineMeta
}

/** 读账本 + 折叠（纯 IO + 纯函数；不存在/不可读时 events 为空） */
export function readOfflineTeam(workspaceRoot: string, teamId: string): LedgerRead | undefined {
  const ledgerPath = teamLedgerPath(workspaceRoot, teamId)
  if (!ledgerPath) return undefined
  const { events: raw, badLines } = readEventsTolerant(ledgerPath)
  const events = raw as LedgerEvent[]
  const last = events.length > 0 ? events[events.length - 1] : undefined
  return {
    events,
    badLines,
    meta: {
      updatedAt: last?.ts ?? 0,
      lastSeq: last?.seq ?? 0,
      badLines,
      skippedEvents: 0,
      degraded: badLines > 0,
    },
  }
}

/** 离线看板：空账本返回 undefined（UI 显示「无快照」而不是空看板） */
export function buildOfflineBoard(workspaceRoot: string, teamId: string): OfflineBoardResult | undefined {
  const read = readOfflineTeam(workspaceRoot, teamId)
  if (!read || read.events.length === 0) return undefined
  const { proj, skippedEvents } = foldTolerant(teamId, read.events)
  // CHG-55/56：离线看板按项目级 + 团队级 team.config.json（建团模板落盘）的列与列映射渲染
  const loaded = loadEffectiveConfig(readProjectConfigRaw(workspaceRoot), readTeamConfigRaw(workspaceRoot, teamId))
  const config = loaded.config
  const configSource = loaded.applied.team ? 'team' : loaded.applied.project ? 'project' : 'default'
  const board = buildBoardView(
    { projectionSnapshot: proj },
    config.board.columnMapping,
    config.board.columns,
  )
  return {
    teamId,
    workspaceRoot,
    board,
    // CHG-62：离线设置页也要能看生效配置（此前只显示「默认值」占位）
    config: buildConfigPayload(config, loaded.warnings, configSource),
    meta: { ...read.meta, skippedEvents, degraded: read.meta.degraded || skippedEvents > 0 },
  }
}

/** 离线任务详情（时间线/证据/沟通区都可从账本复原） */
export function buildOfflineTaskDetail(workspaceRoot: string, teamId: string, taskId: string): (TaskDetailView & { meta: OfflineMeta }) | undefined {
  const read = readOfflineTeam(workspaceRoot, teamId)
  if (!read || read.events.length === 0) return undefined
  const { proj, skippedEvents } = foldTolerant(teamId, read.events)
  const detail = buildTaskDetailView({ projectionSnapshot: proj }, taskId, read.events)
  if (!detail) return undefined
  return { ...detail, meta: { ...read.meta, skippedEvents, degraded: read.meta.degraded || skippedEvents > 0 } }
}

/**
 * 离线 tokens：直接读团队目录下 tokens.json 侧车（不依赖会话）。
 * 侧车缺失/损坏返回 undefined（UI 显示"暂无用量记录"），绝不抛错。
 */
export function readOfflineTokens(workspaceRoot: string, teamId: string): TokensFile | undefined {
  const ledgerPath = teamLedgerPath(workspaceRoot, teamId)
  if (!ledgerPath) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(ledgerPath), 'tokens.json'), 'utf8')) as Partial<TokensFile>
    if (parsed?.version !== 1 || typeof parsed.totals !== 'object' || parsed.totals === null) return undefined
    if (typeof parsed.days !== 'object' || parsed.days === null) return undefined
    return {
      version: 1,
      teamId,
      updatedAt: Number(parsed.updatedAt ?? 0),
      days: parsed.days,
      totals: parsed.totals,
      note: String(parsed.note ?? ''),
    }
  } catch {
    return undefined
  }
}

/** 离线 tokens 视图（与在线 getTokens 同构，带 REV-5 双口径标注） */
export function buildOfflineTokens(workspaceRoot: string, teamId: string): Record<string, unknown> | undefined {
  const file = readOfflineTokens(workspaceRoot, teamId)
  return file ? buildTokensView(file) : undefined
}

/** 离线审计：账本事件按新→旧分页（归档回放的数据面，CHG-49） */
export function buildOfflineAudit(workspaceRoot: string, teamId: string, opts: { limit?: number; beforeSeq?: number } = {}) {
  const read = readOfflineTeam(workspaceRoot, teamId)
  if (!read) return undefined
  return buildAuditView(teamId, read.events, opts)
}

/** 离线团队模板（CHG-50/52）：内置 + 项目目录（全局只存角色，不存团队模板） */
export function buildOfflinePresets(workspaceRoot: string): PresetCatalog {
  return readPresetCatalog(workspaceRoot)
}

/* ── CHG-73：删除角色前的占用面（模板引用 / 团队在册 / 项目自身角色） ── */

export interface RoleUsage {
  /** 占用方（`preset:<id>` / `team:<teamId>` / `project-role`），空 = 可删 */
  bindings: string[]
  /** 在册实例数（active/suspended 成员） */
  instances: number
  /** 引用该角色的团队 id（去重） */
  teams: string[]
  /** 引用该角色的模板 id */
  presets: string[]
}

/**
 * 角色占用面：面板删除前要能把「谁还在用它」说清楚（C7 守门的拒绝理由）。
 * 只读扫描：项目模板目录 + 项目自身角色 + 各团队账本里在册成员的角色。
 */
export function roleUsage(workspaceRoot: string, roleId: string): RoleUsage {
  const bindings: string[] = []
  const teams: string[] = []
  const presets: string[] = []
  let instances = 0
  try {
    for (const entry of readPresetCatalog(workspaceRoot).entries) {
      if ((entry.definition.members ?? []).some((member) => member.roleId === roleId)) {
        presets.push(entry.definition.id)
        bindings.push(`preset:${entry.definition.id}`)
      }
    }
  } catch {
    // 模板目录缺失/损坏：不因此阻止删除，但也不虚报
  }
  try {
    if (readProjectRoleCardSafe(workspaceRoot)?.id === roleId) {
      bindings.push('project-role')
    }
  } catch {
    // 项目自身角色文件损坏：忽略
  }
  const teamsDir = join(workspaceRoot, '.team-workplace', 'state', 'teams')
  let names: string[] = []
  try {
    names = readdirSync(teamsDir)
  } catch {
    names = []
  }
  for (const teamId of names) {
    if (!isSafeTeamId(teamId)) continue
    const folded = foldTeamLedger(workspaceRoot, teamId)
    if (!folded) continue
    const members = Object.values(folded.proj.members).filter(
      (member) => member.roleId === roleId && (member.status === 'active' || member.status === 'suspended'),
    )
    if (members.length === 0) continue
    teams.push(teamId)
    instances += members.length
    bindings.push(`team:${teamId}`)
  }
  return { bindings, instances, teams, presets }
}

/** 项目自身角色（容错读取：文件损坏不抛） */
function readProjectRoleCardSafe(workspaceRoot: string) {
  const paths = projectRolePaths(workspaceRoot)
  return readProjectRoleCard(paths)
}

/* ── CHG-69：离线项目聚合（面板「项目」作用域的数据面；不需要队长会话） ── */

/** 工作区角色库路径（离线只读：项目库 + 全局库 + 项目自身角色） */
export function projectRolePaths(workspaceRoot: string): RoleStorePaths {
  const projectRolesDir = join(workspaceRoot, '.team-workplace', 'config', 'roles')
  return {
    projectRolesDir,
    globalRolesDir: join(resolveMyteamHome(), 'roles'),
    projectRoleFile: join(workspaceRoot, '.team-workplace', 'config', 'project-role.json'),
  }
}

/** 折叠单个团队账本（容忍坏行/坏事件；空账本返回 undefined） */
function foldTeamLedger(workspaceRoot: string, teamId: string): { proj: TeamProjection; events: LedgerEvent[]; badLines: number; skipped: number } | undefined {
  const read = readOfflineTeam(workspaceRoot, teamId)
  if (!read || read.events.length === 0) return undefined
  const { proj, skippedEvents } = foldTolerant(teamId, read.events)
  return { proj, events: read.events, badLines: read.badLines, skipped: skippedEvents }
}

/**
 * 离线项目视图：扫描工作区全部团队账本 → 团队摘要 + 跨团队任务（含参与团队）+ 角色目录。
 * 任务归属 = 持有账本的团队（主责）；协作关系来自 task.participate 事件（FR-21）。
 */
export function buildOfflineProject(workspaceRoot: string, opts: { teams?: string[] } = {}): ProjectView {
  const teamsDir = join(workspaceRoot, '.team-workplace', 'state', 'teams')
  let names: string[] = []
  try {
    names = readdirSync(teamsDir)
  } catch {
    names = []
  }
  if (opts.teams && opts.teams.length > 0) names = names.filter((name) => opts.teams!.includes(name))
  let warnings: string[] = []
  const inputs = []
  for (const teamId of names) {
    if (!isSafeTeamId(teamId)) continue
    const folded = foldTeamLedger(workspaceRoot, teamId)
    if (!folded) continue
    // 列口径按团队级配置（建团模板落盘）；配置损坏时回落默认并记一条告警
    let board: BoardView
    try {
      const loaded = loadEffectiveConfig(readProjectConfigRaw(workspaceRoot), readTeamConfigRaw(workspaceRoot, teamId))
      board = buildBoardView({ projectionSnapshot: folded.proj }, loaded.config.board.columnMapping, loaded.config.board.columns)
      warnings = [...warnings, ...loaded.warnings.map((w) => `${teamId}: ${w}`)]
    } catch {
      board = buildBoardView({ projectionSnapshot: folded.proj }, {}, ['未分类'])
    }
    inputs.push({
      teamId,
      name: folded.proj.name ?? '',
      state: folded.proj.state,
      goal: folded.proj.goal ?? '',
      online: false,
      members: board.members,
      board,
    })
  }
  return buildProjectView({
    workspaceRoot,
    teams: inputs,
    entries: listRoleCatalog(projectRolePaths(workspaceRoot)),
    warnings,
  })
}
