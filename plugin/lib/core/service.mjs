/**
 * T7：myteam service 内核 —— 账本（D1）+ 投影（D2）+ 调度 + 角色库（D4）的写管线。
 *
 * 单写者（ADR-002）：所有状态变更经 TeamService.commit() → 校验 → 增量应用 → 账本 append。
 * 校验拒绝式：返回 { ok:false, code, message } 而非抛异常（工具层直接转模型可见错误）。
 * 投影维护（CHG-59，ADR-002 R2 决策 B 实装）：
 *   - 写路径：在投影副本上 applyEvent 单事件（O(1)），成功才落账并切换内存投影；
 *   - 冷启动：openLedger 全量重放一次（O(n)，唯一恢复路径，team.json 不落盘）；
 *   - 折返失败（重放防线触发）不写账本、不改投影——账本永远只含可重放的历史。
 */
import { join, dirname } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import {
  appendEvent,
  openLedger,
  validateEvent,
  LedgerValidationError,
  RULES_VERSION,
                 
                   
} from './ledger/ledger.mjs'
import { applyEvent, foldEvents, FoldError } from './scheduler/fold.mjs'
import {
  canClaim,
  validatePlan,
  TERMINAL_STATES,
                 
                      
                      
} from './scheduler/state.mjs'
import {
  resolveRuntimeRole,
  validateRoster,
                      
} from './roles/role-store.mjs'
import { loadEffectiveConfig, readProjectConfigRaw, readTeamConfigRaw,                 } from './config/team-config.mjs'
import { storeLayout } from './workspace/layout.mjs'
// CHG-87（FR-5.3/FR-5.4/FR-16.4③）：command 门禁 / scope 审计 / 证据指针
import { validateVerifyCommand } from './gates/command-gate.mjs'
import { validateEvidencePointer } from './knowledge/evidence-pointer.mjs'

                              
               
                 
                                  
     
                                                 
                                                         
                                      
     
                           
 

                          
                                    
                                                                             
                                                                          

                                     
                       
                
                           
                          
 

export class TeamService {
           teamId        
           ledgerPath        
          opts                    
          events                = []
          nextSeq = 0
          projection                 
           effectiveConfig            
           configWarnings          
  /** 配置来源（CHG-55/56）：团队模板落盘 > 项目 config/team.config.json（或注入覆盖）> 插件默认 */
           configSource                                

  constructor(opts                    ) {
    this.opts = opts
    this.teamId = opts.teamId
    const teamsDir = storeLayout(opts.workspaceRoot).tasks
    this.ledgerPath = join(teamsDir, opts.teamId, 'ledger.jsonl')
    // 三层合并（CHG-56）：项目级 config/team.config.json（或注入覆盖）← 团队级 team.config.json
    const projectConfig = readProjectConfigRaw(opts.workspaceRoot) ?? opts.configOverride
    const teamConfig = readTeamConfigRaw(opts.workspaceRoot, opts.teamId)
    const loaded = loadEffectiveConfig(projectConfig, teamConfig)
    this.effectiveConfig = loaded.config
    this.configWarnings = loaded.warnings
    this.configSource = loaded.applied.team ? 'team' : loaded.applied.project ? 'project' : 'default'
    this.ensureLedgerDir()
    this.reload()
  }

