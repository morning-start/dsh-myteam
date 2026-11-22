/**
 * 每个工作区一个项目运行时（进程内单例）。
 *
 * 为什么要注册表而不是每次 new：`ProjectRuntime` 持有写者租约，同一项目
 * 开两个运行时会在第二次 acquire 时被自己的锁挡住（租约按 pid 判活）。
 * 注册表把「同一 root 只开一次」变成结构保证，并把并发打开折叠成同一个
 * Promise，避免两次工具调用同时初始化 manifest。
 */
import { join, resolve } from 'node:path'
import { ProjectRuntime } from '../../application/project-runtime.ts'
import { bootstrapProject } from '../../application/bootstrap.ts'
import type { Clock, IdPort, LoggerPort } from '../../application/ports.ts'
import { systemClock } from '../../application/ports.ts'
import { newId } from '../../contracts/ids.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../../contracts/versions.ts'
import { FileEventStore } from '../event-store/file-store.ts'
import { WriterLeaseManager } from '../event-store/writer-lease.ts'
import { ensureProjectManifest } from '../fs/project-manifest.ts'

export interface ProjectHostsOptions {
  clock?: Clock
  ids?: IdPort
  logger?: LoggerPort
  leaseTtlMs?: number
}

interface SharedEntry {
  promise: Promise<ProjectRuntime>
  refs: number
}

/**
 * 进程级共享：同一工作区只能有一个运行时（写者租约按进程判活）。
 *
 * 队长与成员是两个装配入口，各建一个 ProjectHosts；如果各开各的运行时，
 * 第二个会被自己的租约挡住。按 root 共享 + 引用计数，最后一次释放才 close。
 */
const shared = new Map<string, SharedEntry>()

export class ProjectHosts {
  private readonly keys = new Set<string>()
  private readonly options: ProjectHostsOptions

  constructor(options: ProjectHostsOptions = {}) {
    this.options = options
  }

  /** 打开（或复用）某个工作区的项目运行时。同一 root 进程内只打开一次。 */
  open(rootDir: string): Promise<ProjectRuntime> {
    const key = resolve(rootDir)
    const existing = shared.get(key)
    if (existing !== undefined) {
      if (!this.keys.has(key)) {
        existing.refs += 1
        this.keys.add(key)
      }
      return existing.promise
    }

    const clock = this.options.clock ?? systemClock
    const ids = this.options.ids ?? newId
    this.keys.add(key)
    const opening = (async () => {
      const manifest = ensureProjectManifest(key, {
        projectId: ids('project'),
        createdAt: clock.now(),
      })
      const runtime = await ProjectRuntime.open({
        projectId: manifest.projectId,
        eventStore: new FileEventStore(join(key, EVENTS_FILE)),
        writerLock: new WriterLeaseManager(join(key, WRITER_LOCK_FILE), {
          ...(this.options.leaseTtlMs === undefined ? {} : { ttlMs: this.options.leaseTtlMs }),
        }),
        clock,
        ids,
        ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      })
      // 首次打开空项目时补齐「项目初始化 + 内置角色」，否则队长连成员都聘不了。
      bootstrapProject(runtime, key)
      return runtime
    })()

    const entry: SharedEntry = { promise: opening, refs: 1 }
    shared.set(key, entry)
    // 打开失败必须从注册表移除，否则之后每次调用都会拿到同一个拒绝。
    opening.catch(() => {
      shared.delete(key)
    })
    return opening
  }

  /** 当前已打开的项目根（供诊断/面板列出）。 */
  openedRoots(): string[] {
    return [...this.keys].sort()
  }

  async closeAll(): Promise<void> {
    const keys = [...this.keys]
    this.keys.clear()
    for (const key of keys) {
      const entry = shared.get(key)
      if (entry === undefined) continue
      entry.refs -= 1
      if (entry.refs > 0) continue
      shared.delete(key)
      try {
        const runtime = await entry.promise
        runtime.close()
      } catch {
        // 打开失败的项目没有租约需要释放。
      }
    }
  }
}