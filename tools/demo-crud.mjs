/**
 * 开发用：端到端演示「创建 / 编辑」链路（非插件产物）。
 * 用法：node tools/demo-crud.mjs [workspaceRoot]
 * 输出：每一步的工具返回 + 最终投影摘要 + 落盘文件清单。
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { MyTeamHost } from '../plugin/lib/host.mjs'

const ws = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'myteam-crud-'))
const rt = {
  set: () => {},
  tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
  agents: { create: () => ({ followup: () => {}, session: {} }) },
  logger: { info: () => {}, warn: () => {} },
  workspace: { root: ws },
}
const host = new MyTeamHost(rt)
host.initialize()
const out = (label, value) => ({ step: label, ...value })

const steps = []
const call = (label, name, args, exec = {}) => {
  const r = host.executeLeadTool(name, args, exec)
  const brief = { step: label, tool: name, status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.message ? { message: String(r.message).slice(0, 160) } : {}), ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.teamId && name === 'myteam_submit_plan' ? { teamId: r.teamId } : {}) }
  steps.push(brief)
  return r
}

/* 1. 建角色（含兴趣词） */
const role = call('创建角色', 'myteam_create_role', {
  roleId: 'settle-expert', name: '结算专家', description: '结算口径与对账',
  systemPrompt: '你负责结算口径与对账；按任务 AC 交付并附证据块。',
  interestWords: ['结算', '对账', '口径'], skills: ['ui-design'], mcpAllowlist: [],
})
/* 2. 指定项目自身角色（从已有角色复制一份为项目助理） */
call('创建项目助理角色', 'myteam_create_role', {
  roleId: 'project-assistant', name: '项目助理', description: '项目自身角色：对齐跨团队口径',
  systemPrompt: '你负责跨团队口径对齐与项目级约定。', interestWords: ['协调', '口径'],
})
call('指定项目自身角色', 'myteam_set_project_role', { roleId: 'project-assistant' })
call('确认项目自身角色', 'myteam_set_project_role', { roleId: 'project-assistant', confirm: true })

/* 3. 建团队（草稿 → 批准） */
const sub = call('提交团队草稿', 'myteam_submit_plan', {
  teamName: '结算模块',
  goal: '把结算页拆成可独立演进的模块',
  roster: [{ roleId: 'captain' }, { roleId: 'settle-expert', instanceName: 'settle-1' }, { roleId: 'reviewer' }],
  tasks: [],
})
const teamId = sub.teamId
call('批准团队（召唤队员）', 'myteam_approve_plan', { teamId })

/* 4. 建任务 + 编辑任务 */
const t1 = call('创建任务 t1', 'myteam_create_task', {
  teamId, taskId: 't1',
  task: {
    title: '接入统一登录', description: 'OIDC 授权码模式', acceptanceCriteria: ['未登录跳转', '回调换 token'],
    deliverableSpec: { path: 'docs/t1.md' }, deps: [], requiredRole: 'settle-expert', priority: 'P2', gateChain: ['review'],
  },
})
const t2 = call('创建任务 t2', 'myteam_create_task', {
  teamId, taskId: 't2',
  task: {
    title: '拆账出口', description: '按模块边界拆分结算出口', acceptanceCriteria: ['出口清单'], deps: ['t1'],
    requiredRole: 'settle-expert', priority: 'P2', gateChain: ['review'],
  },
})
const editTask = call('编辑任务（不 changing 状态）', 'myteam_update_task', {
  teamId, taskId: 't1',
  patch: { title: '接入统一登录（OIDC）', acceptanceCriteria: ['未登录跳转', '回调换 token', '过期自动续期'], priority: 'P1', tags: ['auth'] },
})
const badCycle = call('编辑被拒（依赖成环）', 'myteam_update_task', { teamId, taskId: 't1', patch: { deps: ['t2'] } })

/* 5. 编辑团队 / 角色 */
call('团队改名', 'myteam_update_team', { teamId, name: '结算模块 v2', goal: '结算页模块化（二期）' })
call('编辑角色（version+1）', 'myteam_update_role', { roleId: 'settle-expert', patch: { interestWords: ['结算', '对账', '灰度'] } })

/* 6. 多队员指派 + 参与关系（同团队 owner） */
const settleMember = Object.values(host.service(teamId).projectionSnapshot.members).find((m) => m.roleId === 'settle-expert')
call('指派负责队员', 'myteam_assign_task', { teamId, taskId: 't1', memberIds: settleMember ? [settleMember.id] : [] })
call('登记协作团队', 'myteam_participate_task', { teamId, taskId: 't2', participantTeamId: 'demo-api', role: 'coop' })

const svc = host.service(teamId)
const proj = svc.projectionSnapshot
const summary = {
  workspaceRoot: ws,
  team: { teamId: proj.teamId, name: proj.name, goal: proj.goal, state: proj.state },
  tasks: Object.values(proj.tasks).map((t) => ({
    id: t.id, title: t.input.title, state: t.state, priority: t.input.priority,
    ac: t.input.acceptanceCriteria, tags: t.input.tags ?? [], assignees: t.assignees ?? [],
    participants: proj.participations[t.id]?.teams ?? null,
  })),
  members: Object.values(proj.members).map((m) => ({ id: m.id, roleId: m.roleId, instanceName: m.instanceName, status: m.status })),
  roles: host.roleCatalogView().map((r) => ({ id: r.id, origin: r.origin, interestWords: r.interestWords, version: r.version })),
  ledgerTypes: readFileSync(svc.ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).type),
}
const walk = (dir, base = dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, base, acc)
    else acc.push(relative(base, full).replace(/\\/g, '/'))
  }
  return acc
}
const files = walk(join(ws, '.team-workplace')).sort()
console.log(JSON.stringify({ steps, summary, files }, null, 2))
