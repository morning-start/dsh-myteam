/**
 * T3 收口：账本事件 → TeamProjection 逐型折叠（纯函数，可从零重放重建〔I2/R19〕）。
 * 输入 = openLedger 的 events；输出 = team.json 投影内容。
 * 本文件不碰 IO（投影落盘由 service 层负责）。
 */
import type { LedgerEvent } from '../ledger/ledger.ts'
import { diffTaskInput, structuralFieldsOf, type FieldChange } from '../tasks/diff.ts'
import {
  emptyProjection,
  isLegalTransition,
  gateAdvance,
  type TeamProjection,
  type TaskProjection,
  type TaskState,
  type MemberProjection,
} from './state.ts'

export class FoldError extends Error {
  seq: number
  constructor(message: string, seq: number) {
    super(`fold failed at seq ${seq}: ${message}`)
    this.name = 'FoldError'
    this.seq = seq
  }
}

const MESSAGE_TYPES = new Set(['message.sent', 'message.consumed'])

/**
 * P1-3（docs/21 §6，来源官方 `types/projection.js:274-317`）：**只复制被触及的集合**。
 *
 * 为什么按事件类型分类，而不是「改完之后再比较」：JS 里的原地写不留痕迹，
 * 「这个集合变没变」在事后无法廉价判断。分类是唯一 O(1) 且有证明的做法——
 * 宁可多复制（缓存少命中一次，只是性能），不可少复制（缓存拿着**没变**的集合引用
 * 返回**已经变了**的视图，是正确性事故）。
 *
 * 复制是浅拷贝：只换集合本身的引用，不复制元素（元素由各自的字段写入负责）。
 * 视图缓存（`remote/views.ts`）正是拿 `members` / `tasks` 的引用当键——
 * 集合引用不变 ⇔ 该视图依赖的输入没变 ⇒ 可以直接复用上一次的视图对象。
 */
const MEMBER_TOUCHING_EVENTS = new Set([
  'member.spawned',
  'member.released',
  'member.archived',
  'member.restored',
  // 这些任务事件会改成员（claim 占用 currentTaskId / 终态释放成员）
  'task.claimed',
  'task.completed',
  'task.failed',
  'task.blocked',   // CHG-207：blocked 会 releaseMember（成员回到 idle）
  'task.escalated',
  'task.cancelled',
  'task.attempt.revoked',
])

/** 参与边集合（participantsOf 的数据来源；变了下游视图必须重建） */
const PARTICIPATION_TOUCHING_EVENTS = new Set(['task.created', 'task.participate', 'task.participation.released', 'task.deleted'])

const PROPOSAL_TOUCHING_EVENTS = new Set(['task.proposal', 'task.proposal.resolved', 'task.deleted'])

const PER_TASK_MESSAGE_TOUCHING_EVENTS = new Set(['message.sent', 'task.deleted'])

const INBOX_TOUCHING_EVENTS = new Set(['task.escalated', 'message.sent'])

/** 容错折叠的结果（CHG-210：从 `index/offline-view.ts` 搬来——它属于折叠领域，不属于离线视图） */
export interface TolerantFold {
  proj: TeamProjection
  skippedEvents: number
}

/**
 * CHG-210：**容错折叠**——单条事件非法只跳过该条，保留此前已折叠的状态。
 *
 * 与 `foldEvents` 的唯一区别是错误策略：全量折叠用于**写路径**，必须 fail-fast（账本坏了就不能
 * 继续追加，否则脏数据越滚越大）；这里用于**读路径**（索引扫描 / 离线回看 / 面板降级），
 * 目标是「尽量给出一份能看的投影，并如实报告跳过了几条」。
 *
 * 为什么搬进 `fold.ts`：它原来是 `index/offline-view.ts` 的导出，而 `index/team-index.ts` 要用它
 * 做逐团队容错——两个 index 模块互相 import 会成环（A1 门禁）。折叠的两种错误策略放在一起，
 * 也更容易看出「哪个场合该用哪个」。
 */
export function foldTolerant(teamId: string, events: LedgerEvent[]): TolerantFold {
  const proj = emptyProjection(teamId)
  let skippedEvents = 0
  for (const event of events) {
    try {
      applyEvent(proj, event)
    } catch {
      skippedEvents += 1
    }
  }
  return { proj, skippedEvents }
}

