/**
 * dsh-plugin-myteam — 预编译脚本（官方插件契约：装载入口必须是纯 JS）。
 *
 * 用 Node 内置 module.stripTypeScriptTypes 把 src 下全部 .ts 编译到 lib 下对应 .mjs：
 *   - mode 'strip'（擦除型语法；本项目无 enum/namespace/参数属性/装饰器，已核查）
 *   - 相对导入说明符 .ts 结尾 → .mjs（静态 from / 副作用 import / 动态 import）
 *   - package.json main/exports 指向 lib/host.mjs（由本脚本同步校验）
 *
 * ── 发布安全：三道闸（D8；参照 dsh-talk-map/scripts/build-client.mjs）──────────────
 * 为什么必须有闸：`main` 直指 ./lib/host.mjs，宿主**直接 require 构建产物**。
 * 旧实现是「rmSync(lib) → 逐文件 writeFileSync → 最后才 throw」，一次编译失败就会留下
 * 半截 lib/（host.mjs 可能已不存在）→ 插件整体不可装载，且必须重启宿主才能恢复。
 * 闸门顺序本身就是协议，不要调换：
 *
 *   闸 0 · 暂存构建：全部产物先写 lib.__staging__/（与 lib/ 同父目录 → 同卷 → rename 原子），
 *                    **任何情况下都不直写 lib/**。
 *   闸 1 · 语法校验：每个暂存产物跑一遍 `node --check`（子进程，按 ESM 解析）。
 *                    stripTypeScriptTypes 只保证「类型擦除成功」，不保证输出是合法 JS。
 *   闸 2 · 原子替换：全部通过后才 rmSync(lib) + renameSync(staging → lib)。
 *                    NTFS 同卷 rename 是原子的，宿主只会看到旧目录或新目录，不会看到半截。
 *   闸 3 · 宿主在跑就拒绝：TTY 下交互确认（`--force` / `-y` / DSH_BUILD_YES=1 跳过；
 *                    非 TTY 如 CI 自动放行并告警）。**不写靠猜的进程探测**——Node 读完
 *                    .mjs 就关闭句柄，没有任何可靠办法判断宿主是否已装载；假阳性比没有更糟。
 *   失败清理：finally 里删掉暂存目录，绝不留垃圾。
 *
 * ── 产物卫生（D9）───────────────────────────────────────────────────────────────
 * sourceUrl 只写 repo 相对路径。旧实现传 `pathToFileURL(file).href`，把
 * `//# sourceURL=file:///E:/Workplace/...` 写进了 36/36 个 npm 包产物（泄漏开发者目录结构、
 * diff 爆炸、构建不一致）。构建末尾扫全部暂存产物，命中 `file:///` 或盘符绝对路径即失败。
 *
 * 运行：node scripts/build-lib.mjs [--force]（Node >= 22.13，无需任何 devDependency）
 */
import { stripTypeScriptTypes } from 'node:module'
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  realpathSync,
  existsSync,
  copyFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')
/** 闸 0 · 暂存目录：lib/ 的同级兄弟（同一卷），rename 才是原子的 */
const stagingDir = join(root, 'lib.__staging__')
/** 浏览器直载产物（不经 src 编译）：package.json exports["./client"]；与源码指纹分开记录 */
const clientFile = join(root, 'client', 'client.js')
/**
 * 官方插件契约要求的装载入口（t42 复算）。
 *
 * 标准 bundle 形态：包根的 `index.js` 是纯 JS 入口（`dsh_plugin_check` 的
 * `recipe:entry` 只认它），它把 `lib/composition/host.mjs` 的 `apply` / `inject`
 * 原样转发出去。所以这里校验两个点：`main` / `exports["."]` 指向根 `index.js`，
 * 且 `index.js` 的转发目标就是下面这条产物路径——只改其中一处会立刻红。
 */
const ENTRY = './index.js'
/** 根入口转发的实现产物；与 ENTRY 必须成对成立 */
const ENTRY_TARGET = './lib/composition/host.mjs'

/**
 * 客户端产物指纹（P2 门禁缺口）：`client/client.js` 由浏览器**直接装载**，不经过 src→lib 构建，
 * 所以 sourceHash 覆盖不到它——改了忘记重跑构建时，面板会静默跑旧客户端。
 * 用原始字节哈希，且**不混进 sourceHash**（两者语义不同，混在一起会让 lib 重建判定失真）。
 */
function clientHashOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 源码指纹（R38 门禁）：全部 src 文件按相对路径排序后「路径\0内容」哈希；t42 复算比对 */
function sourceHashOf(files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    hash.update(relative(srcDir, file).split(sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(file, 'utf8'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** 递归列出 dir 下扩展名为 ext 的文件（确定性排序；不用 try/catch 猜目录，Dirent 直接给答案） */
function walk(dir, ext) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** 相对 .ts 说明符 → .mjs（静态 from / 副作用 import / 动态 import()） */
function rewriteSpecifiers(code) {
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g,
    (_m, head, quote, spec) => `${head}${quote}${spec}.mjs${quote}`,
  )
}

/**
 * 单文件编译：TS 擦除（strip 失败退回 transform）+ 说明符改写。
 * **导出**给 tools/check-drift.mjs 复用——两边各写一份正是 check-drift 100% 假阳性的根因。
 *
 * @param {string} code TS 源码
 * @param {string} rel 相对 srcDir 的路径（用于 sourceUrl 与错误消息）
 * @returns {string} 可直接落盘的 ESM
 */
export function compileSource(code, rel) {
  const posixRel = rel.split(sep).join('/')
  // D9：只写 repo 相对路径。绝对路径会原样进 npm 包。
  const sourceUrl = `./src/${posixRel}`
  let js
  try {
    js = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl })
  } catch (stripErr) {
    // 擦除失败（非擦除型语法）→ 退回 transform 模式（enum/namespace 等也可编译）
    console.warn(`[strip] ${posixRel}: ${String(stripErr).split('\n')[0]} → retry transform`)
    js = stripTypeScriptTypes(code, { mode: 'transform', sourceUrl })
  }
  return rewriteSpecifiers(js)
}

/**
 * 闸 1 · 语法校验：产物必须能被 Node 按 ESM 解析。
 *
 * 为什么不用 `new vm.Script(text)`（标杆 build-client.mjs 的做法）：vm.Script 只认 CJS，
 * 本包 `type: module`、产物含 top-level import/export，用它会 100% 假失败。
 * `vm.SourceTextModule` 需要 --experimental-vm-modules，不适合当默认构建路径。
 * 因此走 `node --check <file>`：语义等价（只解析不执行），且天然按 ESM 解析。
 * 参考 03-methodology.md:515/537 的同款取舍。
 *
 * @param {string} file 暂存产物的绝对路径
 * @param {string} rel 相对暂存目录的路径（错误消息用）
 */
export function assertProductParses(file, rel) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status === 0) return
  const detail = `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim()
  throw new Error(
    `产物语法非法（stripTypeScriptTypes 输出了坏 JS）：${rel}\n${detail}\n` +
      '这类产物一旦进 lib/ 会让插件整体不可装载——lib/ 未被修改。',
  )
}

/** 绝对构建路径的两类指纹：file:/// URL、Windows 盘符路径（排除 https:// 等协议前缀） */
const FILE_URL_RE = /file:\/\/\//
const DRIVE_PATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/

/**
 * D9 · 产物断言：构建产物里不许出现绝对构建路径。
 * 扫全部暂存产物（.mjs + manifest），命中即失败——导入 npm 包的人不该看到开发机目录结构。
 *
 * @param {string[]} files 暂存产物的绝对路径
 * @param {string} baseDir 用于生成可读相对路径
 */
export function assertNoAbsolutePaths(files, baseDir) {
  const leaks = []
  for (const file of files) {
    const name = relative(baseDir, file).split(sep).join('/')
    const text = readFileSync(file, 'utf8')
    if (FILE_URL_RE.test(text)) leaks.push(`${name}: 含 file:/// URL`)
    else if (DRIVE_PATH_RE.test(text)) leaks.push(`${name}: 含盘符绝对路径`)
  }
  if (leaks.length > 0) {
    throw new Error(
      `产物泄漏绝对构建路径（D9 门禁，${leaks.length} 个文件）：\n  ${leaks.join('\n  ')}\n` +
        '检查是否给 stripTypeScriptTypes 传了绝对 sourceUrl，或源码里写死了本机路径。',
    )
  }
}

/** 闸 3 的旁路开关（显式、可审计；不做进程探测） */
function forceRequested() {
  return (
    process.argv.includes('--force') ||
    process.argv.includes('-y') ||
    process.env.DSH_BUILD_YES === '1'
  )
}

