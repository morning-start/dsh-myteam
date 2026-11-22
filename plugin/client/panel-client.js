/**
 * 面板 RPC 客户端（与传输无关）。
 *
 * 只做一件事：把 `call(method, params)` 包装成方法，并统一处理 `{ok:false}`。
 * 它不认识 DSH、不认识 HTTP、也不认识 fixture——传输由调用方注入，因此同一份
 * 客户端可以跑在宿主 Client、静态演示页和测试里。
 *
 * 错误一律抛 `PanelError`（带服务端 `code`），不返回 `undefined` 让界面自己猜。
 */

export class PanelError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'PanelError'
    this.code = code
    this.details = details ?? null
  }
}

function unwrap(response) {
  if (response === null || typeof response !== 'object') {
    throw new PanelError('INVALID_RESPONSE', '面板返回了非对象响应')
  }
  if (response.ok === true) return response.data
  const error = response.error ?? {}
  throw new PanelError(error.code ?? 'UNKNOWN', error.message ?? '面板调用失败', error.details)
}

export function createPanelClient(call) {
  if (typeof call !== 'function') throw new TypeError('createPanelClient 需要 call(method, params)')
  const invoke = async (method, params) => unwrap(await call(method, params ?? {}))

  return {
    status: () => invoke('status'),
    overview: () => invoke('overview'),
    board: () => invoke('board'),
    task: (taskId) => invoke('task', { taskId }),
    team: (teamId) => invoke('team', { teamId }),
    definitions: () => invoke('definitions'),
    migration: () => invoke('migration'),
  }
}