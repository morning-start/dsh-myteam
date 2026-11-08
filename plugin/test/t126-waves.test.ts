/**
 * T126 路 CHG-154（docs/21 §6 P2-3）：并发波次调度**纯函数**验收。
 *
 * 锁三件事（这三条不成立，调度就是错的）：
 *  ① **拓扑序**：前置任务一定在更早的波（`deps` 语义 = 被依赖，与 task-graph 一致）；
 *  ② **同波不重叠**：同波内任意两任务的 `writeScopes` 两两不重叠——这是「两个成员
 *     同时改同一批文件、后写覆盖先写」这个事故的唯一静态防线；
 *  ③ **确定性**：同输入两次必须深相等（否则面板刷新会跳波次、重放对不上）。
 *
 * 另外锁「保守方向」：glob 之间证不出不相容时必须判重叠（多串行一次只是慢，
 * 漏判是真事故），所以 `src/*.ts` vs `src/*.js` 要能证明不相交，而
 * `src/*.ts` vs `src/a.ts` 必须判重叠。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MT_TASK_CYCLE,
  WAVE_ANY,
  WAVE_CODES,
  explainWaves,
  mergeSharedFileTasks,
  planDevWaves,
  scopesOverlap,
  type WavePlanOk,
} from '../src/core/scheduler/waves.ts'

/** 断言成功并收窄类型（`assert.fail` 返回 never，编译器也能收窄） */
function expectOk(plan: ReturnType<typeof planDevWaves>): WavePlanOk {
  if (!plan.ok) assert.fail(`期望成功的波次计划，实际失败：${plan.code} ${plan.reason}`)
  return plan
}

/* ── 1. scopesOverlap 六种边界 ─────────────────────────────────────── */

test('t126-1: 目录语义——`src/a.ts` 与 `src/` 重叠（双向）', () => {
  assert.equal(scopesOverlap(['src/a.ts'], ['src/']), true, '文件落在目录 scope 内')
  assert.equal(scopesOverlap(['src/'], ['src/a.ts']), true, '重叠是对称的')
  // 不带尾斜杠的目录同样覆盖其下文件（与 matchesScope 的「无通配按目录理解」一致）
  assert.equal(scopesOverlap(['src/a.ts'], ['src']), true)
  assert.equal(scopesOverlap(['plugin/src/core/x.ts'], ['plugin/src/']), true)
})

test('t126-2: 同一文件重叠；同层不同文件不重叠；不同目录不重叠', () => {
  assert.equal(scopesOverlap(['src/a.ts'], ['src/a.ts']), true, '同一个文件')
  assert.equal(scopesOverlap(['src/a.ts'], ['src/b.ts']), false, '同层不同文件')
  assert.equal(scopesOverlap(['src/a.ts'], ['lib/a.ts']), false, '同文件名的不同目录')
  assert.equal(scopesOverlap(['src/'], ['lib/']), false, '两个无关目录')
})

test('t126-3: `**` 通配视为重叠一切', () => {
  assert.equal(WAVE_ANY, '**')
  assert.equal(scopesOverlap(['**'], ['lib/x.ts']), true)
  assert.equal(scopesOverlap(['src/a.ts'], ['**']), true, '任一方向都算')
  assert.equal(scopesOverlap(['**'], ['**']), true)
  // 段内 `**` 只在它所在的段位上跨段，不吞掉前缀差异
  assert.equal(scopesOverlap(['src/**'], ['src/deep/a.ts']), true)
  assert.equal(scopesOverlap(['src/**'], ['lib/a.ts']), false, '`src/**` 不覆盖 lib')
})

test('t126-4: 空 writeScopes = 未声明 = 与任何任务都不冲突', () => {
  assert.equal(scopesOverlap([], ['src/']), false)
  assert.equal(scopesOverlap(['src/'], []), false)
  assert.equal(scopesOverlap([], []), false)
  assert.equal(scopesOverlap(undefined, ['src/']), false, '缺省字段同样视为未声明')
  // 归一化后为空（`./`、空白）也等价于未声明
  assert.equal(scopesOverlap(['./'], ['src/']), false)
})

test('t126-5: 通配保守判定——能证明不相容才判不重叠', () => {
  // 末段字面后缀不同 → 必不相交（这是能证明的少数情况）
  assert.equal(scopesOverlap(['src/*.ts'], ['src/*.js']), false)
  assert.equal(scopesOverlap(['src/*.ts'], ['lib/*.ts']), false, '首段不同')
  // 证不出来就按重叠处理
  assert.equal(scopesOverlap(['src/*.ts'], ['src/a.ts']), true, '通配段能匹配到该文件')
  assert.equal(scopesOverlap(['src/*.ts'], ['src/']), true, '目录里有 .ts 文件')
  assert.equal(scopesOverlap(['src/a*.ts'], ['src/*b.ts']), true, '前缀/后缀都能对上，保守判重叠')
})

test('t126-6: 反斜杠与 `./` 归一化后等价', () => {
  assert.equal(scopesOverlap(['src\\a.ts'], ['src/']), true)
  assert.equal(scopesOverlap(['./src/a.ts'], ['src/a.ts']), true)
})

