/**
 * CHG-69（FR-19/20/21/22）：面板设计稿落地后的模型层回归。
 *
 * 覆盖：
 *  - 角色兴趣词（interestWords）：内置角色带词、schema 校验（≤8 个 / 非空短词）
 *  - 项目自身角色（project-role.json）：写入 / 目录 origin / 取消
 *  - 参与关系（task.participate）：主责隐含、协作增删、旧账本回落
 *  - 多队员指派（task.assigned + memberIds）
 *  - 依赖图分层（buildTaskGraph / dependencyChain）
 *  - 项目聚合视图（buildProjectView：跨团队任务 + 参与团队 + 角色在册）
 *  - 领域校验（主责只能本团队 / 协作不能是自己）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'
import {
  assertValidRole,
  clearProjectRoleCard,
  copyToProject,
  listRoleCatalog,
  projectRoleFilePath,
  readProjectRoleCard,
  writeProjectRoleCard,
} from '../src/core/roles/role-store.ts'
import { BUILTIN_ROLES, builtinRole } from '../src/core/roles/builtin-roles.ts'
import { buildTaskGraph, dependencyChain } from '../src/core/tasks/graph.ts'
import { buildBoardView, buildProjectView, participantsOf } from '../src/remote/views.ts'
import { TeamService, bootstrapTeam } from '../src/core/service.ts'

let seq = 0
function ev(type: string, payload: Record<string, unknown>, ts = 1000): LedgerEvent {
  return { seq: seq++, ts, actor: 'test', type: type as LedgerEvent['type'], payload }
}

function taskInput(over: Record<string, unknown> = {}) {
  return {
    title: 't', description: 'd', acceptanceCriteria: ['ac'],
    deliverableSpec: { path: 'docs/x.md' }, deps: [],
    requiredRole: 'implementer', priority: 'P2', gateChain: ['review'],
    ...over,
  }
}

/* ── 兴趣词（FR-20） ── */

test('t43-1: 内置角色全部带兴趣词，且是短词（≤16 字、≤8 个）', () => {
  for (const role of BUILTIN_ROLES) {
    assert.ok(Array.isArray(role.interestWords) && role.interestWords.length > 0, `${role.id} 缺兴趣词`)
    assert.ok(role.interestWords!.length <= 8)
    for (const word of role.interestWords!) {
      assert.ok(word.trim().length > 0 && word.trim().length <= 16, `${role.id} 兴趣词 "${word}" 非法`)
    }
    // 内置角色必须仍可写回项目库（引用即复制不因新字段失败）
    assert.doesNotThrow(() => assertValidRole(structuredClone(role)))
  }
})

test('t43-2: 兴趣词 schema 拒绝超量/空串（拒绝式，不静默截断）', () => {
  const base = builtinRole('implementer')!
  assert.throws(() => assertValidRole({ ...base, interestWords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), /at most 8/)
  assert.throws(() => assertValidRole({ ...base, interestWords: ['结算', '  '] }), /non-empty strings/)
  assert.doesNotThrow(() => assertValidRole({ ...base, interestWords: ['结算', '模块边界'] }))
})

/* ── 项目自身角色（FR-19） ── */

test('t43-3: 项目自身角色写入 / 目录标注 / 取消（origin=project-role）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t43-role-'))
  const paths = { projectRolesDir: join(ws, 'config', 'roles') }
  copyToProject(paths, 'captain', 'builtin')
  assert.equal(projectRoleFilePath(paths), join(ws, 'config', 'project-role.json'))
  const def = { ...structuredClone(builtinRole('req-validator')!), id: 'project-assistant', name: '项目助理' }
  writeProjectRoleCard(paths, def)
  assert.equal(readProjectRoleCard(paths)?.id, 'project-assistant')
  const catalog = listRoleCatalog(paths)
  const entry = catalog.find((item) => item.definition.id === 'project-assistant')
  assert.equal(entry?.origin, 'project-role')
  // 项目自身角色不进项目角色库目录（不属于任何团队的角色库条目）
  assert.ok(!catalog.some((item) => item.origin === 'project' && item.definition.id === 'project-assistant'))
  clearProjectRoleCard(paths)
  assert.equal(readProjectRoleCard(paths), undefined)
  assert.ok(!listRoleCatalog(paths).some((item) => item.origin === 'project-role'))
})

/* ── 参与关系（FR-21） ── */

