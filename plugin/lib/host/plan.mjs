/**
 * CHG-186（T155c）：计划族端点适配层。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/scheduler/state.ts`（`validatePlan`）、`core/roles/**`（角色复制）、
 * `core/knowledge/**`（知识采集提示），装配与状态在 `host.ts`。方法体**逐字搬自**
 * `host.ts` 的 `switch (toolName)` 里对应 case，允许的差异只有：
 *   ① `this.` → `host.`（宿主面，见下）；
 *   ② `this.rolePaths` → `host.rolePaths()`（私有 **getter**，不能在装配处取值快照）；
 *   ③ `this.workspaceRoot` → `host.workspaceRoot()`（同上：惰性 getter，构造期取不到项目根）；
 *   ④ `resolveTeamLedgerPath(this.workspaceRoot, teamId)` → `teamLedgerPath(host.workspaceRoot(), teamId)`
 *      （前者就是后者的一行别名 wrapper，直接引 core 的纯函数，避免 `host/plan.ts → host.ts`
 *      的 value 环——见下）；
 *   ⑤ `readLedgerEvents(…)` 经宿主面透传（它是 `host.ts` 的模块级函数，import 回来同样成环）。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖 `resolveNewTeamId` / `countClarifyRounds` / `spawnMember` /
 * `taskWithGateChain` 等 `MyTeamHost` 的**私有**成员，而 TS 的私有成员不参与结构化赋值
 * （`private x` 满足不了接口里的 `x`）。两条路：把私有方法改成 public（扩大入口层 API，
 * 和「入口层只留装配」的方向相反），或者 `as` 强转（改名后编译器抓不到）。这里选第三条：
 * host.ts 传一个**只含用到的成员**的闭包对象进来——私有方法名一改，装配处立刻编译报错。
 *
 * ── 为什么不 import host.ts ───────────────────────────────────────────────────
 * `host.ts` 会 `import { createPlanHandlers } from './host/plan.mjs'`；反过来 import 就成
 * **value 环**（`arch-report` 的「环形依赖 — value 边」会从 0 变 1，运行时装载顺序变脆）。
 * 所以纯函数一律从 `core/**` 取，模块级 helper 走宿主面透传。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────────
 * 计划骨架里写的是 `async submit(args)`，但原 case 是**同步返回**（`executeLeadTool` 的
 * 返回类型是 `Record | Promise<Record>`）。给这几个方法加 `async` 会让原本同步的结果变成
 * Promise——调用方（`test/`、面板远程面）就地拿到 `[object Promise]`。所以保持同步：
 * 搬实现不搬异步语义。
 */
import { existsSync } from 'node:fs'
                                                                  
                                                                    
                                                                            
                                                                 
import { copyToProject, listRoleCatalog, readProjectRole } from '../core/roles/role-store.mjs'
import { presetTeamRoster } from '../core/roles/builtin-roles.mjs'
import { readPresetCatalog } from '../core/presets/preset-store.mjs'
import { configOverrideFromPreset, writeTeamConfigRaw } from '../core/config/team-config.mjs'
import { knowledgeDirOf, listKnowledge } from '../core/knowledge/knowledge.mjs'
import { validatePlan } from '../core/scheduler/state.mjs'
import { teamLedgerPath } from '../core/workspace/layout.mjs'

/**
 * 计划族用到的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this\." host.ts` 里 `myteam_submit_plan` / `approve_plan` /
 * `revise_plan` / `discard_plan` / `resolve_proposal` 五个 case 实际碰到的成员。
 * 加成员前先问：这条逻辑能不能落在 `core/**`（那才是规则该在的地方）。
 */
                                  
                                          
                                                                               

                                                                       
                                      

                                                            
                                     

                                           
                         

                                                 
                             

                                                       
                                                   

                             
                                

                                                      
                                                   

                                                
                                                                          

                                              
                                            

                                                          
              
                   
                   
                          
                                                               
                            

                                             
                                                                                           

                                                               
                                                                                                        

                                                               
                                                                                             
 