  /** 目录就绪（host 进程内创建，R26：不走 bash）；幂等 */
          ensureLedgerDir()       {
    const dir = dirname(this.ledgerPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /**
   * 全量重放（冷启动唯一恢复路径：T16；崩溃残留已在 openLedger 截断）。
   *
   * CHG-86（QA-1 接线）：把 `openLedger` 新增的 `corrupted`（中部坏行 / seq 断点，事件已保留）
   * 与 `compacted`（是否重写账本）如实上抛——旧实现只 `return { truncated }`，
   * 坏行告警在 service 层被丢掉，调用方永远不知道账本曾经脏过。
   */
  reload()                                                               {
    const { events, nextSeq, truncated, corrupted, compacted } = openLedger(this.ledgerPath)
    this.events = events
    this.nextSeq = nextSeq
    try {
      this.projection = foldEvents(this.teamId, events)
    } catch (e) {
      if (e instanceof FoldError) {
        throw new Error(`[myteam] ledger replay failed for team ${this.teamId}: ${e.message}`)
      }
      throw e
    }
    return { truncated, corrupted: corrupted ?? 0, compacted: compacted ?? false }
  }

  get projectionSnapshot()                 {
    return this.projection
  }

  /**
   * CHG-87：按 seq 取事件（投影只存 seq 引用，内容的权威在账本）。
   * 供 scope 完成审计按证据 seq 取回 `task.evidence` 载荷；越界/缺失 → undefined。
   *
   * 注意：**不能用数组下标**——账本重写时刻意不重编号 seq（CHG-86/QA-1：seq 是审计锚点，
   * 坏行会留下永久空洞），所以「下标 = seq」只在从未重写过时成立。
   */
  eventBySeq(seq        )                          {
    if (!Number.isInteger(seq) || seq < 0) return undefined
    return this.events.find((event) => event.seq === seq)
  }

  /**
   * 唯一写入口：校验（事件结构 + 领域规则）→ 单事件增量应用 → 账本 append（CHG-59）。
   * 顺序刻意是「先算后写」：折返失败（非法转移等重放防线）时不落账本、不动内存投影，
   * 账本因此永远只含可重放的历史（旧实现在 append 后全量 fold，失败会留下不可重放的脏事件）。
   * 领域校验失败 = 账本不落任何事件（拒绝式）。
   */
  commit(draft             )               {
    // 0. 乐观锁（CHG-87 / QA-4）：先比版本再碰任何状态——冲突必须「什么都没发生」
    const revisionError = this.checkExpectedRevision(draft.expectedRevision)
    if (revisionError) return revisionError

    // 1. 领域前置校验（按事件类型）
    const domainCheck = this.checkDomain(draft)
    if (!domainCheck.ok) return domainCheck

    // 2. 结构校验 → 在副本上增量应用（失败即弃）→ 落账 → 切换投影
    try {
      const event = validateEvent({ actor: draft.actor, type: draft.type, payload: draft.payload }, this.nextSeq)
      const nextProjection = structuredClone(this.projection)
      applyEvent(nextProjection, event)
      appendEvent(this.ledgerPath, event)
      this.projection = nextProjection
      this.events.push(event)
      this.nextSeq = event.seq + 1
      return { ok: true, event }
    } catch (e) {
      if (e instanceof LedgerValidationError) return { ok: false, code: e.code, message: e.message }
      if (e instanceof FoldError) return { ok: false, code: 'MT_INTERNAL_FOLD', message: e.message }
      return { ok: false, code: 'MT_INTERNAL', message: String(e) }
    }
  }

  /**
   * CHG-87（QA-4 乐观锁）：`projection.revision` = 已应用事件数（= 末事件 seq + 1，见 docs/04 §3.2）。
   *
   * 为什么单写者管线下仍要实现：契约承诺（docs/04 §1.1 工具表 + §4 错误码表）已经对外
   * 公开了 `expectedRevision` / `MT_REVISION_CONFLICT`，而 `plugin/src` 全量零命中——
   * 这是**文档承诺未兑现**，不是"管线下冗余"。人的操作跨进程（面板 + 队长会话 + 成员），
   * 单写者只保证不并发写坏账本，不保证「你改的是你看到的那一版」。
   *
   * 语义：缺省/undefined = 不校验（向后兼容）；非整数或负数 = `MT_VALIDATION`；
   * 与当前版本不等 = `MT_REVISION_CONFLICT` + 回显 `currentRevision`。
   */
          checkExpectedRevision(expected                    )                      {
    if (expected === undefined) return null
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      return { ok: false, code: 'MT_VALIDATION', message: `expectedRevision must be a non-negative integer (got ${String(expected)})` }
    }
    const current = this.projection.revision
    if (expected !== current) {
      return {
        ok: false,
        code: 'MT_REVISION_CONFLICT',
        message: `expectedRevision ${expected} is stale; current revision is ${current}（任务已被修改，重新加载后重试）`,
        currentRevision: current,
      }
    }
    return null
  }

  /** 领域规则校验（每型独立，全部拒绝式） */
          checkDomain(draft             )               {
    const p = draft.payload                                                             
    const proj = this.projection
    switch (draft.type) {
      case 'team.created': {
        // FR-10.1：名册必含且仅含一个队长
        const roster = (p.roster                                    ) ?? []
        try {
          validateRoster(roster, this.opts.rolePaths)
        } catch (e) {
          return roleErrorToResult(e)
        }
        break
      }
      case 'task.created': {
        const task = p.task                        
        // CHG-87（FR-5.3/FR-5.4）：command 门禁命令与 scope 范围在创建时就拒绝式校验
        // （否则脏定义要等到任务跑到 verify 门才炸，那时已经烧掉一整轮成员调用）
        const commandError = validateVerifyCommand((task                                      )?.verifyCommand)
        if (commandError) return commandError
        const scopes = (task                                      )?.writeScopes
        if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || String(scope).trim().length === 0))) {
          return { ok: false, code: 'MT_VALIDATION', message: 'writeScopes must be a non-empty string array' }
        }
        // 计划级校验（FR-11.2 七项）：把"已存在的任务 + 新任务"作为一个整体计划校验
        const existing                            = {}
        for (const [id, t] of Object.entries(proj.tasks)) existing[id] = t.input
        existing[p.taskId] = task
        const rosterRoles = this.rosterRoles()
        // CHG-72：团队已 active 时允许补一条独立任务（面板 create_task 的正常用法）；
        // 草稿阶段的计划仍强制 DAG 连通（FR-11.2 ⑥），避免「一键塞进一堆孤立任务」。
        const result = validatePlan(existing, this.effectiveConfig.limits.maxTasks, rosterRoles, { allowOrphans: proj.state === 'active' })
        if (!result.ok) {
          const errs = result.errors.filter((e) => e.taskId === p.taskId || e.taskId === '-')
          const detail = errs.length > 0 ? errs : result.errors
          return {
            ok: false,
            code: 'MT_VALIDATION',
            message: detail.map((e) => `task ${e.taskId}: ${e.message}`).join('; '),
          }
        }
        break
      }
      case 'task.claimed': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        const member = proj.members[p.memberId]
        if (!member) return { ok: false, code: 'MT_VALIDATION', message: `member "${p.memberId}" not found` }
        // 调度判定（FR-11.5）：ready（或 backlog+deps 全 done）+ 角色 + 无活跃 attempt
        const depsResolved = t.input.deps.every((d) => proj.tasks[d]?.state === 'done')
        const claimability = canClaim(t, { roleId: member.roleId, status: member.status }, Date.now(), depsResolved)
        if (!claimability.claimable) {
          return { ok: false, code: 'MT_NOT_CLAIMABLE', message: claimability.reasons.join('; ') }
        }
        break
      }
      case 'task.attempt.revoked': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        if (t.attemptId && t.attemptId !== p.attemptId) {
          return { ok: false, code: 'MT_ATTEMPT_STALE', message: `attempt "${p.attemptId}" is stale; current is "${t.attemptId}"` }
        }
        break
      }
      case 'task.progress': {
        const stale = this.checkAttempt(p.taskId, p.attemptId)
        if (stale) return stale
        break
      }
      case 'task.evidence': {
        const stale = this.checkAttempt(p.taskId, p.attemptId)
        if (stale) return stale
        // FR-5.0/ADR-007：证据块结构校验（done 必附；此处 progress/中间申报也允许带）
        const evidence = p.evidence                                       
        if (evidence) {
          const check = validateEvidenceBlock(evidence)
          if (!check.ok) return check
        }
        break
      }
      case 'task.completed': {
        const stale = this.checkAttempt(p.taskId, p.attemptId)
        if (stale) return stale
        // done 必附证据块（FR-5.0 硬校验）——completed 事件必须先带同 attemptId 的 evidence
        const t = proj.tasks[p.taskId]
        const lastEvidence = t.evidenceRefs.length > 0 ? this.events[t.evidenceRefs[t.evidenceRefs.length - 1]] : undefined
        const evPayload = lastEvidence?.payload                                       
        if (!lastEvidence || evPayload?.attemptId !== p.attemptId) {
          return { ok: false, code: 'MT_EVIDENCE_REQUIRED', message: 'done declaration requires [Verification evidence] for the current attempt (FR-5.0)' }
        }
        break
      }
      case 'task.failed': {
        const stale = this.checkAttempt(p.taskId, p.attemptId)
        if (stale) return stale
        break
      }
      case 'task.escalated': {
        const stale = this.checkAttempt(p.taskId, p.attemptId)
        if (stale) return stale
        // FR-11.7：escalate 必带 evidence（已尝试什么+卡在哪）
        if (!p.evidence || typeof p.evidence !== 'object') {
          return { ok: false, code: 'MT_VALIDATION', message: 'escalate requires evidence {attempted, blockedAt}' }
        }
        break
      }
      case 'task.rescoped': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        // CHG-73：重新规划不再只服务 escalate 出口——面板/队长可对任何非终态任务重规划
        // （撤 attempt → 回 ready/backlog → 带结构补丁）。终态任务必须新建或先重开。
        if (TERMINAL_STATES.has(t.state)) {
          return { ok: false, code: 'MT_TASK_TERMINAL', message: `task "${p.taskId}" is ${t.state}; 终态任务不能重新规划` }
        }
        if (typeof p.reason !== 'string' || String(p.reason).trim().length === 0) {
          return { ok: false, code: 'MT_VALIDATION', message: 'rescope requires a non-empty reason（为什么重新规划必须写清）' }
        }
        // 重规划可以不带补丁（只是撤 attempt 重新排队）；带补丁时按白名单校验（结构字段允许）
        const rescopePatch = (p.patch                           ) ?? {}
        if (Object.keys(rescopePatch).length > 0) {
          const patchError = this.validateTaskPatch(proj, String(p.taskId), rescopePatch, true)
          if (patchError) return patchError
        }
        break
      }
      /* CHG-75：下游改挂（把被取消的上游换成新上游，或解除依赖）
       *  领域规则：目标任务存在；removed 必须是它当前的依赖之一；added 必须是本团队的
       *  非终态任务且不是它自己；改挂后不得成环（沿用补丁的环检测口径）。 */
      case 'task.rewired': {
        const rewiredError = this.validateRewire(proj, String(p.taskId), String(p.removed ?? ''), p.added === undefined || p.added === null || p.added === '' ? undefined : String(p.added))
        if (rewiredError) return rewiredError
        break
      }
      /* CHG-73：取消任务（终态；理由必填；下游策略由写入端决定是否级联） */
      case 'task.cancelled': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        if (TERMINAL_STATES.has(t.state)) {
          return { ok: false, code: 'MT_TASK_TERMINAL', message: `task "${p.taskId}" is already ${t.state}` }
        }
        if (typeof p.reason !== 'string' || String(p.reason).trim().length === 0) {
          return { ok: false, code: 'MT_VALIDATION', message: 'cancel requires a non-empty reason（取消必须留理由）' }
        }
        break
      }
      /* CHG-70：任务编辑（白名单补丁；不改状态 / attempt / 证据） */
      case 'task.updated': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        const patchError = this.validateTaskPatch(proj, String(p.taskId), (p.patch                           ) ?? {}, false)
        if (patchError) return patchError
        break
      }
      /* CHG-70：团队名/目标编辑（至少一个字段，且非空） */
      case 'team.updated': {
        const hasName = p.name !== undefined
        const hasGoal = p.goal !== undefined
        if (!hasName && !hasGoal) return { ok: false, code: 'MT_VALIDATION', message: 'team.updated requires name or goal' }
        if (hasName && String(p.name).trim().length === 0) {
          return { ok: false, code: 'MT_VALIDATION', message: 'team name must be non-empty' }
        }
        if (hasGoal && String(p.goal).trim().length === 0) {
          return { ok: false, code: 'MT_VALIDATION', message: 'team goal must be non-empty' }
        }
        break
      }
      case 'member.spawned': {
        if (Object.values(proj.members).filter((m) => m.status === 'active' || m.status === 'suspended').length >= this.effectiveConfig.limits.maxMembers) {
          return { ok: false, code: 'MT_MEMBER_LIMIT', message: `maxMembers ${this.effectiveConfig.limits.maxMembers} reached (ADR-008 self-managed quota)` }
        }
        // 运行时只认项目库
        if (!resolveRuntimeRole(this.opts.rolePaths, String(p.roleId))) {
          return { ok: false, code: 'MT_VALIDATION', message: `role "${p.roleId}" not in project library (runtime resolves project roles only, FR-10.2)` }
        }
        break
      }
      case 'task.assigned': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        const ids = Array.isArray(p.memberIds) ? (p.memberIds             ).map(String) : [String(p.memberId)]
        if (ids.length === 0) return { ok: false, code: 'MT_VALIDATION', message: 'task.assigned requires at least 1 member' }
        for (const id of ids) {
          if (!proj.members[id]) return { ok: false, code: 'MT_VALIDATION', message: `member "${id}" not found` }
        }
        break
      }
      /* CHG-69（FR-21）：参与边领域校验——主责只能是本团队（账本持有者），协作不能是自己 */
      case 'task.participate': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        const participant = String(p.participantTeamId ?? '')
        if (!participant) return { ok: false, code: 'MT_VALIDATION', message: 'participantTeamId is required' }
        if (p.role !== 'lead' && p.role !== 'coop') {
          return { ok: false, code: 'MT_VALIDATION', message: 'role must be "lead" or "coop"' }
        }
        if (p.role === 'lead' && participant !== this.teamId) {
          return {
            ok: false,
            code: 'MT_VALIDATION',
            message: `lead must be the task's owning team (${this.teamId}); 跨团队主责需要迁移账本，当前不支持（FR-21）`,
          }
        }
        if (p.role === 'coop' && participant === this.teamId) {
          return { ok: false, code: 'MT_VALIDATION', message: 'owning team is already lead; coop must be another team' }
        }
        break
      }
      case 'task.participation.released': {
        const t = proj.tasks[p.taskId]
        if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        if (String(p.participantTeamId) === this.teamId) {
          return { ok: false, code: 'MT_VALIDATION', message: 'cannot release the owning team (lead) participation' }
        }
        break
      }
      case 'task.proposal': {
        if (!proj.tasks[p.taskId]) return { ok: false, code: 'MT_VALIDATION', message: `task "${p.taskId}" not found` }
        break
      }
      case 'task.proposal.resolved': {
        const proposal = proj.proposals[p.proposalId]
        if (!proposal) return { ok: false, code: 'MT_VALIDATION', message: `proposal "${p.proposalId}" not found` }
        if (proposal.status !== 'proposed') {
          return { ok: false, code: 'MT_TEAM_STATE', message: `proposal already ${proposal.status}` }
        }
        break
      }
      case 'knowledge.proposed': {
        // FR-17.4：成员提案必带证据指针与完整草案
        const draft = p.draft                                       
        if (!draft) return { ok: false, code: 'MT_KB_INVALID', message: 'knowledge.proposed requires draft' }
        if (!draft.evidence || String(draft.evidence).trim().length === 0) {
          return { ok: false, code: 'MT_KB_EVIDENCE_REQUIRED', message: 'knowledge draft requires evidence pointer (task id)' }
        }
        // CHG-87（FR-16.4③）：三类指针 tax 校验——`task:` / `file:` / `session:` 前缀后必须有内容；
        // 未知前缀放行（旧账本是任意字符串，拒绝会让历史条目全变非法）
        const pointerError = validateEvidencePointer(draft.evidence)
        if (pointerError) return pointerError
        break
      }
      case 'knowledge.adopted': {
        // FR-17.4：采纳必须有对应提案（账本中存在）
        const proposal = this.events.find(
          (e) => e.type === 'knowledge.proposed' && (e.payload                           ).draftId === p.draftId,
        )
        if (!proposal) {
          return { ok: false, code: 'MT_VALIDATION', message: `knowledge proposal "${p.draftId}" not found in ledger` }
        }
        break
      }
      case 'plan.approved': {
        if (proj.state !== 'draft') {
          return { ok: false, code: 'MT_TEAM_STATE', message: `approve requires draft state; team is ${proj.state}` }
        }
        break
      }
      default:
        break
    }
    return { ok: true, event: { seq: -1, ts: 0, actor: '', type: draft.type, payload: {} } }
  }

  /**
   * CHG-70：任务补丁校验（白名单 + 基本约束 + 依赖环）。拒绝式返回，null = 通过。
   * 与 task.created 的差异：编辑不改状态机、不要求整份计划重校验；只保证「改完仍是一张合法任务」。
   */
          validateTaskPatch(proj                , taskId        , patch                         , allowStructural = false)                      {
    const err = (message        )               => ({ ok: false, code: 'MT_VALIDATION', message })
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err('patch must be an object')
    const known = ['title', 'description', 'acceptanceCriteria', 'deliverableSpec', 'deps', 'requiredRole', 'taskType', 'gateChain', 'priority', 'estimate', 'tags', 'writeScopes', 'verifyCommand']
    const STRUCTURAL = ['acceptanceCriteria', 'deliverableSpec', 'deps', 'requiredRole', 'taskType', 'gateChain', 'writeScopes', 'verifyCommand']
    const keys = Object.keys(patch)
    if (keys.length === 0) return err('patch is empty (nothing to update)')
    const unknown = keys.filter((key) => !known.includes(key))
    if (unknown.length > 0) return err(`unknown patch field(s): ${unknown.join(', ')}`)
    // CHG-71：任务在跑 / 在门禁时，AC、依赖、角色、交付物、门禁链属于结构变更——必须走 rescope
    const task = proj.tasks[taskId]
    const running = task && (task.state === 'in_progress' || task.state.startsWith('gate:'))
    if (!allowStructural && running) {
      const structural = Object.keys(patch).filter((key) => STRUCTURAL.includes(key))
      if (structural.length > 0) {
        return {
          ok: false,
          code: 'MT_TASK_STRUCTURAL_EDIT',
          message: `structural edit (${structural.join(', ')}) is not allowed while task is ${task.state}; 用 rescope（先撤 attempt）或在就绪前改`,
        }
      }
    }
    if ('title' in patch && (typeof patch.title !== 'string' || patch.title.trim().length === 0)) return err('title must be non-empty')
    if ('description' in patch && typeof patch.description !== 'string') return err('description must be a string')
    if ('acceptanceCriteria' in patch) {
      const ac = patch.acceptanceCriteria
      if (!Array.isArray(ac) || ac.length === 0) return err('acceptanceCriteria must have at least 1 item')
      if (ac.some((item) => typeof item !== 'string' || item.trim().length === 0)) return err('acceptanceCriteria entries must be non-empty strings')
    }
    if ('deliverableSpec' in patch && (typeof patch.deliverableSpec !== 'object' || patch.deliverableSpec === null)) {
      return err('deliverableSpec must be an object')
    }
    if ('deps' in patch) {
      const deps = patch.deps
      if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string')) return err('deps must be a string array')
      for (const dep of deps            ) {
        if (dep === taskId) return err('task cannot depend on itself')
        if (!proj.tasks[dep]) return err(`dep "${dep}" does not exist`)
      }
      // 编辑依赖可能成环：在「补丁后的图」上做一次 DFS 环检测（只查本团队任务）
      if (this.detectDependencyCycle(proj, taskId, deps            )) return err('dependency cycle detected after patch')
    }
    if ('requiredRole' in patch) {
      if (typeof patch.requiredRole !== 'string' || patch.requiredRole.length === 0) return err('requiredRole must be a role id')
      if (!this.rosterRoles().includes(patch.requiredRole)) {
        return err(`requiredRole "${patch.requiredRole}" not in roster (${this.rosterRoles().join(', ')})`)
      }
    }
    if ('taskType' in patch && typeof patch.taskType !== 'string') return err('taskType must be a string')
    if ('gateChain' in patch) {
      const chain = patch.gateChain
      if (!Array.isArray(chain) || chain.some((gate) => typeof gate !== 'string' || gate.length === 0)) return err('gateChain must be a non-empty string array')
    }
    if ('priority' in patch && !['P0', 'P1', 'P2', 'P3'].includes(String(patch.priority))) return err('priority must be P0~P3')
    if ('estimate' in patch && !['S', 'M', 'L'].includes(String(patch.estimate))) return err('estimate must be S/M/L')
    if ('tags' in patch && (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== 'string'))) return err('tags must be a string array')
    // CHG-87（FR-5.4/FR-5.3）：scope 范围与 command 门禁命令
    if ('writeScopes' in patch) {
      const scopes = patch.writeScopes
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope.trim().length === 0)) {
        return err('writeScopes must be a non-empty string array')
      }
    }
    if ('verifyCommand' in patch) {
      const cmdError = validateVerifyCommand(patch.verifyCommand)
      if (cmdError) return cmdError
    }
    return null
  }

  /**
   * CHG-75：改挂的领域校验（供提交路径与"取消前的预检"共用——预检很重要：
   * 若先取消再发现改挂非法，就会留下"上游已死、下游还挂着"的半吊子状态）。
   * 返回 null = 通过；否则返回拒绝结果。
   *
   * CHG-86（tsc 真 bug）：返回类型收窄为「只有失败分支」——旧签名 `CommitResult | null`
   * 让调用方 `if (pre)` 无法窄化（`{ok:true}` 也是真值），既过不了类型检查，也掩盖了
   * "成功返回 null" 这个真实契约。
   */
  validateRewire(proj                , taskId        , removed        , added         )                                                      {
    const t = proj.tasks[taskId]
    if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    if (!removed) return { ok: false, code: 'MT_VALIDATION', message: 'rewire requires removed（被换掉的上游 id）' }
    if (!(t.input.deps ?? []).includes(removed)) {
      return { ok: false, code: 'MT_VALIDATION', message: `task "${taskId}" does not depend on "${removed}"` }
    }
    if (added) {
      if (added === taskId) {
        return { ok: false, code: 'MT_VALIDATION', message: `task "${taskId}" cannot depend on itself` }
      }
      const upstream = proj.tasks[added]
      if (!upstream) return { ok: false, code: 'MT_VALIDATION', message: `task "${added}" not found in this team` }
      if (upstream.state === 'cancelled' || upstream.state === 'failed') {
        return { ok: false, code: 'MT_VALIDATION', message: `task "${added}" is ${upstream.state}; 不能作为新的依赖（它自己永远不会完成）` }
      }
    }
    // 环检测：改挂后的依赖图不得成环（沿用 validateTaskPatch 的补丁后图 DFS 口径）
    const nextDeps = (t.input.deps ?? []).filter((dep) => dep !== removed)
    if (added && !nextDeps.includes(added)) nextDeps.push(added)
    if (this.detectDependencyCycle(proj, taskId, nextDeps)) {
      return { ok: false, code: 'MT_TASK_CYCLE', message: `rewiring "${taskId}" to "${added ?? '(独立)'}" would create a dependency cycle` }
    }
    return null
  }

  /**
   * CHG-75：依赖环检测（供补丁与改挂共用；纯判定，不带错误码——错误码由调用方决定，
   * 避免把「编辑依赖成环」的既有 MT_VALIDATION 口径悄悄改掉）。
   * 在「假设 taskId 的依赖被替换成 nextDeps」的图上做 DFS；有环返回 true。
   */
          detectDependencyCycle(proj                , taskId        , nextDeps          )          {
    const graph = new Map                  ()
    for (const [id, task] of Object.entries(proj.tasks)) {
      graph.set(id, id === taskId ? [...nextDeps] : [...task.input.deps])
    }
    const state = new Map                   ()
    const walk = (id        )          => {
      const mark = state.get(id) ?? 0
      if (mark === 1) return true
      if (mark === 2) return false
      state.set(id, 1)
      for (const dep of graph.get(id) ?? []) {
        if (graph.has(dep) && walk(dep)) return true
      }
      state.set(id, 2)
      return false
    }
    for (const id of graph.keys()) {
      if (walk(id)) return true
    }
    return false
  }

          checkAttempt(taskId        , attemptId        )                      {
    const t = this.projection.tasks[taskId]
    if (!t) return { ok: false, code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    /* CHG-78（真实宿主实弹）：终态任务不再接收成员上报。
     * 折叠后终态仍保留 attemptId，旧实现只比 attemptId → 成员在同一 attempt 里再报一次
     * evidence/completed 就能把「已完成」重复落账（实测账本出现两对 evidence/completed），
     * 看板证据与完成时间会被第二次覆盖。终态任务的任何重开都走 rescope/新建，不走上报。 */
    if (TERMINAL_STATES.has(t.state)) {
      return { ok: false, code: 'MT_TASK_TERMINAL', message: `task "${taskId}" is ${t.state}; 终态任务不再接收成员上报（重开请用 rescope 或新建任务）` }
    }
    if (!t.attemptId || t.attemptId !== attemptId) {
      return {
        ok: false,
        code: 'MT_ATTEMPT_STALE',
        message: `attempt "${attemptId}" is stale for task "${taskId}"; current: ${t.attemptId ?? 'none'} (FR-4.3)`,
      }
    }
    return null
  }

          rosterRoles()           {
    // 已批准团队：以名册成员角色为准；草稿阶段：项目库全部角色（计划校验不因角色未复制而失败）
    const memberRoles = Object.values(this.projection.members).map((m) => m.roleId)
    if (memberRoles.length > 0) return memberRoles
    return ['captain', 'implementer', 'reviewer']
  }

  /** 就绪任务可领视图（成员 list_tasks 用；NFR-7.6 限界由调用方执行） */
  claimableTasks(roleId        )                   {
    const proj = this.projection
    return Object.values(proj.tasks).filter((t) => {
      if (TERMINAL_STATES.has(t.state)) return false
      if (t.state !== 'ready' && t.state !== 'backlog') return false
      if (t.input.requiredRole !== roleId) return false
      if (t.attemptId) return false
      const depsDone = t.input.deps.every((d) => proj.tasks[d]?.state === 'done')
      return depsDone
    })
  }
}

