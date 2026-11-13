/**
 * T122 · P1-3（CHG-150，docs/21 §6，来源官方 `types/projection.js:274-317`）：**跨提交零 frame**。
 *
 * 背景：CHG-146 已给 `remote/views.ts` 加了两级 WeakMap 缓存（`members` → `tasks` 当键），
 * 也给 `fold.applyEvent` 加了 `copyTouchedCollections`（按事件类型浅拷贝被触及集合）。
 * 但 `TeamService.commit()` 里仍是 `structuredClone(this.projection)` ——**每次提交都换掉全部引用
 * → 跨提交必然 miss**，面板每帧全量重建，「零 frame」等于没生效。
 *
 * 本测试锁的是「copy-on-write 之后**两个不变量同时成立**」：
 *   - **正确性**：失败（领域校验 / applyEvent 抛错）时原投影**一个引用都不许换、一个字段都不许改**；
 *   - **收益**：成功提交后，**未触及**的集合保持原引用（视图缓存命中），**触及**的换新引用（缓存失效重建）。
 * 这两件事天然对立（少复制 = 返回过期视图），所以每一条都成对断言，缺一半就不算证明。
 *
 * 断言清单（6 条）：
 *   ① 连续提交后 `tasks` / `members` 引用：未触及的保持、触及的换新；
 *   ② 领域校验失败 → 集合引用 `===` 失败前、内容逐字段相同、账本零写入；
 *   ③ applyEvent 抛错（重放防线）→ 同上；
 *   ④ 101 条混合事件后，增量投影与「全量重放」`deepEqual`（CoW 没有漏复制 / 多改）；
 *   ⑤ revision 连续性（CHG-143 的两条断言）未被 CoW 破坏；
 *   ⑥ 端到端：只改标量的提交命中看板视图缓存（**同一个** `BoardView` 对象 = 零 frame），
 *      而触及 `tasks` 的提交必须让缓存失效（正确性优先于命中率）。
 *
 * 运行：`cd plugin && node --test test/t122-cow-commit.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService } from '../src/core/service.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'
import { openLedger, type LedgerEvent } from '../src/core/ledger/ledger.ts'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import { __clearViewCache, buildBoardView, viewCacheStats } from '../src/core/index/views.ts'

const COLUMNS = ['backlog', 'ready', 'running', 'gates', 'done']
const MAPPING = {
  backlog: ['backlog'],
  ready: ['ready'],
  running: ['in_progress', 're-scoping'],
  gates: ['gate:review', 'gate:verify', 'gate:archive'],
  done: ['done', 'failed', 'cancelled'],
}

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t122-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  const ledgerPath = join(ws, '.dsh-myteam', 'tasks', 't1', 'ledger.jsonl')
  return { ws, service, ledgerPath }
}

/** 账本行数（文件不存在 = 0 行） */
function ledgerLines(ledgerPath: string): number {
  try {
    return readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

/** 深快照（断开引用，用来断言「内容没被原地改」） */
const snap = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const taskInput = (over: Record<string, unknown> = {}) => ({
  title: 't',
  description: 'd',
  acceptanceCriteria: ['ac'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2' as const,
  gateChain: ['review', 'archive'],
  ...over,
})

type Draft = Parameters<TeamService['commit']>[0]

function commitOk(service: TeamService, draft: Draft): LedgerEvent {
  const result = service.commit(draft)
  assert.equal(result.ok, true, `${draft.type} 应成功: ${JSON.stringify(result)}`)
  return (result as { event: LedgerEvent }).event
}

/** 5 条引导事件：rules.version → team.created → member.spawned → plan.staged → plan.approved */
function bootstrap(service: TeamService): void {
  commitOk(service, { actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } })
  commitOk(service, {
    actor: 'lead',
    type: 'team.created',
    payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] },
  })
  commitOk(service, {
    actor: 'host',
    type: 'member.spawned',
    payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', instanceName: 'dev', sessionId: 's1', status: 'active', parentMemberId: null, depth: 0, rootMemberId: 'm1' },
  })
  commitOk(service, { actor: 'lead', type: 'plan.staged', payload: { teamId: 't1', planId: 'p1' } })
  commitOk(service, { actor: 'lead', type: 'plan.approved', payload: { teamId: 't1', planId: 'p1' } })
}

