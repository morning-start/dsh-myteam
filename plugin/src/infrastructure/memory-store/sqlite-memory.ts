/**
 * 长期记忆：SQLite 唯一权威。
 *
 * 三条边界（docs/architecture/01 §11.2）：
 *   1. 记忆属于 **bank**，不属于会话；会话可以换绑，记忆不随之丢失；
 *   2. bank 所有权严格校验：成员只能读写自己的 bank，队长只能读写本团队的
 *      bank/成员 bank，跨 bank 的删除直接拒绝；
 *   3. 遗忘是软删除（`forgotten_at`），硬删除必须显式要求——「记错了」和
 *      「要求彻底抹掉」是两件事。
 *
 * 这里只管存储与约束，不做语义判断：什么该记、记忆是否过期，由用例与策展决定。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryEntryRecord, MemoryPort, MemoryRecallInput, MemoryRememberInput } from '../../application/ports.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'

const SCHEMA_VERSION = 1

export class SqliteMemoryStore implements MemoryPort {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL,
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        forgotten_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_bank ON memory_entries(bank_id, forgotten_at);
    `)
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('schemaVersion', String(SCHEMA_VERSION))
  }

  remember(input: MemoryRememberInput): MemoryEntryRecord {
    if (input.text.trim().length === 0) {
      fail(ERROR_CODES.INVALID_PAYLOAD, '记忆正文不能为空')
    }
    this.db
      .prepare(
        `INSERT INTO memory_entries (id, bank_id, text, tags_json, evidence_json, revision, created_at, updated_at, forgotten_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.bankId,
        input.text,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.evidence ?? []),
        input.now,
        input.now,
      )
    return this.get(input.bankId, input.id)
  }

  recall(input: MemoryRecallInput): MemoryEntryRecord[] {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
    const conditions = ['bank_id = ?']
    const params: unknown[] = [input.bankId]
    if (input.includeForgotten !== true) conditions.push('forgotten_at IS NULL')
    if (input.query !== undefined && input.query.trim().length > 0) {
      conditions.push('text LIKE ?')
      params.push(`%${input.query.trim()}%`)
    }
    params.push(limit)
    const rows = this.db
      .prepare(`SELECT * FROM memory_entries WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(params as never[])) as Record<string, unknown>[]
    return rows.map((row) => this.fromRow(row))
  }

  /** 按 id + bank 取一条；跨 bank 读取视为不存在（不泄漏别的 bank 有没有这条）。 */
  get(bankId: string, id: string): MemoryEntryRecord {
    const row = this.db.prepare('SELECT * FROM memory_entries WHERE id = ? AND bank_id = ?').get(id, bankId) as
      | Record<string, unknown>
      | undefined
    if (row === undefined) {
      fail(ERROR_CODES.NOT_FOUND, '记忆条目不存在（或不属于这个 bank）', { details: { id, bankId } })
    }
    return this.fromRow(row)
  }

  forget(input: { bankId: string; id: string; reason: string; hard: boolean; now: string }): void {
    const entry = this.get(input.bankId, input.id)
    if (input.hard) {
      this.db.prepare('DELETE FROM memory_entries WHERE id = ? AND bank_id = ?').run(input.id, input.bankId)
      return
    }
    if (entry.forgottenAt !== null) {
      fail(ERROR_CODES.CONFLICT, '记忆条目已经遗忘', { details: { id: input.id } })
    }
    this.db
      .prepare('UPDATE memory_entries SET forgotten_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND bank_id = ?')
      .run(input.now, input.now, input.id, input.bankId)
  }

  close(): void {
    this.db.close()
  }

  private fromRow(row: Record<string, unknown>): MemoryEntryRecord {
    return {
      id: String(row.id),
      bankId: String(row.bank_id),
      text: String(row.text),
      tags: JSON.parse(String(row.tags_json)) as string[],
      evidence: JSON.parse(String(row.evidence_json)) as string[],
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      forgottenAt: row.forgotten_at === null || row.forgotten_at === undefined ? null : String(row.forgotten_at),
    }
  }
}

/** bank id 规范见 contracts/memory.ts；这里只做存储。 */
export { bankBelongsTo, memberBankId, teamBankId } from '../../contracts/memory.ts'