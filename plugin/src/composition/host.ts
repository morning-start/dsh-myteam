/**
 * 队长侧装配（挂在 `myteam-captain` preset 内）。
 *
 * 这里只做三件事：拿到 `tools` 服务、把工具规格注册进当前会话作用域、
 * 在卸载时释放项目运行时与工具注册。业务规则一条都不在这里。
 *
 * 工具面隔离：队长工具只在本 plugin 行注册，成员 preset 挂的是
 * `composition/member.ts`，因此成员会话看不到 `myteam_create_task` 这类
 * Lead 工具（也看不到任何「构造一个人工 human」的入口）。
 */
import { resolve } from 'node:path'
import { leadToolSpecs } from '../application/tool-specs.ts'
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'
import { toDshTool } from '../infrastructure/dsh/tool-adapter.ts'

export const inject = ['tools', 'agents', 'workingDirectory']

export interface CaptainHostConfig {
  /** 明确固定项目根；不填时用进程工作目录。 */
  projectRoot?: string
}

/** Cordis 传入的最小 ctx；只声明用到的成员，避免耦合宿主类型。 */
interface HostContext {
  tools: { register(definition: unknown, options?: unknown): () => void }
  effect?: (execute: () => () => string | void) => unknown
  agents?: { get(id: string): { id: string } | undefined }
  workingDirectory?: { ensure(agent: { id: string }): Promise<string> }
}

export function apply(ctx: HostContext, config: CaptainHostConfig = {}): (() => void) | undefined {
  const hosts = new ProjectHosts()

  /**
   * 项目根 = **会话**的工作目录，不是进程 cwd。
   *
   * DSH Web 里多个会话共享一个进程；用 process.cwd() 会把所有工作区接到启动
   * 目录。宿主提供 workingDirectory.ensure(agent) 才是每个会话各自的目录。
   * 拿不到会话/服务时才回落到显式配置或 cwd（本地脚本与测试场景）。
   */
  const rootFor = async (sessionId: string): Promise<string> => {
    const agent = ctx.agents?.get(sessionId)
    if (agent !== undefined && ctx.workingDirectory !== undefined) {
      return await ctx.workingDirectory.ensure(agent)
    }
    return resolve(config.projectRoot ?? process.cwd())
  }

  const disposers = leadToolSpecs().map((spec) =>
    ctx.tools.register(
      toDshTool(spec, async (sessionId) => {
        const runtime = await hosts.open(await rootFor(sessionId))
        return { runtime, sessionId }
      }),
    ),
  )

  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 重复释放不应阻断其他清理。
      }
    }
    void hosts.closeAll()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup)
    return undefined
  }
  return cleanup
}