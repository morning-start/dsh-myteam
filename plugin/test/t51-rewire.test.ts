/**
 * CHG-75（P3）：取消后「重接线」——把下游的依赖改挂到新上游，或解除依赖让它独立。
 *
 * 为什么需要：`downstream:'leave'` 下游永远等不到 done（诊断报 dep-cancelled），
 * 而 `downstream:'cancel'` 把下游也毙掉。第三档 rewire 是中间解：**换掉那个死掉的上游**。
 *
 * 覆盖：
 *   1) 账本事件 `task.rewired` 折叠：deps 里 removed → added（缺省 = 解除依赖）；
 *   2) 领域校验：removed 必须是当前依赖 / added 必须存在且非终态 / 不得自指 / 不得成环；
 *   3) host 管线：取消本体 + 逐条改挂（每条独立事件），只改**直接下游**；
 *   4) 视图：详情给 rewiredFrom（依赖已改挂）、看板给 rewired 标记；
 *   5) 传递下游随链条自动受益（不需要重复改写）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'

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

test('t51-1: rewire 档 —— 取消本体 + 直接下游改挂到新上游（独立事件，可逐条审计）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t51-rewire-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const upstream = (await remote.createTask({ teamId, task: TASK })) as any
    const downstream = (await remote.createTask({ teamId, task: { ...TASK, title: '下游', deps: [upstream.taskId] } })) as any
    const other = (await remote.createTask({ teamId, task: { ...TASK, title: '新上游' } })) as any

    // 两段确认：影响面要带 directDependents
    const pending = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: '换方向', downstream: 'rewire', rewireTo: other.taskId })) as any
    assert.equal(pending.status, 'confirm-required')
    assert.equal(pending.impact.downstream, 'rewire')
    assert.equal(pending.impact.rewireTo, other.taskId)
    assert.deepEqual(pending.impact.directDependents, [downstream.taskId])

    const done = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: '换方向', downstream: 'rewire', rewireTo: other.taskId, confirm: true })) as any
    assert.equal(done.status, 'cancelled')
    assert.equal(done.downstream, 'rewire')
    assert.deepEqual(done.cancelled, [upstream.taskId])
    assert.equal(done.rewired.length, 1)
    assert.equal(done.rewired[0].taskId, downstream.taskId)
    assert.equal(done.rewired[0].removed, upstream.taskId)
    assert.equal(done.rewired[0].added, other.taskId)

    // 投影：下游的依赖换掉了
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[downstream.taskId].input.deps, [other.taskId])
    assert.equal(proj.tasks[upstream.taskId].state, 'cancelled')
    assert.equal(proj.tasks[downstream.taskId].rewiredFrom?.removed, upstream.taskId)
    assert.equal(proj.tasks[downstream.taskId].rewiredFrom?.added, other.taskId)

    // 账本：先 task.cancelled，再 task.rewired（顺序即因果）
    const events = ledgerOf(host, teamId).filter((e) => e.payload?.taskId === upstream.taskId || e.payload?.taskId === downstream.taskId)
    const cancelledIdx = events.findIndex((e) => e.type === 'task.cancelled' && e.payload.taskId === upstream.taskId)
    const rewiredIdx = events.findIndex((e) => e.type === 'task.rewired' && e.payload.taskId === downstream.taskId)
    assert.ok(cancelledIdx >= 0 && rewiredIdx > cancelledIdx, '取消先于改挂')
    assert.equal(events[rewiredIdx].actor, 'human', '面板发起记人工')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t51-2: 不指定 rewireTo = 解除依赖（下游变独立任务）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t51-detach-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const upstream = (await remote.createTask({ teamId, task: TASK })) as any
    const downstream = (await remote.createTask({ teamId, task: { ...TASK, title: '下游', deps: [upstream.taskId] } })) as any
    const done = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: '不做了', downstream: 'rewire', confirm: true })) as any
    assert.equal(done.status, 'cancelled')
    assert.equal(done.rewired[0].added, undefined, '未指定新上游 = 解除依赖')
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[downstream.taskId].input.deps, [])
    assert.equal(proj.tasks[downstream.taskId].rewiredFrom?.added, undefined)
    // 解除依赖后它没有待完成依赖了 → 应从"待规划"进"就绪"（否则看板列与 claim 口径不一致）
    assert.equal(proj.tasks[downstream.taskId].state, 'ready', '无待完成依赖的下游应进就绪列')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t51-3: 领域校验 —— 新上游不存在 / 自身 / 已取消 / 成环 都要被拒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t51-guard-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const upstream = (await remote.createTask({ teamId, task: TASK })) as any
    const downstream = (await remote.createTask({ teamId, task: { ...TASK, title: '下游', deps: [upstream.taskId] } })) as any
    const cancelled = (await remote.createTask({ teamId, task: { ...TASK, title: '已取消' } })) as any

    // 不存在的新上游
    const ghost = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: 'x', downstream: 'rewire', rewireTo: 'ghost', confirm: true })) as any
    assert.equal(ghost.status, 'error')
    assert.equal(ghost.code, 'MT_VALIDATION')

    // 自身
    const self = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: 'x', downstream: 'rewire', rewireTo: upstream.taskId, confirm: true })) as any
    assert.equal(self.status, 'error')
    assert.match(String(self.message), /itself/)

    // 已取消的上游不能当新依赖
    await remote.cancelTask({ teamId, taskId: cancelled.taskId, reason: '先取消', confirm: true })
    const dead = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: 'x', downstream: 'rewire', rewireTo: cancelled.taskId, confirm: true })) as any
    assert.equal(dead.status, 'error')
    assert.match(String(dead.message), /cancelled/)

    // 成环：把下游挂到它自己的下游上
    const chain = (await remote.createTask({ teamId, task: { ...TASK, title: '链条', deps: [downstream.taskId] } })) as any
    const cycle = (await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: 'x', downstream: 'rewire', rewireTo: chain.taskId, confirm: true })) as any
    assert.equal(cycle.status, 'error')
    assert.equal(cycle.code, 'MT_TASK_CYCLE')
    // CHG-75：改挂非法时**取消也不能落**——取消不可逆，改挂可回滚（预检就是为了这个）
    const projAfter = host.service(teamId).projectionSnapshot
    assert.notEqual(projAfter.tasks[upstream.taskId].state, 'cancelled', '预检失败不应留下"已取消但没改挂"的半吊子状态')
    assert.equal(ledgerOf(host, teamId).filter((e) => e.type === 'task.cancelled' && e.payload.taskId === upstream.taskId).length, 0, '账本里也不该有这笔取消')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t51-4: 只改直接下游；传递下游随链条自动受益（不被重复改写）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t51-chain-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const a = (await remote.createTask({ teamId, task: TASK })) as any
    const b = (await remote.createTask({ teamId, task: { ...TASK, title: 'B', deps: [a.taskId] } })) as any
    const c = (await remote.createTask({ teamId, task: { ...TASK, title: 'C', deps: [b.taskId] } })) as any
    const done = (await remote.cancelTask({ teamId, taskId: a.taskId, reason: '换方向', downstream: 'rewire', confirm: true })) as any
    assert.deepEqual(done.rewired.map((r: any) => r.taskId), [b.taskId], '只改直接下游 B')
    const proj = host.service(teamId).projectionSnapshot
    assert.deepEqual(proj.tasks[b.taskId].input.deps, [], 'B 解除依赖')
    assert.deepEqual(proj.tasks[c.taskId].input.deps, [b.taskId], 'C 不动（它依赖的是 B，B 已自由）')
    assert.equal(proj.tasks[c.taskId].rewiredFrom, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t51-5: 改挂后下游不再报 dep-cancelled（依赖已换掉）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t51-diag-'))
  try {
    const { host, remote, teamId } = await setupTeam(root)
    const upstream = (await remote.createTask({ teamId, task: TASK })) as any
    const downstream = (await remote.createTask({ teamId, task: { ...TASK, title: '下游', deps: [upstream.taskId] } })) as any
    const other = (await remote.createTask({ teamId, task: TASK })) as any
    await remote.cancelTask({ teamId, taskId: upstream.taskId, reason: '换方向', downstream: 'rewire', rewireTo: other.taskId, confirm: true })
    const proj = host.service(teamId).projectionSnapshot
    const diag = (await remote.getTaskDetail({ teamId, taskId: downstream.taskId })) as any
    assert.equal(diag.detail.rewiredFrom?.removed, upstream.taskId)
    assert.equal(diag.detail.rewiredFrom?.added, other.taskId)
    // 依赖已换成未完成的 other → 变成 deps-pending（而不是 dep-cancelled）
    const codes = diag.detail.diagnosis?.codes ?? []
    assert.ok(!codes.includes('dep-cancelled'), `不应再报 dep-cancelled：${codes.join(',')}`)
    assert.ok(codes.includes('deps-pending'))
    void proj
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
