import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWorkplaceDirs, ensureGitignoreManagedBlock, WORKPLACE_DIRS } from '../src/host.js'
import { STORE_DIR, STORE_GITIGNORE, storeLayout } from '../src/core/workspace/layout.ts'

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'myteam-t1-'))
}

test('T1: ensureWorkplaceDirs creates every partition under .dsh-myteam/ idempotently (CHG-102)', () => {
  const ws = tempWorkspace()
  const first = ensureWorkplaceDirs(ws)
  assert.ok(first.created.length > 0)
  assert.equal(first.root, join(ws, STORE_DIR))
  // CHG-102：分区必须挂在 `<project>/.dsh-myteam/` 下（项目级唯一落盘根）
  for (const dir of Object.values(WORKPLACE_DIRS)) {
    const expected = dir === WORKPLACE_DIRS.root ? join(ws, STORE_DIR) : join(ws, STORE_DIR, dir)
    assert.ok(existsSync(expected), `missing ${dir} at ${expected}`)
  }
  // 反向断言：不允许在工作区根目录下留下 config/ state/ archive/ export/ 四个污染目录
  for (const dir of Object.values(WORKPLACE_DIRS)) {
    if (dir === WORKPLACE_DIRS.root) continue
    assert.ok(!existsSync(join(ws, dir)), `partition ${dir} must not be created at workspace root`)
  }
  assert.ok(existsSync(join(ws, STORE_DIR, 'structure.md')), 'structure.md seeded')
  assert.ok(existsSync(join(ws, STORE_DIR, 'manifest.json')), 'manifest.json seeded')
  assert.ok(existsSync(join(ws, STORE_DIR, 'README.md')), 'README.md seeded')
  // 幂等：第二次调用不再新建
  const second = ensureWorkplaceDirs(ws)
  assert.equal(second.created.length, 0)
})

test('T1: .gitignore lives INSIDE the store and separates uploadable from runtime (CHG-102)', () => {
  const ws = tempWorkspace()
  // 用户项目根的 .gitignore 不被插件污染
  writeFileSync(join(ws, '.gitignore'), 'node_modules/\n', 'utf8')
  ensureGitignoreManagedBlock(ws)
  const projectGitignore = readFileSync(join(ws, '.gitignore'), 'utf8')
  assert.equal(projectGitignore, 'node_modules/\n', 'project-root .gitignore must stay untouched')

  const storeGitignore = readFileSync(join(ws, STORE_DIR, '.gitignore'), 'utf8')
  assert.ok(storeGitignore.includes('# >>> dsh-plugin-myteam managed block >>>'))
  // 不能上传：运行时状态 / 历史流水 / 导出
  assert.ok(storeGitignore.includes('state/'))
  assert.ok(storeGitignore.includes('history/'))
  assert.ok(storeGitignore.includes('export/'))
  // 能上传：配置资产与任务账本必须在忽略规则之外
  assert.ok(!/^config\/$/m.test(storeGitignore), 'config/ stays committable')
  assert.ok(!/^tasks\/$/m.test(storeGitignore), 'tasks/ stays committable')
  // 幂等：重复调用不改写内容
  const before = readFileSync(join(ws, STORE_DIR, '.gitignore'), 'utf8')
  ensureGitignoreManagedBlock(ws)
  assert.equal(readFileSync(join(ws, STORE_DIR, '.gitignore'), 'utf8'), before)
})

test('T1: store .gitignore is self-contained when the project has none', () => {
  const ws = tempWorkspace()
  ensureGitignoreManagedBlock(ws)
  assert.ok(!existsSync(join(ws, '.gitignore')), 'no project-root .gitignore is created')
  const content = readFileSync(join(ws, STORE_DIR, '.gitignore'), 'utf8')
  assert.equal(content, STORE_GITIGNORE)
})

test('T1: legacy .team-workplace is migrated into .dsh-myteam (CHG-102)', () => {
  const ws = tempWorkspace()
  const legacy = join(ws, '.team-workplace')
  ensureLegacyFixture(legacy)
  const result = ensureWorkplaceDirs(ws)
  assert.ok(!existsSync(legacy), 'legacy dir renamed away')
  // 旧 presets 目录对齐到新 teams 目录
  assert.ok(existsSync(join(ws, STORE_DIR, 'config', 'teams', 'trio.json')))
  void result
})

/** 最小旧布局夹具（config/presets + state/teams） */
function ensureLegacyFixture(legacy) {
  mkdirSync(join(legacy, 'config', 'presets'), { recursive: true })
  mkdirSync(join(legacy, 'state', 'teams'), { recursive: true })
  writeFileSync(join(legacy, 'config', 'presets', 'trio.json'), '{"id":"trio","name":"三人组","members":[{"roleId":"developer"}]}\n', 'utf8')
}

test('T1: resolveProjectRoot never accepts a DSH profile dir (CHG-102 P0)', async () => {
  const { resolveProjectRoot } = await import('../src/core/workspace/layout.ts')
  const ws = tempWorkspace()
  const profile = join(tmpdir(), '.dsh-fixture', 'profiles', 'desktop')
  const res = resolveProjectRoot(
    { sessionCwd: ws, workspaceRoot: profile },
    { DSH_HOME: join(tmpdir(), '.dsh-fixture') },
  )
  assert.equal(res.source, 'session')
  assert.equal(res.root, ws)
  // 没有会话 cwd 时，profile 候选被拒并回退（不能把项目级内容写进 ~/.dsh）
  const fallback = resolveProjectRoot(
    { workspaceRoot: profile, cwd: ws },
    { DSH_HOME: join(tmpdir(), '.dsh-fixture') },
  )
  assert.equal(fallback.root, ws)
  assert.ok(fallback.rejected.some((item) => item.source === 'workspace'))
})

test('T1: storeLayout exposes the six top-level sections', () => {
  const layout = storeLayout(tempWorkspace())
  assert.ok(layout.root.endsWith(STORE_DIR))
  assert.ok(layout.config.endsWith(join(STORE_DIR, 'config')))
  assert.ok(layout.roles.endsWith(join('config', 'roles')))
  assert.ok(layout.teams.endsWith(join('config', 'teams')))
  assert.ok(layout.skills.endsWith(join('config', 'skills')))
  assert.ok(layout.tools.endsWith(join('config', 'tools')))
  assert.ok(layout.tasks.endsWith(join(STORE_DIR, 'tasks')))
  assert.ok(layout.history.endsWith(join(STORE_DIR, 'history')))
  assert.ok(layout.archive.endsWith(join('history', 'archive')))
  assert.ok(layout.gitignore.endsWith(join(STORE_DIR, '.gitignore')))
})
