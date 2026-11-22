/**
 * 原子事件批次的帧格式与 hash 定义（纯字符串层，不做 IO）。
 *
 * 一个批次在日志里是 N+2 行：头帧、事件帧、提交帧。为什么不是「一个 JSON 对象
 * 装整个批次」：
 *
 *   - 提交帧在**最后**，它的存在本身就是「这一批已完整写入」的证据；
 *   - 只有头 + 事件 + 提交三者的 hash/数量/序号全部对齐，批次才构成 durable
 *     提交点；调用方有没有收到成功返回不影响这个事实；
 *   - 崩溃只会留下「没有提交帧的尾部」，恢复时能明确区分「未提交尾部」与
 *     「中间坏帧」，前者可显式隔离截断，后者必须停止整个项目写入。
 *
 * hash 口径固定为规范化 JSON（contracts/json.ts），因此同一批事件无论从哪个
 * 进程、以何种字段顺序构造，指纹一致。
 */
import type { EventEnvelope } from './events.ts'
import { hashContent } from './json.ts'
import { SCHEMA_VERSION } from './versions.ts'

export const BATCH_HEADER_KIND = 'myteam.batch'
export const BATCH_COMMIT_KIND = 'myteam.commit'

export interface BatchHeader {
  kind: typeof BATCH_HEADER_KIND
  schemaVersion: number
  projectId: string
  batchId: string
  firstSeq: number
  count: number
  eventsHash: string
}

export interface BatchCommit {
  kind: typeof BATCH_COMMIT_KIND
  schemaVersion: number
  projectId: string
  batchId: string
  firstSeq: number
  lastSeq: number
  count: number
  eventsHash: string
  batchHash: string
}

/** 批次内事件的聚合 hash；空批次不允许存在。 */
export function eventsHashOf(events: readonly EventEnvelope[]): string {
  return hashContent(events)
}

/**
 * 批次 hash：把「定位 + 数量 + 事件指纹」一起纳入。
 *
 * 只对事件本身取 hash 不够：同一批事件被复制到另一个 projectId、或换个
 * batchId 重放，事件 hash 仍然相同，但那已经不是一次合法提交。把定位字段
 * 纳入后，重复提交与跨项目搬运都会在校验时暴露。
 */
export function batchHashOf(input: {
  projectId: string
  batchId: string
  firstSeq: number
  lastSeq: number
  count: number
  eventsHash: string
}): string {
  return hashContent({
    schemaVersion: SCHEMA_VERSION,
    projectId: input.projectId,
    batchId: input.batchId,
    firstSeq: input.firstSeq,
    lastSeq: input.lastSeq,
    count: input.count,
    eventsHash: input.eventsHash,
  })
}

export interface EncodedBatch {
  header: BatchHeader
  commit: BatchCommit
  /** 头帧 + 事件帧（每行一个 JSON，含换行），不含提交帧。 */
  body: string
  /** 提交帧（含换行）。 */
  commitLine: string
  /** 完整字节 = body + commitLine。 */
  text: string
}

/**
 * 编码一个批次。
 *
 * 调用方必须已经为本批事件分配好连续 projectSeq（从 firstSeq 开始）。
 * 序号不连续、事件为空、projectId 混杂都直接抛错：这些错误在编码期发现，
 * 比写进日志后再由恢复逻辑判定「这条日志永远坏」便宜得多。
 */
