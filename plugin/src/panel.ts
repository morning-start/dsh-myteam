/**
 * T13-M2 host 侧：MyTeamPanelFacade —— 根级（root realm）typert remote 门面服务。
 *
 * 为什么需要门面（M2 定案，阶段四十七~四十九网关/客户端全链取证）：
 *  - preset 挂载审计要求队长 scope 内的 MyTeamRemote 服务 isolate（entry-local realm，
 *    见 cordis.patch.yml myteam-host 行）→ 网关 claimsEndpoint/resolveSrcDescriptor 只扫
 *    root 可见服务（collectSrcClaims 遍历 ctx.reflect.props + ctx.get(serviceKey)，
 *    isolate 服务在 root get 返回 undefined 被跳过）→ `ctx.remote.myteam.*` 在 claims
 *    层被拒（客户端 .catch 优雅降级 = M1 文件态）。
 *  - 官方解法样板（dsh-api-session-controller/lib/index.js:2952 SessionController）：
 *    根级 typert remote 服务 + 方法显式收 sessionId 参数；dsh-agent 在 typert.lookups
 *    注册了 lookup `agent`（wire=agentId，resolve: agents.get(sessionId)），网关把客户端
 *    传的 sessionId 解析成 Agent 实例再调方法。
 *  - 门面 namespace 仍取 'myteam' → 客户端端点 `myteam/<method>` 不变；root 只见门面 →
 *    resolveSrcDescriptor 无歧义；隔离的 MyTeamRemote 经官方口子
 *    ctx.agentPresets.serviceFor(agent, 'myteam') 读取（lib/index.js:725）。
 *
 * 形态纪律（与 remote/service.ts 一致）：
 *  - strip-only 环境无装饰器 → 手动 markRemoteMethods（direct invocation，同构 marker）。
 *  - 方法签名必须全是简单标识符（网关 methodParameterNames 用 Function.toString 读形参名，
 *    禁解构/默认/rest；`signal` 只能是末参）——首参命名 `agent` 命中 lookup，第二参 `query`
 *    为原 args 对象（json 参数可缺省）。
 *  - apply + 行级 inject（cordis.patch.yml myteam-panel 行）双保险：门面要读
 *    ctx.agents（listTeams 会话发现）与 ctx.agentPresets（serviceFor）。
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isAbsolute, join } from 'node:path'
import { readdirSync } from 'node:fs'
import { markRemoteMethods, normalizeCtx } from './remote/service.ts'
import { readGlobalIndex } from './core/index/team-index.ts'
import { buildOfflineAudit, buildOfflineBoard, buildOfflinePresets, buildOfflineProject, buildOfflineTaskDetail, buildOfflineTokens, isSafeTeamId, projectRolePaths, roleUsage } from './core/index/offline-view.ts'
import { buildProjectView, buildRoleDetailView, type ProjectTeamInput } from './remote/views.ts'
import { assertValidRole, deleteProjectRoleSafe, listRoleCatalog, readProjectRole, saveProjectRole } from './core/roles/role-store.ts'
// CHG-87（docs/04 §2 承诺的 roleOp 端点）：与 host 侧共用同一份角色库写实现
import { roleOp as roleOpImpl } from './core/roles/role-ops.ts'
import { mcpServerOf } from './core/members/capability-guard.ts'
import { readPresetCatalog, BUILTIN_PRESET_IDS } from './core/presets/preset-store.ts'
// CHG-91（插件团队贡献契约 v1）：面板读取插件贡献（只读；贡献物本身没有写入口）
import { loadContributions } from './core/contributions/parse.ts'
import { contributionsRoot } from './core/contributions/discover.ts'
import { CONTRIBUTION_CODES, type ContributionCatalog } from './core/contributions/contract.ts'
import { isStoreInitialized, readManifest, storeLayout, ensureStore, rejectProjectRoot, displayPath, STORE_DIR } from './core/workspace/layout.ts'

/** 门面可见的最小 Agent 面（真实实例由网关 lookup 注入；测试用 mock） */
type AgentLike = { session: { id: string } }

/** 成员摘要（角色 ↔ 团队关系视图：roleId/实例名/状态/当前任务） */
type MemberSummary = { roleId: string; instanceName: string; status: string; currentTaskId: string }

/** 团队摘要（全局视图列表项；workspaceRoot 为空表示旧实现未提供） */
type TeamInfo = {
  teamId?: string
  /** CHG-62：团队名（账本 team.created.name；旧实现无此字段时面板回落 teamId） */
  name?: string
  workspaceRoot?: string
  goal?: string
  state?: string
  members?: MemberSummary[]
  counts?: { tasks: number; done: number; running: number }
}
type TeamSummary = {
  sessionId: string
  teamId: string
  name: string
  workspaceRoot: string
  goal: string
  state: string
  members: MemberSummary[]
  counts: { tasks: number; done: number; running: number }
  /** true=存活队长会话可交互；false=来自离线索引（会话未运行，只读摘要） */
  online: boolean
  /** 索引最近更新时间（离线团队用于「最后活动」；存活会话未提供时为 undefined） */
  updatedAt?: number
}

  /** 隔离 MyTeamRemote 的最小面（serviceFor 返回值；保持与 remote/service.ts 方法一致） */
