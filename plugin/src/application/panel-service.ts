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

/** 长期记忆读取端口：项目内的 SQLite 库，只读。 */
export interface MemoryStorePort {
  view(rootDir: string, options: { bankId?: string; limit: number }): unknown
}

/** 全局库读取端口：应用层只认这个形状，文件系统怎么读由组合层注入。 */
export interface GlobalLibraryPort {
  /** 读整个全局库（计数 / 条目 / 读不懂的文件）。 */
  library(): unknown
  /** 读全局操作审计（新→旧，最多 limit 条）。 */
  audit(limit: number): unknown
}

export interface PanelServiceOptions {
  hosts: ProjectRuntimeHost
  /** 迁移分析器；未装配时 `migration` 方法明确报错，而不是返回空报告。 */
  analyzeMigration?: (rootDir: string) => MigrationSummary
  /** 全局库读取器；未装配时 `globalLibrary` / `globalAudit` 明确报错。 */
  globalLibrary?: GlobalLibraryPort
  /** 记忆读取器；未装配时 `memory` 明确报错。 */
  memory?: MemoryStorePort
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

/**
 * 事件的 actor 摘要：只公开「谁」，不搬运整个 ActorRef。
 * `kind` 必在；具体身份字段名随 actor 种类不同，逐个试已知键，找不到就 `null`。
 */
function actorSummary(actor: unknown): { kind: string; id: string | null } {
  if (typeof actor !== 'object' || actor === null) return { kind: 'unknown', id: null }
  const record = actor as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind : 'unknown'
  for (const key of ['userId', 'memberId', 'sessionId', 'agentId', 'pluginId', 'system', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return { kind, id: value }
  }
  return { kind, id: null }
}

/** 事件的实体摘要：审计列表只要「哪类实体、哪个 id」。 */
function entitySummary(entity: unknown): { kind: string; id: string } {
  if (typeof entity !== 'object' || entity === null) return { kind: 'unknown', id: '' }
  const record = entity as Record<string, unknown>
  return {
    kind: typeof record.kind === 'string' ? record.kind : 'unknown',
    id: typeof record.id === 'string' ? record.id : '',
  }
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

  /**
   * 全局库只读方法（不属任何项目，因此不打开项目运行时）。
   * @param method - `globalLibrary` / `globalAudit`。
   * @param params - `globalAudit` 接受 `{ limit?: 1..500 }`。
   * @returns 面板响应信封。
   */
  async invokeGlobal(method: PanelMethod, params: Record<string, unknown> | undefined): Promise<PanelResponse> {
    try {
      const port = this.options.globalLibrary
      if (port === undefined) {
        fail(ERROR_CODES.INTERNAL, '全局库读取器未装配')
      }
      if (method === 'globalLibrary') {
        return { ok: true, data: jsonSafe(port.library()) }
      }
      if (method === 'globalAudit') {
        const limitRaw = params?.limit
        const limit = limitRaw === undefined ? 50 : Number(limitRaw)
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          fail(ERROR_CODES.INVALID_PAYLOAD, 'limit 必须是 1..500 的整数')
        }
        return { ok: true, data: jsonSafe(port.audit(limit)) }
      }
      return { ok: false, error: toErrorShape(new Error(`未知全局方法：${String(method)}`)) }
    } catch (error) {
      return { ok: false, error: toErrorShape(error) }
    }
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

      case 'runs': {
        const items = [...state.runs.values()]
          .map((run) => ({
            id: run.id,
            workflowId: run.workflowId,
            workflowRevision: run.workflowRevision,
            teamId: run.teamId,
            status: run.status,
            completionRevision: run.completionRevision,
            revision: run.revision,
            taskCount: run.taskIds.length,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
          }))
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        return jsonSafe({ items })
      }

      case 'run': {
        const runId = requireParam(params, 'runId')
        const run = state.runs.get(runId)
        if (run === undefined) {
          fail(ERROR_CODES.NOT_FOUND, '运行不存在', { details: { runId } })
        }
        return jsonSafe({
          run,
          completion: state.runCompletions.get(run.id) ?? null,
          tasks: run.taskIds.map((taskId) => {
            const task = state.tasks.get(taskId)
            return { id: taskId, title: task?.title ?? null, status: task?.status ?? null }
          }),
        })
      }

      case 'knowledge': {
        const items = [...state.knowledge.values()]
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            body: entry.body,
            status: entry.status,
            revision: entry.revision,
            evidence: entry.evidence,
            supersedes: entry.supersedes,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          }))
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        return jsonSafe({ items })
      }

      case 'effects': {
        const counts: Record<string, number> = {
          requested: 0,
          accepted: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          'outcome-unknown': 0,
        }
        const items = [...state.effects.values()].map((effect) => {
          counts[effect.status] = (counts[effect.status] ?? 0) + 1
          return { id: effect.id, kind: effect.kind, status: effect.status }
        })
        return jsonSafe({ items, counts })
      }

      case 'audit': {
        const limitRaw = params?.limit
        const limit = limitRaw === undefined ? 50 : Number(limitRaw)
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          fail(ERROR_CODES.INVALID_PAYLOAD, 'limit 必须是 1..200 的整数')
        }
        const beforeRaw = params?.beforeSeq
        const beforeSeq = beforeRaw === undefined ? undefined : Number(beforeRaw)
        if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, 'beforeSeq 必须是正整数')
        }
        const events = runtime.readEvents()
        const older = beforeSeq === undefined ? [...events] : events.filter((event) => event.projectSeq < beforeSeq)
        const page = older.slice(Math.max(0, older.length - limit)).reverse()
        const last = page[page.length - 1]
        const items = page.map((event) => ({
          seq: event.projectSeq,
          at: event.occurredAt,
          type: event.type,
          batchId: event.batchId,
          actor: actorSummary(event.actor),
          entity: entitySummary(event.entity),
        }))
        // 还有更旧的才给游标；否则前端会一直「加载更早」翻到空页。
        const hasOlder = page.length === limit && older.length > page.length && last !== undefined
        return jsonSafe({ items, nextBeforeSeq: hasOlder ? last.projectSeq : null })
      }

      case 'memory': {
        const port = this.options.memory
        if (port === undefined) {
          fail(ERROR_CODES.INTERNAL, '记忆读取器未装配')
        }
        const limitRaw = params?.limit
        const limit = limitRaw === undefined ? 50 : Number(limitRaw)
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          fail(ERROR_CODES.INVALID_PAYLOAD, 'limit 必须是 1..200 的整数')
        }
        const bankIdRaw = params?.bankId
        if (bankIdRaw !== undefined && typeof bankIdRaw !== 'string') {
          fail(ERROR_CODES.INVALID_PAYLOAD, 'bankId 必须是字符串')
        }
        const filtered = typeof bankIdRaw === 'string' && bankIdRaw.length > 0 ? { bankId: bankIdRaw, limit } : { limit }
        return jsonSafe(port.view(rootDir, filtered))
      }

      case 'settings':
        return jsonSafe({
          configRevision: state.configRevision,
          defaults: state.configDefaults,
          teams: [...state.teamConfigs.entries()].map(([teamId, snapshot]) => ({
            teamId,
            configRevision: snapshot.configRevision,
            contentHash: snapshot.contentHash,
            mergeAlgorithmVersion: snapshot.mergeAlgorithmVersion,
            safetyLimitsVersion: snapshot.safetyLimitsVersion,
            clamped: snapshot.clamped,
          })),
        })

      default: {
        const exhaustive: never = method
        fail(ERROR_CODES.INVALID_COMMAND, `未实现的面板方法：${String(exhaustive)}`)
      }
    }
  }
}