/**
 * T131 · CHG-159（报告 A6）：并发波次调度的**领取闸门**接线。
 *
 * 为什么补这一层：`waves.ts` 的 `scopesOverlap` / `planDevWaves` 已经能算出「哪些任务必须
 * 串行」（CHG-154，20 条用例全绿），但**没有任何调用点**——claim 前的就绪判定根本不看它。
 * 结果是两个成员 `writeScopes` 有交集时仍可并行改同一批文件，只有事后 `scope-audit` 留痕
 * （不拦截），最后写入者赢、前一个的改动被静默覆盖。
 *
 * 口径（与 `scopesOverlap` **同一套**，不重写判定——两套漂移比没有更糟）：
 *  - 只跟**同团队、正在执行**（`in_progress` / `re-scoping`）的任务比写范围；
 *  - 任一方未声明 `writeScopes` → **不拦**（未声明 = 不参与串行，否则存量团队全部死锁）；
 *  - 同一个任务自己 → 不拦；依赖「上游未完成」不归本函数管（那是 `canClaim` 的活）；
 *  - 命中冲突 → 复用既有错误码 `MT_NOT_CLAIMABLE`（语义 = 此刻不能领），**不新增码**；
 *  - 文案必须点名「与谁重叠、为什么串行、下一步怎么做」——只说 blocked 等于让人干等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimScopeVerdict, scopesOverlap, type ClaimScopeProjection } from '../src/core/scheduler/waves.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

/* ── 纯函数：投影最小面构造 ─────────────────────────────────────── */

function projection(tasks: Array<{ id: string; state?: string; writeScopes?: string[] }>): ClaimScopeProjection {
  const record: ClaimScopeProjection['tasks'] = {}
  for (const task of tasks) {
    record[task.id] = {
      id: task.id,
      state: task.state ?? 'ready',
      input: task.writeScopes === undefined ? {} : { writeScopes: task.writeScopes },
    }
  }
  return { tasks: record }
}

/* ── 1. 未声明写范围不拦 ───────────────────────────────────────── */

test('t130-1: 任一方未声明 writeScopes → 不拦（未声明 ≠ 哪里都能写）', () => {
  assert.deepEqual(claimScopeVerdict(projection([{ id: 'b' }]), 'b'), { ok: true, blockingTaskIds: [] })
  // 自己没声明、别人在跑同一批文件 → 仍然放行（存量任务不补 writeScopes 也不能死锁）
  const noScopes = projection([
    { id: 'a', state: 'in_progress', writeScopes: ['src/'] },
    { id: 'b' },
  ])
  assert.equal(claimScopeVerdict(noScopes, 'b').ok, true)
  // 别人没声明 → 也不构成冲突
  const otherNoScopes = projection([
    { id: 'a', state: 'in_progress' },
    { id: 'b', writeScopes: ['src/'] },
  ])
  assert.equal(claimScopeVerdict(otherNoScopes, 'b').ok, true)
  // 任务还不在投影里（不存在）→ 交给 service 层的「not found」判定，本函数不拦
  assert.equal(claimScopeVerdict(projection([]), 'ghost').ok, true)
})

/* ── 2. 同文件交集 → 拦，且点名阻塞任务 ───────────────────────── */

test('t130-2: 同一文件的写范围交集 → 拦，blockingTaskIds 正确', () => {
  const verdict = claimScopeVerdict(
    projection([
      { id: 'a', state: 'in_progress', writeScopes: ['src/index.ts'] },
      { id: 'b', writeScopes: ['src/index.ts'] },
    ]),
    'b',
  )
  assert.equal(verdict.ok, false)
  if (verdict.ok) assert.fail('同一文件必须串行')
  assert.deepEqual(verdict.blockingTaskIds, ['a'])
  assert.equal(verdict.code, 'MT_NOT_CLAIMABLE', '复用既有错误码，不新增')
  // 文案要能让人知道「跟谁撞、为什么、下一步」
  assert.match(verdict.message, /src\/index\.ts/, '点名重叠的写范围')
  assert.match(verdict.message, /「a」/, '点名阻塞任务')
  assert.match(verdict.message, /串行/, '说明为什么要等')
  assert.match(verdict.message, /等 a 完成/, '给出下一步动作（等它完成）')
})

/* ── 3. 目录前缀语义 ───────────────────────────────────────────── */

test('t130-3: 目录前缀语义（`src/a` 覆盖 `src/a/b.ts`）→ 拦', () => {
  // 无通配的 scope 按目录理解（与 scope-audit 的 normalizeScopePath / matchesScope 同源）
  assert.equal(scopesOverlap(['src/a'], ['src/a/b.ts']), true)
  const verdict = claimScopeVerdict(
    projection([
      { id: 'a', state: 'in_progress', writeScopes: ['src/a'] },
      { id: 'b', writeScopes: ['src/a/b.ts'] },
    ]),
    'b',
  )
  assert.equal(verdict.ok, false)
  if (verdict.ok) assert.fail('目录覆盖其下文件')
  assert.deepEqual(verdict.blockingTaskIds, ['a'])
  // re-scoping 也在飞（任务正在重新规划，产出物仍可能被写）
  const rescoping = claimScopeVerdict(
    projection([
      { id: 'a', state: 're-scoping', writeScopes: ['plugin/src/core/'] },
      { id: 'b', writeScopes: ['plugin/src/core/scheduler/waves.ts'] },
    ]),
    'b',
  )
  assert.equal(rescoping.ok, false)
})

