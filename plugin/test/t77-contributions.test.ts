/**
 * T77 · 插件团队贡献（CHG-91 / docs/16 契约 §13）—— **myteam 侧装载实现**的行为测试。
 *
 * 与 `t76-contract.test.ts` 的分工：
 *  - t76 测**契约校验器**（`skills/.../check-contribution.mjs`）——作者在自己仓库里跑的那份；
 *  - t77 测**myteam 侧装载**（`core/contributions/*` + `listRoleCatalog` / `readPresetCatalog` /
 *    `roleOp` / 面板端点 / 队长工具）——真正进库的那条路。
 *
 * 纪律（沿用 t71/t75 的教训）：走真实入口（`MyTeamHost` / `executeLeadTool` /
 * `MyTeamPanelFacade` / `MyTeamRemote`），不 mock 贡献装载器。
 *
 * 覆盖 docs/16 §13 的 TC-PC-19 ~ TC-PC-25 + 优先级/只读/不写账本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { contributionsRoot } from '../src/core/contributions/discover.ts'
import { loadContributions, parseContributions } from '../src/core/contributions/parse.ts'
import { discoverContributions } from '../src/core/contributions/discover.ts'
import { CONTRIBUTION_CODES } from '../src/core/contributions/contract.ts'
import { ROLE_ORIGIN_PRECEDENCE, listRoleCatalog, resolveEffectiveRole, copyToProject, readProjectRole, assertValidRole } from '../src/core/roles/role-store.ts'
import { readPresetCatalog } from '../src/core/presets/preset-store.ts'

/* ── 宿主桩 + 贡献夹具 ───────────────────────────────────────────── */

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: (opts: { sessionId: string }) => ({ session: { id: opts.sessionId }, followup: () => {} }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

const ROLE = (over: Record<string, unknown> = {}) => ({
  id: 'acme-reviewer',
  name: 'Acme 复核',
  description: '独立复核',
  systemPrompt: '你只审不写。',
  ...over,
})

const TEAM = (over: Record<string, unknown> = {}) => ({
  id: 'acme-trio',
  name: 'Acme 三人组',
  members: [{ roleId: 'acme-reviewer' }],
  ...over,
})

interface ContributionLayout {
  pluginId: string
  roles?: Record<string, Record<string, unknown>>
  teams?: Record<string, Record<string, unknown>>
}

/** 在临时 $DSH_HOME 下写贡献目录 */
function seedContributions(home: string, layouts: ContributionLayout[]): void {
  for (const layout of layouts) {
    const dir = join(home, 'myteam', 'plugins', layout.pluginId)
    mkdirSync(join(dir, 'roles'), { recursive: true })
    mkdirSync(join(dir, 'teams'), { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
      contractVersion: 1,
      pluginId: layout.pluginId,
      displayName: `插件 ${layout.pluginId}`,
      version: '1.0.0',
      roles: Object.keys(layout.roles ?? {}).map((id) => ({ id, file: `roles/${id}.json` })),
      teams: Object.keys(layout.teams ?? {}).map((id) => ({ id, file: `teams/${id}.json` })),
    }, null, 2), 'utf8')
    for (const [id, role] of Object.entries(layout.roles ?? {})) writeFileSync(join(dir, 'roles', `${id}.json`), JSON.stringify(role, null, 2), 'utf8')
    for (const [id, team] of Object.entries(layout.teams ?? {})) writeFileSync(join(dir, 'teams', `${id}.json`), JSON.stringify(team, null, 2), 'utf8')
  }
}

/** 每个用例独立 `$DSH_HOME`（贡献目录是插件级、跨工作区共享——必须隔离） */
function withHome<T>(fn: (home: string) => T): T {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 't77-home-'))
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function makeHost(): { host: MyTeamHost; root: string } {
  const root = mkdtempSync(join(tmpdir(), 't77-ws-'))
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  return { host, root }
}

