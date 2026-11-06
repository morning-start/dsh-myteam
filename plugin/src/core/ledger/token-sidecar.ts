/**
 * T9 token 侧车（FR-8.2/ADR-004）：tokenUsage 投影读数 → 按天桶聚合 → tokens.json。
 *
 * 口径（REV-5/T0-③）：四桶 uncachedInput/cacheRead/cacheWrite/output + calls；
 * 命中率派生 = cacheRead / (uncachedInput + cacheRead + cacheWrite)；
 * 熔断口径独立不合并（本结构不含熔断字段，M2 若需另列）。
 * 纯函数〔J1〕：聚合与合并无 IO；宿主本地时区按日取键（CHG-16 裁决 5）。
 * tokens.json 绝不进模型上下文（F2/NFR-7.2）。
 */

export interface TokenBuckets {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  calls: number
}

export interface TokensFile {
  version: 1
  teamId: string
  updatedAt: number
  /** "YYYY-MM-DD"（宿主本地时区）→ memberId → 四桶 */
  days: Record<string, Record<string, TokenBuckets>>
  totals: Record<string, TokenBuckets>
  /** 独立说明字段：heuristic 估算成分提示（非账单） */
  note: string
}

export function zeroBuckets(): TokenBuckets {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
}

export function addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    calls: a.calls + b.calls,
  }
}

/** 宿主本地时区日期键（CHG-16 裁决 5） */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 命中率 = cacheRead / (uncachedInput + cacheRead + cacheWrite)；分母 0 → undefined（面板显示 —） */
export function cacheHitRate(b: TokenBuckets): number | undefined {
  const denom = b.uncachedInput + b.cacheRead + b.cacheWrite
  if (denom === 0) return undefined
  return b.cacheRead / denom
}

/** 单条用量记录入账（dayKey 已由调用方按事件 ts 计算，保持纯函数无时钟依赖） */
export function accumulate(
  file: TokensFile,
  memberId: string,
  dayKey: string,
  usage: Omit<TokenBuckets, 'calls'> & { calls?: number },
): TokensFile {
  const delta: TokenBuckets = {
    uncachedInput: usage.uncachedInput,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    calls: usage.calls ?? 1,
  }
  const days = { ...file.days }
  const dayMembers = { ...(days[dayKey] ?? {}) }
  dayMembers[memberId] = addBuckets(dayMembers[memberId] ?? zeroBuckets(), delta)
  days[dayKey] = dayMembers
  const totals = { ...file.totals }
  totals[memberId] = addBuckets(totals[memberId] ?? zeroBuckets(), delta)
  return { ...file, days, totals, updatedAt: Date.now() }
}

/** 从账本事件流重建（disband 全量兜底路径）；usageOf 由调用方从成员 session 投影提取后逐条喂入 */
export function emptyTokensFile(teamId: string): TokensFile {
  return {
    version: 1,
    teamId,
    updatedAt: 0,
    days: {},
    totals: {},
    note: '含启发式估算成分（tokenMeter heuristic），非账单；熔断口径独立不合并（REV-5）。',
  }
}
