/**
 * 项目运行时：一个项目在进程内的唯一写入通道。
 *
 * 顺序是硬性的（docs/architecture/01 §9.1）：
 *
 *   取得写者租约 → 读权威日志 → 重建投影 → 领域校验 → 追加原子批次
 *   → fsync → 切换内存投影 → 返回结果 → 调度 Effect
 *
 * durable 之前的任何失败都不改变投影、不执行副作用；durable 之后的失败
 * 不能伪装成「命令没提交」。这里只做前几步，Effect 由上层在 commit 返回后
 * 调度，并且结果必须另写事件。
 */
import type { EventEnvelope, ActorRef, EntityRef, EventType, LegacyOrigin } from '../contracts/events.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { IdKind } from '../contracts/ids.ts'
import { canonicalJson } from '../contracts/json.ts'
import { SCHEMA_VERSION } from '../contracts/versions.ts'
import type { ProjectState } from './projections/project-state.ts'
import { applyEvent, rebuildProjectState } from './projections/project-state.ts'
import type { Clock, EventStorePort, IdPort, LoggerPort, WriteToken, WriterLockPort } from './ports.ts'
import { silentLogger } from './ports.ts'

/** 命令层产出的「待提交事件」：不含信封里由运行时负责的字段。 */
export interface DraftEvent {
  type: EventType
  actor: ActorRef
  entity: EntityRef
  payload: unknown
  entityRevision?: number
  configRevision?: number
  causationId?: string
  correlationId?: string
  /** 迁移事件保留旧来源；普通命令不填。 */
  legacy?: LegacyOrigin
}

export interface CommitResult {
  batchId: string
  firstSeq: number
  lastSeq: number
  events: EventEnvelope[]
}

export interface ProjectRuntimeOptions {
  projectId: string
  eventStore: EventStorePort
  writerLock: WriterLockPort
  clock: Clock
  ids: IdPort
  logger?: LoggerPort
}

export class ProjectRuntime {
  readonly projectId: string
  private readonly eventStore: EventStorePort
  private readonly writerLock: WriterLockPort
  private readonly clock: Clock
  private readonly ids: IdPort
  private readonly logger: LoggerPort
  private lease: WriteToken | null = null
  /**
   * 续租定时器：租约 TTL 默认 60s，而一个打开的项目可能长时间没有写入。
   * 只在 commit 时续租会让空闲项目「静默丢租」，之后第一次写入报
   * WRITER_LEASE_LOST——这属于正常使用路径，不是异常。
   */
  private renewTimer: ReturnType<typeof setInterval> | null = null
  private current: ProjectState
  /** 追加成功但内存投影应用失败时为 true：之后拒绝写入，重启后可重建。 */
  private poisoned = false

  /** 续租间隔：TTL 的 1/3（默认 20s），留足两次失败的机会。 */
  private static readonly RENEW_INTERVAL_MS = 20_000

  private constructor(options: ProjectRuntimeOptions, lease: WriteToken, state: ProjectState) {
    this.projectId = options.projectId
    this.eventStore = options.eventStore
    this.writerLock = options.writerLock
    this.clock = options.clock
    this.ids = options.ids
    this.logger = options.logger ?? silentLogger
    this.lease = lease
    this.current = state
    this.renewTimer = setInterval(() => this.renewLease(), ProjectRuntime.RENEW_INTERVAL_MS)
    // 定时器不应阻止宿主退出。
    if (typeof this.renewTimer === 'object' && this.renewTimer !== null && 'unref' in this.renewTimer) {
      this.renewTimer.unref()
    }
  }

