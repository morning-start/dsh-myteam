/**
 * T13：面板 Remote 方法（host 侧只读投影 + 唯一写入口 planAction）。
 *
 * ADR-006：面板绝不直写文件；读 = 投影/侧车快照；写 = 走 TeamService（与工具同管线）。
 * M1 收窄版（CHG-16 第一刀）：只读看板数据 + 暂存横幅三动作；成员管理操作走聊天。
 * 方法签名与 docs/04 §2 对齐；由 host.ts 接 ctx.typert.register（TF 同型 Remote service）。
 */
                                                                                
import { TERMINAL_STATES } from '../core/scheduler/state.mjs'
                                                                 
                                                               
import { buildConfigPayload } from '../core/config/config-view.mjs'
import { buildTaskGraph,                } from '../core/tasks/graph.mjs'
import { diagnoseTask,                    } from '../core/tasks/readiness.mjs'
                                                                            
import { resolveEffectiveRole } from '../core/roles/role-store.mjs'

/** 视图只依赖投影快照（T25：离线只读视图复用同一套纯函数，无需构造 TeamService） */
                                   
                                    
 

                                  
                
                       
                     
 

/** CHG-73：任务可用动作（服务端算，UI 不重复实现状态机规则） */
                              
                   
                  
                 
                 
                    
               
 

/** 字段级改动（与 core/tasks/diff.ts 的 FieldChange 同构；视图层不 import 实现类型） */
                                 
               
               
             
 

/** 一次编辑（新→旧渲染；reason 来自 rescope/取消理由） */
                               
             
            
               
                 
                           
 

/** 终态任务不可再重规划/取消；已取消与失败的任务连元数据编辑也没有意义（不再参与任何调度） */
export function taskActionsOf(task                )              {
  const terminal = TERMINAL_STATES.has(task.state)
  const editable = task.state !== 'cancelled' && task.state !== 'failed'
  return { rescope: !terminal, cancel: !terminal, edit: editable }
}

                                
            
               
               
                  
                   
                                                
                      
                      
                       
                
                 
                                               
                                                                   
                                      
                                                          
                                                                                                                                          
                                                    
                       
                                        
                                 
                                          
                           
                                       
                      
                                       
                                                     
                                    
                                            
                                    
                   
                                                                  
                             
 

/** CHG-87（FR-5.4）：scope 完成审计的视图形态（与 core/gates/scope-audit.ts 同构） */
                                 
                    
                       
                      
             
                   
 

                            
                
                                                             
               
               
               
                                                                                                                                                     
                                                     
                    
                       
                  
                                                  
                   
 

                                 
            
               
                                
                    
                   
                            
                      
                       
                                        
                 
                                               
                                          
                                      
                                                          
                                                                                                                                          
                   
                       
                                                                       
                                                                                        
                                               
                                                                      
                                                                      
                           
                                 
                                         
                           
                             
                      
                                                    
                                                                           
                                                                 
                       
                    
                                                                         
                                                                                          
                                                              
                                                               
     
                                                     
                                                   
                                          
     
                  
                                                
                             
 

/**
 * CHG-87（FR-5.4）：scope 审计投影 → 视图（拷贝数组，避免面板拿到投影内部引用后误改）。
 * `ok` 由投影给出（host 侧 `auditWriteScopes` 的结论），视图**不重算**——重算会和
 * 审计时刻的 writeScopes 不一致（任务定义后来改过时结论就变了）。
 */
function scopeAuditView(audit   
                    
                       
                      
             
                   
 )                 {
  return {
    declared: [...audit.declared],
    writeScopes: [...audit.writeScopes],
    outOfScope: [...audit.outOfScope],
    ok: audit.ok,
    checkedAt: audit.checkedAt,
  }
}

/** 参与团队视图（旧账本无参与事件时回落：owner team = lead） */export function participantsOf(proj                , taskId        )                    {
  const entry = proj.participations?.[taskId]
  if (!entry || Object.keys(entry.teams ?? {}).length === 0) {
    return [{ teamId: proj.teamId, role: 'lead', memberIds: [] }]
  }
  return Object.values(entry.teams)
    .map((p) => ({ teamId: p.teamId, role: p.role, memberIds: [...(p.memberIds ?? [])] }))
    .sort((a, b) => (a.role === b.role ? a.teamId.localeCompare(b.teamId) : a.role === 'lead' ? -1 : 1))
}