test('t122-1: 连续提交后 —— 未触及集合保持引用，触及的换新引用', () => {
  const { service } = setup()
  bootstrap(service)

  const before = service.projectionSnapshot
  const tasks0 = before.tasks
  const members0 = before.members

  // plan.clarify 在 fold 里是 no-op：任何集合都不该换引用
  commitOk(service, { actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: ['q'], round: 1 } })
  assert.notStrictEqual(service.projectionSnapshot, before, 'revision 变了 → 顶层投影对象必须换新（不可变投影）')
  assert.strictEqual(service.projectionSnapshot.tasks, tasks0, 'tasks 未触及 → 引用必须保持（视图缓存命中）')
  assert.strictEqual(service.projectionSnapshot.members, members0, 'members 未触及 → 引用必须保持')

  // team.updated 只改标量（name/goal）：集合仍应保持
  commitOk(service, { actor: 'lead', type: 'team.updated', payload: { teamId: 't1', name: 'renamed' } })
  assert.strictEqual(service.projectionSnapshot.tasks, tasks0, 'team.updated 不触及 tasks')
  assert.strictEqual(service.projectionSnapshot.members, members0, 'team.updated 不触及 members')

  // task.created 只触及 tasks
  commitOk(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })
  const tasks1 = service.projectionSnapshot.tasks
  assert.notStrictEqual(tasks1, tasks0, 'tasks 被触及 → 必须换新引用（否则缓存返回过期看板）')
  assert.strictEqual(service.projectionSnapshot.members, members0, 'members 仍未触及 → 保持最初引用')

  // member.spawned 只触及 members
  commitOk(service, {
    actor: 'host',
    type: 'member.spawned',
    payload: { teamId: 't1', memberId: 'm2', roleId: 'implementer', instanceName: 'dev2', sessionId: 's2', status: 'active', parentMemberId: null, depth: 0, rootMemberId: 'm2' },
  })
  assert.notStrictEqual(service.projectionSnapshot.members, members0, 'members 被触及 → 换新引用')
  assert.strictEqual(service.projectionSnapshot.tasks, tasks1, 'tasks 未触及 → 保持上一步的引用')
})

test('t122-2: 领域校验失败 —— 两个集合引用与失败前全等，账本零写入', () => {
  const { service, ledgerPath } = setup()
  bootstrap(service)
  commitOk(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })

  const before = service.projectionSnapshot
  const tasksRef = before.tasks
  const membersRef = before.members
  const contentBefore = snap(before)
  const linesBefore = ledgerLines(ledgerPath)
  const revisionBefore = before.revision

  const bad = service.commit({
    actor: 'm1',
    type: 'task.claimed',
    // 不存在的任务 → 领域校验 MT_VALIDATION（走不到 applyEvent / append）
    payload: { teamId: 't1', taskId: 'nope', memberId: 'm1', attemptId: 'a1' },
  })

  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.equal((bad as { code: string }).code, 'MT_VALIDATION')
  assert.strictEqual(service.projectionSnapshot, before, '失败 = 什么都没发生（投影对象都不许换）')
  assert.strictEqual(service.projectionSnapshot.tasks, tasksRef, 'tasks 引用必须全等（===）')
  assert.strictEqual(service.projectionSnapshot.members, membersRef, 'members 引用必须全等（===）')
  assert.deepEqual(snap(service.projectionSnapshot), contentBefore, '内容也不得被原地污染')
  assert.equal(service.projectionSnapshot.revision, revisionBefore, 'revision 不得前进')
  assert.equal(ledgerLines(ledgerPath), linesBefore, '账本零写入')
})

test('t122-3: applyEvent 抛错（重放防线）—— 集合引用全等、内容不变、账本零写入', () => {
  const { service, ledgerPath } = setup()
  bootstrap(service)
  // 任务停在 backlog，此时报门禁裁决 → 领域校验放行、fold 的合法转移防线抛 FoldError
  commitOk(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })

  const before = service.projectionSnapshot
  const tasksRef = before.tasks
  const membersRef = before.members
  const contentBefore = snap(before)
  const linesBefore = ledgerLines(ledgerPath)

  const bad = service.commit({
    actor: 'm1',
    type: 'task.gate.result',
    payload: { teamId: 't1', taskId: 'k1', gate: 'review', verdict: 'pass' },
  })

  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.equal((bad as { code: string }).code, 'MT_INTERNAL_FOLD')
  assert.strictEqual(service.projectionSnapshot, before, 'applyEvent 抛错 = 副本被丢弃，原投影对象不变')
  assert.strictEqual(service.projectionSnapshot.tasks, tasksRef, 'tasks 引用必须全等（===）')
  assert.strictEqual(service.projectionSnapshot.members, membersRef, 'members 引用必须全等（===）')
  assert.deepEqual(snap(service.projectionSnapshot), contentBefore, '嵌套字段（状态机 / 门禁数组）也不得被改')
  assert.equal(ledgerLines(ledgerPath), linesBefore, '账本零写入')

  // 失败后还能继续写，且 seq 没被失败的那次消耗
  const next = service.commit({ actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: ['q'], round: 1 } })
  assert.equal(next.ok, true)
  assert.equal((next as { event: LedgerEvent }).event.seq, linesBefore, '失败的提交不得消耗 seq')
})

