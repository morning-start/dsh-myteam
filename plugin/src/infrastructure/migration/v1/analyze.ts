/**
 * v1 旧布局的**只读**分析（一次性迁移的前半段）。
 *
 * 这里不写任何文件、不生成 v2 事件、不启动 Effect。输入的三种旧布局：
 *
 *   `.team-workplace/`
 *   `.dsh-myteam/tasks/<teamId>/ledger.jsonl`
 *   `.dsh-myteam/state/teams/<teamId>/ledger.jsonl`
 *
 * 分析结论分两类：
 *   - blocking：无法证明数据完整（未知事件、序号断裂、manifest 不可读），阻断 cutover；
 *   - warning：可以继续，但必须由用户确认影响面（索引孤儿、重复规则事件）。
 *
 * 「索引里有、账本里没有」的团队**不会**被建成 active 团队：那等于伪造历史。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LegacyOrigin } from '../../../contracts/entities.ts'
import { hashContent } from '../../../contracts/json.ts'

/** v1 账本事件类型全集（来自 v1 `core/ledger/ledger.ts`）。 */
export const V1_EVENT_TYPES: readonly string[] = [
  'team.created',
  'plan.clarify',
  'plan.staged',
  'plan.revised',
  'plan.approved',
  'plan.discarded',
  'member.spawned',
  'member.released',
  'member.archived',
  'member.restored',
  'member.interrupted',
  'task.created',
  'task.claimed',
  'task.assigned',
  'task.attempt.revoked',
  'task.progress',
  'task.evidence',
  'task.completed',
  'task.failed',
  'task.blocked',
  'task.paused',
  'task.escalated',
  'task.rescoped',
  'task.updated',
  'task.cancelled',
  'task.deleted',
  'task.rewired',
  'team.updated',
  'task.proposal',
  'task.proposal.resolved',
  'task.deliverable',
  'task.gate.result',
  'task.participate',
  'task.participation.released',
  'message.sent',
  'message.consumed',
  'knowledge.proposed',
  'knowledge.adopted',
  'knowledge.revised',
  'session.read',
  'memory.audit',
  'rules.version.adopted',
  'team.disbanded',
]

const RULES_EVENT = 'rules.version.adopted'

export interface V1LedgerEvent {
  seq: number
  ts: number
  actor: string
  type: string
  payload: Record<string, unknown>
  sourceLine: number
}

export type V1SourceKind = 'state-teams' | 'tasks' | 'team-workplace'

export interface V1TeamSource {
  teamId: string
  kind: V1SourceKind
  path: string
  lineCount: number
  events: V1LedgerEvent[]
  /** 该文件全部事件的规范化 hash，迁移后用于逐项对账。 */
  sourceHash: string
  /** 该文件里出现过的未知事件类型（空表示全部可识别）。 */
  unknownTypes: string[]
}

export interface V1IndexTeam {
  teamId: string
  name: string
  state: string
  goal: string
  counts: Record<string, number>
}

export interface V1Issue {
  code: 'MISSING_MANIFEST' | 'MISSING_INDEX' | 'INDEX_ORPHAN' | 'UNKNOWN_EVENT' | 'SEQ_GAP' | 'BAD_LINE' | 'DUPLICATE_RULES' | 'UNKNOWN_LAYOUT'
  severity: 'blocking' | 'warning'
  message: string
  detail?: Record<string, unknown>
}

