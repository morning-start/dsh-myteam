/**
 * 会话 → 工作区根 的默认解析器。
 *
 * 只接受**绝对路径**：会话 cwd 可能是相对路径（宿主启动目录），相对路径本身
 * 不足以确定项目身份——两个会话可能拿到同一个相对串却指向不同项目。
 *
 * 没有 cwd 或 cwd 不是绝对路径时返回 null：让网关按「未绑定工作区」拒绝，
 * 而不是回落到进程目录。回落会把面板接到错误项目上，属于静默错误。
 */
/** 绝对路径判定（不依赖 node:path：应用层不允许 import 宿主模块）。 */
function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]/.test(value)
}

export interface SessionDirectoryPort {
  /** 返回会话的工作目录；拿不到返回 null。 */
  cwdOf(sessionId: string): string | null
}

export interface SessionRootResolverOptions {
  sessions: SessionDirectoryPort
  /**
   * 明确的单项目模式：宿主只服务一个工作区时才可设置。
   * 默认 `null`（不回落），避免多项目下把面板接到错误项目。
   */
  fixedRoot?: string | null
}

export function createSessionRootResolver(options: SessionRootResolverOptions): (sessionId: string) => string | null {
  const fixed = options.fixedRoot ?? null
  if (fixed !== null && !isAbsolutePath(fixed)) {
    throw new Error(`fixedRoot 必须是绝对路径：${fixed}`)
  }

  return (sessionId) => {
    if (fixed !== null) return fixed
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    const cwd = options.sessions.cwdOf(sessionId)
    if (cwd === null || !isAbsolutePath(cwd)) return null
    return cwd
  }
}