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
import type { RoleDefinition } from '../roles/builtin-roles.ts'
import { scratchDir } from '../workspace/layout.ts'

/** 10 个团队协调工具（FR-3.5 v2.5：永不可被策略关闭；v2.4 +claim_task，v2.5 +read_knowledge，
 *  CHG-200 +submit_review——任务检查是成员的份内事，审查者 = 调用者本人） */
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
  'myteam_submit_review',
] as const

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
] as const

export interface MemberInstance {
  memberId: string
  roleId: string
  instanceName: string
  sessionId: string
  teamId: string
  /** 团队模板/队长覆写的技能绑定（空 = 继承角色） */
  skills?: string[]
  /** 团队模板/队长覆写的 MCP allowlist（空 = 继承角色） */
  mcpAllowlist?: string[]
  /**
   * CHG-187（FR-32 支柱一）：派生树。三个字段都由 `core/members/hierarchy.ts` 的
   * `spawnTreeFields` 算，这里只做承载（成员卡和账本 payload 都从同一份实例取，
   * 避免两处各算一遍算歪）。
   *
   * CHG-187b：**必填**——`spawnMember` 在任何 commit 之前就算好了三字段，缺省只可能来自
   * 「忘了接线的写入方」，那应该在编译期/写入端当场红，而不是在 `treeFieldsOf` 里
   * 悄悄补成「一级成员」（第二套默认值，见 `core/ledger/migrate.ts` 头注释）。
   */
  parentMemberId: string | null
  depth: number
  rootMemberId: string
}

/** CHG-187：实例 → 派生树三字段（**纯投影**：缺省值只存在于迁移里，这里不猜） */
export function treeFieldsOf(member: MemberInstance): { parentMemberId: string | null; depth: number; rootMemberId: string } {
  return { parentMemberId: member.parentMemberId, depth: member.depth, rootMemberId: member.rootMemberId }
}

/**
 * 生成成员的 restrict 掩码（纯函数）。
 * 规则（C5）：
 *   - 角色 toolPolicy.deny → 直接进 deny 名单（团队工具除外，断言拒绝）
 *   - 角色 toolPolicy.allow → 白名单模式：掩码 = allow ∪ 团队工具（allow 只能收窄——
 *     不含的宿主工具被收走；团队工具永在白名单）
 *   - 无策略 → 无掩码（继承宿主全量，FR-3.5 只在声明策略时收窄）
 */
export interface ToolMask {
  mode: 'none' | 'allow' | 'deny'
  allow?: string[]
  deny?: string[]
}

export function buildToolMask(role: RoleDefinition): ToolMask {
  const memberToolSet = new Set<string>(TEAM_MEMBER_TOOLS)
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

/**
 * C5 第 9 条（CHG-202y / FR-32）：**子成员工具集 ⊆ 父成员**。
 *
 * 为什么必须有：派生是**扩编**，不是提权。父成员能用的宿主工具，子成员不能凭空多出来——
 * 否则任何被授权派生的角色都能借「派生一个自己的副本」绕回被收走的工具。
 *
 * 判定在 {@link buildToolMask} 的产物上（掩码就是成员的真实工具面）：
 *  - 父 `none`（无策略 = 继承宿主全量）→ 子集恒成立；
 *  - 父 `allow` → 子必须是 `allow` 且 ⊆ 父 allow（子 `none` 也不行：那等于放开全量）；
 *  - 父 `deny` → 子的 allow 里不能出现父 deny 的名字。
 *
 * 返回 `null` = 通过；否则是拒绝说明（调用方转 `MT_UNAVAILABLE`，**在任何 commit 之前**）。
 */
export function childToolSubsetViolation(parent: ToolMask, child: ToolMask): string | null {
  if (parent.mode === 'none') return null
  if (parent.mode === 'allow') {
    if (child.mode !== 'allow') {
      return `parent is restricted (allow) but child mask is "${child.mode}" — child would inherit more tools than parent`
    }
    const allowed = new Set(parent.allow ?? [])
    const extra = (child.allow ?? []).filter((name) => !allowed.has(name))
    return extra.length > 0 ? `child tool set exceeds parent: ${extra.join(', ')}` : null
  }
  const denied = new Set(parent.deny ?? [])
  if (child.mode !== 'allow') return null
  const reenabled = (child.allow ?? []).filter((name) => denied.has(name))
  return reenabled.length > 0 ? `child re-enables tools the parent denies: ${reenabled.join(', ')}` : null
}

/** 成员 sessionId 命名（ADR-001：mt-<teamId>-<roleSlug>-<n>，幂等恢复键） */
export function memberSessionId(teamId: string, roleId: string, n: number): string {
  const slug = roleId.replace(/[^a-z0-9-]/g, '-')
  return `mt-${teamId}-${slug}-${n}`
}

/** 成员系统提示词 section 定义（setup 中经 agentCtx.systemPrompt.section 注入） */
export function memberPromptSection(role: RoleDefinition, member: MemberInstance) {
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
      `8. 任务检查由成员自己完成：审查他人的产出用 myteam_submit_review 提交门禁裁决（不能审自己实现的任务，MT_CROSS_REVIEW）；先核证据块再下结论，队长只做同步与成果检查。`,
    ].join('\n'),
  }
}

/** scratch 区路径（FR-10.5；R26：成员自己 mkdir，不预创建） */
export function scratchPathFor(workspaceRoot: string, teamId: string, memberId: string): string {
  return scratchDir(workspaceRoot, teamId, memberId)
}

/**
 * 记忆纪律 section（T20，CHG-19；契约 docs/04 §1.2c；ADR-009）。
 * FR-6.2 证据指针纪律 + 知识沉淀引导（FR-17.4 候选池→策展正典）。
 * FR-6.4 不宣告交接（E6 反坑）：正面陈述身份连续性 + 显式禁止 handoff 动作。
 */
export function memoryPromptSection(member: MemberInstance, memoryDir: string, evidenceRequired: boolean) {
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
