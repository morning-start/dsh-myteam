/**
 * T39（CHG-58）：成员级能力硬隔离 —— 技能 allowlist 与 MCP allowlist 的执行面。
 *
 * 背景（CHG-54）：模板/角色的 skills、mcpAllowlist 此前只是"声明 + 提示词约束"。
 * 本模块把声明变成运行时约束：
 *
 *  1. **MCP（真收窄）**：`agentCtx.tools.restrict({ deny })` 在该成员 agent 作用域
 *     内屏蔽 allowlist 之外的所有 `mcp__<server>__*` 全局工具；限制只过滤继承的全局
 *     工具，不会误伤成员自己的 9 个 myteam 工具（那些是作用域内注册）。
 *  2. **技能（deny-by-shadow）**：技能注册表只支持"按作用域追加"，没有 deny API。
 *     因此在成员作用域注册一个同名占位 provider，把 allowlist 之外、当前可见的技能
 *     替换为 `modelInvocable:false` 的占位定义——模型侧目录里不再出现、正文不可读。
 *     技能名字仍可能出现在面板/调试列表（诚实边界，见 docs/09 CHG-58）。
 *
 * 纪律：
 *  - allowlist 为空/未声明 = 不启用隔离（继承宿主能力，保持既有团队行为）；
 *  - 取成员自身声明优先，否则回退角色声明（与 spawn 的继承语义一致）；
 *  - 任何一步失败只告警，绝不阻断成员上岗（能力收窄失败 ≠ 成员不可用）；
 *  - 隔离在 setup 内一次完成，随后 agent 的每轮读到的都是收窄后的视图。
 */

                                  
                  
                        
 

                                        
                  
                          
                               
                     
                    
 

/** 成员声明 > 角色声明（空数组视为未声明）；与 spawn 的继承语义一致 */
export function resolveCapabilities(
  role                                                            ,
  member                                                ,
)                  {
  const pick = (own                      , fallback                      )           =>
    own && own.length > 0 ? [...own] : fallback && fallback.length > 0 ? [...fallback] : []
  return {
    skills: pick(member.skills, role?.skills),
    mcpAllowlist: pick(member.mcpAllowlist, role?.mcpAllowlist),
  }
}

/** 从 `mcp__<server>__<tool>` 取 server 名（server 只允许单下划线，双下划线是分隔符） */
export function mcpServerOf(toolName        )                     {
  if (!toolName.startsWith('mcp__')) return undefined
  const rest = toolName.slice(5)
  const index = rest.indexOf('__')
  return index === -1 ? rest : rest.slice(0, index)
}

/** 需要 deny 的 MCP 工具：allowlist 非空时，所有 server 不在名单里的 mcp 工具 */
export function mcpToolsToDeny(toolNames          , allow          )           {
  if (allow.length === 0) return []
  const allowed = new Set(allow)
  return toolNames.filter((name) => {
    const server = mcpServerOf(name)
    return server !== undefined && !allowed.has(server)
  })
}

const GUARD_PROVIDER = 'myteam-capability-guard'

/** 占位定义：模型不可见、正文不可读（合同要求 description/content 非空） */
function shadowDefinition(name        , content        ) {
  return {
    name,
    description: `未授权给本成员（能力 allowlist 之外）：${name}`,
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'myteam',
    provider: GUARD_PROVIDER,
    rank: 900,
    content,
  }
}

function withTimeout   (promise            , timeoutMs        )             {
  let timer                                           
  const timeout = new Promise       ((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })              
}

/**
 * 在成员 agent 作用域应用能力隔离（setup 内调用，可 await）。
 * @param ctx - 成员 agent 的 setup 上下文（agentCtx）
 * @param agent - agents.create 传给 setup 的 agent 本体（用于按作用域枚举）
 * @param caps - 生效的能力 allowlist
 */
