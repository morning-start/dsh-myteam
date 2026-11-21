/**
 * T175 SQLite 成员记忆存储（CHG-212，ADR-010）。
 *
 * 重点覆盖四条不变量：
 *   ① evidence 必填（FR-6.2）——无证据写不进去；
 *   ② bank 隔离——A 队的坑不会被 B 队召回；
 *   ③ refine not overwrite——supersedes 归档旧条目而不是删除；
 *   ④ 重启后仍在——这是「子代理会话会被释放」前提下记忆还能跨会话的原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openMemoryStore,
  memoryDbPath,
  teamBankId,
  memberBankId,
  type MemoryStore,
} from '../src/core/memory/store.ts'
import { memoryBrief, RECALL_MAX_CHARS, RECALL_MAX_LINES } from '../src/core/memory/recall.ts'

function withStore(fn: (store: MemoryStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mt175-'))
  const store = openMemoryStore(join(dir, 'memory.db'))
  try {
    fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('t175a: memoryDbPath 落在 history/ 下（已 gitignore）', () => {
  const p = memoryDbPath('/ws')
  assert.ok(p.endsWith('memory.db'), p)
  assert.ok(p.replace(/\\/g, '/').endsWith('.dsh-myteam/history/memory.db'), p)
})

test('t175b: evidence 必填 + 重要性区间（FR-6.2）', () => {
  withStore((store) => {
    const bank = teamBankId('t1')
    assert.throws(() => store.remember({ bankId: bank, kind: 'fact', title: 'x', body: 'y', evidence: '', source: 'lead' }), /evidence/)
    assert.throws(() => store.remember({ bankId: bank, kind: 'fact', title: 'x', body: 'y', evidence: 'none', source: 'lead' }), /evidence/)
    assert.throws(
      () => store.remember({ bankId: bank, kind: 'fact', title: 'x', body: 'y', evidence: 't-1', importance: 9, source: 'lead' }),
      /importance/,
    )
    assert.equal(store.stats(bank).entries, 0)
  })
})

test('t175c: 写入后可按中文关键词召回，且 bank 隔离', () => {
  withStore((store) => {
    const t1 = teamBankId('t1')
    const t2 = teamBankId('t2')
    store.remember({
      bankId: t1, kind: 'pitfall', title: '登录接口必须先刷新 token',
      body: 'refresh 之后再取用户信息，否则 401。', evidence: 'task t-42', importance: 5, source: 'member:m1',
    })
    store.remember({
      bankId: t2, kind: 'pitfall', title: '另一个队的问题',
      body: '与本队无关。', evidence: 'task t-99', source: 'member:m2',
    })
    const hits = store.recall({ bankId: t1, query: '登录接口' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].title, '登录接口必须先刷新 token')
    assert.equal(hits[0].evidence, 'task t-42')
    assert.ok(hits[0].score > 0 && hits[0].score <= 1)
    // 隔离：t2 的条目不会出现在 t1 的召回里
    assert.equal(store.recall({ bankId: t1, query: '另一个队' }).length, 0)
  })
})

test('t175d: 短查询走 LIKE 回退（trigram 对 <3 字不命中）', () => {
  withStore((store) => {
    const bank = memberBankId('t1', 'm1')
    store.remember({ bankId: bank, kind: 'fact', title: '接口', body: '登录接口有三秒超时。', evidence: 'src/a.ts:12', source: 'member:m1' })
    // 「接口」只有 2 个字：FTS trigram 不命中，LIKE 必须兜住
    assert.equal(store.recall({ bankId: bank, query: '接口' }).length, 1)
    // 3 字以上走 FTS
    assert.equal(store.recall({ bankId: bank, query: '登录接口' }).length, 1)
  })
})

test('t175e: refine not overwrite——supersedes 归档旧条目，历史仍可读', () => {
  withStore((store) => {
    const bank = teamBankId('t1')
    const old = store.remember({
      bankId: bank, kind: 'decision', title: '门禁默认 2 轮打回',
      body: '超限转人工。', evidence: 'ledger seq 7', source: 'lead',
    })
    const next = store.remember({
      bankId: bank, kind: 'decision', title: '门禁默认 3 轮打回',
      body: '超限转人工（口径调整）。', evidence: 'ledger seq 21', source: 'lead', supersedes: old.id,
    })
    assert.equal(next.supersedes, old.id)
    const hits = store.recall({ bankId: bank, query: '门禁默认' })
    assert.equal(hits.length, 1, '召回只看活条目')
    assert.equal(hits[0].id, next.id)
    assert.ok(store.get(old.id)?.archivedAt !== undefined, '旧条目被归档而非删除')
    // 再次 supersede 已归档的条目要报错（防止链断）
    assert.throws(
      () => store.remember({ bankId: bank, kind: 'decision', title: 'x', body: 'y', evidence: 'seq 22', source: 'lead', supersedes: old.id }),
      /not a live entry/,
    )
  })
})

test('t175f: forget 软删 + stats 计数 + 重开仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt175-'))
  const dbPath = join(dir, 'memory.db')
  const bank = teamBankId('t1')
  try {
    const store = openMemoryStore(dbPath)
    const a = store.remember({ bankId: bank, kind: 'fact', title: 'A', body: 'aa', evidence: 'seq 1', source: 'lead' })
    store.remember({ bankId: bank, kind: 'convention', title: 'B', body: 'bb', evidence: 'seq 2', source: 'lead' })
    assert.deepEqual(store.stats(bank).kinds, { fact: 1, convention: 1 })
    assert.equal(store.forget(a.id), true)
    assert.equal(store.forget(a.id), false, '重复归档不算命中')
    assert.deepEqual(store.stats(bank).kinds, { convention: 1 })
    store.close()

    assert.ok(existsSync(dbPath))
    const reopened = openMemoryStore(dbPath)
    try {
      assert.equal(reopened.stats(bank).entries, 1, '重开后条目仍在（子代理会话释放不影响记忆）')
      assert.equal(reopened.recall({ bankId: bank, query: 'B' }).length, 1)
      assert.equal(reopened.recall({ bankId: bank, query: 'aa' }).length, 0, '归档条目不再召回')
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t175g: memoryBrief 上岗召回——私有 bank 优先、带出处、受行数预算约束', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt175g-'))
  try {
    const store = openMemoryStore(memoryDbPath(root))
    store.remember({
      bankId: memberBankId('t1', 'm1'),
      kind: 'pitfall', title: '私有坑：先刷新 token',
      body: '调用登录接口前必须 refresh。', evidence: 'task t-1', importance: 5, source: 'member:m1',
    })
    store.remember({
      bankId: teamBankId('t1'),
      kind: 'convention', title: '团队口径：提交前跑门禁',
      body: 'pnpm test + check-all。', evidence: 'docs/26 §3', importance: 4, source: 'lead',
    })
    for (let i = 0; i < 20; i += 1) {
      store.remember({
        bankId: teamBankId('t1'), kind: 'fact', title: `批量条目 ${i}`,
        body: 'x'.repeat(200), evidence: `seq ${i}`, source: 'lead',
      })
    }
    store.close()

    const brief = memoryBrief(root, 't1', 'm1', { limit: 8 })
    assert.ok(brief.count > 0 && brief.count <= RECALL_MAX_LINES, `count=${brief.count}`)
    assert.ok(brief.text.length <= RECALL_MAX_CHARS, `chars=${brief.text.length}`)
    assert.match(brief.text, /上岗召回/)
    assert.match(brief.text, /evidence: task t-1/, '私有记忆必须带出处')
    assert.match(brief.text, /myteam_recall/, '要给成员后续检索的出口')

    // 空仓不产出（避免给成员一段空标题）
    const empty = memoryBrief(root, 't2', 'm9')
    assert.equal(empty.count, 0)
    assert.equal(empty.text, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