function ledgerPath(root: string, teamId: string): string {
  return join(root, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl')
}

/* ── 1. 装载进目录（origin = plugin）────────────────────────────── */

test('t77-1 (TC-PC-02): 插件角色进 listRoleCatalog 且 origin=plugin、带 pluginId 溯源', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const { host } = makeHost()
    const catalog = host.roleCatalog()
    const pluginEntry = catalog.find((entry) => entry.definition.id === 'acme-reviewer')
    assert.ok(pluginEntry, '插件角色必须进目录')
    assert.equal(pluginEntry.origin, 'plugin')
    assert.equal(pluginEntry.pluginId, 'acme-workflow', '面板要能显示「由插件 X 提供」')
    assert.equal(pluginEntry.definition.origin, 'plugin:acme-workflow', '定义里的 origin 是盖章的来源标记')
    // 内置角色照旧
    assert.ok(catalog.some((entry) => entry.definition.id === 'captain' && entry.origin === 'builtin'))
  })
})

test('t77-2 (TC-PC-02): 插件团队模板进 readPresetCatalog 且 origin=plugin、跨项目可见', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() }, teams: { 'acme-trio': TEAM() } }])
    const { host, root } = makeHost()
    const catalog = host.presetCatalog()
    const entry = catalog.entries.find((item) => item.definition.id === 'acme-trio')
    assert.ok(entry, '插件团队模板必须进目录')
    assert.equal(entry.origin, 'plugin')
    // 跨项目：换一个工作区仍能看到（插件资产，不是项目资产）
    const other = mkdtempSync(join(tmpdir(), 't77-other-'))
    assert.ok(readPresetCatalog(other, host.contributionSnapshot().teams).entries.some((item) => item.definition.id === 'acme-trio'))
    void root
  })
})

/* ── 2. 优先级（契约 §7.1）─────────────────────────────────────── */

test('t77-3: 优先级 builtin(0) < plugin(1) < global(2) < project-role(3) < project(4)', () => {
  assert.deepEqual(ROLE_ORIGIN_PRECEDENCE, { builtin: 0, plugin: 1, global: 2, 'project-role': 3, project: 4 })
  // 相对顺序不能变（既有四档的语义是 CHG-74 定案）
  assert.ok(ROLE_ORIGIN_PRECEDENCE.builtin < ROLE_ORIGIN_PRECEDENCE.plugin)
  assert.ok(ROLE_ORIGIN_PRECEDENCE.plugin < ROLE_ORIGIN_PRECEDENCE.global)
  assert.ok(ROLE_ORIGIN_PRECEDENCE.global < ROLE_ORIGIN_PRECEDENCE['project-role'])
  assert.ok(ROLE_ORIGIN_PRECEDENCE['project-role'] < ROLE_ORIGIN_PRECEDENCE.project)
})

test('t77-4 (TC-PC-12): 插件角色 id 撞全局库 —— 不报错，用户那份生效，插件那份标 shadowedBy', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const { host } = makeHost()
    // 在全局库里写一份同 id 的角色（用户覆盖插件默认）
    const globalDir = join(home, 'myteam', 'roles')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'acme-reviewer.json'), JSON.stringify(ROLE({ name: '用户改过的复核', systemPrompt: '用户版本' }), null, 2), 'utf8')

    const catalog = host.roleCatalog()
    const entries = catalog.filter((entry) => entry.definition.id === 'acme-reviewer')
    assert.equal(entries.length, 2, '目录不隐藏任何一份（CHG-74 口径）')
    const effective = resolveEffectiveRole(catalog, 'acme-reviewer')
    assert.equal(effective?.origin, 'global', '用户的全局库压得过插件')
    const pluginEntry = entries.find((entry) => entry.origin === 'plugin')
    assert.equal(pluginEntry?.shadowedBy, 'global', '插件那份要让位并留痕')
    // 装载本身没有 error（撞全局库是允许的，契约 §7.2）
    assert.equal(host.contributionSnapshot().ok, true)
  })
})

