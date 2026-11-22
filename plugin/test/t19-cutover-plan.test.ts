import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeV1Project, planV1Import } from '../src/infrastructure/migration/v1/analyze.ts'
import { convertV1Analysis, writeCandidateProject } from '../src/infrastructure/migration/v1/convert.ts'
import { inspectCandidate, planCutover } from '../src/infrastructure/migration/v1/cutover.ts'
import { newId } from '../src/contracts/ids.ts'
import { EVENTS_FILE } from '../src/contracts/versions.ts'

const NOW = '2026-01-01T00:00:00.000Z'

function line(seq: number, ts: number, type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ seq, ts, actor: 'lead', type, payload })}\n`
}

function buildSource(root: string, teams: unknown[]): void {
  const workspace = join(root, '.dsh-myteam')
  mkdirSync(join(workspace, 'state', 'teams', 'A'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), JSON.stringify({ schemaVersion: 1, layoutVersion: 1, projectName: 'demo' }))
  writeFileSync(join(workspace, 'state', 'teams.json'), JSON.stringify({ version: 1, teams }))
  writeFileSync(
    join(workspace, 'state', 'teams', 'A', 'ledger.jsonl'),
    line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }),
  )
}

function prepare(source: string, candidate: string) {
  const analysis = analyzeV1Project(source)
  const plan = planV1Import(analysis)
  const conversion = convertV1Analysis({ analysis, plan, now: NOW, ids: newId, resolveRole: () => undefined })
  assert.equal(conversion.ok, true, JSON.stringify(conversion.issues))
  const written = writeCandidateProject(conversion, {
    candidateRoot: candidate,
    projectId: newId('project'),
    projectName: 'demo-migrated',
    now: NOW,
    ids: newId,
    clock: { now: () => NOW },
  })
  return { analysis, written }
}

test('cutover：候选完整且源未变时可以切换', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-cut-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-cand-'))
  try {
    buildSource(source, [{ teamId: 'A', name: '甲队', state: 'active', counts: { tasks: 0 } }])
    const { analysis, written } = prepare(source, candidate)

    const inspection = inspectCandidate(candidate)
    assert.equal(inspection.ok, true, inspection.problems.join('; '))
    assert.equal(inspection.teams, 1)

    const plan = planCutover({ analysis, candidate: written, candidateInspection: inspection, sourceUnchanged: true })
    assert.equal(plan.ready, true, plan.blockers.join('; '))
    assert.equal(plan.steps.length, 6)
    assert.equal(plan.steps[0]!.id, 'stop-old-writer')
    assert.match(plan.rollback.afterBoundary, /不做自动反向回滚/)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})

test('cutover：分析后源发生变化则阻断', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-cut-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-cand-'))
  try {
    buildSource(source, [])
    const { analysis, written } = prepare(source, candidate)
    const inspection = inspectCandidate(candidate)
    const plan = planCutover({ analysis, candidate: written, candidateInspection: inspection, sourceUnchanged: false })
    assert.equal(plan.ready, false)
    assert.ok(plan.blockers.some((blocker) => blocker.includes('候选已过期')))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})

test('cutover：候选被删/损坏时从磁盘检查就能发现', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-cut-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-cand-'))
  try {
    buildSource(source, [])
    const { analysis, written } = prepare(source, candidate)
    rmSync(join(candidate, EVENTS_FILE), { force: true })

    const inspection = inspectCandidate(candidate)
    assert.equal(inspection.ok, false)
    const plan = planCutover({ analysis, candidate: written, candidateInspection: inspection, sourceUnchanged: true })
    assert.equal(plan.ready, false)
    assert.ok(plan.blockers.some((blocker) => blocker.includes('磁盘检查失败')))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})

test('cutover：索引孤儿进入待确认清单而不是被忽略', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-cut-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-cand-'))
  try {
    buildSource(source, [
      { teamId: 'A', name: '甲队', state: 'active', counts: { tasks: 0 } },
      { teamId: 'ghost', name: '', state: 'active', counts: { tasks: 1 } },
    ])
    const { analysis, written } = prepare(source, candidate)
    const inspection = inspectCandidate(candidate)
    const plan = planCutover({ analysis, candidate: written, candidateInspection: inspection, sourceUnchanged: true })
    assert.equal(plan.ready, true)
    assert.ok(plan.requiresConfirmation.some((item) => item.includes('INDEX_ORPHAN')))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})