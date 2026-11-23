/**
 * t31：面板 HTTP 通道（`/__myteam/<method>`）。
 *
 * 为什么要有这组测试：客户端的数据面从此只走这一条路，它同时又是一个**对外
 * 暴露的 HTTP 入口**。准入（Harness 的 requestRejection）、方法白名单、请求体
 * 上限、错误信封，任何一项失守都不是「界面空一块」，而是「谁都能读项目看板」
 * 或者「界面永远转圈」。所以每一条拒绝都要有断言，不能只测 happy path。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createPanelRouteHandler, PANEL_ROUTE_PREFIX, PANEL_ASSET_PATH, buildDesignCss, resolveDesignDir } = (await import(
  pathToFileURL(join(ROOT, 'lib', 'composition', 'panel.mjs')).href
)) as {
  createPanelRouteHandler: (
    facade: unknown,
    host: unknown,
    loadDesignCss?: () => Promise<string>,
  ) => (request: unknown, response: unknown) => Promise<void>
  PANEL_ROUTE_PREFIX: string
  PANEL_ASSET_PATH: string
  buildDesignCss: (read: (file: string) => string) => string
  resolveDesignDir: () => string
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

/** 造一个 node:http 风格的请求：method/url/headers + 可异步迭代的 body。 */
function request(method: string, path: string, body?: unknown, headers: Record<string, unknown> = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')]
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:4399', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个收集写回的响应。 */
function response(): { res: unknown; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status
      captured.headers = headers
    },
    end(body?: string) {
      captured.body = body ?? ''
    },
  }
  return { res, captured }
}

function facadeOf(result: unknown, calls: string[]) {
  const methods: Record<string, (agent: { id: string }, query: unknown) => Promise<unknown>> = {}
  for (const name of ['status', 'overview', 'board', 'task', 'team', 'definitions', 'migration']) {
    methods[name] = async (agent, query) => {
      calls.push(`${name}:${agent.id}:${JSON.stringify(query)}`)
      return result
    }
  }
  return { methods, close: async () => {} }
}

function hostOf(rejection?: number, warnings: string[] = []) {
  return {
    connection: { requestRejection: () => rejection },
    logger: { warn: (event: string) => warnings.push(event) },
  }
}

test('只接受 POST；其余方法回 405 且带 Allow', async () => {
  const { res, captured } = response()
  const handler = createPanelRouteHandler(facadeOf({ ok: true, data: {} }, []), hostOf())
  await handler(request('GET', `${PANEL_ROUTE_PREFIX}/board`), res)
  assert.equal(captured.status, 405)
  assert.equal(captured.headers.allow, 'POST')
})

test('未认证 401、Host 不受信 403：都不进业务', async () => {
  const calls: string[] = []
  for (const [rejection, status, code] of [
    [401, 401, 'MT_UNAUTHENTICATED'],
    [403, 403, 'MT_UNTRUSTED_HOST'],
  ] as const) {
    const { res, captured } = response()
    const handler = createPanelRouteHandler(facadeOf({ ok: true, data: {} }, calls), hostOf(rejection))
    await handler(request('POST', `${PANEL_ROUTE_PREFIX}/board`, { sessionId: 's1', query: {} }), res)
    assert.equal(captured.status, status)
    assert.equal(JSON.parse(captured.body).error.code, code)
  }
  assert.deepEqual(calls, [], '被拒绝的请求不能触达门面')
})

test('方法白名单之外一律 404（不把任意字符串交给门面）', async () => {
  const calls: string[] = []
  const { res, captured } = response()
  const handler = createPanelRouteHandler(facadeOf({ ok: true, data: {} }, calls), hostOf())
  await handler(request('POST', `${PANEL_ROUTE_PREFIX}/deleteEverything`, { sessionId: 's1' }), res)
  assert.equal(captured.status, 404)
  assert.equal(JSON.parse(captured.body).error.code, 'MT_UNKNOWN_METHOD')
  assert.deepEqual(calls, [])
})