type RemoteLike = {
  defaultTeamId(): string
  /** 全局视图摘要（非网关端点；旧实现无此方法时 listTeams 降级为仅 id） */
  describe?: () => TeamInfo
  getBoard(args: Record<string, unknown>): Promise<unknown>
  getTaskDetail(args: Record<string, unknown>): Promise<unknown>
  getTokens(args: Record<string, unknown>): Promise<unknown>
  getInbox(args: Record<string, unknown>): Promise<unknown>
  planAction(args: Record<string, unknown>): Promise<unknown>
  postComment(args: Record<string, unknown>): Promise<unknown>
  memberOp(args: Record<string, unknown>): Promise<unknown>
  disband(args: Record<string, unknown>): Promise<unknown>
  getRoles(args: Record<string, unknown>): Promise<unknown>
  getKnowledge(args: Record<string, unknown>): Promise<unknown>
  getAudit(args: Record<string, unknown>): Promise<unknown>
  getConfig(args: Record<string, unknown>): Promise<unknown>
  getPresets(args: Record<string, unknown>): Promise<unknown>
  /** CHG-72：面板新建/编辑任务（受限写端点，actor=human） */
  createTask?(args: Record<string, unknown>): Promise<unknown>
  updateTask?(args: Record<string, unknown>): Promise<unknown>
  assignTask?(args: Record<string, unknown>): Promise<unknown>
  participateTask?(args: Record<string, unknown>): Promise<unknown>
  /** CHG-73：执行期编辑闭环（重规划 / 取消 / 批量编排），actor=human */
  rescopeTask?(args: Record<string, unknown>): Promise<unknown>
  cancelTask?(args: Record<string, unknown>): Promise<unknown>
  batchTaskOp?(args: Record<string, unknown>): Promise<unknown>
  /** CHG-76：从目标出草稿 → 批量建任务（预览 + 两段确认），actor=human */
  createTasks?(args: Record<string, unknown>): Promise<unknown>
  /** CHG-86（M2-C）：门禁裁决（review/verify 强制交叉审查；archive 由 host 落位校验），actor=human */
  reviewTask?(args: Record<string, unknown>): Promise<unknown>
  /** CHG-86（P0-2）：归档快照读面（面板归档回放视图） */
  getArchive?(args: Record<string, unknown>): Promise<unknown>
  getArchives?(args: Record<string, unknown>): Promise<unknown>
  /** CHG-86（P1-9）：知识提案采纳/驳回（面板写路径，actor=human） */
  adoptKnowledge?(args: Record<string, unknown>): Promise<unknown>
  /**
   * CHG-87（FR-16.1 单角色调用）：`/myteam+<roleId>` 的写入口。
   * 与队长工具 `myteam_apply_roles` 同一条管线（不写团队账本，只落 sessionDefaults）。
   */
  applyRoles?(args: Record<string, unknown>): Promise<unknown>
  /**
   * CHG-88（M2-E / FR-16.3）：会话移交（摘要 → 新团队预设会话；不写团队账本）。
   */
  handoff?(args: Record<string, unknown>): Promise<unknown>
}

/** 非队长会话的统一降级值（客户端据此显示友好态；不让 RPC 变成错误信封） */
const UNAVAILABLE = { status: 'unavailable', reason: 'myteam preset service unavailable in this session' } as const

/** 离线视图参数非法（路径穿越/相对路径/空 teamId 一律拒绝） */
const OFFLINE_INVALID = {
  status: 'error',
  code: 'MT_VALIDATION',
  message: 'workspaceRoot must be an absolute path and teamId a safe identifier',
} as const

/** 离线视图目标校验：绝对工作区 + 白名单 teamId（非法返回 undefined） */
function offlineTarget(query: Record<string, unknown> | undefined): { workspaceRoot: string; teamId: string } | undefined {
  const workspaceRoot = String(query?.workspaceRoot ?? '')
  const teamId = String(query?.teamId ?? '')
  if (!isAbsolute(workspaceRoot) || !isSafeTeamId(teamId)) return undefined
  return { workspaceRoot, teamId }
}

export class MyTeamPanelFacade extends TypertRemoteService {
  /** 跨工作区索引路径（测试可注入；缺省 ~/.dsh/myteam/workspaces.json） */
  private globalIndexPath?: string
  /**
   * CHG-91：插件贡献目录缓存（按工作区）。
   *
   * 为什么要缓存：`listRoleCatalog` 在面板的多条读路径上（角色库 / 能力目录 / 角色详情），
   * 每次都重新扫盘会把一次页面渲染变成 N 次 IO。贡献目录很小，按 workspaceRoot 缓存足够；
   * 插件装/卸后用户点「重新扫描插件」走 `reloadContributions` 清缓存。
   */
  private contributionCache = new Map<string, ContributionCatalog>()

  constructor(ctx: unknown, opts: { globalIndexPath?: string } = {}) {
    // cordis 服务名 = "myteamPanel"；typert namespace = "myteam"（客户端端点 myteam/* 不变，
    // 与 SessionController 的 super(ctx,'sessionController',{namespace:'session'}) 同模式）
    super(normalizeCtx(ctx as never), 'myteamPanel', { namespace: 'myteam' })
    this.globalIndexPath = opts.globalIndexPath
  }

  /** 官方口子读隔离服务：agentPresets.serviceFor(agent, 'myteam')（mount.js serviceForMount 扫 store） */
  private remoteFor(agent: AgentLike): RemoteLike | undefined {
    const registry = (this.ctx as Record<string, unknown> as { agentPresets?: { serviceFor?: (a: unknown, n: string) => unknown } }).agentPresets
    if (!registry || typeof registry.serviceFor !== 'function') return undefined
    return registry.serviceFor(agent, 'myteam') as RemoteLike | undefined
  }

  /* ── CHG-91：插件贡献（只读装载；按工作区缓存）────────────────── */

  /**
   * 装载（或取缓存）某个工作区的插件贡献。
   *
   * 冲突裁决需要「内置 id」与「模板可解析集合」——两者都从**不含插件**的基准目录算，
   * 否则插件角色会自我放行（把自己的 id 当成「已知」）。
   */
  private contributionsFor(workspaceRoot: string): ContributionCatalog {
    const cached = this.contributionCache.get(workspaceRoot)
    if (cached) return cached
    // **基准目录**：故意取「不含插件」的那一份——否则插件角色会把自己的 id 当成「已知」
    // 而自我放行（撞内置也发现不了）。
    const base = listRoleCatalog(projectRolePaths(workspaceRoot))
    const catalog = loadContributions(contributionsRoot(), {
      builtinRoleIds: new Set(base.filter((entry) => entry.origin === 'builtin').map((entry) => entry.definition.id)),
      builtinTemplateIds: new Set(BUILTIN_PRESET_IDS),
      resolvableRoleIds: new Set(base.map((entry) => entry.definition.id)),
    })
    this.contributionCache.set(workspaceRoot, catalog)
    return catalog
  }

