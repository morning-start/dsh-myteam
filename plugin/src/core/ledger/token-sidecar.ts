/**
 * T9 token 侧车（FR-8.2/ADR-004）：tokenUsage 投影读数 → 按天桶聚合 → tokens.json。
 *
 * 口径（REV-5/T0-③）：四桶 uncachedInput/cacheRead/cacheWrite/output + calls；
 * 命中率派生 = cacheRead / (uncachedInput + cacheRead + cacheWrite)；
 * 熔断口径独立不合并（本结构不含熔断字段，M2 若需另列）。
 * 纯函数〔J1〕：聚合与合并无 IO；宿主本地时区按日取键（CHG-16 裁决 5）。
 * tokens.json 绝不进模型上下文（F2/NFR-7.2）。
 *
 * ── P2-5 计量覆盖率三态（CHG-153 / docs/21 §6 P2-5；来源 TC `src/tools/run-history.ts:30-65`）──
 * 为什么需要：四桶总量只回答「数了多少」，不回答「该数的都数到了吗」。成员调用没拿到
 * provider usage 时（服务端不报 / 投影缺失 / 旧数据），总量会**看起来对但样本不全**——
 * 面板无法区分「全量计量」与「部分计量」，成本数字被当成账单误信。
 *
 * 故 sidecar 增两个**独立计数** `meteredCalls`（拿到 usage 的调用）/ `unmeteredCalls`
 * （没拿到的调用），覆盖率 `full | partial | none` 由 `coverageOf(buckets)` **现算**：
 *  - **只读派生**：覆盖率不写进 `tokens.json`——一旦落盘，它与四桶就有了两个真相来源
 *    （迁移/手改/回放都可能不一致），而它是纯函数，现算零成本；
 *  - **与总量解耦**：四桶与 `calls` 的口径一个字都不改（老账本、老测试、面板数值全部不变），
 *    覆盖率只是叠在上面的「可信度」标注；
 *  - **保守优先**：旧 `tokens.json` 没有这两个计数（= 无法证明每次调用都拿到 usage）→
 *    一律 `partial`，绝不谎报 `full`。漏报只是少一个徽章，谎报会让成本数字被误信。
 */

export interface TokenBuckets {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  calls: number
  /**
   * 已计量调用数（拿到 provider usage 的调用数）。
   *
   * 可选：旧 `tokens.json` 没有这个字段。缺省 = **未知**，覆盖率按保守 `partial` 处理
   * （不能把「没记录」当成「都计量了」）。存在时与 `calls` 同口径（调用数，不是 token 数）。
   */
  meteredCalls?: number
  /** 未计量调用数（尝试过但没拿到 usage 的调用数）；缺省 = 未知 */
  unmeteredCalls?: number
}

/** 计量覆盖率三态（TC 口径：与 token 总量正交） */
export type TokenCoverage = 'full' | 'partial' | 'none'

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

/**
 * 合并两个桶。
 *
 * 四桶与 `calls` 的加法口径不变（P2-5 与总量解耦）；`meteredCalls` / `unmeteredCalls`
 * **只在某一侧出现过时才产出**——两侧都没有就保持「未知」（省略字段），不能编 0：
 * 编 0 会被 `coverageOf` 读成「全部未计量」，把「没记录」升级成「确定没计量」，
 * 同样是撒谎，只是方向相反。
 */
export function addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  const merged: TokenBuckets = {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    calls: a.calls + b.calls,
  }
  const metered = addOptionalCount(a.meteredCalls, b.meteredCalls)
  if (metered !== undefined) merged.meteredCalls = metered
  const unmetered = addOptionalCount(a.unmeteredCalls, b.unmeteredCalls)
  if (unmetered !== undefined) merged.unmeteredCalls = unmetered
  return merged
}

