/**
 * T13p M2 门面测试：MyTeamPanelFacade（根级 typert remote 门面，官方 SessionController 模式）。
 *
 * 覆盖（对应阶段四十九网关契约）：
 *  - namespace 绑定：typertRemote = { serviceKey:'myteamPanel', namespace:'myteam' }（客户端端点 myteam/* 不变）
 *  - marker：60 个方法全部 direct invocation（gateway srcClaims 来源；含 6 个离线只读 + getAudit/getConfig 审计与配置 + memberOp 成员管理 + CHG-69 项目聚合/角色详情）
 *  - 方法签名：简单标识符（agent/query）——gateway methodParameterNames 用 Function.toString 读形参名，
 *    首参 `agent` 必须命中 dsh-agent lookup（wire=agentId）；离线视图方法无 agent 首参，只收 query
 *  - 委托：serviceFor(agent,'myteam') → 隔离服务方法透传 query
 *  - 降级：非队长会话（serviceFor undefined / registry 缺失）→ {status:'unavailable'}
 *  - 发现：listTeams 聚合队长会话（sessionId=agent.session.id，agents store 键同命名空间）
 *  - unwrapExports 纪律：apply 函数带 .inject 属性
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MyTeamPanelFacade, apply } from '../src/panel.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { apply as hostApply } from '../src/host.ts'

const DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 隔离服务的桩（形状 = RemoteLike，行为只回显 query 便于断言透传） */
const stubRemote = {
  defaultTeamId: () => 'default',
  describe: () => ({
    teamId: 'default',
    name: '登录改造',
    workspaceRoot: '/ws/proj',
    goal: '目标',
    state: 'active',
    members: [{ roleId: 'developer', instanceName: 'dev-1', status: 'active', currentTaskId: '' }],
    counts: { tasks: 3, done: 1, running: 1 },
  }),
  getBoard: async (q: Record<string, unknown>) => ({ ok: 'board', q }),
  getTaskDetail: async (q: Record<string, unknown>) => ({ ok: 'detail', q }),
  getTokens: async (q: Record<string, unknown>) => ({ ok: 'tokens', q }),
  getInbox: async (q: Record<string, unknown>) => ({ ok: 'inbox', q }),
  planAction: async (q: Record<string, unknown>) => ({ ok: 'plan', q }),
  postComment: async (q: Record<string, unknown>) => ({ ok: 'comment', q }),
  memberOp: async (q: Record<string, unknown>) => ({ ok: 'member', q }),
  disband: async (q: Record<string, unknown>) => ({ ok: 'disband', q }),
  getRoles: async (q: Record<string, unknown>) => ({ ok: 'roles', q }),
  getKnowledge: async (q: Record<string, unknown>) => ({ ok: 'knowledge', q }),
  getAudit: async (q: Record<string, unknown>) => ({ ok: 'audit', q }),
  getConfig: async (q: Record<string, unknown>) => ({ ok: 'config', q }),
  getPresets: async (q: Record<string, unknown>) => ({ ok: 'presets', q }),
}

const captainAgent = (id: string) => ({ session: { id } })

/** 构造门面（mock ctx 走 normalizeCtx 降级面）；teams=队长 sessionId 列表 */
function makeFacade(teams: string[] = ['s-1'], serviceForImpl?: (agent: unknown, name: string) => unknown) {
  const agents = { list: () => teams.map(captainAgent) }
  const agentPresets = { serviceFor: serviceForImpl ?? ((agent: unknown, name: string) => (name === 'myteam' ? stubRemote : undefined)) }
  const facade = new MyTeamPanelFacade({ agents, agentPresets })
  return { facade, agents, agentPresets }
}

test('t13p-1: typertRemote 绑定 serviceKey=myteamPanel + namespace=myteam（客户端端点不变）', () => {
  const { facade } = makeFacade()
  const binding = (facade as any).typertRemote
  assert.equal(binding.serviceKey, 'myteamPanel')
  assert.equal(binding.namespace, 'myteam')
})

