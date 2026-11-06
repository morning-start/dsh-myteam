/**
 * 开发用：在指定工作区播种一个「有内容」的演示团队，便于 UI 调试（非插件产物）。
 * 用法：node tools/seed-demo-team.mjs [workspaceRoot]
 */
import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TeamService, bootstrapTeam } from '../plugin/lib/core/service.mjs'
import { copyToProject } from '../plugin/lib/core/roles/role-store.mjs'
import { emptyTokensFile, accumulate } from '../plugin/lib/core/ledger/token-sidecar.mjs'
import { entryFromProjection } from '../plugin/lib/core/index/team-index.mjs'

const ws = resolve(process.argv[2] ?? process.cwd())
const rolePaths = { projectRolesDir: join(ws, '.team-workplace', 'config', 'roles') }
for (const id of ['captain', 'req-validator', 'developer', 'acceptor']) copyToProject(rolePaths, id, 'builtin')

const svc = new TeamService({ workspaceRoot: ws, teamId: 'demo', rolePaths })
const ok = (r, label) => {
  if (!r.ok) throw new Error(`${label}: ${r.code} ${r.message}`)
  return r
}
ok(bootstrapTeam(svc), 'bootstrap')
ok(svc.commit({
  actor: 'lead', type: 'team.created',
  payload: {
    teamId: 'demo', name: '登录改造', goal: '为控制台接入统一登录与权限校验',
    roster: [
      { roleId: 'captain' },
      { roleId: 'req-validator', instanceName: '需求验证员' },
      { roleId: 'developer', instanceName: '开发' },
      { roleId: 'acceptor', instanceName: '验收员' },
    ],
  },
}), 'team.created')

const spawn = (id, roleId, instanceName) => ok(svc.commit({
  actor: 'host', type: 'member.spawned',
  payload: { teamId: 'demo', memberId: id, roleId, instanceName, sessionId: `mt-demo-${id}`, status: 'active', skills: [], mcpAllowlist: [] },
}), `spawn ${id}`)
spawn('m1', 'req-validator', '需求验证员')
spawn('m2', 'developer', '开发')
spawn('m3', 'acceptor', '验收员')

ok(svc.commit({ actor: 'lead', type: 'plan.staged', payload: { teamId: 'demo', planId: 'p1' } }), 'staged')
const task = (id, over) => ({
  title: id, description: '', acceptanceCriteria: ['AC'], deliverableSpec: { path: `docs/${id}.md` },
  deps: [], requiredRole: 'developer', priority: 'P2', gateChain: ['review', 'archive'], ...over,
})
ok(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo', taskId: 't1', task: task('t1', { title: '接入登录鉴权', description: 'OIDC 授权码模式，会话保持 7 天', acceptanceCriteria: ['未登录跳转', '回调换取 token', '过期自动续期'] }) } }), 't1')
ok(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo', taskId: 't2', task: task('t2', { title: '补充鉴权接口文档', priority: 'P1', deps: ['t1'] }) } }), 't2')
ok(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo', taskId: 't3', task: task('t3', { title: '修复看板拖拽回弹', deps: ['t1'] }) } }), 't3')
ok(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo', taskId: 't4', task: task('t4', { title: '验收登录全链路', requiredRole: 'acceptor', deps: ['t1'], gateChain: ['verify'] }) } }), 't4')
ok(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo', taskId: 't5', task: task('t5', { title: '权限矩阵压测方案', requiredRole: 'req-validator', priority: 'P3', deps: ['t2'] }) } }), 't5')
ok(svc.commit({ actor: 'human', type: 'plan.approved', payload: { teamId: 'demo', planId: 'p1' } }), 'approved')

ok(svc.commit({ actor: 'm2', type: 'task.claimed', payload: { teamId: 'demo', taskId: 't1', memberId: 'm2', attemptId: 'a1' } }), 'claim t1')
ok(svc.commit({ actor: 'm2', type: 'task.progress', payload: { teamId: 'demo', taskId: 't1', attemptId: 'a1', note: 'OIDC 回调已通' } }), 'progress t1')
ok(svc.commit({ actor: 'm2', type: 'task.evidence', payload: { teamId: 'demo', taskId: 't1', attemptId: 'a1', evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0 }] } } }), 'evidence t1')
ok(svc.commit({ actor: 'm2', type: 'task.completed', payload: { teamId: 'demo', taskId: 't1', attemptId: 'a1' } }), 'done t1')
ok(svc.commit({ actor: 'm2', type: 'task.gate.result', payload: { teamId: 'demo', taskId: 't1', gate: 'review', verdict: 'pass' } }), 'review t1')
ok(svc.commit({ actor: 'm2', type: 'task.deliverable', payload: { teamId: 'demo', taskId: 't1', path: 'docs/t1.md' } }), 'deliverable t1')
ok(svc.commit({ actor: 'm2', type: 'task.gate.result', payload: { teamId: 'demo', taskId: 't1', gate: 'archive', verdict: 'pass' } }), 'archive t1')

ok(svc.commit({ actor: 'm2', type: 'task.claimed', payload: { teamId: 'demo', taskId: 't2', memberId: 'm2', attemptId: 'a2' } }), 'claim t2')
ok(svc.commit({ actor: 'm2', type: 'task.evidence', payload: { teamId: 'demo', taskId: 't2', attemptId: 'a2', evidence: { kind: 'na', na: { reason: '文档类任务，人工评审' } } } }), 'evidence t2')
ok(svc.commit({ actor: 'm2', type: 'task.completed', payload: { teamId: 'demo', taskId: 't2', attemptId: 'a2' } }), 'done t2')

ok(svc.commit({ actor: 'm2', type: 'task.claimed', payload: { teamId: 'demo', taskId: 't3', memberId: 'm2', attemptId: 'a3' } }), 'claim t3')
ok(svc.commit({ actor: 'lead', type: 'message.sent', payload: { teamId: 'demo', messageId: 'msg1', from: 'lead', to: 'm2', body: '拖拽回弹优先修，验收员在等。' } }), 'message')
ok(svc.commit({ actor: 'lead', type: 'task.progress', payload: { teamId: 'demo', taskId: 't3', attemptId: 'a3', note: '已定位 flex 高度问题' } }), 'progress t3')

// tokens 侧车（面板成本 tab 用）
const tokens = accumulate(accumulate(accumulate(emptyTokensFile('demo'), 'm2', '2026-10-31', {
  uncachedInput: 120000, cacheRead: 380000, cacheWrite: 12000, output: 8000, calls: 42,
}), 'm1', '2026-10-31', { uncachedInput: 30000, cacheRead: 90000, cacheWrite: 4000, output: 2600, calls: 11 }), 'm3', '2026-10-31', {
  uncachedInput: 8000, cacheRead: 21000, cacheWrite: 1000, output: 900, calls: 4,
})
const { writeFileSync, mkdirSync } = await import('node:fs')
const teamsDir = join(ws, '.team-workplace', 'state', 'teams', 'demo')
mkdirSync(teamsDir, { recursive: true })
writeFileSync(join(teamsDir, 'tokens.json'), JSON.stringify(tokens, null, 2), 'utf8')

console.log(JSON.stringify({ workspace: ws, teamId: 'demo', revision: svc.projectionSnapshot.revision, tasks: Object.keys(svc.projectionSnapshot.tasks).length, members: Object.keys(svc.projectionSnapshot.members).length, entry: entryFromProjection('demo', svc.projectionSnapshot) }, null, 2))
