/**
 * 会话工作目录（项目根）解析 —— 入口层共享原语。
 *
 * 从 `src/host.ts` 下沉而来（CHG-202）：A6 行数棘轮要求入口层「只减不增」，
 * 新代码落到 `src/host/<族>.ts`。这里只放**纯读**的解析逻辑，不持有任何状态。
 *
 * 为什么需要它：宿主里 `ctx.workspace.root` 在 desktop profile 下是 profile 目录
 * （不是项目），而每个会话的 cwd 才是用户真正打开的项目。`agents.currentInitiator()`
 * 是官方给「工具执行链」用的口子（宿主 agents 服务签名），拿不到再用 workingDirectory。
 */
export function sessionCwdOf(rt         )                     {
  try {
    const agents = (rt                                                                                                   )?.agents
    let agent         
    try {
      agent = agents?.currentInitiator?.()
    } catch {
      agent = undefined
    }
    if (!agent) return undefined
    /* CHG-202：DSH 的会话 cwd 在 `session.header.cwd`，**不是** `session.cwd`（后者恒为空）。
     * 修复前只读 `session.cwd` → 永远 undefined → 项目根回落进程 cwd，
     * 桌面 profile 多开时就会把「别人的项目」当成本项目。 */
    const session = (agent                         ).session
    const headerCwd = (session                                              )?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd.length > 0) return headerCwd
    const cwd = (session                                 )?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
    // 兜底：workingDirectory 服务按会话解析
    const wd = (rt                                                                                         )?.workingDirectory
    if (wd?.get && session) {
      const resolved = wd.get(session)
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    }
    return undefined
  } catch {
    return undefined
  }
}


//# sourceURL=./src/host/session-cwd.ts