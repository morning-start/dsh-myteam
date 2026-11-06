/**
 * CHG-72（FR-27/29/30/31）：面板闭环的四件事里，能纯函数/文件面验证的部分。
 *
 * 1) 任务「无人可领」诊断（readiness）：团队未 active / 依赖未完成 / 名册缺角色 / 角色都在忙；
 * 2) 角色保存（saveProjectRole）：校验同源、同名两段确认、captain 不可覆盖、旁路审计；
 * 3) 门面 saveRole 端点：路径校验 → 保存 → 确认态；
 * 4) 面板新建/编辑任务（remote createTask/updateTask）：actor=human 落账、结构守卫仍生效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyProjection, validatePlan, type TeamProjection, type TaskInput, type TaskProjection } from '../src/core/scheduler/state.ts'
import { diagnoseTask } from '../src/core/tasks/readiness.ts'
import { listRoleCatalog, saveProjectRole } from '../src/core/roles/role-store.ts'
import { projectRolePaths } from '../src/core/index/offline-view.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'

/* ── 1. 诊断纯函数 ─────────────────────────────────────────── */

const task = (over: Partial<Omit<TaskProjection, 'input'>> & { input?: Partial<TaskProjection['input']> } = {}): TaskProjection => {
  const { input: inputOver, ...rest } = over
  return {
    id: 't1',
    input: {
      title: 'T', description: 'd', acceptanceCriteria: ['AC1'], deps: [], requiredRole: 'implementer', priority: 'P2',
      ...(inputOver ?? {}),
    },
    state: 'ready',
    escalateCount: 0,
    gates: [],
    gateVerdicts: {},
    evidenceRefs: [],
    deliverables: [],
    createdAt: 1,
    ...rest,
  }
}

const projection = (over: Partial<TeamProjection> = {}): TeamProjection => ({
  ...emptyProjection('t1'),
  state: 'active',
  ...over,
})

test('t46-1: 名册缺 requiredRole → no-role（派人也没用，先加队员/换角色）', () => {
  const proj = projection({ tasks: { t1: task({ input: { requiredRole: 'reviewer' } }) } })
  const d = diagnoseTask(proj, 't1')
  assert.deepEqual(d?.codes, ['no-role'])
  assert.equal(d?.roleId, 'reviewer')
  assert.equal(d?.roleMembers, 0)
})

