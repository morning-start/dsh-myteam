/**
 * T40 性能冒烟（CHG-59）：真实 lib 产物上对比「增量提交」与「全量重放」。
 *
 * 用法（仓库根）：node tools/smoke-commit-perf.mjs [progressEvents]
 * 输出：N 次提交总耗时/均值、一次全量 fold 耗时、冷启动（含重放）耗时、两者投影是否一致。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService, bootstrapTeam } from '../plugin/lib/core/service.mjs'
import { copyToProject } from '../plugin/lib/core/roles/role-store.mjs'
import { openLedger } from '../plugin/lib/core/ledger/ledger.mjs'
import { foldEvents } from '../plugin/lib/core/scheduler/fold.mjs'

const N = Number(process.argv[2] ?? 2000)
const ws = mkdtempSync(join(tmpdir(), 'myteam-perf-'))
const rolePaths = { projectRolesDir: join(ws, 'roles') }
copyToProject(rolePaths, 'captain', 'builtin')
copyToProject(rolePaths, 'implementer', 'builtin')

const svc = new TeamService({ workspaceRoot: ws, teamId: 'perf', rolePaths })
const must = (r, label) => {
  if (!r.ok) throw new Error(`${label} failed: ${r.code} ${r.message}`)
  return r
}
bootstrapTeam(svc)
must(svc.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 'perf', name: 'perf', goal: 'perf', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } }), 'team.created')
must(svc.commit({ actor: 'host', type: 'member.spawned', payload: { teamId: 'perf', memberId: 'm1', roleId: 'implementer', instanceName: 'dev', sessionId: 's1', status: 'active' } }), 'member.spawned')
must(svc.commit({ actor: 'lead', type: 'plan.staged', payload: { teamId: 'perf', planId: 'p1' } }), 'plan.staged')
must(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'perf', taskId: 'k1', task: { title: 't', description: 'd', acceptanceCriteria: ['ac'], deliverableSpec: { path: 'docs/x.md' }, deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'] } } }), 'task.created')
must(svc.commit({ actor: 'human', type: 'plan.approved', payload: { teamId: 'perf', planId: 'p1' } }), 'plan.approved')
must(svc.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 'perf', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } }), 'task.claimed')

const t0 = performance.now()
for (let i = 0; i < N; i++) {
  must(svc.commit({ actor: 'm1', type: 'task.progress', payload: { teamId: 'perf', taskId: 'k1', attemptId: 'a1', note: `p${i}` } }), `progress ${i}`)
}
const commitMs = performance.now() - t0

const ledgerPath = join(ws, '.team-workplace', 'state', 'teams', 'perf', 'ledger.jsonl')
const { events } = openLedger(ledgerPath)

const f0 = performance.now()
const replayed = foldEvents('perf', events)
const foldMs = performance.now() - f0

const c0 = performance.now()
const cold = new TeamService({ workspaceRoot: ws, teamId: 'perf', rolePaths })
const coldMs = performance.now() - c0

const same = JSON.stringify(cold.projectionSnapshot) === JSON.stringify(replayed) &&
  JSON.stringify(svc.projectionSnapshot) === JSON.stringify(replayed)

console.log(JSON.stringify({
  events: events.length,
  progressEvents: N,
  incrementalTotalMs: Number(commitMs.toFixed(1)),
  incrementalAvgMs: Number((commitMs / N).toFixed(3)),
  fullFoldOnceMs: Number(foldMs.toFixed(1)),
  coldStartMs: Number(coldMs.toFixed(1)),
  projectionIdentical: same,
  revision: svc.projectionSnapshot.revision,
}, null, 2))
rmSync(ws, { recursive: true, force: true })
if (!same) process.exit(1)