export interface V1Analysis {
  rootDir: string
  manifest: { schemaVersion: number; layoutVersion: number; projectName: string } | null
  index: V1IndexTeam[]
  sources: V1TeamSource[]
  /** 索引里有、但没有账本的团队：只报告，不迁移。 */
  indexOnly: V1IndexTeam[]
  /** 有账本、但索引里没有的团队。 */
  ledgerOnly: { teamId: string; kinds: V1SourceKind[] }[]
  eventsByType: Record<string, number>
  issues: V1Issue[]
  /** 没有 blocking 问题才能进入候选导入。 */
  readyToImport: boolean
  /** 即使可导入，也需要用户确认影响面（有 warning 时为 true）。 */
  requiresUserConfirmation: boolean
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ParseResult {
  events: V1LedgerEvent[]
  unknownTypes: string[]
  issues: V1Issue[]
  lineCount: number
}

/**
 * 逐行解析旧账本。
 *
 * 旧账本的序号语义是「文件内从 0 连续递增」。序号断裂意味着历史被改过或
 * 写入中断，不能靠「跳过这一行」蒙混过去——那会让之后的投影与旧系统不一致。
 */
export function parseV1Ledger(text: string, sourceName: string): ParseResult {
  const events: V1LedgerEvent[] = []
  const unknownTypes = new Set<string>()
  const issues: V1Issue[] = []
  const lines = text.split('\n')
  let expectedSeq = 0
  let lastTs = Number.NEGATIVE_INFINITY

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim()
    if (raw.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      issues.push({
        code: 'BAD_LINE',
        severity: 'blocking',
        message: `${sourceName} 第 ${index + 1} 行不是合法 JSON`,
        detail: { source: sourceName, line: index + 1 },
      })
      continue
    }
    if (!isPlainObject(parsed)) {
      issues.push({ code: 'BAD_LINE', severity: 'blocking', message: `${sourceName} 第 ${index + 1} 行不是对象` })
      continue
    }

    const seq = asNumber(parsed.seq)
    const ts = asNumber(parsed.ts)
    const actor = asString(parsed.actor)
    const type = asString(parsed.type)
    const payload = parsed.payload

    if (seq === null || ts === null || actor === null || type === null || !isPlainObject(payload)) {
      issues.push({
        code: 'BAD_LINE',
        severity: 'blocking',
        message: `${sourceName} 第 ${index + 1} 行缺少 seq/ts/actor/type/payload`,
        detail: { source: sourceName, line: index + 1 },
      })
      continue
    }
    if (seq !== expectedSeq) {
      issues.push({
        code: 'SEQ_GAP',
        severity: 'blocking',
        message: `${sourceName} 序号不连续：期望 ${expectedSeq}，实际 ${seq}`,
        detail: { source: sourceName, line: index + 1, expectedSeq, seq },
      })
    }
    if (ts < lastTs) {
      issues.push({
        code: 'BAD_LINE',
        severity: 'blocking',
        message: `${sourceName} 时间戳倒退：第 ${index + 1} 行 ${ts} < ${lastTs}`,
        detail: { source: sourceName, line: index + 1 },
      })
    }
    expectedSeq = seq + 1
    lastTs = ts

    if (!V1_EVENT_TYPES.includes(type)) unknownTypes.add(type)

    events.push({ seq, ts, actor, type, payload, sourceLine: index + 1 })
  }

  for (const type of unknownTypes) {
    issues.push({
      code: 'UNKNOWN_EVENT',
      severity: 'blocking',
      message: `${sourceName} 含未知事件类型 ${type}，无法确定如何迁移`,
      detail: { source: sourceName, type },
    })
  }

  const rulesEvents = events.filter((event) => event.type === RULES_EVENT)
  if (rulesEvents.length > 1) {
    issues.push({
      code: 'DUPLICATE_RULES',
      severity: 'warning',
      message: `${sourceName} 含 ${rulesEvents.length} 条规则版本事件，将保留原行并只初始化一次`,
      detail: { source: sourceName, count: rulesEvents.length },
    })
  }

