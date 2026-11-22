/**
 * 任务状态机与完成判定（纯领域）。
 *
 * 两条容易做错的边界，这里明确规定：
 *   1. 「成员说做完了」不是完成。完成 = 状态在 review + 门禁裁决 pass +
 *      证据/交付物满足任务规格 + 依赖已完成。判定放在领域层，任何入口
 *      （工具、面板、迁移）走的都是同一个函数。
 *   2. 旧 Attempt 不能继续写。Attempt 的 generation 绑定在任务当前 attemptId
 *      上，写入前必须核对；否则被释放的成员可以用旧 attemptId 把任务改成 done。
 */
import type { Attempt, EvidenceRef, GateVerdict, Task, TaskStatus } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'

/**
 * 合法迁移。刻意不提供 `* → cancelled`：取消也要说明从哪来，因为不同来源
 * 需要清理不同的外部资源（认领中的 Attempt、排队中的 Effect）。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planned: ['ready', 'cancelled'],
  ready: ['claimed', 'blocked', 'cancelled'],
  claimed: ['in_progress', 'ready', 'blocked', 'cancelled'],
  in_progress: ['review', 'blocked', 'ready', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  review: ['done', 'in_progress', 'ready', 'cancelled'],
  done: ['ready'],
  cancelled: ['ready'],
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled'
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false
  return (TASK_TRANSITIONS[from] ?? []).includes(to)
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    fail(ERROR_CODES.INVALID_TRANSITION, `任务状态不能从 ${from} 变为 ${to}`, {
      details: { from, to, allowed: [...(TASK_TRANSITIONS[from] ?? [])] },
    })
  }
}

/** 可认领的状态：只有 ready。blocked 必须先由队长解除阻塞。 */
export function isClaimable(status: TaskStatus): boolean {
  return status === 'ready'
}

/** 可提交进度/证据的状态：必须已经认领。 */
export function acceptsAttemptWrites(status: TaskStatus): boolean {
  return status === 'claimed' || status === 'in_progress' || status === 'review'
}

export interface CreateTaskInput {
  id: string
  title: string
  description: string
  acceptance: string[]
  ownerTeamId: string | null
  collaborators?: Task['collaborators']
  dependencies?: string[]
  runId?: string | null
  templateKey?: string | null
  requiredRoleId?: string | null
  gate: Task['gate']
  deliverable?: Task['deliverable']
  now: string
}

/**
 * 新建任务总是 `planned`：即便没有依赖，也要经过一次显式「放开」进入 ready。
 *
 * 为什么不在创建时就 ready：批量建图时会出现「先建的下游任务在创建瞬间
 * 还没有上游」的中间态，如果按当时依赖算就绪，就会放出本不该开始的任务。
 */
export function createPlannedTask(input: CreateTaskInput): Task {
  if (input.acceptance.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '任务必须至少有一条验收标准（AC）', {
      details: { taskId: input.id },
    })
  }
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    acceptance: [...input.acceptance],
    status: 'planned',
    ownerTeamId: input.ownerTeamId,
    collaborators: input.collaborators ?? [],
    dependencies: [...(input.dependencies ?? [])],
    runId: input.runId ?? null,
    templateKey: input.templateKey ?? null,
    requiredRoleId: input.requiredRoleId ?? null,
    gate: input.gate,
    deliverable: input.deliverable ?? null,
    attemptId: null,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
  }
}

/** 下一次 Attempt 的 generation：严格递增，不允许复用旧值。 */
export function nextAttemptGeneration(previous: Attempt | null): number {
  return previous === null ? 1 : previous.generation + 1
}

/**
 * 写入前置条件：调用方声明的 attempt 必须是任务当前 attempt，且仍在进行。
 *
 * 只比对 id 不够：同一个 attemptId 在会话丢失后被 revoke，随后新 attempt
 * 可能复用同一个 taskId。状态与 generation 一起核对才能挡住迟到的写入。
 */
export function assertCurrentAttempt(task: Task, attempt: Attempt): void {
  if (task.attemptId !== attempt.id) {
    fail(ERROR_CODES.ATTEMPT_STALE, '该 Attempt 已不是任务的当前执行世代', {
      details: { taskId: task.id, attemptId: attempt.id, currentAttemptId: task.attemptId },
    })
  }
  if (attempt.status !== 'active') {
    fail(ERROR_CODES.ATTEMPT_STALE, `Attempt 状态为 ${attempt.status}，不能继续写入`, {
      details: { taskId: task.id, attemptId: attempt.id, status: attempt.status },
    })
  }
}

export interface ArtifactObservation {
  path: string
  hash: string | null
  exists: boolean
}

export interface CompletionInput {
  task: Task
  verdict: GateVerdict | null
  evidence: readonly EvidenceRef[]
  artifacts: readonly ArtifactObservation[]
  blockingDependencies: readonly string[]
}

export interface CompletionDecision {
  ok: boolean
  blockers: string[]
}

/**
 * 完成判定。返回全部阻塞原因，而不是遇到第一条就返回：
 * 面板要一次列清楚「还差什么」，成员也才知道一次补齐。
 */
export function evaluateTaskCompletion(input: CompletionInput): CompletionDecision {
  const blockers: string[] = []
  const { task, verdict, evidence, artifacts, blockingDependencies } = input

  if (task.status !== 'review') {
    blockers.push(`任务状态为 ${task.status}，只有 review 状态可以完成`)
  }

  if (task.acceptance.length === 0) {
    blockers.push('任务没有验收标准，无法判定完成')
  }

  if (blockingDependencies.length > 0) {
    blockers.push(`上游任务尚未完成：${blockingDependencies.join(', ')}`)
  }

  if (verdict === null) {
    blockers.push('缺少门禁裁决')
  } else {
    if (verdict.outcome !== 'pass') {
      blockers.push(`门禁裁决为 ${verdict.outcome}`)
    }
    if (task.attemptId !== null && verdict.attemptId !== task.attemptId) {
      blockers.push('门禁裁决来自旧 Attempt')
    }
  }

  if (task.gate.requireEvidence) {
    const collected = [...evidence, ...(verdict?.evidence ?? [])]
    if (collected.length === 0) {
      blockers.push('门禁要求证据，但没有任何证据条目')
    }
    for (const item of collected) {
      if (item.kind === 'command' && (item.excerpt === undefined || item.excerpt.trim().length === 0)) {
        blockers.push(`命令证据缺少输出摘要：${item.ref}`)
      }
    }
  }

  if (task.gate.requireArtifacts || task.deliverable !== null) {
    const required = task.deliverable?.paths ?? []
    if (required.length === 0) {
      blockers.push('门禁要求交付物，但任务没有声明交付物路径')
    }
    for (const path of required) {
      const observed = artifacts.find((artifact) => artifact.path === path)
      if (observed === undefined || !observed.exists) {
        blockers.push(`交付物不存在：${path}`)
        continue
      }
      if (observed.hash === null || observed.hash.trim().length === 0) {
        blockers.push(`交付物缺少内容 hash：${path}`)
      }
    }
  }

  return { ok: blockers.length === 0, blockers }
}

/** 完成规则：一个任务最多归属一个 Run；跨 Run 只能靠依赖协作。 */
export function assertSingleRun(task: Task, runId: string): void {
  if (task.runId !== null && task.runId !== runId) {
    fail(ERROR_CODES.CONFLICT, '一个任务最多归属一个 WorkflowRun', {
      details: { taskId: task.id, currentRunId: task.runId, requestedRunId: runId },
    })
  }
}