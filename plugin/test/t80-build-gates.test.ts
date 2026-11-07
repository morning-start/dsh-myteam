/**
 * T80（D8 / D9）：构建安全三道闸 + 产物卫生。
 *
 * 背景（审计 D8 / D9）：
 *   - `plugin/package.json` 的 `main` 直指 `./lib/host.mjs`，宿主**直接 require 构建产物**。
 *     旧实现「rmSync(lib) → 逐文件 writeFileSync → 最后才 throw」，一次编译失败就留下半截 lib/，
 *     插件整体不可装载（docs/06 R39 已登记为 P1）。
 *   - 旧实现给 stripTypeScriptTypes 传 `sourceUrl: pathToFileURL(file).href`，
 *     把 `//# sourceURL=file:///E:/Workplace/...` 写进了全部 npm 包产物（绝对路径泄漏）。
 *
 * 本测试分两层：
 *   ① 静态契约：闸门**类型与顺序**必须在源码里成立（顺序错 = bug 复现，见 03-methodology.md:530）。
 *   ② 实跑（temp dir，绝不碰真实 plugin/lib）：成功路径 + **坏 .ts 时 lib/ 原样不动**。
 *
 * 为什么用 `node --check` 而不是 `new vm.Script`：本包 `type: module`、产物是 ESM，
 * vm.Script 只认 CJS 会 100% 假失败（03-methodology.md:515/537）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const buildScriptPath = join(pluginRoot, 'scripts', 'build-lib.mjs')
const buildSource = readFileSync(buildScriptPath, 'utf8')

/** 源码里某个片段首次出现的下标（不存在则失败，避免断言静默失效） */
function at(fragment) {
  const index = buildSource.indexOf(fragment)
  assert.ok(index >= 0, `构建脚本里找不到片段：${fragment}`)
  return index
}

// ── ① 静态契约 ────────────────────────────────────────────────────────────────

test('T80 · 闸 0：产物只写暂存目录，任何情况下都不直写 lib/', () => {
  assert.match(buildSource, /lib\.__staging__/, '缺暂存目录常量（闸 0）')
  assert.ok(
    buildSource.includes('join(stagingDir, rel.replace'),
    '产物落点必须是 stagingDir 下的镜像路径',
  )
  assert.ok(
    !buildSource.includes('join(libDir'),
    '构建脚本不得再用 join(libDir, …) 拼产物落点（那正是「直写 lib/」）',
  )
})

test('T80 · 闸门顺序：编译 → 语法校验 → rmSync(lib) → renameSync（顺序即协议）', () => {
  // 用 main() 里的**调用点**比较位置（函数定义顺序与执行顺序无关）
  const idxStaging = at('const stagingDir')
  const idxLoop = at('for (const file of files)')
  const idxCall = at('assertProductParses(file, relative(stagingDir')
  const idxRm = at('rmSync(libDir')
  const idxRename = at('renameSync(stagingDir, libDir)')
  assert.match(buildSource, /export function assertProductParses/, '缺语法校验门禁函数定义')
  assert.ok(idxStaging < idxLoop, '暂存目录必须在编译循环之前就位')
  assert.ok(idxLoop < idxCall, '语法校验必须在编译循环之后（校验的是暂存产物）')
  assert.ok(idxCall < idxRm, 'rmSync(lib) 必须在校验全部通过之后——否则就是「先删后写」的老 bug')
  assert.ok(idxRm < idxRename, 'rmSync(lib) 必须在 rename 之前（rename 要求目标不存在）')
})

