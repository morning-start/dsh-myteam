/**
 * 文件事件库：唯一允许追加权威事件日志的出口。
 *
 * 写入协议（docs/architecture/01 §6.3、§9.1）：
 *   1. 先扫描现有日志；损坏则拒绝写入，撕裂尾部要求显式修复；
 *   2. 校验本批 projectSeq 紧接上一个已提交批次；
 *   3. 一次 `write + fsync` 写入「头帧 + 事件帧 + 提交帧」；
 *   4. durable 之后才把结果交给投影与 Effect。
 *
 * 为什么整批一次写：提交帧在最后，只有它落盘并且 hash/数量/序号对齐，批次
 * 才构成 durable 提交点。分多次写会让「头帧已落盘、提交帧没落盘」成为常态，
 * 恢复时无法区分正常进行中与崩溃。
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { BatchCommit } from '../../contracts/batch.ts'
import { encodeBatch } from '../../contracts/batch.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type { EventEnvelope } from '../../contracts/events.ts'
import type { LogScan } from './log-scan.ts'
import { committedEvents, nextProjectSeq, scanLog } from './log-scan.ts'

export interface AppendResult {
  commit: BatchCommit
  /** 本批写入前的文件字节数。 */
  startOffset: number
  /** 本批写入后的文件字节数。 */
  endOffset: number
}

export interface TornTailRepair {
  report: {
    repairedAt: string
    filePath: string
    offset: number
    removedBytes: number
    backupPath: string
    reason: string
  }
  scanAfter: LogScan
}

export class FileEventStore {
  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  exists(): boolean {
    try {
      return statSync(this.filePath).isFile()
    } catch {
      return false
    }
  }

  /** 读取并分类整份日志。文件不存在视为空日志（不是错误：首次初始化）。 */
  scan(): LogScan {
    if (!this.exists()) {
      return { batches: [], bytes: 0, tornTail: null, corruption: null }
    }
    return scanLog(readFileSync(this.filePath))
  }

  /**
   * 严格读取：只返回可证明已提交的事件。
   *
   * 有损坏时抛错而不是返回「读到哪算哪」——残缺投影会被当成最新状态展示，
   * 那比报错更危险。
   */
  readCommitted(): { scan: LogScan; events: EventEnvelope[]; nextSeq: number } {
    const scan = this.scan()
    if (scan.corruption !== null) {
      fail(ERROR_CODES.EVENT_LOG_CORRUPT, '项目事件日志损坏，已停止读取业务事实', {
        details: { ...scan.corruption },
      })
    }
    if (scan.tornTail !== null) {
      fail(ERROR_CODES.EVENT_LOG_TORN_TAIL, '项目事件日志存在未提交尾部，需要显式修复', {
        details: scan.tornTail,
      })
    }
    return { scan, events: committedEvents(scan), nextSeq: nextProjectSeq(scan) }
  }

  /**
   * 追加一个批次。
   *
   * 调用方必须已经为事件分配连续 projectSeq；这里再核对一次，是因为
   * 「上层算错序号」在 durable 之后就无法挽回，只能靠修复。
   */
  append(events: readonly EventEnvelope[]): AppendResult {
    if (events.length === 0) {
      fail(ERROR_CODES.INVALID_COMMAND, '不能追加空批次')
    }

    const scan = this.scan()
    if (scan.corruption !== null) {
      fail(ERROR_CODES.PROJECT_WRITE_BLOCKED, '项目事件日志损坏，已停止整个项目的业务写入', {
        details: { ...scan.corruption },
      })
    }
    if (scan.tornTail !== null) {
      fail(ERROR_CODES.EVENT_LOG_TORN_TAIL, '项目事件日志存在未提交尾部，需先显式修复再写入', {
        details: scan.tornTail,
      })
    }

    const expected = nextProjectSeq(scan)
    const first = events[0]!
    if (first.projectSeq !== expected) {
      fail(ERROR_CODES.PRECONDITION_FAILED, '批次起始序号与日志尾部不连续', {
        details: { expectedProjectSeq: expected, provided: first.projectSeq },
      })
    }

    const encoded = encodeBatch(events)
    mkdirSync(dirname(this.filePath), { recursive: true })

    const fd = openSync(this.filePath, 'a')
    try {
      writeSync(fd, encoded.text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    return { commit: encoded.commit, startOffset: scan.bytes, endOffset: scan.bytes + Buffer.byteLength(encoded.text, 'utf8') }
  }

  /**
   * 修复撕裂尾部：把尾部字节另存备份，再把文件截断到最后一个有效提交点。
   *
   * 这是**显式修复操作**，不在启动时自动执行：自动截断会把「其实还有救的
   * 数据」当成垃圾，也会让「为什么少了一段」永远查不清。损坏（corrupt）时
   * 一律拒绝修复——那种情况需要人工判断，不是截断能解决的。
   */
  repairTornTail(now: string = new Date().toISOString()): TornTailRepair | null {
    const scan = this.scan()
    if (scan.corruption !== null) {
      fail(ERROR_CODES.EVENT_LOG_CORRUPT, '日志损坏不是撕裂尾部，拒绝自动截断', {
        details: { ...scan.corruption },
      })
    }
    if (scan.tornTail === null) return null

    const buffer = readFileSync(this.filePath)
    const tail = buffer.subarray(scan.tornTail.offset)
    const backupPath = `${this.filePath}.torn-${now.replaceAll(/[:.]/g, '-')}.bin`
    const backupFd = openSync(backupPath, 'w')
    try {
      writeSync(backupFd, tail)
      fsyncSync(backupFd)
    } finally {
      closeSync(backupFd)
    }

    truncateSync(this.filePath, scan.tornTail.offset)

    const scanAfter = this.scan()
    if (scanAfter.corruption !== null || scanAfter.tornTail !== null) {
      // 截断后仍不干净：说明判断错误，保留备份并停止，不再继续动文件。
      fail(ERROR_CODES.PROJECT_WRITE_BLOCKED, '截断后日志仍不完整，已保留备份并停止写入', {
        details: { backupPath, corruption: scanAfter.corruption, tornTail: scanAfter.tornTail },
      })
    }

    return {
      report: {
        repairedAt: now,
        filePath: this.filePath,
        offset: scan.tornTail.offset,
        removedBytes: scan.tornTail.bytes,
        backupPath,
        reason: scan.tornTail.reason,
      },
      scanAfter,
    }
  }

  /** 删除日志文件（只用于测试与明确的重新初始化）。 */
  remove(): void {
    if (this.exists()) unlinkSync(this.filePath)
  }
}