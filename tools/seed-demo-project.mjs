/**
 * 开发用：播种一个「项目级」演示工作区（CHG-69 面板验收），非插件产物。
 *
 * 产出：
 *   <ws>/.team-workplace/config/roles/*.json        角色（含兴趣词）
 *   <ws>/.team-workplace/config/project-role.json   项目自身角色
 *   <ws>/.team-workplace/state/teams/<team>/ledger.jsonl  两个团队（主责 + 协作）
 *   <ws>/.team-workplace/state/teams.json           工作区索引
 *   ~/.dsh/myteam/workspaces.json                   跨工作区索引（先备份，cleanup 还原）
 *
 * 用法：node tools/seed-demo-project.mjs [workspaceRoot]
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { TeamService, bootstrapTeam } from '../plugin/lib/core/service.mjs'
import { copyToProject, writeProjectRoleCard, readProjectRole } from '../plugin/lib/core/roles/role-store.mjs'
import { emptyTokensFile, accumulate } from '../plugin/lib/core/ledger/token-sidecar.mjs'
import { entryFromProjection, writeWorkspaceIndex, readGlobalIndex } from '../plugin/lib/core/index/team-index.mjs'

const ws = resolve(process.argv[2] ?? join(process.cwd(), '.debug', 'demo-project'))
if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })

const globalPath = join(homedir(), '.dsh', 'myteam', 'workspaces.json')
const backup = join(process.cwd(), '.debug', 'workspaces.backup.json')
mkdirSync(join(process.cwd(), '.debug'), { recursive: true })
if (existsSync(globalPath) && !existsSync(backup)) copyFileSync(globalPath, backup)
// 索引隔离：只保留本演示工作区（验收后由 cleanup 还原）
mkdirSync(join(homedir(), '.dsh', 'myteam'), { recursive: true })
writeFileSync(globalPath, JSON.stringify({ version: 1, updatedAt: Date.now(), workspaces: {} }, null, 2), 'utf8')

const rolePaths = {
  projectRolesDir: join(ws, '.team-workplace', 'config', 'roles'),
  projectRoleFile: join(ws, '.team-workplace', 'config', 'project-role.json'),
}
for (const id of ['captain', 'implementer', 'reviewer', 'req-validator', 'acceptor', 'developer']) {
  copyToProject(rolePaths, id, 'builtin')
}
// 项目自身角色：需求验证员的一份项目级实例（不属于任何团队）
const assistant = { ...structuredClone(readProjectRole(rolePaths.projectRolesDir, 'req-validator')), id: 'project-assistant', name: '项目助理' }
assistant.description = '项目自身角色：对齐跨团队口径、维护项目级约定；不属于任何团队，可被各团队聘任'
assistant.interestWords = ['协调', '口径']
writeProjectRoleCard(rolePaths, assistant)

const ok = (r, label) => {
  if (!r.ok) throw new Error(`${label}: ${r.code} ${r.message}`)
  return r
}
const team = (teamId, name, goal, members) => {
  const svc = new TeamService({ workspaceRoot: ws, teamId, rolePaths })
  ok(bootstrapTeam(svc), `${teamId} bootstrap`)
  ok(svc.commit({
    actor: 'lead', type: 'team.created',
    payload: { teamId, name, goal, roster: [{ roleId: 'captain' }, ...members.map((m) => ({ roleId: m.roleId, instanceName: m.instanceName }))] },
  }), `${teamId} created`)
  ok(svc.commit({ actor: 'lead', type: 'plan.staged', payload: { teamId, planId: 'p1' } }), `${teamId} staged`)
  for (const m of members) {
    ok(svc.commit({
      actor: 'host', type: 'member.spawned',
      payload: { teamId, memberId: m.id, roleId: m.roleId, instanceName: m.instanceName, sessionId: `mt-${teamId}-${m.id}`, status: 'active' },
    }), `${teamId} spawn ${m.id}`)
  }
  ok(svc.commit({ actor: 'human', type: 'plan.approved', payload: { teamId, planId: 'p1' } }), `${teamId} approved`)
  return svc
}
const task = (over) => ({
  title: 't', description: '', acceptanceCriteria: ['AC'], deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review', 'archive'], ...over,
})

/* ── 团队 α：主责团队（结算页模块化） ── */
const alpha = team('demo-settle', '结算页模块化', '把结算页拆成可独立演进的模块，先接统一登录与出口', [
  { id: 'm-a1', roleId: 'implementer', instanceName: 'implementer' },
  { id: 'm-a2', roleId: 'reviewer', instanceName: 'reviewer' },
  { id: 'm-a3', roleId: 'acceptor', instanceName: 'acceptor' },
])
const aTask = (id, over) => ok(alpha.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo-settle', taskId: id, task: task(over) } }), id)
aTask('t1', { title: '接入统一登录鉴权', description: 'OIDC 授权码模式，会话保持 7 天', acceptanceCriteria: ['未登录跳转', '回调换取 token', '过期自动续期'] })
aTask('t2', { title: '订单拆账与出口', description: '按模块边界拆分结算出口', priority: 'P1', deps: ['t1'] })
aTask('t3', { title: '结算明细页', description: '模块化明细表', deps: ['t2'] })
aTask('t4', { title: '灰度开关与回滚', deps: ['t3'] })
aTask('t5', { title: '导出对账文件', deps: ['t4'] })
aTask('t6', { title: '全链路验收', requiredRole: 'acceptor', deps: ['t2'], gateChain: ['verify'] })
// 任务状态：t1/t2 done，t3 在跑，t4/t5 待规划，t6 门禁
const claim = (svc, teamId, taskId, memberId, attemptId) => ok(svc.commit({ actor: memberId, type: 'task.claimed', payload: { teamId, taskId, memberId, attemptId } }), `${taskId} claim`)
const finish = (svc, teamId, taskId, attemptId) => {
  ok(svc.commit({ actor: 'm-a1', type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 42 }] } } }), `${taskId} evidence`)
  ok(svc.commit({ actor: 'm-a1', type: 'task.completed', payload: { teamId, taskId, attemptId } }), `${taskId} done`)
}
claim(alpha, 'demo-settle', 't1', 'm-a1', 'a1')
finish(alpha, 'demo-settle', 't1', 'a1')
ok(alpha.commit({ actor: 'm-a2', type: 'task.gate.result', payload: { teamId: 'demo-settle', taskId: 't1', gate: 'review', verdict: 'pass' } }), 't1 review')
ok(alpha.commit({ actor: 'lead', type: 'task.deliverable', payload: { teamId: 'demo-settle', taskId: 't1', path: 'docs/t1.md' } }), 't1 deliverable')
ok(alpha.commit({ actor: 'm-a2', type: 'task.gate.result', payload: { teamId: 'demo-settle', taskId: 't1', gate: 'archive', verdict: 'pass' } }), 't1 archive')
claim(alpha, 'demo-settle', 't2', 'm-a1', 'a2')
finish(alpha, 'demo-settle', 't2', 'a2')
ok(alpha.commit({ actor: 'm-a2', type: 'task.gate.result', payload: { teamId: 'demo-settle', taskId: 't2', gate: 'review', verdict: 'pass' } }), 't2 review')
ok(alpha.commit({ actor: 'lead', type: 'task.deliverable', payload: { teamId: 'demo-settle', taskId: 't2', path: 'docs/t2.md' } }), 't2 deliverable')
ok(alpha.commit({ actor: 'm-a2', type: 'task.gate.result', payload: { teamId: 'demo-settle', taskId: 't2', gate: 'archive', verdict: 'pass' } }), 't2 archive')
claim(alpha, 'demo-settle', 't3', 'm-a1', 'a3')
ok(alpha.commit({ actor: 'm-a1', type: 'task.progress', payload: { teamId: 'demo-settle', taskId: 't3', attemptId: 'a3', note: '明细表骨架已通' } }), 't3 progress')
claim(alpha, 'demo-settle', 't6', 'm-a3', 'a6')
ok(alpha.commit({ actor: 'm-a3', type: 'task.evidence', payload: { teamId: 'demo-settle', taskId: 't6', attemptId: 'a6', evidence: { kind: 'na', na: { reason: '验收证据由全链路脚本产出，待 t5 完成后复核' } } } }), 't6 evidence')
ok(alpha.commit({ actor: 'm-a3', type: 'task.completed', payload: { teamId: 'demo-settle', taskId: 't6', attemptId: 'a6' } }), 't6 done')
// 多队员负责：t3 = 实现者主责 + 评审者协作；t4 = 实现者 + 验收员
ok(alpha.commit({ actor: 'lead', type: 'task.assigned', payload: { teamId: 'demo-settle', taskId: 't3', memberId: 'm-a1', memberIds: ['m-a1', 'm-a2'] } }), 't3 assign')
ok(alpha.commit({ actor: 'lead', type: 'task.assigned', payload: { teamId: 'demo-settle', taskId: 't4', memberId: 'm-a1', memberIds: ['m-a1', 'm-a3'] } }), 't4 assign')
// 参与关系：t3 / t6 拉 β 团队协作
ok(alpha.commit({ actor: 'lead', type: 'task.participate', payload: { teamId: 'demo-settle', taskId: 't3', participantTeamId: 'demo-api', role: 'coop', memberIds: ['m-b2'] } }), 't3 coop')
ok(alpha.commit({ actor: 'lead', type: 'task.participate', payload: { teamId: 'demo-settle', taskId: 't6', participantTeamId: 'demo-api', role: 'coop', memberIds: ['m-b1'] } }), 't6 coop')

