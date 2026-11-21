/**
 * T162 · CHG-210 批 3：**attemptId 不是通行证**——票据只对它的持有人有效。
 *
 * 缺陷现场：`checkAttempt` 只比 `attemptId === task.attemptId`，不看调用者是不是 assignee。
 * 于是任何一个成员（或从日志/会话考古里捡到那张票的模型）都能对**别人的**任务写
 * `evidence` / `completed` / `progress`——`assignee` 字段形同虚设。
 * （审计里同时发现 `t48-9` 自己就在用伪造的 `actor: 'member:implementer'` 写别人的任务，
 * 这也解释了为什么旧测试圈不出这个问题。）
 *
 * 修法的关键是**信道**：`actor` 由宿主按会话注入（`member:<id>`），不是模型可自报的入参；
 * 拿它比 `assignee` 才有意义。队长/人类不受限（他们本来就能代成员处置）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

const TASK = {
  title: '票据绑人用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

const EVIDENCE = { kind: 'na', na: { reason: '手工核对' } }

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const b = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'b' }, {}) as any
  const member = (spawned: any) => ({ memberId: String(spawned.memberId), roleId: 'implementer', instanceName: String(spawned.instanceName ?? spawned.memberId), sessionId: String(spawned.sessionId), teamId })
  const claimed = host.executeMemberTool(member(a), 'myteam_claim_task', { taskId: created.taskId }) as any
  assert.equal(claimed.status, 'claimed', JSON.stringify(claimed))
  const attemptId = host.service(teamId).projectionSnapshot.tasks[created.taskId].attemptId!
  return { host, teamId, taskId: String(created.taskId), attemptId, a: member(a), b: member(b) }
}

test('t162-1: 成员 B 拿 A 的 attemptId 写 A 的任务 → MT_ATTEMPT_FOREIGN（账本零改动）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t162-foreign-'))
  try {
    const { host, teamId, taskId, attemptId, a, b } = setup(root)
    const before = host.service(teamId).projectionSnapshot.tasks[taskId].evidenceRefs.length

    const r = host.commit(teamId, { actor: `member:${b.memberId}`, type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: EVIDENCE } })
    assert.equal(r.ok, false, '别人的票据必须被拒')
    assert.equal((r as any).code, 'MT_ATTEMPT_FOREIGN')
    assert.match(String((r as any).message), new RegExp(a.memberId), '提示要点名真实归属')

    const after = host.service(teamId).projectionSnapshot.tasks[taskId]
    assert.equal(after.evidenceRefs.length, before, '被拒的写入不得落账')
    assert.equal(after.assignee, a.memberId, '归属不变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t162-2: 持有人自己写 → 通过（修法不能把正常路径一起拦掉）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t162-own-'))
  try {
    const { host, teamId, taskId, attemptId, a } = setup(root)
    const r = host.commit(teamId, { actor: `member:${a.memberId}`, type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: EVIDENCE } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].evidenceRefs.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t162-3: 队长代成员处置不受限（lead 用同一张票写 → 通过）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t162-lead-'))
  try {
    const { host, teamId, taskId, attemptId } = setup(root)
    const r = host.commit(teamId, { actor: 'lead', type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: EVIDENCE } })
    assert.equal(r.ok, true, '队长/人类本来就能代成员处置，不该被票据绑人挡住')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t162-4: 人类 actor 同样不受限', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t162-human-'))
  try {
    const { host, teamId, taskId, attemptId } = setup(root)
    const r = host.commit(teamId, { actor: 'human', type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: EVIDENCE } })
    assert.equal(r.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
