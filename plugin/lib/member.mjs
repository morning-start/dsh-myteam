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
export const inject = ['tools', 'agents', 'agentPresets']

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
  if (host === undefined || typeof host.executeMemberToolBySession !== 'function') {
    return { error: unavailable('解析不到 myteam 服务：队长会话没有挂载 myteam preset（检查 myteam-preset-captain）') }
  }
  return { host, sessionId }
}

/** 工具执行体（导出供单测直接调用；`apply` 里也走它） */
export function runMemberTool(ctx                , toolName        , args                         , exec                      )          {
  const resolved = resolveMemberHost(ctx, exec)
  if (resolved.error !== undefined) return resolved.error
  return resolved.host .executeMemberToolBySession (resolved.sessionId , toolName, args)
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
}

//# sourceURL=./src/member.ts