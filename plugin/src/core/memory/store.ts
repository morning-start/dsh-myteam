/**
 * 成员长期记忆：SQLite 存储层（CHG-212，FR-6.1/6.2 的 persistence 面）。
 *
 * 为什么不再用 memory.md 做真相：成员改成 DSH 子代理后，会话是**子会话**、会被父级联释放，
 * 「记忆随文件跨会话保留」这件事必须由账本之外的一层持久化承担。ADR-010 决定用 workspace 级
 * SQLite（`history/memory.db`，`.gitignore` 已覆盖），借鉴 Hindsight 的三件事：
 *
 *   ① **bank**：记忆按作用域分仓（`team:<teamId>` / `member:<teamId>:<memberId>`）——
 *      召回永远落在单个仓里，不会把 A 队的坑喂给 B 队。
 *   ② **evidence 强制**（FR-6.2）：没有证据指针的记忆写不进去（`remember` 直接抛）。
 *      这是本插件比 Hindsight 更硬的一条：Hindsight 允许无出处观测，我们的审计要求可追溯。
 *   ③ **refine not overwrite**：新条目用 `supersedes` 指向旧条目，旧条目被归档而不是被删——
 *      召回默认只看活条目，历史仍可追溯（与知识库 `knowledge.revised` 同源语义）。
 *
 * 召回评分 = 匹配度 0.5 + 重要度 0.3 + 新鲜度 0.2（时间衰减 30 天半衰），三项都在 0..1，
 * 所以分数可解释、可测试；不做向量检索（本地无 embedding 服务，语义检索留给 Hindsight 服务版）。
 *
 * 中文检索：FTS5 用 `trigram` 分词（`unicode61` 对中文整段不切词，等于没有索引）。
 * trigram 要求查询长度 ≥ 3；更短的查询回退到 `LIKE` 扫描（有 bank 过滤 + limit，规模可控）。
 *
 * 纯函数/薄 IO：本文件不碰 ctx，host 负责取路径与并发口径（ADR-002 单写者仍在 host）。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { storeLayout } from '../workspace/layout.ts'

/** 记忆类型（与 Hindsight 的 observation/page 对应关系见文件头） */
export const MEMORY_KINDS = ['fact', 'decision', 'pitfall', 'convention', 'episode'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** 一条记忆 */
export interface MemoryEntry {
  id: string
  bankId: string
  kind: MemoryKind
  title: string
  body: string
  /** 证据指针（taskId / 账本 seq / 文件路径）；空值不允许入库 */
  evidence: string
  /** 1..5，召回评分用 */
  importance: number
  /** 写入者：`member:<memberId>` / `lead` / `human` / `import:<来源>` */
  source: string
  taskId?: string
  /** 本条取代的旧条目 id（refine not overwrite） */
  supersedes?: string
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export interface RememberInput {
  bankId: string
  kind: MemoryKind
  title: string
  body: string
  evidence: string
  importance?: number
  source: string
  taskId?: string
  supersedes?: string
}

export interface RecallQuery {
  bankId: string
  /** 关键词；空 = 按重要度/新鲜度取（不做全文匹配） */
  query?: string
  kind?: MemoryKind
  limit?: number
  /** 注入时钟（测试用） */
  now?: number
}

export interface MemoryHit extends MemoryEntry {
  score: number
}

export interface MemoryStats {
  bankId: string
  entries: number
  kinds: Partial<Record<MemoryKind, number>>
  lastWriteAt?: number
}

export interface MemoryStore {
  remember(input: RememberInput): MemoryEntry
  recall(query: RecallQuery): MemoryHit[]
  /** 归档（软删）；返回是否命中活条目 */
  forget(id: string, now?: number): boolean
  get(id: string): MemoryEntry | undefined
  stats(bankId: string): MemoryStats
  close(): void
}

/** 记忆库位置：`<ws>/.dsh-myteam/history/memory.db`（history/ 已 gitignore） */
export function memoryDbPath(projectRoot: string): string {
  return join(storeLayout(projectRoot).history, 'memory.db')
}

/** bank 命名（唯一入口，避免各处拼串拼歪） */
export function teamBankId(teamId: string): string {
  return `team:${teamId}`
}
export function memberBankId(teamId: string, memberId: string): string {
  return `member:${teamId}:${memberId}`
}

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS banks (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  member_id  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  bank_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  importance  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  task_id     TEXT,
  supersedes  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entries_bank ON entries(bank_id, archived_at, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body,
  content = 'entries',
  content_rowid = 'seq',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  INSERT INTO entries_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
`

/** 匹配词最小长度：trigram 索引对 <3 的查询不命中，走 LIKE */
const TRIGRAM_MIN = 3
/** 新鲜度半衰期（天） */
const FRESHNESS_HALF_LIFE_DAYS = 30

let seq = 0

/** 条目 id：`m-<毫秒36>-<进程内序号36>`（可排序、无碰撞、不需要 uuid 依赖） */
function nextId(now: number): string {
  seq = (seq + 1) % 0x10000
  return `m-${now.toString(36)}-${seq.toString(36)}`
}

function toEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id),
    bankId: String(row.bank_id),
    kind: String(row.kind) as MemoryKind,
    title: String(row.title),
    body: String(row.body),
    evidence: String(row.evidence),
    importance: Number(row.importance),
    source: String(row.source),
    ...(row.task_id === null || row.task_id === undefined ? {} : { taskId: String(row.task_id) }),
    ...(row.supersedes === null || row.supersedes === undefined ? {} : { supersedes: String(row.supersedes) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.archived_at === null || row.archived_at === undefined ? {} : { archivedAt: Number(row.archived_at) }),
  }
}

function assertBankId(bankId: string): void {
  if (!/^(team|member):[^:]+(:[^:]+)?$/.test(bankId)) {
    throw new Error(`invalid memory bank id "${bankId}"（期望 team:<teamId> 或 member:<teamId>:<memberId>）`)
  }
}

function ensureBank(db: DatabaseSync, bankId: string, now: number): void {
  const [, teamId, memberId] = bankId.split(':')
  db.prepare(
    'INSERT OR IGNORE INTO banks (id, scope, team_id, member_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(bankId, memberId === undefined ? 'team' : 'member', teamId, memberId ?? null, now)
}

/**
 * 打开（必要时创建）记忆库。
 * @param dbPath `memoryDbPath(projectRoot)` 的产物，或测试用的临时文件
 */
export function openMemoryStore(dbPath: string): MemoryStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)

  const insert = db.prepare(
    `INSERT INTO entries
      (id, bank_id, kind, title, body, evidence, importance, source, task_id, supersedes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const archive = db.prepare('UPDATE entries SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
  const byId = db.prepare('SELECT * FROM entries WHERE id = ?')
  const ftsSearch = db.prepare(
    `SELECT e.*, bm25(entries_fts) AS rank
       FROM entries_fts JOIN entries e ON e.seq = entries_fts.rowid
      WHERE entries_fts MATCH ? AND e.bank_id = ? AND e.archived_at IS NULL
      ORDER BY rank LIMIT ?`,
  )
  const likeSearch = db.prepare(
    `SELECT * FROM entries
      WHERE bank_id = ? AND archived_at IS NULL AND (title LIKE ? OR body LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`,
  )
  const recent = db.prepare(
    'SELECT * FROM entries WHERE bank_id = ? AND archived_at IS NULL ORDER BY importance DESC, updated_at DESC LIMIT ?',
  )
  const statsRows = db.prepare(
    'SELECT kind, COUNT(*) AS n FROM entries WHERE bank_id = ? AND archived_at IS NULL GROUP BY kind',
  )
  const statsMeta = db.prepare(
    'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM entries WHERE bank_id = ? AND archived_at IS NULL',
  )

  function scoreOf(entry: MemoryEntry, now: number, match: number): number {
    const ageDays = Math.max(0, (now - entry.updatedAt) / 86_400_000)
    const freshness = Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS)
    return Math.round((0.5 * match + 0.3 * (entry.importance / 5) + 0.2 * freshness) * 1000) / 1000
  }

  return {
    remember(input) {
      const now = Date.now()
      assertBankId(input.bankId)
      const title = input.title.trim()
      const body = input.body.trim()
      const evidence = input.evidence.trim()
      if (!title) throw new Error('memory entry requires a title')
      if (!body) throw new Error('memory entry requires a body')
      if (!evidence || evidence.toLowerCase() === 'none') {
        throw new Error('memory entry requires an evidence pointer (FR-6.2)：taskId / 账本 seq / 文件路径')
      }
      if (!MEMORY_KINDS.includes(input.kind)) {
        throw new Error(`unknown memory kind "${input.kind}"（允许：${MEMORY_KINDS.join(', ')}）`)
      }
      const importance = input.importance ?? 3
      if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
        throw new Error(`memory importance must be an integer in 1..5 (got ${String(input.importance)})`)
      }
      ensureBank(db, input.bankId, now)
      // refine not overwrite：被取代的旧条目归档（可追溯），新条目留 supersedes 指针
      if (input.supersedes !== undefined) {
        const old = byId.get(input.supersedes) as Record<string, unknown> | undefined
        if (old === undefined || old.archived_at !== null) {
          throw new Error(`supersedes target "${input.supersedes}" is not a live entry`)
        }
        archive.run(now, now, input.supersedes)
      }
      const id = nextId(now)
      insert.run(
        id,
        input.bankId,
        input.kind,
        title,
        body,
        evidence,
        importance,
        input.source,
        input.taskId ?? null,
        input.supersedes ?? null,
        now,
        now,
      )
      return toEntry(byId.get(id) as Record<string, unknown>)
    },

    recall(query) {
      const now = query.now ?? Date.now()
      const limit = Math.min(Math.max(query.limit ?? 8, 1), 50)
      const text = (query.query ?? '').trim()
      let rows: Record<string, unknown>[]
      let matchOf: (row: Record<string, unknown>) => number
      if (text.length === 0) {
        rows = recent.all(query.bankId, limit) as Record<string, unknown>[]
        matchOf = () => 0.5
      } else if (text.length >= TRIGRAM_MIN) {
        rows = ftsSearch.all(text, query.bankId, limit) as Record<string, unknown>[]
        // bm25 是「越小越相关」的负分（无下界）：用 1/(1+|rank|) 归一到 0..1
        matchOf = (row) => 1 / (1 + Math.abs(Number(row.rank ?? 0)))
      } else {
        const like = `%${text}%`
        rows = likeSearch.all(query.bankId, like, like, limit) as Record<string, unknown>[]
        matchOf = () => 0.8
      }
      const hits: MemoryHit[] = []
      for (const row of rows) {
        const entry = toEntry(row)
        if (query.kind !== undefined && entry.kind !== query.kind) continue
        hits.push({ ...entry, score: scoreOf(entry, now, matchOf(row)) })
      }
      hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      return hits.slice(0, limit)
    },

    forget(id, now = Date.now()) {
      const result = archive.run(now, now, id)
      return Number(result.changes) > 0
    },

    get(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined
      return row === undefined ? undefined : toEntry(row)
    },

    stats(bankId) {
      const kinds: Partial<Record<MemoryKind, number>> = {}
      for (const row of statsRows.all(bankId) as Record<string, unknown>[]) {
        kinds[String(row.kind) as MemoryKind] = Number(row.n)
      }
      const meta = statsMeta.get(bankId) as Record<string, unknown>
      return {
        bankId,
        entries: Number(meta.n),
        kinds,
        ...(meta.last === null || meta.last === undefined ? {} : { lastWriteAt: Number(meta.last) }),
      }
    },

    close() {
      db.close()
    },
  }
}
