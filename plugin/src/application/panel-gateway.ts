/**
 * 面板网关：把「DSH 会话」翻译成「项目根」，再交给面板服务。
 *
 * 为什么单独一层：面板服务只认工作区根，不认会话；宿主只认会话。中间这层
 * 负责唯一一件安全相关的事——**会话没有绑定工作区就拒绝**，而不是猜一个根。
 *
 * 它不依赖宿主 API：`rootForSession` 由装配层注入（生产实现读会话 cwd，
 * 测试给假实现）。这样网关可以在 Node 里直接测。
 */
import type { ErrorShape } from '../contracts/errors.ts'
import { ERROR_CODES } from '../contracts/errors.ts'
import type { PanelRequest, PanelResponse } from './panel-contract.ts'
import type { PanelService } from './panel-service.ts'

export interface PanelGatewayService {
  invoke(rootDir: string, request: unknown): Promise<PanelResponse>
}

export interface PanelGatewayOptions {
  service: PanelService | PanelGatewayService
  /** 会话 → 工作区根；返回 null 表示这个会话不属于任何项目。 */
  rootForSession: (sessionId: string) => string | null
}

export interface PanelGateway {
  invoke(sessionId: string, request: PanelRequest | unknown): Promise<PanelResponse>
}

function forbidden(message: string): { ok: false; error: ErrorShape } {
  return {
    ok: false,
    error: { code: ERROR_CODES.FORBIDDEN, message, retryable: false },
  }
}

export function createPanelGateway(options: PanelGatewayOptions): PanelGateway {
  return {
    async invoke(sessionId, request) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return forbidden('面板调用缺少会话身份')
      }
      const rootDir = options.rootForSession(sessionId)
      if (rootDir === null) {
        return forbidden('当前会话没有绑定工作区，不能读取项目面板')
      }
      return options.service.invoke(rootDir, request)
    },
  }
}