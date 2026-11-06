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

export type TaskState =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 're-scoping'
  | 'gate:review'
  | 'gate:verify'
  | 'gate:archive'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['done', 'failed', 'cancelled'])

/**
 * CHG-86（FR-5.2 打回预算）：单个门禁允许的打回轮数上限。
 * 超限后队长工具不能再放行（`MT_REJECT_BUDGET` → needs-human），只有人工（面板 confirm）能放行。
 * 依据：TF r9 实测一次 full run 61% 的模型调用花在打回闭环上——预算必须是硬上限，不是提示。
 */
export const GATE_REJECT_BUDGET = 2

export interface TaskInput {
  title: string
  description: string
  acceptanceCriteria: string[]
  deliverableSpec?: { path: string; producer?: string; reviewer?: string; archiver?: string }
  deps: string[]
  requiredRole: string
  taskType?: string
  gateChain?: string[]
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  estimate?: 'S' | 'M' | 'L'
  /** v2.7（M2-0c，FR-17.2）：主题标签，任务 done 时与知识库条目 tags 求交集 → staleness 触达 */
  tags?: string[]
  /**
   * CHG-87（FR-5.4）：任务声明的**可写范围**（路径前缀 / 通配）。
   * 完成时对照证据块申报的 `filesTouched` 审计越界——**审计而非写拦截**
   * （诚实声明不拦截 bash；越界只留痕不阻断交付）。空/缺省 = 不审计。
   */
  writeScopes?: string[]
  /**
   * CHG-87（FR-5.3）：`verify` 门由 host 执行的命令（真实退出码定裁决）。
   * 无 shell 解释（argv 数组直传）；verify 门存在但缺此项 → `MT_VERIFY_NO_COMMAND`。
   */
  verifyCommand?: { argv: string[]; cwd?: string; timeoutMs?: number }
}

export interface TaskProjection {
  id: string
  input: TaskInput
  state: TaskState
  attemptId?: string
  assignee?: string
  /** CHG-69（FR-21）：多队员负责（主负责 + 协作）；assignee = 当前 claim 的执行者，两者可不同 */
  assignees?: string[]
  escalateCount: number
  gates: string[]
  gateVerdicts: Record<string, 'pass' | 'fail'>
  /**
   * CHG-86（FR-5.2 打回预算）：各门禁的 fail 裁决轮数。
   * 复验预算 ≤2 轮；超限后 pass 只能由人工（面板 confirm）放行——
   * 这是"打回闭环成本"（TF r9 实测 61% 调用）的硬上限，不是提示。
   */
  gateRejects?: Record<string, number>
  evidenceRefs: number[]      // 账本 seq 引用
  deliverables: { path: string; seq: number }[]
  createdAt: number
  waitingSince?: number       // ready 起始时刻（FIFO 用）
  /* ── CHG-73：执行期编辑闭环的投影事实 ── */
  /** 最近一次元数据编辑/重新规划的时刻（详情页"改动记录"与证据过期判定共用） */
  lastEditAt?: number
  /** 被重新规划的次数（rescope 会计数，面板显示"第 N 次重规划"） */
  rescopeCount?: number
  /** 证据过期：最近一次结构编辑（AC/交付物/依赖/角色/门禁链）晚于最近一次证据提交 */
  evidenceStale?: { since: number; fields: string[] }
  /** 取消留痕（终态；reason 必填，downstream 表示当时选的下游策略） */
  cancelledAt?: number
  cancelReason?: string
  cancelDownstream?: 'leave' | 'cancel' | 'rewire'
  /**
   * CHG-75：最近一次被改挂的记录（下游换了上游）。
   * removed = 被换掉的依赖 id；added 缺省 = 解除依赖（该任务变独立任务）。
   */
  rewiredFrom?: { removed: string; added?: string; ts: number }
  /**
   * CHG-87（FR-5.4）：最近一次 scope 完成审计结果。
   * 有 writeScopes 的任务在完成/门禁时对账证据块申报的文件；越界清单在这里留痕
   * （看板徽标 + 详情「写入范围审计」块）。**不阻断交付**——阻断只会 incentive 少报。
   */
  scopeAudit?: {
    declared: string[]
    writeScopes: string[]
    outOfScope: string[]
    ok: boolean
    checkedAt: number
  }
}

/** 任务 × 团队参与边（CHG-69，FR-21；关系不是实体：主责 1 / 协作 N） */
export interface Participation {
  teamId: string
  role: 'lead' | 'coop'
  /** 该团队为此任务派出的队员（实例名或 memberId；空 = 未指定） */
  memberIds: string[]
  /** 落账 seq（审计可追溯） */
  seq: number
  ts: number
}

