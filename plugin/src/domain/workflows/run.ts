/**
 * WorkflowRun：工作流的一次真实执行。
 *
 * Run 只记录「这次执行引用哪个定义 revision、包含哪些任务、完成条件是什么」，
 * **不保存任务状态**——任务状态永远在项目 Task 上。否则同一份任务状态会有
 * 两个真源，动态改图时必然分叉。
 *
 * 完成条件的版本（completionRevision）单独推进：新增任务会让「全部完成」的
 * 含义发生变化，这种变化必须有记录，不能悄悄漂移。
 */
import type { CompletionRule, Task, WorkflowRun } from '../../contracts/entities.ts'
import type { WorkflowRunId } from '../../contracts/ids.ts'
import { hashContent } from '../../contracts/json.ts'

export function createWorkflowRun(input: {
  id: WorkflowRunId
  workflowId: string
  workflowRevision: number
  teamId: string
  taskIds: readonly string[]
  templateKeyToTaskId: Record<string, string>
  now: string
}): WorkflowRun {
  return {
    id: input.id,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    teamId: input.teamId,
    status: 'active',
    completionRevision: 1,
    taskIds: [...input.taskIds],
    templateKeyToTaskId: { ...input.templateKeyToTaskId },
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export interface CompletionStatus {
  satisfied: boolean
  /** 尚未完成、仍在阻塞 Run 的任务。 */
  pending: string[]
  /** 被取消的任务：Run 不可能按原条件完成，需要人决定。 */
  cancelled: string[]
}

/**
 * 判定 Run 是否完成。
 *
 * `all-tasks` 要求本次执行的全部任务 done；`required-tasks` 只要求列出的
 * templateKey 对应任务 done，其余任务可以并行或取消。
 *
 * 取消的任务不算完成：上游被取消意味着 Run 的交付前提不存在，应该由人
 * 明确收口（补任务或结束 Run），而不是让 Run 自动「完成」。
 */
export function completionStatus(
  run: WorkflowRun,
  rule: CompletionRule,
  tasksById: ReadonlyMap<string, Task>,
): CompletionStatus {
  const scope =
    rule.mode === 'all-tasks'
      ? run.taskIds
      : rule.requiredKeys.map((key) => run.templateKeyToTaskId[key]).filter((taskId): taskId is string => taskId !== undefined)

  const pending: string[] = []
  const cancelled: string[] = []
  for (const taskId of scope) {
    const task = tasksById.get(taskId)
    if (task === undefined) {
      pending.push(taskId)
      continue
    }
    if (task.status === 'cancelled') cancelled.push(taskId)
    else if (task.status !== 'done') pending.push(taskId)
  }

  return { satisfied: pending.length === 0 && cancelled.length === 0, pending, cancelled }
}

/** 完成条件是否变化；变化才推进 completionRevision。 */
export function completionRuleChanged(previous: CompletionRule, next: CompletionRule): boolean {
  return hashContent(previous) !== hashContent(next)
}

/** 下一个 completionRevision：条件不变就保持原值。 */
export function nextCompletionRevision(previous: CompletionRule, next: CompletionRule, current: number): number {
  return completionRuleChanged(previous, next) ? current + 1 : current
}