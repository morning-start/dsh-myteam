import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelClient, PanelError } from '../client/panel-client.js'
import { PANEL_METHODS } from '../src/application/panel-contract.ts'

test('面板客户端：方法名与契约一致，参数按方法传递', async () => {
  const calls = []
  const client = createPanelClient(async (method, params) => {
    calls.push([method, params])
    return { ok: true, data: { method } }
  })

  await client.status()
  await client.board()
  await client.task('task_1')
  await client.team('team_1')
  await client.definitions()
  await client.migration()

  assert.deepEqual(
    calls.map(([method]) => method),
    ['status', 'board', 'task', 'team', 'definitions', 'migration'],
  )
  assert.deepEqual(calls[2][1], { taskId: 'task_1' })
  for (const [method] of calls) {
    assert.ok(PANEL_METHODS.includes(method), `${method} 不在契约里`)
  }
})

test('面板客户端：服务端错误转成带 code 的 PanelError', async () => {
  const client = createPanelClient(async () => ({
    ok: false,
    error: { code: 'NOT_FOUND', message: '任务不存在', details: { taskId: 'task_x' } },
  }))

  await assert.rejects(
    () => client.task('task_x'),
    (error) => error instanceof PanelError && error.code === 'NOT_FOUND' && error.details.taskId === 'task_x',
  )
})

test('面板客户端：畸形响应不被当成成功', async () => {
  const client = createPanelClient(async () => null)
  await assert.rejects(
    () => client.overview(),
    (error) => error instanceof PanelError && error.code === 'INVALID_RESPONSE',
  )
})