/* ── 2. planDevWaves 波次语义 ──────────────────────────────────────── */

test('t126-7: 依赖先行——前置任务波次严格更小', () => {
  const plan = expectOk(planDevWaves([
    { taskId: 'b', deps: ['a'] },
    { taskId: 'a' },
    { taskId: 'c', deps: ['b'] },
  ]))
  assert.deepEqual(plan.waves, [['a'], ['b'], ['c']])
  assert.deepEqual(plan.order, ['a', 'b', 'c'], '展平序仍然是拓扑序')
})

test('t126-8: 同波内两两不重叠——互不冲突的任务并进同一波', () => {
  const plan = expectOk(planDevWaves([
    { taskId: 'c', writeScopes: ['docs/'] },
    { taskId: 'a', writeScopes: ['src/'] },
    { taskId: 'b', writeScopes: ['plugin/test/'] },
  ]))
  assert.equal(plan.waves.length, 1, '三个任务零冲突 → 一波并行')
  assert.deepEqual(plan.waves[0], ['a', 'b', 'c'], '同波按 taskId 稳定排序（不是输入顺序）')
})

test('t126-9: 写范围重叠的任务被推进下一波', () => {
  const plan = expectOk(planDevWaves([
    { taskId: 'a', writeScopes: ['src/a.ts'] },
    { taskId: 'b', writeScopes: ['src/'] },
  ]))
  assert.deepEqual(plan.waves, [['a'], ['b']], 'b 与 a 重叠 → 第 2 波')
  // 重叠是传递生效的：同波里已经有人占了这个文件，后来的都要往后
  const chain = expectOk(planDevWaves([
    { taskId: 'a', writeScopes: ['src/index.ts'] },
    { taskId: 'b', writeScopes: ['src/index.ts'] },
    { taskId: 'c', writeScopes: ['src/index.ts'] },
  ]))
  assert.deepEqual(chain.waves, [['a'], ['b'], ['c']], '三个抢同一文件 → 完全串行')
})

test('t126-10: 依赖 + 重叠同时存在时取更晚的那个波次', () => {
  // b 依赖 a（至少第 2 波），同时 b 与 c 范围重叠（c 在第 1 波）→ b 必须让到不冲突处
  const plan = expectOk(planDevWaves([
    { taskId: 'a' },
    { taskId: 'c', writeScopes: ['src/'] },
    { taskId: 'b', deps: ['a'], writeScopes: ['src/a.ts'] },
  ]))
  assert.deepEqual(plan.waves, [['a', 'c'], ['b']])
  assert.ok(
    plan.waves.findIndex((wave) => wave.includes('b')) > plan.waves.findIndex((wave) => wave.includes('a')),
    '依赖约束优先于「尽量早」',
  )
})

test('t126-11: 成环返回 {ok:false, code:MT_TASK_CYCLE}，不抛异常', () => {
  let plan: ReturnType<typeof planDevWaves> | undefined
  assert.doesNotThrow(() => {
    plan = planDevWaves([
      { taskId: 'a', deps: ['b'] },
      { taskId: 'b', deps: ['a'] },
      { taskId: 'c' },
    ])
  })
  assert.equal(plan!.ok, false)
  if (plan!.ok) assert.fail('不可能成功')
  assert.equal(plan!.code, WAVE_CODES.TASK_CYCLE)
  assert.equal(plan!.code, MT_TASK_CYCLE, '工具结果直接回这个字符串')
  assert.deepEqual(plan!.cycles, ['a', 'b'], '点名参与环的任务')
  assert.deepEqual(plan!.waves, [], '失败时不给半截波次，避免调用方误用')
  assert.match(plan!.reason, /依赖环/)
})

test('t126-12: 自依赖与未知依赖只记录不阻断（与 task-graph 容错同源）', () => {
  const plan = expectOk(planDevWaves([
    { taskId: 'a', deps: ['a'] },
    { taskId: 'b', deps: ['not-exist', 'a'] },
  ]))
  assert.deepEqual(plan.waves, [['a'], ['b']])
  assert.deepEqual(plan.skippedDeps, [
    { taskId: 'a', dep: 'a' },
    { taskId: 'b', dep: 'not-exist' },
  ])
})

test('t126-13: 确定性——同输入两次深相等；空输入给空波次', () => {
  const input = [
    { taskId: 'z', writeScopes: ['src/'] },
    { taskId: 'a', deps: ['z'], writeScopes: ['src/index.ts'] },
    { taskId: 'm', writeScopes: ['lib/'] },
  ] as const
  const first = planDevWaves([...input])
  const second = planDevWaves([...input])
  assert.deepEqual(first, second)
  assert.deepEqual(expectOk(first).waves, [['m', 'z'], ['a']])

  const empty = expectOk(planDevWaves([]))
  assert.deepEqual(empty.waves, [])
  assert.deepEqual(empty.order, [])
})

