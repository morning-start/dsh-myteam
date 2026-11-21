/**
 * T159 · CHG-208：**驱动链集成测试**——「成员真的会 claim」第一次被证。
 *
 * 为什么必须单独一组：修复 CHG-206（`has no provider/model` 空壳）时，全部 977 条用例都是绿的，
 * 因为所有 `agents.create` 都是**同步桩**：`create: () => ({ followup: () => {}, session: {} })`。
 * 桩只会记录「被调用过」，永远不会**消费**投进去的消息——于是「消息进了 inbox 但没有任何
 * 循环去 claim」这种整链断裂，在测试里完全看不出来，只能在真实会话里踩。
 *
 * 本文件把桩换成「会消费的假 agent」：`followup` 把消息收进 inbox，测试再按**上岗提示词里
 * 教的步骤**（list_tasks → claim_task）驱动一遍，断言账本真的推进到 `task.claimed`。
 * 这不是 DSH 的 agent loop（那要真模型），但它把「插件这一侧的契约」钉死了：
 *   ① 上岗 prompt 必须真的投进成员 inbox（且写明下一步该调什么）；
 *   ② 成员按 prompt 行动时，工具面必须真的能把任务 claim 下来；
 *   ③ 队长派单时消息必须真的投出去（不是「账本记了唤醒、成员没收到」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

/** 会消费消息的假 agents：`followup` 把文本收进 inbox，供测试驱动 */
function driverAgents() {
  const inbox: Array<{ sessionId: string; text: string }> = []
  return {
    inbox,
    service: {
      create: (opts: { sessionId: string }) => ({
        session: { id: opts.sessionId },
        followup: (msg: unknown) => {
          const text = (msg as { content?: Array<{ text?: string }> })?.content?.map((part) => part?.text ?? '').join('') ?? ''
          inbox.push({ sessionId: opts.sessionId, text })
        },
      }),
    },
    /** 取某个 session 收到的全部文本（按投递顺序） */
    textsFor(sessionId: string): string[] {
      return inbox.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.text)
    },
  }
}

function makeRuntime(root: string, agents: unknown): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents,
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

const TASK = {
  title: '驱动链用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

function approvedTeam(root: string, agents: unknown) {
  const host = new MyTeamHost(makeRuntime(root, agents))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  assert.equal(sub.status, 'staged', JSON.stringify(sub))
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})
  return { host, teamId: String(sub.teamId) }
}

test('t159-1: 上岗 prompt 真的投进成员 inbox，并写明下一步（list_tasks → claim_task）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t159-wake-'))
  try {
    const agents = driverAgents()
    const { host, teamId } = approvedTeam(root, agents.service)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any

    const spawned = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    assert.equal(spawned.status, 'spawned', JSON.stringify(spawned))
    const texts = agents.textsFor(String(spawned.sessionId))
    assert.equal(texts.length >= 1, true, `上岗 prompt 必须真的投递（inbox=${JSON.stringify(agents.inbox)}）`)
    const onboarding = texts[0]
    assert.match(onboarding, /你已上岗/, '上岗 prompt 内容')
    assert.match(onboarding, /myteam_list_tasks/, '必须教它先读板')
    assert.match(onboarding, /myteam_claim_task/, '必须教它领取')
    // 成员卡/投影都真的 active（不是「投了消息但成员没结算」）
    assert.equal(host.service(teamId).projectionSnapshot.members[String(spawned.memberId)].status, 'active')
    assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].state, 'backlog')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t159-2: 成员按上岗 prompt 行动 → 真的 claim 到任务（账本推进到 in_progress）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t159-claim-'))
  try {
    const agents = driverAgents()
    const { host, teamId } = approvedTeam(root, agents.service)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
    const spawned = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = {
      memberId: String(spawned.memberId), roleId: 'implementer',
      instanceName: String(spawned.memberId), sessionId: String(spawned.sessionId), teamId,
    }

    /* 模拟成员消费上岗 prompt：**只按 prompt 教的入口**（list_tasks → claim_task），
     * 不做任何测试专用后门——这样断言的才是「提示词与工具面自洽」。 */
    const listed = host.executeMemberTool(member, 'myteam_list_tasks', {}) as any
    assert.equal(listed.status, 'ok', JSON.stringify(listed))
    const mine = (listed.tasks as any[]).find((row) => row.id === cr.taskId)
    assert.ok(mine, `成员的读板里必须看得到这张任务（${JSON.stringify(listed.tasks)}）`)
    const claimed = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
    assert.equal(claimed.status, 'claimed', JSON.stringify(claimed))
    assert.ok(claimed.attemptId, 'claim 必须回 attemptId（成员后续申报的写凭据）')

    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.tasks[cr.taskId].state, 'in_progress', '账本真的推进了（不是只在内存里）')
    assert.equal(proj.tasks[cr.taskId].assignee, member.memberId)
    assert.equal(proj.members[member.memberId].currentTaskId, cr.taskId, '成员占用也要落到投影')
    // 收尾：进度申报能过（写凭据可用）
    const progress = host.executeMemberTool(member, 'myteam_update_task', {
      taskId: cr.taskId, attemptId: claimed.attemptId, status: 'in_progress', progress: '开跑',
    }) as any
    assert.equal(progress.status, 'in_progress', JSON.stringify(progress))
    assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].state, 'in_progress')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t159-3: 队长派单 → 消息真的投到成员（不是「账本记了唤醒、成员没收到」）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t159-assign-'))
  try {
    const agents = driverAgents()
    const { host, teamId } = approvedTeam(root, agents.service)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
    const spawned = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const sessionId = String(spawned.sessionId)
    const before = agents.textsFor(sessionId).length

    const assigned = host.executeLeadTool('myteam_assign_task', { teamId, taskId: cr.taskId, memberIds: [String(spawned.memberId)] }, {}) as any
    assert.ok(assigned.status === 'assigned' || assigned.status === 'ok', JSON.stringify(assigned))

    const after = agents.textsFor(sessionId)
    assert.ok(after.length > before, `派单必须真的投消息（before=${before} after=${after.length}）`)
    // 消息里要能看出「去领哪张任务」——只说「有新任务」等于让成员猜
    assert.ok(after.slice(before).some((text) => text.includes(cr.taskId) || /assign|dispatch/.test(text)), JSON.stringify(after.slice(before)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