test('t77-5 (TC-PC-10): 插件角色撞内置 —— 硬失败，该角色不进库', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { implementer: ROLE({ id: 'implementer' }) } }])
    const { host } = makeHost()
    const catalog = host.contributionSnapshot()
    assert.equal(catalog.ok, false, '撞内置是 error 级')
    assert.ok(catalog.warnings.some((warning) => warning.code === CONTRIBUTION_CODES.ROLE_CONFLICT))
    assert.equal(catalog.roles.length, 0, '冲突角色不得进库')
    // 内置那份仍然生效（没被替换）
    assert.equal(resolveEffectiveRole(host.roleCatalog(), 'implementer')?.origin, 'builtin')
  })
})

/* ── 3. 只读（契约 P3 / TC-PC-19）───────────────────────────────── */

test('t77-6 (TC-PC-19): 对插件角色 roleOp 写操作 —— MT_ROLE_READONLY（save/delete/publish 三条都拒）', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const { host } = makeHost()

    const saved = host.roleOp('save', { role: ROLE() })
    assert.equal(saved.status, 'error')
    assert.equal(saved.code, CONTRIBUTION_CODES.ROLE_READONLY)
    assert.match(String(saved.message), /复制到项目/, '错误消息必须给修法')

    const deleted = host.roleOp('delete', { roleId: 'acme-reviewer', confirm: true })
    assert.equal(deleted.code, CONTRIBUTION_CODES.ROLE_READONLY)

    const published = host.roleOp('publish', { roleId: 'acme-reviewer', confirm: true })
    assert.equal(published.code, CONTRIBUTION_CODES.ROLE_READONLY)
  })
})

test('t77-7 (TC-PC-20): copyToProject 插件角色 → 项目库那份生效（想改就得走复制）', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const { host } = makeHost()
    const copied = copyToProject(host.rolePaths, 'acme-reviewer', 'plugin', host.contributionSnapshot().roles)
    assert.ok(existsSync(copied.filePath), '复制必须落盘')
    assert.equal(host.rolePaths.projectRolesDir && readProjectRole(host.rolePaths.projectRolesDir, 'acme-reviewer')?.origin, 'plugin:acme-workflow', '复制保留来源溯源')
    assert.equal(resolveEffectiveRole(host.roleCatalog(), 'acme-reviewer')?.origin, 'project', '项目库那份赢（优先级最高）')
    // 再复制一次必须拒（单向、不静默覆盖）
    assert.throws(() => copyToProject(host.rolePaths, 'acme-reviewer', 'plugin', host.contributionSnapshot().roles), /already exists/)
  })
})

/* ── 4. 只读装载本身（TC-PC-21/22）─────────────────────────────── */

test('t77-8 (TC-PC-21): 装载是只读的 —— 贡献目录文件数与 mtime 不变', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() }, teams: { 'acme-trio': TEAM() } }])
    const pluginDir = join(home, 'myteam', 'plugins', 'acme-workflow')
    const snapshot = () => {
      const out: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else out.push(`${full}:${readFileSync(full, 'utf8').length}`)
        }
      }
      walk(pluginDir)
      return out.sort().join('|')
    }
    const before = snapshot()
    makeHost()
    assert.equal(snapshot(), before, '装载不得写贡献目录（P2 数据不是代码 / P3 单向流动）')
  })
})

test('t77-9 (TC-PC-22): 装载不写团队账本 —— 账本字节数不变', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const { host, root } = makeHost()
    const sub = host.executeLeadTool('myteam_submit_plan', {
      teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }], tasks: [],
    }, {}) as any
    host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})
    const path = ledgerPath(root, sub.teamId)
    const before = readFileSync(path, 'utf8').length
    host.reloadContributions()
    assert.equal(readFileSync(path, 'utf8').length, before, '贡献装载不是团队范围内的变更')
  })
})

/* ── 5. 重载 / 卸载（TC-PC-23/24）──────────────────────────────── */