test('t13p-2: marker 60 方法全部 direct invocation（CHG-204：退役 3 个无调用者 RPC）', () => {
  const d = (MyTeamPanelFacade.prototype as any)[DESCRIPTOR]
  assert.ok(d, 'prototype 上必须有 remote-methods 描述符')
  assert.equal(d.version, 1)
  const names = d.methods.map((m: any) => m.method)
  assert.deepEqual(names, ['batch', 'describe', 'watch', 'getGlobalScope', 'getProjectScope', 'getStoreState', 'initStore', 'getProject', 'getRoleDetail', 'saveRole', 'deleteRole', 'getCapabilityCatalog', 'getOfflineBoard', 'getOfflineTaskDetail', 'getOfflineTokens', 'getOfflineAudit', 'getOfflinePlanFeedback', 'getOfflinePresets', 'getBoard', 'getTaskDetail', 'getTokens', 'getInbox', 'getAudit', 'getConfig', 'getPresets', 'getRoles', 'getKnowledge', 'planAction', 'postComment', 'memberOp', 'disband', 'createTask', 'updateTask', 'assignTask', 'participateTask', 'rescopeTask', 'cancelTask', 'deleteTask', 'getProjectBoard', 'getProjectSummary', 'batchTaskOp', 'reviewTask', 'getArchive', 'adoptKnowledge', 'roleOp', 'applyRoles', 'handoff', 'getContributions', 'reloadContributions', 'saveTeamConfig', 'resetTeamConfig', 'getPlanFeedback', 'readSessionHistory', 'getTaskGraph', 'listSkills', 'listMembers', 'copyTeam', 'publishTeam', 'exportTeam', 'createSkill', 'createTool'])
  for (const m of d.methods) assert.deepEqual(m.invocation, { kind: 'direct' })
})

test('t13p-3: 方法签名 = 简单标识符 (agent, query)；listTeams/saveRole 无 agent 首参（gateway methodParameterNames 契约）', () => {
  const proto = MyTeamPanelFacade.prototype as Record<string, Function>
  // CHG-87：roleOp 只收 query（无 agent 首参，同离线视图口径）；applyRoles 是会话门面 (agent, query)
  const withAgent = ['getBoard', 'getTaskDetail', 'getTokens', 'getInbox', 'getAudit', 'getConfig', 'saveTeamConfig', 'resetTeamConfig', 'getPlanFeedback', 'readSessionHistory', 'getTaskGraph', 'listSkills', 'listMembers', 'copyTeam', 'publishTeam', 'exportTeam', 'createSkill', 'createTool', 'getPresets', 'getRoles', 'getKnowledge', 'planAction', 'postComment', 'memberOp', 'disband', 'createTask', 'updateTask', 'assignTask', 'participateTask', 'reviewTask', 'getArchive', 'adoptKnowledge', 'applyRoles']
  for (const name of withAgent) {
    const src = proto[name].toString()
    const m = src.match(/^async\s+\w+\s*\(([^)]*)\)/)
    assert.ok(m, `${name} 应为 async 方法`)
    const params = m![1].split(',').map((s) => s.trim()).filter(Boolean)
    assert.deepEqual(params, ['agent', 'query'], `${name} 形参必须是 (agent, query)，实际 ${JSON.stringify(params)}`)
  }
  /* CHG-201：全局页无参（只读全局资产）；项目页按 agent 解析会话工作区。 */
  const gs = proto.getGlobalScope.toString()
  assert.match(gs, /^async\s+getGlobalScope\s*\(\s*\)/, 'getGlobalScope 必须无参')
  const gps = proto.getProjectScope.toString()
  assert.match(gps, /^async\s+getProjectScope\s*\(\s*agent\s*\)/, 'getProjectScope 必须收 agent 首参')
  // T25：离线视图方法没有 agent 首参（网关 args 只发 {query}），形参必须是单个 query
  for (const name of ['getOfflineBoard', 'getOfflineTaskDetail', 'getOfflineTokens', 'getOfflineAudit', 'getOfflinePlanFeedback', 'getOfflinePresets', 'saveRole', 'roleOp', 'getStoreState', 'initStore']) {
    const m = proto[name].toString().match(/^async\s+\w+\s*\(([^)]*)\)/)
    assert.ok(m, `${name} 应为 async 方法`)
    assert.deepEqual(m![1].split(',').map((s) => s.trim()).filter(Boolean), ['query'], `${name} 只接受 query`)
  }
})

