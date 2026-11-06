/**
 * FR-5.4 scope 完成审计（CHG-87 / M2-C 剩余）：任务声明 writeScopes，完成时**对照
 * 证据块申报的文件**审计越界。
 *
 * 为什么是「完成时审计」而不是「写拦截」（FR-5.4 原文）：
 *  宿主 write 工具不可拦截（bash / 编辑器 / 模型自建脚本都可能写文件），拦截只能覆盖
 *  一小部分通道却给人「已经拦住」的错觉。诚实的做法是**诚实声明 + 事后对账**：
 *  任务在 `writeScopes` 里声明它可以改哪些路径，成员在证据块里申报这次改动了哪些文件，
 *  host 在门禁/完成时对账，越界写进 gate 结果留痕。**越界不阻断交付**（阻断只会
 *   incentivize 少报），但看板/详情能看见。
 *
 * 纯函数（无 IO、无 ctx）〔J1〕：路径归一化 + 前缀匹配 + 三段结果。
 */

/** 一次 scope 审计的结果（落 gate 结果 payload，fold 进投影） */
export interface ScopeAudit {
  /** 证据块申报的文件（原样，去重后保序） */
  declared: string[]
  /** 任务声明的可写范围（空前缀 = 不审计） */
  writeScopes: string[]
  /** 申报文件里落在声明范围外的（越界清单） */
  outOfScope: string[]
  /** 是否通过（无越界；未声明 writeScopes 时恒 true） */
  ok: boolean
  /** 审计时刻 */
  checkedAt: number
}

/** 统一路径分隔符 + 去掉 `./` 前缀（Windows 反斜杠与 posix 混用是常态） */
export function normalizeScopePath(path: string): string {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim()
}

/**
 * 前缀匹配：scope 以 `/` 结尾时表示「目录下所有文件」；否则要求整段相等。
 * 支持 `*` 单段通配与 `**` 跨段通配（够用即可，不做完整 glob 引擎）。
 */
export function matchesScope(file: string, scope: string): boolean {
  const target = normalizeScopePath(file)
  const pattern = normalizeScopePath(scope)
  if (pattern.length === 0) return false
  if (pattern === target) return true
  // 目录语义：`plugin/src/` 覆盖 `plugin/src/a.ts`；`plugin/src` 只覆盖自身
  if (pattern.endsWith('/') && target.startsWith(pattern)) return true
  if (!pattern.includes('*')) {
    // 无通配时按目录前缀理解（任务作者写 `plugin/src` 的意图显然是目录）
    return target.startsWith(`${pattern}/`)
  }
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((segment) =>
        segment === '**'
          ? '.*'
          : segment
              .split('*')
              .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*'),
      )
      .join('/')}$`,
  )
  return regex.test(target)
}

/**
 * 审计入口（纯函数）。
 *
 * @param declared   证据块里申报的 `filesTouched`（可能含重复/空值/相对路径）
 * @param writeScopes 任务声明的可写范围；**空数组 = 未声明 → 不审计**（ok:true，outOfScope 空）
 * @param now        审计时刻（注入以便单测；缺省 Date.now()）
 *
 * 语义细节：
 *  - 未声明 writeScopes 与「声明了空数组」等价：不审计（不是「全部越界」——
 *    那会让所有老任务一升级就集体报越界）；
 *  - 申报文件里落在**任何**一个 scope 内即算合规（并集）；
 *  - 越界清单按首次出现顺序去重。
 */
export function auditWriteScopes(
  declared: unknown,
  writeScopes: unknown,
  now: number = Date.now(),
): ScopeAudit {
  const declaredList = dedupe(toStringArray(declared).map(normalizeScopePath).filter((item) => item.length > 0))
  const scopes = dedupe(toStringArray(writeScopes).map(normalizeScopePath).filter((item) => item.length > 0))
  if (scopes.length === 0) {
    return { declared: declaredList, writeScopes: [], outOfScope: [], ok: true, checkedAt: now }
  }
  const outOfScope = declaredList.filter((file) => !scopes.some((scope) => matchesScope(file, scope)))
  return { declared: declaredList, writeScopes: scopes, outOfScope, ok: outOfScope.length === 0, checkedAt: now }
}

/**
 * 从证据块里提取申报文件（`kind=commands` 的 `commands[].filesTouched`）。
 * `kind=na` 无文件面 → 空数组（显式 N/A 的任务不产生越界噪音）。
 */
export function filesTouchedOf(evidence: Record<string, unknown> | undefined | null): string[] {
  if (!evidence || typeof evidence !== 'object') return []
  if (evidence.kind !== 'commands') return []
  const commands = evidence.commands
  if (!Array.isArray(commands)) return []
  const out: string[] = []
  for (const entry of commands) {
    if (!entry || typeof entry !== 'object') continue
    const files = (entry as Record<string, unknown>).filesTouched
    if (!Array.isArray(files)) continue
    for (const file of files) {
      if (typeof file === 'string' && file.trim().length > 0) out.push(file.trim())
    }
  }
  return dedupe(out)
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? ''))
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)]
}
