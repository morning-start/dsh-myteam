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
import type { EventEnvelope, ActorRef, EntityRef, EventType } from '../contracts/events.ts'
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
  private current: ProjectState
  /** 追加成功但内存投影应用失败时为 true：之后拒绝写入，重启后可重建。 */
  private poisoned = false

  private constructor(options: ProjectRuntimeOptions, lease: WriteToken, state: ProjectState) {
    this.projectId = options.projectId
    this.eventStore = options.eventStore
    this.writerLock = options.writerLock
    this.clock = options.clock
    this.ids = options.ids
    this.logger = options.logger ?? silentLogger
    this.lease = lease
    this.current = state
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
    if (this.lease === null) {
      fail(ERROR_CODES.WRITER_LEASE_LOST, '运行时已关闭，不能提交')
    }
    if (drafts.length === 0) {
      fail(ERROR_CODES.INVALID_COMMAND, '命令没有产出任何事件')
    }

    this.writerLock.assert(this.lease)

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
    if (this.lease === null) return
    this.writerLock.release(this.lease)
    this.lease = null
  }
}