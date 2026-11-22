import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelGateway } from '../src/application/panel-gateway.ts'

test('面板网关：按会话解析工作区根并转交服务', async () => {
  const calls = []
  const gateway = createPanelGateway({
    service: {
      async invoke(rootDir, request) {
        calls.push([rootDir, request])
        return { ok: true, data: { rootDir } }
      },
    },
    rootForSession: (sessionId) => (sessionId === 'ses_known' ? 'E:\\proj' : null),
  })

  const result = await gateway.invoke('ses_known', { method: 'status' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['E:\\proj', { method: 'status' }]])
})

test('面板网关：未知会话与空会话都拒绝，且不调用服务', async () => {
  let called = 0
  const gateway = createPanelGateway({
    service: {
      async invoke() {
        called += 1
        return { ok: true, data: {} }
      },
    },
    rootForSession: () => null,
  })

  const unknown = await gateway.invoke('ses_unknown', { method: 'board' })
  assert.equal(unknown.ok, false)
  assert.equal((unknown as { error: { code: string } }).error.code, 'FORBIDDEN')

  const empty = await gateway.invoke('', { method: 'board' })
  assert.equal(empty.ok, false)
  assert.equal((empty as { error: { code: string } }).error.code, 'FORBIDDEN')

  assert.equal(called, 0, '拒绝时不得触碰项目数据')
})