test('t13p-4: 会话门面委托 serviceFor(agent,"myteam") 并透传 query', async () => {
  const { facade } = makeFacade()
  const agent = captainAgent('s-1')
  assert.deepEqual(await facade.getBoard(agent, { teamId: 't1' }), { ok: 'board', q: { teamId: 't1' } })
  assert.deepEqual(await facade.getTaskDetail(agent, { teamId: 't1', taskId: 'k1' }), { ok: 'detail', q: { teamId: 't1', taskId: 'k1' } })
  assert.deepEqual(await facade.getTokens(agent, {}), { ok: 'tokens', q: {} })
  assert.deepEqual(await facade.getInbox(agent, undefined as never), { ok: 'inbox', q: {} }, 'query 缺省 → {}')
  assert.deepEqual(await facade.planAction(agent, { teamId: 't1', action: 'approve' }), { ok: 'plan', q: { teamId: 't1', action: 'approve' } })
  assert.deepEqual(await facade.postComment(agent, { teamId: 't1', taskId: 'k1', content: 'hi' }), { ok: 'comment', q: { teamId: 't1', taskId: 'k1', content: 'hi' } })
  assert.deepEqual(await facade.memberOp(agent, { teamId: 't1', memberId: 'm1', op: 'suspend' }), { ok: 'member', q: { teamId: 't1', memberId: 'm1', op: 'suspend' } })
  assert.deepEqual(await facade.disband(agent, { teamId: 't1', confirm: true }), { ok: 'disband', q: { teamId: 't1', confirm: true } })
  assert.deepEqual(await facade.getRoles(agent, {}), { ok: 'roles', q: {} })
  assert.deepEqual(await facade.getKnowledge(agent, { teamId: 't1' }), { ok: 'knowledge', q: { teamId: 't1' } })
  assert.deepEqual(await facade.getAudit(agent, { teamId: 't1', limit: 20 }), { ok: 'audit', q: { teamId: 't1', limit: 20 } })
  assert.deepEqual(await facade.getConfig(agent, { teamId: 't1' }), { ok: 'config', q: { teamId: 't1' } })
  assert.deepEqual(await facade.getPresets(agent, {}), { ok: 'presets', q: {} })
})

test('t13p-5: 非队长会话 → {status:"unavailable"}（serviceFor undefined / registry 缺失）', async () => {
  const { facade } = makeFacade(['s-1'], () => undefined)
  const r = await facade.getBoard(captainAgent('s-other'), {})
  assert.deepEqual(r, { status: 'unavailable', reason: 'myteam preset service unavailable in this session' })
  const { facade: f2 } = makeFacade()
  const bare = new MyTeamPanelFacade({}) // ctx 上没有 agentPresets
  const r2 = await bare.getInbox(captainAgent('s-1'), {})
  assert.equal((r2 as any).status, 'unavailable')
})

test('t13p-6: getProjectScope 按会话工作区解析本项目团队（同团队多会话去重）', async () => {
  const { facade } = makeFacade(['s-1', 's-2'])
  const r = await facade.getProjectScope(captainAgent('s-1'))
  assert.equal(r.status, 'ok')
  assert.equal(r.workspaceRoot, '/ws/proj', '工作区来自会话（describe 回落）')
  assert.equal(r.teams.length, 1, '两个会话指向同一团队 → 去重为一条')
  assert.equal(r.teams[0].teamId, 'default')
  assert.equal(r.teams[0].online, true)
  /* 无队长会话 → 没有团队（且不枚举别的项目） */
  const { facade: f3 } = makeFacade([])
  const empty = await f3.getProjectScope(captainAgent('s-1'))
  assert.equal(empty.status, 'ok')
  assert.deepEqual(empty.teams, [])
})

