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
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PanelService } from '../application/panel-service.ts'
import { migrationSummaryFor } from '../infrastructure/migration/v1/panel-summary.ts'
import { globalLibraryRoot, readGlobalAudit, readGlobalLibrary } from '../infrastructure/global-library/library.ts'
import { createGlobalEditor, createGlobalPublisher } from '../infrastructure/global-library/write.ts'
import { memoryDbPath, readMemoryStore } from '../infrastructure/memory-store/read.ts'
import { SqliteMemoryStore } from '../infrastructure/memory-store/sqlite-memory.ts'
import { PANEL_METHODS, isGlobalPanelMethod } from '../application/panel-contract.ts'
import {
  applyDirectPanelWrite,
  applyPanelWrite,
  createPanelWriteAuthorizer,
  isPanelWriteMethod,
  panelWriteKind,
  previewPanelWrite,
} from '../application/panel-writes.ts'
import { ProjectHosts } from '../infrastructure/dsh/project-hosts.ts'

/** 与 v1 remote/service.ts 同形的 marker 键：strip 环境没有装饰器，只能手写。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 门面暴露的方法 = 面板契约的方法表（单一真源，避免两处漂移）。 */
export { PANEL_METHODS }

export interface PanelHostContext {
  agents?: { get(id: string): { id: string } | undefined }
  workingDirectory?: { ensure(agent: { id: string }): Promise<string> }
  logger?: { warn(event: string, detail?: Record<string, unknown>): void }
  /** 面板 HTTP 通道：客户端的唯一数据入口（typert 的 ctx.remote 在 profile 插件上不可用）。 */
  webServer?: { register(route: PanelRoute): () => void }
  /** Harness 自己的浏览器准入判定：401 未登录 / 403 Host 不在信任栅栏 / undefined 放行。 */
  connection?: { requestRejection(request: { headers: Record<string, unknown> }): number | undefined }
  /** cordis 作用域回收钩子：有就挂，没有就直接注册（测试替身可以不给）。 */
  effect?: (callback: () => () => void, label?: string) => void
}

/** `webServer.register` 的一行具名 route（宿主契约：exact/prefix + handler）。 */
export interface PanelRoute {
  kind: 'prefix'
  path: string
  handler: (request: PanelRequest, response: PanelResponse) => void | Promise<void>
}

/** 宿主交给 handler 的 node:http 请求里，本通道实际读取的那几个字段。 */
interface PanelRequest extends AsyncIterable<Uint8Array> {
  method?: string
  url?: string
  headers: Record<string, unknown>
}

interface PanelResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
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
  /** 写通道（两段确认）：预览签发令牌 / 凭令牌确认。 */
  write(name: string, sessionId: string, body: unknown): Promise<unknown>
  close(): Promise<void>
}

