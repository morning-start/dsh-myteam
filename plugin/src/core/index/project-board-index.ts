/**
 * CHG-188（FR-33 · M3-6）：项目级看板**派生索引** —— `<project>/.dsh-myteam/state/index/tasks.json`。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────────────
 * 面板「项目」作用域的全项目看板此前是**每次读时全量折叠**：扫 `tasks/*\/ledger.jsonl`
 * → 逐团队 `foldEvents` → `buildBoardView` → `buildProjectView`，代价 O(团队数 × 账本行数)。
 * 团队一多，看板首屏就慢（docs/23 §4.2 G2-3）。本模块把这次折叠的结果**落盘成派生索引**，
 * 读路径变成「一次 JSON 读」。
 *
 * ── 三条铁律（缺一条就是第二真源）─────────────────────────────────────────────
 *  ① **派生**：索引不是事实源。任何时刻可 `buildProjectBoardIndex()` 全量重建；
 *    删掉索引文件后再读，重算结果必须与原来**逐字段相等**（`t140-1` / `t140-2`）。
 *  ② **降级**：坏 JSON / `schema` 版本不符 / 索引比任一账本旧 → **回落到实时折叠**，
 *    **绝不返回空看板**（空看板会被 UI 说成「这个项目没有任务」——那是谎报，
 *    比慢更糟；`t140-3` / `t140-4` / `t140-5`）。
 *  ③ **写盘唯一出口**：只走 `core/fs/write-log.ts` 的 `writeTextAtomic`
 *    （整份替换 + fsync 屏障 + 唯一临时名 + 拒符号链接，A2 门禁）。
 *
 * ── 刻意不做的事 ──────────────────────────────────────────────────────────────
 *  - **不加内存缓存**：那会引入第二真源（进程内一份、盘上一份，谁新谁旧说不清）。
 *    本任务是**磁盘派生索引**，读盘即真相；要靠内存提速必须先答「失效怎么传播」。
 *  - **不存绝对路径**：索引是要能换机器/换工作区副本复用的，绝对路径一换就废。
 *    折叠结果里只有业务字段（taskId / teamId / 成员 id），`workspaceRoot` 与角色目录
 *    这类机器相关字段**不进索引**（见 {@link ProjectBoardIndex} 的字段清单）。
 *  - **不主动失效**：写路径（`TeamService.commit`）之后不删索引（省一次 IO），
 *    靠 `builtAt` + 账本 mtime + 团队集合比对判过期（{@link isIndexStale}）。
 *
 * ── 折叠逻辑复用（不许复制一份）───────────────────────────────────────────────
 * 索引内容 = `buildOfflineProject(projectRoot)`（`core/index/offline-view.ts`）的结果，
 * 也就是「不依赖队长会话、从账本折叠出的项目看板」——与在线 `getProject` 同构、
 * 与 `getBoard({teamId})` 的 `board` 同一个 `buildBoardView`。本模块**只做**序列化、
 * 版本判定与过期判定，**不重写任何字段映射**。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeTextAtomic } from '../fs/write-log.ts'
import { buildOfflineProject } from './offline-view.ts'
import type { ProjectTaskView, ProjectView } from './views.ts'
import { storeLayout } from '../workspace/layout.ts'

/**
 * 索引 schema 版本。
 *
 * **什么时候 +1**：`ProjectView` 的字段增删改（含嵌套的 `BoardTaskView`）就要 +1 ——
 * 旧索引在新代码里会被当成「结构不符」直接重算，而不是读出半个对象（`t140-4`）。
 * 只加减聚合桶、不改已有字段含义时**不必** +1（读出来仍可用）。
 */
export const BOARD_INDEX_SCHEMA = 1

/** 索引里的任务 = 项目看板任务（复合键 `teamId/taskId`，跨团队同名不冲突） */
export type ProjectBoardTask = ProjectTaskView

