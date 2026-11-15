/**
 * dsh-plugin-myteam — host 入口（T7 收口 + 官方插件生命周期对齐修订）。
 *
 * 装载形态（ADR-005 修订）：preset 组合内的 host 行（cordis.patch.yml myteam-host）。
 * 导出采用 host-plugin.md 规定的 apply 函数形态：
 *   export function apply(ctx, config)  +  export const inject（必需服务声明）
 * 必需服务缺失时插件保持未激活（而不是激活后抛错）；可选服务（tokenMeter/
 * sessionProjections/typert）通过 svc() 防御性读取，缺失只降级不致命。
 *
 * 职责：
 *   ① 目录初始化（`.dsh-myteam/` 项目级存储 + 目录内 .gitignore；CHG-102 收口到
 *      `core/workspace/layout.ts`，项目根来自**会话工作目录**而不是 DSH profile）
 *   ② TeamService 管理（按 teamId 惰性创建 + 冷启动重放恢复）
 *   ③ Lead 工具 17 个注册（preset scope = 队长会话可见，ADR-003；+adopt_knowledge、+create_role/update_role）
 *   ④ 成员 spawn：agents.create 直连 + setup 作用域（9 成员工具/restrict/persona/skills）
 *   ⑤ 唤醒管线：账本事件 → wakeDecisionsFor → agent.followup
 *   ⑥ token 侧车：tokenUsage 投影 → tokens.json
 *
 * 零依赖边界（PRD §2/§9）：绝不 import/调用 agentTeams 服务与内置团队工具；
 * 宿主服务白名单见 PRD §9（agents/subagents/tools/typert/tokenMeter/sessionProjections）。
 */
import { join, isAbsolute, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { ensureWorkplaceDirs, ensureGitignoreManagedBlock } from './host-workspace.ts'
/* CHG-174：**唯一写盘出口**。host 不再直接 `writeFileSync` —— 那是「写一半」的唯一来源：
 * 没有 fsync 屏障、临时文件名固定、不拒符号链接。全部经 `writeTextAtomic`（八步写序），
 * 门禁 `tools/check-architecture.mjs` 的 A2 规则守着这条边界。 */
import { writeTextAtomic, runWithRollback, snapshotFor } from './core/fs/write-log.ts'
import { resolveProjectRoot, storeLayout, teamLedgerPath as teamLedgerPathOf, displayPath, STORE_DIR, tokenSidecarPath, legacyTokenSidecarPath } from './core/workspace/layout.ts'
// CHG-103：作用域契约（全局 vs 项目级）——角色两级都可用，任务/历史/状态只能项目级
import { normalizeScope } from './core/workspace/scope.ts'
import { TeamService, bootstrapTeam, type CommitDraft } from './core/service.ts'
/* CHG-186（T155a）：宿主契约下沉 `core/host/contract.ts` —— 解 `host.ts ⇄ remote/service.ts`
 * 的 type 环（arch-report 里唯一那条）。这里只 `import type`（擦除后无运行时依赖、无装载环）；
 * `MyTeamConfig` 仍从本文件 re-export，既有 import 点（如 `test/t123`）一个都不用改。 */
import type { KnowledgeView, MyTeamConfig, MyTeamHostContract } from './core/host/contract.ts'
export type { MyTeamConfig } from './core/host/contract.ts'
/* CHG-186（T155b）：端点族适配层。本文件只留**装配 + 分发**（switch 里一行转发），
 * 族实现落在 `src/host/<族>.ts`——入口层只减不增（A6 棘轮）。 */
import { createMembersHandlers, guardRule } from './host/members.ts'
/* CHG-187（FR-32 支柱一）：成员派生树的纯规则（深度 / 子数 / 级联顺序） */
import { releaseOrder, rosterOf } from './core/members/hierarchy.ts'
import { createMemberTaskHandlers, createTasksHandlers } from './host/tasks.ts'
import { createPlanHandlers } from './host/plan.ts'
import { createRolesHandlers } from './host/roles.ts'
import { createTeamsHandlers } from './host/teams.ts'
import { createKnowledgeHandlers, createMemberKnowledgeHandlers } from './host/knowledge.ts'
import { createQueryHandlers } from './host/query.ts'
/* CHG-200：队长读面适配层（只读 / 不含 attemptId / 限界读，见 `src/host/read.ts` 文件头） */
import { createReadHandlers } from './host/read.ts'
import { leadToolDefs, memberToolDefs, type ToolDef } from './tools/defs.ts'
// CHG-148（P1-6）：按工具名取完整结果契约（jsonOutput 双声明），不再用统一空 schema
import { outputForTool } from './core/tools/output-contract.ts'
import { wakeDecisionsFor, changeSince, type WakeDecision } from './core/scheduler/wake.ts'
import { TERMINAL_STATES, downstreamOf } from './core/scheduler/state.ts'
/* A9（报告 KI-5 / CHG-163 冷启动重连）：只读折叠口径。
 * 为什么不用 `this.service(teamId).projectionSnapshot`：`service()` 构造 TeamService 时会
 * `bootstrapTeam` 落 `rules.version.adopted`——重连就成了**写账本**，违反「重连不改账本」不变量。
 * `readOfflineTeam` + `foldTolerant` 只读文件、坏行/坏事件各自跳过，正好是重连需要的容错面。 */
import { foldTolerant, isSafeTeamId, readOfflineTeam, readTokensSidecar } from './core/index/offline-view.ts'
import { diffTaskInput } from './core/tasks/diff.ts'
import { treeFieldsOf, HOST_TEAM_TOOLS_TO_HIDE, type MemberInstance } from './core/members/member-setup.ts'
import { memoryDirFor, auditMemoryContent, type MemoryFinding } from './core/members/memory.ts'
import { copyToProject, listRoleCatalog, readGlobalRole, readProjectRole, saveGlobalRole, writeProjectRole, assertValidRole, deleteProjectRoleSafe, type RoleStorePaths } from './core/roles/role-store.ts'
// CHG-87（docs/04 §2 承诺的 roleOp 端点）：host 与面板共用同一份实现
import { roleOp as roleOpImpl } from './core/roles/role-ops.ts'
import type { RoleDefinition } from './core/roles/builtin-roles.ts'
import { CAPTAIN_SKILLS } from './core/roles/captain-skills.ts'
import { readPresetCatalog, readProjectPreset, writeProjectPreset, deleteProjectPreset, validatePresetDefinition, BUILTIN_PRESET_IDS, type PresetCatalog } from './core/presets/preset-store.ts'
import { isStructurallyValidConfig, loadEffectiveConfig, readProjectConfigRaw, teamConfigPath, writeTeamConfigRaw } from './core/config/team-config.ts'
import { listKnowledge, knowledgeDirOf } from './core/knowledge/knowledge.ts'
import { zeroBuckets, dayKeyOf, accumulate, emptyTokensFile, type TokensFile, type MemberMeterState } from './core/ledger/token-sidecar.ts'
// CHG-86（P0-2）：归档落盘（disband 时写快照；面板归档视图读快照）
import { readArchive, listArchives, archiveRootOf } from './core/archive/archive-store.ts'
// CHG-87（M2-C 剩余，FR-5.3/FR-5.4）：command 门禁 + scope 完成审计
import { truncateOutput } from './core/gates/command-gate.ts'
/* P1-5 接线（docs/21 §6，CHG-147 的纯函数模块）：成员单调用护栏四类检测 */
import {
  createGuardState,
  guardReminder,
  observeCall,
  observeEmptyTurn,
  GUARD_OUTPUT_TAIL_LIMIT,
  GUARD_TURN_BOUNDARY_TOOLS,
  type GuardCall,
  type GuardOptions,
  type GuardState,
  type GuardVerdict,
} from './core/agent/guard.ts'
/* CHG-200：回合边界常量已下沉 `core/agent/guard.ts`（A6 棘轮：入口层只减不增）；
 * 对外导出面不变——`test/t123` 等既有 import 点一个都不用改。 */
export { GUARD_TURN_BOUNDARY_TOOLS } from './core/agent/guard.ts'
import type { ScopeAudit } from './core/gates/scope-audit.ts'
// CHG-87（M2-D 剩余，FR-16.4③）：证据指针投影（task/file/session 三类；解析原语已随任务族搬到 src/host/tasks.ts）
import { evidenceRefsOf } from './core/knowledge/evidence-pointer.ts'
// CHG-87（FR-16.1 单角色调用）：sessionDefaults 跨重启恢复 + 提示词 section
import { readSessionDefaults, writeSessionDefaults, buildRolePromptSection } from './core/roles/session-defaults.ts'
// CHG-88（M2-E / FR-16.3）：会话移交（摘要提取 + 新团队预设会话注入）
import {
  buildHandoffPrompt,
  buildHandoffSummary,
  resolveSessionHandoffCapability,
  runHandoff,
  TEAM_AGENT_PRESET_ID,
} from './core/host/session-handoff.ts'
// CHG-120（M2-D ② / FR-16.4②）：会话考古（按 session:<id> 只读读一页历史）
import {
  buildSessionPageRequest,
  resolveSessionHistoryCapability,
  summarizeSessionRecords,
  type SessionRecordView,
} from './core/host/session-archaeology.ts'
import { recoveryAction, reconcileProvisioning, type ProvisioningMember, type ProvisioningProbeResult, type ProvisioningSettlement } from './core/scheduler/recovery.ts'
/* P1-1/P1-2 接线（docs/21 §6，CHG-144 的纯函数模块）：产物新鲜度指纹 + 交付判定三级信号 */
import type { ArtifactBaseline, ArtifactStat } from './core/gates/artifact-freshness.ts'
import type { DeliveryJudgement } from './core/gates/delivery-verdict.ts'
/* P1-4（docs/21 §6）：dispose 有界结算（准入截止 + allSettled + 超时 + 预期取消识别） */
import {
  createAdmissionGate,
  isCancellation,
  settleWithin,
  DEFAULT_DISPOSAL_TIMEOUT_MS,
  type AdmissionGate,
  type AdmissionOperation,
} from './core/lifecycle.ts'
/* CHG-135（docs/20 §5.2）：成员卡（子代理 / 会话依附角色的落盘事实）已随 CHG-189 下沉
 * `core/members/member-card.ts` 的调用点 → `core/members/spawn-lifecycle.ts`。 */
/* CHG-189（T159a）：spawn 生命周期状态机（行为边界下沉——私有方法体搬进 core/members/**） */
import { createSpawnLifecycle } from './core/members/spawn-lifecycle.ts'
/* CHG-190（T159b）：门禁执行（行为边界下沉——审查 / 验证 / 交付裁决 / 归档门禁 / 自动推进的私有方法体搬进 core/gates/**） */
import { createGateExecution } from './core/gates/gate-execution.ts'
/* CHG-191（T159c）：批量编排（行为边界下沉——批量操作 / 批量建任务 / 计划拆分物化搬进 core/tasks/**） */
import { createBatchOrchestration } from './core/tasks/batch-orchestration.ts'
/* CHG-137/138（docs/19 §3）：工具权限档位（单一事实源 + 运行时门禁） */
import { canCall, tierOf, type ToolCaller } from './core/tools/tool-tiers.ts'
/* CHG-124（docs/19 §M6）：任务依赖图谱纯函数（Kahn 分层 + 环检测） */
import { buildTaskGraph } from './core/scheduler/task-graph.ts'
import { readWorkspaceIndex, resolveMyteamHome, globalStoreLayout } from './core/index/team-index.ts'
// CHG-91（插件团队贡献契约 v1）：装载第三方插件贡献的角色与团队模板
import { loadContributions } from './core/contributions/parse.ts'
import { contributionsRoot } from './core/contributions/discover.ts'
import { CONTRIBUTION_CODES, emptyContributionCatalog, type ContributionCatalog } from './core/contributions/contract.ts'
// CHG-93（FR-18 职责③ F8）：团队章程注入队长 system prompt
import { readTeamCharter, TEAM_CHARTER_SECTION, TEAM_CHARTER_VARIABLE } from './core/host/team-charter.ts'
import { roleUsage } from './core/index/offline-view.ts'

/* 宿主编译辅助（T0 实证：register 前必须编译成完整 JSON Schema）。
 * 导出仅供单测（t7b 编译产物审计）；运行时语义不变。 */
export function compileParameters(tool: ToolDef): ToolDef {
  // strip-only 环境下无宿主 parameterSchemaSpecToJsonSchema；本编译器实现宿主
  // spec 语义的等价子集：属性级 required:true 收集 → 顶层 required 数组（递归）。
  // 修订：递归必须同时下钻 items——items 内的属性级 required:true 若残留，
  // 产出的布尔 required 不是宿主 schema 子集关键字（assertSupportedJsonSchema
  // 报 "not a supported keyword"），如 EVIDENCE_PARAM.commands.items、rosterItem。
  const compile = (spec: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...spec }
    if (out.properties && typeof out.properties === 'object') {
      const required: string[] = []
      const props: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(out.properties as Record<string, Record<string, unknown>>)) {
        if (value.required === true) required.push(key)
        const rest = { ...value }
        delete rest.required
        props[key] = compile(rest)
      }
      out.properties = props
      if (required.length > 0) out.required = required
    }
    if (out.items && typeof out.items === 'object') {
      out.items = compile(out.items as Record<string, unknown>)
    }
    return out
  }
  return { ...tool, parameters: compile(tool.parameters as unknown as Record<string, unknown>) as ToolDef['parameters'] }
}

export interface HostRuntime {
  agents?: any          // ctx.agents（成员创建基座）
  subagents?: any       // ctx.subagents（通用消息投递）
  tools?: any           // ctx.tools（工具注册 + restrict）
  typert?: any          // ctx.typert（可选：面板 Remote 发现）
  tokenMeter?: any      // ctx.tokenMeter（计量读，可选）
  sessionProjections?: any
  /** CHG-87（FR-5.3）：ctx.subprocess —— command 门禁执行通道（缺失 → MT_UNAVAILABLE，不静默降级） */
  subprocess?: any
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void }
  workspace?: { root: string }
  /** CHG-102：会话工作目录服务（项目根的权威来源；缺失则回退 agent.session.cwd） */
  workingDirectory?: { get?: (session: unknown) => string | undefined }
}

/**
 * 会话工作目录（CHG-102）：项目根的**权威来源**。
 *
 * CHG-202：实现下沉到 `src/host/session-cwd.ts`（A6 入口层棘轮：host.ts 只减不增）。
 * 这里 import 后原样 re-export，调用点（`TeamHost.workspaceRoot`）与外部消费者都不用改。
 */
import { sessionCwdOf } from './host/session-cwd.ts'
export { sessionCwdOf }

/* CHG-186：行 config 的类型 `MyTeamConfig` 已下沉到 `core/host/contract.ts`（见文件头 import）——
 * 契约里的 `config` 成员要用它，而 `core/**` 不许 import 入口层（A1 门禁）。本文件 re-export。 */

/* ── 纯函数域（无 ctx 依赖，便于单测 J1）────────────────────────── */

/** 防御属性读取：普通对象直读（测试注入路径不受影响）；Cordis Context 代理对
 *  既非自有属性、又非已提供服务的属性会抛 "cannot get property ... without
 *  inject"（cordis lib/index.js L676 守卫）→ 捕获后静默 undefined。 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function safeRead(obj: unknown, prop: string): any {
  try {
    return (obj as Record<string, any> | null | undefined)?.[prop]
  } catch {
    return undefined
  }
}

/**
 * FIX-14（KI-2）：`agents.create` 的返回形状未实证——真实宿主是 `Promise<AgentHandle>`，
 * 单测桩是 handle 本体。两阶段 spawn 必须「先拿到 handle 再结算 active」，
 * 所以这个判定只写一处，避免两处各判一遍然后行为分叉。
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export function resolveTeamLedgerPath(workspaceRoot: string, teamId: string): string {
  return teamLedgerPathOf(workspaceRoot, teamId)
}

/** CHG-71：可能改变「有哪些任务可领」的事件——提交后触发一次派单扫描 */
const DISPATCH_TRIGGER_TYPES = new Set(['task.created', 'task.completed', 'task.rescoped', 'task.updated', 'task.gate.result', 'task.cancelled'])

/** FIX-17：团队名 → 合法 teamId（小写、非字母数字折叠为连字符、去首尾连字符；空则回退 'team'） */
/**
 * 团队名 → teamId slug。纯 ASCII 名直接 slug；**全中文/非 ASCII 名**用名字哈希派生稳定 id
 * （CHG-70：旧实现回退成固定 'team'，两个中文团队会撞同一个账本目录）。
 * 同名 → 同 id（续提/澄清计数语义不变）；不同名 → 不同 id。
 */
export function slugifyTeamName(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (slug) return slug
  const digest = createHash('sha1').update(String(name ?? '')).digest('hex').slice(0, 6)
  return `team-${digest}`
}

/** 账本 JSONL 读取（容错：坏行跳过并返回警告，不让单条坏行炸掉读侧） */
export function readLedgerEvents(ledgerPath: string): { events: Record<string, any>[]; warnings: string[] } {
  const warnings: string[] = []
  if (!existsSync(ledgerPath)) return { events: [], warnings }
  const raw = readFileSync(ledgerPath, 'utf8')
  const events: Record<string, any>[] = []
  raw.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      events.push(JSON.parse(trimmed))
    } catch (e) {
      warnings.push(`ledger line ${i + 1} unparsable: ${String(e)}`)
    }
  })
  return { events, warnings }
}

/* ── P1-1 / P1-2 接线（docs/21 §6）：产物基线 + 交付判定 ───────────────── */

/**
 * P1-2 交付判定的正文长度下限（按任务类型）。
 *
 * 为什么按类型分档：实现类（dev）的产出主要在文件里，正文只需要简短汇报；
 * 需求 / 验收类（prd/qa）的交付物**就是文字结论**，短正文必然信息不足。
 * 为什么导出常量：面板、提示词、文档要引用同一组数字——各写一份必然漂移。
 */
const DELIVERABLE_MIN_LENGTH: Readonly<Record<'dev' | 'qa' | 'prd', number>> = {
  dev: 60,
  qa: 250,
  prd: 400,
}

/**
 * 任务类型 → 正文长度下限。未知类型按 `dev`（实现类最常见、下限最宽松）：
 * 挡住「空话冒充交付」靠的是下限本身，不是分档的精度。
 */
export function deliverableMinLength(taskType?: string): number {
  const type = String(taskType ?? '').trim().toLowerCase()
  if (type.length === 0) return DELIVERABLE_MIN_LENGTH.dev
  if (type.includes('qa') || type.includes('test') || type.includes('accept')) return DELIVERABLE_MIN_LENGTH.qa
  if (type.includes('prd') || type.includes('req') || type.includes('design') || type.includes('doc')) return DELIVERABLE_MIN_LENGTH.prd
  return DELIVERABLE_MIN_LENGTH.dev
}

/**
 * 拍基线时文件**还不存在**的哨兵指纹。
 *
 * 为什么需要它：产物通常由成员在本阶段**创建**，阶段起点上它并不存在。若按
 * `artifactBaseline` 的「读不到就不写键」处理，`artifactIsStale` 会把「本阶段新建的文件」
 * 判成陈旧（缺键 = 不可判 = 不认交付）——正常交付反而全被拒。
 * 哨兵与任何真实指纹（`size:mtimeMs`）都不相等，于是：后来出现 = 指纹变了 = 新鲜；
 * 一直没出现 = 当前读不到 = 陈旧。两种情形都判对。
 */
export const ABSENT_PATH_FINGERPRINT = 'absent'

/**
 * 产物内容读取上限（字符）：交付判定只需要「非空 + 够长」，不需要把整个大文件读进内存
 * （产物可能是几 MB 的构建日志；判定在 gate 路径上，不该因为读文件拖慢卸载 / 裁决）。
 */
const ARTIFACT_TEXT_READ_LIMIT = 512 * 1024

/** 产物基线落盘结构（`.dsh-myteam/state/artifacts/<teamId>/<taskId>.json`） */
export interface ArtifactBaselineRecord {
  version: 1
  teamId: string
  taskId: string
  /** **首次**拍基线的时间（ISO）：重拍只补缺失键，这个时间不被覆盖 */
  capturedAt: string
  /** 路径 → 指纹（`size:mtimeMs`，或 `ABSENT_PATH_FINGERPRINT`） */
  baseline: ArtifactBaseline
}

/** 读产物基线记录（缺失 / 坏 JSON → undefined：调用方据此判「这个任务没拍过基线」） */
export function readArtifactBaselineRecord(filePath: string): ArtifactBaselineRecord | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ArtifactBaselineRecord> | null
    if (!parsed || typeof parsed !== 'object' || !parsed.baseline || typeof parsed.baseline !== 'object') return undefined
    return {
      version: 1,
      teamId: String(parsed.teamId ?? ''),
      taskId: String(parsed.taskId ?? ''),
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : new Date(0).toISOString(),
      baseline: parsed.baseline as ArtifactBaseline,
    }
  } catch {
    // 坏记录当「没拍过」：宁可走兼容分支（有告警留痕），也不因为一条坏 JSON 让 archive 门炸掉
    return undefined
  }
}

