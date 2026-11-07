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
          deliverableSpec: task.deliverableSpec as TaskProjection['input']['deliverableSpec'],
          deps: (task.deps as string[]) ?? [],
          requiredRole: String(task.requiredRole ?? ''),
          taskType: task.taskType as string | undefined,
          gateChain: (task.gateChain as string[]) ?? [],
          priority: (task.priority as TaskProjection['input']['priority']) ?? 'P2',
          estimate: task.estimate as TaskProjection['input']['estimate'],
          tags: (task.tags as string[]) ?? undefined,
          // CHG-87（FR-5.4/FR-5.3）：scope 审计范围 + command 门禁命令
          writeScopes: Array.isArray(task.writeScopes) ? (task.writeScopes as unknown[]).map(String) : undefined,
          verifyCommand: (task.verifyCommand as TaskProjection['input']['verifyCommand']) ?? undefined,
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
      if (proj.members[p.memberId]) proj.members[p.memberId].currentTaskId = p.taskId
      break
    }
    case 'task.assigned': {
      const t = requireTask(proj, p.taskId, event.seq)
      const ids = Array.isArray(p.memberIds) ? (p.memberIds as unknown[]).map(String) : []
      t.assignee = p.memberId
      t.assignees = ids.length > 0 ? ids : [String(p.memberId)]
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
export function applyTaskPatch(t: TaskProjection, patch: Record<string, unknown>): void {
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
export function applyEditWithDiff(t: TaskProjection, patch: Record<string, unknown>, ts: number): FieldChange[] {
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
