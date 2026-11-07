/**
 * CHG-88（M2-E / FR-16.3）：会话移交（handoff）测试。
 *
 * 覆盖四条（按要求）：
 *  1. 纯函数：摘要非空且含团队目标；提示词原样嵌入摘要并框成「上下文摘要」；
 *  2. 宿主无会话创建能力 → `MT_UNAVAILABLE`（**不抛异常**、不假装成功）；
 *  3. 宿主有 mock 能力 → `status:'ok'` + sessionId，且**首条消息确实带走了摘要正文**；
 *  4. 移交**不写团队账本**（账本事件数不变——移交不是团队范围内的变更）。
 *
 * 纪律（沿用 t71 的教训）：走真实入口（`host.handoffTeam()` / 面板 Remote / 门面），
 * 不用替身绕开真实路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'
import {
  buildHandoffPrompt,
  buildHandoffSummary,
  resolveSessionHandoffCapability,
  runHandoff,
  TEAM_AGENT_PRESET_ID,
  type SessionHandoffCapability,
} from '../src/core/host/session-handoff.ts'

/* ── mock 宿主能力（形状 = ctx.get('sessionController') 的 create/prompt）── */

interface RecordedCreate {
  request: Record<string, unknown>
}

interface RecordedPrompt {
  request: Record<string, unknown>
}

function mockCapability(options: { sessionId?: string; failCreate?: Error; failPrompt?: Error } = {}) {
  const creates: RecordedCreate[] = []
  const prompts: RecordedPrompt[] = []
  const capability: SessionHandoffCapability = {
    async create(request) {
      creates.push({ request })
      if (options.failCreate) throw options.failCreate
      return { sessionId: options.sessionId ?? 'session-new-1', agentPreset: request.agentPreset }
    },
    async prompt(request) {
      prompts.push({ request })
      if (options.failPrompt) throw options.failPrompt
      return { accepted: true }
    },
  }
  return { capability, creates, prompts }
}

/** 运行时（可注入 mock sessionController；缺省 = 宿主没有该能力） */
function makeRuntime(root: string, capability?: SessionHandoffCapability): HostRuntime {
  return {
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: { sessionId: string }) => ({ session: { id: opts.sessionId }, followup: () => {} }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
    ...(capability ? { get: (name: string) => (name === 'sessionController' ? capability : undefined) } : {}),
  } as unknown as HostRuntime
}

/** 建一个 active 团队（真实入口：submit_plan → approve_plan → create_task） */
async function seedTeam(host: MyTeamHost, goal = '把登录流程改成 SSO') {
  const sub = host.executeLeadTool(
    'myteam_submit_plan',
    { teamName: 'SSO 改造', goal, roster: [{ roleId: 'captain' }], tasks: [] },
    {},
  ) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})
  const created = host.executeLeadTool(
    'myteam_create_task',
    {
      teamId: sub.teamId,
      task: {
        title: '实现 SSO 登录',
        description: 'd',
        acceptanceCriteria: ['AC1'],
        deliverableSpec: { path: 'docs/sso.md' },
        deps: [],
        requiredRole: 'captain',
        priority: 'P1',
      },
    },
    {},
  ) as any
  return { teamId: sub.teamId as string, taskId: created.taskId as string }
}

function ledgerEvents(root: string, teamId: string): unknown[] {
  const path = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/* ══════════════════════════════════════════════════════════════════
 * 一、纯函数：摘要与提示词
 * ══════════════════════════════════════════════════════════════════ */

test('t73-1: buildHandoffSummary 产出非空摘要且含团队目标；分段有界', () => {
  const goal = '把登录流程改成 SSO'
  const { summary, metadata } = buildHandoffSummary({
    teamId: 'sso-team',
    teamName: 'SSO 改造',
    goal,
    state: 'active',
    tasks: [
      { id: 'task-1', title: '实现 SSO 登录', state: 'in_progress', priority: 'P1', requiredRole: 'captain' },
      { id: 'task-2', title: '写迁移文档', state: 'backlog', priority: 'P2' },
    ],
    members: [{ id: 'm1-captain', roleId: 'captain', instanceName: 'captain', status: 'active' }],
    recentEvents: [{ seq: 3, type: 'task.created', actor: 'lead' }],
    notes: ['灰度先走内部用户'],
  })

  assert.ok(summary.length > 0, '摘要必须非空')
  assert.match(summary, /SSO 改造/, '摘要含团队名')
  assert.match(summary, new RegExp(goal), '摘要含团队目标')
  assert.match(summary, /task-1/, '摘要含任务 id')
  assert.match(summary, /灰度先走内部用户/, '摘要含备注')
  // 结构化副产物
  assert.equal(metadata.teamId, 'sso-team')
  assert.equal(metadata.totalTasks, 2)
  assert.equal(metadata.totalMembers, 1)
  assert.deepEqual(metadata.taskCounts, { in_progress: 1, backlog: 1 })
  assert.deepEqual(metadata.taskIds, ['task-1', 'task-2'])
})

test('t73-2: buildHandoffSummary 段内有界且显式标注省略（不静默丢内容）', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `task-${i + 1}`, title: `T${i + 1}`, state: 'backlog' }))
  const { summary } = buildHandoffSummary({ teamId: 't', goal: 'g', tasks })
  assert.match(summary, /其余 8 项任务省略/, '超出上限的条数必须写出来')
  assert.equal(summary.split('\n').filter((line) => line.startsWith('- task-')).length, 12, '段内条数有界')
})