test('t122-4: 101 条混合事件后，增量投影与全量重放逐字段一致', () => {
  const { service, ledgerPath } = setup()
  bootstrap(service)

  const TASKS = 12
  for (let i = 0; i < TASKS; i++) {
    const taskId = `k${i}`
    const attemptId = `a${i}`
    commitOk(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId, task: taskInput({ title: `t${i}` }) } })
    commitOk(service, { actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId, memberId: 'm1', attemptId } })
    // 4 条「不推进状态」的填充事件，覆盖不同集合（perTaskMessages / inbox / 标量 / no-op）
    commitOk(service, { actor: 'm1', type: 'task.progress', payload: { teamId: 't1', taskId, attemptId, note: `p${i}` } })
    commitOk(service, { actor: 'lead', type: 'message.sent', payload: { teamId: 't1', taskId, messageId: `msg${i}`, from: 'm1', to: 'inbox' } })
    commitOk(service, { actor: 'lead', type: 'team.updated', payload: { teamId: 't1', name: `team-${i}` } })
    commitOk(service, { actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: [`q${i}`], round: i + 1 } })
    commitOk(service, {
      actor: 'm1',
      type: 'task.evidence',
      payload: { teamId: 't1', taskId, attemptId, evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0 }] } },
    })
    commitOk(service, { actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId, attemptId } })
  }

  const { events } = openLedger(ledgerPath)
  const expected = 5 + TASKS * 8
  assert.equal(events.length, expected, `事件数应为 ${expected}`)
  assert.ok(expected >= 100, '本用例要求 ≥100 条事件')

  const replayed = foldEvents('t1', events)
  assert.deepEqual(service.projectionSnapshot, replayed, 'CoW 增量结果必须与「从零全量重放」逐字段一致')
  assert.equal(service.projectionSnapshot.revision, expected, 'revision = 已应用事件数')
  // 各集成都真的被写到了（否则上面的 deepEqual 是空对空）
  assert.equal(Object.keys(service.projectionSnapshot.tasks).length, TASKS)
  assert.equal(service.projectionSnapshot.inbox.length, TASKS)
  assert.equal(Object.keys(service.projectionSnapshot.perTaskMessages).length, TASKS)
})

test('t122-5: revision 连续性仍成立（CoW 没破坏 CHG-143 的两条断言）', () => {
  const { service, ledgerPath } = setup()
  bootstrap(service)
  const base = service.projectionSnapshot.revision
  assert.equal(base, 5)

  const N = 10
  for (let i = 0; i < N; i++) {
    commitOk(service, { actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: [`q${i}`], round: i + 1 } })
    assert.equal(service.projectionSnapshot.revision, base + i + 1, `第 ${i + 1} 次提交后 revision 必须恰好 +1`)
  }
  assert.equal(service.projectionSnapshot.revision, base + N)
  assert.equal(service.projectionSnapshot.revision, ledgerLines(ledgerPath), 'revision 恒等于已落账事件数')
})

test('t122-6: 端到端零 frame —— 只改标量的提交命中视图缓存（同一 BoardView 对象）', () => {
  const { service } = setup()
  bootstrap(service)
  commitOk(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })

  __clearViewCache()
  const view1 = buildBoardView(service, MAPPING, COLUMNS)
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 1 }, '首次构建 = 未命中')

  // plan.clarify 不动 members / tasks / participations → 引用全稳 → 命中，返回**同一个**视图对象
  commitOk(service, { actor: 'lead', type: 'plan.clarify', payload: { teamId: 't1', questions: ['q'], round: 1 } })
  const view2 = buildBoardView(service, MAPPING, COLUMNS)
  assert.strictEqual(view2, view1, '零 frame：必须是同一个视图对象（引用相等）')
  assert.deepEqual(viewCacheStats(), { hits: 1, misses: 1 })
  assert.equal(view2.revision, service.projectionSnapshot.revision, '命中后仍要回填最新 revision')

  // 反过来：触及 tasks 的提交必须让缓存失效——正确性优先于命中率
  const tasksRef = service.projectionSnapshot.tasks
  commitOk(service, { actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k2', task: taskInput({ title: 'k2' }) } })
  assert.notStrictEqual(service.projectionSnapshot.tasks, tasksRef, 'tasks 被触及 → 引用换了')
  const view3 = buildBoardView(service, MAPPING, COLUMNS)
  assert.notStrictEqual(view3, view2, '引用变了必须重建（宁可多算一次，不可返回过期视图）')
  assert.deepEqual(viewCacheStats(), { hits: 1, misses: 2 })
  assert.equal(view3.columns.flatMap((column) => column.tasks).length, 2, '重建后能看到新任务')
})
