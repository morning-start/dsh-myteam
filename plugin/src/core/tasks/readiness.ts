/**
 * CHG-72（FR-30）：任务「为什么没人领」诊断——纯函数，只读投影。
 *
 * 用户看到一张没动的任务卡时，真正想知道的是三件事：
 *   1. 上游没做完（deps-pending）——不是没人，是还不能开始；
 *   2. 名册里没有这个角色（no-role）——派人去也领不了，得先加队员/换角色；
 *   3. 这个角色的人都在忙（role-busy）——等他们手上的任务收口。
 *   另外团队不在 active（draft/archived/discarded）时一切都不该动（team-inactive）。
 *
 * 纪律：不猜测、不用启发式权重；全部来自投影事实（任务状态 / 名册 / 依赖）。
 * 与 claimableTasks 同源（deps 全 done + 角色匹配 + 无活跃 attempt），但方向相反：
 * 它回答「谁能领」，这里回答「谁都不能领，为什么」。
 */
import { TERMINAL_STATES, type TeamProjection, type TaskProjection } from '../scheduler/state.ts'

export type TaskDiagnosisCode = 'team-inactive' | 'deps-pending' | 'dep-cancelled' | 'no-role' | 'role-busy'

/**
 * CHG-76：诊断给出的「一键修复」候选。
 *
 * 诊断只回答"为什么没人领"，人接下来要做的动作只有三种：
 *   1. 指派给同角色里当前空闲的人（assignable）；
 *   2. 改成另一个"名册里有人且有人空闲"的角色（roleSwap）；
 *   3. 这个角色名册里一个能干的都没有 → 召唤（spawnRole）。
 * 服务端只给候选事实，不改任务；是否执行由面板/人点。
 */
export interface TaskFix {
  /** 同角色当前空闲（无 currentTaskId）的队员：有就先指派 */
  assignable?: { memberId: string; instanceName: string }[]
  /** 名册里其它角色中有人空闲的（roleId + 该角色空闲实例名），按空闲数降序 */
  roleSwap?: { roleId: string; idleMembers: string[] }[]
  /** 建议召唤的角色（no-role 时 = requiredRole；role-busy 时 = 同角色增援） */
  spawnRole?: string
  /**
   * CHG-202x（P1-9）：**解除对「已取消上游」的依赖**——一键出口。
   *
   * 修复前：`dep-cancelled` 只报诊断、不给动作（`fixable` 里也没有它），而三处判定都要求上游
   * `state === 'done'` → 下游**永远不可领**，只能靠人自己去改依赖（面板还没有那个入口）。
   * `removed` = 要摘掉的已取消上游；`remaining` = 摘完之后的 deps（直接作为 rescope 补丁）。
   */
  depCancelled?: { removed: string[]; remaining: string[] }
}

/** 单个任务的诊断结果（codes 为空时不返回对象；UI 只在有诊断时展示） */
export interface TaskDiagnosis {
  codes: TaskDiagnosisCode[]
  /** 任务要求的角色（诊断始终围绕它展开） */
  roleId: string
  /** 该角色在册（active）队员数 */
  roleMembers: number
  /** 尚未 done 的依赖（含账本中不存在的依赖 id——配置错误也要显性化） */
  depsPending?: string[]
  /** CHG-73：上游已被取消的依赖（永远等不到 done，必须重新编排或取消本任务） */
  depsCancelled?: string[]
  /** 该角色正在执行其他任务的队员实例名 */
  busyMembers?: string[]
  /** CHG-76：可以怎么修（与 codes 同时给出，UI 直接渲染动作） */
  fix?: TaskFix
}

/** 已经「有人/有事在推进」的状态不诊断：done/failed/cancelled/in_progress/re-scoping/gate:* */
function moving(state: TaskProjection['state']): boolean {
  return TERMINAL_STATES.has(state) || state === 'in_progress' || state === 're-scoping' || state.startsWith('gate:')
}

/**
 * 任务的「无人可领」诊断。返回 undefined = 没有阻塞（可能正被 claim，或本来就该由人处理）。
 * 只看 backlog / ready：blocked / failed 是已有出口的人为状态，不需要再解释。
 */
/* ── CHG-210 批 5.4：停滞判定 ── */

/** 停滞阈值：超过这么久没有任何进展信号，就认为「卡住了」。 */
export const DEFAULT_STALL_MS = 30 * 60 * 1000

export interface StallInfo {
  /** 距最近一次进展多久（毫秒） */
  stalledFor: number
  /** 参照时刻（来自投影里的事件时间戳，不是 now） */
  since: number
  /** 参照的是哪个信号，便于面板说清「30 分钟没有进展」还是「等了 3 小时没人领」 */
  basedOn: 'lastProgressAt' | 'waitingSince' | 'createdAt'
}

/**
 * CHG-210 批 5.4：**这条任务卡住多久了**（纯函数，`now` 由调用方传入）。
 *
 * 为什么单独一个函数、不塞进 `diagnoseTask`：
 *   `diagnoseTask` 回答的是「为什么**没人领**」（只对 backlog/ready 有意义）；而停滞还包括
 *   「领了但不动」（in_progress 很久没有 progress / evidence / 裁决）。两件事的处置完全相反——
 *   前者要改配置或加人，后者要查执行者是不是挂了。混成一个码，面板只能显示一句「有问题」。
 *
 * 为什么 `now` 必须由调用方传：投影里只存事件时间戳。`Date.now()` 一旦进 fold，
 * 同一本账本两次重放就会得出不同结果（t124 的纪律）。
 *
 * 判据按状态取参照点：`in_progress`/`re-scoping` 看最近进展；`ready`/`backlog` 看等领取的时刻；
 * 门禁态与终态不判（它们本来就在等人，不是「停滞」）。
 */