test('t13p-6b: 隔离服务无 describe 时无法解析工作区 → 空作用域（不猜项目）', async () => {
  const legacyRemote = { ...stubRemote, describe: undefined }
  delete (legacyRemote as any).describe
  const { facade } = makeFacade(['s-1'], () => legacyRemote)
  const r = await facade.getProjectScope(captainAgent('s-1'))
  assert.equal(r.status, 'ok')
  assert.equal(r.workspaceRoot, '')
  assert.deepEqual(r.teams, [])
})

test('t13p-6d: 离线视图参数校验（相对路径 / 路径穿越 / 空 teamId 一律 MT_VALIDATION）', async () => {
  const { facade } = makeFacade()
  const bad = [
    {},
    { workspaceRoot: 'relative/ws', teamId: 't1' },
    { workspaceRoot: join(tmpdir(), 'ws'), teamId: '../evil' },
    { workspaceRoot: join(tmpdir(), 'ws'), teamId: '' },
  ]
  for (const q of bad) {
    const r = await facade.getOfflineBoard(q as never)
    assert.equal((r as any).code, 'MT_VALIDATION', `getOfflineBoard 拒绝 ${JSON.stringify(q)}`)
    const d = await facade.getOfflineTaskDetail({ ...q, taskId: 'task-1' } as never)
    assert.equal((d as any).code, 'MT_VALIDATION', `getOfflineTaskDetail 拒绝 ${JSON.stringify(q)}`)
    const tk = await facade.getOfflineTokens(q as never)
    assert.equal((tk as any).code, 'MT_VALIDATION', `getOfflineTokens 拒绝 ${JSON.stringify(q)}`)
    const au = await facade.getOfflineAudit(q as never)
    assert.equal((au as any).code, 'MT_VALIDATION', `getOfflineAudit 拒绝 ${JSON.stringify(q)}`)
    // CHG-69：模板目录只依赖 workspaceRoot（项目管理不需要 teamId），teamId 非法不再拒绝
    if (!q.workspaceRoot || q.workspaceRoot === 'relative/ws') {
      const ps = await facade.getOfflinePresets(q as never)
      assert.equal((ps as any).code, 'MT_VALIDATION', `getOfflinePresets 拒绝 ${JSON.stringify(q)}`)
    }
  }
})

