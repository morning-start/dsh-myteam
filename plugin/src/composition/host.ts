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

export const inject = ['tools']

export interface CaptainHostConfig {
  /** 明确固定项目根；不填时用进程工作目录。 */
  projectRoot?: string
}

/** Cordis 传入的最小 ctx；只声明用到的成员，避免耦合宿主类型。 */
interface HostContext {
  tools: { register(definition: unknown, options?: unknown): () => void }
  effect?: (execute: () => () => void) => unknown
}

export function apply(ctx: HostContext, config: CaptainHostConfig = {}): (() => void) | undefined {
  const hosts = new ProjectHosts()
  const rootDir = () => resolve(config.projectRoot ?? process.cwd())

  const disposers = leadToolSpecs().map((spec) =>
    ctx.tools.register(
      toDshTool(spec, async (sessionId) => {
        const runtime = await hosts.open(rootDir())
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