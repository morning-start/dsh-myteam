/**
 * CHG-86（P0-2 / FR-14.1）：团队归档落盘。
 *
 * 修复的缺陷：`myteam_disband` 此前只往账本写一条 `team.disbanded` 事件，payload 里
 * 带个 `archivedPaths: ['.team-workplace/archive']` 字符串就算完事——**没有任何文件 IO**。
 * 而面板归档视图（`plugin/client/client.js` 归档回放屏）渲染的是
 * `archive/<teamId>/team.json`、`tokens.json`、`members/`、`artifacts/`，
 * 这些文件**永远不存在**，整套归档视图因此是空壳。
 *
 * 布局（FR-9.3 四分区之一，`.team-workplace/archive/` 已在 .gitignore 托管块内）：
 * ```
 * .team-workplace/archive/<teamId>/
 *   MANIFEST.json             归档清单（生成时间 / 来源账本 / 事件数 / 文件列表）
 *   team.json                 团队快照（名册 + 任务终态 + 目标 + 归档时刻）
 *   tokens.json               token 侧车最终快照（按天桶）
 *   members/<memberId>.json   每名队员一份（角色 / 实例名 / 状态 / 会话 id）
 *   artifacts/artifacts.json  交付物清单（task.deliverable 事件的路径引用）
 * ```
 *
 * 设计约束：
 *  - **账本仍是唯一权威**〔I2〕：归档是只读快照，不参与 fold，不进模型上下文；
 *  - **幂等**：同一团队重复归档覆盖同名目录（内容由当次投影决定，不累加）；
 *  - **纯函数与 IO 分离**〔J1〕：`buildArchiveSnapshot` 无 IO，`writeArchive` 只写不读，
 *    `readArchive` 只读不写；这样快照结构可以在单测里不碰磁盘地断言。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamProjection } from '../scheduler/state.ts'
import type { TokensFile } from '../ledger/token-sidecar.ts'

/** 归档快照版本（结构演进时 +1，读侧按版本兼容） */
export const ARCHIVE_VERSION = 1

export interface ArchiveMember {
  id: string
  roleId: string
  instanceName: string
  status: string
  sessionId?: string
  /** 归档时仍持有的任务（正常情况下排空后为空） */
  currentTaskId?: string
}

export interface ArchiveTask {
  id: string
  title: string
  state: string
  priority: string
  assignee?: string
  gates: string[]
  gateVerdicts: Record<string, 'pass' | 'fail'>
  /** 证据条数（归档视图「交付 N 份产物」的数据源） */
  evidenceCount: number
}

export interface ArchiveArtifact {
  path: string
  taskId: string
  seq: number
}

export interface ArchiveTeamSnapshot {
  version: number
  teamId: string
  name: string
  goal: string
  state: string
  archivedAt: number
  archivedBy: string
  /** 来源账本绝对路径（归档只读回放要能找回原始事件流） */
  ledgerPath: string
  /** 归档时的账本事件数（面板「N 条事件」） */
  eventCount: number
  revision: number
  members: ArchiveMember[]
  tasks: ArchiveTask[]
  artifacts: ArchiveArtifact[]
  /** token 侧车最终快照（按天桶；面板归档视图「花费 · 按天桶」） */
  tokens: TokensFile
}

/** 归档目录（团队级）：`.team-workplace/archive/<teamId>` */
export function archiveDirOf(workspaceRoot: string, teamId: string): string {
  return join(workspaceRoot, '.team-workplace', 'archive', teamId)
}

/** 归档根目录：`.team-workplace/archive` */
export function archiveRootOf(workspaceRoot: string): string {
  return join(workspaceRoot, '.team-workplace', 'archive')
}

/**
 * 投影 + token 侧车 → 归档快照（纯函数，无 IO）。
 *
 * `tokens` 由调用方传入（host 侧 syncTokens 的结果），这样本函数可以完全无时钟、
 * 无服务依赖地在单测里断言结构。
 */
