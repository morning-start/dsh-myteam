/**
 * T158 · CHG-207（P1-8）：**冷启动恢复真的接线了，且 blocked 真的能落地**。
 *
 * 修复前的两个断点（都已在真实会话里造成过损失）：
 *  ① `recoverOnBoot` 写在 `host.ts` 里、`initialize()` **从没调它**——重启一次，所有滞留在
 *     `in_progress` 的任务就变成无人推进的僵尸（看板永远「运行中」，attempt 不撤、不重派、
 *     也不阻塞）；
 *  ② `to-blocked` 分支只往返回的 `actions[]` 塞字符串，**账本零写入**——恢复表算出「该停下
 *     等人」，落账什么都没发生，下次启动再算一遍同样的结论。
 *
 * 本文件钉住四件事：
 *  ① `task.blocked` 是**一等事件**（进 EVENT_TYPES、fold 落状态并留痕、重放幂等）；
 *  ② `initialize()` 自动恢复（不需要任何人手动调）；
 *  ③ **重试上限**：同一任务反复崩 → 转 blocked 交给人，不再无限重跑；
 *  ④ blocked 不是终态：人工 `rescope` 能放行回 ready。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { EVENT_TYPES } from '../src/core/ledger/ledger.ts'
import { MAX_RECOVERY_ATTEMPTS } from '../src/core/scheduler/recovery.ts'
import { foldEvents } from '../src/core/scheduler/fold.ts'

function makeRuntime(root: string, agents?: unknown): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    ...(agents ? { agents } : {}),
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

/** 一次「进程重启」：新 host 实例 + initialize（CHG-207 起 initialize 会自动跑恢复） */
function boot(root: string, agents?: unknown): MyTeamHost {
  const host = new MyTeamHost(makeRuntime(root, agents))
  host.initialize()
  return host
}

const TASK = {
  title: '恢复用例任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

const ledgerOf = (root: string, teamId: string) =>
  readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

test('t158-1: task.blocked 是一等事件 —— 进白名单、fold 落 blocked 并留痕、重放幂等', () => {
  assert.ok((EVENT_TYPES as readonly string[]).includes('task.blocked'), 'EVENT_TYPES 必须有 task.blocked')

  const base = foldEvents('t1', [
    { seq: 1, ts: 100, actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'T', goal: 'G', roster: [] } } as never,
    { seq: 2, ts: 110, actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'task-1', task: TASK } } as never,
  ])
  assert.equal(base.tasks['task-1'].state, 'backlog')

  const blockedEvent = { seq: 3, ts: 200, actor: 'host', type: 'task.blocked', payload: { teamId: 't1', taskId: 'task-1', reason: 'boom', recovery: true } } as never
  const folded = foldEvents('t1', [
    { seq: 1, ts: 100, actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'T', goal: 'G', roster: [] } } as never,
    { seq: 2, ts: 110, actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'task-1', task: TASK } } as never,
    blockedEvent,
  ])
  const t = folded.tasks['task-1']
  assert.equal(t.state, 'blocked', 'fold 必须真的落 blocked（不是 rescoped 那种会被转回 ready 的路径）')
  assert.equal(t.blockedAt, 200)
  assert.equal(t.blockedReason, 'boom')
  /* 重放幂等：同一条账本折叠两次结果逐字段相同（恢复会重复触发，投影不能漂） */
  assert.deepEqual(folded, foldEvents('t1', [
    { seq: 1, ts: 100, actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'T', goal: 'G', roster: [] } } as never,
    { seq: 2, ts: 110, actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'task-1', task: TASK } } as never,
    blockedEvent,
  ]))
  /* blocked 不是终态：状态机给了出口（人工放行），这正是它与 failed 的区别 */
  const after = foldEvents('t1', [
    { seq: 1, ts: 100, actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'T', goal: 'G', roster: [] } } as never,
    { seq: 2, ts: 110, actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'task-1', task: TASK } } as never,
    blockedEvent,
    { seq: 4, ts: 300, actor: 'human', type: 'task.rescoped', payload: { teamId: 't1', taskId: 'task-1', reason: '环境修好了', patch: {} } } as never,
  ])
  assert.equal(after.tasks['task-1'].state, 'ready', 'blocked → ready（人工 rescope 放行）')
})

