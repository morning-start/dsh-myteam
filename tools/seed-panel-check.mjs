/**
 * 开发用（非产物）：在仓库工作区播一个「面板验收」活团队，供 CHG-72 UI 联调。
 * 用法：node tools/seed-panel-check.mjs [--clean]
 * 清理：node tools/seed-panel-check.mjs --clean
 */
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TeamService, bootstrapTeam } from '../plugin/lib/core/service.mjs'
import { copyToProject, writeProjectRole } from '../plugin/lib/core/roles/role-store.mjs'

const ws = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd())
const clean = process.argv.includes('--clean')
const workplace = join(ws, '.team-workplace')
const rolePaths = {
  projectRolesDir: join(workplace, 'config', 'roles'),
  projectRoleFile: join(workplace, 'config', 'project-role.json'),
}
const manifestPath = join(workplace, 'state', 'panel-check.manifest.json')
const TEAMS = ['panel-check', 'panel-draft']

if (clean) {
  for (const team of TEAMS) rmSync(join(workplace, 'state', 'teams', team), { recursive: true, force: true })
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const file of manifest.createdRoleFiles ?? []) rmSync(file, { force: true })
    rmSync(manifestPath, { force: true })
  }
  console.log(JSON.stringify({ cleaned: TEAMS }, null, 2))
  process.exit(0)
}

const createdRoleFiles = []
mkdirSync(rolePaths.projectRolesDir, { recursive: true })
mkdirSync(join(workplace, 'state'), { recursive: true })
for (const id of ['captain', 'implementer', 'reviewer']) {
  const target = join(rolePaths.projectRolesDir, `${id}.json`)
  if (existsSync(target)) continue
  const out = copyToProject(rolePaths, id, 'builtin')
  createdRoleFiles.push(out.filePath)
}
writeFileSync(manifestPath, JSON.stringify({ createdRoleFiles, createdAt: Date.now() }, null, 2), 'utf8')

const ok = (r, label) => {
  if (!r.ok) throw new Error(`${label}: ${r.code} ${r.message}`)
  return r
}
const task = (over) => ({
  title: 't', description: '', acceptanceCriteria: ['AC'], deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'], ...over,
})

/* 活团队：两名实现者（一名在跑）+ 一名评审者（在跑） */
rmSync(join(workplace, 'state', 'teams', 'panel-check'), { recursive: true, force: true })
const svc = new TeamService({ workspaceRoot: ws, teamId: 'panel-check', rolePaths })
ok(bootstrapTeam(svc), 'bootstrap')
ok(svc.commit({
  actor: 'lead', type: 'team.created',
  payload: {
    teamId: 'panel-check', name: '面板验收团队', goal: '验证面板内的任务诊断、新建/编辑与角色表单',
    roster: [
      { roleId: 'captain' },
      { roleId: 'implementer', instanceName: 'impl-a' },
      { roleId: 'implementer', instanceName: 'impl-b' },
      { roleId: 'reviewer', instanceName: 'reviewer' },
    ],
  },
}), 'team.created')
ok(svc.commit({ actor: 'lead', type: 'plan.staged', payload: { teamId: 'panel-check', planId: 'p1' } }), 'plan.staged')
for (const [memberId, roleId, instanceName] of [['m-pc1', 'implementer', 'impl-a'], ['m-pc2', 'implementer', 'impl-b'], ['m-pc3', 'reviewer', 'reviewer']]) {
  ok(svc.commit({
    actor: 'host', type: 'member.spawned',
    payload: { teamId: 'panel-check', memberId, roleId, instanceName, sessionId: `mt-panel-check-${memberId}`, status: 'active' },
  }), `spawn ${memberId}`)
}
ok(svc.commit({ actor: 'human', type: 'plan.approved', payload: { teamId: 'panel-check', planId: 'p1' } }), 'approved')

const addTask = (id, over) => ok(svc.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'panel-check', taskId: id, task: task(over) } }), id)
addTask('t1', { title: '接入统一登录', description: '演示：上游在跑', acceptanceCriteria: ['未登录跳转', '回调换取 token'], priority: 'P1' })
addTask('t2', { title: '导出字段校验', description: '演示：上游未完成（deps-pending）', deps: ['t1'] })
addTask('t3', { title: '对账文件下载', description: '演示：链式依赖', deps: ['t2'] })
addTask('r1', { title: '契约评审', requiredRole: 'reviewer', acceptanceCriteria: ['契约无破坏性变更'] })
addTask('r2', { title: '发布说明评审', requiredRole: 'reviewer', description: '演示：该角色都在忙（role-busy）' })

const claim = (taskId, memberId, attemptId) => ok(svc.commit({ actor: memberId, type: 'task.claimed', payload: { teamId: 'panel-check', taskId, memberId, attemptId } }), `${taskId} claim`)
claim('t1', 'm-pc1', 'at-1')
claim('r1', 'm-pc3', 'at-r1')
ok(svc.commit({ actor: 'lead', type: 'task.assigned', payload: { teamId: 'panel-check', taskId: 't2', memberId: 'm-pc2', memberIds: ['m-pc2', 'm-pc1'] } }), 't2 assign')

