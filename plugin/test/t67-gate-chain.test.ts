/**
 * CHG-86（M2-C / FR-5.1~5.2 + P0-2 / P0-3）：门禁裁决闭环、归档落盘、token 侧车口径。
 *
 * 背景（本轮修的是**真实用户可达路径**上的断链）：
 *  - 旧实现里 `task.gate.result` 只有成员 `update_task` 的 archive 分支会写，而默认门禁链是
 *    `['review','archive']`——任务 done 后进的是 `gate:review`，条件永不成立；且没有任何
 *    Lead 工具 / 面板端点能提交 review 裁决 ⇒ 任务永远到不了 `done`，下游永不解锁。
 *    359 个全绿的单测没抓到它，是因为测试直接用 `host.commit()` 落 gate.result 绕过了真实入口。
 *    本文件的用例**全部走真实入口**（`myteam_review_task` / 面板 `reviewTask`），
 *    不使用 `host.commit()` 替身。
 *  - `myteam_disband` 旧实现只写一条账本事件、没有任何文件 IO → 归档视图整体空壳。
 *  - `getTokens` 旧实现每次从空文件重建、把全生命周期总量记进"今天" → 历史按天数据每次读盘被抹掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: { sessionId: string }) => ({
        session: { id: opts.sessionId },
        followup: () => {},
      }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
  }
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  ...over,
})

/**
 * 建一个 active 团队 + 两名成员（implementer / reviewer）。
 * reviewer 角色用于满足「交叉审查必须是另一名成员」。
 */
async function team(root: string) {
  const host = new MyTeamHost(makeRuntime(root), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool(
    'myteam_submit_plan',
    { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }], tasks: [] },
    {},
  ) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  const impl = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'implementer' }, {}) as any
  const review = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'reviewer' }, {}) as any
  await new Promise((r) => setTimeout(r, 0)) // handle 回填是 microtask
  const teamId = sub.teamId as string
  const implMember = { memberId: impl.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: impl.sessionId, teamId }
  return { host, teamId, impl, review, implMember }
}

/** 建任务 → 领取 → 申报 done（走真实成员入口），返回 taskId */
function completeTask(host: MyTeamHost, teamId: string, implMember: any, over: Record<string, unknown> = {}) {
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK(over) }, {}) as any
  assert.equal(cr.status, 'created')
  const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId: cr.taskId }) as any
  assert.equal(claim.status, 'claimed')
  const done = host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId: cr.taskId,
    attemptId: claim.attemptId,
    status: 'done',
    summary: '做完了',
    evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 3 }] },
  }) as any
  assert.equal(done.status, 'completed')
  return cr.taskId as string
}

test('t67-1: 默认门禁链 review→archive 能走完到 done（修复前永远停在 gate:review）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-chain-'))
  const { host, teamId, implMember, impl, review } = await team(root)
  // 交付物真实落盘（archive 门是落位校验）
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'x.md'), '# deliverable\n', 'utf8')

  const taskId = completeTask(host, teamId, implMember, { gateChain: ['review', 'archive'] })
  // ① 申报 done 后进 review 门（不是直接 done，也不是 archive）
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')

  // ② review 门裁决通过（真实入口：Lead 工具）→ 自动推进 archive 落位校验 → done
  const pass = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'pass', reviewerMemberId: review.memberId },
    {},
  ) as any
  assert.equal(pass.status, 'gate-pass', `unexpected: ${JSON.stringify(pass)}`)
  assert.equal(pass.gate, 'review')
  // ③ archive 门由 host 自动落位校验（不是人工裁决门）
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'done')
  assert.match(String(pass.note ?? ''), /archive gate pass/)
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].gateVerdicts.review, 'pass')
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].gateVerdicts.archive, 'pass')
  // ④ 交付物被登记（archive 门 pass 时补写 task.deliverable）
  assert.ok(host.service(teamId).projectionSnapshot.tasks[taskId].deliverables.length > 0)
  void impl
})

test('t67-2: 强制交叉审查——审查者不能是实现者本人（FR-5.1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-cross-'))
  const { host, teamId, implMember, impl } = await team(root)
  const taskId = completeTask(host, teamId, implMember)
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')

  // 自己审自己 → 拒绝
  const self = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'pass', reviewerMemberId: impl.memberId },
    {},
  ) as any
  assert.equal(self.status, 'error')
  assert.equal(self.code, 'MT_CROSS_REVIEW')
  // 未裁决：任务仍在 review 门
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')

  // 缺 reviewer 也拒绝（只认显式结论行 + 强制交叉审查）
  const missing = host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass' }, {}) as any
  assert.equal(missing.code, 'MT_CROSS_REVIEW')
})

