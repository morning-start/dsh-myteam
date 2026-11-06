/**
 * T23 host 执行面 Run 接线自测（KI-2 实弹回归，CHG-39）：
 * - FIX-9：approve = Approve & Run——批准后按名册自动召唤成员（跳过 captain）+ followup 引导；
 * - FIX-10：archive gate 落位校验接线——done 后 gate:archive 由 host 跑 checkArchiveGate 并落
 *   task.deliverable / task.gate.result（此前 checkArchiveGate 无 host 调用点，任务滞留 gate:archive）。
 * 已知边界（KI-13）：review gate 无裁决入口（lead 工具/面板均未覆盖），M1 靠 gateChain 绕行或人工。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

/** 可观测 mock：记录 agents.create 与 followup 调用 */
function makeRuntime(root: string) {
  const createdAgents: Array<{ opts: any; followups: string[] }> = []
  const rt: HostRuntime = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: any) => {
        const agentCtx = {
          tools: { register: () => {}, restrict: () => {} },
          systemPrompt: { section: () => {} },
          skills: { registerProvider: () => {} },
        }
        opts.setup(agentCtx, {})
        const rec = { opts, followups: [] as string[] }
        const agent = { followup: (m: any) => { rec.followups.push(m?.content?.[0]?.text ?? '') }, session: {} }
        createdAgents.push(rec)
        return agent
      },
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
  return { rt, createdAgents }
}

