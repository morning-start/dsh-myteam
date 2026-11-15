/**
 * T145 · CHG-202x（P0-1）：**任务删除**（产品定案「任务不能手动建，但是可以手动删除」）。
 *
 * 为什么必须有这一份：审计（docs/25 §P0-1）发现此前的「删除入口保留」是**假绿**——
 * `t53-p3-client.test.ts` 的断言唯一匹配源是一条注释，**能力一行都没实现**。本文件用
 * 真渲染 / 真账本来锁住这条能力：
 *  ① 账本：`task.deleted` 让任务从投影里消失（历史事件保留）；
 *  ② 下游解锁：删除上游后，下游的 deps 被摘掉且 backlog → ready（不会永久死锁）；
 *  ③ 两段确认：第一次返回影响面、账本零写入；带 confirm=true 才落账；
 *  ④ 客户端：makeApi 暴露 deleteTask、TaskDetail 有真按钮且两段确认；
 *  ⑤ 端到端：删除后 getBoard / getTaskDetail 都看不到它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { foldEvents } from '../src/core/scheduler/fold.ts'
import type { LedgerEvent } from '../src/core/ledger/ledger.ts'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

function makeRuntime(root: string) {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

function setup(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const remote = new MyTeamRemote(rt, host)
  return { host, remote }
}

function taskOf(title: string, deps: string[] = []) {
  return {
    title,
    description: 'd',
    acceptanceCriteria: ['AC1'],
    deliverableSpec: { path: `docs/${title}.md`, producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
    deps,
    requiredRole: 'implementer',
    taskType: 'default',
    estimate: 'S',
  }
}

/** 建团队（active）+ 两个任务：B 依赖 A */
async function seedTwoTasks(host: MyTeamHost, remote: MyTeamRemote) {
  host.executeLeadTool('myteam_submit_plan', { teamId: 'default', teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {})
  await remote.planAction({ teamId: 'default', action: 'approve' })
  const a = host.executeLeadTool('myteam_create_task', { teamId: 'default', task: taskOf('A') }, {}) as any
  const b = host.executeLeadTool('myteam_create_task', { teamId: 'default', task: taskOf('B', [a.taskId]) }, {}) as any
  return { aId: a.taskId as string, bId: b.taskId as string }
}

test('t145-1: fold —— task.deleted 把任务从投影移除，并让下游解除依赖、backlog → ready', () => {
  const base = 1_700_000_000_000
  const events: LedgerEvent[] = [
    { seq: 1, ts: base, actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } },
    { seq: 2, ts: base + 1, actor: 'human', type: 'team.created', payload: { teamId: 'default', name: 'T', goal: 'G' } },
    { seq: 3, ts: base + 2, actor: 'human', type: 'plan.approved', payload: { teamId: 'default', planId: 'p1' } },
    {
      seq: 4, ts: base + 3, actor: 'human', type: 'task.created',
      payload: { teamId: 'default', taskId: 'task-a', task: taskOf('A') as unknown as Record<string, unknown> },
    },
    {
      seq: 5, ts: base + 4, actor: 'human', type: 'task.created',
      payload: { teamId: 'default', taskId: 'task-b', task: taskOf('B', ['task-a']) as unknown as Record<string, unknown> },
    },
    { seq: 6, ts: base + 5, actor: 'human', type: 'task.deleted', payload: { teamId: 'default', taskId: 'task-a' } },
  ]
  const proj = foldEvents('default', events)
  assert.equal(proj.tasks['task-a'], undefined, '被删任务必须从投影消失')
  assert.ok(proj.tasks['task-b'], '下游任务仍在')
  assert.deepEqual(proj.tasks['task-b'].input.deps, [], '下游必须解除对被删任务的依赖')
  assert.equal(proj.tasks['task-b'].state, 'ready', '解除依赖后必须变 ready（否则永远领不到）')
  assert.equal(proj.participations['task-a'], undefined, '参与边必须一并收掉（不留悬空引用）')
})