/**
 * 闸 3 · 宿主在跑就拒绝（降级形态：交互确认）。
 *
 * 可靠性说明：Node 读完 .mjs 即关闭句柄，Windows 上没有任何「文件被装载」的可靠信号；
 * 靠 tasklist 猜宿主进程会大量假阳性（DSH 桌面端/CLI/其他 profile 都叫这个名字）。
 * 假阳性比没有更糟——于是这里只做一次**人类可判断**的确认：
 *   - `--force` / `-y` / DSH_BUILD_YES=1 → 跳过
 *   - 非 TTY（CI、管道、node --test）→ 自动放行 + 告警
 *   - TTY → 交互式 [y/N]，非 y 则退出且 lib/ 原样不动
 */
async function confirmHostRunning() {
  if (forceRequested()) {
    console.warn('[build] --force：跳过「DSH 可能正在运行」确认；替换 lib/ 后请重启宿主装载新产物')
    return
  }
  if (!process.stdin.isTTY || process.env.CI) {
    console.warn(
      '[build] 非 TTY（CI/管道）：自动放行「DSH 可能在运行」确认；' +
        '若宿主正在运行，替换 lib/ 后需重启宿主才能装载新产物（--force 可静默）',
    )
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => {
    rl.question('DSH 可能正在运行，替换 lib/ 后需要重启宿主才能装载新产物。继续？[y/N] ', resolve)
  })
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.error('[build] 已取消：lib/ 未做任何改动')
    process.exit(1)
  }
}