/**
 * 索引落盘形状（顶层字段清单）。
 *
 * 刻意**不含** `workspaceRoot` / `roles` / `projectRole`：
 *  - `workspaceRoot` 是绝对路径（换机器就废，本任务明令禁止入索引）；
 *  - 角色目录是「角色页」的数据面，不是看板派生数据，进了索引只会让索引变大且更易过期。
 */
export interface ProjectBoardIndex {
  /** 索引 schema 版本（≠ {@link BOARD_INDEX_SCHEMA} 即视为不可用） */
  schema: number
  /** 构建时间（ISO 8601）；**不参与**内容比较（t140-1 只比其余字段） */
  builtAt: string
  /** 参与聚合的团队摘要（按 `teamId` 升序，保证删掉重算逐字段相等） */
  teams: ProjectView['teams']
  /** 全项目任务（复合键 `key = teamId/taskId`；按 `key` 升序） */
  tasks: ProjectBoardTask[]
  /** 全项目依赖图（跨团队按复合键重建边） */
  graph: ProjectView['graph']
  /** 五指标汇总（总任务 / 进行中 / 门禁待审 / 已完成 / 阻塞） */
  counts: ProjectView['counts']
  /** 折叠期告警（配置损坏等；透传不失真） */
  warnings: string[]
}

/** 索引文件路径：`<store>/state/index/tasks.json`（`state/` 下自有子目录，与 `teams.json` 平级） */
export function boardIndexPath(projectRoot: string): string {
  return join(storeLayout(projectRoot).state, 'index', 'tasks.json')
}

/**
 * 索引的**规范形态** = 落盘形态。
 *
 * 为什么必须过一遍 JSON：`buildBoardView` 会写出 `assignee: undefined` / `currentTaskId: undefined`
 * 这类「键存在但值是 undefined」的字段，而 `JSON.stringify` 会把它们**丢掉**。于是
 * 「内存里折叠出来的对象」与「盘上读回来的对象」`deepStrictEqual` 不相等 —— 差的不是数据，
 * 是**同一个东西的两种形态**。索引只有一种形态才谈得上「删掉重算逐字段相等」，
 * 所以这里把规范形态一次定死，`buildProjectBoardIndex` 写的就是它。
 */
function canonical(index: ProjectBoardIndex): ProjectBoardIndex {
  return JSON.parse(JSON.stringify(index)) as ProjectBoardIndex
}

/**
 * 实时折叠（**不读也不写索引**）：项目看板的唯一计算入口。
 *
 * 排序是为了「删掉重算一致」：`readdirSync` 的顺序不保证（Windows 与 POSIX 不同、
 * 同一目录两次读也可能不同），不排序的话「重建结果逐字段相等」这条不变量在
 * 换机器/换文件系统后就不成立了。
 */
export function foldBoardLive(projectRoot: string): ProjectBoardIndex {
  const view = buildOfflineProject(projectRoot)
  return canonical({
    schema: BOARD_INDEX_SCHEMA,
    builtAt: new Date().toISOString(),
    teams: [...view.teams].sort((a, b) => a.teamId.localeCompare(b.teamId)),
    tasks: [...view.tasks].sort((a, b) => a.key.localeCompare(b.key)),
    graph: view.graph,
    counts: view.counts,
    warnings: [...view.warnings],
  })
}

/**
 * 全量重建并落盘（**写盘只走 `writeTextAtomic`**）。
 *
 * 返回刚落盘的索引（调用方不必再读一次）。`ensureParent: true` 是因为
 * `state/index/` 不在 `STORE_DIRS` 的初始化清单里——只有第一次构建才需要建。
 */
export async function buildProjectBoardIndex(projectRoot: string): Promise<ProjectBoardIndex> {
  const index = foldBoardLive(projectRoot)
  writeTextAtomic(boardIndexPath(projectRoot), `${JSON.stringify(index, null, 2)}\n`, { ensureParent: true })
  return index
}

