/**
 * CHG-70（FR-25）：任务 / 团队编辑能力。
 *
 * 背景：`myteam_update_task`（非 rescope 分支）此前误用 `task.created` 覆盖整条任务，
 * 会把状态打回 backlog、清空 attempt 与证据；`task.rescoped` 也从未把 patch 合进任务输入。
 * 本文件锁定修复后的语义：
 *  - 编辑 = 账本追加 `task.updated`（白名单补丁合并），**不改状态机 / attempt / 证据**；
 *  - rescope = 状态出口 + 同一份补丁合并；
 *  - 团队名/目标编辑 = `team.updated`；
 *  - 校验拒绝式：空补丁 / 未知字段 / 依赖环 / 名册外角色；冷启动重放一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, slugifyTeamName, type HostRuntime } from '../src/host.ts'
import { TeamService } from '../src/core/service.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  return host
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'], ...over,
})

function approvedTeam(root: string) {
  const host = setup(root)
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  assert.equal(sub.status, 'staged')
  const ap = host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  assert.equal(ap.status, 'approved')
  return { host, teamId: sub.teamId as string }
}

function ledgerEvents(root: string, teamId: string): any[] {
  const path = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('t44-1: 编辑任务 = 追加 task.updated，状态/attempt/证据不变（修旧实现覆盖整条任务）', () => {
  const root = mkdtempSync(join(tmpdir(), 't44-edit-'))
  const { host, teamId } = approvedTeam(root)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: '原始标题' }) }, {}) as any
  // 就绪前的结构编辑（AC 属结构字段；此时不在跑，允许）
  const early = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch: { acceptanceCriteria: ['AC1', 'AC2'] } }, {}) as any
  assert.equal(early.status, 'updated')
  const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
  const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
  host.executeMemberTool(member, 'myteam_update_task', { taskId: cr.taskId, attemptId: claim.attemptId, status: 'in_progress', progress: '跑着' })
  host.executeMemberTool(member, 'myteam_update_task', {
    taskId: cr.taskId, attemptId: claim.attemptId, status: 'done', summary: 's',
    evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0 }] },
  })
  // 进入门禁（review 待裁决）
  const before = host.service(teamId).projectionSnapshot.tasks[cr.taskId]
  assert.equal(before.state, 'gate:review')
  assert.equal(before.evidenceRefs.length, 1)

  const edit = host.executeLeadTool('myteam_edit_task', {
    teamId, taskId: cr.taskId,
    patch: { title: '改后的标题', description: '新描述', priority: 'P1' },
  }, {}) as any
  assert.equal(edit.status, 'updated')

  const after = host.service(teamId).projectionSnapshot.tasks[cr.taskId]
  assert.equal(after.state, 'gate:review', '编辑不改状态机（旧实现会打回 backlog）')
  assert.equal(after.evidenceRefs.length, 1, '证据链保留')
  assert.equal(after.input.title, '改后的标题')
  assert.equal(after.input.description, '新描述')
  assert.deepEqual(after.input.acceptanceCriteria, ['AC1', 'AC2'], '就绪前改的 AC 保留')
  assert.equal(after.input.priority, 'P1')
  // 账本上是 task.updated 而不是新的 task.created
  const events = ledgerEvents(root, teamId)
  assert.equal(events.filter((e) => e.type === 'task.created' && e.payload.taskId === cr.taskId).length, 1, '不能再落 task.created')
  assert.ok(events.some((e) => e.type === 'task.updated' && e.payload.taskId === cr.taskId), '落 task.updated')
})

test('t44-2: 编辑校验拒绝式——空补丁 / 未知字段 / 依赖环 / 名册外角色', () => {
  const root = mkdtempSync(join(tmpdir(), 't44-reject-'))
  const { host, teamId } = approvedTeam(root)
  const t1 = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const t2 = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ deps: [t1.taskId], deliverableSpec: undefined }) }, {}) as any

  const empty = host.executeLeadTool('myteam_edit_task', { teamId, taskId: t1.taskId, patch: {} }, {}) as any
  assert.equal(empty.status, 'error')
  assert.equal(empty.code, 'MT_VALIDATION')

  const unknown = host.executeLeadTool('myteam_edit_task', { teamId, taskId: t1.taskId, patch: { state: 'done' } }, {}) as any
  assert.equal(unknown.status, 'error')
  assert.match(String(unknown.message), /unknown patch field/)

  const cycle = host.executeLeadTool('myteam_edit_task', { teamId, taskId: t1.taskId, patch: { deps: [t2.taskId] } }, {}) as any
  assert.equal(cycle.status, 'error')
  assert.match(String(cycle.message), /cycle/)

  const badRole = host.executeLeadTool('myteam_edit_task', { teamId, taskId: t1.taskId, patch: { requiredRole: 'ghost-role' } }, {}) as any
  assert.equal(badRole.status, 'error')
  assert.match(String(badRole.message), /not in roster/)

  const badAc = host.executeLeadTool('myteam_edit_task', { teamId, taskId: t1.taskId, patch: { acceptanceCriteria: [] } }, {}) as any
  assert.equal(badAc.status, 'error')
  // 失败不落账：账本里没有 task.updated
  assert.ok(!ledgerEvents(root, teamId).some((e) => e.type === 'task.updated'))
})

test('t44-3: rescope 同时应用补丁（旧实现只迁状态、补丁丢失）', () => {
  const root = mkdtempSync(join(tmpdir(), 't44-rescope-'))
  const { host, teamId } = approvedTeam(root)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
  const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
  const esc = host.executeMemberTool(member, 'myteam_escalate_task', {
    taskId: cr.taskId, reason: 'AC 不可达', evidence: { attempted: '试了', blockedAt: '卡在权限' },
  }) as any
  assert.equal(esc.status, 'escalated')
  assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].state, 're-scoping')

  const rescope = host.executeLeadTool('myteam_edit_task', {
    teamId, taskId: cr.taskId, rescope: { reason: '收窄' },
    patch: { acceptanceCriteria: ['只验主路径'], description: '收窄后的描述' },
  }, {}) as any
  assert.equal(rescope.status, 'rescoped')
  const t = host.service(teamId).projectionSnapshot.tasks[cr.taskId]
  assert.equal(t.state, 'ready')
  assert.deepEqual(t.input.acceptanceCriteria, ['只验主路径'])
  assert.equal(t.input.description, '收窄后的描述')
})

test('t44-4: 团队名/目标编辑（team.updated）；空值被拒；冷启动重放一致', () => {
  const root = mkdtempSync(join(tmpdir(), 't44-team-'))
  const { host, teamId } = approvedTeam(root)
  const r = host.executeLeadTool('myteam_update_team', { teamId, name: '新名字', goal: '新目标' }, {}) as any
  assert.equal(r.status, 'updated')
  const proj = host.service(teamId).projectionSnapshot
  assert.equal(proj.name, '新名字')
  assert.equal(proj.goal, '新目标')

  const bad = host.executeLeadTool('myteam_update_team', { teamId, name: '  ' }, {}) as any
  assert.equal(bad.status, 'error')
  const none = host.executeLeadTool('myteam_update_team', { teamId }, {}) as any
  assert.equal(none.status, 'error')

  // 冷启动重放：新 TeamService 从账本重建，名称/目标/任务补丁一致
  const svc = new TeamService({
    workspaceRoot: root, teamId,
    rolePaths: { projectRolesDir: join(root, '.dsh-myteam', 'config', 'roles') },
  })
  assert.equal(svc.projectionSnapshot.name, '新名字')
  assert.equal(svc.projectionSnapshot.goal, '新目标')
  assert.ok(ledgerEvents(root, teamId).some((e) => e.type === 'team.updated'))
})

test('t44-5: 中文团队名派生稳定且互不相同的 teamId；active 团队被重复提交时拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 't44-id-'))
  // 纯中文名：稳定哈希 id，不同名不同 id（旧实现固定回退 'team'，两个团队会撞同一账本）
  assert.match(slugifyTeamName('结算模块'), /^team-[0-9a-f]{6}$/)
  assert.equal(slugifyTeamName('结算模块'), slugifyTeamName('结算模块'))
  assert.notEqual(slugifyTeamName('结算模块'), slugifyTeamName('接口评审'))
  // ASCII 名仍走 slug
  assert.equal(slugifyTeamName('Settle Module'), 'settle-module')

  const host = setup(root)
  const base = { goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }
  const a = host.executeLeadTool('myteam_submit_plan', { ...base, teamName: '结算模块' }, {}) as any
  assert.equal(a.status, 'staged')
  const b = host.executeLeadTool('myteam_submit_plan', { ...base, teamName: '接口评审' }, {}) as any
  assert.equal(b.status, 'staged')
  assert.notEqual(a.teamId, b.teamId)

  const approve = host.executeLeadTool('myteam_approve_plan', { teamId: a.teamId }, {}) as any
  assert.equal(approve.status, 'approved')
  const again = host.executeLeadTool('myteam_submit_plan', { ...base, teamName: '结算模块' }, {}) as any
  assert.equal(again.status, 'error')
  assert.equal(again.code, 'MT_TEAM_STATE')
  // 被拒后团队仍是 active（不会被打回 draft）
  assert.equal(host.service(a.teamId).projectionSnapshot.state, 'active')
})
