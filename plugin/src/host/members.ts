/**
 * CHG-186（T155b）：成员族端点适配层。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/members/**`，装配与状态在 `host.ts`。方法体**逐字搬自** `host.ts` 的
 * `switch (toolName)` 里对应 case，允许的差异只有：
 *   ① `this.` → `host.`（宿主面，见下）；
 *   ② `this.memberHandles.get(id)` → `host.memberHandle(id)`（私有字段不外露）。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖 `spawnMember` / `releaseMember` / `deliverMemberMessage` / `agentOf` /
 * `noteGuardTurnEnd` / `memberHandles`，它们都是 `MyTeamHost` 的**私有**成员，而 TS 的
 * 私有成员不参与结构化赋值（`private x` 满足不了接口里的 `x`）。两条路：把私有方法改成
 * public（扩大入口层 API，且和「入口层只留装配」的方向相反），或者 `as` 强转（改名后
 * 编译器抓不到）。这里选第三条：host.ts 传一个**只含用到的成员**的闭包对象进来——
 * 私有方法名一改，装配处立刻编译报错。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────────
 * 计划里的骨架写的是 `async spawn(args)`，但原 case 是**同步返回**（`executeLeadTool`
 * 的返回类型是 `Record | Promise<Record>`）。给这几个方法加 `async` 会让原本同步的
 * 结果变成 Promise——调用方（`test/`、面板远程面）就地拿到 `[object Promise]`。
 * 所以保持同步：搬实现不搬异步语义。
 */
import type { CommitDraft, TeamService } from '../core/service.ts'
import type { GuardVerdict } from '../core/agent/guard.ts'
import type { MemberProjection } from '../core/scheduler/state.ts'
import { childrenOf } from '../core/members/hierarchy.ts'
/* CHG-202y（FR-32 · G1-2）：成员侧委派——两套授权源（delegation / toolPolicy）与子树归属 */
import { buildToolMask } from '../core/members/member-setup.ts'
import { resolveRuntimeRole, type RoleStorePaths } from '../core/roles/role-store.ts'
import { DELEGATION_TOOL_NAMES } from '../tools/defs.ts'

/**
 * 纯规则层（`core/**`）只抛 `MTError`，工具面必须**返回**错误结果。
 *
 * 为什么需要这层翻译：`executeLeadTool` 的兜底 `catch` 会把任何异常压成
 * `{code:'MT_INTERNAL'}`——`MT_HAS_CHILDREN` / `MT_DEPTH_EXCEEDED` 这些**可分支的码**就丢了，
 * 面板只能显示一句「内部错误」。这是「错误码是契约」的边界。
 */
export function guardRule<T>(rule: () => T): { ok: true; value: T } | { ok: false; result: Record<string, unknown> } {
  try {
    return { ok: true, value: rule() }
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? '')
    return {
      ok: false,
      result: { status: 'error', code: code.startsWith('MT_') ? code : 'MT_INTERNAL', message: String((error as Error | undefined)?.message ?? error) },
    }
  }
}

/**
 * 成员族用到的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this\." host.ts` 里 `myteam_spawn_member` / `release_member` /
 * `message` / `interrupt` 四个 case 实际碰到的成员。加成员前先问：这条逻辑能不能落在
 * `core/members/**`（那才是规则该在的地方）。
 */
export interface MembersHostSurface {
  /** 统一提交入口：成功后触发唤醒（不阻塞提交本身） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>

  /** 成员 spawn（`core/members/member-setup.ts` 装配）：角色 + 实例名 + 覆盖项（含 CHG-187 的父成员） */
  spawnMember(
    teamId: string,
    roleId: string,
    instanceName?: string,
    overrides?: { skills?: string[]; mcpAllowlist?: string[]; parentMemberId?: string },
  ): Record<string, unknown>

  /** 成员释放（两段确认）：suspend / archive / remove 由 `mode` 区分；`cascade` = 倒序级联释放子成员 */
  releaseMember(teamId: string, memberId: string, mode: string, confirm: boolean, actor?: string, cascade?: boolean): Record<string, unknown>