  /** 续租；失败只记日志，真正写入时会再次 assert 并报 WRITER_LEASE_LOST。 */
  private renewLease(): void {
    if (this.lease === null) return
    try {
      this.writerLock.assert(this.lease)
      this.lease = this.writerLock.renew(this.lease)
    } catch (error) {
      this.logger.warn('writer.lease.renew.failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  static open(options: ProjectRuntimeOptions): ProjectRuntime {
    const lease = options.writerLock.acquire(options.projectId)
    try {
      const { events } = options.eventStore.readCommitted()
      const state = rebuildProjectState(options.projectId, events)
      return new ProjectRuntime(options, lease, state)
    } catch (error) {
      options.writerLock.release(lease)
      throw error
    }
  }

  /** 只读视图。调用方不得修改；需要变更请走命令与 commit。 */
  get state(): ProjectState {
    return this.current
  }

  /**
   * 已提交事件的只读视图（按 `projectSeq` 升序）。
   *
   * 审计页与 CLI 需要「事件本身」，而投影只保留折叠结果；这里把账本读口暴露出来，
   * 不额外缓存 —— 每次调用都读已提交字节，避免第二份真源。
   * @returns 已提交事件数组；不可信状态（poisoned）下仍返回账本能读到的部分。
   */
  readEvents(): readonly EventEnvelope[] {
    return this.eventStore.readCommitted().events
  }

  /**
   * 外部进程写入后，本实例的投影会陈旧（单写者租约只挡并发写，不挡陈旧读）。
   *
   * 写前与读取身份前都要调用：否则会拿旧状态算队长身份或任务状态，
   * 表现为「明明是队长却被判 FORBIDDEN」。
   */
  refresh(): void {
    if (this.poisoned) return
    let committed
    try {
      committed = this.eventStore.readCommitted()
    } catch {
      return
    }
    if (committed.events.length <= this.current.seq) return
    this.current = rebuildProjectState(this.projectId, committed.events)
    this.logger.warn('project.state.refreshed', { to: this.current.seq })
  }

  get observedProjectSeq(): number {
    return this.current.seq
  }

  nextId(kind: IdKind): string {
    return this.ids(kind)
  }

  now(): string {
    return this.clock.now()
  }

  /**
   * 提交一个原子批次。
   *
   * 事件序号、batchId、batchIndex 由运行时统一分配：调用方算错序号是
   * durable 之后无法挽回的错误，不该交给每个命令自己去数。
   */
  commit(drafts: readonly DraftEvent[]): CommitResult {
    if (this.poisoned) {
      fail(ERROR_CODES.PROJECT_WRITE_BLOCKED, '项目运行时状态不可信，拒绝继续写入')
    }
    // 先对齐外部写入，避免基于旧投影分配序号与算事件。
    this.refresh()
    if (this.lease === null) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '运行时已关闭，不能提交')
    }
    if (drafts.length === 0) {
      fail(ERROR_CODES.INVALID_COMMAND, '命令没有产出任何事件')
    }

    this.writerLock.assert(this.lease)
    // 写前续租：把「刚好在 TTL 边界」的竞争窗口压到一次 assert 内。
    this.lease = this.writerLock.renew(this.lease)

    const batchId = this.ids('batch')
    const occurredAt = this.clock.now()
    const firstSeq = this.current.seq + 1
    const events: EventEnvelope[] = drafts.map((draft, index) => {
      const envelope: EventEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        eventId: this.ids('event'),
        projectId: this.projectId,
        projectSeq: firstSeq + index,
        batchId,
        batchIndex: index,
        type: draft.type,
        actor: draft.actor,
        occurredAt,
        entity: draft.entity,
        payload: draft.payload as EventEnvelope['payload'],
      }
      if (draft.entityRevision !== undefined) envelope.entityRevision = draft.entityRevision
      if (draft.configRevision !== undefined) envelope.configRevision = draft.configRevision
      if (draft.causationId !== undefined) envelope.causationId = draft.causationId
      if (draft.correlationId !== undefined) envelope.correlationId = draft.correlationId
      if (draft.legacy !== undefined) envelope.legacy = draft.legacy
      return envelope
    })

    // 先证明信封可规范化：undefined/NaN 在这里暴露，而不是写进日志后变成
    // 「读出来和写进去不一样」的悬案。
    for (const event of events) canonicalJson(event)

    this.eventStore.append(events)

    try {
      for (const event of events) applyEvent(this.current, event)
    } catch (error) {
      this.poisoned = true
      this.logger.error('事件已 durable，但内存投影应用失败；已阻止后续写入', {
        projectId: this.projectId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    return { batchId, firstSeq, lastSeq: firstSeq + events.length - 1, events }
  }

  /** 释放写者租约。不自动重放任何 Effect。 */
  close(): void {
    if (this.renewTimer !== null) {
      clearInterval(this.renewTimer)
      this.renewTimer = null
    }
    if (this.lease === null) return
    this.writerLock.release(this.lease)
    this.lease = null
  }
}