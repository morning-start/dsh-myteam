/**
 * CHG-186（T155a）：宿主契约（**只有类型，零运行时**）。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────────────────
 * `remote/service.ts` 需要 `MyTeamHost` 的类型，但它原来从 `../host.ts` 取，而
 * `host.ts` 又 import `remote/service.ts` 的实现（`import * as remoteServiceModule`）——
 * 于是形成 `host.ts ⇄ remote/service.ts` 的 type 环（`arch-report` 里唯一那条
 * 「环形依赖 — 仅 type 边: 1」）。类型擦除后运行时无害，但接口耦合会让「谁能依赖谁」
 * 说不清：改一次 `MyTeamHost` 的方法签名，面板远程面与宿主装配层会一起连带。
 *
 * 把接口沉到 core 层后，依赖图变成：
 *   core/host/contract.ts  ←（type）-- remote/service.ts
 *                          ←（type）-- host.ts
 * 环消失，且 core/ 仍然不 import 入口层（`tools/check-architecture.mjs` 的 A1 门禁继续绿）。
 *
 * ── 搬运纪律（T155a）────────────────────────────────────────────────────────────
 *  - **只搬类型声明，一个字段名都不改**：这里逐字复制 `host.ts` 里已有的方法签名
 *    （含参数名与默认值语义），不新增、不重命名、不改窄/改宽。
 *  - **接口里没有实现**：真正的实现仍在 `MyTeamHost`（`host.ts`），它 `implements` 本接口。
 *  - T155b 每搬走一族端点实现，就把该族成员从本接口挪到 `src/host/<族>.ts` 的适配器契约里；
 *    本文件只保留「跨族编排 + 装配」需要的面。
 *  - 本文件只允许 `import type`（含 `typeof` 类型查询）——一旦出现值 import，`core` 就会
 *    在运行时装到上层实现，A1 的「core 可独立装载」前提立刻失效。
 */
import type { TeamService, CommitDraft } from '../service.ts'
import type { PresetCatalog } from '../presets/preset-store.ts'
import type { TokensFile } from '../ledger/token-sidecar.ts'
import type { readArchive } from '../archive/archive-store.ts'
import type { ContributionCatalog } from '../contributions/contract.ts'
import type { GuardOptions } from '../agent/guard.ts'
import type { EvidencePointer } from '../knowledge/evidence-pointer.ts'

/**
 * 行 config（cordis.patch.yml myteam-host.config；全部可省）。
 *
 * CHG-186：**逐字搬自** `host.ts`（原第 200–249 行），一个字段都没改。搬下来的原因：
 * 契约里的 `config` 成员要它的类型，而 `core/**` **不许** import `../host.ts`（A1）。
 * `host.ts` 仍 `export type { MyTeamConfig }` re-export，既有 import 点（`test/t123`）不用动。
 */
export interface MyTeamConfig {
  /** 隐藏宿主内置团队工具（PRD §2.4 hideBuiltinTeamTools），默认 true */
  hideBuiltinTeamTools?: boolean
  /**
   * CHG-102：项目根显式覆盖（绝对路径）。
   *
   * 真实宿主不配这一项——项目根从**会话工作目录**解析（见 `sessionCwdOf`）。只有两种
   * 场景需要它：单测的临时工作区、以及宿主拿不到会话 cwd 时的运维兜底。
   */
  workspaceRoot?: string
  /** 全局角色库目录覆盖（默认 <workspaceRoot>/../.dsh/myteam/roles，CHG-5） */
  globalRolesDir?: string
  /** TeamService effectiveConfig 覆盖（透传 loadEffectiveConfig；缺省走默认配置） */
  configOverride?: unknown
  /**
   * 客户端载体挂载标记（dsh-client-modules 组图约定）：profile 顶层必须存在一个
   * 以「裸包名」命名的 loader 行（exactPackageSpecifier 拒绝含 `/` 的子路径行，
   * dsh-client-modules/lib/index.js:83-89），否则插件的 client.js 不会进入
   * window.__DSH_BOOT__ 图 → 面板/侧栏 UI 整体不可见。顶层载体行传 carrier:true，
   * apply 直接返回（不做工具注册/不做远程挂载——服务仍只在队长 preset 作用域激活，
   * NFR-7.4；也避免 root 侧再 provide 'myteam' 与门面造成网关端点歧义）。
   */
  carrier?: boolean
  /**
   * CHG-71：派单唤醒的节流参数（毫秒）。
   * - team 级：同一团队的两次 dispatch 扫描间隔（合并一次操作产生的多事件）
   * - member 级：同一成员两次 dispatch 唤醒间隔（防止重复打扰空闲成员）
   * 默认 400 / 3000；测试可设 0 关闭节流。
   */
  dispatchTeamCooldownMs?: number
  dispatchMemberCooldownMs?: number
  /**
   * P1-4（docs/21 §6）：`dispose()` 有界结算的超时（毫秒；缺省 5000）。
   *
   * 为什么要有上界：宿主 effect disposer 不 await（`dispose()` 必须同步返回），
   * 成员的 `dispose()` 可能等事件循环 / 子进程退出——没有上界就只能在「卡住宿主」和
   * 「被宿主砍掉且无人知道」之间二选一。超时只告警（`timedOut` 名单进日志），不再等待。
   */
  disposalTimeoutMs?: number
  /**
   * P1-5（docs/21 §6）：单调用护栏的阈值覆盖（`repeatThreshold` / `stuckThreshold` /
   * `stuckTimeoutMs` / `envThreshold` / `emptyTurnThreshold`）。
   *
   * 为什么允许按行配置：不同档位/不同团队的「打转」成本不同（纯文档团队应更早提醒，
   * 长任务团队需要更宽的时间窗）。非法值由 `guard.ts` 归一回落默认——配置写错不得
   * 静默变成「永不触发」，也不得让护栏自己抛错打断成员调用。
   */
  guardOptions?: GuardOptions
}

