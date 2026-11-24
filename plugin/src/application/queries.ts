/**
 * 查询：把投影折叠成**一份**视图，面板、工具和测试共用。
 *
 * 这里不重新实现 DAG、状态机或权限——那是领域层的事。查询只做形状整理：
 * 缺失实体如实显示 `null`，不猜、不补默认值；冲突与阻塞原因原样带出，
 * 让 UI 能解释「为什么这个任务做不了」。
 */
import type {
  Attempt,
  EffectiveConfigSnapshot,
  EvidenceRef,
  GateVerdict,
  Task,
  TaskStatus,
  Team,
  WorkflowRun,
} from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ProjectState } from './projections/project-state.ts'

const BOARD_ORDER: readonly TaskStatus[] = [
  'planned',
  'ready',
  'claimed',
  'in_progress',
  'blocked',
  'review',
  'done',
  'cancelled',
]

export interface BoardTask {
  id: string
  title: string
  status: TaskStatus
  ownerTeamId: string | null
  ownerTeamName: string | null
  runId: string | null
  /** 未完成的前置（只用于「被谁卡住」的角标）。 */
  blockedBy: string[]
  /** 全部前置边（含已完成的）：依赖图要用完整边，不能只看 blockedBy。 */
  dependencies: string[]
  attemptId: string | null
  updatedAt: string
}

export interface BoardColumn {
  status: TaskStatus
  count: number
  tasks: BoardTask[]
}

export interface BoardView {
  observedProjectSeq: number
  graphRevision: number
  totals: { all: number; done: number; blocked: number; review: number }
  columns: BoardColumn[]
}

/**
 * 待人类确认的事 + 已处理的历史（`p-approval`）。
 *
 * 设计稿把「待你确认」做成一整页，分**待确认 / 已处理 / 已拒绝**。能撑起这一页的真实数据只有两类：
 *
 *   1. **门禁裁决**：任务停在 `review` 就是在等人下结论；`state.verdicts` 里有已下过的结论。
 *   2. **待确认的全局发布**：`definition.publication.requested` 落了事件但还没 `outcome`。
 *
 * **做不到的**（如实写在这里，不假装有）：
 *   - 「计划批准」：领域里没有 draft/plan 聚合，团队只有 active/archived/disbanded；
 *   - 「队长接管」：它是**当场两段式**（预览签令牌 → 确认），不排队。
 *     事件 `captain.handoff.proposed` 在投影里是 no-op，也没有写入方，所以查不出「谁在等接管」。
 *
 * 所以这一页只画**确实在等人类**的东西；另外两类等域模型补上再说。
 */
export interface PendingApprovalItem {
  /** 用来区分卡片画法。 */
  kind: 'gate' | 'publish'
  id: string
  title: string
  /** 副标题：团队名 / 目标文件。 */
  detail: string | null
  since: string
  by: string | null
}

export interface DecidedApprovalItem {
  kind: 'gate'
  id: string
  title: string
  outcome: string
  decidedAt: string
}

export interface PendingApprovalsView {
  pending: PendingApprovalItem[]
  decided: DecidedApprovalItem[]
  counts: { pending: number; decided: number }
  /** 这一页覆盖不到的两类，明着告诉界面，别让它以为「没有了」。 */
  unsupported: { planApproval: boolean; captainTakeover: boolean }
}

export function pendingApprovalsView(state: ProjectState): PendingApprovalsView {
  const pending: PendingApprovalItem[] = []
  const decided: DecidedApprovalItem[] = []

  // 1) 门禁裁决：任务停在 review = 等人下结论。
  for (const task of state.tasks.values()) {
    if (task.status !== 'review') continue
    // 关键：`task.verdict` **只记录裁决，不改任务状态** —— 下过结论的任务仍停在 review，
    // 要等后续事件（completed / blocked）才离开这一列。不排掉的话，已经裁决过的任务
    // 会一直挂在「待确认」里，人点进去发现没什么可确认的。
    const existingVerdict = state.verdicts.get(task.id)
    if (existingVerdict !== undefined && existingVerdict.attemptId === task.attemptId) continue
    const teamName = task.ownerTeamId === null ? null : (state.teams.get(task.ownerTeamId)?.name ?? null)
    pending.push({
      kind: 'gate',
      id: task.id,
      title: task.title,
      detail: teamName,
      since: task.updatedAt,
      by: null,
    })
  }

  // 2) 待确认的全局发布（投影里 `outcome` 一到就删，所以剩下的都是还在等的）。
  for (const item of state.pendingPublications.values()) {
    pending.push({
      kind: 'publish',
      id: item.operationId,
      title: item.target,
      detail: item.kind,
      since: item.requestedAt,
      by: item.requestedBy,
    })
  }

  // 3) 已处理的：门禁裁决结果（state.verdicts 已经是历史，不会被清）。
  for (const verdict of state.verdicts.values()) {
    const task = state.tasks.get(verdict.taskId)
    decided.push({
      kind: 'gate',
      id: verdict.id,
      title: task === undefined ? verdict.taskId : task.title,
      outcome: verdict.outcome,
      decidedAt: verdict.decidedAt,
    })
  }

  // 新→旧：界面上先看到最近发生的。
  pending.sort((left, right) => (left.since < right.since ? 1 : left.since > right.since ? -1 : 0))
  decided.sort((left, right) => (left.decidedAt < right.decidedAt ? 1 : left.decidedAt > right.decidedAt ? -1 : 0))

  return {
    pending,
    decided,
    counts: { pending: pending.length, decided: decided.length },
    unsupported: { planApproval: true, captainTakeover: true },
  }
}

