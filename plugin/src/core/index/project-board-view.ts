/**
 * CHG-202z（FR-33 · M3-7）：**项目共享看板**——三种分组 + 五个汇总（纯函数）。
 *
 * ── 为什么要单独一层 ────────────────────────────────────────────────────────
 * 「按团队 / 按角色 / 按父子根」不是三个视图，是**同一份任务集的三种投影**。做成三个
 * 各自计算的界面 = 三个口径（G2-5 说的「数字对不上时没有唯一口径」）。这里把
 * **汇总口径**收成一个纯函数，端点只做「取项目视图 → 调这里 → 返回」。
 *
 * ── 口径（docs/23 §4.3；改这里就是改产品口径）─────────────────────────────
 *  | 指标 | 判定 |
 *  |---|---|
 *  | `tasks` | 项目内全部任务（含子成员领取的——任务只属于项目） |
 *  | `running` | `in_progress` / `re-scoping`（正在被推进） |
 *  | `gates` | `gate:*`（等裁决） |
 *  | `done` | `done` |
 *  | `blocked` | `blocked`（等上游 / 等人） |
 *  | `evidenceStale` | 结构编辑晚于最近证据（证据过期，**不是状态**，单独一列） |
 *
 * 纪律：**不猜**。未知状态一律不进任何桶（`backlog` / `ready` / `failed` / `cancelled`
 * 只体现在 `tasks` 总数里），这样「五个桶加起来 ≤ 总数」永远成立，UI 不会算出负数。
 */
import type { ProjectTaskView, ProjectView } from './views.ts'

/** 三种分组（docs/23 §4.3） */
export type ProjectGroupBy = 'team' | 'role' | 'rootMember'

/** 五个汇总 + 证据过期（口径见文件头） */
export interface ProjectSummary {
  tasks: number
  running: number
  gates: number
  done: number
  blocked: number
  evidenceStale: number
  /** 口径说明（UI 直接显示，避免「这个数字怎么来的」再被问一次） */
  note: string
}

/** 一个分组（key 为空串 = 未归属，如未领取的任务） */
export interface ProjectGroup {
  key: string
  label: string
  tasks: ProjectTaskView[]
  counts: ProjectSummary
}

export interface ProjectBoardView {
  groupBy: ProjectGroupBy
  groups: ProjectGroup[]
  summary: ProjectSummary
  /** 降级 / 数据问题（与 `ProjectView.warnings` 同源透传） */
  warnings: string[]
}

const SUMMARY_NOTE =
  '口径：tasks = 项目内全部任务；running = in_progress|re-scoping；gates = gate:*（等裁决）；' +
  'done = done；blocked = blocked；evidenceStale = 结构编辑晚于最近证据（不是状态）。' +
  'backlog/ready/failed/cancelled 只计入 tasks 总数，保证五个桶之和 ≤ 总数。'

const isRunning = (state: string): boolean => state === 'in_progress' || state === 're-scoping'
const isGate = (state: string): boolean => state.startsWith('gate:')

/** 五个汇总（纯函数：只读任务字段，不读时钟 / 不读文件） */
export function summarizeProjectTasks(tasks: ProjectTaskView[]): ProjectSummary {
  let running = 0
  let gates = 0
  let done = 0
  let blocked = 0
  let evidenceStale = 0
  for (const task of tasks) {
    const state = String(task.state ?? '')
    if (isRunning(state)) running += 1
    else if (isGate(state)) gates += 1
    else if (state === 'done') done += 1
    else if (state === 'blocked') blocked += 1
    if (task.evidenceStale) evidenceStale += 1
  }
  return { tasks: tasks.length, running, gates, done, blocked, evidenceStale, note: SUMMARY_NOTE }
}

/** 分组键（未归属 → 空串；UI 用 `group.label` 显示） */
function keyOf(task: ProjectTaskView, groupBy: ProjectGroupBy, rootOf: (memberId: string) => string | undefined): string {
  if (groupBy === 'team') return task.ownerTeamId ?? ''
  if (groupBy === 'role') return task.requiredRole ?? ''
  /* rootMember：负责人（多负责取第一个）上溯到根成员；未领取 → 空串。
   * 为什么用 root 而不是 assignee：子成员领取的任务在「按父子根」下要归到根，
   * 否则树一深，同一个根下面散成好几组（场景 44）。 */
  const assignee = task.assignee ?? task.assignees?.[0]
  if (!assignee) return ''
  return rootOf(assignee) ?? assignee
}

/**
 * 项目看板（三种分组 + 五个汇总）。
 *
 * 分组顺序：按任务数降序、同数按 key 升序——**稳定**（同一份数据两次调用结果一致，
 * 否则 UI 每次重渲染都在跳）。空 key 排最后（未归属不该抢第一屏）。
 */
export function buildProjectBoardView(project: ProjectView, groupBy: ProjectGroupBy): ProjectBoardView {
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const teamNameOf = new Map<string, string>()
  const rootOf = new Map<string, string>()
  for (const team of project.teams ?? []) {
    if (team.name) teamNameOf.set(team.teamId, team.name)
    for (const member of team.members ?? []) {
      const root = member.rootMemberId ?? member.id
      if (root) rootOf.set(member.id, root)
    }
  }
  const labelOf = (key: string): string => {
    if (key === '') return groupBy === 'rootMember' ? '（未领取）' : '（未归属）'
    if (groupBy === 'team') return teamNameOf.get(key) ?? key
    if (groupBy === 'rootMember') return key
    return key
  }
  const buckets = new Map<string, ProjectTaskView[]>()
  for (const task of tasks) {
    const key = keyOf(task, groupBy, (memberId) => rootOf.get(memberId))
    const list = buckets.get(key) ?? []
    list.push(task)
    buckets.set(key, list)
  }
  const groups: ProjectGroup[] = [...buckets.entries()]
    .map(([key, list]) => ({ key, label: labelOf(key), tasks: list, counts: summarizeProjectTasks(list) }))
    .sort((a, b) => {
      if (a.key === '') return 1
      if (b.key === '') return -1
      return (b.tasks.length - a.tasks.length) || a.key.localeCompare(b.key)
    })
  return {
    groupBy,
    groups,
    summary: summarizeProjectTasks(tasks),
    warnings: Array.isArray(project.warnings) ? project.warnings : [],
  }
}
