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

/* ── P0-1（docs/21 §6）：两阶段 spawn 的三条件对账 ────────────── */

/**
 * 三条件探针结果（官方 `types/roster.js:339-386` 的 `reconcileProvisioning`）。
 *
 * 三个条件缺一不可，因为它们各自排除一种「看起来建成了、实际不可用」的假活：
 *   - `sessionExists`：child 会话根本不存在（宿主崩在 create 之前或中途）；
 *   - `continuable`：会话存在但不是可续会话（one-shot 子代理跑完即不可恢复，不能当成员）；
 *   - `initialPromptAccepted`：会话在、也能续，但上岗引导（初始 user 消息）没被宿主接受——
 *     成员起来了却不知道自己该做什么，等价于「没上岗」。
 */
export interface ProvisioningProbeResult {
  sessionExists: boolean
  continuable: boolean
  initialPromptAccepted: boolean
}

/** 对账输入：投影/账本里处于 `provisioning` 的成员事实（只读快照） */
export interface ProvisioningMember {
  memberId: string
  sessionId?: string
  status: string
}

export type ProvisioningSettlementAction = 'settle-active' | 'settle-failed'

export interface ProvisioningSettlement {
  memberId: string
  action: ProvisioningSettlementAction
  /** 结算理由：三条件里没满足的项逐条写清（settle-active 也给一句自证），直接进账本 `reason` 供审计 */
  reason: string
}

const PROVISIONING_ACTIVE_REASON = 'session exists ∧ continuable ∧ initial prompt accepted'

/**
 * 启动对账（纯函数，无 IO）：把「停在 provisioning」的成员按三条件结算成 active / failed。
 *
 * 为什么必须是**纯函数**：对账跑在冷启动路径上，而冷启动最怕「对账代码自己崩」——
 * 把宿主探测（`probe`）挡在外面之后，单测能穷举三条件矩阵，不需要真起会话。
 *
 * 幂等口径：**同一 memberId 只结算一次**（同一成员出两条结算事件正是账本要避免的重复写入）；
 * 同样的 members + 同样的探针结果 → 同样的输出（探针自身有副作用时不作保证）。
 *
 * 判活的取向：**证明不了自己是活的，就判 failed**。failed 可重试（重新 spawn），
 * 假 active 会静默丢任务——两种错误的代价不对称。
 */
export function reconcileProvisioning(
  members: readonly ProvisioningMember[],
  probe: (sessionId: string) => ProvisioningProbeResult,
): ProvisioningSettlement[] {
  const settled = new Set<string>()
  const out: ProvisioningSettlement[] = []
  for (const member of members) {
    // 只处理 provisioning：active / spawn_failed 是已结算状态，重复结算会写出重复事件
    if (member.status !== 'provisioning') continue
    if (settled.has(member.memberId)) continue
    settled.add(member.memberId)
    const sessionId = typeof member.sessionId === 'string' ? member.sessionId : ''
    if (sessionId.length === 0) {
      // 没记 sessionId = 探针无从下手（旧账本/坏 payload）；这本身就不构成「可恢复的 child」
      out.push({
        memberId: member.memberId,
        action: 'settle-failed',
        reason: 'no sessionId recorded at provisioning (cannot probe the child session)',
      })
      continue
    }
    let probed: ProvisioningProbeResult
    try {
      probed = probe(sessionId)
    } catch (e) {
      // 探针抛错 = 证明不了它是活的 → failed（可重试）；绝不因对账代码异常把成员判活
      out.push({ memberId: member.memberId, action: 'settle-failed', reason: `probe threw: ${String(e)}` })
      continue
    }
    const missing: string[] = []
    if (probed?.sessionExists !== true) missing.push('child session missing')
    if (probed?.continuable !== true) missing.push('session is not continuable')
    if (probed?.initialPromptAccepted !== true) missing.push('initial prompt was not accepted')
    out.push(
      missing.length === 0
        ? { memberId: member.memberId, action: 'settle-active', reason: PROVISIONING_ACTIVE_REASON }
        : { memberId: member.memberId, action: 'settle-failed', reason: `provisioning did not settle: ${missing.join('; ')}` },
    )
  }
  return out
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