export function createPlanHandlers(host                 ) {
  return {
    /**
     * `myteam_submit_plan`：**建新团队**语义（团队 id 由 `resolveNewTeamId` 派生）。
     *
     * 为什么第一个参数带下划线：原 case 在块内**遮蔽重声明**了 `teamId`（见下面
     * `const teamId = newTeamId` 那段注释），所以外层 `executeLeadTool` 算出来的 `teamId`
     * 在这条分支里**不参与**任何计算。保留同形参数只为与其它端点一致；签名里标 `_` 是
     * 明示「这份值没用上」，而不是忘了用——FIX-17 明确禁止这里回落到 `defaultTeamId()`。
     */
    submit(_teamId        , args                         , actor        )                          {
      // FR-11.2 七项硬校验先行（修订：原实现 team.created 先落账、校验失败无法回滚，
      // 会在账本里留下"幽灵团队"；现在校验失败时零事件落账）。
      // FIX-17（KI-2 实弹）：submit_plan 是"建新团队"语义，teamId 缺省不能走 defaultTeamId()
      // （recent-mtime 会解析到别的活跃团队，账本落错地方）。改为显式 teamId 优先，
      // 否则从团队名 slug 派生，与既有团队冲突时自动加 -N 后缀。
      const newTeamId = host.resolveNewTeamId(args.teamId                      , String(args.teamName))
      // CHG-70：同名团队已批准 → 拒绝重复提交（旧实现会落 team.created/plan.staged，
      // 把 active 团队打回 draft 并覆盖名字）。改名走 myteam_update_team；重建先解散。
      if (existsSync(teamLedgerPath(host.workspaceRoot(), newTeamId))) {
        const existing = host.service(newTeamId).projectionSnapshot
        if (existing.state === 'active') {
          return {
            status: 'error',
            code: 'MT_TEAM_STATE',
            message: `team "${newTeamId}" already exists and is active; 改名用 myteam_update_team，重建请先 myteam_disband`,
          }
        }
      }
      // 块级遮蔽：分支内既有 teamId 引用（validatePlan/commit/payload）统一指向新团队 id
      const teamId = newTeamId
      const presetId = typeof args.presetId === 'string' && args.presetId.trim() ? args.presetId.trim() : ''
      const preset = presetId ? host.presetCatalog().entries.find((entry) => entry.definition.id === presetId) : undefined
      if (presetId && !preset) {
        return { status: 'error', code: 'MT_VALIDATION', message: `team preset "${presetId}" not found (project/builtin)` }
      }
      const rosterIn = (args.roster ?? [])                                                                                           
      // v2.13/CHG-36 预置团队：未显式给名册时按内置模板成团（标准三人组：队长+需求验证+开发+验收）；
      // CHG-54：显式 presetId 时按项目/内置模板的 members 组队（队长隐式），成员可带技能/MCP 覆写。
      const usingPresetRoster = rosterIn.length === 0
      const roster = preset
        ? [{ roleId: 'captain' }, ...preset.definition.members]
        : usingPresetRoster ? presetTeamRoster('triad') : rosterIn
      // 模板/名册引用的角色：全局与内置先复制进项目库（运行时只认项目层，R13）
      const roleErrors           = []
      for (const entry of roster) {
        if (entry.roleId === 'captain') continue
        const catalogEntry = host.roleCatalog().find((item) => item.definition.id === entry.roleId)
        if (!catalogEntry) {
          roleErrors.push(`unknown role "${entry.roleId}"`)
          continue
        }
        if (!readProjectRole(host.rolePaths().projectRolesDir, entry.roleId)) {
          try {
            copyToProject(host.rolePaths(), entry.roleId, catalogEntry.origin, host.contributionRoles())
          } catch (e) {
            roleErrors.push(`role "${entry.roleId}": ${String((e                        ).message ?? e)}`)
          }
        }
      }
      if (roleErrors.length > 0) return { status: 'error', code: 'MT_VALIDATION', message: roleErrors.join('; ') }
      // CHG-55：模板的看板列/泳道/门禁/任务类型落成团队级 team.config.json——
      // 必须在 service(teamId) 首次创建之前写盘（TeamService 构造时读一次并缓存）。
      // 只对"新团队"落盘：同 id 续提/已存在团队不覆盖既有配置（避免编辑正在跑的团队）。
      const presetConfig = preset ? configOverrideFromPreset(preset.definition) : undefined
      const isNewTeam = !host.hasService(teamId) && !existsSync(teamLedgerPath(host.workspaceRoot(), teamId))
      let configApplied                      
      if (presetConfig && isNewTeam) {
        writeTeamConfigRaw(host.workspaceRoot(), teamId, presetConfig)
        configApplied = Object.keys(presetConfig)
      }
      const tasksIn = (args.tasks ?? [])                     
      const svc0 = host.service(teamId)
      /*
       * FR-1.3（CHG-173）：taskPlanning='template' —— DAG 来源二选一的另一档。
       * 队长没给任务（tasksIn 为空）且配置选了 template 时，按 `pipeline.stages`
       * 生成**内置固定流水线模板任务组**（线性链：每阶段一任务，deps 串成一条）。
       *
       * 三条边界（诚实第一）：
       *  ① 显式 tasks 永远优先——模板只补「队长没拆活」这一种空缺；
       *  ② 生成的 AC / 交付物路径是**占位**（description 注明 + 结果 note 提醒编辑），
       *     不假装这是一份想好的计划；路径走 archive 门禁时会如实 fail（落位校验），
       *     队长编辑后即可通过——宁可 needs-human 也不放水；
       *  ③ stages 为空或名册没有非队长角色 → 明确拒绝（MT_VALIDATION），
       *     不静默回退 captain 模式（配置说了 template 就按 template 办）。
       */
      let templateNote                    
      let tasksFinal = tasksIn
      if (tasksIn.length === 0 && (svc0.effectiveConfig.taskPlanning ?? 'captain') === 'template') {
        const stages = svc0.effectiveConfig.pipeline.stages
        const workers = roster.filter((entry) => entry.roleId !== 'captain')
        if (stages.length === 0 || workers.length === 0) {
          return {
            status: 'error',
            code: 'MT_VALIDATION',
            message: `taskPlanning='template' 需要 pipeline.stages 非空且名册含至少一个非队长角色（当前 stages=${stages.length}，非队长角色=${workers.length}）`,
          }
        }
        const slugOf = (raw        ) => String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        const used = new Set        ()
        const ids = stages.map((stage, i) => {
          const base = `stage-${slugOf(String(stage)) || `task-${i + 1}`}`
          let id = base
          let n = 2
          while (used.has(id)) { id = `${base}-${n}`; n += 1 }
          used.add(id)
          return id
        })
        tasksFinal = stages.map((stage, i) => ({
          id: ids[i],
          title: String(stage),
          description: `模板流水线任务组（FR-1.3 taskPlanning:'template'）：阶段「${String(stage)}」，由配置自动生成——验收标准与交付物路径是占位，approve 前请按实际目标编辑。`,
          acceptanceCriteria: [`「${String(stage)}」阶段完成：产出落位并通过门禁链（模板占位，请按实际目标修改）`],
          deps: i === 0 ? [] : [ids[i - 1]],
          requiredRole: workers[i % workers.length].roleId,
          deliverableSpec: { path: `docs/${ids[i]}.md`, producer: workers[i % workers.length].roleId, reviewer: 'captain', archiver: 'captain' },
        }))
        templateNote = `taskPlanning='template'：已按 pipeline.stages 生成 ${ids.length} 个模板任务（线性链 ${ids.join(' → ')}）；AC 与交付物路径是占位，approve 前请用 myteam_edit_task 调整（FR-1.3）。`
      }
      const tasksMap                                          = {}
      for (let i = 0; i < tasksFinal.length; i++) tasksMap[String(tasksFinal[i].id ?? `task-${i + 1}`)] = tasksFinal[i]                           
      const rosterRoles = [...new Set([...roster.map((r0) => r0.roleId), 'captain'])]
      const planCheck = validatePlan(tasksMap         , svc0.effectiveConfig.limits.maxTasks, rosterRoles)
      if (!planCheck.ok) {
        return {
          status: 'error',
          code: 'MT_VALIDATION',
          message: planCheck.errors.map((e) => `task ${e.taskId}: ${e.message}`).join('; '),
        }
      }
      // 澄清轮先落账（FR-1.6：≤N 轮硬终止计数在账本）
      const clarify = args.clarify                                         
      if (clarify?.questions && clarify.questions.length > 0) {
        const round = host.countClarifyRounds(teamId) + 1
        const maxRounds = svc0.effectiveConfig.clarify.maxRounds
        if (round > maxRounds) {
          return { status: 'clarify-limit', message: `澄清已达 ${maxRounds} 轮硬终止；请用默认值+假设标注出草稿（FR-1.6）` }
        }
        const rc = host.commit(teamId, { actor, type: 'plan.clarify', payload: { teamId, questions: clarify.questions, round } })
        if (!rc.ok) return { status: 'error', code: rc.code, message: rc.message }
      }
      const r1 = host.commit(teamId, { actor, type: 'team.created', payload: { teamId, name: args.teamName, goal: args.goal, roster } })
      if (!r1.ok) return { status: 'error', code: r1.code, message: r1.message }
      const r2 = host.commit(teamId, { actor, type: 'plan.staged', payload: { teamId, planId: `plan-${Date.now()}`, roster, tasks: tasksFinal, ...(preset ? { presetId: preset.definition.id } : {}) } })
      if (!r2.ok) return { status: 'error', code: r2.code, message: r2.message }
      /*
       * CHG-163（docs/10 KI-9 / FR-17.4 沉淀时机①）：**onboarding 采集钩子**。
       *
       * 为什么放在返回里而不是「顺手写一条知识」：知识库是**策展制**（成员无写入口、
       * 队长也只能提案，采纳是人的动作）。规划轮能做的只有「提醒队长去采集」，
       * 替用户拍板等于把策展制偷偷改成自动记忆（TF ADR-0009 反例）。
       *
       * 触发条件（两条同时满足才提示，否则每次提计划都唠叨）：
       *  ① 知识库**一条条目都没有**（config/knowledge/ 为空）——已有沉淀说明采集过了；
       *  ② 本团队账本里**没有** `knowledge.proposed`——有人提过（哪怕还没采纳）就不再催。
       * 口径选「账本事件数」而不是「条目数」，是因为提案被驳回后条目仍为空：
       * 只看条目会反复催同一个已被否决的提案（R27 的唠叨反模式）。
       *
       * 非阻塞：多读一次知识库目录 + 一次团队账本（成团时账本只有个位数事件）；
       * 读不到就静默不提示——提示是附加信息，不是契约，绝不因它让 submit_plan 失败。
       */
      let knowledgeHint                    
      try {
        const kbEmpty = listKnowledge(knowledgeDirOf(host.workspaceRoot())).length === 0
        const proposedBefore = host.readLedgerEvents(teamLedgerPath(host.workspaceRoot(), teamId)).events
          .some((e) => e.type === 'knowledge.proposed')
        if (kbEmpty && !proposedBefore) {
          knowledgeHint =
            'onboarding 采集（FR-17.4 沉淀时机①）：本团队知识库还是空的。规划轮请先做一次采集——' +
            '采什么：团队目标、领域约束、用户明确说过的边界与偏好（「既非项目自带、也非协作状态」的团队级理解）；' +
            '怎么采：逐条起草后用 myteam_propose_knowledge 提案，**每条必须带证据**（task:/file:/session:/seq: 指针）；' +
            '谁定夺：只提案不入库，用户确认后由队长 myteam_adopt_knowledge 采纳才写进 config/knowledge/。' +
            '**不要凭印象编造条目**——没有证据就不提。'
        }
      } catch {
        /* 读知识库/账本失败不阻断提交（提示是附加信息，不是契约） */
      }
      return {
        status: 'staged',
        teamId,
        roster,
        ...(preset ? { presetId: preset.definition.id, presetName: preset.definition.name } : {}),
        ...(presetConfig && configApplied ? { configApplied } : {}),
        ...(knowledgeHint ? { knowledgeHint } : {}),
        ...(templateNote ? { templateNote } : {}),
        note:
          '草稿已暂存（无成员会话产生）；等待人工 Approve & Run / Revise / Discard' +
          (templateNote ? `；${templateNote}` : '') +
          (preset
            ? `；已应用团队模板「${preset.definition.name}」（队长 + ${preset.definition.members.length} 名队员）` +
              (configApplied ? `；配置段落已落团队：${configApplied.join('/')}` : '')
            : usingPresetRoster ? '；未显式提供名册，已应用预置团队「标准三人组」（队长+需求验证员+开发者+验收员）' : ''),
      }
    },

    approve(teamId        , args                         , actor        )                          {
      // 守卫：团队已 active（计划已批准过）→ 拒绝二次 approve，防止任务重复入库
      if (host.service(teamId).projectionSnapshot.state === 'active') {
        return { status: 'error', code: 'MT_VALIDATION', message: `plan already approved (teamId: ${teamId})` }
      }
      // FIX-11：先确认账本里有 staged 计划再落 plan.approved——否则"Approve & Run"
      // 会静默成功而 Run（自动召唤）无声跳过（t23-1 实弹回归暴露）。
      const stagedPlan = [...host.readLedgerEvents(teamLedgerPath(host.workspaceRoot(), teamId)).events]
        .reverse()
        .find((e) => e.type === 'plan.staged')
      if (!stagedPlan) {
        return { status: 'error', code: 'MT_VALIDATION', message: `no staged plan to approve (teamId: ${teamId})` }
      }
      const r = host.commit(teamId, { actor, type: 'plan.approved', payload: { teamId, planId: String(args.planId ?? 'plan-latest') } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      // FIX-9（KI-2 实弹）：Approve & Run 的 Run 由执行面落地——队长 turn 在提交计划后已结束，
      // 账本事件不会唤醒任何 LLM（wake 管线只覆盖成员四因果）。批准后按名册自动召唤成员
      // （跳过 captain——队长是 preset 会话本身），成员 followup 引导首轮自治 claim。
      // revise/discard 仍需队长改计划，走收件箱提醒（M1 面板可见，队长下次被 @ 时处理）。
      const staged = [...host.readLedgerEvents(teamLedgerPath(host.workspaceRoot(), teamId)).events]
        .reverse()
        .find((e) => e.type === 'plan.staged')
      const roster = (staged?.payload?.roster                                                                                                            ) ?? []
      const spawned           = []
      const spawnErrors           = []
      for (const entry of roster) {
        if (entry.roleId === 'captain') continue
        const out = host.spawnMember(teamId, entry.roleId, entry.instanceName, {
          skills: entry.skills,
          mcpAllowlist: entry.mcpAllowlist,
        })
        if (out.status === 'spawned') {
          spawned.push(String(out.memberId))
          // 上岗引导由 spawnMember 在 handle 到手后发出（FIX-14 内聚）
        } else {
          spawnErrors.push(`${entry.instanceName ?? entry.roleId}: ${String((out       ).message ?? (out       ).code ?? 'spawn failed')}`)
        }
      }
      // FIX-13（KI-2 实弹）：plan.staged 的任务只存在于计划 payload（fold 只置 state=draft，
      // 任务不进 tasksMap）——批准后成员上岗看到空板、无任务可 claim，"Run"断在任务上板。
      // 成员就位后把 staged 计划的任务逐条入库（task.created → backlog；必须先 spawn——
      // task.created 领域校验 rosterRoles 以投影成员角色为准，空投影会走草稿分支误拒）。
      //
      // CHG-169（FIX-13 增强）：**保留计划 id + deps 重映射**。旧实现无条件重编号 `task-N`，模板任务组
      // （stage-plan → stage-dev → …）与显式计划里带 deps 的任务会全部悬空——dep 指向
      // 计划里的 id，入库后不存在 → task.created 领域校验拒绝（DAG 断）。现在：
      // 计划 id 空闲 = 原样保留；被占用 = 重编号 task-N 兜底；deps 走 plan-id → final-id 映射。
      const stagedTasks = (stagedPlan.payload?.tasks                                              ) ?? []
      const projNow = host.service(teamId).projectionSnapshot.tasks
      const taken = new Set(Object.keys(projNow))
      let maxN = 0
      for (const id of Object.keys(projNow)) {
        const mm = /^task-(\d+)$/.exec(id)
        if (mm) maxN = Math.max(maxN, Number(mm[1]))
      }
      const planIdOf = (t                         ) => (typeof t.id === 'string' && t.id.trim() ? t.id.trim() : '')
      const idMap = new Map                ()
      for (const t of stagedTasks) {
        const want = planIdOf(t)
        if (!want) continue
        if (!taken.has(want)) { idMap.set(want, want); taken.add(want); continue }
        let finalId = `task-${maxN + 1}`
        maxN += 1
        while (taken.has(finalId)) { finalId = `task-${maxN + 1}`; maxN += 1 }
        idMap.set(want, finalId)
        taken.add(finalId)
      }
      const createdTasks           = []
      const createErrors           = []
      for (const t of stagedTasks) {
        const want = planIdOf(t)
        const finalId = want ? (idMap.get(want) ?? `task-${(maxN += 1)}`) : `task-${(maxN += 1)}`
        const deps = Array.isArray(t.deps) ? (t.deps             ).map((d) => idMap.get(String(d)) ?? String(d)) : undefined
        const taskInput = { ...t, ...(deps !== undefined ? { deps } : {}) }
        const r2 = host.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId: finalId, task: host.taskWithGateChain(teamId, taskInput) } })
        if (r2.ok) createdTasks.push(finalId)
        else createErrors.push(`create_task ${String(t.taskKey ?? finalId)}: ${r2.message}`)
      }
      return {
        status: 'approved',
        teamId,
        note: '成员召唤经 myteam_spawn_member 逐个执行（名册 → spawn）；staged 任务已入库上板',
        spawned,
        ...(createdTasks.length > 0 ? { createdTasks } : {}),
        ...(createErrors.length > 0 ? { createErrors } : {}),
        ...(spawnErrors.length > 0 ? { spawnErrors } : {}),
      }
    },

    revise(teamId        , args                         , actor        )                          {
      const r = host.commit(teamId, { actor, type: 'plan.revised', payload: { teamId, planId: String(args.planId ?? 'plan-latest'), note: args.note } })
      return r.ok ? { status: 'revised' } : { status: 'error', code: r.code, message: r.message }
    },

    discard(teamId        , args                         , actor        )                          {
      if (args.confirm !== true) return { status: 'confirm-required', message: 'Discard 是两段确认操作：草稿将归档且不会自动重建，请带 confirm=true 重调' }
      const r = host.commit(teamId, { actor, type: 'plan.discarded', payload: { teamId, planId: String(args.planId ?? 'plan-latest') } })
      return r.ok ? { status: 'discarded' } : { status: 'error', code: r.code, message: r.message }
    },

    resolveProposal(teamId        , args                         , actor        )                          {
      return host.resolveProposal(teamId, args, actor)
    },
  }
}


//# sourceURL=./src/host/plan.ts