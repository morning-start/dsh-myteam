/**
 * 任务执行用例：进度、证据、提交评审、门禁裁决、完成、重开、取消、改依赖。
 *
 * 三条纪律：
 *   1. 任何写入都必须绑定**当前** Attempt（`assertCurrentAttempt`），被释放的
 *      成员不能用旧 attemptId 继续改任务；
 *   2. 完成不是「成员说完了」：由 {@link evaluateTaskCompletion} 统一判定，
 *      工具、面板、迁移走同一个函数；
 *   3. 图结构变化推进项目级 graphRevision，并做全项目防环；业务状态变化只推进
 *      实体 revision。
 */
import type { Attempt, EvidenceRef, GateCheckResult, GateVerdict, Task, VerdictOutcome } from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import { blockingDependencies, cycleIfEdgesChanged, graphOf } from '../domain/tasks/dag.ts'
import {
  acceptsAttemptWrites,
  assertCurrentAttempt,
  assertTransition,
  evaluateTaskCompletion,
} from '../domain/tasks/task.ts'
import type { ArtifactObservation } from '../domain/tasks/task.ts'
import { authorize } from '../domain/permissions/policy.ts'
import { assertGraphRevision } from '../domain/teams/team.ts'
import { completionStatus } from '../domain/workflows/run.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'

function requireTask(runtime: ProjectRuntime, taskId: string): Task {
  const task = runtime.state.tasks.get(taskId)
  if (task === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '任务不存在', { details: { taskId } })
  }
  return task
}

/** 取当前 Attempt 并核对它属于这个任务；可选核对成员本人。 */
function requireAttempt(runtime: ProjectRuntime, task: Task, attemptId: string, memberId?: string): Attempt {
  const attempt = runtime.state.attempts.get(attemptId)
  if (attempt === undefined) {
    fail(ERROR_CODES.NOT_FOUND, 'Attempt 不存在', { details: { attemptId } })
  }
  if (attempt.taskId !== task.id) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '该 Attempt 不属于这个任务', {
      details: { taskId: task.id, attemptTaskId: attempt.taskId },
    })
  }
  if (memberId !== undefined && attempt.memberId !== memberId) {
    fail(ERROR_CODES.FORBIDDEN, 'Attempt 不属于该成员', {
      details: { attemptId, memberId, attemptMemberId: attempt.memberId },
    })
  }
  assertCurrentAttempt(task, attempt)
  return attempt
}

export function recordProgressCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; taskId: string; attemptId: string; memberId: string; note: string; percent?: number | null },
): CommitResult {
  const task = requireTask(runtime, input.taskId)
  const attempt = requireAttempt(runtime, task, input.attemptId, input.memberId)
  authorize('task.progress', input.actor, {
    teamId: task.ownerTeamId ?? undefined,
    attemptMemberId: attempt.memberId,
  })
  if (!acceptsAttemptWrites(task.status)) {
    fail(ERROR_CODES.INVALID_TRANSITION, `任务状态为 ${task.status}，不能提交进度`, {
      details: { taskId: task.id, status: task.status },
    })
  }
  const percent = input.percent ?? null
  if (percent !== null && (percent < 0 || percent > 100)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'percent 必须在 0 到 100 之间')
  }

  const draft: DraftEvent = {
    type: 'task.progress',
    actor: input.actor,
    entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
    configRevision: attempt.configRevision,
    payload: { taskId: task.id, attemptId: attempt.id, note: input.note, percent },
  }
  return runtime.commit([draft])
}

export function recordEvidenceCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; taskId: string; attemptId: string; memberId: string; evidence: EvidenceRef[] },
): CommitResult {
  const task = requireTask(runtime, input.taskId)
  const attempt = requireAttempt(runtime, task, input.attemptId, input.memberId)
  authorize('task.evidence', input.actor, {
    teamId: task.ownerTeamId ?? undefined,
    attemptMemberId: attempt.memberId,
  })
  if (!acceptsAttemptWrites(task.status)) {
    fail(ERROR_CODES.INVALID_TRANSITION, `任务状态为 ${task.status}，不能提交证据`, {
      details: { taskId: task.id, status: task.status },
    })
  }
  if (input.evidence.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '证据条目不能为空')
  }
  for (const item of input.evidence) {
    if (item.ref.trim().length === 0) {
      fail(ERROR_CODES.INVALID_PAYLOAD, '证据缺少引用位置', { details: { kind: item.kind } })
    }
  }

  const draft: DraftEvent = {
    type: 'task.evidence',
    actor: input.actor,
    entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
    configRevision: attempt.configRevision,
    payload: { taskId: task.id, attemptId: attempt.id, evidence: input.evidence },
  }
  return runtime.commit([draft])
}