export function boardView(state: ProjectState): BoardView {
  const byStatus = new Map<TaskStatus, BoardTask[]>()
  for (const status of BOARD_ORDER) byStatus.set(status, [])

  for (const task of state.tasks.values()) {
    const column = byStatus.get(task.status)
    if (column === undefined) continue
    column.push({
      id: task.id,
      title: task.title,
      status: task.status,
      ownerTeamId: task.ownerTeamId,
      ownerTeamName: task.ownerTeamId === null ? null : (state.teams.get(task.ownerTeamId)?.name ?? null),
      runId: task.runId,
      blockedBy: task.dependencies.filter((dependency) => state.tasks.get(dependency)?.status !== 'done'),
      dependencies: [...task.dependencies],
      attemptId: task.attemptId,
      updatedAt: task.updatedAt,
    })
  }

  const columns: BoardColumn[] = BOARD_ORDER.map((status) => {
    const tasks = byStatus.get(status) ?? []
    tasks.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return { status, count: tasks.length, tasks }
  })

  return {
    observedProjectSeq: state.seq,
    graphRevision: state.graphRevision,
    totals: {
      all: state.tasks.size,
      done: byStatus.get('done')?.length ?? 0,
      blocked: byStatus.get('blocked')?.length ?? 0,
      review: byStatus.get('review')?.length ?? 0,
    },
    columns,
  }
}

export interface TaskDetail {
  task: Task
  team: Team | null
  run: WorkflowRun | null
  attempt: Attempt | null
  verdict: GateVerdict | null
  evidence: EvidenceRef[]
  dependencies: { taskId: string; status: TaskStatus | null; title: string | null }[]
  dependents: string[]
}

export function taskDetail(state: ProjectState, taskId: string): TaskDetail {
  const task = state.tasks.get(taskId)
  if (task === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '任务不存在', { details: { taskId } })
  }
  const dependents = [...state.tasks.values()]
    .filter((candidate) => candidate.dependencies.includes(taskId))
    .map((candidate) => candidate.id)

  return {
    task,
    team: task.ownerTeamId === null ? null : (state.teams.get(task.ownerTeamId) ?? null),
    run: task.runId === null ? null : (state.runs.get(task.runId) ?? null),
    attempt: task.attemptId === null ? null : (state.attempts.get(task.attemptId) ?? null),
    verdict: state.verdicts.get(task.id) ?? null,
    evidence: [...(state.evidence.get(task.id) ?? [])],
    dependencies: task.dependencies.map((dependency) => {
      const target = state.tasks.get(dependency)
      return { taskId: dependency, status: target?.status ?? null, title: target?.title ?? null }
    }),
    dependents,
  }
}

export interface TeamView {
  team: Team
  captain: { sessionId: string; generation: number } | null
  members: { id: string; roleId: string; status: string; parentMemberId: string | null }[]
  tasks: { id: string; title: string; status: TaskStatus }[]
  /** 项目级可用角色，供队长挑 roleId 聘人。 */
  roles: { id: string; name: string }[]
  config: EffectiveConfigSnapshot | null
}

export function teamView(state: ProjectState, teamId: string): TeamView {
  const team = state.teams.get(teamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId } })
  }
  const captain = state.captains.get(teamId)
  return {
    team,
    captain: captain === undefined ? null : { sessionId: captain.sessionId, generation: captain.generation },
    members: [...state.members.values()]
      .filter((member) => member.teamId === teamId)
      .map((member) => ({
        id: member.id,
        roleId: member.roleId,
        status: member.status,
        parentMemberId: member.parentMemberId,
      })),
    tasks: [...state.tasks.values()]
      .filter((task) => task.ownerTeamId === teamId)
      .map((task) => ({ id: task.id, title: task.title, status: task.status })),
    roles: [...state.roles.values()].map((role) => ({ id: role.id, name: role.profile.name })),
    config: state.teamConfigs.get(teamId) ?? null,
  }
}