  /** A10：投递口径的唯一构造点（消息已落账 → 投不进去也不抛） */
  deliverMemberMessage(memberId: string, kind: string, content: string): boolean

  /** FIX-12：`agents.create` 返回形状未实证——双形状兼容（`{agent}` 包装 / agent 本体） */
  agentOf(handle: unknown): { followup?: (msg: unknown) => void; cancel?: (o: unknown) => void } | undefined

  /** 成员句柄（`memberHandles` 私有字段的只读取值口；`Map.get` 语义：不存在 → undefined） */
  memberHandle(memberId: string): unknown

  /** P1-5：回合结束时的空转检查（中断 / 释放两个「这一轮到此为止」的入口） */
  noteGuardTurnEnd(memberId: string): GuardVerdict | undefined

  /** CHG-187（FR-32）：名册只读面（**投影**是唯一真源；读不到 → 空数组，不编造成员） */
  membersOf(teamId: string): MemberProjection[]

  /** 角色库路径（**惰性 getter**：构造期取不到项目级角色目录） */
  rolePaths(): RoleStorePaths
}

export function createMembersHandlers(host: MembersHostSurface) {
  return {
    /** `myteam_spawn_member`：skills / mcpAllowlist 只保留字符串项（JSON 面收窄）；`parentMemberId` 走派生树 */
    spawn(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
      return host.spawnMember(teamId, String(args.roleId), args.instanceName ? String(args.instanceName) : undefined, {
        skills: Array.isArray(args.skills) ? args.skills.filter((skill): skill is string => typeof skill === 'string') : undefined,
        mcpAllowlist: Array.isArray(args.mcpAllowlist) ? args.mcpAllowlist.filter((name): name is string => typeof name === 'string') : undefined,
        // CHG-187（FR-32）：父成员 id（缺省 = 队长直接召唤的一级成员）
        parentMemberId: typeof args.parentMemberId === 'string' && args.parentMemberId.length > 0 ? args.parentMemberId : undefined,
      })
    },

    /**
     * 成员能否调用某个 CM 档工具（CHG-202y / FR-32 · G1-2）：**两套授权源，不许混**。
     *
     *  - 委派类（`myteam_spawn_member` / `myteam_release_member`）看角色 `delegation.canSpawn`
     *    ——这是**组织授权**（能不能扩编），与「工具交没交给你」是两件事；
     *  - 其它 CM（审计 / 会话考古）看 `toolPolicy.allow` **显式点名**——那是工具级收窄（C5 原口径）。
     *
     * 两条都缺省 false：CM 档没有「默认放行」。
     */
    cmAuthorized(member: MemberProjection, toolName: string): boolean {
      const role = resolveRuntimeRole(host.rolePaths(), member.roleId)
      if (!role) return false
      if ((DELEGATION_TOOL_NAMES as readonly string[]).includes(toolName)) return role.delegation?.canSpawn === true
      return (role.toolPolicy?.allow ?? []).includes(toolName)
    },

    /**
     * `targetId` 是否是 `ancestorId` 的**后代**（含直接子成员）。
     *
     * 为什么需要：成员侧的 `myteam_release_member` 只能动**自己的子树**——否则任何被授权派生的
     * 角色都能把同队的别人释放掉（那是队长的权力）。顺着 `parentMemberId` 上溯，带环保护。
     */
    isDescendant(teamId: string, targetId: string, ancestorId: string): boolean {
      if (!targetId || targetId === ancestorId) return false
      const byId = new Map(host.membersOf(teamId).map((member) => [member.id, member]))
      let cursor = byId.get(targetId)
      const seen = new Set<string>()
      while (cursor?.parentMemberId && !seen.has(cursor.id)) {
        seen.add(cursor.id)
        if (cursor.parentMemberId === ancestorId) return true
        cursor = byId.get(cursor.parentMemberId)
      }
      return false
    },

    /** `myteam_spawn_member`（**成员侧**，CHG-202y）：父成员 = 调用者（派生树由账本说话，不信自报） */
    spawnAs(teamId: string, member: MemberProjection, args: Record<string, unknown>): Record<string, unknown> {
      return host.spawnMember(teamId, String(args.roleId), args.instanceName ? String(args.instanceName) : undefined, {
        skills: Array.isArray(args.skills) ? args.skills.filter((skill): skill is string => typeof skill === 'string') : undefined,
        mcpAllowlist: Array.isArray(args.mcpAllowlist) ? args.mcpAllowlist.filter((name): name is string => typeof name === 'string') : undefined,
        parentMemberId: member.id,
      })
    },

    /** `myteam_release_member`（**成员侧**，CHG-202y）：只能释放自己的子树，别人的成员是队长的权力 */
    releaseAs(teamId: string, member: MemberProjection, args: Record<string, unknown>): Record<string, unknown> {
      const targetId = String(args.memberId ?? '')
      if (!this.isDescendant(teamId, targetId, member.id)) {
        return {
          status: 'error',
          code: 'MT_UNAVAILABLE',
          message: `成员 ${member.id} 只能释放自己的子成员（${targetId || '(未指定)'} 不在你的子树里）`,
        }
      }
      return this.release(teamId, args)
    },

    /** `myteam_release_member`：`confirm` 两段确认由 `releaseMember` 自己判；`cascade` 走倒序级联 */
    release(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
      return host.releaseMember(teamId, String(args.memberId), String(args.mode), args.confirm === true, 'lead', args.cascade === true)
    },

    /** `myteam_message`：队长 → 成员消息（落账在前，投递在后） */
    message(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const to = String(args.to)
      const kind = String(args.kind ?? 'notify')
      const r = host.commit(teamId, { actor, type: 'message.sent', payload: { teamId, messageId: `msg-${Date.now()}`, from: 'lead', to, taskId: args.taskId, kind, content: args.content } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message }
      // A10：投递口径收敛到 `deliverMemberMessage`（与面板 `memberOp(op:'steer')` 同一份构造）。
      // 投不进去不抛：消息已落账，收件人下次上线读账本仍能拿到；抛错只会把「已记账」变成「失败」。
      if (to !== 'inbox') host.deliverMemberMessage(to, kind, String(args.content))
      return { status: 'sent' }
    },

    /** `myteam_interrupt`：只停当前轮，会话保留（不是释放） */
    interrupt(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const memberId = String(args.memberId)
      const interruptAgent = host.agentOf(host.memberHandle(memberId))
      if (interruptAgent?.cancel) {
        interruptAgent.cancel({ kind: 'user' })
        // P1-5：中断 = 这一轮到此为止——宿主没有 turn 结束回调，这里的空转检查是
        // 「只说不做、被队长打断」的成员唯一会被记到的位置（结论只进 warn 日志）。
        host.noteGuardTurnEnd(memberId)
        host.commit(teamId, { actor, type: 'member.interrupted', payload: { teamId, memberId, reason: args.reason } })
        return { status: 'interrupted', note: 'interrupt 只停当前轮；会话保留' }
      }
      return { status: 'not-running' }
    },

    /**
     * `myteam_list_members`（CHG-187 / FR-32 支柱一，**A 档只读**）：名册 + 派生树事实。
     *
     * `childCount` 由**同一份名册**现算（不落第二份真相）：面板据此决定释放按钮要不要
     * 二次确认「将一并释放 N 个子成员」。读不到成员 → `members: []`（**不返回假成员**）。
     */
    listMembers(teamId: string): Record<string, unknown> {
      let roster: MemberProjection[] = []
      try {
        roster = host.membersOf(teamId)
      } catch {
        // 读不到名册（账本损坏 / 团队不存在）→ 空数组：**不编造成员**，也不让面板整体炸
        roster = []
      }
      const members = roster.map((member) => ({ ...member, childCount: childrenOf(roster, member.id).length }))
      return { status: 'ok', teamId, total: members.length, members }
    },
  }
}
