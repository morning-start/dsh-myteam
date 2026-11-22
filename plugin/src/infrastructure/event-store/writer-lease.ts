/**
 * 项目写者租约（跨进程防物理分叉）。
 *
 * 两种锁不能互相替代（docs/architecture/01 §9.4）：
 *   - 写者租约：同一项目同时只有一个进程能追加事件；
 *   - 队长任期：同一团队同时只有一个有效指令来源。
 *
 * 这里只实现前者。租约失败时**只读或转发**，不降级成「试试看能不能写」。
 *
 * 已知竞态（明确记录，不假装不存在）：两个进程同时接管一个过期租约时，
 * 可能都认为自己拿到同一个 fencing generation。最终防线在事件库：追加时
 * 校验本批起始 projectSeq 必须紧接日志尾部，后写者会被拒绝。租约负责把
 * 这种情况压到极小，序号校验负责兜底。
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'

export interface WriterLease {
  schemaVersion: 1
  projectId: string
  owner: string
  pid: number
  fencing: number
  acquiredAt: string
  renewedAt: string
  /** 正常释放后的墓碑：锁文件保留，保证 fencing 单调递增。 */
  released?: boolean
}

export interface WriterLeaseOptions {
  /** 超过这段时间没有续租即视为失效。默认 60s。 */
  ttlMs?: number
  now?: () => Date
  isProcessAlive?: (pid: number) => boolean
  owner?: string
}

function defaultIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    // 信号 0 只探测存在性，不投递信号。
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号，仍算活着。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class WriterLeaseManager {
  readonly filePath: string
  private readonly ttlMs: number
  private readonly now: () => Date
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly owner: string

  constructor(filePath: string, options: WriterLeaseOptions = {}) {
    this.filePath = filePath
    this.ttlMs = options.ttlMs ?? 60_000
    this.now = options.now ?? (() => new Date())
    this.isProcessAlive = options.isProcessAlive ?? defaultIsAlive
    this.owner = options.owner ?? `pid-${process.pid}`
  }

  /** 读取当前租约；文件不存在或内容不可信时返回 null。 */
  peek(): WriterLease | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<WriterLease>
      if (
        parsed.schemaVersion !== 1 ||
        typeof parsed.projectId !== 'string' ||
        typeof parsed.owner !== 'string' ||
        typeof parsed.pid !== 'number' ||
        typeof parsed.fencing !== 'number' ||
        typeof parsed.acquiredAt !== 'string' ||
        typeof parsed.renewedAt !== 'string'
      ) {
        return null
      }
      return parsed as WriterLease
    } catch {
      return null
    }
  }

  /** 租约是否仍然有效（未释放、持有进程活着且未过期）。 */
  isHeld(lease: WriterLease): boolean {
    if (lease.released === true) return false
    const renewedAt = Date.parse(lease.renewedAt)
    if (Number.isNaN(renewedAt)) return false
    if (this.now().getTime() - renewedAt > this.ttlMs) return false
    return this.isProcessAlive(lease.pid)
  }

  /**
   * 取得租约。
   *
   * 先尝试独占创建（`wx`），失败才读现有租约判断是否可接管。这样正常启动
   * 不依赖「先读再写」的窗口，竞争面更小。
   */
  acquire(projectId: string): WriterLease {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const nowIso = this.now().toISOString()
    const base = { schemaVersion: 1 as const, projectId, owner: this.owner, pid: process.pid, acquiredAt: nowIso, renewedAt: nowIso }

    try {
      const fd = openSync(this.filePath, 'wx')
      try {
        writeSync(fd, JSON.stringify({ ...base, fencing: 1 }))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return { ...base, fencing: 1 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const existing = this.peek()
    if (existing !== null && existing.projectId !== projectId) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '写者锁属于另一个项目，拒绝追加', {
        details: { lockProjectId: existing.projectId, projectId },
      })
    }
    if (existing !== null && this.isHeld(existing)) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '另一个进程正在写这个项目', {
        details: { owner: existing.owner, pid: existing.pid, renewedAt: existing.renewedAt },
      })
    }

    const fencing = existing === null ? 1 : existing.fencing + 1
    const lease: WriterLease = { ...base, fencing }
    this.writeAtomic(lease)
    return lease
  }

  /** 校验仍然持有租约；失败即停止写入，不自动重新接管。 */
  assert(lease: WriterLease): void {
    const current = this.peek()
    if (current === null) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '写者锁已消失，拒绝继续追加')
    }
    if (
      current.pid !== lease.pid ||
      current.owner !== lease.owner ||
      current.fencing !== lease.fencing ||
      current.projectId !== lease.projectId
    ) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '写者租约已被其他进程接管', {
        details: { expectedFencing: lease.fencing, currentFencing: current.fencing, currentOwner: current.owner },
      })
    }
    if (!this.isHeld(current)) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '写者租约已过期，请重新取得后再写入')
    }
  }

  renew(lease: WriterLease): WriterLease {
    this.assert(lease)
    const renewed: WriterLease = { ...lease, renewedAt: this.now().toISOString() }
    this.writeAtomic(renewed)
    return renewed
  }

  release(lease: WriterLease): void {
    const current = this.peek()
    if (current === null) return
    if (current.pid !== lease.pid || current.fencing !== lease.fencing || current.owner !== lease.owner) {
      // 已被别人接管：不动别人的锁。
      return
    }
    // 不删文件，写墓碑：删掉会让下一次 acquire 从 fencing=1 重新开始，
    // 「单调递增」就不成立了。锁文件不是业务事实，保留它没有副作用。
    this.writeAtomic({ ...current, released: true, renewedAt: this.now().toISOString() })
  }

  private writeAtomic(lease: WriterLease): void {
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const fd = openSync(tempPath, 'w')
    try {
      writeSync(fd, JSON.stringify(lease))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tempPath, this.filePath)
  }
}