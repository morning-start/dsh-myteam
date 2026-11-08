/**
 * CHG-154（docs/21 §6 P2-3）：按 `writeScopes` 自动算并发波次（**纯函数**）。
 *
 * 为什么需要（问题本身）：
 *   现在「谁能改哪批文件」只靠成员 `claim` 抢占。抢占解决的是「同一任务被两个人领」，
 *   解决不了「两个不同任务的写范围有交集」——它们仍会被同时派出去改同一批文件，
 *   最后写入者赢，前一个成员的改动被静默覆盖。共享同一批文件的任务本可以合并串行，
 *   目前只能靠人肉协调。
 *
 * 为什么是纯函数（J1）：
 *   波次正确性 = 拓扑序 + 同波两两不重叠 + 确定性。这三条必须能**不建团队、不落盘**
 *   就单测；一旦掺 IO，就得造完整账本 + 事件流才能复现一个环，测试成本高到没人写。
 *
 * 口径（与 `gates/scope-audit.ts` 的 `normalizeScopePath` / `matchesScope` 一致，
 * 这里 import 而不是抄一份——两套路径语义漂移是「串行化了但审计说越界」这类事故的源头）：
 *   - 先归一化：反斜杠 → `/`，去掉 `./` 前缀；
 *   - 无通配的 scope 按「目录」理解：`src` 覆盖 `src/a.ts`，`src/` 同义；
 *   - `*` 单段通配，`**` 跨段通配；单独写 `**`（或所有段都是 `**`）视为重叠一切；
 *   - 空数组 = 未声明写范围 = 与任何任务都不冲突（与 scope 审计「未声明不审计」同源）。
 *
 * 保守方向（重要，别当 bug 改）：
 *   任意 glob 之间的重叠是**不可精确判定**的。本模块只在能证明「段级字面不相容」时
 *   才判不重叠（例如 `src/*.ts` 与 `src/*.js` 的末段字面后缀不同 → 必不相交）；
 *   证不出来就当作重叠——多串行一次只是慢，漏判是两个成员同时写同一个文件。
 */

import type { MtCode } from '../errors.ts'
import { normalizeScopePath } from '../gates/scope-audit.ts'

/* ── 错误码 ─────────────────────────────────────────────────────────── */

/**
 * 本模块产出的错误码。
 *
 * 为什么要 `MtCode` 注解而不是 `as const`：`core/errors.ts` 是全项目错误码的唯一
 * 来源，`t81` 会扫 `src/**` 的每个 `MT_` 字面量并要求「登记在错误码清单里」。
 * 这里**不新增码**、只复用既有语义——环用 `MT_TASK_CYCLE`（errors.ts 的说明就写着
 * 「依赖成环（含自指…）」），入参不合法用跨域通用的 `MT_VALIDATION`。
 * 注解成 `MtCode` 让「写了个不存在的码」在编译期就红，不用等门禁。
 */
export const WAVE_CODES: { readonly TASK_CYCLE: MtCode; readonly TASK_INVALID: MtCode; readonly TASK_IN_FLIGHT: MtCode } = {
  /** 任务依赖成环：波次无法给出，必须先断环 */
  TASK_CYCLE: 'MT_TASK_CYCLE',
  /** 同一个 taskId 出现两次：入参不合法，无法为它给出两个波次位置 */
  TASK_INVALID: 'MT_VALIDATION',
  /**
   * 领取前的写范围闸门命中：与正在执行的任务写范围重叠（CHG-159 / 报告 A6）。
   * 语义 = 既有 `MT_NOT_CLAIMABLE`（「此刻不能领」），**不新增码**——新增码要重生成 `docs/04`
   * 并改 `t81` 对账断言，而这里没有新的失败语义可表达。
   */
  TASK_IN_FLIGHT: 'MT_NOT_CLAIMABLE',
}

export type WaveCode = (typeof WAVE_CODES)[keyof typeof WAVE_CODES]

/** 环码的直取别名（测试与工具结果都直接断言这个字符串） */
export const MT_TASK_CYCLE = WAVE_CODES.TASK_CYCLE

/** 「重叠一切」的通配段：所有段都是 `**` */
export const WAVE_ANY = '**'

/* ── 输入 / 输出 ─────────────────────────────────────────────────────── */

