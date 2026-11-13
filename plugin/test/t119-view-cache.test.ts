/**
 * T119（P1-3，docs/21 §6，来源官方 `types/projection.js:274-317`）：投影视图两级 WeakMap 缓存。
 *
 * 锁两件事（缺一不可，且顺序就是风险等级）：
 *  ① **正确性**：缓存命中拿到的视图必须与「清空缓存后重算」逐字段一致——
 *     fold 的 copy-on-write 少复制一个集合，就会返回**已经变了**的旧视图（静默错误）；
 *  ② **收益**：只改 messages 时 `members` / `tasks` 引用不变 → 视图引用不变 →
 *     客户端不产生白 frame（这正是本任务要消除的重渲染）。
 *
 * 另外锁：失败态绕过缓存（失败现场不能被后续事件悄悄改写）、缓存计数可观测、
 * 列配置/事件流变化不得串视图。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, foldEvents } from '../src/core/scheduler/fold.ts'
import { __clearViewCache, buildBoardView, buildTaskDetailView, viewCacheStats } from '../src/core/index/views.ts'
import { emptyProjection } from '../src/core/scheduler/state.ts'
import type { TeamProjection } from '../src/core/scheduler/state.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'

const COLUMNS = ['backlog', 'ready', 'running', 'gates', 'done']
const MAPPING = {
  backlog: ['backlog'],
  ready: ['ready'],
  running: ['in_progress', 're-scoping'],
  gates: ['gate:review', 'gate:verify', 'gate:archive'],
  done: ['done', 'failed', 'cancelled'],
}

let seq = 0
function ev(type: string, payload: Record<string, unknown>, ts = 1000): LedgerEvent {
  return { seq: seq++, ts, actor: 'test', type: type as LedgerEvent['type'], payload }
}

function taskInput(over: Record<string, unknown> = {}) {
  return {
    title: 't',
    description: 'd',
    acceptanceCriteria: ['ac'],
    deliverableSpec: { path: 'docs/x.md' },
    deps: [],
    requiredRole: 'dev',
    priority: 'P2',
    gateChain: ['review', 'archive'],
    ...over,
  }
}

/** 一份最小合法账本：团队 active + 成员 + 一个任务（可 claim） */
function baseEvents(): LedgerEvent[] {
  seq = 0
  return [
    ev('team.created', { teamId: 't1', name: '团队', goal: '目标' }),
    ev('plan.approved', { teamId: 't1', planId: 'p1' }),
    ev('member.spawned', { teamId: 't1', memberId: 'm1', roleId: 'dev', sessionId: 's1', status: 'ok', parentMemberId: null, depth: 0, rootMemberId: 'm1' }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    ev('task.created', { teamId: 't1', taskId: 'k2', task: taskInput({ title: 'k2 标题', deps: ['k1'] }) }),
  ]
}

function boardOf(proj: TeamProjection) {
  return buildBoardView({ projectionSnapshot: proj }, MAPPING, COLUMNS)
}

function tasksOf(view: ReturnType<typeof boardOf>) {
  return view.columns.flatMap((column) => column.tasks)
}

/** mulberry32：小而确定的 PRNG（随机序列要可复现，失败能原样重跑） */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

beforeEach(() => {
  __clearViewCache()
})

test('t119-1: 只改 messages → members/tasks 引用不变且视图引用相同（命中）', () => {
  const proj = foldEvents('t1', baseEvents())
  const view1 = boardOf(proj)
  const tasksRef = proj.tasks
  const membersRef = proj.members
  const inboxRef = proj.inbox
  const revision1 = proj.revision

  applyEvent(proj, ev('message.sent', { teamId: 't1', taskId: 'k1', from: 'm1', to: 'lead', body: '进度如何？' }))

  // 本任务核心：未触及的集合必须保持引用（否则缓存键每次都变，缓存等于没有）
  assert.equal(proj.tasks, tasksRef, '只改 messages 时 tasks 引用必须不变')
  assert.equal(proj.members, membersRef, '只改 messages 时 members 引用必须不变')
  // 消息事件按类型保守复制 inbox / perTaskMessages（多复制不少复制：少复制 = 过期视图）
  assert.notEqual(proj.inbox, inboxRef, 'message.sent 必须换掉 inbox 引用（copy-on-write，保守复制）')
  assert.equal(proj.revision, revision1 + 1, 'revision 仍逐事件递增')

  const view2 = boardOf(proj)
  assert.equal(view2, view1, '只改 messages 时必须命中缓存（同一个视图引用 = 客户端零 frame）')
  assert.equal(view2.revision, proj.revision, '命中后 revision 必须回填为最新值（乐观锁版本）')
  assert.deepEqual(viewCacheStats(), { hits: 1, misses: 1 })
})

test('t119-2: 改 tasks → 缓存失效、重建且字段正确（不会被旧视图掩盖）', () => {
  const proj = foldEvents('t1', baseEvents())
  const view1 = boardOf(proj)
  const tasksRef = proj.tasks
  assert.equal(tasksOf(view1).find((t) => t.id === 'k1')?.title, 't')

  applyEvent(proj, ev('task.updated', { teamId: 't1', taskId: 'k1', patch: { title: '新标题' } }))

  assert.notEqual(proj.tasks, tasksRef, '任务事件必须换掉 tasks 引用（copy-on-write）')
  const view2 = boardOf(proj)
  assert.notEqual(view2, view1, '任务变了必须重建视图')
  assert.equal(tasksOf(view2).find((t) => t.id === 'k1')?.title, '新标题')
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 2 })
  // 旧视图是「旧快照」——重建不得回头改写它
  assert.equal(tasksOf(view1).find((t) => t.id === 'k1')?.title, 't')
})

