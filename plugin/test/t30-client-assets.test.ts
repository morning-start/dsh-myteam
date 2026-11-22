import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
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

test('package.json 的客户端声明要么完整、要么不写（半截声明会让宿主前端起不来）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8')) as {
    dsh?: { client?: { platform?: string; inject?: string[] } }
    exports?: Record<string, string>
  }
  const declared = pkg.dsh?.client !== undefined || pkg.exports?.['./client'] !== undefined
  if (!declared) {
    assert.equal(existsSync(CLIENT), true, '未声明客户端时 client.js 仍应保留，供将来接线')
    return
  }
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['./client'], './client/client.js')
  assert.ok(existsSync(CLIENT), '声明了 ./client 就必须有 client/client.js')
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(inject.includes('slots'), `客户端 inject 必须含 slots：${inject.join(',')}`)
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

test('客户端入口与设计稿都不含合并冲突标记', () => {
  const files = [CLIENT]
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