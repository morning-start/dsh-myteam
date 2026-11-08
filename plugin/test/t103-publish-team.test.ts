/**
 * T103 · CHG-132（docs/20 §3/§5.1）：`myteam_publish_team` —— 发布团队定义到全局团队库（H 档）。
 *
 * **测试纪律**：必须把 `DSH_HOME` 指到临时目录——否则会写用户真实的
 * `~/.dsh/myteam/teams/`（CHG-127 的教训）。
 *
 * 断言：
 *  ① 工具已注册；缺 `teamId` / 团队不存在 → `MT_VALIDATION`（`field:'teamId'`）；
 *  ② 发布成功：`$DSH_HOME/myteam/teams/<teamId>.json` 落盘，含 `version/teamId/name/goal/roster/config/origin`；
 *  ③ **不发布运行态**：文件里没有 `ledger` / `tasks` / `sessionId` 字段；
 *  ④ 二次发布 → `confirm-required`（`impact.exists:true`）；`confirm:true` → `action:'updated'`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t103-'))
  const home = mkdtempSync(join(tmpdir(), 'myteam-t103-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  const cleanup = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  return { host, root, home, cleanup }
}

async function teamWith(host: MyTeamHost, name: string) {
  const staged: any = await host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: '发布用目标',
    tasks: [{
      title: '任务',
      description: '描述',
      acceptanceCriteria: ['AC'],
      deliverableSpec: { path: 'docs/a.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
      deps: [],
      requiredRole: 'developer',
    }],
  }, {})
  const teamId = String(staged.teamId)
  await host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  return teamId
}

test('t103-1: 注册 + 校验（缺 id / 不存在）', async () => {
  assert.ok(defsSource.includes("name: 'myteam_publish_team'"), 'defs 必须有 myteam_publish_team')
  const { host, cleanup } = setup()
  try {
    const missing: any = await host.executeLeadTool('myteam_publish_team', {}, {})
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'teamId')
    const notFound: any = await host.executeLeadTool('myteam_publish_team', { teamId: 'nope' }, {})
    assert.equal(notFound.code, 'MT_VALIDATION')
  } finally {
    cleanup()
  }
})

test('t103-2: 发布落盘 —— 定义齐全 + 不含运行态', async () => {
  const { host, home, cleanup } = setup()
  try {
    const teamId = await teamWith(host, '发布团队')
    const published: any = await host.executeLeadTool('myteam_publish_team', { teamId }, {})
    assert.equal(published.status, 'ok', JSON.stringify(published))
    assert.equal(published.action, 'created')
    const filePath = join(home, 'myteam', 'teams', `${teamId}.json`)
    assert.equal(published.filePath, filePath)
    assert.ok(existsSync(filePath), '全局团队定义必须落盘')
    const definition = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>
    assert.equal(definition.version, 1)
    assert.equal(definition.teamId, teamId)
    assert.equal(definition.name, '发布团队')
    assert.equal(definition.goal, '发布用目标')
    assert.equal(Array.isArray(definition.roster), true)
    assert.ok(definition.roster.length > 0)
    assert.equal(definition.origin, 'project-copy')
    /* 不发布运行态 */
    for (const forbidden of ['ledger', 'tasks', 'sessionId', 'evidence']) {
      assert.equal(forbidden in definition, false, `不得发布运行态字段 ${forbidden}`)
    }
  } finally {
    cleanup()
  }
})

test('t103-3: 二次发布 —— confirm-required 才覆盖', async () => {
  const { host, home, cleanup } = setup()
  try {
    const teamId = await teamWith(host, '发布团队2')
    await host.executeLeadTool('myteam_publish_team', { teamId }, {})
    const again: any = await host.executeLeadTool('myteam_publish_team', { teamId }, {})
    assert.equal(again.status, 'confirm-required', JSON.stringify(again))
    assert.equal(again.impact.exists, true)
    const forced: any = await host.executeLeadTool('myteam_publish_team', { teamId, confirm: true }, {})
    assert.equal(forced.status, 'ok', JSON.stringify(forced))
    assert.equal(forced.action, 'updated')
    const definition = JSON.parse(readFileSync(join(home, 'myteam', 'teams', `${teamId}.json`), 'utf8'))
    assert.equal(definition.teamId, teamId)
  } finally {
    cleanup()
  }
})
