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
                                                                  
                                                                     
                                                              
                                                                           
import { diffTaskInput } from '../core/tasks/diff.mjs'
// CHG-159（报告 A6）：领取前的写范围闸门（纯函数；与 scope-audit/waves 同一套路径语义）
import { claimScopeVerdict } from '../core/scheduler/waves.mjs'
import {
  candidatesForDraft,
  knowledgeDirOf,
  listKnowledge,
  touchStale,
  validateDraft,
  writeKnowledgeEntry,
                      
} from '../core/knowledge/knowledge.mjs'
import { parseEvidencePointer } from '../core/knowledge/evidence-pointer.mjs'

/**
 * 防御属性读取（JSON 面收窄）。与 `host.ts` 里那份**同形**（本仓已有同样的一行式
 * 副本：`core/config/team-config.ts`、`core/contributions/parse.ts`）——纯函数、无状态，
 * 为一个判断开一条宿主面反而更难读。
 */
const isPlainObject = (value         )                                   =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 队长侧任务族的宿主面（**只列用到的成员**） */
                                   
                                                                       
                                      

                        
                                                                               

                                                                   
                
                   
                                  
                                                 
                                      

                                               
                                                                                           

                                                              
                                                                                                                           

                                                          
                                                                                                    

                                                                       
             
                   
                                  
                  
                                                               

                                          
                                                                                                   


                                                          
                                                                                                    

                                         
                                                                                                         
 

