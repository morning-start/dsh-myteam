/**
 * T102 · CHG-131（docs/19 §5.2）：`myteam_copy_team` —— 复制团队定义 → 新草稿（C 档仅队长）。
 *
 * 为什么必须有：`copy_role` 已有，但**团队**没有任何复制路径——只能人点面板重建
 * （docs/19 §7 P0 最后一项）。
 *
 * 断言：
 *  ① 工具已注册；缺 `sourceTeamId` / 源团队不存在 → `MT_VALIDATION`（`field:'sourceTeamId'`）；
 *  ② 复制成功：新团队是 **`draft`**（不是 active）、名册条数与源一致、`sourceTeamId` 溯源；
 *  ③ **不复制运行态**：新团队账本为空（源团队的事件不搬）、任务为空；
 *  ④ 名称缺省带「（副本）」后缀，可显式覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t102-'))
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

/** 建一个有任务（含账本事件）的团队，返回 id */
async function sourceTeam(host: MyTeamHost, name: string) {
  const staged: any = await host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: '源团队目标',
    tasks: [{
      title: '源任务',
      description: '源任务描述',
      acceptanceCriteria: ['AC'],
      deliverableSpec: { path: 'docs/src.md', producer: 'developer', reviewer: 'acceptor', archiver: 'captain' },
      deps: [],
      requiredRole: 'developer',
    }],
  }, {})
  const teamId = String(staged.teamId)
  const approved: any = await host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  assert.ok(['ok', 'approved'].includes(String(approved.status)), JSON.stringify(approved))
  return teamId
}

test('t102-1: 注册 + 校验（缺 id / 不存在）', async () => {
  assert.ok(defsSource.includes("name: 'myteam_copy_team'"), 'defs 必须有 myteam_copy_team')
  const { host, root } = setup()
  try {
    const missing: any = await host.executeLeadTool('myteam_copy_team', {}, {})
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'sourceTeamId')
    const notFound: any = await host.executeLeadTool('myteam_copy_team', { sourceTeamId: 'nope' }, {})
    assert.equal(notFound.code, 'MT_VALIDATION')
    assert.ok(String(notFound.message).includes('myteam_list_teams'), '错误信息应指路 list_teams')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t102-2: 复制成功 —— 新团队是 draft + 名册 + 溯源', async () => {
  const { host, root } = setup()
  try {
    const sourceTeamId = await sourceTeam(host, '源团队')
    const copied: any = await host.executeLeadTool('myteam_copy_team', { sourceTeamId }, {})
    assert.equal(copied.status, 'ok', JSON.stringify(copied))
    assert.ok(copied.teamId && copied.teamId !== sourceTeamId, '必须是新团队 id')
    assert.equal(copied.sourceTeamId, sourceTeamId)
    assert.equal(copied.name, '源团队（副本）', '缺省名带副本后缀')
    const detail: any = host.executeLeadTool('myteam_get_team', { teamId: copied.teamId }, {})
    assert.equal(detail.status, 'ok', JSON.stringify(detail))
    assert.equal(detail.state, 'draft', '复制来的团队必须是 draft（走人审）')
    assert.equal(detail.goal, '源团队目标', '目标沿用源团队')
    assert.equal(detail.counts.tasks, 0, '**不复制任务**')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t102-3: 不复制运行态 —— 新账本不含源团队的创建事件', async () => {
  const { host, root } = setup()
  try {
    const sourceTeamId = await sourceTeam(host, '源团队2')
    const copied: any = await host.executeLeadTool('myteam_copy_team', { sourceTeamId, name: '自定义副本', goal: '新目标' }, {})
    assert.equal(copied.status, 'ok', JSON.stringify(copied))
    assert.equal(copied.name, '自定义副本', '名称可覆盖')
    const newLedger = join(root, '.dsh-myteam', 'tasks', copied.teamId, 'ledger.jsonl')
    const sourceLedger = join(root, '.dsh-myteam', 'tasks', sourceTeamId, 'ledger.jsonl')
    assert.ok(existsSync(sourceLedger), '源团队必须有账本')
    const sourceLines = readFileSync(sourceLedger, 'utf8').split('\n').filter(Boolean).length
    const newLines = existsSync(newLedger) ? readFileSync(newLedger, 'utf8').split('\n').filter(Boolean).length : 0
    assert.ok(newLines < sourceLines, `新账本不得包含源事件（源 ${sourceLines} 行，新 ${newLines} 行）`)
    const detail: any = host.executeLeadTool('myteam_get_team', { teamId: copied.teamId }, {})
    assert.equal(detail.goal, '新目标', '目标可覆盖')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
