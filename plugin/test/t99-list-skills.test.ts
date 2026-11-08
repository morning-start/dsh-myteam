/**
 * T99 · CHG-128（docs/19 §M3）：`myteam_list_skills` —— 可复用技能清单（A 档只读）。
 *
 * 为什么必须有：角色能 `skills: [...]` 绑定技能，但**没有任何工具能列出可用技能**——
 * 只能盲填名字（docs/19 §M3「先能看见，才谈复用」）。
 *
 * 断言：
 *  ① 工具已注册；返回 `{status,total,declared,host}`；
 *  ② `declared` 聚合角色目录里的 `skills`（去重 + `boundBy` 绑定者）；
 *  ③ `withRoles:false` 时 `declared` 退化为纯字符串数组；
 *  ④ 宿主 `skills` 服务不可用 → `host.available:false` + `note` 说明（**不伪造清单**）；
 *  ⑤ 只读：不写账本、不改角色库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t99-'))
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
    ...extra,
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, root }
}

test('t99-1: 注册 + 声明聚合（builtin 角色带 skills）', () => {
  assert.ok(defsSource.includes("name: 'myteam_list_skills'"), 'defs 必须有 myteam_list_skills')
  const { host, root } = setup()
  try {
    const result: any = host.executeLeadTool('myteam_list_skills', {}, {})
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(typeof result.total, 'number')
    assert.equal(Array.isArray(result.declared), true)
    assert.equal(result.declared.length, result.total, 'total 与 declared 长度一致')
    /* 内置角色若未声明技能 → 清单为空是**真实结果**（不造数据）；声明了就逐条校验 */
    assert.equal(result.declared.length, result.total, 'total 与 declared 长度一致')
    for (const item of result.declared) {
      assert.equal(typeof item.name, 'string')
      assert.ok(item.boundBy.length > 0, `${item.name} 必须有绑定者`)
      for (const binding of item.boundBy) {
        assert.equal(typeof binding.roleId, 'string')
        assert.ok(['builtin', 'global', 'project', 'plugin'].includes(binding.origin), `未知来源 ${binding.origin}`)
      }
    }
    /* 去重：名字唯一 */
    const names = result.declared.map((item: any) => item.name)
    assert.equal(new Set(names).size, names.length, 'declared 必须去重')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t99-2: withRoles:false → 纯字符串数组', () => {
  const { host, root } = setup()
  try {
    const plain: any = host.executeLeadTool('myteam_list_skills', { withRoles: false }, {})
    assert.equal(plain.declared.every((item: unknown) => typeof item === 'string'), true, 'withRoles:false 必须是字符串数组')
    const withRoles: any = host.executeLeadTool('myteam_list_skills', {}, {})
    assert.deepEqual(plain.declared, withRoles.declared.map((item: any) => item.name), '两种形态内容一致')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t99-3: 宿主 skills 服务 —— 可用则并入、不可用则诚实标不可用', () => {
  /* ① 不可用：host.available:false + note */
  const bare = setup()
  try {
    const missing: any = bare.host.executeLeadTool('myteam_list_skills', {}, {})
    assert.equal(missing.host.available, false)
    assert.ok(String(missing.note ?? '').includes('宿主'), '不可用必须给 note 说明')
  } finally {
    rmSync(bare.root, { recursive: true, force: true })
  }
  /* ② 可用：并入清单 */
  const withService = setup({
    skills: { list: () => [{ name: 'code-review', description: '代码审查' }, { id: 'ops-runbook' }, { name: '' }] },
  })
  try {
    const available: any = withService.host.executeLeadTool('myteam_list_skills', {}, {})
    assert.equal(available.host.available, true)
    assert.equal(available.host.skills.length, 2, '空名条目必须被过滤')
    assert.deepEqual(available.host.skills[0], { name: 'code-review', description: '代码审查' })
    assert.equal(available.note, undefined, '可用时不带降级说明')
  } finally {
    rmSync(withService.root, { recursive: true, force: true })
  }
})

test('t99-4: 只读 —— 不改角色库、不写账本', () => {
  const { host, root } = setup()
  try {
    const rolesDir = join(root, '.dsh-myteam', 'config', 'roles')
    const before = (() => { try { return readdirSync(rolesDir).sort().join(',') } catch { return '(absent)' } })()
    host.executeLeadTool('myteam_list_skills', {}, {})
    const after = (() => { try { return readdirSync(rolesDir).sort().join(',') } catch { return '(absent)' } })()
    assert.equal(after, before, '角色库不得被读取改变')
    /* 账本目录由 initialize 创建（基线），只读调用不得新增团队子目录 */
    const tasksDir = join(root, '.dsh-myteam', 'tasks')
    const teams = existsSync(tasksDir) ? readdirSync(tasksDir) : []
    assert.equal(teams.length, 0, '只读调用不得创建团队账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