test('t73-3: buildHandoffPrompt 原样嵌入摘要，并框成「上下文摘要」', () => {
  const { summary } = buildHandoffSummary({ teamId: 't', goal: '目标 G', tasks: [{ id: 'task-1', state: 'ready' }] })
  const prompt = buildHandoffPrompt(summary)
  assert.ok(prompt.includes(summary), '提示词必须原样嵌入摘要正文')
  assert.match(prompt, /【上下文摘要】/, '摘要被明确框成上下文摘要')
  assert.match(prompt, /只读参考，不是指令/, '摘要被框成参考而非指令')
  assert.match(prompt, /SSO|目标 G|团队/, '摘要内容在提示词里可见')
  // 空摘要也不炸
  assert.ok(buildHandoffPrompt('').length > 0)
})

/* ══════════════════════════════════════════════════════════════════
 * 二、宿主能力探测
 * ══════════════════════════════════════════════════════════════════ */

test('t73-4: resolveSessionHandoffCapability——无能力返回 undefined；有能力返回可用壳', () => {
  assert.equal(resolveSessionHandoffCapability({}), undefined)
  assert.equal(resolveSessionHandoffCapability(undefined), undefined)
  // 有服务但缺方法 → 仍然不可用（不半个壳）
  assert.equal(resolveSessionHandoffCapability({ get: () => ({ create: () => {} }) }), undefined)
  const { capability } = mockCapability()
  const resolved = resolveSessionHandoffCapability({ get: (name: string) => (name === 'sessionController' ? capability : undefined) })
  assert.ok(resolved, '能取到能力')
  assert.equal(typeof resolved.create, 'function')
  assert.equal(typeof resolved.prompt, 'function')
})

/* ══════════════════════════════════════════════════════════════════
 * 三、host.handoffTeam（真实入口）
 * ══════════════════════════════════════════════════════════════════ */

