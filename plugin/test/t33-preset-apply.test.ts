/**
 * T33（CHG-54）：项目团队模板应用 —— submit_plan presetId → 名册/技能/MCP → spawn。
 *  - 模板 members 变成名册（队长隐式）；全局/内置角色提交时复制进项目库；
 *  - approve 后成员 identity.json 保留 skills/mcpAllowlist，并注入能力边界 section；
 *  - 未知模板/未知角色拒绝；手动 spawn 也支持按成员覆写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string) {
  const sections: any[] = []
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: any) => {
        const agentCtx = {
          tools: { register: () => {}, restrict: () => {} },
          systemPrompt: { section: (section: any) => { sections.push({ ...section, sessionId: opts.sessionId }) } },
          skills: { registerProvider: () => {} },
        }
        opts.setup(agentCtx, {})
        return { followup: () => {}, session: {} }
      },
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  return { rt, sections }
}

const presetFile = (root: string, id: string, value: unknown) => {
  const dir = join(root, '.team-workplace', 'config', 'presets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(value))
}

const roleFile = (root: string, id: string) => join(root, '.team-workplace', 'config', 'roles', `${id}.json`)

function memberIdentities(root: string, teamId: string): any[] {
  const dir = join(root, '.team-workplace', 'state', 'teams', teamId, 'members')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name, 'identity.json'), 'utf8')))
}

test('t33-1: presetId 组队——模板 members → 名册、角色复制进项目、成员技能/MCP 落快照与提示词', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t33-'))
  try {
    presetFile(root, 'team-a', {
      id: 'team-a',
      name: '模板A',
      members: [
        { roleId: 'developer', skills: ['ui-design'], mcpAllowlist: ['filesystem'] },
        { roleId: 'acceptor', mcpAllowlist: ['github'] },
      ],
    })
    const { rt, sections } = makeRuntime(root)
    const host = new MyTeamHost(rt)
    host.initialize()

    const staged: any = host.executeLeadTool('myteam_submit_plan', {
      presetId: 'team-a', teamName: 'A', goal: 'G', tasks: [],
    }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    assert.equal(staged.presetId, 'team-a')
    assert.deepEqual(staged.roster.map((entry: any) => entry.roleId), ['captain', 'developer', 'acceptor'])
    assert.deepEqual(staged.roster[1].skills, ['ui-design'])
    assert.deepEqual(staged.roster[2].mcpAllowlist, ['github'])

    const approved: any = host.executeLeadTool('myteam_approve_plan', { teamId: staged.teamId }, {})
    assert.equal(approved.status, 'approved', JSON.stringify(approved))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(existsSync(roleFile(root, 'developer')), '角色已复制进项目库')
    assert.ok(existsSync(roleFile(root, 'acceptor')))

    const identities = memberIdentities(root, staged.teamId)
    assert.equal(identities.length, 2)
    const dev = identities.find((item) => item.roleId === 'developer')!
    const acc = identities.find((item) => item.roleId === 'acceptor')!
    assert.deepEqual(dev.skills, ['ui-design'])
    assert.deepEqual(dev.mcpAllowlist, ['filesystem'])
    assert.equal(acc.skills, undefined, '未覆写则继承角色')
    assert.deepEqual(acc.mcpAllowlist, ['github'])

    const capSections = sections.filter((section) => String(section.name).startsWith('myteam:capabilities-'))
    assert.equal(capSections.length, 2)
    const devSection = capSections.find((section) => String(section.text).includes('ui-design'))!
    assert.match(String(devSection.text), /filesystem/)
    assert.match(String(devSection.text), /allowlist 之外的技能与 MCP 在运行时不可用/)

    const proj = host.service(staged.teamId).projectionSnapshot
    const projDev = proj.members[dev.memberId]
    assert.deepEqual(projDev.skills, ['ui-design'], '投影带成员技能（面板可见）')
    assert.deepEqual(projDev.mcpAllowlist, ['filesystem'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t33-2: 未知模板 / 未知角色拒绝；全局角色按模板复制进项目', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t33b-'))
  const globalDir = mkdtempSync(join(tmpdir(), 'myteam-t33g-'))
  try {
    const { rt } = makeRuntime(root)
    const host = new MyTeamHost(rt, { globalRolesDir: globalDir })
    host.initialize()

    const unknown: any = host.executeLeadTool('myteam_submit_plan', {
      presetId: 'no-such', teamName: 'X', goal: 'G', tasks: [],
    }, {})
    assert.equal(unknown.code, 'MT_VALIDATION')

    // 全局角色（只读层）→ 模板引用 → 提交时复制进项目
    writeFileSync(join(globalDir, 'data-auditor.json'), JSON.stringify({
      id: 'data-auditor', name: '数据审计员', description: '核对', systemPrompt: '你是数据审计员。', version: 1,
    }))
    presetFile(root, 'team-g', {
      id: 'team-g', name: '全局角色模板',
      members: [{ roleId: 'data-auditor' }],
    })
    const staged: any = host.executeLeadTool('myteam_submit_plan', {
      presetId: 'team-g', teamName: 'G', goal: 'G', tasks: [],
    }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    assert.ok(existsSync(roleFile(root, 'data-auditor')), '全局角色已复制进项目库')
    const copied = JSON.parse(readFileSync(roleFile(root, 'data-auditor'), 'utf8'))
    assert.equal(copied.id, 'data-auditor')

    presetFile(root, 'team-bad', { id: 'team-bad', name: '坏模板', members: [{ roleId: 'no-such-role' }] })
    const bad: any = host.executeLeadTool('myteam_submit_plan', {
      presetId: 'team-bad', teamName: 'B', goal: 'G', tasks: [],
    }, {})
    assert.equal(bad.code, 'MT_VALIDATION')
    assert.match(String(bad.message), /unknown role/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
  }
})

test('t33-3: 手动 spawn 支持按成员覆写技能/MCP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t33c-'))
  try {
    const { rt } = makeRuntime(root)
    const host = new MyTeamHost(rt)
    host.initialize()
    const staged: any = host.executeLeadTool('myteam_submit_plan', {
      teamName: 'C', goal: 'G', tasks: [],
    }, {})
    host.executeLeadTool('myteam_approve_plan', { teamId: staged.teamId }, {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    const spawned: any = host.executeLeadTool('myteam_spawn_member', {
      teamId: staged.teamId, roleId: 'developer', instanceName: 'dev-extra',
      skills: ['office-xlsx'], mcpAllowlist: ['filesystem'],
    }, {})
    assert.equal(spawned.status, 'spawned', JSON.stringify(spawned))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const identity = memberIdentities(root, staged.teamId).find((item) => item.instanceName === 'dev-extra')!
    assert.deepEqual(identity.skills, ['office-xlsx'])
    assert.deepEqual(identity.mcpAllowlist, ['filesystem'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
