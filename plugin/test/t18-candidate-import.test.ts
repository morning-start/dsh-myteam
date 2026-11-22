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

test('候选导入：缺正文的知识提案阻断而不是猜测', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }) +
        line(1, 2000, 'knowledge.proposed', { teamId: 'A', draftId: 'd1', draft: { title: 'k', evidence: 'task:t1' } }),
    )
    const { conversion } = convert(source)
    assert.equal(conversion.ok, false)
    assert.ok(conversion.issues.some((issue) => issue.code === 'MISSING_FIELD' && issue.severity === 'blocking'))
    assert.ok(conversion.disposition.some((item) => item.type === 'knowledge.proposed' && item.outcome === 'blocked'))

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

test('候选导入：任务按终态折叠，依赖重映射，在途执行回落 ready', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-candidate-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }) +
        line(1, 2000, 'task.created', {
          teamId: 'A',
          taskId: 't1',
          task: {
            title: '设计',
            description: '',
            acceptanceCriteria: ['有结论'],
            deps: [],
            requiredRole: null,
            priority: 'P2',
          },
        }) +
        line(2, 3000, 'task.claimed', { teamId: 'A', taskId: 't1', memberId: 'm1', attemptId: 'a1' }) +
        line(3, 4000, 'task.completed', { teamId: 'A', taskId: 't1', attemptId: 'a1' }) +
        line(4, 5000, 'task.created', {
          teamId: 'A',
          taskId: 't2',
          task: {
            title: '实现',
            description: '',
            acceptanceCriteria: ['通过测试'],
            deps: ['t1'],
            requiredRole: null,
            priority: 'P2',
            deliverableSpec: { path: 'src/a.ts' },
            verifyCommand: { argv: ['npm', 'test'] },
          },
        }),
      [{ teamId: 'A', name: '甲队', state: 'active', counts: { tasks: 2 } }],
    )

    const { conversion } = convert(source)
    assert.equal(conversion.ok, true, JSON.stringify(conversion.issues))
    assert.equal(conversion.counts.tasks, 2)
    assert.equal(conversion.records.length, 3, 'team + 2 tasks')

    const written = writeCandidateProject(conversion, {
      candidateRoot: candidate,
      projectId: newId('project'),
      projectName: 'demo-migrated',
      now: NOW,
      ids: newId,
      clock: { now: () => NOW },
    })
    assert.equal(written.verification.ok, true, written.verification.problems.join('; '))
    assert.equal(written.verification.tasks, 2)

    const rebuilt = (() => {
      const store = new FileEventStore(join(candidate, EVENTS_FILE))
      return store.readCommitted().events
    })()
    const taskEvents = rebuilt.filter((event) => event.type === 'task.created')
    const first = taskEvents[0]!.payload as { task: { status: string; completedAt: string | null } }
    assert.equal(first.task.status, 'done')
    assert.equal(first.task.completedAt, new Date(4000).toISOString())

    const second = (taskEvents[1]!.payload as { task: { dependencies: string[]; gate: { commands: string[] }; deliverable: { paths: string[] } | null } }).task
    assert.equal(second.dependencies.length, 1)
    assert.deepEqual(second.gate.commands, ['npm test'])
    assert.deepEqual(second.deliverable!.paths, ['src/a.ts'])

    // claimed/progress/completed 里的执行细节没有逐条重放，但被明确计数。
    assert.ok(conversion.skipped.some((item) => item.type === 'task.claimed' && item.count === 1))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})

test('候选导入：知识保留提案→采纳链，驳回的不迁移', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-convert-'))
  const candidate = mkdtempSync(join(tmpdir(), 'myteam-candidate-'))
  try {
    buildSource(
      source,
      line(0, 1000, 'team.created', { teamId: 'A', name: '甲队', goal: 'g' }) +
        line(1, 2000, 'knowledge.proposed', {
          teamId: 'A',
          draftId: 'd1',
          draft: { id: 'd1', title: '限流', tags: [], body: '要限流', evidence: 'task:t1' },
        }) +
        line(2, 3000, 'knowledge.adopted', { teamId: 'A', draftId: 'd1', decision: 'adopted' }) +
        line(3, 4000, 'knowledge.proposed', {
          teamId: 'A',
          draftId: 'd2',
          draft: { id: 'd2', title: '旧结论', tags: [], body: '过时', evidence: 'file:docs/x.md' },
        }) +
        line(4, 5000, 'knowledge.adopted', { teamId: 'A', draftId: 'd2', decision: 'rejected' }),
    )

    const { conversion } = convert(source)
    assert.equal(conversion.ok, true, JSON.stringify(conversion.issues))
    assert.equal(conversion.counts.knowledge, 1, '被驳回的提案不迁移')
    assert.equal(conversion.records.filter((record) => record.type === 'knowledge.proposed').length, 1)
    assert.equal(conversion.records.filter((record) => record.type === 'knowledge.adopted').length, 1)

    const written = writeCandidateProject(conversion, {
      candidateRoot: candidate,
      projectId: newId('project'),
      projectName: 'kb',
      now: NOW,
      ids: newId,
      clock: { now: () => NOW },
    })
    assert.equal(written.verification.ok, true, written.verification.problems.join('; '))
    assert.equal(written.verification.knowledge, 1)

    const events = new FileEventStore(join(candidate, EVENTS_FILE)).readCommitted().events
    const entries = events.filter((event) => event.type === 'knowledge.proposed')
    const entry = (entries[0]!.payload as { entry: { title: string; status: string; evidence: { kind: string; ref: string }[] } }).entry
    assert.equal(entry.title, '限流')
    assert.equal(entry.status, 'proposed')
    assert.deepEqual(entry.evidence, [{ kind: 'artifact', ref: 'task:t1' }])
    assert.ok(events.some((event) => event.type === 'knowledge.adopted'))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
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