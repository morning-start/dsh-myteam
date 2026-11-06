/**
 * T37（CHG-58）：成员级能力硬隔离。
 *  - 纯函数：能力解析（成员 > 角色）、MCP server 解析与 deny 清单；
 *  - 执行面：MCP 用 tools.restrict({deny}) 真收窄；技能用作用域占位 provider
 *    把 allowlist 之外、当前可见的技能替换为 modelInvocable:false（deny-by-shadow）；
 *  - 失败只告警不阻断；空 allowlist = 不启用隔离；
 *  - spawn 接线：模板声明 skills/mcpAllowlist → 成员 setup 内自动应用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCapabilityGuard,
  capabilitySummary,
  mcpServerOf,
  mcpToolsToDeny,
  resolveCapabilities,
} from '../src/core/members/capability-guard.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

test('t37-1: 能力解析——成员声明优先，空数组成员回退角色，都没有则为空', () => {
  assert.deepEqual(
    resolveCapabilities({ skills: ['role-skill'], mcpAllowlist: ['role-mcp'] }, { skills: ['member-skill'], mcpAllowlist: ['member-mcp'] }),
    { skills: ['member-skill'], mcpAllowlist: ['member-mcp'] },
  )
  assert.deepEqual(
    resolveCapabilities({ skills: ['role-skill'], mcpAllowlist: ['role-mcp'] }, { skills: [], mcpAllowlist: [] }),
    { skills: ['role-skill'], mcpAllowlist: ['role-mcp'] },
  )
  assert.deepEqual(resolveCapabilities(undefined, {}), { skills: [], mcpAllowlist: [] })
})

test('t37-2: MCP server 解析与 deny 清单（只动 allowlist 之外的 mcp 工具）', () => {
  assert.equal(mcpServerOf('mcp__github__search_issues'), 'github')
  assert.equal(mcpServerOf('mcp__my_server__run'), 'my_server')
  assert.equal(mcpServerOf('mcp__solo'), 'solo')
  assert.equal(mcpServerOf('read_file'), undefined)
  const names = [
    'read_file',
    'mcp__github__search_issues',
    'mcp__filesystem__read_file',
    'mcp__github__create_issue',
  ]
  assert.deepEqual(mcpToolsToDeny(names, ['filesystem']), ['mcp__github__search_issues', 'mcp__github__create_issue'])
  assert.deepEqual(mcpToolsToDeny(names, []), [], '空 allowlist = 不启用隔离')
  assert.deepEqual(mcpToolsToDeny(names, ['github', 'filesystem']), [])
})

test('t37-3: 执行面——MCP restrict deny + 技能占位 provider（模型不可见）', async () => {
  const restrictCalls: any[] = []
  const providers: any[] = []
  const ctx = {
    tools: {
      schemas: () => [
        { name: 'read_file' },
        { name: 'mcp__github__search_issues' },
        { name: 'mcp__filesystem__read_file' },
      ],
      restrict: (filter: any) => restrictCalls.push(filter),
    },
    skills: {
      list: async () => [{ name: 'ui-design' }, { name: 'create-role' }, { name: 'data-analysis' }],
      registerProvider: (create: any) => providers.push(create()),
    },
  }
  const result = await applyCapabilityGuard(ctx, { id: 'agent-1' }, { skills: ['ui-design'], mcpAllowlist: ['filesystem'] }, { workspaceRoot: '/ws' })
  assert.deepEqual(result.mcpDenied, ['mcp__github__search_issues'])
  assert.deepEqual(restrictCalls, [{ deny: ['mcp__github__search_issues'] }])
  assert.deepEqual(result.skillsShadowed.sort(), ['create-role', 'data-analysis'])
  assert.equal(result.warnings.length, 0)

  assert.equal(providers.length, 1)
  const provider = providers[0]
  assert.equal(provider.name, 'myteam-capability-guard')
  const candidates = provider.list()
  assert.deepEqual(candidates.map((c: any) => c.name).sort(), ['create-role', 'data-analysis'])
  for (const candidate of candidates) {
    assert.equal(candidate.invocation.modelInvocable, false, '占位技能不应对模型可见')
    assert.equal(candidate.provider, 'myteam-capability-guard')
  }
  const loaded = provider.get({ name: 'create-role' })
  assert.equal(loaded, undefined, '占位技能的正文不可读（get 返回 undefined）')
})

test('t37-3b: 执行期 guard 兜底（晚到的 MCP 工具）+ skills/change 动态刷新占位', async () => {
  let guardFn: any
  let provider: any
  let changeHandler: any
  let invalidated = 0
  let visible = [{ name: 'ui-design', provider: 'fs' }, { name: 'old-skill', provider: 'fs' }]
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mcp__known__x' }],
      restrict: () => {},
      guard: (fn: any) => {
        guardFn = fn
      },
    },
    skills: {
      list: async () => visible,
      registerProvider: (create: any) => {
        provider = create({ invalidate: () => { invalidated += 1 } })
      },
    },
    on: (event: string, fn: any) => {
      if (event === 'skills/change') changeHandler = fn
    },
  }
  const result = await applyCapabilityGuard(ctx, { id: 'a' }, { skills: ['ui-design'], mcpAllowlist: ['known'] }, { workspaceRoot: '/ws' })
  assert.deepEqual(result.mcpDenied, [], '已知 server 内不产生 deny')
  assert.equal(typeof guardFn, 'function')
  assert.equal(guardFn({ name: 'mcp__known__x' }), undefined)
  assert.match(guardFn({ name: 'mcp__late__y' }), /outside this member's mcpAllowlist/)
  assert.equal(guardFn({ name: 'read_file' }), undefined)
  assert.deepEqual(provider.list().map((c: any) => c.name), ['old-skill'])
  assert.equal(provider.get({ name: 'old-skill' }), undefined)

  visible = [...visible, { name: 'new-skill', provider: 'fs' }]
  assert.equal(typeof changeHandler, 'function')
  await changeHandler()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(provider.list().map((c: any) => c.name).sort(), ['new-skill', 'old-skill'])
  assert.ok(invalidated > 0, '占位集合变化后失效技能缓存')
})

test('t37-4: 失败只告警不阻断；空 allowlist 不产生任何副作用', async () => {
  const warnings: string[] = []
  const ctx = {
    tools: {
      schemas: () => {
        throw new Error('boom')
      },
      restrict: () => {
        throw new Error('should not be called')
      },
    },
    skills: {
      list: async () => {
        throw new Error('skill list down')
      },
      registerProvider: () => {
        throw new Error('should not be called')
      },
    },
  }
  const failed = await applyCapabilityGuard(ctx, { id: 'a' }, { skills: ['x'], mcpAllowlist: ['y'] }, { workspaceRoot: '/ws' })
  assert.equal(failed.mcpDenied.length, 0)
  assert.equal(failed.skillsShadowed.length, 0)
  assert.equal(failed.warnings.length, 2)
  assert.match(capabilitySummary(failed), /warn/)

  let touched = 0
  const idle = {
    tools: {
      schemas: () => {
        touched += 1
        return []
      },
      restrict: () => {
        touched += 1
      },
    },
    skills: {
      list: async () => {
        touched += 1
        return []
      },
      registerProvider: () => {
        touched += 1
      },
    },
  }
  const none = await applyCapabilityGuard(idle, { id: 'b' }, { skills: [], mcpAllowlist: [] }, { workspaceRoot: '/ws' })
  assert.deepEqual(none, { skillsShadowed: [], mcpDenied: [], warnings: [] })
  assert.equal(touched, 0)
  warnings.push('ok')
  assert.equal(warnings.length, 1)
})

test('t37-6: 角色 toolPolicy.allow 只按全局已知名收窄（own-layer 成员工具不进 allow）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t37f-'))
  try {
    const restrictCalls: any[] = []
    const rt = {
      set: () => {},
      tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
      agents: {
        create: async (opts: any) => {
          const agentCtx = {
            tools: {
              register: () => {},
              restrict: (filter: any) => restrictCalls.push(filter),
              schemas: () => [{ name: 'bash' }, { name: 'read_file' }, { name: 'mcp__x__y' }],
            },
            systemPrompt: { section: () => {} },
          }
          await opts.setup(agentCtx, { id: opts.sessionId })
          return { followup: () => {}, session: {} }
        },
      },
      logger: { info: () => {}, warn: () => {} },
      workspace: { root },
    } as unknown as HostRuntime
    const host = new MyTeamHost(rt)
    host.initialize()

    const created: any = host.executeLeadTool('myteam_create_role', {
      roleId: 'limited', name: '受限角色', description: '只允许 bash', systemPrompt: '你是受限角色。',
      toolPolicy: { allow: ['bash', 'myteam_claim_task'] },
    }, {})
    assert.equal(created.status, 'created', JSON.stringify(created))
    const dir = join(root, '.team-workplace', 'config', 'presets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'team-limited.json'), JSON.stringify({
      id: 'team-limited', name: '受限模板', members: [{ roleId: 'limited' }],
    }))

    const staged: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-limited', teamName: '受限队', goal: 'G', tasks: [] }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    await new Promise((resolve) => setTimeout(resolve, 20))
    host.executeLeadTool('myteam_approve_plan', { teamId: staged.teamId }, {})
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.deepEqual(restrictCalls, [{ allow: ['bash'] }], 'own-layer 的 myteam_claim_task 被剔除，不触发 unknown tool')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t37-5: spawn 接线——模板成员声明技能/MCP 时，setup 内自动收窄', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t37-'))
  try {
    const dir = join(root, '.team-workplace', 'config', 'presets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'team-cap.json'), JSON.stringify({
      id: 'team-cap',
      name: '能力模板',
      members: [{ roleId: 'developer', skills: ['ui-design'], mcpAllowlist: ['filesystem'] }],
    }))

    const calls: { restrict: any[]; providers: any[] } = { restrict: [], providers: [] }
    const rt = {
      set: () => {},
      tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
      agents: {
        create: async (opts: any) => {
          const agentCtx = {
            tools: {
              register: () => {},
              restrict: (filter: any) => calls.restrict.push(filter),
              schemas: () => [{ name: 'mcp__github__search_issues' }, { name: 'mcp__filesystem__read_file' }],
            },
            systemPrompt: { section: () => {} },
            skills: {
              list: async () => [{ name: 'ui-design' }, { name: 'create-role' }],
              registerProvider: (create: any) => calls.providers.push(create()),
            },
          }
          await opts.setup(agentCtx, { id: opts.sessionId })
          return { followup: () => {}, session: {} }
        },
      },
      logger: { info: () => {}, warn: () => {} },
      workspace: { root },
    } as unknown as HostRuntime
    const host = new MyTeamHost(rt)
    host.initialize()

    const staged: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-cap', teamName: '能力队', goal: 'G', tasks: [] }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const approved: any = host.executeLeadTool('myteam_approve_plan', { teamId: staged.teamId }, {})
    assert.equal(approved.status, 'approved', JSON.stringify(approved))
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.deepEqual(calls.restrict, [{ deny: ['mcp__github__search_issues'] }])
    assert.equal(calls.providers.length, 1)
    assert.deepEqual(calls.providers[0].list().map((c: any) => c.name), ['create-role'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