function submitStaged(host: MyTeamHost, teamId: string) {
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamId,
    teamName: 'T23',
    goal: '验证 Run 接线',
    roster: [{ roleId: 'captain' }, { roleId: 'developer' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(sub.status, 'staged', JSON.stringify(sub))
  return sub
}

test('t23-1: approve = Approve & Run——名册非队长成员自动召唤 + followup 引导 + spawned 返回', async () => {
  const root = mkdtempSync(join(tmpdir(), 't23run-'))
  try {
    const { rt, createdAgents } = makeRuntime(root)
    const host = new MyTeamHost(rt)
    host.initialize()
    const teamId = 't-run'
    submitStaged(host, teamId)
    const approved = host.executeLeadTool('myteam_approve_plan', { teamId }, {}) as any
    assert.equal(approved.status, 'approved', JSON.stringify(approved))
    assert.deepEqual(approved.spawned, ['m1-developer', 'm2-implementer'], '按名册序召唤（跳过 captain）')
    assert.equal(createdAgents.length, 2, 'agents.create 每成员一次')
    // FIX-14：handle 经 Promise.resolve 微任务回填后才发 followup——flush microtask 再断言
    await new Promise((r) => setTimeout(r, 0))
    for (const rec of createdAgents) {
      assert.equal(rec.followups.length, 1, '每成员一次上岗引导')
      assert.match(rec.followups[0], /已上岗/)
      assert.match(rec.followups[0], /myteam_claim_task/)
    }
    // memberHandles 可见（后续 claim 用）
    const proj = host.service(teamId).projectionSnapshot
    assert.ok(proj.members['m1-developer'], '成员进入投影')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t23-1b: FIX-13 approve 自动入库 staged 任务——批准后任务上板（backlog），二次 approve 拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 't23stage-'))
  try {
    const { rt } = makeRuntime(root)
    const host = new MyTeamHost(rt)
    host.initialize()
    const teamId = 't-stage'
    host.executeLeadTool('myteam_submit_plan', {
      teamId, teamName: 'T23S', goal: '验证 staged 任务入库',
      roster: [{ roleId: 'captain' }, { roleId: 'developer' }],
      tasks: [{
        taskKey: 'S1', title: 'staged 任务', description: 'd',
        acceptanceCriteria: ['c'], deliverableSpec: { path: 'tmp/s.txt', producer: 'developer' },
        deps: [], requiredRole: 'developer', taskType: 'default', gateChain: ['archive'], estimate: 'S',
      }],
    }, {})
    const approved = host.executeLeadTool('myteam_approve_plan', { teamId }, {}) as any
    assert.equal(approved.status, 'approved', JSON.stringify(approved))
    assert.deepEqual(approved.createdTasks, ['task-1'], 'staged 任务自动入库')
    const t = host.service(teamId).projectionSnapshot.tasks['task-1']
    assert.ok(t, '任务进入投影')
    assert.equal(t.input.title, 'staged 任务')
    assert.equal(t.state, 'backlog', '初始 backlog（claim 时 fold 推进 ready）')
    const again = host.executeLeadTool('myteam_approve_plan', { teamId }, {}) as any
    assert.equal(again.status, 'error', '二次 approve 拒绝')
    assert.equal(again.code, 'MT_VALIDATION')
    assert.match(String(again.message), /already approved/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 已批准 + gateChain=['archive'] 的单任务团队；返回成员凭据 */
function makeRunTeam(root: string, deliverablePath: string) {
  const { rt, createdAgents } = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const teamId = 't-run'
  submitStaged(host, teamId)
  const approved = host.executeLeadTool('myteam_approve_plan', { teamId }, {}) as any
  assert.equal(approved.status, 'approved')
  const created = host.executeLeadTool('myteam_create_task', {
    teamId,
    task: {
      title: '落一个文件',
      description: 'x',
      acceptanceCriteria: ['文件存在'],
      deliverableSpec: { path: deliverablePath, producer: 'developer' },
      deps: [],
      requiredRole: 'developer',
      taskType: 'default',
      gateChain: ['archive'],
      estimate: 'S',
    },
  }, {}) as any
  assert.equal(created.status, 'created', JSON.stringify(created))
  return { rt, createdAgents, host, teamId, taskId: String(created.taskId), member: { memberId: 'm1-developer', roleId: 'developer', instanceName: 'developer', sessionId: 'mt-t-run-developer-1', teamId } }
}

function ledgerEvents(root: string, teamId: string): any[] {
  const p = join(root, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl')
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('t23-2: done → archive gate 落位校验 pass → task.deliverable + gate.result pass → 任务 done', () => {
  const root = mkdtempSync(join(tmpdir(), 't23gate-'))
  try {
    const rel = 'tmp/ok.txt'
    mkdirSync(join(root, 'tmp'), { recursive: true })
    writeFileSync(join(root, rel), 'done\n', 'utf8')
    const { host, teamId, taskId, member } = makeRunTeam(root, rel)
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')
    const done = host.executeMemberTool(member, 'myteam_update_task', {
      taskId, attemptId: claim.attemptId, status: 'done', summary: 's',
      evidence: { kind: 'commands', commands: [{ cmd: 'cat', exitCode: 0, assertions: 1 }] },
    }) as any
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.match(String(done.note), /archive gate pass/)
    const events = ledgerEvents(root, teamId)
    const deliverable = events.find((e) => e.type === 'task.deliverable')
    assert.ok(deliverable, 'task.deliverable 落账')
    assert.equal(deliverable.payload.path, rel)
    const gate = events.find((e) => e.type === 'task.gate.result')
    assert.ok(gate, 'task.gate.result 落账')
    assert.equal(gate.payload.verdict, 'pass')
    assert.equal(gate.payload.gate, 'archive')
    const t = host.service(teamId).projectionSnapshot.tasks[taskId]
    assert.equal(t.state, 'done', 'gate pass 推进到 done')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t23-3: done → 交付物未落位 → gate.result fail 留档，任务回到 ready 等修复（CHG-86 repair 回流）', () => {
  const root = mkdtempSync(join(tmpdir(), 't23fail-'))
  try {
    const rel = 'tmp/missing.txt'
    const { host, teamId, taskId, member } = makeRunTeam(root, rel)
    assert.ok(!existsSync(join(root, rel)), '前置：交付物确实不存在')
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')
    const done = host.executeMemberTool(member, 'myteam_update_task', {
      taskId, attemptId: claim.attemptId, status: 'done', summary: 's',
      evidence: { kind: 'na', na: { reason: 'x' } },
    }) as any
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.match(String(done.note), /archive gate fail/)
    const events = ledgerEvents(root, teamId)
    const gate = events.find((e) => e.type === 'task.gate.result')
    assert.ok(gate, 'gate.result fail 落账')
    assert.equal(gate.payload.verdict, 'fail')
    assert.match(String(gate.payload.reason ?? ''), /deliverable not found/)
    const t = host.service(teamId).projectionSnapshot.tasks[taskId]
    // CHG-86：打回后任务回到 ready（修复队列）——旧实现"留在 gate 态"没有任何修复路径，
    // 打回一次任务就永久卡死（既不能重 claim，也没有合法转移能离开 gate:*）。
    assert.equal(t.state, 'ready', 'fail 后回到可修复的调度态')
    assert.equal(t.gateRejects?.archive, 1, '打回轮数累计到 gateRejects')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t23-5: 面板成员管理（CHG-48）——suspend/restore/remove 两段确认，actor=human', async () => {
  const root = mkdtempSync(join(tmpdir(), 't23member-'))
  try {
    const { rt } = makeRuntime(root)
    const host = new MyTeamHost(rt)
    host.initialize()
    const teamId = 't-member'
    submitStaged(host, teamId)
    const approved = host.executeLeadTool('myteam_approve_plan', { teamId }, {}) as any
    assert.equal(approved.status, 'approved', JSON.stringify(approved))
    await new Promise((r) => setTimeout(r, 0))
    const memberId = Object.keys(host.service(teamId).projectionSnapshot.members)[0]
    assert.ok(memberId, '成员已召唤')

    const suspended = host.memberOp(teamId, memberId, 'suspend', true) as any
    assert.equal(suspended.status, 'suspend', JSON.stringify(suspended))
    assert.equal(host.service(teamId).projectionSnapshot.members[memberId].status, 'suspended')

    const restored = host.memberOp(teamId, memberId, 'restore', true) as any
    assert.equal(restored.status, 'restored')
    assert.equal(host.service(teamId).projectionSnapshot.members[memberId].status, 'active')

    const first = host.memberOp(teamId, memberId, 'remove', false) as any
    assert.equal(first.status, 'confirm-required', 'remove 必须两段确认')
    const removed = host.memberOp(teamId, memberId, 'remove', true) as any
    assert.equal(removed.status, 'remove')
    assert.equal(host.service(teamId).projectionSnapshot.members[memberId].status, 'removed')

    const unknown = host.memberOp(teamId, 'no-such', 'suspend', true) as any
    assert.equal(unknown.code, 'MT_VALIDATION')
    const badOp = host.memberOp(teamId, memberId, 'explode', true) as any
    assert.equal(badOp.code, 'MT_VALIDATION')

    const events = ledgerEvents(root, teamId)
    assert.ok(events.some((e) => e.type === 'member.released' && e.actor === 'human'), '面板操作 actor=human')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
