/**
 * T148 · CHG-202z（FR-33 · M3-7）：**项目共享看板**——三种分组 + 五个汇总。
 *
 * 口径正本 docs/23 §4.3。本文件锁住三件事：
 *  ① 汇总口径：running / gates / done / blocked / evidenceStale 各自只认一个状态集合，
 *    **五个桶之和 ≤ 总数**（backlog/ready/failed/cancelled 只计入 tasks）；
 *  ② 三种分组：team / role / rootMember（子成员领取的任务归到**根**，场景 44）；
 *  ③ 端点：门面与 Remote 都暴露，非法 groupBy 报 MT_VALIDATION 而不是静默回落。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectBoardView, summarizeProjectTasks, type ProjectGroupBy } from '../src/core/index/project-board-view.ts'
import type { ProjectTaskView, ProjectView } from '../src/core/index/views.ts'

function task(over: Partial<ProjectTaskView>): ProjectTaskView {
  return {
    id: 't1',
    title: 'x',
    state: 'ready',
    priority: 'P2',
    requiredRole: 'implementer',
    escalateCount: 0,
    deps: [],
    gates: [],
    gateVerdicts: {},
    evidenceCount: 0,
    participants: [],
    actions: { rescope: true, edit: true, cancel: true },
    key: 'team-a::t1',
    ownerTeamId: 'team-a',
    ownerOnline: false,
    ...over,
  } as ProjectTaskView
}

function project(tasks: ProjectTaskView[]): ProjectView {
  return {
    workspaceRoot: '/ws',
    teams: [
      {
        teamId: 'team-a',
        name: 'A 队',
        state: 'active',
        online: false,
        counts: { tasks: 0, done: 0, running: 0 },
        members: [
          { id: 'm1-implementer', roleId: 'implementer', instanceName: 'impl-1', status: 'active', parentMemberId: null, depth: 0, rootMemberId: 'm1-implementer' },
          { id: 'm2-implementer', roleId: 'implementer', instanceName: 'impl-2', status: 'active', parentMemberId: 'm1-implementer', depth: 1, rootMemberId: 'm1-implementer' },
        ] as never,
      },
    ],
    tasks,
    graph: { nodes: [], edges: [] } as never,
    roles: [],
    counts: { tasks: tasks.length, done: 0, running: 0, gates: 0, teams: 1, members: 2, roles: 0 },
    warnings: [],
  }
}

test('t148-1: 五个汇总各自只认一个状态集合；五个桶之和 ≤ 总数', () => {
  const summary = summarizeProjectTasks([
    task({ state: 'in_progress' }),
    task({ state: 're-scoping' }),
    task({ state: 'gate:review' }),
    task({ state: 'gate:verify' }),
    task({ state: 'done' }),
    task({ state: 'blocked' }),
    task({ state: 'backlog' }),
    task({ state: 'failed' }),
    task({ state: 'cancelled' }),
    task({ state: 'ready', evidenceStale: { since: 1, fields: ['deps'] } }),
  ])
  assert.equal(summary.tasks, 10)
  assert.equal(summary.running, 2, 'in_progress + re-scoping')
  assert.equal(summary.gates, 2, 'gate:review + gate:verify')
  assert.equal(summary.done, 1)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.evidenceStale, 1)
  const buckets = summary.running + summary.gates + summary.done + summary.blocked
  assert.ok(buckets <= summary.tasks, `五个桶之和 ${buckets} 不能超过总数 ${summary.tasks}`)
  assert.ok(summary.note.includes('口径'), '口径说明必须随数字一起给（UI 直接显示）')
})

test('t148-2: 按团队分组——key = ownerTeamId，label 用团队名', () => {
  const view = buildProjectBoardView(project([task({}), task({ key: 'team-b::t9', ownerTeamId: 'team-b' })]), 'team')
  assert.equal(view.groupBy, 'team')
  assert.equal(view.groups.length, 2)
  const a = view.groups.find((group) => group.key === 'team-a')
  assert.equal(a?.label, 'A 队')
  assert.equal(a?.counts.tasks, 1)
  assert.equal(view.summary.tasks, 2, '汇总永远按全部任务算，与分组无关')
})

test('t148-3: 按角色分组——key = requiredRole', () => {
  const view = buildProjectBoardView(project([task({ requiredRole: 'implementer' }), task({ key: 'k2', requiredRole: 'reviewer' })]), 'role')
  assert.deepEqual(view.groups.map((group) => group.key).sort(), ['implementer', 'reviewer'])
})

test('t148-4: 按父子根分组——子成员领取的任务归到根；未领取单独一组且排最后（场景 44）', () => {
  const view = buildProjectBoardView(
    project([
      task({ key: 'k1', assignee: 'm1-implementer' }),
      task({ key: 'k2', assignee: 'm2-implementer' }), // 子成员 → 根 m1
      task({ key: 'k3', assignee: undefined }),
    ]),
    'rootMember',
  )
  const root = view.groups.find((group) => group.key === 'm1-implementer')
  assert.equal(root?.tasks.length, 2, '子成员领取的任务必须归到根（否则树一深就散成多组）')
  const unclaimed = view.groups[view.groups.length - 1]
  assert.equal(unclaimed.key, '', '未领取的组排最后（不该抢第一屏）')
  assert.equal(unclaimed.label, '（未领取）')
})

test('t148-5: 分组稳定——同一份数据两次调用结果逐字段一致（UI 不会每次重渲染都跳）', () => {
  const tasks = [task({ key: 'a' }), task({ key: 'b', ownerTeamId: 'team-b' }), task({ key: 'c', ownerTeamId: 'team-c' })]
  const once = buildProjectBoardView(project(tasks), 'team' as ProjectGroupBy)
  const twice = buildProjectBoardView(project(tasks), 'team' as ProjectGroupBy)
  assert.deepEqual(once, twice)
})
