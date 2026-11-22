import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  statusLabel,
  toBoardModel,
  toDefinitionRows,
  toMigrationModel,
  toOverviewModel,
  toTaskModel,
} from '../client/panel-model.js'

test('面板模型：看板补标签、保留计数与阻塞上游', () => {
  const model = toBoardModel({
    totals: { all: 2, done: 1, blocked: 0, review: 0 },
    graphRevision: 3,
    columns: [
      { status: 'ready', count: 1, tasks: [{ id: 'task_1', title: '做', ownerTeamName: null, blockedBy: ['task_0'], attemptId: null }] },
      { status: 'done', count: 1, tasks: [] },
    ],
  })
  assert.equal(model.columns[0].label, '可认领')
  assert.equal(model.columns[0].tasks[0].team, '未分配团队')
  assert.equal(model.columns[0].tasks[0].blocked, true)
  assert.equal(model.columns[1].empty, false, 'count=1 但 tasks 为空时仍以 count 为准')
})

test('面板模型：任务详情不猜缺失值', () => {
  const model = toTaskModel({
    task: { id: 'task_1', title: '做', status: 'review', acceptance: ['x'] },
    team: null,
    attempt: { id: 'att_1', generation: 2 },
    verdict: null,
    evidence: [],
    dependencies: [{ taskId: 'task_0', status: null, title: null }],
    dependents: [],
  })
  assert.equal(model.team, null)
  assert.equal(model.verdict, null)
  assert.equal(model.dependencies[0].title, '（已不存在）')
  assert.equal(model.dependencies[0].statusLabel, '未知')
})

test('面板模型：上游状态未知与「无变化」区分开', () => {
  const [row] = toDefinitionRows({
    items: [
      {
        kind: 'role',
        id: 'role_1',
        name: '实现者',
        revision: 2,
        archived: false,
        localChanged: true,
        upstreamChanged: null,
        updateAvailable: null,
        published: null,
      },
    ],
  })
  assert.equal(row.upstreamLabel, '未知（未接入全局库）')
  assert.equal(row.localChanged, true)
  assert.equal(row.published, null)
})

test('面板模型：概览的关注项带 active 标记', () => {
  const model = toOverviewModel({
    totals: { all: 0, done: 0, blocked: 0, review: 0 },
    attention: { review: 2, blocked: 0, unknownEffects: 1 },
    teams: [{ id: 'team_1', name: '甲队', status: 'active', members: 1, tasks: 2, captain: null }],
  })
  assert.deepEqual(model.attention.map((item) => item.active), [true, false, true])
  assert.equal(model.teams[0].captain, '未指派')
})

test('面板模型：迁移结论与状态标签', () => {
  assert.equal(statusLabel('unknown-state'), '未知状态')
  const model = toMigrationModel({ verdict: 'blocked', headline: 'x', markdown: '# x' })
  assert.equal(model.verdictLabel, '阻断')
})