/** 算波次需要的最小任务面（只要这三个字段，避免耦合 TaskRecord 全量） */
export interface WaveTaskInput {
  taskId: string
  /** 前置任务（被依赖方）：它必须先于本任务，因此波次严格更小 */
  deps?: readonly string[]
  /** 本任务允许写的路径范围；空/缺省 = 未声明 = 不与任何任务冲突 */
  writeScopes?: readonly string[]
}

/** 一条被忽略的依赖（跨团队 / 拼错 / 自依赖）：写路径已拒，这里容错不阻断 */
export interface SkippedWaveDep {
  taskId: string
  dep: string
}

export interface WavePlanOk {
  ok: true
  /** 波次（下标 = 波次序号）。同波内两两 writeScopes 不重叠，且已按 taskId 稳定排序 */
  waves: string[][]
  /** 波次展平后的线性序（依赖一定出现在被依赖方之前） */
  order: string[]
  skippedDeps: SkippedWaveDep[]
}

export interface WavePlanFail {
  ok: false
  code: WaveCode
  /** 中文可读；面板/日志直接显示，所以要能让人知道「怎么改」 */
  reason: string
  /** 参与环的 taskId（字典序），便于看板点名 */
  cycles: string[]
  waves: string[][]
  order: string[]
  skippedDeps: SkippedWaveDep[]
}

export type WavePlan = WavePlanOk | WavePlanFail

/* ── 写范围重叠判定 ─────────────────────────────────────────────────── */

/**
 * 两组写范围是否可能写到同一个路径。
 *
 * 语义：只要**存在**一个路径同时落在 a 的某个 scope 和 b 的某个 scope 里，就算重叠。
 * 任一侧为空数组（未声明）→ 不重叠（无冲突），这样老任务不需要补 writeScopes。
 *
 * @example
 *   scopesOverlap(['src/a.ts'], ['src/'])        // true  —— 目录覆盖其下文件
 *   scopesOverlap(['src/a.ts'], ['src/a.ts'])    // true  —— 同一文件
 *   scopesOverlap(['src/a.ts'], ['src/b.ts'])    // false —— 同层不同文件
 *   scopesOverlap(['**'], ['lib/x.ts'])          // true  —— 通配一切
 *   scopesOverlap([], ['src/'])                  // false —— 未声明
 */
export function scopesOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = normalizeScopeList(a)
  const right = normalizeScopeList(b)
  if (left.length === 0 || right.length === 0) return false
  for (const one of left) {
    for (const other of right) {
      if (scopePairOverlaps(one, other)) return true
    }
  }
  return false
}

/** 单个 scope 对：段级对齐，能证明不相容才判不重叠 */
function scopePairOverlaps(a: string, b: string): boolean {
  if (a === b) return true
  if (isAnyScope(a) || isAnyScope(b)) return true
  const left = segmentsOf(a)
  const right = segmentsOf(b)
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const one = left[index] ?? ''
    const other = right[index] ?? ''
    // `**` 跨段：位置之后的内容它都能盖住，继续比下去没有意义
    if (one === '**' || other === '**') return true
    if (segmentsDisjoint(one, other)) return false
  }
  // 段级全部相容：短的那个是「目录」，长的是它下面的路径（或两者本就同形）→ 重叠
  return true
}

/**
 * 两个**同位置**的段是否必不相交。
 *
 * 只有能证明时才返回 true：两边都是字面段且不等，或至少一边带通配但字面前缀/后缀
 * 已经对不上。判不出来返回 false（= 相容），让上层按「重叠」处理（保守方向）。
 */
function segmentsDisjoint(a: string, b: string): boolean {
  const aWild = a.includes('*')
  const bWild = b.includes('*')
  if (!aWild && !bWild) return a !== b
  const aPrefix = aWild ? a.slice(0, a.indexOf('*')) : a
  const bPrefix = bWild ? b.slice(0, b.indexOf('*')) : b
  if (!prefixCompatible(aPrefix, bPrefix)) return true
  const aSuffix = aWild ? a.slice(a.lastIndexOf('*') + 1) : a
  const bSuffix = bWild ? b.slice(b.lastIndexOf('*') + 1) : b
  return !suffixCompatible(aSuffix, bSuffix)
}

function prefixCompatible(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return true
  const shared = Math.min(a.length, b.length)
  return a.slice(0, shared) === b.slice(0, shared)
}

function suffixCompatible(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return true
  const shared = Math.min(a.length, b.length)
  return a.slice(a.length - shared) === b.slice(b.length - shared)
}