export function submitReviewCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; taskId: string; attemptId: string; memberId: string },
): CommitResult {
  const task = requireTask(runtime, input.taskId)
  const attempt = requireAttempt(runtime, task, input.attemptId, input.memberId)
  authorize('task.submit-review', input.actor, {
    teamId: task.ownerTeamId ?? undefined,
    attemptMemberId: attempt.memberId,
  })
  assertTransition(task.status, 'review')

  const draft: DraftEvent = {
    type: 'task.submitted',
    actor: input.actor,
    entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
    entityRevision: task.revision + 1,
    configRevision: attempt.configRevision,
    payload: { taskId: task.id, attemptId: attempt.id },
  }
  return runtime.commit([draft])
}

export function recordVerdictCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    taskId: string
    attemptId: string
    outcome: VerdictOutcome
    checks: GateCheckResult[]
    evidence: EvidenceRef[]
  },
): CommitResult {
  const task = requireTask(runtime, input.taskId)
  authorize('task.complete', input.actor, { teamId: task.ownerTeamId ?? undefined })
  if (task.status !== 'review') {
    fail(ERROR_CODES.INVALID_TRANSITION, `任务状态为 ${task.status}，不能裁决`, {
      details: { taskId: task.id, status: task.status },
    })
  }
  if (task.attemptId !== input.attemptId) {
    fail(ERROR_CODES.ATTEMPT_STALE, '门禁裁决必须针对当前 Attempt', {
      details: { attemptId: input.attemptId, currentAttemptId: task.attemptId },
    })
  }

  const now = runtime.now()
  const verdict: GateVerdict = {
    id: runtime.nextId('verdict'),
    taskId: task.id,
    attemptId: input.attemptId,
    outcome: input.outcome,
    checks: input.checks,
    evidence: input.evidence,
    decidedAt: now,
  }

  const draft: DraftEvent = {
    type: 'task.verdict',
    actor: input.actor,
    entity: { kind: 'gate-verdict', id: verdict.id, teamId: task.ownerTeamId ?? undefined },
    payload: { verdict },
  }
  return runtime.commit([draft])
}

export function completeTaskCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    taskId: string
    attemptId: string
    artifacts: ArtifactObservation[]
  },
): CommitResult {
  const state = runtime.state
  const task = requireTask(runtime, input.taskId)
  authorize('task.complete', input.actor, { teamId: task.ownerTeamId ?? undefined })

  const verdict = state.verdicts.get(task.id) ?? null
  const evidence = state.evidence.get(task.id) ?? []
  const graph = graphOf([...state.tasks.values()].map((item) => [item.id, item.dependencies] as const))
  const blocking = blockingDependencies(graph, task.id, (taskId) => state.tasks.get(taskId)?.status)

  const decision = evaluateTaskCompletion({
    task,
    verdict,
    evidence,
    artifacts: input.artifacts,
    blockingDependencies: blocking,
  })
  if (!decision.ok) {
    fail(ERROR_CODES.TASK_NOT_READY, '任务还不满足完成条件', { details: { blockers: decision.blockers } })
  }

  const revision = task.revision + 1
  const drafts: DraftEvent[] = [
    {
      type: 'task.completed',
      actor: input.actor,
      entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
      entityRevision: revision,
      configRevision: task.attemptId === null ? undefined : state.attempts.get(task.attemptId)?.configRevision,
      payload: {
        taskId: task.id,
        attemptId: input.attemptId,
        revision,
        verdictId: verdict?.id ?? null,
      },
    },
  ]

  // 任务完成后，下游中「所有依赖都已 done」的 planned 任务在同一批次里放开，
  // 避免看板出现「上游做完了、下游还是 planned」需要人手动推一下的中间态。
  const tasksAfter = new Map(state.tasks)
  tasksAfter.set(task.id, { ...task, status: 'done' })
  for (const candidate of state.tasks.values()) {
    if (candidate.status !== 'planned') continue
    if (!candidate.dependencies.includes(task.id)) continue
    const ready = candidate.dependencies.every((dependency) => tasksAfter.get(dependency)?.status === 'done')
    if (!ready) continue
    drafts.push({
      type: 'task.ready',
      actor: input.actor,
      entity: { kind: 'task', id: candidate.id, teamId: candidate.ownerTeamId ?? undefined },
      entityRevision: candidate.revision + 1,
      payload: { taskId: candidate.id, revision: candidate.revision + 1 },
    })
  }

  // Run 收口：完成条件满足时同一批次里关闭 Run，避免「任务都完成了但 Run 还开着」
  // 这种需要人手动收拾的中间态。
  if (task.runId !== null) {
    const run = state.runs.get(task.runId)
    const rule = state.runCompletions.get(task.runId)
    if (run !== undefined && rule !== undefined && run.status === 'active') {
      const committedTasks = new Map(tasksAfter)
      for (const draft of drafts) {
        if (draft.type !== 'task.ready') continue
        const readyTaskId = (draft.payload as { taskId: string }).taskId
        const current = committedTasks.get(readyTaskId)
        if (current !== undefined) committedTasks.set(readyTaskId, { ...current, status: 'ready' })
      }
      const status = completionStatus(run, rule, committedTasks)
      if (status.satisfied) {
        drafts.push({
          type: 'run.closed',
          actor: input.actor,
          entity: { kind: 'workflow-run', id: run.id, teamId: run.teamId },
          entityRevision: run.revision + 1,
          payload: { runId: run.id, status: 'completed', reason: '完成条件满足' },
        })
      }
    }
  }

  return runtime.commit(drafts)
}

