/**
 * T137（CHG-176）：**架构约束门禁** `tools/check-architecture.mjs` 的自测。
 *
 * 为什么要有这个测试：门禁本身是「用代码写下来的纪律」，它错了比没有更糟 ——
 * 假阴性（该红不红）会让人以为边界被守着；假阳性（该绿不绿）会让人开始用
 * `--no-verify` 绕过，最后整条 CI 被删掉。所以这里锁的是**规则本身的判定口径**，
 * 不是仓库当前状态（CHG-174 的写盘迁移会让 A2 存量数一路变到 0，锁数量等于每天改测试）：
 *
 *  ① 六条规则各自都能抓到自己构造的**最小样例**（A1–A5 行级每条一个，A6 文件级一个）；
 *  ② 每条豁免**只**豁免该豁免的：`atomic-write.ts` 豁免 A2 但 `write-log.ts` 不豁免；
 *     `console.warn` / `error` / `debug` 放行而 `console.log` 不放行；`core` 内部的
 *     相对 import 不误报；名字里带 `remote` 的文件不构成违规（A1 判的是**解析后的
 *     说明符**，不是「源码里出现 remote 三个字」）；
 *  ③ 冻结清单三种状态都对：清单内文件不报、清单外新违规照报、**迁完的条目报
 *     `A2-STALE-FROZEN`** —— 否则清单会退化成一张永远不删的白名单；
 *  ④ 输出格式稳定（`total src files:` / `ARCH_VIOLATIONS:` / ` - 文件:行 规则码 说明`），
 *     外部 CI 靠它 grep 摘要行。
 *
 * 除 t137-1（真跑一次本仓库，就是 acceptance 那条线）外，**全部用临时目录构造样例**，
 * 不依赖仓库里任何具体违规数量，也不受迁移进度影响。
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FROZEN_A2,
  formatArchitectureReport,
  runArchitectureCheck,
} from '../../tools/check-architecture.mjs'

const TOOL = fileURLToPath(new URL('../../tools/check-architecture.mjs', import.meta.url))

/** 造一棵最小 `src` 树：`{ 'core/x.ts': '…' }`；`t.after` 负责删干净 */
function makeSrcTree(t: TestContext, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-arch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }
  return dir
}

/** 跑规则。冻结清单默认清空 —— 临时树里没有「迁移中」的存量，报 STALE 会把用例搅浑 */
const run = (srcDir: string, frozen: string[] = []) => runArchitectureCheck({ srcDir, frozen })

/** `规则码 文件:行` 的紧凑投影，断言用 */
const located = (result: { violations: Array<{ rule: string; file: string; line: number }> }) =>
  result.violations.map((violation) => `${violation.rule} ${violation.file}:${violation.line}`)

/* ── 1. acceptance：仓库当前状态必须绿 ──────────────────────────── */

