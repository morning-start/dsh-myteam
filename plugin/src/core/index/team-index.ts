/**
 * T24（CHG-45）：团队索引 —— **项目级**派生索引。
 *
 * 背景：面板项目视图此前只聚合「存活的队长会话」——会话关闭/宿主重启后，未归档团队
 * 会从项目列表消失（docs/11 §七 P1）。本模块把账本折叠成可重建的摘要索引：
 *
 *   <project>/.dsh-myteam/state/teams.json    # 项目级：本项目所有团队摘要
 *
 * ── CHG-201（用户定案「全局和项目级分开」）──────────────────────────────────
 * **删掉跨工作区全局索引 `$DSH_HOME/myteam/workspaces.json`**：全局层只放全局资产
 * （全局角色 / 全局团队库 / 预设 / 技能），**不记录「都有哪些项目」**。项目清单由
 * 项目视图按会话工作区读 `.dsh-myteam/` 得到——两个作用域物理分离，不互相枚举。
 *
 * 纪律（docs/11 §二）：
 *  - 索引是**派生数据**，不是事实源：任何时刻可 scanWorkspaceIndex() 全量重建；
 *  - 原子写（tmp + rename），半写文件不会出现在目标路径；
 *  - 写失败不阻断 commit 主路径（调用方 catch + warn）；
 *  - 不进入模型上下文（F2），面板只读。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeTextAtomic } from '../fs/write-log.ts'
import { foldEvents } from '../scheduler/fold.ts'
import type { TeamProjection } from '../scheduler/state.ts'
import { storeLayout } from '../workspace/layout.ts'

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

const INDEX_FILE = 'teams.json'

/* ── 路径 ── */

export function workspaceIndexPath(workspaceRoot: string): string {
  return storeLayout(workspaceRoot).stateIndex
}

/** 插件级 home（跨工作区共享）：$DSH_HOME/myteam，缺省 ~/.dsh/myteam */
export function resolveMyteamHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'myteam')
}

/**
 * CHG-132（docs/20 §3）：**全局根结构**（跨项目资源）——团队库 / 角色库 / 预设技能。
 *
 * 三条隔离铁律（docs/20 §1）：
 *  - 写只能写 `$DSH_HOME/myteam/**` 与 `<workspace>/.dsh-myteam/**` 两个根；
 *  - 技能归属 **myteam 队长预设**（`presets/<presetId>/skills/`），**不进** `$DSH_HOME/skills/`；
 *  - 全局团队库只存**团队定义**（`teams/<teamId>.json`），不存运行态（账本/任务/会话）。
 */
export function globalStoreLayout(env: NodeJS.ProcessEnv = process.env) {
  const root = resolveMyteamHome(env)
  const presets = join(root, 'presets')
  return {
    root,
    teams: join(root, 'teams'),
    roles: join(root, 'roles'),
    presets,
    /** 预设技能目录（R2：技能只属于该预设，不污染其它预设） */
    presetSkills: (presetId: string) => join(presets, presetId, 'skills'),
    /** 全局团队定义文件（`teams/<teamId>.json`） */
    teamFile: (teamId: string) => join(root, 'teams', `${teamId}.json`),
  }
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
  const teamsDir = storeLayout(workspaceRoot).tasks
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
  writeTextAtomic(path, `${JSON.stringify(data, null, 2)}\n`, { ensureParent: true })
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

/* ── CHG-201：跨工作区全局索引已删除 ──────────────────────────────
 * 全局层不再记录「都有哪些项目」（`$DSH_HOME/myteam/workspaces.json` 整个文件退役）。
 * 项目视图按会话工作区读本项目 `.dsh-myteam/`；两个作用域物理分离，互不枚举。 */
