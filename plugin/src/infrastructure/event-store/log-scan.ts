/**
 * 事件日志扫描与损坏分类（纯函数，不做 IO）。
 *
 * 恢复的核心判断是三个互斥结论：
 *
 *   clean      末尾是完整 commit record；可以直接追加
 *   torn-tail  尾部字节按协议**不可能**构成完整批次（崩溃留下的半截写）；
 *              这是唯一允许修复截断的情况，且必须显式执行并留报告
 *   corrupt    中间坏帧、hash/数量/序号不符、commit 后还有无法解释的数据；
 *              必须停止整个项目的业务写入并转人工，不得跳过或截断
 *
 * 「torn 还是 corrupt」不能靠「能不能解析成 JSON」判断：一段被截断的 JSON
 * 和一段被篡改的 JSON 都解析失败。这里按**协议可能性**判断——尾部是不是
 * 某个合法批次编码的前缀。是前缀才是撕裂，否则就是损坏。
 */
import type { BatchCommit, BatchHeader } from '../../contracts/batch.ts'
import { isBatchCommit, isBatchHeader, verifyBatch } from '../../contracts/batch.ts'
import type { EventEnvelope } from '../../contracts/events.ts'
import { EVENT_TYPES } from '../../contracts/events.ts'
import { SCHEMA_VERSION } from '../../contracts/versions.ts'

export interface ScannedBatch {
  header: BatchHeader
  commit: BatchCommit
  events: EventEnvelope[]
  /** 头帧起始字节偏移。 */
  startOffset: number
  /** 提交帧结束（含换行）后的字节偏移。 */
  endOffset: number
}

export interface ScanIssue {
  offset: number
  /** 从 1 开始的行号，便于人工在编辑器里定位。 */
  line: number
  reason: string
}

export interface LogScan {
  batches: ScannedBatch[]
  bytes: number
  /** 尾部可修复字节；仅当 `corruption === null` 时可能非空。 */
  tornTail: { offset: number; bytes: number; reason: string } | null
  corruption: ScanIssue | null
}

interface SourceLine {
  text: string
  offset: number
  /** 该行是否以换行结束（最后一行可能是半截写）。 */
  complete: boolean
  number: number
}

function splitLines(buffer: Buffer): SourceLine[] {
  const lines: SourceLine[] = []
  let offset = 0
  let number = 1
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset)
    if (newline === -1) {
      lines.push({ text: buffer.toString('utf8', offset), offset, complete: false, number })
      break
    }
    lines.push({ text: buffer.toString('utf8', offset, newline), offset, complete: true, number })
    offset = newline + 1
    number += 1
  }
  return lines
}

function parseJsonLine(text: string): unknown {
  return JSON.parse(text) as unknown
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<EventEnvelope>
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.eventId === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.projectSeq === 'number' &&
    typeof candidate.batchId === 'string' &&
    typeof candidate.batchIndex === 'number' &&
    typeof candidate.type === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(candidate.type) &&
    typeof candidate.payload === 'object'
  )
}

/**
 * 扫描整份日志。
 *
 * 不做「遇到坏帧就跳过继续读」：一旦中间有坏帧，后续字节的归属就无法证明，
 * 继续读出来的投影是不可信的。宁可给出明确损坏位置，也不返回看似正常的视图。
 */