/** 整个 scope 就是「一切」（所有段都是 `**`，含带前导斜杠的写法） */
function isAnyScope(scope: string): boolean {
  const segments = segmentsOf(scope)
  return segments.length > 0 && segments.every((segment) => segment === WAVE_ANY)
}

function segmentsOf(scope: string): string[] {
  return scope.split('/').filter((segment) => segment.length > 0)
}

/** 归一化 + 去重（保序）；非数组/空串一律丢弃，等价于「未声明」 */
function normalizeScopeList(scopes: readonly string[] | undefined): string[] {
  if (!Array.isArray(scopes)) return []
  const out: string[] = []
  for (const scope of scopes) {
    const normalized = normalizeScopePath(String(scope ?? ''))
    if (normalized.length > 0 && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

/** 字典序比较：不用 localeCompare，避免不同 locale 下同输入算出不同波次 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/* ── 波次规划 ───────────────────────────────────────────────────────── */

/**
 * 按依赖 + 写范围算并发波次。
 *
 * 规则（三条一起才是「安全并行」）：
 *  1. **依赖先行**：任务的波次严格大于它的每个前置任务的波次；
 *  2. **同波不重叠**：同一波内任意两任务的 writeScopes 两两不重叠；
 *  3. **确定性**：同输入必得同输出，同波内按 taskId 字典序。
 *
 * 算法：先 Kahn 算出拓扑序（顺带判环），再按拓扑序**贪心落位**——从「依赖允许的
 * 最早波次」开始往后找第一个不冲突的波次。贪心是正确的：更早落位不会挤掉后面的
 * 任务（后续任务只会往后挪），且每条约束都是「上界」形式。
 *
 * 成环不抛异常：仓库纯函数风格的约定是返回 `{ok:false}` 让调用方决定怎么呈现
 * （工具结果要中文文案，面板要画图，抛异常会把两边的错误处理都逼成 try/catch）。
 *
 * @param tasks 任务面（顺序无关；只读，不会被修改）
 * @returns 成功给 `waves`/`order`，成环给 `{ok:false, code:'MT_TASK_CYCLE'}`
 *
 * @example
 *   planDevWaves([
 *     { taskId: 'a', writeScopes: ['src/'] },
 *     { taskId: 'b', writeScopes: ['src/a.ts'] },   // 与 a 重叠 → 第 2 波
 *     { taskId: 'c', deps: ['a'], writeScopes: ['lib/'] }, // 依赖 a 但范围不冲突
 *   ])
 *   // → { ok: true, waves: [['a'], ['b', 'c']], order: ['a','b','c'] }
 */
export function planDevWaves(tasks: readonly WaveTaskInput[]): WavePlan {
  const ids: string[] = []
  const scopeOf = new Map<string, string[]>()
  const depsOf = new Map<string, string[]>()
  const seen = new Set<string>()

  for (const task of tasks ?? []) {
    const taskId = String(task?.taskId ?? '')
    if (seen.has(taskId)) {
      return {
        ok: false,
        code: WAVE_CODES.TASK_INVALID,
        reason: `任务 id 重复："${taskId}"；同一个任务无法同时落在两个波次里`,
        cycles: [],
        waves: [],
        order: [],
        skippedDeps: [],
      }
    }
    seen.add(taskId)
    ids.push(taskId)
    scopeOf.set(taskId, normalizeScopeList(task?.writeScopes))
    // 依赖去重（同一前置写两次不该让入度算成 2）
    const deps: string[] = []
    for (const dep of task?.deps ?? []) {
      const value = String(dep ?? '')
      if (!deps.includes(value)) deps.push(value)
    }
    depsOf.set(taskId, deps)
  }

  if (ids.length === 0) {
    return { ok: true, waves: [], order: [], skippedDeps: [] }
  }

  const known = new Set(ids)
  const after = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const id of ids) {
    after.set(id, [])
    indegree.set(id, 0)
  }
  const skippedDeps: SkippedWaveDep[] = []
  for (const id of ids) {
    for (const dep of depsOf.get(id) ?? []) {
      // 跨团队依赖 / 拼错的 id / 自依赖：写路径已经拒过，读视图不该因此整体崩
      if (!known.has(dep) || dep === id) {
        skippedDeps.push({ taskId: id, dep })
        continue
      }
      after.get(dep)!.push(id)
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
    }
  }

  const topo: string[] = []
  const remaining = new Map(indegree)
  let frontier = ids.filter((id) => (remaining.get(id) ?? 0) === 0).sort(compareIds)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      topo.push(id)
      for (const follower of after.get(id) ?? []) {
        const left = (remaining.get(follower) ?? 0) - 1
        remaining.set(follower, left)
        if (left === 0) next.push(follower)
      }
    }
    frontier = [...new Set(next)].sort(compareIds)
  }

  const placed = new Set(topo)
  const cycles = ids.filter((id) => !placed.has(id)).sort(compareIds)
  if (cycles.length > 0) {
    return {
      ok: false,
      code: WAVE_CODES.TASK_CYCLE,
      reason: `检测到任务依赖环：${cycles.join(' → ')}；波次无法给出，请先断开环`,
      cycles,
      waves: [],
      order: [],
      skippedDeps,
    }
  }

  const waveOf = new Map<string, number>()
  const waves: string[][] = []
  for (const id of topo) {
    // 依赖允许的最早波次：所有前置都在更早的波里
    let earliest = 0
    for (const dep of depsOf.get(id) ?? []) {
      const depWave = waveOf.get(dep)
      if (depWave !== undefined && depWave + 1 > earliest) earliest = depWave + 1
    }
    waveOf.set(id, placeTask(id, earliest, waves, scopeOf))
  }

  for (const wave of waves) wave.sort(compareIds)
  return { ok: true, waves, order: waves.flat(), skippedDeps }
}

