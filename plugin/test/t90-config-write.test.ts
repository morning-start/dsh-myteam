/**
 * T90 · CHG-117：设置页配置写路径（`saveTeamConfig` / `resetTeamConfig` 端点）。
 *
 * 契约：docs/18 §7 四条纪律 —— **校验先于写**（失败零写入）、**原子写**（tmp + rename）、
 * **两段确认**（门禁链 / 规模上限变化或有在跑任务）、**未知键保留**（不因未知键拒绝）。
 *
 * 断言：
 *  ① 合法配置保存 → `ok` + 生效配置回显（source='team'）+ 文件真的落盘；
 *  ② 结构非法 → `MT_VALIDATION`（field=config），**零写入**；
 *  ③ 终态未覆盖 → `MT_VALIDATION`（reason=terminal-state-not-covered），**零写入**；
 *  ④ 改 limits → 先 `confirm-required` + 影响面，带 `confirm:true` 才写入；
 *  ⑤ 未知键照写（文件保留）+ 告警回显 + 生效配置忽略未知键；
 *  ⑥ `resetTeamConfig` 两段确认 → 删文件 + 来源回落；
 *  ⑦ 端点已注册（remote marker + 门面 marker 由 t13p 守）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import { teamConfigPath } from '../src/core/config/team-config.ts'

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

function stageTeam(host: MyTeamHost): string {
  const staged: any = host.executeLeadTool('myteam_submit_plan', { teamName: '配置队', goal: 'G', tasks: [] }, {})
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  return String(staged.teamId)
}

const COLUMNS = ['ideas', 'build', 'review', 'ship', 'done']

test('t90-1: 合法配置保存 —— ok + 生效配置回显 + 原子落盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t90-'))
  try {
    const { host, remote } = setup(root)
    const teamId = stageTeam(host)
    const config = { board: { columns: COLUMNS } }
    const saved: any = await remote.saveTeamConfig({ teamId, config })
    assert.equal(saved.status, 'ok', JSON.stringify(saved))
    assert.equal(saved.teamId, teamId)
    assert.equal(saved.source, 'team', '保存后来源必须是团队层')
    assert.deepEqual(saved.config.board.columns, COLUMNS, '回显的是**生效配置**')
    const filePath = teamConfigPath(root, teamId)
    assert.equal(existsSync(filePath), true, '文件必须真的落盘')
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), config)
    /* 再读一次：走 getConfig 也是同一份 */
    const cfg: any = await remote.getConfig({ teamId })
    assert.deepEqual(cfg.config.board.columns, COLUMNS)
    assert.equal(cfg.source, 'team')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t90-2: 结构非法 → MT_VALIDATION 且零写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t90-'))
  try {
    const { host, remote } = setup(root)
    const teamId = stageTeam(host)
    const bad: any = await remote.saveTeamConfig({ teamId, config: { board: { columns: 'nope' } } })
    assert.equal(bad.status, 'error')
    assert.equal(bad.code, 'MT_VALIDATION')
    assert.equal(bad.field, 'config')
    assert.equal(bad.reason, 'structural-invalid')
    assert.equal(existsSync(teamConfigPath(root, teamId)), false, '非法配置零写入')
    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'default', '配置未变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t90-3: 字段类型非法 → MT_VALIDATION（structural-invalid）且零写入；部分覆盖合法', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t90-'))
  try {
    const { host, remote } = setup(root)
    const teamId = stageTeam(host)
    /* columnMapping 的值必须是字符串数组——设置页 / JSON 源视图写坏类型必须被拒（CHG-117 收紧结构校验） */
    const bad: any = await remote.saveTeamConfig({ teamId, config: { board: { columnMapping: { running: 'in_progress' } } } })
    assert.equal(bad.status, 'error')
    assert.equal(bad.code, 'MT_VALIDATION')
    assert.equal(bad.reason, 'structural-invalid')
    assert.equal(existsSync(teamConfigPath(root, teamId)), false, '非法配置零写入')
    /* 只声明部分 columnMapping 合法：合并只补不删，终态由默认兜住（t11 口径不变） */
    const ok: any = await remote.saveTeamConfig({ teamId, config: { board: { columnMapping: { running: ['in_progress'] } } } })
    assert.equal(ok.status, 'ok', JSON.stringify(ok))
    assert.deepEqual(ok.config.board.columnMapping.running, ['in_progress'])
    assert.deepEqual(ok.config.board.columnMapping.done, ['done'], '默认映射保留（终态兜底）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t90-4: 改 limits 先两段确认（confirm-required + 影响面），确认后才写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t90-'))
  try {
    const { host, remote } = setup(root)
    const teamId = stageTeam(host)
    const config = { limits: { maxMembers: 3 } }
    const first: any = await remote.saveTeamConfig({ teamId, config })
    assert.equal(first.status, 'confirm-required', JSON.stringify(first))
    assert.equal(first.impact.limitsChanged, true)
    assert.equal(first.impact.gateChainsChanged, false)
    assert.equal(typeof first.impact.members, 'number')
    assert.equal(typeof first.impact.runningTasks, 'number')
    assert.equal(existsSync(teamConfigPath(root, teamId)), false, '未确认时零写入')
    const second: any = await remote.saveTeamConfig({ teamId, config, confirm: true })
    assert.equal(second.status, 'ok', JSON.stringify(second))
    assert.equal(second.config.limits.maxMembers, 3)
    assert.equal(second.impact.limitsChanged, true, '回执带影响面')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t90-5: 未知键保留 —— 不拒绝、文件原样保存、warnings 回显、生效配置忽略', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t90-'))
  try {
    const { host, remote } = setup(root)
    const teamId = stageTeam(host)
    const config = { board: { columns: COLUMNS }, futureField: 42 }
    const saved: any = await remote.saveTeamConfig({ teamId, config })
    assert.equal(saved.status, 'ok', JSON.stringify(saved))
    const onDisk: any = JSON.parse(readFileSync(teamConfigPath(root, teamId), 'utf8'))
    assert.equal(onDisk.futureField, 42, '未知键必须原样保留（JSON 源视图不丢内容）')
    assert.ok(
      (saved.warnings ?? []).some((w: string) => w.includes('futureField')),
      `warnings 必须提到未知键：${JSON.stringify(saved.warnings)}`,
    )
    assert.equal('futureField' in saved.config, false, '生效配置忽略未知键')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t90-6: resetTeamConfig 两段确认 —— 删文件 + 来源回落', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t90-'))
  try {
    const { host, remote } = setup(root)
    const teamId = stageTeam(host)
    const saved: any = await remote.saveTeamConfig({ teamId, config: { board: { columns: COLUMNS } } })
    assert.equal(saved.status, 'ok')
    const first: any = await remote.resetTeamConfig({ teamId })
    assert.equal(first.status, 'confirm-required')
    assert.equal(existsSync(teamConfigPath(root, teamId)), true, '未确认时文件还在')
    const second: any = await remote.resetTeamConfig({ teamId, confirm: true })
    assert.equal(second.status, 'reset')
    assert.equal(existsSync(teamConfigPath(root, teamId)), false)
    const cfg: any = await remote.getConfig({ teamId })
    assert.equal(cfg.source, 'default', '恢复默认后来源回落')
    /* 没有团队层文件时再 reset → noop（不假装成功） */
    const again: any = await remote.resetTeamConfig({ teamId, confirm: true })
    assert.equal(again.status, 'noop')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t90-7: 端点注册 —— remote 上存在 saveTeamConfig / resetTeamConfig', () => {
  const proto = MyTeamRemote.prototype as unknown as Record<string, unknown>
  assert.equal(typeof proto.saveTeamConfig, 'function')
  assert.equal(typeof proto.resetTeamConfig, 'function')
})
