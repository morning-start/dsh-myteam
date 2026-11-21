/**
 * 成员工具入口（CHG-212 / ADR-010 P3）：子代理成员的**工具面由 preset 装**。
 *
 * 为什么不能像以前那样在 `agents.create` 的 setup 里注册：宿主子代理的 local child
 * `setup` 是管理器私有的（`dsh-subagent/src/manager.ts:826-865`），插件插不进去；
 * 子代理只能靠 `agentPreset` 选组合。所以成员工具改由本入口在**成员会话的作用域**里注册。
 *
 * 身份与服务解析（每次 execute 时做，O(1) 查表）：
 *   exec.agent（成员 Agent，由工具执行器按作用域注入，`dsh-tools/src/executor.ts:29-32`）
 *   → agent.session.header.parentSession（队长会话 id）
 *   → ctx.agents.get(parentSessionId)（队长 Agent）
 *   → ctx.agentPresets.serviceFor(captain, 'myteam')（**同一个**服务实例：账本单写者不变）
 *   → host.executeMemberToolBySession(成员会话 id, 工具名, 参数)
 *
 * 解析失败一律 `MT_UNAVAILABLE` + 可行动原因——不静默、也不假装成功。
 */
import { outputForTool } from './core/tools/output-contract.mjs'
import { compileParameters } from './host.mjs'
import { memberToolDefs } from './tools/defs.mjs'

export const name = 'myteam-member-tools'
export const inject = ['tools', 'agents', 'agentPresets', 'systemPrompt']

/** 成员工具执行结果的错误形状（与宿主其它工具一致） */
function unavailable(message        )                          {
  return { status: 'error', code: 'MT_UNAVAILABLE', message }
}

/** 工具 `execute` 的第二参里我们真正用到的部分（宿主传的是完整 exec） */
                    
           
               
                                                                  
   
 

/** 成员工具入口需要的最小 ctx 面（便于单测注入假件） */
                                 
                                                 
                                                                           
                                                                                                                                      
                                                                                                                                  
 

                          
                                  
                                                                                                       
                              
                                                                                                              
                                                                        
                                                                       
 

/** 成员会话 id（`Agent.id` 就是会话 id；兼容只暴露 `session.id` 的宿主形状） */
export function memberSessionIdOf(agent                                )                     {
  return agent.id ?? agent.session?.id
}

/**
 * 解析「谁执行 + 用哪个服务」。纯函数（只读 ctx），失败返回错误对象而不是抛。
 */
export function resolveMemberHost(ctx                , exec                      )                                                                                 {
  const agent = exec?.agent
  if (agent === undefined) return { error: unavailable('成员工具需要调用方 Agent（exec.agent 缺失）') }
  const sessionId = memberSessionIdOf(agent)
  if (sessionId === undefined) return { error: unavailable('成员工具拿不到自己的会话 id（agent.id 缺失）') }
  const parentSessionId = agent.session?.header?.parentSession
  if (parentSessionId === undefined) {
    return { error: unavailable(`成员会话 ${sessionId} 没有 parentSession——它不是以子代理方式起来的，工具面解析不到队长服务`) }
  }
  const captain = ctx.agents.get(parentSessionId)
  if (captain === undefined) {
    return { error: unavailable(`队长会话 ${parentSessionId} 当前不在线：成员工具需要一个存活的队长会话（先恢复队长再重试）`) }
  }
  const host = ctx.agentPresets?.serviceFor?.(captain, 'myteam')                              
  const run = host?.memberToolBySession ?? host?.executeMemberToolBySession
  if (host === undefined || typeof run !== 'function') {
    return { error: unavailable('解析不到 myteam 服务：队长会话没有挂载 myteam preset（检查 myteam-preset-captain）') }
  }
  return { host, sessionId }
}