test('T80 · 闸 1：每个产物都过语法校验（node --check 等价于 vm.Script）', () => {
  assert.match(
    buildSource,
    /spawnSync\(process\.execPath, \['--check', file\]/,
    '缺产物语法校验：stripTypeScriptTypes 只保证类型擦除成功，不保证输出是合法 JS',
  )
  assert.match(buildSource, /assertProductParses/, '缺语法校验门禁函数')
  // 说明为什么不用 vm.Script（ESM 校验不了）——避免后来人「优化」回假失败
  assert.match(buildSource, /vm\.Script/, '注释里应保留「为什么不用 vm.Script」的理由')
})

test('T80 · 闸 2 + 失败清理：原子 rename 与 finally 清暂存', () => {
  assert.match(buildSource, /renameSync\(stagingDir, libDir\)/, '缺原子替换（闸 2）')
  assert.match(buildSource, /finally\s*\{[\s\S]{0,200}rmSync\(stagingDir/, '缺失败清理：暂存目录必须在 finally 里删掉')
  assert.match(buildSource, /if \(!swapped\)/, '成功后 rename 已消费暂存目录，清理需要 swapped 保护')
})

test('T80 · 闸 3：宿主可能在跑时默认拒绝（确认式，不写靠猜的进程探测）', () => {
  assert.match(buildSource, /confirmHostRunning/, '缺闸 3：破坏性替换前必须确认')
  assert.match(buildSource, /process\.stdin\.isTTY/, '缺 TTY 判定（非 TTY 自动放行 + 告警）')
  assert.match(buildSource, /--force/, '缺 --force 旁路开关')
  // 注释里解释「为什么不用 tasklist」是允许的；真正禁止的是**调用**它
  assert.ok(
    !/spawnSync\([^)]*tasklist|execSync\([^)]*tasklist|exec\([^)]*tasklist/i.test(buildSource),
    '不要写靠猜的进程探测（tasklist 匹配宿主机名会大量假阳性，假阳性比没有更糟）',
  )
})

test('T80 · D9：sourceUrl 只写 repo 相对路径，绝不写绝对路径', () => {
  assert.ok(
    !/sourceUrl:\s*pathToFileURL/.test(buildSource),
    'sourceUrl 不得用 pathToFileURL（绝对路径会原样进 npm 包）',
  )
  // 只 import fileURLToPath：pathToFileURL 一旦回来就说明绝对路径又要进产物了
  assert.match(buildSource, /import \{ fileURLToPath \} from 'node:url'/, 'node:url 只应导入 fileURLToPath')
  assert.match(buildSource, /const sourceUrl = `\.\/src\/\$\{posixRel\}`/, 'sourceUrl 应为 ./src/<rel>')
  assert.match(buildSource, /export function assertNoAbsolutePaths/, '缺产物绝对路径断言')
  assert.match(buildSource, /FILE_URL_RE/, '缺 file:/// 检测正则（行为由下方打靶用例覆盖）')
})

// ── ② 实跑（临时目录，绝不碰真实 plugin/lib）────────────────────────────────────

/** 造一个最小可用插件目录：package.json 入口契约 + client 产物 + 真实构建脚本副本 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-build-gate-'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-plugin',
        version: '0.0.0',
        type: 'module',
        main: './lib/host.mjs',
        exports: { '.': './lib/host.mjs' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeFileSync(join(dir, 'client', 'client.js'), 'export const client = 1\n', 'utf8')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  // 跑的是**真实脚本的副本**（不是重写的等价物），这样测试才代表生产构建
  cpSync(buildScriptPath, join(dir, 'scripts', 'build-lib.mjs'))
  writeTs(dir, 'host.ts', [
    "import { helper } from './core/helper.ts'",
    "export const ENTRY: string = 'host'",
    'export function hello(name: string): string {',
    "  return helper() + ':' + name",
    '}',
    '',
  ].join('\n'))
  writeTs(dir, 'core/helper.ts', [
    'export function helper(): string {',
    "  return 'ok'",
    '}',
    '',
  ].join('\n'))
  return dir
}

function writeTs(dir, rel, code) {
  const file = join(dir, 'src', ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, code, 'utf8')
}

function runBuild(dir) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'build-lib.mjs'), '--force'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DSH_BUILD_YES: '1' },
  })
}

/** 递归列出相对路径（posix 风格，排序） */
function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** 目录快照：相对路径 → sha256（判断「原样不动」） */
function snapshot(dir) {
  const out = new Map()
  for (const rel of listFiles(dir)) {
    out.set(rel, createHash('sha256').update(readFileSync(join(dir, ...rel.split('/')))).digest('hex'))
  }
  return out
}

/** 独立复算源码指纹（与 build-manifest 的算法一致，但由测试自己算） */
function sourceHashOf(dir) {
  const srcDir = join(dir, 'src')
  const files = listFiles(srcDir).filter((rel) => rel.endsWith('.ts'))
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(join(srcDir, ...rel.split('/')), 'utf8'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const ABS_LEAK_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/

test('T80 · 实跑成功路径：lib/ 完整、说明符改写、manifest 正确、产物无绝对路径', async () => {
  const dir = makeFixture()
  try {
    const run = runBuild(dir)
    assert.equal(run.status, 0, `构建应成功（status=${run.status}）\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)

    assert.ok(existsSync(join(dir, 'lib', 'host.mjs')), '缺 lib/host.mjs（装载入口）')
    assert.ok(existsSync(join(dir, 'lib', 'core', 'helper.mjs')), '缺 lib/core/helper.mjs')
    assert.ok(!existsSync(join(dir, 'lib.__staging__')), '构建成功后不得残留暂存目录')

    const host = readFileSync(join(dir, 'lib', 'host.mjs'), 'utf8')
    assert.ok(host.includes("from './core/helper.mjs'"), '相对 .ts 说明符必须改写为 .mjs')
    assert.ok(!/from\s*['"]\.{1,2}\/[^'"]+\.ts['"]/.test(host), '产物里不得残留裸露 .ts 说明符')

    // D9：产物卫生（逐个文件扫）
    const products = listFiles(join(dir, 'lib')).map((rel) => join(dir, 'lib', ...rel.split('/')))
    for (const file of products) {
      const text = readFileSync(file, 'utf8')
      const name = relative(dir, file).split(sep).join('/')
      assert.ok(!text.includes('file:///'), `${name} 泄漏 file:/// 绝对路径`)
      assert.ok(!ABS_LEAK_RE.test(text), `${name} 泄漏盘符绝对路径`)
    }

    // manifest 与产物同批落地
    const manifest = JSON.parse(readFileSync(join(dir, 'lib', 'build-manifest.json'), 'utf8'))
    assert.equal(manifest.schema, 1)
    assert.equal(manifest.entry, './lib/host.mjs')
    assert.equal(manifest.modules, 2)
    assert.deepEqual(manifest.files, ['core/helper.ts', 'host.ts'])
    assert.equal(manifest.sourceHash, sourceHashOf(dir), 'sourceHash 复算不一致')
    assert.match(manifest.clientHash, /^[0-9a-f]{64}$/)

    // 产物可装载（这才是宿主真正要的东西）
    const mod = await import(pathToFileURL(join(dir, 'lib', 'host.mjs')).href)
    assert.equal(mod.hello('x'), 'ok:x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T80 · 实跑失败路径：坏 .ts 让构建退出非零，且原 lib/ 一个字节都没变（最关键）', async () => {
  const dir = makeFixture()
  try {
    const first = runBuild(dir)
    assert.equal(first.status, 0, `首次构建应成功\n${first.stdout}\n${first.stderr}`)
    const before = snapshot(join(dir, 'lib'))
    assert.ok(before.size >= 2, '首次构建产物不足，测试前提不成立')

    // 故意放一个语法错的 .ts（stripTypeScriptTypes 擦除阶段就会抛）
    writeTs(dir, 'broken.ts', 'export const oops: number = (\n')

    const second = runBuild(dir)
    assert.notEqual(second.status, 0, '坏 .ts 必须让构建退出非零')
    assert.match(second.stdout + second.stderr, /FAILED|编译失败/, '应打印失败模块')
    assert.match(second.stdout + second.stderr, /lib\/ 未做任何改动/, '应说明 lib/ 未被修改')

    // 核心断言：lib/ 原样不动
    const afterSnapshot = snapshot(join(dir, 'lib'))
    assert.deepEqual(
      [...afterSnapshot.keys()].sort(),
      [...before.keys()].sort(),
      'lib/ 文件集发生变化（旧实现会先 rmSync 再写，这里必须一个不多一个不少）',
    )
    for (const [rel, hash] of before) {
      assert.equal(afterSnapshot.get(rel), hash, `lib/${rel} 内容被破坏`)
    }

    // 失败清理：不留暂存垃圾
    assert.ok(!existsSync(join(dir, 'lib.__staging__')), '失败后残留 lib.__staging__')

    // 旧产物仍可装载（宿主不会因为一次失败的构建而挂掉）
    const mod = await import(pathToFileURL(join(dir, 'lib', 'host.mjs')).href)
    assert.equal(mod.hello('y'), 'ok:y')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T80 · 实跑：rm+rename 语义下旧产物不会残留（无合并式陈旧模块）', async () => {
  const dir = makeFixture()
  try {
    assert.equal(runBuild(dir).status, 0)
    // 伪造一个上一个版本遗留的模块
    writeFileSync(join(dir, 'lib', 'stale.mjs'), 'export const stale = true\n', 'utf8')
    assert.equal(runBuild(dir).status, 0)
    assert.ok(!existsSync(join(dir, 'lib', 'stale.mjs')), '陈旧产物必须在原子替换时被整体丢弃')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ③ 门禁函数本身可被直接打靶（防止「断言写了但从不生效」）─────────────────────

test('T80 · assertProductParses：坏产物被拒、好产物放行', async () => {
  const mod = await import(pathToFileURL(buildScriptPath).href)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-build-parse-'))
  try {
    writeFileSync(join(dir, 'bad.mjs'), 'export const x = (\n', 'utf8')
    assert.throws(() => mod.assertProductParses(join(dir, 'bad.mjs'), 'bad.mjs'), /产物语法非法/)

    writeFileSync(join(dir, 'good.mjs'), 'export const x = 1\n', 'utf8')
    assert.doesNotThrow(() => mod.assertProductParses(join(dir, 'good.mjs'), 'good.mjs'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T80 · assertNoAbsolutePaths：file:/// 与盘符路径被拒，https:// 放行', async () => {
  const mod = await import(pathToFileURL(buildScriptPath).href)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-build-abs-'))
  try {
    writeFileSync(join(dir, 'url.mjs'), '//# sourceURL=file:///E:/proj/src/host.ts\n', 'utf8')
    assert.throws(() => mod.assertNoAbsolutePaths([join(dir, 'url.mjs')], dir), /D9 门禁/)

    writeFileSync(join(dir, 'drive.mjs'), 'export const p = "E:\\proj\\src\\host.ts"\n', 'utf8')
    assert.throws(() => mod.assertNoAbsolutePaths([join(dir, 'drive.mjs')], dir), /D9 门禁/)

    writeFileSync(
      join(dir, 'ok.mjs'),
      '//# sourceURL=./src/host.ts\nexport const u = "https://example.com/a?b=c"\n',
      'utf8',
    )
    assert.doesNotThrow(() => mod.assertNoAbsolutePaths([join(dir, 'ok.mjs')], dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