test('t46-2: 依赖未完成 → deps-pending（含账本里不存在的依赖 id）', () => {
  const proj = projection({
    members: { m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl', status: 'active', spawnedAt: 1 } },
    tasks: {
      t1: task({ input: { deps: ['t0', 'ghost'] } }),
      t0: task({ id: 't0', state: 'in_progress' }),
    },
  })
  const d = diagnoseTask(proj, 't1')
  assert.ok(d?.codes.includes('deps-pending'))
  assert.deepEqual(d?.depsPending, ['t0', 'ghost'])
  assert.ok(!d?.codes.includes('no-role'), '角色有人时不应误报缺角色')
})

test('t46-3: 该角色的人都在跑 → role-busy（给出实例名）', () => {
  const proj = projection({
    members: { m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl', status: 'active', currentTaskId: 't0', spawnedAt: 1 } },
    tasks: { t1: task(), t0: task({ id: 't0', state: 'in_progress' }) },
  })
  const d = diagnoseTask(proj, 't1')
  assert.deepEqual(d?.codes, ['role-busy'])
  assert.deepEqual(d?.busyMembers, ['impl'])
})

test('t46-4: 团队不在 active → team-inactive；已开跑/已完成的任务不诊断', () => {
  const draft = projection({
    state: 'draft',
    members: { m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl', status: 'active', spawnedAt: 1 } },
    tasks: { t1: task() },
  })
  assert.deepEqual(diagnoseTask(draft, 't1')?.codes, ['team-inactive'])
  const running = projection({
    members: { m1: { id: 'm1', roleId: 'implementer', instanceName: 'impl', status: 'active', spawnedAt: 1 } },
    tasks: { t1: task({ state: 'in_progress' }), t2: task({ id: 't2', state: 'done' }) },
  })
  assert.equal(diagnoseTask(running, 't1'), undefined)
  assert.equal(diagnoseTask(running, 't2'), undefined)
})

/* ── 2. 角色保存（配置资产） ────────────────────────────────── */

const roleDef = (over: Record<string, unknown> = {}) => ({
  id: 'reviewer-x', name: '评审员X', description: '评审', systemPrompt: '你是评审员', skills: [], mcpAllowlist: [], interestWords: ['代码审查'], ...over,
})

test('t46-5: saveProjectRole 新建/覆盖两段确认/captain 守卫/审计行', () => {
  const root = mkdtempSync(join(tmpdir(), 't46-role-'))
  try {
    const paths = projectRolePaths(root)
    const first = saveProjectRole(paths, roleDef() as never, { actor: 'human' })
    assert.equal(first.action, 'created')
    assert.ok(existsSync(first.filePath))
    assert.equal(JSON.parse(readFileSync(first.filePath, 'utf8')).id, 'reviewer-x')
    assert.equal(listRoleCatalog(paths).filter((e) => e.origin === 'project').length, 1)

    // 同名再存（无 overwrite）→ MT_ROLE_EXISTS，不静默覆盖
    assert.throws(() => saveProjectRole(paths, roleDef({ name: '改名' }) as never), /already exists/)
    // 显式覆盖 → updated，名字生效
    const second = saveProjectRole(paths, roleDef({ name: '改名', version: 2 }) as never, { overwrite: true })
    assert.equal(second.action, 'updated')
    assert.equal(listRoleCatalog(paths).find((e) => e.origin === 'project')?.definition.name, '改名')
    // captain 不允许被项目角色覆盖（名册「有且仅有一个队长」依赖内置身份）
    assert.throws(() => saveProjectRole(paths, roleDef({ id: 'captain' }) as never, { overwrite: true }), /builtin identity/)
    // 审计行：每次写入一行，谁/何时/哪个文件
    const audit = readFileSync(second.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(audit.length, 2)
    assert.deepEqual(audit.map((row) => row.action), ['created', 'updated'])
    assert.equal(audit[0].actor, 'human')
    assert.equal(audit[1].roleId, 'reviewer-x')
    // 审计文件不会被当成角色读入
    assert.equal(listRoleCatalog(paths).filter((e) => e.definition.id === '.audit').length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t46-6: 门面 saveRole —— 路径校验 / 首次保存 / 同名 confirm-required / confirm=true 覆盖 / 非法角色回错误码', async () => {
  const root = mkdtempSync(join(tmpdir(), 't46-panel-'))
  try {
    const facade = new MyTeamPanelFacade({ agents: { list: () => [] }, agentPresets: { serviceFor: () => undefined } })
    assert.equal((await facade.saveRole({ workspaceRoot: 'relative/path', role: roleDef() })).status, 'error')
    assert.equal((await facade.saveRole({ workspaceRoot: root })).code, 'MT_VALIDATION')

    const saved = (await facade.saveRole({ workspaceRoot: root, role: roleDef() })) as any
    assert.equal(saved.status, 'saved')
    assert.equal(saved.action, 'created')

    const pending = (await facade.saveRole({ workspaceRoot: root, role: roleDef({ name: '再存' }) })) as any
    assert.equal(pending.status, 'confirm-required')
    assert.equal(pending.existing.id, 'reviewer-x')

    const overwritten = (await facade.saveRole({ workspaceRoot: root, role: roleDef({ name: '再存' }), confirm: true })) as any
    assert.equal(overwritten.status, 'saved')
    assert.equal(overwritten.action, 'updated')

    const bad = (await facade.saveRole({ workspaceRoot: root, role: roleDef({ systemPrompt: '' }) })) as any
    assert.equal(bad.status, 'error')
    assert.equal(bad.code, 'MT_ROLE_INVALID')

    const detail = (await facade.getRoleDetail({ workspaceRoot: root, roleId: 'reviewer-x' })) as any
    assert.equal(detail.status, 'ok')
    assert.equal(detail.definition.name, '再存')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t46-8: 增量补独立任务——active 团队允许，草稿计划仍拒绝孤儿（FR-11.2 ⑥ 不被放宽）', () => {
  const input: TaskInput = {
    title: 'T', description: 'd', acceptanceCriteria: ['AC'], deliverableSpec: { path: 'docs/x.md' },
    deps: [], requiredRole: 'implementer', priority: 'P2',
  }
  const tasks = { a: input, b: input }
  assert.ok(validatePlan(tasks, 20, ['implementer']).errors.some((e) => e.message.includes('orphan')))
  assert.deepEqual(validatePlan(tasks, 20, ['implementer'], { allowOrphans: true }).errors, [])
})

/* ── 3. 面板新建/编辑任务（受限写端点） ────────────────────── */

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
  title: '面板建的任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'],
}

test('t46-7: remote.createTask/updateTask 走同一账本管线且 actor=human；结构守卫仍生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 't46-task-'))
  try {
    const rt = makeRuntime(root)
    const host = new MyTeamHost(rt, { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
    host.initialize()
    const remote = new MyTeamRemote(rt, host)
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    await remote.planAction({ teamId: sub.teamId, action: 'approve' })

    const created = (await remote.createTask({ teamId: sub.teamId, task: TASK })) as any
    assert.equal(created.status, 'created')
    const ledger = readFileSync(host.service(sub.teamId).ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const createdEvent = ledger.find((e) => e.type === 'task.created' && e.payload.taskId === created.taskId)
    assert.equal(createdEvent.actor, 'human', '面板新建任务应记人工')

    const updated = (await remote.updateTask({ teamId: sub.teamId, taskId: created.taskId, patch: { title: '改标题', priority: 'P1' } })) as any
    assert.equal(updated.status, 'updated')
    const edited = ledger.concat(readFileSync(host.service(sub.teamId).ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
    assert.equal(edited.filter((e) => e.type === 'task.updated' && e.payload.taskId === created.taskId).at(-1).actor, 'human')

    // 让任务进入执行态，再改 AC → 结构守卫拒绝
    const proj = host.service(sub.teamId).projectionSnapshot
    const member = Object.values(proj.members).find((m) => m.roleId === 'implementer')
    assert.ok(member, 'approve 后名册应有 implementer')
    host.executeMemberTool({ memberId: member!.id, roleId: member!.roleId, instanceName: member!.instanceName, sessionId: member!.sessionId, teamId: sub.teamId }, 'myteam_claim_task', { taskId: created.taskId })
    const structural = (await remote.updateTask({ teamId: sub.teamId, taskId: created.taskId, patch: { acceptanceCriteria: ['新 AC'] } })) as any
    assert.equal(structural.status, 'error')
    assert.equal(structural.code, 'MT_TASK_STRUCTURAL_EDIT')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
