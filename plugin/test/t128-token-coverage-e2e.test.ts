/**
 * T128 · token 计量覆盖率**端到端**（CHG-153 / P2-5 未接线 + FR-8.4 占比环）。
 *
 * 为什么必须有这一组（问题不是「函数对不对」，而是「接没接上」）：
 *  CHG-153 定义了 `coverageOf` / `describeCoverage` / `meteredCalls` / `unmeteredCalls`，
 *  但 src 里**零调用点**、`client.js` 里**零 coverage 引用** —— 纯死代码。单元测试（t125）
 *  全绿也照样是死代码：它证明的是函数本身，不是「生产者在写、视图在出、面板在画」。
 *  本文件锁的是这条链路的每一段：
 *   ① `syncTokens` 真的把计数字段写进 `tokens.json`（生产者接线）；
 *   ② 读不到 usage 时**不谎报 full**（成员级 unreadable → partial；全空 → none）；
 *   ③ `buildTokensView` 输出 `coverage` / `coverageText`，三态文案与 `describeCoverage` 同源；
 *   ④ 上下文占比分母 0 时是 `undefined`（不是 0 —— 0% 会被读成「全是未命中」）；
 *   ⑤ 老 `tokens.json`（无计数字段）加载后按保守 `partial`（兼容旧数据，不谎报）；
 *   ⑥ 客户端静态契约：覆盖率渲染点 + 上下文占比段条 + zh/en 双语键都在。
 *
 * 口径（为什么不是「逐调用精确」）：`calls` 是宿主 `tokenUsage.totals.calls` 的**累计量**，
 * `syncTokens` 只看得到差值，宿主**没有 per-call 钩子**。所以「meteredCalls = 拿到 usage 的
 * 调用数」无法逐调用统计；本实现的口径是：**每个 sync 轮次对每个成员观测一次**能否读到累计
 * usage（`memberMeter`，单位是「成员」不是「调用」），桶里的 `meteredCalls` 则只记「本轮
 * 累加进四桶的调用数」（每一条都有 usage 背书）。文件级三态由两个证据合取派生
 * （`coverageOfFile`：桶级 `coverageOf === 'full'` **且** 该成员本轮不是 `unreadable`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { buildTokensView } from '../src/core/index/views.ts'
import { buildOfflineTokens } from '../src/core/index/offline-view.ts'
import {
  coverageOf,
  coverageOfFile,
  describeCoverage,
  emptyTokensFile,
  zeroBuckets,
  type TokensFile,
} from '../src/core/ledger/token-sidecar.ts'

const TEAM = 't128'

/** tokens.json 落盘路径（CHG-202x / P1-14 契约位置：<root>/.dsh-myteam/history/tokens/<teamId>.json） */
function tokensPath(root: string, teamId: string): string {
  return join(root, '.dsh-myteam', 'history', 'tokens', `${teamId}.json`)
}

/** 旧位置（`tasks/<teamId>/tokens.json`）——只读兼容，新写入不应再碰它 */
function legacyTokensPath(root: string, teamId: string): string {
  return join(root, '.dsh-myteam', 'tasks', teamId, 'tokens.json')
}

/**
 * 可观测 mock runtime：`agents.create` 返回带 session 的 agent（`memberHandles` 靠它回填），
 * `sessionProjections.stateOf` 由用例控制——这是本组测试唯一能模拟「读不到 usage」的接缝。
 */
function makeRuntime(root: string, stateOf: (session: unknown, key: string) => unknown) {
  let created = 0
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: any) => {
        const agentCtx = {
          tools: { register: () => {}, restrict: () => {} },
          systemPrompt: { section: () => {} },
          skills: { registerProvider: () => {} },
        }
        opts.setup(agentCtx, {})
        created += 1
        // session 身份只用于 stateOf 的入参（用例可据它区分成员）
        return { followup: () => {}, cancel: () => {}, session: { id: `sess-${created}` } }
      },
    },
    sessionProjections: { stateOf },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  return { rt }
}