/**
 * 按事件类型复制**可能被写**的顶层集合（浅拷贝，见上方说明）。
 *
 * `task.*` 用前缀判定而不是逐个列举：新增任务事件时自动获得「复制」语义，
 * 漏写一个的代价是返回过期视图——把安全性押在「以后每次加事件都记得改一行」上不值得。
 */
function copyTouchedCollections(proj: TeamProjection, type: string): void {
  if (type.startsWith('task.')) proj.tasks = { ...proj.tasks }
  if (MEMBER_TOUCHING_EVENTS.has(type)) proj.members = { ...proj.members }
  if (PARTICIPATION_TOUCHING_EVENTS.has(type)) proj.participations = { ...proj.participations }
  if (PROPOSAL_TOUCHING_EVENTS.has(type)) proj.proposals = { ...proj.proposals }
  if (PER_TASK_MESSAGE_TOUCHING_EVENTS.has(type)) proj.perTaskMessages = { ...proj.perTaskMessages }
  if (INBOX_TOUCHING_EVENTS.has(type)) proj.inbox = [...proj.inbox]
}

/**
 * 全量折叠：events 顺序应用。
 * 非法状态转移在此抛 FoldError（账本写入端已校验，此处是重放防线）。
 * 未识别 type 跳过（前向兼容：新版事件在旧 reader 上不致崩溃，ignorable 思想）。
 */
export function foldEvents(teamId: string, events: LedgerEvent[]): TeamProjection {
  const proj = emptyProjection(teamId)
  for (const event of events) {
    applyEvent(proj, event)
  }
  return proj
}

