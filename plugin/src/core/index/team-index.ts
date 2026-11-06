/**
 * T24（CHG-45）：团队索引 —— 工作区级 + 跨工作区级派生索引。
 *
 * 背景：面板全局视图此前只聚合「存活的队长会话」——会话关闭/宿主重启后，未归档团队
 * 会从全局列表消失（docs/11 §七 P1）。本模块把账本折叠成可重建的摘要索引：
 *
 *   .team-workplace/state/teams.json        # 工作区级：本工作区所有团队摘要
 *   $DSH_HOME/myteam/workspaces.json         # 跨工作区级：workspaceRoot → teams[]
 *
 * 纪律（docs/11 §二）：
 *  - 索引是**派生数据**，不是事实源：任何时刻可 scanWorkspaceIndex() 全量重建；
 *  - 原子写（tmp + rename），半写文件不会出现在目标路径；
 *  - 写失败不阻断 commit 主路径（调用方 catch + warn）；
 *  - 不进入模型上下文（F2），面板只读。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { foldEvents } from '../scheduler/fold.ts'
import type { TeamProjection } from '../scheduler/state.ts'

export interface TeamIndexMember {
  roleId: string
  instanceName: string
  status: string
}

export interface TeamIndexEntry {
  teamId: string
  /** 团队名（账本 team.created.name；旧索引无此字段时面板回落 teamId） */
  name?: string
  goal: string
  state: string
  createdAt: number
  updatedAt: number
  members: TeamIndexMember[]
  counts: { tasks: number; done: number; running: number; members: number }
}

export interface WorkspaceIndex {
  version: 1
  workspaceRoot: string
  updatedAt: number
  teams: TeamIndexEntry[]
}

export interface GlobalWorkspaceEntry {
  workspaceRoot: string
  updatedAt: number
  teams: TeamIndexEntry[]
}

export interface GlobalIndex {
  version: 1
  updatedAt: number
  workspaces: Record<string, GlobalWorkspaceEntry>
}

const INDEX_FILE = 'teams.json'

/* ── 路径 ── */

export function workspaceIndexPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.team-workplace', 'state', INDEX_FILE)
}

/** 插件级 home（跨工作区共享）：$DSH_HOME/myteam，缺省 ~/.dsh/myteam */
export function resolveMyteamHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'myteam')
}

export function globalIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveMyteamHome(env), 'workspaces.json')
}

/* ── 归档投影 → 索引条目 ── */

/** 从投影生成索引条目（纯函数；createdAt 由调用方给，缺省沿用旧值或 0） */
export function entryFromProjection(teamId: string, proj: TeamProjection, createdAt = 0): TeamIndexEntry {
  const tasks = Object.values((proj.tasks ?? {}) as Record<string, { state?: string }>)
  const members = Object.values((proj.members ?? {}) as Record<string, { roleId?: string; instanceName?: string; status?: string }>)
  return {
    teamId,
    name: proj.name ?? '',
    goal: proj.goal ?? '',
    state: proj.state ?? 'active',
    createdAt,
    updatedAt: Date.now(),
    members: members.map((member) => ({
      roleId: member.roleId ?? '',
      instanceName: member.instanceName ?? '',
      status: member.status ?? '',
    })),
    counts: {
      tasks: tasks.length,
      done: tasks.filter((task) => task.state === 'done').length,
      running: tasks.filter((task) => task.state === 'in_progress').length,
      members: members.filter((member) => member.status === 'active' || member.status === 'suspended').length,
    },
  }
}

/* ── 读账本并折叠（坏行容错，与 remote/service.ts 同语义） ── */

export function readEventsTolerant(ledgerPath: string): { events: Array<{ seq: number; ts: number; type: string; payload: Record<string, unknown> }>; badLines: number } {
  try {
    const text = readFileSync(ledgerPath, 'utf8')
    const events: Array<{ seq: number; ts: number; type: string; payload: Record<string, unknown> }> = []
    let badLines = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        badLines += 1
      }
    }
    return { events, badLines }
  } catch {
    return { events: [], badLines: 0 }
  }
}

/** 全量扫描工作区账本，重建索引（索引缺失/损坏时的重建入口） */
export function scanWorkspaceIndex(workspaceRoot: string): WorkspaceIndex {
  const teamsDir = join(workspaceRoot, '.team-workplace', 'state', 'teams')
  const teams: TeamIndexEntry[] = []
  let names: string[] = []
  try {
    names = readdirSync(teamsDir)
  } catch {
    names = []
  }
  for (const teamId of names) {
    const { events } = readEventsTolerant(join(teamsDir, teamId, 'ledger.jsonl'))
    if (events.length === 0) continue
    const proj = foldEvents(teamId, events as never) as TeamProjection
    teams.push(entryFromProjection(teamId, proj, events[0]?.ts ?? 0))
  }
  teams.sort((a, b) => b.updatedAt - a.updatedAt)
  return { version: 1, workspaceRoot, updatedAt: Date.now(), teams }
}

/* ── 读写（原子写） ── */

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function readWorkspaceIndex(workspaceRoot: string): WorkspaceIndex | undefined {
  const path = workspaceIndexPath(workspaceRoot)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkspaceIndex
  } catch {
    return undefined
  }
}

export function writeWorkspaceIndex(workspaceRoot: string, index: WorkspaceIndex): void {
  writeJsonAtomic(workspaceIndexPath(workspaceRoot), index)
}

/** 单团队 upsert（commit 后调用：只更新这一条，不重扫全部账本） */
export function upsertTeamEntry(workspaceRoot: string, entry: TeamIndexEntry): WorkspaceIndex {
  const existing = readWorkspaceIndex(workspaceRoot)
  const teams = (existing?.teams ?? []).filter((team) => team.teamId !== entry.teamId)
  const previous = (existing?.teams ?? []).find((team) => team.teamId === entry.teamId)
  teams.push({ ...entry, createdAt: entry.createdAt || previous?.createdAt || 0 })
  teams.sort((a, b) => b.updatedAt - a.updatedAt)
  const index: WorkspaceIndex = { version: 1, workspaceRoot, updatedAt: Date.now(), teams }
  writeWorkspaceIndex(workspaceRoot, index)
  return index
}

/* ── 跨工作区索引 ── */

export function readGlobalIndex(path: string = globalIndexPath()): GlobalIndex | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GlobalIndex
  } catch {
    return undefined
  }
}

/** 把某工作区的索引写进全局索引（workspaceRoot 维度覆盖）
 *  - path 显式给出（单测/导出）→ 正常写
 *  - 缺省且处于 node:test 环境 → 只计算不落盘（避免单测污染 ~/.dsh 且规避并发 rename 竞争）
 */
export function upsertGlobalWorkspace(workspaceRoot: string, index: WorkspaceIndex, path?: string): GlobalIndex {
  const target = path ?? globalIndexPath()
  if (!path && process.env.NODE_TEST_CONTEXT) {
    return { version: 1, updatedAt: Date.now(), workspaces: { [workspaceRoot]: { workspaceRoot, updatedAt: Date.now(), teams: index.teams } } }
  }
  const existing = readGlobalIndex(target) ?? { version: 1, updatedAt: 0, workspaces: {} }
  const updated: GlobalIndex = {
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      ...existing.workspaces,
      [workspaceRoot]: { workspaceRoot, updatedAt: Date.now(), teams: index.teams },
    },
  }
  writeJsonAtomic(target, updated)
  return updated
}
