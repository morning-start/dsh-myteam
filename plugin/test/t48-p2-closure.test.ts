/**
 * CHG-73（FR-27/29/31 + 执行期编辑闭环）：P2 批次的服务端口径。
 *
 * 覆盖：
 *   1) 字段级 diff（编辑改动可读 / 证据过期判定同源）；
 *   2) 下游传递闭包（取消影响面 / 级联取消候选）；
 *   3) 一键 rescope：撤 attempt → 回 ready → 理由必填 → 终态拒绝 → gate 态也能复位；
 *   4) 取消任务：两段确认 impact、leave 只停本任务、下游诊断 dep-cancelled、cascade 级联；
 *   5) 批量编排：部分失败不影响其余，结果逐条回传；
 *   6) create_task 一次写入 assignees/participants（也是 actor=human）；
 *   7) updateTask 落 diff、证据过期标记、详情 edits/cancellation/actions；
 *   8) 删除角色：两段确认 / 占用面拒绝 / builtin 拒绝 / 审计行；
 *   9) 能力目录（角色表单候选，含角色声明与宿主降级）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyProjection, downstreamOf, type TeamProjection, type TaskProjection } from '../src/core/scheduler/state.ts'
import { diffTaskInput, structuralFieldsOf, changesDigest } from '../src/core/tasks/diff.ts'
import { diagnoseTask } from '../src/core/tasks/readiness.ts'
import { saveProjectRole } from '../src/core/roles/role-store.ts'
import { projectRolePaths } from '../src/core/index/offline-view.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'
import { buildBoardView, buildTaskDetailView } from '../src/remote/views.ts'

/* ── 1. diff 纯函数 ───────────────────────────────────────────── */

test('t48-1: diffTaskInput 只报真正变化的字段；structuralFieldsOf 标出结构字段；digest 稳定', () => {
  const input = {
    title: 'T', description: 'd', acceptanceCriteria: ['AC1', 'AC2'], deps: [], requiredRole: 'implementer',
    priority: 'P2', gateChain: ['review'],
  }
  const changes = diffTaskInput(input, { title: 'T', acceptanceCriteria: ['AC1', 'AC3'], priority: 'P0' })
  assert.deepEqual(changes.map((c) => c.field), ['acceptanceCriteria', 'priority'])
  assert.deepEqual(changes[0].from, ['AC1', 'AC2'])
  assert.deepEqual(changes[0].to, ['AC1', 'AC3'])
  assert.deepEqual(structuralFieldsOf(changes), ['acceptanceCriteria'])
  // 空补丁 / 值没变 → 没有改动（不能因为"提交了补丁"就产生一条空编辑事件）
  assert.deepEqual(diffTaskInput(input, {}), [])
  assert.deepEqual(diffTaskInput(input, { title: 'T' }), [])
  // digest 对同内容稳定、对改动敏感
  assert.equal(changesDigest(diffTaskInput(input, { priority: 'P0' })), changesDigest(diffTaskInput(input, { priority: 'P0' })))
  assert.notEqual(changesDigest(diffTaskInput(input, { priority: 'P0' })), changesDigest(diffTaskInput(input, { priority: 'P1' })))
})

/* ── 2. 下游闭包 ─────────────────────────────────────────────── */

const taskOf = (id: string, state: TaskProjection['state'], deps: string[] = []): TaskProjection => ({
  id,
  input: { title: id, description: '', acceptanceCriteria: ['AC'], deps, requiredRole: 'implementer', priority: 'P2' },
  state,
  escalateCount: 0,
  gates: [],
  gateVerdicts: {},
  evidenceRefs: [],
  deliverables: [],
  createdAt: 1,
})

test('t48-2: downstreamOf = 传递闭包（近→远），roots 不进结果', () => {
  const proj: TeamProjection = {
    ...emptyProjection('t1'),
    state: 'active',
    tasks: {
      a: taskOf('a', 'done'),
      b: taskOf('b', 'ready', ['a']),
      c: taskOf('c', 'backlog', ['b']),
      d: taskOf('d', 'backlog', ['c', 'a']),
      other: taskOf('other', 'ready'),
    },
  }
  assert.deepEqual([...downstreamOf(proj, ['a'])].sort(), ['b', 'c', 'd'])
  assert.equal(downstreamOf(proj, ['a'])[0], 'b', 'BFS 从最近的下游开始')
  assert.deepEqual(downstreamOf(proj, ['c']), ['d'])
  assert.deepEqual(downstreamOf(proj, ['other']), [])
})

