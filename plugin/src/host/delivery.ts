/**
 * A10 投递的**传输层**（CHG-213 实机）：成员消息到底从哪条通道送进去。
 *
 * 为什么需要单独一层：成员现在是**子代理**（ADR-010）。子代理 child 的 Agent 由 activation
 * manager 持有，`agents.get(childId)` 拿到的是「可续起的 seed」——对它调 `followup` 会抛
 *
 *     Error: session "mt-<team>-<role>-<n>" cannot append outside a SessionStore
 *
 * 现象是**最坏的一种**：账本 `member.spawned{active}`、child 真的在跑、队长却永远叫不动它，
 * 而 `myteam_message` 旧实现还回 `{status:'sent'}`。官方通道是
 * `subagents.sendMessage(sender, targetId, content, {signal})`：sender 必须是子代理树里的
 * 活祖先（队长），target 是树里的 child。
 *
 * 两条通道：
 *   ① 子代理通道（成员是子代理且宿主有该服务）——**异步**（sendMessage 只给 Promise）；
 *   ② `agent.followup`——根会话成员（`agents.create` 老路径）与老宿主，**同步**。
 *
 * 所以返回值是 `boolean | Promise<boolean>`（与 FIX-14 对 `agents.create` 的处置同一口径：
 * 两种形状调用方都得接受，不能靠「看起来是同步的」侥幸）。同步通道直接给布尔——单测与面板
 * 老路径不需要为异步而异步；子代理通道才需要 await。
 *
 * 口径不变：false = 没送到，调用方必须如实回报（`delivered:false`）；账本落了 ≠ 送到了。
 */

/** 投递结果：同步通道给布尔，子代理通道给 Promise */
export type Delivered = boolean | Promise<boolean>

/** 宿主面（只列用到的成员；全部从 host 闭包注入，便于单测） */
export interface DeliveryHost {
  /** 队长 Agent（`leadExec.agent`；面板/唤醒路径可能是 undefined） */
  leadAgent: () => unknown
  /** `ctx.subagents`（显式 `get()` 取；宿主没有该服务时 undefined） */
  subagents: () =>
    | { sendMessage?: (sender: unknown, target: string, content: unknown[], options: { signal: AbortSignal }) => Promise<unknown> }
    | undefined
  /** 成员会话 id（子代理 childId）；成员不在名册时 undefined */
  memberSessionId: (memberId: string) => string | undefined
  /** 已记住的 handle（本进程 spawn 过的） */
  handle: (memberId: string) => unknown
  /** handle → Agent（`{agent}` 包装 / Agent 本体两种形状） */
  agentOf: (handle: unknown) => { followup?: (message: unknown) => unknown } | undefined
  /** `agents.get(sessionId)`：重启后按账本身份回落 */
  agentById: (sessionId: string) => unknown
  /** 回填 handle（下一次投递不再走回落） */
  rememberHandle: (memberId: string, handle: unknown) => void
  /** 消息形状的**唯一**构造点（FIX-16 实弹：缺 id/source 会建空 turn） */
  followupMessage: (text: string) => Record<string, unknown>
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * FIX-14（KI-2）+ CHG-213：`agents.create` / `subagents.sendMessage` 的返回形状——真实宿主是
 * Promise，单测桩是本体。两阶段 spawn 与消息投递都必须「先拿到 handle / 先等受理」再结算，
 * 所以这个判定只写一处（`host.ts` 与 `host/members.ts` 共用），避免两处各判一遍然后行为分叉。
 */
export function isThenable(value: unknown): value is Promise<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export function createDelivery(host: DeliveryHost) {
  /**
   * 该会话是不是**子代理 child**（决定用哪条通道）。
   *
   * 判据取运行时事实（`session.header.parentSession` / `agentPreset` 有值 = 子代理），
   * **不用**「本进程登记过 activation」那种簿记：spawn 与首条消息之间可能只隔一个 await，
   * 簿记还没落，就会误判成根会话 → 走 followup → 抛 `cannot append outside a SessionStore`。
   */
  function isSubagentSession(sessionId: string): boolean {
    const agent = host.agentById(sessionId) as { session?: { header?: { parentSession?: unknown; agentPreset?: unknown } } } | undefined
    const header = agent?.session?.header
    return header !== undefined && (header.parentSession !== undefined || header.agentPreset !== undefined)
  }

  function deliverText(memberId: string, text: string): Delivered {
    const childId = host.memberSessionId(memberId)
    if (childId !== undefined && isSubagentSession(String(childId))) {
      const service = host.subagents()
      const send = service?.sendMessage
      if (service !== undefined && typeof send === 'function') {
        const sender = host.leadAgent()
        /* 没有队长 Agent 就没有「树里的活祖先」，sendMessage 无法授权 → 直接判未送达 */
        if (sender === undefined) return false
        return Promise.resolve(send.call(service, sender, String(childId), [{ type: 'text', text }], { signal: new AbortController().signal })).then(
          () => true,
          (error: unknown) => {
            host.log('warn', `message to child "${childId}" via subagents failed: ${String((error as Error | undefined)?.message ?? error)}`)
            return false
          },
        )
      }
    }
    const agent = host.agentOf(host.handle(memberId)) ?? (childId === undefined ? undefined : host.agentOf(host.agentById(String(childId))))
    if (!agent?.followup) {
      host.log('warn', `message to ${memberId} not delivered: no live agent（重启后未恢复：先 release 再 spawn，或等队列恢复）`)
      return false
    }
    if (host.handle(memberId) === undefined) host.rememberHandle(memberId, agent)
    try {
      agent.followup(host.followupMessage(text))
      return true
    } catch (error) {
      host.log('warn', `message delivery to ${memberId} failed: ${String((error as Error | undefined)?.message ?? error)}`)
      return false
    }
  }

  return {
    deliverText,
    /** 队长 → 成员的标准消息（`myteam_message` / 面板 steer 共用这一份文案） */
    deliverMessage: (memberId: string, kind: string, content: string): Delivered =>
      deliverText(memberId, `[myteam] 队长消息（${kind}）：${content}`),
  }
}