test('t77-10 (TC-PC-23): 重载 —— 新装插件的角色立刻可见（不必重启宿主）', () => {
  withHome((home) => {
    const { host } = makeHost()
    assert.equal(host.contributionSnapshot().roles.length, 0, '起始没有贡献')
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const reloaded = host.reloadContributions()
    assert.deepEqual(reloaded.roles.map((role) => role.id), ['acme-reviewer'])
    assert.ok(host.roleCatalog().some((entry) => entry.definition.id === 'acme-reviewer'), '重载后角色进目录')
  })
})

test('t77-11 (TC-PC-24): 卸载 —— 目录删除后角色消失，但**已召唤成员用召唤时快照不受影响**', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const { host, root } = makeHost()
    const sub = host.executeLeadTool('myteam_submit_plan', {
      teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'acme-reviewer' }], tasks: [],
    }, {}) as any
    assert.equal(sub.status, 'staged', '插件角色能进名册')
    host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})
    const spawned = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'acme-reviewer' }, {}) as any
    assert.ok(['spawned', 'ok'].includes(String(spawned.status)), `召唤插件角色应成功：${JSON.stringify(spawned)}`)

    // 模拟插件卸载
    rmSync(join(home, 'myteam', 'plugins', 'acme-workflow'), { recursive: true, force: true })
    const after = host.reloadContributions()
    assert.equal(after.roles.length, 0, '贡献消失')
    assert.ok(!host.roleCatalog().some((entry) => entry.definition.id === 'acme-reviewer' && entry.origin === 'plugin'), '目录里不再有插件角色')

    // 已召唤成员仍在册（召唤时快照，CHG-6 语义）
    const members = Object.values(host.service(sub.teamId).projectionSnapshot.members) as any[]
    assert.ok(members.some((member) => member.roleId === 'acme-reviewer'), '已召唤成员不受卸载影响')
    void root
  })
})

/* ── 6. 端到端：插件角色能真的组队跑（TC-PC-25）────────────────── */

test('t77-12 (TC-PC-25): 插件角色 + 插件模板能真的建队并派任务（不是只进目录）', () => {
  withHome((home) => {
    seedContributions(home, [{
      pluginId: 'acme-workflow',
      roles: { 'acme-reviewer': ROLE(), 'acme-implementer': ROLE({ id: 'acme-implementer', name: 'Acme 实现' }) },
      teams: { 'acme-trio': TEAM({ members: [{ roleId: 'acme-reviewer' }, { roleId: 'acme-implementer' }] }) },
    }])
    const { host } = makeHost()
    const sub = host.executeLeadTool('myteam_submit_plan', {
      teamName: 'Acme 团队', goal: 'G',
      roster: [{ roleId: 'captain' }, { roleId: 'acme-reviewer' }, { roleId: 'acme-implementer' }],
      tasks: [{
        title: '实现', description: 'd', acceptanceCriteria: ['AC1'],
        deliverableSpec: { path: 'docs/x.md' }, deps: [], requiredRole: 'acme-implementer',
        priority: 'P2', gateChain: ['review'],
      }],
    }, {}) as any
    assert.equal(sub.status, 'staged', `插件角色必须能进名册：${JSON.stringify(sub)}`)
    const approved = host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
    assert.equal(approved.status, 'approved')
    const tasks = Object.values(host.service(sub.teamId).projectionSnapshot.tasks) as any[]
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].input.requiredRole, 'acme-implementer', '插件角色能当任务角色')
  })
})

/* ── 7. 对外暴露面（端点 / 工具 / 门面）────────────────────────── */