/* ── 3. 面板/队长管线共用：rescope / cancel / batch ───────────── */

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
  title: '面板建的任务', description: 'd', acceptanceCriteria: ['AC1'], deliverableSpec: { path: 'docs/x.md' },
  deps: [] as string[], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'],
}

const readLedger = (host: MyTeamHost, teamId: string) =>
  readFileSync(host.service(teamId).ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

async function setupTeam(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt, { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const remote = new MyTeamRemote(rt, host)
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  await remote.planAction({ teamId: sub.teamId, action: 'approve' })
  const member = Object.values(host.service(sub.teamId).projectionSnapshot.members).find((m) => m.roleId === 'implementer')!
  const handle = { memberId: member.id, roleId: member.roleId, instanceName: member.instanceName, sessionId: member.sessionId, teamId: sub.teamId }
  return { rt, host, remote, teamId: sub.teamId as string, handle }
}

test('t48-3: 一键 rescope —— 撤 attempt → 回 ready；理由必填；终态拒绝；actor=human', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-rescope-'))
  try {
    const { host, remote, teamId, handle } = await setupTeam(root)
    const created = (await remote.createTask({ teamId, task: TASK })) as any
    host.executeMemberTool(handle as never, 'myteam_claim_task', { taskId: created.taskId })
    assert.equal(host.service(teamId).projectionSnapshot.tasks[created.taskId].state, 'in_progress')

    // 理由必填
    const noReason = (await remote.rescopeTask({ teamId, taskId: created.taskId, reason: '  ' })) as any
    assert.equal(noReason.status, 'error')
    assert.equal(noReason.code, 'MT_VALIDATION')

    const res = (await remote.rescopeTask({ teamId, taskId: created.taskId, reason: 'AC 需要收窄' })) as any
    assert.equal(res.status, 'rescoped')
    assert.equal(res.state, 'ready')
    assert.ok(res.revokedAttempt, '应回显被撤销的 attemptId')
    const after = host.service(teamId).projectionSnapshot.tasks[created.taskId]
    assert.equal(after.state, 'ready')
    assert.equal(after.attemptId, undefined)
    assert.equal(after.rescopeCount, 1)
    // 账本 actor=human（面板发起）
    const events = readLedger(host, teamId).filter((e) => e.payload?.taskId === created.taskId)
    assert.equal(events.filter((e) => e.type === 'task.attempt.revoked').at(-1).actor, 'human')
    assert.equal(events.find((e) => e.type === 'task.rescoped').actor, 'human')
    assert.equal(events.find((e) => e.type === 'task.rescoped').payload.reason, 'AC 需要收窄')

    // 终态拒绝：走完门禁到 done 后不可再重规划
    host.executeMemberTool(handle as never, 'myteam_claim_task', { taskId: created.taskId })
    host.executeMemberTool(handle as never, 'myteam_update_task', {
      taskId: created.taskId,
      attemptId: host.service(teamId).projectionSnapshot.tasks[created.taskId].attemptId,
      status: 'done',
      evidence: { kind: 'na', na: { reason: '手工验收' } },
    })
    host.commit(teamId, { actor: 'lead', type: 'task.gate.result', payload: { teamId, taskId: created.taskId, gate: 'review', verdict: 'pass' } })
    assert.equal(host.service(teamId).projectionSnapshot.tasks[created.taskId].state, 'done')
    const terminal = (await remote.rescopeTask({ teamId, taskId: created.taskId, reason: '想重开' })) as any
    assert.equal(terminal.status, 'error')
    assert.equal(terminal.code, 'MT_TASK_TERMINAL')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-4: gate 态任务也能被 rescope 复位（撤 attempt 会离开门禁态）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-gate-'))
  try {
    const { host, remote, teamId, handle } = await setupTeam(root)
    const created = (await remote.createTask({ teamId, task: TASK })) as any
    host.executeMemberTool(handle as never, 'myteam_claim_task', { taskId: created.taskId })
    const attemptId = host.service(teamId).projectionSnapshot.tasks[created.taskId].attemptId
    host.executeMemberTool(handle as never, 'myteam_update_task', {
      taskId: created.taskId, attemptId, status: 'done', evidence: { kind: 'na', na: { reason: '无命令可跑' } },
    })
    assert.equal(host.service(teamId).projectionSnapshot.tasks[created.taskId].state, 'gate:review')
    const res = (await remote.rescopeTask({ teamId, taskId: created.taskId, reason: '门禁口径要换' })) as any
    assert.equal(res.status, 'rescoped', JSON.stringify(res))
    assert.equal(host.service(teamId).projectionSnapshot.tasks[created.taskId].state, 'ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-5: cancel 两段确认（impact.dependents）→ leave 只停本任务，下游诊断 dep-cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-cancel-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: '下游任务', deps: [a.taskId], deliverableSpec: { path: 'docs/y.md' } } })) as any
    assert.ok(b.taskId)

    const pending = (await remote.cancelTask({ teamId, taskId: a.taskId, reason: '方向变了' })) as any
    assert.equal(pending.status, 'confirm-required')
    assert.deepEqual(pending.impact.dependents, [b.taskId])
    assert.equal(pending.impact.downstream, 'leave')
    // 未确认 → 账本无取消事件
    assert.equal(readLedger(host, teamId).filter((e) => e.type === 'task.cancelled').length, 0)

    const done = (await remote.cancelTask({ teamId, taskId: a.taskId, reason: '方向变了', confirm: true })) as any
    assert.equal(done.status, 'cancelled')
    assert.deepEqual(done.cancelled, [a.taskId])
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.tasks[a.taskId].state, 'cancelled')
    assert.equal(proj.tasks[a.taskId].cancelReason, '方向变了')
    assert.equal(proj.tasks[b.taskId].state, 'backlog', 'leave 策略不动下游')
    const diag = diagnoseTask(proj, b.taskId)
    assert.ok(diag?.codes.includes('dep-cancelled'), JSON.stringify(diag))
    assert.deepEqual(diag?.depsCancelled, [a.taskId])
    assert.ok(!diag?.codes.includes('deps-pending'), '被取消的依赖不该再报"未完成"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-6: cancel downstream=cancel 级联取消下游闭包（逐条独立事件）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-cascade-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B', deps: [a.taskId] } })) as any
    const c = (await remote.createTask({ teamId, task: { ...TASK, title: 'C', deps: [b.taskId] } })) as any
    const res = (await remote.cancelTask({ teamId, taskId: a.taskId, reason: '整条链不要了', downstream: 'cancel', confirm: true })) as any
    assert.equal(res.status, 'cancelled')
    assert.deepEqual(res.cancelled, [a.taskId, b.taskId, c.taskId])
    const proj = host.service(teamId).projectionSnapshot
    for (const id of [a.taskId, b.taskId, c.taskId]) assert.equal(proj.tasks[id].state, 'cancelled')
    const events = readLedger(host, teamId).filter((e) => e.type === 'task.cancelled')
    assert.equal(events.length, 3)
    assert.equal(events[1].payload.cascadeFrom, a.taskId)
    // 终态任务再取消 → MT_TASK_TERMINAL
    const again = (await remote.cancelTask({ teamId, taskId: b.taskId, reason: 'x', confirm: true })) as any
    assert.equal(again.code, 'MT_TASK_TERMINAL')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-7: batchTaskOp 逐条落账：部分失败不影响其余，summary 如实计数', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-batch-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B' } })) as any
    // 批量改优先级
    const pri = (await remote.batchTaskOp({ teamId, op: 'priority', taskIds: [a.taskId, b.taskId], priority: 'P0' })) as any
    assert.equal(pri.status, 'batch-done')
    assert.equal(pri.summary.ok, 2)
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.tasks[a.taskId].input.priority, 'P0')
    const batchIds = new Set(readLedger(host, teamId).filter((e) => e.type === 'task.updated').map((e) => e.payload.batchId))
    assert.equal(batchIds.size, 1, '同一批操作共享一个 batchId')

    // 批量取消：先 done 掉 b，再整批取消 → b 失败、a 成功
    const res0 = (await remote.cancelTask({ teamId, taskId: b.taskId, reason: '先取消 b', confirm: true })) as any
    assert.equal(res0.status, 'cancelled')
    const pending = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId, b.taskId], reason: '整批停' })) as any
    assert.equal(pending.status, 'confirm-required')
    assert.equal(pending.impact.tasks, 2)
    const out = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId, b.taskId], reason: '整批停', confirm: true })) as any
    assert.equal(out.status, 'batch-done')
    assert.equal(out.summary.ok, 1)
    assert.equal(out.summary.failed, 1)
    assert.equal(out.results.find((r: any) => r.taskId === b.taskId).code, 'MT_TASK_TERMINAL')
    // 非法 op / 空列表被拒
    assert.equal(((await remote.batchTaskOp({ teamId, op: 'nope', taskIds: [a.taskId] })) as any).status, 'error')
    assert.equal(((await remote.batchTaskOp({ teamId, op: 'assign', taskIds: [] })) as any).status, 'error')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-8: createTask 一次写入 assignees + participants（同一管线，actor=human）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-create-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const member = Object.values(host.service(teamId).projectionSnapshot.members).find((m) => m.roleId === 'implementer')!
    const created = (await remote.createTask({
      teamId,
      task: TASK,
      assignees: [member.id],
      participants: [{ teamId: 'ops-team', memberIds: [] }],
    })) as any
    assert.equal(created.status, 'created')
    assert.deepEqual(created.assigned, [member.id])
    assert.deepEqual(created.participants, ['ops-team'])
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[created.taskId].assignees, [member.id])
    assert.ok(proj.participations[created.taskId].teams['ops-team'], '参与边应落账')
    const events = readLedger(host, teamId).filter((e) => e.payload?.taskId === created.taskId)
    assert.equal(events.find((e) => e.type === 'task.assigned').actor, 'human')
    assert.equal(events.find((e) => e.type === 'task.participate').actor, 'human')
    // 标注失败不连累任务本身：给一个不存在的队员 → 任务仍创建成功，只回 warnings
    const partial = (await remote.createTask({ teamId, task: { ...TASK, title: '带坏标注' }, assignees: ['ghost-member'] })) as any
    assert.equal(partial.status, 'created')
    assert.ok(Array.isArray(partial.warnings) && partial.warnings.length > 0, JSON.stringify(partial))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-9: updateTask 落 diff；结构编辑晚于证据 → evidenceStale；详情有 edits/actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-diff-'))
  try {
    const { host, remote, teamId, handle } = await setupTeam(root)
    const created = (await remote.createTask({ teamId, task: TASK })) as any
    host.executeMemberTool(handle as never, 'myteam_claim_task', { taskId: created.taskId })
    const attemptId = host.service(teamId).projectionSnapshot.tasks[created.taskId].attemptId
    host.commit(teamId, {
      actor: 'member:implementer',
      type: 'task.evidence',
      payload: { teamId, taskId: created.taskId, attemptId, evidence: { kind: 'na', na: { reason: '手工核对' } } },
    })
    // 重规划（撤 attempt）后才能改结构字段
    await remote.rescopeTask({ teamId, taskId: created.taskId, reason: '定义要改' })
    const updated = (await remote.updateTask({ teamId, taskId: created.taskId, patch: { acceptanceCriteria: ['AC1', 'AC2'] } })) as any
    assert.equal(updated.status, 'updated')
    assert.deepEqual(updated.changes.map((c: any) => c.field), ['acceptanceCriteria'])
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[created.taskId].evidenceStale?.fields, ['acceptanceCriteria'])

    // 看板与详情都要能看见（UI 直接渲染，不自己算）
    const board = (await remote.getBoard({ teamId })) as any
    const card = board.board.columns.flatMap((c: any) => c.tasks).find((t: any) => t.id === created.taskId)
    assert.deepEqual(card.evidenceStale.fields, ['acceptanceCriteria'])
    assert.deepEqual(card.actions, { rescope: true, cancel: true, edit: true })
    const detail = (await remote.getTaskDetail({ teamId, taskId: created.taskId })) as any
    assert.equal(detail.detail.evidenceStale.fields[0], 'acceptanceCriteria')
    assert.ok(detail.detail.evidenceStale.evidenceSeq >= 0)
    assert.equal(detail.detail.edits.length, 2, 'rescope + update 各一条改动记录')
    assert.equal(detail.detail.edits[0].changes[0].field, 'acceptanceCriteria')
    assert.ok(detail.detail.edits.every((edit: any) => edit.actor === 'human'))
    assert.deepEqual(detail.detail.actions, { rescope: true, cancel: true, edit: true })
    // 取消后：cancellation 留痕，actions 全部关闭
    await remote.cancelTask({ teamId, taskId: created.taskId, reason: '不做了', confirm: true })
    const cancelled = (await remote.getTaskDetail({ teamId, taskId: created.taskId })) as any
    assert.equal(cancelled.detail.cancellation.reason, '不做了')
    assert.deepEqual(cancelled.detail.actions, { rescope: false, cancel: false, edit: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-10: 视图纯函数 —— editsOf/cancelled/evidenceStale 从投影与事件复原（离线同构）', () => {
  const proj: TeamProjection = {
    ...emptyProjection('t1'),
    state: 'active',
    tasks: {
      x: {
        ...taskOf('x', 'cancelled'),
        cancelledAt: 500,
        cancelReason: '重复任务',
        evidenceStale: { since: 600, fields: ['acceptanceCriteria'] },
        evidenceRefs: [3],
      },
    },
  }
  const events = [
    { seq: 1, ts: 100, actor: 'human', type: 'task.updated', payload: { taskId: 'x', patch: { title: 'b' }, changes: [{ field: 'title', from: 'a', to: 'b' }] } },
    { seq: 2, ts: 200, actor: 'lead', type: 'task.rescoped', payload: { taskId: 'x', patch: {}, reason: '重做', changes: [] } },
    { seq: 3, ts: 300, actor: 'member:m', type: 'task.evidence', payload: { taskId: 'x', attemptId: 'a1', evidence: { kind: 'na', na: { reason: 'r' } } } },
  ]
  const board = buildBoardView({ projectionSnapshot: proj }, {}, ['全部'])
  const card = board.columns[0].tasks[0]
  assert.deepEqual(card.cancelled, { ts: 500, reason: '重复任务' })
  assert.deepEqual(card.evidenceStale, { since: 600, fields: ['acceptanceCriteria'] })
  assert.deepEqual(card.actions, { rescope: false, cancel: false, edit: false })
  const detail = buildTaskDetailView({ projectionSnapshot: proj }, 'x', events as never)!
  assert.equal(detail.edits.length, 2)
  assert.equal(detail.edits[0].reason, '重做')
  assert.deepEqual(detail.edits[1].changes, [{ field: 'title', from: 'a', to: 'b' }])
  assert.equal(detail.cancellation?.downstream, 'leave')
})

