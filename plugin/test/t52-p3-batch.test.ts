/**
 * CHG-76（P3 收口）：批量改挂 / 批量建任务 / 无人可领一键修复。
 *
 * 覆盖：
 *   1) 批量取消的 rewire 档：逐条 tasks 各自把直接下游改挂到统一新上游（或解除依赖）；
 *   2) 批量级前置校验：新上游不能是本批要取消的任务 / 不能是已取消的；
 *   3) 批量建任务：预览不写账本、确认后逐条 task.created（同一 batchId）、after 解析成依赖；
 *   4) 批量建任务的部分失败与结构校验（缺 title / after 自指 / 越界 / 成环）；
 *   5) 诊断 fix：no-role → 换角色 / 召唤；role-busy → 召唤增援；deps-pending 有闲置同角色 → 可指派；
 *   6) 门面透传：remote.batchTaskOp(rewire) 与 remote.createTasks（预览 + 创建）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { emptyProjection, type TeamProjection, type TaskProjection } from '../src/core/scheduler/state.ts'
import { diagnoseTask } from '../src/core/tasks/readiness.ts'

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
  title: 'T', description: 'd', acceptanceCriteria: ['AC'], deliverableSpec: { path: 'docs/x.md' },
  deps: [] as string[], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'],
}

async function setupTeam(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt, { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const remote = new MyTeamRemote(rt, host)
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  await remote.planAction({ teamId: sub.teamId, action: 'approve' })
  return { host, remote, teamId: sub.teamId as string }
}

const ledgerOf = (host: MyTeamHost, teamId: string) =>
  readFileSync(host.service(teamId).ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

/* ── 1. 批量改挂 ───────────────────────────────────────────── */

test('t52-1: 批量取消 rewire —— 每个任务的直接下游各自改挂到统一新上游', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-batchrewire-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B', deps: [a.taskId] } })) as any
    const c = (await remote.createTask({ teamId, task: { ...TASK, title: 'C' } })) as any
    const d = (await remote.createTask({ teamId, task: { ...TASK, title: 'D', deps: [c.taskId] } })) as any
    const e = (await remote.createTask({ teamId, task: { ...TASK, title: 'E' } })) as any

    // 预览：按任务列各自的直接下游
    const preview = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId, c.taskId], reason: '换方案', downstream: 'rewire', rewireTo: e.taskId })) as any
    assert.equal(preview.status, 'confirm-required')
    assert.equal(preview.impact.downstream, 'rewire')
    assert.equal(preview.impact.rewireTo, e.taskId)
    assert.deepEqual(preview.impact.rewireByTask, [
      { taskId: a.taskId, directDependents: [b.taskId] },
      { taskId: c.taskId, directDependents: [d.taskId] },
    ])

    const done = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId, c.taskId], reason: '换方案', downstream: 'rewire', rewireTo: e.taskId, confirm: true })) as any
    assert.equal(done.status, 'batch-done')
    assert.equal(done.summary.ok, 2)
    const byTask = new Map<string, any>(done.results.map((r: any) => [r.taskId, r]))
    assert.equal((byTask.get(a.taskId) as any).rewired[0].taskId, b.taskId)
    assert.equal((byTask.get(c.taskId) as any).rewired[0].taskId, d.taskId)

    // 投影：两条下游的依赖都换成 E
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[b.taskId].input.deps, [e.taskId])
    assert.deepEqual(proj.tasks[d.taskId].input.deps, [e.taskId])
    assert.equal(proj.tasks[a.taskId].state, 'cancelled')
    assert.equal(proj.tasks[c.taskId].state, 'cancelled')

    // 账本：每次取消后紧跟改挂（顺序即因果），下标记 actor=human、reason 带批次语义
    const events = ledgerOf(host, teamId)
    for (const [upstreamId, downstreamId] of [[a.taskId, b.taskId], [c.taskId, d.taskId]]) {
      const cancelledIdx = events.findIndex((ev) => ev.type === 'task.cancelled' && ev.payload.taskId === upstreamId)
      const rewiredIdx = events.findIndex((ev) => ev.type === 'task.rewired' && ev.payload.taskId === downstreamId)
      assert.ok(cancelledIdx >= 0 && rewiredIdx > cancelledIdx, '取消先于改挂')
      assert.equal(events[rewiredIdx].actor, 'human')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t52-2: 批量改挂的批量级前置校验 —— 新上游不能是本批要取消的任务 / 不能已取消', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-batchrewire-guard-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B', deps: [a.taskId] } })) as any

    // 新上游在本批里 → 拒（改挂到即将取消的任务等于把死锁换个位置）
    const inBatch = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId, b.taskId], reason: 'x', downstream: 'rewire', rewireTo: b.taskId, confirm: true })) as any
    assert.equal(inBatch.status, 'error')
    assert.equal(inBatch.code, 'MT_VALIDATION')
    assert.match(String(inBatch.message), /这一批/)

    // 已取消的任务不能当新上游
    const dead = (await remote.createTask({ teamId, task: { ...TASK, title: '已取消' } })) as any
    await remote.cancelTask({ teamId, taskId: dead.taskId, reason: '先取消', confirm: true })
    const useDead = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId], reason: 'x', downstream: 'rewire', rewireTo: dead.taskId, confirm: true })) as any
    assert.equal(useDead.status, 'error')
    assert.match(String(useDead.message), /cancelled/)

    // 前置校验失败 → 账本里一笔取消都不该有（不留半吊子状态）
    const proj = host.service(teamId).projectionSnapshot
    assert.notEqual(proj.tasks[a.taskId].state, 'cancelled')
    assert.notEqual(proj.tasks[b.taskId].state, 'cancelled')
    assert.equal(ledgerOf(host, teamId).filter((ev) => ev.type === 'task.cancelled' && (ev.payload.taskId === a.taskId || ev.payload.taskId === b.taskId)).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t52-3: 批量改挂不指定新上游 = 逐条解除依赖（下游回到可领）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-batchdetach-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B', deps: [a.taskId] } })) as any
    const done = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId], reason: '不做了', downstream: 'rewire', confirm: true })) as any
    assert.equal(done.status, 'batch-done')
    assert.equal(done.results[0].rewired[0].added, undefined, '未指定新上游 = 解除依赖')
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[b.taskId].input.deps, [])
    assert.equal(proj.tasks[b.taskId].state, 'ready', '无待完成依赖后回可领')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── 2. 批量建任务 ─────────────────────────────────────────── */