/**
 * CHG-73：改动记录（新→旧，最多 20 条）。取 task.updated / task.rescoped 事件；
 * changes 来自写入端算好的字段级 diff——旧账本没有 changes 时给空数组，
 * 详情页仍显示「某时被谁编辑过 / 为什么」。
 */
export function editsOf(
  events                                                                                              ,
  taskId        ,
)                 {
  const out                 = []
  for (const event of events) {
    if (event.type !== 'task.updated' && event.type !== 'task.rescoped') continue
    const payload = (event.payload ?? {})                           
    if (payload.taskId !== taskId) continue
    const raw = Array.isArray(payload.changes) ? (payload.changes                             ) : []
    out.push({
      seq: event.seq,
      ts: event.ts,
      actor: event.actor,
      ...(typeof payload.reason === 'string' && payload.reason.length > 0 ? { reason: payload.reason } : {}),
      changes: raw.map((change) => ({ field: String(change?.field ?? ''), from: change?.from ?? null, to: change?.to ?? null })),
    })
  }
  return out.reverse().slice(0, 20)
}

/* ── P1-3（docs/21 §6，来源官方 `types/projection.js:274-317`）：投影视图两级 WeakMap 缓存 ── */

/** 缓存计数快照（只读；测试断言命中/未命中次数，面板也可用于诊断） */
                                 
              
                
 

/**
 * 看板视图的缓存条目（`members` → `tasks` 两级 WeakMap 的值）。
 *
 * 为什么用**引用**做键：`fold.ts` 的 `copyTouchedCollections` 只复制被触及的集合，
 * 所以「只来了一条消息」时 `members` / `tasks` 引用都不变 → 命中 → 返回**同一个视图对象**
 * → 客户端拿到相同引用，不产生白 frame（整块重渲染）。
 * 用 WeakMap 而不是 Map：投影被回收时条目一起消失，不会把整份投影钉在内存里。
 *
 * 为什么命中后还要回填 `revision` / `inboxCount` / `proposalCount`：
 * 这三项**不是** members/tasks 的派生量（消息事件只改 `inbox` 与 `revision`）。
 * 把它们算进缓存键的话，每来一条消息都必然失效——恰好是本任务要消除的那类重渲染。
 * 原地回填让「引用不变」与「字段最新」同时成立（`revision` 是乐观锁版本，本来就该取当前值）。
 */
                           
                                    
                    
                
                          
                                
                          
                                                         
                                                  
                 
 

let boardCache = new WeakMap                                                                              ()

/**
 * 任务详情视图缓存：内层再按「任务 + 账本事件签名」分桶。
 * 详情页的时间线 / 消息 / 改动记录直接从账本事件派生，所以事件变了必须重建
 * （`revision` = 已应用事件数，含消息事件，足以区分事件流）。
 */
let detailCache = new WeakMap                                                                                          ()

let cacheHits = 0
let cacheMisses = 0

/** P1-3：缓存计数快照（只读；测试断言命中/未命中次数） */
export function viewCacheStats()                 {
  return { hits: cacheHits, misses: cacheMisses }
}

/** P1-3：清空缓存与计数（测试用：清空后下一次构建必定是一次真正的重算） */
export function __clearViewCache()       {
  boardCache = new WeakMap()
  detailCache = new WeakMap()
  cacheHits = 0
  cacheMisses = 0
}

/**
 * P1-3：失败态视图**绕过缓存**、每次重建。
 *
 * 官方 `state.failure` 是失败瞬间的定格（面板据此展示错误现场）；缓存命中会让这份
 * 「现场」被后续事件悄悄改写。本插件投影暂无该字段，这里按前向兼容处理——
 * 宿主/后续版本注入 `failure` 时同样不缓存（宁可多算一次，不可展示错误的失败现场）。
 */
function hasFailureMarker(proj                )          {
  const raw = proj                                                     
  if (raw.failure) return true
  const state = raw.state
  return typeof state === 'object' && state !== null && Boolean((state                         ).failure)
}

/** 只有对象才能当 WeakMap 的键（手工构造的投影可能缺集合，缺就退化成不缓存） */
function isCacheKey(value         )                  {
  return typeof value === 'object' && value !== null
}

