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
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { leadToolSpecs } from '../application/tool-specs.ts'
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'
import { toDshTool } from '../infrastructure/dsh/tool-adapter.ts'
import { createAgentDispatchMessage } from './host-modules.ts'

export const inject = ['tools', 'agents', 'workingDirectory', 'subagents']

export interface CaptainHostConfig {
  /** 明确固定项目根；不填时用进程工作目录。 */
  projectRoot?: string
}

/** Cordis 传入的最小 ctx；只声明用到的成员，避免耦合宿主类型。 */
interface HostContext {
  tools: { register(definition: unknown, options?: unknown): () => void }
  effect?: (execute: () => () => string | void) => unknown
  agents?: {
    get(id: string): { id: string; followup?: (message: unknown) => unknown } | undefined
    create(options: unknown): Promise<unknown>
  }
  subagents?: {
    sendMessage(
      sender: { id: string },
      target: string,
      content: unknown[],
      options: { signal: AbortSignal },
    ): Promise<unknown>
    startActivation?(spec: unknown): Promise<{ childId: string }>
  }
  workingDirectory?: { ensure(agent: { id: string }): Promise<string> }
  logger?: { warn(event: string, detail?: Record<string, unknown>): void }
}

/** 成员会话的默认模型：与宿主一致；取不到就让宿主自己决定。 */
interface MemberSpawnResult {
  agent?: { session?: { id?: string } }
  session?: { id?: string }
}

export function apply(ctx: HostContext, config: CaptainHostConfig = {}): (() => void) | undefined {
  const hosts = new ProjectHosts()

  /**
   * 为成员开一个子会话，并在该会话作用域内注册三个成员工具。
   *
   * 顺序很关键：先有会话，才能把 sessionId 写进成员记录；先记成员再开会话，
   * 成员就永远是「待绑定」，成员工具也没人用得上。
   */
  const makeSpawner =
    (captainSessionId: string) =>
    async (input: { teamId: string; roleId: string; parentMemberId: string | null }): Promise<string | null> => {
      const cwd = await rootFor(captainSessionId)

      // 首选：真正的子代理（有树、有初始 prompt、消息能唤醒它）。
      // 成员工具面由 myteam-member preset 提供，不在 setup 里重复注册。
      const captain = ctx.agents?.get(captainSessionId)
      if (ctx.subagents?.startActivation !== undefined && captain !== undefined) {
        try {
          const activation = await ctx.subagents.startActivation({
            provider: 'spawn',
            label: `myteam-${input.roleId}`,
            agentPreset: 'myteam-member',
            cwd,
            parent: captain,
            delivery: 'caller',
            signal: AbortSignal.timeout(120_000),
            prompt: [
              {
                type: 'text',
                text: [
                  '你是 myteam 团队的成员，已被队长聘任。',
                  '现在还没有任务；收到任务说明后，按指示调用 myteam_progress / myteam_evidence / myteam_submit_review。',
                  '不要调用队长工具，也不要自己裁决。',
                ].join('\n'),
              },
            ],
          })
          return activation.childId
        } catch {
          // 落到下面的老路径
        }
      }

      // 回落：老路径（agents.create）。它不会被 sendMessage 唤醒，仅作兼容。
      if (ctx.agents?.create === undefined) return null
      const sessionId = `mt-member-${randomUUID()}`
      const created = (await ctx.agents.create({ sessionId, setup() {} })) as MemberSpawnResult
      return created.agent?.session?.id ?? created.session?.id ?? sessionId
    }

  /**
   * 把任务说明投递给成员会话。
   *
   * 两条通道，按可信度排序：
   *   ① `subagents.sendMessage` —— 成员在队长的子代理树里时可用（会唤醒空闲成员）；
   *   ② `agent.followup` —— 老路径（`agents.create` 建的根会话成员）。
   * 都不行就返回 false，让工具如实告诉模型「没派出去」，而不是假装成功。
   *
   * ⚠️ ② 的消息**必须**带 id 与 source（CHG-217）：手写的 `{ role:'user', content }`
   * 写进会话时不报错，但持久化层在**用户下次打开会话时**校验 `message.id` 与
   * `message.source.kind`，缺一整段会话打不开（`lacks an identified message`）。
   * 所以这里走 `createAgentDispatchMessage`——source 用 `agent-message`，因为这条
   * 消息是**队长投给成员**的任务说明，不是真人输入；标成 `user` 会让
   * `dsh-tool-goal` 的「直接人类授权」判定误判，给模型它本不该有的授权。
   */
  const makeDispatcher =
    (captainSessionId: string) =>
    async (target: string, text: string): Promise<boolean> => {
      const content = [{ type: 'text', text }]
      const sender = ctx.agents?.get(captainSessionId)
      if (sender !== undefined && ctx.subagents !== undefined) {
        try {
          await ctx.subagents.sendMessage(sender, target, content, { signal: AbortSignal.timeout(60_000) })
          return true
        } catch {
          // 落到 ②
        }
      }
      const targetAgent = ctx.agents?.get(target)
      if (typeof targetAgent?.followup === 'function') {
        try {
          const message = await createAgentDispatchMessage(content, captainSessionId)
          targetAgent.followup(message)
          return true
        } catch {
          return false
        }
      }
      return false
    }

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
        // 身份判断发生在工具层，读之前先对齐外部写入，避免陈旧投影误判队长。
        runtime.refresh()
        return { runtime, sessionId, spawnMember: makeSpawner(sessionId), dispatchMember: makeDispatcher(sessionId) }
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