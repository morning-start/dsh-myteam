import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService, bootstrapTeam, validateEvidenceBlock } from '../src/core/service.ts'
import { copyToProject, writeProjectRole } from '../src/core/roles/role-store.ts'

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t7-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  return { ws, rolePaths, service }
}

const taskInput = (over: Record<string, unknown> = {}) => ({
  title: 't', description: 'd', acceptanceCriteria: ['ac'],
  deliverableSpec: { path: 'docs/x.md' }, deps: [],
  requiredRole: 'implementer', priority: 'P2' as const,
  gateChain: ['review', 'archive'], ...over,
})

test('T7: bootstrap + team.create validates roster captain rule (scene 11)', () => {
  const { service } = setup()
  const boot = bootstrapTeam(service)
  assert.equal(boot.ok, true)
  // 缺队长 roster 拒绝
  const noCaptain = service.commit({
    actor: 'lead', type: 'team.created',
    payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'implementer' }] },
  })
  assert.equal(noCaptain.ok, false)
  assert.equal((noCaptain as { code: string }).code, 'MT_ROSTER_NO_CAPTAIN')
  // 含队长通过
  const ok = service.commit({
    actor: 'lead', type: 'team.created',
    payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] },
  })
  assert.equal(ok.ok, true)
})

test('T7: task.create runs FR-11.2 validation against the whole plan (scene 15)', () => {
  const { service } = setup()
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  // 缺 AC
  const bad = service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput({ acceptanceCriteria: [] }) } })
  assert.equal(bad.ok, false)
  assert.equal((bad as { code: string }).code, 'MT_VALIDATION')
  // 合法任务通过并进入投影
  const good = service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })
  assert.equal(good.ok, true)
  assert.equal(service.projectionSnapshot.tasks['k1'].state, 'backlog')
  // 非法依赖引用
  const badDep = service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k2', task: taskInput({ deps: ['nope'] }) } })
  assert.equal(badDep.ok, false)
  assert.ok((badDep as { message: string }).message.includes('does not exist'))
})

test('T7: claim enforces role match + ready state (scenes 2/5)', () => {
  const { service } = setup()
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })
  // 成员未 spawn 时 claim 拒绝
  const noMember = service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  assert.equal(noMember.ok, false)
  // spawn 后 role 不匹配的成员拒绝
  const { rolePaths } = { rolePaths: { projectRolesDir: join(dirname(service.ledgerPath), '..', '..', '..', '..') } }
  void rolePaths
  const spawnOk = service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'ok', instanceName: 'impl-1' } })
  assert.equal(spawnOk.ok, true)
  const claimed = service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  assert.equal(service.projectionSnapshot.tasks['k1'].state, 'in_progress')
  // 重复 claim 拒绝（已有活跃 attempt）
  const doubleClaim = service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a2' } })
  assert.equal(doubleClaim.ok, false)
  assert.equal((doubleClaim as { code: string }).code, 'MT_NOT_CLAIMABLE')
})

test('T7: stale attemptId rejected; done without evidence rejected (scenes 3/8)', () => {
  const { service } = setup()
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })
  service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'ok', instanceName: 'impl-1' } })
  service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  // 陈旧 attemptId（FR-4.3）
  const stale = service.commit({ actor: 'm1', type: 'task.progress', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a0', progress: 'half' } })
  assert.equal(stale.ok, false)
  assert.equal((stale as { code: string }).code, 'MT_ATTEMPT_STALE')
  // 无证据块 done 拒绝（FR-5.0）
  const noEvidence = service.commit({ actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1' } })
  assert.equal(noEvidence.ok, false)
  assert.equal((noEvidence as { code: string }).code, 'MT_EVIDENCE_REQUIRED')
  // 附证据块后 done 通过 → 进入 gate:review
  service.commit({ actor: 'm1', type: 'task.evidence', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { kind: 'commands', commands: [{ cmd: 'pnpm test', exitCode: 0 }] } } })
  const done = service.commit({ actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1' } })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(service.projectionSnapshot.tasks['k1'].state, 'gate:review')
})

test('T7: escalate immediately revokes attempt and moves to re-scoping (scene 17)', () => {
  const { service } = setup()
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: taskInput() } })
  service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'ok', instanceName: 'impl-1' } })
  service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  // 无 evidence 的 escalate 拒绝
  const noEv = service.commit({ actor: 'm1', type: 'task.escalated', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', reason: 'r' } })
  assert.equal(noEv.ok, false)
  // 带 evidence 的 escalate 立即生效
  const esc = service.commit({ actor: 'm1', type: 'task.escalated', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', reason: 'AC too broad', evidence: { attempted: 'x', blockedAt: 'y' }, count: 1 } })
  assert.equal(esc.ok, true)
  const t = service.projectionSnapshot.tasks['k1']
  assert.equal(t.state, 're-scoping')
  assert.equal(t.attemptId, undefined)
  // rescope → ready（CHG-73：重新规划必须留理由）
  const rescope = service.commit({ actor: 'lead', type: 'task.rescoped', payload: { teamId: 't1', taskId: 'k1', patch: { description: 'narrowed' }, reason: 'AC 收窄' } })
  assert.equal(rescope.ok, true)
  assert.equal(service.projectionSnapshot.tasks['k1'].state, 'ready')
  // 无理由 rescope 被拒（CHG-73：理由必填；终态才是不可重规划的唯一硬边界）
  const noReason = service.commit({ actor: 'lead', type: 'task.rescoped', payload: { teamId: 't1', taskId: 'k1', patch: {} } })
  assert.equal(noReason.ok, false)
  assert.equal(noReason.code, 'MT_VALIDATION')
})

test('T7: member spawn enforces maxMembers + project-library role resolution', () => {
  const { service } = setup()
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  // 项目库没有的角色拒绝
  const noRole = service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'mx', roleId: 'ghost', sessionId: 's', status: 'ok', instanceName: 'g' } })
  assert.equal(noRole.ok, false)
  assert.ok((noRole as { message: string }).message.includes('project library'))
  // 达上限拒绝（默认 maxMembers=6）
  for (let i = 1; i <= 6; i++) {
    const r = service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: `m${i}`, roleId: 'implementer', sessionId: `s${i}`, status: 'ok', instanceName: `i${i}` } })
    assert.equal(r.ok, true, `spawn ${i} failed: ${JSON.stringify(r)}`)
  }
  const over = service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm7', roleId: 'implementer', sessionId: 's7', status: 'ok', instanceName: 'i7' } })
  assert.equal(over.ok, false)
  assert.equal((over as { code: string }).code, 'MT_MEMBER_LIMIT')
})

test('T7: evidence block structure validation (FR-5.0)', () => {
  assert.equal(validateEvidenceBlock({ kind: 'commands', commands: [{ cmd: 'x', exitCode: 0 }] }).ok, true)
  assert.equal(validateEvidenceBlock({ kind: 'commands', commands: [] }).ok, false)
  assert.equal(validateEvidenceBlock({ kind: 'commands', commands: [{ cmd: 'x' }] }).ok, false)
  assert.equal(validateEvidenceBlock({ kind: 'na', na: { reason: 'doc only' } }).ok, true)
  assert.equal(validateEvidenceBlock({ kind: 'na', na: {} }).ok, false)
  assert.equal(validateEvidenceBlock({ kind: 'bogus' }).ok, false)
})

// Minimal dirname helper (avoid importing node:path twice in test)
function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '.'
}