/** 看板视图：投影 × config 列归并（纯投影，UI 不建第二事实源）；P1-3 起走两级 WeakMap 缓存 */
export function buildBoardView(service                  , columnMapping                          , columns          )            {
  const proj = service.projectionSnapshot
  const columnsKey = JSON.stringify([columnMapping, columns])
  const cacheable = !hasFailureMarker(proj) && isCacheKey(proj.members) && isCacheKey(proj.tasks)
  if (cacheable) {
    const entry = boardCache.get(proj.members)?.get(proj.tasks)
    if (
      entry &&
      entry.columnsKey === columnsKey &&
      entry.teamId === proj.teamId &&
      entry.name === proj.name &&
      entry.state === proj.state &&
      entry.goal === proj.goal &&
      entry.participations === proj.participations
    ) {
      cacheHits += 1
      // 版本类字段每次取当前值（见 BoardCacheEntry 注释）
      entry.view.revision = proj.revision
      entry.view.inboxCount = proj.inbox?.length ?? 0
      entry.view.proposalCount = Object.values(proj.proposals ?? {}).filter((p) => p.status === 'proposed').length
      return entry.view
    }
  }
  cacheMisses += 1
  const view = buildBoardViewUncached(proj, columnMapping, columns)
  if (cacheable) {
    let byTasks = boardCache.get(proj.members)
    if (!byTasks) {
      byTasks = new WeakMap()
      boardCache.set(proj.members, byTasks)
    }
    byTasks.set(proj.tasks, {
      columnsKey,
      teamId: proj.teamId,
      name: proj.name,
      state: proj.state,
      goal: proj.goal,
      participations: proj.participations,
      view,
    })
  }
  return view
}

/** 看板视图的实际构建（无缓存；缓存包装见 `buildBoardView`） */
function buildBoardViewUncached(proj                , columnMapping                          , columns          )            {
  const stateToColumn = new Map                ()
  for (const [col, states] of Object.entries(columnMapping)) {
    for (const s of states) stateToColumn.set(s, col)
  }
  const columnTasks = new Map                                               ()
  for (const col of columns) columnTasks.set(col, [])
  for (const t of Object.values(proj.tasks)) {
    const col = stateToColumn.get(t.state) ?? (columns.includes(t.state) ? t.state : columns[0])
    if (!columnTasks.has(col)) columnTasks.set(col, [])
    const diagnosis = diagnoseTask(proj, t.id)
    columnTasks.get(col) .push({
      id: t.id,
      title: t.input.title,
      state: t.state,
      priority: t.input.priority,
      assignee: t.assignee,
      ...(t.assignees ? { assignees: t.assignees } : {}),
      requiredRole: t.input.requiredRole,
      escalateCount: t.escalateCount,
      deps: t.input.deps,
      gates: t.gates,
      gateVerdicts: t.gateVerdicts,
      ...(t.gateRejects && Object.keys(t.gateRejects).length > 0 ? { gateRejects: { ...t.gateRejects } } : {}),
    ...(t.gateResults && Object.keys(t.gateResults).length > 0 ? { gateResults: { ...t.gateResults } } : {}),
      ...(t.gateResults && Object.keys(t.gateResults).length > 0 ? { gateResults: { ...t.gateResults } } : {}),
      evidenceCount: t.evidenceRefs.length,
      participants: participantsOf(proj, t.id),
      ...(diagnosis ? { diagnosis } : {}),
      actions: taskActionsOf(t),
      ...(t.evidenceStale ? { evidenceStale: { since: t.evidenceStale.since, fields: [...t.evidenceStale.fields] } } : {}),
      ...(t.state === 'cancelled' ? { cancelled: { ts: t.cancelledAt ?? t.createdAt, reason: t.cancelReason ?? '' } } : {}),
      ...(t.rewiredFrom ? { rewired: true } : {}),
      // CHG-87（FR-5.4）：scope 审计（越界才需要徽标；未声明 writeScopes 时投影里没有该字段）
      ...(t.scopeAudit ? { scopeAudit: scopeAuditView(t.scopeAudit) } : {}),
    })
  }
  return {
    teamId: proj.teamId,
    name: proj.name,
    state: proj.state,
    goal: proj.goal,
    members: Object.values(proj.members).map((m) => ({
      id: m.id, roleId: m.roleId, instanceName: m.instanceName, status: m.status, currentTaskId: m.currentTaskId,
      ...(m.skills ? { skills: m.skills } : {}),
      ...(m.mcpAllowlist ? { mcpAllowlist: m.mcpAllowlist } : {}),
    })),
    columns: columns.map((name) => ({ name, tasks: columnTasks.get(name) ?? [] })),
    inboxCount: proj.inbox.length,
    proposalCount: Object.values(proj.proposals).filter((p) => p.status === 'proposed').length,
    revision: proj.revision,
    graph: buildTaskGraph(Object.values(proj.tasks).map((t) => ({ id: t.id, deps: t.input.deps }))),
  }
}