export function reopenTaskCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; taskId: string; reason: string },
): CommitResult {
  const state = runtime.state
  const task = requireTask(runtime, input.taskId)
  authorize('task.reopen', input.actor, { teamId: task.ownerTeamId ?? undefined })

  if (task.runId !== null) {
    const run = state.runs.get(task.runId)
    if (run !== undefined && run.status === 'completed') {
      fail(ERROR_CODES.CONFLICT, '该 Run 已按完成条件结束，重开任务请新建 Run', {
        details: { taskId: task.id, runId: run.id },
      })
    }
  }
  assertTransition(task.status, 'ready')

  const revision = task.revision + 1
  const draft: DraftEvent = {
    type: 'task.reopened',
    actor: input.actor,
    entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
    entityRevision: revision,
    payload: { taskId: task.id, revision, reason: input.reason },
  }
  return runtime.commit([draft])
}

export function cancelTaskCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; taskId: string; reason: string },
): CommitResult {
  const state = runtime.state
  const task = requireTask(runtime, input.taskId)
  authorize('task.cancel', input.actor, { teamId: task.ownerTeamId ?? undefined })
  assertTransition(task.status, 'cancelled')

  const drafts: DraftEvent[] = []
  if (task.attemptId !== null) {
    const attempt = state.attempts.get(task.attemptId)
    if (attempt !== undefined && attempt.status === 'active') {
      drafts.push({
        type: 'attempt.revoked',
        actor: input.actor,
        entity: { kind: 'attempt', id: attempt.id, teamId: attempt.teamId },
        payload: { taskId: task.id, attemptId: attempt.id, reason: '任务被取消' },
      })
    }
  }
  const revision = task.revision + 1
  drafts.push({
    type: 'task.cancelled',
    actor: input.actor,
    entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
    entityRevision: revision,
    payload: { taskId: task.id, revision, reason: input.reason },
  })
  return runtime.commit(drafts)
}

export function rewireDependenciesCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    taskId: string
    dependencies: string[]
    expectedGraphRevision?: number
  },
): CommitResult {
  const state = runtime.state
  const task = requireTask(runtime, input.taskId)
  authorize('task.dependencies.change', input.actor, { teamId: task.ownerTeamId ?? undefined })
  if (input.expectedGraphRevision !== undefined) {
    assertGraphRevision(state.graphRevision, input.expectedGraphRevision)
  }

  const dependencies = [...new Set(input.dependencies)]
  for (const dependency of dependencies) {
    if (!state.tasks.has(dependency)) {
      fail(ERROR_CODES.NOT_FOUND, '依赖的任务不存在', { details: { taskId: dependency } })
    }
  }

  const graph = graphOf([...state.tasks.values()].map((item) => [item.id, item.dependencies] as const))
  const cycle = cycleIfEdgesChanged(graph, task.id, dependencies)
  if (cycle !== null) {
    fail(ERROR_CODES.DEPENDENCY_CYCLE, '这次改依赖会把任务图接成环', { details: { cycle } })
  }

  const revision = task.revision + 1
  const graphRevision = state.graphRevision + 1
  const draft: DraftEvent = {
    type: 'task.dependencies.changed',
    actor: input.actor,
    entity: { kind: 'task', id: task.id, teamId: task.ownerTeamId ?? undefined },
    entityRevision: revision,
    payload: { taskId: task.id, revision, dependencies, graphRevision },
  }
  return runtime.commit([draft])
}