async function main() {
  const files = walk(srcDir, '.ts')
  if (files.length === 0) throw new Error('src/**/*.ts 为空')

  // 前置门禁：入口契约 + 浏览器直载产物——都在动 lib/ 之前，失败时 lib/ 毫发无伤
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const entry = pkg.exports?.['.']
  if (entry !== ENTRY || pkg.main !== ENTRY) {
    throw new Error(
      `package.json 入口应为 "${ENTRY}"（main=${pkg.main}, exports["."]=${entry}）；请修正后重跑`,
    )
  }
  // 根入口是纯 JS 转发层：它必须真的指向本次构建产出的那条路径，否则宿主装载到的是
  // 「入口在、实现不在」的半截包——这种失败在运行期才暴露，代价远高于在这里拦下。
  const entryFile = join(root, 'index.js')
  if (!existsSync(entryFile)) {
    throw new Error(`缺少根入口 ${ENTRY}（标准 bundle 形态要求包根有纯 JS 入口）；lib/ 未做任何改动`)
  }
  const entrySource = readFileSync(entryFile, 'utf8')
  if (!entrySource.includes(`'${ENTRY_TARGET}'`)) {
    throw new Error(
      `根入口 ${ENTRY} 没有转发到 "${ENTRY_TARGET}"（构建产物入口）；lib/ 未做任何改动`,
    )
  }
  // 根入口必须真的能被 Node 解析。
  //
  // 为什么单独查：`index.js` 是**手写的纯 JS**，不经过 stripTypeScriptTypes，也不在
  // `src/**` 的编译范围里——构建的闸 1（`node --check` 每个暂存产物）扫不到它。
  // 2026-11-26 实测踩到：注释里写了 `lib/**/*.mjs`，其中 `*/` 提前闭合了块注释，
  // 整个文件变成语法错误，宿主报 `failed to import: SyntaxError: Unexpected token '*'`，
  // 插件整体不装载、左侧栏没有入口——而 tsc、348 个测试、dsh_plugin_check 全部是绿的。
  // 这里用 `node --check` 把它拦在构建期。
  const entryCheck = spawnSync(process.execPath, ['--check', entryFile], { encoding: 'utf8' })
  if (entryCheck.status !== 0) {
    const detail = `${entryCheck.stderr ?? ''}${entryCheck.error ? `\n${entryCheck.error.message}` : ''}`.trim()
    throw new Error(`根入口 ${ENTRY} 语法非法（宿主会 failed to import，插件整体不装载）：\n${detail}`)
  }
  let clientHash = null
  if (existsSync(clientFile)) {
    clientHash = clientHashOf(clientFile)
  }

  // 闸 3：破坏性替换之前确认（此刻 lib/ 还是完整的旧产物）
  await confirmHostRunning()

  // 闸 0：全部产物先写暂存目录，绝不直写 lib/
  rmSync(stagingDir, { recursive: true, force: true })
  let swapped = false
  try {
    mkdirSync(stagingDir, { recursive: true })
    const failures = []
    for (const file of files) {
      const rel = relative(srcDir, file)
      const outPath = join(stagingDir, rel.replace(/\.ts$/i, '.mjs'))
      try {
        const js = compileSource(readFileSync(file, 'utf8'), rel)
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, js, 'utf8')
        console.log(
          `[build] ${rel.split(sep).join('/')} → ${relative(root, outPath).split(sep).join('/')}`,
        )
      } catch (e) {
        console.error(`[build] FAILED ${rel.split(sep).join('/')}: ${e.message}`)
        failures.push(rel.split(sep).join('/'))
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} 个模块编译失败：${failures.join(', ')}；lib/ 未做任何改动`,
      )
    }

    // 闸 1：语法校验——坏 JS 绝不进 lib/
    const staged = walk(stagingDir, '.mjs')
    for (const file of staged) {
      assertProductParses(file, relative(stagingDir, file).split(sep).join('/'))
    }

    // D9：产物卫生——绝对构建路径不许进包
    assertNoAbsolutePaths(staged, stagingDir)

    // 一致性门禁凭据（R38 / t42）：改 src 未重跑 bundle 时测试立即失败
    const manifest = {
      schema: 1,
      builtAt: new Date().toISOString(),
      node: process.version,
      entry: ENTRY,
      // 根入口转发的实现产物：t42 用它核对「入口在、实现也在」
      entryTarget: ENTRY_TARGET,
      modules: files.length,
      sourceHash: sourceHashOf(files),
      // v2 的浏览器产物在 R5 落地前不存在；有则记指纹，没有就明确缺省。
      ...(clientHash === null ? {} : { clientFile: 'client/client.js', clientHash }),
      files: files.map((f) => relative(srcDir, f).split(sep).join('/')).sort((a, b) => a.localeCompare(b)),
    }
    // manifest 与产物同批落地（同一次 rename），不会出现「产物新、manifest 旧」
    writeFileSync(join(stagingDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    assertNoAbsolutePaths([join(stagingDir, 'build-manifest.json')], stagingDir)

    // 闸 2：原子替换（同卷 rename）；宿主只会看到旧目录或新目录
    rmSync(libDir, { recursive: true, force: true })
    renameSync(stagingDir, libDir)
    swapped = true
    console.log(`[build] OK — ${files.length} module(s) → lib/；入口 ${ENTRY}`)
    copyDesignAssets()
    console.log(
      `[build] manifest sourceHash=${manifest.sourceHash.slice(0, 12)}… clientHash=${clientHash === null ? 'n/a' : `${clientHash.slice(0, 12)}…`}`,
    )
  } finally {
    // 失败清理：留下半截暂存目录只会污染下一次构建（成功后 rename 已消费掉它）
    if (!swapped) rmSync(stagingDir, { recursive: true, force: true })
  }
}

/**
 * 把仓库根的设计稿拷进包里：`<包根>/design-v2`。
 *
 * 为什么必须在包里有一份：面板样式表由宿主从 `/__myteam/assets/design.css` 供出，服务端读的是
 * 「插件包里的 design-v2」。仓库开发与 `link:` 安装时包根就是 `<repo>/plugin`，`../design-v2`
 * 找得到；但**打包装（= 真正的 npm 安装）**会把包复制到 `node_modules/dsh-plugin-myteam`，
 * `../design-v2` 就指向 `node_modules/design-v2` —— 不存在，样式表 500、面板裸奔。
 * 隔离实例一直用 `link:` 安装，所以这个坑没暴露出来。
 */
function copyDesignAssets() {
  const repoDesign = join(root, '..', 'design-v2')
  const packagedDesign = join(root, 'design-v2')
  const files = ['tokens.css', 'myteam.css']
  const missing = files.filter((file) => !existsSync(join(repoDesign, file)))
  if (missing.length > 0) throw new Error(`仓库 design-v2 缺少 ${missing.join(', ')}，样式表会 500`)
  rmSync(packagedDesign, { recursive: true, force: true })
  mkdirSync(packagedDesign, { recursive: true })
  for (const file of files) copyFileSync(join(repoDesign, file), join(packagedDesign, file))
  console.log(`[build] design-v2 → 包内 ${files.length} 个 css（打包安装才找得到样式表）`)
}

/** 直接 `node scripts/build-lib.mjs` 才执行；被 tools/check-drift.mjs import 时只取 compileSource */
function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().catch((e) => {
    console.error(`[build] FAILED: ${e?.message ?? e}`)
    process.exit(1)
  })
}
