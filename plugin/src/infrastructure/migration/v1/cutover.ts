/**
 * cutover 计划（离线、只读）。
 *
 * 它不执行切换，只回答三个问题：
 *   1. 现在能不能切？（候选完整、源未变、没有未确认的异常）
 *   2. 切的时候按什么顺序做？（停旧写 → 增量重析 → 备份 → 切换 → 首次打开验证 → 留报告）
 *   3. 切完之后还能不能回滚？（有边界，且只能向前导出修复）
 *
 * 「能不能切」里刻意包含**源 hash 未变**：分析之后旧账本又写了新事件，候选
 * 就是过期的。这时候切换会丢掉最后一次写入，属于不可恢复的数据损失。
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { EVENTS_FILE } from '../../../contracts/versions.ts'
import { rebuildProjectState } from '../../../application/projections/project-state.ts'
import { FileEventStore } from '../../event-store/file-store.ts'
import { readProjectManifest } from '../../fs/project-manifest.ts'
import type { V1Analysis } from './analyze.ts'
import type { CandidateWriteResult } from './convert.ts'

export interface CandidateInspection {
  ok: boolean
  projectId: string | null
  events: number
  seq: number
  teams: number
  members: number
  tasks: number
  knowledge: number
  problems: string[]
}

/** 从磁盘检查候选项目（不信调用方传进来的内存结果）。 */
export function inspectCandidate(candidateRoot: string): CandidateInspection {
  const problems: string[] = []
  let manifest
  try {
    manifest = readProjectManifest(candidateRoot)
  } catch (error) {
    return {
      ok: false,
      projectId: null,
      events: 0,
      seq: 0,
      teams: 0,
      members: 0,
      tasks: 0,
      knowledge: 0,
      problems: [error instanceof Error ? error.message : String(error)],
    }
  }
  if (manifest === null) {
    return {
      ok: false,
      projectId: null,
      events: 0,
      seq: 0,
      teams: 0,
      members: 0,
      tasks: 0,
      knowledge: 0,
      problems: ['候选目录缺少 manifest.json'],
    }
  }

  try {
    const store = new FileEventStore(join(candidateRoot, EVENTS_FILE))
    const { events } = store.readCommitted()
    const rebuilt = rebuildProjectState(manifest.projectId, events)
    if (events.length === 0) problems.push('候选事件日志为空')
    if (rebuilt.seq !== events[events.length - 1]?.projectSeq) {
      problems.push('候选投影 seq 与日志尾部不一致')
    }
    return {
      ok: problems.length === 0,
      projectId: manifest.projectId,
      events: events.length,
      seq: rebuilt.seq,
      teams: rebuilt.teams.size,
      members: rebuilt.members.size,
      tasks: rebuilt.tasks.size,
      knowledge: rebuilt.knowledge.size,
      problems,
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    return {
      ok: false,
      projectId: manifest.projectId,
      events: 0,
      seq: 0,
      teams: 0,
      members: 0,
      tasks: 0,
      knowledge: 0,
      problems,
    }
  }
}

export interface CutoverStep {
  id: string
  title: string
  detail: string
}

/**
 * 候选里记录的来源 hash 集合。
 *
 * 用来证明「候选还是基于当前旧数据生成的」：分析与候选生成之间旧账本又写了
 * 事件时，来源 hash 会变，这里就对不上，切换必须中止并重新生成候选。
 */
export function candidateSourceHashes(candidateRoot: string): { teamId: string; sourceHash: string }[] {
  // 优先读迁移证据文件：rules-only 的候选没有带 legacy 的事件。
  try {
    const raw = readFileSync(join(candidateRoot, '.dsh-myteam', 'migration.json'), 'utf8')
    const parsed = JSON.parse(raw) as { sourceHashes?: unknown }
    if (Array.isArray(parsed.sourceHashes)) {
      return parsed.sourceHashes
        .filter(
          (item): item is { teamId: string; sourceHash: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { teamId?: unknown }).teamId === 'string' &&
            typeof (item as { sourceHash?: unknown }).sourceHash === 'string',
        )
        .map((item) => ({ teamId: item.teamId, sourceHash: item.sourceHash }))
    }
  } catch {
    // 没有证据文件时回退到事件里的 legacy（旧候选兼容）。
  }

  const store = new FileEventStore(join(candidateRoot, EVENTS_FILE))
  const { events } = store.readCommitted()
  const seen = new Map<string, { teamId: string; sourceHash: string }>()
  for (const event of events) {
    const legacy = event.legacy
    if (legacy?.teamId === undefined || legacy.sourceHash === undefined) continue
    const key = `${legacy.teamId}:${legacy.source}` 
    if (!seen.has(key)) seen.set(key, { teamId: legacy.teamId, sourceHash: legacy.sourceHash })
  }
  return [...seen.values()]
}

/** 当前分析与候选记录是否一致（源未在分析后变化）。 */
export function sourceMatchesCandidate(analysis: V1Analysis, candidateRoot: string): boolean {
  const recorded = new Set(candidateSourceHashes(candidateRoot).map((item) => `${item.teamId}:${item.sourceHash}`))
  return analysis.sources.every((source) => recorded.has(`${source.teamId}:${source.sourceHash}`))
}

export interface CutoverPlan {
  ready: boolean
  blockers: string[]
  /** 需要用户逐项确认的影响面（索引孤儿、重复规则等）。 */
  requiresConfirmation: string[]
  steps: CutoverStep[]
  rollback: { allowedBeforeNewWrites: boolean; afterBoundary: string }
}

export interface CutoverInput {
  analysis: V1Analysis
  candidate: CandidateWriteResult
  candidateInspection: CandidateInspection
  /** 分析之后源账本的 hash 是否仍然一致（由调用方比对）。 */
  sourceUnchanged: boolean
}

/**
 * 生成切换计划。
 *
 * 阻断项全部来自可以证明的事实：分析阻断、候选对账失败、候选事件缺失、
 * 源在分析后又变化。任何一条成立都不输出「可切换」。
 */
export function planCutover(input: CutoverInput): CutoverPlan {
  const blockers: string[] = []

  if (!input.analysis.readyToImport) {
    blockers.push('旧数据分析仍有阻断问题')
  }
  if (!input.candidate.verification.ok) {
    blockers.push(`候选项目对账失败：${input.candidate.verification.problems.join('；')}`)
  }
  if (!input.candidateInspection.ok) {
    blockers.push(`候选项目从磁盘检查失败：${input.candidateInspection.problems.join('；')}`)
  }
  if (input.candidateInspection.projectId !== input.candidate.projectId) {
    blockers.push('候选项目落盘后的 projectId 与写入结果不一致')
  }
  if (input.candidateInspection.events !== input.candidate.written) {
    blockers.push(`候选事件数不一致：磁盘 ${input.candidateInspection.events}，写入报告 ${input.candidate.written}`)
  }
  if (!input.sourceUnchanged) {
    blockers.push('分析之后旧账本又发生了变化，候选已过期；必须重新分析并重新生成候选')
  }

  const requiresConfirmation = input.analysis.issues
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => `${issue.code}：${issue.message}`)

  const steps: CutoverStep[] = [
    {
      id: 'stop-old-writer',
      title: '停止旧写者',
      detail: '确认没有 old runtime 在写旧账本（写者租约/进程），并让用户确认此刻开始不再产生旧数据。',
    },
    {
      id: 're-analyze',
      title: '增量重析',
      detail: '对旧账本重新计算来源 hash；与候选记录的 sourceHash 全量比对，任何差异都中止切换。',
    },
    {
      id: 'backup-old',
      title: '备份旧数据',
      detail: '把 .dsh-myteam 与 .team-workplace 复制为独立只读备份（不随文档删除，需用户另行确认才清理）。',
    },
    {
      id: 'switch',
      title: '切换为候选项目',
      detail: '把候选目录的 manifest 与 events 放到项目根；不合并、不重写旧账本。',
    },
    {
      id: 'first-open',
      title: '首次打开验证',
      detail: '用 v2 打开项目：投影重建成功、seq 连续、团队/成员/任务/知识计数与候选报告一致。',
    },
    {
      id: 'report',
      title: '留 cutover 报告',
      detail: '记录 projectId、来源 hash、跳过事件计数、索引孤儿与用户确认记录；作为后续验收证据。',
    },
  ]

  return {
    ready: blockers.length === 0,
    blockers,
    requiresConfirmation,
    steps,
    rollback: {
      allowedBeforeNewWrites: true,
      afterBoundary:
        'v2 产生第一次写入后不做自动反向回滚：只能把 v2 数据导出修复，或由管理员显式切回旧数据并接受这段新写入丢失。',
    },
  }
}