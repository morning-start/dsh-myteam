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
  blockedBy: string[]
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
    config: state.teamConfigs.get(teamId) ?? null,
  }
}