/** 写产物基线记录（父目录自动创建；返回落盘路径） */
export function writeArtifactBaselineRecord(filePath: string, record: ArtifactBaselineRecord): string {
  writeTextAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`, { ensureParent: true })
  return filePath
}

/**
 * 从 `deliverableSpec` 抽取候选产物路径：`path` + `candidates`（若存在）+ 调用方追加的申报路径。
 *
 * `candidates` 两种形态都收（字符串数组 / `{path}` 数组）：任务定义由模型产出，
 * 形态不总是规范——一条路径解析失败不该让整条交付判定失效。
 */
export function deliverablePathsOf(spec: unknown, extra: readonly string[] = []): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0) out.push(trimmed)
      return
    }
    if (value && typeof value === 'object') {
      const candidate = (value as { path?: unknown }).path
      if (typeof candidate === 'string' && candidate.trim().length > 0) out.push(candidate.trim())
    }
  }
  if (spec && typeof spec === 'object') {
    push((spec as { path?: unknown }).path)
    const candidates = (spec as { candidates?: unknown }).candidates
    if (Array.isArray(candidates)) for (const candidate of candidates) push(candidate)
  }
  for (const value of extra) push(value)
  return [...new Set(out)]
}

/* ── P1-5 接线（docs/21 §6）：成员单调用护栏 ─────────────────────────── */

/**
 * `no-active-peer` 短路的可执行文案（必须给动作：先看名册，再唤醒，最后才等）。
 * CHG-200：读面按**调用者**分叉——成员 `myteam_list_tasks` / 队长 `myteam_read_board`
 * （两个作用域零重名，CHG-86 口径）；提示词同时给出两条，模型按自己的工具面取用。
 */
export const NO_ACTIVE_PEER_HINT = '先看板与名册（成员 myteam_list_tasks / 队长 myteam_read_board，myteam_get_team 看名册），再 myteam_message 唤醒，然后才等'

/**
 * 稳定 JSON（递归按 key 排序）：护栏的签名 = 「同一条命令」的唯一身份。
 *
 * 为什么不用裸 `JSON.stringify`：对象键序在 JS 里不稳定（模型每次生成参数顺序可能不同），
 * 键序不同就会把「同一条命令」算成两条 —— 复读/挂死/环境三类判据会**整体失效**。
 * 解析失败（循环引用 / 不可序列化）退化为 `String(value)`：签名宁可粗糙也不抛错
 * （抛错 = 成员工具调用整体失败，代价远大于漏杀一次）。
 */
export function stableGuardJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node
    if (seen.has(node as object)) return '[circular]'
    seen.add(node as object)
    if (Array.isArray(node)) return node.map(walk)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(node as Record<string, unknown>).sort((a, b) => a.localeCompare(b))) {
      out[key] = walk((node as Record<string, unknown>)[key])
    }
    return out
  }
  try {
    return JSON.stringify(walk(value)) ?? ''
  } catch {
    return String(value)
  }
}

/** 输出指纹（`stuck` 判据：两次输出一字不差才算挂死；只取前 32 位十六进制，账本不需要全量） */
export function guardOutputHash(output: string): string {
  return createHash('sha256').update(String(output ?? '')).digest('hex').slice(0, 32)
}

/**
 * 从成员工具结果里取「真实退出码」（复用 `CommandRunResult.exitCode` 的形状）。
 *
 * 为什么失败要映射成 1：成员通道里没有任何工具直接跑 shell（命令执行在 verify 门 / 成员自己的
 * bash 里），但 `status:'error'` 与「命令以非 0 退出」在护栏看来是同一类事实——
 * **这条调用失败了**。环境不可用判据问的正是「同一环境特征是否连续导致失败」；
 * 结果里自带 `exitCode` 时以它为准（verify 门会带真实值）。
 * 成功映射成 0：只有真实成功才解除 `env-unavailable` 的 latch（见 guard.ts 注释）。
 */
export function guardExitCodeOf(result: Record<string, unknown>): number | null | undefined {
  const raw = result?.exitCode
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  if (raw === null) return null
  if (result?.status === 'error') return 1
  return 0
}

/**
 * 构造一次护栏观测（`GuardCall`）。
 *
 * `output` 只保留有界尾部：它只用于 `env-unavailable` 的特征匹配，**不进状态、不落账**
 * （账本只存 `outputHash`）——完整输出可能几 MB。
 */
export function guardCallOf(name: string, args: Record<string, unknown>, result: Record<string, unknown>, at: number): GuardCall {
  const output = truncateOutput(stableGuardJson(result), GUARD_OUTPUT_TAIL_LIMIT)
  return {
    tool: String(name ?? ''),
    // 签名 = 工具名 + 规范化参数（同签名 = 「同一条命令再来一遍」）
    signature: `${String(name ?? '')}|${stableGuardJson(args ?? {})}`,
    outputHash: guardOutputHash(output),
    exitCode: guardExitCodeOf(result),
    at,
    output,
  }
}

/** 护栏判定的对外形状（附在成员工具结果里；`kind` 是枚举锚点，`hint` 必须可执行） */
export function guardPayloadOf(verdict: GuardVerdict): Record<string, unknown> {
  return {
    kind: verdict.kind,
    message: verdict.message,
    hint: verdict.hint,
    ...(verdict.signature ? { signature: verdict.signature } : {}),
    ...(typeof verdict.count === 'number' ? { count: verdict.count } : {}),
  }
}

/** 从账本统计 plan.clarify 事件数（FR-1.6 硬终止计数，T7 防统计盲区） */
function countClarifyRoundsIn(ledgerPath: string): number {
  try {
    return readLedgerEvents(ledgerPath).events.filter((e) => e.type === 'plan.clarify').length
  } catch {
    return 0
  }
}

/** 从账本找 knowledge.proposed 草稿（FR-17.4 策展门） */
export function findKnowledgeProposal(ledgerPath: string, draftId: string): Record<string, any> | null {
  try {
    return readLedgerEvents(ledgerPath).events
      .filter((e) => e.type === 'knowledge.proposed' && e.payload?.draftId === draftId)
      .pop() ?? null
  } catch {
    return null
  }
}

/**
 * 知识库面板视图（FR-17.5，M2-0b）：纯读投影。
 * - entries：config/knowledge/ 全量条目（共享库，含 badge 面 core/unverified/stale + proofCount + 演化归属）
 * - proposals：各团队账本 knowledge.proposed 减去已裁决（knowledge.adopted 同 draftId，含 rejected）→ 待审队列
 * - timeline：knowledge.revised 按 entryId 归组 → 条目详情演化时间线（Hindsight 溯源思想的账本版）
 */
export function buildKnowledgeView(workspaceRoot: string): KnowledgeView {
  const kbDir = knowledgeDirOf(workspaceRoot)
  const entries = listKnowledge(kbDir).map((e) => ({
    id: e.id,
    title: e.title,
    tags: e.tags,
    audience: e.audience ?? [],
    evidence: e.evidence,
    // CHG-87（FR-16.4③）：三类证据指针的类型化视图（task/file/session）——面板按 kind 上色
    evidenceRefs: evidenceRefsOf(e.evidence),
    proofCount: e.proofCount,
    staleSince: e.staleSince,
    unverified: e.unverified,
    core: e.core,
    contributor: e.contributor,
    updated: e.updated,
    body: e.body,
  }))
  const proposals: Array<{ teamId: string; draftId: string; title: string; tags: string[]; relation: string; targetId?: string; proposedBy: string; at: string; evidence: string[]; evidenceRefs: ReturnType<typeof evidenceRefsOf> }> = []
  const timeline: Record<string, Array<{ teamId: string; ts: string; relation: string; diff: string; actor: string }>> = {}
  const teamsDir = storeLayout(workspaceRoot).tasks
  try {
    if (existsSync(teamsDir)) {
      for (const teamId of readdirSync(teamsDir)) {
        const ledgerPath = join(teamsDir, teamId, 'ledger.jsonl')
        if (!existsSync(ledgerPath)) continue
        const events = readLedgerEvents(ledgerPath).events
        const decided = new Set(events.filter((e) => e.type === 'knowledge.adopted').map((e) => String(e.payload?.draftId ?? '')))
        for (const e of events) {
          if (e.type === 'knowledge.proposed') {
            const draftId = String(e.payload?.draftId ?? '')
            if (!draftId || decided.has(draftId)) continue
            const draft = (e.payload?.draft ?? {}) as Record<string, any>
            proposals.push({
              teamId,
              draftId,
              title: String(draft.title ?? ''),
              tags: Array.isArray(draft.tags) ? draft.tags.map(String) : [],
              relation: String(draft.relation ?? 'new'),
              ...(draft.targetId ? { targetId: String(draft.targetId) } : {}),
              proposedBy: String(e.payload?.proposedBy ?? 'unknown'),
              at: new Date(Number(e.ts) || 0).toISOString(),
              evidence: Array.isArray(draft.evidence) ? draft.evidence.map(String) : [],
              // CHG-87（FR-16.4③）：提案证据同样按 kind 类型化（`session:` 指针在这里第一次可见）
              evidenceRefs: evidenceRefsOf(Array.isArray(draft.evidence) ? draft.evidence.map(String) : draft.evidence ? [String(draft.evidence)] : []),
            })
          } else if (e.type === 'knowledge.revised') {
            const entryId = String(e.payload?.entryId ?? '')
            if (!entryId) continue
            const list = timeline[entryId] ??= []
            list.push({
              teamId,
              ts: new Date(Number(e.ts) || 0).toISOString(),
              relation: String(e.payload?.relation ?? ''),
              diff: String(e.payload?.diff ?? ''),
              actor: String(e.actor ?? 'unknown'),
            })
          }
        }
      }
    }
  } catch {
    /* teams 目录不可读 → 条目照常返回，提案/时间线为空（面板降级而非报错） */
  }
  proposals.sort((a, b) => (a.at < b.at ? -1 : 1))
  return { entries, proposals, timeline }
}

/** 默认团队：状态目录下唯一团队；多团队时取最近修改的账本（M1 单活跃团队口径） */
function pickDefaultTeamId(workspaceRoot: string): string {
  const teamsDir = storeLayout(workspaceRoot).tasks
  try {
    const names = readdirSync(teamsDir).filter((n) => existsSync(join(teamsDir, n, 'ledger.jsonl')))
    if (names.length === 0) return 'default'
    if (names.length === 1) return names[0]
    let best = names[0]
    let bestM = 0
    for (const n of names) {
      const m = statSync(join(teamsDir, n, 'ledger.jsonl')).mtimeMs
      if (m > bestM) { bestM = m; best = n }
    }
    return best
  } catch {
    return 'default'
  }
}

export class MyTeamHost implements MyTeamHostContract {
  private rt: HostRuntime
  private services = new Map<string, TeamService>()
  private memberHandles = new Map<string, any>() // memberId → AgentHandle
  /**
   * CHG-186（T155b）：成员族端点适配层（`src/host/members.ts`）。
   *
   * 宿主面只声明这族**用到的**成员（全部是私有成员，TS 私有不参与结构化赋值，所以在这里
   * 用闭包逐个接出来）：私有方法改名 → 装配处编译报错，不会靠 `as` 蒙混过去。闭包只捕获
   * `this`、构造期不调用任何方法，字段初始化顺序无影响。
   */
  private readonly members = createMembersHandlers({
    commit: (teamId, draft) => this.commit(teamId, draft),
    spawnMember: (teamId, roleId, instanceName, overrides) => this.spawnMember(teamId, roleId, instanceName, overrides),
    releaseMember: (teamId, memberId, mode, confirm, actor, cascade) => this.releaseMember(teamId, memberId, mode, confirm, actor, cascade),
    deliverMemberMessage: (memberId, kind, content) => this.deliverMemberMessage(memberId, kind, content),
    agentOf: (handle) => this.agentOf(handle),
    memberHandle: (memberId) => this.memberHandles.get(memberId),
    noteGuardTurnEnd: (memberId) => this.noteGuardTurnEnd(memberId),
    membersOf: (teamId) => Object.values(this.service(teamId).projectionSnapshot.members),
  })
  /**
   * CHG-186（T155b）：任务族端点适配层（`src/host/tasks.ts`）。
   *
   * 任务族横跨**两个通道**（队长侧 `executeLeadTool` / 成员侧 `executeMemberToolInner`），
   * 返回口径不同，所以两个工厂、两个宿主面。宿主面只声明这族用到的私有成员——私有方法
   * 改名 → 装配处编译报错。注意 `workspaceRoot` 在这里是**方法**（惰性 getter 不能在构造期
   * 取值快照：那会把「首次访问才解析项目根」提前到 host 构造期，日志顺序会变）。
   */
  private readonly tasks = createTasksHandlers({
    service: (teamId) => this.service(teamId),
    commit: (teamId, draft) => this.commit(teamId, draft),
    commitGuarded: (teamId, args, draft) => this.commitGuarded(teamId, args, draft),
    taskWithGateChain: (teamId, task) => this.taskWithGateChain(teamId, task),
    applyTaskRelations: (teamId, taskId, args, actor) => this.applyTaskRelations(teamId, taskId, args, actor),
    rescopeTask: (teamId, args, actor) => this.rescopeTask(teamId, args, actor),
    reviewTask: (teamId, args, actor) => this.reviewTask(teamId, args, actor),
    cancelTask: (teamId, args, actor) => this.cancelTask(teamId, args, actor),
    batchTaskOp: (teamId, args, actor) => this.batchTaskOp(teamId, args, actor),
    createTasksBatch: (teamId, args, actor) => this.createTasksBatch(teamId, args, actor),
  })
  /**
   * CHG-186（T155c）：计划族端点适配层（`src/host/plan.ts`）。
   *
   * 宿主面只声明这族**用到的**私有成员——私有方法改名 → 装配处编译报错。两个惰性 getter
   * （`workspaceRoot` / `rolePaths`）在这里是**方法**：构造期取值会把「首次访问才解析」
   * 提前，日志顺序会变。`services.has` / `contributionCatalog.roles` 是私有字段的只读
   * 取值口；`readLedgerEvents` 是模块级函数透传（plan.ts 直接 import 回来会与 `host.ts`
   * 成 value 环，arch-report 的 value 环会从 0 变 1）。
   */
  private readonly plan = createPlanHandlers({
    commit: (teamId, draft) => this.commit(teamId, draft),
    service: (teamId) => this.service(teamId),
    hasService: (teamId) => this.services.has(teamId),
    workspaceRoot: () => this.workspaceRoot,
    rolePaths: () => this.rolePaths,
    contributionRoles: () => this.contributionCatalog.roles,
    presetCatalog: () => this.presetCatalog(),
    roleCatalog: () => this.roleCatalog(),
    resolveNewTeamId: (explicit, teamName) => this.resolveNewTeamId(explicit, teamName),
    countClarifyRounds: (teamId) => this.countClarifyRounds(teamId),
    spawnMember: (teamId, roleId, instanceName, overrides) => this.spawnMember(teamId, roleId, instanceName, overrides),
    taskWithGateChain: (teamId, task) => this.taskWithGateChain(teamId, task),
    resolveProposal: (teamId, args, actor) => this.resolveProposal(teamId, args, actor),
    readLedgerEvents: (ledgerPath) => readLedgerEvents(ledgerPath),
  })
  /**
   * CHG-186（T155c）：角色族端点适配层（`src/host/roles.ts`）。
   *
   * 宿主面只声明这族**用到的**私有成员——私有方法改名 → 装配处编译报错。`rolePaths`
   * 同样是**惰性 getter**，以方法形式接出来（构造期取不到项目级角色目录）。
   */
  private readonly roles = createRolesHandlers({
    rolePaths: () => this.rolePaths,
    roleCatalog: () => this.roleCatalog(),
    roleError: (e) => this.roleError(e),
    deleteRoleTool: (roleId, confirm) => this.deleteRoleTool(roleId, confirm),
    publishRoleTool: (args) => this.publishRoleTool(args),
    copyRoleTool: (args) => this.copyRoleTool(args),
    createRole: (args) => this.createRole(args),
    updateRole: (args) => this.updateRole(args),
    applyRoles: (teamId, args, actor) => this.applyRoles(teamId, args, actor),
  })
  /**
   * CHG-186（T155c）：团队族端点适配层（`src/host/teams.ts`）。
   *
   * 宿主面只声明这族**用到的**成员——私有方法改名 → 装配处编译报错。`workspaceRoot`
   * 同样是**惰性 getter**，以方法形式接出来（构造期取不到项目根）。这一族**同步与
   * 异步并存**（`exportTeamTool` 同步、`importTeamTool` 等本来 async），原样保留。
   */
  private readonly teams = createTeamsHandlers({
    commit: (teamId, draft) => this.commit(teamId, draft),
    service: (teamId) => this.service(teamId),
    syncTokens: (teamId) => this.syncTokens(teamId),
    workspaceRoot: () => this.workspaceRoot,
    log: (level, msg) => this.log(level, msg),
    dispose: () => this.dispose(),
    exportTeamTool: (args) => this.exportTeamTool(args),
    importTeamTool: (args) => this.importTeamTool(args),
    publishTeamTool: (args) => this.publishTeamTool(args),
    copyTeamTool: (args) => this.copyTeamTool(args),
    saveTeamConfigTool: (args) => this.saveTeamConfigTool(args),
    resetTeamConfig: (teamId, args) => this.resetTeamConfig(teamId, args),
    handoffTeam: (args) => this.handoffTeam(args),
    readSessionHistory: (args) => this.readSessionHistory(args),
  })
  /**
   * CHG-186（T155c）：知识族端点适配层（`src/host/knowledge.ts`）。
   *
   * 宿主面只声明这族**用到的**成员——私有方法改名 → 装配处编译报错。`workspaceRoot`
   * 同样是**惰性 getter**，以方法形式接出来。`findKnowledgeProposal` 是模块级函数透传
   * （knowledge.ts 直接 import 回来会与 `host.ts` 成 value 环）。
   */
  private readonly knowledge = createKnowledgeHandlers({
    commit: (teamId, draft) => this.commit(teamId, draft),
    service: (teamId) => this.service(teamId),
    workspaceRoot: () => this.workspaceRoot,
    findKnowledgeProposal: (ledgerPath, draftId) => findKnowledgeProposal(ledgerPath, draftId),
  })
  /**
   * CHG-186（T155c）：知识族**成员侧**适配层（同一文件的另一半，见上）。
   *
   * 只读：成员无知识写入口是策展制的运行时保证（TF ADR-0009）。这条通道**不碰**
   * `service(teamId)`——那行必须留在 `executeMemberToolInner`（见知识族文件头 ⚠️）。
   */
  private readonly memberKnowledge = createMemberKnowledgeHandlers({
    workspaceRoot: () => this.workspaceRoot,
  })
  /**
   * CHG-186（T155c）：查询族端点适配层（`src/host/query.ts`，只读）。
   *
   * 宿主面只声明这族**用到的**成员——成员改名 → 装配处编译报错（`listContributionsTool`
   * 是私有方法，其余是公开方法）。
   */
  private readonly query = createQueryHandlers({
    getAuditTool: (args) => this.getAuditTool(args),
    getTokensTool: (args) => this.getTokensTool(args),
    listSkillsTool: (args) => this.listSkillsTool(args),
    getTaskGraphTool: (args) => this.getTaskGraphTool(args),
    listTeamsTool: (args) => this.listTeamsTool(args),
    getTeamTool: (args) => this.getTeamTool(args),
    listRolesTool: (args) => this.listRolesTool(args),
    listPresetsTool: () => this.listPresetsTool(),
    listContributionsTool: (catalog) => this.listContributionsTool(catalog),
    reloadContributions: () => this.reloadContributions(),
    savePreset: (args) => this.savePreset(args),
    copyPreset: (args) => this.copyPreset(args),
    deletePreset: (args) => this.deletePreset(args),
    createSkillTool: (args) => this.createSkillTool(args),
    createToolTool: (args) => this.createToolTool(args),
  })
  /** CHG-186（T155b）：任务族**成员侧**适配层（同一文件的另一半，见上） */
  private readonly memberTasks = createMemberTaskHandlers({
    service: (teamId) => this.service(teamId),
    commit: (teamId, draft) => this.commit(teamId, draft),
    captureArtifactBaseline: (teamId, taskId) => this.captureArtifactBaseline(teamId, taskId),
    scopeAuditFor: (teamId, taskId) => this.scopeAuditFor(teamId, taskId),
    evaluateArchiveGate: (teamId, taskId, actor, declaredPaths) => this.evaluateArchiveGate(teamId, taskId, actor, declaredPaths),
    auditMemberMemory: (teamId, memberId, taskId) => this.auditMemberMemory(teamId, memberId, taskId),
    waitForChange: (args) => this.waitForChange(args),
    /* CHG-200：成员提交门禁裁决——与队长侧同一条 reviewTask 实现（口径只有一处） */
    reviewTask: (teamId, args, actor) => this.reviewTask(teamId, args, actor),
    agentOf: (handle) => this.agentOf(handle),
    memberHandle: (memberId) => this.memberHandles.get(memberId),
    followupMessage: (text) => this.followupMessage(text),
    workspaceRoot: () => this.workspaceRoot,
  })
  /** CHG-200：**队长读面**（`src/host/read.ts`）——逻辑全在族文件，入口只留路由。 */
  private readonly read = createReadHandlers({
    service: (teamId) => this.service(teamId),
    readLedgerEvents: (ledgerPath) => readLedgerEvents(ledgerPath),
    workspaceRoot: () => this.workspaceRoot,
  })
  /**
   * CHG-189（T159a）：**spawn 生命周期**（`src/core/members/spawn-lifecycle.ts`）。
   *
   * 这是「按行为边界下沉」的第一刀：`spawnMember` / `settleSpawnActive` / `settleSpawnFailure` /
   * `probeProvisionedSession` / `pendingMessagesFor` 五个私有方法**逐字**搬进 core，这里只声明
   * 宿主面（惰性字段一律以**方法**接出来，构造期取值会把「首次访问才解析」提前）。
   *
   * 为什么不能靠 import：`guardRule`（`host/members.ts`）、`memberToolDefs`（`tools/defs.ts`）、
   * `readLedgerEvents` / `isThenable` / `compileParameters`（`host.ts` 模块级函数）分别在
   * 入口层与工具声明层，`core/**` import 它们会红 A1 门禁、并把 arch-report 的逆向 value 边
   * 从 0 抬起来。逐字核验与依赖边界见该文件头。
   */
  private readonly spawn = createSpawnLifecycle({
    rt: () => this.rt,
    log: (level, msg) => this.log(level, msg),
    workspaceRoot: () => this.workspaceRoot,
    rolePaths: () => this.rolePaths,
    contributionRoles: () => this.contributionCatalog.roles,
    roleCatalog: () => this.roleCatalog(),
    service: (teamId) => this.service(teamId),
    commit: (teamId, draft) => this.commit(teamId, draft),
    disposalGate: () => this.disposalGate,
    memberHandles: () => this.memberHandles,
    agentOf: (handle) => this.agentOf(handle),
    followupMessage: (text) => this.followupMessage(text),
    executeMemberTool: (member, name, args) => this.executeMemberTool(member, name, args),
    memberToolDefs,
    compileParameters,
    guardRule,
    readLedgerEvents,
    isThenable,
  })
  /**
   * CHG-190（T159b）：**门禁执行**（`src/core/gates/gate-execution.ts`）——入口层下沉三刀里的
   * 第二刀。12 个私有方法（`reviewTask` / `runVerifyGate` / `scopeAuditFor` /
   * `evaluateArchiveGate` / `autoEvaluateGateChain` / `captureArtifactBaseline` /
   * `artifactFreshnessFor` / `artifactTextOf` / `completionReplyOf` / `deliveryJudgementFor` /
   * `expectedRevisionOf` / `taskWithGateChain`）**逐字**搬进 core，这里只声明宿主面
   * （惰性字段一律以**方法**接出来，构造期取值会把「首次访问才解析」提前）。
   *
   * 为什么不能靠 import：`deliverablePathsOf` / `readArtifactBaselineRecord` /
   * `writeArtifactBaselineRecord` / `readLedgerEvents` / `deliverableMinLength` / `guardPayloadOf`
   * 与 `ABSENT_PATH_FINGERPRINT` / `ARTIFACT_TEXT_READ_LIMIT` 是 `host.ts` 的**模块级**标识符，
   * `core/**` import 入口层会红 A1 门禁、并把 arch-report 的逆向 value 边从 0 抬起来。
   * 逐字核验与依赖边界见该文件头。
   */
  private readonly gates = createGateExecution({
    service: (teamId) => this.service(teamId),
    commit: (teamId, draft) => this.commit(teamId, draft),
    log: (level, msg) => this.log(level, msg),
    workspaceRoot: () => this.workspaceRoot,
    rt: () => this.rt,
    artifactBaselinePath: (teamId, taskId) => this.artifactBaselinePath(teamId, taskId),
    resolveArtifactPath: (path) => this.resolveArtifactPath(path),
    statArtifact: (path) => this.statArtifact(path),
    guardVerdict: (memberId) => this.guardVerdict(memberId),
    deliverablePathsOf,
    readArtifactBaselineRecord,
    writeArtifactBaselineRecord,
    absentPathFingerprint: ABSENT_PATH_FINGERPRINT,
    artifactTextReadLimit: ARTIFACT_TEXT_READ_LIMIT,
    readLedgerEvents,
    deliverableMinLength,
    guardPayloadOf,
  })
  /**
   * CHG-191（T159c）：**批量编排**（`src/core/tasks/batch-orchestration.ts`）——入口层下沉三刀里的
   * 第三刀。3 个私有方法（`batchTaskOp` / `createTasksBatch` / `materializeSplitProposal`）**逐字**
   * 搬进 core，这里只声明宿主面（闭包惰性求值，构造期不调用任何方法，字段初始化顺序无影响）。
   *
   * 为什么不能靠 import：`isPlainObject` 是 `host.ts` 的**模块级**标识符，`core/**` import 入口层
   * 会红 A1 门禁、并把 arch-report 的逆向 value 边从 0 抬起来；`service` / `commit` /
   * `taskWithGateChain` / `applyTaskRelations` / `cancelTask` / `rescopeTask` 是宿主运行时通道。
   * 逐字核验与依赖边界见该文件头。
   */
  private readonly batchOrchestration = createBatchOrchestration({
    service: (teamId) => this.service(teamId),
    commit: (teamId, draft) => this.commit(teamId, draft),
    taskWithGateChain: (teamId, task) => this.taskWithGateChain(teamId, task),
    applyTaskRelations: (teamId, taskId, args, actor) => this.applyTaskRelations(teamId, taskId, args, actor),
    cancelTask: (teamId, args, actor) => this.cancelTask(teamId, args, actor),
    rescopeTask: (teamId, args, actor) => this.rescopeTask(teamId, args, actor),
    isPlainObject,
  })
  /**
   * P1-4（docs/21 §6）：运行时准入闸门——`dispose()` 关闸后，新起的成员操作立即被拒，
   * 在飞操作在 `disposalTimeoutMs` 内有界结算（非预期失败聚合成一条 warn）。
   * 在 constructor 里用行 config 构造（字段初始化早于 constructor body，拿不到 this.config）。
   */
  private readonly disposalGate: AdmissionGate
  /**
   * P1-5（docs/21 §6）：成员单调用护栏状态（memberId → 纯数据计数 + 本回合动作数 + 最近判定）。
   *
   * 为什么状态挂在 host 侧而不是成员会话里：`executeMemberTool` 是成员每次工具调用的唯一入口，
   * 宿主在这里能拿到「谁调了什么、结果是什么」；把计数交给成员会话意味着它必须能被持久化/
   * 重建，而护栏口径是「本次会话内的连续段」——host 存活期就是它的自然作用域（崩溃即重置，
   * 与 guard.ts「状态是纯数据」的设计一致）。
   */
  private guardRecords = new Map<string, { state: GuardState; toolsInTurn: number; lastVerdict?: GuardVerdict }>()
  /** CHG-71 派单唤醒节流：team 级（合并突发事件）与 member 级（防重复打扰） */
  private lastDispatchAt = new Map<string, number>()
  private lastDispatchWakeAt = new Map<string, number>()
  private tokensFiles = new Map<string, TokensFile>()
  /**
   * R41-③：内置团队工具隐藏的**实际生效**状态（initialize 时机记录一次，只读快照）。
   *
   * 为什么要在 host 上留这份状态：`hideBuiltinTeamTools` 是 host 级行为（不是 team.config），
   * 旧设置页只显示「配置期望值」（甚至只是一颗永远关闭的假开关）——R41-③ 裁决要求显示
   * **实际生效**的 deny 清单。三个字段都是事实而非期望：`restricted=false` 表示宿主根本
   * 没提供 `tools.restrict`（隐藏未执行），`effective ⊆ configured` 是过滤后的真实 deny。
   */
  private builtinToolsHideState: { enabled: boolean; restricted: boolean; configured: string[]; effective: string[] } = {
    enabled: true,
    restricted: false,
    configured: [],
    effective: [],
  }
  /**
   * CHG-86（P0-3）：token 侧车的**上次读到的累计量**基线（teamId → memberId → 四桶）。
   * session 投影给的是全生命周期累计量；没有基线就只能把总量记进"今天"这一个桶，
   * 历史按天数据每次读盘都被抹掉。有了基线，每次只落增量，days 自然长出多天。
   * 冷启动从已有 tokens.json 的 `totals` 恢复基线（见 syncTokens）。
   */
  private tokenBaselines = new Map<string, Map<string, TokensFile['totals'][string]>>()
  /**
   * 项目根（CHG-102 的 P0 修复）。
   *
   * 修复前 = `ctx.workspace.root ?? process.cwd()`：desktop profile 下 `workspace.root` 是
   * `~/.dsh/profiles/desktop`，于是**项目级角色/团队/任务全部写进了用户全局 profile**，
   * 面板项目视图永远看不到（「所有项目看起来都一样」的根因）。
   *
   * 现在按 `resolveProjectRoot()` 的优先级：**会话工作目录**（`agent.session.cwd` /
   * `workingDirectory.get`）→ 行 config 显式 → 宿主 workspace（过 profile 拒绝规则）→
   * 进程 cwd。解析结果缓存（一个 host 实例 = 一个队长 preset 作用域 = 一个项目）。
   */
  private _workspaceRoot?: string
  private _rolePaths?: RoleStorePaths
  get workspaceRoot(): string {
    if (!this._workspaceRoot) {
      const resolution = resolveProjectRoot({
        explicit: typeof this.config.workspaceRoot === 'string' ? this.config.workspaceRoot : undefined,
        sessionCwd: sessionCwdOf(this.rt),
        workspaceRoot: (safeRead(this.rt, 'workspace') as { root?: string } | undefined)?.root,
        cwd: process.cwd(),
      })
      this._workspaceRoot = resolution.root
      this.workspaceFallback = resolution.source === 'cwd'
      for (const rejected of resolution.rejected) {
        this.log('warn', `project root candidate rejected (${rejected.source}: ${rejected.path}): ${rejected.reason}`)
      }
      this.log('info', `project root = ${resolution.root} (source: ${resolution.source})`)
    }
    return this._workspaceRoot
  }
  /** R41-③：面板设置页读「实际生效」的内置工具隐藏状态（只读快照，initialize 后恒有值） */
  get builtinToolsHide(): { enabled: boolean; restricted: boolean; configured: string[]; effective: string[] } {
    return this.builtinToolsHideState
  }
  get rolePaths(): RoleStorePaths {
    if (!this._rolePaths) {
      const layout = storeLayout(this.workspaceRoot)
      this._rolePaths = {
        projectRolesDir: layout.roles,
        // 全局角色库：$DSH_HOME/myteam/roles（CHG-69 与面板/离线聚合统一路径口径）
        globalRolesDir: this.config.globalRolesDir ?? join(resolveMyteamHome(), 'roles'),
        // 项目自身角色（FR-19）：不属于任何团队，可被本项目各团队聘任
        projectRoleFile: layout.projectRole,
      }
    }
    return this._rolePaths
  }
  readonly config: MyTeamConfig
  /** TeamService effectiveConfig 覆盖：行 config 显式 > 运行时自有属性（见 constructor 注释） */
  private configOverride?: unknown
  /** workspace 服务缺失时为 true（initialize 记 warn，提示存储落点降级） */
  private workspaceFallback = false
  /**
   * CHG-91（插件团队贡献契约 v1）：第三方插件贡献的角色与团队模板。
   *
   * 装载在 `initialize()` 里（**只读**：`JSON.parse` 文件，不 `import()` 插件代码、不写账本）。
   * 一个插件坏了不影响其它插件（`warnings[]` 收集），但**必须大声**——
   * 面板角色库页顶部显示红条，不静默跳过（契约 P4）。
   */
  private contributionCatalog: ContributionCatalog = emptyContributionCatalog('')

  constructor(rt: HostRuntime, config: MyTeamConfig = {}) {
    this.rt = rt
    this.config = { hideBuiltinTeamTools: true, ...config }
    // P1-4：准入闸门的超时来自行 config（缺省 5s；非法值回落默认）
    this.disposalGate = createAdmissionGate({ disposalTimeoutMs: this.disposalTimeoutMs() })
    // configOverride 优先级：行 config 显式 > rt 自有属性（t11/t21 测试注入路径）。
    // 真实宿主 rt 是 Cordis Context 代理，且宿主 asar 全文无 configOverride（0 命中）
    // → 真实环境恒 undefined，TeamService 走 loadEffectiveConfig 默认值。
    this.configOverride = config.configOverride ?? safeRead(rt, 'configOverride')
    // T24（CHG-45）：索引缺失时全量重建（冷启动/首次使用），保证面板全局视图先有离线数据
    this.ensureTeamIndex()
    /* A9（报告 KI-5，CHG-163）：冷启动重连——把重启前既有活跃成员的 AgentHandle 捡回来。
     *
     * 为什么放在 constructor（而不是 initialize / recoverOnBoot 之前）：`memberHandles` 的三个
     * 消费点全都「谁先跑谁说了算」——`syncTokens` 拿不到 handle 就把成员记 `no-session`（少算 token）、
     * `wakeDecisionsFor` 投不出 followup（唤醒静默失效）、`recoverOnBoot` 判 `memberLive=false`
     * 会把**活着的**成员正在跑的任务转 blocked。constructor 是它们共同的前置点（`ensureTeamIndex`
     * 之后，索引已就绪；`initialize()` 里的启动对账/工具注册都在它之后）。
     *
     * 纪律同 `ensureTeamIndex`：**失败只 warn，绝不阻断启动**——宿主没有 `agents` 服务时插件也必须起得来。 */
    try {
      const reconnected = this.reconnectMembers()
      if (reconnected.reconnected > 0 || reconnected.missing > 0) {
        this.log(
          'info',
          `member reconnect on boot: ${reconnected.reconnected} session(s) restored, ${reconnected.missing} missing` +
            (reconnected.skipped.length > 0 ? ` (skipped: ${reconnected.skipped.join('; ')})` : ''),
        )
      }
    } catch (e) {
      this.log('warn', `member reconnect on boot failed (startup continues): ${String(e)}`)
    }
  }

  /**
   * CHG-91：重新扫描插件贡献（启动时一次 + 面板/工具显式重载）。
   *
   * 三条纪律（契约 §8 / §11）：
   *  1. **只读**——`loadContributions` 只 `JSON.parse` 文件，不 `import()` 插件代码、不写账本；
   *  2. **失败隔离**——一个插件坏了不影响其它插件（`parseContributions` 里没有 `throw`）；
   *  3. **大声**——每个失败都写进 `warnings`，并 `log('warn')` 一条汇总（面板顶部红条读它）。
   */
  reloadContributions(): ContributionCatalog {
    const root = contributionsRoot()
    // 冲突裁决用「内置 id」（撞上 = 硬失败）；模板可解析集合 = 全部非插件来源
    const baseCatalog = listRoleCatalog(this.rolePaths)
    const builtinRoleIds = new Set(baseCatalog.filter((entry) => entry.origin === 'builtin').map((entry) => entry.definition.id))
    const resolvableRoleIds = new Set(baseCatalog.map((entry) => entry.definition.id))
    const builtinTemplateIds = new Set(BUILTIN_PRESET_IDS)
    try {
      this.contributionCatalog = loadContributions(root, { builtinRoleIds, builtinTemplateIds, resolvableRoleIds })
    } catch (e) {
      // 装载器自身异常（理论上不该发生）：不让它拖垮启动，但必须留痕
      this.contributionCatalog = { ...emptyContributionCatalog(root), ok: false, warnings: [{
        level: 'error', code: 'MT_PLUGIN_MANIFEST_INVALID', pluginId: '(loader)', message: `贡献装载器异常：${String(e)}`,
      }] }
      this.log('warn', `contributions loader failed: ${String(e)}`)
    }
    const errors = this.contributionCatalog.warnings.filter((warning) => warning.level === 'error')
    if (errors.length > 0) {
      this.log('warn', `plugin contributions: ${errors.length} error(s), ${errors.map((warning) => warning.code).join(', ')}`)
    } else if (this.contributionCatalog.plugins.length > 0) {
      this.log('info', `plugin contributions: ${this.contributionCatalog.plugins.length} plugin(s), ${this.contributionCatalog.roles.length} role(s), ${this.contributionCatalog.teams.length} team(s)`)
    }
    return this.contributionCatalog
  }

  /** CHG-91：当前装载的贡献目录（只读快照；面板/工具用） */
  contributionSnapshot(): ContributionCatalog {
    return this.contributionCatalog
  }

  /** CHG-91：角色目录（**含插件贡献**）——所有调用点统一走这里，避免漏传 contributions 造成分叉 */
  roleCatalog() {
    return listRoleCatalog(this.rolePaths, this.contributionCatalog.roles)
  }

  /** CHG-91：团队模板目录（**含插件贡献**） */
  presetCatalog(): PresetCatalog {
    return readPresetCatalog(this.workspaceRoot, this.contributionCatalog.teams)
  }

  /** CHG-91：某个角色是否是插件贡献（只读；写操作要报 `MT_ROLE_READONLY`） */
  contributedRole(roleId: string) {
    return this.contributionCatalog.roles.find((role) => role.id === roleId)
  }

  /** T24：索引缺失时从账本全量重建工作区索引 + 全局索引（实现见 `host/teams.ts`，失败只 warn） */
  ensureTeamIndex(): void {
    this.teams.ensureIndex()
  }

  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.rt.logger?.[level]?.(`[myteam] ${msg}`) ?? console[level](`[myteam] ${msg}`)
  }

  /** 可选服务防御读取：缺失返回 undefined（宿主未装该服务时降级而非抛错） */
  private svc<T = any>(name: 'tokenMeter' | 'sessionProjections' | 'typert' | 'subagents'): T | undefined {
    try {
      return (this.rt as Record<string, any>)[name] as T | undefined
    } catch {
      return undefined
    }
  }

  /* ── 初始化（apply 调用；同步部分直接执行，异步收尾进 ctx.effect）── */

  initialize(): void {
    const dirs = ensureWorkplaceDirs(this.workspaceRoot, (m) => this.log('warn', m))
    ensureGitignoreManagedBlock(this.workspaceRoot, (m) => this.log('warn', m))
    if (this.workspaceFallback) {
      this.log('warn', `session working directory unavailable; ${STORE_DIR} rooted at process cwd: ${this.workspaceRoot}`)
    }
    this.log('info', `store ready: ${dirs.root} (created ${dirs.created.length} dirs)`)
    // P0-1（docs/21 §6）：两阶段 spawn 的启动对账——把上次进程崩在 `agents.create` 期间的成员
    // 从 provisioning 结算掉（active / failed），否则它们永远不会被清理、也不会被唤醒。
    // 放在工具注册之前（对账要写账本，不能被工具面并发影响），且**失败不得阻断启动**
    // （`reconcileProvisioningOnBoot` 内部逐团队兜底，这里再兜一层）。
    try {
      const reconciled = this.reconcileProvisioningOnBoot()
      if (reconciled.settled > 0) {
        this.log('info', `spawn reconcile on boot: ${reconciled.settled} provisioning member(s) settled (${reconciled.active} active, ${reconciled.failed} failed)`)
      }
    } catch (e) {
      this.log('warn', `spawn reconcile on boot failed (startup continues): ${String(e)}`)
    }
    // CHG-91（插件团队贡献契约 v1）：装载第三方插件贡献的角色与团队模板。
    // **必须早于** registerLeadTools / registerRemote——工具与面板都要读这份目录。
    // 纪律：只读（JSON.parse 文件）、失败隔离（坏插件只进 warnings）、大声（warn 日志 + 面板红条）。
    this.reloadContributions()
    // Lead 工具注册（preset 层；队长会话可见）。工具面缺失是致命配置错误 → fail loud。
    this.registerLeadTools()
    // 队长技能（CHG-53）+ 团队章程（CHG-93 FR-18③）：都是 **preset 作用域服务**，
    // 必须延迟注入——真实安装实测（CHG-93）发现 initialize() 同步执行时
    // skills / systemPrompt 还没就绪，两个注册**静默不生效**（单测里 rt 是同步桩，永远拿得到）。
    this.deferCaptainServices()
    // 面板 Remote service（ADR-006：client 读盘真相 + 唯一写入口；namespace myteam）
    this.registerRemote()
    // hideBuiltinTeamTools（PRD §2.4）：隐藏宿主内置团队工具。
    // restrict 只能移除工具（practices.md §4 最弱机制）——符合"隐藏"语义。
    // R41-③：无论走哪个分支，都把**实际生效**状态记下来（设置页显示事实，不显示期望）。
    this.builtinToolsHideState = {
      enabled: this.config.hideBuiltinTeamTools !== false,
      restricted: Boolean(this.rt.tools?.restrict),
      configured: [...HOST_TEAM_TOOLS_TO_HIDE],
      effective: [],
    }
    if (this.config.hideBuiltinTeamTools !== false && this.rt.tools?.restrict) {
      try {
        // CHG-58：restrict 只接受"当前已知的全局工具名"——先过滤，避免宿主没装内置团队
        // 工具时整批抛错（只告警、静默跳过）。作用域 = 队长 preset，成员 agent 继承该限制。
        const known = new Set(
          (((this.rt.tools as any).schemas?.() ?? []) as Array<{ name?: unknown }>)
            .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
            .filter((name) => name.length > 0),
        )
        const deny = known.size === 0 ? [...HOST_TEAM_TOOLS_TO_HIDE] : HOST_TEAM_TOOLS_TO_HIDE.filter((name) => known.has(name))
        this.builtinToolsHideState = { enabled: true, restricted: true, configured: [...HOST_TEAM_TOOLS_TO_HIDE], effective: deny }
        if (deny.length > 0) {
          this.rt.tools.restrict({ deny })
          this.log('info', `builtin team tools hidden (${deny.length})`)
        }
      } catch (e) {
        /* 状态保持 effective:[]（restricted:true 但一条都没生效——诚实） */
        this.log('warn', `restrict for hiding builtin tools failed: ${String(e)}`)
      }
    }
  }

  /**
   * 卸载清理（apply 返回的 disposer 调用）：**有界**排空全部成员会话（P1-4，docs/21 §6）。
   *
   * 顺序即协议（不要调换）：
   *  ① **关准入**（`disposalGate.close()`）——此后新起的成员操作 / spawn 结算一律立即拒绝，
   *     不再往正在拆的运行时里写账本；
   *  ② **收集在飞**——成员会话的 `dispose()` 包装成 operation（同步抛错也包成 rejected
   *     Promise，否则一条成员崩掉会中断整批排空）；
   *  ③ **有界结算**（`settleWithin`）——`allSettled` + `disposalTimeoutMs`（默认 5s）；
   *  ④ **非预期失败聚合成一条 warn**（AggregateError 语义），**预期取消不告警**
   *     （卸载期间成员会话被取消是正常结果；把取消当失败报会让真失败被假告警淹没）。
   *
   * 为什么保持**同步返回**：宿主 effect disposer 不 await 返回值（`apply()` 里
   * `ctx.effect(() => () => host.dispose())`），签名一旦改成 async，宿主会拿到一个
   * 没人 await 的 Promise —— 卸载仍然不等，但错误变得不可观测。所以排空放后台，
   * 但**必须有界**（超时留痕）且**必须留日志**（「消失了」与「排空了」要可区分）。
   *
   * 幂等：effect 与 `myteam_disband` 可能各调一次，第二次直接返回（不重复排空）。
   */
  dispose(): void {
    if (this.disposalGate.disposed) return
    const operations: AdmissionOperation[] = []
    for (const [memberId, handle] of this.memberHandles) {
      // 同步抛错 → rejected Promise（统一走结算段，两条路径不分叉）
      operations.push({ name: `member:${memberId}`, promise: Promise.resolve().then(() => handle?.dispose?.()) })
    }
    // ① 关闸（在收集之后、结算之前）：闸门只关心「已准入的」，这批 operation 正是
    this.disposalGate.close('myteam host dispose()')
    // ② 已在飞的运行时操作（spawn 结算段等）也要收进来——它们同样在写账本
    operations.push(...this.disposalGate.pending())
    this.memberHandles.clear()
    this.services.clear()
    // 护栏状态随运行时一起退休（host 卸载后残留的计数没有意义，成员 id 复用时还会串味）
    this.guardRecords.clear()
    void this.settleDisposal(operations)
  }

  /**
   * P1-4 的排空段（异步；`dispose()` 只负责 fire-and-forget）。
   *
   * 为什么把非预期失败**聚合成一条**：一次卸载里 3 个成员都炸了，应该看到 1 条
   * 「3 个失败」而不是 3 条互不相关的告警（日志被截断时后者还会丢）。
   * 为什么超时也算一条 warn：超时 = 没排空，必须让人知道（不是「已经收干净」）。
   */
  private async settleDisposal(operations: readonly AdmissionOperation[]): Promise<void> {
    const timeoutMs = this.disposalTimeoutMs()
    try {
      const outcome = await settleWithin(operations, timeoutMs)
      const unexpected = outcome.failures.filter((failure) => !isCancellation(failure.reason))
      if (unexpected.length > 0) {
        const detail = unexpected
          .map((failure) => `${failure.name}: ${String((failure.reason as Error | undefined)?.message ?? failure.reason)}`)
          .join('; ')
        this.log('warn', `dispose settled with ${unexpected.length} unexpected failure(s) (AggregateError semantics): ${detail}`)
      }
      if (outcome.timedOut.length > 0) {
        this.log(
          'warn',
          `dispose timeout after ${timeoutMs}ms: ${outcome.timedOut.length} member session(s) still pending (${outcome.timedOut.join(', ')}); 已放后台，宿主退出前不再等待`,
        )
      }
      if (unexpected.length === 0 && outcome.timedOut.length === 0) {
        this.log('info', `dispose settled ${outcome.settled} member session(s)`)
      }
    } catch (e) {
      // 排空段自身异常（不该发生）：卸载路径上没有上家，只能留日志
      this.log('warn', `dispose settlement failed: ${String(e)}`)
    }
  }

  /** P1-4 的有界结算超时（行 config 缺省 / 非法 → `DEFAULT_DISPOSAL_TIMEOUT_MS`） */
  private disposalTimeoutMs(): number {
    const value = this.config?.disposalTimeoutMs
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_DISPOSAL_TIMEOUT_MS
  }

  /** T13：MyTeamRemote 挂载。TypertRemoteService 构造即完成 Cordis provide + typertRemote
   *  绑定（Gateway source-mode discovery 消费）；此处只构造，不做第二次 provide（防键冲突）。 */
  private registerRemote(): void {
    try {
      const { MyTeamRemote } = remoteServiceModule
      new MyTeamRemote(this.rt, this)
      this.log('info', 'panel remote registered (namespace: myteam)')
    } catch (e) {
      this.log('warn', `panel remote registration failed: ${String(e)}`)
    }
  }

  /* ── TeamService 管理 ───────────────────────────────────────── */

  defaultTeamId(): string {
    return pickDefaultTeamId(this.workspaceRoot)
  }

  /**
   * FIX-17：submit_plan（建新团队）的 id 解析——显式 teamId 优先，否则从团队名 slug 派生。
   * 同名团队复用同一 id（discard 后重提续计澄清轮次 FR-1.6；撞 active 团队由 commit 报错）。
   * 不做 -N 避让：那会让澄清硬终止计数分摊到多个团队而失效。
   */
  resolveNewTeamId(explicit: string | undefined, teamName: string): string {
    const base = String(explicit ?? slugifyTeamName(teamName)).slice(0, 48)
    return base || 'team'
  }

  service(teamId: string): TeamService {
    let svc = this.services.get(teamId)
    if (!svc) {
      svc = new TeamService({ workspaceRoot: this.workspaceRoot, teamId, rolePaths: this.rolePaths, configOverride: this.configOverride })
      const { truncated } = svc.reload()
      if (truncated > 0) this.log('warn', `team ${teamId} ledger had ${truncated} crash-residue line(s), truncated`)
      this.services.set(teamId, svc)
      bootstrapTeam(svc)
    }
    return svc
  }

  /** CHG-55 门禁链展开 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；语义见该文件同名函数头）。 */
  private taskWithGateChain(teamId: string, task: Record<string, unknown>): Record<string, unknown> {
    return this.gates.taskWithGateChain(teamId, task)
  }

  /** 统一提交入口：成功后触发唤醒（不阻塞提交本身） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']> {
    const result = this.service(teamId).commit(draft)
    if (result.ok) this.afterCommit(teamId, result.event)
    return result
  }

  /**
   * CHG-87（QA-4 乐观锁）：带 `expectedRevision` 的提交入口。
   *
   * 工具入参里的 `expectedRevision` 是 `unknown`（JSON 面），统一在这里收敛：
   * 缺省 → 不传（service 侧不校验，向后兼容）；给了坏值 → NaN（service 判 `MT_VALIDATION`，
   * **不静默当没给**）。
   *
   * 用它的工具：`myteam_edit_task` / `myteam_rescope_task` / `myteam_cancel_task` /
   * `myteam_reassign_task` / `myteam_review_task`（docs/04 §1.1 承诺的乐观锁入口）。
   */
  commitGuarded(
    teamId: string,
    args: Record<string, unknown>,
    draft: Omit<CommitDraft, 'expectedRevision'>,
  ): ReturnType<TeamService['commit']> {
    const expected = this.expectedRevisionOf(args)
    return this.commit(teamId, { ...draft, ...(expected !== undefined ? { expectedRevision: expected } : {}) })
  }

  /** FIX-12：agents.create 返回形状未实证（宿主可能是 agent 本体或 {agent} 包装）——双形状兼容 */
  private agentOf(handle: unknown): { followup?: (msg: unknown) => void; cancel?: (o: unknown) => void } | undefined {
    const h = handle as { agent?: unknown; followup?: unknown } | undefined
    if (!h) return undefined
    if (h.agent) return h.agent as { followup?: (msg: unknown) => void; cancel?: (o: unknown) => void }
    if (typeof h.followup === 'function') return h as { followup: (msg: unknown) => void }
    return undefined
  }

  /**
   * FIX-16（KI-2 实弹）：followup 消息必须带标识（dsh-llm createUserMessage：{role:'user',
   * content, source, id:uuid}）——裸 {content, source} 会建 turn 但 prompt 为空（成员 turn 1
   * 空转、零 LLM 请求，实弹 turnOutline prompt:"" 实证）。插件不依赖 dsh-llm，自构同形消息。
   */
  private followupMessage(text: string): Record<string, unknown> {
    return {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-plugin-myteam' },
    }
  }

  /**
   * A10（FR-14.2 指导档，CHG-163）：成员消息投递的**唯一**构造点。
   *
   * 为什么收敛成一个方法：`myteam_message`（队长工具）与面板 `memberOp(op:'steer')` 是同一个语义
   * （给成员发一条消息并立刻投递）。两处各写一份「文案 + 消息形状」必然漂移，而
   * `followupMessage` 的 `{role,id,content,source}` 形状是 FIX-16 的实弹结论——不要在这里另造格式。
   *
   * 边界：返回**是否真的投递出去**。没有 handle（成员会话不在线）或 followup 抛错都返回 `false`，
   * 调用方必须如实回报 `delivered:false`——**账本落了 ≠ 送到了**（项目纪律：不假装成功）。
   */
  private deliverMemberMessage(memberId: string, kind: string, content: string): boolean {
    const agent = this.agentOf(this.memberHandles.get(memberId))
    if (!agent?.followup) return false
    try {
      agent.followup(this.followupMessage(`[myteam] 队长消息（${kind}）：${content}`))
      return true
    } catch (e) {
      this.log('warn', `message delivery to ${memberId} failed: ${String(e)}`)
      return false
    }
  }

  private afterCommit(teamId: string, event: { seq: number; type: string; payload: Record<string, unknown> }): void {
    this.teams.refreshIndex(teamId)
    const wakes = wakeDecisionsFor(event) as WakeDecision[]
    for (const wake of wakes) {
      const agent = this.agentOf(this.memberHandles.get(wake.memberId))
      if (agent?.followup) {
        try {
          agent.followup(this.followupMessage(`[myteam] ${wake.cause}: ledger seq ${event.seq}（读 myteam_get_task/myteam_list_tasks 获取详情）`))
        } catch (e) {
          this.log('warn', `wake ${wake.memberId} failed: ${String(e)}`)
        }
      }
    }
    // CHG-71：任务被编辑 → 提醒当前执行者（不改变调度，不属于四种因果唤醒）
    if (event.type === 'task.updated') this.notifyTaskEdited(teamId, event)
    // CHG-71：派单扫描——新建/解锁/重规划后，若没有显式唤醒，看看有没有可领任务
    if (wakes.length === 0 && DISPATCH_TRIGGER_TYPES.has(event.type)) this.dispatchSweep(teamId)
  }

  /** CHG-71：任务编辑通知（只提醒正在执行该任务的成员；无执行者则静默） */
  private notifyTaskEdited(teamId: string, event: { seq: number; payload: Record<string, unknown> }): void {
    try {
      const svc = this.service(teamId)
      const taskId = String(event.payload.taskId ?? '')
      const t = svc.projectionSnapshot.tasks[taskId]
      const assignee = t?.assignee
      if (!t || !assignee) return
      if (!t.attemptId) return // 还没开跑：编辑会随下一次 claim 的读取自然生效
      const patch = (event.payload.patch as Record<string, unknown>) ?? {}
      const fields = Object.keys(patch)
      const agent = this.agentOf(this.memberHandles.get(assignee))
      agent?.followup?.(this.followupMessage(`[myteam] task-updated: ${taskId} 被队长编辑（${fields.join('/') || '内容'}），ledger seq ${event.seq}（用 myteam_get_task 重读再继续）`))
    } catch (e) {
      this.log('warn', `notify task edited failed: ${String(e)}`)
    }
  }

  /**
   * CHG-71：派单扫描（dispatch）。背景：只有 assign/message/resume/revoke 四种因果唤醒，
   * 新建任务 / 上游完成解锁下游时没有任何人会被叫醒 → 团队实际会停在原地。
   * 规则（克制版）：
   *  - 只扫 active 团队的空闲成员（status=active 且无 currentTaskId）；
   *  - 每个「角色」最多唤醒 1 名（按名册顺序），一次扫描最多 2 名；
   *  - team 级 / member 级节流（默认 400ms / 3000ms），可配置为 0 关闭；
   *  - 唤醒文案只给「有匹配任务」的失效提示，不推任务正文（NFR-7.7）。
   */
  private dispatchSweep(teamId: string): void {
    try {
      const svc = this.service(teamId)
      const proj = svc.projectionSnapshot
      if (proj.state !== 'active') return
      const now = Date.now()
      const teamCooldown = this.config.dispatchTeamCooldownMs ?? 400
      const memberCooldown = this.config.dispatchMemberCooldownMs ?? 3000
      if (now - (this.lastDispatchAt.get(teamId) ?? 0) < teamCooldown) return
      const idle = Object.values(proj.members).filter((m) => m.status === 'active' && !m.currentTaskId)
      if (idle.length === 0) return
      const byRole = new Map<string, typeof idle[number]>()
      for (const member of idle) {
        if (!this.memberHandles.has(member.id)) continue
        if (now - (this.lastDispatchWakeAt.get(member.id) ?? 0) < memberCooldown) continue
        if (!byRole.has(member.roleId)) byRole.set(member.roleId, member)
      }
      const woken: string[] = []
      for (const [roleId, member] of byRole) {
        if (woken.length >= 2) break
        // 该角色当前可领任务数（claimableTasks 已含 deps 全 done + 角色匹配 + 无活跃 attempt）
        const tasks = svc.claimableTasks(roleId)
        if (tasks.length === 0) continue
        const agent = this.agentOf(this.memberHandles.get(member.id))
        if (!agent?.followup) continue
        agent.followup(this.followupMessage(`[myteam] dispatch: 有 ${tasks.length} 个与你的角色匹配的就绪任务（myteam_list_tasks → myteam_claim_task）`))
        woken.push(member.id)
        this.lastDispatchWakeAt.set(member.id, now)
      }
      if (woken.length > 0) this.lastDispatchAt.set(teamId, now)
    } catch (e) {
      this.log('warn', `dispatch sweep failed: ${String(e)}`)
    }
  }

  /* ── Lead 工具（preset 层）──────────────────────────────────── */

  private registerLeadTools(): void {
    if (!this.rt.tools) {
      throw new Error('[myteam] ctx.tools unavailable; cannot register lead tools（fail-fast，检查 preset 组合 inject）')
    }
    for (const def of leadToolDefs()) {
      const compiled = compileParameters(def)
      this.rt.tools.register({
        ...compiled,
        // 宿主 output 契约（tools.register 校验器强制）：schema 会被用于 execute 返回值校验
        output: outputForTool(def.name),
        execute: (args: Record<string, unknown>, exec: { agent?: any }) => {
          const out = this.executeLeadTool(def.name, args, exec)
          // myteam_wait_for_change 走异步长轮询；其余工具保持同步返回
          return def.name === 'myteam_wait_for_change' ? this.waitForChange(args) : out
        },
      })
    }
    this.log('info', `lead tools registered (${leadToolDefs().length})`)
  }

  /** Lead 工具 execute 分发（全部走 TeamService 单写者管线）
   *  CHG-72：面板受限写端点经此复用同一条管线，exec.actor='human' 时账本 actor 记人工
   *  （计划批准/成员操作沿用既有口径；新建/编辑任务与团队编辑从面板发起时标 human）。
   *  CHG-87：返回类型放宽为「同步结果 | Promise」——`myteam_review_task` 在 verify 门要
   *  **等待命令执行**（FR-5.3 真实退出码），宿主工具管线本来就 await 该返回值。 */
  executeLeadTool(
    name: string,
    args: Record<string, unknown>,
    exec: { agent?: any; actor?: 'lead' | 'human'; enforceTier?: boolean } = {},
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const actor = exec.actor === 'human' ? 'human' : 'lead'
    /*
     * CHG-138（docs/19 §3 / CHG-137）：**运行时门禁**——按 `canCall` 判档位。
     *
     * 为什么默认 `enforceTier:false`：H 档（批准 / 退回 / 解散 / 发布）当前**由 lead 通道代言**
     * （人审按钮 → lead 工具），宿主无法区分「人类点了按钮」与「模型自己调」——硬拦会打断审批流。
     * 所以：**成员通道硬拦**（`executeMemberTool`），lead 通道**显式开启**才拦（给未来的
     * human-intent 通道留位）。未登记工具**不改原有行为**（走 switch 默认分支）。
     */
    if (exec.enforceTier === true) {
      const tier = tierOf(name)
      const caller: ToolCaller = actor === 'human' ? 'human' : 'captain'
      if (tier && !canCall(name, caller)) {
        return {
          status: 'error',
          code: 'MT_UNAVAILABLE',
          message: `工具「${name}」是 ${tier} 档（人类专属），当前调用者（${caller}）不可调`,
        }
      }
    }
    try {
      switch (name) {
        /* CHG-186（T155c）：计划族（提交 / 批准 / 修订 / 丢弃）实现已搬到 `src/host/plan.ts`。
         * 这里只转发——逻辑/顺序/默认值一个都没改（纯结构重构，行为零变化）。 */
        case 'myteam_submit_plan':
          return this.plan.submit(teamId, args, actor)
        case 'myteam_approve_plan':
          return this.plan.approve(teamId, args, actor)
        case 'myteam_revise_plan':
          return this.plan.revise(teamId, args, actor)
        case 'myteam_discard_plan':
          return this.plan.discard(teamId, args, actor)
        /* CHG-186（T155b）：任务族**队长侧**实现已搬到 `src/host/tasks.ts`。这里只转发——逻辑/顺序/默认值一个都没改。 */
        case 'myteam_create_task':
          return this.tasks.create(teamId, args, actor)
        case 'myteam_edit_task':
          return this.tasks.edit(teamId, args, actor)
        case 'myteam_review_task':
          return this.tasks.review(teamId, args, actor)
        /* CHG-186（T155c）：团队族（编辑 / 解散 / 导出 / 导入 / 发布 / 复制 / 团队配置 /
         * 会话移交 / 考古）实现已搬到 `src/host/teams.ts`。这里只转发——逻辑/顺序/默认值
         * 一个都没改（纯结构重构，行为零变化）。 */
        case 'myteam_update_team':
          return this.teams.updateTeam(teamId, args, actor)
        /* ── CHG-73：执行期编辑闭环（重规划 / 取消 / 批量编排 / 角色删除）── */
        case 'myteam_rescope_task':
          return this.tasks.rescope(teamId, args, actor)
        case 'myteam_cancel_task':
          return this.tasks.cancel(teamId, args, actor)
        case 'myteam_delete_task': return this.tasks.deleteTask(teamId, args, actor)
        case 'myteam_batch_task_op':
          return this.tasks.batchOp(teamId, args, actor)
        /* ── CHG-76：批量建任务（从目标出草稿 → 预览 → 一次创建）── */
        case 'myteam_create_tasks':
          return this.tasks.createBatch(teamId, args, actor)
        case 'myteam_delete_role':
          return this.roles.deleteRole(args)
        case 'myteam_reassign_task':
        case 'myteam_revoke_attempt':
          // CHG-158（报告 A5）：撤权 vs 重派共用一段实现，由工具名分叉（见 tasks.ts）
          return this.tasks.revokeOrReassign(name, teamId, args, actor)
        /* CHG-186（T155b）：成员族实现已搬到 `src/host/members.ts`。这里只转发——
         * 逻辑/顺序/默认值一个都没改（纯结构重构，行为零变化）。 */
        case 'myteam_spawn_member':
          return this.members.spawn(teamId, args)
        case 'myteam_release_member':
          return this.members.release(teamId, args)
        /* CHG-187（FR-32 支柱一）：名册只读面——成员 + 派生树事实（父 / 深度 / 子成员数） */
        case 'myteam_list_members':
          return this.members.listMembers(teamId)
        case 'myteam_message':
          return this.members.message(teamId, args, actor)
        case 'myteam_interrupt':
          return this.members.interrupt(teamId, args, actor)
        case 'myteam_disband':
          return this.teams.disband(teamId, args, actor)
        case 'myteam_resolve_proposal':
          return this.plan.resolveProposal(teamId, args, actor)
        /* CHG-186（T155c）：知识族（采纳 / 提案 / 参与 / 指派）实现已搬到 `src/host/knowledge.ts`。
         * 这里只转发——逻辑/顺序/默认值一个都没改（纯结构重构，行为零变化）。 */
        case 'myteam_adopt_knowledge':
          return this.knowledge.adopt(teamId, args, actor)
        case 'myteam_propose_knowledge':
          return this.knowledge.propose(teamId, args, actor)
        case 'myteam_participate_task':
          return this.knowledge.participate(teamId, args, actor)
        case 'myteam_assign_task':
          return this.knowledge.assign(teamId, args, actor)
        /* CHG-186（T155c）：角色族（新建 / 编辑 / 删除 / 发布 / 复制 / 应用 / 项目自身角色）
         * 实现已搬到 `src/host/roles.ts`。这里只转发——逻辑/顺序/默认值一个都没改
         * （纯结构重构，行为零变化）。 */
        case 'myteam_set_project_role':
          return this.roles.setProjectRole(teamId, args, actor)
        /* CHG-134（docs/20 §5.4）：技能 / 工具资产（只写 myteam 队长预设） */
        /* CHG-186（T155c）：查询族（审计 / token / 技能 / 依赖图谱 / 团队目录 / 角色目录 /
         * 团队模板 / 插件贡献）实现已搬到 `src/host/query.ts`。这里只转发——逻辑/顺序/默认值
         * 一个都没改（纯结构重构，行为零变化）。 */
        case 'myteam_create_skill':
          return this.query.createSkill(args)
        case 'myteam_create_tool':
          return this.query.createTool(args)
        /* CHG-133（docs/20 §8）：导出 / 导入团队快照（仅队长） */
        case 'myteam_export_team':
          return this.teams.exportTeam(args)
        case 'myteam_import_team':
          return this.teams.importTeam(args)
        /* CHG-132（docs/20 §3/§5.1）：发布团队定义到全局团队库（人类专属） */
        case 'myteam_publish_team':
          return this.teams.publishTeam(args)
        /* CHG-131（docs/19 §5.2）：复制团队定义 → 新草稿（仅队长） */
        case 'myteam_copy_team':
          return this.teams.copyTeam(args)
        /* CHG-130（docs/19 §M9/§M10）：审计查询 + 会话面（移交 / 考古） */
        case 'myteam_get_audit':
          return this.query.getAudit(args)
        case 'myteam_handoff':
          return this.teams.handoff(args)
        case 'myteam_read_session':
          return this.teams.readSession(args)
        /* CHG-129（docs/19 §M10）：token / 成本只读查询（全员可读） */
        case 'myteam_get_tokens':
          return this.query.getTokens(args)
        /* CHG-128（docs/19 §M3）：可复用技能清单（全员可读） */
        case 'myteam_list_skills':
          return this.query.listSkills(args)
        /* CHG-127（docs/19 §5.3）：发布角色到全局（人类专属；单向不可逆） */
        case 'myteam_publish_role':
          return this.roles.publishRole(args)
        /* CHG-126（docs/19 §5.1）：复制角色到项目（fork；仅队长） */
        case 'myteam_copy_role':
          return this.roles.copyRole(args)
        /* CHG-125（docs/19 §M2）：写团队配置（仅队长；校验先于写 + 两段确认） */
        case 'myteam_save_team_config':
          return this.teams.saveTeamConfig(args)
        /* CHG-124（docs/19 §M6）：任务依赖图谱只读查询（全员可读） */
        case 'myteam_get_task_graph':
          return this.query.getTaskGraph(args)
        /* CHG-200：**队长读面**——只读 / 不含 attemptId / 限界读（见 `src/host/read.ts`） */
        case 'myteam_read_task':
          return this.read.readTask(teamId, args)
        case 'myteam_read_board':
          return this.read.readBoard(teamId, args)
        case 'myteam_read_knowledge_entry':
          return this.read.readKnowledgeEntry(teamId, args)
        /* CHG-123（docs/19 §M0/M2）：团队目录 + 详情（全员可读） */
        case 'myteam_list_teams':
          return this.query.listTeams(args)
        case 'myteam_get_team':
          return this.query.getTeam(args)
        /* CHG-122（docs/19 §M1）：角色目录只读视图（全员可读） */
        case 'myteam_list_roles':
          return this.query.listRoles(args)
        case 'myteam_create_role':
          return this.roles.createRole(args)
        case 'myteam_update_role':
          return this.roles.updateRole(args)
        case 'myteam_apply_roles':
          // CHG-87（FR-16.1）：单角色调用——只写 config/roles/session-defaults.json，不碰团队账本
          return this.roles.applyRoles(teamId, args, actor)
        case 'myteam_list_presets':
          return this.query.listPresets()
        // CHG-91（插件团队贡献契约 v1）：插件贡献的只读视图 + 显式重载
        case 'myteam_list_contributions':
          return this.query.listContributions()
        case 'myteam_reload_contributions':
          return this.query.reloadContributions()
        case 'myteam_save_preset':
          return this.query.savePreset(args)
        case 'myteam_copy_preset':
          return this.query.copyPreset(args)
        case 'myteam_delete_preset':
          return this.query.deletePreset(args)
        case 'myteam_reset_team_config':
          return this.teams.resetTeamConfig(teamId, args)
        default:
          return { status: 'error', code: 'MT_UNKNOWN_TOOL', message: `unknown lead tool: ${name}` }
      }
    } catch (e) {
      return { status: 'error', code: 'MT_INTERNAL', message: String(e) }
    }
  }

  private countClarifyRounds(teamId: string): number {
    return countClarifyRoundsIn(resolveTeamLedgerPath(this.workspaceRoot, teamId))
  }

  /* ── CHG-73：执行期编辑闭环（面板受限写端点与队长工具共用同一条管线）── */

  /**
   * 一次写入「负责队员 + 参与团队」（FR-29/FR-21）。
   * 任务是主实体，关系是标注——关系写失败不回滚任务，只按 warnings 显性化。
   */
  private applyTaskRelations(teamId: string, taskId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const warnings: string[] = []
    const assignees = Array.isArray(args.assignees)
      ? (args.assignees as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    if (assignees.length > 0) {
      const r = this.commit(teamId, { actor, type: 'task.assigned', payload: { teamId, taskId, memberId: assignees[0], memberIds: assignees } })
      if (r.ok) out.assigned = assignees
      else warnings.push(`assignees: ${r.message}`)
    }
    const participants = Array.isArray(args.participants) ? (args.participants as Record<string, unknown>[]) : []
    const registered: string[] = []
    for (const participant of participants) {
      const participantTeamId = String(participant?.teamId ?? '')
      if (!participantTeamId) {
        warnings.push('participants: entry without teamId skipped')
        continue
      }
      const ids = Array.isArray(participant.memberIds)
        ? (participant.memberIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      const r = this.commit(teamId, {
        actor,
        type: 'task.participate',
        payload: { teamId, taskId, participantTeamId, role: participant.role === 'lead' ? 'lead' : 'coop', ...(ids.length > 0 ? { memberIds: ids } : {}) },
      })
      if (r.ok) registered.push(participantTeamId)
      else warnings.push(`participant ${participantTeamId}: ${r.message}`)
    }
    if (registered.length > 0) out.participants = registered
    if (warnings.length > 0) out.warnings = warnings
    return out
  }

  /** 撤当前 attempt（若有）；返回 attemptId 供响应回显。 */
  private revokeAttemptIfAny(teamId: string, taskId: string, reason: string, actor: string): { ok: boolean; attemptId?: string; code?: string; message?: string } {
    const task = this.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task?.attemptId) return { ok: true }
    const attemptId = task.attemptId
    const r = this.commit(teamId, { actor, type: 'task.attempt.revoked', payload: { teamId, taskId, attemptId, reason, prevAssignee: task.assignee } })
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    return { ok: true, attemptId }
  }

  /**
   * 一键重新规划（CHG-73 / FR-31）：撤 attempt → 带结构补丁回 ready/backlog → 可选重派。
   * 与队长工具的差别只在 actor（human/lead），账本事件类型与领域校验完全一致。
   */
  private rescopeTask(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    const taskId = String(args.taskId ?? '')
    const reason = String(args.reason ?? '').trim()
    if (!taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    if (!reason) return { status: 'error', code: 'MT_VALIDATION', message: 'rescope requires a non-empty reason（为什么重新规划必须写清）' }
    const task = this.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    if (TERMINAL_STATES.has(task.state)) {
      return { status: 'error', code: 'MT_TASK_TERMINAL', message: `task "${taskId}" is ${task.state}; 终态任务不能重新规划（要重开请新建任务）` }
    }
    const patch = (isPlainObject(args.patch) ? args.patch : {}) as Record<string, unknown>
    const changes = diffTaskInput(task.input as unknown as Record<string, unknown>, patch)
    const revoked = this.revokeAttemptIfAny(teamId, taskId, reason, actor)
    if (!revoked.ok) return { status: 'error', code: revoked.code ?? 'MT_INTERNAL', message: revoked.message ?? 'revoke failed' }
    const r = this.commitGuarded(teamId, args, {
      actor,
      type: 'task.rescoped',
      payload: { teamId, taskId, patch, reason, changes, ...(typeof args.batchId === 'string' ? { batchId: args.batchId } : {}) },
    })
    if (!r.ok) {
      return { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
    }
    const after = this.service(teamId).projectionSnapshot.tasks[taskId]
    // P1-1 接线：重规划 = 新阶段（续跑）——补拍基线（只补缺失键，既有基线仍是首次快照）。
    // 新声明的产物路径在这里落哨兵，重规划之后写出来的才算「本阶段写的」。
    this.captureArtifactBaseline(teamId, taskId)
    const memberIds = Array.isArray(args.memberIds)
      ? (args.memberIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    let assigned: string[] | undefined
    if (memberIds.length > 0) {
      const relation = this.commit(teamId, { actor, type: 'task.assigned', payload: { teamId, taskId, memberId: memberIds[0], memberIds } })
      if (relation.ok) assigned = memberIds
    }
    return {
      status: 'rescoped',
      taskId,
      state: after?.state ?? 'ready',
      ...(revoked.attemptId ? { revokedAttempt: revoked.attemptId } : {}),
      ...(assigned ? { assigned } : {}),
      ...(changes.length > 0 ? { changes } : {}),
    }
  }

  /**
   * CHG-86 门禁裁决入口（review / verify / archive）→ **逐字**下沉 `core/gates/gate-execution.ts`
   * （CHG-190）。裁决口径 / 强制交叉审查 / 打回预算的语义见该文件同名函数头。
   */
  private reviewTask(
    teamId: string,
    args: Record<string, unknown>,
    actor: string,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    return this.gates.review(teamId, args, actor)
  }

  /** CHG-87 乐观锁版本收敛 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190）。 */
  private expectedRevisionOf(args: Record<string, unknown>): number | undefined {
    return this.gates.expectedRevision(args)
  }

  /** CHG-87 写范围审计 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；只认当前 attempt 的证据事件）。 */
  private scopeAuditFor(teamId: string, taskId: string): ScopeAudit | undefined {
    return this.gates.scopeAudit(teamId, taskId)
  }

  /** CHG-87 `gate:verify` 执行路径 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；只认真实退出码）。 */
  private async runVerifyGate(
    teamId: string,
    taskId: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<Record<string, unknown>> {
    return this.gates.runVerifyGate(teamId, taskId, args, actor)
  }

  /* ── P1-1 / P1-2 接线：产物基线 + 交付判定 ───────────────────────── */

  /** 产物基线落点：`.dsh-myteam/state/artifacts/<teamId>/<taskId>.json` */
  private artifactBaselinePath(teamId: string, taskId: string): string {
    // 为什么落在 `state/` 而不是 `tasks/`：基线是**可由文件事实重建**的派生数据
    // （删掉只会退化成「没拍过基线」的兼容分支），按布局契约属于 `state/`；
    // 放进入库目录会让每次 claim 都产生 git 噪音，且基线本身不该被 review/共享。
    return join(storeLayout(this.workspaceRoot).state, 'artifacts', String(teamId), `${String(taskId)}.json`)
  }

  /** 产物路径 → 绝对路径（相对工作区；绝对路径原样） */
  private resolveArtifactPath(path: string): string {
    return isAbsolute(path) ? path : join(this.workspaceRoot, path)
  }

  /** 读产物指纹（读不到 → undefined：**不要把异常抛进判定**） */
  private statArtifact(path: string): ArtifactStat | undefined {
    try {
      const stat = statSync(this.resolveArtifactPath(path))
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return undefined
    }
  }

  /** P1-1 产物基线快照 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；续跑只补缺失键）。 */
  private captureArtifactBaseline(teamId: string, taskId: string): ArtifactBaseline {
    return this.gates.captureBaseline(teamId, taskId)
  }

  /** P1-1 新鲜度判定 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；stale 的当不存在）。 */
  private artifactFreshnessFor(
    teamId: string,
    taskId: string,
    declaredPaths: readonly string[] = [],
  ): { fresh: string[]; stale: string[]; enforced: boolean } {
    return this.gates.artifactFreshness(teamId, taskId, declaredPaths)
  }

  /** 产物取文（空收尾兜底的 `docText`）→ **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；空文件跳过）。 */
  private artifactTextOf(paths: readonly string[]): string {
    return this.gates.artifactText(paths)
  }

  /** 完成回执（`task.completed.summary`）→ **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190）。 */
  private completionReplyOf(teamId: string, taskId: string): { text: string; stopReason?: string } {
    return this.gates.completionReply(teamId, taskId)
  }

  /** P1-2 交付判定 → **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；review 门留痕 / archive 门否决共用）。 */
  private deliveryJudgementFor(teamId: string, taskId: string): { judgement: DeliveryJudgement; payload: Record<string, unknown> } {
    return this.gates.deliveryJudgement(teamId, taskId)
  }

  /** archive 门落位校验（FR-10.4）→ **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；环境不可用转人工）。 */
  private evaluateArchiveGate(
    teamId: string,
    taskId: string,
    actor: string,
    declaredPaths: string[] = [],
  ): { pass: boolean; note: string; reason?: string; needsHuman?: boolean } {
    return this.gates.evaluateArchive(teamId, taskId, actor, declaredPaths)
  }

  /** 门禁自动推进（CHG-86）→ **逐字**下沉 `core/gates/gate-execution.ts`（CHG-190；archive 不是人工裁决门）。 */
  private autoEvaluateGateChain(teamId: string, taskId: string, actor: string): { advanced: boolean; note?: string } {
    return this.gates.autoEvaluate(teamId, taskId, actor)
  }

  /**
   * 取消任务（CHG-73）：撤 attempt → task.cancelled；下游按策略处理：
   *  - leave（默认）：只停本任务，下游保持原状（诊断会报「上游已取消」）；
   *  - cancel：级联取消下游传递闭包（逐条独立事件，可逐条审计/回放）。
   * 两段确认：第一次返回 impact（下游清单 + 是否有活跃 attempt），不带 confirm 不落账。
   */
  private cancelTask(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    const taskId = String(args.taskId ?? '')
    const reason = String(args.reason ?? '').trim()
    const downstream: 'leave' | 'cancel' | 'rewire' = args.downstream === 'cancel' ? 'cancel' : args.downstream === 'rewire' ? 'rewire' : 'leave'
    // CHG-75：rewire 档的新上游（缺省 = 解除依赖，让直接下游变独立任务）
    const rewireTo = typeof args.rewireTo === 'string' && args.rewireTo.length > 0 ? args.rewireTo : undefined
    if (!taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    const task = this.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    if (TERMINAL_STATES.has(task.state)) {
      return { status: 'error', code: 'MT_TASK_TERMINAL', message: `task "${taskId}" is already ${task.state}` }
    }
    if (!reason) return { status: 'error', code: 'MT_VALIDATION', message: 'cancel requires a non-empty reason（取消必须留理由）' }
    const proj = this.service(teamId).projectionSnapshot
    const dependents = downstreamOf(proj, [taskId]).filter((id) => !TERMINAL_STATES.has(proj.tasks[id]?.state ?? 'cancelled'))
    // CHG-75：rewire 只改**直接下游**（deps 里直接含本任务的）；传递下游随链条自动受益
    // CHG-76：批量取消时，同一批里自己也要被取消的任务不算"要改挂的下游"（否则会给一个即将被取消的任务改挂，纯噪音）
    const rewireSkip = new Set(Array.isArray(args.rewireSkip) ? (args.rewireSkip as unknown[]).map((id) => String(id)) : [])
    const directDependents = Object.values(proj.tasks)
      .filter((t) => !TERMINAL_STATES.has(t.state) && (t.input.deps ?? []).includes(taskId) && !rewireSkip.has(t.id))
      .map((t) => t.id)
    // 新上游合法性先判（改挂前就能告诉人"这个上游不行"，而不是先取消再失败）
    if (downstream === 'rewire' && rewireTo) {
      const upstream = proj.tasks[rewireTo]
      if (!upstream) return { status: 'error', code: 'MT_VALIDATION', message: `task "${rewireTo}" not found in this team` }
      if (rewireTo === taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'cannot rewire a task onto itself' }
      if (upstream.state === 'cancelled' || upstream.state === 'failed') {
        return { status: 'error', code: 'MT_VALIDATION', message: `task "${rewireTo}" is ${upstream.state}; 不能作为新的依赖` }
      }
    }
    // CHG-75：改挂的**预检**——先确认每个直接下游都改得动，再落"取消"这一笔。
    // （否则会出现"上游已取消、下游还挂着"的半吊子状态：取消不可逆，改挂可回滚。）
    if (downstream === 'rewire') {
      for (const id of directDependents) {
        const pre = this.service(teamId).validateRewire(proj, id, taskId, rewireTo)
        if (pre) {
          return { status: 'error', code: pre.code, message: `cannot rewire downstream "${id}": ${pre.message}` }
        }
      }
    }
    if (args.confirm !== true) {
      const strategy = downstream === 'cancel'
        ? '，将级联取消下游'
        : downstream === 'rewire'
          ? `，将把 ${directDependents.length} 个直接下游改挂到${rewireTo ? `「${rewireTo}」` : '独立任务（解除依赖）'}`
          : '，下游保持原状（诊断会提示重新编排）'
      return {
        status: 'confirm-required',
        taskId,
        impact: {
          dependents,
          hasAttempt: Boolean(task.attemptId),
          downstream,
          ...(downstream === 'rewire' ? { rewireTo, directDependents } : {}),
        },
        message: `取消「${task.input.title}」是不可逆终态（下游 ${dependents.length} 个任务）${strategy}；确认请带 confirm=true`,
      }
    }
    const revoked = this.revokeAttemptIfAny(teamId, taskId, reason, actor)
    if (!revoked.ok) return { status: 'error', code: revoked.code ?? 'MT_INTERNAL', message: revoked.message ?? 'revoke failed' }
    const r = this.commitGuarded(teamId, args, {
      actor,
      type: 'task.cancelled',
      payload: { teamId, taskId, reason, downstream, ...(typeof args.batchId === 'string' ? { batchId: args.batchId } : {}) },
    })
    if (!r.ok) {
      return { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
    }
    const cancelled: string[] = [taskId]
    if (downstream === 'cancel') {
      for (const id of dependents) {
        const current = this.service(teamId).projectionSnapshot.tasks[id]
        if (!current || TERMINAL_STATES.has(current.state)) continue
        this.revokeAttemptIfAny(teamId, id, `级联取消（上游 ${taskId}）：${reason}`, actor)
        const rc = this.commit(teamId, {
          actor,
          type: 'task.cancelled',
          payload: { teamId, taskId: id, reason: `级联取消（上游 ${taskId}）：${reason}`, downstream: 'cancel', cascadeFrom: taskId, ...(typeof args.batchId === 'string' ? { batchId: args.batchId } : {}) },
        })
        if (rc.ok) cancelled.push(id)
      }
    }
    // CHG-75：改挂——先取消本体，再逐个直接下游落 task.rewired（每条独立事件，可逐条审计/重放）。
    // 预检已保证每条都能落；真失败不吞（吞掉会让人以为改挂成功了）。
    const rewired: Array<{ taskId: string; removed: string; added?: string }> = []
    const rewireErrors: string[] = []
    if (downstream === 'rewire') {
      for (const id of directDependents) {
        const current = this.service(teamId).projectionSnapshot.tasks[id]
        if (!current || TERMINAL_STATES.has(current.state)) continue
        const rw = this.commit(teamId, {
          actor,
          type: 'task.rewired',
          payload: {
            teamId,
            taskId: id,
            removed: taskId,
            ...(rewireTo ? { added: rewireTo } : {}),
            reason: `上游 ${taskId} 被取消，改挂${rewireTo ? `到 ${rewireTo}` : '为独立任务'}：${reason}`,
            ...(typeof args.batchId === 'string' ? { batchId: args.batchId } : {}),
          },
        })
        if (rw.ok) rewired.push({ taskId: id, removed: taskId, ...(rewireTo ? { added: rewireTo } : {}) })
        else rewireErrors.push(`${id}: ${rw.message}`)
      }
    }
    return {
      status: 'cancelled',
      taskId,
      cancelled,
      downstream,
      ...(rewired.length > 0 ? { rewired } : {}),
      ...(rewireErrors.length > 0 ? { rewireErrors } : {}),
    }
  }

  /**
   * 批量编排（CHG-73）→ **逐字**下沉 `core/tasks/batch-orchestration.ts`（CHG-191）。
   * 逐条独立落账（同一 batchId）、个别失败不中断其余的口径见该文件同名函数头。
   */
  private batchTaskOp(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    return this.batchOrchestration.batchOp(teamId, args, actor)
  }

  /**
   * CHG-88（FR-11.4 / PRD 验收场景 16）：队长裁决成员的结构化提案。
   *
   * 修复前的问题：旧实现只落一条 `task.proposal.resolved` 留痕，然后回一句
   * 「批准的变更由你用既有工具执行对应操作」——**批准 split 之后子任务并不会出现**，
   * 验收场景 16（成员提交 split 提案 → 队长批准 → 子任务出现且账本
   * task.proposal→approved 关联）跑不通，提案通道等于只留了个墓碑。
   *
   * 现在：
   *  - `split` 提案：批准即**按提案载荷落子任务**（task.created 逐条，同 batchId），
   *    原任务转 cancelled 且下游按 `leave` 策略保持原状（不静默改挂——改挂要走
   *    cancelTask 的 rewire 档，提案裁决不越权做结构决策）；
   *  - `add-dep` / `reassign` / `cancel`：批准即用既有管线执行对应操作
   *    （task.updated / task.assigned / task.cancelled）；
   *  - 驳回：只留痕，不改任何结构。
   * 载荷不合规 → 拒绝并说明（不落「已批准但什么都没做」的半截状态）。
   */
  private resolveProposal(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    const proposalId = String(args.proposalId ?? '')
    const decision = String(args.decision ?? '')
    if (!proposalId) return { status: 'error', code: 'MT_VALIDATION', message: 'proposalId is required' }
    if (!['approved', 'rejected'].includes(decision)) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'decision must be approved | rejected' }
    }
    const svc = this.service(teamId)
    const proj = svc.projectionSnapshot
    const proposal = proj.proposals[proposalId]
    if (!proposal) {
      return { status: 'error', code: 'MT_VALIDATION', message: `proposal "${proposalId}" not found in ledger` }
    }
    if (proposal.status !== 'proposed') {
      return { status: 'error', code: 'MT_VALIDATION', message: `proposal "${proposalId}" already ${proposal.status}` }
    }

    // 驳回：只留痕，不动结构。
    if (decision === 'rejected') {
      const r = this.commit(teamId, { actor, type: 'task.proposal.resolved', payload: { teamId, proposalId, decision, note: args.note } })
      return r.ok
        ? { status: 'rejected', note: '提案已驳回留痕；结构未改动' }
        : { status: 'error', code: r.code, message: r.message }
    }

    // 批准：按提案类型执行对应操作。
    const type = String(proposal.type ?? '')
    const payload = (proposal.payload ?? {}) as Record<string, unknown>

    if (type === 'split') {
      return this.materializeSplitProposal(teamId, proposalId, proposal.taskId, payload, args, actor)
    }
    if (type === 'add-dep') {
      const dep = String(payload.dep ?? payload.dependency ?? '')
      if (!dep) return { status: 'error', code: 'MT_VALIDATION', message: 'add-dep 提案缺少 dep（要依赖哪个任务）' }
      if (!proj.tasks[dep]) return { status: 'error', code: 'MT_VALIDATION', message: `add-dep 提案指向不存在的任务 "${dep}"` }
      const task = proj.tasks[proposal.taskId]
      const deps = Array.isArray(task?.input.deps) ? [...(task.input.deps as string[])] : []
      if (deps.includes(dep)) return { status: 'error', code: 'MT_VALIDATION', message: `任务已依赖 "${dep}"，无需重复添加` }
      const r = this.commitGuarded(teamId, args, { actor, type: 'task.updated', payload: { teamId, taskId: proposal.taskId, patch: { deps: [...deps, dep] } } })
      if (!r.ok) return { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
      const rr = this.commit(teamId, { actor, type: 'task.proposal.resolved', payload: { teamId, proposalId, decision, note: args.note } })
      if (!rr.ok) return { status: 'error', code: rr.code, message: rr.message }
      return { status: 'approved', applied: 'add-dep', note: `已为任务添加依赖 "${dep}"` }
    }
    if (type === 'reassign') {
      const memberId = String(payload.memberId ?? payload.toMemberId ?? '')
      if (!memberId) return { status: 'error', code: 'MT_VALIDATION', message: 'reassign 提案缺少 memberId（要改派给谁）' }
      if (!proj.members[memberId]) return { status: 'error', code: 'MT_VALIDATION', message: `reassign 提案指向不存在的成员 "${memberId}"` }
      const task = proj.tasks[proposal.taskId]
      const r1 = this.commit(teamId, { actor, type: 'task.attempt.revoked', payload: { teamId, taskId: proposal.taskId, attemptId: task?.attemptId ?? 'none', reason: `reassign proposal ${proposalId} approved`, prevAssignee: task?.assignee } })
      if (!r1.ok) return { status: 'error', code: r1.code, message: r1.message }
      const r2 = this.commit(teamId, { actor, type: 'task.assigned', payload: { teamId, taskId: proposal.taskId, memberId } })
      if (!r2.ok) return { status: 'error', code: r2.code, message: r2.message }
      const rr = this.commit(teamId, { actor, type: 'task.proposal.resolved', payload: { teamId, proposalId, decision, note: args.note } })
      if (!rr.ok) return { status: 'error', code: rr.code, message: rr.message }
      return { status: 'approved', applied: 'reassign', note: `已改派给 ${memberId}` }
    }
    if (type === 'cancel') {
      const reason = String(payload.reason ?? args.note ?? 'proposal approved')
      // confirm=true 同上：队长已批准 = 不可逆动作已获授权（FR-11.4 批准才生效）。
      const cancelled = this.cancelTask(teamId, { taskId: proposal.taskId, reason, downstream: 'leave', confirm: true }, actor)
      if (cancelled.status === 'error') return cancelled
      const rr = this.commit(teamId, { actor, type: 'task.proposal.resolved', payload: { teamId, proposalId, decision, note: args.note } })
      if (!rr.ok) return { status: 'error', code: rr.code, message: rr.message }
      return { status: 'approved', applied: 'cancel', note: '任务已取消（下游保持原状）' }
    }
    return { status: 'error', code: 'MT_VALIDATION', message: `unsupported proposal type "${type}"（split / add-dep / reassign / cancel）` }
  }

  /**
   * split 提案批准 → 落子任务（PRD 验收场景 16）→ **逐字**下沉
   * `core/tasks/batch-orchestration.ts`（CHG-191）。载荷形状、「不静默造数据」与「原任务转
   * cancelled、下游保持原状」的口径见该文件同名函数头。
   */
  private materializeSplitProposal(
    teamId: string,
    proposalId: string,
    originTaskId: string,
    payload: Record<string, unknown>,
    args: Record<string, unknown>,
    actor: string,
  ): Record<string, unknown> {
    return this.batchOrchestration.materializeSplit(teamId, proposalId, originTaskId, payload, args, actor)
  }

  /** 批量建任务（CHG-76 / FR-33）→ **逐字**下沉 `core/tasks/batch-orchestration.ts`（CHG-191；`after` 前向引用按拓扑序创建）。 */
  private createTasksBatch(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    return this.batchOrchestration.createTasks(teamId, args, actor)
  }

  /**
   * 删除项目角色（CHG-73 / FR-27）：配置资产写操作，两段确认 + 占用面 + 审计行。
   * 占用面按「模板引用 / 团队在册 / 项目自身角色」三处只读扫描得出来。
   */
  private deleteRoleTool(roleId: string, confirm: boolean): Record<string, unknown> {
    const id = roleId.trim()
    if (!id) return { status: 'error', code: 'MT_VALIDATION', message: 'roleId is required' }
    const usage = roleUsage(this.workspaceRoot, id)
    if (!confirm) {
      return {
        status: 'confirm-required',
        roleId: id,
        usage: { teams: usage.teams.length, instances: usage.instances, presets: usage.presets },
        message: `删除项目角色「${id}」会移除 ${STORE_DIR}/config/roles/${id}.json（在跑成员仍用召唤时快照）；${usage.bindings.length > 0 ? `当前仍被占用：${usage.bindings.join(', ')}` : '当前未被任何团队/模板引用'}；确认请带 confirm=true`,
      }
    }
    try {
      const out = deleteProjectRoleSafe(this.rolePaths, id, { bindings: usage.bindings, actor: 'human' })
      return { status: 'deleted', roleId: id, filePath: out.filePath, auditPath: out.auditPath }
    } catch (e) {
      return this.roleError(e)
    }
  }

  /**
   * P2-1（docs/21 §6）：团队里**能产生事件**的活跃成员（`active` / `provisioning`，排除本人）。
   *
   * 为什么排除本人：等待的语义是「等**别人**的动作」——自己不会给自己发消息、也不会给自己
   * 派单，把自己算进去等于「永远有人在动」，短路永远不生效（这正是修复前空等超时的形态）。
   *
   * 为什么 `provisioning` 也算：两阶段 spawn 期间成员已落账、即将上岗，它的
   * `member.spawned(active)` 结算就是一条会到来的事件——不能因为「还没 active」就判没人。
   * 投影里 fold 会把 provisioning 折叠成 active，这里同时认两个字面量（防御旧账本）。
   */
  private activePeersOf(teamId: string, excludeMemberId: string): Array<{ id: string; roleId: string; status: string }> {
    try {
      const members = Object.values(this.service(teamId).projectionSnapshot.members)
      return members
        .filter((member) => String(member.id) !== String(excludeMemberId ?? ''))
        .filter((member) => member.status === 'active' || (member.status as string) === 'provisioning')
        .map((member) => ({ id: String(member.id), roleId: String(member.roleId), status: String(member.status) }))
    } catch (e) {
      // 读不到名册（坏账本 / 未知团队）→ 当「没有活跃 peer」：等待本来就等不到东西，
      // 立即返回并留痕，比空等 60s 再超时更诚实（也不抛错，等待工具不该炸掉成员回合）。
      this.log('warn', `active peers unavailable for ${teamId}: ${String(e)}`)
      return []
    }
  }

  /** myteam_wait_for_change：异步长轮询（修订：原实现用 Atomics.wait 在宿主主线程
   *  同步阻塞 500ms/次，最长 60s——会冻结整个 Harness 事件循环；改为 setTimeout
   *  间隔轮询，账本有新事件立即返回，失效提示语义不变（F9）。
   *
   *  P2-1（docs/21 §6）：**无活跃 peer 时立即返回** `no-active-peer`。
   *  为什么：账本只会在别人动作时出现新事件——团队里没有第二个活跃成员时，等待
   *  **在数学上**不会等到任何东西（空等 60s 纯粹浪费一次模型回合 + 一轮 token）。
   *  返回的是**可执行文案**（先看名册 → 再唤醒 → 最后才等），不是错误：
   *  成员据此先 self-service 确认名册，而不是把「没人在」当成故障。
   */
  private async waitForChange(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const sinceSeq = Number(args.sinceSeq ?? 0)
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 60000), 0), 300000)
    const ledgerPath = resolveTeamLedgerPath(this.workspaceRoot, teamId)
    const excludeMemberId = typeof args.memberId === 'string' ? args.memberId : ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { events } = readLedgerEvents(ledgerPath)
      // 已经有变化 → 先回答变化（比「没人在」更有信息量）
      const result = changeSince(events as never, sinceSeq, args.taskId ? String(args.taskId) : undefined)
      if (result.changed) {
        return { status: 'changed', changed: true, cause: result.cause, note: '失效提示：成员用 myteam_get_task/myteam_list_tasks、队长用 myteam_read_task/myteam_read_board 重新读取（不推正文）' }
      }
      // P2-1：没有活跃 peer → 等不到新事件，立即返回（不 sleep、不消耗模型回合）。
      // `status` 复用词表里的 `unavailable`（没有**可等待对象** = 本次等待不可用）；
      // 语义由 `cause: 'no-active-peer'` 承载 —— 不新增状态字面量（结果契约词表是别处的单一来源）。
      const peers = this.activePeersOf(teamId, excludeMemberId)
      if (peers.length === 0) {
        return {
          status: 'unavailable',
          changed: false,
          cause: 'no-active-peer',
          peers: [],
          hint: NO_ACTIVE_PEER_HINT,
          note: '团队里没有其他活跃成员：等待不会产生新事件。先确认名册 / 唤醒对方，再回来等',
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { status: 'timeout', changed: false }
  }

  /* ── 成员记忆审计（T21，FR-6.2/ADR-009：事后扫描，不拦截写入）── */

  auditMemberMemory(teamId: string, memberId: string, taskId?: string): { violations: number; checkedFiles: number } | null {
    const svc = this.service(teamId)
    if (svc.effectiveConfig.memory?.evidenceRequired === false) return null
    const dir = memoryDirFor(this.workspaceRoot, teamId, memberId)
    if (!existsSync(dir)) return null
    const findings: MemoryFinding[] = []
    let checkedFiles = 0
    const walk = (d: string, rel: string): void => {
      let names: string[] = []
      try {
        names = readdirSync(d)
      } catch (e) {
        this.log('warn', `memory audit readdir failed for ${memberId}/${rel}: ${String(e)}`)
        return
      }
      for (const name of names) {
        const full = [d, name].join('/')
        const relPath = rel ? `${rel}/${name}` : name
        let st: { isDirectory(): boolean }
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          walk(full, relPath)
        } else if (name.endsWith('.md')) {
          try {
            const r = auditMemoryContent(relPath, readFileSync(full, 'utf8'))
            checkedFiles += r.checkedFiles
            findings.push(...r.findings)
          } catch (e) {
            this.log('warn', `memory audit parse failed for ${memberId}/${relPath}: ${String(e)}`)
          }
        }
      }
    }
    walk(dir, '')
    if (findings.length > 0) {
      this.commit(teamId, {
        actor: 'host',
        type: 'memory.audit',
        payload: { teamId, memberId, ...(taskId ? { taskId } : {}), findings, checkedFiles, violations: findings.length },
      })
    }
    return { violations: findings.length, checkedFiles }
  }

  /* ── 成员 spawn（ADR-001：agents.create 直连 + setup 作用域）── */

  /**
   * 两阶段 spawn（P0-1）→ **逐字**下沉 `core/members/spawn-lifecycle.ts`（CHG-189）。
   *
   * 为什么「先落 provisioning 账、再建 child」、为什么同步抛错与异步 reject 必须走**同一**失败
   * 结算、为什么 `agents.create` 的 Promise 形状要先拿 handle 再结算——全在该文件同名函数头。
   *
   * 签名与调用点一个都没改（`spawnMember` 仍是 public：面板 / 队长工具 / 13 个测试直接调它）。
   */
  spawnMember(teamId: string, roleId: string, instanceName?: string, overrides: { skills?: string[]; mcpAllowlist?: string[]; parentMemberId?: string } = {}): Record<string, unknown> {
    return this.spawn.spawn(teamId, roleId, instanceName, overrides)
  }

  /**
   * 两阶段 spawn 的 **active 结算段** → **逐字**下沉 `core/members/spawn-lifecycle.ts`（CHG-189）。
   *
   * 顺序（**先投递初始 prompt、再落 active**）与「投递失败按 failed 结算并释放 child」的理由见
   * 该文件同名函数头；成员卡（CHG-135）与 handle 回填也在那里。
   */
  private settleSpawnActive(teamId: string, member: MemberInstance, handle: unknown): void {
    return this.spawn.settleActive(teamId, member, handle)
  }

  /**
   * 两阶段 spawn 的 **failed 结算段** → **逐字**下沉 `core/members/spawn-lifecycle.ts`（CHG-189）。
   *
   * `provisioning` 只有 active / failed 两个合法出口（失败不落账 = 永久 provisioning），结算被拒
   * 只告警、失败原因必须同时进日志与工具返回——见该文件同名函数头。
   */
  private settleSpawnFailure(teamId: string, member: MemberInstance, error: unknown): Record<string, unknown> {
    return this.spawn.settleFailure(teamId, member, error)
  }

  /* ── P0-1：启动对账（两阶段 spawn 的收尾）───────────────────── */

  /**
   * 启动对账（P0-1，docs/21 §6，来源官方 `types/roster.js:339-386`）。
   *
   * 为什么读**账本**而不是投影：`member.spawned{status:'provisioning'}` 在 fold 里被折叠成
   * `active`，投影区分不出「已结算」与「停在 provisioning」；账本是唯一权威〔I2〕——按 memberId
   * 取**最后一条** `member.spawned` 的 status 才是真实阶段。
   * 纪律：**对账失败不得阻断启动**（单个团队账本坏了只告警，残留 provisioning 下次再对）。
   */
  reconcileProvisioningOnBoot(): { settled: number; active: number; failed: number } {
    const summary = { settled: 0, active: 0, failed: 0 }
    const teamsDir = storeLayout(this.workspaceRoot).tasks
    let teamIds: string[] = []
    try {
      if (!existsSync(teamsDir)) return summary
      teamIds = readdirSync(teamsDir).filter((name) => existsSync(join(teamsDir, name, 'ledger.jsonl')))
    } catch (e) {
      this.log('warn', `spawn reconcile skipped (teams dir unreadable): ${String(e)}`)
      return summary
    }
    for (const teamId of teamIds) {
      try {
        // CHG-187b：先让服务打开账本（openLedger = 迁移的唯一入口），再按迁移后的载荷对账
        const { events } = readLedgerEvents(this.service(teamId).ledgerPath)
        // 每个 memberId 只认最后一条 member.spawned（同 memberId 的更新事件 = 阶段推进）
        const latest = new Map<string, Record<string, unknown>>()
        for (const event of events) {
          if (event.type !== 'member.spawned') continue
          const payload = (event.payload ?? {}) as Record<string, unknown>
          const memberId = typeof payload.memberId === 'string' ? payload.memberId : ''
          if (memberId) latest.set(memberId, payload)
        }
        const provisioning: ProvisioningMember[] = []
        for (const [memberId, payload] of latest) {
          if (payload.status !== 'provisioning') continue
          provisioning.push({ memberId, sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined, status: 'provisioning' })
        }
        if (provisioning.length === 0) continue
        const settlements: ProvisioningSettlement[] = reconcileProvisioning(provisioning, (sessionId) => this.probeProvisionedSession(sessionId))
        for (const settlement of settlements) {
          const payload = latest.get(settlement.memberId) ?? {}
          const status = settlement.action === 'settle-active' ? 'active' : 'failed'
          const result = this.commit(teamId, {
            actor: 'host',
            type: 'member.spawned',
            payload: {
              teamId,
              memberId: settlement.memberId,
              roleId: String(payload.roleId ?? ''),
              instanceName: String(payload.instanceName ?? settlement.memberId),
              sessionId: payload.sessionId,
              status,
              reason: settlement.reason,
              ...treeFieldsOf(payload as unknown as MemberInstance), // CHG-187b：派生树三字段随身份原样搬（迁移保证一定在）
            },
          })
          if (!result.ok) {
            this.log('warn', `spawn reconcile: member ${settlement.memberId} (team ${teamId}) settle(${status}) rejected: ${result.code} ${result.message}`)
            continue
          }
          summary.settled += 1
          if (status === 'active') summary.active += 1
          else summary.failed += 1
          // 结算 active 是「自愈」，failed 是「这个成员没建成」——后者必须让人看见
          this.log(status === 'active' ? 'info' : 'warn', `spawn reconcile: member ${settlement.memberId} (team ${teamId}) → ${status}: ${settlement.reason}`)
        }
      } catch (e) {
        this.log('warn', `spawn reconcile failed for team ${teamId}: ${String(e)}`)
      }
    }
    return summary
  }

  /**
   * 对账探针（纯函数 `reconcileProvisioning` 的宿主注入点）→ **逐字**下沉
   * `core/members/spawn-lifecycle.ts`（CHG-189）。
   *
   * 三条件的宿主口径（`agents.get` 拿不到 child / 未暴露 `descriptor.mode` 按 continuable /
   * 读不到事件流按 `initialPromptAccepted:false`）见该文件同名函数头。
   */
  private probeProvisionedSession(sessionId: string): ProvisioningProbeResult {
    return this.spawn.probeProvisioned(sessionId)
  }

  /**
   * 成员待投递消息数（CHG-93）→ **逐字**下沉 `core/members/spawn-lifecycle.ts`（CHG-189）。
   *
   * 为什么读账本而不是投影、为什么读不到要留痕而不是返回 0，见该文件同名函数头。
   */
  private pendingMessagesFor(teamId: string, memberId: string): number {
    return this.spawn.pendingMessages(teamId, memberId)
  }

  releaseMember(teamId: string, memberId: string, mode: string, confirm: boolean, actor = 'lead', cascade = false): Record<string, unknown> {
    const svc = this.service(teamId)
    const proj = svc.projectionSnapshot
    const member = proj.members[memberId]
    if (!member) return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" not found` }
    if (mode === 'remove' && confirm !== true) {
      return { status: 'confirm-required', message: '移除是两段确认操作（私有空间将删除），请带 confirm=true 重调' }
    }
    // 排空检查（FR-3.11）：在跑任务/待处理输入
    if (member.currentTaskId) {
      return { status: 'drain-pending', code: 'MT_DRAIN_PENDING', running: 1, note: `成员仍有在跑任务 ${member.currentTaskId}；先 revoke/reassign 或等完成` }
    }
    // CHG-187（FR-32 支柱一）：派生树排空——有子成员且未声明 cascade 时拒绝（**账本零写入**）
    const plan = guardRule(() => releaseOrder(rosterOf(proj.members), memberId, cascade))
    if (!plan.ok) return plan.result
    let memAudit: { violations: number } | undefined
    try {
      // 级联释放**全有或全无**：写前给账本留档，中途失败按快照还原（再 reload 让内存跟着退）
      runWithRollback('release-cascade', (log) => {
        if (plan.value.length > 1) snapshotFor(log, svc.ledgerPath)
        for (const id of plan.value) {
          // CHG-93：排空面**如实**记录（原实现硬编码 running:0/pending:0，「排空完成」是假的）
          const drained = { running: 0, pending: this.pendingMessagesFor(teamId, id) }
          // P1-5：释放 = 这一轮到此为止——同 interrupt，空转只能在「交出控制权」的入口补检查
          this.noteGuardTurnEnd(id)
          // 释放前记忆审计（T21：违规落 memory.audit，不阻断释放——M2 再议 hard 阻断）
          const audit = this.auditMemberMemory(teamId, id)
          if (id === memberId) memAudit = audit
          const r = this.commit(teamId, { actor, type: mode === 'archive' ? 'member.archived' : 'member.released', payload: { teamId, memberId: id, mode, reason: cascade ? 'cascade' : 'manual', drained } })
          if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code })
        }
      })
    } catch (error) {
      svc.reload() // 账本已还原 → 内存投影必须跟着退（磁盘没有、内存有 = 假成功）
      const failed = guardRule(() => { throw error })
      return failed.ok ? { status: 'error', code: 'MT_INTERNAL', message: String(error) } : failed.result
    }
    for (const id of plan.value) {
      const handle = this.memberHandles.get(id)
      if (!handle) continue
      if (mode === 'remove') {
        void handle.dispose?.()
        this.memberHandles.delete(id)
        // 成员真的没了：护栏状态随之退休（留在 Map 里会让成员 id 复用时带着旧计数）
        this.guardRecords.delete(id)
      }
      // suspend/archive：会话保留（宿主侧栏可见），仅停止领新任务
    }
    return { status: mode, ...(memAudit && memAudit.violations > 0 ? { memoryAudit: { violations: memAudit.violations, note: '释放前审计发现无证据指针的记忆条目，已落账本 memory.audit（FR-6.2）' } } : {}) }
  }

  /**
   * T27（CHG-48）：成员管理统一入口（面板 FR-14.2）——suspend/archive/remove/restore。
   * 写路径与 Lead 工具同管线，actor 标注 human（面板操作），破坏性 remove 两段确认。
   *
   * A10（CHG-163）：补 `steer`（指导）档——语义 = 发一条 `kind:'steer'` 消息并**立刻投递**：
   * ① 落 `message.sent`（`actor/from = human`）；② 投递复用 `deliverMemberMessage`（不另造格式）；
   * ③ **账本与送达分开如实回报**：没有 handle → 账本照落、`delivered:false` + `reason`
   * （把「记下来了」说成「送到了」就是假成功）。边界：`content` 空 / 成员不存在 →
   * `MT_VALIDATION`；`removed`/`archived` 是终态 → 拒绝（否则是一条永远读不到的假账）；
   * 跑任务中自动带上 `taskId`——成员要能对上「指导的是哪一单」。
   */
  memberOp(teamId: string, memberId: string, op: string, confirm: boolean, extra: { content?: unknown; taskId?: unknown; cascade?: unknown } = {}): Record<string, unknown> {
    const member = this.service(teamId).projectionSnapshot.members[memberId]
    if (!member) return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" not found` }
    switch (op) {
      case 'steer': {
        const content = typeof extra.content === 'string' ? extra.content.trim() : ''
        if (content.length === 0) {
          return { status: 'error', code: 'MT_VALIDATION', field: 'content', message: 'steer requires non-empty content' }
        }
        if (member.status === 'removed' || member.status === 'archived') {
          return {
            status: 'error',
            code: 'MT_VALIDATION',
            message: `member "${memberId}" is ${member.status}; a ${member.status} member has no live session to steer (restore it first if that was unintended)`,
          }
        }
        // 显式 taskId 优先；没给就看成员是否在跑任务（自动带上，成员才知道指导的是哪一单）
        const explicitTaskId = typeof extra.taskId === 'string' ? extra.taskId.trim() : ''
        const taskId = explicitTaskId.length > 0 ? explicitTaskId : member.currentTaskId
        const r = this.commit(teamId, {
          actor: 'human',
          type: 'message.sent',
          payload: {
            teamId,
            messageId: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
            from: 'human',
            to: memberId,
            content,
            kind: 'steer',
            ...(taskId ? { taskId } : {}),
          },
        })
        if (!r.ok) return { status: 'error', code: r.code, message: r.message }
        const delivered = this.deliverMemberMessage(memberId, 'steer', content)
        return {
          status: 'steered',
          memberId,
          delivered,
          // 未送达必须点名原因（客户端据此显示警示文案，而不是成功提示）
          ...(delivered
            ? {}
            : { reason: 'member session is offline (no live handle); the steer message is recorded in the ledger and stays readable after reconnect' }),
          ...(taskId ? { taskId } : {}),
        }
      }
      case 'suspend':
      case 'archive':
      case 'remove': {
        const already = op === 'suspend' ? 'suspended' : op === 'archive' ? 'archived' : 'removed'
        if (member.status === already) return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" is already ${already}` }
        return this.releaseMember(teamId, memberId, op, confirm, 'human', extra.cascade === true)
      }
      case 'restore': {
        if (member.status !== 'suspended' && member.status !== 'archived') {
          return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" is ${member.status}; only suspended/archived can be restored` }
        }
        const r = this.commit(teamId, { actor: 'human', type: 'member.restored', payload: { teamId, memberId } })
        return r.ok ? { status: 'restored', memberId } : { status: 'error', code: r.code, message: r.message }
      }
      default:
        return { status: 'error', code: 'MT_VALIDATION', message: `unsupported member op "${op}" (suspend|archive|remove|restore|steer)` }
    }
  }

  /* ── 成员工具 execute ──────────────────────────────────────── */

  /** 取（或初始化）某成员的护栏状态；阈值来自行 config 的 `guardOptions` */
  private guardRecordOf(memberId: string): { state: GuardState; toolsInTurn: number; lastVerdict?: GuardVerdict } {
    const key = String(memberId ?? '')
    let record = this.guardRecords.get(key)
    if (!record) {
      record = { state: createGuardState(), toolsInTurn: 0 }
      this.guardRecords.set(key, record)
    }
    return record
  }

  /** 最近一次护栏判定（面板 / 交付判定 / 测试读这一份；没触发过 → undefined） */
  guardVerdict(memberId: string): GuardVerdict | undefined {
    return this.guardRecords.get(String(memberId ?? ''))?.lastVerdict
  }

  /**
   * P1-5 接线：观测一次成员工具调用（`executeMemberTool` 的统一收口）。
   *
   * 顺序即协议：
   *  ① **回合边界**：`myteam_update_task` / `myteam_escalate_task` 意味着本回合结束——
   *     若本回合零真实动作 → `observeEmptyTurn`（只说不做）；
   *  ② **调用类判据**：`observeCall` 按 env-unavailable > repeat > stuck 顺序判（guard.ts 里
   *     就是按这个顺序写的，这里不重排）；调用类判据**优先于**空回合（前者证明本次调用已无意义）；
   *  ③ 命中 → 一条 warn（grep 锚点 `[GUARD · <kind>]`）+ 把 `{kind,message,hint}` 附在结果里
   *     （**不改变现有字段**：成员看到提醒，同时老代码照旧读 status）。
   *
   * 为什么边界工具只走空回合判据、不走 `observeCall`：`wait_for_change`/`update_task` 是
   * 常态动作（空闲等待、进度申报），把它们算进「复读/挂死」是纯噪音；而它们**也不能**
   * 清掉空回合计数（否则空转永远攒不到 2）。
   */
  private observeMemberCall(
    member: MemberInstance,
    name: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = this.guardRecordOf(String(member.memberId))
    const boundary = GUARD_TURN_BOUNDARY_TOOLS.has(name)
    let verdict: GuardVerdict | undefined
    if (boundary) {
      // 本回合一个真实动作都没有 → 空转（阈值 2：单次「只申报没动作」可能只是刚接手，连续两次才是打转）
      if (record.toolsInTurn === 0) verdict = observeEmptyTurn(record.state, this.config.guardOptions ?? {})
      record.toolsInTurn = 0
    } else {
      record.toolsInTurn += 1
      verdict = observeCall(record.state, guardCallOf(name, args, result, Date.now()), this.config.guardOptions ?? {})
    }
    if (!verdict) return result
    record.lastVerdict = verdict
    this.log('warn', guardReminder(verdict))
    return { ...result, guard: guardPayloadOf(verdict) }
  }

  /**
   * 回合结束时的空转检查（`observeMemberCall` 之外的挂点：中断 / 释放）。
   *
   * 宿主的成员通道**没有** turn 结束回调（`executeMemberTool` 每次只看一次调用），
   * 所以除了「申报类工具」这个主挂点，再在 `myteam_interrupt` / `release_member` 这两个
   * 「这一轮到此为止」的入口补一次检查——否则一个只说话不干活、被队长中断的成员永远不会被
   * 记成空转。返回判定（调用方负责 warn；没有可附的调用结果）。
   */
  private noteGuardTurnEnd(memberId: string): GuardVerdict | undefined {
    const record = this.guardRecordOf(memberId)
    const verdict = record.toolsInTurn === 0 ? observeEmptyTurn(record.state, this.config.guardOptions ?? {}) : undefined
    record.toolsInTurn = 0
    if (verdict) {
      record.lastVerdict = verdict
      this.log('warn', guardReminder(verdict))
    }
    return verdict
  }

  /**
   * 成员工具入口（P1-5 接线点）：**先执行、后观测**。
   *
   * 为什么统一包一层而不是在每个 case 里插：护栏要的是「每次工具调用的结果」，散在 9 个
   * case 里必然漏（历史上「新增工具忘了埋点」正是这类缺陷的固定形态）。包一层还顺带解决
   * 异步结果：`myteam_wait_for_change` 返回 Promise，必须在**结算之后**再观测，
   * 否则签名/输出都会是 `[object Promise]`。
   */
  executeMemberTool(member: MemberInstance, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const result = this.executeMemberToolInner(member, name, args)
    if (isThenable(result)) {
      return (result as Promise<Record<string, unknown>>).then((settled) =>
        this.observeMemberCall(member, name, args, settled ?? {}),
      ) as unknown as Record<string, unknown>
    }
    return this.observeMemberCall(member, name, args, result)
  }

  /* CHG-200：`myteam_submit_review` 在 verify 门要等命令执行（FR-5.3）——返回类型补实为
   * 「同步结果 | Promise」，与 `executeLeadTool` 同形（结算由 `executeMemberTool` 的 thenable 分支负责）。 */
  private executeMemberToolInner(member: MemberInstance, name: string, args: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
    const teamId = member.teamId
    const actor = `member:${member.memberId}`
    /* CHG-138（docs/19 §3）：**成员通道硬拦**——成员只能调 A 档工具（C5 铁律的运行时保证） */
    const tier = tierOf(name)
    if (tier && !canCall(name, 'member')) {
      return {
        status: 'error',
        code: 'MT_UNAVAILABLE',
        message: `工具「${name}」是 ${tier} 档（仅队长可调），成员不可用`,
      }
    }
    try {
      /* CHG-186（T155b）：任务族实现已搬到 `src/host/tasks.ts`（下面每个 case 只剩一行转发）。
       * 这行 `service(teamId)` **必须留着**：它是每次成员工具调用「惰性建 TeamService +
       * 冷启动重放 + 首次 bootstrap」的唯一入口——含 `myteam_read_knowledge` 与未知工具名
       * （那些 case 不读 `svc`，但侧效应照旧）。挪进各 handler 会改变 read_knowledge 的行为。 */
      const svc = this.service(teamId)
      switch (name) {
        /* CHG-186（T155b）：任务族**成员侧**实现已搬到 `src/host/tasks.ts`。这里只转发——
         * 逻辑/顺序/默认值一个都没改（纯结构重构，行为零变化）。 */
        case 'myteam_get_task':
          return this.memberTasks.get(teamId, member, args, actor)
        case 'myteam_list_tasks':
          return this.memberTasks.list(teamId, member, args, actor)
        case 'myteam_claim_task':
          return this.memberTasks.claim(teamId, member, args, actor)
        case 'myteam_update_task':
          return this.memberTasks.update(teamId, member, args, actor)
        case 'myteam_peer_message':
          return this.memberTasks.peerMessage(teamId, member, args, actor)
        case 'myteam_wait_for_change':
          return this.memberTasks.waitForChange(teamId, member, args, actor)
        case 'myteam_propose_task_change':
          return this.memberTasks.propose(teamId, member, args, actor)
        case 'myteam_escalate_task':
          return this.memberTasks.escalate(teamId, member, args, actor)
        case 'myteam_read_knowledge':
          return this.memberKnowledge.read(args)
        /* CHG-200（用户定案「任务检查应该由成员自己完成」）：成员提交门禁裁决——审查者 = 调用者。 */
        case 'myteam_submit_review':
          return this.memberTasks.submitReview(teamId, member, args, actor)
        default:
          return { status: 'error', code: 'MT_UNKNOWN_TOOL', message: `unknown member tool: ${name}` }
      }
    } catch (e) {
      return { status: 'error', code: 'MT_INTERNAL', message: String(e) }
    }
  }

  /* ── 角色目录（FR-13.1 数据面：builtin/global/project 三态并列，origin 标注）── */

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
  }> {
    return this.roleCatalog().map((entry) => ({
      origin: entry.origin,
      // CHG-91：插件来源带 pluginId（面板显示「由插件 X 提供」+ 只读徽标）
      ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
      ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
      id: entry.definition.id,
      name: entry.definition.name,
      description: entry.definition.description,
      isCaptain: entry.definition.isCaptain === true,
      interestWords: [...(entry.definition.interestWords ?? [])],
      skills: [...(entry.definition.skills ?? [])],
      mcpAllowlist: [...(entry.definition.mcpAllowlist ?? [])],
      ...(entry.definition.model ? { model: entry.definition.model } : {}),
      version: entry.definition.version ?? 1,
    }))
  }

  /* ── 团队模板管理（CHG-57）：内置只读、写项目层、两段确认；面板仍只读 ── */

  /**
   * CHG-134（docs/20 §5.4）：**创建技能**——全员可用（A 档），**只写 myteam 队长预设**。
   *
   * 隔离铁律（docs/20 §1 R2）：
   *  - 只写 `$DSH_HOME/myteam/presets/myteam-captain/skills/<skillId>/SKILL.md`；
   *  - **绝不写** `$DSH_HOME/skills/`（全局技能目录）、**绝不**污染其它预设；
   *  - 同名已存在 → 拒绝（不覆盖；改技能请先删）。
   */
  createSkillTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const skillId = String(args.skillId ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(skillId)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'skillId', message: 'skillId 必须是小写字母/数字/连字符（2~64 位）' }
    }
    const name = String(args.name ?? '').trim()
    const description = String(args.description ?? '').trim()
    if (!name || !description) {
      return { status: 'error', code: 'MT_VALIDATION', field: name ? 'description' : 'name', message: 'name / description 都必填' }
    }
    const skillsRoot = globalStoreLayout().presetSkills(TEAM_AGENT_PRESET_ID)
    const dir = join(skillsRoot, skillId)
    if (existsSync(dir)) {
      return { status: 'error', code: 'MT_ROLE_EXISTS', skillId, message: `技能「${skillId}」已存在于 myteam 队长预设（不覆盖；改技能请先删）` }
    }
    const tools = Array.isArray(args.tools) ? (args.tools as unknown[]).map((tool) => String(tool)).filter((tool) => tool.length > 0) : []
    const mcp = Array.isArray(args.mcp) ? (args.mcp as unknown[]).map((item) => String(item)).filter((item) => item.length > 0) : []
    const body = String(args.body ?? `# ${name}\n\n${description}\n`).trim()
    const frontmatter = [
      '---',
      `name: ${skillId}`,
      `description: ${JSON.stringify(description)}`,
      'version: 1',
      ...(tools.length > 0 ? [`tools: ${JSON.stringify(tools)}`] : []),
      ...(mcp.length > 0 ? [`mcp: ${JSON.stringify(mcp)}`] : []),
      '---',
      '',
      body,
      '',
    ].join('\n')
    const filePath = join(dir, 'SKILL.md')
    try {
      writeTextAtomic(filePath, frontmatter, { ensureParent: true })
    } catch (error) {
      return { status: 'error', code: 'MT_INTERNAL', skillId, message: String((error as Error | undefined)?.message ?? error) }
    }
    return {
      status: 'ok',
      skillId,
      name,
      filePath,
      presetId: TEAM_AGENT_PRESET_ID,
      note: '已写入 myteam 队长预设（仅在装载该预设的会话可见；不污染其它预设）',
    }
  }

  /**
   * CHG-134（docs/20 §5.4）：**创建工具**——全员可用（A 档），**声明式**。
   *
   * 只声明「能力 + 参数契约」，**不执行第三方代码**（docs/16 安全边界）；
   * 落点同样是 myteam 队长预设，不碰全局 `tools/`。
   */
  createToolTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const toolId = String(args.toolId ?? '').trim()
    if (!/^[a-z0-9][a-z0-9_]{1,63}$/.test(toolId)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'toolId', message: 'toolId 必须是小写字母/数字/下划线（2~64 位）' }
    }
    const name = String(args.name ?? '').trim()
    const description = String(args.description ?? '').trim()
    if (!name || !description) {
      return { status: 'error', code: 'MT_VALIDATION', field: name ? 'description' : 'name', message: 'name / description 都必填' }
    }
    const toolsRoot = join(globalStoreLayout().presets, TEAM_AGENT_PRESET_ID, 'tools')
    const filePath = join(toolsRoot, `${toolId}.json`)
    if (existsSync(filePath)) {
      return { status: 'error', code: 'MT_ROLE_EXISTS', toolId, message: `工具「${toolId}」已存在于 myteam 队长预设（不覆盖）` }
    }
    const definition = {
      version: 1,
      toolId,
      name,
      description,
      parameters: (args.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
      declarative: true,
      note: '声明式工具：只声明能力与参数契约，不执行第三方代码',
      createdAt: Date.now(),
    }
    try {
      writeTextAtomic(filePath, `${JSON.stringify(definition, null, 2)}\n`, { ensureParent: true })
    } catch (error) {
      return { status: 'error', code: 'MT_INTERNAL', toolId, message: String((error as Error | undefined)?.message ?? error) }
    }
    return {
      status: 'ok',
      toolId,
      name,
      filePath,
      presetId: TEAM_AGENT_PRESET_ID,
      note: '已写入 myteam 队长预设（声明式；不执行第三方代码）',
    }
  }

  /**
   * CHG-133（docs/20 §8）：**导出团队快照**——仅队长（C 档只读）。
   *
   * 快照是**定义 + 计数**（名册 / 名称 / 目标 / 团队层配置 / 事件数），**不含**成员会话 id、
   * 记忆、token 明细——那些是运行态，导出即泄露。
   */
  exportTeamTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const teamId = String(args.teamId ?? this.defaultTeamId()).trim()
    const dir = join(storeLayout(this.workspaceRoot).tasks, teamId)
    if (!teamId || !existsSync(dir)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'teamId', message: `团队不存在：${teamId}（先用 myteam_list_teams 看有哪些）` }
    }
    const proj = this.service(teamId).projectionSnapshot as unknown as {
      name?: string
      goal?: string
      members?: Record<string, { roleId?: string; instanceName?: string; skills?: unknown }>
    }
    const roster = Object.values(proj.members ?? {})
      .map((member) => ({
        roleId: String(member.roleId ?? ''),
        instanceName: String(member.instanceName ?? ''),
        ...(Array.isArray(member.skills) ? { skills: (member.skills as unknown[]).map((skill) => String(skill)) } : {}),
      }))
      .filter((entry) => entry.roleId.length > 0)
    let config: unknown
    const configPath = join(dir, 'team.config.json')
    try {
      if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    } catch {
      config = undefined
    }
    const eventCount = readLedgerEvents(this.service(teamId).ledgerPath).events.length
    const snapshot = {
      version: 1,
      teamId,
      name: String(proj.name ?? ''),
      goal: String(proj.goal ?? ''),
      roster,
      ...(config === undefined ? {} : { config }),
      eventCount,
      exportedAt: Date.now(),
    }
    const label = String(args.label ?? teamId).replace(/[^A-Za-z0-9._-]/g, '_')
    const exportsDir = join(storeLayout(this.workspaceRoot).history, 'exports')
    const filePath = join(exportsDir, `${label}-${Date.now()}.json`)
    const text = `${JSON.stringify(snapshot, null, 2)}\n`
    try {
      writeTextAtomic(filePath, text, { ensureParent: true })
    } catch (error) {
      return { status: 'error', code: 'MT_INTERNAL', teamId, message: String((error as Error | undefined)?.message ?? error) }
    }
    return {
      status: 'ok',
      teamId,
      filePath,
      bytes: Buffer.byteLength(text, 'utf8'),
      counts: { roster: roster.length, events: eventCount, hasConfig: config !== undefined },
      note: '快照只含团队定义 + 计数（不含会话 id / 记忆 / token 明细）',
    }
  }

  /**
   * CHG-133（docs/20 §8）：**导入团队快照**——仅队长（C 档写；**新 id，永不覆盖**）。
   *
   * 导入 = 建**新草稿团队**（走 `submit_plan` staging + `approve_plan` 人审）；
   * 快照里的 `teamId` 只作 `sourceTeamId` 溯源；任务 / 账本 / 会话不导入。
   */
  async importTeamTool(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const raw = String(args.filePath ?? '').trim()
    if (!raw) return { status: 'error', code: 'MT_VALIDATION', field: 'filePath', message: 'filePath is required' }
    const filePath = /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw : join(this.workspaceRoot, raw)
    if (!existsSync(filePath)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'filePath', message: `快照文件不存在：${filePath}` }
    }
    let snapshot: { version?: unknown; teamId?: unknown; name?: unknown; goal?: unknown; roster?: unknown }
    try {
      snapshot = JSON.parse(readFileSync(filePath, 'utf8')) as typeof snapshot
    } catch (error) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'filePath', message: `快照不是合法 JSON：${String((error as Error | undefined)?.message ?? error)}` }
    }
    if (Number(snapshot.version) !== 1) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'version', message: `不支持的快照版本：${String(snapshot.version)}（期望 1）` }
    }
    if (!Array.isArray(snapshot.roster)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'roster', message: '快照缺少 roster 数组' }
    }
    const roster = (snapshot.roster as { roleId?: unknown; instanceName?: unknown; skills?: unknown }[])
      .map((entry) => ({
        roleId: String(entry?.roleId ?? ''),
        instanceName: String(entry?.instanceName ?? ''),
        ...(Array.isArray(entry?.skills) ? { skills: (entry.skills as unknown[]).map((skill) => String(skill)) } : {}),
      }))
      .filter((entry) => entry.roleId.length > 0)
    if (roster.length === 0) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'roster', message: '快照名册为空（至少需要队长角色）' }
    }
    const captainRoleId = this.roleCatalog()
      .map((entry) => entry.definition as unknown as { id?: string; isCaptain?: boolean })
      .find((definition) => definition.isCaptain === true)?.id
    if (captainRoleId && !roster.some((entry) => entry.roleId === String(captainRoleId))) {
      roster.push({ roleId: String(captainRoleId), instanceName: 'captain' })
    }
    /* 名称必须唯一（同一团队名会撞 MT_TEAM_STATE）：显式 name 优先，否则「源名+导入+短时间戳」 */
    const name = String(args.name ?? `${String(snapshot.name || snapshot.teamId || '团队')}（导入-${Date.now().toString(36)}）`).trim()
    const staged = await this.executeLeadTool('myteam_submit_plan', { teamName: name, goal: String(snapshot.goal ?? ''), roster, tasks: [] }, {}) as unknown as Record<string, unknown>
    if (String(staged.status) !== 'staged') {
      return { status: 'error', code: typeof staged.code === 'string' ? staged.code : 'MT_INTERNAL', message: String(staged.message ?? '导入失败'), filePath }
    }
    return {
      status: 'ok',
      teamId: String(staged.teamId ?? ''),
      sourceTeamId: String(snapshot.teamId ?? ''),
      sourceFile: filePath,
      name,
      rosterCount: roster.length,
      note: '已导入为新草稿团队（新 id，永不覆盖）；任务 / 账本 / 会话不导入',
    }
  }

  /**
   * CHG-132（docs/20 §3/§5.1）：**发布团队定义到全局团队库**——人类专属（H 档）。
   *
   * 语义（docs/20 §5.1 定案）：
   *  - 只发布**定义**：名册（roleId + 实例名 + 成员级 skills）、名称、目标、团队层配置；
   *  - **不发布**运行态：账本 / 任务 / attempt / 门禁结果 / 成员会话 id / token 计量；
   *  - 全局已有同 `teamId` → 先回 `confirm-required`（`impact.exists:true`），`confirm:true` 才覆盖；
   *  - **单向不可逆**（快照语义：已复制出去的团队不受影响）。
   */
  async publishTeamTool(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const teamId = String(args.teamId ?? '').trim()
    if (!teamId) return { status: 'error', code: 'MT_VALIDATION', field: 'teamId', message: 'teamId is required' }
    const dir = join(storeLayout(this.workspaceRoot).tasks, teamId)
    if (!existsSync(dir)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'teamId', message: `团队不存在：${teamId}（先用 myteam_list_teams 看有哪些）` }
    }
    const proj = this.service(teamId).projectionSnapshot as unknown as {
      name?: string
      goal?: string
      members?: Record<string, { roleId?: string; instanceName?: string; skills?: unknown }>
    }
    const global = globalStoreLayout()
    const filePath = global.teamFile(teamId)
    const exists = existsSync(filePath)
    if (exists && args.confirm !== true) {
      return {
        status: 'confirm-required',
        teamId,
        impact: { exists: true, path: filePath },
        message: '全局团队库已有同 teamId 的定义：确认覆盖请带 confirm:true 重调（发布单向不可逆）',
      }
    }
    /* 团队层配置（存在才带上；不存在就只发布名册——不造空配置） */
    let config: unknown
    const configPath = join(dir, 'team.config.json')
    try {
      if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    } catch {
      config = undefined
    }
    const roster = Object.values(proj.members ?? {})
      .map((member) => ({
        roleId: String(member.roleId ?? ''),
        instanceName: String(member.instanceName ?? ''),
        ...(Array.isArray(member.skills) ? { skills: (member.skills as unknown[]).map((skill) => String(skill)) } : {}),
      }))
      .filter((entry) => entry.roleId.length > 0)
    const definition = {
      version: 1,
      teamId,
      name: String(proj.name ?? ''),
      goal: String(proj.goal ?? ''),
      roster,
      ...(config === undefined ? {} : { config }),
      origin: 'project-copy' as const,
      updatedAt: Date.now(),
    }
    try {
      writeTextAtomic(filePath, `${JSON.stringify(definition, null, 2)}\n`, { ensureParent: true })
    } catch (error) {
      return { status: 'error', code: 'MT_INTERNAL', teamId, message: String((error as Error | undefined)?.message ?? error) }
    }
    return {
      status: 'ok',
      teamId,
      filePath,
      action: exists ? 'updated' : 'created',
      rosterCount: roster.length,
      note: '已发布团队定义到全局库（只含名册/配置/目标；账本/任务/会话不发布）',
    }
  }

  /**
   * CHG-131（docs/19 §5.2）：**复制团队定义 → 新草稿团队**——仅队长（C 档）。
   *
   * 语义（docs/19 §5.2 定案 B：只复制「团队定义」，不复制运行态）：
   *  - **复制**：名册（roleId + 实例名）、名称、目标；
   *  - **不复制**：账本事件（唯一权威，复制即分叉）、任务 / attempt / 门禁结果、
   *    成员会话 id / 记忆 / token 计量、团队 id（新 id；旧 id 只作 `sourceTeamId` 溯源）；
   *  - 产物是 **`draft` 团队**（staging）——走 `approve_plan` 人审才 active（FR-1.1）。
   *
   * 为什么走 `submit_plan` 而不是直接建目录：团队是「计划批准后才存在的实体」，
   * 复制来的团队若直接 active 就等于绕过人审。
   */
  async copyTeamTool(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sourceTeamId = String(args.sourceTeamId ?? '').trim()
    if (!sourceTeamId) return { status: 'error', code: 'MT_VALIDATION', field: 'sourceTeamId', message: 'sourceTeamId is required' }
    const dir = join(storeLayout(this.workspaceRoot).tasks, sourceTeamId)
    if (!existsSync(dir)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'sourceTeamId', message: `团队不存在：${sourceTeamId}（先用 myteam_list_teams 看有哪些）` }
    }
    const proj = this.service(sourceTeamId).projectionSnapshot as unknown as {
      name?: string
      goal?: string
      members?: Record<string, { roleId?: string; instanceName?: string }>
    }
    const sourceName = String(proj.name ?? sourceTeamId)
    const name = String(args.name ?? `${sourceName}（副本）`).trim()
    const goal = String(args.goal ?? proj.goal ?? '')
    const roster = Object.values(proj.members ?? {})
      .map((member) => ({ roleId: String(member.roleId ?? ''), instanceName: String(member.instanceName ?? '') }))
      .filter((entry) => entry.roleId.length > 0)
    /* 名册必须恰好一个队长角色（submit_plan 硬校验 MT_ROSTER_NO_CAPTAIN）：源名册缺队长时补上 */
    const captainRoleId = this.roleCatalog()
      .map((entry) => entry.definition as unknown as { id?: string; isCaptain?: boolean })
      .find((definition) => definition.isCaptain === true)?.id
    if (captainRoleId && !roster.some((entry) => entry.roleId === String(captainRoleId))) {
      roster.push({ roleId: String(captainRoleId), instanceName: 'captain' })
    }
    const staged = await this.executeLeadTool('myteam_submit_plan', { teamName: name, goal, roster, tasks: [] }, {}) as unknown as Record<string, unknown>
    if (String(staged.status) !== 'staged') {
      return {
        status: 'error',
        code: typeof staged.code === 'string' ? staged.code : 'MT_INTERNAL',
        message: String(staged.message ?? '复制团队失败'),
        sourceTeamId,
      }
    }
    return {
      status: 'ok',
      teamId: String(staged.teamId ?? ''),
      sourceTeamId,
      name,
      rosterCount: roster.length,
      note: '已复制团队定义（名册 + 名称/目标）为新草稿；账本 / 任务 / 成员会话不复制（批准后由新队长重新规划）',
    }
  }

  /**
   * CHG-130（docs/19 §M10）：**审计事件流只读查询**——队长 + 显式授权成员（CM 档）。
   *
   * 为什么必须有：面板有 `getAudit` 端点，但模型侧没有工具——无法自审「我做过什么」
   * （docs/19 §M10 缺口）。返回按 `seq` 倒序取最近 N 条，`nextBeforeSeq` 用于往前翻页。
   *
   * 只读：不写账本、不 fold；坏行容错（`readLedgerEvents` 已跳过坏行）。
   */
  getAuditTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const rawLimit = Number(args.limit ?? 50)
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50, 1), 200)
    const beforeSeq = Number.isFinite(Number(args.beforeSeq)) ? Number(args.beforeSeq) : undefined
    const svc = this.service(teamId)
    const all = readLedgerEvents(svc.ledgerPath).events as unknown as { seq?: number; type?: string; actor?: string; ts?: number }[]
    const filtered = beforeSeq === undefined ? all : all.filter((event) => Number(event.seq ?? 0) < beforeSeq)
    const slice = filtered.slice(-limit)
    return {
      status: 'ok',
      teamId,
      total: all.length,
      count: slice.length,
      events: slice.map((event) => ({
        seq: Number(event.seq ?? 0),
        type: String(event.type ?? ''),
        actor: String(event.actor ?? ''),
        ts: Number(event.ts ?? 0),
      })),
      nextBeforeSeq: slice.length > 0 ? Number(slice[0].seq ?? 0) : null,
      note: '只读审计事件流（按 seq 倒序取最近 N 条；nextBeforeSeq 用于往前翻页）',
    }
  }

  /**
   * CHG-129（docs/19 §M10）：**token / 成本只读查询**——全员可读（A 档）。
   *
   * 口径（CHG-86 §P0-3）：`days` 是**按天增量桶**——基线 = 成员累计量（冷启动从
   * `tokens.json.totals` 恢复），本次累计 − 基线 = 增量记到当天；重复读不改变结果，
   * 也不会写负数（累计量回退时只重置基线）。
   *
   * **估算标注**：tokenMeter 给的是估算值，不是账单——返回里不放任何「金额」字段。
   */
  getTokensTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const tokens = this.syncTokens(teamId)
    return { status: 'ok', teamId, tokens }
  }

  /**
   * CHG-128（docs/19 §M3）：**可复用技能清单**——全员可读（A 档）。
   *
   * 口径（docs/19 §1 R1：项目管到「角色」为止）：
   *  - 技能是**外部资产**（宿主 `skills` 服务 / 插件贡献 / `DSH_HOME/skills`），本项目只维护
   *    「角色绑定了哪些」——所以这一条的首要数据是**角色目录里的 `skills` 声明**（去重 + 绑定者）；
   *  - 宿主技能服务**可用就并进来**（`host.available:true` + 清单）；拿不到就**如实标不可用**
   *    并给 `note`，**绝不伪造一份假清单**（docs/19 §6 第 8 条）。
   */
  listSkillsTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const withRoles = args.withRoles !== false
    const declared = new Map<string, { roleId: string; origin: string }[]>()
    for (const entry of this.roleCatalog()) {
      const definition = entry.definition as unknown as { id?: string; skills?: unknown }
      const skills = Array.isArray(definition.skills) ? definition.skills : []
      for (const skill of skills) {
        const name = String(skill ?? '').trim()
        if (!name) continue
        const bucket = declared.get(name) ?? []
        bucket.push({ roleId: String(definition.id ?? ''), origin: String(entry.origin) })
        declared.set(name, bucket)
      }
    }
    const names = [...declared.keys()].sort((a, b) => a.localeCompare(b))
    /* 宿主技能服务（可选能力）：有就用，没有就诚实标不可用 */
    let host: Record<string, unknown> = { available: false }
    try {
      const service = (this.rt as unknown as { skills?: { list?: () => unknown } })?.skills
      if (service && typeof service.list === 'function') {
        const raw = service.list()
        const skills = (Array.isArray(raw) ? raw : []).map((item) => {
          const record = (item ?? {}) as { name?: unknown; id?: unknown; description?: unknown }
          return {
            name: String(record.name ?? record.id ?? ''),
            ...(typeof record.description === 'string' && record.description.length > 0 ? { description: record.description } : {}),
          }
        }).filter((item) => item.name.length > 0)
        host = { available: true, skills }
      }
    } catch {
      host = { available: false }
    }
    return {
      status: 'ok',
      total: names.length,
      declared: withRoles ? names.map((name) => ({ name, boundBy: declared.get(name) ?? [] })) : names,
      host,
      ...(host.available === true ? {} : { note: '宿主未暴露 skills 服务：这里只列「角色已绑定」的技能名；可复用资产的权威清单以宿主为准（不伪造）' }),
    }
  }

  /**
   * CHG-127（docs/19 §5.3）：**发布角色到全局库**——人类专属（H 档）。
   *
   * 语义（docs/19 §5.3 定案）：
   *  - 只发布**项目库**里的角色（内置/插件只读，由写层守门；项目库缺失 → `MT_ROLE_NOT_FOUND`）；
   *  - **单向不可逆**：全局库那份不会回流到任何项目副本（快照语义）；
   *  - 全局已有同名角色 → 先回 `confirm-required`（带影响面），`confirm:true` 才覆盖；
   *  - 审计记 `actor:'human'`（发布是人类动作，不是模型自选）。
   */
  publishRoleTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const roleId = String(args.roleId ?? '').trim()
    if (!roleId) return { status: 'error', code: 'MT_VALIDATION', field: 'roleId', message: 'roleId is required' }
    const entry = this.roleCatalog().find((item) => String(item.definition.id) === roleId && String(item.origin) === 'project')
    if (!entry) {
      return { status: 'error', code: 'MT_ROLE_NOT_FOUND', roleId, message: `项目库没有角色「${roleId}」（内置/插件角色只读，先 myteam_copy_role 复制进项目再改）` }
    }
    const existsGlobally = this.roleCatalog().some((item) => String(item.definition.id) === roleId && String(item.origin) === 'global')
    const confirm = args.confirm === true
    if (existsGlobally && !confirm) {
      return {
        status: 'confirm-required',
        roleId,
        impact: { exists: true, note: '全局库已有同名角色；发布将覆盖它（单向、不可逆）' },
        message: '全局库已有同名角色：确认覆盖请带 confirm:true 重调（发布单向不可逆）',
      }
    }
    try {
      const result = saveGlobalRole(this.rolePaths, entry.definition, { overwrite: existsGlobally, actor: 'human' })
      return {
        status: 'ok',
        roleId,
        action: result.action,
        filePath: result.filePath,
        auditPath: result.auditPath,
        note: '已发布到全局库（单向；已复制出去的副本不受影响）',
      }
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      return {
        status: 'error',
        code: typeof code === 'string' && code.length > 0 ? code : 'MT_INTERNAL',
        roleId,
        message: String((error as Error | undefined)?.message ?? error),
      }
    }
  }

  /**
   * CHG-126（docs/19 §5.1）：**复制角色到项目**（fork）——仅队长（C 档）。
   *
   * 语义（docs/19 §5.1 定案）：
   *  - 复制 **定义**（prompt / 职责 / toolPolicy / skills / model），`origin` 保留来源标记；
   *  - **不复制**在册成员（成员在团队里，不随角色走）；
   *  - 产物是项目库一份**可改**副本（运行时只认项目库）。
   *
   * 只写项目库：不碰全局库、不写团队账本（角色是配置单元，不是团队事件）。
   */
  copyRoleTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const roleId = String(args.roleId ?? '').trim()
    if (!roleId) return { status: 'error', code: 'MT_VALIDATION', field: 'roleId', message: 'roleId is required' }
    const entry = this.roleCatalog().find((item) => String(item.definition.id) === roleId)
    if (!entry) {
      return { status: 'error', code: 'MT_ROLE_NOT_FOUND', roleId, message: `角色不存在：${roleId}（先用 myteam_list_roles 看有哪些）` }
    }
    if (String(entry.origin) === 'project') {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        field: 'roleId',
        roleId,
        message: `${roleId} 已在项目库（可改）；改它请用 myteam_update_role，不要自复制`,
      }
    }
    const source = String(args.source ?? entry.origin)
    try {
      const { filePath } = copyToProject(this.rolePaths, roleId, source as never, this.contributionCatalog.roles)
      return { status: 'ok', roleId, source: String(entry.origin), filePath, note: '已复制到项目库（可改；origin 保留来源标记）' }
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      return {
        status: 'error',
        code: typeof code === 'string' && code.length > 0 ? code : 'MT_INTERNAL',
        roleId,
        message: String((error as Error | undefined)?.message ?? error),
      }
    }
  }

  /**
   * CHG-125（docs/19 §M2）：**写团队配置**——仅队长（C 档）。
   *
   * 薄封装：写路径全在 `saveTeamConfig(teamId, args)`（CHG-117：校验先于写 → 影响面 →
   * 原子写 → 重建 TeamService → 返回生效配置；未知键保留）。这一条只是把「缺省 teamId」
   * 补上并暴露给模型——设置页与工具必须**同一条写路径**，否则两处校验会分叉。
   */
  saveTeamConfigTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    return this.saveTeamConfig(teamId, args)
  }

  /**
   * CHG-124（docs/19 §M6）：**任务依赖图谱只读查询**——全员可读（A 档）。
   *
   * 为什么必须有：依赖是**写**（`create_task.deps` / `edit_task` / `rescope_task`），
   * 但模型此前只能拿 `deps` 数组手算拓扑——无法判断「哪些能并行」「有没有环」。
   * 这一条把图谱视图（面板 `getBoard().graph` 同源）暴露给模型。
   *
   * 口径：
   *  - `edges`: `from` = 被依赖（前置），`to` = 依赖它的（后继）——与 `deps` 语义一致；
   *  - `layers`: 拓扑层级（Kahn 分层，同层可并行；**只含无环部分**）；
   *  - `cycles`: 环（Kahn 剩余节点 + 其可达边）——有环时 `hasCycle:true`，`layers` 不完整；
   *  - **只读**：不写账本、不改任何任务。
   */
  getTaskGraphTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const tasks = Object.values(this.service(teamId).projectionSnapshot.tasks ?? {}) as unknown as {
      id: string
      state: string
      input?: { title?: string; priority?: string; requiredRole?: string; deps?: string[] }
    }[]
    /* 分层/环检测在纯函数里（`core/scheduler/task-graph.ts`）——可脱团队单测 */
    const graph = buildTaskGraph(tasks.map((task) => ({
      id: String(task.id),
      title: String(task.input?.title ?? ''),
      state: String(task.state),
      priority: String(task.input?.priority ?? ''),
      requiredRole: String(task.input?.requiredRole ?? ''),
      deps: (task.input?.deps ?? []).map((dep) => String(dep)),
    })))
    return { status: 'ok', teamId, ...graph }
  }

  /**
   * CHG-123（docs/19 §M0/M2）：**团队目录**——全员可读（A 档）。
   *
   * 数据源 = 工作区索引（`readWorkspaceIndex`，CHG-91 的团队索引落点）+ 归档目录名。
   * 为什么不用 `agents.list()`：那是**活的** agent 列表（门面通道），Lead 工具没有 agent
   * 上下文，且「有哪些团队」问的是磁盘事实而不是进程内对象。
   *
   * 只读：不写索引、不写账本、不 fold 任何团队。
   */
  listTeamsTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const state = String(args.state ?? 'all')
    const includeArchived = args.includeArchived !== false
    const index = readWorkspaceIndex(this.workspaceRoot) as unknown as {
      workspaceRoot?: string
      teams?: Record<string, unknown>[]
    } | undefined
    const teams = (index?.teams ?? []).map((entry) => ({
      teamId: String(entry.teamId ?? ''),
      name: String(entry.name ?? ''),
      goal: String(entry.goal ?? ''),
      state: String(entry.state ?? ''),
      tasks: Number(entry.tasks ?? entry.taskCount ?? 0),
    })).filter((team) => team.teamId.length > 0)
    const filtered = state === 'all' ? teams : teams.filter((team) => team.state === state)
    const archived = includeArchived ? this.archiveList() : { teams: [] as string[] }
    return {
      status: 'ok',
      workspaceRoot: this.workspaceRoot,
      state,
      total: filtered.length,
      teams: filtered,
      ...(includeArchived ? { archived: { count: archived.teams.length, ids: archived.teams } } : {}),
      /* 口径：索引为空 ≠ 没有团队（可能从未扫描）——如实说明，不让调用方误判 */
      ...(index === undefined ? { note: '工作区索引尚未生成（团队从未被扫描过）；团队列表可能不完整' } : {}),
    }
  }

  /**
   * CHG-123（docs/19 §M2）：**团队详情**——全员可读（A 档）。
   *
   * 只读投影：名 / 目标 / 状态 / 计数 / 名册摘要。不存在 → `MT_VALIDATION`（`field:'teamId'`），
   * **不返回空对象假装成功**（docs/19 §6 第 8 条）。
   */
  getTeamTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const teamId = String(args.teamId ?? '').trim()
    if (!teamId) return { status: 'error', code: 'MT_VALIDATION', field: 'teamId', message: 'teamId is required' }
    const dir = join(storeLayout(this.workspaceRoot).tasks, teamId)
    if (!existsSync(dir)) {
      return { status: 'error', code: 'MT_VALIDATION', field: 'teamId', message: `团队不存在：${teamId}（先用 myteam_list_teams 看有哪些团队）` }
    }
    const proj = this.service(teamId).projectionSnapshot as unknown as {
      name?: string
      goal?: string
      state?: string
      tasks?: Record<string, { state?: string }>
      members?: Record<string, { id?: string; roleId?: string; instanceName?: string; status?: string; currentTaskId?: string }>
    }
    const tasks = Object.values(proj.tasks ?? {})
    const members = Object.values(proj.members ?? {}).map((member) => ({
      id: String(member.id ?? ''),
      roleId: String(member.roleId ?? ''),
      instanceName: String(member.instanceName ?? ''),
      status: String(member.status ?? ''),
      ...(member.currentTaskId ? { currentTaskId: String(member.currentTaskId) } : {}),
    }))
    return {
      status: 'ok',
      teamId,
      name: String(proj.name ?? ''),
      goal: String(proj.goal ?? ''),
      state: String(proj.state ?? ''),
      counts: {
        tasks: tasks.length,
        done: tasks.filter((task) => task.state === 'done').length,
        running: tasks.filter((task) => task.state === 'in_progress').length,
        members: members.length,
      },
      members,
    }
  }

  /**
   * CHG-122（docs/19 §M1）：**角色目录只读视图**——全员可读（A 档）。
   *
   * 为什么必须有：`myteam_create_role` / `spawn_member` 都要求填 `roleId`，
   * 但此前**没有任何工具能列出有哪些角色**——模型只能猜 id 或靠用户贴。
   * 这一条补上「先看得见，才谈聘任 / 复制 / 改」。
   *
   * 只读：不写库、不改任何角色定义、不产生账本事件。
   */
  listRolesTool(args: Record<string, unknown> = {}): Record<string, unknown> {
    const scope = String(args.scope ?? 'all')
    const includeSkills = args.includeSkills === true
    let entries = this.roleCatalog()
    if (scope !== 'all') entries = entries.filter((entry) => String(entry.origin) === scope)
    const roles = entries.map((entry) => {
      const definition = entry.definition as unknown as {
        id?: string
        name?: string
        description?: string
        isCaptain?: boolean
        skills?: string[]
      }
      const origin = String(entry.origin)
      return {
        id: String(definition.id ?? ''),
        name: String(definition.name ?? definition.id ?? ''),
        description: String(definition.description ?? ''),
        origin,
        /* 内置与插件贡献只读（想改先复制到项目，docs/19 §5.1） */
        readOnly: origin === 'builtin' || origin === 'plugin',
        ...(definition.isCaptain ? { isCaptain: true } : {}),
        ...(includeSkills && Array.isArray(definition.skills) ? { skills: definition.skills.map((skill) => String(skill)) } : {}),
      }
    })
    return { status: 'ok', scope, total: roles.length, roles }
  }

  /** 模板目录（队长选模板用；不写盘） */
  listPresetsTool(): Record<string, unknown> {
    const catalog = this.presetCatalog()
    return {
      status: 'ok',
      dirs: catalog.dirs,
      warnings: catalog.warnings,
      presets: catalog.entries.map(({ origin, definition }) => ({
        id: definition.id,
        name: definition.name,
        origin,
        description: definition.description ?? '',
        memberCount: definition.members.length,
        members: definition.members.map((member) => ({
          roleId: member.roleId,
          ...(member.instanceName ? { instanceName: member.instanceName } : {}),
          ...(member.skills ? { skills: member.skills } : {}),
          ...(member.mcpAllowlist ? { mcpAllowlist: member.mcpAllowlist } : {}),
        })),
        ...(definition.board?.columns ? { boardColumns: definition.board.columns } : {}),
        ...(definition.taskTypes ? { taskTypes: Object.keys(definition.taskTypes) } : {}),
        readOnly: origin === 'builtin',
      })),
      note: '用 myteam_submit_plan({presetId}) 应用模板；内置模板只读，可 myteam_copy_preset 复制成新 id 再改。',
    }
  }

  /** 创建/更新项目模板（内置 id 拒写；已存在需 overwrite=true） */
  savePreset(args: Record<string, unknown>): Record<string, unknown> {
    const validated = validatePresetDefinition(args.preset)
    if ('errors' in validated) return { status: 'error', code: 'MT_VALIDATION', message: validated.errors.join('; ') }
    const unknownRoles = validated.members
      .map((member) => member.roleId)
      .filter((roleId) => !this.roleCatalog().some((entry) => entry.definition.id === roleId))
    if (unknownRoles.length > 0) {
      return { status: 'error', code: 'MT_VALIDATION', message: `unknown role(s) in preset: ${[...new Set(unknownRoles)].join(', ')}` }
    }
    const existing = readProjectPreset(this.workspaceRoot, validated.id)
    if (existing && args.overwrite !== true) {
      return {
        status: 'confirm-required',
        code: 'MT_PRESET_EXISTS',
        message: `preset "${validated.id}" already exists (version ${existing.version ?? 1}); 覆盖是两段确认操作，请带 overwrite=true 重调`,
      }
    }
    const definition = { ...validated, version: existing ? (existing.version ?? 1) + 1 : 1 }
    const written = writeProjectPreset(this.workspaceRoot, definition, { overwrite: args.overwrite === true })
    if (!written.ok) return { status: 'error', code: written.code, message: written.message }
    return {
      status: written.created ? 'created' : 'updated',
      presetId: definition.id,
      version: definition.version,
      presetPath: `${STORE_DIR}/config/teams/${definition.id}.json`,
      note: written.created ? '模板已创建；用 myteam_submit_plan({presetId}) 应用' : '模板已更新（版本 +1）；已建团队不受影响',
    }
  }

  /** 复制/fork 模板：内置或项目 → 新项目模板 */
  copyPreset(args: Record<string, unknown>): Record<string, unknown> {
    const fromId = String(args.fromPresetId ?? '')
    const toId = String(args.toPresetId ?? '')
    const source = this.presetCatalog().entries.find((entry) => entry.definition.id === fromId)
    if (!source) return { status: 'error', code: 'MT_PRESET_NOT_FOUND', message: `preset "${fromId}" not found (builtin/project)` }
    if (BUILTIN_PRESET_IDS.has(toId)) {
      return { status: 'error', code: 'MT_PRESET_BUILTIN', message: `target id "${toId}" is a builtin preset (read-only); choose another id` }
    }
    const definition = {
      ...structuredClone(source.definition),
      id: toId,
      name: args.name ? String(args.name) : `${source.definition.name} 副本`,
      version: 1,
    }
    const written = writeProjectPreset(this.workspaceRoot, definition, { overwrite: false })
    if (!written.ok) return { status: 'error', code: written.code, message: written.message }
    return {
      status: 'copied',
      presetId: toId,
      fromPresetId: fromId,
      presetPath: `${STORE_DIR}/config/teams/${toId}.json`,
      note: '已复制成项目模板；改它不影响来源模板，用 myteam_submit_plan({presetId}) 应用',
    }
  }

  /** 删除项目模板（内置拒删；confirm 两段确认） */
  deletePreset(args: Record<string, unknown>): Record<string, unknown> {
    const presetId = String(args.presetId ?? '')
    if (BUILTIN_PRESET_IDS.has(presetId)) {
      return { status: 'error', code: 'MT_PRESET_BUILTIN', message: `preset "${presetId}" is builtin (read-only); it cannot be deleted` }
    }
    if (args.confirm !== true) {
      return { status: 'confirm-required', message: `删除模板「${presetId}」是两段确认操作（已建团队不受影响），请带 confirm=true 重调` }
    }
    const deleted = deleteProjectPreset(this.workspaceRoot, presetId)
    if (!deleted) return { status: 'error', code: 'MT_PRESET_NOT_FOUND', message: `project preset "${presetId}" not found` }
    return { status: 'deleted', presetId, note: '仅删除模板文件；已建团队的配置/名册是建团快照，不受影响' }
  }

  /** 恢复团队默认配置：删除团队级 team.config.json 并重建配置缓存 */
  resetTeamConfig(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
    if (args.confirm !== true) {
      return { status: 'confirm-required', message: '恢复默认配置是两段确认操作（只重置配置，不动账本/成员），请带 confirm=true 重调' }
    }
    const path = teamConfigPath(this.workspaceRoot, teamId)
    if (!existsSync(path)) {
      return { status: 'noop', teamId, message: '团队没有团队级配置（已按项目层/插件默认生效）' }
    }
    unlinkSync(path)
    this.services.delete(teamId)
    const svc = this.service(teamId)
    return {
      status: 'reset',
      teamId,
      configSource: svc.configSource,
      note: '团队级配置已删除；按「项目层 < 插件默认」重新加载（账本/成员未动）',
    }
  }

  /**
   * CHG-117（FR-14.3 / docs/18 §7）：设置页保存团队级配置。
   *
   * 四条纪律（契约见 docs/18 §7，实现不得偏离）：
   *  1. **校验先于写**：结构校验 + 终态覆盖，失败 `MT_VALIDATION`（带 `field` / `reason`），**零写入**；
   *  2. **原子写**：`writeTeamConfigRaw`（tmp + rename），写后**重建 TeamService**（配置在构造时读取）；
   *  3. **两段确认**：门禁链 / 规模上限变化，或有在跑任务 → 先回 `confirm-required` + 影响面；
   *  4. **未知键保留**：不因未知键拒绝（原样写入，`warnings` 回显），否则「JSON 源视图 → 表单 → 保存」会丢用户手写内容；
   *  5. 返回**生效配置**（重读的 `effectiveConfig`），不是回显入参。
   */
  saveTeamConfig(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
    const id = String(teamId ?? '').trim()
    if (!id) return { status: 'error', code: 'MT_VALIDATION', field: 'teamId', message: 'teamId is required' }
    const next = args?.config
    if (next === undefined || next === null) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        field: 'config',
        reason: 'missing',
        message: 'config is required（要恢复默认请用 resetTeamConfig，两段确认）',
      }
    }
    if (!isStructurallyValidConfig(next)) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        field: 'config',
        reason: 'structural-invalid',
        message: '配置结构非法：已知段落必须是对象、board.columns 必须是字符串数组（docs/18 §2 第 5 条）',
      }
    }
    /* 终态覆盖与合并告警：与运行时同一条管线；运行时是「忽略该层」，保存时必须升级为「拒绝写入」 */
    const probe = loadEffectiveConfig(readProjectConfigRaw(this.workspaceRoot), next)
    if (!probe.applied.team) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        field: 'board.columnMapping',
        reason: 'terminal-state-not-covered',
        message: probe.warnings.join('; ') || '配置非法：看板列没有覆盖全部终态（done/failed/blocked/cancelled）',
      }
    }
    /* 影响面：只统计「这次保存会改变的可见后果」 */
    const currentSvc = this.service(id)
    const proj = currentSvc.projectionSnapshot
    const current = currentSvc.effectiveConfig
    const runningTasks = Object.values(proj.tasks ?? {}).filter((task) => {
      const state = String(task.state ?? '')
      return state === 'in_progress' || state === 're-scoping' || state.startsWith('gate:')
    }).length
    const impact = {
      members: Object.values(proj.members ?? {}).filter((member) => {
        const status = String(member.status ?? '')
        return status === 'active' || status === 'suspended'
      }).length,
      runningTasks,
      gateChainsChanged: JSON.stringify(current.taskTypes) !== JSON.stringify(probe.config.taskTypes),
      limitsChanged: JSON.stringify(current.limits) !== JSON.stringify(probe.config.limits),
    }
    if ((impact.gateChainsChanged || impact.limitsChanged || runningTasks > 0) && args?.confirm !== true) {
      return {
        status: 'confirm-required',
        impact,
        message: '保存会改变门禁链 / 规模上限，或团队有在跑任务——请确认后带 confirm=true 重调（两段确认，docs/18 §7）',
      }
    }
    const filePath = writeTeamConfigRaw(this.workspaceRoot, id, next)
    /* 配置在 TeamService 构造时读取：写完必须丢掉旧实例，否则 getConfig/看板还是旧值 */
    this.services.delete(id)
    const nextSvc = this.service(id)
    return {
      status: 'ok',
      teamId: id,
      filePath,
      impact,
      warnings: nextSvc.configWarnings,
      note: '已原子写入团队级 team.config.json；生效配置见 config / source',
    }
  }

  /**
   * 创建角色（CHG-53，队长技能 create-role 的写入口）。
   *
   * CHG-103（用户定案）：
   *  - **默认项目级**：不传 `scope` 一律写 `.dsh-myteam/config/roles/`；
   *  - **全局必须明示**：`scope: 'global'` + `confirmGlobal: true` 才写全局库；
   *    只传 scope 不传确认 → 返回 `confirm-required`（模型据此弹窗让用户明确确认）；
   *  - 同名任一来源存在 → `MT_ROLE_EXISTS`（不静默覆盖）。
   */
  createRole(args: Record<string, unknown>): Record<string, unknown> {
    const roleId = String(args.roleId ?? '')
    const def: RoleDefinition = {
      id: roleId,
      name: String(args.name ?? ''),
      description: String(args.description ?? ''),
      systemPrompt: String(args.systemPrompt ?? ''),
      isCaptain: args.isCaptain === true,
      skills: Array.isArray(args.skills) ? args.skills.filter((skill): skill is string => typeof skill === 'string') : [],
      mcpAllowlist: Array.isArray(args.mcpAllowlist) ? args.mcpAllowlist.filter((name): name is string => typeof name === 'string') : [],
      interestWords: Array.isArray(args.interestWords)
        ? args.interestWords.filter((word): word is string => typeof word === 'string' && word.trim().length > 0).map((word) => word.trim())
        : [],
      version: 1,
      ...(isPlainObject(args.toolPolicy) ? { toolPolicy: args.toolPolicy as RoleDefinition['toolPolicy'] } : {}),
      ...(isPlainObject(args.model) ? { model: args.model as RoleDefinition['model'] } : {}),
    }
    if (!def.name.trim()) return { status: 'error', code: 'MT_ROLE_INVALID', message: `role "${roleId}" requires name` }
    // 「创建」语义严格：同名已存在一律 MT_ROLE_EXISTS（不提供覆盖语义——那是 update_role 的事）。
    // 项目级还要看内置/全局/插件（都不允许被同名项目角色覆盖，R13 引用即复制）。
    let scope: 'project' | 'global'
    try {
      scope = normalizeScope(args.scope)
    } catch (e) {
      return this.roleError(e)
    }
    if (scope === 'global') {
      if (readGlobalRole(this.rolePaths, roleId)) {
        return { status: 'error', code: 'MT_ROLE_EXISTS', message: `role "${roleId}" already exists in global library` }
      }
    } else {
      const existing = this.roleCatalog().find((entry) => entry.definition.id === roleId)
      if (existing) {
        return { status: 'error', code: 'MT_ROLE_EXISTS', message: `role "${roleId}" already exists in ${existing.origin} library` }
      }
    }
    // 统一走 roleOp.save：作用域守卫 / 全局两段确认 / 审计与面板同源
    const out = this.roleOp('save', {
      role: def,
      scope,
      confirmGlobal: args.confirmGlobal,
      confirm: true,
    })
    // 工具语义是「创建」：落盘成功后把 saved 归一成 created（confirm-required / error 原样透传）
    return out.status === 'saved' ? { ...out, status: 'created' } : out
  }

  /**
   * 修改角色（CHG-53，队长技能 modify-role）。
   *
   * CHG-103：`scope` 决定改哪一层——
   *  - `project`（缺省）：内置/全局先复制进项目（fork）再 patch（原行为）；
   *  - `global`：**必须** `confirmGlobal: true`，直接改全局库那一份（各项目副本不受影响）。
   */
  updateRole(args: Record<string, unknown>): Record<string, unknown> {
    const roleId = String(args.roleId ?? '')
    if (!isPlainObject(args.patch)) {
      return { status: 'error', code: 'MT_ROLE_INVALID', message: 'patch object is required' }
    }
    let scope: 'project' | 'global'
    try {
      scope = normalizeScope(args.scope)
    } catch (e) {
      return this.roleError(e)
    }
    const applyPatch = (base: RoleDefinition): RoleDefinition => {
      const patch = args.patch as Record<string, unknown>
      const next: RoleDefinition = { ...base, version: (base.version ?? 1) + 1 }
      if (typeof patch.name === 'string') next.name = patch.name
      if (typeof patch.description === 'string') next.description = patch.description
      if (typeof patch.systemPrompt === 'string') next.systemPrompt = patch.systemPrompt
      if (typeof patch.isCaptain === 'boolean') next.isCaptain = patch.isCaptain
      if (Array.isArray(patch.skills)) next.skills = patch.skills.filter((skill): skill is string => typeof skill === 'string')
      if (Array.isArray(patch.mcpAllowlist)) next.mcpAllowlist = patch.mcpAllowlist.filter((name): name is string => typeof name === 'string')
      if (Array.isArray(patch.interestWords)) {
        next.interestWords = patch.interestWords
          .filter((word): word is string => typeof word === 'string' && word.trim().length > 0)
          .map((word) => word.trim())
      }
      if (isPlainObject(patch.toolPolicy)) next.toolPolicy = patch.toolPolicy as RoleDefinition['toolPolicy']
      if (isPlainObject(patch.model)) next.model = patch.model as RoleDefinition['model']
      return next
    }
    if (scope === 'global') {
      if (args.confirmGlobal !== true) {
        return {
          status: 'confirm-required',
          scope: 'global',
          roleId,
          message: `要修改的是**全局**角色库里的「${roleId}」——它影响所有项目看到的这一份定义。确认全局作用域请带 confirmGlobal=true 重试；只改本项目请省略 scope（默认项目级，会先复制一份进项目库再改）。`,
        }
      }
      const base = readGlobalRole(this.rolePaths, roleId)
      if (!base) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in global library` }
      const next = applyPatch(base)
      if (!next.name.trim()) return { status: 'error', code: 'MT_ROLE_INVALID', message: `role "${roleId}" requires name` }
      try {
        assertValidRole(next)
        saveGlobalRole(this.rolePaths, next, { overwrite: true, actor: 'human' })
        return { status: 'updated', scope: 'global', roleId, version: next.version, note: '已更新全局角色定义；各项目里的副本不受影响（运行时只认项目库）' }
      } catch (e) {
        return this.roleError(e)
      }
    }
    let def = readProjectRole(this.rolePaths.projectRolesDir, roleId)
    let copiedFrom: string | undefined
    if (!def) {
      const source = this.roleCatalog().find((entry) => entry.definition.id === roleId)
      if (!source) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in any library` }
      if (source.origin !== 'project') {
        try {
          copyToProject(this.rolePaths, roleId, source.origin, this.contributionCatalog.roles)
          copiedFrom = source.origin
        } catch (e) {
          return this.roleError(e)
        }
      }
      def = readProjectRole(this.rolePaths.projectRolesDir, roleId)
    }
    if (!def) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in project library` }
    const next = applyPatch(def)
    if (!next.name.trim()) return { status: 'error', code: 'MT_ROLE_INVALID', message: `role "${roleId}" requires name` }
    try {
      assertValidRole(next)
      writeProjectRole(this.rolePaths.projectRolesDir, next)
      return {
        status: 'updated',
        scope: 'project',
        roleId,
        version: next.version,
        ...(copiedFrom ? { copiedFrom } : {}),
        note: '运行中的成员使用身份快照，不受本次修改影响；之后 spawn 的成员使用新配置',
      }
    } catch (e) {
      return this.roleError(e)
    }
  }

  /**
   * CHG-87（FR-16.1 单角色调用 / FR-15.1 入口②）：`/myteam+<id>` 的工具面。
   *
   * 语义（PRD §5.16）：
   *  - **累加**启用（`roles` 与会话内已有角色求并），**`remove` 卸载**（求差）；
   *  - 生效 = 角色配置注入当前会话（提示词 section + C5 收窄 + Skill/MCP 绑定），
   *    与成员实例化同管线（同一份 `RoleDefinition`）；
   *  - **不入团队账本**：单角色调用不是团队（没有任务 DAG / claim / 账本）；
   *  - `sessionDefaults` 落 `config/roles/session-defaults.json` → 跨重启恢复；
   *  - 两段确认：不带 `confirm` 先返回影响面（生效角色 + 技能/MCP 绑定），
   *    带 `confirm=true` 才落盘（与 saveRole / deleteRole / set_project_role 同口径）。
   *
   * 为什么不在这里改系统提示：宿主 `systemPrompt.section()` 是**会话建立时**注册的，
   * 运行期改不了（NFR-7.3 明确「系统提示稳定」）。故本工具返回 `promptSection` 由调用方
   * （队长会话 / 面板）在下次 context 组装时注入——**诚实告知"下次唤醒/重启生效"**，
   * 不假装即时生效。
   */
  applyRoles(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
    const requested = Array.isArray(args.roles)
      ? (args.roles as unknown[]).map((id) => String(id ?? '').trim()).filter((id) => id.length > 0)
      : []
    const removals = Array.isArray(args.remove)
      ? (args.remove as unknown[]).map((id) => String(id ?? '').trim()).filter((id) => id.length > 0)
      : []
    if (requested.length === 0 && removals.length === 0) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'apply_roles requires roles[] or remove[]（单角色调用要指定启用/卸载哪些角色）' }
    }
    // FR-16.1 拍板：已有会话原地启用 Team 不支持——但单角色调用随时可用，两者不冲突。
    const catalog = this.roleCatalog()
    const unknown = [...requested, ...removals].filter((id) => !catalog.some((entry) => entry.definition.id === id))
    if (unknown.length > 0) {
      return {
        status: 'error',
        code: 'MT_ROLE_NOT_FOUND',
        message: `role(s) not found in any library: ${[...new Set(unknown)].join(', ')}（内置/全局/项目库均可；用 myteam_create_role 新建）`,
      }
    }
    const current = readSessionDefaults(this.workspaceRoot)
    const nextRoles = [...new Set([...current.roles.filter((id) => !removals.includes(id)), ...requested])]
    // 生效角色定义：项目库优先（运行时真相，R13），否则目录里优先级最高的那份
    const resolved: RoleDefinition[] = []
    for (const roleId of nextRoles) {
      const entry = this.roleCatalog().find((candidate) => candidate.definition.id === roleId)
      if (entry) resolved.push(entry.definition)
    }
    const promptSection = buildRolePromptSection(resolved)
    const summary = resolved.map((role) => ({
      roleId: role.id,
      name: role.name,
      skills: [...(role.skills ?? [])],
      mcpAllowlist: [...(role.mcpAllowlist ?? [])],
    }))
    if (args.confirm !== true) {
      return {
        status: 'confirm-required',
        roles: summary,
        removed: removals,
        promptSection,
        message:
          `把 ${nextRoles.length} 个角色注入当前会话？生效 = 提示词 section + C5 收窄 + Skill/MCP 绑定（与成员实例化同管线），` +
          `**不入团队账本**（单角色调用不是团队）。带 confirm=true 落盘（sessionDefaults 跨重启恢复）`,
      }
    }
    const written = writeSessionDefaults(this.workspaceRoot, nextRoles, {
      action: removals.length > 0 && requested.length === 0 ? 'removed' : 'applied',
      actor,
    })
    void teamId // 单角色调用不写团队账本（teamId 仅用于面板作用域解析）
    return {
      status: 'applied',
      roles: summary,
      removed: removals,
      filePath: written.filePath,
      promptSection,
      note:
        nextRoles.length === 0
          ? '已清空单角色调用（会话回到普通模式）'
          : `角色配置已写入会话默认值（跨重启恢复）；提示词 section 在下次唤醒/重启时生效（系统提示稳定，NFR-7.3）`,
    }
  }

  /**
   * CHG-87（docs/04 §2 承诺的 `roleOp` 端点）：角色库写操作的统一入口。
   *
   * 为什么补这一层：docs/04 §2 把 `roleOp(op, payload)` 写成对外端点（「角色 CRUD/fork/
   * 发布（FR-13.1，C7 守门在 host）」），实现却只有面板的 `saveRole` / `deleteRole` ——
   * **文档承诺与实现分叉**；M2 的「发布到全局库」「fork 成新 id」也一直没有落点。
   *
   * op ∈ `save`（新建/覆盖）+ `delete`（C7 占用面守门）+ `publish`（项目 → 全局库）+
   * `fork`（任意来源复制成新 id）。实现集中在 `core/roles/role-ops.ts`，
   * 面板侧（`MyTeamPanelFacade.roleOp`）走同一份——离线团队没有活动会话也能改角色库。
   */
  roleOp(op: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
    /**
     * CHG-91（契约 P3 单向流动）：**插件贡献的角色只读**。
     *
     * `save` / `delete` / `publish` 打到 `plugin` 来源的角色上一律拒（`MT_ROLE_READONLY`）——
     * 想改就 `copyToProject` 复制成项目库角色再改（此后项目库优先级更高，自动生效）。
     * 为什么 `publish` 也拒：插件来源不是「项目库资产」，没有「发布到全局」这一说。
     */
    const directId = String((payload as { roleId?: unknown }).roleId ?? '')
    const saveId = String((payload as { role?: { id?: unknown } }).role?.id ?? '')
    if (op === 'save' || op === 'delete' || op === 'publish') {
      const readonlyId = this.contributedRole(directId) ? directId : (saveId && this.contributedRole(saveId) ? saveId : '')
      if (readonlyId) {
        return {
          status: 'error',
          code: CONTRIBUTION_CODES.ROLE_READONLY,
          roleId: readonlyId,
          message: `插件贡献的角色「${readonlyId}」只读；想改请先「复制到项目」再编辑项目库那份`,
        }
      }
    }
    // 实现集中在 core/roles/role-ops.ts：host 与面板共用同一份（避免「工具能改、面板改不了」分叉）
    return roleOpImpl({ paths: this.rolePaths, actor: 'human' }, op, payload)
  }

  private roleError(e: unknown): Record<string, unknown> {
    const err = e as { code?: string; message?: string }
    return { status: 'error', code: err.code ?? 'MT_ROLE_INVALID', message: err.message ?? String(e) }
  }

  /** 队长技能注册（CHG-53）：create-role / modify-role；skills 服务缺失只告警，不影响主链 */
  /**
   * CHG-93（**真实安装实测发现的 P0**）：preset 作用域的服务是**异步就绪**的。
   *
   * `initialize()` 在插件 apply 时同步执行，此时 preset 作用域的 `skills` / `systemPrompt`
   * 还没注册完——直接读拿到 `undefined`，于是「船长技能」与「团队章程」**静默不注入**：
   * 日志只有一句 warn，功能面全空。**单测发现不了**（测试里的 rt 是同步桩，永远拿得到）。
   *
   * 修法：用 cordis 的**延迟注入** `ctx.inject([...], cb)` —— 服务就绪后再跑，
   * 不阻塞插件装载。宿主不支持 `inject` 时退回同步路径（老宿主仍能跑，只是可能拿不到）。
   */
  private deferCaptainServices(): void {
    const ctx = this.rt as unknown as { inject?: (deps: string[], cb: (scoped: unknown) => void) => unknown }
    const run = (scoped?: unknown): void => {
      try {
        this.registerCaptainSkills(scoped)
        this.registerTeamCharter(scoped)
      } catch (e) {
        // 两个都是增强项（技能 / 章程），失败只告警不阻断主链
        this.log('warn', `captain scope registration failed: ${String(e)}`)
      }
    }
    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['skills', 'systemPrompt'], (scoped) => run(scoped))
        return
      } catch (e) {
        this.log('warn', `deferred captain services unavailable (falling back to sync): ${String(e)}`)
      }
    }
    run()
  }

  private registerCaptainSkills(scoped?: unknown): void {
    const skills = safeRead(scoped ?? this.rt, 'skills') as { register?: (skill: Record<string, unknown>) => unknown } | undefined
    if (!skills || typeof skills.register !== 'function') {
      this.log('warn', 'skills service unavailable; captain role skills not registered')
      return
    }
    let registered = 0
    for (const skill of CAPTAIN_SKILLS) {
      try {
        skills.register({
          ...skill,
          source: 'myteam',
          invocation: { modelInvocable: true, userInvocable: false },
        })
        registered += 1
      } catch (e) {
        this.log('warn', `captain skill "${skill.name}" register failed: ${String(e)}`)
      }
    }
    this.log('info', `captain role skills registered (${registered}/${CAPTAIN_SKILLS.length})`)
  }

  /**
   * CHG-93（FR-18 职责③ F8）：把团队章程（`.dsh-myteam/structure.md`）注入队长 system prompt。
   *
   * ## 为什么必须做
   *
   * CHG-88 实装了 create-team 技能**写**章程，但**没有任何读取方**——章程写进磁盘就没人看，
   * 队长自己的系统提示里一个字都没有。「UI 显示已生成团队章程、模型侧零感知」是典型的
   * 文档承诺与实现分叉。
   *
   * ## 为什么用 variable + section（而不是静态 section）
   *
   * 宿主 `systemPrompt.section({text})` 是**会话建立时**取值（NFR-7.3「系统提示稳定」），
   * 而章程是队长随时会改的文件。`systemPrompt.variable(name, provider)` 的 provider
   * **每次组装求值**，配合 `section({text:'{{var}}'})` 就能做到「改了下一次请求生效」。
   *
   * 宿主没有 variable API 时**降级为静态注入并如实告知**（改动下次重启生效）——
   * 不假装即时生效（与 `applyRoles` 的诚实口径一致）。
   *
   * ## 边界
   *
   * 章程是**给模型看的约定，不是权限**：不改 `toolPolicy`、不绕门禁。
   * 文件缺失是合法状态（新项目首次启动就是空的）——不注册 section，不阻断会话建立。
   */
  private registerTeamCharter(scoped?: unknown): void {
    const systemPrompt = safeRead(scoped ?? this.rt, 'systemPrompt') as
      | {
        variable?: (name: string, provider: () => string) => unknown
        section?: (section: { name: string; order: number; text: string }) => unknown
      }
      | undefined
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      this.log('warn', 'systemPrompt service unavailable; team charter not injected')
      return
    }
    try {
      if (typeof systemPrompt.variable === 'function') {
        // 动态路径：每次组装重新读盘（队长改章程不必重启）
        systemPrompt.variable(TEAM_CHARTER_VARIABLE, () => readTeamCharter(this.workspaceRoot).text)
        systemPrompt.section({ ...TEAM_CHARTER_SECTION, text: `{{${TEAM_CHARTER_VARIABLE}}}` })
        this.log('info', 'team charter injected (dynamic: edits take effect on the next request)')
        return
      }
      // 退化路径：静态注入（改动下次重启生效）
      const charter = readTeamCharter(this.workspaceRoot)
      if (charter.text.length === 0) {
        this.log('info', 'team charter: no structure.md yet (nothing to inject)')
        return
      }
      systemPrompt.section({ ...TEAM_CHARTER_SECTION, text: charter.text })
      this.log('info', `team charter injected (static ${charter.bytes}B; edits take effect after restart)`)
    } catch (e) {
      // 注入失败不该阻断启动（章程是增强，不是主链），但必须留痕
      this.log('warn', `team charter injection failed: ${String(e)}`)
    }
  }

  /** 知识库面板视图（FR-17.5 数据面，M2-0b）：条目全量 + 各团队待审提案 + 条目演化时间线（读投影，不进模型上下文） */
  knowledgeView() {
    return buildKnowledgeView(this.workspaceRoot)
  }

  /** 预设库面板视图（CHG-50）：三层只读目录（builtin/global/project），不写盘 */
  presetCatalogView(): PresetCatalog {
    return this.presetCatalog()
  }

  /**
   * CHG-91（契约 §12.1）：插件贡献的**只读**工具视图。
   *
   * 为什么队长需要它：插件装完后「有哪些角色可用」是规划的前提——不查就会派给
   * 一个不存在的角色（`MT_ROLE_NOT_FOUND`）。所以这里给的是**可执行**信息：
   * 角色 id（能直接写进 `roster[].roleId`）+ 团队模板名册 + 每条 warning 的修法。
   *
   * @param catalog 显式传入则用它（重载路径）；缺省走当前快照
   */
  private listContributionsTool(catalog: ContributionCatalog = this.contributionCatalog): Record<string, unknown> {
    return {
      status: 'ok',
      root: catalog.root,
      /* CHG-107：展示用（用户名 → ~）；root 保留绝对路径供复制/排障 */
      rootDisplay: displayPath(catalog.root),
      ok: catalog.ok,
      scannedAt: catalog.scannedAt,
      plugins: catalog.plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        version: plugin.version,
        namespace: plugin.namespace,
        status: plugin.status,
        roles: plugin.roles,
        teams: plugin.teams,
      })),
      roles: catalog.roles.map((role) => ({ id: role.id, name: role.name, origin: role.origin })),
      teams: catalog.teams.map((team) => ({ id: team.id, name: team.name, namespace: team.namespace, members: team.members })),
      warnings: catalog.warnings,
    }
  }

  /* ── 归档快照（CHG-86 / P0-2：面板归档视图的读面）────────────── */

  /**
   * 读取某个团队的归档快照（只读）。
   * `teamId` 缺省时取默认团队；该团队未归档 → `null`（面板按"未归档"渲染，不猜半个快照）。
   */
  archiveView(teamId?: string): { teamId: string; archive: ReturnType<typeof readArchive>; root: string; rootDisplay: string } {
    const id = teamId && teamId.trim().length > 0 ? teamId.trim() : this.defaultTeamId()
    const root = archiveRootOf(this.workspaceRoot)
    // CHG-108：展示用（用户名 → ~）；root 保留绝对路径
    return { teamId: id, archive: readArchive(this.workspaceRoot, id), root, rootDisplay: displayPath(root) }
  }

  /** 已归档团队 id 列表（面板「全部团队」入口；只读目录名） */
  archiveList(): { root: string; rootDisplay: string; teams: string[] } {
    const root = archiveRootOf(this.workspaceRoot)
    return { root, rootDisplay: displayPath(root), teams: listArchives(this.workspaceRoot) }
  }

  /* ── 会话移交（CHG-88 / M2-E / FR-16.3）───────────────────────── */

  /**
   * 会话移交：提取当前团队上下文摘要 → 程序化建**新**团队预设会话 → 把摘要作为
   * 首条消息注入。**原会话原样保留**（FR-16.3 明令不做原地变身）。
   *
   * 三条纪律：
   *  1. **不建成员、不建任务**——移交只交上下文；名册与任务由新队长用自己的工具决定
   *     （`myteam_submit_plan` / `myteam_spawn_member` / `myteam_create_task`）。
   *  2. **不写团队账本**——移交不是团队范围内的变更（没有新事件类型），账本字节数不变。
   *  3. **不假装成功**——宿主缺 `sessionController` 能力 → `MT_UNAVAILABLE`；
   *     建会话失败 → 报错带宿主原始错误码；注入失败 → 报错并**带 sessionId**
   *     （会话已存在，人可以手动粘贴摘要）。
   */
  async handoffTeam(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const capability = resolveSessionHandoffCapability(this.rt)
    if (!capability) {
      return {
        status: 'error',
        code: 'MT_UNAVAILABLE',
        message: '宿主未提供 sessionController 服务，无法程序化创建团队预设会话（FR-16.3 移交不可用；可手动复制摘要到新会话）',
      }
    }
    // 摘要来源：当前团队的投影 + 账本事件（**只读**；不产生任何事件）
    const svc = this.service(teamId)
    const proj = svc.projectionSnapshot
    const events = readLedgerEvents(svc.ledgerPath).events
    const recentEvents = events.slice(-20).map((event) => ({
      seq: Number(event.seq ?? 0),
      type: String(event.type ?? ''),
      actor: String(event.actor ?? ''),
      ts: Number(event.ts ?? 0),
    }))
    const { summary, metadata } = buildHandoffSummary({
      teamId,
      teamName: String(proj.name ?? ''),
      goal: String(proj.goal ?? ''),
      state: String(proj.state ?? ''),
      tasks: Object.values(proj.tasks).map((task) => ({
        id: task.id,
        title: task.input?.title,
        state: task.state,
        priority: task.input?.priority,
        requiredRole: task.input?.requiredRole,
        assignee: task.assignee,
      })),
      members: Object.values(proj.members).map((member) => ({
        id: member.id,
        roleId: member.roleId,
        instanceName: member.instanceName,
        status: member.status,
        currentTaskId: member.currentTaskId,
        // M2-D ①（FR-16.4①）：会话索引的指针来源——没有它就编不出 \`session:<id>\`
        ...(member.sessionId ? { sessionId: member.sessionId } : {}),
      })),
      recentEvents,
      ...(typeof args.sourceSessionId === 'string' && args.sourceSessionId.trim().length > 0
        ? { sourceSessionId: args.sourceSessionId.trim() }
        : {}),
    })
    const prompt = buildHandoffPrompt(summary)
    const requestId = `myteam-handoff-${teamId}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const result = await runHandoff(capability, {
      summary,
      prompt,
      cwd: this.workspaceRoot,
      agentPreset: TEAM_AGENT_PRESET_ID,
      requestId,
    })
    if (result.status !== 'ok') {
      return {
        status: 'error',
        code: result.code ?? 'MT_HANDOFF_FAILED',
        message: result.message ?? '会话移交失败',
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        teamId,
      }
    }
    return {
      status: 'ok',
      teamId,
      sessionId: result.sessionId,
      agentPreset: TEAM_AGENT_PRESET_ID,
      summary,
      metadata,
      note: '已新建团队预设会话并注入上下文摘要（原会话保留；名册与任务由新队长自行决定）',
    }
  }

  /* ── 会话考古（CHG-120 / M2-D ② / FR-16.4②）──────────────────── */

  /**
   * 会话考古：按 `session:<id>` 指针**只读**读一段历史（不激活 Agent、不写当前上下文）。
   *
   * 为什么需要：handoff 摘要只给 `session:<id>` 指针（CHG-88），没有读取方它就是死链接。
   * 宿主能力 = `SessionController.page`（注释原文「Read one message-aligned history page
   * **without activating an Agent**」）——**只读**、按页（`beforeSeq` 往回翻）、有界
   * （`maxMessages`）。
   *
   * 纪律：
   *  1. 缺 `page` 能力 → `MT_UNAVAILABLE`（**不假装读到**、不返回空历史）；
   *  2. 读成功且给了 `teamId` → 落一条 `session.read` 审计（读取即留痕，CHG-87 口径）；
   *  3. 返回**有界摘要**（`summarizeSessionRecords`），原文只用于展示，不回写任何地方。
   */
  async readSessionHistory(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sessionId = String(args.sessionId ?? '').trim()
    if (!sessionId) return { status: 'error', code: 'MT_VALIDATION', field: 'sessionId', message: 'sessionId is required（形如 session:<id>）' }
    const teamId = typeof args.teamId === 'string' && args.teamId.trim().length > 0 ? args.teamId.trim() : undefined
    const capability = resolveSessionHistoryCapability(this.rt)
    if (!capability) {
      return {
        status: 'error',
        code: 'MT_UNAVAILABLE',
        message: '宿主未提供 sessionController.page 能力，无法读取历史会话（会话考古不可用；不要伪造历史）',
      }
    }
    let page: { records?: SessionRecordView[]; hasMore?: boolean }
    try {
      page = await capability.page(buildSessionPageRequest(sessionId, {
        ...(args.beforeSeq !== undefined ? { beforeSeq: Number(args.beforeSeq) } : {}),
        ...(args.maxMessages !== undefined ? { maxMessages: Number(args.maxMessages) } : {}),
      }))
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      const message = (error as { message?: unknown } | undefined)?.message
      return {
        status: 'error',
        code: typeof code === 'string' && code.length > 0 ? code : 'MT_HISTORY_FAILED',
        message: typeof message === 'string' && message.length > 0 ? message : String(error),
        sessionId,
      }
    }
    const excerpt = summarizeSessionRecords(sessionId, page)
    /* 读取留痕：有团队上下文就落 session.read（与 CHG-87 的成员证据指针同一事件类型） */
    if (teamId) {
      try {
        this.commit(teamId, {
          actor: 'human',
          type: 'session.read',
          payload: {
            teamId,
            sessionId,
            pointer: `session:${sessionId}`,
            by: 'human',
            via: 'archaeology',
            ...(Number.isFinite(Number(args.beforeSeq)) ? { beforeSeq: Number(args.beforeSeq) } : {}),
          },
        })
      } catch {
        /* 审计失败不阻断读取（读取是只读行为；留痕尽力而为） */
      }
    }
    return { status: 'ok', ...excerpt }
  }

  /* ── token 侧车（FR-8.2：增量同步；disband 时随归档落最终快照）──────── */

  /**
   * CHG-86（P0-3）：token 侧车**增量同步**（原 `rebuildTokens`）。
   *
   * 旧实现的缺陷：每次调用都从 `emptyTokensFile()` 重建，把成员**全生命周期累计量**
   * 记进**今天**这一个桶再整份覆写 `tokens.json`。而它是被**只读端点** `getTokens`
   * 调用的——每读一次盘就抹掉一次历史：`days` 维度实现了但永远只有一天，
   * 面板「按天桶」表恒为一行。
   *
   * 现在的口径：
   *  ① 基线 = 上次读到的累计量（内存 `tokenBaselines`；冷启动从 `tokens.json` 的
   *     `totals` 恢复——`totals` 本身就是每个成员的累计量）；
   *  ② 本次累计 − 基线 = 增量 → 记到**当天**桶，基线跟进（session 重建导致累计量
   *     回退时只重置基线，不写负数）；
   *  ③ 写盘幂等：同一时刻重复调用不改变结果，`days` 会自然长出多天。
   *
   * P2-5 计量覆盖率接线（口径见 `token-sidecar.ts` 的 `MemberMeterState`）：
   *  ④ 每轮对每个成员**观测一次**「此刻能不能读到累计 usage」，结果写进 `memberMeter`；
   *  ⑤ 读得到 → 本轮 delta 的调用数记进 `meteredCalls`（每一条被计数的调用都有 usage 背书）；
   *     读不到 / 抛错 → 该成员记 `unreadable`，**覆盖率必须降级 partial**，绝不谎报 full；
   *  ⑥ 读失败时**不推进基线**（保持既有行为）——下一轮 delta 会把漏掉的调用一起补进来，
   *     因此恢复可读后覆盖率可以回到 full（观测是「当下」的，不是历史污点）。
   */
  syncTokens(teamId: string): TokensFile {
    const svc = this.service(teamId)
    // ① 已有历史：优先内存，其次读盘（进程重启后 days 不能丢；旧路径只读兼容，见 CHG-202x / P1-14）
    const filePath = tokenSidecarPath(this.workspaceRoot, teamId)
    let file = this.tokensFiles.get(teamId) ?? readTokensSidecar([filePath, legacyTokenSidecarPath(this.workspaceRoot, teamId)])
    file ??= emptyTokensFile(teamId)
    // ② 基线：冷启动从 totals 恢复（totals = 每个成员的累计量）
    let baselines = this.tokenBaselines.get(teamId)
    if (!baselines) {
      baselines = new Map(Object.entries(file.totals ?? {}))
      this.tokenBaselines.set(teamId, baselines)
    }
    const projections = this.svc('sessionProjections')
    const dayKey = dayKeyOf(Date.now())
    let observed = 0
    // ④ 成员级观测表：每轮**重写**，但保留已离开投影的成员的最后状态（成员移除不降级历史）。
    //    单位是「成员」，不是「调用」——调用计数只有 meteredCalls。
    const memberMeter: Record<string, MemberMeterState> = { ...(file.memberMeter ?? {}) }
    for (const member of Object.values(svc.projectionSnapshot.members)) {
      const agent = this.agentOf(this.memberHandles.get(member.id))
      // 没有活跃 agent 会话：没有观测对象（不是漏数，也不产生调用）
      if (!agent) {
        memberMeter[member.id] = 'no-session'
        continue
      }
      try {
        // session-projection 契约：stateOf(session, key) 读宿主态（README §Register and read）。
        // 旧实现 .read() 不存在——真实注册的 'tokenUsage' 投影只能经 stateOf 读。
        const usage = projections?.stateOf?.((agent as { session?: unknown }).session, 'tokenUsage') ?? undefined
        const totals = usage?.totals ?? usage
        // ⑤ 有会话却读不到累计量：本轮四桶可能漏数 → 记 unreadable，覆盖率降级（不谎报 full）
        if (!totals || typeof totals !== 'object') {
          memberMeter[member.id] = 'unreadable'
          continue
        }
        const current = {
          uncachedInput: Number(totals.uncachedInputTokens ?? 0),
          cacheRead: Number(totals.cacheReadTokens ?? 0),
          cacheWrite: Number(totals.cacheWriteTokens ?? 0),
          output: Number(totals.outputTokens ?? 0),
          calls: Number(totals.calls ?? 0),
        }
        const baseline = baselines.get(member.id) ?? zeroBuckets()
        // ③ 增量：session 重建会让累计量回退 → 只跟基线，绝不写负数
        const delta = {
          uncachedInput: Math.max(0, current.uncachedInput - baseline.uncachedInput),
          cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
          cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
          output: Math.max(0, current.output - baseline.output),
          calls: Math.max(0, current.calls - baseline.calls),
        }
        // ⑥ 读失败不推进基线：留到下一轮把漏掉的增量一起补进来（既有行为，不要动）
        baselines.set(member.id, current)
        if (delta.uncachedInput + delta.cacheRead + delta.cacheWrite + delta.output + delta.calls > 0) {
          // ⑤ 每一条被计数的调用都来自宿主累计量（有 usage 背书）→ meteredCalls = delta.calls。
          //    delta.calls === 0 时**不写**该字段：编 0 会被 coverageOf 读成「全部未计量」，
          //    把「没记录」说成「确定没计量」——方向相反的谎报。
          file = accumulate(file, member.id, dayKey, delta.calls > 0 ? { ...delta, meteredCalls: delta.calls } : delta)
          observed += 1
        }
        // 本轮确实读到了（哪怕增量为 0）→ 该成员的样本是可覆盖的
        memberMeter[member.id] = 'metered'
      } catch (e) {
        // 抛错 = 本轮观测不到（成员级，不是调用级）→ 覆盖率必须降级
        memberMeter[member.id] = 'unreadable'
        this.log('warn', `token read for ${member.id} failed: ${String(e)}`)
      }
    }
    // ④ 无任何计量数据时保留成员维度（面板显示「计量不可用」而不是缺行）。
    //    旧实现读的是 TokensFile 上**不存在**的 `file.members` 字段——分支恒真，
    //    且该字段永远 undefined，所以「计量不可用」行从来没产出过（死代码）。
    if (observed === 0 && Object.keys(file.totals ?? {}).length === 0) {
      for (const member of Object.values(svc.projectionSnapshot.members)) {
        file = accumulate(file, member.id, dayKey, zeroBuckets())
      }
    }
    // ④ 观测表与四桶一起落盘（覆盖率是派生读数，观测才需要持久化）
    file = { ...file, memberMeter }
    writeTextAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`, { ensureParent: true })
    this.tokensFiles.set(teamId, file)
    return file
  }

  /**
   * A9（CHG-163）：**只读**成员会话快照（memberId 列表）——`memberHandles` 是内存态、不落盘，
   * 测试与面板诊断需要一个「此刻哪些成员会话在线」的事实面。返回新数组：调用方改它不影响运行时。
   *
   * 为什么加 getter 而不是让测试摸私有字段：`memberHandles` 的键集合是「重连是否生效」的判据，
   * 用公开只读面表达，测试与真实代码读的是同一份事实（`as any` 摸私有字段会悄悄绕过封装）。
   */
  memberHandleIds(): string[] {
    return [...this.memberHandles.keys()]
  }

  /**
   * A9（报告 KI-5，CHG-163）：**冷启动重连**——进程重启后把既有活跃成员的 `AgentHandle` 捡回来。
   *
   * 为什么必须有它：`memberHandles` 是**纯内存**（`dispose()` 里 `clear()`），重启即空。而它是
   * 「成员会话还活着」的唯一判据，三个消费点都吃它：
   *  - `syncTokens`：拿不到 handle → 该成员记 `no-session`（token 少算，覆盖率读数失真）；
   *  - `wakeDecisionsFor` / `dispatchSweep`：投不出 followup → 唤醒**静默失效**（账本记了唤醒、成员没收到）；
   *  - `recoverOnBoot`：`memberLive=false` → 在跑任务被转 `to-blocked`（**活着的**成员被当成死的）。
   * CHG-135（成员卡落盘）+ CHG-142（启动对账）只覆盖 provisioning 半边，**既有活跃成员的重连无收口**。
   *
   * 三条硬不变量（重连是**纯内存重建**）：
   *  ① **不改账本**——只用 `readOfflineTeam` + `foldTolerant` 只读折叠。**刻意不用** `this.service()`：
   *     构造 `TeamService` 会 `bootstrapTeam` 落 `rules.version.adopted`，重连就变成写操作；
   *  ② **不建会话**——只做 `agents.get(sessionId)` 的官方 lookup（`probeProvisionedSession` 同源口径），
   *     `agents.create` 是 spawn 的事，重连不负责造成员；
   *  ③ **不发消息**——重连只回答「谁还活着」，不 followup（判断活着 ≠ 该被叫醒）。
   *
   * 语义变化（`memberLive`）：从「**本进程**建过的」变成「本进程建过**或重连回来的**」。
   * 因此 `recoveryAction` 里 `memberLive=false` 的含义收窄为「本进程 + 账本都证明不了它活着」——
   * 这正是崩溃恢复想要的（真死的成员仍然走 `to-blocked`，不会因为重连被误判成活）。
   *
   * 边界（都不抛）：
   *  - 宿主没有 `agents.get`（单测 mock / 旧宿主）→ 整轮进 `skipped`，**绝不抛**（插件不能因为
   *    宿主少一个 API 就起不来）；
   *  - `agents.get` 抛错 / 返回空 → 该成员进 `missing`（不猜、不伪造 handle），其它成员照常重连；
   *  - 只重连 `active` / `suspended` 且账本里有 `sessionId` 的成员：`removed` / `archived` 是终态
   *    （唤醒它们等于让死人干活），`spawn_failed` 没有会话可重连；
   *  - 本进程已有 handle 的成员不覆盖（幂等；`spawnMember` 拿到的 handle 更权威）。
   */
  reconnectMembers(): { reconnected: number; missing: number; skipped: string[] } {
    const summary: { reconnected: number; missing: number; skipped: string[] } = { reconnected: 0, missing: 0, skipped: [] }
    const agents = this.rt.agents as { get?: (sessionId: string) => unknown } | undefined
    if (!agents || typeof agents.get !== 'function') {
      // 没有官方 lookup 口子就没有「重连」这件事：留痕（skipped）而不是静默报 0——
      // 「没重连」与「重连了 0 个」是两回事，混起来会让启动日志骗人
      summary.skipped.push('agents.get unavailable (host has no session lookup)')
      return summary
    }
    const teamsDir = storeLayout(this.workspaceRoot).tasks
    let teamIds: string[] = []
    try {
      if (!existsSync(teamsDir)) return summary
      teamIds = readdirSync(teamsDir).filter((name) => existsSync(join(teamsDir, name, 'ledger.jsonl')))
    } catch (e) {
      summary.skipped.push(`teams dir unreadable: ${String(e)}`)
      this.log('warn', `member reconnect skipped (teams dir unreadable): ${String(e)}`)
      return summary
    }
    for (const teamId of teamIds) {
      // 路径安全：目录名来自磁盘（用户手建 / 大小写变体 / 脏数据），只认白名单口径
      if (!isSafeTeamId(teamId)) {
        summary.skipped.push(`${teamId}: unsafe team id`)
        continue
      }
      let projection: ReturnType<typeof foldTolerant>['proj']
      try {
        const read = readOfflineTeam(this.workspaceRoot, teamId)
        if (!read) {
          summary.skipped.push(`${teamId}: ledger path rejected`)
          continue
        }
        projection = foldTolerant(teamId, read.events).proj
      } catch (e) {
        summary.skipped.push(`${teamId}: ${String((e as Error | undefined)?.message ?? e)}`)
        this.log('warn', `member reconnect skipped for team ${teamId}: ${String(e)}`)
        continue
      }
      for (const member of Object.values(projection.members)) {
        // 终态不重连：removed / archived 不该再被唤醒，spawn_failed 没有会话
        if (member.status !== 'active' && member.status !== 'suspended') continue
        const sessionId = typeof member.sessionId === 'string' ? member.sessionId : ''
        if (sessionId.length === 0) continue
        if (this.memberHandles.has(member.id)) continue
        let handle: unknown
        try {
          handle = agents.get(sessionId)
        } catch (e) {
          summary.missing += 1
          this.log('warn', `member reconnect lookup failed for ${teamId}/${member.id} (session ${sessionId}): ${String(e)}`)
          continue
        }
        if (!handle) {
          summary.missing += 1
          this.log('warn', `member reconnect: session ${sessionId} for ${teamId}/${member.id} not found in host (handle missing)`)
          continue
        }
        this.memberHandles.set(member.id, handle)
        summary.reconnected += 1
      }
    }
    return summary
  }

  /** 冷启动恢复（T16）：对滞留 in_progress 任务按恢复表落事件 */
  recoverOnBoot(teamId: string): { recovered: number; actions: string[] } {
    const svc = this.service(teamId)
    const actions: string[] = []
    for (const t of Object.values(svc.projectionSnapshot.tasks)) {
      if (t.state !== 'in_progress') continue
      const memberLive = t.assignee ? this.memberHandles.has(t.assignee) : false
      const action = recoveryAction({ state: t.state, attemptId: t.attemptId, assignee: t.assignee, memberLive })
      if (action.kind === 're-activate-new-attempt') {
        this.commit(teamId, { actor: 'host', type: 'task.attempt.revoked', payload: { teamId, taskId: t.id, attemptId: t.attemptId ?? 'unknown', reason: 'host restart recovery (FR-4.6)', prevAssignee: t.assignee } })
        actions.push(`task ${t.id}: attempt revoked for re-claim`)
      } else if (action.kind === 'to-blocked') {
        actions.push(`task ${t.id}: needs manual (no attempt, no live member)`)
      }
    }
    return { recovered: actions.length, actions }
  }
}

/** Remote service 引用（延迟解构：无 @deepseek-ai/dsh-typert-protocol 环境下仅在使用时报错） */
import * as remoteServiceModule from './remote/service.ts'

/** 插件 apply 入口（host-plugin.md 形态一：apply 函数 + inject + effect 清理）。
 *  inject 声明必需服务：缺失时本行保持未激活（而不是激活后抛错）。
 *
 *  ⚠ 元数据挂载纪律：cordis registry 消费的是「插件对象自身属性」
 *  （lib/index.js L1635 `Inject.resolve(plugin.inject)`），而 loader 的
 *  unwrapExports（cordis-plugin-loader/lib/index.js L667-672）取
 *  `exports.default ?? exports` —— 模块同时存在 default 导出时，named
 *  `inject` 导出会被整体丢弃，inject 声明失效 → 激活期守卫抛
 *  `cannot get property "tools" without inject`。因此 inject 必须以函数
 *  属性挂在 apply 上（default 导出携带它）；named 导出同步保留供测试与文档读取。 */
export function apply(ctx: HostRuntime & Record<string, any>, config: MyTeamConfig = {}): void {
  // 客户端载体行（config.carrier=true，见 MyTeamConfig.carrier 注释）：只为让
  // dsh-client-modules 的 loader 扫描看到裸包名行，宿主职责全部留在 preset 作用域。
  if (config.carrier === true) return
  const host = new MyTeamHost(ctx, config)
  host.initialize()
  // 资源清理归 ctx.effect（practices.md：注册是上下文拥有的 effect，卸载即回收）
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => host.dispose(), 'myteam.host')
  }
}

export const inject = ['tools', 'agents']
Object.assign(apply, { inject })

export default apply