/**
 * 覆盖率派生（纯函数，P2-5 核心判据）。三态定义：
 *  - `full`：`calls > 0` 且**每个**已计数调用都带 usage（`meteredCalls === calls` 且无未计量）；
 *  - `partial`：有过计量也有过未计量；或计量计数缺失（旧数据，无法证明 full）；
 *  - `none`：`calls === 0`（没有调用可覆盖）或**全部未计量**（`meteredCalls === 0`）。
 *
 * 边界纪律：
 *  - `meteredCalls` 缺失 / 非有限数 → `partial`（**不谎报 full**，这是本函数的底线）；
 *  - 计数为负 / 浮点时先归一到「非负整数」，避免坏数据让三态抖动；
 *  - `meteredCalls > calls`（坏数据）不判 full —— 保守落 partial，等人工核对；
 *  - 只读：不修改入参（总量与计数原样返回）。
 */
export function coverageOf(buckets: TokenBuckets | undefined | null): TokenCoverage {
  if (!buckets || typeof buckets !== 'object') return 'none'
  const calls = countOrZero(buckets.calls)
  if (calls <= 0) return 'none'
  const meteredRaw = buckets.meteredCalls
  // 旧 tokens.json 无计量计数：无法证明每次调用都拿到 usage → 保守 partial
  if (typeof meteredRaw !== 'number' || !Number.isFinite(meteredRaw)) return 'partial'
  const metered = countOrZero(meteredRaw)
  if (metered <= 0) return 'none'
  const unmetered = countOrZero(buckets.unmeteredCalls)
  if (metered === calls && unmetered === 0) return 'full'
  return 'partial'
}

/**
 * 覆盖率中文文案（面板 / 远程端点 / 报告共用）。
 *
 * 为什么放在 sidecar 里而不是各消费点自写：三态文案是**口径**，散落就会漂移
 * （「部分计量」被写成「计量正常」正是本项要防的误导）。不接线也要先导出，
 * 避免以后各处自造措辞。`default` 分支防御运行时脏值（持久化文件可能被手改）。
 */
export function describeCoverage(coverage: TokenCoverage): string {
  switch (coverage) {
    case 'full':
      return '全量计量（每次调用都拿到 provider usage）'
    case 'partial':
      return '部分计量（有调用未拿到 usage，总量只覆盖已计量部分）'
    case 'none':
      return '无计量（没有拿到任何 provider usage）'
    default:
      return '覆盖率未知（无法识别的取值）'
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

/**
 * 单条用量记录入账（dayKey 已由调用方按事件 ts 计算，保持纯函数无时钟依赖）。
 *
 * P2-5：`meteredCalls` / `unmeteredCalls` 若由调用方给出就一并累加（每次调用记 1，
 * 由 host 侧按「拿到/没拿到 usage」决定），缺省则不写字段（= 未知，覆盖率保守 partial）。
 * 四桶与 `calls` 的口径不受影响（与总量解耦）。
 */
export function accumulate(
  file: TokensFile,
  memberId: string,
  dayKey: string,
  usage: Omit<TokenBuckets, 'calls' | 'meteredCalls' | 'unmeteredCalls'> & {
    calls?: number
    meteredCalls?: number
    unmeteredCalls?: number
  },
): TokensFile {
  const delta: TokenBuckets = {
    uncachedInput: usage.uncachedInput,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    calls: usage.calls ?? 1,
  }
  // 只在调用方给出时携带（缺省 = 未知；编 0 会把「没记录」说成「全未计量」）
  if (typeof usage.meteredCalls === 'number' && Number.isFinite(usage.meteredCalls)) {
    delta.meteredCalls = countOrZero(usage.meteredCalls)
  }
  if (typeof usage.unmeteredCalls === 'number' && Number.isFinite(usage.unmeteredCalls)) {
    delta.unmeteredCalls = countOrZero(usage.unmeteredCalls)
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

/** 计数归一：非有限数 / 负数 / 小数 → 非负整数（坏数据不让三态抖动） */
function countOrZero(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/** 可选计数求和：两侧都缺省 → undefined（保持未知，不编 0） */
function addOptionalCount(a: number | undefined, b: number | undefined): number | undefined {
  const left = typeof a === 'number' && Number.isFinite(a) ? a : undefined
  const right = typeof b === 'number' && Number.isFinite(b) ? b : undefined
  if (left === undefined && right === undefined) return undefined
  return countOrZero(left) + countOrZero(right)
}
