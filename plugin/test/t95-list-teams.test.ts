/**
 * T95 · CHG-123（docs/19 §M0/M2）：`myteam_list_teams` / `myteam_get_team` —— 团队目录 + 详情（A 档只读）。
 *
 * 为什么必须有：团队是按项目隔离的资源，但此前**没有任何工具能列出本工作区有哪些团队**，
 * 模型无法「先看见再操作」（docs/19 §7 P0 第 1 项）。
 *
 * 断言：
 *  ① 两个工具已注册；
 *  ② 空工作区：`list_teams` 返回 `{status:'ok', teams:[], archived:{count:0,ids:[]}}` 并带
 *    「索引尚未生成」口径说明（**不假装有团队**）；
 *  ③ 建团队后：`get_team(teamId)` 返回名/目标/状态/计数/名册；
 *  ④ 缺 `teamId` / 不存在的团队 → `MT_VALIDATION`（`field:'teamId'`），**不返回空对象假装成功**；
 *  ⑤ `state` 过滤只回本状态；
 *  ⑥ 只读：两个工具都不产生账本事件（调用前后账本行数一致）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t95-'))
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, root }
}

test('t95-1: 工具已注册 + 空工作区不造团队', () => {
  assert.ok(defsSource.includes("name: 'myteam_list_teams'"), 'defs 必须有 myteam_list_teams')
  assert.ok(defsSource.includes("name: 'myteam_get_team'"), 'defs 必须有 myteam_get_team')
  const { host, root } = setup()
  try {
    const result: any = host.executeLeadTool('myteam_list_teams', {}, {})
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(Array.isArray(result.teams), true)
    assert.equal(result.teams.length, 0, '空工作区不得造团队')
    assert.equal(result.total, 0)
    assert.deepEqual(result.archived, { count: 0, ids: [] })
    /* 索引已由 initialize 写入 → 不带 note；只有读不到索引时才如实说明（两种都合法） */
    assert.ok(result.note === undefined || String(result.note).includes('索引'), 'note 若存在必须是索引口径说明')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t95-2: 建团队后 —— 详情返回名/目标/状态/计数/名册', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', {
      teamName: 'T95 队',
      goal: '验证团队目录',
      tasks: [],
    }, {})
    const teamId = String(staged.teamId)
    const detail: any = host.executeLeadTool('myteam_get_team', { teamId }, {})
    assert.equal(detail.status, 'ok', JSON.stringify(detail))
    assert.equal(detail.teamId, teamId)
    assert.equal(detail.name, 'T95 队')
    assert.equal(detail.goal, '验证团队目录')
    assert.ok(['draft', 'active'].includes(detail.state), `未知状态 ${detail.state}`)
    assert.deepEqual(detail.counts, { tasks: 0, done: 0, running: 0, members: 0 })
    assert.deepEqual(detail.members, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t95-3: 校验 —— 缺 teamId / 不存在的团队都 MT_VALIDATION', () => {
  const { host, root } = setup()
  try {
    const missing: any = host.executeLeadTool('myteam_get_team', {}, {})
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'teamId')
    const notFound: any = host.executeLeadTool('myteam_get_team', { teamId: 'no-such-team' }, {})
    assert.equal(notFound.status, 'error')
    assert.equal(notFound.code, 'MT_VALIDATION')
    assert.equal(notFound.field, 'teamId')
    assert.ok(String(notFound.message).includes('myteam_list_teams'), '错误信息应指路')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t95-4: state 过滤 + 只读（不产生账本事件）', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T95b', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const ledger = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
    const linesBefore = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    const all: any = host.executeLeadTool('myteam_list_teams', {}, {})
    const active: any = host.executeLeadTool('myteam_list_teams', { state: 'active' }, {})
    const archived: any = host.executeLeadTool('myteam_list_teams', { includeArchived: false }, {})
    assert.equal(Array.isArray(all.teams), true)
    assert.equal(active.teams.every((team: any) => team.state === 'active'), true, 'state=active 不得混入其它状态')
    assert.equal('archived' in archived, false, 'includeArchived:false 不带归档段')
    const linesAfter = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    assert.equal(linesAfter, linesBefore, '只读工具不得写账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
