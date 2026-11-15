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

  // 归档两处（archiveView / archiveList）也要带——归档目录同样是绝对路径
  const host = readFileSync(join(import.meta.dirname, '..', 'src', 'host.ts'), 'utf8')
  /* CHG-123：按**定义**取切片（`archiveList()` 现在也会被工具方法调用，取首个调用点会切空） */
  const archiveViewAt = host.indexOf('archiveView(teamId?: string)')
  const archiveListAt = host.indexOf('archiveList(): {')
  assert.ok(archiveViewAt > 0 && archiveListAt > archiveViewAt, 'archiveView / archiveList 定义必须存在')
  const archiveView = host.slice(archiveViewAt, archiveListAt)
  assert.ok(archiveView.includes('rootDisplay: displayPath(root)'), 'archiveView 必须带 rootDisplay')
  const archiveList = host.slice(archiveListAt, archiveListAt + 400)
  assert.ok(archiveList.includes('rootDisplay: displayPath(root)'), 'archiveList 必须带 rootDisplay')
})

test('t86-7: 归档目录展示只认 rootDisplay（绝对路径 snap.dir 不得上屏）', () => {
  // archiveDir 必须优先 archiveRoot（display），snap.dir 只做兜底
  const at = clientSource.indexOf('const archiveDir =')
  assert.ok(at > 0, '找不到 archiveDir')
  const block = clientSource.slice(at, at + 400)
  const rootIdx = block.indexOf('archiveRoot')
  const snapDirIdx = block.indexOf('snap.dir')
  assert.ok(rootIdx > 0 && snapDirIdx > 0, 'archiveDir 必须同时考虑 archiveRoot 与 snap.dir')
  assert.ok(rootIdx < snapDirIdx, 'archiveRoot（已 display）必须优先于 snap.dir（绝对路径）')
  assert.ok(!/snap\.dir\s*\|\|\s*\(archiveRoot/.test(block), '不得再让 snap.dir 抢在前面')
  // 且 archiveRoot 的来源必须是 rootDisplay
  assert.match(clientSource, /setArchiveRoot\(r\?\.rootDisplay \? String\(r\.rootDisplay\) : r\?\.root \? String\(r\.root\) : ''\)/, 'archiveRoot 来源必须优先 rootDisplay')
})

test('t86-6: 客户端只展示 rootDisplay，绝对路径进 title（可复制/排障）', () => {
  // 贡献目录 footer
  assert.match(
    clientSource,
    /className: 'mt-contrib-root', title: String\(data\?\.root \?\? ''\), children: t\('contrib\.root'\)\.replace\('\{root\}', String\(data\?\.rootDisplay \?\? data\?\.root \?\? ''\)\)/,
    '贡献目录必须展示 rootDisplay，title 留绝对路径',
  )
  // 存储横幅路径（CHG-202b：允许带附加类名，如引导卡的 `mt-store-path` 省略号版式）
  assert.match(
    clientSource,
    /className: 'mt-banner-path[^']*', title: String\(storeState\.layout\?\.root \?\? ''\), children: String\(storeState\.layout\?\.rootDisplay \?\? storeState\.layout\?\.root \?\? ''\)/,
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

test('t86-8: 客户端 prettyPath —— 团队摘要里的历史 workspaceRoot 也要缩成 ~', () => {
  // ① 函数存在且被用于组头路径
  const fnMatch = clientSource.match(/const prettyPath = \(value\) => \{[\s\S]*?\n    \}/)
  assert.ok(fnMatch, '客户端必须有 prettyPath（浏览器里没有 homedir）')
  assert.match(
    clientSource,
    /className: 'mt-group-path', title: root, children: prettyPath\(root\)/,
    '组头路径必须展示 prettyPath，title 留原值',
  )

  // ② 行为：直接求值那段源码（自包含，无外部依赖）
  const prettyPath = new Function(`return (${fnMatch[0].replace('const prettyPath = ', '')})`)() as (value: string) => string
  assert.equal(prettyPath('C:\\Users\\Hanes\\.dsh\\myteam\\plugins'), '~\\.dsh\\myteam\\plugins')
  assert.equal(prettyPath('/home/hanes/proj'), '~/proj')
  assert.equal(prettyPath('/Users/hanes/proj'), '~/proj')
  assert.equal(prettyPath('E:\\Workplace\\extension\\dsh-myteam'), 'E:\\Workplace\\extension\\dsh-myteam', '非家目录原样返回')
  /* 客户端只看「形状」：任何 `Users\<x>` / `home/<x>` 都缩成 ~（隐私优先——别人的用户名同样不该上屏；
   * 服务端 displayPath 知道本机 $HOME，所以要严格得多）。 */
  assert.equal(prettyPath('C:\\Users\\Hanes2\\x'), '~\\x', '别的用户目录同样缩成 ~')
  assert.equal(prettyPath(''), '')
})