/* ── 4. 角色删除（配置资产第三种写操作） ─────────────────────── */

test('t48-11: deleteRole 两段确认 / 占用面拒绝 / builtin 拒绝 / 审计行 / 能力目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-role-'))
  try {
    const facade = new MyTeamPanelFacade({ agents: { list: () => [] }, agentPresets: { serviceFor: () => undefined } })
    const paths = projectRolePaths(root)
    saveProjectRole(paths, { id: 'temp-role', name: '临时', description: 'd', systemPrompt: 's', skills: ['my-skill-x'], mcpAllowlist: ['my-mcp'] } as never, { actor: 'human' })

    // 能力目录：项目角色声明的技能/MCP 作为候选（宿主服务缺失只降级）
    const catalog = (await facade.getCapabilityCatalog({ workspaceRoot: root })) as any
    assert.equal(catalog.status, 'ok')
    assert.ok(catalog.skills.some((s: any) => s.name === 'my-skill-x' && s.source === 'role'), JSON.stringify(catalog.skills))
    assert.ok(catalog.mcp.some((s: any) => s.name === 'my-mcp'))

    // 路径非法 → 拒绝
    assert.equal(((await facade.deleteRole({ workspaceRoot: 'relative', roleId: 'temp-role' })) as any).status, 'error')
    // 内置角色不可删
    const builtin = (await facade.deleteRole({ workspaceRoot: root, roleId: 'reviewer', confirm: true })) as any
    assert.equal(builtin.code, 'MT_ROLE_BUILTIN')
    // 两段确认
    const pending = (await facade.deleteRole({ workspaceRoot: root, roleId: 'temp-role' })) as any
    assert.equal(pending.status, 'confirm-required')
    assert.equal(pending.usage.instances, 0)
    assert.ok(existsSync(join(paths.projectRolesDir, 'temp-role.json')), '确认前不能删文件')
    // 确认删除 + 审计行
    const deleted = (await facade.deleteRole({ workspaceRoot: root, roleId: 'temp-role', confirm: true })) as any
    assert.equal(deleted.status, 'deleted')
    assert.ok(!existsSync(join(paths.projectRolesDir, 'temp-role.json')))
    const audit = readFileSync(deleted.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(audit.map((row) => row.action), ['created', 'deleted'])
    // 不存在 / 已删
    assert.equal(((await facade.deleteRole({ workspaceRoot: root, roleId: 'ghost', confirm: true })) as any).code, 'MT_ROLE_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-12: 角色被团队在册时拒绝删除（占用面 = 模板/团队/项目自身角色）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-role-use-'))
  try {
    const { host, teamId } = await setupTeam(root)
    assert.ok(Object.values(host.service(teamId).projectionSnapshot.members).some((m) => m.roleId === 'implementer'))
    const facade = new MyTeamPanelFacade({ agents: { list: () => [] }, agentPresets: { serviceFor: () => undefined } })
    const pending = (await facade.deleteRole({ workspaceRoot: root, roleId: 'implementer' })) as any
    assert.equal(pending.status, 'confirm-required')
    assert.equal(pending.usage.teams, 1)
    assert.ok(pending.usage.instances >= 1)
    const blocked = (await facade.deleteRole({ workspaceRoot: root, roleId: 'implementer', confirm: true })) as any
    assert.equal(blocked.code, 'MT_ROLE_OCCUPIED')
    assert.ok(String(blocked.message).includes(`team:${teamId}`), blocked.message)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t48-13: 门面 rescopeTask/cancelTask/batchTaskOp 透传同一隔离服务；非队长会话降级；getProject 带 actions/canDelete', async () => {
  const root = mkdtempSync(join(tmpdir(), 't48-facade-'))
  try {
    const { remote, teamId } = await setupTeam(root)
    const agent = { session: { id: 's-1' } }
    const facade = new MyTeamPanelFacade({ agents: { list: () => [agent] }, agentPresets: { serviceFor: () => remote } } as never, { globalIndexPath: join(root, 'absent-index.json') })
    const created = (await remote.createTask({ teamId, task: TASK })) as any

    const rescoped = (await facade.rescopeTask(agent as never, { teamId, taskId: created.taskId, reason: '面板重规划' })) as any
    assert.equal(rescoped.status, 'rescoped')
    const pending = (await facade.cancelTask(agent as never, { teamId, taskId: created.taskId, reason: '不做了' })) as any
    assert.equal(pending.status, 'confirm-required')
    const cancelled = (await facade.cancelTask(agent as never, { teamId, taskId: created.taskId, reason: '不做了', confirm: true })) as any
    assert.equal(cancelled.status, 'cancelled')
    const second = (await remote.createTask({ teamId, task: { ...TASK, title: 'B' } })) as any
    const batch = (await facade.batchTaskOp(agent as never, { teamId, op: 'priority', taskIds: [second.taskId], priority: 'P1' })) as any
    assert.equal(batch.status, 'batch-done')

    // 非队长会话（serviceFor undefined）→ unavailable 降级，不抛错
    const noPreset = new MyTeamPanelFacade({ agents: { list: () => [] }, agentPresets: { serviceFor: () => undefined } } as never)
    assert.equal(((await noPreset.rescopeTask(agent as never, {})) as any).status, 'unavailable')
    assert.equal(((await noPreset.cancelTask(agent as never, {})) as any).status, 'unavailable')
    assert.equal(((await noPreset.batchTaskOp(agent as never, {})) as any).status, 'unavailable')

    // 项目聚合：任务带 actions/cancelled，在册角色不可删
    const proj = (await facade.getProject({ workspaceRoot: root })) as any
    assert.equal(proj.status, 'ok')
    const task = proj.tasks.find((t: any) => t.id === created.taskId)
    assert.deepEqual(task.actions, { rescope: false, cancel: false, edit: false })
    assert.equal(task.cancelled.reason, '不做了')
    const implementer = proj.roles.find((role: any) => role.id === 'implementer')
    assert.equal(implementer.canDelete, false, '在册角色不能显示删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