test('t145-2: 两段确认 —— 第一次只返回影响面（账本零写入），confirm=true 才落账', async () => {
  const root = mkdtempSync(join(tmpdir(), 't145-2-'))
  try {
    const { host, remote } = setup(root)
    const { aId, bId } = await seedTwoTasks(host, remote)
    const svc = host.service('default')
    const before = (svc.projectionSnapshot as any).revision

    const first = await remote.deleteTask({ teamId: 'default', taskId: aId })
    assert.equal(first.status, 'confirm-required', '不带 confirm 必须停在确认段')
    assert.deepEqual((first as any).impact.dependents, [bId], '影响面必须列出直接下游')
    assert.equal((svc.projectionSnapshot as any).revision, before, '确认段账本零写入')
    assert.ok(svc.projectionSnapshot.tasks[aId], '确认段任务仍在')

    const second = await remote.deleteTask({ teamId: 'default', taskId: aId, confirm: true })
    assert.equal(second.status, 'deleted')
    assert.equal(svc.projectionSnapshot.tasks[aId], undefined, '落账后任务从投影消失')
    assert.equal(svc.projectionSnapshot.tasks[bId].state, 'ready', '下游解锁变 ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t145-3: 端到端 —— 删除后看板与详情都看不到它，且账本保留历史事件', async () => {
  const root = mkdtempSync(join(tmpdir(), 't145-3-'))
  try {
    const { host, remote } = setup(root)
    const { aId } = await seedTwoTasks(host, remote)
    await remote.deleteTask({ teamId: 'default', taskId: aId, confirm: true })

    const board: any = await remote.getBoard({ teamId: 'default' })
    const ids = board.board.columns.flatMap((col: any) => col.tasks.map((task: any) => task.id))
    assert.ok(!ids.includes(aId), '看板上不能再出现被删任务')

    const detail: any = await remote.getTaskDetail({ teamId: 'default', taskId: aId })
    assert.equal(detail.status, 'error', '详情端点必须报错（不是「还在」）')

    // 账本只追加不删行：task.created 与 task.deleted 都在
    const ledger = host.service('default').ledgerPath
    const types = readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line).type)
    assert.ok(types.includes('task.created'), '历史事件保留（task.created）')
    assert.ok(types.includes('task.deleted'), '删除事件留痕（task.deleted）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t145-4: 删除不存在的任务 → MT_VALIDATION（不静默成功）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't145-4-'))
  try {
    const { host, remote } = setup(root)
    await seedTwoTasks(host, remote)
    const r: any = await remote.deleteTask({ teamId: 'default', taskId: 'nope', confirm: true })
    assert.equal(r.status, 'error')
    assert.equal(r.code, 'MT_VALIDATION')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t145-5: 客户端 —— makeApi 暴露 deleteTask；TaskDetail 有真按钮且两段确认', () => {
  assert.match(clientSource, /deleteTask: \(query\) => call\('deleteTask', query\)/, 'makeApi 必须暴露 deleteTask')
  assert.match(clientSource, /onDelete: openTask\.online \? deleteTaskFlow : undefined/, '抽屉必须接收 onDelete')
  assert.match(clientSource, /const deleteTaskFlow = async \(confirm\) =>/, '必须有真实现（不是注释）')
  assert.match(clientSource, /deleteTask\(\{ teamId: openTask\.teamId, taskId: openTask\.taskId, confirm: confirm === true \}\)/, '写调用必须带 confirm 与 taskId')
  // 抽屉侧：真按钮 + 两段确认（先 askDelete 拿影响面，再 doDelete 落账）
  assert.match(clientSource, /const askDelete = async \(\) => \{[\s\S]{0,600}?await onDelete\(false\)/, '第一段必须不带 confirm')
  assert.match(clientSource, /const doDelete = async \(\) => \{[\s\S]{0,400}?await onDelete\(true\)/, '第二段必须带 confirm')
  assert.ok(clientSource.includes("t('detail.deleteTaskBtn')"), '删除按钮文案')
  assert.ok(clientSource.includes("t('detail.deleteImpact')"), '影响面文案（下游条数）')
})