export function applyEvent(proj: TeamProjection, event: LedgerEvent): void {
  const { type, payload } = event
  const p = payload as Record<string, string & number & Record<string, unknown>>
  // P1-3：先换掉被触及集合的引用（未触及的保持原引用），再原地写元素
  copyTouchedCollections(proj, type)
  switch (type) {
    case 'team.created': {
      proj.name = String(p.name)
      proj.goal = String(p.goal)
      break
    }
    case 'plan.staged': {
      proj.state = 'draft'
      break
    }
    case 'plan.approved': {
      proj.state = 'active'
      break
    }
    case 'plan.discarded': {
      proj.state = 'discarded'
      break
    }
    case 'team.disbanded': {
      proj.state = 'archived'
      break
    }
    case 'member.spawned': {
      const member: MemberProjection = {
        id: p.memberId,
        roleId: p.roleId,
        instanceName: p.instanceName ?? p.memberId,
        sessionId: p.sessionId,
        status: p.status === 'failed' ? 'spawn_failed' : 'active',
        spawnedAt: event.ts,
        // CHG-187b（FR-32 支柱一）：派生树三字段是**必填**载荷——历史账本在 `openLedger`
        // 里一次性迁移（补成「队长直接召唤的一级成员」），所以这里**直接取**，不再有第二套
        // 默认值。`?? null / ?? 0 / ?? memberId` 一旦留在这里，就是「载荷说可能没有、
        // 折叠层说没有就是一级成员」的两份真相（重放结果取决于哪边先改）。
        parentMemberId: p.parentMemberId,
        depth: p.depth,
        rootMemberId: p.rootMemberId,
        ...(Array.isArray(p.skills) ? { skills: p.skills as unknown as string[] } : {}),
        ...(Array.isArray(p.mcpAllowlist) ? { mcpAllowlist: p.mcpAllowlist as unknown as string[] } : {}),
      }
      proj.members[member.id] = member
      break
    }
    case 'member.released': {
      const m = proj.members[p.memberId]
      if (m) m.status = p.mode === 'remove' ? 'removed' : 'suspended'
      break
    }
    case 'member.archived': {
      const m = proj.members[p.memberId]
      if (m) m.status = 'archived'
      break
    }
    case 'member.restored': {
      const m = proj.members[p.memberId]
      if (m) m.status = 'active'
      break
    }
    case 'task.created': {
      const task = p.task as TaskProjection['input'] & Record<string, unknown>
      proj.tasks[p.taskId] = {
        id: p.taskId,
        input: {
          title: String(task.title ?? ''),
          description: String(task.description ?? ''),
          acceptanceCriteria: (task.acceptanceCriteria as string[]) ?? [],
          /* CHG-205（P0 bug）：可选字段缺省时**不能写成 `undefined` 的 own key**——
           * 工具输出校验要求 lossless JSON，`myteam_read_task` 会把 `input` 原样带出去，
           * 一个 `taskType: undefined` 就足以让整次读取报「value is not lossless JSON」。 */
          ...(task.deliverableSpec !== undefined ? { deliverableSpec: task.deliverableSpec as TaskProjection['input']['deliverableSpec'] } : {}),
          deps: (task.deps as string[]) ?? [],
          requiredRole: String(task.requiredRole ?? ''),
          ...(typeof task.taskType === 'string' ? { taskType: task.taskType } : {}),
          gateChain: (task.gateChain as string[]) ?? [],
          priority: (task.priority as TaskProjection['input']['priority']) ?? 'P2',
          ...(task.estimate !== undefined ? { estimate: task.estimate as TaskProjection['input']['estimate'] } : {}),
          ...(Array.isArray(task.tags) ? { tags: task.tags as string[] } : {}),
          // CHG-87（FR-5.4/FR-5.3）：scope 审计范围 + command 门禁命令
          ...(Array.isArray(task.writeScopes) ? { writeScopes: (task.writeScopes as unknown[]).map(String) } : {}),
          ...(task.verifyCommand !== undefined ? { verifyCommand: task.verifyCommand as TaskProjection['input']['verifyCommand'] } : {}),
        },
        state: 'backlog',
        escalateCount: 0,
        gates: ((task.gateChain as string[]) ?? []).length > 0 ? (task.gateChain as string[]) : ['review', 'archive'],
        gateVerdicts: {},
        evidenceRefs: [],
        deliverables: [],
        createdAt: event.ts,
      }
      // CHG-69：建任务即隐含主责参与边（owner team = 持有账本的团队）
      const owner = String(p.teamId ?? proj.teamId)
      ;(proj.participations[p.taskId] ??= { leadTeamId: owner, teams: {} }).teams[owner] = {
        teamId: owner,
        role: 'lead',
        memberIds: [],
        seq: event.seq,
        ts: event.ts,
      }
      proj.participations[p.taskId].leadTeamId = owner
      break
    }
    case 'task.claimed': {
      const t = requireTask(proj, p.taskId, event.seq)
      // 调度语义：deps 全 done（或无 deps）→ ready。fold 按账本推进到 ready 再 claim
      // （claim 条件的角色/优先级校验在工具层；fold 只保证状态机合法）
      if (t.state === 'backlog') {
        const depsDone = t.input.deps.every((d) => proj.tasks[d]?.state === 'done')
        if (depsDone) {
          t.state = 'ready'
          t.waitingSince = event.ts
        } else {
          throw new FoldError(`task "${p.taskId}" claimed with unfinished deps`, event.seq)
        }
      }
      transition(t, 'in_progress', event.seq)
      t.attemptId = p.attemptId
      t.assignee = p.memberId
      // ── CHG-158（报告 A5）：attempt 四字段接线（fold **只读 payload，不生成**）──
      // ① 执行世代号由写入方算好（host 取「上一世代 + 1」）。为什么不能在 fold 里自增：
      //    重放时若事件被裁剪/跳号，自增会与首次 fold 分叉；`randomUUID()` 更直接——同一本账本
      //    两次重放会得出不同投影（t124 的纪律）。
      // ② 老账本（接线前写的 task.claimed）没有 attempt 字段 → 保持 undefined，重放结果逐字不变。
      // ③ 清除 `reassigning`（重派完成）与 `handoffId`（交接落地）：不清的话阶段永远停在
      //    reassigning/handoff，调度器会把正在执行的任务当成「正在交接」而不敢派单。
      const claimPayload = p as unknown as Record<string, unknown>
      const generation = Number(claimPayload.attempt)
      if (Number.isFinite(generation) && generation > 0) t.attempt = generation
      t.reassigning = undefined
      t.handoffId = undefined
      if (proj.members[p.memberId]) proj.members[p.memberId].currentTaskId = p.taskId
      break
    }
    case 'task.assigned': {
      const t = requireTask(proj, p.taskId, event.seq)
      const ids = Array.isArray(p.memberIds) ? (p.memberIds as unknown[]).map(String) : []
      t.assignee = p.memberId
      t.assignees = ids.length > 0 ? ids : [String(p.memberId)]
      // CHG-158（报告 A5）：交接票据只从 payload 赋值（fold 不发明）。`task.assigned` = 新持有人
      // 已接手 ⇒ 旧持有人的排空结束，「重派中」这道闸门落下（阶段从 reassigning 回落到 handoff，
      // 见 `attemptPhase` ③）；票据本身保留到下一次 claim 才失效。
      const assignedPayload = p as unknown as Record<string, unknown>
      if (typeof assignedPayload.handoffId === 'string' && assignedPayload.handoffId.length > 0) {
        t.handoffId = assignedPayload.handoffId
      }
      t.reassigning = undefined
      break
    }
    /* CHG-69（FR-21）：任务 × 团队参与边（主责 1 / 协作 N） */
    case 'task.participate': {
      const t = requireTask(proj, p.taskId, event.seq)
      const teamId = String(p.participantTeamId)
      const role = p.role === 'lead' ? 'lead' : 'coop'
      const entry = proj.participations[p.taskId] ?? (proj.participations[p.taskId] = { teams: {} })
      if (role === 'lead') {
        // 主责唯一：旧主责团队（若有）降级为协作，避免出现两个主责
        const previous = entry.leadTeamId
        if (previous && previous !== teamId && entry.teams[previous]) entry.teams[previous].role = 'coop'
        entry.leadTeamId = teamId
      }
      const memberIds = Array.isArray(p.memberIds) ? (p.memberIds as unknown[]).map(String) : []
      entry.teams[teamId] = { teamId, role, memberIds, seq: event.seq, ts: event.ts }
      void t
      break
    }
    case 'task.participation.released': {
      const t = requireTask(proj, p.taskId, event.seq)
      const teamId = String(p.participantTeamId)
      const entry = proj.participations[p.taskId]
      if (entry) {
        delete entry.teams[teamId]
        if (entry.leadTeamId === teamId) entry.leadTeamId = undefined
      }
      void t
      break
    }
    case 'task.attempt.revoked': {
      const t = requireTask(proj, p.taskId, event.seq)
      // ── CHG-158（报告 A5）：停放记录 + 重派标记（都只读 payload）──
      // ① 每次撤销（含重派）都把「哪个 attempt 为什么停下」并入停放记录（累积，不覆盖历史）。
      //    为什么是普通对象不是 Map：Map 能 `structuredClone`，但 `JSON.stringify(new Map())` 恒为 `{}`
      //    ——面板 RPC / 导出 / 日志都会把停放记录静默丢光（t124 已把这点钉成断言）。
      // ② 重派（`reassign === true`）额外置 `reassigning`：它是交接（旧持有人排空、新 attempt 接手），
      //    阶段由 `reassigning` 表达；停放记录只记「这个 attempt 被撤下了」这段历史，
      //    不再压过交接（`attemptPhase` ②/④ 的顺序即为此而调）。
      // ③ 交接票据由写入方生成塞进 payload；fold 只赋值（生成随机 id 破坏重放确定性）。
      const revokePayload = p as unknown as Record<string, unknown>
      const revokedAttemptId = typeof revokePayload.attemptId === 'string' && revokePayload.attemptId.length > 0 ? revokePayload.attemptId : 'none'
      t.parkedAttempts = { ...(t.parkedAttempts ?? {}), [revokedAttemptId]: String(p.reason ?? '') }
      if (revokePayload.reassign === true) {
        t.reassigning = true
        if (typeof revokePayload.handoffId === 'string' && revokePayload.handoffId.length > 0) {
          t.handoffId = revokePayload.handoffId
        }
      }
      if (t.attemptId === p.attemptId) {
        t.attemptId = undefined
        // 撤 attempt = 放弃本次执行：in_progress 与门禁态都复位到 ready 重新调度
        // （CHG-73：门禁态此前不会被复位，导致 gate:* 任务撤销后卡死）
        if (t.state === 'in_progress' || t.state.startsWith('gate:')) {
          t.state = 'ready'
          t.waitingSince = event.ts
        }
      }
      releaseMember(proj, t)
      break
    }
    case 'task.progress': {
      const t = requireTask(proj, p.taskId, event.seq)
      break
    }
    case 'task.evidence': {
      const t = requireTask(proj, p.taskId, event.seq)
      t.evidenceRefs.push(event.seq)
      // CHG-73：新证据覆盖当前定义 → 过期标记清除（过期只对"旧定义下的旧证据"成立）
      t.evidenceStale = undefined
      break
    }
    case 'task.completed': {
      const t = requireTask(proj, p.taskId, event.seq)
      // CHG-87（FR-5.4）：完成时 scope 审计结果随 completed 事件落投影（无门禁链的任务
      // 没有 gate.result 可挂，审计结论只能挂这里；有门禁链时 gate.result 会覆盖成最新一次）
      applyScopeAudit(t, p.scopeAudit)
      // 有门禁链 → 走 gate；无 → done（M1 archive gate 由 task.deliverable 触发校验）
      const next = t.gates.length > 0 ? ((`gate:${t.gates[0]}` as TaskState)) : 'done'
      transition(t, next, event.seq)
      releaseMember(proj, t)
      advanceDependents(proj, event.seq)
      break
    }
    case 'task.gate.result': {
      const t = requireTask(proj, p.taskId, event.seq)
      t.gateVerdicts[p.gate] = p.verdict as 'pass' | 'fail'
      // CHG-93：同时记下「谁执行的 / 是否人工强制放行」——面板据此显示 badge（否则账本有、界面无）
      t.gateResults = { ...(t.gateResults ?? {}) }
      t.gateResults[p.gate] = {
        verdict: p.verdict as 'pass' | 'fail',
        ...(typeof p.executedBy === 'string' ? { executedBy: p.executedBy } : {}),
        ...(typeof p.forcedBy === 'string' ? { forcedBy: p.forcedBy } : {}),
        ...(typeof p.exitCode === 'number' || p.exitCode === null ? { exitCode: p.exitCode as number | null } : {}),
        at: event.ts,
      }
      // CHG-87（FR-5.4）：scope 审计结论随门禁结果落投影（看板徽标 / 详情审计块的唯一来源）
      applyScopeAudit(t, p.scopeAudit)
      if (p.verdict === 'pass') {
        // gate 链按任务配置推进（FR-10.3 通用性）
        const current = `gate:${p.gate}`
        if (t.state !== current) throw new FoldError(`gate result "${p.gate}" but task is ${t.state}`, event.seq)
        transition(t, gateAdvance(p.gate, t.gates), event.seq)
        // 到达 done（最后一个 gate 过）→ 依赖解锁重算（T17 场景2）
        if (t.state === 'done') advanceDependents(proj, event.ts)
      } else {
        // CHG-86（FR-5.2 打回预算 + repair 回流）：fail 累计本门打回轮数，并**把任务放回调度队列**。
        // 旧实现只留在 gate 态、没有任何修复路径——打回一次任务就永久卡死（既不能重 claim，
        // 也没有合法转移能离开 gate:*）。现在 fail → ready：实现者修复后重新 claim → 提交 done →
        // 再次进入同一道门（复验），打回轮数在 `gateRejects` 上跨轮累计。
        // 依赖方不解锁（advanceDependents 只在 done 时跑），语义不变。
        // 只认当前门禁的 fail——对已过的门补录 fail 不计数（否则历史门禁可被反复刷预算）。
        if (t.state === `gate:${p.gate}`) {
          t.gateRejects = { ...(t.gateRejects ?? {}) }
          t.gateRejects[p.gate] = (t.gateRejects[p.gate] ?? 0) + 1
          // 本次 attempt 已结束（申报过 done 才会到门禁态）——不清掉的话回到 ready 也领不走
          // （canClaim 的 "task already has an active attempt" 判定）
          t.attemptId = undefined
          transition(t, 'ready', event.seq)
          t.waitingSince = event.ts
        }
      }
      break
    }
    case 'task.deliverable': {
      const t = requireTask(proj, p.taskId, event.seq)
      t.deliverables.push({ path: p.path, seq: event.seq })
      break
    }
    case 'task.failed': {
      const t = requireTask(proj, p.taskId, event.seq)
      transition(t, 'failed', event.seq)
      t.attemptId = undefined
      releaseMember(proj, t)
      break
    }
    /*
     * CHG-207（P1-8）：**blocked = 停下等人**（不是终态）。
     *
     * 与 `task.failed` 的区别：failed 的合法后继是空集（重放后永不复活，只能人重建任务）；
     * blocked 的后继是 `ready / backlog / cancelled`——人工用 `myteam_rescope_task` 放行后任务能回去重跑。
     * 修复前**没有任何事件能写 blocked**：状态机里有这个状态、有迁移边、看板也统计它，
     * 实际永远是 0（解散文案承诺的「未完成任务转 blocked」从未发生）。
     */
    case 'task.blocked': {
      const t = requireTask(proj, p.taskId, event.seq)
      transition(t, 'blocked', event.seq)
      t.attemptId = undefined
      t.blockedAt = event.ts
      t.blockedReason = String(p.reason ?? '')
      releaseMember(proj, t)
      break
    }
    case 'task.escalated': {
      const t = requireTask(proj, p.taskId, event.seq)
      transition(t, 're-scoping', event.seq)
      t.escalateCount = Number(p.count ?? t.escalateCount + 1)
      t.attemptId = undefined // attempt 撤销（FR-11.7 立即生效）
      releaseMember(proj, t)
      proj.inbox.push({ seq: event.seq, kind: 'escalate' })
      break
    }
    case 'task.rescoped': {
      const t = requireTask(proj, p.taskId, event.seq)
      const patch = (p.patch as Record<string, unknown>) ?? {}
      applyEditWithDiff(t, patch, event.ts)
      // CHG-73：重新规划 = 带着新定义重新排队——依赖都完成了才是 ready，否则回 backlog 等上游
      const depsDone = t.input.deps.every((dep) => proj.tasks[dep]?.state === 'done')
      const target: TaskState = depsDone ? 'ready' : 'backlog'
      transition(t, target, event.seq)
      if (target === 'ready') t.waitingSince = event.ts
      t.rescopeCount = (t.rescopeCount ?? 0) + 1
      break
    }
    /* CHG-73：取消任务（终态）。下游策略由写入端决定是否级联（级联 = 独立事件，可逐条审计） */
    case 'task.cancelled': {
      const t = requireTask(proj, p.taskId, event.seq)
      transition(t, 'cancelled', event.seq)
      t.attemptId = undefined
      t.cancelledAt = event.ts
      t.cancelReason = String(p.reason ?? '')
      t.cancelDownstream = p.downstream === 'cancel' ? 'cancel' : p.downstream === 'rewire' ? 'rewire' : 'leave'
      releaseMember(proj, t)
      break
    }
    /*
     * CHG-202x（P0-1）：**删除任务**（产品定案「任务不能手动建，但可以手动删除」）。
     *
     * 与 `task.cancelled` 的区别：cancel 是**终态**（任务仍在看板「已取消」列、下游仍挂着它，
     * 只能靠 rewire 解开）；delete 是**把任务从投影里去掉**（误建任务的清理出口）。
     * 为了让下游不永久死锁，删除时把它的 id 从其它任务的 deps 里摘掉，并补一次
     * backlog→ready 判定（与 task.rewired 同口径）。
     * 账本只追加不删行：历史事件全部保留，投影才是「当前样子」。
     */
    case 'task.deleted': {
      const t = proj.tasks[p.taskId]
      if (t) releaseMember(proj, t)
      delete proj.tasks[p.taskId]
      delete proj.participations[p.taskId]
      delete proj.perTaskMessages[p.taskId]
      for (const [proposalId, proposal] of Object.entries(proj.proposals)) {
        if (proposal.taskId === p.taskId) delete proj.proposals[proposalId]
      }
      for (const other of Object.values(proj.tasks)) {
        const deps = other.input.deps ?? []
        if (!deps.includes(p.taskId)) continue
        other.input.deps = deps.filter((dep) => dep !== p.taskId)
        other.rewiredFrom = { removed: p.taskId, ts: event.ts }
        if (other.state === 'backlog' && other.input.deps.every((dep) => proj.tasks[dep]?.state === 'done')) {
          other.state = 'ready'
          other.waitingSince = event.ts
        }
      }
      break
    }
    /* CHG-75：下游改挂——把 deps 里的 removed 换成 added（added 缺省 = 解除依赖，变独立任务）。
     * 只改依赖，不动状态机 / attempt / 证据。 */
    case 'task.rewired': {
      const t = requireTask(proj, p.taskId, event.seq)
      const removed = String(p.removed ?? '')
      const added = p.added === undefined || p.added === null || p.added === '' ? undefined : String(p.added)
      const deps = (t.input.deps ?? []).filter((dep) => dep !== removed)
      if (added && !deps.includes(added)) deps.push(added)
      t.input.deps = deps
      t.rewiredFrom = { removed, ...(added ? { added } : {}), ts: event.ts }
      t.lastEditAt = event.ts
      // 解除依赖后该任务可能已经"无待完成依赖"——补一次 backlog→ready 的判定
      // （否则它会一直躺在待规划列里，claim 口径与看板列不一致）
      if (t.state === 'backlog' && deps.every((dep) => proj.tasks[dep]?.state === 'done')) {
        t.state = 'ready'
        t.waitingSince = event.ts
      }
      break
    }
    /* CHG-70：任务元数据编辑（不改变状态；只在账本追加一条可重放的更新） */
    case 'task.updated': {
      const t = requireTask(proj, p.taskId, event.seq)
      applyEditWithDiff(t, (p.patch as Record<string, unknown>) ?? {}, event.ts)
      break
    }
    /* CHG-70：团队名 / 目标编辑（团队信息卡与索引一起刷新） */
    case 'team.updated': {
      if (typeof p.name === 'string') proj.name = p.name
      if (typeof p.goal === 'string') proj.goal = p.goal
      break
    }
    case 'task.proposal': {
      proj.proposals[p.proposalId] = {
        taskId: p.taskId,
        type: p.type,
        payload: (p.payload as Record<string, unknown>) ?? {},
        status: 'proposed',
      }
      break
    }
    case 'task.proposal.resolved': {
      const pr = proj.proposals[p.proposalId]
      if (pr) pr.status = p.decision === 'approved' ? 'approved' : 'rejected'
      break
    }
    case 'message.sent': {
      const taskId = p.taskId as string | undefined
      if (taskId && proj.tasks[taskId]) {
        ;(proj.perTaskMessages[taskId] ??= []).push(event.seq)
      }
      if (p.to === 'inbox') proj.inbox.push({ seq: event.seq, kind: 'message' })
      break
    }
    case 'message.consumed': {
      break
    }
    case 'plan.clarify':
    case 'plan.revised':
    case 'member.interrupted':
    case 'rules.version.adopted': {
      // clarify 轮次在账本可查（统计面消费）；投影不承载
      break
    }
    default:
      // 未识别类型：跳过（前向兼容）
      break
  }
  proj.revision += 1
  void MESSAGE_TYPES
}

