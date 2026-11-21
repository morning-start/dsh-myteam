/**
 * CHG-189（T159a）：spawn 生命周期（**行为边界**，不是端点边界）。
 *
 * 从一个成员「被召唤」到「上岗 / 上岗失败」的完整状态机：
 *
 * ```
 *   spawn()                settleActive()              settleFailure()
 *   provisioning 落账 ──┬─→ 投初始 prompt ──→ active ──→ 成员卡 + handle 回填
 *                       │        └─ 投递失败 ────────────→ failed（并释放 child）
 *                       └─ create 同步抛错 ──────────────→ failed
 *   probeProvisioned()  启动对账的探针（三条件：sessionExists / continuable / initialPromptAccepted）
 *   pendingMessages()   释放前「排空」判定的待投递消息计数（读账本，不读投影）
 * ```
 *
 * ## 为什么下沉（T159）
 *
 * `arch-report` 显示入口层占比 35.5% 没降：T155 已经搬走了**端点族**（case 层），剩下的
 * 5,563 行是**私有方法体**。按端点切已经到头，真正减入口层只有一条路——**按行为边界下沉**。
 * 本文件是三刀里的第一刀：spawn 生命周期（`host.ts` 里与「成员怎么出生、怎么上岗、怎么失败」
 * 有关的 5 个方法）。
 *
 * ## 逐字搬迁（纪律，不是口号）
 *
 * 方法体**一字不差**搬过来，只做一种形式适配：`this.X` → `deps.X()`（T155 的「宿主面」
 * 做法——凡是惰性 getter / 构造期才存在的字段，都以**方法**接出来，否则构造期取值会把
 * 「首次访问才解析」提前，日志顺序会变）。`git diff` 的删除行与本文件做规范化后比对：
 * **290 条逻辑行全部一字不差**（`tools` 侧脚本核验，见 CHG-189 变更记录）。
 *
 * 规范化规则（只有这两类，没有第三条）：
 *  1. `this.foo` → `deps.foo()`（惰性字段 / 私有方法）；
 *  2. `this.settleSpawnActive` → `settleActive`、`this.settleSpawnFailure` → `settleFailure`、
 *     `this.probeProvisionedSession` → `probeProvisioned`、`this.pendingMessagesFor` → `pendingMessages`
 *     ——**同一工厂内的兄弟方法**，不再是 `this` 成员；这是返回对象名与宿主方法名不同的**唯一**原因
 *     （目标形态要求 `{ spawn, settleActive, settleFailure, probeProvisioned, pendingMessages }`）。
 *
 * ## 依赖边界（为什么是 18 个，而不是「全能门面」）
 *
 * `SpawnLifecycleDeps` 只声明这 5 个方法**真正碰到**的宿主能力。有三类**不能**靠 import 解决，
 * 所以只能显式注入：
 *
 *  - `guardRule` / `memberToolDefs` 分别住在 `src/host/members.ts`（入口层）与 `src/tools/defs.ts`
 *    （工具声明层）。`core/**` import 它们 = `check-architecture.mjs` 的 **A1 门禁红**，并且
 *    `arch-report` 的「逆向 value 边」会从 0 变 2（domain depth 3 → tools depth 1 是逆向）。
 *  - `readLedgerEvents` / `isThenable` / `compileParameters` 是 `host.ts` 的**模块级函数**
 *    （不是类成员）——同理不能 import，只能注入。
 *  - `rt` / `memberHandles` / `disposalGate` 是宿主**运行时状态**（agents 服务、handle 表、
 *    准入闸门），它们的生命周期属于 host 进程，不属于领域层。
 *
 * `agents` / `memberHandles` 的 `any` 是**照抄** `host.ts` 的 `HostRuntime.agents?: any` 与
 * `memberHandles = new Map<string, any>()`——宿主服务形状本身未定形（宿主版本间会变），
 * 在这里收窄等于假装知道了。**不是** `as any` 蒙混：`as` 断言一个都没有。
 */
import { join } from 'node:path'
import { copyToProject, resolveRuntimeRole,                                     } from '../roles/role-store.mjs'
import { rosterOf, spawnLimitsOf, spawnTreeFields } from '../members/hierarchy.mjs'
import {
  buildToolMask,
  /* CHG-202y（FR-32）：C5 第 9 条——子成员工具集 ⊆ 父成员（纯函数，判定在掩码产物上） */
  childToolSubsetViolation,
  memberPromptSection,
  memberSessionId,
  memoryPromptSection,
  treeFieldsOf,
                      
} from '../members/member-setup.mjs'
import { applyCapabilityGuard, buildCapabilityBoundaryText, capabilitySummary, resolveCapabilities } from '../members/capability-guard.mjs'
import { memoryDirFor, seedMemoryIfMissing } from '../members/memory.mjs'
import { memoryBrief } from '../memory/recall.mjs'
import { writeMemberCard } from '../members/member-card.mjs'
import { knowledgeDirOf, listKnowledge, renderIndexSection } from '../knowledge/knowledge.mjs'
import { memberIdentityDir as memberIdentityDirOf, scratchDir as scratchDirOf, storeLayout } from '../workspace/layout.mjs'
import { writeTextAtomic } from '../fs/write-log.mjs'
import { outputForTool } from '../tools/output-contract.mjs'
                                                    
                                                                       
                                                                       
                                                             