export async function applyCapabilityGuard(
  ctx     ,
  agent     ,
  caps                 ,
  opts                                               ,
)                                 {
  const result                        = { skillsShadowed: [], mcpDenied: [], warnings: [] }
  // agentCtx.<svc> 受 inject 守卫限制；get() 既绕开声明又仍绑定到 agent 作用域（T0 实证）
  const toolsSvc = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  const skillsSvc = typeof ctx?.get === 'function' ? ctx.get('skills') : ctx?.skills
  const allowedMcp = new Set(caps.mcpAllowlist)
  const allowedOf = (toolName        )          => {
    const server = mcpServerOf(toolName)
    return server === undefined || allowedMcp.has(server)
  }

  // ① MCP：可见性 deny + 执行期 guard 兜底（晚连接的 server 也能挡住）
  if (caps.mcpAllowlist.length > 0 && typeof toolsSvc?.restrict === 'function') {
    try {
      const applyDeny = ()           => {
        const names = ((toolsSvc.schemas?.() ?? [])                             )
          .map((schema                    ) => (typeof schema?.name === 'string' ? schema.name : ''))
          .filter((name        ) => name.length > 0)
        const denied = mcpToolsToDeny(names, caps.mcpAllowlist)
        if (denied.length > 0) toolsSvc.restrict({ deny: denied })
        return denied
      }
      result.mcpDenied = applyDeny()
      // 动态兜底：restrict 只能 deny 调用时已存在的工具，guard 按名字实时判定
      if (typeof toolsSvc.guard === 'function') {
        toolsSvc.guard((exec     ) => {
          const name = typeof exec?.name === 'string' ? exec.name : ''
          if (!name.startsWith('mcp__') || allowedOf(name)) return undefined
          return `MCP tool "${name}" is outside this member's mcpAllowlist (${caps.mcpAllowlist.join(', ')})`
        })
      }
      if (typeof ctx?.on === 'function') {
        ctx.on('tools/change', () => {
          try {
            const more = applyDeny().filter((name) => !result.mcpDenied.includes(name))
            result.mcpDenied.push(...more)
          } catch { /* 静默：动态补刀失败不影响已生效的收窄 */ }
        })
      }
    } catch (e) {
      result.warnings.push(`mcp allowlist not enforced: ${String((e                        ).message ?? e)}`)
    }
  }

  // ② 技能：deny-by-shadow（异步枚举当前可见技能，再按作用域注册占位 provider）
  if (caps.skills.length > 0 && typeof skillsSvc?.registerProvider === 'function') {
    try {
      const allowed = new Set(caps.skills)
      const blocked = new Set        ()
      let refreshing = false
      let control                                         
      const refresh = async ()                => {
        if (refreshing || typeof skillsSvc.list !== 'function') return
        refreshing = true
        try {
          const visible = (await withTimeout(skillsSvc.list({ scope: agent, cwd: opts.workspaceRoot }), opts.timeoutMs ?? 3000))                                                 
          const next = visible
            .filter((skill) => skill?.provider !== GUARD_PROVIDER)
            .map((skill) => (typeof skill?.name === 'string' ? skill.name : ''))
            .filter((name) => name.length > 0 && !allowed.has(name))
          const changed = next.length !== blocked.size || next.some((name) => !blocked.has(name))
          blocked.clear()
          for (const name of next) blocked.add(name)
          if (changed) control?.invalidate?.()
        } finally {
          refreshing = false
        }
      }
      skillsSvc.registerProvider((registered                             ) => {
        control = registered
        return {
          name: GUARD_PROVIDER,
          list: () =>
            [...blocked].map((name) => ({
              ...shadowDefinition(name, ''),
              locator: { name },
            })),
          // 返回 undefined：技能正文不可读，skill 工具报 "unknown or no longer available"
          get: () => undefined,
        }
      })
      await refresh()
      result.skillsShadowed = [...blocked]
      if (typeof ctx?.on === 'function') ctx.on('skills/change', () => { void refresh() })
    } catch (e) {
      result.warnings.push(`skill allowlist not enforced: ${String((e                        ).message ?? e)}`)
    }
  }

  return result
}

/** 给日志/身份快照用的一行摘要 */
export function capabilitySummary(result                       )         {
  const parts           = []
  if (result.mcpDenied.length > 0) parts.push(`mcp denied ${result.mcpDenied.length}`)
  if (result.skillsShadowed.length > 0) parts.push(`skills shadowed ${result.skillsShadowed.length}`)
  for (const warning of result.warnings) parts.push(`warn: ${warning}`)
  return parts.join('; ')
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/members/capability-guard.ts