/** FR-5.0/ADR-007：证据块结构校验 */
export function validateEvidenceBlock(evidence                         )               {
  if (evidence.kind === 'commands') {
    const cmds = evidence.commands                         
    if (!Array.isArray(cmds) || cmds.length === 0) {
      return { ok: false, code: 'MT_VALIDATION', message: 'evidence.kind=commands requires at least 1 command entry' }
    }
    for (const c of cmds) {
      const entry = c                           
      if (typeof entry.cmd !== 'string' || typeof entry.exitCode !== 'number') {
        return { ok: false, code: 'MT_VALIDATION', message: 'evidence command entry requires {cmd: string, exitCode: number}' }
      }
      // CHG-87（FR-5.4）：申报改动的文件（scope 审计的输入）——只能是非空字符串数组
      if (entry.filesTouched !== undefined) {
        if (!Array.isArray(entry.filesTouched) || entry.filesTouched.some((file) => typeof file !== 'string' || String(file).trim().length === 0)) {
          return { ok: false, code: 'MT_VALIDATION', message: 'evidence command entry filesTouched must be a non-empty string array（申报改动的文件路径，FR-5.4）' }
        }
      }
    }
    return { ok: true, event: { seq: -1, ts: 0, actor: '', type: 'task.evidence', payload: {} } }
  }
  if (evidence.kind === 'na') {
    const na = evidence.na                                       
    if (!na || typeof na.reason !== 'string' || na.reason.trim().length === 0) {
      return { ok: false, code: 'MT_VALIDATION', message: 'evidence.kind=na requires na.reason (non-empty)' }
    }
    return { ok: true, event: { seq: -1, ts: 0, actor: '', type: 'task.evidence', payload: {} } }
  }
  return { ok: false, code: 'MT_VALIDATION', message: 'evidence.kind must be "commands" or "na"' }
}

function roleErrorToResult(e         )               {
  const err = e                                       
  return { ok: false, code: err.code ?? 'MT_VALIDATION', message: err.message ?? String(e) }
}

/** 团队创建引导：新账本首事件 rules.version.adopted〔I3〕 */
export function bootstrapTeam(service             , actor = 'host')               {
  return service.commit({ actor, type: 'rules.version.adopted', payload: { version: RULES_VERSION } })
}


//# sourceURL=./src/core/service.ts