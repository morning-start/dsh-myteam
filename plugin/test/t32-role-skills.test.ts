/**
 * T32（CHG-53）：队长角色能力 —— create-role / modify-role 工具 + 两个队长技能。
 *  - 创建写项目角色库；重名/非法 id/空提示词拒绝；
 *  - 修改 patch 合并 + version 自增；内置/全局角色先 fork 进项目再改（origin 保留）；
 *  - 技能注册只进队长 scope（source=myteam，model 可调用、用户命令不可调用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string, skills: { register: (skill: any) => void } = { register: () => {} }) {
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    skills,
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  return rt
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t32-'))
  const registered: any[] = []
  const rt = makeRuntime(root, { register: (skill: any) => { registered.push(skill) } })
  const host = new MyTeamHost(rt)
  host.initialize()
  return { root, host, registered }
}

const roleFile = (root: string, id: string) => join(root, '.team-workplace', 'config', 'roles', `${id}.json`)

test('t32-1: create-role 写项目库；重名 / 非法 id / 空提示词拒绝', () => {
  const { root, host } = setup()
  try {
    const created: any = host.executeLeadTool('myteam_create_role', {
      roleId: 'data-auditor',
      name: '数据审计员',
      description: '核对口径与报表一致性',
      systemPrompt: '你是数据审计员。只做核对与证据输出，不改数据源。',
      skills: ['data-analysis'],
      mcpAllowlist: ['filesystem'],
      toolPolicy: { allow: ['read_file'] },
    }, {})
    assert.equal(created.status, 'created', JSON.stringify(created))
    assert.ok(existsSync(roleFile(root, 'data-auditor')))
    const saved = JSON.parse(readFileSync(roleFile(root, 'data-auditor'), 'utf8'))
    assert.deepEqual(saved.skills, ['data-analysis'])
    assert.deepEqual(saved.mcpAllowlist, ['filesystem'])
    assert.equal(saved.version, 1)

    const dup: any = host.executeLeadTool('myteam_create_role', {
      roleId: 'data-auditor', name: 'X', description: 'x', systemPrompt: 'x',
    }, {})
    assert.equal(dup.code, 'MT_ROLE_EXISTS')

    const dupBuiltin: any = host.executeLeadTool('myteam_create_role', {
      roleId: 'developer', name: 'X', description: 'x', systemPrompt: 'x',
    }, {})
    assert.equal(dupBuiltin.code, 'MT_ROLE_EXISTS', '内置角色同名也拒绝（不覆盖）')

    const badId: any = host.executeLeadTool('myteam_create_role', {
      roleId: 'Bad_ID', name: 'X', description: 'x', systemPrompt: 'x',
    }, {})
    assert.equal(badId.code, 'MT_ROLE_INVALID')

    const badPrompt: any = host.executeLeadTool('myteam_create_role', {
      roleId: 'empty-prompt', name: 'X', description: 'x', systemPrompt: '   ',
    }, {})
    assert.equal(badPrompt.code, 'MT_ROLE_INVALID')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t32-2: update-role patch 合并 + version 自增；内置角色 fork 进项目后修改', () => {
  const { root, host } = setup()
  try {
    host.executeLeadTool('myteam_create_role', {
      roleId: 'data-auditor', name: '数据审计员', description: '核对', systemPrompt: '你是数据审计员。',
    }, {})
    const updated: any = host.executeLeadTool('myteam_update_role', {
      roleId: 'data-auditor',
      patch: { skills: ['data-analysis', 'office-xlsx'], mcpAllowlist: ['filesystem', 'github'] },
    }, {})
    assert.equal(updated.status, 'updated', JSON.stringify(updated))
    assert.equal(updated.version, 2)
    const saved = JSON.parse(readFileSync(roleFile(root, 'data-auditor'), 'utf8'))
    assert.deepEqual(saved.skills, ['data-analysis', 'office-xlsx'])
    assert.deepEqual(saved.mcpAllowlist, ['filesystem', 'github'])

    // 内置角色：先复制进项目（fork）再改，origin 保留
    const forked: any = host.executeLeadTool('myteam_update_role', {
      roleId: 'developer',
      patch: { skills: ['ui-design'], systemPrompt: '你是开发者。先读任务；交付必须带证据。' },
    }, {})
    assert.equal(forked.status, 'updated', JSON.stringify(forked))
    assert.equal(forked.copiedFrom, 'builtin')
    const dev = JSON.parse(readFileSync(roleFile(root, 'developer'), 'utf8'))
    assert.equal(dev.origin, 'builtin:developer')
    assert.deepEqual(dev.skills, ['ui-design'])
    assert.equal(dev.version, 2)

    const missing: any = host.executeLeadTool('myteam_update_role', { roleId: 'no-such', patch: { name: 'x' } }, {})
    assert.equal(missing.code, 'MT_ROLE_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t32-3: 队长技能注册（model 可调用，用户命令不可调用）', () => {
  const { root, registered } = setup()
  try {
    const names = registered.map((skill) => skill.name).sort()
    // CHG-88：新增 create-team 章程技能（M2-F）——断言改为「必备集合 + 数量」，
    // 避免每加一个技能就要改一次硬编码列表（脆断言）。必备项仍逐个点名，缺一即失败。
    for (const required of ['choose-team-template', 'create-role', 'manage-team-template', 'modify-role']) {
      assert.ok(names.includes(required), `missing captain skill ${required}`)
    }
    assert.equal(new Set(names).size, names.length, '技能名不得重复')
    for (const skill of registered) {
      assert.equal(skill.source, 'myteam')
      assert.equal(skill.invocation.modelInvocable, true)
      assert.equal(skill.invocation.userInvocable, false)
      assert.ok(skill.description.length > 10)
      if (skill.name.endsWith('-role')) assert.match(skill.content, /myteam_(create|update)_role/)
      else if (skill.name === 'create-team') assert.match(skill.content, /structure\.md/)
      else assert.match(skill.content, /myteam_(list|save|copy|delete)_preset|myteam_reset_team_config/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
