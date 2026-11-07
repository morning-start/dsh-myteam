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
 *   ① 目录初始化（.team-workplace 四分区 + gitignore 托管块）
 *   ② TeamService 管理（按 teamId 惰性创建 + 冷启动重放恢复）
 *   ③ Lead 工具 17 个注册（preset scope = 队长会话可见，ADR-003；+adopt_knowledge、+create_role/update_role）
 *   ④ 成员 spawn：agents.create 直连 + setup 作用域（9 成员工具/restrict/persona/skills）
 *   ⑤ 唤醒管线：账本事件 → wakeDecisionsFor → agent.followup
 *   ⑥ token 侧车：tokenUsage 投影 → tokens.json
 *
 * 零依赖边界（PRD §2/§9）：绝不 import/调用 agentTeams 服务与内置团队工具；
 * 宿主服务白名单见 PRD §9（agents/subagents/tools/typert/tokenMeter/sessionProjections）。
 */
import { join, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { ensureWorkplaceDirs, ensureGitignoreManagedBlock } from './host-workspace.mjs'
import { TeamService, bootstrapTeam,                  } from './core/service.mjs'
import { leadToolDefs, memberToolDefs, toolOutput,              } from './tools/defs.mjs'
import { wakeDecisionsFor, changeSince,                   } from './core/scheduler/wake.mjs'
import { validatePlan, TERMINAL_STATES, downstreamOf, GATE_REJECT_BUDGET,                     } from './core/scheduler/state.mjs'
import { diffTaskInput, structuralFieldsOf } from './core/tasks/diff.mjs'
import { buildToolMask, memberPromptSection, memoryPromptSection, memberSessionId, HOST_TEAM_TOOLS_TO_HIDE,                     } from './core/members/member-setup.mjs'
import { applyCapabilityGuard, capabilitySummary, resolveCapabilities } from './core/members/capability-guard.mjs'
import { memoryDirFor, seedMemoryIfMissing, auditMemoryContent,                    } from './core/members/memory.mjs'
import { copyToProject, listRoleCatalog, readProjectRole, resolveRuntimeRole, writeProjectRole, assertValidRole, readProjectRoleCard, writeProjectRoleCard, clearProjectRoleCard, deleteProjectRoleSafe,                     } from './core/roles/role-store.mjs'
// CHG-87（docs/04 §2 承诺的 roleOp 端点）：host 与面板共用同一份实现
import { roleOp as roleOpImpl } from './core/roles/role-ops.mjs'
import { presetTeamRoster,                     } from './core/roles/builtin-roles.mjs'
import { CAPTAIN_SKILLS } from './core/roles/captain-skills.mjs'
import { readPresetCatalog, readProjectPreset, writeProjectPreset, deleteProjectPreset, validatePresetDefinition, BUILTIN_PRESET_IDS,                    } from './core/presets/preset-store.mjs'
import { configOverrideFromPreset, teamConfigPath, writeTeamConfigRaw } from './core/config/team-config.mjs'
import { listKnowledge, renderIndexSection, readKnowledgeEntry, adoptDraft, reviseEntry, touchStale, candidatesForDraft, writeKnowledgeEntry, knowledgeDirOf, validateDraft,                     } from './core/knowledge/knowledge.mjs'
import { zeroBuckets, dayKeyOf, accumulate, emptyTokensFile,                 } from './core/ledger/token-sidecar.mjs'
// CHG-86（P0-2）：归档落盘（disband 时写快照；面板归档视图读快照）
import { buildArchiveSnapshot, writeArchive, readArchive, listArchives, archiveRootOf } from './core/archive/archive-store.mjs'
// CHG-87（M2-C 剩余，FR-5.3/FR-5.4）：command 门禁 + scope 完成审计
import { runVerifyCommand, validateVerifyCommand, classifyVerifyResult, resolveTimeoutMs,                    } from './core/gates/command-gate.mjs'
import { auditWriteScopes, filesTouchedOf,                 } from './core/gates/scope-audit.mjs'
// CHG-87（M2-D 剩余，FR-16.4③）：证据指针三类解析（task/file/session）
import { evidenceRefsOf, parseEvidencePointer } from './core/knowledge/evidence-pointer.mjs'
// CHG-87（FR-16.1 单角色调用）：sessionDefaults 跨重启恢复 + 提示词 section
import { readSessionDefaults, writeSessionDefaults, buildRolePromptSection } from './core/roles/session-defaults.mjs'
// CHG-88（M2-E / FR-16.3）：会话移交（摘要提取 + 新团队预设会话注入）
import {
  buildHandoffPrompt,
  buildHandoffSummary,
  resolveSessionHandoffCapability,
  runHandoff,
  TEAM_AGENT_PRESET_ID,
} from './core/host/session-handoff.mjs'
import { recoveryAction, checkArchiveGate } from './core/scheduler/recovery.mjs'
import { entryFromProjection, scanWorkspaceIndex, readWorkspaceIndex, writeWorkspaceIndex, upsertTeamEntry, upsertGlobalWorkspace, resolveMyteamHome } from './core/index/team-index.mjs'
// CHG-91（插件团队贡献契约 v1）：装载第三方插件贡献的角色与团队模板
import { loadContributions } from './core/contributions/parse.mjs'
import { contributionsRoot } from './core/contributions/discover.mjs'
import { CONTRIBUTION_CODES, emptyContributionCatalog,                          } from './core/contributions/contract.mjs'
// CHG-93（FR-18 职责③ F8）：团队章程注入队长 system prompt
import { readTeamCharter, TEAM_CHARTER_SECTION, TEAM_CHARTER_VARIABLE } from './core/host/team-charter.mjs'
import { roleUsage, projectRolePaths } from './core/index/offline-view.mjs'

/* 宿主编译辅助（T0 实证：register 前必须编译成完整 JSON Schema）。
 * 导出仅供单测（t7b 编译产物审计）；运行时语义不变。 */
export function compileParameters(tool         )          {
  // strip-only 环境下无宿主 parameterSchemaSpecToJsonSchema；本编译器实现宿主
  // spec 语义的等价子集：属性级 required:true 收集 → 顶层 required 数组（递归）。
  // 修订：递归必须同时下钻 items——items 内的属性级 required:true 若残留，
  // 产出的布尔 required 不是宿主 schema 子集关键字（assertSupportedJsonSchema
  // 报 "not a supported keyword"），如 EVIDENCE_PARAM.commands.items、rosterItem。
  const compile = (spec                         )                          => {
    const out                          = { ...spec }
    if (out.properties && typeof out.properties === 'object') {
      const required           = []
      const props                          = {}
      for (const [key, value] of Object.entries(out.properties                                           )) {
        if (value.required === true) required.push(key)
        const rest = { ...value }
        delete rest.required
        props[key] = compile(rest)
      }
      out.properties = props
      if (required.length > 0) out.required = required
    }
    if (out.items && typeof out.items === 'object') {
      out.items = compile(out.items                           )
    }
    return out
  }
  return { ...tool, parameters: compile(tool.parameters                                      )                          }
}

                              
                                             
                                                
                                                     
                                                      
                                                 
                          
                                                                                   
                  
                                                                                                  
                              
 

/** 行 config（cordis.patch.yml myteam-host.config；全部可省） */
                               
                                                          
                                
                                                                 
                         
                                                                       
                          
     
                                                        
                                                            
                                                                
                                                                
                                                    
                                                       
     
                   
     
                          
                                                 
                                                
                               
     
                                 
                                   
 

/* ── 纯函数域（无 ctx 依赖，便于单测 J1）────────────────────────── */

/** 防御属性读取：普通对象直读（测试注入路径不受影响）；Cordis Context 代理对
 *  既非自有属性、又非已提供服务的属性会抛 "cannot get property ... without
 *  inject"（cordis lib/index.js L676 守卫）→ 捕获后静默 undefined。 */
const isPlainObject = (value         )                                   =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function safeRead(obj         , prop        )      {
  try {
    return (obj                                          )?.[prop]
  } catch {
    return undefined
  }
}

export function resolveTeamLedgerPath(workspaceRoot        , teamId        )         {
  return join(workspaceRoot, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl')
}

/** CHG-71：可能改变「有哪些任务可领」的事件——提交后触发一次派单扫描 */
const DISPATCH_TRIGGER_TYPES = new Set(['task.created', 'task.completed', 'task.rescoped', 'task.updated', 'task.gate.result', 'task.cancelled'])

/** FIX-17：团队名 → 合法 teamId（小写、非字母数字折叠为连字符、去首尾连字符；空则回退 'team'） */
/**
 * 团队名 → teamId slug。纯 ASCII 名直接 slug；**全中文/非 ASCII 名**用名字哈希派生稳定 id
 * （CHG-70：旧实现回退成固定 'team'，两个中文团队会撞同一个账本目录）。
 * 同名 → 同 id（续提/澄清计数语义不变）；不同名 → 不同 id。
 */
export function slugifyTeamName(name        )         {
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
export function readLedgerEvents(ledgerPath        )                                                        {
  const warnings           = []
  if (!existsSync(ledgerPath)) return { events: [], warnings }
  const raw = readFileSync(ledgerPath, 'utf8')
  const events                        = []
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

/** 从账本统计 plan.clarify 事件数（FR-1.6 硬终止计数，T7 防统计盲区） */
export function countClarifyRoundsIn(ledgerPath        )         {
  try {
    return readLedgerEvents(ledgerPath).events.filter((e) => e.type === 'plan.clarify').length
  } catch {
    return 0
  }
}

/** 从账本找 knowledge.proposed 草稿（FR-17.4 策展门） */
export function findKnowledgeProposal(ledgerPath        , draftId        )                             {
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
export function buildKnowledgeView(workspaceRoot        )   
                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                
                                                                                                                
  {
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
  const proposals                                                                                                                                                                                                                      = []
  const timeline                                                                                                       = {}
  const teamsDir = join(workspaceRoot, '.team-workplace', 'state', 'teams')
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
            const draft = (e.payload?.draft ?? {})                       
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
export function pickDefaultTeamId(workspaceRoot        )         {
  const teamsDir = join(workspaceRoot, '.team-workplace', 'state', 'teams')
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

export class MyTeamHost {
          rt             
          services = new Map                     ()
          memberHandles = new Map             () // memberId → AgentHandle
  /** CHG-71 派单唤醒节流：team 级（合并突发事件）与 member 级（防重复打扰） */
          lastDispatchAt = new Map                ()
          lastDispatchWakeAt = new Map                ()
          tokensFiles = new Map                    ()
  /**
   * CHG-86（P0-3）：token 侧车的**上次读到的累计量**基线（teamId → memberId → 四桶）。
   * session 投影给的是全生命周期累计量；没有基线就只能把总量记进"今天"这一个桶，
   * 历史按天数据每次读盘都被抹掉。有了基线，每次只落增量，days 自然长出多天。
   * 冷启动从已有 tokens.json 的 `totals` 恢复基线（见 syncTokens）。
   */
          tokenBaselines = new Map                                                   ()
           workspaceRoot        
           rolePaths                
           config              
  /** TeamService effectiveConfig 覆盖：行 config 显式 > 运行时自有属性（见 constructor 注释） */
          configOverride          
  /** workspace 服务缺失时为 true（initialize 记 warn，提示 .team-workplace 落点降级） */
          workspaceFallback = false
  /**
   * CHG-91（插件团队贡献契约 v1）：第三方插件贡献的角色与团队模板。
   *
   * 装载在 `initialize()` 里（**只读**：`JSON.parse` 文件，不 `import()` 插件代码、不写账本）。
   * 一个插件坏了不影响其它插件（`warnings[]` 收集），但**必须大声**——
   * 面板角色库页顶部显示红条，不静默跳过（契约 P4）。
   */
          contributionCatalog                      = emptyContributionCatalog('')

  constructor(rt             , config               = {}) {
    this.rt = rt
    this.config = { hideBuiltinTeamTools: true, ...config }
    // configOverride 优先级：行 config 显式 > rt 自有属性（t11/t21 测试注入路径）。
    // 真实宿主 rt 是 Cordis Context 代理，且宿主 asar 全文无 configOverride（0 命中）
    // → 真实环境恒 undefined，TeamService 走 loadEffectiveConfig 默认值。
    this.configOverride = config.configOverride ?? safeRead(rt, 'configOverride')
    const ws = safeRead(rt, 'workspace')                                 
    this.workspaceRoot = ws?.root ?? process.cwd()
    this.workspaceFallback = !ws?.root
    this.rolePaths = {
      projectRolesDir: join(this.workspaceRoot, '.team-workplace', 'config', 'roles'),
      // 全局角色库：$DSH_HOME/myteam/roles（CHG-69 与面板/离线聚合统一路径口径）
      globalRolesDir: this.config.globalRolesDir ?? join(resolveMyteamHome(), 'roles'),
      // 项目自身角色（FR-19）：不属于任何团队，可被本项目各团队聘任
      projectRoleFile: join(this.workspaceRoot, '.team-workplace', 'config', 'project-role.json'),
    }
    // T24（CHG-45）：索引缺失时全量重建（冷启动/首次使用），保证面板全局视图先有离线数据
    this.ensureTeamIndex()
  }

  /**
   * CHG-91：重新扫描插件贡献（启动时一次 + 面板/工具显式重载）。
   *
   * 三条纪律（契约 §8 / §11）：
   *  1. **只读**——`loadContributions` 只 `JSON.parse` 文件，不 `import()` 插件代码、不写账本；
   *  2. **失败隔离**——一个插件坏了不影响其它插件（`parseContributions` 里没有 `throw`）；
   *  3. **大声**——每个失败都写进 `warnings`，并 `log('warn')` 一条汇总（面板顶部红条读它）。
   */
  reloadContributions()                      {
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
  contributionSnapshot()                      {
    return this.contributionCatalog
  }

  /** CHG-91：角色目录（**含插件贡献**）——所有调用点统一走这里，避免漏传 contributions 造成分叉 */
  roleCatalog() {
    return listRoleCatalog(this.rolePaths, this.contributionCatalog.roles)
  }

  /** CHG-91：团队模板目录（**含插件贡献**） */
  presetCatalog()                {
    return readPresetCatalog(this.workspaceRoot, this.contributionCatalog.teams)
  }

  /** CHG-91：某个角色是否是插件贡献（只读；写操作要报 `MT_ROLE_READONLY`） */
  contributedRole(roleId        ) {
    return this.contributionCatalog.roles.find((role) => role.id === roleId)
  }

  /** T24：索引缺失时从账本全量重建工作区索引 + 全局索引（失败只 warn） */
  ensureTeamIndex()       {
    try {
      if (readWorkspaceIndex(this.workspaceRoot)) return
      const index = scanWorkspaceIndex(this.workspaceRoot)
      writeWorkspaceIndex(this.workspaceRoot, index)
      upsertGlobalWorkspace(this.workspaceRoot, index)
    } catch (e) {
      this.log('warn', `team index rebuild failed: ${String(e)}`)
    }
  }

  /** T24：commit 后单条 upsert（派生数据；失败不阻断主路径） */
          refreshTeamIndex(teamId        )       {
    try {
      const svc = this.service(teamId)
      const entry = entryFromProjection(teamId, svc.projectionSnapshot)
      const index = upsertTeamEntry(this.workspaceRoot, entry)
      upsertGlobalWorkspace(this.workspaceRoot, index)
    } catch (e) {
      this.log('warn', `team index update failed: ${String(e)}`)
    }
  }

  log(level                           , msg        )       {
    this.rt.logger?.[level]?.(`[myteam] ${msg}`) ?? console[level](`[myteam] ${msg}`)
  }

  /** 可选服务防御读取：缺失返回 undefined（宿主未装该服务时降级而非抛错） */
          svc         (name                                                              )                {
    try {
      return (this.rt                       )[name]                 
    } catch {
      return undefined
    }
  }

  /* ── 初始化（apply 调用；同步部分直接执行，异步收尾进 ctx.effect）── */

  initialize()       {
    const dirs = ensureWorkplaceDirs(this.workspaceRoot, (m) => this.log('warn', m))
    ensureGitignoreManagedBlock(this.workspaceRoot, (m) => this.log('warn', m))
    if (this.workspaceFallback) {
      this.log('warn', `runtime workspace unavailable; .team-workplace rooted at process cwd: ${this.workspaceRoot}`)
    }
    this.log('info', `workplace ready: ${dirs.root} (created ${dirs.created.length} dirs)`)
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
    if (this.config.hideBuiltinTeamTools !== false && this.rt.tools?.restrict) {
      try {
        // CHG-58：restrict 只接受"当前已知的全局工具名"——先过滤，避免宿主没装内置团队
        // 工具时整批抛错（只告警、静默跳过）。作用域 = 队长 preset，成员 agent 继承该限制。
        const known = new Set(
          (((this.rt.tools       ).schemas?.() ?? [])                             )
            .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
            .filter((name) => name.length > 0),
        )
        const deny = known.size === 0 ? [...HOST_TEAM_TOOLS_TO_HIDE] : HOST_TEAM_TOOLS_TO_HIDE.filter((name) => known.has(name))
        if (deny.length > 0) {
          this.rt.tools.restrict({ deny })
          this.log('info', `builtin team tools hidden (${deny.length})`)
        }
      } catch (e) {
        this.log('warn', `restrict for hiding builtin tools failed: ${String(e)}`)
      }
    }
  }

  /** 卸载清理（apply 返回的 disposer 调用）：dispose 全部成员会话 */
  dispose()       {
    for (const handle of this.memberHandles.values()) {
      try { void handle?.dispose?.() } catch { /* 排空尽力而为 */ }
    }
    this.memberHandles.clear()
    this.services.clear()
  }

  /** T13：MyTeamRemote 挂载。TypertRemoteService 构造即完成 Cordis provide + typertRemote
   *  绑定（Gateway source-mode discovery 消费）；此处只构造，不做第二次 provide（防键冲突）。 */
          registerRemote()       {
    try {
      const { MyTeamRemote } = remoteServiceModule
      new MyTeamRemote(this.rt, this)
      this.log('info', 'panel remote registered (namespace: myteam)')
    } catch (e) {
      this.log('warn', `panel remote registration failed: ${String(e)}`)
    }
  }

  /* ── TeamService 管理 ───────────────────────────────────────── */

  defaultTeamId()         {
    return pickDefaultTeamId(this.workspaceRoot)
  }

  /**
   * FIX-17：submit_plan（建新团队）的 id 解析——显式 teamId 优先，否则从团队名 slug 派生。
   * 同名团队复用同一 id（discard 后重提续计澄清轮次 FR-1.6；撞 active 团队由 commit 报错）。
   * 不做 -N 避让：那会让澄清硬终止计数分摊到多个团队而失效。
   */
  resolveNewTeamId(explicit                    , teamName        )         {
    const base = String(explicit ?? slugifyTeamName(teamName)).slice(0, 48)
    return base || 'team'
  }

  service(teamId        )              {
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

  /**
   * CHG-55：任务类型 → 门禁链展开（团队模板 taskTypes 生效）。
   * 显式 gateChain 优先；否则按生效配置 taskTypes[taskType] → taskTypes.default 展开。
   * 都不命中时原样返回（fold 兜底 review/archive）。
   */
          taskWithGateChain(teamId        , task                         )                          {
    const explicit = Array.isArray(task.gateChain)
      ? (task.gateChain             ).filter((gate)                 => typeof gate === 'string' && gate.length > 0)
      : []
    if (explicit.length > 0) return task
    const types = this.service(teamId).effectiveConfig.taskTypes
    const type = typeof task.taskType === 'string' && task.taskType ? task.taskType : 'default'
    const chain = types[type]?.gateChain ?? types.default?.gateChain
    return chain && chain.length > 0 ? { ...task, gateChain: [...chain] } : task
  }

  /** 统一提交入口：成功后触发唤醒（不阻塞提交本身） */
  commit(teamId        , draft             )                                    {
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
    teamId        ,
    args                         ,
    draft                                       ,
  )                                    {
    const expected = this.expectedRevisionOf(args)
    return this.commit(teamId, { ...draft, ...(expected !== undefined ? { expectedRevision: expected } : {}) })
  }

  /** FIX-12：agents.create 返回形状未实证（宿主可能是 agent 本体或 {agent} 包装）——双形状兼容 */
          agentOf(handle         )                                                                                   {
    const h = handle                                                       
    if (!h) return undefined
    if (h.agent) return h.agent                                                                        
    if (typeof h.followup === 'function') return h                                        
    return undefined
  }

  /**
   * FIX-16（KI-2 实弹）：followup 消息必须带标识（dsh-llm createUserMessage：{role:'user',
   * content, source, id:uuid}）——裸 {content, source} 会建 turn 但 prompt 为空（成员 turn 1
   * 空转、零 LLM 请求，实弹 turnOutline prompt:"" 实证）。插件不依赖 dsh-llm，自构同形消息。
   */
          followupMessage(text        )                          {
    return {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-plugin-myteam' },
    }
  }

          afterCommit(teamId        , event                                                                 )       {
    this.refreshTeamIndex(teamId)
    const wakes = wakeDecisionsFor(event)                  
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
          notifyTaskEdited(teamId        , event                                                   )       {
    try {
      const svc = this.service(teamId)
      const taskId = String(event.payload.taskId ?? '')
      const t = svc.projectionSnapshot.tasks[taskId]
      const assignee = t?.assignee
      if (!t || !assignee) return
      if (!t.attemptId) return // 还没开跑：编辑会随下一次 claim 的读取自然生效
      const patch = (event.payload.patch                           ) ?? {}
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
          dispatchSweep(teamId        )       {
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
      const byRole = new Map                             ()
      for (const member of idle) {
        if (!this.memberHandles.has(member.id)) continue
        if (now - (this.lastDispatchWakeAt.get(member.id) ?? 0) < memberCooldown) continue
        if (!byRole.has(member.roleId)) byRole.set(member.roleId, member)
      }
      const woken           = []
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

          registerLeadTools()       {
    if (!this.rt.tools) {
      throw new Error('[myteam] ctx.tools unavailable; cannot register lead tools（fail-fast，检查 preset 组合 inject）')
    }
    for (const def of leadToolDefs()) {
      const compiled = compileParameters(def)
      this.rt.tools.register({
        ...compiled,
        // 宿主 output 契约（tools.register 校验器强制）：schema 会被用于 execute 返回值校验
        output: toolOutput(),
        execute: (args                         , exec                 ) => {
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
    name        ,
    args                         ,
    exec                                            = {},
  )                                                             {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const actor = exec.actor === 'human' ? 'human' : 'lead'
    try {
      switch (name) {
        case 'myteam_submit_plan': {
          // FR-11.2 七项硬校验先行（修订：原实现 team.created 先落账、校验失败无法回滚，
          // 会在账本里留下"幽灵团队"；现在校验失败时零事件落账）。
          // FIX-17（KI-2 实弹）：submit_plan 是"建新团队"语义，teamId 缺省不能走 defaultTeamId()
          // （recent-mtime 会解析到别的活跃团队，账本落错地方）。改为显式 teamId 优先，
          // 否则从团队名 slug 派生，与既有团队冲突时自动加 -N 后缀。
          const newTeamId = this.resolveNewTeamId(args.teamId                      , String(args.teamName))
          // CHG-70：同名团队已批准 → 拒绝重复提交（旧实现会落 team.created/plan.staged，
          // 把 active 团队打回 draft 并覆盖名字）。改名走 myteam_update_team；重建先解散。
          if (existsSync(resolveTeamLedgerPath(this.workspaceRoot, newTeamId))) {
            const existing = this.service(newTeamId).projectionSnapshot
            if (existing.state === 'active') {
              return {
                status: 'error',
                code: 'MT_TEAM_STATE',
                message: `team "${newTeamId}" already exists and is active; 改名用 myteam_update_team，重建请先 myteam_disband`,
              }
            }
          }
          // 块级遮蔽：分支内既有 teamId 引用（validatePlan/commit/payload）统一指向新团队 id
          const teamId = newTeamId
          const presetId = typeof args.presetId === 'string' && args.presetId.trim() ? args.presetId.trim() : ''
          const preset = presetId ? this.presetCatalog().entries.find((entry) => entry.definition.id === presetId) : undefined
          if (presetId && !preset) {
            return { status: 'error', code: 'MT_VALIDATION', message: `team preset "${presetId}" not found (project/builtin)` }
          }
          const rosterIn = (args.roster ?? [])                                                                                           
          // v2.13/CHG-36 预置团队：未显式给名册时按内置模板成团（标准三人组：队长+需求验证+开发+验收）；
          // CHG-54：显式 presetId 时按项目/内置模板的 members 组队（队长隐式），成员可带技能/MCP 覆写。
          const usingPresetRoster = rosterIn.length === 0
          const roster = preset
            ? [{ roleId: 'captain' }, ...preset.definition.members]
            : usingPresetRoster ? presetTeamRoster('triad') : rosterIn
          // 模板/名册引用的角色：全局与内置先复制进项目库（运行时只认项目层，R13）
          const roleErrors           = []
          for (const entry of roster) {
            if (entry.roleId === 'captain') continue
            const catalogEntry = this.roleCatalog().find((item) => item.definition.id === entry.roleId)
            if (!catalogEntry) {
              roleErrors.push(`unknown role "${entry.roleId}"`)
              continue
            }
            if (!readProjectRole(this.rolePaths.projectRolesDir, entry.roleId)) {
              try {
                copyToProject(this.rolePaths, entry.roleId, catalogEntry.origin, this.contributionCatalog.roles)
              } catch (e) {
                roleErrors.push(`role "${entry.roleId}": ${String((e                        ).message ?? e)}`)
              }
            }
          }
          if (roleErrors.length > 0) return { status: 'error', code: 'MT_VALIDATION', message: roleErrors.join('; ') }
          // CHG-55：模板的看板列/泳道/门禁/任务类型落成团队级 team.config.json——
          // 必须在 service(teamId) 首次创建之前写盘（TeamService 构造时读一次并缓存）。
          // 只对"新团队"落盘：同 id 续提/已存在团队不覆盖既有配置（避免编辑正在跑的团队）。
          const presetConfig = preset ? configOverrideFromPreset(preset.definition) : undefined
          const isNewTeam = !this.services.has(teamId) && !existsSync(resolveTeamLedgerPath(this.workspaceRoot, teamId))
          let configApplied                      
          if (presetConfig && isNewTeam) {
            writeTeamConfigRaw(this.workspaceRoot, teamId, presetConfig)
            configApplied = Object.keys(presetConfig)
          }
          const tasksIn = (args.tasks ?? [])                     
          const svc0 = this.service(teamId)
          const tasksMap                                          = {}
          for (let i = 0; i < tasksIn.length; i++) tasksMap[String(tasksIn[i].id ?? `task-${i + 1}`)] = tasksIn[i]                           
          const rosterRoles = [...new Set([...roster.map((r0) => r0.roleId), 'captain'])]
          const planCheck = validatePlan(tasksMap         , svc0.effectiveConfig.limits.maxTasks, rosterRoles)
          if (!planCheck.ok) {
            return {
              status: 'error',
              code: 'MT_VALIDATION',
              message: planCheck.errors.map((e) => `task ${e.taskId}: ${e.message}`).join('; '),
            }
          }
          // 澄清轮先落账（FR-1.6：≤N 轮硬终止计数在账本）
          const clarify = args.clarify                                         
          if (clarify?.questions && clarify.questions.length > 0) {
            const round = this.countClarifyRounds(teamId) + 1
            const maxRounds = svc0.effectiveConfig.clarify.maxRounds
            if (round > maxRounds) {
              return { status: 'clarify-limit', message: `澄清已达 ${maxRounds} 轮硬终止；请用默认值+假设标注出草稿（FR-1.6）` }
            }
            const rc = this.commit(teamId, { actor, type: 'plan.clarify', payload: { teamId, questions: clarify.questions, round } })
            if (!rc.ok) return { status: 'error', code: rc.code, message: rc.message }
          }
          const r1 = this.commit(teamId, { actor, type: 'team.created', payload: { teamId, name: args.teamName, goal: args.goal, roster } })
          if (!r1.ok) return { status: 'error', code: r1.code, message: r1.message }
          const r2 = this.commit(teamId, { actor, type: 'plan.staged', payload: { teamId, planId: `plan-${Date.now()}`, roster, tasks: args.tasks, ...(preset ? { presetId: preset.definition.id } : {}) } })
          if (!r2.ok) return { status: 'error', code: r2.code, message: r2.message }
          return {
            status: 'staged',
            teamId,
            roster,
            ...(preset ? { presetId: preset.definition.id, presetName: preset.definition.name } : {}),
            ...(presetConfig && configApplied ? { configApplied } : {}),
            note:
              '草稿已暂存（无成员会话产生）；等待人工 Approve & Run / Revise / Discard' +
              (preset
                ? `；已应用团队模板「${preset.definition.name}」（队长 + ${preset.definition.members.length} 名队员）` +
                  (configApplied ? `；配置段落已落团队：${configApplied.join('/')}` : '')
                : usingPresetRoster ? '；未显式提供名册，已应用预置团队「标准三人组」（队长+需求验证员+开发者+验收员）' : ''),
          }
        }
        case 'myteam_approve_plan': {
          // 守卫：团队已 active（计划已批准过）→ 拒绝二次 approve，防止任务重复入库
          if (this.service(teamId).projectionSnapshot.state === 'active') {
            return { status: 'error', code: 'MT_VALIDATION', message: `plan already approved (teamId: ${teamId})` }
          }
          // FIX-11：先确认账本里有 staged 计划再落 plan.approved——否则"Approve & Run"
          // 会静默成功而 Run（自动召唤）无声跳过（t23-1 实弹回归暴露）。
          const stagedPlan = [...readLedgerEvents(resolveTeamLedgerPath(this.workspaceRoot, teamId)).events]
            .reverse()
            .find((e) => e.type === 'plan.staged')
          if (!stagedPlan) {
            return { status: 'error', code: 'MT_VALIDATION', message: `no staged plan to approve (teamId: ${teamId})` }
          }
          const r = this.commit(teamId, { actor, type: 'plan.approved', payload: { teamId, planId: String(args.planId ?? 'plan-latest') } })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          // FIX-9（KI-2 实弹）：Approve & Run 的 Run 由执行面落地——队长 turn 在提交计划后已结束，
          // 账本事件不会唤醒任何 LLM（wake 管线只覆盖成员四因果）。批准后按名册自动召唤成员
          // （跳过 captain——队长是 preset 会话本身），成员 followup 引导首轮自治 claim。
          // revise/discard 仍需队长改计划，走收件箱提醒（M1 面板可见，队长下次被 @ 时处理）。
          const staged = [...readLedgerEvents(resolveTeamLedgerPath(this.workspaceRoot, teamId)).events]
            .reverse()
            .find((e) => e.type === 'plan.staged')
          const roster = (staged?.payload?.roster                                                                                                            ) ?? []
          const spawned           = []
          const spawnErrors           = []
          for (const entry of roster) {
            if (entry.roleId === 'captain') continue
            const out = this.spawnMember(teamId, entry.roleId, entry.instanceName, {
              skills: entry.skills,
              mcpAllowlist: entry.mcpAllowlist,
            })
            if (out.status === 'spawned') {
              spawned.push(String(out.memberId))
              // 上岗引导由 spawnMember 在 handle 到手后发出（FIX-14 内聚）
            } else {
              spawnErrors.push(`${entry.instanceName ?? entry.roleId}: ${String((out       ).message ?? (out       ).code ?? 'spawn failed')}`)
            }
          }
          // FIX-13（KI-2 实弹）：plan.staged 的任务只存在于计划 payload（fold 只置 state=draft，
          // 任务不进 tasksMap）——批准后成员上岗看到空板、无任务可 claim，"Run"断在任务上板。
          // 成员就位后把 staged 计划的任务逐条入库（task.created → backlog；必须先 spawn——
          // task.created 领域校验 rosterRoles 以投影成员角色为准，空投影会走草稿分支误拒）。
          const stagedTasks = (stagedPlan.payload?.tasks                                              ) ?? []
          const createdTasks           = []
          const createErrors           = []
          for (const t of stagedTasks) {
            const proj0 = this.service(teamId).projectionSnapshot.tasks
            let maxN = 0
            for (const id of Object.keys(proj0)) {
              const mm = /^task-(\d+)$/.exec(id)
              if (mm) maxN = Math.max(maxN, Number(mm[1]))
            }
            const taskId = `task-${maxN + 1}`
            const r2 = this.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: this.taskWithGateChain(teamId, t) } })
            if (r2.ok) createdTasks.push(taskId)
            else createErrors.push(`create_task ${String(t.taskKey ?? taskId)}: ${r2.message}`)
          }
          return {
            status: 'approved',
            teamId,
            note: '成员召唤经 myteam_spawn_member 逐个执行（名册 → spawn）；staged 任务已入库上板',
            spawned,
            ...(createdTasks.length > 0 ? { createdTasks } : {}),
            ...(createErrors.length > 0 ? { createErrors } : {}),
            ...(spawnErrors.length > 0 ? { spawnErrors } : {}),
          }
        }
        case 'myteam_revise_plan': {
          const r = this.commit(teamId, { actor, type: 'plan.revised', payload: { teamId, planId: String(args.planId ?? 'plan-latest'), note: args.note } })
          return r.ok ? { status: 'revised' } : { status: 'error', code: r.code, message: r.message }
        }
        case 'myteam_discard_plan': {
          if (args.confirm !== true) return { status: 'confirm-required', message: 'Discard 是两段确认操作：草稿将归档且不会自动重建，请带 confirm=true 重调' }
          const r = this.commit(teamId, { actor, type: 'plan.discarded', payload: { teamId, planId: String(args.planId ?? 'plan-latest') } })
          return r.ok ? { status: 'discarded' } : { status: 'error', code: r.code, message: r.message }
        }
        case 'myteam_create_task': {
          // taskId 由 host 分配（契约 docs/04 §1.1）；取投影中 task-N 最大 N + 1（重放幂等）
          const proj0 = this.service(teamId).projectionSnapshot.tasks
          let maxN = 0
          for (const id of Object.keys(proj0)) {
            const m = /^task-(\d+)$/.exec(id)
            if (m) maxN = Math.max(maxN, Number(m[1]))
          }
          const taskId = args.taskId ? String(args.taskId) : `task-${maxN + 1}`
          const r = this.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: this.taskWithGateChain(teamId, (args.task ?? {})                           ) } })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          // CHG-73（FR-29）：一次写入负责队员与参与团队——创建任务时人已经知道"谁做/谁协作"，
          // 不该让面板/队长再串三次调用（部分失败不撤销任务本身，按 warnings 显性化）
          const created = this.applyTaskRelations(teamId, taskId, args, actor)
          return { status: 'created', taskId, ...created }
        }
        /* CHG-86（P0-4）：队长侧工具改名 myteam_edit_task（原 myteam_update_task 与成员作用域重名，
         * 同名跨层注册时解析顺序决定谁生效——若队长侧生效，成员可绕过 attemptId 校验改任务结构） */
        case 'myteam_edit_task': {
          const taskIdArg = String(args.taskId ?? '')
          const patch = (isPlainObject(args.patch) ? args.patch : {})                           
          const rescope = args.rescope                                   
          // CHG-73：rescope 走统一的"一键重新规划"管线（撤 attempt → 回 ready/backlog → 可选重派）
          if (rescope) {
            return this.rescopeTask(teamId, { teamId, taskId: taskIdArg, reason: rescope.reason, patch, memberIds: args.memberIds }, actor)
          }
          // CHG-70：普通编辑走 task.updated（补丁合并，**不改状态/attempt/证据**）；
          // CHG-73：把字段级 diff 一起落账——详情页「改动记录」与证据过期判定都读它
          const task = this.service(teamId).projectionSnapshot.tasks[taskIdArg]
          const changes = task ? diffTaskInput(task.input                                      , patch) : []
          const r = this.commitGuarded(teamId, args, { actor, type: 'task.updated', payload: { teamId, taskId: taskIdArg, patch, changes } })
          return r.ok
            ? { status: 'updated', taskId: taskIdArg, changes }
            : { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }
        }
        /* CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口——修复前无任何入口能提交 task.gate.result，
         * 默认链 ['review','archive'] 下任务 done 后停在 gate:review 永远到不了 done。 */
        case 'myteam_review_task':
          return this.reviewTask(teamId, args, actor)
        case 'myteam_update_team': {
          const payload                          = { teamId }
          if (args.name !== undefined) payload.name = String(args.name).trim()
          if (args.goal !== undefined) payload.goal = String(args.goal).trim()
          const r = this.commit(teamId, { actor, type: 'team.updated', payload })
          return r.ok
            ? { status: 'updated', teamId, ...(args.name !== undefined ? { name: String(args.name).trim() } : {}), ...(args.goal !== undefined ? { goal: String(args.goal).trim() } : {}) }
            : { status: 'error', code: r.code, message: r.message }
        }
        /* ── CHG-73：执行期编辑闭环（重规划 / 取消 / 批量编排 / 角色删除）── */
        case 'myteam_rescope_task':
          return this.rescopeTask(teamId, args, actor)
        case 'myteam_cancel_task':
          return this.cancelTask(teamId, args, actor)
        case 'myteam_batch_task_op':
          return this.batchTaskOp(teamId, args, actor)
        /* ── CHG-76：批量建任务（从目标出草稿 → 预览 → 一次创建）── */
        case 'myteam_create_tasks':
          return this.createTasksBatch(teamId, args, actor)
        case 'myteam_delete_role':
          return this.deleteRoleTool(String(args.roleId ?? ''), args.confirm === true)
        case 'myteam_reassign_task':
        case 'myteam_revoke_attempt': {          const svc = this.service(teamId)
          const proj = svc.projectionSnapshot
          const task = proj.tasks[String(args.taskId)]
          const prevAttempt = task?.attemptId
          const r1 = this.commitGuarded(teamId, args, { actor, type: 'task.attempt.revoked', payload: { teamId, taskId: args.taskId, attemptId: prevAttempt ?? 'none', reason: args.reason, prevAssignee: task?.assignee } })
          if (!r1.ok) {
            return { status: 'error', code: r1.code, message: r1.message, ...(r1.currentRevision !== undefined ? { currentRevision: r1.currentRevision } : {}) }
          }
          if (name === 'myteam_reassign_task') {
            // CHG-87（QA-4）：重派也吃乐观锁（先撤 attempt 再指派，冲突时两步都不落账）
            const r2 = this.commitGuarded(teamId, args, { actor, type: 'task.assigned', payload: { teamId, taskId: args.taskId, memberId: args.toMemberId } })
            return r2.ok
              ? { status: 'reassigned', note: '等待目标成员 claim（原子 claim 语义保留）' }
              : { status: 'error', code: r2.code, message: r2.message, ...(r2.currentRevision !== undefined ? { currentRevision: r2.currentRevision } : {}) }
          }
          return { status: 'revoked' }
        }
        case 'myteam_spawn_member': {
          return this.spawnMember(teamId, String(args.roleId), args.instanceName ? String(args.instanceName) : undefined, {
            skills: Array.isArray(args.skills) ? args.skills.filter((skill)                  => typeof skill === 'string') : undefined,
            mcpAllowlist: Array.isArray(args.mcpAllowlist) ? args.mcpAllowlist.filter((name)                 => typeof name === 'string') : undefined,
          })
        }
        case 'myteam_release_member': {
          return this.releaseMember(teamId, String(args.memberId), String(args.mode), args.confirm === true)
        }
        case 'myteam_message': {
          const to = String(args.to)
          const r = this.commit(teamId, { actor, type: 'message.sent', payload: { teamId, messageId: `msg-${Date.now()}`, from: 'lead', to, taskId: args.taskId, kind: args.kind ?? 'notify', content: args.content } })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          if (to !== 'inbox') {
            this.agentOf(this.memberHandles.get(to))?.followup?.(this.followupMessage(`[myteam] 队长消息（${String(args.kind ?? 'notify')}）：${String(args.content)}`))
          }
          return { status: 'sent' }
        }
        case 'myteam_interrupt': {
          const memberId = String(args.memberId)
          const interruptAgent = this.agentOf(this.memberHandles.get(memberId))
          if (interruptAgent?.cancel) {
            interruptAgent.cancel({ kind: 'user' })
            this.commit(teamId, { actor, type: 'member.interrupted', payload: { teamId, memberId, reason: args.reason } })
            return { status: 'interrupted', note: 'interrupt 只停当前轮；会话保留' }
          }
          return { status: 'not-running' }
        }
        case 'myteam_disband': {
          if (args.confirm !== true) return { status: 'confirm-required', message: '解散是两段确认操作（影响面：成员排空/未完成任务转 blocked/账本归档），请带 confirm=true 重调' }
          const svc = this.service(teamId)
          const proj = svc.projectionSnapshot
          const memberCount = Object.keys(proj.members).length
          const taskCount = Object.keys(proj.tasks).length
          // CHG-86（P0-2）：归档必须**真的落盘**。旧实现只往账本写一条 team.disbanded
          // （payload 里带个路径字符串），没有任何文件 IO——面板归档视图渲染的
          // archive/<id>/{team.json,tokens.json,members/,artifacts/} 永远不存在，整套是空壳。
          // 顺序：先落账本（状态变 archived）→ 再按归档态快照写文件 → 最后释放成员。
          const disbanded = this.commit(teamId, { actor, type: 'team.disbanded', payload: { teamId, archivedPaths: [`.team-workplace/archive/${teamId}`] } })
          if (!disbanded.ok) {
            return { status: 'error', code: disbanded.code, message: disbanded.message }
          }
          let archived                                                                   
          try {
            const after = this.service(teamId).projectionSnapshot
            const tokens = this.syncTokens(teamId)
            const snapshot = buildArchiveSnapshot({
              team: after,
              tokens,
              archivedAt: Date.now(),
              archivedBy: actor,
              ledgerPath: svc.ledgerPath,
              eventCount: after.revision,
            })
            archived = writeArchive(this.workspaceRoot, snapshot)
          } catch (e) {
            // 归档写失败不静默：账本已记 disbanded，但必须让调用方知道文件没落盘
            this.log('error', `archive write for ${teamId} failed: ${String(e)}`)
            this.dispose()
            return {
              status: 'error',
              code: 'MT_ARCHIVE_FAILED',
              message: `团队已解散但归档落盘失败：${String(e)}（账本仍完整，可用 myteam_list_archives 复查）`,
              impact: { members: memberCount, tasks: taskCount },
            }
          }
          this.dispose()
          return {
            status: 'disbanded',
            impact: { members: memberCount, tasks: taskCount },
            archive: archived,
            note: `归档已落盘：${archived.relativeDir}（${archived.files.length} 个文件，只读可查）`,
          }
        }
        case 'myteam_resolve_proposal': {
          return this.resolveProposal(teamId, args, actor)
        }
        case 'myteam_adopt_knowledge': {
          // 策展门（FR-17.4）：提案必须存在账本；adopted 落库带归因
          const draftId = String(args.draftId)
          const decision = String(args.decision)
          if (decision === 'rejected') {
            const r = this.commit(teamId, { actor, type: 'knowledge.adopted', payload: { teamId, draftId, decision: 'rejected', note: args.note } })
            return r.ok ? { status: 'rejected', note: '提案已留痕驳回；不入库' } : { status: 'error', code: r.code, message: r.message }
          }
          const svc = this.service(teamId)
          const proposedEvent = findKnowledgeProposal(svc.ledgerPath, draftId)
          if (!proposedEvent) return { status: 'error', code: 'MT_VALIDATION', message: `knowledge proposal "${draftId}" not found in ledger` }
          const draft = proposedEvent.payload.draft                  
          const now = new Date().toISOString()
          const kbDir = knowledgeDirOf(this.workspaceRoot)
          const existingEntries = listKnowledge(kbDir)
          const proposer = String(proposedEvent.payload.proposedBy ?? 'unknown')
          // v2.7（M2-0c，FR-17.4）：refine/contradict 走演化式修订（reviseEntry）；
          // refine = 精炼既有条目（staleSince 清除），contradict = 矛盾记录轨迹（标 staleSince 待复核）。
          if (draft.relation === 'refine' || draft.relation === 'contradict') {
            const targetId = draft.targetId ?? draft.id
            const target = existingEntries.find((e) => e.id === targetId)
            if (!target) return { status: 'error', code: 'MT_VALIDATION', message: `${draft.relation} proposal targets unknown entry "${targetId}"` }
            const { entry, diffSummary } = reviseEntry(target, draft, proposer, now)
            const written = writeKnowledgeEntry(kbDir, entry)
            const r = this.commit(teamId, { actor, type: 'knowledge.revised', payload: { teamId, entryId: entry.id, relation: draft.relation, diff: diffSummary } })
            return r.ok
              ? { status: 'revised', entryPath: written.filePath, diff: diffSummary, note: draft.relation === 'refine' ? '条目已精炼（演化节留轨迹）；成员索引下轮 spawn/重启生效' : '矛盾证据已记录轨迹并标记待复核（原断言未改写）；请安排复核' }
              : { status: 'error', code: r.code, message: r.message }
          }
          const existing = new Set(existingEntries.map((e) => e.id))
          const entry = adoptDraft(draft, proposer, existing, now)
          const written = writeKnowledgeEntry(kbDir, entry)
          const r = this.commit(teamId, { actor, type: 'knowledge.adopted', payload: { teamId, draftId, entryPath: written.filePath, note: args.note } })
          return r.ok
            ? { status: 'adopted', entryPath: written.filePath, note: '知识条目已入库（config/knowledge/，带 evidence+contributor 归因）；成员索引下轮 spawn/重启生效' }
            : { status: 'error', code: r.code, message: r.message }
        }
        case 'myteam_participate_task': {
          const role = args.role === 'lead' ? 'lead' : 'coop'
          const memberIds = Array.isArray(args.memberIds)
            ? args.memberIds.filter((id)               => typeof id === 'string' && id.length > 0)
            : []
          const r = this.commit(teamId, {
            actor,
            type: 'task.participate',
            payload: {
              teamId,
              taskId: args.taskId,
              participantTeamId: args.participantTeamId,
              role,
              ...(memberIds.length > 0 ? { memberIds } : {}),
            },
          })
          return r.ok
            ? { status: 'participating', note: `任务 ${String(args.taskId)} 已登记参与团队 ${String(args.participantTeamId)}（${role}）` }
            : { status: 'error', code: r.code, message: r.message }
        }
        case 'myteam_assign_task': {
          const ids = Array.isArray(args.memberIds)
            ? args.memberIds.filter((id)               => typeof id === 'string' && id.length > 0)
            : []
          if (ids.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'memberIds requires at least 1 member' }
          const r = this.commit(teamId, {
            actor,
            type: 'task.assigned',
            payload: { teamId, taskId: args.taskId, memberId: ids[0], memberIds: ids },
          })
          return r.ok
            ? { status: 'assigned', taskId: args.taskId, memberIds: ids, note: '负责队员已标注；执行仍按角色 claim（指派不改变调度）' }
            : { status: 'error', code: r.code, message: r.message }
        }
        case 'myteam_set_project_role': {
          if (args.clear === true) {
            if (args.confirm !== true) return { status: 'confirm-required', message: '取消项目自身角色是两段确认操作，请带 confirm=true 重调' }
            clearProjectRoleCard(this.rolePaths)
            return { status: 'cleared', note: '项目自身角色已取消（不影响任何团队）' }
          }
          const roleId = String(args.roleId ?? '')
          const entry = this.roleCatalog().find((item) => item.definition.id === roleId)
          if (!entry) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in any library` }
          if (args.confirm !== true) {
            return {
              status: 'confirm-required',
              role: { id: entry.definition.id, name: entry.definition.name, origin: entry.origin },
              message: `把「${entry.definition.name}」设为项目自身角色？它不属于任何团队，可被本项目各团队聘任。带 confirm=true 落盘`,
            }
          }
          try {
            const written = writeProjectRoleCard(this.rolePaths, structuredClone(entry.definition))
            return {
              status: 'set',
              roleId,
              filePath: written.filePath,
              note: '项目自身角色已写入 config/project-role.json；团队组队时可直接聘任该角色',
            }
          } catch (e) {
            return this.roleError(e)
          }
        }
        case 'myteam_create_role':
          return this.createRole(args)
        case 'myteam_update_role':
          return this.updateRole(args)
        case 'myteam_apply_roles':
          // CHG-87（FR-16.1）：单角色调用——只写 config/roles/session-defaults.json，不碰团队账本
          return this.applyRoles(teamId, args, actor)
        case 'myteam_list_presets':
          return this.listPresetsTool()
        // CHG-91（插件团队贡献契约 v1）：插件贡献的只读视图 + 显式重载
        case 'myteam_list_contributions':
          return this.listContributionsTool()
        case 'myteam_reload_contributions':
          return this.listContributionsTool(this.reloadContributions())
        case 'myteam_save_preset':
          return this.savePreset(args)
        case 'myteam_copy_preset':
          return this.copyPreset(args)
        case 'myteam_delete_preset':
          return this.deletePreset(args)
        case 'myteam_reset_team_config':
          return this.resetTeamConfig(teamId, args)
        default:
          return { status: 'error', code: 'MT_UNKNOWN_TOOL', message: `unknown lead tool: ${name}` }
      }
    } catch (e) {
      return { status: 'error', code: 'MT_INTERNAL', message: String(e) }
    }
  }

          countClarifyRounds(teamId        )         {
    return countClarifyRoundsIn(resolveTeamLedgerPath(this.workspaceRoot, teamId))
  }

  /* ── CHG-73：执行期编辑闭环（面板受限写端点与队长工具共用同一条管线）── */

  /**
   * 一次写入「负责队员 + 参与团队」（FR-29/FR-21）。
   * 任务是主实体，关系是标注——关系写失败不回滚任务，只按 warnings 显性化。
   */
          applyTaskRelations(teamId        , taskId        , args                         , actor        )                          {
    const out                          = {}
    const warnings           = []
    const assignees = Array.isArray(args.assignees)
      ? (args.assignees             ).filter((id)               => typeof id === 'string' && id.length > 0)
      : []
    if (assignees.length > 0) {
      const r = this.commit(teamId, { actor, type: 'task.assigned', payload: { teamId, taskId, memberId: assignees[0], memberIds: assignees } })
      if (r.ok) out.assigned = assignees
      else warnings.push(`assignees: ${r.message}`)
    }
    const participants = Array.isArray(args.participants) ? (args.participants                             ) : []
    const registered           = []
    for (const participant of participants) {
      const participantTeamId = String(participant?.teamId ?? '')
      if (!participantTeamId) {
        warnings.push('participants: entry without teamId skipped')
        continue
      }
      const ids = Array.isArray(participant.memberIds)
        ? (participant.memberIds             ).filter((id)               => typeof id === 'string' && id.length > 0)
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
          revokeAttemptIfAny(teamId        , taskId        , reason        , actor        )                                                                       {
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
          rescopeTask(teamId        , args                         , actor        )                          {
    const taskId = String(args.taskId ?? '')
    const reason = String(args.reason ?? '').trim()
    if (!taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    if (!reason) return { status: 'error', code: 'MT_VALIDATION', message: 'rescope requires a non-empty reason（为什么重新规划必须写清）' }
    const task = this.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    if (TERMINAL_STATES.has(task.state)) {
      return { status: 'error', code: 'MT_TASK_TERMINAL', message: `task "${taskId}" is ${task.state}; 终态任务不能重新规划（要重开请新建任务）` }
    }
    const patch = (isPlainObject(args.patch) ? args.patch : {})                           
    const changes = diffTaskInput(task.input                                      , patch)
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
    const memberIds = Array.isArray(args.memberIds)
      ? (args.memberIds             ).filter((id)               => typeof id === 'string' && id.length > 0)
      : []
    let assigned                      
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
   * CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口（队长工具 + 面板 reviewTask 共用）。
   *
   * 修复的断链：`task.gate.result` 此前**只有**成员 `update_task` 的 archive 分支会写，
   * 而默认门禁链是 `['review','archive']`——任务 done 后进的是 `gate:review` 不是
   * `gate:archive`，条件永不成立；且任何 Lead 工具 / 面板端点都没有裁决入口。
   * 结果：任务永远到不了 `done`，下游依赖永不解锁，归档与成本管线全部悬空。
   *
   * 裁决口径：
   *  - `gate:review` / `gate:verify` → 只认显式结论行（verdict 必填），**强制交叉审查**
   *    （reviewerMemberId 必填且 ≠ 实现者；同成员拒绝 `MT_CROSS_REVIEW`，FR-5.1）；
   *  - `gate:archive` → 不是人工裁决门：host 按 `deliverableSpec` 约定路径做落位校验
   *    （FR-10.4），verdict 参数只用于"再校验一次"，**绝不采信模型自述"已归档"**；
   *  - 打回预算（FR-5.2）：单门 fail 轮数 ≥ `GATE_REJECT_BUDGET` 后，队长侧 pass 被拒
   *    （`MT_REJECT_BUDGET` → needs-human），只有人工（actor='human' 且 confirm=true）能放行。
   */
          reviewTask(
    teamId        ,
    args                         ,
    actor        ,
  )                                                             {
    const taskId = String(args.taskId ?? '')
    if (!taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    const verdict = args.verdict === 'pass' ? 'pass' : args.verdict === 'fail' ? 'fail' : undefined
    if (!verdict) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        message: 'verdict must be "pass" or "fail"（只认显式结论行；无结论 = needs-human，不回退解析自由文本 FR-5.1）',
      }
    }
    const task = this.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    if (!task.state.startsWith('gate:')) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        message: `task "${taskId}" is ${task.state}, not in a gate state（门禁裁决只对 gate:* 任务有效；先由实现者申报 done）`,
      }
    }
    const gate = task.state.slice('gate:'.length)

    // ① archive 门：结论由文件事实决定
    if (gate === 'archive') {
      const evaluated = this.evaluateArchiveGate(teamId, taskId, actor)
      return {
        status: evaluated.pass ? 'gate-pass' : 'gate-fail',
        gate,
        taskState: this.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? task.state,
        note: evaluated.note,
        ...(evaluated.reason ? { reason: evaluated.reason } : {}),
        note2: 'archive 门由 host 按 deliverableSpec 约定路径做落位校验（FR-10.4），不接受模型自述「已归档」',
      }
    }

    // ①b verify 门：**不接受人工 verdict** —— host 跑命令取真实退出码（FR-5.3）
    // 「绝不采信模型自述『测试通过』」：连人工点了 pass 都不算，只有进程退出码算。
    // （人工强制放行是独立的 confirm 通道，会留痕 forcedBy:'human'。）
    if (gate === 'verify') {
      return this.runVerifyGate(teamId, taskId, args, actor)
    }

    // ② review 门：强制交叉审查（FR-5.1）
    const reviewer = String(args.reviewerMemberId ?? '').trim()
    if (!reviewer) {
      return {
        status: 'error',
        code: 'MT_CROSS_REVIEW',
        message: `gate "${gate}" requires reviewerMemberId（强制交叉审查 FR-5.1：审查者必须是另一名成员）`,
      }
    }
    const reviewerMember = this.service(teamId).projectionSnapshot.members[reviewer]
    if (!reviewerMember) return { status: 'error', code: 'MT_VALIDATION', message: `reviewer "${reviewer}" not found in this team` }
    const implementer = task.assignee
    if (implementer && reviewer === implementer) {
      return {
        status: 'error',
        code: 'MT_CROSS_REVIEW',
        message: `reviewer "${reviewer}" is the implementer of "${taskId}"; 强制交叉审查要求审查者不同于实现者（FR-5.1）`,
      }
    }

    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (verdict === 'fail' && !reason) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'verdict=fail requires a non-empty reason（打回必须写清要改什么）' }
    }
    const rejectCount = task.gateRejects?.[gate] ?? 0
    // ③ 打回预算（FR-5.2）：超预算后只有人工能放行
    if (verdict === 'pass' && rejectCount >= GATE_REJECT_BUDGET && !(actor === 'human' && args.confirm === true)) {
      return {
        status: 'needs-human',
        code: 'MT_REJECT_BUDGET',
        gate,
        taskState: task.state,
        rejectCount,
        message: `gate "${gate}" 已打回 ${rejectCount} 轮，达到复验预算上限（≤${GATE_REJECT_BUDGET}）；需人工裁决（面板带 confirm=true 可放行）`,
      }
    }
    const scopeAudit = this.scopeAuditFor(teamId, taskId)
    const r = this.commit(teamId, {
      actor,
      type: 'task.gate.result',
      payload: { teamId, taskId, gate, verdict, ...(reason ? { reason } : {}), reviewerMemberId: reviewer, ...(scopeAudit ? { scopeAudit } : {}) },
      ...(this.expectedRevisionOf(args) !== undefined ? { expectedRevision: this.expectedRevisionOf(args) } : {}),
    })
    if (!r.ok) return { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }

    if (verdict === 'fail') {
      return {
        status: 'gate-fail',
        gate,
        taskState: task.state,
        rejectCount: rejectCount + 1,
        note: `已打回（第 ${rejectCount + 1} 轮）；任务留在 ${task.state}，实现者修复后重新提交 done 再复验`,
      }
    }
    // ④ pass 后：下一道若是 archive 门，host 立即做落位校验（archive 不是人工裁决门）
    const auto = this.autoEvaluateGateChain(teamId, taskId, actor)
    return {
      status: 'gate-pass',
      gate,
      taskState: this.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'done',
      ...(auto.note ? { note: auto.note } : {}),
    }
  }

  /**
   * CHG-87（QA-4 乐观锁）：把工具入参里的 `expectedRevision` 收敛成 `number | undefined`。
   * 非数字字符串 → NaN（service 侧 `Number.isInteger` 判定为 `MT_VALIDATION`），
   * 这样"给了个坏值"不会被静默当成"没给"。
   */
          expectedRevisionOf(args                         )                     {
    const raw = args?.expectedRevision
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'number') return raw
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }

  /**
   * CHG-87（FR-5.4）：为某任务算一次 scope 完成审计。
   *
   * 输入 = 任务声明的 `writeScopes` × 当前 attempt 的证据块申报的 `filesTouched`。
   * 未声明 writeScopes（或配置 `audit.writeScopes=false`）→ `undefined`（不落审计载荷，
   * 不制造"未越界"的空噪音）。
   *
   * 为什么从**证据事件**取申报文件而不是从投影：投影只存 seq，申报内容的权威在账本里
   * （`task.evidence` 事件的 `evidence.commands[].filesTouched`）。取**最后一个属于当前
   * attempt** 的证据——历史 attempt 的文件不该算进这次交付。
   */
          scopeAuditFor(teamId        , taskId        )                         {
    const svc = this.service(teamId)
    if (svc.effectiveConfig.audit?.writeScopes === false) return undefined
    const task = svc.projectionSnapshot.tasks[taskId]
    if (!task) return undefined
    const scopes = task.input.writeScopes ?? []
    if (scopes.length === 0) return undefined
    const attemptId = task.attemptId
    let declared           = []
    for (let i = task.evidenceRefs.length - 1; i >= 0; i--) {
      const payload = svc.eventBySeq(task.evidenceRefs[i])?.payload
      if (!payload) continue
      // 只认当前 attempt 的证据（历史 attempt 的文件不算这次交付）；旧账本无 attemptId 时放行
      if (attemptId && payload.attemptId && payload.attemptId !== attemptId) continue
      declared = filesTouchedOf(payload.evidence                                       )
      break
    }
    return auditWriteScopes(declared, scopes)
  }

  /**
   * CHG-87（FR-5.3）：`gate:verify` 的 host 执行路径。
   *
   * 语义（严格对齐 FR-5.3「绝不采信模型自述"测试通过"」）：
   *  - **普通调用（actor=lead / 未 confirm）**：忽略 verdict 参数，跑 `task.input.verifyCommand`，
   *    以**真实退出码**定 pass/fail，结果（命令 / exitCode / signal / durationMs / 输出尾部 /
   *    scope 审计）落账本；
   *  - **人工强制放行（actor=human 且 confirm=true）**：不跑命令，落 pass 并标
   *    `forcedBy:'human'` + 必填 reason——这是"宿主没有 subprocess 服务"时的唯一出口，
   *    且留痕（谁在什么时候放过了哪道门）；
   *  - 任务没声明 verifyCommand → `MT_VERIFY_NO_COMMAND`（不是静默 pass）；
   *  - 宿主没 subprocess 服务 → `MT_UNAVAILABLE`（**不静默降级成人工点通过**）。
   */
          async runVerifyGate(
    teamId        ,
    taskId        ,
    args                         ,
    actor        ,
  )                                   {
    const svc = this.service(teamId)
    const task = svc.projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    const command = task.input.verifyCommand                             
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

    // 人工强制放行（唯一不跑命令的出口；必须留下理由）
    if (actor === 'human' && args.confirm === true) {
      if (!reason) {
        return { status: 'error', code: 'MT_VALIDATION', message: '人工强制放行必须写清理由（reason 非空；这是唯一绕过命令执行的出口，要能审计）' }
      }
      const scopeAudit = this.scopeAuditFor(teamId, taskId)
      const forced = this.commit(teamId, {
        actor,
        type: 'task.gate.result',
        payload: {
          teamId,
          taskId,
          gate: 'verify',
          verdict: 'pass',
          forcedBy: 'human',
          reason,
          ...(scopeAudit ? { scopeAudit } : {}),
        },
        ...(this.expectedRevisionOf(args) !== undefined ? { expectedRevision: this.expectedRevisionOf(args) } : {}),
      })
      if (!forced.ok) {
        return { status: 'error', code: forced.code, message: forced.message, ...(forced.currentRevision !== undefined ? { currentRevision: forced.currentRevision } : {}) }
      }
      const auto = this.autoEvaluateGateChain(teamId, taskId, actor)
      return {
        status: 'gate-pass',
        gate: 'verify',
        forcedBy: 'human',
        taskState: this.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'done',
        note: `人工强制放行已留痕（reason: ${reason}）；${auto.note ?? '已推进门禁链'}`,
        ...(scopeAudit ? { scopeAudit } : {}),
      }
    }

    // 普通路径：必须有命令
    const commandError = validateVerifyCommand(command)
    if (commandError) return { status: 'error', code: commandError.code, message: commandError.message }
    if (!command) {
      return {
        status: 'error',
        code: 'MT_VERIFY_NO_COMMAND',
        message: `gate "verify" 要求任务声明 verifyCommand（argv 数组）；task "${taskId}" 未声明，无法执行 command 门禁（FR-5.3）。请用 myteam_edit_task 补 verifyCommand 后重试`,
      }
    }
    const workdir = command.cwd ? join(this.workspaceRoot, command.cwd) : this.workspaceRoot
    const timeoutMs = resolveTimeoutMs(command.timeoutMs, svc.effectiveConfig.gates?.commandTimeoutMs)
    const run = await runVerifyCommand({ command, workdir, timeoutMs, subprocess: this.rt.subprocess })
    if (!run.ok) return { status: 'error', code: run.code, message: run.message }

    const verdict = classifyVerifyResult(run.result)
    const scopeAudit = this.scopeAuditFor(teamId, taskId)
    const rejectCount = task.gateRejects?.verify ?? 0
    if (verdict === 'pass' && rejectCount >= GATE_REJECT_BUDGET && !(actor === 'human' && args.confirm === true)) {
      return {
        status: 'needs-human',
        code: 'MT_REJECT_BUDGET',
        gate: 'verify',
        taskState: task.state,
        rejectCount,
        exitCode: run.result.exitCode,
        command: { argv: [...command.argv], ...(command.cwd ? { cwd: command.cwd } : {}) },
        message: `verify 门已打回 ${rejectCount} 轮，达到复验预算上限（≤${GATE_REJECT_BUDGET}）；需人工裁决（面板带 confirm=true 可放行）`,
      }
    }
    const committed = this.commit(teamId, {
      actor,
      type: 'task.gate.result',
      payload: {
        teamId,
        taskId,
        gate: 'verify',
        verdict,
        command: { argv: [...command.argv], ...(command.cwd ? { cwd: command.cwd } : {}) },
        exitCode: run.result.exitCode,
        signal: run.result.signal,
        durationMs: run.result.durationMs,
        outputTail: run.result.outputTail,
        executedBy: 'host',
        ...(reason ? { reason } : {}),
        ...(scopeAudit ? { scopeAudit } : {}),
      },
      ...(this.expectedRevisionOf(args) !== undefined ? { expectedRevision: this.expectedRevisionOf(args) } : {}),
    })
    if (!committed.ok) {
      return { status: 'error', code: committed.code, message: committed.message, ...(committed.currentRevision !== undefined ? { currentRevision: committed.currentRevision } : {}) }
    }
    const base = {
      gate: 'verify',
      command: { argv: [...command.argv], ...(command.cwd ? { cwd: command.cwd } : {}) },
      exitCode: run.result.exitCode,
      signal: run.result.signal,
      durationMs: run.result.durationMs,
      outputTail: run.result.outputTail,
      ...(scopeAudit ? { scopeAudit } : {}),
    }
    if (verdict === 'fail') {
      return {
        status: 'gate-fail',
        ...base,
        taskState: this.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'gate:verify',
        rejectCount: rejectCount + 1,
        note: `verify 门 fail（exit ${run.result.exitCode ?? run.result.signal ?? '?'}）；任务已回到修复队列，修完重新申报 done 再跑`,
      }
    }
    const auto = this.autoEvaluateGateChain(teamId, taskId, actor)
    return {
      status: 'gate-pass',
      ...base,
      taskState: this.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'done',
      ...(auto.note ? { note: auto.note } : { note: 'verify 门 pass（exit 0）' }),
    }
  }

  /**
   * archive 门落位校验（FR-10.4）：按 `deliverableSpec` 约定路径检查产物是否真实存在。
   * pass → 补写 `task.deliverable`（实存路径）再落 `task.gate.result` pass（fold 推进 done）；
   * fail → 落 `task.gate.result` fail 留档（repair 流转 M2），调用方从返回 note 可见。
   * 抽取自 FIX-10 的成员 `update_task` 分支：CHG-86 起队长工具 / 面板 / 成员三处共用同一判定。
   */
          evaluateArchiveGate(
    teamId        ,
    taskId        ,
    actor        ,
    declaredPaths           = [],
  )                                                   {
    const task = this.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task || task.state !== 'gate:archive') {
      return { pass: false, note: '', reason: `task "${taskId}" is not at gate:archive` }
    }
    const existsUnderWorkspace = (p        ) => (isAbsolute(p) ? existsSync(p) : existsSync(join(this.workspaceRoot, p)))
    const verdict = checkArchiveGate(
      task.input.deliverableSpec                                ,
      declaredPaths.map((p) => ({ path: p })),
      existsUnderWorkspace,
    )
    if (verdict.pass) {
      for (const c of verdict.checks) {
        if (c.exists) this.commit(teamId, { actor, type: 'task.deliverable', payload: { teamId, taskId, path: c.path } })
      }
      const gr = this.commit(teamId, { actor, type: 'task.gate.result', payload: { teamId, taskId, gate: 'archive', verdict: 'pass' } })
      return gr.ok
        ? { pass: true, note: 'archive gate pass（落位校验通过），任务已归档' }
        : { pass: false, note: '', reason: gr.message ?? 'gate.result commit failed' }
    }
    this.commit(teamId, {
      actor,
      type: 'task.gate.result',
      payload: { teamId, taskId, gate: 'archive', verdict: 'fail', reason: verdict.reason },
    })
    return {
      pass: false,
      note: `archive gate fail：${verdict.reason ?? 'deliverable 未落位'}（repair 流转 M2；请补交付物后 escalate 或联系队长）`,
      reason: verdict.reason,
    }
  }

  /**
   * 门禁自动推进（CHG-86）：review/verify 裁决通过后，若下一道是 archive 门则立即
   * 做落位校验并推进到 done（archive 不是人工裁决门，不该让人再点一次）。
   * 循环上限 = 门禁链长度 + 1：自定义链里 archive 出现在中间时不会死循环。
   */
          autoEvaluateGateChain(teamId        , taskId        , actor        )                                       {
    const chain = this.service(teamId).projectionSnapshot.tasks[taskId]?.gates ?? []
    let note                    
    let advanced = false
    for (let i = 0; i <= chain.length; i++) {
      const task = this.service(teamId).projectionSnapshot.tasks[taskId]
      if (!task || task.state !== 'gate:archive') break
      const evaluated = this.evaluateArchiveGate(teamId, taskId, actor)
      note = evaluated.note
      if (!evaluated.pass) break
      advanced = true
    }
    return { advanced, ...(note ? { note } : {}) }
  }

  /**
   * 取消任务（CHG-73）：撤 attempt → task.cancelled；下游按策略处理：
   *  - leave（默认）：只停本任务，下游保持原状（诊断会报「上游已取消」）；
   *  - cancel：级联取消下游传递闭包（逐条独立事件，可逐条审计/回放）。
   * 两段确认：第一次返回 impact（下游清单 + 是否有活跃 attempt），不带 confirm 不落账。
   */
          cancelTask(teamId        , args                         , actor        )                          {
    const taskId = String(args.taskId ?? '')
    const reason = String(args.reason ?? '').trim()
    const downstream                                = args.downstream === 'cancel' ? 'cancel' : args.downstream === 'rewire' ? 'rewire' : 'leave'
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
    const rewireSkip = new Set(Array.isArray(args.rewireSkip) ? (args.rewireSkip             ).map((id) => String(id)) : [])
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
    const cancelled           = [taskId]
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
    const rewired                                                             = []
    const rewireErrors           = []
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
   * 批量编排（CHG-73）：同一操作作用到多个任务，逐条独立落账（带同一 batchId）。
   * 个别失败不中断其余任务——面板要把「哪几条没成、为什么」原样告诉人。
   */
          batchTaskOp(teamId        , args                         , actor        )                          {
    const op = String(args.op ?? '')
    if (!['cancel', 'rescope', 'assign', 'priority'].includes(op)) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'op must be cancel | rescope | assign | priority' }
    }
    const taskIds = Array.isArray(args.taskIds)
      ? [...new Set((args.taskIds             ).filter((id)               => typeof id === 'string' && id.length > 0))]
      : []
    if (taskIds.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'taskIds requires at least 1 task' }
    if (taskIds.length > 50) return { status: 'error', code: 'MT_VALIDATION', message: 'at most 50 tasks per batch' }
    const proj = this.service(teamId).projectionSnapshot
    for (const id of taskIds) {
      if (!proj.tasks[id]) return { status: 'error', code: 'MT_VALIDATION', message: `task "${id}" not found` }
    }
    const reason = String(args.reason ?? '').trim()
    const memberIds = Array.isArray(args.memberIds)
      ? (args.memberIds             ).filter((id)               => typeof id === 'string' && id.length > 0)
      : []
    if ((op === 'cancel' || op === 'rescope') && !reason) {
      return { status: 'error', code: 'MT_VALIDATION', message: `${op} requires a non-empty reason` }
    }
    if (op === 'assign' && memberIds.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'assign requires memberIds' }
    const priority = String(args.priority ?? '')
    if (op === 'priority' && !['P0', 'P1', 'P2', 'P3'].includes(priority)) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'priority must be P0~P3' }
    }
    // CHG-76：批量取消也支持「重接线」——每个被取消任务的直接下游统一改挂到 rewireTo（缺省 = 解除依赖）。
    // 先做批量级前置校验：新上游不能是本批要取消的任务（否则改挂完立刻又死），且必须存在、非终态失败。
    const downstream                                = op !== 'cancel'
      ? 'leave'
      : args.downstream === 'cancel'
        ? 'cancel'
        : args.downstream === 'rewire'
          ? 'rewire'
          : 'leave'
    const rewireTo = typeof args.rewireTo === 'string' && args.rewireTo.trim().length > 0 ? args.rewireTo.trim() : undefined
    if (downstream === 'rewire') {
      if (rewireTo && taskIds.includes(rewireTo)) {
        return { status: 'error', code: 'MT_VALIDATION', message: `rewireTo "${rewireTo}" 在这一批里也要被取消；改挂到一个即将取消的任务等于把死锁换个位置` }
      }
      if (rewireTo) {
        const upstream = proj.tasks[rewireTo]
        if (!upstream) return { status: 'error', code: 'MT_VALIDATION', message: `task "${rewireTo}" not found in this team` }
        if (upstream.state === 'cancelled' || upstream.state === 'failed') {
          return { status: 'error', code: 'MT_VALIDATION', message: `task "${rewireTo}" is ${upstream.state}; 不能作为新的依赖` }
        }
      }
    }
    if (op === 'cancel' && args.confirm !== true) {
      const dependents = new Set        ()
      for (const id of taskIds) {
        for (const dep of downstreamOf(proj, [id])) {
          if (!TERMINAL_STATES.has(proj.tasks[dep]?.state ?? 'cancelled')) dependents.add(dep)
        }
      }
      // CHG-76：重接线要按任务列出各自要被改挂的直接下游（人才能判断"这一批会动几条边"）
      const rewireByTask = downstream === 'rewire'
        ? taskIds.map((id) => ({
          taskId: id,
          directDependents: Object.values(proj.tasks)
            .filter((t) => !TERMINAL_STATES.has(t.state) && (t.input.deps ?? []).includes(id) && !taskIds.includes(t.id))
            .map((t) => t.id),
        }))
        : undefined
      return {
        status: 'confirm-required',
        impact: {
          tasks: taskIds.length,
          dependents: [...dependents],
          ...(downstream !== 'leave' ? { downstream } : {}),
          ...(downstream === 'rewire' ? { rewireTo, rewireByTask } : {}),
        },
        message: `批量取消 ${taskIds.length} 个任务是不可逆操作（下游 ${dependents.size} 个任务）${downstream === 'cancel'
          ? '，将一并取消下游'
          : downstream === 'rewire'
            ? `，将把直接下游改挂到${rewireTo ? `「${rewireTo}」` : '独立任务（解除依赖）'}`
            : '，下游保持原状'}；确认请带 confirm=true`,
      }
    }
    const batchId = `batch-${Date.now()}`
    const results                                                                                                                                                                                     = []
    for (const id of taskIds) {
      let outcome                         
      if (op === 'cancel') {
        // CHG-76：rewireSkip = 本批其余任务（它们自己也要取消，不该被"改挂"）
        outcome = this.cancelTask(teamId, {
          teamId,
          taskId: id,
          reason,
          downstream,
          ...(downstream === 'rewire' ? { rewireTo, rewireSkip: taskIds.filter((other) => other !== id) } : {}),
          confirm: true,
          batchId,
        }, actor)
      } else if (op === 'rescope') {
        outcome = this.rescopeTask(teamId, { teamId, taskId: id, reason, patch: args.patch, batchId }, actor)
      } else if (op === 'assign') {
        const r = this.commit(teamId, { actor, type: 'task.assigned', payload: { teamId, taskId: id, memberId: memberIds[0], memberIds } })
        outcome = r.ok ? { status: 'assigned' } : { status: 'error', code: r.code, message: r.message }
      } else {
        const current = this.service(teamId).projectionSnapshot.tasks[id]
        const r = this.commit(teamId, {
          actor,
          type: 'task.updated',
          payload: { teamId, taskId: id, patch: { priority }, changes: [{ field: 'priority', from: current?.input.priority ?? null, to: priority }] },
        })
        outcome = r.ok ? { status: 'updated' } : { status: 'error', code: r.code, message: r.message }
      }
      const ok = outcome.status !== 'error' && outcome.status !== 'confirm-required'
      results.push({
        taskId: id,
        ok,
        ...(typeof outcome.status === 'string' ? { status: outcome.status } : {}),
        ...(typeof outcome.code === 'string' ? { code: outcome.code } : {}),
        ...(typeof outcome.message === 'string' ? { message: outcome.message } : {}),
        ...(Array.isArray(outcome.rewired) && outcome.rewired.length > 0 ? { rewired: outcome.rewired                                                          } : {}),
        ...(Array.isArray(outcome.rewireErrors) && outcome.rewireErrors.length > 0 ? { rewireErrors: outcome.rewireErrors             } : {}),
      })
    }
    return {
      status: 'batch-done',
      batchId,
      results,
      summary: { total: results.length, ok: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length },
    }
  }

  /**
   * 批量建任务（CHG-76 / FR-33）：把"一次想出的一批任务"当成一份草稿——
   * 预览先给出影响面（条数 / 角色分布 / 名册缺角色 / 依赖边 / 补齐项），确认后逐条独立落账（同一 batchId）。
   *
   * 三个刻意的取舍：
   *   1. **不做整体原子性**：一条失败不影响其余（人能看到哪几条成了、哪几条没成）；
   *   2. **按依赖顺序创建**：先建上游再建下游，避免"dep 不存在"的假失败（`after` 指向本批序号）；
   *   3. **草稿缺省补齐并留痕**：验收标准缺省用「完成「标题」」、叶子任务的交付物路径缺省用
   *      `docs/<taskId>.md`，都写进 warnings——草稿阶段卡"必须先想好验收标准"只会让人放弃批量。
   */
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
          resolveProposal(teamId        , args                         , actor        )                          {
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
    const payload = (proposal.payload ?? {})                           

    if (type === 'split') {
      return this.materializeSplitProposal(teamId, proposalId, proposal.taskId, payload, args, actor)
    }
    if (type === 'add-dep') {
      const dep = String(payload.dep ?? payload.dependency ?? '')
      if (!dep) return { status: 'error', code: 'MT_VALIDATION', message: 'add-dep 提案缺少 dep（要依赖哪个任务）' }
      if (!proj.tasks[dep]) return { status: 'error', code: 'MT_VALIDATION', message: `add-dep 提案指向不存在的任务 "${dep}"` }
      const task = proj.tasks[proposal.taskId]
      const deps = Array.isArray(task?.input.deps) ? [...(task.input.deps            )] : []
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
   * split 提案批准 → 落子任务（PRD 验收场景 16）。
   * 载荷形状：{ tasks: [{title, description?, acceptanceCriteria?, requiredRole?, priority?, deliverableSpec?, deps?}], deps?: string[] }
   * - 逐条 task.created（同一 batchId），失败逐条回显、不中断其余；
   * - 原任务转 cancelled（下游保持原状——改挂属结构决策，走 cancelTask 的 rewire 档，不在提案裁决里越权做）；
   * - 最后落 task.proposal.resolved 关联（账本可回放 task.proposal → task.created* → task.cancelled → task.proposal.resolved）。
   */
          materializeSplitProposal(
    teamId        ,
    proposalId        ,
    originTaskId        ,
    payload                         ,
    args                         ,
    actor        ,
  )                          {
    const svc = this.service(teamId)
    const proj = svc.projectionSnapshot
    const drafts = Array.isArray(payload.tasks) ? (payload.tasks             ) : []
    if (drafts.length === 0) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'split 提案缺少 tasks（要拆成哪些子任务）' }
    }
    if (drafts.length > 20) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'split 提案的子任务过多（上限 20）' }
    }
    const origin = proj.tasks[originTaskId]
    if (!origin) {
      return { status: 'error', code: 'MT_VALIDATION', message: `split 提案的原任务 "${originTaskId}" 不存在` }
    }
    let maxN = 0
    for (const id of Object.keys(proj.tasks)) {
      const m = /^task-(\d+)$/.exec(id)
      if (m) maxN = Math.max(maxN, Number(m[1]))
    }
    // 子任务默认继承原任务的角色/优先级/类型；deps 默认指向原任务之外（不自我依赖）。
    const inheritedRole = String(origin.input.requiredRole ?? '')
    const inheritedPriority = String(origin.input.priority ?? 'P2')
    const batchId = `split-${proposalId}`
    const created                                           = []
    const failed                                                          = []
    const allWarnings           = []
    let seq = 0
    for (const item of drafts) {
      seq += 1
      if (!isPlainObject(item)) {
        failed.push({ title: `第 ${seq} 条`, code: 'MT_VALIDATION', message: '不是对象' })
        continue
      }
      const title = String(item.title ?? '').trim()
      if (!title) {
        failed.push({ title: `第 ${seq} 条`, code: 'MT_VALIDATION', message: 'title 必填' })
        continue
      }
      const taskId = `task-${maxN + seq}`
      const acRaw = Array.isArray(item.acceptanceCriteria)
        ? (item.acceptanceCriteria             ).filter((ac)               => typeof ac === 'string' && ac.trim().length > 0).map((ac) => ac.trim())
        : []
      const acceptanceCriteria = acRaw.length > 0 ? acRaw : [`完成「${title}」`]
      const deps = Array.isArray(item.deps)
        ? [...new Set((item.deps             ).filter((d)              => typeof d === 'string' && d.length > 0))]
        : []
      // 叶子任务必须有交付物路径（FR-11.2 硬校验）。split 的子任务草案常常不写——
      // 那就**继承原任务的交付物路径并加后缀**（同一批产物分件落位），而不是整批失败。
      // 不静默造数据：继承来的路径会记进 warnings，随裁决结果一起回显。
      const warnings           = []
      let deliverableSpec = isPlainObject(item.deliverableSpec) && typeof item.deliverableSpec.path === 'string'
        ? (item.deliverableSpec                                              )
        : undefined
      if (!deliverableSpec && deps.length === 0) {
        const basePath = typeof origin.input.deliverableSpec?.path === 'string' ? origin.input.deliverableSpec.path : ''
        if (basePath) {
          const dot = basePath.lastIndexOf('.')
          const derived = dot > 0 ? `${basePath.slice(0, dot)}.${seq}${basePath.slice(dot)}` : `${basePath}.${seq}`
          deliverableSpec = { path: derived, producer: String(origin.input.requiredRole ?? '') }
          warnings.push(`未填交付物路径，已从原任务派生 ${derived}`)
        }
      }
      const task                          = {
        title,
        description: String(item.description ?? ''),
        acceptanceCriteria,
        deps,
        requiredRole: String(item.requiredRole ?? inheritedRole),
        priority: String(item.priority ?? inheritedPriority),
        ...(origin.input.taskType ? { taskType: origin.input.taskType } : {}),
        ...(deliverableSpec ? { deliverableSpec } : {}),
      }
      const r = this.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: this.taskWithGateChain(teamId, task), batchId, fromProposal: proposalId } })
      if (!r.ok) {
        failed.push({ title, code: r.code, message: r.message })
        continue
      }
      created.push({ taskId, title })
      if (warnings.length > 0) allWarnings.push(...warnings.map((w) => `${title}：${w}`))
    }
    if (created.length === 0) {
      // 一条都没建成：不落「已批准」——避免留下批准但零子任务的半截状态。
      return { status: 'error', code: 'MT_VALIDATION', message: 'split 提案的子任务全部创建失败', failed }
    }
    // 原任务转 cancelled（下游保持原状）。
    // confirm=true：提案已被队长明确批准 = 不可逆动作已获授权，不再要求二次确认
    //（否则裁决会停在一句「请带 confirm=true 重调」，批准等于没批准）。
    const cancelled = this.cancelTask(teamId, { taskId: originTaskId, reason: `split by proposal ${proposalId}`, downstream: 'leave', confirm: true }, actor)
    if (cancelled.status === 'error') {
      return { status: 'error', code: cancelled.code, message: cancelled.message, created }
    }
    const rr = this.commit(teamId, { actor, type: 'task.proposal.resolved', payload: { teamId, proposalId, decision: 'approved', note: args.note } })
    if (!rr.ok) return { status: 'error', code: rr.code, message: rr.message, created }
    return {
      status: 'approved',
      applied: 'split',
      created,
      ...(failed.length > 0 ? { failed } : {}),
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
      note: `已拆出 ${created.length} 个子任务；原任务 ${originTaskId} 已取消（下游保持原状）`,
    }
  }

          createTasksBatch(teamId        , args                         , actor        )                          {
    const raw = Array.isArray(args.tasks) ? (args.tasks             ) : []
    if (raw.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'tasks requires at least 1 draft' }
    if (raw.length > 30) return { status: 'error', code: 'MT_VALIDATION', message: 'at most 30 tasks per batch' }
    const proj = this.service(teamId).projectionSnapshot
    let maxN = 0
    for (const id of Object.keys(proj.tasks)) {
      const m = /^task-(\d+)$/.exec(id)
      if (m) maxN = Math.max(maxN, Number(m[1]))
    }
    const idOf = (index        ) => `task-${maxN + index + 1}`
    const priorities = ['P0', 'P1', 'P2', 'P3']

                     
                   
                         
                          
                      
                       
                       
                                  
                                                                  
                    
                     
                         
                        
     

    const problems           = []
    const drafts          = []
    raw.forEach((item, index) => {
      const n = index + 1
      if (!isPlainObject(item)) {
        problems.push(`第 ${n} 条：不是对象`)
        return
      }
      const title = String(item.title ?? '').trim()
      if (!title) problems.push(`第 ${n} 条：title 必填`)
      const requiredRole = String(item.requiredRole ?? '').trim()
      if (!requiredRole) problems.push(`第 ${n} 条：requiredRole 必填`)
      const priority = String(item.priority ?? 'P2')
      if (!priorities.includes(priority)) problems.push(`第 ${n} 条：priority 必须是 P0~P3`)
      const estimate = item.estimate === undefined || item.estimate === null ? undefined : Number(item.estimate)
      if (estimate !== undefined && (!Number.isFinite(estimate) || estimate <= 0)) problems.push(`第 ${n} 条：estimate 必须是正数`)
      const acList = Array.isArray(item.acceptanceCriteria)
        ? (item.acceptanceCriteria             ).filter((ac)               => typeof ac === 'string' && ac.trim().length > 0).map((ac) => ac.trim())
        : []
      const deps = Array.isArray(item.deps)
        ? [...new Set((item.deps             ).filter((dep)                => typeof dep === 'string' && dep.length > 0))]
        : []
      const afterRaw = Array.isArray(item.after) ? (item.after             ) : []
      const after           = []
      for (const value of afterRaw) {
        const num = Number(value)
        if (!Number.isInteger(num) || num < 1 || num > raw.length) {
          problems.push(`第 ${n} 条：after 里的「${String(value)}」不是本批序号（1~${raw.length}）`)
          continue
        }
        if (num === n) {
          problems.push(`第 ${n} 条：after 不能指向自己`)
          continue
        }
        if (!after.includes(num)) after.push(num)
      }
      const assignees = Array.isArray(item.assignees)
        ? [...new Set((item.assignees             ).filter((id)               => typeof id === 'string' && id.length > 0))]
        : []
      const warnings           = []
      const ac = acList.length > 0 ? acList : []
      if (ac.length === 0 && title) {
        ac.push(`完成「${title}」`)
        warnings.push('未填验收标准，已用「完成「标题」」占位（可在详情页补）')
      }
      let deliverableSpec = isPlainObject(item.deliverableSpec) && typeof item.deliverableSpec.path === 'string'
        ? (item.deliverableSpec                                              )
        : undefined
      if (!deliverableSpec && deps.length === 0 && after.length === 0 && title) {
        deliverableSpec = { path: `docs/${idOf(index)}.md` }
        warnings.push(`叶子任务未填交付物路径，已用 docs/${idOf(index)}.md 占位`)
      }
      drafts.push({
        title,
        description: String(item.description ?? ''),
        requiredRole,
        priority,
        ...(estimate !== undefined ? { estimate } : {}),
        ...(typeof item.taskType === 'string' && item.taskType ? { taskType: item.taskType } : {}),
        acceptanceCriteria: ac,
        ...(deliverableSpec ? { deliverableSpec } : {}),
        deps,
        after,
        assignees,
        warnings,
      })
    })
    if (problems.length > 0) {
      return { status: 'error', code: 'MT_VALIDATION', message: problems.join('; '), problems }
    }

    // 依赖顺序：after 是本批内序号 → 建图做拓扑排序（成环直接拒，别写出半个 DAG）
    const indegree = drafts.map(() => 0)
    const adj             = drafts.map(() => [])
    drafts.forEach((draft, index) => {
      for (const target of draft.after) {
        const from = target - 1
        if (adj[from].includes(index)) continue
        adj[from].push(index)
        indegree[index] += 1
      }
    })
    const order           = []
    const queue           = []
    indegree.forEach((value, index) => { if (value === 0) queue.push(index) })
    while (queue.length > 0) {
      const current = queue.shift()          
      order.push(current)
      for (const next of adj[current]) {
        indegree[next] -= 1
        if (indegree[next] === 0) queue.push(next)
      }
    }
    if (order.length !== drafts.length) {
      return { status: 'error', code: 'MT_TASK_CYCLE', message: '这批草稿的 after 引用成环，无法确定创建顺序' }
    }

    const byRole                         = {}
    for (const draft of drafts) byRole[draft.requiredRole] = (byRole[draft.requiredRole] ?? 0) + 1
    const rosterRoles = new Set(Object.values(proj.members).map((member) => member.roleId))
    const rolesMissing = Object.keys(byRole).filter((role) => !rosterRoles.has(role))
    const edges = drafts.flatMap((draft, index) => draft.after.map((target) => ({ from: `draft-${target}`, to: `draft-${index + 1}` })))
    const allWarnings = drafts.flatMap((draft, index) => draft.warnings.map((w) => `第 ${index + 1} 条：${w}`))
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''

    if (args.confirm !== true) {
      return {
        status: 'confirm-required',
        impact: {
          tasks: drafts.length,
          byRole,
          rolesMissing,
          edges,
          ids: drafts.map((_, index) => `draft-${index + 1}`),
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        },
        message: `将创建 ${drafts.length} 个任务${goal ? `（目标：${goal}）` : ''}，角色分布 ${Object.entries(byRole).map(([role, count]) => `${role}×${count}`).join('、')}${rolesMissing.length > 0 ? `；名册里没有：${rolesMissing.join('、')}（这些会创建失败）` : ''}；确认请带 confirm=true`,
      }
    }

    const batchId = `batch-${Date.now()}`
    const failed = new Set        ()
    const created                                                          = []
    const results                                                                                                                                                   = []
    for (const index of order) {
      const draft = drafts[index]
      const brokenAfter = draft.after.filter((target) => failed.has(target - 1))
      if (brokenAfter.length > 0) {
        failed.add(index)
        results.push({ index, ok: false, title: draft.title, code: 'MT_DEPENDENCY_FAILED', message: `依赖的第 ${brokenAfter.join('、')} 条没建成，本任务跳过`, ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}) })
        continue
      }
      const taskId = idOf(index)
      const task                          = {
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: draft.acceptanceCriteria,
        deps: [...draft.deps, ...draft.after.map((target) => idOf(target - 1))],
        requiredRole: draft.requiredRole,
        priority: draft.priority,
        ...(draft.estimate !== undefined ? { estimate: draft.estimate } : {}),
        ...(draft.taskType ? { taskType: draft.taskType } : {}),
        ...(draft.deliverableSpec ? { deliverableSpec: draft.deliverableSpec } : {}),
      }
      const r = this.commit(teamId, { actor, type: 'task.created', payload: { teamId, taskId, task: this.taskWithGateChain(teamId, task), batchId } })
      if (!r.ok) {
        failed.add(index)
        results.push({ index, ok: false, title: draft.title, taskId, code: r.code, message: r.message, ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}) })
        continue
      }
      const extras = draft.assignees.length > 0 ? this.applyTaskRelations(teamId, taskId, { assignees: draft.assignees }, actor) : {}
      created.push({ index, taskId, title: draft.title })
      results.push({
        index,
        ok: true,
        title: draft.title,
        taskId,
        ...(Array.isArray(extras.assigned) ? { assigned: extras.assigned             } : {}),
        ...(draft.warnings.length > 0 ? { warnings: draft.warnings } : {}),
      })
    }
    results.sort((a, b) => a.index - b.index)
    created.sort((a, b) => a.index - b.index)
    return {
      status: 'created',
      batchId,
      ...(goal ? { goal } : {}),
      tasks: created.map((item) => ({ taskId: item.taskId, title: item.title })),
      results,
      summary: { total: drafts.length, created: created.length, failed: drafts.length - created.length },
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    }
  }

  /**
   * 删除项目角色（CHG-73 / FR-27）：配置资产写操作，两段确认 + 占用面 + 审计行。
   * 占用面按「模板引用 / 团队在册 / 项目自身角色」三处只读扫描得出来。
   */
          deleteRoleTool(roleId        , confirm         )                          {
    const id = roleId.trim()
    if (!id) return { status: 'error', code: 'MT_VALIDATION', message: 'roleId is required' }
    const usage = roleUsage(this.workspaceRoot, id)
    if (!confirm) {
      return {
        status: 'confirm-required',
        roleId: id,
        usage: { teams: usage.teams.length, instances: usage.instances, presets: usage.presets },
        message: `删除项目角色「${id}」会移除 .team-workplace/config/roles/${id}.json（在跑成员仍用召唤时快照）；${usage.bindings.length > 0 ? `当前仍被占用：${usage.bindings.join(', ')}` : '当前未被任何团队/模板引用'}；确认请带 confirm=true`,
      }
    }
    try {
      const out = deleteProjectRoleSafe(this.rolePaths, id, { bindings: usage.bindings, actor: 'human' })
      return { status: 'deleted', roleId: id, filePath: out.filePath, auditPath: out.auditPath }
    } catch (e) {
      return this.roleError(e)
    }
  }

  /** myteam_wait_for_change：异步长轮询（修订：原实现用 Atomics.wait 在宿主主线程
   *  同步阻塞 500ms/次，最长 60s——会冻结整个 Harness 事件循环；改为 setTimeout
   *  间隔轮询，账本有新事件立即返回，失效提示语义不变（F9）。 */
          async waitForChange(args                         )                                   {
    const teamId = String(args.teamId ?? this.defaultTeamId())
    const sinceSeq = Number(args.sinceSeq ?? 0)
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 60000), 0), 300000)
    const ledgerPath = resolveTeamLedgerPath(this.workspaceRoot, teamId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { events } = readLedgerEvents(ledgerPath)
      const result = changeSince(events         , sinceSeq, args.taskId ? String(args.taskId) : undefined)
      if (result.changed) {
        return { status: 'changed', cause: result.cause, note: '失效提示：重新 myteam_get_task/myteam_list_tasks 读取（不推正文）' }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { status: 'timeout', changed: false }
  }

  /* ── 成员记忆审计（T21，FR-6.2/ADR-009：事后扫描，不拦截写入）── */

  auditMemberMemory(teamId        , memberId        , taskId         )                                                      {
    const svc = this.service(teamId)
    if (svc.effectiveConfig.memory?.evidenceRequired === false) return null
    const dir = memoryDirFor(this.workspaceRoot, teamId, memberId)
    if (!existsSync(dir)) return null
    const findings                  = []
    let checkedFiles = 0
    const walk = (d        , rel        )       => {
      let names           = []
      try {
        names = readdirSync(d)
      } catch (e) {
        this.log('warn', `memory audit readdir failed for ${memberId}/${rel}: ${String(e)}`)
        return
      }
      for (const name of names) {
        const full = [d, name].join('/')
        const relPath = rel ? `${rel}/${name}` : name
        let st                            
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

  spawnMember(teamId        , roleId        , instanceName         , overrides                                                 = {})                          {
    if (!this.rt.agents) return { status: 'error', code: 'MT_NO_AGENTS_SERVICE', message: 'ctx.agents unavailable' }
    const svc = this.service(teamId)
    // 运行时只认项目库（FR-10.2）；内置/全局/项目自身角色自动复制进项目库（引用即复制）
    if (!resolveRuntimeRole(this.rolePaths, roleId)) {
      const source = this.roleCatalog().find((entry) => entry.definition.id === roleId)
      if (!source) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in any library` }
      const copy = copyToProject(this.rolePaths, roleId, source.origin, this.contributionCatalog.roles)
      this.log('info', `${source.origin} role "${roleId}" copied to project library: ${copy.filePath}`)
    }
    const n = Object.keys(svc.projectionSnapshot.members).length + 1
    const memberId = `m${n}-${roleId}`
    const sessionId = memberSessionId(teamId, roleId, n)
    const member                 = {
      memberId,
      roleId,
      instanceName: instanceName ?? `${roleId}-${n}`,
      sessionId,
      teamId,
      ...(overrides.skills && overrides.skills.length > 0 ? { skills: overrides.skills } : {}),
      ...(overrides.mcpAllowlist && overrides.mcpAllowlist.length > 0 ? { mcpAllowlist: overrides.mcpAllowlist } : {}),
    }
    const roleDef = resolveRuntimeRole(this.rolePaths, roleId) .definition

    // 账本校验先行（maxMembers/角色解析在 service.checkDomain）
    const spawnEvent = this.commit(teamId, {
      actor: 'lead',
      type: 'member.spawned',
      payload: {
        teamId, memberId, roleId, instanceName: member.instanceName, sessionId, status: 'ok',
        ...(member.skills ? { skills: member.skills } : {}),
        ...(member.mcpAllowlist ? { mcpAllowlist: member.mcpAllowlist } : {}),
      },
    })
    if (!spawnEvent.ok) return { status: 'error', code: spawnEvent.code, message: spawnEvent.message }

    const created = this.rt.agents.create({
      sessionId,
      agentOptions: roleDef.model ?? undefined,
      setup: async (agentCtx     , agent     ) => {
        // ① 成员工具 9 个（仅该成员可见）
        for (const def of memberToolDefs()) {
          const compiled = compileParameters(def)
          agentCtx.tools.register({
            ...compiled,
            output: toolOutput(),
            execute: (toolArgs                         ) => this.executeMemberTool(member, def.name, toolArgs),
          })
        }
        // ② 角色工具策略收窄（C5：只收窄）
        // restrict 只过滤「继承的全局工具」，且名单必须落在当前已知全局工具内——
        // 成员自己的 9 个工具是作用域内注册、永远可见（CHG-58 实证），因此：
        //   allow → 去掉 own-layer 成员工具后按全局已知名收窄（全被去掉 = deny 全部全局）；
        //   deny  → 过滤未知名字（拼写错误只告警，不让整批拒绝）。
        const mask = buildToolMask(roleDef)
        if (mask.mode !== 'none' && agentCtx.tools.restrict) {
          const known = new Set(
            ((agentCtx.tools.schemas?.(agent) ?? [])                             )
              .map((schema) => (typeof schema?.name === 'string' ? schema.name : ''))
              .filter((name) => name.length > 0),
          )
          if (mask.mode === 'allow') {
            const wanted = mask.allow ?? []
            const allow = wanted.filter((name) => known.has(name))
            const dropped = wanted.filter((name) => !known.has(name))
            if (dropped.length > 0) this.log('info', `member ${memberId} allow list drops scoped/unknown tools: ${dropped.join(', ')}`)
            if (allow.length > 0) agentCtx.tools.restrict({ allow })
            else if (known.size > 0) agentCtx.tools.restrict({ deny: [...known] })
          } else {
            const deny = (mask.deny ?? []).filter((name) => known.has(name))
            const unknown = (mask.deny ?? []).filter((name) => !known.has(name))
            if (unknown.length > 0) this.log('warn', `member ${memberId} deny list names unknown tools (ignored): ${unknown.join(', ')}`)
            if (deny.length > 0) agentCtx.tools.restrict({ deny })
          }
        }
        // ③ 角色提示词 + 工作纪律 section
        agentCtx.systemPrompt.section(memberPromptSection(roleDef, member))
        // ④ 知识库索引层常驻（FR-17.3：≤40 行预算；v2.7 audience 软过滤 + stale 徽标）
        const kbDir = knowledgeDirOf(this.workspaceRoot)
        const kb = listKnowledge(kbDir)
        if (kb.length > 0) {
          const { text, truncated } = renderIndexSection(
            kb.map((e) => ({ id: e.id, title: e.title, tags: e.tags, updated: e.updated, unverified: e.unverified, core: e.core, staleSince: e.staleSince, proofCount: e.proofCount, audience: e.audience ?? [], words: 0 })),
            { audience: member.roleId },
          )
          if (truncated) this.log('warn', `knowledge index over budget for ${memberId}`)
          agentCtx.systemPrompt.section({ name: `myteam:knowledge-index-${member.memberId}`, order: 101, text })
        }
        // ⑤ scratch 路径注入（FR-10.5；R26：目录由成员自建）
        agentCtx.systemPrompt.section({
          name: `myteam:scratch-${member.memberId}`,
          order: 102,
          text: `临时脚本一律写入 ${join(this.workspaceRoot, '.team-workplace', 'state', 'scratch', teamId, memberId)}（目录不存在时先创建；不入库、不进收口提交）。`,
        })
        // ⑥ 记忆纪律 section（T20：FR-6.2 证据指针 + FR-6.4 不宣告交接）
        const memDir = memoryDirFor(this.workspaceRoot, teamId, memberId)
        agentCtx.systemPrompt.section(memoryPromptSection(member, memDir, svc.effectiveConfig.memory?.evidenceRequired ?? true))
        // ⑦ 能力边界（CHG-54 声明 / CHG-58 硬隔离）：成员声明 > 角色声明；空 = 不启用隔离
        const caps = resolveCapabilities(roleDef, member)
        if (caps.skills.length > 0 || caps.mcpAllowlist.length > 0) {
          agentCtx.systemPrompt.section({
            name: `myteam:capabilities-${member.memberId}`,
            order: 104,
            text: `能力边界（已硬隔离，只使用下列能力）：\n- 技能：${caps.skills.join('、') || '（无）'}\n- MCP：${caps.mcpAllowlist.join('、') || '（无）'}\nallowlist 之外的技能与 MCP 在运行时不可用；需要额外能力时先向队长申报，不要尝试绕过。`,
          })
          const guard = await applyCapabilityGuard(agentCtx, agent, caps, { workspaceRoot: this.workspaceRoot })
          if (guard.warnings.length > 0) this.log('warn', `member ${memberId} capability guard: ${guard.warnings.join('; ')}`)
          else if (guard.mcpDenied.length > 0 || guard.skillsShadowed.length > 0) this.log('info', `member ${memberId} capabilities enforced: ${capabilitySummary(guard)}`)
        }
      },
    })
    // FIX-14（KI-2 实弹）：agents.create 是 async（返回 Promise<AgentHandle>，dsh-agent/lib/index.js:453）。
    // 同步存 Promise 会让 agentOf() 取不到 followup（P1：成员上岗引导静默丢失，t23 mock 同步返回掩盖）。
    // fire-and-forget：handle 到手后回填 memberHandles 并发上岗引导（读板→claim→空闲 wait_for_change）。
    void Promise.resolve(created).then((handle     ) => {
      this.memberHandles.set(memberId, handle)
      this.agentOf(handle)?.followup?.(this.followupMessage(`[myteam] 你已上岗（团队 ${teamId}，角色 ${roleId}）。请读板并领取与角色匹配的就绪任务（myteam_list_tasks → myteam_claim_task）；当前无就绪任务则用 myteam_wait_for_change 等待失效提示。`))
    }).catch((e         ) => {
      this.log('warn', `member ${memberId} handle/followup failed: ${String(e)}`)
    })
    // identity.json 快照（C3 不可变）
    const identityDir = join(this.workspaceRoot, '.team-workplace', 'state', 'teams', teamId, 'members', memberId)
    if (!existsSync(identityDir)) mkdirSync(identityDir, { recursive: true })
    writeFileSync(join(identityDir, 'identity.json'), `${JSON.stringify({ ...member, roleSnapshot: roleDef, spawnedAt: Date.now() }, null, 2)}\n`, 'utf8')
    // 记忆区播种（T21，FR-6.1：幂等；R26：host 进程 fs；notes/ 留给成员自建）
    const memSeed = seedMemoryIfMissing(memoryDirFor(this.workspaceRoot, teamId, memberId), member)
    if (memSeed.seeded) this.log('info', `memory seeded for ${memberId}: ${memSeed.memoryMdPath}`)
    return { status: 'spawned', memberId, sessionId }
  }

  /**
   * CHG-93（清 §7.4 遗留硬编码）：成员待处理消息数（`message.sent` 未消费条数）。
   *
   * 为什么需要它：`member.released` / `member.archived` 的 `drained.pending` 此前**硬编码为 0**——
   * 账本上写「排空完成」，实际成员收件箱里还压着消息。释放是**不可逆**动作（`mode: 'remove'`
   * 会删私有空间），它宣称的「排空」必须是**真的**，否则审计回看会得到错误结论。
   *
   * 口径：`message.sent` 里 `to === memberId` 且对应 `messageId` 尚未 `message.consumed` 的条数。
   * 读账本（不是投影）——投影的 `inbox` 只为面板人工待办聚合，不带收件人。
   */
          pendingMessagesFor(teamId        , memberId        )         {
    try {
      const events = readLedgerEvents(this.service(teamId).ledgerPath).events
      const sent = new Set        ()
      const consumed = new Set        ()
      for (const event of events) {
        const payload = (event.payload ?? {})                           
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : ''
        if (!messageId) continue
        if (event.type === 'message.sent' && String(payload.to ?? '') === memberId) sent.add(messageId)
        else if (event.type === 'message.consumed') consumed.add(messageId)
      }
      let pending = 0
      for (const messageId of sent) if (!consumed.has(messageId)) pending += 1
      return pending
    } catch (e) {
      // 读账本失败不该阻断释放（释放是排空动作），但必须留痕——0 是「读不到」而不是「真的没有」
      this.log('warn', `drained.pending unavailable for ${teamId}/${memberId}: ${String(e)}`)
      return 0
    }
  }

  releaseMember(teamId        , memberId        , mode        , confirm         , actor = 'lead')                          {
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
    // CHG-93：排空面**如实**记录（原实现硬编码 running:0/pending:0，「排空完成」是假的）
    const drained = { running: 0, pending: this.pendingMessagesFor(teamId, memberId) }
    // 释放前记忆审计（T21：违规落 memory.audit，不阻断释放——M2 再议 hard 阻断）
    const memAudit = this.auditMemberMemory(teamId, memberId)
    const r = this.commit(teamId, { actor, type: mode === 'archive' ? 'member.archived' : 'member.released', payload: { teamId, memberId, mode, drained } })
    if (!r.ok) return { status: 'error', code: r.code, message: r.message }
    const handle = this.memberHandles.get(memberId)
    if (handle) {
      if (mode === 'remove') {
        void handle.dispose?.()
        this.memberHandles.delete(memberId)
      }
      // suspend/archive：会话保留（宿主侧栏可见），仅停止领新任务
    }
    return {
      status: mode,
      ...(memAudit && memAudit.violations > 0
        ? { memoryAudit: { violations: memAudit.violations, note: '释放前审计发现无证据指针的记忆条目，已落账本 memory.audit（FR-6.2）' } }
        : {}),
    }
  }

  /**
   * T27（CHG-48）：成员管理统一入口（面板 FR-14.2）——suspend/archive/remove/restore。
   * 写路径与 Lead 工具同管线（member.released / member.archived / member.restored），
   * actor 标注 human（面板操作），破坏性 remove 两段确认；restore 仅允许挂起/归档态。
   */
  memberOp(teamId        , memberId        , op        , confirm         )                          {
    const member = this.service(teamId).projectionSnapshot.members[memberId]
    if (!member) return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" not found` }
    switch (op) {
      case 'suspend':
      case 'archive':
      case 'remove': {
        const already = op === 'suspend' ? 'suspended' : op === 'archive' ? 'archived' : 'removed'
        if (member.status === already) return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" is already ${already}` }
        return this.releaseMember(teamId, memberId, op, confirm, 'human')
      }
      case 'restore': {
        if (member.status !== 'suspended' && member.status !== 'archived') {
          return { status: 'error', code: 'MT_VALIDATION', message: `member "${memberId}" is ${member.status}; only suspended/archived can be restored` }
        }
        const r = this.commit(teamId, { actor: 'human', type: 'member.restored', payload: { teamId, memberId } })
        return r.ok ? { status: 'restored', memberId } : { status: 'error', code: r.code, message: r.message }
      }
      default:
        return { status: 'error', code: 'MT_VALIDATION', message: `unsupported member op "${op}" (suspend|archive|remove|restore)` }
    }
  }

  /* ── 成员工具 execute ──────────────────────────────────────── */

  executeMemberTool(member                , name        , args                         )                          {
    const teamId = member.teamId
    const actor = `member:${member.memberId}`
    try {
      const svc = this.service(teamId)
      switch (name) {
        case 'myteam_get_task': {
          const t = svc.projectionSnapshot.tasks[String(args.taskId)]
          if (!t) return { status: 'error', code: 'MT_VALIDATION', message: `task "${args.taskId}" not found` }
          // 修订：attemptId 只发给当前持有人（原实现 t.attemptId === t.attemptId 恒真，泄漏给任意成员）
          const ownAttempt = t.assignee === member.memberId ? t.attemptId : undefined
          return { status: 'ok', task: { id: t.id, title: t.input.title, description: t.input.description, acceptanceCriteria: t.input.acceptanceCriteria, deliverableSpec: t.input.deliverableSpec, deps: t.input.deps, requiredRole: t.input.requiredRole, priority: t.input.priority, state: t.state, attemptId: ownAttempt, escalateCount: t.escalateCount } }
        }
        case 'myteam_list_tasks': {
          const filter = String(args.filter ?? 'claimable')
          const limit = Number(args.limit ?? 20)
          const proj = svc.projectionSnapshot
          let tasks = Object.values(proj.tasks)
          if (filter === 'claimable') {
            tasks = svc.claimableTasks(member.roleId)
          } else if (filter === 'mine') {
            tasks = tasks.filter((t) => t.assignee === member.memberId && !['done', 'failed', 'cancelled'].includes(t.state))
          }
          const rows = tasks.slice(0, limit).map((t) => ({ id: t.id, title: t.input.title, state: t.state, priority: t.input.priority, requiredRole: t.input.requiredRole }))
          return { status: 'ok', tasks: rows, returnedCount: rows.length, note: `返回 ${rows.length} 行 ≠ 已读全部内容（NFR-7.6）` }
        }
        case 'myteam_claim_task': {
          const r = this.commit(teamId, { actor, type: 'task.claimed', payload: { teamId, taskId: args.taskId, memberId: member.memberId, attemptId: `at-${Date.now()}` } })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          const t = svc.projectionSnapshot.tasks[String(args.taskId)]
          return { status: 'claimed', attemptId: t.attemptId, task: { id: t.id, title: t.input.title, acceptanceCriteria: t.input.acceptanceCriteria, deliverableSpec: t.input.deliverableSpec } }
        }
        case 'myteam_update_task': {
          const status = String(args.status)
          const attemptId = String(args.attemptId)
          const taskId = String(args.taskId)
          const eventType = status === 'in_progress' ? 'task.progress' : status === 'done' ? 'task.completed' : 'task.failed'
          const payload                          = { teamId, taskId, attemptId }
          if (status === 'in_progress') payload.progress = args.progress
          if (status === 'done') payload.summary = args.summary
          if (status === 'failed') { payload.reason = args.reason; payload.summary = args.summary }
          if (args.evidence) payload.evidence = args.evidence
          // 证据块先落存证（FR-5.0：completed 前必须有同 attemptId 的 task.evidence 事件）
          if (status === 'done' && args.evidence) {
            const ev = this.commit(teamId, { actor, type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: args.evidence } })
            if (!ev.ok) return { status: 'error', code: ev.code, message: ev.message }
          }
          // CHG-87（FR-5.4）：完成时 scope 审计——证据块申报的文件 × 任务声明的 writeScopes。
          // 必须在上面 task.evidence 落账**之后**算（审计输入就是那条证据事件）。
          // 越界只留痕不阻断（FR-5.4「诚实声明不拦截 bash」）。
          if (status === 'done') {
            const scopeAudit = this.scopeAuditFor(teamId, taskId)
            if (scopeAudit) payload.scopeAudit = scopeAudit
          }
          const r = this.commit(teamId, { actor, type: eventType                       , payload })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          // FIX-10（KI-2 实弹）+ CHG-86：archive gate 落位校验接线。
          // 修复前的断链：这里只判 `state === 'gate:archive'`，而默认门禁链是
          // `['review','archive']` —— 任务 done 后进的是 `gate:review`，条件永不成立；
          // 加上没有任何 Lead 工具/面板端点能提交 review 裁决，任务永远到不了 done。
          // 现在：门禁链第一道是 archive → host 立即落位校验；是 review/verify → 提示等队长裁决。
          let gateNote                    
          if (status === 'done') {
            const tAfter = svc.projectionSnapshot.tasks[taskId]
            const declared = (args.deliverablePaths                        ) ?? []
            if (tAfter?.state === 'gate:archive') {
              gateNote = this.evaluateArchiveGate(teamId, taskId, actor, declared).note || undefined
            } else if (tAfter?.state.startsWith('gate:')) {
              const gate = tAfter.state.slice('gate:'.length)
              gateNote = `已进入 gate:${gate}，等待队长裁决（myteam_review_task / 面板「门禁裁决」）`
            }
          }
          // 知识提案（FR-17.4）：done 时随申报 → knowledge.proposed（队长审）；
          // v2.7（M2-0c）：① 任务 tags 触达知识库条目 → staleSince 写入（staleness 提示，R27 缓解）
          // ② host 依提案 tags 匹配既有条目给候选（"自动找靶、人来定夺"），随 completed 非阻塞返回
          const draft = args.knowledgeDraft                              
          if (status === 'done' && draft) {
            const check = validateDraft({ ...draft, evidence: draft.evidence || taskId })
            if (!check.ok) {
              return { status: 'completed', knowledgeDraftError: `${check.code}: ${check.message}` }
            }
            const resolvedDraft = { ...draft, evidence: draft.evidence || taskId }
            // CHG-87（FR-16.4③）：跨会话引用留痕——证据指针是 `session:<id>` 时落一条
            // session.read 审计（边界：读取即留痕，不整段注入；成员默认不开放跨读，C5）
            const pointer = parseEvidencePointer(resolvedDraft.evidence)
            if (pointer.kind === 'session') {
              this.commit(teamId, {
                actor,
                type: 'session.read',
                payload: { teamId, sessionId: pointer.value, pointer: pointer.raw, by: member.memberId, taskId },
              })
            }
            const kbDir = knowledgeDirOf(this.workspaceRoot)
            const kbEntries = listKnowledge(kbDir)
            const now = new Date().toISOString()
            // staleness 触达：任务 input.tags × 条目 tags 交集 → staleSince=当天（结构性提示）
            const taskTags = svc.projectionSnapshot.tasks[taskId]?.input.tags ?? []
            const touched = touchStale(kbEntries, taskTags, now)
            for (const t of touched) writeKnowledgeEntry(kbDir, t)
            // 半自动巩固候选（FR-17.4）：仅提示，不改变提案流
            const candidates = candidatesForDraft(kbEntries, resolvedDraft.tags ?? [])
            this.commit(teamId, { actor, type: 'knowledge.proposed', payload: { teamId, draftId: draft.id, draft: resolvedDraft, proposedBy: member.memberId } })
            const knowledgeHint = candidates.length > 0
              ? `知识库存在 tags 相交条目，供队长复核时参考关系：${candidates.map((c) => `${c.id}(${c.shared.join('/')})`).join('、')}`
              : undefined
            return {
              status: 'completed',
              note: gateNote ?? '已进入门禁链；知识提案待队长审',
              ...(knowledgeHint ? { knowledgeHint } : {}),
              ...(touched.length > 0
                ? { staleMarked: touched.map((t) => t.id), note2: `任务主题触及 ${touched.length} 条知识条目，已标记待复核（staleSince=${now.slice(0, 10)}）` }
                : {}),
            }
          }
          // 记忆审计（T21：任务收口后扫描，违规落 memory.audit；R28：不阻塞主流程）
          const audit = this.auditMemberMemory(teamId, member.memberId, taskId)
          return {
            status: status === 'done' ? 'completed' : status,
            note: status === 'done' ? (gateNote ?? '已进入门禁链；知识提案（如有）待队长审') : undefined,
            ...(audit && audit.violations > 0
              ? { memoryAudit: { violations: audit.violations, note: '私有记忆存在无证据指针条目，已落账本 memory.audit（FR-6.2）' } }
              : {}),
          }
        }
        case 'myteam_peer_message': {
          const r = this.commit(teamId, { actor, type: 'message.sent', payload: { teamId, messageId: `msg-${Date.now()}`, from: member.memberId, to: args.toMemberId, taskId: args.taskId, content: args.content } })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          this.agentOf(this.memberHandles.get(String(args.toMemberId)))?.followup?.(this.followupMessage(`[myteam] 来自 ${member.instanceName} 的消息：${String(args.content)}`))
          return { status: 'sent' }
        }
        case 'myteam_wait_for_change': {
          // 成员侧等待：与 Lead 侧同一异步长轮询实现（工具 execute 返回 Promise，
          // 宿主工具管线 await 之；不再阻塞事件循环）。
          return this.waitForChange({ ...args, teamId })                                      
        }
        case 'myteam_propose_task_change': {
          const proposalId = `prop-${Date.now()}`
          const r = this.commit(teamId, { actor, type: 'task.proposal', payload: { teamId, taskId: args.taskId, proposalId, type: args.type, payload: args.payload ?? {}, reason: args.reason, proposedBy: member.memberId } })
          return r.ok ? { status: 'proposed', proposalId, note: '提案进队长队列；批准才生效（FR-11.4）' } : { status: 'error', code: r.code, message: r.message }
        }
        case 'myteam_escalate_task': {
          const svc2 = this.service(teamId)
          const t = svc2.projectionSnapshot.tasks[String(args.taskId)]
          const count = (t?.escalateCount ?? 0) + 1
          const r = this.commit(teamId, { actor, type: 'task.escalated', payload: { teamId, taskId: args.taskId, attemptId: args.attemptId ?? t?.attemptId, reason: args.reason, evidence: args.evidence, suggestion: args.suggestion, count } })
          if (!r.ok) return { status: 'error', code: r.code, message: r.message }
          return { status: 'escalated', count, note: count > 2 ? 'escalate 计数 >2：裁决面建议人工介入（FR-11.7）' : '任务已入 re-scoping，等待队长裁决' }
        }
        case 'myteam_read_knowledge': {
          const entry = readKnowledgeEntry(knowledgeDirOf(this.workspaceRoot), String(args.id))
          if (!entry) return { status: 'error', code: 'MT_KB_NOT_FOUND', message: `knowledge entry "${args.id}" not found（索引见提示词）` }
          const body = entry.staleSince ? `[stale 待复核] 该条目已被主题相近任务触及，请勿盲信，注意交叉核对。\n\n${entry.body}` : entry.body
          return { status: 'ok', entry: { id: entry.id, title: entry.title, tags: entry.tags, unverified: entry.unverified, staleSince: entry.staleSince, proofCount: entry.proofCount, body } }
        }
        default:
          return { status: 'error', code: 'MT_UNKNOWN_TOOL', message: `unknown member tool: ${name}` }
      }
    } catch (e) {
      return { status: 'error', code: 'MT_INTERNAL', message: String(e) }
    }
  }

  /* ── 角色目录（FR-13.1 数据面：builtin/global/project 三态并列，origin 标注）── */

  /** 面板角色 tab 只读目录（listRoleCatalog 的脱敏投影：不含 systemPrompt 全文） */
  roleCatalogView()         
                  
              
                
                       
                      
                           
                    
                          
                                               
                   
     {
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

  /** 模板目录（队长选模板用；不写盘） */
  listPresetsTool()                          {
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
  savePreset(args                         )                          {
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
      presetPath: `.team-workplace/config/presets/${definition.id}.json`,
      note: written.created ? '模板已创建；用 myteam_submit_plan({presetId}) 应用' : '模板已更新（版本 +1）；已建团队不受影响',
    }
  }

  /** 复制/fork 模板：内置或项目 → 新项目模板 */
  copyPreset(args                         )                          {
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
      presetPath: `.team-workplace/config/presets/${toId}.json`,
      note: '已复制成项目模板；改它不影响来源模板，用 myteam_submit_plan({presetId}) 应用',
    }
  }

  /** 删除项目模板（内置拒删；confirm 两段确认） */
  deletePreset(args                         )                          {
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
  resetTeamConfig(teamId        , args                         )                          {
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

  /** 创建项目角色（CHG-53，队长技能 create-role 的写入口）：同名任一来源存在 → MT_ROLE_EXISTS */
  createRole(args                         )                          {
    const roleId = String(args.roleId ?? '')
    const existing = this.roleCatalog().find((entry) => entry.definition.id === roleId)
    if (existing) {
      return { status: 'error', code: 'MT_ROLE_EXISTS', message: `role "${roleId}" already exists in ${existing.origin} library` }
    }
    const def                 = {
      id: roleId,
      name: String(args.name ?? ''),
      description: String(args.description ?? ''),
      systemPrompt: String(args.systemPrompt ?? ''),
      isCaptain: args.isCaptain === true,
      skills: Array.isArray(args.skills) ? args.skills.filter((skill)                  => typeof skill === 'string') : [],
      mcpAllowlist: Array.isArray(args.mcpAllowlist) ? args.mcpAllowlist.filter((name)                 => typeof name === 'string') : [],
      interestWords: Array.isArray(args.interestWords)
        ? args.interestWords.filter((word)                 => typeof word === 'string' && word.trim().length > 0).map((word) => word.trim())
        : [],
      version: 1,
      ...(isPlainObject(args.toolPolicy) ? { toolPolicy: args.toolPolicy                                 } : {}),
      ...(isPlainObject(args.model) ? { model: args.model                            } : {}),
    }
    if (!def.name.trim()) return { status: 'error', code: 'MT_ROLE_INVALID', message: `role "${roleId}" requires name` }
    try {
      assertValidRole(def)
      const written = writeProjectRole(this.rolePaths.projectRolesDir, def)
      return {
        status: 'created',
        roleId,
        filePath: written.filePath,
        note: '角色已写入项目库；可用 myteam_spawn_member 或组队名册引用（运行中成员不受影响）',
      }
    } catch (e) {
      return this.roleError(e)
    }
  }

  /** 修改项目角色（CHG-53，队长技能 modify-role）：内置/全局先复制进项目（fork）再 patch */
  updateRole(args                         )                          {
    const roleId = String(args.roleId ?? '')
    if (!isPlainObject(args.patch)) {
      return { status: 'error', code: 'MT_ROLE_INVALID', message: 'patch object is required' }
    }
    let def = readProjectRole(this.rolePaths.projectRolesDir, roleId)
    let copiedFrom                    
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
    const patch = args.patch
    const next                 = { ...def, version: (def.version ?? 1) + 1 }
    if (typeof patch.name === 'string') next.name = patch.name
    if (typeof patch.description === 'string') next.description = patch.description
    if (typeof patch.systemPrompt === 'string') next.systemPrompt = patch.systemPrompt
    if (typeof patch.isCaptain === 'boolean') next.isCaptain = patch.isCaptain
    if (Array.isArray(patch.skills)) next.skills = patch.skills.filter((skill)                  => typeof skill === 'string')
    if (Array.isArray(patch.mcpAllowlist)) next.mcpAllowlist = patch.mcpAllowlist.filter((name)                 => typeof name === 'string')
    if (Array.isArray(patch.interestWords)) {
      next.interestWords = patch.interestWords
        .filter((word)                 => typeof word === 'string' && word.trim().length > 0)
        .map((word) => word.trim())
    }
    if (isPlainObject(patch.toolPolicy)) next.toolPolicy = patch.toolPolicy                                
    if (isPlainObject(patch.model)) next.model = patch.model                           
    if (!next.name.trim()) return { status: 'error', code: 'MT_ROLE_INVALID', message: `role "${roleId}" requires name` }
    try {
      assertValidRole(next)
      writeProjectRole(this.rolePaths.projectRolesDir, next)
      return {
        status: 'updated',
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
  applyRoles(teamId        , args                         , actor        )                          {
    const requested = Array.isArray(args.roles)
      ? (args.roles             ).map((id) => String(id ?? '').trim()).filter((id) => id.length > 0)
      : []
    const removals = Array.isArray(args.remove)
      ? (args.remove             ).map((id) => String(id ?? '').trim()).filter((id) => id.length > 0)
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
    const resolved                   = []
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
  roleOp(op        , payload                          = {})                          {
    /**
     * CHG-91（契约 P3 单向流动）：**插件贡献的角色只读**。
     *
     * `save` / `delete` / `publish` 打到 `plugin` 来源的角色上一律拒（`MT_ROLE_READONLY`）——
     * 想改就 `copyToProject` 复制成项目库角色再改（此后项目库优先级更高，自动生效）。
     * 为什么 `publish` 也拒：插件来源不是「项目库资产」，没有「发布到全局」这一说。
     */
    const directId = String((payload                        ).roleId ?? '')
    const saveId = String((payload                               ).role?.id ?? '')
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

          roleError(e         )                          {
    const err = e                                       
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
          deferCaptainServices()       {
    const ctx = this.rt                                                                                      
    const run = (scoped          )       => {
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

          registerCaptainSkills(scoped          )       {
    const skills = safeRead(scoped ?? this.rt, 'skills')                                                                          
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
   * CHG-93（FR-18 职责③ F8）：把团队章程（`.team-workplace/structure.md`）注入队长 system prompt。
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
          registerTeamCharter(scoped          )       {
    const systemPrompt = safeRead(scoped ?? this.rt, 'systemPrompt')   
         
                                                                    
                                                                                     
       
                 
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
  presetCatalogView()                {
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
          listContributionsTool(catalog                      = this.contributionCatalog)                          {
    return {
      status: 'ok',
      root: catalog.root,
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
  archiveView(teamId         )                                                                            {
    const id = teamId && teamId.trim().length > 0 ? teamId.trim() : this.defaultTeamId()
    return { teamId: id, archive: readArchive(this.workspaceRoot, id), root: archiveRootOf(this.workspaceRoot) }
  }

  /** 已归档团队 id 列表（面板「全部团队」入口；只读目录名） */
  archiveList()                                    {
    return { root: archiveRootOf(this.workspaceRoot), teams: listArchives(this.workspaceRoot) }
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
  async handoffTeam(args                          = {})                                   {
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
   */
  syncTokens(teamId        )             {
    const svc = this.service(teamId)
    const dir = join(this.workspaceRoot, '.team-workplace', 'state', 'teams', teamId)
    const filePath = join(dir, 'tokens.json')
    // ① 已有历史：优先内存，其次读盘（进程重启后 days 不能丢）
    let file = this.tokensFiles.get(teamId)
    if (!file) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'))              
        if (parsed && typeof parsed === 'object' && parsed.days) file = parsed
      } catch {
        file = undefined
      }
    }
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
    for (const member of Object.values(svc.projectionSnapshot.members)) {
      const agent = this.agentOf(this.memberHandles.get(member.id))
      if (!agent) continue
      try {
        // session-projection 契约：stateOf(session, key) 读宿主态（README §Register and read）。
        // 旧实现 .read() 不存在——真实注册的 'tokenUsage' 投影只能经 stateOf 读。
        const usage = projections?.stateOf?.((agent                         ).session, 'tokenUsage') ?? undefined
        const totals = usage?.totals ?? usage
        if (!totals || typeof totals !== 'object') continue
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
        baselines.set(member.id, current)
        if (delta.uncachedInput + delta.cacheRead + delta.cacheWrite + delta.output + delta.calls > 0) {
          file = accumulate(file, member.id, dayKey, delta)
          observed += 1
        }
      } catch (e) {
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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    this.tokensFiles.set(teamId, file)
    return file
  }

  /** 冷启动恢复（T16）：对滞留 in_progress 任务按恢复表落事件 */
  recoverOnBoot(teamId        )                                           {
    const svc = this.service(teamId)
    const actions           = []
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
import * as remoteServiceModule from './remote/service.mjs'

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
export function apply(ctx                                   , config               = {})       {
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


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/host.ts