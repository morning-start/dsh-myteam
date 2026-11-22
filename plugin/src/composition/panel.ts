/**
 * 面板 RPC 门面（root 级）。
 *
 * 为什么必须是 root 级：队长 preset 内的服务会被要求 `isolate`（entry-local realm），
 * 而网关只扫 root 可见服务 → 客户端 `ctx.remote.myteam.*` 在 claims 层会被拒。
 * v1 已经踩过这个坑（见 docs/architecture/05-面板RPC适配设计.md）。
 *
 * 本文件只做三件事：把 7 个只读方法摊平、按会话解析工作区、把结果交给
 * `PanelService`。业务一律在服务里，这里不做判断。
 */
import { PanelService } from '../application/panel-service.ts'
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'

/** 与 v1 remote/service.ts 同形的 marker 键：strip 环境没有装饰器，只能手写。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export const PANEL_METHODS = [
  'status',
  'overview',
  'board',
  'task',
  'team',
  'definitions',
  'migration',
] as const

export interface PanelHostContext {
  agents?: { get(id: string): { id: string } | undefined }
  workingDirectory?: { ensure(agent: { id: string }): Promise<string> }
  logger?: { warn(event: string, detail?: Record<string, unknown>): void }
}

interface PanelFailure {
  ok: false
  error: { code: string; message: string; retryable: boolean }
}

function forbidden(message: string): PanelFailure {
  return { ok: false, error: { code: 'FORBIDDEN', message, retryable: false } }
}

export interface PanelFacade {
  /** 方法与 RPC 名一一对应；签名固定为 `(agent, query)`（网关按首参名做 lookup）。 */
  methods: Record<string, (agent: { id: string }, query: unknown) => Promise<unknown>>
  close(): Promise<void>
}

export function createPanelFacade(ctx: PanelHostContext): PanelFacade {
  const hosts = new ProjectHosts()
  const service = new PanelService({ hosts })

  const dispatch = async (sessionId: string, method: string, query: unknown): Promise<unknown> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return forbidden('面板调用缺少会话身份')
    const agent = ctx.agents?.get(sessionId)
    if (agent === undefined || ctx.workingDirectory === undefined) {
      return forbidden('当前会话没有绑定工作区，不能读取项目面板')
    }
    try {
      const rootDir = await ctx.workingDirectory.ensure(agent)
      return await service.invoke(rootDir, { method, params: query ?? {} })
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      }
    }
  }

  const methods: PanelFacade['methods'] = {}
  for (const method of PANEL_METHODS) {
    methods[method] = async (agent: { id: string }, query: unknown) => dispatch(agent.id, method, query)
  }

  return { methods, close: () => hosts.closeAll() }
}

/**
 * Cordis 装配入口。宿主包里才有 `@deepseek-ai/dsh-typert-protocol`，所以这里
 * 动态导入：拿不到就明确告警并不注册，而不是让整个 profile 起不来。
 */
export const inject = ['agents', 'workingDirectory']

/**
 * 解析 `@deepseek-ai/dsh-typert-protocol`：它只存在于宿主安装目录，不是本包的
 * 依赖，所以先试裸包名，失败再从 `DSH_INSTALL_DIR` 的兄弟包里按需解析。
 */
async function loadProtocol(): Promise<unknown> {
  try {
    return await import('@deepseek-ai/dsh-typert-protocol')
  } catch {
    // 落到宿主安装目录
  }
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir === undefined || installDir.length === 0) {
    throw new Error('DSH_INSTALL_DIR 未设置，无法定位 typert 协议包')
  }
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { join } = await import('node:path')
  const requireFromHost = createRequire(join(installDir, 'package.json'))
  const resolved = requireFromHost.resolve('@deepseek-ai/dsh-typert-protocol')
  return await import(pathToFileURL(resolved).href)
}

export function apply(ctx: PanelHostContext): void {
  const facade = createPanelFacade(ctx)
  void loadProtocol()
    .then((protocol: unknown) => {
      const base = (protocol as { TypertRemoteService?: new (ctx: unknown, key: string, options: unknown) => object })
        .TypertRemoteService
      if (base === undefined) {
        ctx.logger?.warn('myteam.panel.protocol-missing')
        return
      }
      class MyTeamPanelFacade extends base {
        constructor() {
          super(ctx, 'myteamPanel', { namespace: 'myteam' })
        }
      }
      const prototype = MyTeamPanelFacade.prototype as unknown as Record<string, unknown>
      for (const [name, handler] of Object.entries(facade.methods)) {
        Object.defineProperty(prototype, name, {
          configurable: true,
          value: handler,
          writable: true,
        })
      }
      Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
        configurable: true,
        value: Object.freeze({
          version: 1,
          methods: Object.freeze(
            PANEL_METHODS.map((method) =>
              Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
            ),
          ),
        }),
      })
      try {
        new MyTeamPanelFacade()
        ctx.logger?.warn('myteam.panel.registered', { namespace: 'myteam', methods: PANEL_METHODS.length })
      } catch (error) {
        ctx.logger?.warn('myteam.panel.construct-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
    .catch((error: unknown) => {
      ctx.logger?.warn('myteam.panel.protocol-import-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

export default apply