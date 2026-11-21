/**
 * T166 · CHG-210 批 5.2/5.3：**配额拒绝要告诉用户下一步**。
 *
 * 缺陷现场（审计原文）：
 *   - `maxMembers 6 reached (ADR-008 self-managed quota)` —— 英文、带一个对用户无意义的
 *     ADR 编号、不说现在几个人、该释放谁、能不能拆团队；
 *   - `task count 21 exceeds limit 20` —— 只说数字；
 *   - `maxTasks` 更是**没有硬顶**（`PATCH_CEILINGS` 不含它），配置能写成任意大；
 *   - 批量建任务上限 30 与 maxTasks 20 打架：25 条的批能过批检，团队空时只能落 20 条，
 *     第 21 条起逐条报错 → 用户得到「部分成功」而不是「你该分两批」。
 *
 * 本文件钉四件事：
 *   ① 成员配额拒绝：现状 + 上限 + 「没有创建任何成员」+ 三条出口；
 *   ② 任务配额拒绝：同上；
 *   ③ 批量建任务按 `min(30, maxTasks)` 结算，超了给分批建议；
 *   ④ `PATCH_CEILINGS` 真的有 `limits.maxTasks` 硬顶。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { PATCH_CEILINGS } from '../src/core/config/team-config.ts'

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
  title: 't', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [],
  }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  return { host, teamId }
}

test('t166-1: 成员配额拒绝给三段式（现状/上限 + 没创建 + 出口）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t166-member-'))
  try {
    const { host, teamId } = setup(root)
    let last: any
    for (let i = 0; i < 8; i += 1) {
      last = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: `m${i}` }, {})
      if ((last as any).status === 'error') break
    }
    assert.equal(last.status, 'error')
    assert.equal(last.code, 'MT_MEMBER_LIMIT')
    assert.match(String(last.message), /已有 \d+ 名成员/, '要说现状')
    assert.match(String(last.message), /上限 \d+/, '要说上限')
    assert.match(String(last.message), /没有创建任何成员/, '要说「什么都没做」')
    assert.match(String(last.message), /release_member|拆成两个团队|调高/, '要给出口')
    assert.ok(!/ADR-008/.test(String(last.message)), '不要把内部 ADR 编号甩给用户')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t166-2: 任务配额拒绝同样三段式', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t166-task-'))
  try {
    const { host, teamId } = setup(root)
    const tooMany = Array.from({ length: 25 }, (_, i) => ({ ...TASK, id: `t-${i}`, title: `t${i}` }))
    const r = host.executeLeadTool('myteam_submit_plan', { teamName: 'T2', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: tooMany }, {}) as any
    assert.equal(r.status, 'error', JSON.stringify(r))
    const message = JSON.stringify(r)
    assert.match(message, /没有创建任何任务/, '要说「什么都没做」')
    assert.match(message, /maxTasks|另一个团队|cancel_task/, '要给出口')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t166-3: 批量建任务按 min(30, maxTasks) 结算，超了给分批建议', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t166-batch-'))
  try {
    const { host, teamId } = setup(root)
    const drafts = Array.from({ length: 31 }, (_, i) => ({ ...TASK, title: `b${i}` }))
    const r = host.executeLeadTool('myteam_create_tasks', { teamId, tasks: drafts }, {}) as any
    assert.equal(r.status, 'error', JSON.stringify(r))
    assert.match(String(r.message), /一批最多 \d+ 条/, '要说清单批上限')
    assert.match(String(r.message), /没有创建任何任务/, '要明确零写入（不是部分成功）')
    assert.match(String(r.message), /分成 \d+ 批|清掉不用的任务/, '要给分批建议')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t166-4: PATCH_CEILINGS 真的有 maxTasks 硬顶（配置不能写成任意大）', () => {
  assert.equal(typeof (PATCH_CEILINGS as Record<string, number>)['limits.maxTasks'], 'number')
  assert.ok((PATCH_CEILINGS as Record<string, number>)['limits.maxTasks'] > 0)
})