test('t137-1: 本仓库跑门禁 —— 退出码 0 且输出 ARCH_VIOLATIONS: 0（acceptance 线）', (t) => {
  /*
   * 为什么落文件而不是 `spawnSync(..., { encoding: 'utf8' })`：后者会开管道，
   * 受限沙箱（CI 就跑在那种沙箱里）对管道直接 EPERM。落文件拿到的是**同一个**真实退出码
   * 和真实 stdout，只是不走管道 —— 测的是脚本本身，不是沙箱能力。
   */
  const workDir = mkdtempSync(join(tmpdir(), 'myteam-arch-run-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const logFile = join(workDir, 'stdout.log')
  const fd = openSync(logFile, 'w')
  let status: number | null
  try {
    status = spawnSync(process.execPath, [TOOL], { stdio: ['ignore', fd, fd] }).status
  } finally {
    closeSync(fd)
  }
  const stdout = readFileSync(logFile, 'utf8')
  assert.equal(status, 0, `门禁必须绿，实际输出：\n${stdout}`)
  assert.match(stdout, /^total src files: \d+$/m)
  assert.match(stdout, /^ARCH_VIOLATIONS: 0$/m)
  assert.match(stdout, /^frozen \(A2 存量，迁移中\): \d+$/m)
})

/* ── 2. A1 分层：该抓的抓 ──────────────────────────────────────── */

test('t137-2: A1 抓得到 core → host.ts 的反向 import', (t) => {
  const dir = makeSrcTree(t, {
    'core/x.ts': "import { MyTeamHost } from '../host.ts'\nexport const x = MyTeamHost\n",
  })
  const result = run(dir)
  assert.deepEqual(located(result), ['A1 core/x.ts:1'])
  assert.match(result.violations[0].message, /host\.ts/, '说明必须点名到底 import 了哪个上层模块')
  assert.match(result.violations[0].fix, /core/, '修法必须指出往哪边收口')
})

test('t137-3: A1 覆盖 panel.ts、remote/** 与 export … from 三种写法', (t) => {
  const dir = makeSrcTree(t, {
    'core/a.ts': "import { buildBoardView } from '../remote/views.ts'\nexport const a = buildBoardView\n",
    'core/b.ts': "import type { PanelThing } from '../panel.ts'\nexport type B = PanelThing\n",
    'core/c.ts': "export { buildBoardView } from '../remote/views.ts'\n",
  })
  assert.deepEqual(located(run(dir)), ['A1 core/a.ts:1', 'A1 core/b.ts:1', 'A1 core/c.ts:1'])
})

test('t137-4: A1 不误报 core 内部相对 import，也不管上层 import remote（分层只管 core 往上）', (t) => {
  const dir = makeSrcTree(t, {
    'core/index/a.ts': "import { b } from './b.ts'\nimport { c } from '../config/c.ts'\nexport const a = [b, c]\n",
    'core/index/b.ts': 'export const b = 1\n',
    'core/config/c.ts': 'export const c = 2\n',
    // 上层自己 import remote 是正常装配，不归 A1 管
    'host.ts': "import { buildBoardView } from './remote/views.ts'\nexport const h = buildBoardView\n",
    'remote/views.ts': 'export const buildBoardView = 1\n',
    // 关键回归：文件名 / 字符串里带「remote」不等于跨层依赖（判据是解析后的说明符）
    'core/remote-helper.ts': "export const helper = 'import x from ../remote/views.ts'\n",
  })
  assert.deepEqual(run(dir).violations, [])
})

/* ── 3. A2 写盘出口 ────────────────────────────────────────────── */

test('t137-5: A2 抓得到新的 writeFileSync，且修法给的是能直接粘的相对说明符', (t) => {
  const dir = makeSrcTree(t, {
    'core/knowledge/knowledge.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('a', 'b')\n",
  })
  const result = run(dir)
  assert.deepEqual(located(result), ['A2 core/knowledge/knowledge.ts:1', 'A2 core/knowledge/knowledge.ts:2'])
  assert.equal(
    result.violations[0].fix,
    "import { writeTextAtomic } from '../fs/write-log.ts'",
    '修法必须是相对**当前文件**的正确路径，否则等于让人自己算',
  )
  assert.match(result.violations[0].message, /writeTextAtomic/)
})

test('t137-6: A2 只豁免 atomic-write.ts 本体；write-log.ts 出现原语照样红', (t) => {
  const dir = makeSrcTree(t, {
    'core/fs/atomic-write.ts': "import { writeFileSync, openSync } from 'node:fs'\nwriteFileSync('a', 'b')\n",
    'core/fs/write-log.ts': "import { appendFileSync } from 'node:fs'\nappendFileSync('a', 'b')\n",
  })
  assert.deepEqual(located(run(dir)), ['A2 core/fs/write-log.ts:1', 'A2 core/fs/write-log.ts:2'])
})

test('t137-7: A2 不管目录 / 读操作（mkdirSync / rmSync / unlinkSync / statSync / readFileSync 放行）', (t) => {
  const dir = makeSrcTree(t, {
    'core/dirs.ts':
      "import { mkdirSync, rmSync, unlinkSync, statSync, readFileSync } from 'node:fs'\n" +
      "mkdirSync('a', { recursive: true })\nrmSync('a', { recursive: true, force: true })\n" +
      "unlinkSync('b')\nstatSync('c')\nreadFileSync('d', 'utf8')\n",
  })
  assert.deepEqual(run(dir).violations, [], '这几条是目录/读语义，不是「写盘出口」的泄漏面')
})

/* ── 4. 冻结清单：只减不增 ─────────────────────────────────────── */

test('t137-8: 冻结清单内的文件不报 violation，但计入 frozen（迁移进度可见）', (t) => {
  const dir = makeSrcTree(t, {
    'core/legacy.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('a', 'b')\n",
    'core/fresh.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('c', 'd')\n",
  })
  const result = run(dir, ['core/legacy.ts'])
  assert.deepEqual(located(result), ['A2 core/fresh.ts:1', 'A2 core/fresh.ts:2'], '清单外的增量必须照报')
  assert.equal(result.frozen, 1)
  assert.deepEqual(result.frozenFiles, ['core/legacy.ts'])
})

test('t137-9: A2-STALE-FROZEN —— 条目已不违规（迁完 / 文件没了）就报违规，逼清单只减不增', (t) => {
  const dir = makeSrcTree(t, { 'core/migrated.ts': 'export const done = true\n' })
  const result = run(dir, ['core/migrated.ts', 'core/deleted.ts'])
  // 存量条目统一排在扫描结果之后、按路径排序（顺序稳定，diff 才看得懂）
  assert.deepEqual(located(result), ['A2-STALE-FROZEN core/deleted.ts:0', 'A2-STALE-FROZEN core/migrated.ts:0'])
  assert.equal(result.frozen, 0)
  // 存量条目没有「行」：不能打成 `文件:0` 让人以为第 0 行有问题
  const lines = formatArchitectureReport(result)
  assert.ok(lines.some((line) => line.startsWith(' - core/migrated.ts A2-STALE-FROZEN ')))
  assert.ok(!lines.some((line) => line.includes('core/migrated.ts:0')))
})

/* ── 5. A3 / A4 / A5 ───────────────────────────────────────────── */

test('t137-10: A3 抓得到 core 里的 child_process；上层 host.ts 用它是正常装配', (t) => {
  const dir = makeSrcTree(t, {
    // 只有真写出 `child_process` 的那一行算违规；`spawnSync` 的调用点不重复报
    'core/spawn.ts': "import { spawnSync } from 'node:child_process'\nexport const s = spawnSync\n",
    'host.ts': "import { spawnSync } from 'node:child_process'\nexport const h = spawnSync\n",
  })
  assert.deepEqual(located(run(dir)), ['A3 core/spawn.ts:1'])
})

test('t137-11: A4 只有 write-log.ts 可以 new WriteLog / 碰 activeLog', (t) => {
  const dir = makeSrcTree(t, {
    'core/fs/write-log.ts': 'const log = new WriteLog()\nlet activeLog = null\n',
    'core/bad.ts': 'const log = new WriteLog()\nactiveLog = log\n',
  })
  assert.deepEqual(located(run(dir)), ['A4 core/bad.ts:1', 'A4 core/bad.ts:2'])
})

test('t137-12: A5 只禁 console.log / process.stdout.write；warn / error / debug 放行（stderr 是诊断面）', (t) => {
  const dir = makeSrcTree(t, {
    'core/quiet.ts': "console.warn('a')\nconsole.error('b')\nconsole.debug('c')\n",
    'core/loud.ts': "console.log('a')\nprocess.stdout.write('b')\n",
  })
  assert.deepEqual(located(run(dir)), ['A5 core/loud.ts:1', 'A5 core/loud.ts:2'])
})

/* ── 6. 两个「不要误报」的取舍 + 输出契约 ──────────────────────── */

test('t137-13: 行首注释里提到原语不算违规（否则 host.ts 的 CHG-174 说明会自打脸）', (t) => {
  const dir = makeSrcTree(t, {
    'core/doc.ts': [
      '/** 不再直接 writeFileSync，走 writeTextAtomic —— 见 CHG-174 */',
      '// console.log 在 core 层是被禁止的',
      ' * child_process 也不许出现',
      'export const ok = true',
    ].join('\n'),
  })
  assert.deepEqual(run(dir).violations, [])
})

test('t137-14: 输出格式稳定（CI 靠 grep 摘要行）', (t) => {
  const dir = makeSrcTree(t, { 'core/x.ts': "console.log('a')\n" })
  const lines = formatArchitectureReport(run(dir))
  assert.equal(lines[0], 'total src files: 1')
  assert.equal(lines[1], 'ARCH_VIOLATIONS: 1')
  assert.match(lines[2], /^ - core\/x\.ts:1 A5 /)
  assert.match(lines[2], /（修法：/)
  assert.equal(lines[3], 'frozen (A2 存量，迁移中): 0')
})

test('t137-15: FROZEN_A2 是排好序、去重、相对 posix 路径（清单要能被人审）', () => {
  assert.deepEqual(
    [...FROZEN_A2],
    [...new Set(FROZEN_A2)].sort((a, b) => a.localeCompare(b)),
    '清单必须排序去重，否则 diff 里全是无意义重排',
  )
  for (const path of FROZEN_A2) {
    assert.ok(!path.includes('\\'), `必须用 posix 分隔符：${path}`)
    assert.ok(!path.startsWith('/') && !path.startsWith('./'), `必须是相对 src 的路径：${path}`)
  }
})

/* ── 7. A6 入口层行数棘轮（CHG-186）────────────────────────────── */

test('t137-16: A6 入口层行数棘轮 —— 刚好不超放行，超一行才红，且输出带实测行数', (t) => {
  const dir = makeSrcTree(t, {
    // split('\n').length === 3（末尾换行算一个空元素）——行数口径与 arch-report 的 loc 一致
    'host.ts': 'export const a = 1\nexport const b = 2\n',
    'core/x.ts': 'export const x = 1\n',
  })
  // 上限 3：刚好等于实测 → 绿（棘轮是「只减不增」，不是「必须小于」）
  assert.deepEqual(runArchitectureCheck({ srcDir: dir, frozen: [], a6Limit: { 'host.ts': 3 } }).violations, [])
  // 上限 2：超一行 → 红；line 记 0（文件级规则没有「第几行」，与 A2-STALE-FROZEN 同形）
  const result = runArchitectureCheck({ srcDir: dir, frozen: [], a6Limit: { 'host.ts': 2 } })
  assert.deepEqual(located(result), ['A6 host.ts:0'])
  assert.match(result.violations[0].message, /已 3 行/, '说明必须带实测行数，否则没法照它下调')
  assert.match(result.violations[0].fix, /A6_LIMIT/, '修法必须指向常量本身')
  // 摘要必须能读到实测行数（CI 靠 grep 这一行判进度）
  assert.deepEqual(result.a6, [{ file: 'host.ts', lines: 3, limit: 2 }])
  const lines = formatArchitectureReport(result)
  assert.ok(
    lines.includes('A6 入口层行数棘轮: host.ts 3 行 / 上限 2'),
    `输出必须带 A6 实测行数，实际：${JSON.stringify(lines)}`,
  )
  // 入口层文件不在树里（临时树 / 族已搬空后改名）→ 跳过，不凭空报违规
  const bare = makeSrcTree(t, { 'core/x.ts': 'export const x = 1\n' })
  assert.deepEqual(runArchitectureCheck({ srcDir: bare, frozen: [], a6Limit: { 'host.ts': 0 } }).violations, [])
})