test('t52-4: 批量建任务 —— 预览不写账本；确认后逐条落账（after 解析成依赖，同一 batchId）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-createtasks-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const drafts = [
      { title: '拆需求', requiredRole: 'implementer' },
      { title: '实现', requiredRole: 'implementer', after: [1] },
      { title: '验收', requiredRole: 'implementer', after: [2] },
    ]
    const before = ledgerOf(host, teamId).length
    const preview = (await remote.createTasks({ teamId, goal: '把登录做完', tasks: drafts })) as any
    assert.equal(preview.status, 'confirm-required')
    assert.equal(preview.impact.tasks, 3)
    assert.deepEqual(preview.impact.byRole, { implementer: 3 })
    assert.deepEqual(preview.impact.ids, ['draft-1', 'draft-2', 'draft-3'])
    assert.deepEqual(preview.impact.edges, [
      { from: 'draft-1', to: 'draft-2' },
      { from: 'draft-2', to: 'draft-3' },
    ])
    assert.equal(ledgerOf(host, teamId).length, before, '预览不写账本')

    const created = (await remote.createTasks({ teamId, goal: '把登录做完', tasks: drafts, confirm: true })) as any
    assert.equal(created.status, 'created')
    assert.equal(created.summary.created, 3)
    assert.equal(created.tasks.length, 3)
    const ids = created.tasks.map((t: any) => t.taskId)
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[ids[1]].input.deps, [ids[0]], 'after 解析成上一条的 taskId')
    assert.deepEqual(proj.tasks[ids[2]].input.deps, [ids[1]])
    assert.equal(proj.tasks[ids[0]].input.requiredRole, 'implementer')
    // 叶子任务缺省补交付物路径（并留痕）
    assert.equal(proj.tasks[ids[0]].input.deliverableSpec?.path, `docs/${ids[0]}.md`)
    assert.ok((created.warnings ?? []).some((w: string) => w.includes('交付物')))

    const events = ledgerOf(host, teamId).filter((ev) => ev.type === 'task.created' && ids.includes(ev.payload.taskId))
    assert.equal(events.length, 3)
    const batchIds = new Set(events.map((ev) => ev.payload.batchId))
    assert.equal(batchIds.size, 1, '同一批次同一 batchId')
    assert.equal(events[0].actor, 'human')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t52-5: 批量建任务的部分失败 —— 名册外角色该条失败、依赖它的跳过、其余照样建成', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-createtasks-partial-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    // 预览就该点出"名册里没有这个角色"（同一条 create_task 管线：requiredRole 必须在名册）
    const preview = (await remote.createTasks({
      teamId,
      tasks: [{ title: 'A', requiredRole: 'implementer' }, { title: 'B', requiredRole: 'ghost-role' }],
    })) as any
    assert.equal(preview.status, 'confirm-required')
    assert.deepEqual(preview.impact.rolesMissing, ['ghost-role'])

    const created = (await remote.createTasks({
      teamId,
      tasks: [
        { title: 'A', requiredRole: 'implementer' },
        { title: 'B', requiredRole: 'ghost-role' },
        { title: 'C', requiredRole: 'implementer', after: [2] },
      ],
      confirm: true,
    })) as any
    assert.equal(created.status, 'created')
    assert.deepEqual(created.summary, { total: 3, created: 1, failed: 2 })
    const byTitle = new Map<string, any>(created.results.map((r: any) => [r.title, r]))
    assert.equal((byTitle.get('A') as any).ok, true)
    assert.equal((byTitle.get('B') as any).ok, false)
    assert.match(String((byTitle.get('B') as any).message), /roster/)
    assert.equal((byTitle.get('C') as any).code, 'MT_DEPENDENCY_FAILED', '依赖的条目没建成 → 跳过而不是造出悬空依赖')
    assert.equal(host.service(teamId).projectionSnapshot.tasks[String((byTitle.get('A') as any).taskId)].input.title, 'A')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t52-6: 批量建任务的结构校验 —— 缺 title / after 自指 / 越界 / 成环 都拒绝且不写账本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-createtasks-guard-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const before = ledgerOf(host, teamId).length
    const cases: Array<{ tasks: any[]; code: string; match?: RegExp }> = [
      { tasks: [{ requiredRole: 'implementer' }], code: 'MT_VALIDATION', match: /title/ },
      { tasks: [{ title: 'A', after: [1], requiredRole: 'implementer' }], code: 'MT_VALIDATION', match: /自己/ },
      { tasks: [{ title: 'A', after: [5], requiredRole: 'implementer' }], code: 'MT_VALIDATION', match: /本批序号/ },
      {
        tasks: [
          { title: 'A', after: [2], requiredRole: 'implementer' },
          { title: 'B', after: [1], requiredRole: 'implementer' },
        ],
        code: 'MT_TASK_CYCLE',
        match: /成环/,
      },
      { tasks: [], code: 'MT_VALIDATION', match: /at least 1/ },
    ]
    for (const item of cases) {
      const out = (await remote.createTasks({ teamId, tasks: item.tasks, confirm: true })) as any
      assert.equal(out.status, 'error', JSON.stringify(item.tasks))
      assert.equal(out.code, item.code, JSON.stringify(out))
      if (item.match) assert.match(String(out.message), item.match)
    }
    assert.equal(ledgerOf(host, teamId).length, before, '校验失败不写账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── 3. 无人可领的一键修复 ──────────────────────────────────── */

function mkTask(id: string, input: Partial<TaskProjection['input']>, state: TaskProjection['state'] = 'backlog'): TaskProjection {
  return {
    id,
    input: {
      title: id, description: '', acceptanceCriteria: ['ac'], deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: [],
      ...input,
    } as TaskProjection['input'],
    state,
    escalateCount: 0,
    gates: [],
    gateVerdicts: {},
    evidenceRefs: [],
    deliverables: [],
    createdAt: 1,
  }
}

function mkProj(state: TeamProjection['state'], tasks: TaskProjection[], members: TeamProjection['members']): TeamProjection {
  const proj = emptyProjection('t1')
  proj.state = state
  for (const task of tasks) proj.tasks[task.id] = task
  proj.members = members
  return proj
}

test('t52-7: 诊断 fix —— no-role 给"换角色 + 召唤"，role-busy 给"召唤增援"', () => {
  const members = {
    m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl-1', status: 'active' as const, spawnedAt: 1 },
    m2: { id: 'm2', roleId: 'reviewer', instanceName: 'rev-1', status: 'active' as const, currentTaskId: 't9', spawnedAt: 1 },
  }
  // 名册里没人担这个角色 → 换角色候选（implementer 有人空闲）+ 建议召唤
  const noRole = diagnoseTask(mkProj('active', [mkTask('t1', { requiredRole: 'qa' })], members), 't1')
  assert.ok(noRole?.codes.includes('no-role'))
  assert.deepEqual(noRole?.fix?.roleSwap, [{ roleId: 'implementer', idleMembers: ['impl-1'] }])
  assert.equal(noRole?.fix?.spawnRole, 'qa')
  assert.equal(noRole?.fix?.assignable, undefined, '同角色一个人都没有，没有可指派的')

  // 该角色的人全在忙 → 没有可指派、也没有可换（唯一空闲的只有别人），建议同角色增援
  const busyMembers = {
    m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl-1', status: 'active' as const, currentTaskId: 't8', spawnedAt: 1 },
  }
  const busy = diagnoseTask(mkProj('active', [mkTask('t1', { requiredRole: 'implementer' })], busyMembers), 't1')
  assert.ok(busy?.codes.includes('role-busy'))
  assert.equal(busy?.fix?.assignable, undefined)
  assert.equal(busy?.fix?.spawnRole, 'implementer')

  // 团队没跑：不给修复建议（做什么都没用）
  const inactive = diagnoseTask(mkProj('draft', [mkTask('t1', { requiredRole: 'qa' })], members), 't1')
  assert.deepEqual(inactive?.codes, ['team-inactive'])
  assert.equal(inactive?.fix, undefined)
})

test('t52-8: 诊断 fix —— 上游未完成但同角色有人闲着时，可以先把负责人指派上', () => {
  const members = {
    m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl-1', status: 'active' as const, spawnedAt: 1 },
  }
  const proj = mkProj('active', [
    mkTask('t1', {}, 'ready'),
    mkTask('t2', { deps: ['t1'] }),
  ], members)
  const diag = diagnoseTask(proj, 't2')
  assert.ok(diag?.codes.includes('deps-pending'))
  assert.deepEqual(diag?.fix?.assignable, [{ memberId: 'm1', instanceName: 'impl-1' }])
  assert.equal(diag?.fix?.spawnRole, undefined, '有人可用就不催着加人')
})

test('t52-10: 批量建任务支持前向引用（第 1 条依赖第 2 条）——按拓扑序创建，依赖不悬空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-createtasks-forward-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const created = (await remote.createTasks({
      teamId,
      tasks: [
        { title: '后置', requiredRole: 'implementer', after: [2] },
        { title: '前置', requiredRole: 'implementer' },
      ],
      confirm: true,
    })) as any
    assert.equal(created.summary.created, 2)
    const ids = created.tasks.map((t: any) => t.taskId)
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[ids[0]].input.deps, [ids[1]], '第 1 条挂在第 2 条上（前向引用已解析）')
    assert.deepEqual(proj.tasks[ids[1]].input.deps, [])
    // 前置那条必须先落账（否则创建时 dep 不存在）
    const events = ledgerOf(host, teamId).filter((ev) => ev.type === 'task.created' && ids.includes(ev.payload.taskId))
    assert.equal(events[0].payload.taskId, ids[1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── 4. 门面透传 ───────────────────────────────────────────── */

test('t52-9: 门面透传 —— batchTaskOp(rewire) 与 createTasks 走同一条账本管线（actor=human）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t52-facade-'))
  try {
    const { remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B', deps: [a.taskId] } })) as any
    const e = (await remote.createTask({ teamId, task: { ...TASK, title: 'E' } })) as any
    const cancelled = (await remote.batchTaskOp({ teamId, op: 'cancel', taskIds: [a.taskId], reason: '换方向', downstream: 'rewire', rewireTo: e.taskId, confirm: true })) as any
    assert.equal(cancelled.status, 'batch-done')
    assert.equal(cancelled.results[0].rewired[0].added, e.taskId)
    void b

    const preview = (await remote.createTasks({ teamId, tasks: [{ title: 'X', requiredRole: 'implementer' }] })) as any
    assert.equal(preview.status, 'confirm-required')
    assert.equal(preview.impact.tasks, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