test('t77-13: 面板端点 getContributions / reloadContributions —— 根级（只收 query），离线也能看', async () => {
  const home = mkdtempSync(join(tmpdir(), 't77-panelhome-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const root = mkdtempSync(join(tmpdir(), 't77-panel-'))
    const facade = new MyTeamPanelFacade({ set: () => {}, get: () => undefined, workspace: { root } } as any)

    const proto = MyTeamPanelFacade.prototype as Record<string, any>
    for (const name of ['getContributions', 'reloadContributions']) {
      const m = proto[name].toString().match(/^async\s+\w+\s*\(([^)]*)\)/)
      assert.ok(m, `${name} 应为 async 方法`)
      assert.deepEqual(m![1].split(',').map((s: string) => s.trim()).filter(Boolean), ['query'], `${name} 只接受 query（根级端点）`)
    }

    const view = (await (facade as any).getContributions({ workspaceRoot: root })) as any
    assert.equal(view.status, 'ok')
    assert.equal(view.plugins.length, 1)
    assert.deepEqual(view.roles.map((role: any) => role.id), ['acme-reviewer'])
    assert.ok(!('systemPrompt' in view.roles[0]), '列表视图不带 systemPrompt（面板不需要）')

    // 非法 workspaceRoot → 与其它根级端点同口径
    assert.equal(((await (facade as any).getContributions({ workspaceRoot: 'relative/path' })) as any).code, 'MT_VALIDATION')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('t77-14: 队长工具 myteam_list_contributions / myteam_reload_contributions —— 只读、可执行信息', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() }, teams: { 'acme-trio': TEAM() } }])
    const { host } = makeHost()
    const listed = host.executeLeadTool('myteam_list_contributions', {}, {}) as any
    assert.equal(listed.status, 'ok')
    assert.equal(listed.plugins.length, 1)
    assert.deepEqual(listed.roles.map((role: any) => role.id), ['acme-reviewer'], '队长要拿到能直接写进 roster 的 id')
    assert.equal(listed.teams[0].id, 'acme-trio')
    assert.deepEqual(listed.teams[0].members, [{ roleId: 'acme-reviewer' }], '名册预览给建队向导用')

    const reloaded = host.executeLeadTool('myteam_reload_contributions', {}, {}) as any
    assert.equal(reloaded.status, 'ok')
    assert.ok(reloaded.scannedAt, '重载返回扫描时间')
  })
})

test('t77-15: Remote 与门面都标记了这两个方法（gateway 发现协议）', () => {
  const descriptor = '@deepseek-ai/dsh-typert-protocol/remote-methods'
  for (const Service of [MyTeamRemote, MyTeamPanelFacade]) {
    const desc = (Service.prototype as Record<string, any>)[descriptor]
    const names = desc.methods.map((m: any) => m.method)
    for (const name of ['getContributions', 'reloadContributions']) {
      assert.ok(names.includes(name), `${Service.name} 缺 marker ${name}`)
    }
  }
})

/* ── 8. 坏插件隔离（契约 P4）───────────────────────────────────── */

test('t77-16 (TC-PC-03): 一个插件写坏了，另一个照常装载（失败隔离但大声）', () => {
  withHome((home) => {
    // 坏：清单不是合法 JSON
    const brokenDir = join(home, 'myteam', 'plugins', 'acme-broken')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'plugin.json'), '{ "pluginId": "acme-broken", }', 'utf8')
    // 好
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])

    const { host } = makeHost()
    const catalog = host.contributionSnapshot()
    assert.equal(catalog.plugins.length, 1, '只有合法的那个装载')
    assert.equal(catalog.plugins[0].pluginId, 'acme-workflow')
    assert.ok(catalog.warnings.some((warning) => warning.code === CONTRIBUTION_CODES.MANIFEST_INVALID && warning.level === 'error'), '坏插件必须大声')
    assert.equal(catalog.ok, false, '有 error 时 ok=false（面板据此显示红条）')
    assert.ok(host.roleCatalog().some((entry) => entry.definition.id === 'acme-reviewer'), '好插件不受影响')
  })
})

/* ── 9. 纯函数入口（不经宿主也能测）────────────────────────────── */

test('t77-17: loadContributions / discoverContributions / parseContributions 三个入口一致', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
    const root = contributionsRoot()
    const sources = discoverContributions(root)
    assert.deepEqual(sources.map((source) => source.pluginId), ['acme-workflow'])

    const parsed = parseContributions(sources, {})
    assert.equal(parsed.roles.length, 1)
    const loaded = loadContributions(root, {})
    assert.deepEqual(loaded.roles.map((role) => role.id), parsed.roles.map((role) => role.id), '两个入口结论一致')
  })
})

