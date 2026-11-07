/**
 * T40（CHG-59）：增量提交（ADR-002 R2 决策 B 实装）。
 *
 * 断言三件事：
 *   ① 增量 apply 与全量重放结果逐字段一致（同一份账本，两条路径同一投影）；
 *   ② 折返失败不落账本、不动投影（旧实现 append 后全量 fold，失败会留下不可重放的脏事件）；
 *   ③ 冷启动重放与增量结果一致，revision 严格等于已应用事件数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService, bootstrapTeam } from '../src/core/service.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'
import { openLedger } from '../src/core/ledger/ledger.ts'
import { foldEvents } from '../src/core/scheduler/fold.ts'

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t40-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  return { ws, rolePaths, service }
}

const task = (over: Record<string, unknown> = {}) => ({
  title: 't', description: 'd', acceptanceCriteria: ['ac'],
  deliverableSpec: { path: 'docs/x.md' }, deps: [],
  requiredRole: 'implementer', priority: 'P2' as const,
  gateChain: ['review', 'archive'], ...over,
})

/** 一条覆盖团队/成员/任务/门禁/依赖解锁的完整事件流；返回每步期望的累计事件数 */
function scriptedFlow(svc: TeamService): number[] {
  const counts: number[] = []
  const step = (draft: Parameters<TeamService['commit']>[0]) => {
    const r = svc.commit(draft)
    assert.equal(r.ok, true, `${draft.type} should commit: ${JSON.stringify(r)}`)
    counts.push(counts.length + 1)
    return r
  }
  step({ actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } })
  step({
    actor: 'lead', type: 'team.created',
    payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] },
  })
  step({
    actor: 'host', type: 'member.spawned',
    payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', instanceName: 'dev', sessionId: 's1', status: 'active' },
  })
  step({ actor: 'lead', type: 'plan.staged', payload: { teamId: 't1', planId: 'p1' } })
  step({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: task() } })
  step({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k2', task: task({ title: 't2', deps: ['k1'] }) } })
  step({ actor: 'human', type: 'plan.approved', payload: { teamId: 't1', planId: 'p1' } })
  step({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  step({ actor: 'm1', type: 'task.progress', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', note: 'half' } })
  step({
    actor: 'm1', type: 'task.evidence',
    payload: {
      teamId: 't1', taskId: 'k1', attemptId: 'a1',
      evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0 }] },
    },
  })
  step({ actor: 'm1', type: 'task.evidence', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { kind: 'na', na: { reason: 'no archive' } } } })
  step({ actor: 'm1', type: 'task.completed', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1' } })
  step({ actor: 'm1', type: 'task.deliverable', payload: { teamId: 't1', taskId: 'k1', path: 'docs/x.md' } })
  step({ actor: 'm1', type: 'task.gate.result', payload: { teamId: 't1', taskId: 'k1', gate: 'review', verdict: 'pass' } })
  step({ actor: 'm1', type: 'task.gate.result', payload: { teamId: 't1', taskId: 'k1', gate: 'archive', verdict: 'pass' } })
  return counts
}

test('T40: 增量 apply 与全量重放逐字段一致，revision 严格等于事件数', () => {
  const { ws, service } = setup()
  scriptedFlow(service)
  const before = JSON.stringify(service.projectionSnapshot)
  // 每步提交后 revision 必须恰好 +1（漏应用或多应用都会被抓到）
  assert.equal(service.projectionSnapshot.revision, 15)
  const { events } = openLedger(join(ws, '.dsh-myteam', 'tasks', 't1', 'ledger.jsonl'))
  assert.equal(events.length, 15)
  const replayed = foldEvents('t1', events)
  assert.deepEqual(JSON.parse(before), JSON.parse(JSON.stringify(replayed)))
  // 任务流后半段真的推进了（不是空投影自比）
  assert.equal(service.projectionSnapshot.tasks['k1'].state, 'done')
  assert.equal(service.projectionSnapshot.tasks['k2'].state, 'ready')
  assert.equal(service.projectionSnapshot.members['m1'].currentTaskId, undefined)
})

test('T40: 折返失败不落账本、不动投影（先算后写）', () => {
  const { ws, service } = setup()
  bootstrapTeam(service)
  service.commit({
    actor: 'lead', type: 'team.created',
    payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] },
  })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: task() } })
  const ledgerPath = join(ws, '.dsh-myteam', 'tasks', 't1', 'ledger.jsonl')
  const linesBefore = readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  const projBefore = JSON.stringify(service.projectionSnapshot)

  // task 还在 backlog，直接报 gate 结果 → fold 防线抛错（领域校验放行、重放防线拒绝）
  const bad = service.commit({
    actor: 'm1', type: 'task.gate.result',
    payload: { teamId: 't1', taskId: 'k1', gate: 'review', verdict: 'pass' },
  })
  assert.equal(bad.ok, false)
  assert.equal((bad as { code: string }).code, 'MT_INTERNAL_FOLD')

  const linesAfter = readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  assert.equal(linesAfter.length, linesBefore.length, '失败事件不得落账本')
  assert.equal(JSON.stringify(service.projectionSnapshot), projBefore, '失败事件不得污染投影')
  // seq 未被消耗：下一条合法事件接在旧尾部
  const next = service.commit({ actor: 'lead', type: 'plan.staged', payload: { teamId: 't1', planId: 'p1' } })
  assert.equal(next.ok, true)
  assert.equal((next as { event: { seq: number } }).event.seq, linesBefore.length)
})

test('T40: 冷启动重放结果与增量结果一致（重启不改变投影）', () => {
  const { ws, rolePaths, service } = setup()
  scriptedFlow(service)
  const online = JSON.stringify(service.projectionSnapshot)
  const reopened = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  assert.equal(JSON.stringify(reopened.projectionSnapshot), online)
  assert.equal(reopened.projectionSnapshot.revision, 15)
  // 重开后继续写：seq 延续、投影仍与全量重放一致
  const more = reopened.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k2', memberId: 'm1', attemptId: 'a2' } })
  assert.equal(more.ok, true)
  const { events } = openLedger(join(ws, '.dsh-myteam', 'tasks', 't1', 'ledger.jsonl'))
  assert.equal(events.length, 16)
  const replayed = foldEvents('t1', events)
  assert.equal(JSON.stringify(replayed), JSON.stringify(reopened.projectionSnapshot))
})
