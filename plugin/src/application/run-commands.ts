/**
 * WorkflowRun 用例：把一份 WorkflowDefinition 实例化成项目任务。
 *
 * 实例化 = 一个原子批次里的 `run.created` + N 条 `task.created`：
 * 只写一半会让看板出现「有 Run 没任务」或「有任务不属于任何 Run」的中间态。
 * 同一批次内 graphRevision 只推进一次——一次实例化是**一次**图结构变化。
 */
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import type { CompletionRule, Task } from '../contracts/entities.ts'
import { planInstantiation } from '../domain/definitions/workflow.ts'
import { authorize } from '../domain/permissions/policy.ts'
import { assertGraphRevision, assertTeamActive } from '../domain/teams/team.ts'
import { createWorkflowRun } from '../domain/workflows/run.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'

export interface StartRunResult {
  commit: CommitResult
  runId: string
  taskIds: string[]
  completion: CompletionRule
}

export function startWorkflowRunCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    teamId: string
    workflowId: string
    expectedGraphRevision?: number
  },
): StartRunResult {
  authorize('run.create', input.actor, { teamId: input.teamId })
  const state = runtime.state

  const team = state.teams.get(input.teamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  }
  assertTeamActive(team)

  const definition = state.workflows.get(input.workflowId)
  if (definition === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '工作流定义不存在', { details: { workflowId: input.workflowId } })
  }
  if (input.expectedGraphRevision !== undefined) {
    assertGraphRevision(state.graphRevision, input.expectedGraphRevision)
  }

  const now = runtime.now()
  const runId = runtime.nextId('run')
  const plan = planInstantiation({
    definition,
    runId,
    ownerTeamId: input.teamId,
    now,
    nextTaskId: () => runtime.nextId('task'),
  })

  // 没有依赖的根任务在实例化时直接 ready：否则每次新建 Run 都要人工「放开」一次。
  for (const task of plan.tasks) {
    if (task.dependencies.length === 0) task.status = 'ready'
  }

  const run = createWorkflowRun({
    id: runId,
    workflowId: definition.id,
    workflowRevision: definition.revision,
    teamId: input.teamId,
    taskIds: plan.tasks.map((task) => task.id),
    templateKeyToTaskId: plan.templateKeyToTaskId,
    now,
  })

  const graphRevision = state.graphRevision + 1
  const drafts: DraftEvent[] = [
    {
      type: 'run.created',
      actor: input.actor,
      entity: { kind: 'workflow-run', id: runId, teamId: input.teamId },
      entityRevision: 1,
      configRevision: team.configRevision,
      payload: { run, completion: plan.completion, graphRevision },
    },
    ...plan.tasks.map(
      (task: Task): DraftEvent => ({
        type: 'task.created',
        actor: input.actor,
        entity: { kind: 'task', id: task.id, teamId: input.teamId },
        entityRevision: 1,
        configRevision: team.configRevision,
        payload: { task, graphRevision },
      }),
    ),
  ]

  const commit = runtime.commit(drafts)
  return { commit, runId, taskIds: plan.tasks.map((task) => task.id), completion: plan.completion }
}