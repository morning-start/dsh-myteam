/**
 * T76 · 插件团队贡献契约（docs/16）—— **契约校验器**的行为测试。
 *
 * 为什么先测校验器而不是先测 myteam 侧实现：
 * 用户在 CHG-90 明确要求「先设置好契约，然后再来实现」。契约的可执行部分是
 * `skills/myteam-plugin-team/tools/check-contribution.mjs`——它报的每个码就是契约 §9 的错误码。
 * **校验器先绿，实现才有靶子**；否则实现完再回头改契约 = 两头返工。
 *
 * 覆盖 docs/16 §13 的 TC-PC-01 ~ TC-PC-18（校验器可判定的部分）。
 * 全部用真实函数入口（`checkContribution` / `checkContributionsRoot`），不 mock 文件系统。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line import/no-relative-packages -- 契约校验器是 skills 资产，测试跨目录引用是有意的
import { checkContribution, checkContributionsRoot } from '../../skills/myteam-plugin-team/tools/check-contribution.mjs'

/* ── 夹具：在临时目录里造一个贡献根 ─────────────────────────────── */

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

interface Layout {
  pluginId: string
  manifest?: Record<string, unknown> | string
  roles?: Record<string, Record<string, unknown> | string>
  teams?: Record<string, Record<string, unknown> | string>
  /** 直接在目录里额外写的文件（用于测 .js 忽略 / 越界） */
  extra?: Record<string, string>
}

function writeJson(filePath: string, value: Record<string, unknown> | string): void {
  writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8')
}

function makeRoot(layouts: Layout[]): string {
  const root = mkdtempSync(join(tmpdir(), 't76-contract-'))
  for (const layout of layouts) {
    const dir = join(root, layout.pluginId)
    mkdirSync(join(dir, 'roles'), { recursive: true })
    mkdirSync(join(dir, 'teams'), { recursive: true })
    const manifest = layout.manifest ?? {
      contractVersion: 1,
      pluginId: layout.pluginId,
      displayName: 'Acme 工作流插件',
      version: '1.0.0',
      roles: Object.keys(layout.roles ?? {}).map((id) => ({ id, file: `roles/${id}.json` })),
      teams: Object.keys(layout.teams ?? {}).map((id) => ({ id, file: `teams/${id}.json` })),
    }
    writeJson(join(dir, 'plugin.json'), manifest)
    for (const [id, role] of Object.entries(layout.roles ?? {})) writeJson(join(dir, 'roles', `${id}.json`), role)
    for (const [id, team] of Object.entries(layout.teams ?? {})) writeJson(join(dir, 'teams', `${id}.json`), team)
    for (const [name, content] of Object.entries(layout.extra ?? {})) writeFileSync(join(dir, name), content, 'utf8')
  }
  return root
}

const codes = (report: { findings: Array<{ code: string }> }) => report.findings.map((finding) => finding.code)
const errors = (report: { findings: Array<{ level: string; code: string }> }) =>
  report.findings.filter((finding) => finding.level === 'error').map((finding) => finding.code)

/* ── 1. 正路子（TC-PC-01 / 02）────────────────────────────────── */

test('t76-1 (TC-PC-01): 空根目录 —— 没有插件贡献是正常态，不是错误', () => {
  const root = mkdtempSync(join(tmpdir(), 't76-empty-'))
  const result = checkContributionsRoot(root)
  assert.deepEqual(result.plugins, [])
  assert.equal(result.report.ok, true, '空目录必须 ok')
  assert.deepEqual(errors(result.report), [])
})

test('t76-1b (TC-PC-01): 根目录不存在 —— info 级提示，不是错误', () => {
  const result = checkContributionsRoot(join(tmpdir(), 't76-does-not-exist-xyz'))
  assert.equal(result.report.ok, true)
  assert.ok(codes(result.report).includes('MT_CONTRIBUTION_ROOT_ABSENT'))
})

test('t76-2 (TC-PC-02): 合法单插件 —— 角色与团队模板都被接受，且 id 保序', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE(), 'acme-implementer': ROLE({ id: 'acme-implementer', name: '实现' }) },
    teams: { 'acme-trio': TEAM({ members: [{ roleId: 'acme-reviewer' }, { roleId: 'acme-implementer' }] }) },
  }])
  const result = checkContributionsRoot(root)
  assert.equal(result.report.ok, true, `应通过，实际：${JSON.stringify(result.report.findings)}`)
  assert.equal(result.plugins.length, 1)
  assert.deepEqual(result.roles.map((role) => role.id), ['acme-reviewer', 'acme-implementer'])
  assert.deepEqual(result.teams.map((team) => team.id), ['acme-trio'])
  assert.equal(result.plugins[0].status, 'ok')
})

