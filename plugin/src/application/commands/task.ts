/**
 * 任务用例：建任务、认领任务，以及只读的任务图派生。
 *
 * 任务的依赖与等级校验都在 domain/tasks；这里只负责把意图翻成事件，
 * 并复用统一 Task DAG（不另建任务引擎）。由 {@link ../commands.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { authorize } from '../../domain/permissions/policy.ts'
import { cycleIfEdgesChanged, graphOf } from '../../domain/tasks/dag.ts'
import { assertCurrentAttempt, createPlannedTask, isClaimable, nextAttemptGeneration } from '../../domain/tasks/task.ts'
import { assertMemberActive } from '../../domain/teams/member.ts'
import { assertGraphRevision, assertTeamActive } from '../../domain/teams/team.ts'
import type { Attempt, Task } from '../../contracts/entities.ts'
import type { ActorRef } from '../../contracts/events.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from '../project-runtime.ts'

export function createTaskCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    title: string
    description: string
    acceptance: string[]
    ownerTeamId: string
    dependencies?: string[]
    requiredRoleId?: string | null
    gate?: { commands: string[]; requireEvidence: boolean; requireArtifacts: boolean }
    deliverable?: { paths: string[]; description: string } | null
  },
): CommitResult {
  authorize('task.create', input.actor, { teamId: input.ownerTeamId })
  const state = runtime.state
  const team = state.teams.get(input.ownerTeamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '主责团队不存在', { details: { teamId: input.ownerTeamId } })
  }
  assertTeamActive(team)

  const dependencies = [...new Set(input.dependencies ?? [])]
  for (const dependency of dependencies) {
    if (!state.tasks.has(dependency)) {
      fail(ERROR_CODES.NOT_FOUND, '依赖的任务不存在', { details: { taskId: dependency } })
    }
  }

  const taskId = runtime.nextId('task')
  const graph = graphOf([...state.tasks.values()].map((task) => [task.id, task.dependencies] as const))
  const cycle = cycleIfEdgesChanged(graph, taskId, dependencies)
  if (cycle !== null) {
    fail(ERROR_CODES.DEPENDENCY_CYCLE, '这次依赖会把任务图接成环', { details: { cycle } })
  }

  const now = runtime.now()
  const task = createPlannedTask({
    id: taskId,
    title: input.title,
    description: input.description,
    acceptance: input.acceptance,
    ownerTeamId: input.ownerTeamId,
    dependencies,
    requiredRoleId: input.requiredRoleId ?? null,
    gate: input.gate ?? { commands: [], requireEvidence: true, requireArtifacts: false },
    deliverable: input.deliverable ?? null,
    now,
  })
  // 没有依赖的任务在创建时就可以被认领；有依赖的先保持 planned。
  if (dependencies.length === 0) task.status = 'ready'

  const draft: DraftEvent = {
    type: 'task.created',
    actor: input.actor,
    entity: { kind: 'task', id: taskId, teamId: input.ownerTeamId },
    entityRevision: 1,
    configRevision: team.configRevision,
    payload: { task, graphRevision: state.graphRevision + 1 },
  }
  return runtime.commit([draft])
}

export function claimTaskCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    taskId: string
    memberId: string
    expectedGraphRevision?: number
  },
): CommitResult {
  const state = runtime.state
  const task = state.tasks.get(input.taskId)
  if (task === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '任务不存在', { details: { taskId: input.taskId } })
  }
  authorize('task.claim', input.actor, {
    teamId: task.ownerTeamId ?? undefined,
    memberId: input.memberId,
    attemptMemberId: input.memberId,
  })

  const team = task.ownerTeamId === null ? undefined : state.teams.get(task.ownerTeamId)
  if (input.expectedGraphRevision !== undefined) {
    assertGraphRevision(state.graphRevision, input.expectedGraphRevision)
  }
  if (!isClaimable(task.status)) {
    fail(ERROR_CODES.TASK_NOT_READY, `任务状态为 ${task.status}，当前不能认领`, {
      details: { taskId: task.id, status: task.status },
    })
  }

  const member = state.members.get(input.memberId)
  if (member === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '成员不存在', { details: { memberId: input.memberId } })
  }
  assertMemberActive(member)
  if (member.teamId !== task.ownerTeamId && !task.collaborators.some((item) => item.teamId === member.teamId)) {
    fail(ERROR_CODES.FORBIDDEN, '成员所属团队不是该任务的参与团队')
  }
  if (task.requiredRoleId !== null && task.requiredRoleId !== member.roleId) {
    fail(ERROR_CODES.FORBIDDEN, '成员角色与任务要求不符', {
      details: { requiredRoleId: task.requiredRoleId, memberRoleId: member.roleId },
    })
  }
  if (member.sessionId === null) {
    fail(ERROR_CODES.SESSION_LOST, '成员还没有可用的会话，不能认领任务')
  }
  if (task.attemptId !== null) {
    const current = state.attempts.get(task.attemptId)
    if (current !== undefined) assertCurrentAttempt(task, current)
  }

  const previousAttempts = [...state.attempts.values()].filter((attempt) => attempt.taskId === task.id)
  // generation 的口径只有一个来源（domain/tasks/task.ts）：取该任务**全部**历史 attempt 的
  // 最大值 + 1。这里曾经自己 reduce 了一遍，与领域函数是两份实现——领域那份还带着
  // 「previous 为 null 就返回 1」的复用缺陷，两边一旦分叉，迟到的旧写入会和新 attempt 撞号。
  const generation = nextAttemptGeneration(previousAttempts)

  const now = runtime.now()
  const attempt: Attempt = {
    id: runtime.nextId('attempt'),
    taskId: task.id,
    teamId: member.teamId,
    memberId: member.id,
    generation,
    configRevision: team?.configRevision ?? state.configRevision,
    roleRevision: member.roleRevision,
    sessionId: member.sessionId,
    status: 'active',
    startedAt: now,
    endedAt: null,
  }

  const draft: DraftEvent = {
    type: 'task.claimed',
    actor: input.actor,
    entity: { kind: 'attempt', id: attempt.id, teamId: member.teamId },
    entityRevision: task.revision + 1,
    configRevision: attempt.configRevision,
    payload: { taskId: task.id, attempt, graphRevision: state.graphRevision },
  }
  return runtime.commit([draft])
}

/** 只读辅助：把投影里的任务折成图，供查询与测试使用。 */
export function taskGraphOf(state: { tasks: Map<string, Task> }): ReturnType<typeof graphOf> {
  return graphOf([...state.tasks.values()].map((task) => [task.id, task.dependencies] as const))
}
