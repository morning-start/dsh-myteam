/**
 * 应用层的端口（Port）。
 *
 * 应用层只依赖这些接口，不知道文件、Cordis、DSH 或面板。实现放在
 * infrastructure，装配放在 composition——这样「换一个 EventStore」不需要改
 * 任何用例，也不会出现「应用层顺手拼了个路径」这种事。
 */
import type { EventEnvelope } from '../contracts/events.ts'
import type { IdKind } from '../contracts/ids.ts'

/** 时间端口：事件里的 occurredAt 必须来自这里，不能各写各的 new Date()。 */
export interface Clock {
  now(): string
}

/** 写者令牌：把「持有租约」这件事传进应用层，但不暴露锁的实现。 */
export interface WriteToken {
  projectId: string
  fencing: number
}

export interface EventStorePort {
  /** 严格读取已提交事件；日志损坏时抛错，不返回部分结果。 */
  readCommitted(): { events: EventEnvelope[]; nextSeq: number }
  /** durable 追加；失败时抛错，调用方不得把「返回失败」当成「可能写进去了」。 */
  append(events: readonly EventEnvelope[]): void
}

export interface WriterLockPort {
  acquire(projectId: string): WriteToken
  assert(token: WriteToken): void
  release(token: WriteToken): void
}

export interface LoggerPort {
  warn(message: string, details?: Record<string, unknown>): void
  error(message: string, details?: Record<string, unknown>): void
}

export interface IdPort {
  (kind: IdKind): string
}

export const systemClock: Clock = { now: () => new Date().toISOString() }

export const silentLogger: LoggerPort = {
  warn: () => undefined,
  error: () => undefined,
}

// —— 长期记忆端口 ——

export interface MemoryEntryRecord {
  id: string
  bankId: string
  text: string
  tags: string[]
  evidence: string[]
  revision: number
  createdAt: string
  updatedAt: string
  forgottenAt: string | null
}

export interface MemoryRememberInput {
  id: string
  bankId: string
  text: string
  tags?: string[]
  evidence?: string[]
  now: string
}

export interface MemoryRecallInput {
  bankId: string
  query?: string
  limit?: number
  includeForgotten?: boolean
}

export interface MemoryPort {
  remember(input: MemoryRememberInput): MemoryEntryRecord
  recall(input: MemoryRecallInput): MemoryEntryRecord[]
  get(bankId: string, id: string): MemoryEntryRecord
  forget(input: { bankId: string; id: string; reason: string; hard: boolean; now: string }): void
  close(): void
}