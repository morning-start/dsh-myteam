/**
 * T18（FR-17，v2.5）+ M2-0c（FR-17.2/17.4 v2.7 Hindsight 语义增强，CHG-21/28）。
 *
 * 三层记忆中的 ② 团队知识库：`.dsh-myteam/config/knowledge/<topic>.md` + index.json。
 * 硬规则（PRD §5.17）：
 *   - 每条必带 evidence（E8）与 contributor（E9）；无 evidence → `unverified` 标记；
 *   - 注入分层：索引常驻（≤40 行预算，config knowledge.indexBudget）+ 条目按需读（绝不全文倾倒）；
 *   - 沉淀 = 策展制：成员无写入口，只能经 done 申报 knowledgeDraft → 队长采纳入库
 *     （账本 knowledge.proposed / knowledge.adopted）；不建全自动记忆。
 * v2.7 语义（借鉴 Hindsight，不引入其基础设施）：
 *   - 多证据数组 + proofCount（巩固时引文计数）；
 *   - 演化式修订（refine not overwrite）：refine/contradict 走 reviseEntry——「演化」节记录轨迹，
 *     矛盾不静默改写只标 staleSince 待复核；账本 knowledge.revised 落 diff 摘要；
 *   - staleness 触达（freshness 轻量版）：任务 done 时 host 比对任务 tags × 条目 tags，触及写 staleSince；
 *   - 提案关系声明（观察巩固的提案版）：relation new|refine|contradict + host tags 匹配给候选；
 *   - index 注入按 audience 过滤（软约束：无 audience 条目全员可见）。
 * 纯函数 + 文件 IO 分离〔J1〕。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { storeLayout } from '../workspace/layout.ts'

export const INDEX_BUDGET_LINES = 40

/** 提案关系声明（v2.7 观察巩固语义，FR-17.4） */
export const KNOWLEDGE_RELATIONS = ['new', 'refine', 'contradict'] as const
export type KnowledgeRelation = (typeof KNOWLEDGE_RELATIONS)[number]

export interface KnowledgeEntry {
  id: string
  title: string
  tags: string[]
  audience: string[]
  /** 证据指针数组（v2.7）：task:/file:/session: 前缀；旧单指针文件兼容 → [scalar] */
  evidence: string[]
  contributor?: string
  updated: string
  /** 无证据指针 → unverified（场景 32） */
  unverified: boolean
  core: boolean
  /** v2.7：staleness 标记（任务证据触及 tags 写入日期；复核采纳 refine 后清除） */
  staleSince?: string
  /** v2.7：独立证据数 = evidence.length（frontmatter 显式值取 max，防手改倒退） */
  proofCount: number
  body: string
}

export interface KnowledgeIndexItem {
  id: string
  title: string
  tags: string[]
  updated: string
  unverified: boolean
  core: boolean
  /** v2.7：staleness 徽标 + proofCount 进派生缓存（FR-17.2 v2.7） */
  staleSince?: string
  proofCount: number
  /** v2.7：受众面（空 = 全员可见；renderIndexSection audience 软过滤用） */
  audience: string[]
  words: number
}

/** CHG-98（审计 A7）：错误码走单一来源 `core/errors.ts`，拼错在编译期就被拦住。 */
import type { MtCode } from '../errors.ts'

export class KnowledgeError extends Error {
  code: MtCode
  constructor(code: MtCode, message: string) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

/* ── frontmatter 解析（纯函数）──────────────────────────────── */

/** 解析 YAML-lite frontmatter（键: 值；tags/audience 为 [a, b] 行内数组；
 *  v2.7：evidence 等多值字段支持多行 `- item` 列表（PRD FR-17.2 v2.7 形态）） */
export function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new KnowledgeError('MT_KB_CORRUPT', 'knowledge entry missing frontmatter block')
  const meta: Record<string, string | string[]> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const [, key, rawValue] = kv
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      meta[key] = rawValue.slice(1, -1).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      continue
    }
    // 多行列表：`key:` 空值，后续缩进 `- item` 行
    if (rawValue.length === 0 && i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
      const items: string[] = []
      let j = i + 1
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, '').trim())
        j++
      }
      meta[key] = items
      i = j - 1
      continue
    }
    meta[key] = rawValue.trim()
  }
  return { meta, body: match[2] }
}

