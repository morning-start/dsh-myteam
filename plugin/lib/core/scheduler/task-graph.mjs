/**
 * CHG-124（docs/19 §M6）：任务依赖图谱**纯函数**（Kahn 分层 + 环检测）。
 *
 * 为什么单独成模块：宿主 `getTaskGraphTool` 只是「取投影 → 调这里」；
 * 分层/环检测的正确性必须能**不建团队**就单测（否则要造带 deps 的计划，
 * 而计划任务的 id 是生成出来的、deps 无法预先引用）。
 *
 * 口径：
 *  - 边 `from` = 前置（被依赖），`to` = 后继（依赖它的）——与 `deps` 语义一致；
 *  - `layers` = 拓扑层级（同层可并行），**只含无环部分**；
 *  - `cycles` = Kahn 排不掉的节点（有环即非空），`hasCycle` 为真时 `layers` 不完整；
 *  - 孤儿依赖（两端不齐）与自依赖**跳过**（写路径已拒；这里容错，不让读视图崩）。
 */

                                     
            
                
                
                   
                       
                 
 

                                
            
               
               
                  
                      
 

                            
                        
                                       
                    
                 
                  
                   
 

export function buildTaskGraph(tasks                               )            {
  const ids = new Set(tasks.map((task) => String(task.id)))
  const nodes                  = tasks.map((task) => ({
    id: String(task.id),
    title: String(task.title ?? ''),
    state: String(task.state ?? ''),
    priority: String(task.priority ?? ''),
    requiredRole: String(task.requiredRole ?? ''),
  }))
  const edges                                 = []
  const adjacency = new Map                  ()
  const indegree = new Map                ()
  for (const id of ids) {
    adjacency.set(id, [])
    indegree.set(id, 0)
  }
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      const from = String(dep)
      const to = String(task.id)
      if (!ids.has(from) || from === to) continue
      edges.push({ from, to })
      adjacency.get(from) .push(to)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }
  const layers             = []
  const order           = []
  const remaining = new Map(indegree)
  let frontier = [...ids].filter((id) => (remaining.get(id) ?? 0) === 0).sort()
  while (frontier.length > 0) {
    layers.push([...frontier])
    order.push(...frontier)
    const next           = []
    for (const id of frontier) {
      for (const to of adjacency.get(id) ?? []) {
        const left = (remaining.get(to) ?? 0) - 1
        remaining.set(to, left)
        if (left === 0) next.push(to)
      }
    }
    frontier = [...new Set(next)].sort()
  }
  const cycles = [...ids].filter((id) => !order.includes(id)).sort()
  return { nodes, edges, layers, order, cycles, hasCycle: cycles.length > 0 }
}


//# sourceURL=./src/core/scheduler/task-graph.ts