function requireTask(proj: TeamProjection, taskId: string, seq: number): TaskProjection {
  const t = proj.tasks[taskId]
  if (!t) throw new FoldError(`task "${taskId}" not yet created`, seq)
  return t
}

/**
 * CHG-70：任务元数据补丁（白名单合并）。用于 task.updated / task.rescoped。
 * 只合并任务输入面字段；状态 / attempt / 证据 / 门禁裁决不在补丁面（由状态机与证据链拥有）。
 * gateChain 变更时同步 t.gates（当前门禁链 = 新链；已过门的裁决保留，供审计追溯）。
 */
function applyTaskPatch(t: TaskProjection, patch: Record<string, unknown>): void {
  if (typeof patch.title === 'string') t.input.title = patch.title
  if (typeof patch.description === 'string') t.input.description = patch.description
  if (Array.isArray(patch.acceptanceCriteria)) {
    t.input.acceptanceCriteria = (patch.acceptanceCriteria as unknown[]).map(String)
  }
  if (patch.deliverableSpec && typeof patch.deliverableSpec === 'object') {
    t.input.deliverableSpec = patch.deliverableSpec as TaskProjection['input']['deliverableSpec']
  }
  if (Array.isArray(patch.deps)) t.input.deps = (patch.deps as unknown[]).map(String)
  if (typeof patch.requiredRole === 'string') t.input.requiredRole = patch.requiredRole
  if (typeof patch.taskType === 'string') t.input.taskType = patch.taskType
  if (Array.isArray(patch.gateChain)) {
    const chain = (patch.gateChain as unknown[]).map(String).filter((gate) => gate.length > 0)
    t.input.gateChain = chain
    t.gates = chain
  }
  if (typeof patch.priority === 'string') t.input.priority = patch.priority as TaskProjection['input']['priority']
  if (typeof patch.estimate === 'string') t.input.estimate = patch.estimate as TaskProjection['input']['estimate']
  if (Array.isArray(patch.tags)) t.input.tags = (patch.tags as unknown[]).map(String)
  // CHG-87（FR-5.4/FR-5.3）：可写范围与 command 门禁命令也是任务定义的一部分（可编辑）
  if (Array.isArray(patch.writeScopes)) t.input.writeScopes = (patch.writeScopes as unknown[]).map(String)
  if (patch.verifyCommand && typeof patch.verifyCommand === 'object') {
    t.input.verifyCommand = patch.verifyCommand as TaskProjection['input']['verifyCommand']
  }
}

