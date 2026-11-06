/**
 * D3 成员域（T6）：成员 setup 组装管线（ADR-001/003）。
 *
 * 成员经 ctx.agents.create({sessionId, agentOptions, setup}) 直连创建；
 * setup(agentCtx, agent) 作用域内：
 *   ① 注册 8 个成员工具（tools/member-tools.ts 定义，此处接线）
 *   ② agentCtx.tools.restrict(allowMask) —— 角色工具策略收窄（C5，只收窄）
 *   ③ agentCtx.systemPrompt.section(角色提示词)
 *   ④ agentCtx.skills.registerProvider(角色绑定技能)（M2 完整；M1 预留接口）
 * 团队协调工具（8 个）永不进入 restrict 的 deny 名单（安全不变量）。
 *
 * 本文件保持宿主无关：组装逻辑纯函数化，宿主接线（真 agents.create）在 host.ts。
 */
                                                               

/** 9 个团队协调工具（FR-3.5 v2.5：永不可被策略关闭；v2.4 +claim_task，v2.5 +read_knowledge） */
export const TEAM_MEMBER_TOOLS = [
  'myteam_get_task',
  'myteam_list_tasks',
  'myteam_claim_task',
  'myteam_update_task',
  'myteam_peer_message',
  'myteam_wait_for_change',
  'myteam_propose_task_change',
  'myteam_escalate_task',
  'myteam_read_knowledge',
]         

/** 内置团队工具（宿主 experimental agentTeam；hideBuiltinTeamTools 要隐藏的名单，T0 实测 9 个） */
export const HOST_TEAM_TOOLS_TO_HIDE = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]         

                                 
                  
                
                      
                   
                
                                 
                   
                                           
                         
 

/**
 * 生成成员的 restrict 掩码（纯函数）。
 * 规则（C5）：
 *   - 角色 toolPolicy.deny → 直接进 deny 名单（团队工具除外，断言拒绝）
 *   - 角色 toolPolicy.allow → 白名单模式：掩码 = allow ∪ 团队工具（allow 只能收窄——
 *     不含的宿主工具被收走；团队工具永在白名单）
 *   - 无策略 → 无掩码（继承宿主全量，FR-3.5 只在声明策略时收窄）
 */
                           
                                 
                  
                 
 

export function buildToolMask(role                )           {
  const memberToolSet = new Set        (TEAM_MEMBER_TOOLS)
  const { toolPolicy } = role
  if (!toolPolicy || (!toolPolicy.allow && !toolPolicy.deny)) return { mode: 'none' }
  if (toolPolicy.deny) {
    for (const d of toolPolicy.deny) {
      if (memberToolSet.has(d)) {
        throw new Error(`[myteam] toolPolicy.deny cannot disable team coordination tool "${d}" (FR-3.5 invariant)`)
      }
    }
    return { mode: 'deny', deny: [...toolPolicy.deny] }
  }
  // allow 白名单：必须并入团队工具（否则成员无法协调）
  const allow = Array.from(new Set([...(toolPolicy.allow ?? []), ...TEAM_MEMBER_TOOLS]))
  return { mode: 'allow', allow }
}

/** 成员 sessionId 命名（ADR-001：mt-<teamId>-<roleSlug>-<n>，幂等恢复键） */
export function memberSessionId(teamId        , roleId        , n        )         {
  const slug = roleId.replace(/[^a-z0-9-]/g, '-')
  return `mt-${teamId}-${slug}-${n}`
}

/** 成员系统提示词 section 定义（setup 中经 agentCtx.systemPrompt.section 注入） */
export function memberPromptSection(role                , member                ) {
  return {
    name: `myteam:member-${member.memberId}`,
    order: 100,
    text: [
      `你是 myteam 团队「${member.teamId}」的成员 ${member.instanceName}（角色：${role.name}）。`,
      `职责：${role.description}`,
      '',
      '工作纪律：',
      `1. 用 myteam_claim_task 领取与角色匹配的就绪任务；一次只领一个（原子 claim，返回 attemptId）。`,
      `2. 所有 update_task 必须带当前 attemptId（陈旧 attemptId 被拒绝）。`,
      `3. done 申报必须附证据块 [Verification evidence]（kind=commands: 命令+退出码+断言数；或 kind=na: 显式 N/A+原因）。`,
      `4. AC 无法按当前口径达成时用 myteam_escalate_task 申报（附已尝试证据），不伪装完成。`,
      `5. 结构性建议（拆分/补依赖）用 myteam_propose_task_change 提案，等队长批准。`,
      `6. 与任务相关的沟通挂 taskId（进任务 thread 留痕）；纯协调消息可不挂。`,
      `7. 空闲无任务时保持静默（零请求）；用 myteam_wait_for_change 等待失效提示。`,
    ].join('\n'),
  }
}

/** scratch 区路径（FR-10.5；R26：成员自己 mkdir，不预创建） */
export function scratchPathFor(workspaceRoot        , teamId        , memberId        )         {
  return [workspaceRoot, '.team-workplace', 'state', 'scratch', teamId, memberId].join('/')
}

/**
 * 记忆纪律 section（T20，CHG-19；契约 docs/04 §1.2c；ADR-009）。
 * FR-6.2 证据指针纪律 + 知识沉淀引导（FR-17.4 候选池→策展正典）。
 * FR-6.4 不宣告交接（E6 反坑）：正面陈述身份连续性 + 显式禁止 handoff 动作。
 */
export function memoryPromptSection(member                , memoryDir        , evidenceRequired         ) {
  return {
    name: `myteam:memory-${member.memberId}`,
    order: 103,
    text: [
      `私有记忆区：${memoryDir}/（memory.md + notes/；跨会话保留，重启与上下文压缩都不会清空它）。`,
      '',
      '记忆写入纪律：',
      `1. 每条记忆必须带证据指针（taskId / 账本 seq / 文件路径），写在条目标题的下一行：evidence: <指针>。`,
      evidenceRequired
        ? `2. memory.evidenceRequired 已开启：无证据指针的记忆会被 host 审计并落账本（memory.audit 事件），队长可见。`
        : `2. 记忆证据指针当前为建议项（memory.evidenceRequired=false），但强烈建议保留。`,
      `3. 学到团队级知识（其他成员也需要的背景/坑/口径）：不要只写私有记忆——在 update_task done 申报附 knowledgeDraft 提案，经队长采纳沉淀进团队知识库。`,
      '',
      '交接纪律：',
      `4. 你是同一身份的延续（sessionId ${member.sessionId} 不变），不存在"上一代"——不要宣告交接、不要写"接替上代/新一代"、不要生成 handoff 交接摘要；恢复工作状态 = 直接读 memory.md 与账本（myteam_get_task / myteam_list_tasks）。`,
    ].join('\n'),
  }
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/members/member-setup.ts