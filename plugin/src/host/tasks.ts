/**
 * CHG-186（T155b）：任务族端点适配层。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/tasks/**`、`core/scheduler/**`、`core/gates/**`，装配与状态在 `host.ts`。
 * 方法体**逐字搬自** `host.ts` 的 `switch (toolName)` 里对应 case，允许的差异只有：
 *   ① `this.` → `host.`（宿主面，见下）；
 *   ② `this.memberHandles.get(id)` → `host.memberHandle(id)`（私有字段不外露）；
 *   ③ `this.workspaceRoot` → `host.workspaceRoot()`（**惰性 getter**，不能在装配处取值快照）。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 为什么分两个工厂（lead / member）────────────────────────────────────────────
 * 任务族的 17 个端点横跨**两个通道**：`executeLeadTool`（队长侧：建/编辑/裁决/重规划/
 * 取消/批量/重派撤权）与 `executeMemberToolInner`（成员侧：读/领/申报/协作）。两边
 * 拿到的上下文不同（`actor` 一个是 `'lead' | 'human'`，一个是 `member:<id>`），返回
 * 口径也不同（成员通道有护栏包一层）。合在一个工厂里只能靠 `any` 蒙，所以拆成两个。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖一堆 `MyTeamHost` 的**私有**成员（`rescopeTask` / `scopeAuditFor` /
 * `captureArtifactBaseline` …），而 TS 的私有成员不参与结构化赋值。两条路：把私有方法
 * 改成 public（扩大入口层 API，和「入口层只留装配」相反），或者 `as` 强转（改名后编译器
 * 抓不到）。这里选第三条：host.ts 传一个**只含用到的成员**的闭包对象进来——私有方法名
 * 一改，装配处立刻编译报错。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────────
 * 计划里的骨架写的是 `async spawn(args)`，但原 case 是**同步返回**（`executeLeadTool`
 * 的返回类型是 `Record | Promise<Record>`）。给方法加 `async` 会让原本同步的结果变成
 * Promise——调用方（`test/`、面板远程面）就地拿到 `[object Promise]`。所以保持同步：
 * 只有本来就返回 Promise 的（`reviewTask` / `waitForChange`）才带 Promise。
 */
import type { CommitDraft, TeamService } from '../core/service.ts'
import type { MemberInstance } from '../core/members/member-setup.ts'
import type { ScopeAudit } from '../core/gates/scope-audit.ts'
import type { ArtifactBaseline } from '../core/gates/artifact-freshness.ts'
import { diffTaskInput } from '../core/tasks/diff.ts'
// CHG-159（报告 A6）：领取前的写范围闸门（纯函数；与 scope-audit/waves 同一套路径语义）
import { claimScopeVerdict } from '../core/scheduler/waves.ts'
import {
  candidatesForDraft,
  knowledgeDirOf,
  listKnowledge,
  touchStale,
  validateDraft,
  writeKnowledgeEntry,
  type KnowledgeDraft,
} from '../core/knowledge/knowledge.ts'
import { parseEvidencePointer } from '../core/knowledge/evidence-pointer.ts'

/**
 * 防御属性读取（JSON 面收窄）。与 `host.ts` 里那份**同形**（本仓已有同样的一行式
 * 副本：`core/config/team-config.ts`、`core/contributions/parse.ts`）——纯函数、无状态，
 * 为一个判断开一条宿主面反而更难读。
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 队长侧任务族的宿主面（**只列用到的成员**） */
export interface TasksHostSurface {
  /** 按 teamId 取 TeamService（惰性创建 + 冷启动重放恢复 + 首次 bootstrap；**幂等缓存**） */
  service(teamId: string): TeamService

  /** 统一提交入口（成功后触发唤醒） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>

  /** QA-4：带 `expectedRevision` 的提交入口（乐观锁收敛到 host，不散落在每个 case 里） */
  commitGuarded(
    teamId: string,
    args: Record<string, unknown>,
    draft: Omit<CommitDraft, 'expectedRevision'>,
  ): ReturnType<TeamService['commit']>