/**
 * 工具声明（**只用到 `name`**，整份 def 原样透传给 `compileParameters`）。
 *
 * 为什么不是 `ToolDef`：`ToolDef` 在 `src/tools/defs.ts`（工具声明层，arch-report 层深 1），
 * `core/**`（领域层，层深 3）import 它是**逆向依赖**——A1 之外的「逆向 value 边」会从 0 变 1。
 * 所以这里只声明本文件真正读到的那一个字段，形态由装配处保证。
 */
                               
              
 

/** 宿主 agents 服务（`HostRuntime['agents']`；形状未定形，`any` 与 `host.ts` 同口径） */
                                   
              
                                                                   
                 
     
                                                           
    
                                                                           
                                             
     
                                 
                                       
                       
                                                                                                           
   
 

/**
 * CHG-206（P0 bug）：成员 agent 的模型选择。
 *
 * 角色声明 `model` 优先；否则用宿主默认模型（`ctx.agentDefaultModel.currentSelection()`）。
 * 为什么不能省：`agents.create` 不传 `agentOptions` 时，DSH 的 agent loop 在第一个 turn
 * 直接以 `agent "..." has no provider/model` 结束——账本上成员是 `active`，但永远不会 claim。
 */
function defaultModelSelection(rt                  )                                                                            {
  let service                                       
  try {
    service = (typeof rt.get === 'function' ? rt.get('agentDefaultModel') : rt.agentDefaultModel)                                         
  } catch {
    return undefined
  }
  if (!service || typeof service.currentSelection !== 'function') return undefined
  try {
    const selection = service.currentSelection()
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
    if (provider.length === 0 || model.length === 0) return undefined
    const reasoningEffort = typeof selection?.reasoningEffort === 'string' ? selection.reasoningEffort : undefined
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  } catch {
    return undefined
  }
}

/**
 * `ctx.subagents` 的**安全取值**（CHG-213 实机：整条 spawn 挂在 `without inject` 上）。
 *
 * 为什么不能直接 `rt().subagents`：插件 `inject` 只声明了 `tools/agents`，未 inject 的服务
 * **属性读会抛** `cannot get property "subagents" without inject` —— 这个异常发生在
 * `canActivate` 里，于是「子代理分支」和「回落 agents.create」一起挂掉，成员永远起不来，
 * 账本只留一条 `member.spawned{failed}`。把它写进 `inject` 也不行：那会让没有
 * subagents 服务的宿主**整个插件不激活**（队长工具也没了）。
 *
 * 与 CHG-206 的 `agentDefaultModel` 同一个坑 → 走显式 `get()`；老宿主没有 `get()` 时
 * 才回退属性读（包在 try 里）。取不到 = `undefined` = 回落 `agents.create`。
 */
function subagentsOf(rt                  )                                            {
  let service         
  try {
    service = typeof rt.get === 'function' ? rt.get('subagents') : undefined
  } catch {
    service = undefined
  }
  if (service === undefined) {
    try {
      service = (rt                                      ).subagents
    } catch {
      service = undefined
    }
  }
  return service                                             
}

/**
 * 子代理的模型可见名字：1–32 位、小写字母/数字/连字符、字母开头、不等于 `lead`。
 *
 * 为什么要带团队前缀：名字在**父会话**里必须唯一，而成员实例名是按团队编号的
 * （每个团队都有 `implementer-1`）——实测同一队长会话里开第二个团队，spawn 直接被拒：
 * `agent name "implementer-1" is already used by another subagent you created`。
 * 不合规/超长时返回 undefined（交给宿主自动分配 `agent-N`），不拿非法名字去撞。
 */
