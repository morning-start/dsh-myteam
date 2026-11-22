/**
 * 面板只读服务：把项目投影折叠成面板需要的形状。
 *
 * 它只做查询，不维护第二套状态机：在线/离线、CLI 与浏览器都走这里，
 * 因此「面板显示 blocked、命令行说 ready」这种分叉在结构上不成立。
 *
 * 迁移分析通过端口注入：应用层不知道旧文件怎么读，只知道「有人能给出结论」。
 */
import type { JsonValue } from '../contracts/json.ts'
import type { ErrorShape } from '../contracts/errors.ts'
import { ERROR_CODES, fail, toErrorShape } from '../contracts/errors.ts'
import type { ProjectRuntime } from './project-runtime.ts'
import type { ProjectState } from './projections/project-state.ts'
import { boardView, taskDetail, teamView } from './queries.ts'
import { validateRequest } from './panel-contract.ts'
import type { PanelMethod, PanelResponse } from './panel-contract.ts'

/** 打开项目的端口；生产实现是 ProjectHosts，测试可以给只读假宿主。 */
export interface ProjectRuntimeHost {
  open(rootDir: string): Promise<ProjectRuntime>
}

export interface MigrationSummary {
  verdict: 'ready' | 'blocked'
  headline: string
  markdown: string
}

export interface PanelServiceOptions {
  hosts: ProjectRuntimeHost
  /** 迁移分析器；未装配时 `migration` 方法明确报错，而不是返回空报告。 */
  analyzeMigration?: (rootDir: string) => MigrationSummary
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function requireParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `缺少参数 ${key}`)
  }
  return value
}

interface DefinitionSummary {
  kind: 'role' | 'workflow' | 'blueprint'
  id: string
  name: string
  revision: number
  contentHash: string
  baseHash: string
  origin: unknown
  archived: boolean
  published: unknown
  /** 本地内容与共同基准不同：可以发布。 */
  localChanged: boolean
  /** 需要全局库才能判断；未接入时保持 null，不猜。 */
  upstreamChanged: boolean | null
  updateAvailable: boolean | null
}

function definitionSummaries(state: ProjectState): DefinitionSummary[] {
  const result: DefinitionSummary[] = []
  for (const meta of state.definitionMeta.values()) {
    const name =
      meta.kind === 'role'
        ? (state.roles.get(meta.id)?.profile.name ?? meta.id)
        : meta.kind === 'workflow'
          ? (state.workflows.get(meta.id)?.name ?? meta.id)
          : (state.blueprints.get(meta.id)?.name ?? meta.id)
    result.push({
      kind: meta.kind,
      id: meta.id,
      name,
      revision: meta.revision,
      contentHash: meta.contentHash,
      baseHash: meta.baseHash,
      origin: meta.origin,
      archived: meta.archived,
      published: meta.published,
      localChanged: meta.contentHash !== meta.baseHash,
      upstreamChanged: null,
      updateAvailable: null,
    })
  }
  return result.sort((left, right) => (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind)))
}

export class PanelService {
  private readonly options: PanelServiceOptions

  constructor(options: PanelServiceOptions) {
    this.options = options
  }

  async invoke(rootDir: string, input: unknown): Promise<PanelResponse> {
    try {
      const request = validateRequest(input)
      const data = await this.read(rootDir, request.method, request.params)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: toErrorShape(error) }
    }
  }

  private async read(rootDir: string, method: PanelMethod, params: Record<string, unknown> | undefined): Promise<JsonValue> {
    if (method === 'migration') {
      const analyze = this.options.analyzeMigration
      if (analyze === undefined) {
        fail(ERROR_CODES.INTERNAL, '迁移分析器未装配')
      }
      return jsonSafe(analyze(rootDir))
    }

    const runtime = await this.options.hosts.open(rootDir)
    const state = runtime.state

    switch (method) {
      case 'status':
        return jsonSafe({
          projectId: state.projectId,
          name: state.name,
          observedProjectSeq: state.seq,
          graphRevision: state.graphRevision,
          configRevision: state.configRevision,
          counts: {
            teams: state.teams.size,
            members: state.members.size,
            tasks: state.tasks.size,
            runs: state.runs.size,
            roles: state.roles.size,
            workflows: state.workflows.size,
            blueprints: state.blueprints.size,
            knowledge: state.knowledge.size,
          },
        })

      case 'overview': {
        const board = boardView(state)
        const unknownEffects = [...state.effects.values()].filter((effect) => effect.status === 'outcome-unknown').length
        return jsonSafe({
          observedProjectSeq: state.seq,
          graphRevision: state.graphRevision,
          totals: board.totals,
          teams: [...state.teams.values()].map((team) => {
            const captain = state.captains.get(team.id)
            return {
              id: team.id,
              name: team.name,
              status: team.status,
              members: [...state.members.values()].filter((member) => member.teamId === team.id && member.status !== 'released')
                .length,
              tasks: [...state.tasks.values()].filter((task) => task.ownerTeamId === team.id).length,
              captain: captain === undefined ? null : { sessionId: captain.sessionId, generation: captain.generation },
            }
          }),
          attention: {
            review: board.totals.review,
            blocked: board.totals.blocked,
            unknownEffects,
          },
        })
      }

      case 'board':
        return jsonSafe(boardView(state))

      case 'task': {
        const taskId = requireParam(params, 'taskId')
        return jsonSafe(taskDetail(state, taskId))
      }

      case 'team': {
        const teamId = requireParam(params, 'teamId')
        return jsonSafe(teamView(state, teamId))
      }

      case 'definitions':
        return jsonSafe({ items: definitionSummaries(state) })

      default: {
        const exhaustive: never = method
        fail(ERROR_CODES.INVALID_COMMAND, `未实现的面板方法：${String(exhaustive)}`)
      }
    }
  }
}