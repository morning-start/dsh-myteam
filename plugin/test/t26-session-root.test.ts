import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionRootResolver } from '../src/application/session-root.ts'
import { createPanelGateway } from '../src/application/panel-gateway.ts'

test('会话根解析：只接受绝对路径', () => {
  const resolve = createSessionRootResolver({
    sessions: {
      cwdOf: (sessionId) => {
        if (sessionId === 'ses_abs') return 'E:\\proj'
        if (sessionId === 'ses_rel') return 'proj'
        return null
      },
    },
  })
  assert.equal(resolve('ses_abs'), 'E:\\proj')
  assert.equal(resolve('ses_rel'), null, '相对路径不足以确定项目')
  assert.equal(resolve('ses_missing'), null)
  assert.equal(resolve(''), null)
})

test('单项目模式：fixedRoot 生效，但必须是绝对路径', () => {
  const resolve = createSessionRootResolver({ sessions: { cwdOf: () => null }, fixedRoot: 'E:\\only' })
  assert.equal(resolve('ses_any'), 'E:\\only')
  assert.throws(() => createSessionRootResolver({ sessions: { cwdOf: () => null }, fixedRoot: 'only' }))
})

test('网关 + 解析器：相对 cwd 的会话被拒绝', async () => {
  const gateway = createPanelGateway({
    service: {
      async invoke() {
        return { ok: true, data: {} }
      },
    },
    rootForSession: createSessionRootResolver({ sessions: { cwdOf: () => 'proj' } }),
  })
  const result = await gateway.invoke('ses_rel', { method: 'status' })
  assert.equal(result.ok, false)
  assert.equal((result as { error: { code: string } }).error.code, 'FORBIDDEN')
})