export function createPanelFacade(ctx: PanelHostContext): PanelFacade {
  const hosts = new ProjectHosts()
  // 迁移分析器在这里装配：v1 影响面报告由迁移模块产出，面板只取三字段。
  const service = new PanelService({
    hosts,
    analyzeMigration: migrationSummaryFor,
    // 应用层只认端口；文件系统怎么读留给这里（架构门禁：application 不得 import infrastructure）。
    globalLibrary: {
      library: () => readGlobalLibrary(globalLibraryRoot()),
      audit: (limit) => readGlobalAudit(globalLibraryRoot(), limit),
    },
    memory: { view: (rootDir, options) => readMemoryStore(rootDir, options) },
  })

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

  const writeAuthorizer = createPanelWriteAuthorizer()
  // 全局发布的写入器：文件系统细节留在 infrastructure，用例只认端口。
  const globalRoot = globalLibraryRoot()
  const globalPublisher = createGlobalPublisher(globalRoot)
  // 全局直改：与发布共用同一段原子写与审计；引用校验读的是**全局目录**，不是项目投影。
  const globalEditor = createGlobalEditor(globalRoot)
  const globalEntries = {
    list: (kind: string) =>
      readGlobalLibrary(globalRoot)
        .entries.filter((entry) => entry.kind === kind)
        .map((entry) => ({ kind: entry.kind as never, id: entry.id, revision: entry.revision ?? 0 })),
  }
  /** 面板写的外部端口：direct 要记忆库，token 要发布器/直改器。两处共用同一份。 */
  const writeDeps = {
    rootDir: undefined as string | undefined,
    publisher: globalPublisher,
    globalEditor,
    globalEntries,
  }

  /**
   * 写通道：按 `panelWriteKind` 分两种确认方式——
   * `token` 方法 `action: confirm` 才执行，否则只预览并签发一次性令牌；
   * `direct` 方法要求请求体带 `confirm: true`，直接执行（域校验自兜底）。
   * 预览与确认必须共用同一个 authorizer（令牌登记在它里面）。
   */
  /**
   * 不依赖会话与工作区、也不是某个项目的写方法。
   *
   * `globalDefinitionSave` 直改的是 `$DSH_HOME/myteam`，跟哪个项目都没关系 ——
   * 全局库面板本来就没有会话（它就是 root scope 的），如果照别的写方法要求「当前会话
   * 绑定工作区」，这个动作在面板上永远点不动。所以这里单独放行：仍要 human（令牌 + HUMAN_ONLY
   * 在用例层把关），但不要求 sessionId。
   */
  const GLOBAL_WRITE_METHODS = new Set<string>(['globalDefinitionSave', 'globalUnpublish'])

  const write = async (name: string, sessionId: string, body: unknown): Promise<unknown> => {
    if (!isPanelWriteMethod(name)) {
      return { ok: false, error: { code: 'INVALID_COMMAND', message: `未知写方法：${name}`, retryable: false } }
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const params = typeof record.params === 'object' && record.params !== null ? (record.params as Record<string, unknown>) : {}

    if (GLOBAL_WRITE_METHODS.has(name)) {
      try {
        // 全局库不属任何项目：直改只看全局目录，不需要 runtime / rootDir。
        if (panelWriteKind(name) === 'direct') {
          return { ok: false, error: { code: 'INVALID_COMMAND', message: `${name} 是 token 通道`, retryable: false } }
        }
        if (record.action === 'confirm') {
          if (record.confirmation === undefined) {
            return { ok: false, error: { code: 'INVALID_PAYLOAD', message: '确认需要 confirmation 令牌', retryable: false } }
          }
          const reason = typeof record.reason === 'string' ? record.reason : ''
          const applied = applyPanelWrite(undefined as never, writeAuthorizer, name, {
            params,
            reason,
            confirmation: record.confirmation as never,
          }, writeDeps)
          return { ok: true, data: JSON.parse(JSON.stringify(applied)) }
        }
        const preview = previewPanelWrite(undefined as never, writeAuthorizer, name, params, writeDeps)
        return { ok: true, data: JSON.parse(JSON.stringify(preview)) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = (error as { code?: string } | null)?.code ?? 'INTERNAL'
        return { ok: false, error: { code, message, retryable: false } }
      }
    }

    if (typeof sessionId !== 'string' || sessionId.length === 0) return forbidden('面板写动作缺少会话身份')
    const agent = ctx.agents?.get(sessionId)
    if (agent === undefined || ctx.workingDirectory === undefined) {
      return forbidden('当前会话没有绑定工作区，不能执行面板写动作')
    }
    try {
      const rootDir = await ctx.workingDirectory.ensure(agent)
      const runtime = await hosts.open(rootDir)
      // 预览与确认都基于最新账本：陈旧投影会让 hash 校验假失败。
      runtime.refresh()
      if (panelWriteKind(name) === 'direct') {
        const applied = applyDirectPanelWrite(
          runtime,
          name,
          { params, confirm: record.confirm === true },
          {
            ...writeDeps,
            rootDir,
            openMemory: (dir: string) => new SqliteMemoryStore(join(dir, memoryDbPath(dir))),
          },
        )
        return { ok: true, data: JSON.parse(JSON.stringify(applied)) }
      }
      if (record.action === 'confirm') {
        if (record.confirmation === undefined) {
          return { ok: false, error: { code: 'INVALID_PAYLOAD', message: '确认需要 confirmation 令牌', retryable: false } }
        }
        const reason = typeof record.reason === 'string' ? record.reason : ''
        const applied = applyPanelWrite(runtime, writeAuthorizer, name, {
          params,
          reason,
          confirmation: record.confirmation as never,
        }, writeDeps)
        return { ok: true, data: JSON.parse(JSON.stringify(applied)) }
      }
      const preview = previewPanelWrite(runtime, writeAuthorizer, name, params, writeDeps)
      return { ok: true, data: JSON.parse(JSON.stringify(preview)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = (error as { code?: string } | null)?.code ?? 'INTERNAL'
      return { ok: false, error: { code, message, retryable: false } }
    }
  }

  const methods: PanelFacade['methods'] = {}
  for (const method of PANEL_METHODS) {
    // 全局库方法不属任何项目：不解析工作区，也不要求会话身份。
    methods[method] = isGlobalPanelMethod(method)
      ? async (_agent: { id: string }, query: unknown) => service.invokeGlobal(method, query)
      : async (agent: { id: string }, query: unknown) => dispatch(agent.id, method, query)
  }

  return { methods, write, close: () => hosts.closeAll() }
}

/**
 * 面板 HTTP 通道（M2 数据面）。
 *
 * 为什么不是 typert：`ctx.remote.<ns>` 的贡献清单属于应用装配（`dsh-api-remotes`
 * 的 Client 半只挂它自己清单里的 remote），profile 插件加 `./remote` 导出也进不去。
 * 所以面板数据走宿主自己的 `webServer.register`：端口本来就在本机回环上，准入
 * 交给 Harness 的 `connection.requestRejection`（401 未登录 / 403 Host 不受信）。
 *
 * 只读方法列表就是门面的 `PANEL_METHODS`，本通道不额外开写路径。
 */
export const PANEL_ROUTE_PREFIX = '/__myteam'

/** 设计稿样式表走的路径（客户端用 `<link>` 引它，不由客户端内嵌色值）。 */
export const PANEL_ASSET_PATH = `${PANEL_ROUTE_PREFIX}/assets/design.css`

/**
 * 把设计稿的 `--dsh-*` 外框层接到宿主的 `--dsw-alias-*` 主题变量上。
 *
 * 设计稿（`design-v2`）是给「DSH 外框静态页」画的，`--dsh-*` 由 `dsh-shell.css`
 * 提供；真实宿主只给 `--dsw-alias-*`。这层适配让同一份 `myteam.css` 在两侧都成立，
 * fallback 取设计稿的浅色值（宿主别名在时永远走别名）。
 */
const HOST_ADAPTER = `/* myteam · 宿主适配层（由 panel.ts 生成，不要手改） */
[data-myteam] {
  --dsh-bg: var(--dsw-alias-bg-base, #ffffff);
  --dsh-side: var(--dsw-alias-bg-layer-2, #f9fafb);
  --dsh-card: var(--dsw-alias-bg-layer-1, #ffffff);
  --dsh-fg: var(--dsw-alias-label-primary, #0f1115);
  --dsh-muted: var(--dsw-alias-label-tertiary, #81858c);
  --dsh-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  --dsh-hover: var(--dsw-alias-interactive-bg-hover, #ebeef2);
  --dsh-accent: var(--dsw-alias-accent, #4176e6);
  --dsh-btn: var(--dsw-alias-button-primary-fill, #0f1115);
  --dsh-btn-fg: var(--dsw-alias-bg-base, #ffffff);
  --dsh-radius-sm: 8px;
  --dsh-radius-md: 12px;
  --dsh-radius-lg: 16px;
  /* 字族必须是具体值：设计稿的 font 简写带 var(--dsh-font)，若这里给的是
     inherit（CSS-wide 关键字），整条简写在计算值阶段失效，字号会回落成 16px
     —— 会话「团队视图」导航轨、标题、输入框都被撑大。 */
  --dsh-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --dsh-font-code: var(--dsw-alias-font-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
[data-myteam] > .wt { flex: 1 1 auto; min-width: 0; min-height: 0; }
`

/**
 * 组装客户端样式：设计稿两份 CSS 原样取用，只做两件事——
 * 把外框作用域 `[data-slot="main"]` 换成插件自己的 `[data-myteam]`（避免与宿主
 * 主区选择器撞车），把 `:root` / 深色段收进同一作用域。
 * @param read - 读设计稿文件的函数（生产是 readFile，测试给内存实现）。
 */
export function buildDesignCss(read: (file: string) => string): string {
  const scope = (css: string): string =>
    css
      .replace(/:root\s*\{/gu, '[data-myteam] {')
      .replace(
        /\[data-theme="dark"\]\s*\{/gu,
        'html[data-theme="dark"] [data-myteam], [data-myteam][data-theme="dark"] {',
      )
      .replace(/\[data-slot="main"\]/gu, '[data-myteam]')
  return [HOST_ADAPTER, scope(read('tokens.css')), scope(read('myteam.css'))].join('\n')
}

/** 请求体上限：面板查询是短 JSON，超过就是误用。 */
const MAX_PANEL_BODY = 64 * 1024

const PANEL_METHOD_SET: ReadonlySet<string> = new Set(PANEL_METHODS)

function sendPanelJson(
  request: PanelRequest,
  response: PanelResponse,
  status: number,
  payload: unknown,
  extra?: Record<string, string>,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extra ?? {}),
  })
  response.end(request.method === 'HEAD' ? undefined : `${JSON.stringify(payload)}\n`)
}

function panelFailure(code: string, message: string, retryable = false): PanelFailure {
  return { ok: false, error: { code, message, retryable } }
}

/** 读完请求体；超限返回 `undefined`（调用方回 413），坏 JSON 回 undefined 且标记区分。 */
async function readPanelBody(request: PanelRequest): Promise<{ parsed?: unknown; tooLarge?: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.byteLength
    if (size > MAX_PANEL_BODY) return { tooLarge: true }
    chunks.push(chunk)
  }
  if (size === 0) return { parsed: {} }
  try {
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
    return { parsed: JSON.parse(text) }
  } catch {
    return { parsed: undefined }
  }
}

/**
 * 建面板路由的 handler。
 * @param facade - 门面（方法表与业务都在里面）。
 * @param host - 只需要 `connection` 与 `logger`。
 */
export function createPanelRouteHandler(
  facade: PanelFacade,
  host: PanelHostContext,
  loadDesignCss?: () => Promise<string>,
): (request: PanelRequest, response: PanelResponse) => Promise<void> {
  return async function handlePanelRoute(request: PanelRequest, response: PanelResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
    const rejection = host.connection?.requestRejection({ headers: request.headers ?? {} })
    if (rejection === 401) {
      sendPanelJson(request, response, 401, panelFailure('MT_UNAUTHENTICATED', '会话未认证，请刷新页面后重试'))
      return
    }
    if (rejection === 403) {
      sendPanelJson(
        request,
        response,
        403,
        panelFailure('MT_UNTRUSTED_HOST', '这个 Host 不在信任栅栏里；经代理访问时给 dsh 加 --trusted-host'),
      )
      return
    }

    // 设计稿样式表：GET 一次、按页面缓存（no-store：换设计稿立刻生效）。
    if (pathname === PANEL_ASSET_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendPanelJson(request, response, 405, panelFailure('MT_METHOD_NOT_ALLOWED', '样式表只接受 GET'), {
          allow: 'GET, HEAD',
        })
        return
      }
      if (loadDesignCss === undefined) {
        sendPanelJson(request, response, 404, panelFailure('MT_ASSET_UNAVAILABLE', '样式表未装配'))
        return
      }
      try {
        const css = await loadDesignCss()
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
        response.end(request.method === 'HEAD' ? undefined : css)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        host.logger?.warn('myteam.panel.asset-failed', { error: message })
        sendPanelJson(request, response, 500, panelFailure('MT_ASSET_UNAVAILABLE', message, true))
      }
      return
    }

    // 写通道：路径 `/__myteam/write/<name>`，POST，必须带 sessionId。
    if (pathname.startsWith(`${PANEL_ROUTE_PREFIX}/write/`)) {
      if (request.method !== 'POST') {
        sendPanelJson(request, response, 405, panelFailure('MT_METHOD_NOT_ALLOWED', '写通道只接受 POST'), { allow: 'POST' })
        return
      }
      const writeName = pathname.slice(`${PANEL_ROUTE_PREFIX}/write/`.length)
      const raw = await readPanelBody(request)
      if (raw.tooLarge === true) {
        sendPanelJson(request, response, 413, panelFailure('MT_BODY_TOO_LARGE', '请求体过大'))
        return
      }
      const envelope = typeof raw.parsed === 'object' && raw.parsed !== null ? (raw.parsed as Record<string, unknown>) : undefined
      if (envelope === undefined) {
        sendPanelJson(request, response, 400, panelFailure('MT_BAD_REQUEST', '请求体必须是 JSON 对象'))
        return
      }
      const writeSession = typeof envelope.sessionId === 'string' ? envelope.sessionId : ''
      // 全局库写方法不属任何项目（面板本身也是 root scope、没有会话），不强制 sessionId。
      const globalWrites = new Set(['globalDefinitionSave', 'globalUnpublish'])
      if (writeSession.length === 0 && !(envelope as Record<string, unknown>).__global === true && !globalWrites.has(writeName)) {
        sendPanelJson(request, response, 400, panelFailure('MT_BAD_REQUEST', '写动作必须带 sessionId'))
        return
      }
      const result = await facade.write(writeName, writeSession, envelope)
      sendPanelJson(request, response, 200, result)
      return
    }

    if (request.method !== 'POST') {
      sendPanelJson(request, response, 405, panelFailure('MT_METHOD_NOT_ALLOWED', '面板通道只接受 POST'), {
        allow: 'POST',
      })
      return
    }
    const name = pathname.startsWith(`${PANEL_ROUTE_PREFIX}/`)
      ? pathname.slice(PANEL_ROUTE_PREFIX.length + 1)
      : ''
    if (!PANEL_METHOD_SET.has(name)) {
      sendPanelJson(request, response, 404, panelFailure('MT_UNKNOWN_METHOD', `未知面板方法：${name || '(空)'}`))
      return
    }

    const body = await readPanelBody(request)
    if (body.tooLarge === true) {
      sendPanelJson(request, response, 413, panelFailure('MT_BODY_TOO_LARGE', '请求体过大'))
      return
    }
    const envelope = typeof body.parsed === 'object' && body.parsed !== null ? (body.parsed as Record<string, unknown>) : undefined
    if (envelope === undefined) {
      sendPanelJson(request, response, 400, panelFailure('MT_BAD_REQUEST', '请求体必须是 JSON 对象'))
      return
    }
    const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId : ''
    if (sessionId.length === 0 && !isGlobalPanelMethod(name)) {
      sendPanelJson(request, response, 400, panelFailure('MT_BAD_REQUEST', '缺少 sessionId'))
      return
    }

    try {
      const result = await facade.methods[name]({ id: sessionId }, envelope.query ?? {})
      sendPanelJson(request, response, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      host.logger?.warn('myteam.panel.route-failed', { method: name, error: message })
      sendPanelJson(request, response, 500, panelFailure('MT_INTERNAL', message, true))
    }
  }
}

/**
 * 设计稿目录。
 *
 * 两种安装形态都要成立：
 *   - **npm 安装/打包安装**：`<包根>/design-v2`（`scripts/build-lib.mjs` 在构建时把仓库的
 *     `design-v2` 拷进包里，`package.json` 的 `files` 带上它）；
 *   - **仓库开发 / `link:` 安装**：`<包根>/../design-v2`（设计稿在仓库根）。
 *
 * 早期只算了后者，结果是 `link:` 安装一切正常、复制安装（= 真正的 npm 安装）样式表 500、
 * 面板裸奔 —— 隔离实例用的是 `link:`，一直没暴露。
 * `MYTEAM_DESIGN_DIR` 仍然可以覆盖（调试或让两侧读同一份设计稿时用）。
 * @returns 绝对路径。
 */
export function resolveDesignDir(): string {
  const fromEnv = process.env.MYTEAM_DESIGN_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
  // 先看仓库根（开发 / `link:` 安装：改 design-v2 立刻生效），再看包内副本（打包安装）。
  const candidates = [join(packageRoot, '..', 'design-v2'), join(packageRoot, 'design-v2')]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'myteam.css'))) return dir
  }
  return candidates[0]
}