export function buildArchiveSnapshot(input: {
  team: TeamProjection
  tokens: TokensFile
  archivedAt: number
  archivedBy: string
  ledgerPath: string
  eventCount: number
}): ArchiveTeamSnapshot {
  const { team, tokens, archivedAt, archivedBy, ledgerPath, eventCount } = input
  const members: ArchiveMember[] = Object.values(team.members).map((member) => ({
    id: member.id,
    roleId: member.roleId,
    instanceName: member.instanceName,
    status: member.status,
    ...(member.sessionId ? { sessionId: member.sessionId } : {}),
    ...(member.currentTaskId ? { currentTaskId: member.currentTaskId } : {}),
  }))
  const tasks: ArchiveTask[] = Object.values(team.tasks).map((task) => ({
    id: task.id,
    title: task.input.title,
    state: task.state,
    priority: task.input.priority,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    gates: [...task.gates],
    gateVerdicts: { ...task.gateVerdicts },
    evidenceCount: task.evidenceRefs.length,
  }))
  // 交付物清单：账本只存路径引用（FR-10.4），归档把引用原样收进来
  const artifacts: ArchiveArtifact[] = Object.values(team.tasks).flatMap((task) =>
    task.deliverables.map((deliverable) => ({ path: deliverable.path, taskId: task.id, seq: deliverable.seq })),
  )
  return {
    version: ARCHIVE_VERSION,
    teamId: team.teamId,
    name: team.name ?? '',
    goal: team.goal ?? '',
    state: team.state,
    archivedAt,
    archivedBy,
    ledgerPath,
    eventCount,
    revision: team.revision,
    members,
    tasks,
    artifacts,
    tokens,
  }
}

export interface ArchiveWriteResult {
  dir: string
  /** 相对工作区根的归档目录（写进账本 payload，面板据此显示 `archive/<id>/`） */
  relativeDir: string
  files: string[]
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 落盘归档快照（幂等：同团队重复归档整体覆盖）。
 * 返回写出的文件清单（相对归档目录），供账本 payload 与面板展示。
 */
export function writeArchive(workspaceRoot: string, snapshot: ArchiveTeamSnapshot): ArchiveWriteResult {
  const dir = archiveDirOf(workspaceRoot, snapshot.teamId)
  const membersDir = join(dir, 'members')
  const artifactsDir = join(dir, 'artifacts')
  mkdirSync(membersDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })

  const files: string[] = []
  // team.json：不含 tokens（tokens 单独一份，避免 team.json 随时间膨胀）
  const { tokens, ...teamOnly } = snapshot
  writeJson(join(dir, 'team.json'), teamOnly)
  files.push('team.json')
  writeJson(join(dir, 'tokens.json'), tokens)
  files.push('tokens.json')
  for (const member of snapshot.members) {
    writeJson(join(membersDir, `${member.id}.json`), member)
    files.push(`members/${member.id}.json`)
  }
  writeJson(join(artifactsDir, 'artifacts.json'), snapshot.artifacts)
  files.push('artifacts/artifacts.json')
  // MANIFEST 最后写：它是"这份归档完整"的判据（中途崩溃不会留下看似完整的清单）
  writeJson(join(dir, 'MANIFEST.json'), {
    version: snapshot.version,
    teamId: snapshot.teamId,
    archivedAt: snapshot.archivedAt,
    archivedBy: snapshot.archivedBy,
    ledgerPath: snapshot.ledgerPath,
    eventCount: snapshot.eventCount,
    files: [...files],
  })
  files.push('MANIFEST.json')
  return { dir, relativeDir: `${'.team-workplace/archive'}/${snapshot.teamId}`, files }
}

/**
 * 读归档快照（只读）。`MANIFEST.json` 缺失视为未归档（宁可报空，不猜半个快照）。
 * tokens 单独读回并挂上，结构与 `buildArchiveSnapshot` 的输出对称。
 */
export function readArchive(workspaceRoot: string, teamId: string): ArchiveTeamSnapshot | null {
  const dir = archiveDirOf(workspaceRoot, teamId)
  const teamPath = join(dir, 'team.json')
  const manifestPath = join(dir, 'MANIFEST.json')
  if (!existsSync(teamPath) || !existsSync(manifestPath)) return null
  try {
    const teamOnly = JSON.parse(readFileSync(teamPath, 'utf8')) as Omit<ArchiveTeamSnapshot, 'tokens'>
    const tokensPath = join(dir, 'tokens.json')
    const tokens = existsSync(tokensPath)
      ? (JSON.parse(readFileSync(tokensPath, 'utf8')) as TokensFile)
      : { version: 1 as const, teamId, updatedAt: 0, days: {}, totals: {}, note: '' }
    return { ...teamOnly, tokens }
  } catch {
    // 坏归档（手工改坏/写一半）：不抛，返回 null 让面板显示"归档不可读"
    return null
  }
}

/** 列出已归档团队 id（面板「全部团队」入口的数据源；只读目录名，不解析内容） */
export function listArchives(workspaceRoot: string): string[] {
  const root = archiveRootOf(workspaceRoot)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}
