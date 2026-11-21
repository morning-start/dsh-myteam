/**
 * T171 · CHG-210 批 6.4：**释放时的排空面必须如实**。
 *
 * 缺陷现场：`releaseMember` 的 `drained` 是 `{ running: 0, pending: ... }`——`running` 恒为 0。
 * 更糟的是注释写着「原实现硬编码 running:0，「排空完成」是假的」（CHG-93），
 * **那次只改了注释没改代码**。后果：账本上每次释放都记着「没有在跑的任务」，
 * 就算成员手上还挂着任务也一样——「排空完成」是假的。
 *
 * 本文件钉两件事：
 *   ① 成员没有在跑任务时，账本 `member.released.drained.running === 0`（正常路径不变）；
 *   ② 成员**有**在跑任务时，释放被 `drain-pending` 拒（不能一边说排空一边放行）。
 *      —— ② 是「① 的对照」：如果 running 恒 0，这道闸就永远不会触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  title: '排空面用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const as = (m: any) => ({ memberId: String(m.memberId), roleId: String(m.roleId), instanceName: String(m.instanceName ?? m.memberId), sessionId: String(m.sessionId), teamId })
  return { host, teamId, taskId: String(created.taskId), a: as(a), rawA: a }
}

const releasedEvents = (root: string, teamId: string) =>
  readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    .filter((e) => e.type === 'member.released')

test('t171-1: 成员没有在跑任务 → 释放成功，账本 drained.running = 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t171-idle-'))
  try {
    const { host, teamId, a } = setup(root)
    const r = host.executeLeadTool('myteam_release_member', { teamId, memberId: a.memberId, mode: 'suspend' }, {}) as any
    assert.equal(r.status, 'suspend', JSON.stringify(r))
    const events = releasedEvents(root, teamId)
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.drained.running, 0, '闲置成员释放时 running 应为 0')
    assert.equal(typeof events[0].payload.drained.pending, 'number')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t171-2: 成员有在跑任务 → 释放被 drain-pending 拒（对照：running 不是恒 0）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t171-busy-'))
  try {
    const { host, teamId, taskId, a } = setup(root)
    assert.equal((host.executeMemberTool(a, 'myteam_claim_task', { taskId }) as any).status, 'claimed')
    const r = host.executeLeadTool('myteam_release_member', { teamId, memberId: a.memberId, mode: 'suspend' }, {}) as any
    assert.equal(r.status, 'drain-pending', JSON.stringify(r))
    assert.equal(r.code, 'MT_DRAIN_PENDING')
    assert.equal(r.running, 1, '要说清还有 1 个在跑')
    assert.equal(releasedEvents(root, teamId).length, 0, '被拒的释放不得落账')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})