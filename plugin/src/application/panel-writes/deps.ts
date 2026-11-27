/**
 * 写通道的外部依赖：端口形状与取用器。
 *
 * 应用层不 import infrastructure，所以销毁器 / 全局库直改 / 全局发布 / 记忆存储
 * 都由装配层按接口注入；没装配就报 `INTERNAL`（而不是悄悄跳过一步写动作）。
 * 由 {@link ../panel-writes.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type { GlobalLibraryEditPort, GlobalPublicationPort, PublicationKind } from '../../contracts/publication.ts'
import type { GlobalEntryReader } from '../global-edit.ts'
import type { ProjectDestroyPort } from '../../contracts/project-destroy.ts'
import type { HumanConfirmation } from '../../domain/permissions/human-authorizer.ts'
import type { MemoryPort } from '../ports.ts'
import type { PanelWriteMethod } from './methods.ts'

export interface PanelWritePreview {
  method: PanelWriteMethod
  operationId: string
  summary: string
  impact: unknown
  /** 一次性确认令牌：只有预览这一次返回，服务端只留 hash。 */
  confirmation: HumanConfirmation
}

export interface PanelWriteApplied {
  method: PanelWriteMethod
  operationId: string
  committed: unknown
}

/** 写通道的外部依赖：全局发布要写入器，记忆要存储实现与项目根（都是端口注入）。 */
export interface PanelWriteDeps {
  publisher?: GlobalPublicationPort
  /** 全局库直改端口（definition.publish 之外的第二条全局写路径）。 */
  globalEditor?: GlobalLibraryEditPort
  /** 全局目录读取器：直改时校验引用用（只看全局库，不看项目）。 */
  globalEntries?: GlobalEntryReader
  /**
   * 项目数据销毁器。**必须由装配层注入**，并且它的审计文件是全局审计
   * （`$DSH_HOME/myteam/audit/global-operations.jsonl`）—— 项目的账本正是被删的东西，
   * 销毁记录不能写在里面。
   */
  destroyer?: ProjectDestroyPort
  /** 关掉某个工作区的运行时（释放写者租约）。销毁前必须调。 */
  closeProject?: (rootDir: string) => Promise<void>
  /** 项目根：记忆库按项目落盘（`memory/myteam.db`）。 */
  rootDir?: string
  /** 打开记忆存储；由装配层注入，application 不 import infrastructure。 */
  openMemory?: (rootDir: string) => MemoryPort
}

export function requireDestroyer(deps: PanelWriteDeps): ProjectDestroyPort {
  if (deps.destroyer === undefined) {
    fail(ERROR_CODES.INTERNAL, '项目销毁器未装配')
  }
  return deps.destroyer
}

export function requireGlobalEditor(deps: PanelWriteDeps): GlobalLibraryEditPort {
  if (deps.globalEditor === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局库直改端口未装配')
  }
  return deps.globalEditor
}

export function requireGlobalEntries(deps: PanelWriteDeps): GlobalEntryReader {
  if (deps.globalEntries === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局目录读取器未装配')
  }
  return deps.globalEntries
}

export function requirePublisher(deps: PanelWriteDeps): GlobalPublicationPort {
  if (deps.publisher === undefined) {
    fail(ERROR_CODES.INTERNAL, '全局发布器未装配')
  }
  return deps.publisher
}

export function requireMemory(deps: PanelWriteDeps): { memory: MemoryPort; rootDir: string } {
  if (deps.rootDir === undefined || deps.openMemory === undefined) {
    fail(ERROR_CODES.INTERNAL, '记忆存储未装配')
  }
  return { memory: deps.openMemory(deps.rootDir), rootDir: deps.rootDir }
}

const PUBLICATION_KINDS = ['role', 'workflow', 'blueprint'] as const

export function requirePublicationKind(params: Record<string, unknown>): PublicationKind {
  const value = params.kind
  if (typeof value !== 'string' || !(PUBLICATION_KINDS as readonly string[]).includes(value)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `kind 必须是 ${PUBLICATION_KINDS.join(' / ')} 之一`)
  }
  return value as PublicationKind
}
