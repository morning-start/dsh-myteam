/**
 * T13 host 侧：MyTeam Remote service（ADR-006：面板读盘真相，写一律走账本）。
 *
 * 形态（T0 实证 dsh-plugin-manager 同型）：
 *  - extends TypertRemoteService（Cordis Service 基类，构造时绑定 typertRemote）
 *  - 方法用 Remote 装饰器标记 → Node strip-only 不支持装饰器语法，
 *    故手动写 marker（与 @deepseek-ai/dsh-typert-protocol mark() 产出的描述符同构：
 *    prototype["@deepseek-ai/dsh-typert-protocol/remote-methods"] = { version: 1, methods: [...] }）
 *  - 方法体全部委托 MyTeamHost（复用 TeamService 单写者管线与视图纯函数）
 *
 * 客户端调用路径：ctx.remote.myteam.<method>(args)（gateway 按 namespace=myteam 路由）。
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { readFileSync as _readFileSync } from 'node:fs'
import type { MyTeamHost } from '../host.ts'

const readFs = () => ({ readFileSync: _readFileSync })

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 最小 Cordis ctx 面：真 Cordis Context 直传；否则提供 reflect.provide 兼容（测试/降级宿主）。M2 门面（../panel.ts）复用 */
export function normalizeCtx(ctx: unknown): unknown {
  const anyCtx = ctx as Record<string, any> | undefined
  if (anyCtx?.reflect && typeof anyCtx.reflect.provide === 'function') return ctx
  const services = new Map<string, unknown>()
  const reflect = {
    provide(name: string, service: unknown) { services.set(name, service) },
  }
  return { ...(anyCtx ?? {}), reflect, [Symbol.for('myteam.mockCtx')]: services }
}

/** 手动标记 Remote 方法（等价 Remote 装饰器在 strip-only 环境的效果）。M2 门面（../panel.ts）复用 */
export function markRemoteMethods(prototype: object, methods: string[]): void {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
  })
}

export class MyTeamRemote extends TypertRemoteService {
  private host: MyTeamHost

  constructor(ctx: unknown, host: MyTeamHost) {
    // serviceKey/namespace = "myteam" → 客户端 ctx.remote.myteam.*
    // ctx 必须是真 Cordis Context（Service 基类要 ctx.reflect.provide）；否则降级为
    // 自建最小 ctx 面（reflect.provide 记录自引用），保证单测/非 Cordis 宿主可构造。
    super(normalizeCtx(ctx as never), 'myteam')
    this.host = host
  }

  /* ── 读（ADR-006：只读投影/侧车，绝不进模型上下文）── */

  /** 活跃团队信息卡 + 看板（FR-14.4/9.2） */
  async getBoard(args: { teamId?: string }) {
    const { teamId, service } = this.resolveTeam(args?.teamId)
    const svc = this.host.service(teamId)
    const board = buildBoard(service, svc.effectiveConfig.board.columnMapping, svc.effectiveConfig.board.columns)
    return { teamId, board, config: this.boardConfig(teamId) }
  }

  /** 任务详情：时间线 + 证据块 + 沟通区（FR-8.1/12.2） */
  async getTaskDetail(args: { teamId?: string; taskId: string }) {
    const { teamId, service, events } = this.resolveTeam(args?.teamId)
    const detail = buildDetail(service, events(), String(args.taskId))
    if (!detail) return { status: 'error', code: 'MT_VALIDATION', message: `task "${args.taskId}" not found` }
    return { status: 'ok', teamId, detail }
  }

  /** token 侧车四桶 + 命中率（FR-8.2/8.4 数据面）。
   *  CHG-86（P0-3）：改走 `syncTokens` 增量同步——旧实现每次从空文件重建，把成员
   *  全生命周期总量记进"今天"这一个桶，**读一次盘就抹掉一次历史**（days 永远只有一天）。 */
  async getTokens(args: { teamId?: string }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    const file = this.host.syncTokens(teamId)
    return { status: 'ok', tokens: buildTokens(file) }
  }

  /**
   * 归档快照（CHG-86 / P0-2）：面板归档视图的读面。
   * 返回 `archive/<teamId>/` 下真实落盘的内容（team.json + tokens.json + members/ + artifacts/）；
   * 未归档 → `archive: null`（面板按"未归档"渲染，不猜半个快照）。
   */
  async getArchive(args: { teamId?: string } = {}) {
    return { status: 'ok', ...this.host.archiveView(args?.teamId) }
  }

