/**
 * T8 archive 门禁 + T16 有序恢复（host 侧逻辑，纯函数 + 文件校验分离）。
 *
 * archive 门禁（FR-10.4）：校验产物文件存在于 deliverableSpec 约定路径（轻量落位校验，
 * 不做内容语义评审——那是 review 门禁的事）。
 *
 * 有序恢复表（FR-4.6/I8/D7）：重启后按优先级选一条恢复路径。
 */
import { existsSync } from 'node:fs'

export interface DeliverableCheck {
  path: string
  exists: boolean
}

/** archive gate 判定：约定路径存在即 pass（M1 轻量）；无约定 → fail（叶子任务必填在计划校验已拦） */
export function checkArchiveGate(
  deliverableSpec: { path: string } | undefined,
  actualDeliverables: { path: string }[],
  fileExists: (p: string) => boolean = existsSync,
): { pass: boolean; checks: DeliverableCheck[]; reason?: string } {
  if (!deliverableSpec?.path) {
    return { pass: false, checks: [], reason: 'task has no deliverableSpec.path (leaf tasks require one, FR-11.2)' }
  }
  const declared = deliverableSpec.path
  const candidates = actualDeliverables.length > 0 ? actualDeliverables.map((d) => d.path) : [declared]
  const checks = candidates.map((p) => ({ path: p, exists: fileExists(p) }))
  const pass = checks.some((c) => c.exists)
  return { pass, checks, reason: pass ? undefined : `deliverable not found on disk: ${checks.map((c) => c.path).join(', ')}` }
}

/* ── T16：有序恢复表 ────────────────────────────────────────── */

export type TaskRuntimeFacts = {
  state: string
  attemptId?: string
  assignee?: string
  /** 该 attempt 的成员会话是否仍存活（host 侧 agents.get 结果） */
  memberLive: boolean
}

export type RecoveryAction =
  | { kind: 'complete-transition' }      // 完成已记录的转移（账本有 transfer 意图未落效果）
  | { kind: 're-activate-in-place' }     // 原地重激活（成员活着，attempt 保留）
  | { kind: 're-activate-new-attempt' }  // 滞留 attempt 用新 attemptId 重试
  | { kind: 'to-blocked' }               // 引导人工
  | { kind: 'noop' }

/**
 * 恢复决策表（FR-4.6：按有序表选一条路径，不并行多策）。
 * 顺序：完成转移 > 原地重激活 > 新 attempt 重试 > blocked > noop。
 */
export function recoveryAction(facts: TaskRuntimeFacts): RecoveryAction {
  if (facts.state === 'in_progress') {
    if (facts.memberLive && facts.assignee) return { kind: 're-activate-in-place' }
    if (facts.attemptId) return { kind: 're-activate-new-attempt' }
    return { kind: 'to-blocked' }
  }
  if (facts.state === 'ready' || facts.state === 'backlog') return { kind: 'noop' } // 调度层自然接管
  if (facts.state === 're-scoping') return { kind: 'noop' } // 等队长裁决（Inbox 已有提醒）
  if (facts.state === 'gate:review' || facts.state === 'gate:verify' || facts.state === 'gate:archive') {
    return facts.memberLive ? { kind: 're-activate-in-place' } : { kind: 're-activate-new-attempt' }
  }
  return { kind: 'noop' } // 终态不恢复
}

/** 恢复动作 → 账本事件（重构 attempt 用新 attemptId） */
export function recoveryEventFor(action: RecoveryAction, taskId: string, newAttemptId?: string): { type: string; payload: Record<string, unknown> } | undefined {
  switch (action.kind) {
    case 're-activate-new-attempt':
      return {
        type: 'task.attempt.revoked',
        payload: { taskId, attemptId: `revoked-on-recovery`, reason: 'host restart recovery (FR-4.6)', prevAssignee: undefined },
      }
    case 'to-blocked':
      return { type: 'task.rescoped', payload: { taskId, patch: { recoveryBlocked: true } } }
    default:
      return undefined
  }
  void newAttemptId
}
