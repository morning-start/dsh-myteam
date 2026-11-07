/**
 * D2 调度/投影域（T3+T4）：任务状态机 fold + 调度纯函数。
 *
 * 全部无 IO、无 ctx 依赖〔J1〕：输入账本事件切片 → 输出投影/判定。
 * 状态机（PRD §7.1 + FR-11.7）：
 *   backlog ──(deps 全 done)──► ready ──claim──► in_progress
 *   in_progress ──escalate──► re-scoping ──rescope──► ready / ──split──► cancelled / ──abort──► blocked
 *   in_progress ──► gate:review ──pass──► gate:verify ──pass──► gate:archive ──pass──► done
 *   gate fail ──► repair（M2）；failed 终态（下游永不解锁）；cancelled（split 后下游已重接线）
 *   blocked ──(人工)──► ready
 */

                       
             
           
                 
                
                 
                 
                  
          
            
             
               

export const TERMINAL_STATES                         = new Set(['done', 'failed', 'cancelled'])

/**
 * CHG-86（FR-5.2 打回预算）：单个门禁允许的打回轮数上限。
 * 超限后队长工具不能再放行（`MT_REJECT_BUDGET` → needs-human），只有人工（面板 confirm）能放行。
 * 依据：TF r9 实测一次 full run 61% 的模型调用花在打回闭环上——预算必须是硬上限，不是提示。
 */
export const GATE_REJECT_BUDGET = 2

                            
               
                     
                              
                                                                                             
                
                      
                   
                      
                                     
                            
                                                                         
                 
     
                                             
                                                 
                                          
     
                        
     
                                                     
                                                                   
     
                                                                      
 

                                 
            
                  
                  
                    
                   
                                                                     
                      
                       
                 
                                               
     
                                        
                                             
                                          
     
                                      
     
                                              
    
                                                               
                                                                        
                                             
     
                                                                                                                                          
                                          
                                               
                   
                                                   
                                 
                                              
                     
                                             
                       
                                                  
                                                     
                                                 
                      
                       
                                                  
     
                               
                                                   
     
                                                               
     
                                      
                                                 
                                                       
     
                
                      
                         
                        
               
                     
   
 

/** 任务 × 团队参与边（CHG-69，FR-21；关系不是实体：主责 1 / 协作 N） */
                                
                
                       
                                            
                     
                      
             
            
 

/** 单任务的参与集合（leadTeamId = 主责团队；teams 含主责与全部协作） */
                                    
                     
                                      
 

/** 状态机合法转移表（拒绝式校验的数据源）。
 * gate 链按 config 驱动（FR-10.3 通用性）：任意 gate:xxx 的合法后继 = gate 链的下一项或 done。
 * 静态表只列固定骨架；gate 间转移由 fold 按 t.gates 动态判定（见 fold.ts gateAdvance）。 */
export const LEGAL_TRANSITIONS                                 = {
  backlog: ['ready', 'blocked', 'cancelled'],
  // CHG-73：重新规划（rescope）带结构补丁时，任务可能退回 backlog（新依赖还没完成）——
  // 「ready → backlog」只在 rescope 事件里出现，是补丁生效后的重新调度，不是回退历史。
  ready: ['in_progress', 'blocked', 'cancelled', 'backlog'],
  in_progress: ['re-scoping', 'gate:review', 'gate:verify', 'gate:archive', 'failed', 'blocked', 'cancelled'],
  're-scoping': ['ready', 'backlog', 'blocked', 'cancelled'],   // rescope→ready / abort→blocked / 队长撤销→cancelled
  'gate:review': ['gate:verify', 'gate:archive', 'in_progress', 'ready', 'failed', 'cancelled'],  // 后继由任务 gateChain 决定；ready = 打回后回到修复队列（CHG-86）
  'gate:verify': ['gate:review', 'gate:archive', 'in_progress', 'ready', 'failed', 'cancelled'],
  'gate:archive': ['done', 'in_progress', 'ready', 'failed', 'cancelled'],
  done: [],
  failed: [],
  blocked: ['ready', 'backlog', 'cancelled'],
  cancelled: [],
}

export function isLegalTransition(from           , to           )          {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to)
}

/** gate 链推进（fold 专用）：from gate pass 后按该任务 gateChain 的实际下一站判定 */
export function gateAdvance(currentGate        , gates          )            {
  const idx = gates.indexOf(currentGate)
  if (idx < 0) return 'done'
  const next = gates[idx + 1]
  return next ? ((`gate:${next}`             )) : 'done'
}

/** FR-11.2 host 硬校验（拒绝式，七项）。
 *  CHG-72：allowOrphans —— 计划提交（draft）仍强制「无孤儿」；团队已 active 后单独补一条
 *  独立任务（面板/队长 create_task）是正常操作，不再要求它必须挂在既有 DAG 上。 */
                                 
             
                                                             
 