  return { events, unknownTypes: [...unknownTypes], issues, lineCount: lines.filter((line) => line.trim().length > 0).length }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 分析一个工作区里的 v1 数据。
 *
 * 只读：不创建、不删除、不迁移。返回的结构可直接渲染成给用户的「影响面预览」。
 */
export function analyzeV1Project(rootDir: string): V1Analysis {
  const issues: V1Issue[] = []
  const workspace = join(rootDir, '.dsh-myteam')
  const manifestPath = join(workspace, 'manifest.json')
  const indexPath = join(workspace, 'state', 'teams.json')

  let manifest: V1Analysis['manifest'] = null
  if (existsSync(manifestPath)) {
    try {
      const parsed = readJsonFile(manifestPath)
      if (isPlainObject(parsed)) {
        manifest = {
          schemaVersion: asNumber(parsed.schemaVersion) ?? 0,
          layoutVersion: asNumber(parsed.layoutVersion) ?? 0,
          projectName: asString(parsed.projectName) ?? '',
        }
      }
    } catch {
      issues.push({ code: 'MISSING_MANIFEST', severity: 'blocking', message: 'manifest.json 无法解析' })
    }
  } else {
    issues.push({ code: 'MISSING_MANIFEST', severity: 'blocking', message: '缺少 .dsh-myteam/manifest.json，无法证明旧布局版本' })
  }
  if (manifest !== null && manifest.layoutVersion !== 1) {
    issues.push({
      code: 'UNKNOWN_LAYOUT',
      severity: 'blocking',
      message: `旧布局版本为 ${manifest.layoutVersion}，迁移器只认识 v1`,
    })
  }

  let index: V1IndexTeam[] = []
  if (existsSync(indexPath)) {
    try {
      const parsed = readJsonFile(indexPath)
      if (isPlainObject(parsed) && Array.isArray(parsed.teams)) {
        index = parsed.teams.filter(isPlainObject).map((team) => ({
          teamId: asString(team.teamId) ?? '(unknown)',
          name: asString(team.name) ?? '',
          state: asString(team.state) ?? '',
          goal: asString(team.goal) ?? '',
          counts: isPlainObject(team.counts) ? (team.counts as Record<string, number>) : {},
        }))
      }
    } catch {
      issues.push({ code: 'MISSING_INDEX', severity: 'blocking', message: 'state/teams.json 无法解析' })
    }
  } else {
    issues.push({ code: 'MISSING_INDEX', severity: 'warning', message: '缺少 state/teams.json，将只按账本目录发现团队' })
  }

  const sources: V1TeamSource[] = []
  const collect = (baseDir: string, kind: V1SourceKind) => {
    for (const teamId of listDir(baseDir)) {
      const ledgerPath = join(baseDir, teamId, 'ledger.jsonl')
      if (!existsSync(ledgerPath)) continue
      const parsed = parseV1Ledger(readFileSync(ledgerPath, 'utf8'), `${kind}/${teamId}/ledger.jsonl`)
      issues.push(...parsed.issues)
      sources.push({
        teamId,
        kind,
        path: ledgerPath,
        lineCount: parsed.lineCount,
        events: parsed.events,
        sourceHash: hashContent(parsed.events.map((event) => ({ seq: event.seq, ts: event.ts, actor: event.actor, type: event.type, payload: event.payload }))),
        unknownTypes: parsed.unknownTypes,
      })
    }
  }

  collect(join(workspace, 'state', 'teams'), 'state-teams')
  collect(join(workspace, 'tasks'), 'tasks')

  const workplace = join(rootDir, '.team-workplace')
  if (isDirectory(workplace)) {
    collect(workplace, 'team-workplace')
  }

  const ledgerTeamIds = new Set(sources.map((source) => source.teamId))
  const indexOnly = index.filter((team) => !ledgerTeamIds.has(team.teamId))
  for (const team of indexOnly) {
    issues.push({
      code: 'INDEX_ORPHAN',
      severity: 'warning',
      message: `索引里的团队 ${team.teamId}（${team.name || '未命名'}）没有账本，不会迁移为 active 团队`,
      detail: { teamId: team.teamId, state: team.state, counts: team.counts },
    })
  }

  const ledgerOnly = [...ledgerTeamIds]
    .filter((teamId) => !index.some((team) => team.teamId === teamId))
    .map((teamId) => ({ teamId, kinds: sources.filter((source) => source.teamId === teamId).map((source) => source.kind) }))
  for (const item of ledgerOnly) {
    issues.push({
      code: 'MISSING_INDEX',
      severity: 'warning',
      message: `账本里的团队 ${item.teamId} 不在索引中，将按账本迁移并记录来源`,
      detail: item,
    })
  }

  const eventsByType: Record<string, number> = {}
  for (const source of sources) {
    for (const event of source.events) {
      eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1
    }
  }

  const blocking = issues.some((issue) => issue.severity === 'blocking')
  return {
    rootDir,
    manifest,
    index,
    sources,
    indexOnly,
    ledgerOnly,
    eventsByType,
    issues,
    readyToImport: !blocking,
    requiresUserConfirmation: issues.length > 0,
  }
}

export interface PlannedV1Event {
  order: number
  teamId: string
  kind: V1SourceKind
  event: V1LedgerEvent
  legacyOrigin: LegacyOrigin
}

export interface V1ImportPlan {
  events: PlannedV1Event[]
  /** 多团队合并时的合成顺序说明：旧账本没有跨团队全序，这是迁移构造的顺序。 */
  syntheticOrder: boolean
  sourceHashes: { teamId: string; kind: V1SourceKind; sourceHash: string }[]
}

/**
 * 生成候选导入顺序（不写存储）。
 *
 * 旧账本每个团队各自从 seq=0 开始，没有跨团队全序。这里按
 * `(ts, teamId, seq, sourceLine)` 排序并标记 `syntheticOrder`：迁移后的事件
 * 顺序是**构造**出来的，必须在 legacy 元数据里如实说明，不能冒充原始全序。
 */
export function planV1Import(analysis: V1Analysis): V1ImportPlan {
  if (!analysis.readyToImport) {
    throw new Error('存在阻断问题，不能生成导入计划')
  }

  const rows: Omit<PlannedV1Event, 'order'>[] = []
  for (const source of analysis.sources) {
    for (const event of source.events) {
      rows.push({
        teamId: source.teamId,
        kind: source.kind,
        event,
        legacyOrigin: {
          source: source.kind === 'state-teams' ? 'ledger-state-teams' : source.kind === 'tasks' ? 'ledger-tasks' : 'team-workplace',
          teamId: source.teamId,
          sourceLine: event.sourceLine,
          sourceSeq: event.seq,
          sourceTs: new Date(event.ts).toISOString(),
          sourceHash: source.sourceHash,
          syntheticOrder: analysis.sources.length > 1,
          unknownConfigRevision: true,
        },
      })
    }
  }

  rows.sort((left, right) => {
    if (left.event.ts !== right.event.ts) return left.event.ts - right.event.ts
    if (left.teamId !== right.teamId) return left.teamId < right.teamId ? -1 : 1
    if (left.event.seq !== right.event.seq) return left.event.seq - right.event.seq
    return left.event.sourceLine - right.event.sourceLine
  })

  return {
    events: rows.map((row, order) => ({ ...row, order })),
    syntheticOrder: analysis.sources.length > 1,
    sourceHashes: analysis.sources.map((source) => ({ teamId: source.teamId, kind: source.kind, sourceHash: source.sourceHash })),
  }
}