export function encodeBatch(events: readonly EventEnvelope[]): EncodedBatch {
  if (events.length === 0) {
    throw new Error('事件批次不能为空')
  }

  const first = events[0]!
  const projectId = first.projectId
  const batchId = first.batchId
  const firstSeq = first.projectSeq

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.projectId !== projectId) {
      throw new Error(`批次内 projectId 不一致：${event.projectId} ≠ ${projectId}`)
    }
    if (event.batchId !== batchId) {
      throw new Error(`批次内 batchId 不一致：${event.batchId} ≠ ${batchId}`)
    }
    if (event.batchIndex !== index) {
      throw new Error(`batchIndex 必须从 0 连续：期望 ${index}，实际 ${event.batchIndex}`)
    }
    if (event.projectSeq !== firstSeq + index) {
      throw new Error(`projectSeq 必须连续：期望 ${firstSeq + index}，实际 ${event.projectSeq}`)
    }
  }

  const lastSeq = firstSeq + events.length - 1
  const eventsHash = eventsHashOf(events)
  const header: BatchHeader = {
    kind: BATCH_HEADER_KIND,
    schemaVersion: SCHEMA_VERSION,
    projectId,
    batchId,
    firstSeq,
    count: events.length,
    eventsHash,
  }
  const commit: BatchCommit = {
    kind: BATCH_COMMIT_KIND,
    schemaVersion: SCHEMA_VERSION,
    projectId,
    batchId,
    firstSeq,
    lastSeq,
    count: events.length,
    eventsHash,
    batchHash: batchHashOf({ projectId, batchId, firstSeq, lastSeq, count: events.length, eventsHash }),
  }

  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]
  const body = `${lines.join('\n')}\n`
  const commitLine = `${JSON.stringify(commit)}\n`
  return { header, commit, body, commitLine, text: `${body}${commitLine}` }
}

export function isBatchHeader(value: unknown): value is BatchHeader {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<BatchHeader>
  return (
    candidate.kind === BATCH_HEADER_KIND &&
    candidate.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.batchId === 'string' &&
    typeof candidate.firstSeq === 'number' &&
    typeof candidate.count === 'number' &&
    candidate.count > 0 &&
    typeof candidate.eventsHash === 'string'
  )
}

export function isBatchCommit(value: unknown): value is BatchCommit {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<BatchCommit>
  return (
    candidate.kind === BATCH_COMMIT_KIND &&
    candidate.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.batchId === 'string' &&
    typeof candidate.firstSeq === 'number' &&
    typeof candidate.lastSeq === 'number' &&
    typeof candidate.count === 'number' &&
    candidate.count > 0 &&
    typeof candidate.eventsHash === 'string' &&
    typeof candidate.batchHash === 'string'
  )
}

/**
 * 校验「头 + 事件 + 提交」三者自洽。
 *
 * 返回问题清单而不是抛错，因为恢复流程需要把问题写进报告，而不是在第一处
 * 不一致就丢掉后续诊断信息。
 */
export function verifyBatch(header: BatchHeader, events: readonly EventEnvelope[], commit: BatchCommit): string[] {
  const problems: string[] = []

  if (header.projectId !== commit.projectId) {
    problems.push(`projectId 不一致：header=${header.projectId} commit=${commit.projectId}`)
  }
  if (header.batchId !== commit.batchId) {
    problems.push(`batchId 不一致：header=${header.batchId} commit=${commit.batchId}`)
  }
  if (header.count !== events.length) {
    problems.push(`数量不一致：header=${header.count} 实际=${events.length}`)
  }
  if (commit.count !== events.length) {
    problems.push(`数量不一致：commit=${commit.count} 实际=${events.length}`)
  }
  if (commit.firstSeq !== header.firstSeq) {
    problems.push(`起始序号不一致：header=${header.firstSeq} commit=${commit.firstSeq}`)
  }
  if (commit.lastSeq !== header.firstSeq + events.length - 1) {
    problems.push(`结束序号不一致：commit=${commit.lastSeq} 期望=${header.firstSeq + events.length - 1}`)
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.projectSeq !== header.firstSeq + index) {
      problems.push(`第 ${index} 条事件 projectSeq=${event.projectSeq}，期望 ${header.firstSeq + index}`)
    }
    if (event.batchId !== header.batchId) {
      problems.push(`第 ${index} 条事件 batchId=${event.batchId}，期望 ${header.batchId}`)
    }
    if (event.batchIndex !== index) {
      problems.push(`第 ${index} 条事件 batchIndex=${event.batchIndex}`)
    }
  }

  const eventsHash = eventsHashOf(events)
  if (eventsHash !== header.eventsHash) {
    problems.push('事件 hash 与头帧不符')
  }
  if (eventsHash !== commit.eventsHash) {
    problems.push('事件 hash 与提交帧不符')
  }

  const expectedBatchHash = batchHashOf({
    projectId: header.projectId,
    batchId: header.batchId,
    firstSeq: header.firstSeq,
    lastSeq: commit.lastSeq,
    count: events.length,
    eventsHash,
  })
  if (expectedBatchHash !== commit.batchHash) {
    problems.push('批次 hash 不符')
  }

  return problems
}