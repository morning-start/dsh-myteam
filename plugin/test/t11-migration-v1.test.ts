import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeV1Project, planV1Import } from '../src/infrastructure/migration/v1/analyze.ts'

interface Fixture {
  root: string
  manifest?: Record<string, unknown> | null
  index?: Record<string, unknown> | null
  ledgers?: Record<string, string>
  taskLedgers?: Record<string, string>
  workplaceLedgers?: Record<string, string>
}

function build(fixture: Fixture): void {
  const workspace = join(fixture.root, '.dsh-myteam')
  mkdirSync(join(workspace, 'state', 'teams'), { recursive: true })
  if (fixture.manifest !== null) {
    writeFileSync(
      join(workspace, 'manifest.json'),
      JSON.stringify(fixture.manifest ?? { schemaVersion: 1, layoutVersion: 1, projectName: 'demo' }),
    )
  }
  if (fixture.index !== null) {
    writeFileSync(
      join(workspace, 'state', 'teams.json'),
      JSON.stringify(fixture.index ?? { version: 1, teams: [] }),
    )
  }
  for (const [teamId, text] of Object.entries(fixture.ledgers ?? {})) {
    const dir = join(workspace, 'state', 'teams', teamId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.jsonl'), text)
  }
  for (const [teamId, text] of Object.entries(fixture.taskLedgers ?? {})) {
    const dir = join(workspace, 'tasks', teamId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.jsonl'), text)
  }
  for (const [teamId, text] of Object.entries(fixture.workplaceLedgers ?? {})) {
    const dir = join(fixture.root, '.team-workplace', teamId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.jsonl'), text)
  }
}

function line(seq: number, ts: number, type: string, payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ seq, ts, actor: 'host', type, payload })}\n`
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'myteam-v1-'))
}

const TEAM_CREATED = line(0, 1000, 'rules.version.adopted', { version: 1 })

test('v1 分析：可导入时给出事件计数与来源 hash', () => {
  const root = temp()
  try {
    build({
      root,
      index: {
        version: 1,
        teams: [{ teamId: 'A', name: '甲队', goal: 'g', state: 'active', counts: { tasks: 1 } }],
      },
      ledgers: {
        A: TEAM_CREATED + line(1, 2000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }),
      },
      taskLedgers: {
        A: line(0, 3000, 'task.created', { taskId: 't1', teamId: 'A', title: '做', description: '', acceptance: ['x'] }),
      },
    })

    const analysis = analyzeV1Project(root)
    assert.equal(analysis.readyToImport, true)
    assert.equal(analysis.manifest?.layoutVersion, 1)
    assert.equal(analysis.sources.length, 2)
    assert.equal(analysis.eventsByType['team.created'], 1)
    assert.equal(analysis.eventsByType['task.created'], 1)
    assert.ok(analysis.sources.every((source) => source.sourceHash.startsWith('sha256:')))
    assert.equal(analysis.indexOnly.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v1 分析：索引孤儿只报告，不创建团队', () => {
  const root = temp()
  try {
    build({
      root,
      index: {
        version: 1,
        teams: [
          { teamId: 'A', name: '有账本', state: 'active', counts: { tasks: 0 } },
          { teamId: 'ghost', name: '没账本', state: 'active', counts: { tasks: 1 } },
        ],
      },
      ledgers: { A: TEAM_CREATED },
    })

    const analysis = analyzeV1Project(root)
    assert.equal(analysis.readyToImport, true)
    assert.deepEqual(analysis.indexOnly.map((team) => team.teamId), ['ghost'])
    assert.ok(analysis.issues.some((issue) => issue.code === 'INDEX_ORPHAN' && issue.severity === 'warning'))
    assert.equal(analysis.requiresUserConfirmation, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v1 分析：未知事件与序号断裂都阻断', () => {
  const root = temp()
  try {
    build({
      root,
      ledgers: {
        A: TEAM_CREATED + line(1, 2000, 'something.unknown', {}) + line(3, 3000, 'team.updated', { teamId: 'A' }),
      },
    })
    const analysis = analyzeV1Project(root)
    assert.equal(analysis.readyToImport, false)
    assert.ok(analysis.issues.some((issue) => issue.code === 'UNKNOWN_EVENT' && issue.severity === 'blocking'))
    assert.ok(analysis.issues.some((issue) => issue.code === 'SEQ_GAP' && issue.severity === 'blocking'))
    assert.throws(() => planV1Import(analysis), /阻断/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v1 分析：重复规则事件只告警', () => {
  const root = temp()
  try {
    build({
      root,
      ledgers: {
        A: TEAM_CREATED + line(1, 2000, 'rules.version.adopted', { version: 1 }),
      },
    })
    const analysis = analyzeV1Project(root)
    assert.equal(analysis.readyToImport, true)
    assert.ok(analysis.issues.some((issue) => issue.code === 'DUPLICATE_RULES' && issue.severity === 'warning'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v1 导入计划：多团队按 (ts, teamId, seq) 合成顺序并标记', () => {
  const root = temp()
  try {
    build({
      root,
      ledgers: {
        A: line(0, 2000, 'team.created', { teamId: 'A' }),
        B: line(0, 1000, 'team.created', { teamId: 'B' }) + line(1, 3000, 'team.updated', { teamId: 'B' }),
      },
    })
    const analysis = analyzeV1Project(root)
    assert.equal(analysis.readyToImport, true)

    const plan = planV1Import(analysis)
    assert.equal(plan.syntheticOrder, true)
    assert.deepEqual(plan.events.map((item) => `${item.teamId}:${item.event.ts}`), ['B:1000', 'A:2000', 'B:3000'])
    assert.ok(plan.events.every((item) => item.legacyOrigin.syntheticOrder === true))
    assert.ok(plan.events.every((item) => item.legacyOrigin.unknownConfigRevision === true))
    assert.deepEqual(plan.events.map((item) => item.order), [0, 1, 2])
    assert.equal(plan.sourceHashes.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v1 分析：.team-workplace 旧布局也能发现', () => {
  const root = temp()
  try {
    build({ root, workplaceLedgers: { C: line(0, 1000, 'team.created', { teamId: 'C' }) } })
    const analysis = analyzeV1Project(root)
    assert.equal(analysis.sources.length, 1)
    assert.equal(analysis.sources[0]!.kind, 'team-workplace')
    assert.equal(analysis.ledgerOnly[0]!.teamId, 'C')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})