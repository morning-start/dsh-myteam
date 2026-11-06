/**
 * T35（CHG-56）：项目层配置接线 —— `.team-workplace/config/team.config.json`
 * 与团队级配置组成三层合并：内置默认 < 项目 < 团队模板。
 *  - 只项目层：看板列/任务类型生效，getConfig source='project'；
 *  - 项目 + 团队模板：团队层覆盖同名字段，未声明段落保留项目层值；
 *  - 项目层非法：整层忽略 + 告警，回退默认（不误伤团队层）；
 *  - 离线看板同样吃项目层配置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { buildOfflineBoard } from '../src/core/index/offline-view.ts'

function setup(root: string) {
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, remote: new MyTeamRemote(rt as never, host) }
}

const writeProjectConfig = (root: string, value: unknown) => {
  const dir = join(root, '.team-workplace', 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'team.config.json'), JSON.stringify(value))
}

const presetFile = (root: string, id: string, value: unknown) => {
  const dir = join(root, '.team-workplace', 'config', 'presets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(value))
}

const PROJECT_CONFIG = {
  board: {
    columns: ['p-ideas', 'p-build', 'p-gates', 'done'],
    columnMapping: {
      'p-ideas': ['failed', 'blocked', 'cancelled'],
      'p-build': ['in_progress', 're-scoping'],
      'p-gates': ['gate:review', 'gate:verify', 'gate:archive'],
      done: ['done'],
    },
  },
  pipeline: { swimlaneBy: 'member', stages: ['p-plan', 'p-dev'], layout: 'linear' },
  taskTypes: { design: { gateChain: ['review'] } },
}

const DEV_TASK = {
  title: '项目配置任务', description: 'd', acceptanceCriteria: ['AC'],
  deliverableSpec: { path: 'docs/p.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
  deps: [], requiredRole: 'developer', estimate: 'S',
}

test('t35-1: 仅项目层配置生效——看板列/任务类型/配置来源 project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t35-'))
  try {
    writeProjectConfig(root, PROJECT_CONFIG)
    const { host, remote } = setup(root)

    const staged: any = host.executeLeadTool('myteam_submit_plan', { teamName: '项目队', goal: 'G', tasks: [] }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    const teamId = String(staged.teamId)
    assert.equal(staged.configApplied, undefined, '未用模板 → 不落团队配置')

    const board: any = await remote.getBoard({ teamId })
    assert.deepEqual(board.board.columns.map((c: any) => c.name), ['p-ideas', 'p-build', 'p-gates', 'done'])

    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'project')
    assert.equal(cfg.chain.find((c: any) => c.layer === 'project').active, true)
    assert.equal(cfg.chain.find((c: any) => c.layer === 'team').active, false)
    assert.equal(cfg.config.pipeline.swimlaneBy, 'member')
    assert.deepEqual(cfg.warnings, [])

    await remote.planAction({ teamId, action: 'approve' })
    const created: any = host.executeLeadTool('myteam_create_task', { teamId, task: { ...DEV_TASK, taskType: 'design' } }, {})
    assert.equal(created.status, 'created', JSON.stringify(created))
    assert.deepEqual(host.service(teamId).projectionSnapshot.tasks[created.taskId].gates, ['review'])

    const offline = buildOfflineBoard(root, teamId)
    assert.ok(offline)
    assert.deepEqual(offline!.board.columns.map((c) => c.name), ['p-ideas', 'p-build', 'p-gates', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t35-2: 团队模板覆盖项目层同名字段，未声明段落保留项目层', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t35b-'))
  try {
    writeProjectConfig(root, PROJECT_CONFIG)
    presetFile(root, 'team-over', {
      id: 'team-over', name: '覆盖模板', members: [{ roleId: 'developer' }],
      board: {
        columns: ['t-inbox', 't-doing', 'done'],
        columnMapping: { 't-inbox': ['failed', 'blocked', 'cancelled'], 't-doing': ['in_progress'], done: ['done'] },
      },
      // 不声明 pipeline / taskTypes → 应保留项目层
    })
    const { host, remote } = setup(root)

    const staged: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-over', teamName: '覆盖队', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    assert.deepEqual(staged.configApplied, ['board'])

    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'team')
    assert.deepEqual(cfg.config.board.columns, ['t-inbox', 't-doing', 'done'])
    assert.equal(cfg.config.pipeline.swimlaneBy, 'member', '项目层 pipeline 保留')
    assert.equal(cfg.config.taskTypes.design.gateChain[0], 'review', '项目层 taskTypes 保留')
    const board: any = await remote.getBoard({ teamId })
    assert.deepEqual(board.board.columns.map((c: any) => c.name), ['t-inbox', 't-doing', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t35-3: 项目层非法时整层忽略 + 告警，回退默认（团队层不受影响）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t35c-'))
  try {
    writeProjectConfig(root, { board: 'nonsense' })
    const { host, remote } = setup(root)
    const staged: any = host.executeLeadTool('myteam_submit_plan', { teamName: '坏配置队', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)

    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'default')
    assert.ok(cfg.warnings.some((w: string) => w.includes('project team.config.json structurally invalid')), JSON.stringify(cfg.warnings))
    assert.deepEqual(cfg.config.board.columns, ['backlog', 'ready', 'running', 'gates', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
