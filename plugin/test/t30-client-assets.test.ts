import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'plugin', 'client', 'client.js')
const DESIGN = join(ROOT, 'design-v2')

/** 最小 React/宿主替身：只要 factory 能跑完并交回 { apply, inject }。 */
function fakeRequire() {
  const noop = () => undefined
  const react = new Proxy(
    {
      createElement: () => ({}),
      Fragment: 'fragment',
      useState: (initial) => [initial, noop],
      useEffect: noop,
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
    },
    { get: (target, key) => (key in target ? target[key] : noop) },
  )
  return (name) => (name === 'react' ? react : new Proxy({}, { get: () => noop }))
}

test('package.json 的客户端声明按宿主契约写全（platform / ./client / 包 id 级 inject）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8')) as {
    dsh?: { client?: { platform?: string; inject?: string[]; immediately?: boolean } }
    exports?: Record<string, string>
  }
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['./client'], './client/client.js')
  assert.ok(existsSync(CLIENT), '声明了 ./client 就必须有 client/client.js')

  // `dsh.client.inject` 是**包 id**（factory 到达顺序），不是服务名。
  // 写成 'slots' / 'connection' 会让组装器拿着不存在的包去排图，前端 boot 直接崩。
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(inject.length > 0, 'inject 不能为空：至少要声明提供 slot 与 remote 的包')
  for (const id of inject) {
    assert.match(id, /^(@[^/]+\/)?[^/@][^/]*$/, `inject 里的 ${id} 不像包名`)
    assert.ok(id.includes('/'), `inject 里的 ${id} 是服务名而不是包 id`)
  }
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
    '会话「团队」视图要等 ui-conversation 声明 conversation.view',
  )
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-ui-sidebar'),
    '左栏入口要等 ui-sidebar 声明 sidebar.panellist',
  )
})

test('客户端的数据通道是面板行自己的 /__myteam（不是进不去的 ctx.remote）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.match(code, /__myteam\//, '客户端应调 /__myteam/<method>')
  assert.ok(!/ctx\.remote/.test(code), 'ctx.remote 对 profile 插件不可用，不该再走它')
})

test('客户端按 design-v2 的结构画：引设计稿样式表，且自己不写色值与字体', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.match(code, /__myteam\/assets\/design\.css/, '样式表应由宿主面板行按 /__myteam/assets/design.css 供出')
  assert.match(code, /data-myteam/, '根元素必须带 [data-myteam]：设计稿选择器已收进这个作用域')
  // 作用域类名来自 design-v2/myteam.css，客户端只写结构。
  for (const className of ['wt', 'ir', 'ir-nav', 'pane', 'hd', 'bar', 'body', 'st-chip', 'board', 'col']) {
    assert.ok(code.includes(`'${className}'`) || code.includes(` ${className}`) || code.includes(`joinClass('${className}'`), `结构里应出现设计稿类名 .${className}`)
  }
})

test('标签纪律：会话视图叫「团队视图」，客户端与设计稿不把「项目」当标签', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(!code.includes('「项目」'), '客户端里不该再有「项目」标签字样（用户明确要求改成「团队视图」）')
  assert.ok(!/kind: '项目'/.test(code), '面板头部的 scope 标签不能是「项目」')
  for (const name of readdirSync(DESIGN)) {
    if (!name.endsWith('.html')) continue
    const text = readFileSync(join(DESIGN, name), 'utf8')
    // 只查面板头部的 scope 标签（它和会话 tab 是同一个概念）；正文里的「项目」
    // 指的是项目这个实体，不能一起改掉。
    assert.ok(!text.includes('class="scope"><b>项目</b>'), `${name} 仍把「项目」当 scope 标签`)
  }
})

test('客户端入口能在模拟模块加载器下加载，并给出 apply/inject', () => {
  const code = readFileSync(CLIENT, 'utf8')
  let module = null
  const window = { __ModuleLoader__: { load: (value) => (module = value) } }
  // 客户端文件是宿主注入的脚本形态：顶层只调用 window.__ModuleLoader__.load。
  new Function('window', 'document', code)(window, {})
  assert.ok(module, '应调用 __ModuleLoader__.load')
  assert.equal(module.id, 'dsh-plugin-myteam')
  const exported = module.factory(fakeRequire())
  assert.equal(typeof exported.apply, 'function')
  assert.ok(Array.isArray(exported.inject), 'inject 必须是数组')
  assert.ok(exported.inject.includes('slots'), `inject 应含 slots：${exported.inject.join(',')}`)
})

test('apply 注册左栏入口、对应 main 面板与会话「团队视图」三个落点', () => {
  const code = readFileSync(CLIENT, 'utf8')
  let module = null
  const window = { __ModuleLoader__: { load: (value) => (module = value) } }
  new Function('window', 'document', code)(window, {})

  const registrations = []
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (options, Component) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    layout: { selectPanel: () => {} },
  }

  const exported = module.factory(fakeRequire())
  exported.apply(ctx)

  const byName = (name) => registrations.filter((entry) => entry.options.name === name)
  assert.equal(byName('conversation.view').length, 1, '缺会话「团队视图」标签')
  assert.equal(byName('conversation.view')[0].options.id, 'myteam')
  assert.equal(byName('conversation.view')[0].options.label(), '团队视图')
  assert.equal(byName('conversation.view')[0].options.inject('s1').sessionId, 's1')

  assert.equal(byName('sidebar.panellist').length, 1, '缺左栏入口')
  assert.equal(byName('sidebar.panellist')[0].options.id, 'myteam', '左栏 id 必须等于 main 的 key')
  assert.equal(byName('sidebar.panellist')[0].options.label(), 'myteam')

  assert.equal(byName('main').length, 1, '缺左栏对应的中央面板')
  assert.equal(byName('main')[0].options.key, 'myteam')
})

test('客户端入口与设计稿都不含合并冲突标记', () => {  const files = [CLIENT]
  for (const name of ['p-lanes.html', 'p-task.html', 'p-roster.html', 'p-settings.html']) {
    files.push(join(DESIGN, name))
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!/^(<<<<<<< |>>>>>>> |=======$)/m.test(text), `${file} 残留冲突标记`)
  }
})

test('设计纪律：页面与客户端不写死颜色；font-family 只允许引用宿主字体变量', () => {
  const strict = [CLIENT]
  for (const name of ['p-lanes.html', 'p-task.html', 'p-roster.html', 'p-settings.html']) {
    strict.push(join(DESIGN, name))
  }
  for (const file of strict) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), `${file} 出现十六进制颜色`)
    assert.ok(!/font-family\s*:\s*(?!var\(--dsh-font)/i.test(text), `${file} 的 font-family 必须写 var(--dsh-font*)`)
  }
  const css = readFileSync(join(DESIGN, 'myteam.css'), 'utf8')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'design-v2/myteam.css 出现十六进制颜色（应走 tokens.css）')
})

test('核心设计资产齐全且引用样式与 token', () => {
  for (const name of ['p-lanes.html', 'p-task.html', 'p-roster.html', 'p-settings.html', 'myteam.css', 'tokens.css', 'icons.svg']) {
    assert.ok(existsSync(join(DESIGN, name)), `缺少 design-v2/${name}`)
  }
  for (const name of ['p-lanes.html', 'p-task.html', 'p-roster.html', 'p-settings.html']) {
    const text = readFileSync(join(DESIGN, name), 'utf8')
    assert.match(text, /myteam\.css/, `${name} 应引用 myteam.css`)
    assert.match(text, /tokens\.css/, `${name} 应引用 tokens.css`)
  }
})