  /** CHG-91：显式重载（面板「重新扫描插件」/ 端点 `reloadContributions`） */
  private reloadContributionsFor(workspaceRoot: string): ContributionCatalog {
    this.contributionCache.delete(workspaceRoot)
    return this.contributionsFor(workspaceRoot)
  }

  /** CHG-91：角色目录（含插件贡献）——面板所有读路径统一走这里 */
  private roleCatalogFor(workspaceRoot: string) {
    return listRoleCatalog(projectRolePaths(workspaceRoot), this.contributionsFor(workspaceRoot).roles)
  }

  /** CHG-91：团队模板目录（含插件贡献） */
  private presetCatalogFor(workspaceRoot: string) {
    return readPresetCatalog(workspaceRoot, this.contributionsFor(workspaceRoot).teams)
  }

  /**
   * 无参会话发现：列出所有队长会话（sessionId 与客户端 slot binding.key 同命名空间，
   * 即 agents store 键 = agent.session.id）。root 槽（main）的 Panel 用它拿 sessionId。
   */
  async listTeams() {
    const agents = (this.ctx as { agents?: { list?: () => AgentLike[] } }).agents
    const teams: TeamSummary[] = []
    const liveAgents = agents && typeof agents.list === 'function' ? agents.list() : []
    for (const agent of liveAgents) {
      const remote = this.remoteFor(agent)
      if (!remote) continue
      let info: TeamInfo | undefined
      try {
        info = remote.describe?.()
      } catch {
        info = undefined
      }
      teams.push({
        sessionId: agent.session.id,
        teamId: info?.teamId ?? remote.defaultTeamId(),
        name: info?.name ?? '',
        workspaceRoot: info?.workspaceRoot ?? '',
        goal: info?.goal ?? '',
        state: info?.state ?? '',
        members: info?.members ?? [],
        counts: info?.counts ?? { tasks: 0, done: 0, running: 0 },
        online: true,
      })
    }
    // T24（CHG-45）：合并跨工作区离线索引（会话未运行/宿主重启后的团队仍可见）
    const liveKeys = new Set(teams.map((team) => `${team.workspaceRoot}::${team.teamId}`))
    // CHG-72：同一工作区可能同时有多个队长会话指向同一个团队（多开会话/重开页面）——
    // 面板按「工作区 + 团队」去重，避免团队卡/任务重复出现。
    const deduped: TeamSummary[] = []
    const seenLive = new Set<string>()
    for (const team of teams) {
      const key = `${team.workspaceRoot}::${team.teamId}`
      if (seenLive.has(key)) continue
      seenLive.add(key)
      deduped.push(team)
    }
    teams.length = 0
    teams.push(...deduped)
    // 旧版 describe 不提供 workspaceRoot 时，按 teamId 兜底去重（CHG-46 修正：看存活侧是否缺 root）
    const liveNoRoot = new Set(teams.filter((team) => !team.workspaceRoot).map((team) => team.teamId))
    for (const offline of this.offlineTeams()) {
      if (liveKeys.has(`${offline.workspaceRoot}::${offline.teamId}`)) continue
      if (liveNoRoot.has(offline.teamId)) continue
      teams.push(offline)
    }
    /**
     * CHG-102（P0「所有项目看起来都一样」）：这里**只做跨工作区发现**（项目下拉的候选），
     * 项目作用域的数据面是 `getProject({workspaceRoot})`——它按工作区过滤，不再把全局
     * 索引串进项目视图。两侧职责分开，避免「切了项目看到同一批团队」。
     */
    return { status: 'ok', teams }
  }

