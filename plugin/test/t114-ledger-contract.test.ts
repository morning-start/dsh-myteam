/**
 * T114 · P0-2 / P0-3（docs/21 §6，来源官方四包 `types/projection.js:212-217`、`types/journal.js:29-58`）：
 * 把两处「正确性靠代码顺序看起来对」升级成**显式契约 + 时序断言**。
 *
 * P0-2 `revision` 连续性断言：
 *   `projection.revision` 应恒等于「已应用事件数」。`MT_REVISION_CONFLICT` 只是乐观锁
 *   （比的是「调用方读到的版本」与「当前版本」），两边一起被改坏时照样放行——它防并发，
 *   防不了**跳号**。跳号是「账本被篡改 / 重放污染」唯一可靠的运行时信号，必须独立断言。
 *
 * P0-3 `flush` 后提交通知：
 *   `onCommitted` **只在** appendEvent（含 fsync）成功且内存投影切换之后调用；
 *   校验失败 / 乐观锁冲突 / revision 跳号时绝不调用；回调抛错不得回滚已 durable 的事件。
 *
 * 断言清单（6 条）：
 *   ① 正常 commit → `onCommitted` 恰好一次，且**回调里**账本行数已经 +1（时序：durable 才通知）；
 *   ② 领域校验失败 → 零调用、账本行数不变、revision 不变；
 *   ③ 乐观锁冲突 → 零调用、账本行数不变；
 *   ④ `onCommitted` 抛错 → 仍是 `{ok:true}`，投影已更新、账本已落，只留一条告警（且不影响后续提交）；
 *   ⑤ 人为把 `projection.revision` 改坏（跳号）→ `MT_REVISION_GAP` 且账本零写入、seq 未消耗；
 *   ⑥ revision 连续：连续 N 次 commit 后 `revision === 初始值 + N`，冷启动重放后仍相等。
 *
 * 运行：`cd plugin && node --test test/t114-ledger-contract.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService } from '../src/core/service.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'

interface SetupResult {
  ws: string
  service: TeamService
  ledgerPath: string
  warnings: string[]
}

function setup(): SetupResult {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t114-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const warnings: string[] = []
  const service = new TeamService({
    workspaceRoot: ws,
    teamId: 't1',
    rolePaths,
    // 注入告警出口：④⑤ 两条断言「确实告警了」，同时不让测试输出被我方 warn 污染
    logger: { warn: (message: string) => void warnings.push(message) },
  })
  const ledgerPath = join(ws, '.dsh-myteam', 'tasks', 't1', 'ledger.jsonl')
  return { ws, service, ledgerPath, warnings }
}

/** 账本行数（文件不存在 = 0 行；空行不计） */
function ledgerLines(ledgerPath: string): number {
  if (!existsSync(ledgerPath)) return 0
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

/** 新账本首事件必须是 rules.version.adopted〔I3〕 */
const bootstrap = (service: TeamService, onCommitted?: (event: LedgerEvent) => void) =>
  service.commit({ actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } }, { onCommitted })

/** 一条无副作用的事件（投影不改字段，但 revision 必须 +1）——用来测连续性 */
const clarify = (service: TeamService, round: number, onCommitted?: (event: LedgerEvent) => void) =>
  service.commit(
    { actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: [`q${round}`], round } },
    { onCommitted },
  )

test('t114-1: 正常 commit —— onCommitted 恰好一次，且回调时账本已落盘（durable 才通知）', () => {
  const { service, ledgerPath } = setup()
  const before = ledgerLines(ledgerPath)
  assert.equal(before, 0, '新团队账本应为空')

  const seen: LedgerEvent[] = []
  /** 回调**内部**读到的行数：只有「先 append 再通知」才等于 before + 1 */
  let linesWhenNotified = -1

  const result = bootstrap(service, (event) => {
    linesWhenNotified = ledgerLines(ledgerPath)
    seen.push(event)
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(seen.length, 1, 'onCommitted 必须恰好调用一次')
  assert.deepEqual(seen[0], (result as { event: LedgerEvent }).event, '回调收到的事件必须就是本次落账的事件')
  assert.equal(linesWhenNotified, before + 1, '通知必须发生在 append 之后（durable 才唤醒）')
  assert.equal(ledgerLines(ledgerPath), before + 1, '事件必须已落盘')
  assert.equal(service.projectionSnapshot.revision, 1, '新建团队首事件后 revision = 1')
})

test('t114-2: 领域校验失败 —— onCommitted 零调用、账本行数不变、revision 不变', () => {
  const { service, ledgerPath } = setup()
  assert.equal(bootstrap(service).ok, true)
  const linesBefore = ledgerLines(ledgerPath)
  const revisionBefore = service.projectionSnapshot.revision

  let called = 0
  const bad = service.commit(
    // 不存在的任务 → 领域校验 MT_VALIDATION（走不到 append）
    { actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'nope', memberId: 'm1', attemptId: 'a1' } },
    { onCommitted: () => void (called += 1) },
  )

  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.equal((bad as { code: string }).code, 'MT_VALIDATION')
  assert.equal(called, 0, '校验失败时绝不能通知（下游会收到一条从未发生的事件）')
  assert.equal(ledgerLines(ledgerPath), linesBefore, '校验失败必须零写入')
  assert.equal(service.projectionSnapshot.revision, revisionBefore, '校验失败不得推进 revision')
})

test('t114-3: 乐观锁冲突 —— onCommitted 零调用、账本行数不变', () => {
  const { service, ledgerPath } = setup()
  assert.equal(bootstrap(service).ok, true)
  const linesBefore = ledgerLines(ledgerPath)

  let called = 0
  const conflict = clarify(service, 1, () => void (called += 1))
  // 上面那条是正常提交（revision 1 → 2），先确认基线，再制造真正的冲突
  assert.equal(conflict.ok, true, JSON.stringify(conflict))
  const linesAfterOk = ledgerLines(ledgerPath)
  assert.equal(linesAfterOk, linesBefore + 1)

  const stale = service.commit(
    { actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: ['q'], round: 2 }, expectedRevision: 0 },
    { onCommitted: () => void (called += 2) },
  )
  assert.equal(stale.ok, false, JSON.stringify(stale))
  assert.equal((stale as { code: string }).code, 'MT_REVISION_CONFLICT')
  assert.equal((stale as { currentRevision?: number }).currentRevision, 2)
  assert.equal(called, 1, '只有那次成功提交通知过一次；冲突那次不得通知')
  assert.equal(ledgerLines(ledgerPath), linesAfterOk, '乐观锁冲突必须零写入')
  assert.equal(service.projectionSnapshot.revision, 2, '冲突不得推进 revision')
})

