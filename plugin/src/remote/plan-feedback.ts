/**
 * CHG-119（FR-11.6）：**计划质量反馈视图**——只读观测，不自动改计划。
 *
 * 需求原文：「计划视图：任务数 / 粒度分布 / 角色负载预估；M2 加 estimate vs 实际对比——
 * 先可观测不自动改」。
 *
 * 口径（必须诚实标注，不能当成精确值）：
 *  - `estimate` 是队长填的**主观体量**（S/M/L），不是工时；
 *  - `actualMs` 是**账本时间差**：终态任务 = 终态事件 ts − `task.created` ts；未终态 = now − 创建
 *    （标 `running:true`，说明它还在长）；
 *  - 「超时」是**桶比较**（实际桶 > 估算桶），桶阈值写死在这里（4h / 24h / 72h），
 *    只是可观测信号，不改计划、不降级、不自动重排。
 *
 * 纯函数：不读盘、不写账本、不依赖宿主；坏事件（缺 taskId / ts 非数）容错跳过。
 */
import type { TeamProjection } from '../core/scheduler/state.ts'

const HOUR = 3_600_000

/** 估算桶 → 小时阈值（**可观测口径**，不是排期承诺） */
export const ESTIMATE_HOURS = { S: 4, M: 24, L: 72 } as const
export type EstimateBucket = keyof typeof ESTIMATE_HOURS

/** 实际耗时（ms）→ 桶：≤4h=S、≤24h=M、其余=L */
export function bucketOfMs(ms: number): EstimateBucket {
  if (!Number.isFinite(ms) || ms <= 0) return 'S'
  if (ms <= ESTIMATE_HOURS.S * HOUR) return 'S'
  if (ms <= ESTIMATE_HOURS.M * HOUR) return 'M'
  return 'L'
}

/** 桶序（比较「实际桶 > 估算桶」必须用序，不能比字符串） */
const BUCKET_RANK: Record<EstimateBucket, number> = { S: 0, M: 1, L: 2 }

export interface PlanFeedbackTaskView {
  id: string
  title: string
  state: string
  /** 队长填的体量；未填 = null（不参与可比较统计） */
  estimate: EstimateBucket | null
  /** 账本时间差（ms）；未终态 = now − created */
  actualMs: number
  /** true = 还没终态（actualMs 仍在增长） */
  running: boolean
  /** 实际耗时落在哪个桶 */
  actualBucket: EstimateBucket
  /** 实际桶 > 估算桶（只对有 estimate 的任务有意义） */
  overrun: boolean
}

export interface PlanFeedbackView {
  teamId: string
  /** 口径标注：estimate 是主观体量，actual 是账本时间差 */
  caliber: 'heuristic'
  generatedAt: number
  tasks: {
    total: number
    terminal: number
    open: number
    /** 状态 → 数量（只列出现过的状态） */
    byState: Record<string, number>
  }
  /** 粒度分布（estimate 缺省单列，不并进 S） */
  granularity: { S: number; M: number; L: number; unset: number }
  /** 角色负载预估：计划中的任务数 vs 在册成员数（> 1 说明这个角色是瓶颈） */
  roleLoad: { roleId: string; planned: number; open: number; members: number }[]
  /** estimate vs 实际（只列有 estimate 的任务，按超时倍数降序） */
  deviations: PlanFeedbackTaskView[]
  /** 超时任务数 / 可比较任务数 */
  overrun: { over: number; comparable: number }
  /** 给用户看的口径说明（逐条都是解释，不是警告） */
  notes: string[]
}

interface LedgerEventLike {
  type: string
  ts: number
  payload?: Record<string, unknown>
}

const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled'])

/**
 * 纯函数入口。
 *
 * @param proj 团队投影（任务 / 成员 / 状态）
 * @param events 该团队账本事件（只用来找终态时刻；缺事件时退化为「未终态」）
 * @param now 当前时刻（测试注入，默认 Date.now()）
 */
