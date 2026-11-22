/**
 * t37：全局库只读读取器（`$DSH_HOME/myteam`）。
 *
 * 三条纪律：
 *   1. 目录不存在不是错误（新机器就是没有全局库），返回 `exists: false`；
 *   2. 读不懂的文件进 `warnings`，**不静默丢**——否则界面会显示「0 个角色」而
 *      真实原因是文件坏了；
 *   3. 审计只读操作日志，坏行跳过并记账，不让一行坏数据打空整页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { globalLibraryRoot, readGlobalAudit, readGlobalLibrary } from '../src/infrastructure/global-library/library.ts'

function seedLibrary(root: string): void {
  mkdirSync(join(root, 'roles'), { recursive: true })
  mkdirSync(join(root, 'workflows'), { recursive: true })
  mkdirSync(join(root, 'blueprints'), { recursive: true })
  mkdirSync(join(root, 'teams'), { recursive: true })
  mkdirSync(join(root, 'audit'), { recursive: true })
  writeFileSync(join(root, 'roles', 'reviewer.json'), JSON.stringify({ id: 'reviewer', revision: 3, profile: { name: '审查者' } }))
  writeFileSync(join(root, 'workflows', 'ship.json'), JSON.stringify({ id: 'ship', name: '上线流程', revision: 1 }))
  writeFileSync(join(root, 'blueprints', 'web.json'), JSON.stringify({ id: 'web', name: 'Web 团队' }))
  writeFileSync(join(root, 'teams', 'legacy.json'), JSON.stringify({ id: 'legacy', name: '旧发布团队' }))
  writeFileSync(join(root, 'roles', 'broken.json'), '{ not json')
  writeFileSync(
    join(root, 'audit', 'global-operations.jsonl'),
    [
      JSON.stringify({ at: '2026-01-01T00:00:00.000Z', operationId: 'op_1', action: 'publish', target: 'roles/reviewer.json', status: 'ok' }),
      JSON.stringify({ at: '2026-01-02T00:00:00.000Z', operationId: 'op_2', action: 'publish', target: 'workflows/ship.json', status: 'ok' }),
      'not json',
    ].join('\n'),
  )
}

test('全局库：按目录读定义，坏文件进 warnings，v1 teams 标 legacy', () => {
  const home = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  const root = join(home, '.dsh', 'myteam')
  try {
    mkdirSync(join(home, '.dsh'), { recursive: true })
    seedLibrary(root)

    const view = readGlobalLibrary(root)
    assert.equal(view.exists, true)
    assert.deepEqual(view.counts, { role: 1, workflow: 1, blueprint: 1, team: 1 })
    assert.equal(view.warnings.length, 1, '坏 JSON 必须留一条 warning')
    assert.match(view.warnings[0]!.file, /roles\/broken\.json/)

    const reviewer = view.entries.find((entry) => entry.id === 'reviewer')!
    assert.equal(reviewer.name, '审查者', '角色名从 profile.name 取')
    assert.equal(reviewer.revision, 3)
    const legacy = view.entries.find((entry) => entry.id === 'legacy')!
    assert.equal(legacy.legacy, true, 'v1 teams 要标 legacy')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局库：目录不存在时 exists=false，不抛错', () => {
  const home = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const view = readGlobalLibrary(join(home, 'nope'))
    assert.equal(view.exists, false)
    assert.deepEqual(view.entries, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局审计：新→旧、坏行跳过、truncated 反映还有更早的', () => {
  const home = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  const root = join(home, '.dsh', 'myteam')
  try {
    mkdirSync(join(home, '.dsh'), { recursive: true })
    seedLibrary(root)

    const view = readGlobalAudit(root, 1)
    assert.equal(view.exists, true)
    assert.equal(view.items.length, 1)
    assert.equal(view.items[0]!.operationId, 'op_2', '最新的一条在前')
    assert.equal(view.truncated, true, '还有更早的要标出来')

    const all = readGlobalAudit(root, 50)
    assert.equal(all.items.length, 2, '坏行被跳过，好行都保留')
    assert.equal(all.truncated, false)
    assert.ok(all.warnings.length >= 1, '坏行要记 warning')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局库根：DSH_HOME 优先，缺省回落 ~/.dsh', () => {
  assert.equal(globalLibraryRoot({ DSH_HOME: '/tmp/x' }, '/home/u'), join('/tmp/x', 'myteam'))
  assert.equal(globalLibraryRoot({}, '/home/u'), join('/home/u', '.dsh', 'myteam'))
  assert.equal(globalLibraryRoot({ DSH_HOME: '   ' }, '/home/u'), join('/home/u', '.dsh', 'myteam'))
})