/** 单任务的参与集合（leadTeamId = 主责团队；teams 含主责与全部协作） */
export interface TaskParticipation {
  leadTeamId?: string
  teams: Record<string, Participation>
}

/** 状态机合法转移表（拒绝式校验的数据源）。
 * gate 链按 config 驱动（FR-10.3 通用性）：任意 gate:xxx 的合法后继 = gate 链的下一项或 done。
 * 静态表只列固定骨架；gate 间转移由 fold 按 t.gates 动态判定（见 fold.ts gateAdvance）。 */
export const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
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

export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to)
}

/** gate 链推进（fold 专用）：from gate pass 后按该任务 gateChain 的实际下一站判定 */
export function gateAdvance(currentGate: string, gates: string[]): TaskState {
  const idx = gates.indexOf(currentGate)
  if (idx < 0) return 'done'
  const next = gates[idx + 1]
  return next ? ((`gate:${next}` as TaskState)) : 'done'
}

/** FR-11.2 host 硬校验（拒绝式，七项）。
 *  CHG-72：allowOrphans —— 计划提交（draft）仍强制「无孤儿」；团队已 active 后单独补一条
 *  独立任务（面板/队长 create_task）是正常操作，不再要求它必须挂在既有 DAG 上。 */
export interface PlanValidation {
  ok: boolean
  errors: { taskId: string; code: string; message: string }[]
}

export function validatePlan(tasks: Record<string, TaskInput>, maxTasks: number, rosterRoles: string[], opts: { allowOrphans?: boolean } = {}): PlanValidation {
  const errors: PlanValidation['errors'] = []
  const ids = Object.keys(tasks)
  if (ids.length === 0) {
    // 空计划合法（CHG-16：暂存计划允许先出名册后补任务，逐个 create_task 入库）
    return { ok: true, errors: [] }
  }
  if (ids.length > maxTasks) {
    errors.push({ taskId: '-', code: 'MT_VALIDATION', message: `task count ${ids.length} exceeds limit ${maxTasks}` })
  }
  const referenced = new Set<string>()
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
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const id of ids) {
    for (const dep of tasks[id].deps ?? []) {
      if (indegree.has(dep)) {
        indegree.set(id, (indegree.get(id) ?? 0) + 1)
        dependents.get(dep)!.push(id)
      }
    }
  }
  const queue = ids.filter((id) => indegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()!
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

export interface MemberProjection {
  id: string
  roleId: string
  instanceName: string
  sessionId?: string
  status: 'active' | 'suspended' | 'archived' | 'removed' | 'spawn_failed'
  currentTaskId?: string
  spawnedAt: number
  /** CHG-54：成员级技能/MCP 覆写（来自 member.spawned；空 = 继承角色） */
  skills?: string[]
  mcpAllowlist?: string[]
}

export interface TeamProjection {
  teamId: string
  state: 'draft' | 'active' | 'archived' | 'discarded'
  name?: string
  goal?: string
  revision: number
  tasks: Record<string, TaskProjection>
  members: Record<string, MemberProjection>
  /** CHG-69：任务参与关系（任务 × 团队多对多边；本团队账本记录自己主责/协作的任务） */
  participations: Record<string, TaskParticipation>
  proposals: Record<string, { taskId: string; type: string; payload: Record<string, unknown>; status: 'proposed' | 'approved' | 'rejected' }>
  perTaskMessages: Record<string, number[]>
  inbox: { seq: number; kind: string; read?: boolean }[]
}

/** FR-11.5 调度判定（纯函数）：成员能否领取任务。
 * depsResolved：调用方计算的"deps 全 done"投影事实（backlog + deps 全 done = 可领，等价 ready） */
export function canClaim(
  task: TaskProjection,
  member: { roleId: string; status: MemberProjection['status'] },
  now: number,
  depsResolved = task.state === 'ready',
): { claimable: boolean; reasons: string[] } {
  const reasons: string[] = []
  const ready = task.state === 'ready' || (task.state === 'backlog' && depsResolved)
  if (!ready) reasons.push(`task state is ${task.state}, not ready`)
  if (member.status !== 'active') reasons.push(`member is ${member.status}`)
  if (task.input.requiredRole !== member.roleId) reasons.push(`requiredRole ${task.input.requiredRole} != member role ${member.roleId}`)
  if (task.attemptId) reasons.push('task already has an active attempt')
  return { claimable: reasons.length === 0, reasons }
}

/** FR-11.5 调度排序（纯函数）：可领集合 → 优先级最高 + 同级 FIFO */
export function claimOrder(tasks: TaskProjection[]): string[] {
  const rank: Record<TaskProjection['input']['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
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
export function downstreamOf(proj: TeamProjection, roots: string[]): string[] {
  const rootSet = new Set(roots)
  const out = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.shift() as string
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
export function emptyProjection(teamId: string): TeamProjection {
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
