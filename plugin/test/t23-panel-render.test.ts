import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, renderBoard, renderDefinitions, renderMigration, renderOverview, renderTask } from '../client/panel-render.js'

test('渲染：所有数据文本都转义', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')">`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;')

  const board = renderBoard({
    columns: [
      {
        status: 'ready',
        label: '可认领',
        count: 1,
        empty: false,
        tasks: [{ id: 'task_1', title: '<script>bad()</script>', team: '甲队', blockedBy: [], blocked: false }],
      },
    ],
  })
  assert.ok(!board.includes('<script>'))
  assert.ok(board.includes('&lt;script&gt;'))

  const task = renderTask({
    id: 'task_1',
    title: '<b>x</b>',
    statusLabel: '评审中',
    team: { name: '<i>甲</i>' },
    verdict: null,
    acceptance: ['<ok>'],
    dependencies: [],
    dependents: [],
  })
  assert.ok(!task.includes('<b>x</b>'))
  assert.ok(task.includes('&lt;b&gt;x&lt;/b&gt;'))
  assert.ok(task.includes('尚未裁决'))
  assert.ok(task.includes('无依赖'))
})

test('渲染：空列显式显示无任务', () => {
  const html = renderBoard({
    columns: [{ status: 'done', label: '已完成', count: 0, empty: true, tasks: [] }],
  })
  assert.ok(html.includes('无任务'))
  assert.ok(html.includes('data-status="done"'))
})

test('渲染：定义清单显示三类状态，迁移报告按纯文本转义', () => {
  const rows = renderDefinitions([
    {
      kind: 'role',
      id: 'r1',
      name: '<实现者>',
      revision: 2,
      archived: false,
      localChanged: true,
      upstreamChanged: null,
      updateAvailable: null,
      upstreamLabel: '未知（未接入全局库）',
      published: null,
    },
  ])
  assert.ok(rows.includes('本地已改'))
  assert.ok(rows.includes('&lt;实现者&gt;'))
  assert.ok(!rows.includes('<实现者>'))

  const report = renderMigration({ verdict: 'blocked', verdictLabel: '阻断', headline: '<x>', markdown: '<b>正文</b>' })
  assert.ok(report.includes('&lt;b&gt;正文&lt;/b&gt;'))
  assert.ok(!report.includes('<b>正文</b>'))
})

test('渲染：概览关注项带 active 标记与计数', () => {
  const html = renderOverview({
    attention: [
      { key: 'review', label: '待裁决', count: 2, active: true },
      { key: 'blocked', label: '阻塞', count: 0, active: false },
    ],
    teams: [{ id: 'team_1', name: '甲队', status: 'active', members: 1, tasks: 2, captain: '未指派' }],
  })
  assert.ok(html.includes('is-active'))
  assert.ok(html.includes('阻塞 0'))
  assert.ok(html.includes('未指派'))
})