test('缺 sessionId / 非对象 body 都回 400', async () => {
  const calls: string[] = []
  const facade = facadeOf({ ok: true, data: {} }, calls)

  let { res, captured } = response()
  await createPanelRouteHandler(facade, hostOf())(request('POST', `${PANEL_ROUTE_PREFIX}/board`, {}), res)
  assert.equal(captured.status, 400)
  assert.equal(JSON.parse(captured.body).error.code, 'MT_BAD_REQUEST')

  ;({ res, captured } = response())
  const bad = request('POST', `${PANEL_ROUTE_PREFIX}/board`)
  ;(bad as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('not json', 'utf8')
  }
  await createPanelRouteHandler(facade, hostOf())(bad, res)
  assert.equal(captured.status, 400)
  assert.deepEqual(calls, [])
})

test('请求体超过 64 KiB 回 413（面板查询是短 JSON）', async () => {
  const { res, captured } = response()
  const huge = request('POST', `${PANEL_ROUTE_PREFIX}/board`, { sessionId: 's1', query: { blob: 'x'.repeat(70 * 1024) } })
  await createPanelRouteHandler(facadeOf({ ok: true, data: {} }, []), hostOf())(huge, res)
  assert.equal(captured.status, 413)
  assert.equal(JSON.parse(captured.body).error.code, 'MT_BODY_TOO_LARGE')
})

test('happy path：门面收到 sessionId 与 query，回包原样是 {ok,data}', async () => {
  const calls: string[] = []
  const { res, captured } = response()
  const data = { totals: { all: 3, done: 1, review: 1, blocked: 0 }, columns: [] }
  await createPanelRouteHandler(facadeOf({ ok: true, data }, calls), hostOf())(
    request('POST', `${PANEL_ROUTE_PREFIX}/board`, { sessionId: 's1', query: { limit: 5 } }),
    res,
  )
  assert.equal(captured.status, 200)
  assert.match(captured.headers['content-type'], /application\/json/)
  assert.equal(captured.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(captured.body), { ok: true, data })
  assert.deepEqual(calls, ['board:s1:{"limit":5}'])
})

test('门面抛错回 500 + MT_INTERNAL，并记一条 warning（不吞异常）', async () => {
  const warnings: string[] = []
  const facade = {
    methods: {
      board: async () => {
        throw new Error('project root vanished')
      },
    },
    close: async () => {},
  }
  const { res, captured } = response()
  await createPanelRouteHandler(facade, hostOf(undefined, warnings))(
    request('POST', `${PANEL_ROUTE_PREFIX}/board`, { sessionId: 's1' }),
    res,
  )
  assert.equal(captured.status, 500)
  assert.equal(JSON.parse(captured.body).error.message, 'project root vanished')
  assert.deepEqual(warnings, ['myteam.panel.route-failed'])
})
test('设计稿样式表：作用域换成 [data-myteam]，GET 回 text/css', async () => {
  const css = buildDesignCss((file) =>
    file === 'tokens.css' ? ':root { --mt-run: var(--dsw-alias-state-ok-primary, #15803d); }' : '[data-slot="main"] .wt { color: var(--dsh-fg); }',
  )
  assert.match(css, /\[data-myteam\]/, '设计稿的 :root 与 [data-slot="main"] 都要收进插件作用域')
  assert.ok(!css.includes('[data-slot="main"]'), '不能把外框作用域原样带进真宿主')

  const { res, captured } = response()
  const handler = createPanelRouteHandler(facadeOf({ ok: true, data: {} }, []), hostOf(), async () => css)
  await handler(request('GET', PANEL_ASSET_PATH), res)
  assert.equal(captured.status, 200)
  assert.match(captured.headers['content-type'], /text\/css/)
  assert.match(captured.body, /\[data-myteam\] \.wt/)
})

test('设计稿目录：仓库开发与打包安装两种形态都读得到样式表', () => {
  // 为什么会漏：样式表目录原来只按「包根/../design-v2」推，仓库开发与 link: 安装都成立；
  // 一旦打包装（= 真 npm 安装，包被复制到 node_modules/dsh-plugin-myteam），
  // 那个路径指向 node_modules/design-v2 → 样式表 500、面板裸奔。
  const designDir = resolveDesignDir()
  assert.ok(existsSync(join(designDir, 'myteam.css')), `design 目录里没有 myteam.css：${designDir}`)
  assert.ok(existsSync(join(designDir, 'tokens.css')), `design 目录里没有 tokens.css：${designDir}`)

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }
  assert.ok(manifest.files.includes('design-v2'), 'package.json 的 files 必须带 design-v2，否则包里没有样式表')

  const build = readFileSync(join(ROOT, 'scripts', 'build-lib.mjs'), 'utf8')
  assert.match(build, /copyDesignAssets\(\)/, '构建必须把仓库 design-v2 拷进包里（打包安装才读得到）')
})