test('t114-4: onCommitted 抛错 —— 仍 {ok:true}，投影已更新、账本已落，只告警（不回滚）', () => {
  const { service, ledgerPath, warnings } = setup()
  assert.equal(bootstrap(service).ok, true)
  const linesBefore = ledgerLines(ledgerPath)

  const boom = clarify(service, 1, () => {
    throw new Error('subscriber exploded')
  })

  assert.equal(boom.ok, true, '事件已 durable，回调抛错不得改变提交结果（回滚才是错的）')
  assert.equal((boom as { event: LedgerEvent }).event.seq, linesBefore, 'seq 必须已推进')
  assert.equal(service.projectionSnapshot.revision, 2, '内存投影必须已切换')
  assert.equal(ledgerLines(ledgerPath), linesBefore + 1, '账本必须已落盘')
  assert.equal(warnings.length, 1, '必须留一条告警（否则订阅方坏了没人知道）')
  assert.match(warnings[0], /onCommitted/, `告警要能定位到通知回调：${warnings[0]}`)

  // 抛错不污染后续提交：revision 继续连续，账本继续追加
  const next = clarify(service, 2)
  assert.equal(next.ok, true, JSON.stringify(next))
  assert.equal(service.projectionSnapshot.revision, 3)
  assert.equal(ledgerLines(ledgerPath), linesBefore + 2)
})

test('t114-5: revision 被改坏（跳号）—— MT_REVISION_GAP 且账本零写入、seq 未消耗', () => {
  const { service, ledgerPath, warnings } = setup()
  assert.equal(bootstrap(service).ok, true)
  const linesBefore = ledgerLines(ledgerPath)

  // 人为篡改内存投影：revision 与已落账事件数脱钩（模拟重放污染 / 脏数据）
  service.projectionSnapshot.revision = 999

  let called = 0
  const gap = clarify(service, 1, () => void (called += 1))

  assert.equal(gap.ok, false, JSON.stringify(gap))
  assert.equal((gap as { code: string }).code, 'MT_REVISION_GAP')
  assert.match((gap as { message: string }).message, /revision/, '消息要说明 revision 连续性')
  assert.equal(called, 0, '跳号时绝不能通知')
  assert.equal(ledgerLines(ledgerPath), linesBefore, '跳号必须零写入（账本只含可重放的历史）')
  assert.equal(service.projectionSnapshot.revision, 999, '失败不得「顺手」把脏投影改回合法值')
  assert.equal(warnings.length, 1, '跳号是账本被篡改的强信号，必须留告警')

  // 修好投影后能继续写，且 seq 没有被失败的那次消耗掉
  service.projectionSnapshot.revision = 1
  const recovered = clarify(service, 2)
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal((recovered as { event: LedgerEvent }).event.seq, linesBefore, '失败的提交不得消耗 seq')
  assert.equal(ledgerLines(ledgerPath), linesBefore + 1)
  assert.equal(service.projectionSnapshot.revision, 2)
})

test('t114-6: revision 连续性 —— 连续 N 次 commit 后 revision === 初始值 + N（冷启动重放仍成立）', () => {
  const { ws, service, ledgerPath } = setup()
  const initial = service.projectionSnapshot.revision
  assert.equal(initial, 0, '空账本 revision 从 0 起（docs/04 §3.2）')

  const N = 8
  for (let i = 0; i < N; i++) {
    const result = i === 0 ? bootstrap(service) : clarify(service, i)
    assert.equal(result.ok, true, `第 ${i + 1} 次提交应成功: ${JSON.stringify(result)}`)
    assert.equal(
      service.projectionSnapshot.revision,
      initial + i + 1,
      `第 ${i + 1} 次提交后 revision 必须恰好 +1（跳号/漏应用都会被抓到）`,
    )
    assert.equal(ledgerLines(ledgerPath), initial + i + 1, 'revision 必须恒等于已落账事件数')
  }

  assert.equal(service.projectionSnapshot.revision, N)
  // 冷启动重放与增量同源：重放出来的 revision 也必须等于事件数
  const reopened = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths: { projectRolesDir: join(ws, 'roles') } })
  assert.equal(reopened.projectionSnapshot.revision, N, '重放后的 revision 必须等于事件数')
})
