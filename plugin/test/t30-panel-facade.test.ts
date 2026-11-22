import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPanelFacade } from '../src/composition/panel.ts'

test('面板门面：会话未绑定工作区时拒绝，且不触碰项目数据', async () => {
  const facade = createPanelFacade({})
  try {
    const result = (await facade.methods.board!({ id: 'ses_unknown' }, {})) as {
      ok: boolean
      error?: { code: string }
    }
    assert.equal(result.ok, false)
    assert.equal(result.error!.code, 'FORBIDDEN')
  } finally {
    await facade.close()
  }
})

test('面板门面：按会话解析工作区后转发给服务（空项目返回空看板）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const facade = createPanelFacade({
    agents: { get: (id) => (id === 'ses_1' ? { id: 'ses_1' } : undefined) },
    workingDirectory: { ensure: async () => dir },
  })

  try {
    const status = (await facade.methods.status!({ id: 'ses_1' }, {})) as {
      ok: boolean
      data?: { schemaVersion?: number }
      error?: { code: string }
    }
    assert.equal(status.ok, true, JSON.stringify(status))

    const board = (await facade.methods.board!({ id: 'ses_1' }, {})) as {
      ok: boolean
      data?: { totals: { all: number }; columns: unknown[] }
    }
    assert.equal(board.ok, true, JSON.stringify(board))
    assert.equal(board.data!.totals.all, 0)
    assert.equal(board.data!.columns.length, 8)

    const bad = (await facade.methods.task!({ id: 'ses_1' }, { taskId: 'task_missing' })) as {
      ok: boolean
      error?: { code: string }
    }
    assert.equal(bad.ok, false)
  } finally {
    await facade.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写通道：门禁裁决走直接确认，缺 confirm 时由域拒绝（不签发预览令牌）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-write-'))
  const facade = createPanelFacade({
    agents: { get: (id) => (id === 'ses_1' ? { id: 'ses_1' } : undefined) },
    workingDirectory: { ensure: async () => dir },
  })
  try {
    const rejected = (await facade.write('gateVerdict', 'ses_1', {
      sessionId: 'ses_1',
      confirm: false,
      params: {
        taskId: 'task_missing',
        attemptId: 'attempt_missing',
        outcome: 'pass',
        checks: [],
        evidence: [],
      },
    })) as { ok: boolean; data?: unknown; error?: { code: string; message: string } }
    assert.equal(rejected.ok, false, '缺 confirm 不能执行')
    assert.equal(rejected.error!.code, 'INVALID_PAYLOAD')
    assert.equal(rejected.data, undefined, '也不该回预览数据')
    assert.match(rejected.error!.message, /confirm/)
  } finally {
    await facade.close()
    rmSync(dir, { recursive: true, force: true })
  }
})