/* ── CHG-73：执行期编辑闭环的演示数据（重规划 / 取消 / 证据过期 / 批量编排）── */

// ① 证据过期：交付后被改 AC（详情页应显示「证据已过期」+ 改动记录）
addTask('t4', { title: '支付回调验签', description: '演示：证据已过期（交付后被改 AC）', acceptanceCriteria: ['验签成功'] })
claim('t4', 'm-pc2', 'at-t4')
ok(svc.commit({
  actor: 'm-pc2', type: 'task.evidence',
  payload: { teamId: 'panel-check', taskId: 't4', attemptId: 'at-t4', evidence: { kind: 'commands', commands: [{ cmd: 'npm test -- pay', exitCode: 0 }] } },
}), 't4 evidence')
ok(svc.commit({ actor: 'm-pc2', type: 'task.completed', payload: { teamId: 'panel-check', taskId: 't4', attemptId: 'at-t4' } }), 't4 completed')
ok(svc.commit({ actor: 'lead', type: 'task.gate.result', payload: { teamId: 'panel-check', taskId: 't4', gate: 'review', verdict: 'pass' } }), 't4 gate')
ok(svc.commit({
  actor: 'human', type: 'task.updated',
  payload: {
    teamId: 'panel-check', taskId: 't4',
    patch: { acceptanceCriteria: ['验签成功', '重复回调幂等'] },
    changes: [{ field: 'acceptanceCriteria', from: ['验签成功'], to: ['验签成功', '重复回调幂等'] }],
  },
}), 't4 edit')

// ② 取消任务 + 上游已取消（dep-cancelled 诊断）
addTask('t5', { title: '灰度发布脚本', description: '演示：已被取消' })
addTask('t6', { title: '全量发布', description: '演示：上游已取消（dep-cancelled）', deps: ['t5'] })
ok(svc.commit({
  actor: 'human', type: 'task.cancelled',
  payload: { teamId: 'panel-check', taskId: 't5', reason: '转由发布平台接管，任务作废', downstream: 'leave' },
}), 't5 cancelled')

// ③ 批量编排候选（ready 且无依赖：多选后可批量改优先级 / 指派 / 取消）
addTask('b1', { title: '埋点补齐', description: '演示：批量编排候选', priority: 'P3' })
addTask('b2', { title: '文档更新', description: '演示：批量编排候选', priority: 'P3' })

// ③' CHG-75 演示：取消后重接线（上游 w1 有下游 w2，可改挂到 w3 或解除依赖）
addTask('w1', { title: '待取消的上游', description: '演示：取消时可改挂下游' })
addTask('w2', { title: '待改挂的下游', description: '演示：上游取消后改挂到这里', deps: ['w1'] })
addTask('w3', { title: '候选新上游', description: '演示：可作为新的上游' })

// ④ 角色删除 / 技能目录多选的演示角色（项目库；无在册成员 → 可删）
writeProjectRole(rolePaths.projectRolesDir, {
  id: 'panel-temp-role', name: '临时角色', description: '演示：角色表单技能/MCP 多选与删除',
  systemPrompt: '你是临时角色，用于面板验收。',
  skills: ['panel-demo-skill'], mcpAllowlist: ['filesystem'], interestWords: ['面板验收'],
})
createdRoleFiles.push(join(rolePaths.projectRolesDir, 'panel-temp-role.json'))
writeFileSync(manifestPath, JSON.stringify({ createdRoleFiles, createdAt: Date.now() }, null, 2), 'utf8')

/* 草稿团队：团队未运行（team-inactive） */
rmSync(join(workplace, 'state', 'teams', 'panel-draft'), { recursive: true, force: true })
const draft = new TeamService({ workspaceRoot: ws, teamId: 'panel-draft', rolePaths })
ok(bootstrapTeam(draft), 'draft bootstrap')
ok(draft.commit({
  actor: 'lead', type: 'team.created',
  payload: { teamId: 'panel-draft', name: '待批准团队', goal: '演示草稿态（team-inactive）', roster: [{ roleId: 'captain' }] },
}), 'draft created')
ok(draft.commit({ actor: 'lead', type: 'plan.staged', payload: { teamId: 'panel-draft', planId: 'p1' } }), 'draft staged')
ok(draft.commit({
  actor: 'lead', type: 'task.created',
  payload: { teamId: 'panel-draft', taskId: 'd1', task: task({ requiredRole: 'captain', title: '待批准后才开跑' }) },
}), 'draft task')

// panel-check 账本最新的 mtime → 存活会话的 defaultTeamId 落到这个活团队（不是草稿团队）
const liveLedger = join(workplace, 'state', 'teams', 'panel-check', 'ledger.jsonl')
const now = new Date()
utimesSync(liveLedger, now, now)

console.log(JSON.stringify({ workspaceRoot: ws, teams: TEAMS, createdRoleFiles }, null, 2))