/** 任务详情：时间线（账本事件）+ 沟通消息流 + 证据块（FR-8.1/12.2）；P1-3 起按「任务 + 事件签名」走两级 WeakMap 缓存 */
export function buildTaskDetailView(service                  , taskId        , events                                                                                              )                             {
  const proj = service.projectionSnapshot
  const cacheable = !hasFailureMarker(proj) && isCacheKey(proj.members) && isCacheKey(proj.tasks)
  // 事件签名：详情页的时间线/消息/改动记录都从账本事件派生——事件流一变就必须重建。
  // 用「全部 seq 的滚动指纹 + 条数 + revision（= 已应用事件数）」三段：
  // 首尾 seq 不够（[1,2,5] 与 [1,3,5] 首尾相同、内容不同），滚动指纹把中间也纳入。
  // 之所以用指纹而不是数组引用：面板每次 getTaskDetail 都从账本文件重新解析出一个新数组，
  // 引用恒不同——用引用做键 = 永远是未命中，缓存等于没有。
  let eventsHash = 0
  for (const event of events) eventsHash = (Math.imul(eventsHash, 31) + event.seq) | 0
  const eventsKey = `${taskId}|${proj.revision}|${events.length}|${eventsHash}`
  if (cacheable) {
    const cached = detailCache.get(proj.members)?.get(proj.tasks)?.get(eventsKey)
    if (cached) {
      cacheHits += 1
      return cached
    }
  }
  cacheMisses += 1
  const view = buildTaskDetailViewUncached(proj, taskId, events)
  if (view && cacheable) {
    let byTasks = detailCache.get(proj.members)
    if (!byTasks) {
      byTasks = new WeakMap()
      detailCache.set(proj.members, byTasks)
    }
    let byEvents = byTasks.get(proj.tasks)
    if (!byEvents) {
      byEvents = new Map()
      byTasks.set(proj.tasks, byEvents)
    }
    byEvents.set(eventsKey, view)
  }
  return view
}

/** 任务详情的实际构建（无缓存；缓存包装见 `buildTaskDetailView`） */
function buildTaskDetailViewUncached(proj                , taskId        , events                                                                                              )                             {
  const t = proj.tasks[taskId]
  if (!t) return undefined
  // seq → 事件映射：账本截断/轮转后 seq 不再等于数组下标（离线视图可能拿到过滤后的切片）
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const timeline = events.filter((e) => (e.payload                           )?.taskId === taskId)
    .map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type }))
  const messageSeqs = new Set(proj.perTaskMessages[taskId] ?? [])
  const diagnosis = diagnoseTask(proj, taskId)
  const edits = editsOf(events, taskId)
  const lastEvidenceSeq = t.evidenceRefs.length > 0 ? t.evidenceRefs[t.evidenceRefs.length - 1] : undefined
  return {
    id: t.id,
    state: t.state,
    input: t.input                                      ,
    attemptId: t.attemptId,
    assignee: t.assignee,
    ...(t.assignees ? { assignees: t.assignees } : {}),
    escalateCount: t.escalateCount,
    gates: t.gates,
    gateVerdicts: t.gateVerdicts,
    ...(t.gateRejects && Object.keys(t.gateRejects).length > 0 ? { gateRejects: { ...t.gateRejects } } : {}),
    createdAt: t.createdAt,
    waitingSince: t.waitingSince,
    participants: participantsOf(proj, t.id),
    ...(diagnosis ? { diagnosis } : {}),
    actions: taskActionsOf(t),
    edits,
    ...(t.evidenceStale
      ? {
          evidenceStale: {
            since: t.evidenceStale.since,
            fields: [...t.evidenceStale.fields],
            ...(lastEvidenceSeq !== undefined ? { evidenceSeq: lastEvidenceSeq } : {}),
          },
        }
      : {}),
    ...(t.state === 'cancelled'
      ? { cancellation: { ts: t.cancelledAt ?? t.createdAt, reason: t.cancelReason ?? '', downstream: t.cancelDownstream ?? 'leave' } }
      : {}),
    ...(t.rewiredFrom ? { rewiredFrom: { removed: t.rewiredFrom.removed, ...(t.rewiredFrom.added ? { added: t.rewiredFrom.added } : {}), ts: t.rewiredFrom.ts } } : {}),
    // CHG-87（QA-4 乐观锁）：编辑表单打开时快照它，保存时回传 expectedRevision
    revision: proj.revision,
    // CHG-87（FR-5.4）：scope 完成审计（详情页「写入范围审计」块）
    ...(t.scopeAudit ? { scopeAudit: scopeAuditView(t.scopeAudit) } : {}),
    evidenceRefs: t.evidenceRefs.map((seq) => {
      const ev = bySeq.get(seq)
      const payload = (ev?.payload                           ) ?? {}
      const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : undefined
      return { seq, evidence: (payload.evidence                           ) ?? {}, ...(attemptId ? { attemptId } : {}) }
    }),
    deliverables: t.deliverables,
    timeline,
    messages: events.filter((e) => messageSeqs.has(e.seq)).map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type })),
  }
}