test('样式表同样过准入：未认证 401，且不装配时 404', async () => {
  const unauthenticated = response()
  await createPanelRouteHandler(facadeOf({ ok: true, data: {} }, []), hostOf(401), async () => 'x')(
    request('GET', PANEL_ASSET_PATH),
    unauthenticated.res,
  )
  assert.equal(unauthenticated.captured.status, 401)

  const missing = response()
  await createPanelRouteHandler(facadeOf({ ok: true, data: {} }, []), hostOf())(
    request('GET', PANEL_ASSET_PATH),
    missing.res,
  )
  assert.equal(missing.captured.status, 404)
  assert.equal(JSON.parse(missing.captured.body).error.code, 'MT_ASSET_UNAVAILABLE')
})

test('数据通道不接受 GET（只读查询也不走 query string）', async () => {
  const { res, captured } = response()
  await createPanelRouteHandler(facadeOf({ ok: true, data: {} }, []), hostOf())(
    request('GET', `${PANEL_ROUTE_PREFIX}/board`),
    res,
  )
  assert.equal(captured.status, 405)
  assert.equal(captured.headers.allow, 'POST')
})

test('全局库方法不需要 sessionId；项目方法仍然要', async () => {
  const calls: string[] = []
  const facade = {
    methods: {
      globalLibrary: async (_agent: { id: string }, query: unknown) => {
        calls.push(JSON.stringify(query))
        return { ok: true, data: { exists: false } }
      },
      board: async () => {
        calls.push('board')
        return { ok: true, data: {} }
      },
    },
    close: async () => {},
  }

  const global = response()
  await createPanelRouteHandler(facade, hostOf())(request('POST', `${PANEL_ROUTE_PREFIX}/globalLibrary`, { query: {} }), global.res)
  assert.equal(global.captured.status, 200, '全局方法没有 sessionId 也要能读')
  assert.deepEqual(calls, ['{}'])

  const project = response()
  await createPanelRouteHandler(facade, hostOf())(request('POST', `${PANEL_ROUTE_PREFIX}/board`, {}), project.res)
  assert.equal(project.captured.status, 400, '项目方法缺 sessionId 必须拒绝')
  assert.deepEqual(calls, ['{}'], '被拒绝的请求不能触达门面')
})

test('写通道：缺 sessionId 400、未知写方法 200+INVALID_COMMAND、未认证 401', async () => {
  const facade = {
    methods: {},
    write: async (name: string) => ({
      ok: false,
      error: { code: 'INVALID_COMMAND', message: `未知写方法：${name}`, retryable: false },
    }),
    close: async () => {},
  }

  const noSession = response()
  await createPanelRouteHandler(facade, hostOf())(
    request('POST', `${PANEL_ROUTE_PREFIX}/write/teamDisband`, { params: {} }),
    noSession.res,
  )
  assert.equal(noSession.captured.status, 400, '写动作必须带 sessionId')

  const unknown = response()
  await createPanelRouteHandler(facade, hostOf())(
    request('POST', `${PANEL_ROUTE_PREFIX}/write/nope`, { sessionId: 's1' }),
    unknown.res,
  )
  assert.equal(unknown.captured.status, 200)
  assert.equal(JSON.parse(unknown.captured.body).error.code, 'INVALID_COMMAND')

  const unauthenticated = response()
  await createPanelRouteHandler(facade, hostOf(401))(
    request('POST', `${PANEL_ROUTE_PREFIX}/write/teamDisband`, { sessionId: 's1' }),
    unauthenticated.res,
  )
  assert.equal(unauthenticated.captured.status, 401, '写通道同样过浏览器准入')
})