test('t67-3: 打回预算——同一门打回 2 轮后队长不能再放行，需人工 confirm（FR-5.2）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-budget-'))
  const { host, teamId, implMember, impl, review } = await team(root)
  const member = { memberId: impl.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: impl.sessionId, teamId }

  const taskId = completeTask(host, teamId, implMember, { gateChain: ['review'], title: '需要复验的任务' })
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')

  // 第 1 轮打回 → 任务回到 ready（修复队列，可以重新 claim 复验）
  const fail1 = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'fail', reviewerMemberId: review.memberId, reason: 'AC 没覆盖' },
    {},
  ) as any
  assert.equal(fail1.status, 'gate-fail')
  assert.equal(fail1.rejectCount, 1)
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'ready', '打回后必须回到可修复的调度态')

  // 修复 → 重新提交 done → 再次进入同一道门
  const claim2 = host.executeMemberTool(member, 'myteam_claim_task', { taskId }) as any
  assert.equal(claim2.status, 'claimed')
  host.executeMemberTool(member, 'myteam_update_task', {
    taskId,
    attemptId: claim2.attemptId,
    status: 'done',
    summary: '改好了',
    evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 5 }] },
  })
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')

  // 第 2 轮打回 → rejectCount = 2（达到预算上限）
  const fail2 = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'fail', reviewerMemberId: review.memberId, reason: '还是不行' },
    {},
  ) as any
  assert.equal(fail2.rejectCount, 2)

  // 第 3 次想放行 → 超预算，转人工（队长侧被拒）
  const claim3 = host.executeMemberTool(member, 'myteam_claim_task', { taskId }) as any
  assert.equal(claim3.status, 'claimed')
  host.executeMemberTool(member, 'myteam_update_task', {
    taskId,
    attemptId: claim3.attemptId,
    status: 'done',
    summary: '再改一次',
    evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 9 }] },
  })
  const blocked = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'pass', reviewerMemberId: review.memberId },
    {},
  ) as any
  assert.equal(blocked.status, 'needs-human')
  assert.equal(blocked.code, 'MT_REJECT_BUDGET')
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review', '超预算不得放行')

  // 人工（面板 reviewTask，actor=human）带 confirm=true 放行
  const remotePass = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'pass', reviewerMemberId: review.memberId, confirm: true },
    { actor: 'human' },
  ) as any
  assert.equal(remotePass.status, 'gate-pass', `unexpected: ${JSON.stringify(remotePass)}`)
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'done')
})

test('t67-4: 非门禁态 / 终态提交裁决被拒（只对 gate:* 有效）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-nogate-'))
  const { host, teamId, review } = await team(root)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const r = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId: cr.taskId, verdict: 'pass', reviewerMemberId: review.memberId },
    {},
  ) as any
  assert.equal(r.status, 'error')
  assert.match(String(r.message), /not in a gate state/)
})

test('t67-5: 门禁链门序自定义——单门链 [review] 最后一道 pass 直接 done', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-single-'))
  const { host, teamId, implMember, review } = await team(root)
  const taskId = completeTask(host, teamId, implMember, { gateChain: ['review'] })
  const pass = host.executeLeadTool(
    'myteam_review_task',
    { teamId, taskId, verdict: 'pass', reviewerMemberId: review.memberId },
    {},
  ) as any
  assert.equal(pass.status, 'gate-pass')
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'done')
})

test('t67-6: disband 真的落盘归档（team.json / tokens.json / members/ / artifacts/ / MANIFEST.json）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-archive-'))
  const { host, teamId, implMember, review } = await team(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'x.md'), '# deliverable\n', 'utf8')
  const taskId = completeTask(host, teamId, implMember, { gateChain: ['review', 'archive'] })
  host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: review.memberId }, {})

  const r = host.executeLeadTool('myteam_disband', { teamId, confirm: true }, {}) as any
  assert.equal(r.status, 'disbanded', `unexpected: ${JSON.stringify(r)}`)
  const archiveDir = join(root, '.team-workplace', 'archive', teamId)
  for (const file of ['team.json', 'tokens.json', 'MANIFEST.json', 'artifacts/artifacts.json']) {
    assert.ok(existsSync(join(archiveDir, file)), `missing archive file ${file}`)
  }
  // 名册里两名成员各一份
  const membersDir = join(archiveDir, 'members')
  assert.ok(existsSync(membersDir), 'members/ 目录必须存在')
  // team.json 内容可读且是归档态
  const snapshot = JSON.parse(readFileSync(join(archiveDir, 'team.json'), 'utf8'))
  assert.equal(snapshot.teamId, teamId)
  assert.equal(snapshot.state, 'archived')
  assert.ok(Array.isArray(snapshot.members) && snapshot.members.length >= 2)
  assert.ok(Array.isArray(snapshot.tasks) && snapshot.tasks.length >= 1)
  // 归档视图读面能读回来
  const view = host.archiveView(teamId)
  assert.ok(view.archive, 'archiveView 必须能读回归档快照')
  assert.equal(view.archive!.teamId, teamId)
  assert.ok(host.archiveList().teams.includes(teamId))
})

test('t67-7: token 侧车按天桶保留历史（修复前每次读盘只剩一天）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't67-tokens-'))
  const { host, teamId } = await team(root)
  const dir = join(root, '.team-workplace', 'state', 'teams', teamId)
  mkdirSync(dir, { recursive: true })
  // 造一份"昨天"的历史（模拟跨天已经记过账）
  writeFileSync(
    join(dir, 'tokens.json'),
    `${JSON.stringify({
      version: 1,
      teamId,
      updatedAt: 1,
      days: { '2020-01-01': { 'm-old': { uncachedInput: 10, cacheRead: 20, cacheWrite: 30, output: 40, calls: 2 } } },
      totals: { 'm-old': { uncachedInput: 10, cacheRead: 20, cacheWrite: 30, output: 40, calls: 2 } },
      note: '',
    }, null, 2)}\n`,
    'utf8',
  )
  // 新 host 实例（冷启动，内存无缓存）→ 读盘恢复历史
  const host2 = new MyTeamHost(makeRuntime(root), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host2.initialize()
  const file = host2.syncTokens(teamId)
  assert.ok(file.days['2020-01-01'], '历史按天桶必须保留，不能被空文件重建抹掉')
  assert.equal(file.days['2020-01-01']['m-old'].cacheRead, 20)
  // 写回盘后仍带着历史
  const onDisk = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'))
  assert.ok(onDisk.days['2020-01-01'], '写盘结果必须包含历史桶')
  // 幂等：再读一次不改变历史
  const again = host2.syncTokens(teamId)
  assert.equal(again.days['2020-01-01']['m-old'].uncachedInput, 10)
})
