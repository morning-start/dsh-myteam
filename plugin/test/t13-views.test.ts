import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService, bootstrapTeam } from '../src/core/service.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'
import { buildBoardView, buildTaskDetailView, buildTokensView } from '../src/core/index/views.ts'
import { emptyTokensFile, accumulate } from '../src/core/ledger/token-sidecar.ts'

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t13-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'demo', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'plan.approved', payload: { teamId: 't1', planId: 'p1' } })
  service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'ok', instanceName: 'impl-1', parentMemberId: null, depth: 0, rootMemberId: 'm1' } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: { title: 'T1', description: 'd', acceptanceCriteria: ['ac'], deliverableSpec: { path: 'docs/x.md' }, deps: [], requiredRole: 'implementer', priority: 'P1', gateChain: ['review', 'archive'] } } })
  return service
}

test('T13: board view maps task states to config columns (K1: column = stage)', () => {
  const service = setup()
  const board = buildBoardView(service, { running: ['in_progress', 're-scoping'], gates: ['gate:review', 'gate:archive'] }, ['backlog', 'ready', 'running', 'gates', 'done'])
  assert.equal(board.teamId, 't1')
  assert.equal(board.members.length, 1)
  // backlog 中的任务落在 backlog 列
  const backlog = board.columns.find((c) => c.name === 'backlog')
  assert.ok(backlog!.tasks.some((t) => t.id === 'k1'))
  assert.equal(board.revision > 0, true)
})

test('T13: task detail assembles timeline + evidence + messages from ledger only (FR-8.1/12.2)', () => {
  const service = setup()
  service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  service.commit({ actor: 'm1', type: 'task.evidence', payload: { teamId: 't1', taskId: 'k1', attemptId: 'a1', evidence: { kind: 'na', na: { reason: 'doc' } } } })
  service.commit({ actor: 'm1', type: 'message.sent', payload: { teamId: 't1', messageId: 'msg1', from: 'm1', to: 'm1', taskId: 'k1' } })
  // 面板读侧的等价物：从账本重读 events
  const events = readEvents(service.ledgerPath)
  const detail = buildTaskDetailView(service, 'k1', events)
  assert.ok(detail)
  assert.equal(detail!.attemptId, 'a1')
  assert.ok(detail!.timeline.some((e) => e.type === 'task.claimed'))
  assert.equal(detail!.evidenceRefs.length, 1)
  assert.equal(detail!.evidenceRefs[0].evidence.kind, 'na')
  assert.equal(detail!.messages.length, 1)
  // 不存在的任务 → undefined
  assert.equal(buildTaskDetailView(service, 'ghost', events), undefined)
})

test('T13: tokens view derives hit rate (REV-5)', () => {
  let file = emptyTokensFile('t1')
  file = accumulate(file, 'm1', '2026-10-25', { uncachedInput: 100, cacheRead: 900, cacheWrite: 50, output: 200 })
  const view = buildTokensView(file) as { totals: Record<string, { hitRate: number | null }> }
  assert.ok(Math.abs(view.totals['m1'].hitRate! - 900 / 1050) < 1e-9)
})

test('T13: task detail sharedScopes —— claim 闸门（CHG-161）的事前可见化（CHG-171）', () => {
  const service = setup()
  const mk = (taskId: string, extra: Record<string, unknown>) => {
    const r = service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId, task: { title: taskId.toUpperCase(), description: 'd', acceptanceCriteria: ['ac'], deliverableSpec: { path: 'docs/x.md' }, deps: [], requiredRole: 'implementer', priority: 'P1', gateChain: ['review', 'archive'], ...extra } } })
    assert.equal(r.ok, true, `${taskId} 建单成功`)
  }
  /* k1（setup 建）未声明 writeScopes → 无块（未声明 ≠ 冲突） */
  assert.equal(buildTaskDetailView(service, 'k1', readEvents(service.ledgerPath))!.sharedScopes, undefined)
  mk('k2', { writeScopes: ['src/'] })
  mk('k3', { writeScopes: ['src/a.ts'] })
  mk('k4', { writeScopes: ['lib/'] })
  mk('k5', {})
  mk('k6', { writeScopes: ['lib/db.ts'] })
  const events = () => readEvents(service.ledgerPath)
  /* k2 ready：blocking 空（没有 in_progress 重叠）；queued = k3（ready 重叠），不含 k4（不重叠）/ k5（未声明） */
  const d2 = buildTaskDetailView(service, 'k2', events())!
  assert.deepEqual(d2.sharedScopes, { blocking: [], queued: [{ taskId: 'k3', title: 'K3' }] })
  /* k2 claim → in_progress 后：k3 再看 k2 = blocking（此刻会被闸门拦，点名在等谁） */
  const claim = service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k2', memberId: 'm1', attemptId: 'a2' } })
  assert.equal(claim.ok, true)
  const d3 = buildTaskDetailView(service, 'k3', events())!
  assert.deepEqual(d3.sharedScopes!.blocking, [{ taskId: 'k2', title: 'K2' }])
  assert.deepEqual(d3.sharedScopes!.queued, [])
  /* k4/k6 同范围（lib/ vs lib/db.ts 重叠）：互相 queued；字典序稳定 */
  const d4 = buildTaskDetailView(service, 'k4', events())!
  assert.deepEqual(d4.sharedScopes!.queued, [{ taskId: 'k6', title: 'K6' }])
  /* k5 未声明 → 无块 */
  assert.equal(buildTaskDetailView(service, 'k5', events())!.sharedScopes, undefined)
})

test('T13: plan banner three actions map to ledger events (FR-1.2 唯一写入口)', () => {
  const service = setup()
  // revise / discard 萰账本（approve 已在 setup 中验证过）
  const revise = service.commit({ actor: 'lead', type: 'plan.revised', payload: { teamId: 't1', planId: 'p1', note: 'narrow goal' } })
  assert.equal(revise.ok, true)
  const discard = service.commit({ actor: 'lead', type: 'plan.discarded', payload: { teamId: 't1', planId: 'p1' } })
  assert.equal(discard.ok, true)
  assert.equal(service.projectionSnapshot.state, 'discarded')
})

function readEvents(ledgerPath: string): { seq: number; ts: number; actor: string; type: string; payload: Record<string, unknown> }[] {
  const raw = readFileSync(ledgerPath, 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
}
