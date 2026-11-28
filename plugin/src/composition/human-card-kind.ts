/**
 * 动作卡片 kind：把人类动作包装成「队长提议 → 人类点确认」。
 *
 * 真正的执行在 `human-cards.ts` 的 `actOnHumanCard`（已有单测）。这里只做宿主接线：
 * 拿 zod 定义 details、拿会话工作区开项目、把结果 record 回卡片。
 *
 * 依赖从宿主解析：zod 与 actionCards 都不由本包分发；解析不到就明确跳过，
 * 不能让整个 profile 起不来。
 */
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'
import { actOnHumanCard, type HumanCardDetails } from './human-cards.ts'
import { loadHostZod } from './host-modules.ts'

export const inject = ['actionCards', 'agents', 'workingDirectory']

export interface CardHostContext {
  actionCards?: {
    register(kind: unknown): () => void
    record(agent: { id: string }, decision: unknown): void
  }
  agents?: { get(id: string): { id: string } | undefined }
  workingDirectory?: { ensure(agent: { id: string }): Promise<string> }
  logger?: { warn(event: string, detail?: Record<string, unknown>): void }
}

/**
 * 从宿主安装目录解析 zod（本包不依赖它）。
 *
 * ⚠️ 为什么**不写**裸包名动态导入（CHG-217）：DSH 的装载闭包里解析不到裸名
 * `zod`——它只保证 `@deepseek-ai/*` 的一部分。裸名 import 在本地开发机上「恰好能
 * 解析」是因为那儿有同名 `node_modules`，换到干净 profile 就炸（toolkit 的错误卡片
 * `bare-name-dependency` 记的就是这个坑）。所以只走宿主安装目录这一条路：
 * `loadHostZod` 内部用 `createRequire` 从 `DSH_INSTALL_DIR` 解析。
 */
async function loadZod(): Promise<unknown | null> {
  const module = await loadHostZod()
  if (module === undefined) return null
  // zod 的 CJS 入口经 ESM 互操作后，`z` 既可能是顶层命名导出，也挂在 default 上。
  const candidate = module as { z?: unknown; default?: { z?: unknown } }
  return candidate.z !== undefined ? candidate.z : (candidate.default?.z ?? null)
}

export function apply(ctx: CardHostContext): (() => void) | undefined {
  if (ctx.actionCards === undefined) return undefined
  const hosts = new ProjectHosts()
  const disposers: (() => void)[] = []

  void loadZod()
    .then((zod) => {
      const z = zod as { z?: { object(u: unknown): unknown; enum(v: string[]): unknown; string(): unknown } } | null
      if (z?.z === undefined) {
        ctx.logger?.warn('myteam.card.zod-missing')
        return
      }
      const schema = z.z.object({
        action: z.z.enum(['disband', 'takeover']),
        teamId: z.z.string(),
        toSessionId: z.z.string(),
        summary: z.z.string(),
        targetHash: z.z.string(),
      })

      disposers.push(
        ctx.actionCards!.register({
          action: 'myteam.human',
          skill: 'myteam-human-actions',
          invitation: '影响面已经列在卡片里；确认后才会真正执行，取消不会改动任何数据。',
          details: schema,
          verbs: { confirm: { writes: true }, cancel: {} },
          openPhases: ['confirmed', 'cancelled'],
          statusGuidance: '这张卡片的结果由人类点击产生，不要替人类重复发起。',
          statusFields: ['action', 'teamId', 'summary'],
          async act(
            agent: { id: string },
            proposal: { callId: string; action: string; details: HumanCardDetails },
            verb: string,
          ) {
            const open = async (sessionId: string) => {
              const live = ctx.agents?.get(sessionId)
              if (live === undefined || ctx.workingDirectory === undefined) {
                throw new Error('当前会话没有绑定工作区')
              }
              return hosts.open(await ctx.workingDirectory.ensure(live))
            }
            const result = await actOnHumanCard(
              { open },
              { callId: proposal.callId, action: proposal.action, sessionId: agent.id, details: proposal.details },
              verb,
            )
            if (result.status === 'refused') return { status: 'refused', reason: result.reason }
            ctx.actionCards!.record(agent, result.decision)
            return { status: 'settled', decision: result.decision }
          },
        }),
      )
      ctx.logger?.warn('myteam.card.registered', { action: 'myteam.human' })
    })
    .catch((error: unknown) => {
      ctx.logger?.warn('myteam.card.registration-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

  const cleanup = () => {
    for (const dispose of disposers) dispose()
    void hosts.closeAll()
  }
  return cleanup
}

export default apply