export function validatePlan(tasks                           , maxTasks        , rosterRoles          , opts                             = {})                 {
  const errors                           = []
  const ids = Object.keys(tasks)
  if (ids.length === 0) {
    // 空计划合法（CHG-16：暂存计划允许先出名册后补任务，逐个 create_task 入库）
    return { ok: true, errors: [] }
  }
  if (ids.length > maxTasks) {
    errors.push({ taskId: '-', code: 'MT_VALIDATION', message: `task count ${ids.length} exceeds limit ${maxTasks}` })
  }
  const referenced = new Set        ()
  for (const id of ids) {
    const t = tasks[id]
    // ③ requiredRole 在名册内
    if (!rosterRoles.includes(t.requiredRole)) {
      errors.push({ taskId: id, code: 'MT_VALIDATION', message: `requiredRole "${t.requiredRole}" not in roster` })
    }
    // ④ AC≥1
    if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.length === 0) {
      errors.push({ taskId: id, code: 'MT_VALIDATION', message: 'acceptanceCriteria must have at least 1 item' })
    }
    // deps 引用存在
    for (const dep of t.deps ?? []) {
      referenced.add(dep)
      if (!ids.includes(dep)) {
        errors.push({ taskId: id, code: 'MT_VALIDATION', message: `dep "${dep}" does not exist` })
      }
    }
    // ⑦ 叶子任务有 deliverableSpec
    const isLeaf = (t.deps ?? []).length === 0
    if (isLeaf && !t.deliverableSpec?.path) {
      errors.push({ taskId: id, code: 'MT_VALIDATION', message: 'leaf task requires deliverableSpec.path' })
    }
  }
  // ① DAG 无环（Kahn 拓扑）
  const indegree = new Map(ids.map((id) => [id, 0]))
  const dependents = new Map                  (ids.map((id) => [id, []]))
  for (const id of ids) {
    for (const dep of tasks[id].deps ?? []) {
      if (indegree.has(dep)) {
        indegree.set(id, (indegree.get(id) ?? 0) + 1)
        dependents.get(dep) .push(id)
      }
    }
  }
  const queue = ids.filter((id) => indegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift() 
    visited += 1
    for (const next of dependents.get(node) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (visited !== ids.length) {
    const cyclic = ids.filter((id) => (indegree.get(id) ?? 0) > 0)
    for (const id of cyclic) {
      errors.push({ taskId: id, code: 'MT_VALIDATION', message: 'task is part of a dependency cycle' })
    }
  }
  // ⑥ 无孤儿（每个任务要么被依赖要么依赖别人；单任务计划豁免）
  if (ids.length > 1 && !opts.allowOrphans) {
    for (const id of ids) {
      const hasDeps = (tasks[id].deps ?? []).length > 0
      const isDepended = referenced.has(id)
      if (!hasDeps && !isDepended) {
        errors.push({ taskId: id, code: 'MT_VALIDATION', message: 'orphan task: neither depends on others nor is depended on' })
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

                                   
            
                
                      
                    
                                                                          
                        
                   
                                                        
                   
                         
 

                                 
                
                                                      
               
               
                  
                                       
                                           
                                                     
                                                   
                                                                                                                                             
                                           
                                                        
 

/** FR-11.5 调度判定（纯函数）：成员能否领取任务。
 * depsResolved：调用方计算的"deps 全 done"投影事实（backlog + deps 全 done = 可领，等价 ready） */
export function canClaim(
  task                ,
  member                                                        ,
  now        ,
  depsResolved = task.state === 'ready',
)                                            {
  const reasons           = []
  const ready = task.state === 'ready' || (task.state === 'backlog' && depsResolved)
  if (!ready) reasons.push(`task state is ${task.state}, not ready`)
  if (member.status !== 'active') reasons.push(`member is ${member.status}`)
  if (task.input.requiredRole !== member.roleId) reasons.push(`requiredRole ${task.input.requiredRole} != member role ${member.roleId}`)
  if (task.attemptId) reasons.push('task already has an active attempt')
  return { claimable: reasons.length === 0, reasons }
}

/** FR-11.5 调度排序（纯函数）：可领集合 → 优先级最高 + 同级 FIFO */
export function claimOrder(tasks                  )           {
  const rank                                                      = { P0: 0, P1: 1, P2: 2, P3: 3 }
  return [...tasks]
    .sort((a, b) => {
      const pa = rank[a.input.priority] - rank[b.input.priority]
      if (pa !== 0) return pa
      return (a.waitingSince ?? a.createdAt) - (b.waitingSince ?? b.createdAt)
    })
    .map((t) => t.id)
}

/**
 * CHG-73：下游传递闭包（取消任务的影响面 / 级联取消的候选集）。
 * roots 只作起点，不进入返回值；返回顺序按 BFS（近→远），调用方按需过滤终态任务
 * （终态依赖已关闭，不需要再取消，但仍要穿过它继续找更下游）。
 */
export function downstreamOf(proj                , roots          )           {
  const rootSet = new Set(roots)
  const out = new Set        ()
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.shift()          
    for (const task of Object.values(proj.tasks)) {
      if (out.has(task.id) || rootSet.has(task.id)) continue
      if (!(task.input.deps ?? []).includes(current)) continue
      out.add(task.id)
      queue.push(task.id)
    }
  }
  return [...out]
}

/** 空事件 → 空投影（T3 fold 的入口约定；事件逐型折叠在 T7 工具实现时扩展） */
export function emptyProjection(teamId        )                 {
  return {
    teamId,
    state: 'draft',
    revision: 0,
    tasks: {},
    members: {},
    participations: {},
    proposals: {},
    perTaskMessages: {},
    inbox: [],
  }
}


//# sourceURL=./src/core/scheduler/state.ts