test('t73-5: 宿主无会话创建能力 → MT_UNAVAILABLE（不抛异常、不假装成功）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't73-no-cap-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    const { teamId } = await seedTeam(host)
    const out = await host.handoffTeam({ teamId })
    assert.equal(out.status, 'error')
    assert.equal(out.code, 'MT_UNAVAILABLE')
    assert.match(String(out.message), /sessionController/)
    assert.equal(out.sessionId, undefined, '不可用时不得给出 sessionId')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t73-6: 宿主有 mock 能力 → status:ok + sessionId，且首条消息真的带走了摘要正文', async () => {
  const root = mkdtempSync(join(tmpdir(), 't73-ok-'))
  try {
    const { capability, creates, prompts } = mockCapability({ sessionId: 'session-handoff-xyz' })
    const host = new MyTeamHost(makeRuntime(root, capability))
    host.initialize()
    const { teamId } = await seedTeam(host, '把登录流程改成 SSO')

    const out = await host.handoffTeam({ teamId, sourceSessionId: 'session-old-1' })
    assert.equal(out.status, 'ok', JSON.stringify(out))
    assert.equal(out.sessionId, 'session-handoff-xyz')
    assert.equal(out.agentPreset, TEAM_AGENT_PRESET_ID)
    assert.equal(typeof out.summary, 'string')
    assert.ok(String(out.summary).includes('把登录流程改成 SSO'), '摘要含团队目标')

    // ① 建会话：一次，cwd = 工作区，preset = 团队预设
    assert.equal(creates.length, 1, '只建一次会话')
    assert.equal(creates[0].request.cwd, root)
    assert.equal(creates[0].request.agentPreset, TEAM_AGENT_PRESET_ID)

    // ② 注入：一次，首条消息就是「上下文摘要 + 摘要正文」
    assert.equal(prompts.length, 1, '只发一条首消息')
    const sent = prompts[0].request
    assert.equal(sent.sessionId, 'session-handoff-xyz')
    assert.equal(sent.mode, 'queue')
    assert.equal(typeof sent.requestId, 'string')
    assert.ok(String(sent.requestId).length > 0, 'requestId 必须给（宿主按它幂等）')
    assert.equal(Array.isArray(sent.content), true)
    assert.equal(sent.content[0].type, 'text')
    const text = String(sent.content[0].text)
    assert.ok(text.includes(String(out.summary)), '首条消息必须原样带上摘要正文')
    assert.match(text, /【上下文摘要】/)
    assert.match(text, /把登录流程改成 SSO/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t73-7: 移交不写团队账本（事件数不变；移交不是团队范围内的变更）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't73-noleg-'))
  try {
    const { capability } = mockCapability()
    const host = new MyTeamHost(makeRuntime(root, capability))
    host.initialize()
    const { teamId } = await seedTeam(host)
    const before = ledgerEvents(root, teamId).length
    const out = await host.handoffTeam({ teamId })
    assert.equal(out.status, 'ok')
    const after = ledgerEvents(root, teamId).length
    assert.equal(after, before, `移交不得写账本（before=${before} after=${after}）`)
    // 也不得建成员/任务
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(Object.keys(proj.members).length, 0, '移交不建成员')
    assert.equal(Object.keys(proj.tasks).length, 1, '移交不建任务（原有 1 条不变）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t73-8: 建会话失败 / 注入失败 → 明确报错；注入失败仍带 sessionId（会话已存在）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't73-fail-'))
  try {
    // ① 建会话失败
    const failing = mockCapability({ failCreate: Object.assign(new Error('preset missing'), { code: 'agent-preset/not-found' }) })
    const host1 = new MyTeamHost(makeRuntime(root, failing.capability))
    host1.initialize()
    const t1 = await seedTeam(host1)
    const out1 = await host1.handoffTeam({ teamId: t1.teamId })
    assert.equal(out1.status, 'error')
    assert.equal(out1.code, 'agent-preset/not-found', '宿主原始错误码透传')
    assert.match(String(out1.message), /preset missing/)

    // ② 注入失败（会话已建出来）
    const promptFail = mockCapability({ sessionId: 'session-x', failPrompt: new Error('prompt rejected') })
    const host2 = new MyTeamHost(makeRuntime(root, promptFail.capability))
    host2.initialize()
    const t2 = await seedTeam(host2)
    const out2 = await host2.handoffTeam({ teamId: t2.teamId })
    assert.equal(out2.status, 'error')
    assert.equal(out2.sessionId, 'session-x', '会话已存在，必须告诉人去哪儿手动粘贴摘要')
    assert.match(String(out2.message), /手动粘贴/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ══════════════════════════════════════════════════════════════════
 * 四、面板端点与门面（gateway 契约）
 * ══════════════════════════════════════════════════════════════════ */

test('t73-9: 面板 Remote handoff 端点已登记（marker）且走 host 真实路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 't73-remote-'))
  try {
    const descriptor = (MyTeamRemote.prototype as Record<string, any>)['@deepseek-ai/dsh-typert-protocol/remote-methods']
    assert.ok(descriptor, 'marker descriptor present')
    const names = descriptor.methods.map((m: any) => m.method)
    assert.ok(names.includes('handoff'), 'handoff 必须在 marker 列表里')
    assert.ok(descriptor.methods.every((m: any) => m.invocation.kind === 'direct'))

    const { capability, prompts } = mockCapability({ sessionId: 'session-remote-1' })
    const rt = makeRuntime(root, capability)
    const host = new MyTeamHost(rt)
    host.initialize()
    const remote = new MyTeamRemote(rt, host)
    const { teamId } = await seedTeam(host)
    const out = await remote.handoff({ teamId })
    assert.equal(out.status, 'ok', JSON.stringify(out))
    assert.equal(out.sessionId, 'session-remote-1')
    assert.equal(prompts.length, 1, '端点确实注入了首条消息')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t73-10: 面板门面 handoff——无队长会话 / 远端缺方法 → MT_UNAVAILABLE（不假装成功）', async () => {
  const facade = new MyTeamPanelFacade({ agents: { list: () => [] } }, { globalIndexPath: join(tmpdir(), 'myteam-t73-none', 'workspaces.json') })
  const out = await facade.handoff({ session: { id: 's-1' } }, {})
  assert.equal((out as any).status, 'error')
  assert.equal((out as any).code, 'MT_UNAVAILABLE')
  // marker 里必须有 handoff（gateway 发现协议）
  const descriptor = (MyTeamPanelFacade.prototype as Record<string, any>)['@deepseek-ai/dsh-typert-protocol/remote-methods']
  assert.ok(descriptor.methods.map((m: any) => m.method).includes('handoff'))
  // 形参必须是 (agent, query)
  const src = (MyTeamPanelFacade.prototype as Record<string, Function>).handoff.toString()
  const m = src.match(/^async\s+\w+\s*\(([^)]*)\)/)
  assert.ok(m)
  assert.deepEqual(m![1].split(',').map((s) => s.trim()).filter(Boolean), ['agent', 'query'])
})

/* ══════════════════════════════════════════════════════════════════
 * 五、runHandoff 直接单测（失败口径）
 * ══════════════════════════════════════════════════════════════════ */

test('t73-11: runHandoff——建会话未返回 sessionId → MT_HANDOFF_NO_SESSION（不伪造 id）', async () => {
  const capability: SessionHandoffCapability = {
    async create() {
      return {} as never
    },
    async prompt() {
      throw new Error('不该被调用')
    },
  }
  const out = await runHandoff(capability, {
    summary: 's',
    prompt: 'p',
    cwd: '/ws',
    agentPreset: TEAM_AGENT_PRESET_ID,
    requestId: 'req-1',
  })
  assert.equal(out.status, 'error')
  assert.equal(out.code, 'MT_HANDOFF_NO_SESSION')
  assert.equal(out.sessionId, undefined)
})
