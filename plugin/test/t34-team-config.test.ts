/**
 * T34（CHG-55）：团队模板配置生效 —— 模板的看板列/泳道/门禁/任务类型落成
 * `.dsh-myteam/tasks/<teamId>/team.config.json`，并在 TeamService →
 * 看板/门禁链/配置视图/离线快照里生效。
 *  - 落盘：建团时（service 首次构造之前）写入；无配置段落的模板不落文件；
 *  - 生效：getBoard 列、getConfig 来源链（team 层）、create_task 按 taskType 展开门禁链；
 *  - 边界：显式 gateChain 优先；staged 任务批准入库时同样展开；离线看板同列。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { teamConfigPath } from '../src/core/config/team-config.ts'
import { buildOfflineBoard } from '../src/core/index/offline-view.ts'

function setup(root: string) {
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: any) => ({
        followup: () => {},
        session: {},
        cancel: () => {},
      }),
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, remote: new MyTeamRemote(rt as never, host) }
}

const presetFile = (root: string, id: string, value: unknown) => {
  const dir = join(root, '.dsh-myteam', 'config', 'teams')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(value))
}

const CUSTOM_TEMPLATE = {
  id: 'team-board',
  name: '自定义看板团队',
  members: [{ roleId: 'developer' }, { roleId: 'acceptor' }],
  board: {
    columns: ['ideas', 'working', 'gates', 'done'],
    columnMapping: {
      working: ['in_progress', 're-scoping'],
      gates: ['gate:review', 'gate:verify', 'gate:archive'],
      done: ['done'],
      ideas: ['failed', 'blocked', 'cancelled'],
    },
  },
  pipeline: { swimlaneBy: 'member', stages: ['design', 'build', 'ship'], layout: 'linear' },
  gates: { enabled: false, commandTimeoutMs: 5000 },
  taskTypes: { fast: { gateChain: ['verify'] }, default: { gateChain: ['review', 'verify', 'archive'] } },
}

test('t34-1: 模板配置段落落团队配置，看板列/门禁/任务类型/配置视图随之生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t34-'))
  try {
    presetFile(root, 'team-board', CUSTOM_TEMPLATE)
    const { host, remote } = setup(root)

    const staged: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-board', teamName: '看板队', goal: 'G', tasks: [] }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    const teamId = String(staged.teamId)
    assert.deepEqual(staged.configApplied, ['board', 'pipeline', 'gates', 'taskTypes'])

    const path = teamConfigPath(root, teamId)
    assert.ok(existsSync(path), '团队级 team.config.json 已落盘')
    const saved: any = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(saved.board.columns, ['ideas', 'working', 'gates', 'done'])
    assert.deepEqual(saved.pipeline.stages, ['design', 'build', 'ship'])
    assert.equal(saved.gates.enabled, false)
    assert.deepEqual(saved.taskTypes.fast.gateChain, ['verify'])

    // 服务构造时已读到团队级配置（不是缓存默认值）
    const svc = host.service(teamId)
    assert.equal(svc.configSource, 'team')
    assert.deepEqual(svc.effectiveConfig.board.columns, ['ideas', 'working', 'gates', 'done'])

    await remote.planAction({ teamId, action: 'approve' })
    const board: any = await remote.getBoard({ teamId })
    assert.deepEqual(board.board.columns.map((c: any) => c.name), ['ideas', 'working', 'gates', 'done'])

    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'team')
    assert.equal(cfg.chain.find((c: any) => c.layer === 'team').active, true)
    assert.deepEqual(cfg.config.taskTypes.fast.gateChain, ['verify'])
    assert.equal(cfg.config.pipeline.swimlaneBy, 'member')
    assert.deepEqual(cfg.warnings, [])

    // 任务类型 → 门禁链：模板 taskTypes.fast
    const task = {
      title: '快餐任务', description: 'd', acceptanceCriteria: ['AC'],
      deliverableSpec: { path: 'docs/f.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
      deps: [], requiredRole: 'developer', taskType: 'fast', estimate: 'S',
    }
    const created: any = host.executeLeadTool('myteam_create_task', { teamId, task }, {})
    assert.equal(created.status, 'created', JSON.stringify(created))
    assert.deepEqual(host.service(teamId).projectionSnapshot.tasks[created.taskId].gates, ['verify'])

    // 显式 gateChain 优先于任务类型
    const explicit: any = host.executeLeadTool('myteam_create_task', {
      teamId,
      task: { ...task, title: '显式链', taskType: 'fast', gateChain: ['archive'], deps: [created.taskId] },
    }, {})
    assert.equal(explicit.status, 'created', JSON.stringify(explicit))
    assert.deepEqual(host.service(teamId).projectionSnapshot.tasks[explicit.taskId].gates, ['archive'])

    // 离线看板复用团队配置列
    const offline = buildOfflineBoard(root, teamId)
    assert.ok(offline)
    assert.deepEqual(offline!.board.columns.map((c) => c.name), ['ideas', 'working', 'gates', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t34-2: 模板未声明配置段落 → 不落团队配置，来源仍是插件默认', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t34b-'))
  try {
    presetFile(root, 'bare', { id: 'bare', name: '裸模板', members: [{ roleId: 'developer' }] })
    const { host, remote } = setup(root)

    const staged: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'bare', teamName: '裸队', goal: 'G', tasks: [] }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    assert.equal(staged.configApplied, undefined)
    const teamId = String(staged.teamId)
    assert.equal(existsSync(teamConfigPath(root, teamId)), false)

    await remote.planAction({ teamId, action: 'approve' })
    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'default')
    const board: any = await remote.getBoard({ teamId })
    assert.deepEqual(board.board.columns.map((c: any) => c.name), ['backlog', 'ready', 'running', 'gates', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t34-4: 同一团队重复提交不覆盖既有团队配置（模板只对建团生效）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t34d-'))
  try {
    presetFile(root, 'team-board', CUSTOM_TEMPLATE)
    const { host } = setup(root)

    const first: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-board', teamName: '重提队', goal: 'G', tasks: [] }, {})
    assert.equal(first.status, 'staged', JSON.stringify(first))
    const teamId = String(first.teamId)
    const path = teamConfigPath(root, teamId)
    const before = readFileSync(path, 'utf8')

    // 换一个模板（不同看板列）用同一团队名再提交 → 解析到同一 teamId，配置不得被改写
    presetFile(root, 'team-board-2', {
      ...CUSTOM_TEMPLATE,
      id: 'team-board-2',
      name: '另一个模板',
      board: { columns: ['a', 'b', 'done'], columnMapping: { a: ['failed', 'blocked', 'cancelled'], b: ['in_progress'], done: ['done'] } },
    })
    const second: any = host.executeLeadTool('myteam_submit_plan', { presetId: 'team-board-2', teamName: '重提队', goal: 'G2', tasks: [] }, {})
    assert.equal(second.status, 'staged', JSON.stringify(second))
    assert.equal(second.teamId, teamId, '同名团队复用同一 id')
    assert.equal(second.configApplied, undefined, '既有团队不再套用模板配置')
    assert.equal(readFileSync(path, 'utf8'), before, '团队级配置未被覆盖')
    assert.deepEqual(host.service(teamId).effectiveConfig.board.columns, ['ideas', 'working', 'gates', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t34-3: staged 任务批准入库时按模板 taskTypes 展开门禁链', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t34c-'))
  try {
    presetFile(root, 'team-board', CUSTOM_TEMPLATE)
    const { host, remote } = setup(root)
    const task = {
      title: 'staged 快任务', description: 'd', acceptanceCriteria: ['AC'],
      deliverableSpec: { path: 'docs/s.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
      deps: [], requiredRole: 'developer', taskType: 'fast', estimate: 'S',
    }
    const staged: any = host.executeLeadTool('myteam_submit_plan', {
      presetId: 'team-board', teamName: '入库队', goal: 'G', tasks: [task],
    }, {})
    assert.equal(staged.status, 'staged', JSON.stringify(staged))
    const teamId = String(staged.teamId)

    const approved: any = await remote.planAction({ teamId, action: 'approve' })
    assert.equal(approved.status, 'approved', JSON.stringify(approved))
    assert.deepEqual(approved.createdTasks, ['task-1'])
    assert.deepEqual(host.service(teamId).projectionSnapshot.tasks['task-1'].gates, ['verify'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
