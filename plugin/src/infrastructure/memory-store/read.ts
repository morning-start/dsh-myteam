/**
 * 长期记忆（SQLite）只读视图。
 *
 * 记忆是**项目内**的权威数据（`<ws>/.dsh-myteam/memory/memory.db`，v1 遗留在
 * `history/memory.db`），不属任何全局库，也不进事件日志。这里只读：不发号、
 * 不写、不改 schema；打不开或表缺失时如实写 warning，不冒充「没有记忆」。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 新版记忆库位置。 */
const MEMORY_DB = 'memory/memory.db'
/** v1 遗留位置（只读回退）。 */
const LEGACY_MEMORY_DB = 'history/memory.db'

export interface MemoryEntryView {
  id: string
  bankId: string
  text: string
  tags: string[]
  evidence: unknown[]
  revision: number
  createdAt: string
  updatedAt: string
  forgotten: boolean
}

export interface MemoryBankView {
  bankId: string
  /** 未遗忘的条目数（界面上「有多少条在用」）。 */
  live: number
  /** 含已遗忘的总数。 */
  total: number
  lastUpdated: string | null
}

export interface MemoryStoreView {
  /** 实际读的文件（相对项目根）；没找到时是首选路径。 */
  file: string
  exists: boolean
  banks: MemoryBankView[]
  entries: MemoryEntryView[]
  warnings: string[]
}

/**
 * 解析记忆库文件路径：先新布局，再 v1 遗留；都不存在时返回新布局路径。
 * @param rootDir - 项目根目录。
 */
export function memoryDbPath(rootDir: string): string {
  if (existsSync(join(rootDir, MEMORY_DB))) return MEMORY_DB
  if (existsSync(join(rootDir, LEGACY_MEMORY_DB))) return LEGACY_MEMORY_DB
  return MEMORY_DB
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return []
  try {
    return JSON.parse(text) as unknown
  } catch {
    return []
  }
}

/**
 * 读记忆库。
 * @param rootDir - 项目根目录。
 * @param options - `bankId` 只读一个 bank；`limit` 条目上限（1..200，默认 50）。
 * @returns 文件、bank 汇总、条目与 warning；库不存在时 `exists: false`。
 */
export function readMemoryStore(
  rootDir: string,
  options: { bankId?: string; limit?: number } = {},
): MemoryStoreView {
  const file = memoryDbPath(rootDir)
  const warnings: string[] = []
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200)
  const absolute = join(rootDir, file)
  if (!existsSync(absolute)) {
    return { file, exists: false, banks: [], entries: [], warnings }
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(absolute, { readOnly: true })
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'")
      .get() as { name?: string } | undefined
    if (table?.name === undefined) {
      warnings.push('memory_entries 表不存在（库文件可能不是记忆库）')
      return { file, exists: true, banks: [], entries: [], warnings }
    }

    const bankRows = db
      .prepare(
        `SELECT bank_id AS bankId,
                SUM(CASE WHEN forgotten_at IS NULL THEN 1 ELSE 0 END) AS live,
                COUNT(*) AS total,
                MAX(updated_at) AS lastUpdated
           FROM memory_entries GROUP BY bank_id ORDER BY bank_id`,
      )
      .all() as Record<string, unknown>[]
    const banks: MemoryBankView[] = bankRows.map((row) => ({
      bankId: String(row.bankId),
      live: Number(row.live ?? 0),
      total: Number(row.total ?? 0),
      lastUpdated: typeof row.lastUpdated === 'string' ? row.lastUpdated : null,
    }))

    const conditions: string[] = []
    const params: unknown[] = []
    if (options.bankId !== undefined && options.bankId.length > 0) {
      conditions.push('bank_id = ?')
      params.push(options.bankId)
    }
    params.push(limit)
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const entryRows = db
      .prepare(`SELECT * FROM memory_entries ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[]

    const entries: MemoryEntryView[] = entryRows.map((row) => ({
      id: String(row.id),
      bankId: String(row.bank_id),
      text: String(row.text ?? ''),
      tags: strings(parseJson(row.tags_json)),
      evidence: Array.isArray(parseJson(row.evidence_json)) ? (parseJson(row.evidence_json) as unknown[]) : [],
      revision: Number(row.revision ?? 0),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      forgotten: typeof row.forgotten_at === 'string',
    }))
    return { file, exists: true, banks, entries, warnings }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error))
    return { file, exists: true, banks: [], entries: [], warnings }
  } finally {
    db?.close()
  }
}