  /** 已归档团队清单（面板「全部团队」入口） */
  async getArchives() {
    return { status: 'ok', ...this.host.archiveList() }
  }

  /**
   * 门禁裁决（CHG-86 / M2-C，FR-5.1~5.2）：面板侧的 review/verify 裁决入口。
   * 与队长工具 `myteam_review_task` 同一条管线（actor=human）；
   * `confirm=true` 是打回预算超限后的**人工放行**开关。
   */
  async reviewTask(args: {
    teamId?: string
    taskId: string
    verdict: 'pass' | 'fail'
    reviewerMemberId?: string
    reason?: string
    confirm?: boolean
  }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_review_task',
      {
        teamId,
        taskId: args?.taskId,
        verdict: args?.verdict,
        ...(args?.reviewerMemberId ? { reviewerMemberId: args.reviewerMemberId } : {}),
        ...(args?.reason ? { reason: args.reason } : {}),
        ...(args?.confirm === true ? { confirm: true } : {}),
      },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /**
   * 知识提案策展（CHG-86 / P1-9，FR-17.4）：面板「采纳 / 驳回」按钮的写路径。
   * 修复前 UI 只写「由队长用 myteam_adopt_knowledge 执行」，面板没有写路径——
   * UI-5 验收门要求按钮直接接该通道。
   */
  async adoptKnowledge(args: { teamId?: string; draftId: string; decision: 'adopted' | 'rejected'; note?: string }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_adopt_knowledge',
      {
        teamId,
        draftId: args?.draftId,
        decision: args?.decision,
        ...(args?.note ? { note: args.note } : {}),
      },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /** 人工待办：暂存计划横幅 / escalate 提醒 / 提案队列计数（FR-1.2/12.3 M1 聊天裁决 + 徽标） */
  async getInbox(args: { teamId?: string }) {
    const { teamId, service } = this.resolveTeam(args?.teamId)
    const proj = service.projectionSnapshot
    const staged = proj.state === 'draft' ? { planId: 'plan-latest', state: proj.state } : null
    const escalations = Object.values(proj.tasks).filter((t) => t.state === 're-scoping').map((t) => ({ taskId: t.id, title: t.input.title, escalateCount: t.escalateCount }))
    const proposals = Object.values(proj.proposals).filter((p) => p.status === 'proposed')
    return { status: 'ok', teamId, inbox: { staged, escalations, proposalCount: proposals.length, unread: proj.inbox.length } }
  }

  /** 角色目录（FR-13.1 数据面）：builtin/global/project 三态，origin 标注（不进模型上下文） */
  async getRoles(args: { teamId?: string } = {}) {
    return { status: 'ok', roles: this.host.roleCatalogView() }
  }

  /** 知识库面板视图（FR-17.5 数据面，M2-0b）：条目 + 待审提案 + 演化时间线（读投影，不进模型上下文） */
  async getKnowledge(args: { teamId?: string } = {}) {
    return { status: 'ok', knowledge: this.host.knowledgeView() }
  }

  /** 审计（FR-12.5，CHG-49）：账本事件流新→旧分页（只读，不进模型上下文） */
  async getAudit(args: { teamId?: string; limit?: number; beforeSeq?: number } = {}) {
    const { teamId, events } = this.resolveTeam(args?.teamId)
    return { status: 'ok', ...buildAuditView(teamId, events() as unknown as { seq: number; ts: number; actor: string; type: string; payload?: Record<string, unknown> }[], { limit: args.limit, beforeSeq: args.beforeSeq }) }
  }

  /** 生效配置（FR-14.3，CHG-49/55）：来源链 + 看板/流水线/限制/门禁/任务类型 + 告警 */
  async getConfig(args: { teamId?: string } = {}) {
    const { teamId } = this.resolveTeam(args?.teamId)
    const svc = this.host.service(teamId)
    return buildConfigView(svc, svc.configSource)
  }

  /** 预设库（CHG-50）：三层只读目录（builtin/global/project），团队模板不在此创建 */
  async getPresets() {
    return { status: 'ok', ...this.host.presetCatalogView() }
  }

  /**
   * CHG-91（契约 §12.1）：第三方插件贡献的只读视图。
   *
   * 归属说明：贡献物是**插件资产**（随插件安装写盘），myteam 只读不写——
   * 所以这里没有 `publish` / `save` 之类写端点（P3 单向流动）。
   */
  async getContributions() {
    return contributionView(this.host.contributionSnapshot())
  }

  /** CHG-91：显式重载（插件装/卸后不必重启宿主） */
  async reloadContributions() {
    return contributionView(this.host.reloadContributions())
  }

  /**
   * 角色库统一写入口（CHG-87，docs/04 §2 承诺的 `roleOp(op, payload)`）。
   * 修复前 doc 里列了这个端点、实现只有 saveRole/deleteRole —— 契约承诺与实现分叉。
   * op ∈ save / delete / publish（项目 → 全局库）/ fork（复制成新 id）。
   */
  async roleOp(args: { op: string; payload?: Record<string, unknown>; confirm?: boolean } = { op: '' }) {
    return this.host.roleOp(String(args?.op ?? ''), {
      ...((args?.payload as Record<string, unknown> | undefined) ?? {}),
      ...(args?.confirm === true ? { confirm: true } : {}),
    })
  }

  /**
   * 单角色调用（CHG-87，FR-16.1 / FR-15.1 `/myteam+<id>`）：
   * 与队长工具 `myteam_apply_roles` 同一条管线（actor=human）；不写团队账本。
   */
  async applyRoles(args: { teamId?: string; roles?: string[]; remove?: string[]; confirm?: boolean } = {}) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_apply_roles',
      {
        teamId,
        roles: Array.isArray(args?.roles) ? args.roles : [],
        ...(Array.isArray(args?.remove) && args.remove.length > 0 ? { remove: args.remove } : {}),
        ...(args?.confirm === true ? { confirm: true } : {}),
      },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /**
   * CHG-88（M2-E / FR-16.3）：会话移交端点 —— 提取当前团队上下文摘要 → 新建团队预设
   * 会话 → 注入摘要。原会话保留；**不建成员、不建任务、不写团队账本**。
   *
   * 宿主缺 `sessionController` 能力 → `MT_UNAVAILABLE`（不假装成功）。
   */
  async handoff(args: { teamId?: string; sourceSessionId?: string } = {}) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.handoffTeam({ teamId, ...(args?.sourceSessionId ? { sourceSessionId: args.sourceSessionId } : {}) })
  }

  /* ── 写（面板唯一写入口；与工具同管线：TeamService.checkDomain → 账本）── */

  /** 暂存横幅三动作（FR-1.2：Approve & Run / Revise / Discard） */
  async planAction(args: { teamId: string; action: 'approve' | 'revise' | 'discard'; planId?: string; note?: string; confirm?: boolean }) {
    if (args.action === 'discard' && args.confirm !== true) {
      return { status: 'confirm-required', message: 'Discard 是两段确认操作：草稿将归档且不会自动重建，请带 confirm=true 重调' }
    }
    const toolName = args.action === 'approve' ? 'myteam_approve_plan' : args.action === 'revise' ? 'myteam_revise_plan' : 'myteam_discard_plan'
    const toolArgs: Record<string, unknown> = { teamId: args.teamId, planId: args.planId ?? 'plan-latest' }
    if (args.action === 'revise') toolArgs.note = args.note ?? ''
    if (args.action === 'discard') toolArgs.confirm = true
    const r = this.host.executeLeadTool(toolName, toolArgs, {}) as Record<string, unknown>
    return r
  }

  /** 成员管理（FR-14.2，CHG-48）：suspend/archive/remove/restore；remove 两段确认 */
  async memberOp(args: { teamId?: string; memberId: string; op: 'suspend' | 'archive' | 'remove' | 'restore'; confirm?: boolean }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.memberOp(teamId, String(args.memberId), String(args.op), args.confirm === true)
  }

  /** 人留言进任务 thread（actor=human，FR-12.2；CHG-16 裁决 4） */
  async postComment(args: { teamId: string; taskId: string; content: string }) {
    const r = this.host.commit(args.teamId, {
      actor: 'human',
      type: 'message.sent',
      payload: { teamId: args.teamId, messageId: `msg-${Date.now()}`, from: 'human', to: 'task-thread', taskId: args.taskId, content: args.content },
    })
    return r.ok ? { status: 'sent' } : { status: 'error', code: r.code, message: r.message }
  }

  /**
   * CHG-72（FR-29）：面板新建任务——走与队长工具同一条单写者管线（domain 校验 + 账本），
   * 只把 actor 标成 human。teamId 由面板传入（在线团队），离线团队没有会话可写。
   */
  async createTask(args: { teamId?: string; taskId?: string; task: Record<string, unknown>; assignees?: string[]; participants?: Array<{ teamId: string; memberIds?: string[]; role?: 'lead' | 'coop' }> }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    if (!args?.task || typeof args.task !== 'object') {
      return { status: 'error', code: 'MT_VALIDATION', message: 'task is required' }
    }
    const payload: Record<string, unknown> = { teamId, task: args.task }
    if (args.taskId) payload.taskId = args.taskId
    // CHG-73：一次写入负责队员 / 参与团队（FR-29/FR-21）
    if (Array.isArray(args.assignees)) payload.assignees = args.assignees
    if (Array.isArray(args.participants)) payload.participants = args.participants
    return this.host.executeLeadTool('myteam_create_task', payload, { actor: 'human' }) as Record<string, unknown>
  }

  /**
   * CHG-72（FR-31）：面板编辑任务——普通编辑走 task.updated（结构字段在跑时会被拒，
   * 调用方应改用 rescope）；rescope = { reason } 时走 task.rescoped（先撤 attempt 由服务校验）。
   */
  async updateTask(args: { teamId?: string; taskId: string; patch: Record<string, unknown>; rescope?: { reason: string }; expectedRevision?: number }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    if (!args?.taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    const payload: Record<string, unknown> = { teamId, taskId: args.taskId, patch: args.patch ?? {} }
    if (args.rescope) payload.rescope = args.rescope
    // CHG-87（QA-4 乐观锁）：面板编辑表单打开时快照 detail.revision，保存时回传
    if (args.expectedRevision !== undefined) payload.expectedRevision = args.expectedRevision
    // CHG-86（P0-4）：队长侧工具改名 myteam_edit_task（原 myteam_update_task 与成员作用域重名）
    return this.host.executeLeadTool('myteam_edit_task', payload, { actor: 'human' }) as Record<string, unknown>
  }

  /**
   * CHG-72（FR-29）：面板指派负责队员（多选）——在创建/编辑后一次调用，语义仍是「标注」，
   * 执行按角色 claim 不变（与 myteam_assign_task 同一管线）。
   */
  async assignTask(args: { teamId?: string; taskId: string; memberIds: string[] }) {    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool('myteam_assign_task', { teamId, taskId: args.taskId, memberIds: args.memberIds ?? [] }, { actor: 'human' }) as Record<string, unknown>
  }

  /**
   * CHG-72（FR-29）：面板登记协作团队（任务 × 团队多对多边）——主责固定为本团队，
   * 协作团队只读聚合；memberIds 为空表示「只建立关系，不指定队员」。
   */
  async participateTask(args: { teamId?: string; taskId: string; participantTeamId: string; role?: 'lead' | 'coop'; memberIds?: string[] }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    const payload: Record<string, unknown> = {
      teamId,
      taskId: args.taskId,
      participantTeamId: args.participantTeamId,
      role: args.role ?? 'coop',
      ...(Array.isArray(args.memberIds) ? { memberIds: args.memberIds } : {}),
    }
    return this.host.executeLeadTool('myteam_participate_task', payload, { actor: 'human' }) as Record<string, unknown>
  }

  /**
   * CHG-73（FR-31）：一键重新规划 —— 撤 attempt → 按新定义回 ready/backlog → 可选重派。
   * 与队长工具同一条管线（同一账本事件），actor 记 human。
   */
  async rescopeTask(args: { teamId?: string; taskId: string; reason: string; patch?: Record<string, unknown>; memberIds?: string[] }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_rescope_task',
      { teamId, taskId: args?.taskId, reason: args?.reason, patch: args?.patch ?? {}, memberIds: args?.memberIds ?? [] },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /**
   * CHG-73：取消任务（终态）。不带 confirm=true 时返回 confirm-required + 影响面；
   * downstream=leave 只停本任务，downstream=cancel 级联取消下游。
   * CHG-75：downstream=rewire 把**直接下游**改挂到 rewireTo（缺省 = 解除依赖变独立任务）。
   */
  async cancelTask(args: { teamId?: string; taskId: string; reason: string; downstream?: 'leave' | 'cancel' | 'rewire'; rewireTo?: string; confirm?: boolean }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_cancel_task',
      {
        teamId,
        taskId: args?.taskId,
        reason: args?.reason,
        downstream: args?.downstream ?? 'leave',
        ...(args?.rewireTo ? { rewireTo: args.rewireTo } : {}),
        confirm: args?.confirm === true,
      },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /** CHG-73/76：批量编排（取消/重规划/指派/改优先级），逐条落账，部分失败不影响其余；cancel 可走三档下游策略 */
  async batchTaskOp(args: { teamId?: string; op: string; taskIds: string[]; reason?: string; memberIds?: string[]; priority?: string; downstream?: 'leave' | 'cancel' | 'rewire'; rewireTo?: string; confirm?: boolean }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_batch_task_op',
      {
        teamId,
        op: args?.op,
        taskIds: args?.taskIds ?? [],
        reason: args?.reason,
        memberIds: args?.memberIds ?? [],
        priority: args?.priority,
        downstream: args?.downstream,
        ...(args?.rewireTo ? { rewireTo: args.rewireTo } : {}),
        confirm: args?.confirm === true,
      },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /**
   * CHG-76（FR-33）：批量建任务（面板「从目标出草稿」）——与队长工具同一条管线（task.created，actor=human）。
   * 不带 confirm 时返回影响面预览，带 confirm=true 才落账。
   */
  async createTasks(args: { teamId?: string; goal?: string; tasks: Record<string, unknown>[]; confirm?: boolean }) {
    const { teamId } = this.resolveTeam(args?.teamId)
    return this.host.executeLeadTool(
      'myteam_create_tasks',
      {
        teamId,
        ...(args?.goal ? { goal: args.goal } : {}),
        tasks: args?.tasks ?? [],
        confirm: args?.confirm === true,
      },
      { actor: 'human' },
    ) as Record<string, unknown>
  }

  /** 解散团队（两段确认 + 影响面，FR-14.1 M1 聊天为主、面板入口兜底） */
  async disband(args: { teamId: string; confirm?: boolean }) {
    if (args.confirm !== true) {
      const proj = this.host.service(args.teamId).projectionSnapshot
      return {
        status: 'confirm-required',
        impact: { members: Object.keys(proj.members).length, tasks: Object.keys(proj.tasks).length },
        message: '解散是两段确认操作（影响面见 impact），请带 confirm=true 重调',
      }
    }
    return this.host.executeLeadTool('myteam_disband', { teamId: args.teamId, confirm: true }, {}) as Record<string, unknown>
  }

  /* ── 内部 ── */

  /** 门面发现通道（M2）：默认团队 id（MyTeamPanelFacade.listTeams 聚合用，不经 remote marker 暴露给网关） */
  defaultTeamId(): string {
    return this.host.defaultTeamId()
  }

  /**
   * 全局视图摘要（FR-14 面板常驻 / 全局-项目切换）：团队 id、所属工作区、目标、状态、任务计数。
   * 非网关端点（不进 marker，同 defaultTeamId）：门面 listTeams 内部聚合用，返回纯数据不读模型。
   */
  describe() {
    const svc = this.host.service(this.host.defaultTeamId())
    const proj = svc.projectionSnapshot as unknown as {
      name?: string
      goal?: string
      state?: string
      tasks?: Record<string, { state?: string }>
      members?: Record<string, { roleId?: string; instanceName?: string; status?: string; currentTaskId?: string }>
    }
    const tasks = Object.values(proj.tasks ?? {})
    // 成员维度（角色 ↔ 团队关系视图数据源）：roleId/实例名/状态/当前任务
    const members = Object.values(proj.members ?? {}).map((member) => ({
      roleId: member.roleId ?? '',
      instanceName: member.instanceName ?? '',
      status: member.status ?? '',
      currentTaskId: member.currentTaskId ?? '',
    }))
    return {
      teamId: svc.teamId,
      name: proj.name ?? '',
      workspaceRoot: this.host.workspaceRoot,
      goal: proj.goal ?? '',
      state: proj.state ?? 'active',
      members,
      counts: {
        tasks: tasks.length,
        done: tasks.filter((task) => task.state === 'done').length,
        running: tasks.filter((task) => task.state === 'in_progress').length,
      },
    }
  }

  private resolveTeam(teamId?: string): { teamId: string; service: ReturnType<MyTeamHost['service']>; events: () => Record<string, unknown>[] } {
    const svc = this.host.service(teamId ?? this.host.defaultTeamId())
    const ledgerPath = svc.ledgerPath
    const events = () => {
      // 坏行容错（与 host.ts readLedgerEvents 同语义）：单条坏行跳过，不让面板视图整体失效
      try {
        const { readFileSync } = readFs()
        return readFileSync(ledgerPath, 'utf8').split('\n').flatMap((line) => {
          const trimmed = line.trim()
          if (!trimmed) return []
          try { return [JSON.parse(trimmed) as Record<string, unknown>] } catch { return [] }
        })
      } catch {
        return []
      }
    }
    return { teamId: svc.teamId, service: svc, events }
  }

  private boardConfig(teamId: string): Record<string, unknown> {
    const svc = this.host.service(teamId)
    return { columns: svc.effectiveConfig.board.columns, columnMapping: svc.effectiveConfig.board.columnMapping, warnings: svc.configWarnings }
  }
}

// 手动 Remote 标记（strip-only 环境等价装饰器）：gateway 按 method 名发现端点
markRemoteMethods(MyTeamRemote.prototype, ['getBoard', 'getTaskDetail', 'getTokens', 'getInbox', 'getAudit', 'getConfig', 'getPresets', 'planAction', 'postComment', 'memberOp', 'disband', 'createTask', 'createTasks', 'updateTask', 'assignTask', 'participateTask', 'rescopeTask', 'cancelTask', 'batchTaskOp',
  // CHG-86：门禁裁决 / 归档快照 / 知识提案策展
  'reviewTask', 'getArchive', 'getArchives', 'adoptKnowledge',
  // CHG-87（FR-13.1/FR-16.1）：角色库统一写入口 + 单角色调用
  'roleOp', 'applyRoles',
  // CHG-88（M2-E / FR-16.3）：会话移交（摘要 → 新团队预设会话）
  'handoff',
  // CHG-91（插件团队贡献契约 v1）：插件贡献只读视图 + 显式重载
  'getContributions', 'reloadContributions'])

// views.ts 纯函数复用（buildDetail/buildBoard/buildTokens 薄转发，避免 client 打包拉入 service 类型）
import { buildAuditView, buildBoardView, buildConfigView, buildTaskDetailView, buildTokensView } from './views.ts'
function buildDetail(service: ReturnType<MyTeamHost['service']>, events: Record<string, unknown>[], taskId: string) {
  return buildTaskDetailView(service, taskId, events as never)
}
function buildBoard(service: ReturnType<MyTeamHost['service']>, columnMapping: Record<string, string[]>, columns: string[]) {
  return buildBoardView(service, columnMapping, columns)
}
function buildTokens(file: Parameters<typeof buildTokensView>[0]) {
  return buildTokensView(file)
}

/**
 * CHG-91：贡献目录的**线上形态**（只读）。
 *
 * 为什么在 service 层再包一层而不是直接把 catalog 扔出去：
 *  - 角色定义里的 `systemPrompt` 可能上千字，面板列表不需要——只给 id/name/origin；
 *  - 团队模板只给 `members` 名册预览（建队向导要展示「这个团队有谁」）；
 *  - `warnings` 原样带上（面板顶部红条 + 每条都有「怎么改」，契约 §9）。
 */
function contributionView(catalog: import('../core/contributions/contract.ts').ContributionCatalog) {
  return {
    status: 'ok' as const,
    root: catalog.root,
    ok: catalog.ok,
    scannedAt: catalog.scannedAt,
    plugins: catalog.plugins,
    roles: catalog.roles.map((role) => ({ id: role.id, name: role.name, origin: role.origin })),
    teams: catalog.teams.map((team) => ({ id: team.id, name: team.name, namespace: team.namespace, members: team.members })),
    warnings: catalog.warnings,
  }
}

export { Remote }
