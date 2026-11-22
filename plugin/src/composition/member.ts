/**
 * 成员侧装配（挂在 `myteam-member` preset 内）。
 *
 * 成员工具只有三条：进度、证据、提交评审。它们都要求调用者能从会话解析成
 * **本项目已聘任的成员**，并且写入绑定当前 Attempt。成员不能建任务、改定义、
 * 完成任务（完成由队长侧门禁裁决），也没有任何全局写入口。
 */
import { resolve } from 'node:path'
import { memberToolSpecs } from '../application/tool-specs.ts'
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'
import { toDshTool } from '../infrastructure/dsh/tool-adapter.ts'

export const inject = ['tools']

export interface MemberHostConfig {
  projectRoot?: string
}

interface HostContext {
  tools: { register(definition: unknown, options?: unknown): () => void }
  effect?: (execute: () => () => void) => unknown
}

export function apply(ctx: HostContext, config: MemberHostConfig = {}): (() => void) | undefined {
  const hosts = new ProjectHosts()
  const rootDir = () => resolve(config.projectRoot ?? process.cwd())

  const disposers = memberToolSpecs().map((spec) =>
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