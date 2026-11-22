/**
 * 人类动作的 DSH 命令入口（斜杠命令）。
 *
 * 为什么放在这里：解散团队、指定/接管队长是**人类专属**，模型不能调用，所以
 * 不能挂在 preset 工具面上。`commands` 服务是宿主承认的「人在输入框里发起」
 * 通道：只有 UI 提交才会执行 handler，模型无法伪造。
 *
 * 语义与 CLI 保持一致：
 *   `/myteam-disband <teamId> [reason]`  —— 不带 `--yes` 只返回影响面预览；
 *   `/myteam-takeover <teamId> <sessionId>` —— 同上。
 * 预览不写事件；带 `--yes` 时在**当前状态**上重算影响面，变了就拒绝。
 */
import { resolve } from 'node:path'
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'
import { HumanAuthorizer } from '../domain/permissions/human-authorizer.ts'
import {
  confirmCaptainTakeover,
  confirmTeamDisband,
  previewCaptainTakeover,
  previewTeamDisband,
} from '../application/human-actions.ts'
import { randomUUID } from 'node:crypto'
import type { ActorRef } from '../contracts/events.ts'

interface CommandInvocationLike {
  agent: { id: string }
  rawInput: string
}

interface CommandDefinitionLike {
  name: string
  description: string
  input?: { hint: string }
  handler: (invocation: CommandInvocationLike) => Promise<{ kind: 'success' | 'error'; text: string }>
}

export interface HumanCommandContext {
  commands?: { register(definition: CommandDefinitionLike): () => void }
  agents?: { get(id: string): { id: string } | undefined }
  workingDirectory?: { ensure(agent: { id: string }): Promise<string> }
}

function parseInput(raw: string): { positional: string[]; yes: boolean } {
  const parts = raw.trim().split(/\s+/).filter((part) => part.length > 0)
  return { positional: parts.filter((part) => part !== '--yes'), yes: parts.includes('--yes') }
}

function humanActor(): ActorRef {
  // 命令只在 UI 提交路径执行；这里记的是「宿主内的人类操作」，不是模型。
  return { kind: 'human', userId: 'dsh-user', via: 'panel' }
}

async function rootOf(ctx: HumanCommandContext, agent: { id: string }): Promise<string> {
  if (ctx.workingDirectory === undefined) {
    throw new Error('当前环境没有工作目录服务，无法定位项目')
  }
  return await ctx.workingDirectory.ensure(agent)
}

export function registerHumanCommands(ctx: HumanCommandContext): (() => void)[] {
  if (ctx.commands === undefined) return []
  const disposers: (() => void)[] = []
  const hosts = new ProjectHosts()

  /**
   * 待确认的预览（按会话记住 10 分钟）。
   *
   * 之前确认要手工抄 targetHash，实际几乎没人这么用——人类动作等于没有入口。
   * 现在预览把结果留在这个会话里，确认时只补 --yes；执行前仍重算并比对
   * targetHash，状态变了就拒绝，避免「预览是旧的、执行是新的」。
   */
  const pending = new Map<string, { action: 'disband' | 'takeover'; teamId: string; toSessionId: string; targetHash: string; expiresAt: number }>()
  const PENDING_TTL_MS = 10 * 60 * 1000

  const run = async (invocation: CommandInvocationLike, action: 'disband' | 'takeover') => {
    const { positional, yes } = parseInput(invocation.rawInput)
    const teamId = positional[0]
    if (teamId === undefined) {
      return { kind: 'error' as const, text: '缺少 teamId。示例：/myteam-disband team_xxx' }
    }
    const runtime = await hosts.open(resolve(await rootOf(ctx, invocation.agent)))
    const preview =
      action === 'disband'
        ? previewTeamDisband(runtime, { teamId })
        : previewCaptainTakeover(runtime, { teamId, toSessionId: positional[1] ?? '' })

    const summary = [
      `动作：${preview.action}`,
      `目标：${preview.summary}`,
      `targetHash：${preview.targetHash}`,
      `impactHash：${preview.impactHash}`,
      `影响面：${JSON.stringify(preview.impact)}`,
    ].join('\n')

    if (!yes) {
      pending.set(invocation.agent.id, {
        action,
        teamId,
        toSessionId: positional[1] ?? '',
        targetHash: preview.targetHash,
        expiresAt: Date.now() + PENDING_TTL_MS,
      })
      return {
        kind: 'success' as const,
        text: `${summary}\n\n这是预览，未写入。确认无误后在同一会话发送：\n${action === 'disband' ? `/myteam-disband ${teamId} --yes` : `/myteam-takeover ${teamId} ${positional[1] ?? ''} --yes`}\n（预览 10 分钟内有效；状态变了会要求重新预览。）`,
      }
    }

    const remembered = pending.get(invocation.agent.id)
    pending.delete(invocation.agent.id)
    if (remembered === undefined || remembered.expiresAt < Date.now()) {
      return { kind: 'error' as const, text: '没有可用的预览（或已过期）。请先不带 --yes 执行一次，确认影响面后再加 --yes。' }
    }
    if (remembered.action !== action || remembered.teamId !== teamId) {
      return { kind: 'error' as const, text: '这次参数与预览时不同。请重新预览后再确认。' }
    }
    // 只有接管才需要比对目标会话；解散的第二段是 reason，不参与比对。
    if (action === 'takeover' && remembered.toSessionId !== (positional[1] ?? '')) {
      return { kind: 'error' as const, text: '目标会话与预览时不同。请重新预览后再确认。' }
    }
    if (remembered.targetHash !== preview.targetHash) {
      return { kind: 'error' as const, text: '预览后项目状态已变化，影响面不再一致。请重新预览。' }
    }

    const actor = humanActor()
    const authorizer = new HumanAuthorizer({ now: () => new Date().toISOString(), createNonce: () => randomUUID() })
    const confirmation = authorizer.issue(
      {
        operationId: preview.operationId,
        action: preview.action,
        targetHash: preview.targetHash,
        impactHash: preview.impactHash,
      },
      actor,
    )

    if (action === 'disband') {
      confirmTeamDisband(runtime, { authorizer }, {
        actor,
        teamId,
        operationId: preview.operationId,
        confirmation,
        reason: positional[2] ?? 'human command',
      })
    } else {
      confirmCaptainTakeover(runtime, { authorizer }, {
        actor,
        teamId,
        toSessionId: positional[1] ?? '',
        operationId: preview.operationId,
        confirmation,
      })
    }
    return { kind: 'success' as const, text: `已执行：${preview.action}\n${preview.summary}` }
  }

  disposers.push(
    ctx.commands.register({
      name: 'myteam-disband',
      description: '解散团队（人类动作；不带 --yes 只预览影响面）',
      input: { hint: '<teamId> [reason] [--yes]' },
      handler: async (invocation) => {
        try {
          return await run(invocation, 'disband')
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  )
  disposers.push(
    ctx.commands.register({
      name: 'myteam-takeover',
      description: '指定/接管队长（人类动作；不带 --yes 只预览影响面）',
      input: { hint: '<teamId> <sessionId> [--yes]' },
      handler: async (invocation) => {
        try {
          return await run(invocation, 'takeover')
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  )
  return disposers
}

export const inject = ['commands', 'agents', 'workingDirectory']

export function apply(ctx: HumanCommandContext): void {
  try {
    registerHumanCommands(ctx)
  } catch (error) {
    console.error('[myteam] 命令注册失败', error)
  }
}

export default apply