export function buildPlanFeedback(proj: TeamProjection, events: readonly LedgerEventLike[] = [], now = Date.now()): PlanFeedbackView {
  /* 终态时刻：取该任务最早的一条终态事件（completed / failed / cancelled） */
  const terminalTs = new Map<string, number>()
  for (const event of events) {
    const type = String(event?.type ?? '')
    if (type !== 'task.completed' && type !== 'task.failed' && type !== 'task.cancelled') continue
    const taskId = String((event.payload as Record<string, unknown> | undefined)?.taskId ?? '')
    const ts = Number(event?.ts)
    if (!taskId || !Number.isFinite(ts)) continue
    const prev = terminalTs.get(taskId)
    if (prev === undefined || ts < prev) terminalTs.set(taskId, ts)
  }

  const tasks = Object.values(proj.tasks ?? {})
  const byState: Record<string, number> = {}
  const granularity = { S: 0, M: 0, L: 0, unset: 0 }
  const roleLoad = new Map<string, { planned: number; open: number }>()
  const deviations: PlanFeedbackTaskView[] = []
  let terminal = 0
  let over = 0
  let comparable = 0

  for (const task of tasks) {
    const state = String(task.state)
    byState[state] = (byState[state] ?? 0) + 1
    const isTerminal = TERMINAL_STATES.has(state)
    if (isTerminal) terminal += 1

    /* 角色负载：主责角色（requiredRole）是计划侧的口径 */
    const roleId = String(task.input?.requiredRole ?? '')
    if (roleId) {
      const bucket = roleLoad.get(roleId) ?? { planned: 0, open: 0 }
      bucket.planned += 1
      if (!isTerminal) bucket.open += 1
      roleLoad.set(roleId, bucket)
    }

    const rawEstimate = String(task.input?.estimate ?? '')
    const estimate = rawEstimate === 'S' || rawEstimate === 'M' || rawEstimate === 'L' ? (rawEstimate as EstimateBucket) : null
    if (estimate) granularity[estimate] += 1
    else granularity.unset += 1

    const createdAt = Number(task.createdAt)
    if (!Number.isFinite(createdAt)) continue
    /* 终态时刻：优先终态事件；没有事件（旧账本/坏行）退化为 cancelledAt，再退化 now（不丢任务） */
    const terminalAt = terminalTs.get(task.id) ?? (Number.isFinite(Number(task.cancelledAt)) ? Number(task.cancelledAt) : now)
    const end = isTerminal ? terminalAt : now
    if (!Number.isFinite(end)) continue
    const actualMs = Math.max(0, Number(end) - createdAt)
    const actualBucket = bucketOfMs(actualMs)
    /* 超时只对**终态**任务判定：未终态任务的耗时会继续增长，把它算进超时比会误导 */
    const overrun = isTerminal && estimate !== null && BUCKET_RANK[actualBucket] > BUCKET_RANK[estimate]
    /* 排序用：实际桶序 / 估算桶序 */
    if (estimate !== null) {
      comparable += 1
      if (overrun) over += 1
    }
    deviations.push({ id: task.id, title: String(task.input?.title ?? task.id), state, estimate, actualMs, running: !isTerminal, actualBucket, overrun })
  }

  deviations.sort((a, b) => {
    const ratio = (view: PlanFeedbackTaskView) => (view.estimate ? ESTIMATE_HOURS[view.actualBucket] / ESTIMATE_HOURS[view.estimate] : 0)
    return ratio(b) - ratio(a) || b.actualMs - a.actualMs
  })

  const members = Object.values(proj.members ?? {})
  const roleRows = [...roleLoad.entries()]
    .map(([roleId, counts]) => ({
      roleId,
      planned: counts.planned,
      open: counts.open,
      members: members.filter((member) => String(member.roleId) === roleId && (member.status === 'active' || member.status === 'suspended')).length,
    }))
    .sort((a, b) => b.planned - a.planned || a.roleId.localeCompare(b.roleId))

  const notes: string[] = [
    '口径：estimate 是队长填的体量（S/M/L），actual 是账本时间差（创建 → 终态事件）；未终态的任务实际耗时会继续增长。',
    '桶阈值：≤4h=S、≤24h=M、其余=L。「超时」只在**终态**任务上判定（实际桶 > 估算桶）——未终态任务的耗时会继续增长，算进去会误导；这只是可观测信号，不自动改计划、不自动重排。',
    '只统计本团队账本；跨团队协作任务不计入本团队的负载。',
  ]
  if (granularity.unset > 0) notes.push(`有 ${granularity.unset} 个任务没填体量（estimate），不参与超时统计。`)
  if (roleRows.some((row) => row.members === 0 && row.open > 0)) {
    notes.push('存在「有计划任务但无在册成员」的角色：这些任务暂时没人能领。')
  }

  return {
    teamId: String(proj.teamId ?? ''),
    caliber: 'heuristic',
    generatedAt: now,
    tasks: { total: tasks.length, terminal, open: tasks.length - terminal, byState },
    granularity,
    roleLoad: roleRows,
    deviations,
    overrun: { over, comparable },
    notes,
  }
}