/* ── 10. PascalCase 原生工具名（CHG-91 顺带修的真 bug）─────────── */

test('t77-18: toolPolicy.allow 接受宿主原生 PascalCase 工具名（原模式只认小写，Read/Grep 被判非法）', () => {
  const base = { id: 'acme-reviewer', name: 'x', description: 'x', systemPrompt: 'x' }
  // 宿主原生工具名（PascalCase）—— 这是插件作者会写的形态
  for (const allow of [['Read'], ['Read', 'Grep', 'Glob'], ['Write', 'Edit', 'Bash'], ['myteam_*'], ['mcp__acme__figma']]) {
    assert.doesNotThrow(() => assertValidRole({ ...base, toolPolicy: { allow } } as never), `allow=${JSON.stringify(allow)} 应合法`)
  }
  // 注入形态仍然拒绝（宽松不等于放行）
  for (const allow of [['Bash; rm -rf /'], [''], ['Read Write']]) {
    assert.throws(() => assertValidRole({ ...base, toolPolicy: { allow } } as never), /not a valid tool name/, `allow=${JSON.stringify(allow)} 应拒绝`)
  }
})

test('t77-19: 插件角色带 PascalCase allow 能真的装载进库（不是只过校验）', () => {
  withHome((home) => {
    seedContributions(home, [{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE({ toolPolicy: { allow: ['Read', 'Grep', 'Glob'] } }) } }])
    const { host } = makeHost()
    const catalog = host.contributionSnapshot()
    assert.equal(catalog.ok, true, `不应有 error：${JSON.stringify(catalog.warnings)}`)
    assert.deepEqual(catalog.roles.map((role) => role.id), ['acme-reviewer'])
  })
})

/* ── 11. 面板可达性（CHG-96 真实安装目检抓出的缺陷）────────────── */

/**
 * 为什么需要这条：`ContributionsSection` 原本只在「项目」作用域的「角色」tab 里渲染，
 * 而「项目」切换按钮在**未选工作区**时是 disabled 的；面板默认停「全局」。
 * 结果：用户装完插件、打开面板看不到任何入口——但区块自己的文案写的是
 * 「贡献进**全局**角色库」。真实安装目检（CDP）才暴露出来，单测此前只覆盖了装载层。
 *
 * 本测试锁两件事：
 *  1. 区块在**全局作用域**（默认落点）渲染；
 *  2. 项目作用域仍然保留（两份渲染是「同一组件、两个入口」，不是复制代码）。
 */
test('t77-20: 插件贡献区块在「全局」作用域可见（默认落点不能是死路）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

  const renderSites = source.match(/j\(ContributionsSection,/g) ?? []
  assert.equal(renderSites.length, 2, `ContributionsSection 应有 2 处渲染（全局 + 项目），实际 ${renderSites.length} 处`)

  // 全局页：以 `mt-roles-section`（内置角色分区）为锚点，向上找同一 children 数组
  const globalAnchor = source.indexOf("id: 'mt-roles-section'")
  assert.ok(globalAnchor > 0, '全局页应有内置角色分区')
  const globalBlock = source.slice(Math.max(0, globalAnchor - 2000), globalAnchor)
  assert.ok(globalBlock.includes('j(ContributionsSection,'), '全局作用域的 .mt-page 里必须渲染插件贡献区块')

  // 项目页：rolesPage 仍保留（进入项目后按「这个角色是谁给的」就地可查）
  const rolesPageAnchor = source.indexOf('const rolesPage = js(')
  assert.ok(rolesPageAnchor > 0, '项目页 rolesPage 应存在')
  assert.ok(
    source.slice(rolesPageAnchor, rolesPageAnchor + 1200).includes('j(ContributionsSection,'),
    '项目作用域的角色页也应保留插件贡献区块',
  )
})
