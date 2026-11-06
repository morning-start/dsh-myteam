/**
 * T74（CHG-88）：FR-11.4 结构化提案的**裁决真正生效**（PRD 验收场景 16）。
 *
 * 修复前：`myteam_resolve_proposal` 只落一条 `task.proposal.resolved` 留痕，
 * 然后回「批准的变更由你用既有工具执行对应操作」——**批准 split 之后子任务不出现**，
 * 提案通道等于只留了个墓碑，验收场景 16 跑不通。
 *
 * 现在：批准即执行对应操作——
 *  - split → 落子任务（task.created 逐条，同 batchId）+ 原任务转 cancelled
 *  - add-dep → task.updated 加依赖
 *  - reassign → 撤 attempt + task.assigned
 *  - cancel → task.cancelled
 *  - 驳回 → 只留痕，结构不动
 * 载荷不合规 → 拒绝并说明，**不落「已批准但什么都没做」的半截状态**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string) {
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
        return { followup: () => {}, session: {} }
      },
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
  return { rt }
}

function teamWithTask(root: string) {
  const { rt } = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const teamId = 't-split'
  host.executeLeadTool('myteam_submit_plan', {
    teamId, teamName: 'S', goal: 'g',
    roster: [{ roleId: 'captain' }, { roleId: 'developer' }], tasks: [],
  }, {})
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const created = host.executeLeadTool('myteam_create_task', {
    teamId,
    task: {
      title: '大任务', description: 'x', acceptanceCriteria: ['c'],
      deliverableSpec: { path: 'tmp/big.txt', producer: 'developer' },
      deps: [], requiredRole: 'developer', taskType: 'default', estimate: 'S',
    },
  }, {}) as any
  return { host, teamId, taskId: String(created.taskId) }
}

function ledgerTypes(root: string, teamId: string): string[] {
  const p = join(root, '.team-workplace/state/teams', teamId, 'ledger.jsonl')
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).type as string)
}

const member = (teamId: string) => ({
  memberId: 'm1-developer', roleId: 'developer', instanceName: 'developer',
  sessionId: `mt-${teamId}-developer-1`, teamId,
})

test('t74-1: split 提案批准 → 子任务出现 + 原任务 cancelled + 账本关联（验收场景 16）', () => {
  const root = mkdtempSync(join(tmpdir(), 't74split-'))
  try {
    const { host, teamId, taskId } = teamWithTask(root)
    // 成员提交 split 提案
    const proposed = host.executeMemberTool(member(teamId), 'myteam_propose_task_change', {
      taskId,
      type: 'split',
      payload: {
        tasks: [
          { title: '子任务甲', acceptanceCriteria: ['甲做完'], requiredRole: 'developer' },
          { title: '子任务乙', acceptanceCriteria: ['乙做完'], requiredRole: 'developer' },
        ],
      },
      reason: '任务太大，拆成两件',
    }) as any
    assert.equal(proposed.status, 'proposed', JSON.stringify(proposed))
    const proposalId = proposed.proposalId

    // 队长批准
    const resolved = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId, decision: 'approved', note: '同意拆分',
    }, {}) as any
    assert.equal(resolved.status, 'approved', JSON.stringify(resolved))
    assert.equal(resolved.applied, 'split')
    assert.equal(resolved.created.length, 2, '两个子任务都建成')
    assert.deepEqual(
      resolved.created.map((c: any) => c.title),
      ['子任务甲', '子任务乙'],
      '子任务按提案顺序创建',
    )

    const proj = host.service(teamId).projectionSnapshot
    // 子任务真的出现在投影里
    for (const c of resolved.created) {
      assert.ok(proj.tasks[c.taskId], `子任务 ${c.taskId} 未出现在投影`)
      assert.equal(proj.tasks[c.taskId].state, 'backlog')
    }
    // 原任务已取消
    assert.equal(proj.tasks[taskId].state, 'cancelled', '原任务应转 cancelled')

    // 账本顺序：proposal → created* → cancelled → resolved
    const types = ledgerTypes(root, teamId)
    const iProp = types.lastIndexOf('task.proposal')
    const iCreated = types.lastIndexOf('task.created')
    const iCancel = types.lastIndexOf('task.cancelled')
    const iResolved = types.lastIndexOf('task.proposal.resolved')
    assert.ok(iProp >= 0 && iCreated > iProp, `账本顺序不对: ${types.join(',')}`)
    assert.ok(iCancel > iCreated, `原任务取消应晚于子任务创建: ${types.join(',')}`)
    assert.ok(iResolved > iCancel, `裁决留痕应最后: ${types.join(',')}`)
    // 同一 batchId 串起子任务
    const p = join(root, '.team-workplace/state/teams', teamId, 'ledger.jsonl')
    const evs = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const childEvents = evs.filter((e) => e.type === 'task.created' && e.payload.fromProposal === proposalId)
    assert.equal(childEvents.length, 2, '两个子任务都带 fromProposal 关联')
    assert.equal(new Set(childEvents.map((e) => e.payload.batchId)).size, 1, '同一 batchId')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t74-2: 驳回提案 → 只留痕，结构不动（不建子任务、不取消原任务）', () => {
  const root = mkdtempSync(join(tmpdir(), 't74reject-'))
  try {
    const { host, teamId, taskId } = teamWithTask(root)
    const proposed = host.executeMemberTool(member(teamId), 'myteam_propose_task_change', {
      taskId, type: 'split', payload: { tasks: [{ title: '不该出现' }] }, reason: '想拆',
    }) as any
    const r = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId: proposed.proposalId, decision: 'rejected', note: '不拆',
    }, {}) as any
    assert.equal(r.status, 'rejected', JSON.stringify(r))
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.tasks[taskId].state, 'backlog', '原任务状态不动')
    assert.equal(Object.keys(proj.tasks).length, 1, '不建任何子任务')
    const types = ledgerTypes(root, teamId)
    assert.ok(!types.includes('task.cancelled'))
    assert.ok(!types.includes('task.proposal.resolved') === false, '驳回也要留痕')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t74-3: 载荷不合规 → 拒绝且不落「已批准」半截状态', () => {
  const root = mkdtempSync(join(tmpdir(), 't74bad-'))
  try {
    const { host, teamId, taskId } = teamWithTask(root)
    const proposed = host.executeMemberTool(member(teamId), 'myteam_propose_task_change', {
      taskId, type: 'split', payload: {}, reason: '空载荷',
    }) as any
    const r = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId: proposed.proposalId, decision: 'approved',
    }, {}) as any
    assert.equal(r.status, 'error', JSON.stringify(r))
    assert.equal(r.code, 'MT_VALIDATION')
    // 关键：不落 task.proposal.resolved（否则就是「已批准但什么都没做」的半截状态）
    const types = ledgerTypes(root, teamId)
    assert.ok(!types.includes('task.proposal.resolved'), '不合规载荷不得落已批准留痕')
    assert.equal(host.service(teamId).projectionSnapshot.proposals[proposed.proposalId].status, 'proposed', '提案仍是待裁决')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t74-4: add-dep 提案批准 → 依赖真的加上', () => {
  const root = mkdtempSync(join(tmpdir(), 't74adddep-'))
  try {
    const { host, teamId, taskId } = teamWithTask(root)
    // 第二个任务作为依赖目标
    const other = host.executeLeadTool('myteam_create_task', {
      teamId,
      task: {
        title: '上游', description: 'x', acceptanceCriteria: ['c'],
        deliverableSpec: { path: 'tmp/up.txt', producer: 'developer' },
        deps: [], requiredRole: 'developer', taskType: 'default', estimate: 'S',
      },
    }, {}) as any
    const proposed = host.executeMemberTool(member(teamId), 'myteam_propose_task_change', {
      taskId, type: 'add-dep', payload: { dep: other.taskId }, reason: '需要先做上游',
    }) as any
    const r = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId: proposed.proposalId, decision: 'approved',
    }, {}) as any
    assert.equal(r.status, 'approved', JSON.stringify(r))
    assert.equal(r.applied, 'add-dep')
    const proj = host.service(teamId).projectionSnapshot
    assert.ok(proj.tasks[taskId].input.deps.includes(other.taskId), '依赖应加上')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t74-5: 未知 proposalId / 重复裁决 → 拒绝，不静默成功', () => {
  const root = mkdtempSync(join(tmpdir(), 't74dup-'))
  try {
    const { host, teamId, taskId } = teamWithTask(root)
    const r1 = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId: 'prop-nope', decision: 'approved',
    }, {}) as any
    assert.equal(r1.status, 'error')
    assert.equal(r1.code, 'MT_VALIDATION')

    const proposed = host.executeMemberTool(member(teamId), 'myteam_propose_task_change', {
      taskId, type: 'split', payload: { tasks: [{ title: '甲' }] }, reason: '拆',
    }) as any
    const first = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId: proposed.proposalId, decision: 'approved',
    }, {}) as any
    assert.equal(first.status, 'approved', JSON.stringify(first))
    // 二次裁决 → 拒绝
    const second = host.executeLeadTool('myteam_resolve_proposal', {
      teamId, proposalId: proposed.proposalId, decision: 'approved',
    }, {}) as any
    assert.equal(second.status, 'error', '重复裁决必须拒绝')
    assert.equal(second.code, 'MT_VALIDATION')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
