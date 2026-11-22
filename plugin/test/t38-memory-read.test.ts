/**
 * t38：记忆库只读视图。
 *
 * 断言口径：**「没有记忆」与「库坏了」必须分开**——文件不存在是 `exists:false`，
 * 表缺失/打不开是 `exists:true + warnings`。合并两者会让界面在库损坏时显示
 * 「暂无记忆」，那是在撒谎。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SqliteMemoryStore } from '../src/infrastructure/memory-store/sqlite-memory.ts'
import { readMemoryStore } from '../src/infrastructure/memory-store/read.ts'

function seedDb(dir: string): void {
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const store = new SqliteMemoryStore(join(dir, 'memory', 'memory.db'))
  store.remember({ id: 'm1', bankId: 'team_a', text: '甲队第一条', tags: ['x'], evidence: [], now: '2026-01-01T00:00:00.000Z' })
  store.remember({ id: 'm2', bankId: 'team_a', text: '甲队第二条', now: '2026-01-02T00:00:00.000Z' })
  store.remember({ id: 'm3', bankId: 'member_m', text: '成员记忆', now: '2026-01-03T00:00:00.000Z' })
  store.forget({ bankId: 'team_a', id: 'm2', reason: '过期', hard: false, now: '2026-01-04T00:00:00.000Z' })
  store.close()
}

test('记忆视图：bank 汇总区分在用/总数，条目新→旧，遗忘的仍可读但带标记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-mem-'))
  try {
    seedDb(dir)
    const view = readMemoryStore(dir)
    assert.equal(view.exists, true)
    assert.equal(view.file, 'memory/memory.db')
    assert.deepEqual(view.warnings, [])

    const teamA = view.banks.find((bank) => bank.bankId === 'team_a')!
    assert.equal(teamA.live, 1, '遗忘的不算在用')
    assert.equal(teamA.total, 2, '总数仍含遗忘的')
    assert.equal(view.banks.find((bank) => bank.bankId === 'member_m')!.live, 1)

    assert.equal(view.entries[0]!.id, 'm3', '按 updatedAt 新→旧')
    const forgotten = view.entries.find((entry) => entry.id === 'm2')!
    assert.equal(forgotten.forgotten, true)
    assert.deepEqual(view.entries.find((entry) => entry.id === 'm1')!.tags, ['x'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('记忆视图：bankId 过滤与 limit 边界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-mem-'))
  try {
    seedDb(dir)
    const onlyA = readMemoryStore(dir, { bankId: 'team_a', limit: 10 })
    assert.equal(onlyA.entries.length, 2)
    assert.ok(onlyA.entries.every((entry) => entry.bankId === 'team_a'))

    const limited = readMemoryStore(dir, { limit: 1 })
    assert.equal(limited.entries.length, 1)

    // limit=0 不报错，按默认值处理（面板是全量视图，不该因一个越界参数整页失败）
    assert.equal(readMemoryStore(dir, { limit: 0 }).entries.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('记忆视图：库不存在是 exists:false，不冒充「空记忆」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-mem-'))
  try {
    const view = readMemoryStore(dir)
    assert.equal(view.exists, false)
    assert.deepEqual(view.entries, [])
    assert.deepEqual(view.banks, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('记忆视图：库文件存在但不是记忆库 → exists:true + warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-mem-'))
  try {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    const db = new DatabaseSync(join(dir, 'memory', 'memory.db'))
    db.exec('CREATE TABLE not_memory (id TEXT)')
    db.close()

    const view = readMemoryStore(dir)
    assert.equal(view.exists, true)
    assert.equal(view.warnings.length, 1)
    assert.match(view.warnings[0]!, /memory_entries/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})