/* ── 团队 β：协作方（插件 v0.2 接口评审），也有一条主责任务被 α 协作 ── */
const beta = team('demo-api', '插件 v0.2 接口评审', '评审插件 v0.2 的命令面与回滚兼容性', [
  { id: 'm-b1', roleId: 'reviewer', instanceName: 'reviewer' },
  { id: 'm-b2', roleId: 'implementer', instanceName: 'implementer' },
])
const bTask = (id, over) => ok(beta.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'demo-api', taskId: id, task: task(over) } }), id)
bTask('u1', { title: '命令面契约评审', requiredRole: 'reviewer', deps: [] })
bTask('u2', { title: '回滚兼容性回归', deps: ['u1'] })
bTask('u3', { title: '发布说明与迁移指引', deps: ['u2'] })
claim(beta, 'demo-api', 'u1', 'm-b1', 'b1')
ok(beta.commit({ actor: 'm-b1', type: 'task.evidence', payload: { teamId: 'demo-api', taskId: 'u1', attemptId: 'b1', evidence: { kind: 'commands', commands: [{ cmd: 'pnpm test contracts', exitCode: 0 }] } } }), 'u1 evidence')
ok(beta.commit({ actor: 'm-b1', type: 'task.completed', payload: { teamId: 'demo-api', taskId: 'u1', attemptId: 'b1' } }), 'u1 done')
ok(beta.commit({ actor: 'm-b1', type: 'task.gate.result', payload: { teamId: 'demo-api', taskId: 'u1', gate: 'review', verdict: 'pass' } }), 'u1 review')
ok(beta.commit({ actor: 'lead', type: 'task.deliverable', payload: { teamId: 'demo-api', taskId: 'u1', path: 'docs/contract.md' } }), 'u1 deliverable')
ok(beta.commit({ actor: 'm-b1', type: 'task.gate.result', payload: { teamId: 'demo-api', taskId: 'u1', gate: 'archive', verdict: 'pass' } }), 'u1 archive')
claim(beta, 'demo-api', 'u2', 'm-b2', 'b2')
ok(beta.commit({ actor: 'lead', type: 'task.assigned', payload: { teamId: 'demo-api', taskId: 'u2', memberId: 'm-b2', memberIds: ['m-b2', 'm-b1'] } }), 'u2 assign')
// β 的 u2 拉 α 协作（α 提供 API 清单）
ok(beta.commit({ actor: 'lead', type: 'task.participate', payload: { teamId: 'demo-api', taskId: 'u2', participantTeamId: 'demo-settle', role: 'coop', memberIds: ['m-a1'] } }), 'u2 coop')

