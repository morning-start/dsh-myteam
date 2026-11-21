/**
 * T170 · CHG-210 批 6.1：**队长能拿到 proposalId**。
 *
 * 缺陷现场：`proposalId` 只回给提交者，队长侧没有任何列表面——`read_task` 的 timeline
 * 只有 `seq/ts/actor/type` 不带 payload，而 `resolve_proposal` 又必须要 proposalId。
 * 于是 FR-11.4「队长批准才生效」在工具面**断链**：实际只能人去 `ledger.jsonl` 里抄 id。
 *
 * 本文件钉三件事：
 *   ① 成员提了提案后，队长 `list_proposals` 能拿到 proposalId / taskId / type / 提交者；
 *   ② 默认只看 `proposed`，`status:'all'` 能看到已处置的；
 *   ③ 没有提案时返回空数组（不编造）。
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
  title: '提案清单用例', description: 'd', acceptanceCriteria: ['AC1'],
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
  return { host, teamId, taskId: String(created.taskId), a: as(a) }
}

test('t170-1: 成员提提案后，队长能列出 proposalId 与提交者', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t170-list-'))
  try {
    const { host, teamId, taskId, a } = setup(root)
    const proposed = host.executeMemberTool(a, 'myteam_propose_task_change', { taskId, type: 'split', payload: { subtasks: [{ title: 'a' }, { title: 'b' }] }, note: '太大了' }) as any
    assert.equal(proposed.status, 'proposed', JSON.stringify(proposed))

    const listed = host.executeLeadTool('myteam_list_proposals', { teamId }, {}) as any
    assert.equal(listed.status, 'ok', JSON.stringify(listed))
    assert.equal(listed.count, 1)
    const item = listed.proposals[0]
    assert.equal(item.taskId, taskId)
    assert.equal(item.type, 'split')
    assert.equal(item.status, 'proposed')
    assert.equal(typeof item.proposalId, 'string')
    assert.ok(item.proposalId.length > 0, 'proposalId 必须能直接拿去调 resolve_proposal')
    assert.equal(item.proposerId, a.memberId, '要能看出是谁提的（驳回时要通知他）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t170-2: 处置后默认不再列出，status:all 能看到', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t170-status-'))
  try {
    const { host, teamId, taskId, a } = setup(root)
    host.executeMemberTool(a, 'myteam_propose_task_change', { taskId, type: 'split', payload: { subtasks: [{ title: 'a' }, { title: 'b' }] }, note: '太大了' })
    const first = (host.executeLeadTool('myteam_list_proposals', { teamId }, {}) as any).proposals[0]
    const resolved = host.executeLeadTool('myteam_resolve_proposal', { teamId, proposalId: first.proposalId, decision: 'rejected', note: '不急' }, {}) as any
    assert.equal(resolved.status, 'rejected', JSON.stringify(resolved))

    assert.equal((host.executeLeadTool('myteam_list_proposals', { teamId }, {}) as any).count, 0, '默认只看 proposed')
    const all = host.executeLeadTool('myteam_list_proposals', { teamId, status: 'all' }, {}) as any
    assert.equal(all.count, 1)
    assert.equal(all.proposals[0].status, 'rejected')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t170-3: 没有提案时返回空数组（不编造）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t170-empty-'))
  try {
    const { host, teamId } = setup(root)
    const r = host.executeLeadTool('myteam_list_proposals', { teamId }, {}) as any
    assert.equal(r.status, 'ok', JSON.stringify(r))
    assert.equal(r.count, 0)
    assert.deepEqual(r.proposals, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})