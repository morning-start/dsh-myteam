/**
 * CHG-88（M2-E / FR-16.3）：`/myteam handoff` —— 会话移交面（摘要提取 + 新团队会话注入）。
 *
 * 为什么存在（FR-16.3 的原话「移交」不是「原地变身」）：
 *  - **原地变身被明确否决**，两个硬理由：①破坏 F3（系统提示在会话建立时确定，运行期
 *    改写会让队长人设半途易形）；②旧会话历史整段混进队长上下文（历史里全是"上一个
 *    团队"的对话，模型会按旧上下文继续干活，而不是按新团队的规划继续）。
 *  - 所以移交 = **新开会话 + 注入摘要**，原会话原样保留（它仍是一条可查的历史）。
 *
 * 能力前提（docs/02 T0-⑥ / docs/06 R25，已在真宿主实证，见 `.debug/drive-e2e.mjs`）：
 *  1. `sessionController.create({ cwd, agentPreset })` → `{ sessionId, agentPreset }`
 *  2. `sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] })`
 *     → `{ accepted: true }`（requestId 幂等；mode='queue' = 追加到当前轮之后）
 *  宿主没有 `sessionController` 服务时 → `MT_UNAVAILABLE`（**不假装成功**、不静默降级、
 *  不伪造一个 sessionId）。
 *
 * 纯函数与宿主调用分离〔J1〕：
 *  - 纯：`buildHandoffSummary` / `buildHandoffPrompt`（无 IO、无 ctx，可单测断言）；
 *  - 宿主调用：`resolveSessionHandoffCapability`（能力探测）/ `runHandoff`（建会话 + 注入）。
 *    两者都**不碰团队账本**：移交不是团队范围内的写操作（成员与任务由新队长自己建）。
 *
 * 摘要为什么要有界（FR-16.3「≤N 行」）：摘要要整段塞进新会话的**首条消息**，
 *  无界的话一个跑了几百个任务的团队会把新会话的上下文一次吃掉；故任务/成员/事件/
 *  备注各段都截断并显式写明「省略 N 项」——**不静默丢内容**。
 */

/** 团队预设 id（与 `cordis.patch.yml` 的 preset 行 `id: myteam-captain` 同口径） */
export const TEAM_AGENT_PRESET_ID = 'myteam-captain'

/** 摘要各分段的行数上限（超出部分折叠成「省略 N 项」） */
export const HANDOFF_SECTION_LIMITS = {
  tasks: 12,
  members: 12,
  events: 8,
  notes: 8,
} as const

/**
 * 会话索引的条目上限（M2-D ①：摘要升级为索引）。
 *
 * 为什么单独给一个上限：索引是**指针列表**（每行一个 `session:<id>`），
 * 不是内容摘要——它不占上下文预算的大头，但也不能无界（一个百人团队就是一百行）。
 * 20 条 ≈ 一屏，超出折叠成「省略 N 个会话」。
 */
export const HANDOFF_SESSION_INDEX_LIMIT = 20

/* ── 纯函数域（无 IO、无 ctx）─────────────────────────────────── */

/** 摘要输入里的任务条目（字段可缺省——缺省即"没有这一维"） */
export interface HandoffTask {
  id: string
  title?: string
  state?: string
  priority?: string
  requiredRole?: string
  assignee?: string
}

/** 摘要输入里的成员条目 */
export interface HandoffMember {
  id: string
  roleId?: string
  instanceName?: string
  status?: string
  currentTaskId?: string
  /** 成员会话 id（M2-D ①：会话索引的指针来源——`session:<id>` 可被新队长按需深读） */
  sessionId?: string
}

/**
 * M2-D ①（FR-16.4①）：会话索引的一条。
 *
 * 为什么是「索引」不是「摘要」：整段注入旧会话历史会让新队长按**旧上下文**继续干活
 * （FR-16.3 明确否决原地变身的第二条理由）。索引只给**指针**——
 * 新队长知道「哪些会话值得看」，需要时用 `session:<id>` 深读，
 * 读取本身留痕（`session.read` 账本事件，CHG-87）。
 */