test('t158-2: initialize() 自动恢复 —— 重启后滞留 attempt 被撤、任务回 ready（不需要手动调）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t158-auto-'))
  try {
    const agents = { create: () => ({ followup: () => {}, session: {} }) }
    const first = boot(root, agents)
    const sub = first.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    first.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})
    const cr = first.executeLeadTool('myteam_create_task', { teamId: sub.teamId, task: TASK }, {}) as any
    const spawn = first.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId: sub.teamId }
    const claim = first.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
    assert.equal(claim.status, 'claimed')
    assert.equal(first.service(sub.teamId).projectionSnapshot.tasks[cr.taskId].state, 'in_progress')

    // 重启：**只调 initialize**，没有任何人手动 recover
    const second = boot(root)
    const after = second.service(sub.teamId).projectionSnapshot
    assert.equal(after.tasks[cr.taskId].state, 'ready', '重启后任务必须回 ready（僵尸任务的修复点）')
    assert.equal(after.tasks[cr.taskId].attemptId, undefined, 'attempt 被撤（旧票据不能继续用）')
    const spawnEvents = ledgerOf(root, sub.teamId).filter((e) => e.type === 'task.attempt.revoked')
    assert.equal(spawnEvents.length, 1, '撤权要真落账（不是只在内存里改投影）')
    assert.match(String(spawnEvents[0].payload.reason), /restart recovery/)
    // 幂等：再重启一次没有可恢复项（不会无限写撤权事件）
    const third = boot(root)
    assert.equal(ledgerOf(root, sub.teamId).filter((e) => e.type === 'task.attempt.revoked').length, 1, '重复启动不得重复落账')
    assert.equal(third.service(sub.teamId).projectionSnapshot.tasks[cr.taskId].state, 'ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t158-3: 重试上限 —— 同一任务反复崩 → 真落 task.blocked（不再无限重跑）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t158-blocked-'))
  try {
    const agents = { create: () => ({ followup: () => {}, session: {} }) }
    let host = boot(root, agents)
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    const teamId = String(sub.teamId)
    host.executeLeadTool('myteam_approve_plan', { teamId }, {})
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }

    // 每轮：claim（世代号 +1）→ 重启（自动恢复）
    for (let round = 1; round <= MAX_RECOVERY_ATTEMPTS; round += 1) {
      const claim = host.executeMemberTool({ ...member }, 'myteam_claim_task', { taskId: cr.taskId }) as any
      assert.equal(claim.status, 'claimed', `第 ${round} 轮 claim 失败：${JSON.stringify(claim)}`)
      const proj = host.service(teamId).projectionSnapshot
      assert.equal(proj.tasks[cr.taskId].attempt, round, `第 ${round} 轮世代号应为 ${round}`)
      host = boot(root)
    }

    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.tasks[cr.taskId].state, 'blocked', `崩溃 ${MAX_RECOVERY_ATTEMPTS} 次后必须转 blocked（不再重跑）`)
    assert.match(String(proj.tasks[cr.taskId].blockedReason), /restart recovery/)
    const blockedEvents = ledgerOf(root, teamId).filter((e) => e.type === 'task.blocked')
    assert.equal(blockedEvents.length, 1, 'blocked 必须真落账（旧实现只往 actions[] 塞字符串）')
    assert.equal(blockedEvents[0].payload.recovery, true)
    // 再重启也不会把 blocked 复活（只处理 in_progress）
    host = boot(root)
    assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].state, 'blocked', 'blocked 不得被启动恢复自动复活')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t158-4: blocked 可被人工放行 —— rescope 回 ready 并能重新 claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t158-release-'))
  try {
    const agents = { create: () => ({ followup: () => {}, session: {} }) }
    let host = boot(root, agents)
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    const teamId = String(sub.teamId)
    host.executeLeadTool('myteam_approve_plan', { teamId }, {})
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    for (let round = 1; round <= MAX_RECOVERY_ATTEMPTS; round += 1) {
      host.executeMemberTool({ ...member }, 'myteam_claim_task', { taskId: cr.taskId })
      host = boot(root)
    }
    assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].state, 'blocked')

    const rescoped = host.executeLeadTool('myteam_rescope_task', { teamId, taskId: cr.taskId, reason: '环境已修好，重新跑' }, {}) as any
    assert.equal(rescoped.status, 'rescoped', JSON.stringify(rescoped))
    const after = host.service(teamId).projectionSnapshot
    assert.equal(after.tasks[cr.taskId].state, 'ready', '人工放行后回 ready 等新 attempt')
    // 放行后能重新 claim（blocked 的出口是「回去干活」，不是死路）
    const reclaimed = host.executeMemberTool({ ...member }, 'myteam_claim_task', { taskId: cr.taskId }) as any
    assert.equal(reclaimed.status, 'claimed', JSON.stringify(reclaimed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