test('t13p-6e: 离线看板/详情从 ledger.jsonl 折叠（无队长会话，只读）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-offline-'))
  try {
    const teamDir = join(ws, '.dsh-myteam', 'tasks', 't-off')
    mkdirSync(teamDir, { recursive: true })
    const ts = Date.now()
    const events = [
      { seq: 1, ts, actor: 'lead', type: 'team.created', payload: { teamId: 't-off', name: '离线队', goal: '离线目标' } },
      { seq: 2, ts, actor: 'lead', type: 'task.created', payload: { taskId: 'task-1', task: { title: '离线任务', requiredRole: 'developer', priority: 'P1', acceptanceCriteria: ['ac'], deps: [], gateChain: ['review'] } } },
    ]
    writeFileSync(join(teamDir, 'ledger.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')

    writeFileSync(join(teamDir, 'tokens.json'), JSON.stringify({
      version: 1,
      teamId: 't-off',
      updatedAt: ts,
      days: {},
      totals: { 'dev-1': { uncachedInput: 100, cacheRead: 50, cacheWrite: 0, output: 20, calls: 2 } },
      note: 'heuristic',
    }))

    const { facade } = makeFacade([])
    const r: any = await facade.getOfflineBoard({ workspaceRoot: ws, teamId: 't-off' })
    assert.equal(r.status, 'ok')
    assert.equal(r.readOnly, true)
    assert.equal(r.online, false)
    assert.equal(r.board.goal, '离线目标')
    const backlog = r.board.columns.find((c: any) => c.name === 'backlog')
    assert.deepEqual(backlog.tasks.map((task: any) => task.id), ['task-1'])
    assert.ok(r.meta.updatedAt > 0)

    const d: any = await facade.getOfflineTaskDetail({ workspaceRoot: ws, teamId: 't-off', taskId: 'task-1' })
    assert.equal(d.status, 'ok')
    assert.equal(d.detail.input.title, '离线任务')
    assert.ok(d.detail.timeline.some((e: any) => e.type === 'task.created'))
    assert.deepEqual(d.detail.gates, ['review'], '详情带门禁链（CHG-47）')
    assert.equal(d.readOnly, true)

    const tk: any = await facade.getOfflineTokens({ workspaceRoot: ws, teamId: 't-off' })
    assert.equal(tk.status, 'ok')
    assert.equal(tk.tokens.caliber, 'heuristic', 'REV-5 双口径标注')
    assert.equal(tk.tokens.totals['dev-1'].calls, 2)
    assert.ok(Math.abs(tk.tokens.totals['dev-1'].hitRate - 50 / 150) < 1e-9, '命中率派生')

    const au: any = await facade.getOfflineAudit({ workspaceRoot: ws, teamId: 't-off', limit: 1 })
    assert.equal(au.status, 'ok')
    assert.equal(au.readOnly, true)
    assert.equal(au.events.length, 1)
    assert.equal(au.events[0].seq, 2, '新→旧，取最后一条')
    assert.equal(au.nextBeforeSeq, 2, '还有更早事件')

    const ps: any = await facade.getOfflinePresets({ workspaceRoot: ws, teamId: 't-off' })
    assert.equal(ps.status, 'ok')
    assert.equal(ps.readOnly, true)
    assert.ok(ps.entries.some((entry: any) => entry.origin === 'builtin' && entry.definition.id === 'starter-team'), '内置开箱团队可见')
    assert.equal(ps.entries.find((entry: any) => entry.definition.id === 'starter-team').definition.members.length, 3)
    assert.ok(!ps.entries.find((entry: any) => entry.definition.id === 'starter-team').definition.members.some((member: any) => member.roleId === 'captain'))

    const missing: any = await facade.getOfflineTaskDetail({ workspaceRoot: ws, teamId: 't-off', taskId: 'nope' })
    assert.equal(missing.code, 'MT_VALIDATION')

    const empty: any = await facade.getOfflineBoard({ workspaceRoot: ws, teamId: 't-empty' })
    assert.equal(empty.status, 'empty')
    const noTokens: any = await facade.getOfflineTokens({ workspaceRoot: ws, teamId: 't-empty' })
    assert.equal(noTokens.status, 'empty')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('t13p-7: apply 导出带 .inject 属性（unwrapExports 纪律：named inject 会被 loader 丢弃）', () => {
  assert.equal(typeof apply, 'function')
  assert.deepEqual((apply as any).inject, ['agents', 'agentPresets'])
})

test('t13p-8: 隔离服务 MyTeamRemote 的 marker 不含 defaultTeamId（门面发现通道不进网关）', () => {
  const d = (MyTeamRemote.prototype as any)[DESCRIPTOR]
  const names = d.methods.map((m: any) => m.method)
  assert.ok(!names.includes('defaultTeamId'), 'defaultTeamId 只作门面发现通道，不应暴露为网关端点')
  /* CHG-139a~d：+getTaskGraph/+listSkills/+copyTeam/+publishTeam/+exportTeam/+createSkill/+createTool = 37（CHG-204 退役 createTasks/getArchives/importTeam） */
  /* CHG-187（FR-32 支柱一）：+listMembers = 38 */
  /* CHG-202z（FR-33）：+getProjectBoard/+getProjectSummary = 41 */
  assert.equal(names.length, 41)
})

test('t13p-9: 载体行 guard —— hostApply(ctx, {carrier:true}) 直接返回（dsh-client-modules 组图载体）', () => {
  const touched: string[] = []
  const ctx = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return undefined } })
  hostApply(ctx as never, { carrier: true } as never)
  assert.deepEqual(touched, [], 'carrier 模式不得触碰 ctx（宿主职责全留 preset 作用域，NFR-7.4）')
})