export interface HandoffSessionRef {
  /** 会话 id（写成 `session:<id>` 即为合法证据指针） */
  sessionId: string
  /** 这个会话是谁的：队长 / 成员 */
  kind: 'captain' | 'member'
  /** 一行描述（面板与会话索引共用） */
  title: string
  /** 该会话当前在做什么（成员为 currentTaskId；队长为空） */
  taskId?: string
  /** 成员 id（kind='member' 时） */
  memberId?: string
  /** 角色 id（kind='member' 时） */
  roleId?: string
}

/** 摘要输入里的最近事件 */
export interface HandoffEvent {
  seq?: number
  type?: string
  actor?: string
  ts?: number
}

/** 摘要输入（全部可缺省：缺字段只影响摘要的一段，不影响整体可用性） */
export interface HandoffSummaryInput {
  teamId?: string
  teamName?: string
  goal?: string
  state?: string
  tasks?: HandoffTask[]
  members?: HandoffMember[]
  recentEvents?: HandoffEvent[]
  notes?: string[]
  /** 移交来源会话 id（FR-16.4①：摘要升级为索引——新队长据此按需深读原会话） */
  sourceSessionId?: string
}

/** 摘要的结构化副产物（面板/审计可读，不进模型上下文） */
export interface HandoffSummaryMetadata {
  teamId: string
  teamName: string
  goal: string
  state: string
  totalTasks: number
  /** 任务状态分布（state → 计数） */
  taskCounts: Record<string, number>
  totalMembers: number
  totalEvents: number
  taskIds: string[]
  memberIds: string[]
  sourceSessionId?: string
}

export interface HandoffSummaryResult {
  /** 人类可读的上下文摘要正文（新会话首条消息的正文） */
  summary: string
  metadata: HandoffSummaryMetadata
}