test('t119-3: members 变 → 旧缓存不可达（旧视图不被新事件改写）', () => {
  const proj = foldEvents('t1', baseEvents())
  const view1 = boardOf(proj)
  const membersRef = proj.members
  assert.equal(view1.members.length, 1)

  applyEvent(proj, ev('member.spawned', { teamId: 't1', memberId: 'm2', roleId: 'dev', sessionId: 's2', status: 'ok', parentMemberId: null, depth: 0, rootMemberId: 'm2' }))
  assert.notEqual(proj.members, membersRef, '成员事件必须换掉 members 引用')

  const view2 = boardOf(proj)
  assert.notEqual(view2, view1, '成员变了必须重建视图')
  assert.equal(view2.members.length, 2)
  assert.equal(view1.members.length, 1, '旧视图必须停留在旧快照（缓存不可达 ≠ 旧对象可变）')
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 2 })
})

test('t119-4: 逐字段一致性——随机事件序列 20 轮，缓存视图 vs 清空重算 vs 全量重放', () => {
  for (let round = 0; round < 20; round += 1) {
    const rand = mulberry32(0x9e3779b9 ^ round)
    const events: LedgerEvent[] = [
      ev('team.created', { teamId: 't1', name: `团队-${round}`, goal: '目标' }),
      ev('plan.approved', { teamId: 't1', planId: 'p1' }),
      ev('member.spawned', { teamId: 't1', memberId: 'm1', roleId: 'dev', sessionId: 's1', status: 'ok', parentMemberId: null, depth: 0, rootMemberId: 'm1' }),
      ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
      ev('task.created', { teamId: 't1', taskId: 'k2', task: taskInput({ title: 'k2', deps: ['k1'] }) }),
      ev('task.claimed', { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' }),
      ev('task.progress', { teamId: 't1', taskId: 'k1', note: '进行中' }),
      ev('task.evidence', { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { kind: 'files', filesTouched: ['src/a.ts'] } }),
      ev('task.completed', { teamId: 't1', taskId: 'k1', attemptId: 'a1' }),
      ev('task.gate.result', { teamId: 't1', taskId: 'k1', gate: 'review', verdict: 'pass' }),
      ev('task.gate.result', { teamId: 't1', taskId: 'k1', gate: 'archive', verdict: 'pass' }),
    ]
    // 随机插入消息事件：只有 perTaskMessages / inbox / revision 变化，视图不该重建
    const messageCount = 1 + Math.floor(rand() * 6)
    for (let i = 0; i < messageCount; i += 1) {
      const at = 1 + Math.floor(rand() * (events.length - 1))
      events.splice(at, 0, ev('message.sent', { teamId: 't1', taskId: 'k1', from: 'm1', to: 'lead', body: `m${round}-${i}` }))
    }

    // 增量折叠：每来一条事件就构建一次视图（模拟面板轮询）
    const proj = emptyProjection('t1')
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      applyEvent(proj, event)
      const cached = boardOf(proj)
      const again = boardOf(proj)
      assert.equal(again, cached, `round ${round} seq ${event.seq}: 同一快照的第二次构建必须命中缓存`)
      // 清空缓存 → 真正的重算；命中与重算必须逐字段一致
      __clearViewCache()
      const fresh = boardOf(proj)
      assert.deepEqual(cached, fresh, `round ${round} seq ${event.seq}: 缓存视图与重算视图必须逐字段一致`)
      // 与全量重放（另一条折叠路径）对照：增量折叠不得偏离账本重放
      const replayed = boardOf(foldEvents('t1', events.slice(0, i + 1)))
      assert.deepEqual(fresh, replayed, `round ${round} seq ${event.seq}: 增量折叠与全量重放必须一致`)
    }
  }
})

test('t119-5: 失败态绕过缓存，每次重建（失败现场不得被后续事件改写）', () => {
  const proj = foldEvents('t1', baseEvents())
  const view1 = boardOf(proj)

  // 官方形态：state 是带 failure 的对象（本插件投影暂无该字段，前向兼容）
  ;(proj as unknown as { failure?: unknown }).failure = { at: 1, reason: 'boom' }
  const view2 = boardOf(proj)
  const view3 = boardOf(proj)
  assert.notEqual(view2, view1, '失败态必须重建')
  assert.notEqual(view3, view2, '失败态每次都必须重建（不得缓存）')
  assert.deepEqual(view3, view2, '两次重建的字段必须一致')
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 3 }, '失败态不计命中')

  // 另一种形态：state.failure
  __clearViewCache()
  const proj2 = foldEvents('t1', baseEvents())
  ;(proj2 as unknown as { state: unknown }).state = { failure: { at: 2 } }
  const a = boardOf(proj2)
  const b = boardOf(proj2)
  assert.notEqual(b, a, 'state.failure 同样必须绕过缓存')
})