/** 证据指针归一化：标量 → [标量]（旧单指针文件兼容）；数组透传 */
function normalizeEvidence(meta: Record<string, string | string[]>): string[] {
  const v = meta.evidence
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function asStaleSince(meta: Record<string, string | string[]>): string | undefined {
  const v = meta.staleSince
  if (v === undefined) return undefined
  const s = Array.isArray(v) ? String(v[0] ?? '') : String(v)
  return s.length > 0 && s !== 'null' ? s : undefined
}

export function entryFromMarkdown(raw: string, expectedId?: string): KnowledgeEntry {
  const { meta, body } = parseFrontmatter(raw)
  const id = String(meta.id ?? '')
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
    throw new KnowledgeError('MT_KB_CORRUPT', `knowledge entry id "${id}" invalid`)
  }
  if (expectedId && id !== expectedId) {
    throw new KnowledgeError('MT_KB_CORRUPT', `frontmatter id "${id}" != filename id "${expectedId}"`)
  }
  const title = String(meta.title ?? id)
  if (title.trim().length === 0) throw new KnowledgeError('MT_KB_CORRUPT', `entry "${id}" missing title`)
  const evidence = normalizeEvidence(meta)
  const explicitProof = Number(meta.proofCount)
  const proofCount = Number.isFinite(explicitProof)
    ? Math.max(Math.trunc(explicitProof), evidence.length)
    : evidence.length
  return {
    id,
    title,
    tags: (meta.tags as string[]) ?? [],
    audience: (meta.audience as string[]) ?? [],
    evidence,
    contributor: meta.contributor ? String(meta.contributor) : undefined,
    updated: String(meta.updated ?? ''),
    unverified: evidence.length === 0,
    core: meta.core === 'true',
    staleSince: asStaleSince(meta),
    proofCount,
    body,
  }
}

export function entryToMarkdown(entry: KnowledgeEntry): string {
  // evidence：多指针用多行列表（PRD FR-17.2 v2.7 形态）；单指针保持行内（旧文件可读性）
  const evidenceLines =
    entry.evidence.length === 0
      ? []
      : entry.evidence.length === 1
        ? [`evidence: ${entry.evidence[0]}`]
        : ['evidence:', ...entry.evidence.map((e) => `  - ${e}`)]
  const lines = [
    '---',
    `id: ${entry.id}`,
    `title: ${entry.title}`,
    `tags: [${entry.tags.join(', ')}]`,
    `audience: [${entry.audience.join(', ')}]`,
    ...evidenceLines,
    ...(entry.contributor ? [`contributor: ${entry.contributor}`] : []),
    ...(entry.proofCount > 0 ? [`proofCount: ${entry.proofCount}`] : []),
    `updated: ${entry.updated}`,
    `core: ${entry.core}`,
    ...(entry.staleSince ? [`staleSince: ${entry.staleSince}`] : []),
    '---',
    entry.body.replace(/\s+$/, ''),
    '',
  ]
  return lines.join('\n')
}

/* ── 索引与注入（纯函数）────────────────────────────────────── */

export function buildIndex(entries: KnowledgeEntry[]): KnowledgeIndexItem[] {
  return entries
    .map((e) => ({
      id: e.id,
      title: e.title,
      tags: e.tags,
      updated: e.updated,
      unverified: e.unverified,
      core: e.core,
      staleSince: e.staleSince,
      proofCount: e.proofCount,
      audience: e.audience ?? [],
      words: e.body.split(/\s+/).filter(Boolean).length + e.body.split(/[^\x00-\x7F]/).length - 1,
    }))
    .sort((a, b) => (a.core === b.core ? a.id.localeCompare(b.id) : a.core ? -1 : 1)) // core 小集排前
}

/** 索引层注入文本（常驻提示词段）；超预算 → 告警并截断（场景 31 的告警分支）。
 *  v2.7：opts.audience 过滤（软约束：无 audience 条目全员可见）+ stale 待复核徽标。 */
export function renderIndexSection(
  index: KnowledgeIndexItem[],
  opts: { budgetLines?: number; audience?: string } = {},
): { text: string; truncated: boolean } {
  const budgetLines = opts.budgetLines ?? INDEX_BUDGET_LINES
  const visible = opts.audience
    ? index.filter((e) => e.audience.length === 0 || e.audience.includes(opts.audience!))
    : index
  const header = [
    '## 团队知识库索引',
    '遇到下列主题时，先用 myteam_read_knowledge(id) 读取对应条目（按需读，勿凭印象）：',
    '',
  ]
  const rows = visible.map((e) => {
    const mark = e.core ? '[core] ' : e.unverified ? '[unverified] ' : e.staleSince ? '[stale 待复核] ' : ''
    return `- ${mark}${e.id} · ${e.title} · tags: ${e.tags.join('/') || '-'}`
  })
  const budget = budgetLines - header.length
  const truncated = rows.length > budget
  const used = truncated ? rows.slice(0, Math.max(0, budget)) : rows
  const tail = truncated ? ['', `(索引超预算：${rows.length} 条仅显示前 ${used.length} 条，请精简条目或提高 knowledge.indexBudget)`] : []
  return { text: [...header, ...used, ...tail].join('\n'), truncated }
}