/** tokens 侧车视图（含命中率派生，REV-5） */
export function buildTokensView(file            )                          {
  const hitRate = (b                                                                  ) => {
    const denom = b.uncachedInput + b.cacheRead + b.cacheWrite
    return denom === 0 ? null : b.cacheRead / denom
  }
  return {
    version: file.version,
    teamId: file.teamId,
    updatedAt: file.updatedAt,
    note: file.note,
    // CHG-47 / REV-5 双口径标注：本视图来自 tokenMeter 实时读数（启发式，非账单），
    // 与账本事件里的用量口径分开标注，避免对账时混淆。
    source: 'tokenMeter',
    caliber: 'heuristic',
    nonBillable: true,
    days: file.days,
    totals: Object.fromEntries(
      Object.entries(file.totals).map(([memberId, b]) => [memberId, { ...b, hitRate: hitRate(b) }]),
    ),
  }
}

/* ── CHG-69：项目级聚合（任务 × 团队参与 / 角色目录与详情 / 依赖图） ── */

/** 团队参与者（聘任记录视角：角色 × 团队的关系，不进模型） */
                                     
                
                   
                      
                
                 
                        
 

                                  
                
            
              
                     
                    
                         
                  
                        
                                             
                 
                                         
                                   
                                                        
                    
                                                 
                     
 

                                                        
                                  
             
                     
                        
                                   
                      
                         
 

                                   
                
               
               
               
                 
                    
                               
                   
 

                              
                       
                                                                                                                                                                                                        
                          
                  
                          
                               
                                                                                                                        
                    
 

/** 角色目录视图：角色定义 + 兴趣词/技能/MCP + 跨团队在册情况（FR-24） */
export function buildRoleCatalogView(
  entries             ,
  memberships                                                      ,
)                                                              {
  const map = (entry           )                  => {
    const def = entry.definition
    // 在册只对「项目库 / 项目自身角色」成立：内置与全局只是复制源（运行时只认项目库，R13）
    const appointable = entry.origin === 'project' || entry.origin === 'project-role'
    const list = appointable ? memberships.filter((m) => m.roleId === def.id).map((m) => m.membership) : []
    return {
      origin: entry.origin,
      id: def.id,
      name: def.name,
      description: def.description,
      isCaptain: def.isCaptain === true,
      interestWords: [...(def.interestWords ?? [])],
      skills: [...(def.skills ?? [])],
      mcpAllowlist: [...(def.mcpAllowlist ?? [])],
      ...(def.model ? { model: def.model } : {}),
      version: def.version ?? 1,
      memberships: list,
      canDelete: entry.origin === 'project' && list.length === 0,
      ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
    }
  }
  const roles                    = []
  let projectRole                             
  for (const entry of entries) {
    const view = map(entry)
    if (entry.origin === 'project-role') projectRole = view
    else roles.push(view)
  }
  return { roles, ...(projectRole ? { projectRole } : {}) }
}

/**
 * 角色详情：定义全文（含提示词）+ 在册情况（FR-24 定义/设定/skill/MCP 聚合）。
 *
 * CHG-74：同名副本时取**生效条目**（项目库 > 项目自身角色 > 全局 > 内置）——
 * 否则会出现「项目里改的那份，详情却显示内置定义」的错觉（编辑入口也会走错分支）。
 * `shadowed` 列出被它让位的其它来源，UI 据此说明「同名副本已由这份生效」。
 */
export function buildRoleDetailView(
  entries             ,
  roleId        ,
  memberships                                                      ,
)   
                
                            
                                   
                                             
                                        
                    
                                                 
                   
              {
  const entry = resolveEffectiveRole(entries, roleId)
  if (!entry) return undefined
  const list = memberships.filter((m) => m.roleId === roleId).map((m) => m.membership)
  const shadowed = entries
    .filter((e) => e.definition.id === roleId && e !== entry)
    .map((e) => e.origin)
  return {
    origin: entry.origin,
    definition: entry.definition,
    memberships: list,
    usage: { teams: new Set(list.map((m) => m.teamId)).size, instances: list.length },
    shadowed,
    editable: entry.origin === 'project',
  }
}

