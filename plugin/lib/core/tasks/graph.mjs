/**
 * CHG-69（FR-22）：任务依赖图的纯函数层——层级（最长路径）与边集。
 *
 * 依赖图必须有箭头（上游 → 下游），并支持横向/竖向两种布局：
 *   - 横向：按依赖层级分列（level = 0 最左）
 *   - 竖向：按依赖层级分行（level = 0 最上）
 * 两个布局共用同一份 levels/edges，渲染差异只在客户端。
 *
 * 纪律：纯函数、无 IO；环不抛错（环上的节点按已算出的部分层级处理，最长路径截断），
 * 图只是视图，合法性由任务写入端的 validatePlan 保证（DAG 无环）。
 */

                                 
            
                
 

                            
                              
                                
                                        
                                       
                             
                 
                                   
                  
 

/**
 * 计算依赖层级与边集。
 * level(t) = 0（无 deps）或 1 + max(level(dep))；deps 引用不存在的任务时忽略该引用。
 */
export function buildTaskGraph(tasks                  )            {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const levels                         = {}
  const visiting = new Set        ()
  const stack           = []
  const cyclic           = []

  const visit = (id        )         => {
    if (Object.prototype.hasOwnProperty.call(levels, id)) return levels[id]
    if (visiting.has(id)) {
      // 环：把闭环上的节点全部记下（截断为 0 计，避免死循环）
      const start = stack.indexOf(id)
      for (const node of start >= 0 ? stack.slice(start) : [id]) {
        if (!cyclic.includes(node)) cyclic.push(node)
      }
      return 0
    }
    const task = byId.get(id)
    if (!task) return 0
    visiting.add(id)
    stack.push(id)
    const deps = (task.deps ?? []).filter((dep) => dep !== id && byId.has(dep))
    const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => visit(dep)))
    stack.pop()
    visiting.delete(id)
    levels[id] = level
    return level
  }

  for (const task of tasks) visit(task.id)

  const edges                                 = []
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (dep !== task.id && byId.has(dep)) edges.push({ from: dep, to: task.id })
    }
  }
  const roots = tasks.filter((t) => (t.deps ?? []).filter((dep) => byId.has(dep)).length === 0).map((t) => t.id)
  return { levels, edges, roots, cyclic }
}

/** 依赖链闭包（CHG-63 面板高亮用）：从 focus 向上收集依赖、向下收集解锁方 */
export function dependencyChain(tasks                  , focus        )                                               {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const upstream = new Set        ()
  const walkUp = (id        )       => {
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep) || upstream.has(dep)) continue
      upstream.add(dep)
      walkUp(dep)
    }
  }
  walkUp(focus)
  const downstream = new Set        ()
  const walkDown = (id        )       => {
    for (const task of tasks) {
      if (!(task.deps ?? []).includes(id) || downstream.has(task.id)) continue
      downstream.add(task.id)
      walkDown(task.id)
    }
  }
  walkDown(focus)
  upstream.delete(focus)
  downstream.delete(focus)
  return { upstream: [...upstream], downstream: [...downstream] }
}


//# sourceURL=./src/core/tasks/graph.ts