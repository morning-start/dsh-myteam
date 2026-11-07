/**
 * T22 预置团队自测（v2.13 / CHG-36）：内置三人组角色 + 预置名册模板 + submit_plan 缺省名册。
 * 对位用户全局 PM·TL·QA 预设 → myteam 内置「需求验证员/开发者/验收员」+ triad 模板。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_ROLES, BUILTIN_TEAM_TEMPLATES, presetTeamRoster, builtinRole } from '../src/core/roles/builtin-roles.ts'
import { listRoleCatalog, readProjectRole, validateRoster } from '../src/core/roles/role-store.ts'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const NODE = process.execPath

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

test('T22-1: 内置角色含三人组三角色；非队长；模板名册合法（恰一队长）', () => {
  const ids = BUILTIN_ROLES.map((r) => r.id)
  for (const id of ['req-validator', 'developer', 'acceptor']) {
    assert.ok(ids.includes(id), `builtin role "${id}" present`)
    const def = builtinRole(id)!
    assert.ok(def.systemPrompt.trim().length > 40, `${id} 有实质 persona`)
    assert.notEqual(def.isCaptain, true, `${id} 非队长`)
    assert.equal(def.version, 1)
  }
  // 模板名册：恰一队长（FR-10.1），成员 roleId 均有内置定义
  const triad = BUILTIN_TEAM_TEMPLATES.find((t) => t.id === 'triad')!
  assert.deepEqual(triad.roster.map((r) => r.roleId), ['captain', 'req-validator', 'developer', 'acceptor'])
  const paths = { projectRolesDir: join(tmpdir(), `t22-none-${Date.now()}`) }
  assert.doesNotThrow(() => validateRoster(presetTeamRoster('triad'), paths), '模板名册通过 FR-10.1 校验（captain 回内置定义）')
})

test('T22-2: 角色目录可见（builtin origin）+ presetTeamRoster 深拷贝幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 't22cat-'))
  try {
    const paths = { projectRolesDir: join(root, 'roles') }
    const catalog = listRoleCatalog(paths)
    for (const id of ['req-validator', 'developer', 'acceptor']) {
      const e = catalog.find((x) => x.definition.id === id)
      assert.ok(e && e.origin === 'builtin', `${id} 以 builtin 出现在目录`)
    }
    const a = presetTeamRoster('triad')
    const b = presetTeamRoster('triad')
    assert.deepEqual(a, b)
    assert.notEqual(a, b, '每次返回新数组（防共享引用被调用方改写）')
    assert.deepEqual(presetTeamRoster('no-such-template'), [{ roleId: 'captain' }], '未知模板回退仅队长')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T22-3: submit_plan 不带名册 → 按预置团队成团（team.created.roster = 队长+三人组）', () => {
  const root = mkdtempSync(join(tmpdir(), 't22plan-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: '预置团队测试', goal: 'G', tasks: [] }, {}) as any
    assert.equal(sub.status, 'staged')
    assert.match(String(sub.note), /预置团队/)
    // 名册落账：读团队账本 team.created 事件
    const ledger = readFileSync(join(root, '.dsh-myteam', 'tasks', String(sub.teamId), 'ledger.jsonl'), 'utf8')
    const created = ledger.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'team.created')
    assert.deepEqual(created.payload.roster.map((r: any) => r.roleId), ['captain', 'req-validator', 'developer', 'acceptor'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T22-4: 显式名册行为不变；三人组成员可 spawn（内置角色自动复制进项目库）', () => {
  const root = mkdtempSync(join(tmpdir(), 't22spawn-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    // 显式名册：不受预置模板影响
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    assert.equal(sub.status, 'staged')
    assert.doesNotMatch(String(sub.note), /预置团队/)
    // 三人组成员 spawn（引用即复制：req-validator 内置 → 项目库）
    const sp = host.spawnMember(String(sub.teamId), 'developer') as any
    assert.equal(sp.status, 'spawned')
    const copied = readProjectRole(join(root, '.dsh-myteam', 'config', 'roles'), 'developer')
    assert.ok(copied, 'developer 内置角色已复制进项目库')
    assert.equal(copied!.origin, 'builtin:developer')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T22-5: 预置名册成团后可 approve 并逐个 spawn 三成员（端到端）', () => {
  const root = mkdtempSync(join(tmpdir(), 't22e2e-'))
  try {
    const host = new MyTeamHost(makeRuntime(root))
    host.initialize()
    const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', tasks: [] }, {}) as any
    const ap = host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
    assert.equal(ap.status, 'approved')
    for (const roleId of ['req-validator', 'developer', 'acceptor']) {
      const sp = host.spawnMember(String(sub.teamId), roleId) as any
      assert.equal(sp.status, 'spawned', `${roleId} spawn 成功`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// NODE 引用避免未使用告警（宿主 agents.create 走桩，不真实起会话）
void NODE