  /** CHG-55：任务类型 → 门禁链展开（团队模板 taskTypes 生效） */
  taskWithGateChain(teamId: string, task: Record<string, unknown>): Record<string, unknown>

  /** CHG-73（FR-29）：一次写入负责队员与参与团队（assignees / participants） */
  applyTaskRelations(teamId: string, taskId: string, args: Record<string, unknown>, actor: string): Record<string, unknown>

  /** CHG-73：一键重新规划（撤 attempt → 回 ready/backlog → 可选重派） */
  rescopeTask(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown>

  /** CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口（**可能异步**：archive gate 要跑校验命令） */
  reviewTask(
    teamId: string,
    args: Record<string, unknown>,
    actor: string,
  ): Record<string, unknown> | Promise<Record<string, unknown>>

  /** CHG-73：取消（下游依赖按 `downstream` 档处理） */
  cancelTask(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown>

  /** CHG-73：批量编排（cancel / rescope / assign / priority） */
  batchTaskOp(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown>

  /** CHG-76：批量建任务（从目标出草稿 → 预览 → 一次创建） */
  createTasksBatch(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown>
}

export function createTasksHandlers(host: TasksHostSurface) {
  return {
    /** `myteam_create_task`：taskId 由 host 分配（重放幂等） */
    create(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      // taskId 由 host 分配（契约 docs/04 §1.1）；取投影中 task-N 最大 N + 1（重放幂等）
      const proj0 = host.service(teamId).projectionSnapshot.tasks
      let maxN = 0
      for (const id of Object.keys(proj0)) {
        const m = /^task-(\d+)$/.exec(id)
        if (m) maxN = Math.max(maxN, Number(m[1]))
      }
      const taskId = args.taskId ? String(args.taskId) : `task-${maxN + 1}`
      const r = host.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: host.taskWithGateChain(teamId, (args.task ?? {}) as Record<string, unknown>) } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      // CHG-73（FR-29）：一次写入负责队员与参与团队——创建任务时人已经知道"谁做/谁协作"，
      // 不该让面板/队长再串三次调用（部分失败不撤销任务本身，按 warnings 显性化）
      const created = host.applyTaskRelations(teamId, taskId, args, actor)
      return { status: 'created', taskId, ...created }
    },

    /* CHG-86（P0-4）：队长侧工具改名 myteam_edit_task（原 myteam_update_task 与成员作用域重名，
     * 同名跨层注册时解析顺序决定谁生效——若队长侧生效，成员可绕过 attemptId 校验改任务结构） */
    /** `myteam_edit_task`：普通编辑（补丁合并）或 `rescope` 一键重规划 */
    edit(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const taskIdArg = String(args.taskId ?? '')
      const patch = (isPlainObject(args.patch) ? args.patch : {}) as Record<string, unknown>
      const rescope = args.rescope as { reason?: string } | undefined
      // CHG-73：rescope 走统一的"一键重新规划"管线（撤 attempt → 回 ready/backlog → 可选重派）
      if (rescope) {
        return host.rescopeTask(teamId, { teamId, taskId: taskIdArg, reason: rescope.reason, patch, memberIds: args.memberIds }, actor)
      }
      // CHG-70：普通编辑走 task.updated（补丁合并，**不改状态/attempt/证据**）；
      // CHG-73：把字段级 diff 一起落账——详情页「改动记录」与证据过期判定都读它
      const task = host.service(teamId).projectionSnapshot.tasks[taskIdArg]
      const changes = task ? diffTaskInput(task.input as unknown as Record<string, unknown>, patch) : []
      const r = host.commitGuarded(teamId, args, { actor, type: 'task.updated', payload: { teamId, taskId: taskIdArg, patch, changes } })
      return r.ok
        ? { status: 'updated', taskId: taskIdArg, changes }
        : { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
    },

    /* CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口——修复前无任何入口能提交 task.gate.result，
     * 默认链 ['review','archive'] 下任务 done 后停在 gate:review 永远到不了 done。 */
    /** `myteam_review_task`：门禁裁决（pass / fail） */
    review(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> | Promise<Record<string, unknown>> {
      return host.reviewTask(teamId, args, actor)
    },

    /* ── CHG-73：执行期编辑闭环（重规划 / 取消 / 批量编排 / 角色删除）── */
    /** `myteam_rescope_task` */
    rescope(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      return host.rescopeTask(teamId, args, actor)
    },

    /** `myteam_cancel_task` */
    cancel(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      return host.cancelTask(teamId, args, actor)
    },

    /** `myteam_batch_task_op` */
    batchOp(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      return host.batchTaskOp(teamId, args, actor)
    },

    /* ── CHG-76：批量建任务（从目标出草稿 → 预览 → 一次创建）── */
    /** `myteam_create_tasks` */
    createBatch(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      return host.createTasksBatch(teamId, args, actor)
    },

    /**
     * `myteam_reassign_task` / `myteam_revoke_attempt`：两个工具**共用**一段实现，
     * 由 `name` 分叉（`reassign: true` + 交接票据 vs `parkedAttempts` 留痕）。
     */
    revokeOrReassign(name: string, teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const svc = host.service(teamId)
      const proj = svc.projectionSnapshot
      const task = proj.tasks[String(args.taskId)]
      const prevAttempt = task?.attemptId
      // CHG-158（报告 A5）：撤权 vs 重派要分开表达——
      //  - 重派（`myteam_reassign_task`）= **交接**：`reassign: true` + 交接票据（旧持有人排空、
      //    新 attempt 接手），fold 置 `reassigning` 并记票据；
      //  - 撤权（`myteam_revoke_attempt`）= **停放**：fold 把 `{attemptId: reason}` 并入
      //    `parkedAttempts`（每次撤销都留痕，供恢复/看板回答「这个 attempt 为什么停」）。
      // 票据由**写入方**生成（值随事件落账 → 重放读到同一个值，确定）：显式传就用调用方给的
      // （会话移交返回的 ticket），否则发一个不透明票号。
      const reassign = name === 'myteam_reassign_task'
      const handoffId = typeof args.handoffId === 'string' && args.handoffId.trim().length > 0
        ? args.handoffId.trim()
        : `ho-${prevAttempt ?? 'none'}-${Date.now()}`
      const r1 = host.commitGuarded(teamId, args, {
        actor,
        type: 'task.attempt.revoked',
        payload: {
          teamId,
          taskId: args.taskId,
          attemptId: prevAttempt ?? 'none',
          reason: args.reason,
          prevAssignee: task?.assignee,
          ...(reassign ? { reassign: true, handoffId } : {}),
        },
      })
      if (!r1.ok) {
        return { status: 'error', code: r1.code, message: r1.message, ...(r1.currentRevision !== undefined ? { currentRevision: r1.currentRevision } : {}) }
      }
      if (name === 'myteam_reassign_task') {
        // CHG-87（QA-4）：重派也吃乐观锁（先撤 attempt 再指派，冲突时两步都不落账）
        const r2 = host.commitGuarded(teamId, args, { actor, type: 'task.assigned', payload: { teamId, taskId: args.taskId, memberId: args.toMemberId } })
        return r2.ok
          ? { status: 'reassigned', note: '等待目标成员 claim（原子 claim 语义保留）' }
          : { status: 'error', code: r2.code, message: r2.message, ...(r2.currentRevision !== undefined ? { currentRevision: r2.currentRevision } : {}) }
      }
      return { status: 'revoked' }
    },
  }
}

/** 成员侧任务族的宿主面（**只列用到的成员**） */
export interface MemberTasksHostSurface {
  /** 按 teamId 取 TeamService（**幂等缓存**：与 `executeMemberToolInner` 里那个 `svc` 同一实例） */
  service(teamId: string): TeamService

  /** 统一提交入口（成功后触发唤醒） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>

  /** P1-1：阶段起点拍产物基线（claim / 进度申报两个挂点） */
  captureArtifactBaseline(teamId: string, taskId: string): ArtifactBaseline

  /** CHG-87（FR-5.4）：完成时 scope 审计（越界只留痕不阻断） */
  scopeAuditFor(teamId: string, taskId: string): ScopeAudit | undefined

  /** FIX-10 + CHG-86：archive gate 落位校验（三级信号 → 通过 / 转人工 / 不通过） */
  evaluateArchiveGate(
    teamId: string,
    taskId: string,
    actor: string,
    declaredPaths?: string[],
  ): { pass: boolean; note: string; reason?: string; needsHuman?: boolean }

  /** T21（FR-6.2）：任务收口后的成员记忆审计（违规落 memory.audit；不阻塞主流程） */
  auditMemberMemory(teamId: string, memberId: string, taskId?: string): { violations: number; checkedFiles: number } | null

  /** 成员侧等待：与 Lead 侧同一异步长轮询实现（工具 execute 返回 Promise，宿主管线 await 之） */
  waitForChange(args: Record<string, unknown>): Promise<Record<string, unknown>>

  /** FIX-12：`agents.create` 返回形状未实证——双形状兼容 */
  agentOf(handle: unknown): { followup?: (msg: unknown) => void; cancel?: (o: unknown) => void } | undefined

  /** 成员句柄（`memberHandles` 私有字段的只读取值口） */
  memberHandle(memberId: string): unknown

  /** FIX-16：followup 消息必须带标识（裸 {content,source} 会建空 turn） */
  followupMessage(text: string): Record<string, unknown>

  /**
   * 项目根。**方法而不是属性**：它是惰性解析的 getter（首次访问才 `resolveProjectRoot` 并
   * 落 warn/info 日志），在装配处取属性值等于把解析时机提前到 host 构造期——日志顺序会变。
   */
  workspaceRoot(): string
}

export function createMemberTaskHandlers(host: MemberTasksHostSurface) {
  return {
    /** `myteam_get_task`：修订后 attemptId 只发给当前持有人 */
    get(teamId: string, member: MemberInstance, args: Record<string, unknown>, _actor: string): Record<string, unknown> {
      const svc = host.service(teamId)
      const t = svc.projectionSnapshot.tasks[String(args.taskId)]
      if (!t) return { status: 'error', code: 'MT_VALIDATION', message: `task "${args.taskId}" not found` }
      // 修订：attemptId 只发给当前持有人（原实现 t.attemptId === t.attemptId 恒真，泄漏给任意成员）
      const ownAttempt = t.assignee === member.memberId ? t.attemptId : undefined
      return { status: 'ok', task: { id: t.id, title: t.input.title, description: t.input.description, acceptanceCriteria: t.input.acceptanceCriteria, deliverableSpec: t.input.deliverableSpec, deps: t.input.deps, requiredRole: t.input.requiredRole, priority: t.input.priority, state: t.state, attemptId: ownAttempt, escalateCount: t.escalateCount } }
    },

    /** `myteam_list_tasks`：返回行数 ≠ 已读全部内容（NFR-7.6） */
    list(teamId: string, member: MemberInstance, args: Record<string, unknown>, _actor: string): Record<string, unknown> {
      const svc = host.service(teamId)
      const filter = String(args.filter ?? 'claimable')
      const limit = Number(args.limit ?? 20)
      const proj = svc.projectionSnapshot
      let tasks = Object.values(proj.tasks)
      if (filter === 'claimable') {
        tasks = svc.claimableTasks(member.roleId)
      } else if (filter === 'mine') {
        tasks = tasks.filter((t) => t.assignee === member.memberId && !['done', 'failed', 'cancelled'].includes(t.state))
      }
      const rows = tasks.slice(0, limit).map((t) => ({ id: t.id, title: t.input.title, state: t.state, priority: t.input.priority, requiredRole: t.input.requiredRole }))
      return { status: 'ok', tasks: rows, returnedCount: rows.length, note: `返回 ${rows.length} 行 ≠ 已读全部内容（NFR-7.6）` }
    },

    /** `myteam_claim_task`：先过写范围闸门，再原子 claim（世代号由 host 算） */
    claim(teamId: string, member: MemberInstance, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const svc = host.service(teamId)
      const claimTaskId = String(args.taskId)
      const claimProj = svc.projectionSnapshot
      const claimTarget = claimProj.tasks[claimTaskId]
      // CHG-159（报告 A6）：**领取前的写范围闸门**——两个任务 writeScopes 有交集时必须串行。
      // 为什么必须在这里拦：claim 抢占只解决「同一任务被两个人领」，解决不了「两个不同任务
      // 改同一批文件」；scope-audit 只在完成时事后留痕，不拦截，于是后写静默覆盖先写。
      // 职责边界：依赖「上游未完成」不归这里管（service 层 canClaim 已判），这里只判写范围。
      // 放行条件：任一方未声明 writeScopes（未声明 = 不参与串行，否则存量团队全部死锁）。
      if (claimTarget) {
        const scopeVerdict = claimScopeVerdict(claimProj, claimTaskId)
        if (!scopeVerdict.ok) return { status: 'error', code: scopeVerdict.code, message: scopeVerdict.message }
      }
      // CHG-158（报告 A5）：世代号由 **host** 按「上一世代 + 1」算好塞进 payload——fold 只赋值，
      // 绝不自增/生成（同一本账本两次重放必须得出同一投影）。
      const previousGeneration = Number.isInteger(claimTarget?.attempt) ? Number(claimTarget?.attempt) : 0
      // 交接票据：由**会话移交**写入方给（`myteam_handoff` 按设计不写团队账本——见 handoffTeam
      // 的纪律 ②，所以票据只能由承接方在 claim 时带进来）。缺省不带：只有真的做过移交才落账。
      // 注意 payload 与投影的区别：账本里的 `handoffId` 是「这次 claim 承接了哪次移交」的
      // **审计留痕**；投影的 `handoffId` 是「待落地」槽位（`attemptPhase` ③ 的 handoff 态），
      // 由 claim 本身清除——保留会让正在执行的任务永远显示「交接中」。
      const handoffTicket = typeof args.handoffId === 'string' && args.handoffId.trim().length > 0 ? args.handoffId.trim() : undefined
      const r = host.commit(teamId, {
        actor,
        type: 'task.claimed',
        payload: {
          teamId,
          taskId: args.taskId,
          memberId: member.memberId,
          attemptId: `at-${Date.now()}`,
          attempt: previousGeneration + 1,
          ...(handoffTicket ? { handoffId: handoffTicket } : {}),
        },
      })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      const t = svc.projectionSnapshot.tasks[String(args.taskId)]
      // P1-1 接线：claim 成功 = 任务进入 in_progress = **阶段起点**，在这里拍产物基线。
      // 拍完之后「产物指纹变了」才等于「本阶段真的写过它」（否则上游越界写的文件会被当交付）。
      host.captureArtifactBaseline(teamId, String(args.taskId))
      return { status: 'claimed', attemptId: t.attemptId, task: { id: t.id, title: t.input.title, acceptanceCriteria: t.input.acceptanceCriteria, deliverableSpec: t.input.deliverableSpec } }
    },

    /** `myteam_update_task`：进度 / 完成 / 失败申报（含证据、scope 审计、门禁落位、知识提案） */
    update(teamId: string, member: MemberInstance, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const svc = host.service(teamId)
      const status = String(args.status)
      const attemptId = String(args.attemptId)
      const taskId = String(args.taskId)
      const eventType = status === 'in_progress' ? 'task.progress' : status === 'done' ? 'task.completed' : 'task.failed'
      const payload: Record<string, unknown> = { teamId, taskId, attemptId }
      if (status === 'in_progress') payload.progress = args.progress
      if (status === 'done') payload.summary = args.summary
      if (status === 'failed') { payload.reason = args.reason; payload.summary = args.summary }
      if (args.evidence) payload.evidence = args.evidence
      // 证据块先落存证（FR-5.0：completed 前必须有同 attemptId 的 task.evidence 事件）
      if (status === 'done' && args.evidence) {
        const ev = host.commit(teamId, { actor, type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: args.evidence } })
        if (!ev.ok) return { status: 'error', code: ev.code, message: ev.message }
      }
      // CHG-87（FR-5.4）：完成时 scope 审计——证据块申报的文件 × 任务声明的 writeScopes。
      // 必须在上面 task.evidence 落账**之后**算（审计输入就是那条证据事件）。
      // 越界只留痕不阻断（FR-5.4「诚实声明不拦截 bash」）。
      if (status === 'done') {
        const scopeAudit = host.scopeAuditFor(teamId, taskId)
        if (scopeAudit) payload.scopeAudit = scopeAudit
      }
      const r = host.commit(teamId, { actor, type: eventType as CommitDraft['type'], payload })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      // P1-1 接线：`in_progress` 申报 = 阶段仍在进行，补拍基线（只补缺失键——
      // 首次基线固定，见 captureArtifactBaseline 的注释）。
      if (status === 'in_progress') host.captureArtifactBaseline(teamId, taskId)
      // FIX-10（KI-2 实弹）+ CHG-86：archive gate 落位校验接线。
      // 修复前的断链：这里只判 `state === 'gate:archive'`，而默认门禁链是
      // `['review','archive']` —— 任务 done 后进的是 `gate:review`，条件永不成立；
      // 加上没有任何 Lead 工具/面板端点能提交 review 裁决，任务永远到不了 done。
      // 现在：门禁链第一道是 archive → host 立即落位校验；是 review/verify → 提示等队长裁决。
      let gateNote: string | undefined
      // P1-5：环境不可用 latch 让交付判定转人工——此时**不能**把申报当 completed 放行
      let gateNeedsHuman = false
      if (status === 'done') {
        const tAfter = svc.projectionSnapshot.tasks[taskId]
        const declared = (args.deliverablePaths as string[] | undefined) ?? []
        if (tAfter?.state === 'gate:archive') {
          const evaluated = host.evaluateArchiveGate(teamId, taskId, actor, declared)
          gateNote = evaluated.note || undefined
          gateNeedsHuman = evaluated.needsHuman === true
        } else if (tAfter?.state.startsWith('gate:')) {
          const gate = tAfter.state.slice('gate:'.length)
          gateNote = `已进入 gate:${gate}，等待队长裁决（myteam_review_task / 面板「门禁裁决」）`
        }
      }
      // 知识提案（FR-17.4）：done 时随申报 → knowledge.proposed（队长审）；
      // v2.7（M2-0c）：① 任务 tags 触达知识库条目 → staleSince 写入（staleness 提示，R27 缓解）
      // ② host 依提案 tags 匹配既有条目给候选（"自动找靶、人来定夺"），随 completed 非阻塞返回
      const draft = args.knowledgeDraft as KnowledgeDraft | undefined
      if (status === 'done' && draft) {
        const check = validateDraft({ ...draft, evidence: draft.evidence || taskId })
        if (!check.ok) {
          return { status: 'completed', knowledgeDraftError: `${check.code}: ${check.message}` }
        }
        const resolvedDraft = { ...draft, evidence: draft.evidence || taskId }
        // CHG-87（FR-16.4③）：跨会话引用留痕——证据指针是 `session:<id>` 时落一条
        // session.read 审计（边界：读取即留痕，不整段注入；成员默认不开放跨读，C5）
        const pointer = parseEvidencePointer(resolvedDraft.evidence)
        if (pointer.kind === 'session') {
          host.commit(teamId, {
            actor,
            type: 'session.read',
            payload: { teamId, sessionId: pointer.value, pointer: pointer.raw, by: member.memberId, taskId },
          })
        }
        const kbDir = knowledgeDirOf(host.workspaceRoot())
        const kbEntries = listKnowledge(kbDir)
        const now = new Date().toISOString()
        // staleness 触达：任务 input.tags × 条目 tags 交集 → staleSince=当天（结构性提示）
        const taskTags = svc.projectionSnapshot.tasks[taskId]?.input.tags ?? []
        const touched = touchStale(kbEntries, taskTags, now)
        for (const t of touched) writeKnowledgeEntry(kbDir, t)
        // 半自动巩固候选（FR-17.4）：仅提示，不改变提案流
        const candidates = candidatesForDraft(kbEntries, resolvedDraft.tags ?? [])
        host.commit(teamId, { actor, type: 'knowledge.proposed', payload: { teamId, draftId: draft.id, draft: resolvedDraft, proposedBy: member.memberId } })
        const knowledgeHint = candidates.length > 0
          ? `知识库存在 tags 相交条目，供队长复核时参考关系：${candidates.map((c) => `${c.id}(${c.shared.join('/')})`).join('、')}`
          : undefined
        return {
          status: gateNeedsHuman ? 'needs-human' : 'completed',
          ...(gateNeedsHuman ? { code: 'MT_ENV_UNAVAILABLE' } : {}),
          note: gateNote ?? '已进入门禁链；知识提案待队长审',
          ...(knowledgeHint ? { knowledgeHint } : {}),
          ...(touched.length > 0
            ? { staleMarked: touched.map((t) => t.id), note2: `任务主题触及 ${touched.length} 条知识条目，已标记待复核（staleSince=${now.slice(0, 10)}）` }
            : {}),
        }
      }
      // 记忆审计（T21：任务收口后扫描，违规落 memory.audit；R28：不阻塞主流程）
      const audit = host.auditMemberMemory(teamId, member.memberId, taskId)
      return {
        status: gateNeedsHuman ? 'needs-human' : status === 'done' ? 'completed' : status,
        ...(gateNeedsHuman ? { code: 'MT_ENV_UNAVAILABLE' } : {}),
        note: status === 'done' ? (gateNote ?? '已进入门禁链；知识提案（如有）待队长审') : undefined,
        ...(audit && audit.violations > 0
          ? { memoryAudit: { violations: audit.violations, note: '私有记忆存在无证据指针条目，已落账本 memory.audit（FR-6.2）' } }
          : {}),
      }
    },

    /** `myteam_peer_message`：成员 → 成员消息（落账后 followup 唤醒） */
    peerMessage(teamId: string, member: MemberInstance, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const r = host.commit(teamId, { actor, type: 'message.sent', payload: { teamId, messageId: `msg-${Date.now()}`, from: member.memberId, to: args.toMemberId, taskId: args.taskId, content: args.content } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      host.agentOf(host.memberHandle(String(args.toMemberId)))?.followup?.(host.followupMessage(`[myteam] 来自 ${member.instanceName} 的消息：${String(args.content)}`))
      return { status: 'sent' }
    },

    /** `myteam_wait_for_change`：长轮询（P2-1：把自己传进去，活跃 peer 判定要排除自己） */
    waitForChange(teamId: string, member: MemberInstance, args: Record<string, unknown>, _actor: string): Record<string, unknown> {
      // 成员侧等待：与 Lead 侧同一异步长轮询实现（工具 execute 返回 Promise，
      // 宿主工具管线 await 之；不再阻塞事件循环）。
      // P2-1：把「本人」传进去——活跃 peer 判定要排除自己（自己等自己必然空转）
      return host.waitForChange({ ...args, teamId, memberId: member.memberId }) as unknown as Record<string, unknown>
    },

    /** `myteam_propose_task_change`：提案进队长队列（FR-11.4：批准才生效） */
    propose(teamId: string, member: MemberInstance, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const proposalId = `prop-${Date.now()}`
      const r = host.commit(teamId, { actor, type: 'task.proposal', payload: { teamId, taskId: args.taskId, proposalId, type: args.type, payload: args.payload ?? {}, reason: args.reason, proposedBy: member.memberId } })
      return r.ok ? { status: 'proposed', proposalId, note: '提案进队长队列；批准才生效（FR-11.4）' } : { status: 'error', code: r.code, message: r.message }
    },

    /** `myteam_escalate_task`：升级到裁决面（FR-11.7；计数 >2 建议人工介入） */
    escalate(teamId: string, member: MemberInstance, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const svc2 = host.service(teamId)
      const t = svc2.projectionSnapshot.tasks[String(args.taskId)]
      const count = (t?.escalateCount ?? 0) + 1
      const r = host.commit(teamId, { actor, type: 'task.escalated', payload: { teamId, taskId: args.taskId, attemptId: args.attemptId ?? t?.attemptId, reason: args.reason, evidence: args.evidence, suggestion: args.suggestion, count } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      return { status: 'escalated', count, note: count > 2 ? 'escalate 计数 >2：裁决面建议人工介入（FR-11.7）' : '任务已入 re-scoping，等待队长裁决' }
    },
  }
}