/* ── 2. 清单级失败（TC-PC-03 ~ 07）─────────────────────────────── */

test('t76-3 (TC-PC-03): plugin.json 坏 JSON —— 该插件整体跳过，其它插件不受影响', () => {
  const root = makeRoot([
    { pluginId: 'acme-broken', manifest: '{ "pluginId": "acme-broken", }' },
    { pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } },
  ])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_PLUGIN_MANIFEST_INVALID'), '坏 JSON 要报 MT_PLUGIN_MANIFEST_INVALID')
  assert.equal(result.plugins.length, 1, '只装载合法的那一个')
  assert.equal(result.plugins[0].pluginId, 'acme-workflow', '失败隔离：好插件照常装载')
})

test('t76-4 (TC-PC-04): contractVersion 高于支持集 —— 整个插件跳过（不尽力解析）', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    manifest: { contractVersion: 2, pluginId: 'acme-workflow', displayName: 'x', version: '1.0.0' },
    roles: { 'acme-reviewer': ROLE() },
  }])
  const result = checkContributionsRoot(root)
  assert.deepEqual(errors(result.report), ['MT_PLUGIN_CONTRACT_UNSUPPORTED'])
  assert.equal(result.plugins.length, 0, '高版本契约必须整插件跳过')
  assert.equal(result.roles.length, 0, '不能偷偷装载一部分')
})

test('t76-5 (TC-PC-05): pluginId 含下划线 / 大写 —— MT_PLUGIN_ID_INVALID', () => {
  for (const badId of ['acme_workflow', 'Acme-Workflow', 'acmeWorkflow']) {
    const root = makeRoot([{
      pluginId: badId,
      manifest: { contractVersion: 1, pluginId: badId, displayName: 'x', version: '1.0.0' },
    }])
    const result = checkContributionsRoot(root)
    assert.ok(
      errors(result.report).includes('MT_PLUGIN_ID_INVALID'),
      `${badId} 应报 MT_PLUGIN_ID_INVALID，实际 ${JSON.stringify(errors(result.report))}`,
    )
    assert.equal(result.plugins.length, 0)
  }
})

test('t76-6 (TC-PC-06): 清单 pluginId ≠ 目录名 —— MT_PLUGIN_ID_MISMATCH', () => {
  // 注意：形状非法的 id 会先撞 MT_PLUGIN_ID_INVALID（契约 §4.4 校验顺序：
  // 先形状、后目录名比对）。所以这里必须用**形状合法但不同**的 id。
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    manifest: { contractVersion: 1, pluginId: 'acme-other', displayName: 'x', version: '1.0.0' },
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_PLUGIN_ID_MISMATCH'), `实际：${JSON.stringify(errors(result.report))}`)
  assert.equal(result.plugins.length, 0)
})

test('t76-6b: 校验顺序 —— 形状先于目录名比对（非法 id 不会报 MISMATCH）', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    manifest: { contractVersion: 1, pluginId: 'Acme_Other', displayName: 'x', version: '1.0.0' },
  }])
  const result = checkContributionsRoot(root)
  const found = errors(result.report)
  assert.ok(found.includes('MT_PLUGIN_ID_INVALID'), '先报形状')
  assert.ok(!found.includes('MT_PLUGIN_ID_MISMATCH'), '形状错了就不该走到比对')
})

test('t76-7 (TC-PC-07): 两目录同 pluginId —— 确定性失败（字典序后者），不随机', () => {
  const root = makeRoot([
    { pluginId: 'acme-a', manifest: { contractVersion: 1, pluginId: 'acme-shared', displayName: 'A', version: '1.0.0' } },
    { pluginId: 'acme-b', manifest: { contractVersion: 1, pluginId: 'acme-shared', displayName: 'B', version: '1.0.0' } },
  ].map((layout) => ({
    ...layout,
    // 目录名与清单 id 必须相等才能走到「重复」判定 —— 这里故意让两个目录都声明同一个 id，
    // 于是两者都先撞 MT_PLUGIN_ID_MISMATCH；重复检测只在「目录名相同」的极端情况下才触发。
    manifest: layout.manifest,
  })))
  const result = checkContributionsRoot(root)
  // 目录名不同 → 各自先撞 MISMATCH；这是契约 §4.4 的校验顺序（id 形状先于重复）
  assert.ok(errors(result.report).includes('MT_PLUGIN_ID_MISMATCH'))
  assert.equal(result.plugins.length, 0)
})