/** 走真实 host 管线建团队（名册：captain 不召唤、developer/implementer 召唤成 agent 会话） */
async function stageTeam(host: MyTeamHost, teamId: string) {
  const staged = host.executeLeadTool(
    'myteam_submit_plan',
    {
      teamId,
      teamName: 'T128',
      goal: '计量覆盖率端到端',
      roster: [{ roleId: 'captain' }, { roleId: 'developer' }, { roleId: 'implementer' }],
      tasks: [],
    },
    {},
  ) as any
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  const approved = host.executeLeadTool('myteam_approve_plan', { teamId }, {}) as any
  assert.equal(approved.status, 'approved', JSON.stringify(approved))
  // FIX-14：handle 经 Promise.resolve 微任务回填后才进 memberHandles —— flush 再读
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 宿主投影的原始形状（`stateOf` 的返回 = `{ totals: {...Tokens} }`） */
const usageTotals = (calls: number) => ({
  totals: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 200, calls },
})

test('t128-1: syncTokens 把计量计数写进 tokens.json（meteredCalls + memberMeter 真接线）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't128a-'))
  try {
    const { rt } = makeRuntime(root, () => usageTotals(3))
    const host = new MyTeamHost(rt)
    host.initialize()
    await stageTeam(host, TEAM)
    const file = host.syncTokens(TEAM)
    const onDisk = JSON.parse(readFileSync(tokensPath(root, TEAM), 'utf8')) as TokensFile
    // CHG-202x（P1-14）：侧车是派生数据——落在 history/（.gitignore 覆盖），旧位置不再写
    assert.equal(existsSync(legacyTokensPath(root, TEAM)), false, '旧路径 tasks/<teamId>/tokens.json 不应再被写入（派生数据不入库）')
    // ① 计数字段必须落盘（旧实现只写 5 个字段 → 覆盖率恒 partial 的死代码）
    assert.equal(onDisk.totals['m1-developer'].calls, 3)
    assert.equal(onDisk.totals['m1-developer'].meteredCalls, 3, 'meteredCalls 必须写进 tokens.json')
    assert.equal(
      Object.prototype.hasOwnProperty.call(onDisk.totals['m1-developer'], 'unmeteredCalls'),
      false,
      '没有未计量调用时不得编 0（编 0 = 反向谎报「确定没计量」）',
    )
    assert.equal(onDisk.totals['m2-implementer'].meteredCalls, 3)
    // ① memberMeter：成员级观测表（有调用且读到 → metered；captain 未召唤 → no-session）
    assert.equal(onDisk.memberMeter?.['m1-developer'], 'metered')
    assert.equal(onDisk.memberMeter?.['m2-implementer'], 'metered')
    // 内存返回与落盘一致（写盘幂等的前提）
    assert.deepEqual(file.memberMeter, onDisk.memberMeter)
    // ③ 视图端到端：三态 + 中文文案同源
    const view = buildTokensView(onDisk)
    assert.equal(view.coverage, 'full')
    assert.equal(view.coverageText, describeCoverage('full'))
    // ④ 上下文占比 = 未缓存输入 / 上下文总输入（100 / 1050）
    const row = (view.totals as Record<string, { contextShare?: number }>)['m1-developer']
    assert.ok(Math.abs(Number(row.contextShare) - 100 / 1050) < 1e-9, `contextShare=${row.contextShare}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t128-2: 读不到 usage 时不谎报 full（unreadable → partial；恢复可读回到 full；全空 → none）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't128b-'))
  try {
    let mode: 'ok' | 'missing' | 'throw' = 'ok'
    const { rt } = makeRuntime(root, () => {
      if (mode === 'throw') throw new Error('projection unavailable')
      return mode === 'ok' ? usageTotals(2) : undefined
    })
    const host = new MyTeamHost(rt)
    host.initialize()
    await stageTeam(host, TEAM)
    // 第一轮：读得到 → full
    assert.equal(coverageOfFile(host.syncTokens(TEAM)), 'full')
    // 第二轮：投影返回空 → 该成员记 unreadable，覆盖率必须降级（绝不谎报 full）
    mode = 'missing'
    let file = host.syncTokens(TEAM)
    assert.equal(file.memberMeter?.['m1-developer'], 'unreadable')
    assert.equal(coverageOfFile(file), 'partial', '读不到 usage 必须 partial')
    assert.notEqual(buildTokensView(file).coverage, 'full', '视图不得把 unreadable 显示成 full')
    // 第三轮：抛错同样记 unreadable（不把异常吞成「全量」）
    mode = 'throw'
    file = host.syncTokens(TEAM)
    assert.equal(file.memberMeter?.['m2-implementer'], 'unreadable')
    assert.equal(coverageOfFile(file), 'partial')
    // 第四轮：恢复可读 → 观测是「当下」的，不是历史污点（基线未推进 → 增量追平）
    mode = 'ok'
    file = host.syncTokens(TEAM)
    assert.equal(coverageOfFile(file), 'full')
    assert.equal(file.totals['m1-developer'].calls, 2, '读数追平后累计量仍是 2（没有重复入账）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t128-2b: 一次都没读到 → none（不是 full：没有样本不能被读成「全量计量」）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't128c-'))
  try {
    const { rt } = makeRuntime(root, () => undefined)
    const host = new MyTeamHost(rt)
    host.initialize()
    await stageTeam(host, TEAM)
    const file = host.syncTokens(TEAM)
    assert.equal(file.memberMeter?.['m1-developer'], 'unreadable')
    assert.equal(coverageOfFile(file), 'none')
    assert.equal(buildTokensView(file).coverage, 'none')
    assert.notEqual(buildTokensView(file).coverage, 'full')
    // ④ 全零桶：上下文占比是 undefined（不是 0）
    const row = (buildTokensView(file).totals as Record<string, { contextShare?: number }>)['m1-developer']
    assert.equal(row.contextShare, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t128-3: buildTokensView 三态 coverage/coverageText 与 describeCoverage 同源', () => {
  const fileWith = (bucket: Partial<TokensFile['totals'][string]>, memberMeter?: TokensFile['memberMeter']): TokensFile => ({
    ...emptyTokensFile('t1'),
    totals: { m1: { ...zeroBuckets(), ...bucket } },
    ...(memberMeter ? { memberMeter } : {}),
  })
  const cases: Array<[ReturnType<typeof fileWith>, 'full' | 'partial' | 'none']> = [
    // 全计量：每条调用都有 usage 背书 + 成员本轮可读
    [fileWith({ calls: 3, meteredCalls: 3 }, { m1: 'metered' }), 'full'],
    // 部分计量：有调用没拿到 usage
    [fileWith({ calls: 3, meteredCalls: 2, unmeteredCalls: 1 }, { m1: 'metered' }), 'partial'],
    // 零调用：没有可覆盖的样本
    [fileWith({ calls: 0, meteredCalls: 0 }, { m1: 'metered' }), 'none'],
  ]
  for (const [file, expected] of cases) {
    const view = buildTokensView(file)
    assert.equal(view.coverage, expected, `coverage 应为 ${expected}`)
    assert.equal(view.coverageText, describeCoverage(expected), '文案必须与 sidecar 单一来源一致')
  }
  // 三态文案互不相同（不会出现「看着一样」的假标注）
  assert.notEqual(describeCoverage('full'), describeCoverage('partial'))
  assert.notEqual(describeCoverage('partial'), describeCoverage('none'))
})

test('t128-4: 上下文占比分母为 0 → undefined（不是 0），有数据时口径正确', () => {
  const zero: TokensFile = {
    ...emptyTokensFile('t1'),
    totals: { m1: { ...zeroBuckets(), calls: 2, meteredCalls: 2 } },
    memberMeter: { m1: 'metered' },
  }
  const zeroView = buildTokensView(zero)
  const zeroRow = (zeroView.totals as Record<string, Record<string, unknown>>)['m1']
  assert.equal(zeroRow.contextShare, undefined, '分母 0 必须是 undefined（面板显示「—」）')
  // undefined 不会被 JSON 序列化成 0（序列化后键消失 = 面板走「—」分支）
  assert.equal(JSON.stringify(zeroView).includes('"contextShare"'), false)
  // 命中率（既有字段）分母 0 仍为 null（历史口径不动）
  assert.equal(zeroRow.hitRate, null)

  const filled: TokensFile = {
    ...emptyTokensFile('t1'),
    totals: {
      m1: { uncachedInput: 250, cacheRead: 750, cacheWrite: 0, output: 10, calls: 4, meteredCalls: 4 },
    },
    memberMeter: { m1: 'metered' },
  }
  const filledRow = (buildTokensView(filled).totals as Record<string, Record<string, number>>)['m1']
  assert.equal(filledRow.contextShare, 0.25, '上下文占比 = uncachedInput / (uncached + read + write)')
  assert.equal(filledRow.hitRate, 0.75, '命中率 = cacheRead / 同分母')
})

test('t128-5: 老 tokens.json（无计数字段）加载后保守 partial（离线快照兼容旧数据）', () => {
  const root = mkdtempSync(join(tmpdir(), 't128d-'))
  try {
    /* CHG-202x（P1-14）：旧工作区的侧车还在 tasks/<teamId>/——这里刻意写到**旧位置**，
     * 验证「新路径优先、旧路径只读兼容」不会让历史用量凭空消失。 */
    const legacyFile = legacyTokensPath(root, TEAM)
    mkdirSync(join(legacyFile, '..'), { recursive: true })
    // 旧版落盘结构：只有四桶 + calls，没有 meteredCalls / memberMeter
    const legacy = {
      version: 1,
      teamId: TEAM,
      updatedAt: 1,
      days: { '2026-11-08': { m1: { uncachedInput: 10, cacheRead: 20, cacheWrite: 5, output: 8, calls: 2 } } },
      totals: { m1: { uncachedInput: 10, cacheRead: 20, cacheWrite: 5, output: 8, calls: 2 } },
      note: '',
    }
    writeFileSync(legacyFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
    const loaded = buildOfflineTokens(root, TEAM)
    assert.ok(loaded, '离线视图必须能读到 tokens.json')
    assert.equal(loaded!.coverage, 'partial', '旧数据无法证明全量 → 保守 partial')
    assert.equal(loaded!.coverageText, describeCoverage('partial'))
    assert.notEqual(loaded!.coverage, 'full', '旧数据绝不谎报 full')
    // 纯函数同口径（读盘路径与内存路径不得漂移）
    assert.equal(coverageOfFile(legacy as unknown as TokensFile), 'partial')
    assert.equal(coverageOf(legacy.totals.m1), 'partial')
    // 兼容旧数据不等于降级一切：桶级计数齐全时覆盖率仍可证明（离线快照会重建 TokensFile，
    // 丢掉 memberMeter 也不该让「全量」永不可达）
    const metered = {
      ...legacy,
      totals: { m1: { ...legacy.totals.m1, meteredCalls: 2, unmeteredCalls: 0 } },
      days: {},
    }
    assert.equal(coverageOfFile(metered as unknown as TokensFile), 'full')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t128-6: 客户端静态契约——覆盖率徽标 + 上下文占比段条 + zh/en 双语键', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
  // ⑥ 渲染点：三态徽标（旧宿主 → mt-cov-unknown 显示「—」，不编 0）
  assert.ok(source.includes('mt-cov mt-cov-${coverage}'), '覆盖率徽标按三态出 className')
  assert.ok(source.includes('mt-cov-unknown'), '旧宿主（无 coverage 字段）→ unknown 分支')
  assert.ok(source.includes('tokens.coverageText'), 'coverageText 作 title/hint（口径文案来自服务端）')
  assert.ok(source.includes("t('cost.coverage')"), '徽标文案走 locale 键')
  // ⑥ FR-8.4 占比环/段条：复用 .mt-segbar 写法 + 语义 token 类
  assert.ok(source.includes('mt-cost-rings') && source.includes('mt-ctxbar'), '上下文占比 / 命中率段条容器')
  assert.ok(source.includes('mt-seg-uncached') && source.includes('mt-seg-read') && source.includes('mt-seg-write'), '三段语义色')
  assert.ok(source.includes("t('cost.contextShare')"), '上下文占比列/标签走 locale 键')
  // ⑥ 双语键：zh 段与 en 段各一份（en 段在文件后半部分）
  const enStart = source.indexOf('const en = {')
  assert.ok(enStart > 0, 'en 字典必须存在')
  const zhPart = source.slice(source.indexOf('const zh = {'), enStart)
  const enPart = source.slice(enStart)
  for (const key of ['cost.coverage', 'cost.coverage.full', 'cost.coverage.partial', 'cost.coverage.none', 'cost.coverage.unknownHint', 'cost.contextShare']) {
    assert.ok(zhPart.includes(`'${key}'`), `zh 缺键：${key}`)
    assert.ok(enPart.includes(`'${key}'`), `en 缺键：${key}`)
  }
  // 样式纪律：新增段条只用 --dsw-alias-* 语义 token（不硬编码颜色）
  for (const cls of ['.mt-segbar i.mt-seg-uncached', '.mt-segbar i.mt-seg-read', '.mt-segbar i.mt-seg-write', '.mt-cov-full', '.mt-cov-partial', '.mt-cov-none']) {
    const at = source.indexOf(cls)
    assert.ok(at > 0, `缺样式：${cls}`)
    assert.ok(/var\(--dsw-alias-[a-z0-9-]+\)/.test(source.slice(at, source.indexOf("'", at))), `${cls} 必须用 --dsw-alias-* token`)
  }
})