  /**
   * CHG-102：初始化项目级存储（面板空态里的「进入团队模式」入口）。
   *
   * 只建目录与元文件（`.dsh-myteam/` + `.gitignore` + `manifest.json`），**不建团队、不写账本、
   * 不召唤成员**——所以它是安全的项目级写操作，不需要两段确认；重复调用幂等。
   */
  async initStore(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    if (!isAbsolute(workspaceRoot) || rejectProjectRoot(workspaceRoot)) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        message: `workspaceRoot 不能是 DSH profile / 家目录：${workspaceRoot}`,
      }
    }
    const result = ensureStore(workspaceRoot, { warn: () => {} })
    return {
      status: 'ok',
      workspaceRoot,
      root: result.layout.root,
      /* CHG-107：展示用（用户名 → ~）；root 保留绝对路径 */
      rootDisplay: displayPath(result.layout.root),
      created: result.created,
      migrated: result.migrated,
      warnings: result.warnings,
      initialized: isStoreInitialized(workspaceRoot),
    }
  }

  /**
   * CHG-102：项目级存储状态（面板空态/引导的唯一数据面）。
   *
   * 为什么必须有个端点：用户「还没开始团队模式的对话」时，面板不该凭空显示角色/团队/任务
   * ——那会把内置角色与全局库误读成「这个项目已经有团队了」。`initialized=false` 时
   * 客户端只画一句「这个项目还没进入团队模式」+ 初始化入口。
   */
  async getStoreState(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const layout = storeLayout(workspaceRoot)
    const initialized = isStoreInitialized(workspaceRoot)
    const manifest = initialized ? readManifest(workspaceRoot) : undefined
    return {
      status: 'ok',
      workspaceRoot,
      initialized,
      manifest: manifest ?? null,
      /** 目录契约（面板「设置 → 存储」展示 / 排障用；路径不是秘密） */
      layout: {
        root: layout.root,
        /* CHG-107：展示用（用户名 → ~） */
        rootDisplay: displayPath(layout.root),
        gitignore: layout.gitignore,
        config: layout.config,
        tasks: layout.tasks,
        history: layout.history,
        state: layout.state,
      },
      /** 上传纪律：与 `.dsh-myteam/.gitignore` 同语义（面板只读展示） */
      upload: {
        include: ['manifest.json', 'README.md', 'structure.md', 'config/', 'tasks/'],
        exclude: ['state/', 'history/', 'export/', '*.tmp'],
      },
    }
  }

  /** 跨工作区索引 → 离线团队摘要（索引缺失/损坏时返回空，不抛错） */
  private offlineTeams(): TeamSummary[] {
    try {
      const global = this.globalIndexPath ? readGlobalIndex(this.globalIndexPath) : readGlobalIndex()
      if (!global?.workspaces) return []
      const out: TeamSummary[] = []
      for (const ws of Object.values(global.workspaces)) {
        for (const team of ws.teams ?? []) {
          out.push({
            sessionId: '',
            teamId: team.teamId,
            name: team.name ?? '',
            workspaceRoot: ws.workspaceRoot,
            goal: team.goal ?? '',
            state: team.state ?? '',
            members: (team.members ?? []).map((member) => ({ roleId: member.roleId, instanceName: member.instanceName, status: member.status, currentTaskId: '' })),
            counts: team.counts ?? { tasks: 0, done: 0, running: 0 },
            online: false,
            updatedAt: team.updatedAt ?? 0,
          })
        }
      }
      return out
    } catch {
      return []
    }
  }

  /* ── 离线只读视图（T25/CHG-46）：不依赖队长会话，直接折叠工作区账本 ── */

  /**
   * 离线看板：会话未运行时从 ledger.jsonl 折叠出列视图（只读）。
   * 与 getBoard 的区别：无 agent 首参（网关参数即 query），不经过隔离服务。
   */
  async getOfflineBoard(query: Record<string, unknown>) {
    const target = offlineTarget(query)
    if (!target) return OFFLINE_INVALID
    const { workspaceRoot, teamId } = target
    const result = buildOfflineBoard(workspaceRoot, teamId)
    if (!result) return { status: 'empty', readOnly: true, online: false, teamId, workspaceRoot }
    return { status: 'ok', readOnly: true, online: false, ...result }
  }

  /** 离线任务详情：时间线/证据/沟通区从账本复原（只读） */
  async getOfflineTaskDetail(query: Record<string, unknown>) {
    const target = offlineTarget(query)
    if (!target) return OFFLINE_INVALID
    const { workspaceRoot, teamId } = target
    const taskId = String(query?.taskId ?? '')
    if (!isSafeTeamId(taskId)) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    const detail = buildOfflineTaskDetail(workspaceRoot, teamId, taskId)
    if (!detail) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found (or team ledger is empty)` }
    return { status: 'ok', readOnly: true, online: false, teamId, detail }
  }

  /** 离线 tokens：直接读团队目录 tokens.json 侧车（REV-5 双口径标注；缺失返回 empty） */
  async getOfflineTokens(query: Record<string, unknown>) {
    const target = offlineTarget(query)
    if (!target) return OFFLINE_INVALID
    const { workspaceRoot, teamId } = target
    const tokens = buildOfflineTokens(workspaceRoot, teamId)
    if (!tokens) return { status: 'empty', readOnly: true, online: false, teamId, workspaceRoot }
    return { status: 'ok', readOnly: true, online: false, teamId, tokens }
  }

  /** 离线审计：账本事件流新→旧分页（归档回放，CHG-49） */
  async getOfflineAudit(query: Record<string, unknown>) {
    const target = offlineTarget(query)
    if (!target) return OFFLINE_INVALID
    const { workspaceRoot, teamId } = target
    const limit = Number(query?.limit ?? 100)
    const beforeSeq = query?.beforeSeq === undefined || query?.beforeSeq === null ? undefined : Number(query.beforeSeq)
    const audit = buildOfflineAudit(workspaceRoot, teamId, {
      limit: Number.isFinite(limit) ? limit : 100,
      beforeSeq: Number.isFinite(beforeSeq) ? beforeSeq as number : undefined,
    })
    if (!audit) return OFFLINE_INVALID
    return { status: 'ok', readOnly: true, online: false, ...audit }
  }

  /** 离线团队模板（CHG-50/52）：内置 + 项目目录，全局只存角色。
   *  CHG-69：模板目录只依赖 workspaceRoot（项目管理不需要 teamId），面板全局页在未选团队时也能读。 */
  async getOfflinePresets(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const catalog = buildOfflinePresets(workspaceRoot)
    return { status: 'ok', readOnly: true, online: false, ...catalog }
  }

  /* ── CHG-69：项目作用域聚合（角色 / 团队 / 任务三标签的数据面） ── */

  /**
   * 项目聚合：团队摘要 + 跨团队任务（含参与团队）+ 角色目录（含兴趣词/技能/MCP/在册情况）。
   * 在线团队走隔离服务 getBoard（有主席位），离线团队折叠工作区账本；角色目录直接读文件（不需会话）。
   */
  async getProject(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const { inputs, entries, warnings } = await this.collectProject(workspaceRoot)
    const view = buildProjectView({ workspaceRoot, teams: inputs, entries, warnings })
    // CHG-73：删除按钮还要求「模板没引用它」——模板是配置资产，删角色会让模板引用悬空
    try {
      const presetRoleIds = new Set(
        this.presetCatalogFor(workspaceRoot).entries.flatMap((entry) => (entry.definition.members ?? []).map((member) => member.roleId)),
      )
      for (const role of view.roles) role.canDelete = role.canDelete && !presetRoleIds.has(role.id)
    } catch {
      // 模板目录缺失/损坏：按角色库自身结论（删除时服务端仍会二次校验占用面）
    }
    return { status: 'ok', ...view }
  }

  /** 角色详情（FR-24）：定义/设定/技能/MCP + 跨团队在册情况（实例名与状态） */
  async getRoleDetail(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    const roleId = String(query?.roleId ?? '')
    if (!isAbsolute(workspaceRoot) || !roleId) return OFFLINE_INVALID
    const { inputs, entries } = await this.collectProject(workspaceRoot)
    const memberships = inputs.flatMap((team) =>
      (team.members ?? []).map((member) => ({
        roleId: member.roleId,
        membership: {
          teamId: team.teamId,
          ...(team.name ? { teamName: team.name } : {}),
          instanceName: member.instanceName,
          status: member.status,
          online: team.online,
          workspaceRoot,
        },
      })),
    )
    const detail = buildRoleDetailView(entries, roleId, memberships)
    if (!detail) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in any library` }
    return { status: 'ok', workspaceRoot, roleId, ...detail }
  }

  /**
   * 面板保存项目角色（CHG-72，FR-27，ADR-006 R1）：角色是**配置资产**，不进账本。
   * 写 `.dsh-myteam/config/roles/<id>.json`，校验与工具链同源（assertValidRole）；
   * 同名已存在必须显式 confirm（两段确认）；每次写入留一行 `.audit.jsonl` 旁路审计。
   */
  async saveRole(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const role = query?.role as Record<string, unknown> | undefined
    if (!role || typeof role !== 'object' || Array.isArray(role)) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'role is required (object)' }
    }
    // CHG-103：作用域守卫与工具链**同一份实现**（缺省 project；global 需 confirmGlobal）
    const out = roleOpImpl(
      { paths: projectRolePaths(workspaceRoot), actor: 'human' },
      'save',
      { role, scope: query?.scope, confirmGlobal: query?.confirmGlobal, confirm: query?.confirm },
    )
    return out.status === 'saved' ? { ...out, workspaceRoot } : out
  }

  /* ── CHG-73：角色删除 + 能力目录（配置资产写操作 / 角色表单候选）── */

  /**
   * 删除角色（FR-27，ADR-006 R1）：配置资产，不进账本。
   * 两段确认 + 占用面（模板引用 / 团队在册 / 项目自身角色）+ `.audit.jsonl` 审计行。
   *
   * CHG-103：删除也走作用域——缺省只删项目库；`scope:'global'` 需 `confirmGlobal:true`。
   */
  async deleteRole(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const roleId = String(query?.roleId ?? '').trim()
    if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'roleId is required' }
    const usage = roleUsage(workspaceRoot, roleId)
    const isGlobal = query?.scope === 'global'
    if (query?.confirm !== true || (isGlobal && query?.confirmGlobal !== true)) {
      return {
        status: 'confirm-required',
        scope: isGlobal ? 'global' : 'project',
        roleId,
        usage: { teams: usage.teams.length, instances: usage.instances, presets: usage.presets },
        bindings: usage.bindings,
        message: isGlobal
          ? `删除**全局**角色「${roleId}」会影响所有项目看到的这一份定义（各项目副本不受影响）；确认请同时带 confirmGlobal=true 与 confirm=true`
          : `删除项目角色「${roleId}」会移除 ${STORE_DIR}/config/roles/${roleId}.json（在跑成员仍用召唤时快照）；${
              usage.bindings.length > 0 ? `当前仍被占用：${usage.bindings.join(', ')}` : '当前未被任何团队/模板引用'
            }；确认请带 confirm=true`,
      }
    }
    const out = roleOpImpl(
      { paths: projectRolePaths(workspaceRoot), actor: 'human', bindings: usage.bindings },
      'delete',
      { roleId, scope: query?.scope, confirmGlobal: query?.confirmGlobal, confirm: query?.confirm },
    )
    return out.status === 'deleted' ? { ...out, workspaceRoot } : out
  }

  /**
   * CHG-87（docs/04 §2 承诺的 `roleOp` 端点）：角色库写操作的统一入口。
   *
   * 为什么需要（问题不在"多一个方法"）：docs/04 §2 把 `roleOp(op, payload)` 列成对外端点，
   * 实现只有 `saveRole` / `deleteRole` —— **文档承诺与实现分叉**，契约测试不可能通过；
   * 同时 M2 的「发布到全局库」「fork 成新 id」一直没有落点（角色目录只能看不能动）。
   *
   * 与 `saveRole` / `deleteRole` 的关系：`roleOp` 是**统一入口**，两者保留为细粒度端点
   * （既有客户端与 t13p 断言不动）。`op='save'|'delete'` 与它们走同一份实现
   * （`core/roles/role-ops.ts`），不会出现语义漂移。
   *
   * C7 守门：`delete` 的占用面（团队在册 / 模板引用 / 项目自身角色）由 `roleUsage` 算好传入。
   */
  async roleOp(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const op = String(query?.op ?? '')
    const payload = (query?.payload as Record<string, unknown> | undefined) ?? {}
    // CHG-91（契约 P3 单向流动）：插件贡献的角色**只读**——面板与工具同一份守门
    if (op === 'save' || op === 'delete' || op === 'publish') {
      const directId = String(payload.roleId ?? '')
      const saveId = String((payload as { role?: { id?: unknown } }).role?.id ?? '')
      const contributed = this.contributionsFor(workspaceRoot).roles
      const readonlyId = contributed.some((role) => role.id === directId) ? directId : (saveId && contributed.some((role) => role.id === saveId) ? saveId : '')
      if (readonlyId) {
        return {
          status: 'error',
          code: CONTRIBUTION_CODES.ROLE_READONLY,
          roleId: readonlyId,
          message: `插件贡献的角色「${readonlyId}」只读；想改请先「复制到项目」再编辑项目库那份`,
        }
      }
    }
    // delete 的 C7 占用面（团队在册 / 模板引用 / 项目自身角色）先算好再交给角色库层
    const roleId = String(payload.roleId ?? '')
    const bindings = op === 'delete' && roleId ? roleUsage(workspaceRoot, roleId).bindings : []
    return roleOpImpl({ paths: projectRolePaths(workspaceRoot), bindings, actor: 'human' }, op, {
      ...payload,
      ...(query?.confirm === true ? { confirm: true } : {}),
    })
  }

  /**
   * CHG-91（契约 §12.1）：插件贡献的**只读**视图。
   *
   * 根级端点（只收 `query`，不需要活动会话）——插件贡献是**配置资产**，离线团队也能看
   * （与 `roleOp` / `getCapabilityCatalog` 同口径）。
   *
   * 为什么没有写入端点：贡献物由插件安装时写盘（P3 单向流动），myteam 只读不写。
   */
  async getContributions(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const catalog = this.contributionsFor(workspaceRoot)
    return {
      status: 'ok',
      root: catalog.root,
      /* CHG-107：展示用（用户名 → ~）；root 保留绝对路径供复制/排障 */
      rootDisplay: displayPath(catalog.root),
      ok: catalog.ok,
      scannedAt: catalog.scannedAt,
      plugins: catalog.plugins,
      roles: catalog.roles.map((role) => ({ id: role.id, name: role.name, origin: role.origin })),
      teams: catalog.teams.map((team) => ({ id: team.id, name: team.name, namespace: team.namespace, members: team.members })),
      warnings: catalog.warnings,
    }
  }

  /** CHG-91：显式重载贡献目录（面板「重新扫描插件」；工具 `myteam_reload_contributions` 同源） */
  async reloadContributions(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    if (!isAbsolute(workspaceRoot)) return OFFLINE_INVALID
    const catalog = this.reloadContributionsFor(workspaceRoot)
    return {
      status: 'ok',
      root: catalog.root,
      ok: catalog.ok,
      scannedAt: catalog.scannedAt,
      plugins: catalog.plugins,
      roles: catalog.roles.map((role) => ({ id: role.id, name: role.name, origin: role.origin })),
      teams: catalog.teams.map((team) => ({ id: team.id, name: team.name, namespace: team.namespace, members: team.members })),
      warnings: catalog.warnings,
    }
  }

  /**
   * CHG-87（FR-16.1 单角色调用）：`/myteam+<roleId>` 的面板写入口。
   *
   * 与队长工具 `myteam_apply_roles` 同一条管线（`exec.actor='human'`）；
   * 只有在线团队有活动会话（`applyRoles` 走隔离 remote），离线团队 → `MT_UNAVAILABLE`
   * （单角色调用注入的是**会话**配置，没有会话就没有注入点——不假装成功）。
   */
  async applyRoles(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote || typeof remote.applyRoles !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: '单角色调用需要活动队长会话（离线团队没有会话可注入）' }
    }
    return remote.applyRoles(query ?? {})
  }

  /**
   * CHG-88（M2-E / FR-16.3）：会话移交（面板入口）。
   *
   * 移交需要**活动队长会话**（摘要从当前团队的投影 + 账本提取）→ 离线团队
   * `MT_UNAVAILABLE`（不假装成功）。移交本身不写团队账本。
   */
  async handoff(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote || typeof remote.handoff !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: '会话移交需要活动队长会话（离线团队没有会话可移交）' }
    }
    return remote.handoff(query ?? {})
  }

  /**
   * 角色表单的技能 / MCP 候选目录（CHG-73，FR-27）。
   * 这是**提示**不是白名单：技能来自宿主 skills 注册表 + 已有角色声明，MCP 由工具表里的
   * `mcp__<server>__*` 推导（与能力隔离同口径）。读不到就降级并如实带回 warnings。
   */
  async getCapabilityCatalog(query: Record<string, unknown>) {
    const workspaceRoot = String(query?.workspaceRoot ?? '')
    const warnings: string[] = []
    const skills = new Map<string, 'host' | 'role'>()
    const mcp = new Map<string, 'host' | 'role'>()
    try {
      if (workspaceRoot && isAbsolute(workspaceRoot)) {
        for (const entry of this.roleCatalogFor(workspaceRoot)) {
          for (const skill of entry.definition.skills ?? []) skills.set(skill, 'role')
          for (const name of entry.definition.mcpAllowlist ?? []) mcp.set(name, 'role')
        }
      }
    } catch (e) {
      warnings.push(`role catalog unavailable: ${String((e as { message?: string }).message ?? e)}`)
    }
    const getService = (name: string): unknown => {
      try {
        return typeof (this.ctx as unknown as { get?: unknown }).get === 'function' ? (this.ctx as unknown as { get: (n: string) => unknown }).get(name) : undefined
      } catch {
        return undefined
      }
    }
    // MCP：工具表里 mcp__<server>__* → server 名（与 capability-guard 的 mcpServerOf 同口径）
    try {
      const tools = getService('tools') as { schemas?: () => Array<{ name?: unknown }> } | undefined
      for (const schema of tools?.schemas?.() ?? []) {
        const server = mcpServerOf(typeof schema?.name === 'string' ? schema.name : '')
        if (server) mcp.set(server, 'host')
      }
    } catch (e) {
      warnings.push(`mcp catalog unavailable: ${String((e as { message?: string }).message ?? e)}`)
    }
    // 技能：宿主 skills 服务按工作区枚举（1.5s 超时，读不到只降级）
    try {
      const skillsSvc = getService('skills') as { list?: (opts: Record<string, unknown>) => Promise<Array<{ name?: unknown }>> } | undefined
      if (typeof skillsSvc?.list === 'function') {
        const list = await Promise.race([
          skillsSvc.list({ cwd: workspaceRoot || undefined }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout after 1500ms')), 1500)),
        ])
        for (const item of list ?? []) {
          if (typeof item?.name === 'string' && item.name.length > 0) skills.set(item.name, 'host')
        }
      } else {
        warnings.push('skills service unavailable; catalog falls back to role declarations')
      }
    } catch (e) {
      warnings.push(`skill catalog unavailable: ${String((e as { message?: string }).message ?? e)}`)
    }
    const toList = (map: Map<string, 'host' | 'role'>) =>
      [...map].map(([name, source]) => ({ name, source })).sort((a, b) => a.name.localeCompare(b.name))
    return { status: 'ok', skills: toList(skills), mcp: toList(mcp), warnings }
  }

  /** 收集一个工作区的项目输入：在线团队（隔离服务）+ 离线团队（账本折叠）+ 角色目录 */
  private async collectProject(workspaceRoot: string): Promise<{ inputs: ProjectTeamInput[]; entries: ReturnType<typeof listRoleCatalog>; warnings: string[] }> {
    const inputs: ProjectTeamInput[] = []
    const warnings: string[] = []
    const liveKeys = new Set<string>()
    const agents = (this.ctx as { agents?: { list?: () => AgentLike[] } }).agents
    const liveAgents = agents && typeof agents.list === 'function' ? agents.list() : []
    for (const agent of liveAgents) {
      const remote = this.remoteFor(agent)
      if (!remote) continue
      let info: TeamInfo | undefined
      try {
        info = remote.describe?.()
      } catch {
        info = undefined
      }
      if (!info || (info.workspaceRoot && info.workspaceRoot !== workspaceRoot)) continue
      const teamId = info.teamId ?? remote.defaultTeamId()
      // CHG-72：同工作区多会话指向同一团队 → 只保留一份（避免任务/团队重复聚合）
      if (liveKeys.has(teamId)) continue
      let board: Record<string, unknown> | undefined
      try {
        const result = (await remote.getBoard({ teamId })) as Record<string, unknown> | undefined
        // CHG-72 修正：getBoard 的返回形如 { teamId, board, config }（没有 status:'ok'），
        // 旧代码按 status 判定 → 在线团队的看板被静默丢弃（团队卡显示 0 任务/0 队员）。
        if (result?.board) board = result.board as Record<string, unknown>
        else if (result?.status === 'error') warnings.push(`${teamId}: ${String(result.message ?? 'getBoard failed')}`)
      } catch {
        warnings.push(`${teamId}: 在线看板读取失败，已按离线账本展示`)
      }
      const boardView = board as unknown as ProjectTeamInput['board']
      liveKeys.add(teamId)
      inputs.push({
        teamId,
        name: String(boardView?.name ?? info.name ?? ''),
        state: String(boardView?.state ?? info.state ?? ''),
        goal: String(boardView?.goal ?? info.goal ?? ''),
        online: true,
        sessionId: agent.session.id,
        members: boardView?.members ?? [],   // 无看板时成员面也降级（describe 的摘要不含 memberId，不能冒充成员卡）
        ...(boardView ? { board: boardView } : {}),
      })
    }
    // 离线团队（索引里存在但会话未运行）：折叠账本，与在线同构
    try {
      const global = this.globalIndexPath ? readGlobalIndex(this.globalIndexPath) : readGlobalIndex()
      const ws = global?.workspaces?.[workspaceRoot]
      for (const team of ws?.teams ?? []) {
        if (liveKeys.has(team.teamId)) continue
        const offline = buildOfflineBoard(workspaceRoot, team.teamId)
        if (!offline) continue
        inputs.push({
          teamId: team.teamId,
          name: offline.board.name ?? team.name ?? '',
          state: offline.board.state,
          goal: offline.board.goal ?? '',
          online: false,
          members: offline.board.members,
          board: offline.board,
        })
      }
    } catch {
      // 索引缺失/损坏：只展示在线团队（不阻断）
    }
    // 索引可能缺失/过期：再扫一遍工作区账本目录，补齐任何未收录的团队（面板不建第二事实源，
    // 只是发现账本；空账本被 buildOfflineBoard 过滤掉）
    try {
      const seen = new Set(inputs.map((input) => input.teamId))
      const teamsDir = storeLayout(workspaceRoot).tasks
      for (const name of readdirSync(teamsDir)) {
        if (seen.has(name) || !isSafeTeamId(name)) continue
        const offline = buildOfflineBoard(workspaceRoot, name)
        if (!offline) continue
        inputs.push({
          teamId: name,
          name: offline.board.name ?? name,
          state: offline.board.state,
          goal: offline.board.goal ?? '',
          online: false,
          members: offline.board.members,
          board: offline.board,
        })
      }
    } catch {
      // 目录不存在 = 没有账本，正常
    }
    const entries = this.roleCatalogFor(workspaceRoot)
    return { inputs, entries, warnings }
  }

  /* ── 会话门面（首参 agent 由网关 lookup 'agent' 解析；query 透传给隔离服务）── */

  /** 活跃团队信息卡 + 看板 */
  async getBoard(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getBoard(query ?? {})
  }

  /** 任务详情：时间线 + 证据块 + 沟通区 */
  async getTaskDetail(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getTaskDetail(query ?? {})
  }

  /** token 侧车四桶 + 命中率 */
  async getTokens(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getTokens(query ?? {})
  }

  /** 人工待办：暂存横幅 / escalate 提醒 / 提案计数 / 徽标 */
  async getInbox(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getInbox(query ?? {})
  }

  /** 暂存横幅三动作（Approve & Run / Revise / Discard） */
  async planAction(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.planAction(query ?? {})
  }

  /** 人留言进任务 thread（actor=human） */
  async postComment(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.postComment(query ?? {})
  }

  /** 面板新建任务（CHG-72，FR-29）：受限写端点 → 隔离服务 → 同一账本管线（actor=human） */
  async createTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.createTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'createTask requires a live team session (disable offline view)' }
    }
    return remote.createTask(query ?? {})
  }

  /** 面板编辑任务（CHG-72，FR-31）：元数据直改；结构字段在跑时需 rescope（服务端守卫生效） */
  async updateTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.updateTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'updateTask requires a live team session (disable offline view)' }
    }
    return remote.updateTask(query ?? {})
  }

  /** 面板指派负责队员（CHG-72）：标注语义，执行仍按角色 claim */
  async assignTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.assignTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'assignTask requires a live team session' }
    }
    return remote.assignTask(query ?? {})
  }

  /** 面板登记协作团队（CHG-72，FR-21）：任务 × 团队参与边（主责固定本团队） */
  async participateTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.participateTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'participateTask requires a live team session' }
    }
    return remote.participateTask(query ?? {})
  }

  /** 面板一键重新规划（CHG-73，FR-31）：撤 attempt → 新定义回 ready/backlog → 可选重派 */
  async rescopeTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.rescopeTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'rescopeTask requires a live team session' }
    }
    return remote.rescopeTask(query ?? {})
  }

  /** 面板取消任务（CHG-73/75）：终态；两段确认；下游 leave/cancel/rewire（query 整体透传，含 rewireTo） */
  async cancelTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.cancelTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'cancelTask requires a live team session' }
    }
    return remote.cancelTask(query ?? {})
  }

  /** 面板批量编排（CHG-73/76）：取消/重规划/指派/改优先级，逐条落账；cancel 支持三档下游策略 */
  async batchTaskOp(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.batchTaskOp !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'batchTaskOp requires a live team session' }
    }
    return remote.batchTaskOp(query ?? {})
  }

  /** 面板批量建任务（CHG-76，FR-33）：草稿列表 → 预览影响面 → 两段确认落账（actor=human） */
  async createTasks(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.createTasks !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'createTasks requires a live team session (disable offline view)' }
    }
    return remote.createTasks(query ?? {})
  }

  /** 成员管理（FR-14.2，CHG-48）：suspend/archive/remove/restore（remove 两段确认） */
  async memberOp(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.memberOp(query ?? {})
  }

  /**
   * 门禁裁决（CHG-86 / M2-C，FR-5.1~5.2）：面板任务详情「门禁裁决」区的写路径。
   * review/verify 门强制交叉审查（reviewerMemberId 必填且 ≠ 实现者）；
   * archive 门由 host 落位校验（verdict 只用于再校验一次）；confirm=true 是打回预算超限后的人工放行。
   */
  async reviewTask(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.reviewTask !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'reviewTask requires a live team session (disable offline view)' }
    }
    return remote.reviewTask(query ?? {})
  }

  /** 归档快照（CHG-86 / P0-2）：面板归档回放视图读 `archive/<teamId>/` 下真实落盘内容 */
  async getArchive(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.getArchive !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'getArchive requires a live team session' }
    }
    return remote.getArchive(query ?? {})
  }

  /** 已归档团队清单（CHG-86 / P0-2）：面板「全部团队」入口 */
  async getArchives(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.getArchives !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'getArchives requires a live team session' }
    }
    return remote.getArchives(query ?? {})
  }

  /** 知识提案策展（CHG-86 / P1-9，FR-17.4）：面板「采纳 / 驳回」按钮的写路径（actor=human） */
  async adoptKnowledge(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    if (typeof remote.adoptKnowledge !== 'function') {
      return { status: 'error', code: 'MT_UNAVAILABLE', message: 'adoptKnowledge requires a live team session' }
    }
    return remote.adoptKnowledge(query ?? {})
  }

  /** 解散团队（两段确认） */
  async disband(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.disband(query ?? {})
  }

  /** 角色目录（FR-13.1 数据面：builtin/global/project 三态，origin 标注） */
  async getRoles(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getRoles(query ?? {})
  }

  /** 知识库面板视图（FR-17.5 数据面，M2-0b）：条目 + 待审提案 + 演化时间线 */
  async getKnowledge(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getKnowledge(query ?? {})
  }

  /** 审计（FR-12.5，CHG-49）：账本事件流新→旧分页 */
  async getAudit(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getAudit(query ?? {})
  }

  /** 生效配置（FR-14.3，CHG-49）：来源链 + 生效值 + 告警 */
  async getConfig(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getConfig(query ?? {})
  }

  /** 预设库（CHG-50）：三层只读目录（builtin/global/project） */
  async getPresets(agent: AgentLike, query: Record<string, unknown>) {
    const remote = this.remoteFor(agent)
    if (!remote) return UNAVAILABLE
    return remote.getPresets(query ?? {})
  }
}