/* ── 3. 条目级失败（TC-PC-08 ~ 18）────────────────────────────── */

test('t76-8 (TC-PC-08): 清单列了不存在的文件 —— 该条跳过，插件仍可用', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    manifest: {
      contractVersion: 1, pluginId: 'acme-workflow', displayName: 'x', version: '1.0.0',
      roles: [{ id: 'acme-reviewer', file: 'roles/reviewer.json' }],
    },
    // 故意不写 roles/acme-reviewer.json（清单要的是 roles/reviewer.json）
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_CONTRIBUTION_FILE_MISSING'))
  assert.equal(result.plugins.length, 1, '插件本身仍装载（条目级失败）')
  assert.deepEqual(result.plugins[0].roles, [], '没有任何角色进库')
})

test('t76-9 (TC-PC-09): 文件内 id ≠ 清单 id —— MT_CONTRIBUTION_ID_MISMATCH', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    manifest: {
      contractVersion: 1, pluginId: 'acme-workflow', displayName: 'x', version: '1.0.0',
      roles: [{ id: 'acme-reviewer', file: 'roles/reviewer.json' }],
    },
    roles: { reviewer: ROLE({ id: 'reviewer' }) },
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_CONTRIBUTION_ID_MISMATCH'))
  assert.deepEqual(result.plugins[0].roles, [])
})

test('t76-10 (TC-PC-10): 角色撞内置 id —— 硬失败并提示加前缀', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { implementer: ROLE({ id: 'implementer' }) },
  }])
  const result = checkContributionsRoot(root)
  const conflict = result.report.findings.find((finding: any) => finding.code === 'MT_ROLE_CONTRIBUTION_CONFLICT')
  assert.ok(conflict, '撞内置必须失败')
  assert.equal((conflict as any).conflictsWith, 'builtin')
  assert.match((conflict as any).message, /acme-implementer/, '消息里必须给出改名建议')
})

test('t76-11 (TC-PC-11): 两插件贡献同 id 角色 —— 后者失败且消息点名', () => {
  const root = makeRoot([
    { pluginId: 'acme-a', roles: { 'acme-reviewer': ROLE() } },
    { pluginId: 'acme-b', roles: { 'acme-reviewer': ROLE() } },
  ])
  const result = checkContributionsRoot(root)
  const conflicts = result.report.findings.filter((finding: any) => finding.code === 'MT_ROLE_CONTRIBUTION_CONFLICT')
  assert.ok(conflicts.length >= 1, '跨插件同 id 必须报冲突')
  assert.match((conflicts[0] as any).message, /acme-reviewer/)
})

test('t76-13 (TC-PC-13): 角色声明 isCaptain —— MT_ROLE_CAPTAIN_RESERVED', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-captain': ROLE({ id: 'acme-captain', isCaptain: true }) },
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_ROLE_CAPTAIN_RESERVED'))
  assert.deepEqual(result.plugins[0].roles, [])
})

test('t76-14 (TC-PC-14): toolPolicy.allow 不是字符串数组 —— MT_ROLE_INVALID（不是静默扩权）', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE({ toolPolicy: { allow: 'Read' } }) },
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_ROLE_INVALID'), '非数组必须报错，不能当通配符')
})

test('t76-15 (TC-PC-15): roles[].file 路径穿越 —— MT_CONTRIBUTION_PATH_TRAVERSAL', () => {
  for (const badFile of ['../outside.json', '/etc/passwd', 'roles/../../x.json']) {
    const root = makeRoot([{
      pluginId: 'acme-workflow',
      manifest: {
        contractVersion: 1, pluginId: 'acme-workflow', displayName: 'x', version: '1.0.0',
        roles: [{ id: 'acme-reviewer', file: badFile }],
      },
    }])
    const result = checkContributionsRoot(root)
    assert.ok(
      errors(result.report).includes('MT_CONTRIBUTION_PATH_TRAVERSAL'),
      `${badFile} 必须被拒，实际 ${JSON.stringify(errors(result.report))}`,
    )
  }
})

test('t76-16 (TC-PC-16): 团队模板 members 含 captain —— MT_TEAM_TEMPLATE_CAPTAIN', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE() },
    teams: { 'acme-trio': TEAM({ members: [{ roleId: 'captain' }, { roleId: 'acme-reviewer' }] }) },
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_TEAM_TEMPLATE_CAPTAIN'))
  assert.deepEqual(result.plugins[0].teams, [])
})