/* ── 提案 → 采纳/修订（沉淀流，纯判定 + 纯函数）──────────────── */

export interface KnowledgeDraft {
  id: string
  title: string
  tags: string[]
  body: string
  /** 证据指针 = 任务 id / 账本 seq / 文件路径 / session:<id>（成员提案时 = 任务 id） */
  evidence: string
  core?: boolean
  /** v2.7：对既有条目的关系声明（观察巩固）；缺省 = new */
  relation?: KnowledgeRelation
  /** v2.7：refine/contradict 的目标条目 id（缺省取 draft.id） */
  targetId?: string
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** 成员 done 申报附带的 knowledgeDraft 校验（FR-17.4：提案必带证据=任务 id；
 *  v2.7：refine/contradict 必须可解析出目标条目 id） */
export function validateDraft(draft: KnowledgeDraft): { ok: boolean; code?: string; message?: string } {
  if (!ID_RE.test(draft.id)) return { ok: false, code: 'MT_KB_INVALID', message: 'draft id invalid' }
  if (!draft.title?.trim()) return { ok: false, code: 'MT_KB_INVALID', message: 'draft title required' }
  if (!draft.body?.trim()) return { ok: false, code: 'MT_KB_INVALID', message: 'draft body required' }
  if (!draft.evidence?.trim()) return { ok: false, code: 'MT_KB_EVIDENCE_REQUIRED', message: 'draft requires evidence pointer (task id / seq / path)' }
  if (draft.relation !== undefined && !KNOWLEDGE_RELATIONS.includes(draft.relation)) {
    return { ok: false, code: 'MT_KB_INVALID', message: `draft relation must be one of ${KNOWLEDGE_RELATIONS.join('|')}` }
  }
  if ((draft.relation === 'refine' || draft.relation === 'contradict') && !ID_RE.test(draft.targetId ?? draft.id)) {
    return { ok: false, code: 'MT_KB_TARGET_REQUIRED', message: `${draft.relation} proposal requires a valid targetId (existing entry)` }
  }
  return { ok: true }
}

/** 队长采纳（new 关系）：draft → 项目库条目（contributor 归因 = 提案成员）；同 id 已存在 → 拒绝（不静默覆盖）。
 *  v2.7：refine/contradict 走 reviseEntry（演化式修订），此处拒绝。 */
export function adoptDraft(draft: KnowledgeDraft, proposer: string, existingIds: Set<string>, now: string): KnowledgeEntry {
  const check = validateDraft(draft)
  if (!check.ok) throw new KnowledgeError(check.code!, check.message!)
  if (draft.relation === 'refine' || draft.relation === 'contradict') {
    throw new KnowledgeError('MT_KB_RELATION_MISMATCH', `${draft.relation} proposal revises an existing entry; use reviseEntry`)
  }
  if (existingIds.has(draft.id)) {
    throw new KnowledgeError('MT_KB_EXISTS', `knowledge entry "${draft.id}" already exists; edit the file directly to update`)
  }
  return {
    id: draft.id,
    title: draft.title,
    tags: draft.tags ?? [],
    audience: [],
    evidence: [draft.evidence],
    contributor: proposer,
    updated: now,
    unverified: false, // 提案带证据 → 非 unverified
    core: draft.core ?? false,
    proofCount: 1,
    body: draft.body,
  }
}

/** 演化节维护：条目正文尾部的「## 演化」节，每次修订追加一行轨迹（账本 knowledge.revised 为权威流，
 *  正文节是随文件走的人读轨迹——FR-17.5 演化时间线以账本为准）。 */
function appendEvolution(body: string, line: string): string {
  const trimmed = body.replace(/\s+$/, '')
  if (/^##\s*演化\s*$/m.test(trimmed)) return `${trimmed}\n${line}\n`
  return `${trimmed}\n\n## 演化\n\n${line}\n`
}

/** v2.7 演化式修订（Hindsight：refine not overwrite）：refine = 精炼既有条目（强化/扩展），
 *  contradict = 矛盾证据记录轨迹（不静默改写原断言，条目标 staleSince 待复核）。
 *  场景 33：队长复核采纳 refine → 条目更新（演化节记录轨迹）、proofCount 增、staleSince 清除。 */
export function reviseEntry(
  existing: KnowledgeEntry,
  draft: KnowledgeDraft,
  proposer: string,
  now: string,
): { entry: KnowledgeEntry; diffSummary: string } {
  const check = validateDraft(draft)
  if (!check.ok) throw new KnowledgeError(check.code!, check.message!)
  if (draft.relation !== 'refine' && draft.relation !== 'contradict') {
    throw new KnowledgeError('MT_KB_RELATION_MISMATCH', 'reviseEntry expects relation refine|contradict')
  }
  const targetId = draft.targetId ?? draft.id
  if (targetId !== existing.id) {
    throw new KnowledgeError('MT_KB_TARGET_MISMATCH', `proposal targets "${targetId}" but entry is "${existing.id}"`)
  }
  const relation = draft.relation
  const pointer = draft.evidence.trim()
  const evidence = existing.evidence.includes(pointer) ? [...existing.evidence] : [...existing.evidence, pointer]
  const line = `- ${now.slice(0, 10)} · ${proposer} · ${relation} · 证据 ${pointer}：${draft.title}`
  const entry: KnowledgeEntry = {
    ...existing,
    evidence,
    proofCount: Math.max(existing.proofCount, evidence.length),
    updated: now.slice(0, 10),
    // refine = 复核通过 → 清除待复核；contradict = 矛盾 → 标待复核（提示而非改写，策展制不变）
    staleSince: relation === 'refine' ? undefined : now.slice(0, 10),
    body: appendEvolution(existing.body, line),
  }
  const diffSummary = `${relation} · ${existing.id} · +evidence:${pointer} · by ${proposer}`
  return { entry, diffSummary }
}

/** v2.7 staleness 触达（纯函数）：任务 done 时 host 比对任务 tags × 条目 tags，
 *  触及即在 staleSince 写入日期（结构性提示，不自动改写——R27 缓解）。 */
export function touchStale(entries: KnowledgeEntry[], taskTags: string[], now: string): KnowledgeEntry[] {
  const tags = new Set(taskTags.filter((t) => typeof t === 'string' && t.length > 0))
  if (tags.size === 0) return []
  return entries
    .filter((e) => e.tags.some((t) => tags.has(t)))
    .map((e) => ({ ...e, staleSince: now.slice(0, 10) }))
}

/** v2.7 提案候选（半自动巩固的"自动找靶"）：host 依 draft tags 匹配既有条目给出候选，
 *  关系由成员/队长定夺（"自动找靶、人来定夺"）。 */
export function candidatesForDraft(
  entries: KnowledgeEntry[],
  draftTags: string[],
): { id: string; title: string; shared: string[] }[] {
  const tags = new Set(draftTags.filter((t) => typeof t === 'string' && t.length > 0))
  if (tags.size === 0) return []
  return entries
    .map((e) => ({ id: e.id, title: e.title, shared: e.tags.filter((t) => tags.has(t)) }))
    .filter((c) => c.shared.length > 0)
}

/* ── 文件 IO（host 进程内，R26）──────────────────────────────── */

export function knowledgeDirOf(workspaceRoot: string): string {
  return storeLayout(workspaceRoot).knowledge
}

export function listKnowledge(dir: string): KnowledgeEntry[] {
  if (!existsSync(dir)) return []
  const out: KnowledgeEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name === 'index.json') continue
    const expectedId = name.slice(0, -3)
    out.push(entryFromMarkdown(readFileSync(join(dir, name), 'utf8'), expectedId))
  }
  return out
}

export function readKnowledgeEntry(dir: string, id: string): KnowledgeEntry | undefined {
  const p = join(dir, `${id}.md`)
  if (!existsSync(p)) return undefined
  return entryFromMarkdown(readFileSync(p, 'utf8'), id)
}

export function writeKnowledgeEntry(dir: string, entry: KnowledgeEntry): { filePath: string } {
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${entry.id}.md`)
  writeFileSync(filePath, entryToMarkdown(entry), 'utf8')
  const index = buildIndex(listKnowledge(dir))
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return { filePath }
}
