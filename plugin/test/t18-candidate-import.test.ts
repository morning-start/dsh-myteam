import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeV1Project, planV1Import } from '../src/infrastructure/migration/v1/analyze.ts'
import { convertV1Analysis, writeCandidateProject } from '../src/infrastructure/migration/v1/convert.ts'
import type { RoleDefinition } from '../src/contracts/entities.ts'
import { newId } from '../src/contracts/ids.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE } from '../src/contracts/versions.ts'

const NOW = '2026-01-01T00:00:00.000Z'

const ROLE: RoleDefinition = {
  id: 'role_legacy',
  revision: 1,
  profile: { name: '开发', purpose: '实现', instructions: '按 AC 做', specialties: [] },
  capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  createdAt: NOW,
  updatedAt: NOW,
}

function line(seq: number, ts: number, type: string, payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ seq, ts, actor: 'lead', type, payload })}\n`
}

function buildSource(root: string, ledger: string, teams: unknown[] = []): void {
  const workspace = join(root, '.dsh-myteam')
  mkdirSync(join(workspace, 'state', 'teams'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), JSON.stringify({ schemaVersion: 1, layoutVersion: 1, projectName: 'demo' }))
  writeFileSync(join(workspace, 'state', 'teams.json'), JSON.stringify({ version: 1, teams }))
  const dir = join(workspace, 'state', 'teams', 'A')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ledger.jsonl'), ledger)
}

function convert(root: string, resolveRole: (roleId: string) => RoleDefinition | undefined = () => undefined) {
  const analysis = analyzeV1Project(root)
  const plan = planV1Import(analysis)
  return {
    analysis,
    conversion: convertV1Analysis({ analysis, plan, now: NOW, ids: newId, resolveRole }),
  }
}

test('候选导入：团队 + 成员写进候选目录并对账通过', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-candidate-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }) +
        line(1, 2000, 'member.spawned', { teamId: 'A', memberId: 'm1', roleId: 'role_legacy', parentMemberId: null }),
      [{ teamId: 'A', name: '甲队', state: 'active', counts: { tasks: 0 } }],
    )

    const { conversion } = convert(source, (roleId) => (roleId === ROLE.id ? ROLE : undefined))
    assert.equal(conversion.ok, true, JSON.stringify(conversion.issues))
    assert.equal(conversion.records.length, 2)
    assert.equal(conversion.counts.teams, 1)
    assert.equal(conversion.counts.members, 1)
    assert.ok(conversion.records.every((record) => record.legacy.sourceLine !== undefined))

    const written = writeCandidateProject(conversion, {
      candidateRoot: candidate,
      projectId: newId('project'),
      projectName: 'demo-migrated',
      now: NOW,
      ids: newId,
      clock: { now: () => NOW },
    })

    assert.equal(written.verification.ok, true, written.verification.problems.join('; '))
    assert.equal(written.verification.teams, 1)
    assert.equal(written.verification.members, 1)
    // project.initialized + team.created + member.appointed
    assert.equal(written.written, 3)

    const store = new FileEventStore(join(candidate, EVENTS_FILE))
    const { events } = store.readCommitted()
    assert.equal(events[1]!.type, 'team.created')
    assert.equal((events[1]!.payload as { captain: unknown }).captain, null, '迁移团队不应带伪造队长')
    const legacy = events[1]!.legacy!
    assert.equal(legacy.syntheticOrder, false)
    assert.equal(legacy.unknownConfigRevision, true)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})

test('候选导入：不支持的事件阻断而不是跳过', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }) +
        line(1, 2000, 'task.created', { teamId: 'A', taskId: 't1', task: {} }),
    )
    const { conversion } = convert(source)
    assert.equal(conversion.ok, false)
    assert.ok(conversion.issues.some((issue) => issue.code === 'UNSUPPORTED_FOR_IMPORT' && issue.severity === 'blocking'))
    assert.ok(conversion.disposition.some((item) => item.type === 'task.created' && item.outcome === 'blocked'))

    const candidate = mkdtempSync(join(tmpdir(), 'myteam-candidate-'))
    try {
      assert.throws(
        () =>
          writeCandidateProject(conversion, {
            candidateRoot: candidate,
            projectId: newId('project'),
            projectName: 'x',
            now: NOW,
            ids: newId,
            clock: { now: () => NOW },
          }),
        (error: unknown) => error instanceof MyTeamError && error.code === 'MIGRATION_BLOCKED',
      )
    } finally {
      rmSync(candidate, { recursive: true, force: true })
    }
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})

test('候选导入：成员角色无法解析时阻断', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }) +
        line(1, 2000, 'member.spawned', { teamId: 'A', memberId: 'm1', roleId: 'role_ghost' }),
    )
    const { conversion } = convert(source)
    assert.equal(conversion.ok, false)
    assert.ok(conversion.issues.some((issue) => issue.code === 'MISSING_ROLE'))
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})

test('候选导入：只有规则事件时零业务记录，规则事件被跳过并计数', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-candidate-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'rules.version.adopted', { version: 1 }) + line(1, 2000, 'rules.version.adopted', { version: 1 }),
    )
    const { conversion } = convert(source)
    assert.equal(conversion.ok, true)
    assert.equal(conversion.records.length, 0)
    assert.deepEqual(conversion.skipped.map((item) => item.type), ['rules.version.adopted'])
    assert.equal(conversion.skipped[0]!.count, 2)

    const written = writeCandidateProject(conversion, {
      candidateRoot: candidate,
      projectId: newId('project'),
      projectName: 'empty',
      now: NOW,
      ids: newId,
      clock: { now: () => NOW },
    })
    assert.equal(written.verification.ok, true)
    assert.equal(written.written, 1, '只有 project.initialized')
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})