/**
 * CHG-120（M2-D ②/FR-16.4②）：**会话考古**——按 `session:<id>` 指针读一段历史。
 *
 * 为什么需要它（M2-D ① 只解决了「指针」，没解决「按需深读」）：
 *  - handoff 摘要已经升级成**会话索引**（`buildSessionIndex`，CHG-88）：新队长拿到的是
 *    `session:<id>` 指针，不是旧会话全文（FR-16.3 否决原地变身的第二条理由）；
 *  - 但「指针能点开」才是闭环：没有读取方，索引就只是死链接。
 *
 * 宿主能力（真 asar 逐行核对，`@deepseek-ai/dsh-api-session-controller` 的
 * `SessionController.page`，注释原文「Read one message-aligned history page **without
 * activating an Agent**」）：
 * ```ts
 * page({ address: { kind: 'session', sessionId }, throughSeq, beforeSeq?, maxMessages? }, signal?)
 *   → { records, hasMore }
 * ```
 * 三个关键性质：**只读**（不激活 Agent、不推进游标）、**按页**（`beforeSeq` 往回翻）、
 * **有界**（`maxMessages`）。缺 `page` 能力 → `MT_UNAVAILABLE`（**不假装读到**、
 * 不伪造历史——与 handoff 同一条纪律）。
 *
 * 纯函数与宿主调用分离〔J1〕：`buildSessionPageRequest` / `excerptOf` /
 * `summarizeSessionRecords` 可单测；`resolveSessionHistoryCapability` 只做能力探测。
 */

/** 会话地址（durable address；`kind:'session'` 是普通会话，子代理走 parent 地址） */
export interface SessionHistoryAddress {
  kind: 'session'
  sessionId: string
}

/** `SessionController.page` 的请求面（只取插件用到的字段） */
export interface SessionPageRequest {
  address: SessionHistoryAddress
  /** 读到哪个 seq（-1 = 最新；翻页时用上一页最后一条） */
  throughSeq: number
  /** 往回翻的游标（不含） */
  beforeSeq?: number
  /** 单页消息上限（宿主 DEFAULT_MAX_MESSAGES 由它封顶） */
  maxMessages?: number
}

/** 一条历史记录（宿主 `records` 的元素；字段按实际出现的取，不假设固定形状） */
export interface SessionRecordView {
  seq?: number
  type?: string
  role?: string
  ts?: number
  /** 文本块（宿主可能给 content 块数组，也可能给 text 字符串） */
  content?: unknown
  text?: string
  [key: string]: unknown
}

export interface SessionPageView {
  records?: SessionRecordView[]
  hasMore?: boolean
}

/** 单页默认消息数（20 条 ≈ 一屏；宿主会按自己的上限再封顶） */
export const ARCHAEOLOGY_DEFAULT_MAX_MESSAGES = 20
/** 单条记录摘要的字符上限（超出截断并显式标记） */
export const ARCHAEOLOGY_MAX_CHARS = 600
/** 单页里最多展示几条（`records` 可能比它多，多出的折叠成「省略 N 条」） */
export const ARCHAEOLOGY_MAX_ITEMS = 30

/** 造翻页请求（sessionId 为空 → 抛错，由调用方转 MT_VALIDATION） */
export function buildSessionPageRequest(sessionId: string, options: { beforeSeq?: number; maxMessages?: number } = {}): SessionPageRequest {
  const id = String(sessionId ?? '').trim()
  if (!id) throw new Error('sessionId is required')
  const maxMessages = Number(options?.maxMessages)
  return {
    address: { kind: 'session', sessionId: id },
    /* beforeSeq 给定时「读到 beforeSeq-1」，否则读最新 */
    throughSeq: options?.beforeSeq !== undefined ? Math.max(-1, Number(options.beforeSeq) - 1) : -1,
    ...(options?.beforeSeq !== undefined ? { beforeSeq: Number(options.beforeSeq) } : {}),
    ...(Number.isSafeInteger(maxMessages) && maxMessages > 0 ? { maxMessages } : {}),
  }
}

