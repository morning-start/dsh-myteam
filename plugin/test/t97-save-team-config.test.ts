/**
 * T97 · CHG-125（docs/19 §M2）：`myteam_save_team_config` —— 写团队配置（C 档，队长专属）。
 *
 * 为什么必须有：设置页已能写（CHG-117 端点 + CHG-118 表单），但 **Lead 工具只有
 * `reset_team_config`**——模型改不了 `team.config.json`（docs/19 §7 P1 缺口）。
 *
 * 断言：
 *  ① 工具已注册；
 *  ② 缺 `config` → `MT_VALIDATION`（`field:'config'`）；
 *  ③ 结构非法（段落类型错）→ `MT_VALIDATION` 带 `field`，**零写入**（文件不存在/未变）；
 *  ④ 合法保存 → `status:'ok'` 且配置落盘（读回同一份）；
 *  ⑤ **未知键保留**（源视图 → 表单 → 保存不丢手写内容）；
 *  ⑥ 幂等：同配置连存两次结果一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t97-'))
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

/** 递归找 team.config.json（落点由 storeLayout 决定，测试不写死路径） */
function findTeamConfig(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let isDir = false
    try { isDir = statSync(path).isDirectory() } catch { continue }
    if (isDir) findTeamConfig(path, out)
    else if (name === 'team.config.json') out.push(path)
  }
  return out
}

test('t97-1: 工具已注册 + 缺 config 拒绝', async () => {
  assert.ok(defsSource.includes("name: 'myteam_save_team_config'"), 'defs 必须有 myteam_save_team_config')
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T97', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const missing: any = await host.executeLeadTool('myteam_save_team_config', { teamId }, {})
    assert.equal(missing.status, 'error', JSON.stringify(missing))
    assert.equal(missing.code, 'MT_VALIDATION')
    assert.equal(missing.field, 'config')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t97-2: 结构非法 —— MT_VALIDATION + 零写入', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T97b', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const before = findTeamConfig(join(root, '.dsh-myteam')).map((path) => readFileSync(path, 'utf8'))
    const bad: any = await host.executeLeadTool('myteam_save_team_config', { teamId, config: { limits: 'not-an-object' } }, {})
    assert.equal(bad.status, 'error', JSON.stringify(bad))
    assert.equal(bad.code, 'MT_VALIDATION')
    assert.ok(String(bad.field ?? '').length > 0, '必须指出哪个字段非法')
    const after = findTeamConfig(join(root, '.dsh-myteam')).map((path) => readFileSync(path, 'utf8'))
    assert.deepEqual(after, before, '非法配置必须零写入')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t97-3: 合法保存落盘 + 未知键保留 + 幂等', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T97c', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const config = {
      board: { columns: ['backlog', 'ready', 'running', 'gates', 'done'] },
      limits: { maxMembers: 4, memberMaxDepth: 1, maxTasks: 12 },
      /* 未知键：源视图手写内容必须原样保留 */
      customSection: { note: '手写内容不许丢' },
    }
    const saved: any = await host.executeLeadTool('myteam_save_team_config', { teamId, config, confirm: true }, {})
    /* 有影响面（limits 变化）时可能先回 confirm-required：这里带 confirm 直接落盘 */
    assert.ok(['ok', 'saved'].includes(String(saved.status)), JSON.stringify(saved))
    const files = findTeamConfig(join(root, '.dsh-myteam'))
    assert.ok(files.length > 0, '配置必须落盘')
    const raw = readFileSync(files[0], 'utf8')
    assert.ok(raw.includes('customSection'), '未知键必须原样保留')
    assert.ok(raw.includes('手写内容不许丢'))
    /* 幂等：同配置再存一次不报错 */
    const again: any = await host.executeLeadTool('myteam_save_team_config', { teamId, config, confirm: true }, {})
    assert.ok(['ok', 'saved'].includes(String(again.status)), JSON.stringify(again))
    assert.equal(readFileSync(files[0], 'utf8'), raw, '同配置重存必须字节一致')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
