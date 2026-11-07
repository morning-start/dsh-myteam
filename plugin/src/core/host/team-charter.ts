/**
 * CHG-93（FR-18 职责③ F8）：团队章程 → 队长 system prompt 的注入面。
 *
 * ## 为什么需要它
 *
 * PRD FR-18 把「结构整理」列为队长职责，产出物是 `.team-workplace/structure.md`
 * （**与 PRD §4.1 的结构约定同一份文件**，不另建——两份项目级约定必然分叉）。
 * CHG-88 已实装 create-team 技能**写**这份文件，但**从没有人读它**：
 * 章程写进去就躺在磁盘上，队长自己的系统提示里一个字都没有。
 *
 * 这是典型的「文档承诺与实现分叉」——UI 显示「已生成团队章程」，模型侧零感知。
 *
 * ## 为什么是「变量 + section」而不是直接 section
 *
 * 宿主 `systemPrompt.section({text})` 是**会话建立时**取值（NFR-7.3「系统提示稳定」），
 * 运行期改不了。而章程是**队长随时会改**的文件——用静态 section 就意味着
 * 「改了要重启」。
 *
 * 宿主的 `systemPrompt.variable(name, provider)` 的 provider **每次组装求值**，
 * 配合 `section({text: '{{var}}'})` 就能做到「改了下一次请求就生效」。
 * 两条 API 都不可用时**降级为静态注入并如实告知**（不假装即时生效）。
 *
 * ## 边界（诚实声明）
 *
 * - 章程是**给模型看的约定**，不是权限：它不改变 `toolPolicy`，也不绕过门禁。
 * - 文件缺失 / 读取失败 → 返回空串（section 会被宿主丢弃），**不阻断会话建立**。
 *   「没有章程」是合法状态（新项目首次启动时就是空的）。
 * - 大小上限：超过 {@link MAX_CHARTER_BYTES} 只取前 N 字节并显式标注截断——
 *   一份 100KB 的章程会把整个 system prompt 挤爆，那比没有章程更糟。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../workspace/layout.ts'

/** 章程文件相对项目根的位置（与 `core/workspace/layout.ts` 的 `storeLayout().charter` 同源） */
export const TEAM_CHARTER_FILE = join(STORE_DIR, 'structure.md')

/**
 * 注入上限（64 KiB）。
 *
 * 为什么是这个量级：system prompt 每一轮都要付 token 成本，章程是**长期挂着**的段落。
 * 64 KiB ≈ 16k tokens，已经是一份很长的约定；超过说明它该拆成 knowledge 条目
 * （按任务相关性检索），而不是塞进每一轮。
 */
export const MAX_CHARTER_BYTES = 64 * 1024

/** 注入用的 section 名与排序（`TEAM_POLICY: 600` 之后、`PTC_ONLY: 800` 之前） */
export const TEAM_CHARTER_SECTION = { name: 'myteam:team-charter', order: 610 } as const

/** 变量名（宿主校验 `[a-z][a-z0-9_]*`） */
export const TEAM_CHARTER_VARIABLE = 'myteam_team_charter'

export interface TeamCharter {
  /** 已渲染的注入文本（空串 = 没有章程，调用方不要注册 section） */
  text: string
  /** 章程文件绝对路径 */
  path: string
  /** 是否因超过 {@link MAX_CHARTER_BYTES} 被截断 */
  truncated: boolean
  /** 原始字节数（截断前） */
  bytes: number
}

/**
 * 读团队章程并包成**给模型看的**段落。
 *
 * 为什么要加标题与「只读参考」框：直接裸贴 markdown 会让模型把它当成用户消息的一部分；
 * 加一段明确的定位（「这是本团队的结构约定」）能显著降低误用（比如把约定当成指令去执行）。
 *
 * @param workspaceRoot 工作区根
 * @returns 章程内容；文件不存在/读不到 → `text: ''`（合法状态，不抛）
 */
export function readTeamCharter(workspaceRoot: string): TeamCharter {
  const path = join(workspaceRoot, TEAM_CHARTER_FILE)
  const empty: TeamCharter = { text: '', path, truncated: false, bytes: 0 }
  if (!existsSync(path)) return empty
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    return empty
  }
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return empty
  }
  // 去 BOM（Windows 编辑器默认写 BOM，混进 system prompt 是垃圾字符）
  raw = raw.replace(/^\uFEFF/, '')
  const truncated = bytes > MAX_CHARTER_BYTES
  const body = truncated ? `${raw.slice(0, MAX_CHARTER_BYTES)}\n\n> （章程超过 64 KiB，已截断；完整内容见 ${TEAM_CHARTER_FILE}）` : raw
  if (body.trim().length === 0) return { ...empty, bytes }

  return {
    text: [
      '## 团队章程（本团队的结构约定）',
      '',
      '> 这是本项目队长在「结构整理」职责（FR-18）下维护的约定：文件放哪里、做到什么程度、谁沟通、谁存档。',
      '> 它描述的是**本团队约定**，不是权限——不改变你的工具边界，也不绕过门禁。',
      '',
      body.trim(),
    ].join('\n'),
    path,
    truncated,
    bytes,
  }
}
