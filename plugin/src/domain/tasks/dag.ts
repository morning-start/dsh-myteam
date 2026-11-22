/**
 * 项目任务 DAG（纯图算法）。
 *
 * 依赖边归**下游任务**所有：`task.dependencies` 表示「这个任务在等谁」，因此
 * 增删依赖只需改下游任务一条事件，不需要上游团队双写。跨团队依赖与团队内
 * 依赖在这种表示下没有区别——这正是「一个项目一张图」的意义。
 *
 * 所有函数都是纯函数：输入图与变更，输出新图或环路径。没有 id 生成、没有
 * 存储、没有时间。应用层负责把结果写进原子批次。
 */

export interface DependencyGraph {
  /** taskId → 它依赖的 taskId 列表。 */
  readonly edges: ReadonlyMap<string, readonly string[]>
}

export function emptyGraph(): DependencyGraph {
  return { edges: new Map() }
}

export function graphOf(entries: Iterable<readonly [string, readonly string[]]>): DependencyGraph {
  const edges = new Map<string, readonly string[]>()
  for (const [id, dependencies] of entries) {
    edges.set(id, dedupe(dependencies))
  }
  return { edges }
}

export function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

/** 图里的全部节点（即使没有出边，只要作为某个任务的依赖出现也算）。 */
export function allNodes(graph: DependencyGraph): Set<string> {
  const nodes = new Set<string>(graph.edges.keys())
  for (const dependencies of graph.edges.values()) {
    for (const dependency of dependencies) nodes.add(dependency)
  }
  return nodes
}

/** 引用完整性：返回引用了不存在任务的边。 */
export function missingEdges(graph: DependencyGraph): { taskId: string; missing: string[] }[] {
  const result: { taskId: string; missing: string[] }[] = []
  for (const [taskId, dependencies] of graph.edges) {
    const missing = dependencies.filter((dependency) => !graph.edges.has(dependency))
    if (missing.length > 0) result.push({ taskId, missing })
  }
  return result
}

/**
 * 找环。返回环上的节点序列（首尾相同），没有环返回 null。
 *
 * 用迭代 DFS 而不是递归：项目任务图可以长到几百个节点，递归深度取决于最长
 * 依赖链，而依赖链恰恰是最容易被人为拉长的地方。
 */
export function findCycle(graph: DependencyGraph): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const nodes = [...allNodes(graph)].sort()

  for (const start of nodes) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue

    const path: string[] = []
    const stack: { id: string; index: number }[] = [{ id: start, index: 0 }]
    color.set(start, GRAY)
    path.push(start)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const dependencies = graph.edges.get(frame.id) ?? []
      if (frame.index < dependencies.length) {
        const next = dependencies[frame.index]!
        frame.index += 1
        const state = color.get(next) ?? WHITE
        if (state === GRAY) {
          const cycleStart = path.indexOf(next)
          return path.slice(cycleStart).concat(next)
        }
        if (state === WHITE && graph.edges.has(next)) {
          color.set(next, GRAY)
          path.push(next)
          stack.push({ id: next, index: 0 })
        } else if (state === WHITE) {
          // 引用不存在的节点：不在本图里，交给 missingEdges 报告，不在这里造环。
          color.set(next, BLACK)
        }
        continue
      }
      color.set(frame.id, BLACK)
      path.pop()
      stack.pop()
    }
  }

  return null
}

/**
 * 试算「把 taskId 的依赖改成 dependencies」是否会成环。
 *
 * 返回环路径而不是布尔值：拒绝操作时必须能告诉用户「你这条边接在了
 * t1 → t2 → t3 → t1 上」，否则只会看到一句「不能这么做」。
 */
export function cycleIfEdgesChanged(graph: DependencyGraph, taskId: string, dependencies: readonly string[]): string[] | null {
  const provisional = new Map<string, readonly string[]>(graph.edges)
  provisional.set(taskId, dedupe(dependencies))
  return findCycle({ edges: provisional })
}

/** 拓扑序（依赖在前）。图有环时抛错——调用方应先校验，不应靠异常兜底。 */
export function topologicalOrder(graph: DependencyGraph): string[] {
  const cycle = findCycle(graph)
  if (cycle !== null) {
    throw new Error(`任务图存在环：${cycle.join(' → ')}`)
  }
  const visited = new Set<string>()
  const result: string[] = []

  for (const id of [...allNodes(graph)].sort()) {
    if (visited.has(id)) continue
    const stack: { id: string; index: number }[] = [{ id, index: 0 }]
    visited.add(id)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const dependencies = graph.edges.get(frame.id) ?? []
      if (frame.index < dependencies.length) {
        const next = dependencies[frame.index]!
        frame.index += 1
        if (!visited.has(next)) {
          visited.add(next)
          stack.push({ id: next, index: 0 })
        }
        continue
      }
      result.push(frame.id)
      stack.pop()
    }
  }
  return result
}

/** 直接依赖图上的「谁依赖我」（反向边）。 */
export function directDependents(graph: DependencyGraph): Map<string, string[]> {
  const dependents = new Map<string, string[]>()
  for (const [taskId, dependencies] of graph.edges) {
    for (const dependency of dependencies) {
      const list = dependents.get(dependency) ?? []
      list.push(taskId)
      dependents.set(dependency, list)
    }
  }
  return dependents
}

/** 传递闭包上的下游任务（不含自己）。 */
export function transitiveDependents(graph: DependencyGraph, taskId: string): Set<string> {
  const dependents = directDependents(graph)
  const result = new Set<string>()
  const queue = [...(dependents.get(taskId) ?? [])]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (result.has(current)) continue
    result.add(current)
    queue.push(...(dependents.get(current) ?? []))
  }
  return result
}

/**
 * 就绪判定：依赖全部处于终态成功（done），且任务自身还没开始（planned/ready）。
 *
 * `cancelled` 不解除下游——被取消的上游意味着下游失去输入，应该由人重新
 * 决定（改依赖或一并取消），而不是让它「莫名其妙就能做了」。
 */
export function readyTaskIds(graph: DependencyGraph, statusOf: (taskId: string) => string | undefined): string[] {
  const result: string[] = []
  for (const [taskId, dependencies] of graph.edges) {
    const own = statusOf(taskId)
    if (own !== 'planned' && own !== 'ready') continue
    const ready = dependencies.every((dependency) => statusOf(dependency) === 'done')
    if (ready) result.push(taskId)
  }
  return result.sort()
}

/** 阻塞原因：返回尚未完成的上游任务列表。 */
export function blockingDependencies(graph: DependencyGraph, taskId: string, statusOf: (id: string) => string | undefined): string[] {
  const dependencies = graph.edges.get(taskId) ?? []
  return dependencies.filter((dependency) => statusOf(dependency) !== 'done')
}