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

  /** 成员 spawn（`core/members/member-setup.ts` 装配）：角色 + 实例名 + 覆盖项 */
  spawnMember(
    teamId: string,
    roleId: string,
    instanceName?: string,
    overrides?: { skills?: string[]; mcpAllowlist?: string[] },
  ): Record<string, unknown>

  /** 成员释放（两段确认）：suspend / archive / remove 由 `mode` 区分 */
  releaseMember(teamId: string, memberId: string, mode: string, confirm: boolean): Record<string, unknown>

  /** A10：投递口径的唯一构造点（消息已落账 → 投不进去也不抛） */
  deliverMemberMessage(memberId: string, kind: string, content: string): boolean

  /** FIX-12：`agents.create` 返回形状未实证——双形状兼容（`{agent}` 包装 / agent 本体） */
  agentOf(handle: unknown): { followup?: (msg: unknown) => void; cancel?: (o: unknown) => void } | undefined

  /** 成员句柄（`memberHandles` 私有字段的只读取值口；`Map.get` 语义：不存在 → undefined） */
  memberHandle(memberId: string): unknown

  /** P1-5：回合结束时的空转检查（中断 / 释放两个「这一轮到此为止」的入口） */
  noteGuardTurnEnd(memberId: string): GuardVerdict | undefined
}

export function createMembersHandlers(host: MembersHostSurface) {
  return {
    /** `myteam_spawn_member`：skills / mcpAllowlist 只保留字符串项（JSON 面收窄） */
    spawn(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
      return host.spawnMember(teamId, String(args.roleId), args.instanceName ? String(args.instanceName) : undefined, {
        skills: Array.isArray(args.skills) ? args.skills.filter((skill): skill is string => typeof skill === 'string') : undefined,
        mcpAllowlist: Array.isArray(args.mcpAllowlist) ? args.mcpAllowlist.filter((name): name is string => typeof name === 'string') : undefined,
      })
    },

    /** `myteam_release_member`：`confirm` 两段确认由 `releaseMember` 自己判 */
    release(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
      return host.releaseMember(teamId, String(args.memberId), String(args.mode), args.confirm === true)
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
  }
}
