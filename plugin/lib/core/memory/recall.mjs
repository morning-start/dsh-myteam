/**
 * 成员上岗记忆召回（CHG-212 / ADR-010）：把 SQLite 里的长期记忆压成一段提示词。
 *
 * 为什么在 spawn 时召回而不是每轮注入：注入是**预算**——每轮都带会挤掉任务上下文；
 * 上岗那一刻召回一次（≤10 行），成员需要更多时自己调 `myteam_recall`（P2）。
 *
 * 召回顺序：**自己的 bank 优先**（私有坑），再补团队 bank（公共口径），按 score 合并去重。
 * 记忆是增强不是门禁：任何失败（库损坏 / 被占用 / 无记录）都返回 `count:0` 并告警，
 * 绝不让 spawn 因为记忆读不出来而失败。
 */
import { memberBankId, memoryDbPath, openMemoryStore, teamBankId,                  } from './store.mjs'

/** 召回的预算：行数与字符数双上限（提示词是稀缺资源） */
export const RECALL_MAX_LINES = 10
export const RECALL_MAX_CHARS = 1600

                              
              
               
 

/** 一条记忆的提示词行（内部格式函数；对外只暴露 {@link memoryBrief}） */
function memoryLine(entry             , score        )         {
  const head = `- [${entry.kind}] ${entry.title}`
  const body = entry.body.replace(/\s+/g, ' ').trim()
  const short = body.length > 160 ? `${body.slice(0, 157)}…` : body
  return `${head} — ${short}（evidence: ${entry.evidence} · score ${score.toFixed(2)}）`
}

/**
 * 生成上岗记忆摘要。
 * @param projectRoot 工作区根（`memoryDbPath` 由它派生）
 * @param teamId 团队
 * @param memberId 成员（决定私有 bank）
 * @param opts.limit 每仓取几条（默认 6）
 */
export function memoryBrief(
  projectRoot        ,
  teamId        ,
  memberId        ,
  opts                                   = {},
)              {
  const limit = opts.limit ?? 6
  const now = opts.now
  let store                                                
  try {
    store = openMemoryStore(memoryDbPath(projectRoot))
    const own = store.recall({ bankId: memberBankId(teamId, memberId), limit, ...(now === undefined ? {} : { now }) })
    const shared = store.recall({ bankId: teamBankId(teamId), limit, ...(now === undefined ? {} : { now }) })
    const seen = new Set        ()
    const merged                                          = []
    for (const hit of [...own, ...shared]) {
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      merged.push({ entry: hit, score: hit.score })
      if (merged.length >= RECALL_MAX_LINES) break
    }
    if (merged.length === 0) return { text: '', count: 0 }
    const header = `[记忆] 上岗召回（${merged.length} 条，来自 ${memberId} 的私有 bank 与团队 bank；每条都带出处）：`
    const lines           = []
    let chars = header.length
    for (const { entry, score } of merged) {
      const line = memoryLine(entry, score)
      if (chars + line.length + 1 > RECALL_MAX_CHARS) break
      lines.push(line)
      chars += line.length + 1
    }
    const footer = '需要更多时用 myteam_recall 检索；写入用 myteam_remember（必须带 evidence）。'
    return { text: [header, ...lines, footer].join('\n'), count: lines.length }
  } catch {
    return { text: '', count: 0 }
  } finally {
    store?.close()
  }
}


//# sourceURL=./src/core/memory/recall.ts