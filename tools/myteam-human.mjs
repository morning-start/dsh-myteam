/**
 * 人类动作入口（部署者 CLI）。
 *
 * 为什么是 CLI 而不是工具：解散团队、指定/接管队长是**人类专属**动作。模型
 * 不能调用，所以它不能挂在 preset 工具面上。DSH 的 commands/actionCards 通道
 * 尚未接线前，这条 CLI 是唯一可用的真人入口。
 *
 * 用法：
 *   node tools/myteam-human.mjs preview --root <dir> --action disband --team <teamId>
 *   node tools/myteam-human.mjs apply   --root <dir> --action disband --team <teamId> --by <user> --yes
 *   node tools/myteam-human.mjs apply   --root <dir> --action takeover --team <teamId> --to <sessionId> --by <user> --yes
 *
 * 安全边界：
 *   - 必须先 `preview` 看影响面；`apply` 会在**当前状态**上重算影响面，
 *     预览之后有任何变化都会让 hash 对不上而失败（不是提示，是拒绝）；
 *   - `--yes` 是显式确认；缺了就只打印预览；
 *   - 令牌一次性、带过期；本进程内禁止重放。
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { ProjectHosts } from '../plugin/src/infrastructure/dsh/project-hosts.ts'
import { HumanAuthorizer } from '../plugin/src/domain/permissions/human-authorizer.ts'
import {
  confirmCaptainTakeover,
  confirmTeamDisband,
  previewCaptainTakeover,
  previewTeamDisband,
} from '../plugin/src/application/human-actions.ts'

function parse(argv) {
  const options = { command: argv[0] ?? '' }
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--yes') {
      options.yes = true
      continue
    }
    if (key.startsWith('--')) {
      options[key.slice(2)] = value
      index += 1
    }
  }
  return options
}

/** 可编程入口（测试与脚本共用）；返回预览或提交结果。 */
export async function runHumanAction(options) {
  const root = resolve(options.root ?? process.cwd())
  const hosts = new ProjectHosts()
  try {
    const runtime = await hosts.open(root)
    const teamId = options.team
    if (teamId === undefined || teamId.length === 0) throw new Error('缺少 --team')

    const preview =
      options.action === 'disband'
        ? previewTeamDisband(runtime, { teamId })
        : previewCaptainTakeover(runtime, { teamId, toSessionId: options.to ?? '' })

    if (options.command === 'preview' || options.yes !== true) {
      return { kind: 'preview', preview }
    }

    const actor = { kind: 'human', userId: options.by ?? 'operator', via: 'host' }
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
    const deps = { authorizer }

    if (options.action === 'disband') {
      const result = confirmTeamDisband(runtime, deps, {
        actor,
        teamId,
        operationId: preview.operationId,
        confirmation,
        reason: options.reason ?? 'operator disband',
      })
      return { kind: 'applied', preview, events: result.events.map((event) => event.type) }
    }

    const result = confirmCaptainTakeover(runtime, deps, {
      actor,
      teamId,
      toSessionId: options.to ?? '',
      operationId: preview.operationId,
      confirmation,
    })
    return { kind: 'applied', preview, events: result.events.map((event) => event.type) }
  } finally {
    await hosts.closeAll()
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('/tools/myteam-human.mjs')
if (isMain) {
  const options = parse(process.argv.slice(2))
  if (options.command !== 'preview' && options.command !== 'apply') {
    console.error('用法：preview|apply --root <dir> --action disband|takeover --team <id> [--to <session>] [--by <user>] [--yes]')
    process.exit(2)
  }
  try {
    const output = await runHumanAction(options)
    console.log(JSON.stringify(output, null, 2))
    if (output.kind === 'preview') {
      console.log('\n这只是预览。确认无误后加 --yes 执行；执行时会在当前状态上重算影响面。')
    }
    process.exit(0)
  } catch (error) {
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}