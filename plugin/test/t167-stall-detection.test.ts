/**
 * T167 · CHG-210 批 5.4：**「卡住多久了」要能算出来**。
 *
 * 缺陷现场：投影里只有 `createdAt` / `waitingSince` / `lastEditAt` / `cancelledAt` 这些
 * 「事件发生时刻」，**没有任何「最近一次进展」的事实**。于是：
 *   - 任务领走两小时不动，系统没有任何信号（看板永远显示「进行中」）；
 *   - 上游一直停在 ready 没人领，下游就在 backlog 里安静地烂掉。
 *
 * 修法分两层（本文件钉这两层）：
 *   ① 投影记 `lastProgressAt`（claim / progress / evidence / 裁决 / 编辑各更新一次）；
 *   ② `stallOf(task, now)` 纯函数算年龄——`now` 由调用方传，**不放进投影**，
 *      否则同一本账本两次重放会得出不同结果（t124 的纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { stallOf, DEFAULT_STALL_MS } from '../src/core/tasks/readiness.ts'
import type { TaskProjection } from '../src/core/scheduler/state.ts'

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
  title: '停滞用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

/** 造一个「只有判定相关字段」的投影对象 */
const proj = (over: Partial<TaskProjection>): TaskProjection => ({
  id: 't1', state: 'in_progress', createdAt: 1_000_000,
  input: { title: 'x', description: '', acceptanceCriteria: [], deliverableSpec: { path: 'x', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' }, deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S', priority: 'P2', gateChain: ['review'] } as any,
  evidenceRefs: [], deliverables: [],
  ...over,
} as unknown as TaskProjection)

test('t167-1: in_progress 超阈值 → 报年龄（参照 lastProgressAt）', () => {
  const now = 10_000_000
  const t = proj({ lastProgressAt: now - DEFAULT_STALL_MS - 1000 })
  const s = stallOf(t, now)
  assert.ok(s, '超过阈值必须报')
  assert.equal(s.basedOn, 'lastProgressAt')
  assert.ok(s.stalledFor >= DEFAULT_STALL_MS)
})

test('t167-2: 刚有进展（未超阈值）→ 不报', () => {
  const now = 10_000_000
  assert.equal(stallOf(proj({ lastProgressAt: now - 1000 }), now), undefined)
})

test('t167-3: ready 用 waitingSince（等领取太久也是停滞）', () => {
  const now = 10_000_000
  const s = stallOf(proj({ state: 'ready', waitingSince: now - DEFAULT_STALL_MS - 1 }), now)
  assert.ok(s)
  assert.equal(s.basedOn, 'waitingSince')
})

test('t167-4: 门禁态与终态不判（它们本来就在等人，不是停滞）', () => {
  const now = 10_000_000
  for (const state of ['gate:review', 'gate:verify', 'done', 'cancelled', 'failed'] as const) {
    assert.equal(stallOf(proj({ state }), now), undefined, `${state} 不该被判停滞`)
  }
})

test('t167-5: claim 之后投影有 lastProgressAt（判定的事实底座真的被写进去）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t167-progress-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    const teamId = String(sub.teamId)
    host.executeLeadTool('myteam_approve_plan', { teamId }, {})
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
    const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
    host.executeMemberTool({ memberId: String(a.memberId), roleId: 'implementer', instanceName: 'a', sessionId: String(a.sessionId), teamId }, 'myteam_claim_task', { taskId: created.taskId })

    const t = host.service(teamId).projectionSnapshot.tasks[created.taskId]
    assert.equal(typeof t.lastProgressAt, 'number', 'claim 必须写 lastProgressAt（否则停滞判定没有参照点）')
    assert.ok(stallOf(t, Date.now()) === undefined, '刚 claim 的任务不该被判停滞')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