function subagentNameFor(teamId        , instanceName        )                     {
  const raw = `${teamId}-${instanceName}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (raw.length === 0) return undefined
  const name = /^[a-z]/.test(raw) ? raw : `mt-${raw}`
  if (name.length > 32 || name === 'lead') return undefined
  return name
}

/**
 * 起子代理：名字撞上就**去掉 name 重试一次**（宿主自动分配 `agent-N`）。
 * 只对「名字已被占用」重试——其它错误（深度超限、provider 变更）必须原样抛出，不能被吞。
 */
function activateChild(activation                                                                 , spec                         )          {
  try {
    return activation.startActivation(spec)
  } catch (error) {
    if (spec['name'] === undefined || !/already used|already exists/i.test(String((error                     )?.message ?? error))) throw error
    const { name: _drop, ...rest } = spec
    return activation.startActivation(rest)
  }
}

/**
 * spawn 生命周期的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 加成员前先问：这条逻辑能不能落在 `core/members/**`？只有「宿主进程才有的东西」
 * （agents 服务、handle 表、准入闸门、日志通道、service 缓存、账本提交）才该进这里。
 */
                                     
                                                        
                            
                                                  
                                                              
                                        
                             
                                
                                 
                                               
                                                       
                                                              
                                
                                            
                                          
                                             
                                                                                   
                                            
                                   
                                                              
                                       
     
                                           
                                                                   
     
                                                                            
     
                                                                   
                                                                  
                                          
     
                                           
     
                                                         
                                                                            
                                                                               
     
                                                                               
                                                                    
                                                                                                                
                                                                       
                                                            
                                           
                                                                                                                     
                                                               
                                                   
     
                                                                                   
                                                                        
     
                                                       
                                                                  
                                       
                                                               
                                                                                                          
                                                        
                                                                                                 
                                                                           
                                                               
 

/** 上岗引导文案（CHG-212 P4a：子代理路径把它放进 activation 的 prompt，旧路径仍走 followup——只此一处构造） */
function initialPromptText(teamId        , member                    )         {
  return `[myteam] 你已上岗（团队 ${teamId}，角色 ${member.roleId}）。请读板并领取与角色匹配的就绪任务（myteam_list_tasks → myteam_claim_task）；当前无就绪任务则用 myteam_wait_for_change 等待失效提示。`
}

export function createSpawnLifecycle(deps                    ) {
  /**
   * 两阶段 spawn（P0-1，docs/21 §6，来源官方 `types/roster.js:206-288`）：① 先落
   * `member.spawned{status:'provisioning'}`（名字 / sessionId / `maxMembers` 在此占用）→
   * ② 才 `agents.create` 建 child → ③ 拿到 handle 落 `status:'active'` 结算；④ 任何一步失败
   * 落 `status:'failed'` + `reason`，**不留 provisioning 残留**。
   *
   * 为什么先落账再建 child：宿主可能在建 child 中途崩掉，那一刻没有任何记录 = 永远不会被清理、
   * 也不会被唤醒的孤儿。**全程只有一个 memberId**（同 id 的更新事件，fold 按 id 覆盖），所以
   * 重试 / 对账重复结算都幂等——这是「崩溃后可按账本对账」的前提。
   *
   * CHG-187（FR-32 支柱一）：派生准入（深度 / 子数）在**任何 commit 之前**，被拒 = 账本零写入。
   */
  function spawn(teamId        , roleId        , instanceName         , overrides                                                                          = {})                          {
    if (!deps.rt().agents) return { status: 'error', code: 'MT_NO_AGENTS_SERVICE', message: 'ctx.agents unavailable' }
    // P1-4 准入截止：卸载已开始 → 新成员一律拒绝（不往正在拆的运行时里写 provisioning 账）
    if (deps.disposalGate().disposed) {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'host is disposing: member admission closed（卸载已开始，不再接新成员）' }
    }
    const svc = deps.service(teamId)
    // 运行时只认项目库（FR-10.2）；内置/全局/项目自身角色自动复制进项目库（引用即复制）
    if (!resolveRuntimeRole(deps.rolePaths(), roleId)) {
      const source = deps.roleCatalog().find((entry) => entry.definition.id === roleId)
      if (!source) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in any library` }
      const copy = copyToProject(deps.rolePaths(), roleId, source.origin, deps.contributionRoles())
      deps.log('info', `${source.origin} role "${roleId}" copied to project library: ${copy.filePath}`)
    }
    const n = Object.keys(svc.projectionSnapshot.members).length + 1
    const memberId = `m${n}-${roleId}`
    const sessionId = memberSessionId(teamId, roleId, n)
    // CHG-187（FR-32 支柱一）：派生准入（深度 / 子数）+ 算树字段——**任何 commit 之前**，
    // 被拒 = 账本零写入（不留 provisioning 残留）
    const tree = deps.guardRule(() => spawnTreeFields(rosterOf(svc.projectionSnapshot.members), memberId, overrides.parentMemberId ?? null, spawnLimitsOf(svc.effectiveConfig.limits)))
    if (!tree.ok) return tree.result
    const member                 = {
      memberId,
      roleId,
      instanceName: instanceName ?? `${roleId}-${n}`,
      sessionId,
      teamId,
      ...tree.value,
      ...(overrides.skills && overrides.skills.length > 0 ? { skills: overrides.skills } : {}),
      ...(overrides.mcpAllowlist && overrides.mcpAllowlist.length > 0 ? { mcpAllowlist: overrides.mcpAllowlist } : {}),
    }
    const roleDef = resolveRuntimeRole(deps.rolePaths(), roleId) .definition
    /* C5 第 9 条（CHG-202y / FR-32）：**子成员工具集 ⊆ 父成员**——派生是扩编，不是提权。
     * 与深度/子数准入同一位置（任何 commit 之前），被拒 = 账本零写入。 */
    if (overrides.parentMemberId) {
      const parent = svc.projectionSnapshot.members[overrides.parentMemberId]
      const parentRole = parent ? resolveRuntimeRole(deps.rolePaths(), parent.roleId) : undefined
      if (!parentRole) {
        return { status: 'error', code: 'MT_UNAVAILABLE', message: `delegation denied: parent member "${overrides.parentMemberId}" not found or its role is unavailable` }
      }
      const violation = childToolSubsetViolation(buildToolMask(parentRole.definition), buildToolMask(roleDef))
      if (violation) return { status: 'error', code: 'MT_UNAVAILABLE', message: `delegation denied (C5 #9): ${violation}` }
    }

    // ① 第一段：provisioning 先落账（崩溃在这里 = 启动时可对账，而不是孤儿）
    // maxMembers / 角色解析在 service.checkDomain（账本校验先行）
    const provisioningEvent = deps.commit(teamId, {
      actor: 'lead',
      type: 'member.spawned',
      payload: {
        teamId, memberId, roleId, instanceName: member.instanceName, sessionId, status: 'provisioning',
        ...treeFieldsOf(member),
        ...(member.skills ? { skills: member.skills } : {}),
        ...(member.mcpAllowlist ? { mcpAllowlist: member.mcpAllowlist } : {}),
      },
    })
    if (!provisioningEvent.ok) return { status: 'error', code: provisioningEvent.code, message: provisioningEvent.message }

    // ② 第二段：建 child。同步抛错与异步 reject 必须走**同一**失败结算（否则失败路径会分叉）
    // CHG-206（P0 bug）：角色声明 model 优先；没声明时用宿主默认模型。**不能**传 undefined——
    // 那会让成员 agent 的每个 turn 都以 `has no provider/model` 结束（账本 active 的空壳）。
    const model = roleDef.model ?? defaultModelSelection(deps.rt())
    // 没有模型选择 = 成员起来了也不会跑（每个 turn 都以 has no provider/model 结束）。
    // 不阻断（老宿主可能没有默认模型服务），但必须留痕，不能让「active 空壳」静默存在。
    if (!model) deps.log('warn', `member ${memberId} has no model selection (role "${roleId}" + agentDefaultModel unavailable); the agent will not run`)
    let created         
    try {
      /* CHG-212（ADR-010 P4a）：能走子代理就走子代理——成员进入子代理树，生命周期交给宿主。
       * C5 收窄由成员 preset 的懒应用负责（P4b），所以**所有角色**都走这条。
       * CHG-213：subagents 服务经 `subagentsOf` 取（未 inject 的属性直读会抛，见该函数注释）。 */
      const spawnCtx = deps.spawnContext?.()
      const activation = subagentsOf(deps.rt())
      const canActivate = spawnCtx?.agent !== undefined
        && typeof activation?.startActivation === 'function'
      if (canActivate) deps.markSubagent?.(memberId)
      created = canActivate ? activateChild(activation                                                                   , {
        provider: 'spawn',
        childId: sessionId,
        /* CHG-213（实机）：子代理名**在父会话里必须唯一**（同名直接拒绝：
         * `agent name "implementer-1" is already used by another subagent you created`）。
         * 成员实例名是按团队编号的（每个团队都有 implementer-1），所以名字必须带团队前缀；
         * 仍然撞名（同团队释放后重名）就退回「不指定名字，让宿主自动分配」。 */
        name: subagentNameFor(teamId, member.instanceName),
        label: member.instanceName,
        prompt: [{ type: 'text', text: initialPromptText(teamId, member) }],
        parent: spawnCtx .agent,
        agentPreset: 'myteam-member',
        delivery: 'caller',
        signal: spawnCtx .signal ?? new AbortController().signal,
      })
        : deps.rt().agents.create({
        sessionId,
        agentOptions: model
          ? { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
          : undefined,
        setup: async (agentCtx     , agent     ) => {
        // ① 成员工具 10 个（仅该成员可见）+ **条件**委派工具（角色 delegation.canSpawn 授权才注册）
        const toolDefs = [
          ...deps.memberToolDefs(),
          ...(roleDef.delegation?.canSpawn === true ? deps.delegationToolDefs() : []),
        ]
        for (const def of toolDefs) {
          const compiled = deps.compileParameters(def)
          agentCtx.tools.register({
            ...compiled,
            output: outputForTool(def.name),
            execute: (toolArgs                         ) => deps.executeMemberTool(member, def.name, toolArgs),
          })
        }
        // ② 角色工具策略收窄（C5：只收窄）。restrict 只过滤「继承的全局工具」，成员自己的 9 个
        //   工具是作用域内注册、永远可见（CHG-58 实证）：allow → 按全局已知名收窄（全被去掉 =
        //   deny 全部全局）；deny → 过滤未知名字（拼写错误只告警，不让整批拒绝）。
        const mask = buildToolMask(roleDef)
        if (mask.mode !== 'none' && typeof agentCtx.tools.restrict !== 'function') {
          // A7：宿主没有 restrict API 时旧实现静默跳过——角色 toolPolicy 一个字都没生效，
          // 日志里却看不出任何异常。降级必须留痕（成员卡/排查都以 warn 日志为准）。
          deps.log('warn', `member ${memberId} toolPolicy mask not enforced: host tools service has no restrict() API (mode=${mask.mode})`)
        } else if (mask.mode !== 'none') {
          const known = new Set(
            ((agentCtx.tools.schemas?.(agent) ?? [])                             )
              .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
              .filter((name) => name.length > 0),
          )
          if (mask.mode === 'allow') {
            const wanted = mask.allow ?? []
            const allow = wanted.filter((name) => known.has(name))
            const dropped = wanted.filter((name) => !known.has(name))
            if (dropped.length > 0) deps.log('info', `member ${memberId} allow list drops scoped/unknown tools: ${dropped.join(', ')}`)
            if (allow.length > 0) agentCtx.tools.restrict({ allow })
            else if (known.size > 0) agentCtx.tools.restrict({ deny: [...known] })
          } else {
            const deny = (mask.deny ?? []).filter((name) => known.has(name))
            const unknown = (mask.deny ?? []).filter((name) => !known.has(name))
            if (unknown.length > 0) deps.log('warn', `member ${memberId} deny list names unknown tools (ignored): ${unknown.join(', ')}`)
            if (deny.length > 0) agentCtx.tools.restrict({ deny })
          }
        }
        // ③ 角色提示词 + 工作纪律 section
        agentCtx.systemPrompt.section(memberPromptSection(roleDef, member))
        // ④ 知识库索引层常驻（FR-17.3：≤40 行预算；v2.7 audience 软过滤 + stale 徽标）
        const kbDir = knowledgeDirOf(deps.workspaceRoot())
        const kb = listKnowledge(kbDir)
        if (kb.length > 0) {
          const { text, truncated } = renderIndexSection(
            kb.map((e) => ({ id: e.id, title: e.title, tags: e.tags, updated: e.updated, unverified: e.unverified, core: e.core, staleSince: e.staleSince, proofCount: e.proofCount, audience: e.audience ?? [], words: 0 })),
            { audience: member.roleId },
          )
          if (truncated) deps.log('warn', `knowledge index over budget for ${memberId}`)
          agentCtx.systemPrompt.section({ name: `myteam:knowledge-index-${member.memberId}`, order: 101, text })
        }
        // ⑤ scratch 路径注入（FR-10.5；R26：目录由成员自建）
        agentCtx.systemPrompt.section({
          name: `myteam:scratch-${member.memberId}`,
          order: 102,
          text: `临时脚本一律写入 ${scratchDirOf(deps.workspaceRoot(), teamId, memberId)}（目录不存在时先创建；不入库、不进收口提交）。`,
        })
        // ⑥ 记忆纪律 section（T20：FR-6.2 证据指针 + FR-6.4 不宣告交接）
        const memDir = memoryDirFor(deps.workspaceRoot(), teamId, memberId)
        agentCtx.systemPrompt.section(memoryPromptSection(member, memDir, svc.effectiveConfig.memory?.evidenceRequired ?? true))
        // ⑥b 上岗记忆召回（CHG-212 / ADR-010）：SQLite bank 里的长期记忆压成一段提示词。
        // 子代理会话会被父级联释放，记忆不随会话走；这里只做「上岗那一刻的一次召回」，
        // 更多内容由成员自己调 myteam_recall（每轮注入是预算浪费）。失败不阻断 spawn。
        const brief = memoryBrief(deps.workspaceRoot(), teamId, memberId)
        if (brief.count > 0) {
          agentCtx.systemPrompt.section({ name: `myteam:memory-recall-${member.memberId}`, order: 105, text: brief.text })
        }
        // ⑦ 能力边界（CHG-54 声明 / CHG-58 硬隔离）：成员声明 > 角色声明；空 = 不启用隔离
        const caps = resolveCapabilities(roleDef, member)
        if (caps.skills.length > 0 || caps.mcpAllowlist.length > 0) {
          // A7：**先执行隔离、再写提示词**——section 是给模型的事实陈述，必须描述已经发生的
          // 事情。旧实现先无条件写「已硬隔离」再 await guard：宿主缺 restrict/registerProvider
          // 时隔离根本没生效，那句「已硬隔离」就是假话（模型会据此假设 allowlist 之外不可用）。
          // 两段都在 setup 内完成（setup resolve 前 section 必须注册好，不能拖到 then 里）。
          const guard = await applyCapabilityGuard(agentCtx, agent, caps, { workspaceRoot: deps.workspaceRoot() })
          agentCtx.systemPrompt.section({
            name: `myteam:capabilities-${member.memberId}`,
            order: 104,
            text: buildCapabilityBoundaryText(caps, guard),
          })
          if (guard.warnings.length > 0) deps.log('warn', `member ${memberId} capability guard: ${guard.warnings.join('; ')}`)
          else if (guard.mcpDenied.length > 0 || guard.skillsShadowed.length > 0) deps.log('info', `member ${memberId} capabilities enforced: ${capabilitySummary(guard)}`)
        }
      },
      })
    } catch (error) {
      // create 同步抛错：与异步 reject 走**同一**失败结算（落 failed + reason，不留 provisioning）
      return settleFailure(teamId, member, error)
    }
    // identity.json 快照（C3 不可变）+ 记忆区播种（T21，FR-6.1：幂等）：
    // 都是「成员真的存在」的派生事实，与 handle 是否先到无关，保持同步落盘
    // （异步宿主也不拖到 microtask——t33 直接读 identity 快照）。
    const identityDir = memberIdentityDirOf(deps.workspaceRoot(), teamId, memberId)
    writeTextAtomic(
      join(identityDir, 'identity.json'),
      `${JSON.stringify({ ...member, roleSnapshot: roleDef, spawnedAt: Date.now() }, null, 2)}\n`,
      { ensureParent: true },
    )
    // 记忆区播种（T21，FR-6.1：幂等；R26：host 进程 fs；notes/ 留给成员自建）
    const memSeed = seedMemoryIfMissing(memoryDirFor(deps.workspaceRoot(), teamId, memberId), member)
    if (memSeed.seeded) deps.log('info', `memory seeded for ${memberId}: ${memSeed.memoryMdPath}`)
    // ③ 结算段：FIX-14（KI-2 实弹）——`agents.create` 是 async（返回 Promise<AgentHandle>，
    // dsh-agent/lib/index.js:453），而同步桩返回 handle 本体。两种形状都必须**先拿到 handle**
    // 再结算，否则「create 已返回」会被误当成「child 已起来」。
    // 同步返回值走同步结算（投影立刻是 active，单测无需等 microtask）；Promise 走 then 结算。
    if (deps.isThenable(created)) {
      const settlement = Promise.resolve(created).then(
        (handle         ) => settleActive(teamId, member, handle),
        (error         ) => { settleFailure(teamId, member, error) },
      ).catch((e         ) => {
        // 结算段自身异常（不该发生）：已建成的 child 留在 provisioning，交给下次启动对账
        deps.log('warn', `member ${memberId} settle failed: ${String(e)}`)
      })
      // P1-4：在飞结算登记进准入闸门——`dispose()` 会**有界地**等它落完（不再「消失」）。
      // 关闸后 track 返回已拒绝的 Promise（这里必须消费掉，否则卸载期间冒 unhandled rejection）。
      void deps.disposalGate().track(settlement, `spawn:${memberId}`).catch(() => {})
    } else {
      const failure = settleActive(teamId, member, created)
      if (failure) return failure
    }
    // 回显派生树三字段（CHG-187）：调用方（面板/队长）拿得到 depth 才能确认「子成员真的挂上了」
    return { status: 'spawned', memberId, sessionId, ...treeFieldsOf(member) }
  }

  /**
   * 两阶段 spawn 的 **active 结算段**（官方 `checkpointInitialPrompt` → `settleProvisioning(active)`）。
   *
   * 顺序是**先投递初始 prompt、再落 active**：反过来一旦投递失败就留下「账本 active 但从不干活」
   * 的静默僵尸（CHG-77）；先投递则崩溃窗口里的成员停在 provisioning，下次启动的三条件对账能自愈
   * （初始 prompt 已在会话里 → `initialPromptAccepted`）。`followup` 没有 durable 回执（宿主不给），
   * 所以「投递没抛错」是这里能拿到的最强证据，真正的 durability 判定留给启动对账。
   * 成员卡（CHG-135）与 handle 回填都在这里：只有真建成的成员才配拥有。
   */
  function settleActive(teamId        , member                , handle         )                                      {
    /* CHG-212（ADR-010 P4a）：子代理 activation 的 prompt 已随 `startActivation` 投递，
     * 不能再 followup（会重复上岗）。后续消息改用 live Agent 投递，所以 handle 换成 Agent 本体。 */
    const activation = handle                                                             
    const activated = activation?.childId !== undefined && typeof activation.dispose === 'function'
    if (activated) {
      deps.rememberActivation?.(member.memberId, () => activation .dispose())
      handle = deps.rt().agents?.get(String(activation .childId)) ?? handle
    }
    // ① 初始 prompt（上岗引导）：投不出去 = 成员起来了却不知道做什么 → 按失败结算
    const agent = activated ? undefined : deps.agentOf(handle)
    if (!activated && !agent?.followup) {
      /* 不能静默跳过：optional chain 会让「handle 形状不认识」变成 active 空壳
       * （账本 active，但成员从没收到过任何消息）。 */
      const failure = settleFailure(teamId, member, new Error('agent handle has no followup; cannot deliver initial prompt'))
      try { void (handle                                           )?.dispose?.() } catch { /* 排空尽力而为 */ }
      return failure
    }
    if (!activated) try {
      agent .followup(deps.followupMessage(initialPromptText(teamId, member)))
    } catch (error) {
      const failure = settleFailure(teamId, member, error)
      // 初始 prompt 投不进去的 child 不能留着「假装在跑」：尽力释放（失败只告警）
      try { void (handle                                           )?.dispose?.() } catch { /* 排空尽力而为 */ }
      return failure
    }
    // ② 结算 active（同 memberId 的更新事件；fold 按 memberId 覆盖 = 幂等）
    const settled = deps.commit(teamId, {
      actor: 'host',
      type: 'member.spawned',
      payload: {
        teamId, memberId: member.memberId, roleId: member.roleId, instanceName: member.instanceName, sessionId: member.sessionId, status: 'active',
        ...treeFieldsOf(member),
        ...(member.skills ? { skills: member.skills } : {}),
        ...(member.mcpAllowlist ? { mcpAllowlist: member.mcpAllowlist } : {}),
      },
    })
    if (!settled.ok) {
      // child 已建成但结算没落账：**不能假成功**——账本停在 provisioning，下次启动对账接手
      deps.log('warn', `member ${member.memberId} spawned but settle(active) rejected: ${settled.code} ${settled.message}`)
      deps.memberHandles().set(member.memberId, handle)
      return
    }
    // ③ 成员卡落盘（CHG-135，docs/20 §5.2）：`sessionId` 只写在团队目录内，不散落全局；
    //    写失败只告警（账本才是权威，卡片是「重启后可查」的便利事实）
    try {
      writeMemberCard(join(storeLayout(deps.workspaceRoot()).tasks, String(teamId)), {
        version: 1,
        memberId: String(member.memberId),
        teamId: String(teamId),
        roleId: String(member.roleId),
        instanceName: String(member.instanceName ?? ''),
        ...(member.sessionId ? { sessionId: String(member.sessionId) } : {}),
        ...(member.skills ? { skills: member.skills.map((skill) => String(skill)) } : {}),
        ...(member.mcpAllowlist ? { mcpAllowlist: member.mcpAllowlist.map((item) => String(item)) } : {}),
        ...treeFieldsOf(member),
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch (error) {
      deps.log('warn', `member card write failed (${String(member.memberId)}): ${String((error                     )?.message ?? error)}`)
    }
    deps.memberHandles().set(member.memberId, handle)
  }

  /**
   * 两阶段 spawn 的 **failed 结算段**：同 memberId 落 `status:'failed'` + `reason`（`provisioning`
   * 只有 active / failed 两个合法出口，失败不落账会留下**永久 provisioning**——既不能重试也不能
   * 清理，docs/15 R1）。结算被拒（如角色已从项目库删除）只告警：残留交给下次启动对账，但本次
   * 失败原因必须同时进日志与工具返回，不能静默。
   */
  function settleFailure(teamId        , member                , error         )                          {
    const reason = String((error                     )?.message ?? error ?? 'unknown spawn failure')
    const settled = deps.commit(teamId, {
      actor: 'host',
      type: 'member.spawned',
      payload: { teamId, memberId: member.memberId, roleId: member.roleId, instanceName: member.instanceName, sessionId: member.sessionId, status: 'failed', reason, ...treeFieldsOf(member) },
    })
    if (!settled.ok) {
      deps.log('warn', `member ${member.memberId} spawn failed and settle(failed) rejected: ${settled.code} ${settled.message}`)
    }
    deps.log('warn', `member ${member.memberId} spawn failed: ${reason}`)
    // 回显 memberId/sessionId：失败也已在账本里占了一个（failed）成员，调用方要能定位它
    // （重试 / 面板排查 / 对账），而不是只拿到一句错误。
    return { status: 'error', code: 'MT_INTERNAL', message: `spawn member ${member.memberId} failed: ${reason}`, memberId: member.memberId, sessionId: member.sessionId }
  }

  /**
   * 对账探针（宿主侧 IO，纯函数 `reconcileProvisioning` 的注入点）。
   *
   * 三条件的宿主口径（`agents.get(sessionId)` 是官方 lookup 口径，`panel.ts` 注释同源）：
   *  - `sessionExists`：`agents.get(sessionId)` 拿得到 Agent（拿不到 = child 不存在）；
   *  - `continuable`：Agent 暴露 `descriptor.mode` 时按它判；本运行时的成员由 `agents.create`
   *    建成 continuable 驻留会话（ADR-001），未暴露描述符时按 continuable 处理——
   *    否则每次崩溃恢复都会把**活着的**成员误判 failed；
   *  - `initialPromptAccepted`：会话事件流里是否已有 user 消息（官方 `messageAccepted` 同口径）。
   *    读不到（宿主没暴露事件流）按 **false** 处理：证明不了「已上岗」就不能报 active。
   */
  function probeProvisioned(sessionId        )                          {
    const dead                          = { sessionExists: false, continuable: false, initialPromptAccepted: false }
    if (sessionId.length === 0) return dead
    const agents = deps.rt().agents
    if (!agents || typeof agents.get !== 'function') {
      // 没有 agents 服务 = 没有 child 能活；这不是「探针失败」，是「不存在」
      return dead
    }
    let handle         
    try {
      handle = agents.get(sessionId)
    } catch (e) {
      deps.log('warn', `spawn reconcile probe failed for session ${sessionId}: ${String(e)}`)
      return dead
    }
    if (!handle) return dead
    const agent = handle                                                                                          
    const session = (agent.session ?? handle)                           
    const descriptorMode = agent.descriptor?.mode ?? agent.mode ?? (session?.descriptor                                  )?.mode
    const continuable = descriptorMode === undefined ? true : descriptorMode === 'continuable'
    let initialPromptAccepted = false
    try {
      const snapshotEvents = (session                                                  ).snapshotEvents
      const events = typeof snapshotEvents === 'function' ? snapshotEvents.call(session, 0) : undefined
      initialPromptAccepted =
        Array.isArray(events) &&
        events.some((event) => {
          const e = event                                                                                              
          return e?.source?.kind === 'user' || e?.message?.source?.kind === 'user' || e?.message?.role === 'user'
        })
    } catch {
      initialPromptAccepted = false
    }
    return { sessionExists: true, continuable, initialPromptAccepted }
  }

  /**
   * CHG-93（清 §7.4 遗留硬编码）：成员待处理消息数（`message.sent` 里 `to === memberId` 且对应
   * `messageId` 尚未 `message.consumed` 的条数）。释放是**不可逆**动作（`mode:'remove'` 会删私有
   * 空间），它宣称的「排空」必须是真的——硬编码 0 等于账本上写假结论。读**账本**而不是投影：
   * 投影的 `inbox` 只为面板人工待办聚合，不带收件人。
   */
  function pendingMessages(teamId        , memberId        )         {
    try {
      const events = deps.readLedgerEvents(deps.service(teamId).ledgerPath).events
      const sent = new Set        ()
      const consumed = new Set        ()
      for (const event of events) {
        const payload = (event.payload ?? {})                           
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : ''
        if (!messageId) continue
        if (event.type === 'message.sent' && String(payload.to ?? '') === memberId) sent.add(messageId)
        else if (event.type === 'message.consumed') consumed.add(messageId)
      }
      let pending = 0
      for (const messageId of sent) if (!consumed.has(messageId)) pending += 1
      return pending
    } catch (e) {
      // 读账本失败不该阻断释放（释放是排空动作），但必须留痕——0 是「读不到」而不是「真的没有」
      deps.log('warn', `drained.pending unavailable for ${teamId}/${memberId}: ${String(e)}`)
      return 0
    }
  }

  return { spawn, settleActive, settleFailure, probeProvisioned, pendingMessages }
}


//# sourceURL=./src/core/members/spawn-lifecycle.ts