/** 工具执行体（导出供单测直接调用；`apply` 里也走它） */
export function runMemberTool(ctx                , toolName        , args                         , exec                      )          {
  const resolved = resolveMemberHost(ctx, exec)
  if (resolved.error !== undefined) return resolved.error
  /* CHG-213（实机）：**必须带接收者调用**。把方法取出来再调（`const run = host.foo; run(...)`）
   * 会让 `this` 变 undefined，MyTeamRemote 里的 `this.host` 当场抛
   * `Cannot read properties of undefined (reading 'host')`——成员的**所有** myteam 工具
   * 都是这条路，于是整族工具一起失效（活体验收里成员逐条试过，全部同一句错误）。 */
  const host = resolved.host 
  const sessionId = resolved.sessionId 
  return typeof host.memberToolBySession === 'function'
    ? host.memberToolBySession(sessionId, toolName, args)
    : host.executeMemberToolBySession (sessionId, toolName, args)
}

/**
 * C5 收窄的懒应用（ADR-010 P4b）：子代理的 `setup` 插不进去，`restrict` 只能由 preset 补。
 *
 * 为什么挂在 `systemPrompt.section` 的惰性 `text({agent})` 上：提示词在**每次请求前**组装，
 * 早于模型的第一次工具调用，所以收窄仍然发生在「模型看见工具面」之前；而且这个回调拿得到
 * agent（工具注册期拿不到）。每个会话只应用一次；宿主不支持 restrict 时保持不收窄并留待重试。
 */
function applyMemberPolicyOnce(ctx                , agent         , applied             )       {
  if (agent === undefined) return
  const sessionId = memberSessionIdOf(agent                                  )
  if (sessionId === undefined || applied.has(sessionId)) return
  const resolved = resolveMemberHost(ctx, { agent: agent                                   })
  if (resolved.error !== undefined) return
  const policy = resolved.host .memberPolicyBySession?.(sessionId)
  if (policy === undefined || policy['status'] !== 'ok') return
  if (policy['mode'] === 'none') { applied.add(sessionId); return }
  try {
    if (policy['mode'] === 'allow') ctx.tools.restrict?.({ allow: policy['allow']             })
    else ctx.tools.restrict?.({ deny: policy['deny']             })
    applied.add(sessionId)
  } catch { /* 宿主没有 restrict / 形状不符：不标记已应用，下次提示词组装再试 */ }
}

export function apply(ctx                )       {
  for (const def of memberToolDefs()) {
    const compiled = compileParameters(def)
    ctx.tools.register({
      ...compiled,
      // 与队长侧同一份输出契约（tools.register 的校验器会按它校验 execute 返回值）
      output: outputForTool(def.name),
      execute: (args                         , exec          ) => runMemberTool(ctx, def.name, args, exec),
    })
  }
  // C5：角色 toolPolicy 的收窄（第一次提示词组装时应用；空文本 = 不占提示词预算）
  const applied = new Set        ()
  ctx.systemPrompt?.section({
    name: 'myteam:member-policy',
    order: 90,
    text: ({ agent }) => {
      applyMemberPolicyOnce(ctx, agent, applied)
      return ''
    },
  })
  /* 上岗简报（角色纪律 + 知识索引 + 记忆召回）：子代理的 setup 注入不了，只能在首次组装时补。
   * 每个会话算一次并缓存文本——后续每轮原样返回，成员的身份与记忆要保持连续。 */
  const briefs = new Map                ()
  ctx.systemPrompt?.section({
    name: 'myteam:member-brief',
    order: 95,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const sessionId = memberSessionIdOf(agent                                  )
      if (sessionId === undefined) return ''
      const cached = briefs.get(sessionId)
      if (cached !== undefined) return cached
      const resolved = resolveMemberHost(ctx, { agent: agent                                   })
      if (resolved.error !== undefined) return ''
      const brief = resolved.host .memberBriefBySession?.(sessionId)
      if (brief === undefined || brief['status'] !== 'ok') return ''
      const text = String(brief['text'] ?? '')
      briefs.set(sessionId, text)
      return text
    },
  })
}

//# sourceURL=./src/member.ts