test('t43-4: 建任务隐含主责参与边；协作团队可增删；旧账本回落 owner=lead', () => {
  seq = 0
  const events = [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.created', { teamId: 'alpha', taskId: 'k1', task: taskInput() }),
    ev('task.participate', { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta', role: 'coop', memberIds: ['reviewer-1'] }),
  ]
  const proj = foldEvents('alpha', events)
  assert.equal(proj.participations['k1'].leadTeamId, 'alpha')
  assert.equal(proj.participations['k1'].teams['beta'].role, 'coop')
  assert.deepEqual(proj.participations['k1'].teams['beta'].memberIds, ['reviewer-1'])
  const view = participantsOf(proj, 'k1')
  assert.equal(view[0].teamId, 'alpha')
  assert.equal(view[0].role, 'lead')
  assert.equal(view[1].teamId, 'beta')
  assert.equal(view[1].role, 'coop')
  // 协作释放
  events.push(ev('task.participation.released', { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta' }))
  const proj2 = foldEvents('alpha', events)
  assert.equal(proj2.participations['k1'].teams['beta'], undefined)
  assert.deepEqual(participantsOf(proj2, 'k1').map((p) => p.teamId), ['alpha'])
  // 旧账本（无参与事件）回落：owner = lead
  const legacy = foldEvents('alpha', [ev('rules.version.adopted', { version: 1 })])
  assert.deepEqual(participantsOf(legacy, 'ghost'), [{ teamId: 'alpha', role: 'lead', memberIds: [] }])
})

test('t43-5: 主责迁移时旧主责降级为协作（不会出现两个主责）', () => {
  seq = 0
  const proj = foldEvents('alpha', [
    ev('rules.version.adopted', { version: 1 }),
    ev('task.created', { teamId: 'alpha', taskId: 'k1', task: taskInput() }),
    ev('task.participate', { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta', role: 'lead' }),
  ])
  assert.equal(proj.participations['k1'].leadTeamId, 'beta')
  assert.equal(proj.participations['k1'].teams['alpha'].role, 'coop')
  assert.equal(proj.participations['k1'].teams['beta'].role, 'lead')
})

test('t43-6: 多队员指派——assignees 落投影，assignee 保持主负责（claim 语义不变）', () => {
  seq = 0
  const proj = foldEvents('t1', [
    ev('rules.version.adopted', { version: 1 }),
    ev('member.spawned', { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'ok' }),
    ev('member.spawned', { teamId: 't1', memberId: 'm2', roleId: 'reviewer', sessionId: 's2', status: 'ok' }),
    ev('task.created', { teamId: 't1', taskId: 'k1', task: taskInput() }),
    ev('task.assigned', { teamId: 't1', taskId: 'k1', memberId: 'm1', memberIds: ['m1', 'm2'] }),
  ])
  assert.deepEqual(proj.tasks['k1'].assignees, ['m1', 'm2'])
  assert.equal(proj.tasks['k1'].assignee, 'm1')
})

/* ── 依赖图（FR-22） ── */

test('t43-7: 依赖图分层 = 最长路径；边从上游指下游；链闭包上下双向', () => {
  const tasks = [
    { id: 'a', deps: [] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['a'] },
    { id: 'd', deps: ['b', 'c'] },
  ]
  const graph = buildTaskGraph(tasks)
  assert.deepEqual(graph.levels, { a: 0, b: 1, c: 1, d: 2 })
  assert.deepEqual(graph.roots, ['a'])
  assert.deepEqual(graph.edges, [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' },
  ])
  assert.deepEqual(dependencyChain(tasks, 'b'), { upstream: ['a'], downstream: ['d'] })
  assert.deepEqual(graph.cyclic, [])
})

test('t43-8: 依赖图容忍环（不挂死，标 cyclic）与悬空依赖（忽略）', () => {
  const graph = buildTaskGraph([
    { id: 'a', deps: ['b'] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['ghost'] },
  ])
  assert.deepEqual(graph.cyclic.sort(), ['a', 'b'])
  assert.deepEqual(graph.roots, ['c'])
  // 环上的边照常输出（数据本身非法，视图不隐藏）；悬空依赖（ghost）被忽略
  assert.deepEqual(graph.edges.map((e) => `${e.from}->${e.to}`).sort(), ['a->b', 'b->a'])
})

/* ── 项目聚合视图（FR-19/21/24） ── */

test('t43-9: 项目聚合——跨团队任务带参与团队、计数、角色在册（成员=关系）', () => {
  seq = 0
  const alpha = foldEvents('alpha', [
    ev('rules.version.adopted', { version: 1 }),
    ev('team.created', { teamId: 'alpha', name: '结算页', goal: 'g' }),
    ev('member.spawned', { teamId: 'alpha', memberId: 'm1', roleId: 'implementer', instanceName: 'impl-1', sessionId: 's1', status: 'ok' }),
    ev('task.created', { teamId: 'alpha', taskId: 'k1', task: taskInput({ deps: [] }) }),
    ev('task.created', { teamId: 'alpha', taskId: 'k2', task: taskInput({ deps: ['k1'] }) }),
    ev('task.participate', { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta', role: 'coop' }),
  ])
  const beta = foldEvents('beta', [
    ev('rules.version.adopted', { version: 1 }),
    ev('team.created', { teamId: 'beta', name: '接口评审', goal: 'g' }),
    ev('member.spawned', { teamId: 'beta', memberId: 'm1', roleId: 'implementer', instanceName: 'impl-2', sessionId: 's2', status: 'ok' }),
  ])
  const cols = { backlog: ['backlog', 'ready'], doing: ['in_progress'], done: ['done'] }
  const boardA = buildBoardView({ projectionSnapshot: alpha }, cols, ['backlog', 'doing', 'done'])
  const boardB = buildBoardView({ projectionSnapshot: beta }, cols, ['backlog', 'doing', 'done'])
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t43-proj-'))
  const paths = { projectRolesDir: join(ws, 'config', 'roles') }
  copyToProject(paths, 'implementer', 'builtin')
  const view = buildProjectView({
    workspaceRoot: ws,
    teams: [
      { teamId: 'alpha', name: '结算页', state: 'active', online: true, sessionId: 's-alpha', members: boardA.members, board: boardA },
      { teamId: 'beta', name: '接口评审', state: 'active', online: false, members: boardB.members, board: boardB },
    ],
    entries: listRoleCatalog(paths),
  })
  assert.equal(view.tasks.length, 2)
  const k1 = view.tasks.find((task) => task.key === 'alpha/k1')!
  assert.equal(k1.ownerTeamId, 'alpha')
  assert.deepEqual(k1.participants.map((p) => `${p.teamId}:${p.role}`), ['alpha:lead', 'beta:coop'])
  assert.equal(view.counts.tasks, 2)
  assert.equal(view.counts.teams, 2)
  assert.equal(view.counts.members, 2)
  // 同一角色（implementer）被两个团队聘任 → 两条在册记录（多团队）；只有项目库条目统计聘任
  const impl = view.roles.find((role) => role.id === 'implementer' && role.origin === 'project')!
  assert.equal(view.roles.find((role) => role.id === 'implementer' && role.origin === 'builtin')!.memberships.length, 0)
  assert.equal(impl.memberships.length, 2)
  assert.deepEqual(impl.memberships.map((m) => m.instanceName).sort(), ['impl-1', 'impl-2'])
  // 跨团队复合键的依赖图：k2 依赖 alpha/k1
  assert.equal(view.graph.levels['alpha/k1'], 0)
  assert.equal(view.graph.levels['alpha/k2'], 1)
  assert.deepEqual(view.graph.edges, [{ from: 'alpha/k1', to: 'alpha/k2' }])
})

/* ── 领域校验（参与边） ── */

test('t43-10: 参与边领域校验——主责只能本团队 / 协作不能是自己 / 无参与不能释放主责', () => {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t43-svc-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 'alpha', rolePaths })
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 'alpha', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'plan.approved', payload: { teamId: 'alpha', planId: 'p1' } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'alpha', taskId: 'k1', task: taskInput() } })

  const leadOther = service.commit({ actor: 'lead', type: 'task.participate', payload: { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta', role: 'lead' } })
  assert.equal(leadOther.ok, false)
  assert.equal((leadOther as { code: string }).code, 'MT_VALIDATION')

  const coopSelf = service.commit({ actor: 'lead', type: 'task.participate', payload: { teamId: 'alpha', taskId: 'k1', participantTeamId: 'alpha', role: 'coop' } })
  assert.equal(coopSelf.ok, false)

  const ok = service.commit({ actor: 'lead', type: 'task.participate', payload: { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta', role: 'coop' } })
  assert.equal(ok.ok, true)
  const releaseLead = service.commit({ actor: 'lead', type: 'task.participation.released', payload: { teamId: 'alpha', taskId: 'k1', participantTeamId: 'alpha' } })
  assert.equal(releaseLead.ok, false)
  const releaseCoop = service.commit({ actor: 'lead', type: 'task.participation.released', payload: { teamId: 'alpha', taskId: 'k1', participantTeamId: 'beta' } })
  assert.equal(releaseCoop.ok, true)
})

test('t43-11: 指派领域校验——未知队员被拒（拒绝式，账本不落）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t43-assign-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 'alpha', rolePaths })
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 'alpha', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'plan.approved', payload: { teamId: 'alpha', planId: 'p1' } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 'alpha', taskId: 'k1', task: taskInput() } })
  const bad = service.commit({ actor: 'lead', type: 'task.assigned', payload: { teamId: 'alpha', taskId: 'k1', memberId: 'ghost', memberIds: ['ghost'] } })
  assert.equal(bad.ok, false)
  assert.equal((bad as { code: string }).code, 'MT_VALIDATION')
})