export function createTasksHandlers(host                  ) {
  return {
    /** `myteam_create_task`：taskId 由 host 分配（重放幂等） */
    create(teamId        , args                         , actor        )                          {
      // taskId 由 host 分配（契约 docs/04 §1.1）；取投影中 task-N 最大 N + 1（重放幂等）
      const proj0 = host.service(teamId).projectionSnapshot.tasks
      let maxN = 0
      for (const id of Object.keys(proj0)) {
        const m = /^task-(\d+)$/.exec(id)
        if (m) maxN = Math.max(maxN, Number(m[1]))
      }
      const taskId = args.taskId ? String(args.taskId) : `task-${maxN + 1}`
      const r = host.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: host.taskWithGateChain(teamId, (args.task ?? {})                           ) } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      // CHG-73（FR-29）：一次写入负责队员与参与团队——创建任务时人已经知道"谁做/谁协作"，
      // 不该让面板/队长再串三次调用（部分失败不撤销任务本身，按 warnings 显性化）
      const created = host.applyTaskRelations(teamId, taskId, args, actor)
      return { status: 'created', taskId, ...created }
    },

    /* CHG-86（P0-4）：队长侧工具改名 myteam_edit_task（原 myteam_update_task 与成员作用域重名，
     * 同名跨层注册时解析顺序决定谁生效——若队长侧生效，成员可绕过 attemptId 校验改任务结构） */
    /** `myteam_edit_task`：普通编辑（补丁合并）或 `rescope` 一键重规划 */
    edit(teamId        , args                         , actor        )                          {
      const taskIdArg = String(args.taskId ?? '')
      const patch = (isPlainObject(args.patch) ? args.patch : {})                           
      const rescope = args.rescope                                   
      // CHG-73：rescope 走统一的"一键重新规划"管线（撤 attempt → 回 ready/backlog → 可选重派）
      if (rescope) {
        return host.rescopeTask(teamId, { teamId, taskId: taskIdArg, reason: rescope.reason, patch, memberIds: args.memberIds }, actor)
      }
      // CHG-70：普通编辑走 task.updated（补丁合并，**不改状态/attempt/证据**）；
      // CHG-73：把字段级 diff 一起落账——详情页「改动记录」与证据过期判定都读它
      const task = host.service(teamId).projectionSnapshot.tasks[taskIdArg]
      const changes = task ? diffTaskInput(task.input                                      , patch) : []
      const r = host.commitGuarded(teamId, args, { actor, type: 'task.updated', payload: { teamId, taskId: taskIdArg, patch, changes } })
      return r.ok
        ? { status: 'updated', taskId: taskIdArg, changes }
        : { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
    },

    /* CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口——修复前无任何入口能提交 task.gate.result，
     * 默认链 ['review','archive'] 下任务 done 后停在 gate:review 永远到不了 done。 */
    /** `myteam_review_task`：门禁裁决（pass / fail） */
    review(teamId        , args                         , actor        )                                                             {
      return host.reviewTask(teamId, args, actor)
    },

    /* ── CHG-73：执行期编辑闭环（重规划 / 取消 / 批量编排 / 角色删除）── */
    /** `myteam_rescope_task` */
    rescope(teamId        , args                         , actor        )                          {
      return host.rescopeTask(teamId, args, actor)
    },

    /** `myteam_cancel_task` */
    cancel(teamId        , args                         , actor        )                          {
      return host.cancelTask(teamId, args, actor)
    },

    /**
     * `myteam_delete_task`（CHG-202x / P0-1）：产品定案「任务不能手动建，但是可以手动删除」。
     *
     * 与 `cancel` 的区别：cancel 是**终态**（任务留在看板「已取消」列，下游仍挂着它，只能靠 rewire 解开）；
     * delete 是**把任务从投影里去掉**（误建任务的清理出口）。两段确认：第一次返回影响面
     * （标题 / 状态 / 直接下游 / 是否有活跃 attempt），带 confirm=true 才落账。
     * 落账后 fold 会把它的 id 从其它任务的 deps 里摘掉——下游不会永久死锁。
     */
    deleteTask(teamId        , args                         , actor        )                          {
      const taskId = String(args.taskId ?? '')
      if (!taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
      const proj = host.service(teamId).projectionSnapshot
      const task = proj.tasks[taskId]
      if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
      const reason = String(args.reason ?? '').trim()
      const dependents = Object.values(proj.tasks)
        .filter((t) => t.id !== taskId && (t.input.deps ?? []).includes(taskId))
        .map((t) => t.id)
      if (args.confirm !== true) {
        return {
          status: 'confirm-required',
          taskId,
          impact: { title: task.input.title, state: task.state, dependents, hasAttempt: Boolean(task.attemptId) },
          message: `删除「${task.input.title}」会把它从账本投影里移除（历史事件保留、可回放）；${
            dependents.length > 0
              ? `它的 ${dependents.length} 个直接下游会**解除对该任务的依赖**（变独立任务）`
              : '当前没有下游依赖它'
          }；确认请带 confirm=true`,
        }
      }
      const r = host.commitGuarded(teamId, args, {
        actor,
        type: 'task.deleted',
        payload: { teamId, taskId, ...(reason ? { reason } : {}), ...(typeof args.batchId === 'string' ? { batchId: args.batchId } : {}) },
      })
      if (!r.ok) {
        return { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
      }
      return { status: 'deleted', taskId, dependents }
    },

    /** `myteam_batch_task_op` */
    batchOp(teamId        , args                         , actor        )                          {
      return host.batchTaskOp(teamId, args, actor)
    },

    /* ── CHG-76：批量建任务（从目标出草稿 → 预览 → 一次创建）── */
    /** `myteam_create_tasks` */
    createBatch(teamId        , args                         , actor        )                          {
      return host.createTasksBatch(teamId, args, actor)
    },

    /**
     * `myteam_reassign_task` / `myteam_revoke_attempt`：两个工具**共用**一段实现，
     * 由 `name` 分叉（`reassign: true` + 交接票据 vs `parkedAttempts` 留痕）。
     */
    revokeOrReassign(name        , teamId        , args                         , actor        )                          {
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
                                         
                                                                                   
                                      

                        
                                                                               

                                         
                                                                           

                                              
                                                                       

                                                                 
                      
                   
                   
                  
                             
                                                                           

                                                          
                                                                                                                           

                                                                    
                                                                                

     
                                                        
    
                                                          
                                     
     
                                                                                                                                      

                                              
                                                                                                            

                                         
                                         

                                                             
                                                        

     
                                                                
                                                         
     
                         
 

export function createMemberTaskHandlers(host                        ) {
  return {
    /** `myteam_get_task`：修订后 attemptId 只发给当前持有人 */
    get(teamId        , member                , args                         , _actor        )                          {
      const svc = host.service(teamId)
      const t = svc.projectionSnapshot.tasks[String(args.taskId)]
      if (!t) return { status: 'error', code: 'MT_VALIDATION', message: `task "${args.taskId}" not found` }
      // 修订：attemptId 只发给当前持有人（原实现 t.attemptId === t.attemptId 恒真，泄漏给任意成员）
      const ownAttempt = t.assignee === member.memberId ? t.attemptId : undefined
      /* CHG-213（实机）：可选字段**不能**写成 `key: undefined`。工具返回值要过 lossless JSON
       * 校验（`tools.register` 的 output schema），一个 undefined 就让整次读取失败——成员在
       * **认领前**读任务时实测报 `invalid output: value is not lossless JSON`（认领后 task 有
       * attemptId 才恢复正常）。deliverableSpec 同理（非叶子任务没有它）。 */
      return {
        status: 'ok',
        task: {
          id: t.id,
          title: t.input.title,
          description: t.input.description,
          acceptanceCriteria: t.input.acceptanceCriteria,
          deps: t.input.deps,
          requiredRole: t.input.requiredRole,
          priority: t.input.priority,
          state: t.state,
          escalateCount: t.escalateCount,
          ...(t.input.deliverableSpec !== undefined ? { deliverableSpec: t.input.deliverableSpec } : {}),
          ...(ownAttempt !== undefined ? { attemptId: ownAttempt } : {}),
        },
      }
    },

    /** `myteam_list_tasks`：返回行数 ≠ 已读全部内容（NFR-7.6） */
    list(teamId        , member                , args                         , _actor        )                          {
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
    claim(teamId        , member                , args                         , actor        )                          {
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
    update(teamId        , member                , args                         , actor        )                          {
      const svc = host.service(teamId)
      const status = String(args.status)
      const attemptId = String(args.attemptId)
      const taskId = String(args.taskId)
      const eventType = status === 'in_progress' ? 'task.progress' : status === 'done' ? 'task.completed' : status === 'paused' ? 'task.paused' : 'task.failed'
      const payload                          = { teamId, taskId, attemptId }
      if (status === 'in_progress') payload.progress = args.progress
      if (status === 'done') payload.summary = args.summary
      if (status === 'failed') { payload.reason = args.reason; payload.summary = args.summary }
      /* CHG-210 批 5.5：暂停只带理由（不带 summary——它没产出任何东西） */
      if (status === 'paused') payload.reason = args.reason
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
      const r = host.commit(teamId, { actor, type: eventType                       , payload })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      // P1-1 接线：`in_progress` 申报 = 阶段仍在进行，补拍基线（只补缺失键——
      // 首次基线固定，见 captureArtifactBaseline 的注释）。
      if (status === 'in_progress') host.captureArtifactBaseline(teamId, taskId)
      // FIX-10（KI-2 实弹）+ CHG-86：archive gate 落位校验接线。
      // 修复前的断链：这里只判 `state === 'gate:archive'`，而默认门禁链是
      // `['review','archive']` —— 任务 done 后进的是 `gate:review`，条件永不成立；
      // 加上没有任何 Lead 工具/面板端点能提交 review 裁决，任务永远到不了 done。
      // 现在：门禁链第一道是 archive → host 立即落位校验；是 review/verify → 提示等队长裁决。
      let gateNote                    
      // P1-5：环境不可用 latch 让交付判定转人工——此时**不能**把申报当 completed 放行
      let gateNeedsHuman = false
      if (status === 'done') {
        const tAfter = svc.projectionSnapshot.tasks[taskId]
        const declared = (args.deliverablePaths                        ) ?? []
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
      const draft = args.knowledgeDraft                              
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

    /** CHG-210 批 6.1：待批提案清单（队长侧入口）
     *
     * 缺陷现场：`proposalId` 只回给提交者，队长侧没有任何列表面——`read_task` 的 timeline
     * 只有 `seq/ts/actor/type` 不带 payload，而 `resolve_proposal` 又必须要 proposalId。
     * 于是 FR-11.4「队长批准才生效」在工具面**断链**：实际只能人去 `ledger.jsonl` 里抄 id。
     *
     * 为什么从投影派生而不是维护一个 id 队列：两份真相必然漂移（提案被删/任务被取消后
     * 队列里的 id 变成幽灵）。派生面永不漂移，代价只是查询时多算一次。 */
    listProposals(teamId        , args                         )                          {
      const proj = host.service(teamId).projectionSnapshot
      const want = typeof args.status === 'string' ? args.status : 'proposed'
      const items = Object.entries(proj.proposals)
        .filter(([, p]) => want === 'all' || p.status === want)
        .map(([proposalId, p]) => ({
          proposalId,
          taskId: p.taskId,
          type: p.type,
          status: p.status,
          title: proj.tasks[p.taskId]?.input.title ?? '',
          ...(p.proposerId ? { proposerId: p.proposerId } : {}),
        }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.proposalId.localeCompare(b.proposalId))
      return { status: 'ok', count: items.length, proposals: items }
    },

    /** `myteam_peer_message`：成员 → 成员消息（落账后 followup 唤醒） */
    peerMessage(teamId        , member                , args                         , actor        )                          {
      const to = String(args.toMemberId ?? '').trim()
      if (!to) return { status: 'error', code: 'MT_VALIDATION', message: 'toMemberId is required（发给谁？）' }
      /* CHG-210 批 6.5：**收件人必须存在**。
       *
       * 旧实现不校验：发给一个不存在的 id（包括 `'lead'`），账本照落 `message.sent`，
       * `agentOf(handle)` 拿到 undefined → followup 静默跳过，**发送方以为送达了**。
       * 这是最难查的一类失败：账本上说有、收件人那边什么都没有。
       *
       * 顺带把出口写进错误里：向队长上报是 `myteam_escalate_task`（会改状态、进 inbox、
       * 会被调度看见），发给人类是 `myteam_message({to:'inbox'})`——私讯不是这两个。 */
      if (!host.memberHandle(to)) {
        return {
          status: 'error',
          code: 'MT_VALIDATION',
          message: `成员 "${to}" 不在本团队（或已释放），消息**没有发送**。向队长上报请用 myteam_escalate_task；发给人类请用 myteam_message({ to: 'inbox' })`,
        }
      }
      const r = host.commit(teamId, { actor, type: 'message.sent', payload: { teamId, messageId: `msg-${Date.now()}`, from: member.memberId, to, taskId: args.taskId, content: args.content } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      host.agentOf(host.memberHandle(to))?.followup?.(host.followupMessage(`[myteam] 来自 ${member.instanceName} 的消息：${String(args.content)}`))
      return { status: 'sent' }
    },

    /**
     * `myteam_submit_review`（CHG-200）：**成员侧门禁裁决**——审查者 = 调用者本人。
     *
     * 为什么必须由成员提交（而不是队长代填 reviewerMemberId）：审查是成员的份内事，
     * 队长只做任务同步与成果检查。让队长代填，等于「谁都能以别人的名义下结论」——
     * 账本上的 reviewerMemberId 就成了一个没有主体的名字。
     *
     * 越权边界不在这里重写：`reviewTask` 的 `reviewer ≠ implementer` 硬校验
     * （MT_CROSS_REVIEW）与三门语义原样复用。
     */
    submitReview(teamId        , member                , args                         , actor        )                                                             {
      return host.reviewTask(teamId, { ...args, reviewerMemberId: member.memberId }, actor)
    },

    /** `myteam_wait_for_change`：长轮询（P2-1：把自己传进去，活跃 peer 判定要排除自己） */
    waitForChange(teamId        , member                , args                         , _actor        )                          {
      // 成员侧等待：与 Lead 侧同一异步长轮询实现（工具 execute 返回 Promise，
      // 宿主工具管线 await 之；不再阻塞事件循环）。
      // P2-1：把「本人」传进去——活跃 peer 判定要排除自己（自己等自己必然空转）
      return host.waitForChange({ ...args, teamId, memberId: member.memberId })                                      
    },

    /** `myteam_propose_task_change`：提案进队长队列（FR-11.4：批准才生效） */
    propose(teamId        , member                , args                         , actor        )                          {
      const proposalId = `prop-${Date.now()}`
      const r = host.commit(teamId, { actor, type: 'task.proposal', payload: { teamId, taskId: args.taskId, proposalId, type: args.type, payload: args.payload ?? {}, reason: args.reason, proposedBy: member.memberId } })
      return r.ok ? { status: 'proposed', proposalId, note: '提案进队长队列；批准才生效（FR-11.4）' } : { status: 'error', code: r.code, message: r.message }
    },

    /** `myteam_escalate_task`：升级到裁决面（FR-11.7；计数 >2 建议人工介入） */
    escalate(teamId        , member                , args                         , actor        )                          {
      const svc2 = host.service(teamId)
      const t = svc2.projectionSnapshot.tasks[String(args.taskId)]
      const count = (t?.escalateCount ?? 0) + 1
      const r = host.commit(teamId, { actor, type: 'task.escalated', payload: { teamId, taskId: args.taskId, attemptId: args.attemptId ?? t?.attemptId, reason: args.reason, evidence: args.evidence, suggestion: args.suggestion, count } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      return { status: 'escalated', count, note: count > 2 ? 'escalate 计数 >2：裁决面建议人工介入（FR-11.7）' : '任务已入 re-scoping，等待队长裁决' }
    },
  }
}


//# sourceURL=./src/host/tasks.ts