/* ── 4. 不相关路径 → 放行 ──────────────────────────────────────── */

test('t130-4: 不相关路径 → 放行（不能因为「有任务在跑」就全局串行）', () => {
  const verdict = claimScopeVerdict(
    projection([
      { id: 'a', state: 'in_progress', writeScopes: ['src/'] },
      { id: 'b', writeScopes: ['docs/'] },
    ]),
    'b',
  )
  assert.deepEqual(verdict, { ok: true, blockingTaskIds: [] })
  // 通配也遵守「能证明不相容才放行」的保守方向：`src/*.ts` vs `src/*.js` 必不相交
  assert.equal(
    claimScopeVerdict(
      projection([
        { id: 'a', state: 'in_progress', writeScopes: ['src/*.ts'] },
        { id: 'b', writeScopes: ['src/*.js'] },
      ]),
      'b',
    ).ok,
    true,
  )
})

/* ── 5. 只有正在执行的任务参与拦截 ─────────────────────────────── */

test('t130-5: `in_progress` / `re-scoping` 之外的任务不参与拦截（ready 不算冲突）', () => {
  // 两个 ready 任务范围重叠：谁都还没开始写 → 不拦
  assert.equal(
    claimScopeVerdict(
      projection([
        { id: 'a', state: 'ready', writeScopes: ['src/'] },
        { id: 'b', state: 'ready', writeScopes: ['src/a.ts'] },
      ]),
      'b',
    ).ok,
    true,
  )
  // 门禁态 = 实现已完成、等裁决，不再构成「正在写」的并发冲突
  assert.equal(
    claimScopeVerdict(
      projection([
        { id: 'a', state: 'gate:review', writeScopes: ['src/'] },
        { id: 'b', writeScopes: ['src/a.ts'] },
      ]),
      'b',
    ).ok,
    true,
  )
  // 终态同样不参与
  assert.equal(
    claimScopeVerdict(
      projection([
        { id: 'a', state: 'done', writeScopes: ['src/'] },
        { id: 'b', writeScopes: ['src/a.ts'] },
      ]),
      'b',
    ).ok,
    true,
  )
  // 自己（同一个任务）永远不跟自己冲突
  assert.equal(
    claimScopeVerdict(projection([{ id: 'b', state: 'in_progress', writeScopes: ['src/'] }]), 'b').ok,
    true,
  )
})

/* ── 6. host 端到端：claim 被拒 + 释放后可领 ──────────────────── */

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  gateChain: ['review'],
  ...over,
})

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: { sessionId: string }) => ({ session: { id: opts.sessionId }, followup: () => {} }),
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

test('t130-6: host 端到端 —— 写范围重叠的第二个 claim 被拒（错误码/文案可断言），释放后可领', async () => {
  const root = mkdtempSync(join(tmpdir(), 't130-waves-claim-'))
  const host = new MyTeamHost(makeRuntime(root), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T',
    goal: 'G',
    roster: [{ roleId: 'captain' }],
    tasks: [],
  }, {}) as { teamId: string }
  const teamId = sub.teamId
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as { memberId: string; sessionId: string }
  await new Promise((resolve) => setTimeout(resolve, 0)) // FIX-14：handle 回填是 microtask

  const first = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ writeScopes: ['src/'] }) }, {}) as { status: string; taskId: string }
  const second = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ writeScopes: ['src/app.ts'] }) }, {}) as { status: string; taskId: string }
  assert.equal(first.status, 'created')
  assert.equal(second.status, 'created')

  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: spawn.sessionId, teamId }
  const claimedFirst = host.executeMemberTool(member, 'myteam_claim_task', { taskId: first.taskId }) as { status: string }
  assert.equal(claimedFirst.status, 'claimed')
  // CHG-158：claim 时写入世代号（host 按「上一世代 + 1」算好）
  assert.equal(host.service(teamId).projectionSnapshot.tasks[first.taskId]!.attempt, 1)

  // 第二个任务写范围落在第一个任务声明的目录里 → 必须串行
  const blocked = host.executeMemberTool(member, 'myteam_claim_task', { taskId: second.taskId }) as { status: string; code?: string; message?: string }
  assert.equal(blocked.status, 'error')
  assert.equal(blocked.code, 'MT_NOT_CLAIMABLE', '复用既有错误码（此刻不能领）')
  assert.match(String(blocked.message), /writeScopes|可写范围/, '文案说明是写范围冲突，不是状态问题')
  assert.match(String(blocked.message), new RegExp(first.taskId), '点名阻塞任务')
  // 拒绝 = 账本零写入：第二个任务仍在就绪列
  assert.equal(host.service(teamId).projectionSnapshot.tasks[second.taskId]!.attemptId, undefined)

  // 第一个任务被撤权（不再 in_progress）→ 第二个可以领
  host.executeLeadTool('myteam_revoke_attempt', { teamId, taskId: first.taskId, reason: '释放写范围' }, {})
  const retried = host.executeMemberTool(member, 'myteam_claim_task', { taskId: second.taskId }) as { status: string }
  assert.equal(retried.status, 'claimed', '阻塞任务结束后可领（否则就是死锁）')
})