// 手动 Remote 标记：gateway 按 method 名发现端点（namespace=myteam，direct invocation）
markRemoteMethods(MyTeamPanelFacade.prototype, ['listTeams', 'getStoreState', 'initStore', 'getProject', 'getRoleDetail', 'saveRole', 'deleteRole', 'getCapabilityCatalog', 'getOfflineBoard', 'getOfflineTaskDetail', 'getOfflineTokens', 'getOfflineAudit', 'getOfflinePresets', 'getBoard', 'getTaskDetail', 'getTokens', 'getInbox', 'getAudit', 'getConfig', 'getPresets', 'getRoles', 'getKnowledge', 'planAction', 'postComment', 'memberOp', 'disband', 'createTask', 'createTasks', 'updateTask', 'assignTask', 'participateTask', 'rescopeTask', 'cancelTask', 'batchTaskOp',
  // CHG-86：门禁裁决 / 归档快照 / 知识提案策展
  'reviewTask', 'getArchive', 'getArchives', 'adoptKnowledge',
  // CHG-87（FR-13.1/FR-16.1）：角色库统一写入口 + 单角色调用
  'roleOp', 'applyRoles',
  // CHG-88（M2-E / FR-16.3）：会话移交
  'handoff',
  // CHG-91（插件团队贡献契约 v1）：插件贡献的只读视图 + 显式重载
  'getContributions', 'reloadContributions'])

/**
 * 顶层装载行 apply（cordis.patch.yml myteam-panel 行）：
 * 构造即完成 cordis provide（Service 基类）+ typertRemote 绑定（Gateway source-mode 发现）。
 */
export function apply(ctx: unknown): void {
  new MyTeamPanelFacade(ctx)
}
export const inject = ['agents', 'agentPresets']
// unwrapExports 纪律（loader lib/index.js:667 `exports.default ?? exports` 会丢弃 named
// inject）：inject 必须以函数属性挂在 default 导出上
Object.assign(apply, { inject })
export default apply