export function stallOf(task: TaskProjection, now: number, thresholdMs = DEFAULT_STALL_MS): StallInfo | undefined {
  let since: number
  let basedOn: StallInfo['basedOn']
  if (task.state === 'in_progress' || task.state === 're-scoping') {
    if (task.lastProgressAt !== undefined) {
      since = task.lastProgressAt
      basedOn = 'lastProgressAt'
    } else if (task.lastEditAt !== undefined) {
      since = task.lastEditAt
      basedOn = 'lastProgressAt'
    } else {
      since = task.createdAt
      basedOn = 'createdAt'
    }
  } else if (task.state === 'ready' || task.state === 'backlog') {
    if (task.waitingSince !== undefined) {
      since = task.waitingSince
      basedOn = 'waitingSince'
    } else {
      since = task.createdAt
      basedOn = 'createdAt'
    }
  } else {
    return undefined
  }
  const stalledFor = now - since
  return stalledFor >= thresholdMs ? { stalledFor, since, basedOn } : undefined
}

export function diagnoseTask(proj: TeamProjection, taskId: string): TaskDiagnosis | undefined {
  const task = proj.tasks[taskId]
  if (!task) return undefined
  if (moving(task.state)) return undefined
  if (task.state !== 'backlog' && task.state !== 'ready') return undefined

  const roleId = task.input.requiredRole
  const active = Object.values(proj.members).filter((member) => member.roleId === roleId && member.status === 'active')
  // 团队不在 active：其它原因都是它的后果（草稿团队本来就没有队员/任务也不该动），
  // 只报「团队未运行」，避免一张卡上堆三条互相推导出来的原因。
  if (proj.state !== 'active') {
    return { codes: ['team-inactive'], roleId, roleMembers: active.length }
  }
  const depsPending = (task.input.deps ?? []).filter((dep) => {
    const state = proj.tasks[dep]?.state
    return state !== 'done' && state !== 'cancelled'
  })
  // 上游被取消 = 这个任务永远等不到依赖完成：不是"再等等"，而是"要重新编排"（CHG-73）
  const depsCancelled = (task.input.deps ?? []).filter((dep) => proj.tasks[dep]?.state === 'cancelled')
  const busy = active.filter((member) => Boolean(member.currentTaskId))
  const codes: TaskDiagnosisCode[] = []
  if (depsPending.length > 0) codes.push('deps-pending')
  if (depsCancelled.length > 0) codes.push('dep-cancelled')
  if (active.length === 0) codes.push('no-role')
  else if (busy.length === active.length) codes.push('role-busy')
  if (codes.length === 0) return undefined
  // CHG-76：把"接下来能做什么"一并给出——只陈述投影事实（谁空闲、谁在册），不替人做决定。
  // team-inactive 不给（团队没跑，做什么都没用）；dep-cancelled 的出口是重新规划/改挂，不在这里。
  const fixable = codes.includes('no-role') || codes.includes('role-busy') || codes.includes('deps-pending') || codes.includes('dep-cancelled')
  /* CHG-202x（P1-9）：dep-cancelled 的出口 = 摘掉已取消上游（其余修复候选照旧并列，互不排斥） */
  const baseFix = fixable ? buildFix(proj, roleId) : undefined
  const fix = fixable
    ? {
      ...(baseFix ?? {}),
      ...(depsCancelled.length > 0
        ? { depCancelled: { removed: depsCancelled, remaining: (task.input.deps ?? []).filter((dep) => !depsCancelled.includes(dep)) } }
        : {}),
    }
    : undefined
  return {
    codes,
    roleId,
    roleMembers: active.length,
    ...(depsPending.length > 0 ? { depsPending } : {}),
    ...(depsCancelled.length > 0 ? { depsCancelled } : {}),
    ...(busy.length > 0 ? { busyMembers: busy.map((member) => member.instanceName) } : {}),
    ...(fix ? { fix } : {}),
  }
}

/** CHG-76：修复候选（纯投影推导；同角色空闲 → 指派，其它角色空闲 → 换角色，都没有 → 召唤） */
function buildFix(proj: TeamProjection, roleId: string): TaskFix | undefined {
  const members = Object.values(proj.members).filter((member) => member.status === 'active')
  const sameRole = members.filter((member) => member.roleId === roleId)
  const idleSame = sameRole.filter((member) => !member.currentTaskId)
  const byRole = new Map<string, string[]>()
  for (const member of members) {
    if (member.roleId === roleId || member.currentTaskId) continue
    const list = byRole.get(member.roleId) ?? []
    list.push(member.instanceName)
    byRole.set(member.roleId, list)
  }
  const roleSwap = [...byRole.entries()]
    .map(([id, idleMembers]) => ({ roleId: id, idleMembers: [...idleMembers].sort() }))
    .sort((a, b) => (b.idleMembers.length - a.idleMembers.length) || a.roleId.localeCompare(b.roleId))
  const fix: TaskFix = {}
  if (idleSame.length > 0) {
    fix.assignable = idleSame.map((member) => ({ memberId: member.id, instanceName: member.instanceName })).sort((a, b) => a.instanceName.localeCompare(b.instanceName))
  }
  if (roleSwap.length > 0) fix.roleSwap = roleSwap
  if (sameRole.length === 0 || idleSame.length === 0) fix.spawnRole = roleId
  return Object.keys(fix).length > 0 ? fix : undefined
}
