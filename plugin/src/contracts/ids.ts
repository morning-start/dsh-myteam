/**
 * v2 标识符。
 *
 * 约定（与 docs/architecture/01 §2.3 一致）：
 *   - `projectId` 初始化时生成，工作区移动不变；
 *   - `roleId`/`workflowId`/`blueprintId` 在同一作用域内唯一，跨作用域用 `scope + id`；
 *   - `teamId`/`workflowRunId` 项目内唯一，且**不与定义共用命名空间**；
 *   - `taskId` 项目内唯一（不再需要 `teamId/taskId` 才能定位）；
 *   - `memberId` 只在团队内唯一，跨团队用 `teamId + memberId`。
 *
 * 前缀不是装饰：日志、事件、UI 混在一起时，前缀决定了一个 id 能不能被误当成
 * 另一类实体。解析函数因此拒绝无前缀或错前缀的值，而不是「看起来像就收下」。
 */
import { randomUUID } from 'node:crypto'

export const ID_PREFIXES = {
  project: 'prj',
  role: 'role',
  workflow: 'wfl',
  blueprint: 'bp',
  team: 'team',
  member: 'mem',
  run: 'run',
  task: 'task',
  attempt: 'att',
  verdict: 'gd',
  knowledge: 'kn',
  memory: 'memo',
  effect: 'eff',
  message: 'msg',
  batch: 'bat',
  event: 'evt',
  operation: 'op',
  session: 'ses',
} as const

export type IdKind = keyof typeof ID_PREFIXES

export type ProjectId = string
export type RoleId = string
export type WorkflowId = string
export type BlueprintId = string
export type TeamId = string
export type MemberId = string
export type WorkflowRunId = string
export type TaskId = string
export type AttemptId = string
export type GateVerdictId = string
export type KnowledgeEntryId = string
export type EffectId = string
export type MessageId = string
export type BatchId = string
export type EventId = string
export type OperationId = string
export type SessionId = string

/** 生成带前缀的随机 id（时间无关，避免用创建时间泄漏顺序）。 */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUUID().replaceAll('-', '')}`
}

/** 判定某个字符串是否为指定种类的 id。 */
export function isIdOf(kind: IdKind, value: unknown): value is string {
  if (typeof value !== 'string') return false
  const prefix = `${ID_PREFIXES[kind]}_`
  if (!value.startsWith(prefix)) return false
  const body = value.slice(prefix.length)
  return body.length >= 8 && /^[0-9a-zA-Z]+$/.test(body)
}

/** 从 id 取种类；不认识的前缀返回 undefined，调用方据此拒绝而不是猜。 */
export function idKindOf(value: unknown): IdKind | undefined {
  if (typeof value !== 'string') return undefined
  for (const [kind, prefix] of Object.entries(ID_PREFIXES) as [IdKind, string][]) {
    if (value.startsWith(`${prefix}_`)) {
      const body = value.slice(prefix.length + 1)
      if (body.length >= 8 && /^[0-9a-zA-Z]+$/.test(body)) return kind
    }
  }
  return undefined
}

/**
 * 可注入的 id 工厂。
 *
 * 领域层不生成 id（它是输入），应用层通过这个接口拿 id；测试注入确定性序列，
 * 生产注入 {@link newId}。这样「同一输入是否产生同一结果」在测试里是可判定的。
 */
export interface IdFactory {
  (kind: IdKind): string
}

/** 生产实现。 */
export const randomIds: IdFactory = newId

/** 测试用：按种类生成 `kind_00000001` 这样的稳定序列。 */
export function sequentialIds(start = 1): IdFactory {
  let counter = start
  return (kind: IdKind) => {
    const value = `${ID_PREFIXES[kind]}_${String(counter).padStart(8, '0')}`
    counter += 1
    return value
  }
}