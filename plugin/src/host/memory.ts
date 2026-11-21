/**
 * 记忆族端点适配层（CHG-212 / ADR-010）：`myteam_remember` / `myteam_recall` / `myteam_forget`。
 *
 * 为什么单独一族：记忆是**成员私有**的长期状态（SQLite bank），不写账本、不改任务状态机——
 * 混进任务族会让「账本唯一权威」这句话变含糊（账本是团队状态，记忆是个体知识）。
 *
 * 宿主面只声明用到的私有成员：`workspaceRoot` 是**方法**（惰性 getter 的取值时机不能提前，
 * 否则日志顺序会变——与 tasks/plan 族同一条约定）。
 *
 * 失败口径：库打不开/写失败一律 `MT_UNAVAILABLE`，**不静默降级成「没记住」**——
 * 模型会以为记住了。空召回是正常结果（`returnedCount:0`），不是错误。
 */
import {
  MEMORY_KINDS,
  memberBankId,
  memoryDbPath,
  openMemoryStore,
  teamBankId,
  type MemoryKind,
  type MemoryStore,
} from '../core/memory/store.ts'

export interface MemoryHostSurface {
  workspaceRoot: () => string
}

type Result = Record<string, unknown>

function invalid(message: string): Result {
  return { status: 'error', code: 'MT_VALIDATION', message }
}

function unavailable(message: string): Result {
  return { status: 'error', code: 'MT_UNAVAILABLE', message }
}

export function createMemoryHandlers(host: MemoryHostSurface) {
  /** 每次调用开/关连接：记忆调用稀疏（上岗召回 + 手动检索），省掉长连接的生命周期问题 */
  const withStore = (fn: (store: MemoryStore) => Result): Result => {
    let store: MemoryStore | undefined
    try {
      store = openMemoryStore(memoryDbPath(host.workspaceRoot()))
      return fn(store)
    } catch (error) {
      return unavailable(`memory store unavailable: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      store?.close()
    }
  }

  /** `scope=member`（默认）落成员私有 bank；`team` 落团队公共 bank */
  const bankOf = (teamId: string, memberId: string | null, args: Record<string, unknown>): string => {
    const scope = String(args.scope ?? 'member')
    if (scope === 'team') return teamBankId(teamId)
    if (scope !== 'member') throw new Error(`unknown memory scope "${scope}"（member|team）`)
    if (memberId === null) return teamBankId(teamId)
    return memberBankId(teamId, memberId)
  }

  return {
    handle(name: string, teamId: string, memberId: string | null, args: Record<string, unknown>, actor: string): Result {
      if (name === 'myteam_remember') {
        const kind = String(args.kind ?? 'fact') as MemoryKind
        if (!MEMORY_KINDS.includes(kind)) return invalid(`kind must be one of: ${MEMORY_KINDS.join(', ')}`)
        const title = String(args.title ?? '').trim()
        const body = String(args.body ?? '').trim()
        const evidence = String(args.evidence ?? '').trim()
        if (!title) return invalid('title is required')
        if (!body) return invalid('body is required')
        if (!evidence || evidence.toLowerCase() === 'none') {
          return invalid('evidence is required（FR-6.2：taskId / 账本 seq / 文件路径）')
        }
        return withStore((store) => {
          const entry = store.remember({
            bankId: bankOf(teamId, memberId, args),
            kind,
            title,
            body,
            evidence,
            importance: args.importance === undefined ? undefined : Number(args.importance),
            source: actor,
            ...(args.taskId === undefined ? {} : { taskId: String(args.taskId) }),
            ...(args.supersedes === undefined ? {} : { supersedes: String(args.supersedes) }),
          })
          return { status: 'ok', id: entry.id, bank: entry.bankId, kind: entry.kind, title: entry.title }
        })
      }
      if (name === 'myteam_recall') {
        return withStore((store) => {
          const hits = store.recall({
            bankId: bankOf(teamId, memberId, args),
            ...(args.query === undefined ? {} : { query: String(args.query) }),
            ...(args.kind === undefined ? {} : { kind: String(args.kind) as MemoryKind }),
            ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
          })
          return {
            status: 'ok',
            entries: hits.map((hit) => ({
              id: hit.id,
              kind: hit.kind,
              title: hit.title,
              body: hit.body,
              evidence: hit.evidence,
              importance: hit.importance,
              score: hit.score,
            })),
            returnedCount: hits.length,
            note: '召回按 score 排序（匹配 0.5 / 重要度 0.3 / 新鲜度 0.2）；空结果是正常，不是错误',
          }
        })
      }
      if (name === 'myteam_forget') {
        const id = String(args.id ?? '').trim()
        if (!id) return invalid('id is required')
        return withStore((store) => ({ status: 'ok', id, forgotten: store.forget(id) }))
      }
      return invalid(`unknown memory tool "${name}"`)
    },
  }
}