/**
 * CHG-73：应用编辑补丁 + 记录改动与证据过期（task.updated / task.rescoped 共用）。
 *  - changes 由补丁前后值算出（不信任账本里的 changes 字段——重放要能自证）；
 *  - 结构性字段改动且此前已有证据 → evidenceStale（UI 提示"证据已过期，建议重规划"）；
 *  - lastEditAt 供详情页「改动记录」与看板「最近编辑」排序。
 */
function applyEditWithDiff(t: TaskProjection, patch: Record<string, unknown>, ts: number): FieldChange[] {
  const before = { ...(t.input as unknown as Record<string, unknown>) }
  const changes = diffTaskInput(before, patch)
  applyTaskPatch(t, patch)
  t.lastEditAt = ts
  const structural = structuralFieldsOf(changes)
  if (structural.length > 0 && t.evidenceRefs.length > 0) {
    t.evidenceStale = { since: ts, fields: structural }
  }
  return changes
}

/** 任务离开 in_progress 态（完成/失败/escalate/revoke）时释放成员当前任务 */
function releaseMember(proj: TeamProjection, t: TaskProjection): void {  const m = t.assignee ? proj.members[t.assignee] : undefined
  if (m && m.currentTaskId === t.id) m.currentTaskId = undefined
}

/**
 * CHG-87（FR-5.4）：把 scope 审计载荷折叠进投影。
 * 载荷来自 host 侧纯函数 `auditWriteScopes` 的返回；重放时按账本原样恢复
 * （不做二次计算——审计时刻的 writeScopes 可能与当前不同，重算会篡改历史结论）。
 * 形状不符（旧账本 / 手工事件）→ 静默跳过，不让整个折叠崩掉。
 */
