/**
 * FR-16.4③ 证据指针解析（CHG-87 / M2-D 剩余）：`task:` / `file:` / `session:` 三类指针。
 *
 * 背景（docs/11 §数据模型、docs/04 §3.1）：证据指针从 v2.7 起就是**有类型**的
 * （`task:` / `file:` / `session:` 并列），但代码一直把它当任意字符串收下——
 * 于是「跨会话引用」这条落点（CHG-29 落点③：「证据指针第三类 `session:<id>`」）
 * 只存在于文档里，读不到、审计不了、面板也没法按类型渲染。
 *
 * 本模块只做**解析**（纯函数〔J1〕）；`session:` 指针被消费时落 `session.read`
 * 审计事件由 host 层负责（FR-16.4 边界：读取留痕）。
 *
 * 兼容纪律：**未知前缀不拒绝**（旧账本是任意字符串，拒绝会让历史条目全部变成非法）。
 * 未知 → `kind:'unknown'`，原样保留，面板按中性渲染。
 */

export type EvidencePointerKind = 'task' | 'file' | 'session' | 'seq' | 'unknown'

export interface EvidencePointer {
  /** 原始字符串（账本里存的形态，绝不改写） */
  raw: string
  /** 指针类型；无法识别 → 'unknown' */
  kind: EvidencePointerKind
  /** 去掉前缀后的值（taskId / 文件路径 / sessionId / 序号 / 原串） */
  value: string
}

/** 已知前缀（顺序无关：按 `:` 切第一段判定） */
const KNOWN_KINDS: ReadonlySet<string> = new Set(['task', 'file', 'session', 'seq'])

/**
 * 解析单条证据指针。
 *  - `task:task-3`            → { kind:'task', value:'task-3' }
 *  - `file:docs/schema.md#L12` → { kind:'file', value:'docs/schema.md#L12' }
 *  - `session:sess-abc`       → { kind:'session', value:'sess-abc' }
 *  - `seq:42`                 → { kind:'seq', value:'42' }
 *  - `task-k1`（v2.7 旧形态）  → { kind:'unknown', value:'task-k1' }
 *  - 空串                      → { kind:'unknown', value:'' }
 */
export function parseEvidencePointer(raw: unknown): EvidencePointer {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return { raw: text, kind: 'unknown', value: '' }
  const index = text.indexOf(':')
  if (index <= 0) return { raw: text, kind: 'unknown', value: text }
  const prefix = text.slice(0, index).toLowerCase()
  if (!KNOWN_KINDS.has(prefix)) return { raw: text, kind: 'unknown', value: text }
  return { raw: text, kind: prefix as EvidencePointerKind, value: text.slice(index + 1).trim() }
}

/** 批量解析（去重保序；非数组 → 空数组） */
export function evidenceRefsOf(evidence: unknown): EvidencePointer[] {
  if (!Array.isArray(evidence)) return []
  const seen = new Set<string>()
  const out: EvidencePointer[] = []
  for (const item of evidence) {
    const pointer = parseEvidencePointer(item)
    if (pointer.raw.length === 0 || seen.has(pointer.raw)) continue
    seen.add(pointer.raw)
    out.push(pointer)
  }
  return out
}

/** 是否跨会话引用（host 用它决定要不要落 `session.read` 审计） */
export function isSessionPointer(raw: unknown): boolean {
  return parseEvidencePointer(raw).kind === 'session'
}

/**
 * 指针合法性校验（拒绝式；null = 通过）。
 *
 * 只对**已知前缀**做值非空校验：`task:` 后面空着是无意义指针（写的人以为留了证据，
 * 实际什么都没指向）。未知前缀放行（兼容旧账本）。
 */
export function validateEvidencePointer(raw: unknown): { ok: false; code: string; message: string } | null {
  const pointer = parseEvidencePointer(raw)
  if (pointer.kind === 'unknown') return null
  if (pointer.value.length === 0) {
    return {
      ok: false,
      code: 'MT_KB_EVIDENCE_REQUIRED',
      message: `evidence pointer "${pointer.raw}" has an empty ${pointer.kind} value（前缀后必须给指针内容）`,
    }
  }
  return null
}