/**
 * 知识库面板视图（FR-17.5，M2-0b）：纯读投影。
 *
 * CHG-186：**逐字搬自** `host.ts` 里 `buildKnowledgeView()` 的返回类型（原第 558–562 行）。
 * 搬下来的原因同上：契约要声明 `knowledgeView()` 的显式返回类型，而 `core/**` 不许
 * import 入口层。`buildKnowledgeView` 现在标注 `: KnowledgeView`，两边不可能再漂移。
 */
export interface KnowledgeView {
  entries: Array<{
    id: string
    title: string
    tags: string[]
    audience: string[]
    evidence: string[]
    evidenceRefs: EvidencePointer[]
    proofCount: number
    staleSince?: string
    unverified: boolean
    core: boolean
    contributor?: string
    updated: string
    body: string
  }>
  proposals: Array<{
    teamId: string
    draftId: string
    title: string
    tags: string[]
    relation: string
    targetId?: string
    proposedBy: string
    at: string
    evidence: string[]
    evidenceRefs: EvidencePointer[]
  }>
  timeline: Record<string, Array<{ teamId: string; ts: string; relation: string; diff: string; actor: string }>>
}

/**
 * `remote/service.ts` 用到的宿主面（**只列被用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this.host\." src/remote/service.ts` 的 28 个成员 + 两个只读属性
 * （`config` / `workspaceRoot`）。面板远程面只读投影、写一律经 `executeLeadTool` 同一条
 * 单写者管线，所以它需要的正好是「TeamService 取用 + 队长工具分发 + 几个只读视图」。
 */
export interface MyTeamHostContract {
  /** 行 config（构造时定型；`TeamService` 的 configOverride 来源） */
  readonly config: MyTeamConfig
  /**
   * 项目根（CHG-102 的 P0 修复）：会话工作目录 → 行 config 显式 → 宿主 workspace
   * （过 profile 拒绝规则）→ 进程 cwd。缓存，一个 host 实例 = 一个队长 preset 作用域。
   */
  readonly workspaceRoot: string
  /** R41-③：面板设置页读「实际生效」的内置工具隐藏状态（只读快照，initialize 后恒有值） */
  readonly builtinToolsHide: { enabled: boolean; restricted: boolean; configured: string[]; effective: string[] }

  /** 默认团队 id（M1 单活跃团队口径：状态目录下唯一团队 / 最近修改的账本） */
  defaultTeamId(): string

  /** 按 teamId 取 TeamService（惰性创建 + 冷启动重放恢复 + 首次 bootstrap） */
  service(teamId: string): TeamService

  /** 统一提交入口：成功后触发唤醒（不阻塞提交本身） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>

  /** Lead 工具 execute 分发（全部走 TeamService 单写者管线；`actor:'human'` 记人工） */
  executeLeadTool(
    name: string,
    args: Record<string, unknown>,
    exec?: { agent?: any; actor?: 'lead' | 'human'; enforceTier?: boolean },
  ): Record<string, unknown> | Promise<Record<string, unknown>>

