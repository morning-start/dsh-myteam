/**
 * T86（CHG-107）：路径展示纪律 —— **不要把用户名打出来**。
 *
 * 用户定案（逐字）：「C:\Users\Hanes\.dsh\myteam\plugins 显示不对，用户名不该显示，应显示 ~」。
 *
 * 为什么是硬规则而不是顺手改一个字符串：
 *  ① 面板里到处显示绝对路径（贡献目录 / 存储根 / 初始化回执），逐处 `replace` 一定会漏；
 *  ② 泄露本机账户名——截图、录屏、提 issue 时尤其糟糕；
 *  ③ 绝对路径太长，挤占本来就紧的横排空间。
 *
 * 所以：**服务端统一产出 `rootDisplay`**（`$HOME` 前缀换成 `~`），客户端只展示它，
 * 真实绝对路径放 `title`（复制/排障仍然可用）。本文件同时锁服务端与客户端两侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayPath } from '../src/core/workspace/layout.ts'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
const env = (home: string) => ({ USERPROFILE: home, HOME: home }) as unknown as NodeJS.ProcessEnv

test('t86-1: 家目录内的路径 → ~ 前缀（Windows 反斜杠）', () => {
  const home = 'C:\\Users\\Hanes'
  assert.equal(
    displayPath('C:\\Users\\Hanes\\.dsh\\myteam\\plugins', env(home)),
    '~\\.dsh\\myteam\\plugins',
  )
  assert.equal(displayPath('C:\\Users\\Hanes\\.dsh', env(home)), '~\\.dsh')
})

test('t86-2: 家目录本身 → 单个 ~', () => {
  const home = 'C:\\Users\\Hanes'
  assert.equal(displayPath(home, env(home)), '~')
  assert.equal(displayPath('C:\\Users\\Hanes\\', env(home)), '~')
})

test('t86-3: 家目录外的路径原样返回（不能把别人的路径也缩成 ~）', () => {
  const home = 'C:\\Users\\Hanes'
  assert.equal(displayPath('E:\\Workplace\\extension\\dsh-myteam', env(home)), 'E:\\Workplace\\extension\\dsh-myteam')
  // 前缀相同但不是子目录：不能误判（Hanes2 不是 Hanes 的子目录）
  assert.equal(displayPath('C:\\Users\\Hanes2\\.dsh', env(home)), 'C:\\Users\\Hanes2\\.dsh')
})

test('t86-4: 空值 / 无 HOME 时安全降级（不抛、不返回 ~ 冒充）', () => {
  assert.equal(displayPath('', env('C:\\Users\\Hanes')), '')
  assert.equal(displayPath('/tmp/x', {} as unknown as NodeJS.ProcessEnv), '/tmp/x')
})

test('t86-5: 服务端两个门面都产出 rootDisplay（贡献目录 / 存储根 / 初始化回执）', () => {
  for (const file of ['../src/panel.ts', '../src/host.ts']) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8')
    assert.match(source, /displayPath/, `${file} 必须 import displayPath`)
  }
  const panel = readFileSync(join(import.meta.dirname, '..', 'src', 'panel.ts'), 'utf8')
  assert.match(panel, /rootDisplay: displayPath\(catalog\.root\)/, 'getContributions 必须带 rootDisplay')
  assert.match(panel, /rootDisplay: displayPath\(layout\.root\)/, 'getStoreState.layout 必须带 rootDisplay')
  assert.match(panel, /rootDisplay: displayPath\(result\.layout\.root\)/, 'initStore 回执必须带 rootDisplay')
})

test('t86-6: 客户端只展示 rootDisplay，绝对路径进 title（可复制/排障）', () => {
  // 贡献目录 footer
  assert.match(
    clientSource,
    /className: 'mt-contrib-root', title: String\(data\?\.root \?\? ''\), children: t\('contrib\.root'\)\.replace\('\{root\}', String\(data\?\.rootDisplay \?\? data\?\.root \?\? ''\)\)/,
    '贡献目录必须展示 rootDisplay，title 留绝对路径',
  )
  // 存储横幅路径
  assert.match(
    clientSource,
    /className: 'mt-banner-path', title: String\(storeState\.layout\?\.root \?\? ''\), children: String\(storeState\.layout\?\.rootDisplay \?\? storeState\.layout\?\.root \?\? ''\)/,
    '存储横幅必须展示 rootDisplay，title 留绝对路径',
  )
  // 初始化回执
  assert.match(clientSource, /r\.rootDisplay \?\? r\.root \?\? ''/, '初始化回执必须展示 rootDisplay')
  // 反向：不得再有直接展示绝对路径的残留
  assert.ok(
    !/t\('contrib\.root'\)\.replace\('\{root\}', String\(data\?\.root \?\? ''\)\)/.test(clientSource),
    '不得再直接展示绝对路径',
  )
})