function applyScopeAudit(t: TaskProjection, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const audit = raw as Record<string, unknown>
  const toList = (value: unknown): string[] => (Array.isArray(value) ? (value as unknown[]).map(String) : [])
  t.scopeAudit = {
    declared: toList(audit.declared),
    writeScopes: toList(audit.writeScopes),
    outOfScope: toList(audit.outOfScope),
    ok: audit.ok !== false,
    checkedAt: typeof audit.checkedAt === 'number' ? audit.checkedAt : 0,
  }
}

/**
 * 依赖解锁重算（T17 场景2 补）：某任务进入 done 后，deps 全 done 的 backlog 任务推进 ready。
 * 只动 backlog（ready/in_progress 不回退）；waitingSince 记 FIFO 起始（NFR-7.1——
 * 解锁不唤醒成员，成员经 wait_for_change 失效提示重新 list_tasks）。
 */
function advanceDependents(proj: TeamProjection, ts: number): void {
  for (const t of Object.values(proj.tasks)) {
    if (t.state !== 'backlog') continue
    const depsDone = t.input.deps.every((d) => proj.tasks[d]?.state === 'done')
    if (depsDone) {
      t.state = 'ready'
      t.waitingSince = ts
    }
  }
}

function transition(t: TaskProjection, to: TaskState, seq: number): void {
  if (t.state === to) return
  // CHG-71：门禁链的最后一道不一定是 archive——任意 gate:* 的最后一道 pass 后都直接 done
  // （旧实现只允许 gate:archive → done，自定义单门链 ['review'] 会卡在 gate:review）
  const gateToDone = to === 'done' && t.state.startsWith('gate:')
  if (!gateToDone && !isLegalTransition(t.state, to)) {
    throw new FoldError(`illegal transition ${t.state} → ${to}`, seq)
  }
  t.state = to
}