/** 项目聚合：团队摘要 + 跨团队任务（带参与团队）+ 全局依赖图 + 角色目录（FR-19/21） */
export function buildProjectView(input   
                       
                           
                      
                     
 )              {
  const teams = input.teams.map((team) => {
    const tasks = team.board ? team.board.columns.flatMap((col) => col.tasks) : []
    return {
      teamId: team.teamId,
      ...(team.name ? { name: team.name } : {}),
      state: team.state,
      ...(team.goal ? { goal: team.goal } : {}),
      online: team.online,
      ...(team.sessionId ? { sessionId: team.sessionId } : {}),
      members: team.members,
      counts: {
        tasks: tasks.length,
        done: tasks.filter((task) => task.state === 'done').length,
        running: tasks.filter((task) => task.state === 'in_progress').length,
      },
    }
  })
  const tasks                    = []
  for (const team of input.teams) {
    if (!team.board) continue
    for (const task of team.board.columns.flatMap((col) => col.tasks)) {
      tasks.push({
        ...task,
        key: `${team.teamId}/${task.id}`,
        ownerTeamId: team.teamId,
        ...(team.name ? { ownerTeamName: team.name } : {}),
        ownerOnline: team.online,
        ...(team.sessionId ? { ownerSessionId: team.sessionId } : {}),
      })
    }
  }
  // 全局依赖图：跨团队按复合键重建边（依赖只在团队内部成立）
  const graph = buildTaskGraph(tasks.map((task) => ({
    id: task.key,
    deps: task.deps.map((dep) => `${task.ownerTeamId}/${dep}`),
  })))
  const memberships = input.teams.flatMap((team) =>
    (team.members ?? []).map((member) => ({
      roleId: member.roleId,
      membership: {
        teamId: team.teamId,
        ...(team.name ? { teamName: team.name } : {}),
        instanceName: member.instanceName,
        status: member.status,
        online: team.online,
        workspaceRoot: input.workspaceRoot,
      }                      ,
    })),
  )
  const catalog = buildRoleCatalogView(input.entries, memberships)
  return {
    workspaceRoot: input.workspaceRoot,
    teams,
    tasks,
    graph,
    roles: catalog.roles,
    ...(catalog.projectRole ? { projectRole: catalog.projectRole } : {}),
    counts: {
      tasks: tasks.length,
      done: tasks.filter((task) => task.state === 'done').length,
      running: tasks.filter((task) => task.state === 'in_progress').length,
      gates: tasks.filter((task) => String(task.state).startsWith('gate:')).length,
      teams: teams.length,
      members: teams.reduce((sum, team) => sum + (team.members ?? []).length, 0),
      roles: catalog.roles.length,
    },
    warnings: input.warnings ?? [],
  }
}

/* ── T28（CHG-49）：审计视图 + 配置视图（面板「审计」「设置」页的数据面） ── */

                                  
             
            
               
              
                                   
 

                                 
             
            
               
              
                 
 

                            
                
               
                          
                                
                              
 

/** 账本事件 → 审计页（新→旧；按 seq 游标分页，UI 不建第二事实源） */
export function buildAuditView(teamId        , events                   , opts                                         = {})            {
  const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 100)))
  const before = Number(opts.beforeSeq ?? Number.POSITIVE_INFINITY)
  const newestFirst = [...events]
    .filter((event) => event.seq < before)
    .sort((a, b) => b.seq - a.seq)
  const page = newestFirst.slice(0, limit)
  return {
    teamId,
    total: events.length,
    events: page.map((event) => ({
      seq: event.seq,
      ts: event.ts,
      actor: event.actor,
      type: event.type,
      ...(typeof event.payload?.taskId === 'string' ? { taskId: event.payload.taskId } : {}),
    })),
    nextBeforeSeq: newestFirst.length > limit ? page[page.length - 1].seq : null,
  }
}

/** 生效配置视图（FR-14.3）：来源标注 + 生效值 + 告警；source='team' = 团队模板落盘（CHG-55） */
export function buildConfigView(svc                                                           , source                                 = 'default')                          {
  return buildConfigPayload(svc.effectiveConfig, svc.configWarnings, source)                                      
}


//# sourceURL=./src/remote/views.ts