/** 从 earliest 起找第一个「不与已落位任务写范围冲突」的波次，并落位 */
function placeTask(
  taskId: string,
  earliest: number,
  waves: string[][],
  scopeOf: ReadonlyMap<string, string[]>,
): number {
  const own = scopeOf.get(taskId) ?? []
  let index = earliest
  for (;;) {
    const wave = waves[index]
    if (wave === undefined) {
      // 走到末尾：earliest 永远 <= waves.length（前置一定已落位），所以不会留洞
      waves[index] = [taskId]
      return index
    }
    const conflicts = wave.some((other) => scopesOverlap(own, scopeOf.get(other) ?? []))
    if (!conflicts) {
      wave.push(taskId)
      return index
    }
    index += 1
  }
}

/* ── 共享文件任务合并 ───────────────────────────────────────────────── */

/** 一个「串行组」：组内任务的写范围完全相同，所以必须一个跑完再跑下一个 */
export interface SharedFileGroup {
  groupId: string
  /** 组内任务，按 taskId 稳定排序 = 串行顺序 */
  taskIds: string[]
  /** 组内共享的写范围（归一化 + 字典序） */
  writeScopes: string[]
}

export type SharedFileMergeResult =
  | {
      ok: true
      groups: SharedFileGroup[]
      /** 组的波次（元素是 groupId，不是 taskId） */
      waves: string[][]
      /** taskId → groupId，便于调用方回填 */
      groupOf: Record<string, string>
    }
  | { ok: false; code: WaveCode; reason: string; cycles: string[] }

/**
 * 把「写范围完全相同」的任务合并成一个串行组，再对组算波次。
 *
 * 为什么需要合并，而不是只靠 `planDevWaves` 的「重叠进下一波」：
 *   两个任务写的是**同一批文件**（如都改 `src/index.ts` 和 `src/app.ts`），
 *   它们之间的先后是有业务意义的（后一个要在前一个的改动上继续）。分开算波次
 *   会把它们排成「谁先谁后由 taskId 决定」，而合并成组能明确表达「这是一条串行链」，
 *   面板也能画成一条链而不是两个孤立节点。
 *
 * 为什么只合并「**完全相同**」的范围：
 *   范围只要有差异（`src/` vs `src/a.ts`）就可能是「一个任务改目录、另一个只改一个
 *   文件」，语义上不是同一条链。这种情况交给 `planDevWaves` 的重叠规则串行化即可。
 *   未声明 writeScopes 的任务**不参与合并**（否则所有无范围任务会并成一条假串行链）。
 *
 * @param tasks 任务面（同 `planDevWaves`）
 * @returns 成功给 `groups` + `waves`（组级波次）；成环给 `{ok:false}` 原样透传
 */