export function scanLog(buffer: Buffer): LogScan {
  const lines = splitLines(buffer)
  const batches: ScannedBatch[] = []

  let pendingHeader: BatchHeader | null = null
  let pendingEvents: EventEnvelope[] = []
  let pendingStart = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    let parsed: unknown
    try {
      parsed = parseJsonLine(line.text)
    } catch (error) {
      const reason = `无法解析 JSON：${error instanceof Error ? error.message : String(error)}`
      if (pendingHeader === null) {
        return { batches, bytes: buffer.length, tornTail: null, corruption: { offset: line.offset, line: line.number, reason } }
      }
      // 半截 JSON（最后一行且没有换行）才是撕裂；完整行解析失败是损坏。
      if (!line.complete && index === lines.length - 1) {
        return torn(batches, buffer.length, pendingStart, `批次尾部不完整（${reason}）`)
      }
      return { batches, bytes: buffer.length, tornTail: null, corruption: { offset: line.offset, line: line.number, reason } }
    }

    if (pendingHeader === null) {
      if (!isBatchHeader(parsed)) {
        return {
          batches,
          bytes: buffer.length,
          tornTail: null,
          corruption: { offset: line.offset, line: line.number, reason: '期望批次头帧，实际不是' },
        }
      }
      pendingHeader = parsed
      pendingEvents = []
      pendingStart = line.offset
      continue
    }

    if (isBatchCommit(parsed)) {
      const problems = verifyBatch(pendingHeader, pendingEvents, parsed)
      if (problems.length > 0) {
        return {
          batches,
          bytes: buffer.length,
          tornTail: null,
          corruption: {
            offset: line.offset,
            line: line.number,
            reason: `批次校验失败：${problems.join('；')}`,
          },
        }
      }
      batches.push({
        header: pendingHeader,
        commit: parsed,
        events: pendingEvents,
        startOffset: pendingStart,
        endOffset: line.offset + Buffer.byteLength(line.text, 'utf8') + 1,
      })
      pendingHeader = null
      pendingEvents = []
      continue
    }

    if (isBatchHeader(parsed)) {
      return {
        batches,
        bytes: buffer.length,
        tornTail: null,
        corruption: { offset: line.offset, line: line.number, reason: '上一个批次还没有提交帧，却又出现头帧' },
      }
    }

    if (!isEventEnvelope(parsed)) {
      if (!line.complete && index === lines.length - 1) {
        return torn(batches, buffer.length, pendingStart, '批次尾部不完整（事件帧被截断）')
      }
      return {
        batches,
        bytes: buffer.length,
        tornTail: null,
        corruption: { offset: line.offset, line: line.number, reason: '事件帧结构不合法' },
      }
    }

    if (parsed.batchId !== pendingHeader.batchId) {
      return {
        batches,
        bytes: buffer.length,
        tornTail: null,
        corruption: {
          offset: line.offset,
          line: line.number,
          reason: `事件 batchId=${parsed.batchId} 与头帧 ${pendingHeader.batchId} 不一致`,
        },
      }
    }
    if (parsed.projectId !== pendingHeader.projectId) {
      return {
        batches,
        bytes: buffer.length,
        tornTail: null,
        corruption: { offset: line.offset, line: line.number, reason: '事件 projectId 与头帧不一致' },
      }
    }

    pendingEvents.push(parsed)
  }

  if (pendingHeader !== null) {
    // 有头帧、没有提交帧，且已到 EOF：崩溃留下的未提交批次，属可修复尾部。
    return torn(batches, buffer.length, pendingStart, '批次缺少提交帧（崩溃留下的未提交尾部）')
  }

  const last = lines[lines.length - 1]
  if (last !== undefined && !last.complete) {
    // 提交帧之后还有半截字节：不可能构成完整批次，属可修复尾部。
    return torn(batches, buffer.length, last.offset, '提交帧之后存在半截写入')
  }

  return { batches, bytes: buffer.length, tornTail: null, corruption: null }
}

function torn(batches: ScannedBatch[], bytes: number, offset: number, reason: string): LogScan {
  return { batches, bytes, tornTail: { offset, bytes: bytes - offset, reason }, corruption: null }
}

/** 最后一个已提交批次的结束偏移；空日志为 0。 */
export function committedBytes(scan: LogScan): number {
  const last = scan.batches[scan.batches.length - 1]
  return last === undefined ? 0 : last.endOffset
}

/** 下一个应分配的 projectSeq。 */
export function nextProjectSeq(scan: LogScan): number {
  const last = scan.batches[scan.batches.length - 1]
  return last === undefined ? 1 : last.commit.lastSeq + 1
}

/** 全部已提交事件（按日志顺序）。 */
export function committedEvents(scan: LogScan): EventEnvelope[] {
  return scan.batches.flatMap((batch) => batch.events)
}