test('t126-14: 重复 taskId 显式失败，而不是静默给出两个位置', () => {
  const plan = planDevWaves([{ taskId: 'a' }, { taskId: 'a' }])
  assert.equal(plan.ok, false)
  if (plan.ok) assert.fail('不可能成功')
  // 不新增码（t81 门禁）：入参不合法复用跨域通用的 MT_VALIDATION
  assert.equal(plan.code, WAVE_CODES.TASK_INVALID)
  assert.equal(plan.code, 'MT_VALIDATION')
})

/* ── 3. 共享文件任务合并 ────────────────────────────────────────────── */

test('t126-15: 写范围完全相同的任务合并成一个串行组', () => {
  const merged = mergeSharedFileTasks([
    { taskId: 'b', writeScopes: ['src/index.ts'] },
    { taskId: 'a', writeScopes: ['src/index.ts'] },
  ])
  assert.equal(merged.ok, true)
  if (!merged.ok) assert.fail('不可能失败')
  assert.equal(merged.groups.length, 1, '同范围 → 一个组')
  assert.deepEqual(merged.groups[0]!.taskIds, ['a', 'b'], '组内按 taskId 稳定排序 = 串行顺序')
  assert.deepEqual(merged.groups[0]!.writeScopes, ['src/index.ts'])
  assert.deepEqual(merged.waves, [['g1']], '组级波次')
  assert.deepEqual(merged.groupOf, { a: 'g1', b: 'g1' })
})

test('t126-16: 只有「完全相同」才合并；重叠但不同的范围分开成组并串行', () => {
  const merged = mergeSharedFileTasks([
    { taskId: 'a', writeScopes: ['src/'] },
    { taskId: 'b', writeScopes: ['src/a.ts'] },
  ])
  assert.equal(merged.ok, true)
  if (!merged.ok) assert.fail('不可能失败')
  assert.equal(merged.groups.length, 2, '范围不同 → 不合并（语义上不是同一条链）')
  assert.deepEqual(merged.waves, [['g1'], ['g2']], '但重叠仍然串行')
})

test('t126-17: 未声明 writeScopes 的任务不参与合并（避免假串行链）', () => {
  const merged = mergeSharedFileTasks([
    { taskId: 'a' },
    { taskId: 'b' },
    { taskId: 'c', writeScopes: ['src/'] },
  ])
  assert.equal(merged.ok, true)
  if (!merged.ok) assert.fail('不可能失败')
  assert.equal(merged.groups.length, 3, '三个各自成组')
  assert.deepEqual(merged.waves, [['g1', 'g2', 'g3']], '零冲突 → 同一波并行')
})

test('t126-18: 合并时把组内依赖折叠掉、把跨组依赖映射到组 id', () => {
  const merged = mergeSharedFileTasks([
    { taskId: 'a', writeScopes: ['src/x.ts'] },
    { taskId: 'b', deps: ['a'], writeScopes: ['src/x.ts'] }, // 同组：依赖自己 → 丢掉
    { taskId: 'c', deps: ['b'], writeScopes: ['lib/'] }, // 跨组 → 依赖 g1
  ])
  assert.equal(merged.ok, true)
  if (!merged.ok) assert.fail('不可能失败')
  assert.deepEqual(merged.groups.map((group) => group.taskIds), [['a', 'b'], ['c']])
  assert.deepEqual(merged.waves, [['g1'], ['g2']], 'g2 因跨组依赖必须在 g1 之后')
})

test('t126-19: 合并路径把组内的相互依赖折叠掉，跨组才成环', () => {
  // 同组：a 与 b 写同一批文件 → 合并成 g1，两条依赖都指向组内 → 折叠成自依赖被丢弃
  const folded = mergeSharedFileTasks([
    { taskId: 'a', deps: ['b'], writeScopes: ['src/'] },
    { taskId: 'b', deps: ['a'], writeScopes: ['src/'] },
  ])
  assert.equal(folded.ok, true, '组内依赖不构成环（它本来就串行）')
  if (!folded.ok) assert.fail('不可能失败')
  assert.deepEqual(folded.groups.map((group) => group.taskIds), [['a', 'b']])
  assert.deepEqual(folded.waves, [['g1']])

  // 跨组：范围不同 → 各自成组，依赖跨组保留 → 真的成环
  const twoGroups = mergeSharedFileTasks([
    { taskId: 'a', deps: ['b'], writeScopes: ['src/'] },
    { taskId: 'b', deps: ['a'], writeScopes: ['lib/'] },
  ])
  assert.equal(twoGroups.ok, false)
  if (twoGroups.ok) assert.fail('不可能成功')
  assert.equal(twoGroups.code, MT_TASK_CYCLE)
  assert.deepEqual(twoGroups.cycles, ['g1', 'g2'], '环在组级出现')
})

/* ── 4. 人读说明 ───────────────────────────────────────────────────── */

test('t126-20: explainWaves 输出可读中文（面板折叠行直接用）', () => {
  const text = explainWaves([['a', 'b'], ['c']])
  assert.match(text, /第 1 波（2 个，可并行）：a、b/)
  assert.match(text, /第 2 波（1 个，单独执行）：c/)
  assert.equal(explainWaves([]), '没有可调度的任务。')
})