export function mergeSharedFileTasks(tasks: readonly WaveTaskInput[]): SharedFileMergeResult {
  const list = [...(tasks ?? [])]
  const groups: SharedFileGroup[] = []
  const groupOf: Record<string, string> = {}
  const indexOfKey = new Map<string, number>()
  const depsOf = new Map<string, string[]>()

  for (const task of list) {
    const taskId = String(task?.taskId ?? '')
    depsOf.set(taskId, (task?.deps ?? []).map((dep) => String(dep ?? '')))
    const scopes = normalizeScopeList(task?.writeScopes).sort(compareIds)
    // 未声明范围：独立成组（key 用 taskId 保证不会与任何人合并）
    const key = scopes.length === 0 ? `\u0000${taskId}` : scopes.join('\u0000')
    const existing = indexOfKey.get(key)
    if (existing === undefined) {
      indexOfKey.set(key, groups.length)
      groups.push({ groupId: `g${groups.length + 1}`, taskIds: [taskId], writeScopes: scopes })
    } else {
      groups[existing]!.taskIds.push(taskId)
    }
  }

  for (const group of groups) {
    group.taskIds.sort(compareIds)
    for (const taskId of group.taskIds) groupOf[taskId] = group.groupId
  }

  // 组级依赖：把成员的 deps 映射到组；组内依赖自己会变成自依赖，直接丢掉
  const groupTasks: WaveTaskInput[] = groups.map((group) => {
    const deps: string[] = []
    for (const taskId of group.taskIds) {
      for (const dep of depsOf.get(taskId) ?? []) {
        const mapped = groupOf[dep]
        if (mapped === undefined || mapped === group.groupId || deps.includes(mapped)) continue
        deps.push(mapped)
      }
    }
    return { taskId: group.groupId, deps, writeScopes: group.writeScopes }
  })

  const plan = planDevWaves(groupTasks)
  if (!plan.ok) return { ok: false, code: plan.code, reason: plan.reason, cycles: plan.cycles }
  return { ok: true, groups, waves: plan.waves, groupOf }
}

/* ── 领取前的写范围闸门（CHG-159 / 报告 A6）────────────────────────── */

/**
 * 写范围闸门需要的最小任务面（**结构化类型**：`TeamProjection` 直接可传，不必先 map 一份）。
 *
 * 为什么只收三个字段：闸门只回答「两批文件会不会撞」，不关心任务标题/证据/门禁；
 * 收窄到最小面之后，单测不需要造完整账本就能穷举冲突矩阵。
 */
export interface ClaimScopeProjection {
  tasks: Record<string, { id: string; state: string; input: { writeScopes?: readonly string[] } }>
}

export interface ClaimScopeAllowed {
  ok: true
  /** 放行时恒为空数组（调用方不必判 undefined） */
  blockingTaskIds: []
}

export interface ClaimScopeBlocked {
  ok: false
  /**
   * 复用 `MT_NOT_CLAIMABLE`（`errors.ts` 原文：「任务当前状态不允许 claim（不满足就绪条件）」
   * ——写范围被在飞任务占住就是「此刻不能领」的一种）。**不新增码**：新增码要重生成
   * `docs/04` 并改 t81 对账，而语义没有新东西可表达。
   */
  code: MtCode
  /** 中文可读：点名与谁重叠、为什么必须串行、下一步怎么做（只写 blocked 等于让人干等） */
  message: string
  /** 与本次 claim 写范围重叠的在飞任务（字典序，看板/日志直接点名） */
  blockingTaskIds: string[]
}

export type ClaimScopeVerdict = ClaimScopeAllowed | ClaimScopeBlocked

/**
 * 参与闸门的任务状态：只有**正在执行**的任务此刻可能正在写文件。
 * 为什么不含 `gate:*`：门禁态 = 实现已完成、等裁决（产出物已交付），此时改的是同一批
 * 已完成的文件，再串行只是把交付拖慢；而 `ready`/`backlog` 还没开始写，不构成并发。
 */
const CLAIM_SCOPE_IN_FLIGHT: ReadonlySet<string> = new Set(['in_progress', 're-scoping'])