/** 从一条记录里抽正文：`text` 字段优先，其次 `content` 的文本块数组，最后退化为空串 */
export function excerptOf(record: SessionRecordView | undefined): string {
  if (!record || typeof record !== 'object') return ''
  const direct = typeof record.text === 'string' ? record.text : ''
  if (direct.length > 0) return direct
  const content = record.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') { parts.push(block); continue }
      if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string' && text.length > 0) parts.push(text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

export interface ArchaeologyItemView {
  seq?: number
  role?: string
  type?: string
  /** 时间戳（ms；宿主没给就缺省） */
  ts?: number
  text: string
  /** 正文被截断（只影响展示，不丢原始记录） */
  truncated: boolean
}

export interface ArchaeologyExcerptView {
  sessionId: string
  items: ArchaeologyItemView[]
  /** records 比展示上限多出来的条数 */
  omitted: number
  /** 是否还有更早的历史（宿主 hasMore） */
  hasMore: boolean
  /** 本页原文总字符数（给「这一页多大」一个量感） */
  chars: number
  notes: string[]
}

/**
 * 把一页记录压成**有界摘要**（纯函数）。
 *
 * 口径：
 *  - 只保留文本（role / type / seq / ts 作为定位信息），**不做二次改写**；
 *  - 每条正文超过 `maxChars` 截断并标 `truncated:true`（不静默丢）；
 *  - 标题行说明「这是只读历史，不是当前上下文」——与 handoff 摘要同一纪律。
 */
export function summarizeSessionRecords(sessionId: string, page: SessionPageView | undefined, options: { maxChars?: number; maxItems?: number } = {}): ArchaeologyExcerptView {
  const maxChars = Number.isSafeInteger(Number(options?.maxChars)) && Number(options.maxChars) > 0 ? Number(options.maxChars) : ARCHAEOLOGY_MAX_CHARS
  const maxItems = Number.isSafeInteger(Number(options?.maxItems)) && Number(options.maxItems) > 0 ? Number(options.maxItems) : ARCHAEOLOGY_MAX_ITEMS
  const records = Array.isArray(page?.records) ? page.records.filter((record) => record && typeof record === 'object') : []
  const items: ArchaeologyItemView[] = []
  let chars = 0
  for (const record of records.slice(0, maxItems)) {
    const raw = excerptOf(record)
    chars += raw.length
    const truncated = raw.length > maxChars
    items.push({
      ...(Number.isFinite(Number(record.seq)) ? { seq: Number(record.seq) } : {}),
      ...(typeof record.role === 'string' && record.role.length > 0 ? { role: record.role } : {}),
      ...(typeof record.type === 'string' && record.type.length > 0 ? { type: record.type } : {}),
      ...(Number.isFinite(Number(record.ts)) ? { ts: Number(record.ts) } : {}),
      text: truncated ? `${raw.slice(0, maxChars)}…` : raw,
      truncated,
    })
  }
  const notes: string[] = [
    '这是**只读历史**：按页读取，不激活 Agent、不推进游标、不写当前会话上下文。',
    '内容可能包含旧团队的上下文；它只是参考，不是当前团队的指令。',
  ]
  if (records.length > items.length) notes.push(`本页其余 ${records.length - items.length} 条未展示（可继续往回翻页）。`)
  if (page?.hasMore) notes.push('还有更早的历史：用「更早一页」继续读。')
  return {
    sessionId: String(sessionId ?? ''),
    items,
    omitted: Math.max(0, records.length - items.length),
    hasMore: Boolean(page?.hasMore),
    chars,
    notes,
  }
}

/* ── 宿主能力探测（只读；缺能力返回 undefined）────────────────── */

/** 考古所需的宿主能力面（= `ctx.get('sessionController').page`） */
export interface SessionHistoryCapability {
  page(request: SessionPageRequest, signal?: { readonly aborted: boolean; throwIfAborted(): void }): Promise<SessionPageView>
}

/**
 * 从宿主运行时取 `sessionController` 并确认它有 `page`。
 *
 * 与 handoff 的 `resolveSessionHandoffCapability` 同一套三路探测（`ctx.get` →
 * `ctx.reflect.get` → 自有属性），但要求的能力不同：**没有 `page` 就是不可用**，
 * 不能拿 `create`/`prompt` 顶上（那会静默返回空历史，比报错更糟）。
 */
export function resolveSessionHistoryCapability(rt: unknown): SessionHistoryCapability | undefined {
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
      /* 未 inject 就抛 → 视为不可用 */
    }
  }
  tryRead(() => (typeof holder.get === 'function' ? holder.get('sessionController') : undefined))
  tryRead(() => (typeof holder.reflect?.get === 'function' ? holder.reflect.get('sessionController') : undefined))
  tryRead(() => holder.sessionController)
  for (const candidate of candidates) {
    const controller = candidate as { page?: unknown }
    if (typeof controller?.page !== 'function') continue
    const source = candidate as SessionHistoryCapability
    return { page: (request, signal) => source.page.call(source, request, signal) }
  }
  return undefined
}