test('t119-6: 缓存计数正确（命中/未命中可观测，清空后归零）', () => {
  const proj = foldEvents('t1', baseEvents())
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 0 })

  const view1 = boardOf(proj)
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 1 }, '首次构建 = 未命中')

  const view2 = boardOf(proj)
  assert.equal(view2, view1)
  assert.deepEqual(viewCacheStats(), { hits: 1, misses: 1 }, '同一快照重复构建 = 命中')

  applyEvent(proj, ev('message.sent', { teamId: 't1', taskId: 'k1', from: 'm1', to: 'lead', body: 'hi' }))
  boardOf(proj)
  assert.deepEqual(viewCacheStats(), { hits: 2, misses: 1 }, '只改消息 = 命中')

  applyEvent(proj, ev('task.updated', { teamId: 't1', taskId: 'k1', patch: { description: '改描述' } }))
  boardOf(proj)
  assert.deepEqual(viewCacheStats(), { hits: 2, misses: 2 }, '改任务 = 未命中')

  // 换列配置：同一投影也不能串用视图（否则看板列会错乱）
  buildBoardView({ projectionSnapshot: proj }, {}, ['全部'])
  assert.deepEqual(viewCacheStats(), { hits: 2, misses: 3 }, '换列配置必须重建')

  __clearViewCache()
  assert.deepEqual(viewCacheStats(), { hits: 0, misses: 0 }, '__clearViewCache 必须同时清零计数')
})

test('t119-7: 详情视图缓存——同一快照同一任务命中，事件流变化后重建且字段正确', () => {
  const events = baseEvents()
  const proj = foldEvents('t1', events)
  const detail1 = buildTaskDetailView({ projectionSnapshot: proj }, 'k1', events)
  assert.ok(detail1)
  const detail2 = buildTaskDetailView({ projectionSnapshot: proj }, 'k1', events)
  assert.equal(detail2, detail1, '同一快照同一任务必须命中')

  const message = ev('message.sent', { teamId: 't1', taskId: 'k1', from: 'm1', to: 'lead', body: '详情页消息' })
  events.push(message)
  applyEvent(proj, message)
  const detail3 = buildTaskDetailView({ projectionSnapshot: proj }, 'k1', events)
  assert.ok(detail3)
  assert.notEqual(detail3, detail1, '事件流变了（消息进时间线/消息流）必须重建')
  assert.equal(detail3.messages.length, 1, '新消息必须出现在详情视图里')
  assert.equal(detail3.revision, proj.revision, 'revision 必须是最新值')

  // 不存在的任务：不得因为缓存而返回旧对象
  assert.equal(buildTaskDetailView({ projectionSnapshot: proj }, 'ghost', events), undefined)
})
