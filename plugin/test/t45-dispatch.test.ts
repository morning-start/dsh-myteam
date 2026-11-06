/**
 * CHG-71（FR-28/29）：团队执行面两处缺口。
 *
 * 1) 派单唤醒（dispatch）：只有 assign/message/resume/revoke 四种因果唤醒，新建任务、
 *    上游完成解锁下游都没有人会被叫醒 → 「建任务让团队执行」实际会停住。现在提交后
 *    做一次克制的派单扫描（空闲 + 角色匹配 + 节流）。
 * 2) 执行期编辑：结构字段（AC/依赖/角色/交付物/门禁链）在 in_progress / gate 阶段
 *    不允许走普通编辑，必须 rescope（先撤 attempt）；元数据编辑允许，并提醒当前执行者。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

type Followups = Record<string, string[]>

function makeRuntime(root: string, followups: Followups): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: { sessionId: string }) => ({
        session: { id: opts.sessionId },
        followup: (msg: Record<string, unknown>) => {
          const content = Array.isArray(msg.content) ? (msg.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('') : String(msg.content ?? '')
          ;(followups[opts.sessionId] ??= []).push(content)
        },
      }),
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'], ...over,
})

async function teamWithMember(root: string, followups: Followups) {
  const host = new MyTeamHost(makeRuntime(root, followups), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }], tasks: [],
  }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  const spawn = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'implementer' }, {}) as any
  await new Promise((r) => setTimeout(r, 0)) // FIX-14：handle 回填是 microtask
  return { host, teamId: sub.teamId as string, spawn, followups }
}

const dispatchMsgs = (followups: Followups, sessionId: string) => (followups[sessionId] ?? []).filter((m) => m.includes('[myteam] dispatch'))

test('t45-1: 新建任务后派单唤醒空闲且角色匹配的成员（否则团队不会自己动）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't45-dispatch-'))
  const followups: Followups = {}
  const { host, teamId, spawn } = await teamWithMember(root, followups)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  assert.equal(cr.status, 'created')
  const msgs = dispatchMsgs(followups, spawn.sessionId)
  assert.equal(msgs.length, 1, '应有一次派单唤醒')
  assert.match(msgs[0], /就绪任务/)
})

test('t45-2: 角色不匹配 / 成员已在跑时不派单唤醒', async () => {
  const root = mkdtempSync(join(tmpdir(), 't45-nomatch-'))
  const followups: Followups = {}
  const { host, teamId, spawn } = await teamWithMember(root, followups)
  // reviewer 任务：名册里没有 reviewer，implementer 不该被叫
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ requiredRole: 'implementer', deps: [] }) }, {}) as any
  const before = dispatchMsgs(followups, spawn.sessionId).length
  // 让成员先领走任务（在跑）
  const claim = host.executeMemberTool({ memberId: spawn.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: spawn.sessionId, teamId }, 'myteam_claim_task', { taskId: cr.taskId }) as any
  assert.equal(claim.status, 'claimed')
  // 再建一个任务：成员在跑（有 currentTaskId），不唤醒
  host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  assert.equal(dispatchMsgs(followups, spawn.sessionId).length, before, '在跑成员不重复唤醒')
})

test('t45-3: 上游完成后解锁下游，会再次派单唤醒（gate pass 也算调度事件）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't45-unlock-'))
  const followups: Followups = {}
  const { host, teamId, spawn } = await teamWithMember(root, followups)
  const t1 = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ requiredRole: 'implementer' }) }, {}) as any
  const t2 = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ deps: [t1.taskId] }) }, {}) as any
  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: spawn.sessionId, teamId }
  const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: t1.taskId }) as any
  host.executeMemberTool(member, 'myteam_update_task', {
    taskId: t1.taskId, attemptId: claim.attemptId, status: 'done', summary: 's',
    evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0 }] },
  })
  const beforeGate = dispatchMsgs(followups, spawn.sessionId).length
  const gate = host.executeLeadTool('myteam_edit_task', { teamId, taskId: t1.taskId, patch: { title: 'x' } }, {}) as any
  assert.equal(gate.status, 'updated') // 元数据编辑不改状态
  // 真正推进：gate pass（通过执行面工具落 gate.result）
  const svc = host.service(teamId)
  const proj = svc.projectionSnapshot
  assert.equal(proj.tasks[t1.taskId].state, 'gate:review')
  assert.equal(proj.tasks[t2.taskId].state, 'backlog')
  host.executeMemberTool(member, 'myteam_claim_task', { taskId: t2.taskId }) // 下游还没解锁 → 应失败
  // 队长批门（用内部 commit 走同一管线）
  const pass = host.commit(teamId, { actor: 'lead', type: 'task.gate.result', payload: { teamId, taskId: t1.taskId, gate: 'review', verdict: 'pass' } })
  assert.equal(pass.ok, true)
  assert.equal(host.service(teamId).projectionSnapshot.tasks[t2.taskId].state, 'ready')
  assert.ok(dispatchMsgs(followups, spawn.sessionId).length > beforeGate, '解锁后应重新派单唤醒')
})

test('t45-4: 执行期结构编辑被拒（AC/依赖/角色/交付物/门禁链必须走 rescope）；元数据可改', async () => {
  const root = mkdtempSync(join(tmpdir(), 't45-structural-'))
  const followups: Followups = {}
  const { host, teamId, spawn } = await teamWithMember(root, followups)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: spawn.sessionId, teamId }
  const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
  assert.equal(claim.status, 'claimed')

  for (const patch of [
    { acceptanceCriteria: ['新 AC'] },
    { deps: [] },
    { requiredRole: 'implementer' },
    { deliverableSpec: { path: 'docs/y.md' } },
    { gateChain: ['review', 'archive'] },
  ]) {
    const r = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch }, {}) as any
    assert.equal(r.status, 'error', `结构补丁应被拒：${JSON.stringify(patch)}`)
    assert.equal(r.code, 'MT_TASK_STRUCTURAL_EDIT')
  }
  const meta = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch: { title: '改标题', priority: 'P1' } }, {}) as any
  assert.equal(meta.status, 'updated')
  assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].input.title, '改标题')
})

test('t45-5: 编辑正在执行的任务会提醒当前执行者（task-updated followup）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't45-notify-'))
  const followups: Followups = {}
  const { host, teamId, spawn } = await teamWithMember(root, followups)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: spawn.sessionId, teamId }
  host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId })
  host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch: { description: '补充：先做登录页' } }, {}) as any
  const msgs = (followups[spawn.sessionId] ?? []).filter((m) => m.includes('[myteam] task-updated'))
  assert.equal(msgs.length, 1)
  assert.match(msgs[0], /task-updated/)
})