  /** 成员管理（FR-14.2，CHG-48）：suspend/archive/remove/restore/steer；remove 两段确认 */
  memberOp(
    teamId: string,
    memberId: string,
    op: string,
    confirm: boolean,
    extra?: { content?: unknown; taskId?: unknown },
  ): Record<string, unknown>

  /** 角色库统一写入口（CHG-87，docs/04 §2 承诺的 `roleOp(op, payload)`） */
  roleOp(op: string, payload?: Record<string, unknown>): Record<string, unknown>

  /** 面板角色 tab 只读目录（listRoleCatalog 的脱敏投影：不含 systemPrompt 全文） */
  roleCatalogView(): Array<{
    origin: string
    id: string
    name: string
    description: string
    isCaptain: boolean
    interestWords: string[]
    skills: string[]
    mcpAllowlist: string[]
    model?: { provider: string; model: string }
    version: number
  }>

  /** 知识库面板视图（FR-17.5 数据面）：条目 + 待审提案 + 演化时间线（读投影，不进模型上下文） */
  knowledgeView(): KnowledgeView

  /** 预设库面板视图（CHG-50）：三层只读目录（builtin/global/project），不写盘 */
  presetCatalogView(): PresetCatalog

  /** CHG-91：插件贡献的只读快照（当前生效的那份目录） */
  contributionSnapshot(): ContributionCatalog

  /** CHG-91：显式重载插件贡献（插件装/卸后不必重启宿主） */
  reloadContributions(): ContributionCatalog

  /** CHG-139a（docs/19 §M6）：依赖图谱只读端点（面板「依赖图」视图） */
  getTaskGraphTool(args?: Record<string, unknown>): Record<string, unknown>

  /** CHG-139a（docs/19 §M3）：可复用技能清单只读端点（面板「技能」视图） */
  listSkillsTool(args?: Record<string, unknown>): Record<string, unknown>

  /** CHG-139b（docs/19 §5.2）：复制团队定义 → 新草稿（面板「复制团队」按钮） */
  copyTeamTool(args?: Record<string, unknown>): Promise<Record<string, unknown>>

  /** CHG-139b（docs/19 §5.3）：发布团队定义到全局库（**人类专属**；两段确认） */
  publishTeamTool(args?: Record<string, unknown>): Promise<Record<string, unknown>>

  /** CHG-139c（docs/20 §8）：导出团队快照（只读团队；写 history/exports/） */
  exportTeamTool(args?: Record<string, unknown>): Record<string, unknown>

  /** CHG-139c（docs/20 §8）：导入团队快照（新 id，永不覆盖） */
  importTeamTool(args?: Record<string, unknown>): Promise<Record<string, unknown>>

  /** CHG-139d（docs/20 §5.4）：创建技能（**只写 myteam 队长预设**，不污染其它预设） */
  createSkillTool(args?: Record<string, unknown>): Record<string, unknown>

  /** CHG-139d（docs/20 §5.4）：创建工具（**声明式**，不执行第三方代码） */
  createToolTool(args?: Record<string, unknown>): Record<string, unknown>

  /** CHG-120（M2-D ② / FR-16.4②）：按 `session:<id>` 只读读一页历史 */
  readSessionHistory(args?: Record<string, unknown>): Promise<Record<string, unknown>>

  /** CHG-88（M2-E / FR-16.3）：会话移交（摘要 → 新团队预设会话） */
  handoffTeam(args?: Record<string, unknown>): Promise<Record<string, unknown>>

  /** 设置页保存配置（CHG-117 / docs/18 §7）：校验先于写 + 原子写 + 两段确认 */
  saveTeamConfig(teamId: string, args: Record<string, unknown>): Record<string, unknown>

  /** 恢复团队默认配置（CHG-57 工具面 / CHG-117 面板面）：删团队层文件并重建缓存 */
  resetTeamConfig(teamId: string, args: Record<string, unknown>): Record<string, unknown>

  /** 读取某个团队的归档快照（只读；未归档 → `archive: null`） */
  archiveView(teamId?: string): { teamId: string; archive: ReturnType<typeof readArchive>; root: string; rootDisplay: string }

  /** 已归档团队 id 列表（面板「全部团队」入口；只读目录名） */
  archiveList(): { root: string; rootDisplay: string; teams: string[] }

  /** token 侧车四桶 + 命中率（CHG-86 改走增量同步） */
  syncTokens(teamId: string): TokensFile
}
