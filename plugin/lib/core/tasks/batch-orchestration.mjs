/**
 * CHG-191（T159c）：批量编排（**行为边界**）——批量操作 / 批量建任务（前向引用拓扑序）/ 计划拆分物化。
 *
 * `host.ts` 里与「一次作用到多条任务」有关的 3 个私有方法**逐字**搬进本文件，宿主侧只剩一行
 * 转发（方法签名不变，调用点一个都没动）。这是入口层下沉三刀里的**第三刀**：
 * 第一刀 T159a 把 spawn 生命周期搬进 `core/members/spawn-lifecycle.ts`（5,563 → 5,311，
 * 入口占比 35.5% → 34.2%）；第二刀 T159b 把门禁执行搬进 `core/gates/gate-execution.ts`
 * （5,311 → 4,815，34.2% → 31.9%）；本刀收的是**批量落账**这一条行为链。
 *
 * ## 为什么是这三个方法
 *
 * 三条行为共用同一个骨架——「一批任务怎么逐条独立落账」：
 *
 * ```
 *   batchTaskOp()              ──→ 逐条独立落账（同一 batchId），个别失败不中断其余
 *   createTasksBatch()         ──→ 先按 after 拓扑排序（成环直接拒）再逐条 task.created
 *   materializeSplitProposal() ──→ split 载荷 → 逐条 task.created → 原任务 cancelled → 关联留痕
 * ```
 *
 * 三条都是**行为边界**，不是端点：不做整体原子性、失败逐条回显、同一 batchId 可回放。
 * 拆开搬会把这一份纪律切成三份互不知情的代码。
 *
 * **`resolveProposal` 没有搬**（留在 `host.ts` 原位）：它是提案裁决的**入口**——参数校验、
 * 按 `type` 分发（add-dep / reassign / cancel）、驳回留痕，与「物化」的载荷形状无关；它唯一
 * 与批量落账相关的那一步（split 批准 → 落子任务）已经在 `materializeSplitProposal` 里，通过
 * `deps.materializeSplit` 一行调用。硬搬它只会把「裁决」和「物化」两种职责重新搅在一起。
 *
 * ## 逐字搬迁（纪律，不是口号）
 *
 * 方法体**一字不差**搬过来，只做形式适配。规范化规则只有五类，没有第六类：
 *
 *  1. `this.service(` / `this.commit(` / `this.cancelTask(` / `this.rescopeTask(` /
 *     `this.taskWithGateChain(` / `this.applyTaskRelations(` → `deps.<同名>(`——宿主面能力；
 *  2. `isPlainObject(` → `deps.isPlainObject(`——`host.ts` 的**模块级**纯函数（A1 门禁：
 *     `core/**` 不能 import 入口层）；
 *  3. 方法声明 `private xxx(` → `function xxx(`——同一工厂内的兄弟方法不再是 `this` 成员。
 *     ⚠️ **声明名一律保留宿主名**（`batchTaskOp` / `createTasksBatch` /
 *     `materializeSplitProposal`），改名的只有唯一一处「对外表面」（返回对象里的
 *     `batchOp` / `createTasks` / `materializeSplit` 三个键），核验脚本能把「方法体逐字」
 *     与「表面改名」分开判；
 *  4. 局部变量 `const deps = Array.isArray(item.deps) ? … : []`（**任务依赖 id 列表**）→ `depIds`。
 *     这是本刀唯一一处「方法体贴了变量名」的地方，原因是硬约束：注入面就叫 `deps`，同名的
 *     `const deps` 会在方法体后半段**遮蔽注入面**（`deps.commit(…)` 就成数组调用了）——
 *     那不是形式问题，是真的行为变化。核验脚本把 `depIds` 规范化回 `deps` 再比对，
 *     所以它仍然算「一字不差」；
 *  5. `TERMINAL_STATES` / `downstreamOf` **不是** dep——它们来自
 *     `core/scheduler/state.ts`，core → core 是允许的（`gate-execution.ts` 同样直接 import
 *     `GATE_REJECT_BUDGET`）。
 *
 * 另有一处**注释**搬迁：`host.ts` 里 `createTasksBatch` 的 JSDoc（「批量建任务（CHG-76 /
 * FR-33）…」）历史上与 `resolveProposal` 的 JSDoc 叠成了两块相邻注释——前一块是**死注释**，
 * 不挂在任何方法上（中间没有别的声明）。本刀把它**原样**挪到本文件的 `createTasksBatch` 上方，
 * `host.ts` 侧改用一行指向本文件的短注释。注释不参与逻辑行比对，但记在这里，免得「凭空少了
 * 一段说明」。
 *
 * `git diff` 的删除行与本文件做规范化后比对：**N/M 条逻辑行全部一字不差**（见 CHG-191
 * 变更记录）。方法体内的注释也逐字保留——注释里的交叉引用仍写宿主侧方法名（`cancelTask` /
 * `taskWithGateChain` 等），改它们只会让「逐字」这件事不可机械核验。
 *
 * ## 依赖边界（为什么是 7 个，而不是「全能门面」）
 *
 * `BatchOrchestrationDeps` 只声明这 3 个方法**真正碰到**的宿主能力。有两类**不能**靠 import
 * 解决，所以只能显式注入：
 *
 *  - `isPlainObject` 是 `host.ts` 的**模块级函数**（不是类成员）——`core/**` import 入口层 =
 *    `check-architecture.mjs` 的 **A1 门禁红**，并且 arch-report 的「逆向 value 边」会从 0 变 1。
 *  - `service` / `commit` / `taskWithGateChain` / `applyTaskRelations` / `cancelTask` /
 *    `rescopeTask` 是宿主**运行时状态与通道**（团队服务缓存、账本写入口、门禁链装配、关系
 *    落账、取消与重规划的既有管线），它们的生命周期属于 host 进程，不属于领域层。
 *    `taskWithGateChain` 是 `gate-execution.ts` 的装配结果，`applyTaskRelations` /
 *    `cancelTask` / `rescopeTask` 仍是入口层的私有方法（自己还要落账、还要做终态校验）——
 *    这里注入的是**宿主装配后的那个形状**（闭包，惰性求值，构造期不调用任何方法）。若改成
 *    在 core 里持有 `this.tasks` / `this.gates` 字段再转发，会在两个工厂之间制造隐式环。
 *
 * 本文件一个 `as any` 都没有。
 */

                                                             