/* ── tokens 侧车 + 索引 ── */
const writeTokens = (teamId, rows) => {
  let file = emptyTokensFile(teamId)
  for (const [memberId, bucket] of rows) file = accumulate(file, memberId, '2026-10-31', bucket)
  const dir = join(ws, '.team-workplace', 'state', 'teams', teamId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify(file, null, 2), 'utf8')
}
writeTokens('demo-settle', [
  ['m-a1', { uncachedInput: 180000, cacheRead: 520000, cacheWrite: 20000, output: 12000, calls: 48 }],
  ['m-a2', { uncachedInput: 60000, cacheRead: 150000, cacheWrite: 5000, output: 4200, calls: 16 }],
  ['m-a3', { uncachedInput: 22000, cacheRead: 48000, cacheWrite: 2000, output: 1500, calls: 6 }],
])
writeTokens('demo-api', [
  ['m-b1', { uncachedInput: 90000, cacheRead: 210000, cacheWrite: 7000, output: 6200, calls: 22 }],
  ['m-b2', { uncachedInput: 44000, cacheRead: 96000, cacheWrite: 3000, output: 2800, calls: 10 }],
])
const index = { version: 1, workspaceRoot: ws, updatedAt: Date.now(), teams: [] }
for (const id of ['demo-settle', 'demo-api']) {
  const svc = new TeamService({ workspaceRoot: ws, teamId: id, rolePaths })
  index.teams.push(entryFromProjection(id, svc.projectionSnapshot, Date.now()))
}
writeWorkspaceIndex(ws, index)
const global = readGlobalIndex(globalPath) ?? { version: 1, updatedAt: 0, workspaces: {} }
global.workspaces[ws] = { workspaceRoot: ws, updatedAt: Date.now(), teams: index.teams }
global.updatedAt = Date.now()
writeFileSync(globalPath, JSON.stringify(global, null, 2), 'utf8')

console.log(JSON.stringify({
  workspaceRoot: ws,
  teams: ['demo-settle', 'demo-api'],
  projectRole: 'project-assistant',
  tasks: 9,
  note: 'index/global 已指向本演示工作区（原索引备份在 .debug/workspaces.backup.json）',
}, null, 2))