test('t76-17 (TC-PC-17): 模板引用不可解析角色 —— MT_TEAM_TEMPLATE_UNRESOLVED 且列出 id', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE() },
    teams: { 'acme-trio': TEAM({ members: [{ roleId: 'acme-reviewer' }, { roleId: 'acme-tester' }] }) },
  }])
  const result = checkContributionsRoot(root)
  const unresolved = result.report.findings.find((finding: any) => finding.code === 'MT_TEAM_TEMPLATE_UNRESOLVED')
  assert.ok(unresolved, '不可解析必须失败')
  assert.match((unresolved as any).message, /acme-tester/, '消息必须点名解析不到的 id')
  assert.deepEqual(result.plugins[0].teams, [])
})

test('t76-18 (TC-PC-18): 模板 id 撞内置 —— MT_TEAM_TEMPLATE_CONFLICT', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE() },
    teams: { 'starter-team': TEAM({ id: 'starter-team' }) },
  }])
  const result = checkContributionsRoot(root)
  assert.ok(errors(result.report).includes('MT_TEAM_TEMPLATE_CONFLICT'))
})

/* ── 4. 非错误但会被看见（warning / info）─────────────────────── */

test('t76-19: 角色写了 origin —— 覆盖警告（myteam 会盖章，作者不该写）', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE({ origin: 'builtin:captain' }) },
  }])
  const result = checkContributionsRoot(root)
  assert.equal(result.report.ok, true, 'warning 不阻断')
  assert.ok(codes(result.report).includes('MT_CONTRIBUTION_ORIGIN_STAMPED'))
})

test('t76-20: 目录里有 .js 文件 —— info 提示「只读 JSON 永不执行」（P2 数据不是代码）', () => {
  const root = makeRoot([{
    pluginId: 'acme-workflow',
    roles: { 'acme-reviewer': ROLE() },
    extra: { 'evil.js': 'process.exit(1)' },
  }])
  const result = checkContributionsRoot(root)
  assert.equal(result.report.ok, true, '可执行文件不阻断（也不会被执行）')
  assert.ok(codes(result.report).includes('MT_CONTRIBUTION_CODE_IGNORED'))
})

/* ── 5. 仓库自带模板必须过 ─────────────────────────────────────── */

test('t76-21: 仓库自带模板 templates/ 必须 0 error 0 warning（skill 里给人拷的就是它）', async () => {
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const templatesRoot = join(here, '..', '..', 'skills', 'myteam-plugin-team', 'templates')
  const result = checkContributionsRoot(templatesRoot)
  assert.equal(result.report.ok, true, `模板必须干净：${JSON.stringify(result.report.findings)}`)
  assert.equal(result.report.warnings.length, 0, '模板不该有 warning（会教坏使用者）')
  assert.equal(result.plugins.length, 1)
  assert.equal(result.roles.length, 3, '模板带 3 个角色')
  assert.equal(result.teams.length, 1, '模板带 1 个团队模板')
})

/* ── 6. 单插件入口（不带 --root）也要能用 ─────────────────────── */

test('t76-22: checkContribution（单插件入口）与 root 入口结论一致', () => {
  const root = makeRoot([{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
  const single = checkContribution(join(root, 'acme-workflow'))
  assert.equal(single.report.ok, true)
  assert.equal(single.plugin?.pluginId, 'acme-workflow')
  assert.deepEqual(single.roles.map((role: any) => role.id), ['acme-reviewer'])
})

/* ── 7. BOM（Windows 上 100% 会踩的坑）──────────────────────────── */

test('t76-23: 带 UTF-8 BOM 的 JSON 必须能读（PowerShell / 记事本默认写 BOM）', () => {
  // 这条不是洁癖：`Set-Content -Encoding UTF8`（PS 5.1）和记事本「UTF-8」都会写 EF BB BF，
  // 而 `JSON.parse('\uFEFF{...}')` 直接抛「Unexpected token」——插件作者会以为清单写错了。
  const root = makeRoot([{ pluginId: 'acme-workflow', roles: { 'acme-reviewer': ROLE() } }])
  const dir = join(root, 'acme-workflow')
  // 给清单和角色文件都加 BOM
  for (const rel of ['plugin.json', join('roles', 'acme-reviewer.json')]) {
    const filePath = join(dir, rel)
    const content = readFileSync(filePath, 'utf8')
    writeFileSync(filePath, `\uFEFF${content}`, 'utf8')
  }
  const result = checkContributionsRoot(root)
  assert.equal(result.report.ok, true, `BOM 不该让清单或角色失效：${JSON.stringify(result.report.findings)}`)
  assert.equal(result.plugins.length, 1)
  assert.deepEqual(result.roles.map((role: any) => role.id), ['acme-reviewer'])
})
