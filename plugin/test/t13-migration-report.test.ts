import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeV1Project, planV1Import } from '../src/infrastructure/migration/v1/analyze.ts'
import { buildMigrationReport } from '../src/infrastructure/migration/v1/report.ts'

function line(seq: number, ts: number, type: string, payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ seq, ts, actor: 'host', type, payload })}\n`
}

function build(root: string, options: { teams?: unknown[]; ledgers?: Record<string, string> }): void {
  const workspace = join(root, '.dsh-myteam')
  mkdirSync(join(workspace, 'state', 'teams'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), JSON.stringify({ schemaVersion: 1, layoutVersion: 1, projectName: 'demo' }))
  writeFileSync(join(workspace, 'state', 'teams.json'), JSON.stringify({ version: 1, teams: options.teams ?? [] }))
  for (const [teamId, text] of Object.entries(options.ledgers ?? {})) {
    const dir = join(workspace, 'state', 'teams', teamId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.jsonl'), text)
  }
}

test('报告：可导入时列出来源、计数与确认项', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-report-'))
  try {
    build(root, {
      teams: [
        { teamId: 'A', name: '甲队', state: 'active', counts: { tasks: 1 } },
        { teamId: 'ghost', name: '', state: 'active', counts: { tasks: 2 } },
      ],
      ledgers: { A: line(0, 1000, 'team.created', { teamId: 'A' }) + line(1, 2000, 'task.created', { taskId: 't1' }) },
    })
    const analysis = analyzeV1Project(root)
    const report = buildMigrationReport(analysis, planV1Import(analysis))

    assert.equal(report.verdict, 'ready')
    assert.match(report.markdown, /可进入候选导入/)
    assert.match(report.markdown, /索引孤儿/)
    assert.match(report.markdown, /ghost/)
    assert.match(report.markdown, /`task.created`/)
    assert.match(report.markdown, /需要你决定/)
    assert.ok(report.sections.some((section) => section.title === '来源'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('报告：阻断时不给导入顺序，只给阻断项', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-report-'))
  try {
    build(root, { ledgers: { A: line(0, 1000, 'task.created', {}) + line(2, 2000, 'task.created', {}) } })
    const analysis = analyzeV1Project(root)
    const report = buildMigrationReport(analysis)

    assert.equal(report.verdict, 'blocked')
    assert.match(report.markdown, /阻断/)
    assert.ok(report.sections.some((section) => section.title === '阻断项'))
    assert.ok(!report.sections.some((section) => section.title === '候选导入顺序'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('报告：没有旧数据时给出空来源而不是崩溃', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-report-'))
  try {
    const analysis = analyzeV1Project(root)
    const report = buildMigrationReport(analysis)
    assert.match(report.markdown, /没有发现旧账本/)
    assert.equal(report.verdict, 'blocked', '缺少 manifest 应阻断')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})