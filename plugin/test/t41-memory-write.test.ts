/**
 * t41：面板写记忆（`memoryRemember` / `memoryForget`）。
 *
 * 为什么单独一组：记忆是**唯一**存在事件账本之外的权威数据（SQLite）。面板写它时
 * 没有事件可回放，所以断言只能落在库本身：写进去读得到、软删留痕、硬删真没了。
 * 另外要确认路径是按项目落的（`memory/myteam.db`），不是全局库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { applyDirectPanelWrite } from '../src/application/panel-writes.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { memoryDbPath, readMemoryStore } from '../src/infrastructure/memory-store/read.ts'
import { SqliteMemoryStore } from '../src/infrastructure/memory-store/sqlite-memory.ts'
import { createReviewTaskFixture } from './fixtures/review-task.ts'

function depsFor(rootDir: string) {
  return { rootDir, openMemory: (dir: string) => new SqliteMemoryStore(join(dir, memoryDbPath(dir))) }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, `应抛 MyTeamError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

test('写记忆：落进项目的 memory/memory.db，读得到 tag 与正文', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-memory-' })
  try {
    const applied = applyDirectPanelWrite(
      fx.runtime,
      'memoryRemember',
      { confirm: true, params: { teamId: fx.teamId, text: '成员提交前先跑测试', tags: ['gate'] } },
      depsFor(fx.dir),
    )
    const committed = applied.committed as { id: string; bankId: string }
    assert.equal(applied.operationId, committed.id)
    assert.match(committed.bankId, /^team:/, '人类不带 memberId 时写团队 bank')

    const view = readMemoryStore(fx.dir, {})
    assert.equal(view.exists, true)
    assert.equal(view.entries.length, 1)
    assert.equal(view.entries[0]!.text, '成员提交前先跑测试')
    assert.deepEqual(view.entries[0]!.tags, ['gate'])
    assert.equal(readMemoryStore(fx.dir, {}).banks.length, 1)
    assert.equal(view.file, 'memory/memory.db', '路径是项目内的相对路径')
  } finally {
    fx.dispose()
  }
})

test('遗忘记忆：默认软删留痕，hard 才真删', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-memory-' })
  try {
    const deps = depsFor(fx.dir)
    const first = applyDirectPanelWrite(
      fx.runtime,
      'memoryRemember',
      { confirm: true, params: { teamId: fx.teamId, text: '这条会先软删' } },
      deps,
    ).committed as { id: string }
    const second = applyDirectPanelWrite(
      fx.runtime,
      'memoryRemember',
      { confirm: true, params: { teamId: fx.teamId, text: '这条会硬删' } },
      deps,
    ).committed as { id: string }

    applyDirectPanelWrite(
      fx.runtime,
      'memoryForget',
      { confirm: true, params: { teamId: fx.teamId, id: first.id, reason: '记错了' } },
      deps,
    )
    const afterSoft = readMemoryStore(fx.dir, {})
    assert.equal(afterSoft.entries.length, 2, '软删不删行')
    assert.equal(afterSoft.entries.filter((entry) => entry.forgotten).length, 1)
    assert.equal(afterSoft.banks[0]!.live, 1, 'bank 的 live 计数只算未遗忘')

    applyDirectPanelWrite(
      fx.runtime,
      'memoryForget',
      { confirm: true, params: { teamId: fx.teamId, id: second.id, reason: '要求彻底抹掉', hard: true } },
      deps,
    )
    const afterHard = readMemoryStore(fx.dir, {})
    assert.equal(afterHard.entries.filter((entry) => entry.id === second.id).length, 0, '硬删后行真的没了')
  } finally {
    fx.dispose()
  }
})

test('写记忆要被拦住：缺 confirm / 缺正文 / 未装配存储', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-memory-' })
  try {
    expectCode(
      () =>
        applyDirectPanelWrite(
          fx.runtime,
          'memoryRemember',
          { confirm: false, params: { teamId: fx.teamId, text: 'x' } },
          depsFor(fx.dir),
        ),
      'INVALID_PAYLOAD',
    )
    expectCode(
      () => applyDirectPanelWrite(fx.runtime, 'memoryRemember', { confirm: true, params: { teamId: fx.teamId } }, depsFor(fx.dir)),
      'INVALID_PAYLOAD',
    )
    expectCode(
      () =>
        applyDirectPanelWrite(
          fx.runtime,
          'memoryRemember',
          { confirm: true, params: { teamId: fx.teamId, text: 'x' } },
          {},
        ),
      'INTERNAL',
    )
    assert.equal(readMemoryStore(fx.dir, {}).exists, false, '被拒绝的写不能创建库')
  } finally {
    fx.dispose()
  }
})

test('记忆写不能用确认令牌通道（它没有 HumanAction 动作位）', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-memory-' })
  try {
    assert.throws(() => applyDirectPanelWrite(fx.runtime, 'memoryForget', { confirm: false, params: {} }, depsFor(fx.dir)))
  } finally {
    fx.dispose()
  }
})