/**
 * 领取前的写范围闸门（纯函数）：本任务的可写范围是否与**同团队正在执行**的任务重叠。
 *
 * 为什么需要（问题本身）：`claim` 抢占只解决「同一任务被两个人领」，解决不了「两个不同任务
 * 写同一批文件」——它们仍会被同时派出去，最后写入者赢、前一个的改动被静默覆盖。
 * `scope-audit` 只在完成时事后留痕，**不拦截**；这里补上「领之前」那道闸。
 *
 * 判定口径（与 `scopesOverlap` 同源，**不另写一套**）：
 *  ① 只跟同团队、状态为 `in_progress` / `re-scoping` 的任务比（`ClaimScopeProjection` 就是
 *     单个团队的投影，跨团队的比较不在本函数职责内）；
 *  ② 任一方的 `writeScopes` 为空/未声明 → **不拦**（未声明 = 不参与串行。否则存量团队
 *     全部死锁：没有声明范围不等于「哪里都能写」）；
 *  ③ 同一个任务自己 → 不拦；
 *  ④ 依赖「上游未完成」不属于本函数职责（那是 `canClaim` 在 service 层的活）；
 *  ⑤ 阻塞清单按 taskId 字典序稳定输出（同输入必得同结果，日志/面板不会每次顺序不同）。
 *
 * @param projection 本团队投影（只读）
 * @param taskId 准备 claim 的任务 id
 * @returns 放行 `{ok:true}`；冲突 `{ok:false, code:'MT_NOT_CLAIMABLE', message, blockingTaskIds}`
 *
 * @example
 *   claimScopeVerdict(proj, 'b')  // a 正在跑且 writeScopes 都是 ['src/']
 *   // → { ok: false, code: 'MT_NOT_CLAIMABLE', blockingTaskIds: ['a'], message: '…' }
 */
export function claimScopeVerdict(projection: ClaimScopeProjection, taskId: string): ClaimScopeVerdict {
  const target = projection?.tasks?.[taskId]
  const own = normalizeScopeList(target?.input?.writeScopes)
  // ② 未声明（或任务还不在投影里）→ 不做写范围串行：闸门只拦「能证明会撞」的情况
  if (!target || own.length === 0) return { ok: true, blockingTaskIds: [] }
  const conflicts: { taskId: string; state: string; scopes: string[] }[] = []
  for (const task of Object.values(projection.tasks)) {
    if (!task || task.id === taskId) continue // ③ 自己
    if (!CLAIM_SCOPE_IN_FLIGHT.has(task.state)) continue // ① 只比在飞任务
    const other = normalizeScopeList(task.input?.writeScopes)
    // ② 对方未声明 → 不构成冲突（scopesOverlap 已按此口径实现，这里只是省一次调用）
    if (other.length === 0 || !scopesOverlap(own, other)) continue
    conflicts.push({ taskId: task.id, state: task.state, scopes: other })
  }
  if (conflicts.length === 0) return { ok: true, blockingTaskIds: [] }
  conflicts.sort((a, b) => compareIds(a.taskId, b.taskId))
  const blockingTaskIds = conflicts.map((conflict) => conflict.taskId)
  const detail = conflicts.map((conflict) => `「${conflict.taskId}」（${conflict.state}，范围 ${conflict.scopes.join('、')}）`).join('、')
  return {
    ok: false,
    code: WAVE_CODES.TASK_IN_FLIGHT,
    message:
      `任务「${taskId}」的可写范围（${own.join('、')}）与正在执行的任务 ${detail} 重叠：` +
      '两者会改同一批文件，同时执行会后写覆盖先写，必须串行。' +
      `请等 ${blockingTaskIds.join('、')} 完成（或撤权/结束）后再 claim；` +
      '需要并行请先调整任务的 writeScopes 让范围不重叠（写范围是契约，不是提示）。',
    blockingTaskIds,
  }
}

/* ── 人读说明 ───────────────────────────────────────────────────────── */

/**
 * 把波次渲染成中文说明（面板折叠行 / 日志 / 工具结果都用这一段）。
 *
 * 只做展示，不参与任何判定——所以它接受任何 `string[][]`，包括 `mergeSharedFileTasks`
 * 出来的组级波次。
 */
export function explainWaves(waves: readonly (readonly string[])[]): string {
  if (!Array.isArray(waves) || waves.length === 0) return '没有可调度的任务。'
  return waves
    .map((wave, index) => {
      const items = [...(wave ?? [])]
      const head = `第 ${index + 1} 波（${items.length} 个，${items.length > 1 ? '可并行' : '单独执行'}）`
      return items.length === 0 ? `${head}：空` : `${head}：${items.join('、')}`
    })
    .join('\n')
}