/**
 * 生产用的样式表加载器：读设计稿两份 CSS，交给 {@link buildDesignCss} 组装。
 * 读不到就是读不到——抛错由路由回 500 并记 warning，不返回半份样式。
 * @param designDir - 设计稿目录，默认 {@link resolveDesignDir}。
 */
export function createDesignCssLoader(designDir: string = resolveDesignDir()): () => Promise<string> {
  return async () => {
    const [tokens, sheet] = await Promise.all([
      readFile(join(designDir, 'tokens.css'), 'utf8'),
      readFile(join(designDir, 'myteam.css'), 'utf8'),
    ])
    const files: Record<string, string> = { 'tokens.css': tokens, 'myteam.css': sheet }
    return buildDesignCss((file) => {
      const text = files[file]
      if (text === undefined) throw new Error(`design-v2 缺少 ${file}`)
      return text
    })
  }
}

/**
 * Cordis 装配入口。宿主包里才有 `@deepseek-ai/dsh-typert-protocol`，所以这里
 * 动态导入：拿不到就明确告警并不注册，而不是让整个 profile 起不来。
 */
export const inject = ['agents', 'workingDirectory', 'webServer', 'connection']

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

  // 面板数据通道：客户端 fetch 的唯一入口（见 PANEL_ROUTE_PREFIX 的注释）。
  const handler = createPanelRouteHandler(facade, ctx, createDesignCssLoader())
  const registerRoute = (): (() => void) => {
    if (ctx.webServer === undefined) {
      ctx.logger?.warn('myteam.panel.route-unavailable', { reason: '宿主没有 webServer 服务' })
      return () => {}
    }
    try {
      return ctx.webServer.register({ kind: 'prefix', path: PANEL_ROUTE_PREFIX, handler })
    } catch (error) {
      // 重复路径会抛错：报出来而不是静默少一条通道。
      ctx.logger?.warn('myteam.panel.route-register-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return () => {}
    }
  }
  if (ctx.effect !== undefined) ctx.effect(registerRoute, 'myteam: panel route')
  else registerRoute()

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