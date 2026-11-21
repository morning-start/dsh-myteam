/**
 * T172 · CHG-210 批 4.1：**同一条跑不起来的命令，不该一轮轮重试**。
 *
 * 缺陷现场：verify 门每轮 fail 都真跑一次命令、把任务放回 ready、下一轮再跑。
 * 如果失败原因是「命令不存在」（`not-run`），重试一万次也不会过——只会把打回预算
 * （`GATE_REJECT_BUDGET=2`）烧光，然后转人工时用户还以为「测试一直不过」。
 *
 * 修法：按**命令签名**计数，连续 `not-run` 达 `VERIFY_ENV_LATCH=3` 就熔断成
 * `needs-human` + `MT_ENV_UNAVAILABLE`，并明说「不是代码问题」。
 *
 * ⚠ 两个必须踩对的地方（第一版就是栽在这里）：
 *   ① `runVerifyGate` 是 **async** —— `executeLeadTool` 直接返回它的 Promise，
 *      测试若忘了 `await`，拿到的是 `{}`（不是 `gate-fail`）；
 *   ② verify 门要真跑命令，宿主面必须给 **`subprocess` 服务**，否则一律
 *      `MT_UNAVAILABLE`（不做静默降级）。测试里用一个返回 127 的假 spawn。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { __resetVerifyEnvLatch } from '../src/core/gates/gate-execution.ts'

/** 假 subprocess：不管跑什么都返回 127 + 「不是内部或外部命令」——稳定的 `not-run` */
const FAKE_SUBPROCESS = {
  spawn: () => ({
    done: Promise.resolve({
      exitCode: 127,
      signal: null,
      output: "'nope-xyz' 不是内部或外部命令，也不是可运行的程序",
    }),
    kill: () => {},
  }),
}

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
    subprocess: FAKE_SUBPROCESS,
  } as unknown as HostRuntime
}

function setup(root: string) {
  __resetVerifyEnvLatch()
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [],
  }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const created = host.executeLeadTool('myteam_create_task', {
    teamId,
    task: {
      title: '熔断用例', description: 'd', acceptanceCriteria: ['AC1'],
      deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
      deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
      gateChain: ['verify'],
      verifyCommand: { argv: ['nope-xyz-not-a-command'], timeoutMs: 15_000 },
    },
  }, {}) as any
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const member = { memberId: String(a.memberId), roleId: 'implementer', instanceName: 'a', sessionId: String(a.sessionId), teamId }
  return { host, teamId, taskId: String(created.taskId), member }
}

/** 走到 gate:verify 并调一次裁决（**必须 await** —— runVerifyGate 是 async） */
async function runVerify(host: MyTeamHost, teamId: string, taskId: string, member: any) {
  const state = host.service(teamId).projectionSnapshot.tasks[taskId].state
  if (state !== 'gate:verify') {
    const claimed = host.executeMemberTool(member, 'myteam_claim_task', { taskId }) as any
    assert.equal(claimed.status, 'claimed', `无法 claim（state=${state}）：${JSON.stringify(claimed)}`)
    const attemptId = host.service(teamId).projectionSnapshot.tasks[taskId].attemptId!
    host.commit(teamId, { actor: `member:${member.memberId}`, type: 'task.evidence', payload: { teamId, taskId, attemptId, evidence: { kind: 'na', na: { reason: '手工核对' } } } })
    host.executeMemberTool(member, 'myteam_update_task', { taskId, attemptId, status: 'done' })
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:verify')
  }
  return await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass' }, {}) as any)
}

test('t172: 前两次正常打回，第三次熔断成 needs-human（不再执行命令）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t172-latch-'))
  try {
    const { host, teamId, taskId, member } = setup(root)

    const first = await runVerify(host, teamId, taskId, member)
    assert.equal(first.status, 'gate-fail', JSON.stringify(first))
    assert.equal(first.failureKind, 'not-run', '第一次就要标出「没跑起来」')

    const second = await runVerify(host, teamId, taskId, member)
    assert.equal(second.status, 'gate-fail', `第二次仍应可重试（阈值 3）：${JSON.stringify(second)}`)

    const third = await runVerify(host, teamId, taskId, member)
    assert.equal(third.status, 'needs-human', `第三次应熔断：${JSON.stringify(third)}`)
    assert.equal(third.code, 'MT_ENV_UNAVAILABLE', '环境类失败要优先于 MT_REJECT_BUDGET——前者可行动')
    assert.equal(third.failures, 2, '第 3 次没有执行，所以只记了 2 次**真实**失败')
    assert.match(String(third.message), /不是代码问题/, '要明说这不是代码错')
    assert.equal(third.exitCode, undefined, '熔断后不再带退出码——它没有执行命令')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