import { TERMINAL_STATES, downstreamOf } from '../scheduler/state.mjs'

/**
 * 批量编排的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 加成员前先问：这条逻辑能不能落在 `core/tasks/**`？只有「宿主进程才有的东西」
 * （团队服务缓存、账本提交、门禁链装配、关系落账、取消与重规划的既有管线、模块级纯函数）
 * 才该进这里。
 */
                                         
                                            
                                          
                                       
                                                                                   
                                                                           
                                                                                               
                                        
                                                                                                                               
                                                 
                                                                                                       
                                
                                                                                                        
                                                                
                                                                     
 

/**
 * 批量编排工厂。
 *
 * 返回对象的三个键是**对外表面**（`host.ts` 的一行转发用），声明名保留宿主名——
 * 理由见文件头「逐字搬迁」第 3 条（方法体里本来就有同名局部变量，改声明名会落进 TDZ）。
 */
export function createBatchOrchestration(deps                        ) {

  /**
   * 批量编排（CHG-73）：同一操作作用到多个任务，逐条独立落账（带同一 batchId）。
   * 个别失败不中断其余任务——面板要把「哪几条没成、为什么」原样告诉人。
   */
  function batchTaskOp(teamId        , args                         , actor        )                          {
    const op = String(args.op ?? '')
    if (!['cancel', 'rescope', 'assign', 'priority'].includes(op)) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'op must be cancel | rescope | assign | priority' }
    }
    const taskIds = Array.isArray(args.taskIds)
      ? [...new Set((args.taskIds             ).filter((id)               => typeof id === 'string' && id.length > 0))]
      : []
    if (taskIds.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'taskIds requires at least 1 task' }
    if (taskIds.length > 50) return { status: 'error', code: 'MT_VALIDATION', message: 'at most 50 tasks per batch' }
    const proj = deps.service(teamId).projectionSnapshot
    for (const id of taskIds) {
      if (!proj.tasks[id]) return { status: 'error', code: 'MT_VALIDATION', message: `task "${id}" not found` }
    }
    const reason = String(args.reason ?? '').trim()
    const memberIds = Array.isArray(args.memberIds)
      ? (args.memberIds             ).filter((id)               => typeof id === 'string' && id.length > 0)
      : []
    if ((op === 'cancel' || op === 'rescope') && !reason) {
      return { status: 'error', code: 'MT_VALIDATION', message: `${op} requires a non-empty reason` }
    }
    if (op === 'assign' && memberIds.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'assign requires memberIds' }
    const priority = String(args.priority ?? '')
    if (op === 'priority' && !['P0', 'P1', 'P2', 'P3'].includes(priority)) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'priority must be P0~P3' }
    }
    // CHG-76：批量取消也支持「重接线」——每个被取消任务的直接下游统一改挂到 rewireTo（缺省 = 解除依赖）。
    // 先做批量级前置校验：新上游不能是本批要取消的任务（否则改挂完立刻又死），且必须存在、非终态失败。
    const downstream                                = op !== 'cancel'
      ? 'leave'
      : args.downstream === 'cancel'
        ? 'cancel'
        : args.downstream === 'rewire'
          ? 'rewire'
          : 'leave'
    const rewireTo = typeof args.rewireTo === 'string' && args.rewireTo.trim().length > 0 ? args.rewireTo.trim() : undefined
    if (downstream === 'rewire') {
      if (rewireTo && taskIds.includes(rewireTo)) {
        return { status: 'error', code: 'MT_VALIDATION', message: `rewireTo "${rewireTo}" 在这一批里也要被取消；改挂到一个即将取消的任务等于把死锁换个位置` }
      }
      if (rewireTo) {
        const upstream = proj.tasks[rewireTo]
        if (!upstream) return { status: 'error', code: 'MT_VALIDATION', message: `task "${rewireTo}" not found in this team` }
        if (upstream.state === 'cancelled' || upstream.state === 'failed') {
          return { status: 'error', code: 'MT_VALIDATION', message: `task "${rewireTo}" is ${upstream.state}; 不能作为新的依赖` }
        }
      }
    }
    if (op === 'cancel' && args.confirm !== true) {
      const dependents = new Set        ()
      for (const id of taskIds) {
        for (const dep of downstreamOf(proj, [id])) {
          if (!TERMINAL_STATES.has(proj.tasks[dep]?.state ?? 'cancelled')) dependents.add(dep)
        }
      }
      // CHG-76：重接线要按任务列出各自要被改挂的直接下游（人才能判断"这一批会动几条边"）
      const rewireByTask = downstream === 'rewire'
        ? taskIds.map((id) => ({
          taskId: id,
          directDependents: Object.values(proj.tasks)
            .filter((t) => !TERMINAL_STATES.has(t.state) && (t.input.deps ?? []).includes(id) && !taskIds.includes(t.id))
            .map((t) => t.id),
        }))
        : undefined
      return {
        status: 'confirm-required',
        impact: {
          tasks: taskIds.length,
          dependents: [...dependents],
          ...(downstream !== 'leave' ? { downstream } : {}),
          ...(downstream === 'rewire' ? { rewireTo, rewireByTask } : {}),
        },
        message: `批量取消 ${taskIds.length} 个任务是不可逆操作（下游 ${dependents.size} 个任务）${downstream === 'cancel'
          ? '，将一并取消下游'
          : downstream === 'rewire'
            ? `，将把直接下游改挂到${rewireTo ? `「${rewireTo}」` : '独立任务（解除依赖）'}`
            : '，下游保持原状'}；确认请带 confirm=true`,
      }
    }
    const batchId = `batch-${Date.now()}`
    const results                                                                                                                                                                                     = []
    for (const id of taskIds) {
      let outcome                         
      if (op === 'cancel') {
        // CHG-76：rewireSkip = 本批其余任务（它们自己也要取消，不该被"改挂"）
        outcome = deps.cancelTask(teamId, {
          teamId,
          taskId: id,
          reason,
          downstream,
          ...(downstream === 'rewire' ? { rewireTo, rewireSkip: taskIds.filter((other) => other !== id) } : {}),
          confirm: true,
          batchId,
        }, actor)
      } else if (op === 'rescope') {
        outcome = deps.rescopeTask(teamId, { teamId, taskId: id, reason, patch: args.patch, batchId }, actor)
      } else if (op === 'assign') {
        const r = deps.commit(teamId, { actor, type: 'task.assigned', payload: { teamId, taskId: id, memberId: memberIds[0], memberIds } })
        outcome = r.ok ? { status: 'assigned' } : { status: 'error', code: r.code, message: r.message }
      } else {
        const current = deps.service(teamId).projectionSnapshot.tasks[id]
        const r = deps.commit(teamId, {
          actor,
          type: 'task.updated',
          payload: { teamId, taskId: id, patch: { priority }, changes: [{ field: 'priority', from: current?.input.priority ?? null, to: priority }] },
        })
        outcome = r.ok ? { status: 'updated' } : { status: 'error', code: r.code, message: r.message }
      }
      const ok = outcome.status !== 'error' && outcome.status !== 'confirm-required'
      results.push({
        taskId: id,
        ok,
        ...(typeof outcome.status === 'string' ? { status: outcome.status } : {}),
        ...(typeof outcome.code === 'string' ? { code: outcome.code } : {}),
        ...(typeof outcome.message === 'string' ? { message: outcome.message } : {}),
        ...(Array.isArray(outcome.rewired) && outcome.rewired.length > 0 ? { rewired: outcome.rewired                                                          } : {}),
        ...(Array.isArray(outcome.rewireErrors) && outcome.rewireErrors.length > 0 ? { rewireErrors: outcome.rewireErrors             } : {}),
      })
    }
    return {
      status: 'batch-done',
      batchId,
      results,
      summary: { total: results.length, ok: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length },
    }
  }

  /**
   * split 提案批准 → 落子任务（PRD 验收场景 16）。
   * 载荷形状：{ tasks: [{title, description?, acceptanceCriteria?, requiredRole?, priority?, deliverableSpec?, deps?}], deps?: string[] }
   * - 逐条 task.created（同一 batchId），失败逐条回显、不中断其余；
   * - 原任务转 cancelled（下游保持原状——改挂属结构决策，走 cancelTask 的 rewire 档，不在提案裁决里越权做）；
   * - 最后落 task.proposal.resolved 关联（账本可回放 task.proposal → task.created* → task.cancelled → task.proposal.resolved）。
   */
  function materializeSplitProposal(
    teamId        ,
    proposalId        ,
    originTaskId        ,
    payload                         ,
    args                         ,
    actor        ,
  )                          {
    const svc = deps.service(teamId)
    const proj = svc.projectionSnapshot
    const drafts = Array.isArray(payload.tasks) ? (payload.tasks             ) : []
    if (drafts.length === 0) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'split 提案缺少 tasks（要拆成哪些子任务）' }
    }
    if (drafts.length > 20) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'split 提案的子任务过多（上限 20）' }
    }
    const origin = proj.tasks[originTaskId]
    if (!origin) {
      return { status: 'error', code: 'MT_VALIDATION', message: `split 提案的原任务 "${originTaskId}" 不存在` }
    }
    let maxN = 0
    for (const id of Object.keys(proj.tasks)) {
      const m = /^task-(\d+)$/.exec(id)
      if (m) maxN = Math.max(maxN, Number(m[1]))
    }
    // 子任务默认继承原任务的角色/优先级/类型；deps 默认指向原任务之外（不自我依赖）。
    const inheritedRole = String(origin.input.requiredRole ?? '')
    const inheritedPriority = String(origin.input.priority ?? 'P2')
    const batchId = `split-${proposalId}`
    const created                                           = []
    const failed                                                          = []
    const allWarnings           = []
    let seq = 0
    for (const item of drafts) {
      seq += 1
      if (!deps.isPlainObject(item)) {
        failed.push({ title: `第 ${seq} 条`, code: 'MT_VALIDATION', message: '不是对象' })
        continue
      }
      const title = String(item.title ?? '').trim()
      if (!title) {
        failed.push({ title: `第 ${seq} 条`, code: 'MT_VALIDATION', message: 'title 必填' })
        continue
      }
      const taskId = `task-${maxN + seq}`
      const acRaw = Array.isArray(item.acceptanceCriteria)
        ? (item.acceptanceCriteria             ).filter((ac)               => typeof ac === 'string' && ac.trim().length > 0).map((ac) => ac.trim())
        : []
      const acceptanceCriteria = acRaw.length > 0 ? acRaw : [`完成「${title}」`]
      const depIds = Array.isArray(item.deps)
        ? [...new Set((item.deps             ).filter((d)              => typeof d === 'string' && d.length > 0))]
        : []
      // 叶子任务必须有交付物路径（FR-11.2 硬校验）。split 的子任务草案常常不写——
      // 那就**继承原任务的交付物路径并加后缀**（同一批产物分件落位），而不是整批失败。
      // 不静默造数据：继承来的路径会记进 warnings，随裁决结果一起回显。
      const warnings           = []
      let deliverableSpec = deps.isPlainObject(item.deliverableSpec) && typeof item.deliverableSpec.path === 'string'
        ? (item.deliverableSpec                                              )
        : undefined
      if (!deliverableSpec && depIds.length === 0) {
        const basePath = typeof origin.input.deliverableSpec?.path === 'string' ? origin.input.deliverableSpec.path : ''
        if (basePath) {
          const dot = basePath.lastIndexOf('.')
          const derived = dot > 0 ? `${basePath.slice(0, dot)}.${seq}${basePath.slice(dot)}` : `${basePath}.${seq}`
          deliverableSpec = { path: derived, producer: String(origin.input.requiredRole ?? '') }
          warnings.push(`未填交付物路径，已从原任务派生 ${derived}`)
        }
      }
      const task                          = {
        title,
        description: String(item.description ?? ''),
        acceptanceCriteria,
        deps: depIds,
        requiredRole: String(item.requiredRole ?? inheritedRole),
        priority: String(item.priority ?? inheritedPriority),
        ...(origin.input.taskType ? { taskType: origin.input.taskType } : {}),
        ...(deliverableSpec ? { deliverableSpec } : {}),
      }
      const r = deps.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: deps.taskWithGateChain(teamId, task), batchId, fromProposal: proposalId } })
      if (!r.ok) {
        failed.push({ title, code: r.code, message: r.message })
        continue
      }
      created.push({ taskId, title })
      if (warnings.length > 0) allWarnings.push(...warnings.map((w) => `${title}：${w}`))
    }
    if (created.length === 0) {
      // 一条都没建成：不落「已批准」——避免留下批准但零子任务的半截状态。
      return { status: 'error', code: 'MT_VALIDATION', message: 'split 提案的子任务全部创建失败', failed }
    }
    // 原任务转 cancelled（下游保持原状）。
    // confirm=true：提案已被队长明确批准 = 不可逆动作已获授权，不再要求二次确认
    //（否则裁决会停在一句「请带 confirm=true 重调」，批准等于没批准）。
    const cancelled = deps.cancelTask(teamId, { taskId: originTaskId, reason: `split by proposal ${proposalId}`, downstream: 'leave', confirm: true }, actor)
    if (cancelled.status === 'error') {
      return { status: 'error', code: cancelled.code, message: cancelled.message, created }
    }
    const rr = deps.commit(teamId, { actor, type: 'task.proposal.resolved', payload: { teamId, proposalId, decision: 'approved', note: args.note } })
    if (!rr.ok) return { status: 'error', code: rr.code, message: rr.message, created }
    return {
      status: 'approved',
      applied: 'split',
      created,
      ...(failed.length > 0 ? { failed } : {}),
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
      note: `已拆出 ${created.length} 个子任务；原任务 ${originTaskId} 已取消（下游保持原状）`,
    }
  }

  /**
   * 批量建任务（CHG-76 / FR-33）：把"一次想出的一批任务"当成一份草稿——
   * 预览先给出影响面（条数 / 角色分布 / 名册缺角色 / 依赖边 / 补齐项），确认后逐条独立落账（同一 batchId）。
   *
   * 三个刻意的取舍：
   *   1. **不做整体原子性**：一条失败不影响其余（人能看到哪几条成了、哪几条没成）；
   *   2. **按依赖顺序创建**：先建上游再建下游，避免"dep 不存在"的假失败（`after` 指向本批序号）；
   *   3. **草稿缺省补齐并留痕**：验收标准缺省用「完成「标题」」、叶子任务的交付物路径缺省用
   *      `docs/<taskId>.md`，都写进 warnings——草稿阶段卡"必须先想好验收标准"只会让人放弃批量。
   */
  function createTasksBatch(teamId        , args                         , actor        )                          {
    const raw = Array.isArray(args.tasks) ? (args.tasks             ) : []
    if (raw.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'tasks requires at least 1 draft' }
    if (raw.length > 30) return { status: 'error', code: 'MT_VALIDATION', message: 'at most 30 tasks per batch' }
    const proj = deps.service(teamId).projectionSnapshot
    let maxN = 0
    for (const id of Object.keys(proj.tasks)) {
      const m = /^task-(\d+)$/.exec(id)
      if (m) maxN = Math.max(maxN, Number(m[1]))
    }
    const idOf = (index        ) => `task-${maxN + index + 1}`
    const priorities = ['P0', 'P1', 'P2', 'P3']

                     
                   
                         
                          
                      
                       
                       
                                  
                                                                  
                    
                     
                         
                        
     

    const problems           = []
    const drafts          = []
    raw.forEach((item, index) => {
      const n = index + 1
      if (!deps.isPlainObject(item)) {
        problems.push(`第 ${n} 条：不是对象`)
        return
      }
      const title = String(item.title ?? '').trim()
      if (!title) problems.push(`第 ${n} 条：title 必填`)
      const requiredRole = String(item.requiredRole ?? '').trim()
      if (!requiredRole) problems.push(`第 ${n} 条：requiredRole 必填`)
      const priority = String(item.priority ?? 'P2')
      if (!priorities.includes(priority)) problems.push(`第 ${n} 条：priority 必须是 P0~P3`)
      const estimate = item.estimate === undefined || item.estimate === null ? undefined : Number(item.estimate)
      if (estimate !== undefined && (!Number.isFinite(estimate) || estimate <= 0)) problems.push(`第 ${n} 条：estimate 必须是正数`)
      const acList = Array.isArray(item.acceptanceCriteria)
        ? (item.acceptanceCriteria             ).filter((ac)               => typeof ac === 'string' && ac.trim().length > 0).map((ac) => ac.trim())
        : []
      const depIds = Array.isArray(item.deps)
        ? [...new Set((item.deps             ).filter((dep)                => typeof dep === 'string' && dep.length > 0))]
        : []
      const afterRaw = Array.isArray(item.after) ? (item.after             ) : []
      const after           = []
      for (const value of afterRaw) {
        const num = Number(value)
        if (!Number.isInteger(num) || num < 1 || num > raw.length) {
          problems.push(`第 ${n} 条：after 里的「${String(value)}」不是本批序号（1~${raw.length}）`)
          continue
        }
        if (num === n) {
          problems.push(`第 ${n} 条：after 不能指向自己`)
          continue
        }
        if (!after.includes(num)) after.push(num)
      }
      const assignees = Array.isArray(item.assignees)
        ? [...new Set((item.assignees             ).filter((id)               => typeof id === 'string' && id.length > 0))]
        : []
      const warnings           = []
      const ac = acList.length > 0 ? acList : []
      if (ac.length === 0 && title) {
        ac.push(`完成「${title}」`)
        warnings.push('未填验收标准，已用「完成「标题」」占位（可在详情页补）')
      }
      let deliverableSpec = deps.isPlainObject(item.deliverableSpec) && typeof item.deliverableSpec.path === 'string'
        ? (item.deliverableSpec                                              )
        : undefined
      if (!deliverableSpec && depIds.length === 0 && after.length === 0 && title) {
        deliverableSpec = { path: `docs/${idOf(index)}.md` }
        warnings.push(`叶子任务未填交付物路径，已用 docs/${idOf(index)}.md 占位`)
      }
      drafts.push({
        title,
        description: String(item.description ?? ''),
        requiredRole,
        priority,
        ...(estimate !== undefined ? { estimate } : {}),
        ...(typeof item.taskType === 'string' && item.taskType ? { taskType: item.taskType } : {}),
        acceptanceCriteria: ac,
        ...(deliverableSpec ? { deliverableSpec } : {}),
        deps: depIds,
        after,
        assignees,
        warnings,
      })
    })
    if (problems.length > 0) {
      return { status: 'error', code: 'MT_VALIDATION', message: problems.join('; '), problems }
    }

    // 依赖顺序：after 是本批内序号 → 建图做拓扑排序（成环直接拒，别写出半个 DAG）
    const indegree = drafts.map(() => 0)
    const adj             = drafts.map(() => [])
    drafts.forEach((draft, index) => {
      for (const target of draft.after) {
        const from = target - 1
        if (adj[from].includes(index)) continue
        adj[from].push(index)
        indegree[index] += 1
      }
    })
    const order           = []
    const queue           = []
    indegree.forEach((value, index) => { if (value === 0) queue.push(index) })
    while (queue.length > 0) {
      const current = queue.shift()          
      order.push(current)
      for (const next of adj[current]) {
        indegree[next] -= 1
        if (indegree[next] === 0) queue.push(next)
      }
    }
    if (order.length !== drafts.length) {
      return { status: 'error', code: 'MT_TASK_CYCLE', message: '这批草稿的 after 引用成环，无法确定创建顺序' }
    }

    const byRole                         = {}
    for (const draft of drafts) byRole[draft.requiredRole] = (byRole[draft.requiredRole] ?? 0) + 1
    const rosterRoles = new Set(Object.values(proj.members).map((member) => member.roleId))
    const rolesMissing = Object.keys(byRole).filter((role) => !rosterRoles.has(role))
    const edges = drafts.flatMap((draft, index) => draft.after.map((target) => ({ from: `draft-${target}`, to: `draft-${index + 1}` })))
    const allWarnings = drafts.flatMap((draft, index) => draft.warnings.map((w) => `第 ${index + 1} 条：${w}`))
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''

    if (args.confirm !== true) {
      return {
        status: 'confirm-required',
        impact: {
          tasks: drafts.length,
          byRole,
          rolesMissing,
          edges,
          ids: drafts.map((_, index) => `draft-${index + 1}`),
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        },
        message: `将创建 ${drafts.length} 个任务${goal ? `（目标：${goal}）` : ''}，角色分布 ${Object.entries(byRole).map(([role, count]) => `${role}×${count}`).join('、')}${rolesMissing.length > 0 ? `；名册里没有：${rolesMissing.join('、')}（这些会创建失败）` : ''}；确认请带 confirm=true`,
      }
    }

    const batchId = `batch-${Date.now()}`
    const failed = new Set        ()
    const created                                                          = []
    const results                                                                                                                                                   = []
    for (const index of order) {
      const draft = drafts[index]
      const brokenAfter = draft.after.filter((target) => failed.has(target - 1))
      if (brokenAfter.length > 0) {
        failed.add(index)
        results.push({ index, ok: false, title: draft.title, code: 'MT_DEPENDENCY_FAILED', message: `依赖的第 ${brokenAfter.join('、')} 条没建成，本任务跳过`, ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}) })
        continue
      }
      const taskId = idOf(index)
      const task                          = {
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: draft.acceptanceCriteria,
        deps: [...draft.deps, ...draft.after.map((target) => idOf(target - 1))],
        requiredRole: draft.requiredRole,
        priority: draft.priority,
        ...(draft.estimate !== undefined ? { estimate: draft.estimate } : {}),
        ...(draft.taskType ? { taskType: draft.taskType } : {}),
        ...(draft.deliverableSpec ? { deliverableSpec: draft.deliverableSpec } : {}),
      }
      const r = deps.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: deps.taskWithGateChain(teamId, task), batchId } })
      if (!r.ok) {
        failed.add(index)
        results.push({ index, ok: false, title: draft.title, taskId, code: r.code, message: r.message, ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}) })
        continue
      }
      const extras = draft.assignees.length > 0 ? deps.applyTaskRelations(teamId, taskId, { assignees: draft.assignees }, actor) : {}
      created.push({ index, taskId, title: draft.title })
      results.push({
        index,
        ok: true,
        title: draft.title,
        taskId,
        ...(Array.isArray(extras.assigned) ? { assigned: extras.assigned             } : {}),
        ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}),
      })
    }
    results.sort((a, b) => a.index - b.index)
    created.sort((a, b) => a.index - b.index)
    return {
      status: 'created',
      batchId,
      ...(goal ? { goal } : {}),
      tasks: created.map((item) => ({ taskId: item.taskId, title: item.title })),
      results,
      summary: { total: drafts.length, created: created.length, failed: drafts.length - created.length },
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    }
  }

  return {
    batchOp: batchTaskOp,
    createTasks: createTasksBatch,
    materializeSplit: materializeSplitProposal,
  }
}


//# sourceURL=./src/core/tasks/batch-orchestration.ts