/** 读到的 JSON 是不是本版本的索引（结构 + 版本双判；任何一条不满足都视为不可用） */
function isBoardIndex(value: unknown): value is ProjectBoardIndex {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ProjectBoardIndex>
  return (
    candidate.schema === BOARD_INDEX_SCHEMA
    && typeof candidate.builtAt === 'string'
    && Array.isArray(candidate.tasks)
    && Array.isArray(candidate.teams)
    && Array.isArray(candidate.warnings)
    && typeof candidate.counts === 'object'
    && candidate.counts !== null
  )
}

/** 目录下「有账本的团队」集合（排序；读不到 = 空，与折叠口径一致） */
function ledgerTeamIds(projectRoot: string): string[] {
  const teamsDir = storeLayout(projectRoot).tasks
  let names: string[] = []
  try {
    names = readdirSync(teamsDir)
  } catch {
    return []
  }
  return names
    .filter((name) => existsSync(join(teamsDir, name, 'ledger.jsonl')))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * 索引是否过期。**两道判定，缺一不可**：
 *
 * ① **团队集合变了**（新团队建了账本 / 团队目录被删）——这一条 mtime 判不出来：
 *    删掉一个团队不会让任何现存账本的 mtime 前进，索引会一直带着已解散团队的任务。
 * ② **索引比任一账本旧**（`mtimeMs` 严格小于）——正常的「账本追加」路径。
 *
 * 宁可多折叠一次（慢），不返回脏数据（错）。
 */
function isIndexStale(projectRoot: string, indexPath: string): boolean {
  const teamsDir = storeLayout(projectRoot).tasks
  const current = ledgerTeamIds(projectRoot)
  let indexMtime = 0
  try {
    indexMtime = statSync(indexPath).mtimeMs
  } catch {
    return true
  }
  for (const teamId of current) {
    try {
      // 账本比索引新 → 过期（严格小于：同一次写入的同一毫秒不算旧）
      if (statSync(join(teamsDir, teamId, 'ledger.jsonl')).mtimeMs > indexMtime) return true
    } catch {
      // 账本刚被删（读目录与 stat 之间）——当作没有，交给下一轮
    }
  }
  // 团队集合比对：索引里出现的团队必须都还在（否则说明有团队被删/归档）
  return false
}

/** 索引里的团队集合与当前账本目录是否一致（`isIndexStale` 的第 ① 条） */
function teamSetChanged(projectRoot: string, index: ProjectBoardIndex): boolean {
  const current = ledgerTeamIds(projectRoot)
  const cached = index.teams.map((team) => team.teamId).sort((a, b) => a.localeCompare(b))
  if (current.length !== cached.length) return true
  return current.some((teamId, position) => teamId !== cached[position])
}

/**
 * 读索引（三条降级，见模块头 ②）：
 *
 *  - **文件不存在** → 现场折叠并落索引（首次访问/用户删掉索引后自愈）；
 *  - **JSON 坏 / `schema` 不符** → 回落实时折叠（**不抛错、不返回空看板**）；
 *  - **比任一账本旧 / 团队集合变了** → 重算并落盘。
 *
 * 坏索引**不在读路径上重写**：读失败往往是「文件正在被替换」，此时写盘只会制造
 * 一次无谓的竞争；下一次写路径或下一次构建自然会覆盖它。
 */
export async function readProjectBoardIndex(projectRoot: string): Promise<ProjectBoardIndex> {
  const path = boardIndexPath(projectRoot)
  if (!existsSync(path)) return buildProjectBoardIndex(projectRoot)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // 坏 JSON（半写文件 / 手工改坏）：诚实降级为实时折叠
    return foldBoardLive(projectRoot)
  }
  if (!isBoardIndex(parsed)) return foldBoardLive(projectRoot)
  if (teamSetChanged(projectRoot, parsed)) return buildProjectBoardIndex(projectRoot)
  if (isIndexStale(projectRoot, path)) return buildProjectBoardIndex(projectRoot)
  return parsed
}