/** 取一段非空字符串（trim 后为空 → ''） */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 计数并保持首次出现顺序（摘要里的状态分布按常见度排，多的在前） */
function countBy(items: string[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const key of items) counts.set(key, (counts.get(key) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

/**
 * CHG-88（M2-E / FR-16.3）：从团队上下文构建移交摘要（**纯函数**）。
 *
 * 口径：
 *  - 第一行永远是「团队名（teamId）+ 目标」——目标缺失也保留该行（空目标让新队长
 *    知道自己缺什么，而不是悄悄省略这一行）；
 *  - 任务/成员/事件/备注分段输出，每段超出上限折叠成「（省略 N 项）」；
 *  - 全程不抛异常：缺字段 / 类型不对都退化成"这一段没有"，不因一条脏数据毁掉整个移交。
 */
/**
 * M2-D ①（FR-16.4①）：构建**会话索引**——把「有哪些会话可深读」变成指针列表。
 *
 * ## 为什么是索引而不是摘要
 *
 * FR-16.3 否决原地变身的两条理由里，第二条是「旧会话历史整段混进队长上下文 →
 * 模型按旧上下文继续干活」。摘要虽然已经截断，但**截断仍是内容**——
 * 新队长读到的是「上一个团队做了什么」，而不是「哪里能查到」。
 *
 * 索引只给指针：`session:<id>` 是 CHG-87 定义的第三类证据指针，
 * 新队长需要时按需深读（读取留痕 `session.read`），不需要就完全不占上下文。
 *
 * ## 口径
 *
 * - 队长会话（`sourceSessionId`）**永远排第一**——它是上下文最完整的一条；
 * - 成员会话按名册顺序（与面板名册一致，便于对照）；
 * - **没有 sessionId 的成员不进索引**（编造 id 比没有更糟——深读会落到不存在的会话）；
 * - 去重（同一 sessionId 只出现一次，取首次）。
 *
 * @param input 摘要输入（复用同一份，不额外取数）
 * @returns 有界、去重、稳定的会话索引（最多 {@link HANDOFF_SESSION_INDEX_LIMIT} 条）
 */
export function buildSessionIndex(input: HandoffSummaryInput): HandoffSessionRef[] {
  const refs: HandoffSessionRef[] = []
  const seen = new Set<string>()
  const push = (ref: HandoffSessionRef): void => {
    if (ref.sessionId.length === 0 || seen.has(ref.sessionId)) return
    seen.add(ref.sessionId)
    refs.push(ref)
  }

  const sourceSessionId = textOf(input?.sourceSessionId)
  if (sourceSessionId.length > 0) {
    push({ sessionId: sourceSessionId, kind: 'captain', title: '队长会话（上一个团队，上下文最完整）' })
  }

  const members = Array.isArray(input?.members) ? input.members : []
  for (const member of members) {
    const sessionId = textOf(member?.sessionId)
    if (sessionId.length === 0) continue
    const memberId = textOf(member.id)
    const roleId = textOf(member.roleId)
    const instanceName = textOf(member.instanceName)
    const label = [roleId, instanceName].filter(Boolean).join(' / ')
    const taskId = textOf(member.currentTaskId)
    push({
      sessionId,
      kind: 'member',
      title: memberId + (label ? `（${label}）` : ''),
      ...(taskId ? { taskId } : {}),
      ...(memberId ? { memberId } : {}),
      ...(roleId ? { roleId } : {}),
    })
  }

  return refs.slice(0, HANDOFF_SESSION_INDEX_LIMIT)
}

export function buildHandoffSummary(input: HandoffSummaryInput): HandoffSummaryResult {
  const teamId = textOf(input?.teamId)
  const teamName = textOf(input?.teamName)
  const goal = textOf(input?.goal)
  const state = textOf(input?.state)
  const sourceSessionId = textOf(input?.sourceSessionId)

  const tasks = Array.isArray(input?.tasks) ? input.tasks.filter((t) => t && typeof t === 'object') : []
  const members = Array.isArray(input?.members) ? input.members.filter((m) => m && typeof m === 'object') : []
  const recentEvents = Array.isArray(input?.recentEvents) ? input.recentEvents.filter((e) => e && typeof e === 'object') : []
  const notes = (Array.isArray(input?.notes) ? input.notes : [])
    .map((note) => textOf(note))
    .filter((note) => note.length > 0)

  const sessionIndex = buildSessionIndex(input)
  const taskStates = tasks.map((t) => textOf(t.state) || 'unknown')
  const metadata: HandoffSummaryMetadata = {
    teamId,
    teamName,
    goal,
    state,
    totalTasks: tasks.length,
    taskCounts: countBy(taskStates),
    totalMembers: members.length,
    totalEvents: recentEvents.length,
    taskIds: tasks.map((t) => textOf(t.id)).filter((id) => id.length > 0),
    memberIds: members.map((m) => textOf(m.id)).filter((id) => id.length > 0),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sessionIndex.length > 0 ? { sessionIndex } : {}),
  }

  const lines: string[] = []
  const title = teamName.length > 0 ? teamName : teamId
  lines.push(`【团队上下文摘要】团队「${title}」${teamId ? `（teamId: ${teamId}）` : ''}`)
  lines.push(`目标：${goal}`)
  if (state.length > 0) lines.push(`状态：${state}`)
  const countText = Object.entries(metadata.taskCounts).map(([key, value]) => `${key} ${value}`).join(' / ')
  lines.push(`任务：${metadata.totalTasks}${countText ? `（${countText}）` : ''}；成员：${metadata.totalMembers}`)

  if (tasks.length > 0) {
    lines.push('任务清单：')
    for (const task of tasks.slice(0, HANDOFF_SECTION_LIMITS.tasks)) {
      const parts = [`- ${textOf(task.id) || '(无 id)'}`]
      const titleText = textOf(task.title)
      if (titleText) parts.push(`「${titleText}」`)
      parts.push(`[${textOf(task.state) || 'unknown'}]`)
      const priority = textOf(task.priority)
      if (priority) parts.push(`优先级=${priority}`)
      const role = textOf(task.requiredRole)
      if (role) parts.push(`需角色=${role}`)
      const assignee = textOf(task.assignee)
      if (assignee) parts.push(`负责=${assignee}`)
      lines.push(parts.join(' '))
    }
    if (tasks.length > HANDOFF_SECTION_LIMITS.tasks) {
      lines.push(`（其余 ${tasks.length - HANDOFF_SECTION_LIMITS.tasks} 项任务省略）`)
    }
  }

  if (members.length > 0) {
    lines.push('成员名册：')
    for (const member of members.slice(0, HANDOFF_SECTION_LIMITS.members)) {
      const id = textOf(member.id) || '(无 id)'
      const role = textOf(member.roleId)
      const status = textOf(member.status)
      const detail = [role, status].filter(Boolean).join(' / ')
      const current = textOf(member.currentTaskId)
      lines.push(`- ${id}${detail ? `（${detail}）` : ''}${current ? ` 当前任务：${current}` : ''}`)
    }
    if (members.length > HANDOFF_SECTION_LIMITS.members) {
      lines.push(`（其余 ${members.length - HANDOFF_SECTION_LIMITS.members} 名成员省略）`)
    }
  }

  /* M2-D ①（FR-16.4①）：会话索引——只给指针，不整段注入。
   * 明确框成「按需深读」而不是「以下是历史」：后者会让模型以为内容已经给全了。 */
  if (sessionIndex.length > 0) {
    lines.push('会话索引（需要细节时按 `session:<id>` 深读；未深读的内容不在你的上下文里）：')
    for (const ref of sessionIndex) {
      const kind = ref.kind === 'captain' ? '队长' : '成员'
      const tail = ref.taskId ? ` 当前任务：${ref.taskId}` : ''
      lines.push(`- \`session:${ref.sessionId}\` [${kind}] ${ref.title}${tail}`)
    }
    const totalRefs = 1 + (Array.isArray(input?.members) ? input.members.filter((m) => textOf(m?.sessionId).length > 0).length : 0)
    if (totalRefs > sessionIndex.length) {
      lines.push(`（其余 ${totalRefs - sessionIndex.length} 个会话省略）`)
    }
  }
  if (recentEvents.length > 0) {
    lines.push('最近事件：')
    for (const event of recentEvents.slice(-HANDOFF_SECTION_LIMITS.events)) {
      const seq = Number(event.seq ?? 0)
      const type = textOf(event.type) || '(未知类型)'
      const actor = textOf(event.actor)
      lines.push(`- ${seq > 0 ? `#${seq} ` : ''}${type}${actor ? `（${actor}）` : ''}`)
    }
    if (recentEvents.length > HANDOFF_SECTION_LIMITS.events) {
      lines.push(`（其余 ${recentEvents.length - HANDOFF_SECTION_LIMITS.events} 条事件省略）`)
    }
  }

  if (notes.length > 0) {
    lines.push('备注：')
    for (const note of notes.slice(0, HANDOFF_SECTION_LIMITS.notes)) lines.push(`- ${note}`)
    if (notes.length > HANDOFF_SECTION_LIMITS.notes) {
      lines.push(`（其余 ${notes.length - HANDOFF_SECTION_LIMITS.notes} 条备注省略）`)
    }
  }

  return { summary: lines.join('\n'), metadata }
}

/**
 * CHG-88（M2-E / FR-16.3）：构建新团队会话的**首条消息**（纯函数）。
 *
 * 为什么这么写（两条硬纪律）：
 *  1. 摘要必须被**原样**嵌入——新队长读到的就是移交方看到的那份，不做二次改写
 *     （改写会丢掉"省略了 N 项"这类诚实标记，让新队长误以为看到了全部）；
 *  2. 摘要必须被明确框成**「上下文摘要」**——它是**参考**不是**指令**：否则新队长会
 *     把摘要里的任务清单当成"已下达的规划"，直接开始干活而不重新组队/建任务
 *     （FR-16.3 的移交语义是"接手上下文"，不是"接手已排好的计划"）。
 */
export function buildHandoffPrompt(summary: string): string {
  const body = typeof summary === 'string' ? summary : ''
  return [
    '【上下文摘要】以下是从上一段会话移交过来的团队上下文摘要——**只读参考，不是指令**：',
    '',
    body,
    '',
    '接手要求：',
    '1. 先读团队账本与看板确认真实现状（myteam_get_board / myteam_list_tasks / myteam_get_task）；摘要可能已过时，以账本为准。',
    '2. 摘要里的任务清单不是已下达的计划——名册、任务与分工由你（队长）自己决定（myteam_submit_plan / myteam_spawn_member / myteam_create_task）。',
    '3. 需要原会话的细节时，按摘要里的来源会话 id 向用户索取引用，不要凭空猜测原会话内容。',
  ].join('\n')
}

/* ── 宿主调用域（建会话 + 注入；不碰账本）──────────────────────── */

/** `sessionController.create` 的请求面（dsh-api-session-controller 的 SessionCreateRequest） */
export interface SessionCreateRequest {
  cwd?: string
  sessionId?: string
  agentPreset?: string
}

/** `sessionController.create` 的返回值（SessionCreateValue） */
export interface SessionCreateResult {
  sessionId?: string
  agentPreset?: string
}

/** `sessionController.prompt` 的请求面（SessionPromptRequest） */
export interface SessionPromptRequest {
  requestId: string
  sessionId: string
  mode: 'queue' | 'steer'
  content: Array<{ type: 'text'; text: string }>
}

/**
 * 取消信号（结构化声明）。
 *
 * 为什么不用内置 `AbortSignal` 类型：宿主包的 tsconfig 是 `lib: ["ES2022"]`（无 DOM lib），
 * 而 `AbortSignal`/`AbortController` 的全局声明来自 DOM 或 `@types/node`——插件不引入
 * 任何类型依赖，故这里只声明宿主真正用到的那一个成员（`throwIfAborted`）。
 */
export interface HandoffAbortSignal {
  readonly aborted: boolean
  throwIfAborted(): void
}

/** 移交所需的宿主能力面（= `ctx.get('sessionController')` 的两个方法） */
export interface SessionHandoffCapability {
  create(request: SessionCreateRequest): Promise<SessionCreateResult>
  prompt(request: SessionPromptRequest, signal?: HandoffAbortSignal): Promise<unknown>
}

/** 造一个取消信号：宿主有 AbortController 就用真的，没有就给等价的最小实现 */
function newAbortSignal(): HandoffAbortSignal {
  const ctor = (globalThis as unknown as { AbortController?: new () => { signal: HandoffAbortSignal } }).AbortController
  if (typeof ctor === 'function') {
    try {
      return new ctor().signal
    } catch {
      /* 落到下面的最小实现 */
    }
  }
  return { aborted: false, throwIfAborted: () => {} }
}

/** 错误对象上的稳定错误码（宿主 RemoteError 有 `code`；普通 Error 没有） */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'MT_HANDOFF_FAILED'
}

/** 错误消息（宿主 RemoteError 的 message 可直接给用户看） */
function errorMessageOf(error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message
  if (typeof message === 'string' && message.length > 0) return message
  return String(error)
}

/**
 * 能力探测：从宿主运行时里取 `sessionController`。
 *
 * 取法三选一（按可靠性排序）：
 *  1. `ctx.get('sessionController')`——官方口子（不要求 inject，缺服务返回 undefined）；
 *  2. `ctx.reflect.get('sessionController')`——同一服务的另一种叫法；
 *  3. 运行时上的 `sessionController` 自有属性——测试桩 / 非 Cordis 宿主。
 *
 * 三个都拿不到、或拿到的对象缺 `create`/`prompt` → 返回 undefined（调用方据此报
 * `MT_UNAVAILABLE`）。**绝不**在这里伪造一个"能用"的壳——那会让移交静默失败。
 */
export function resolveSessionHandoffCapability(rt: unknown): SessionHandoffCapability | undefined {
  const holder = (rt ?? {}) as {
    get?: (name: string) => unknown
    reflect?: { get?: (name: string) => unknown }
    sessionController?: unknown
  }
  const candidates: unknown[] = []
  const tryRead = (fn: (() => unknown) | undefined) => {
    if (typeof fn !== 'function') return
    try {
      const value = fn()
      if (value !== undefined && value !== null) candidates.push(value)
    } catch {
      /* Cordis 的「未 inject 就抛」在此被吞掉 → 视为不可用 */
    }
  }
  tryRead(() => (typeof holder.get === 'function' ? holder.get('sessionController') : undefined))
  tryRead(() => (typeof holder.reflect?.get === 'function' ? holder.reflect.get('sessionController') : undefined))
  tryRead(() => holder.sessionController)

  for (const candidate of candidates) {
    const controller = candidate as Partial<SessionHandoffCapability>
    if (typeof controller.create !== 'function' || typeof controller.prompt !== 'function') continue
    const source = candidate as SessionHandoffCapability
    return {
      create: (request) => source.create.call(source, request),
      prompt: (request, signal) => source.prompt.call(source, request, signal),
    }
  }
  return undefined
}

export interface HandoffRunOptions {
  /** 移交摘要正文（回显给调用方） */
  summary: string
  /** 新会话的首条消息（= buildHandoffPrompt(summary)） */
  prompt: string
  /** 新会话的工作目录（同一工作区 → 同一份 `.team-workplace`） */
  cwd: string
  /** 新会话运行的 Agent 预设（默认团队预设 `myteam-captain`） */
  agentPreset: string
  /** 幂等用的请求 id（宿主按 requestId 去重） */
  requestId: string
}

export interface HandoffRunResult {
  status: 'ok' | 'error'
  code?: string
  message?: string
  sessionId?: string
}

/**
 * 移交执行：建会话 → 注入摘要（两步，顺序不可换）。
 *
 * 失败口径（**不假装成功**）：
 *  - 建会话失败 → `{status:'error', code, message}`（没有 sessionId）；
 *  - 建会话成功但注入失败 → 同样报 error，但**带 sessionId**（会话已经存在，
 *    人可以自己去那条会话里手动粘贴摘要；把这条信息藏起来等于让人找不到会话）。
 */
export async function runHandoff(capability: SessionHandoffCapability, options: HandoffRunOptions): Promise<HandoffRunResult> {
  let created: SessionCreateResult
  try {
    created = await capability.create({ cwd: options.cwd, agentPreset: options.agentPreset })
  } catch (error) {
    return {
      status: 'error',
      code: errorCodeOf(error),
      message: `创建团队预设会话失败（agentPreset=${options.agentPreset}）：${errorMessageOf(error)}`,
    }
  }
  const sessionId = textOf(created?.sessionId)
  if (!sessionId) {
    return {
      status: 'error',
      code: 'MT_HANDOFF_NO_SESSION',
      message: '宿主建会话成功但未返回 sessionId（无法注入摘要）',
    }
  }
  try {
    await capability.prompt(
      {
        requestId: options.requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: options.prompt }],
      },
      newAbortSignal(),
    )
  } catch (error) {
    return {
      status: 'error',
      code: errorCodeOf(error),
      message: `团队会话已创建（${sessionId}）但注入上下文摘要失败：${errorMessageOf(error)}（可手动粘贴摘要到该会话）`,
      sessionId,
    }
  }
  return { status: 'ok', sessionId }
}
