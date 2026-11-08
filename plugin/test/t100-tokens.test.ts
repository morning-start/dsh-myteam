/**
 * T100 · CHG-129（docs/19 §M10）：`myteam_get_tokens` —— token / 成本只读查询（A 档）。
 *
 * 为什么必须有：面板有 `getTokens` 端点，但模型侧**没有工具**——无法自评预算
 * （docs/19 §M10 缺口）。
 *
 * 断言：
 *  ① 工具已注册；返回 `{status:'ok', teamId, tokens}`；
 *  ② `tokens` 具备 `days` / `totals` 结构（CHG-86 增量桶口径）；
 *  ③ 只读：不写账本（调用前后账本行数一致）；
 *  ④ 幂等：连读两次 `days` 与 `totals` 稳定（不因读取而改变历史）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t100-'))
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

test('t100-1: 注册 + 返回结构（days / totals）', async () => {
  assert.ok(defsSource.includes("name: 'myteam_get_tokens'"), 'defs 必须有 myteam_get_tokens')
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T100', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const result: any = host.executeLeadTool('myteam_get_tokens', { teamId }, {})
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.teamId, teamId)
    assert.equal(typeof result.tokens, 'object')
    assert.ok(result.tokens !== null)
    assert.equal(typeof result.tokens.days, 'object', 'days 必须存在（按天增量桶）')
    assert.equal(typeof result.tokens.totals, 'object', 'totals 必须存在（成员累计量）')
    /* 估算标注：不得出现金额字段 */
    assert.equal('cost' in result.tokens, false, 'tokenMeter 是估算，不提供金额')
    assert.equal('usd' in result.tokens, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t100-2: 只读 + 幂等 —— 不写账本、连读两次稳定', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T100b', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const ledger = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
    const before = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    const first: any = host.executeLeadTool('myteam_get_tokens', { teamId }, {})
    const second: any = host.executeLeadTool('myteam_get_tokens', { teamId }, {})
    const after = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    assert.equal(after, before, '只读工具不得写账本')
    assert.deepEqual(second.tokens.days, first.tokens.days, 'days 必须稳定（不因读取改变历史）')
    assert.deepEqual(second.tokens.totals, first.tokens.totals, 'totals 必须稳定')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t100-3: 缺省 teamId 回落到默认团队', () => {
  const { host, root } = setup()
  try {
    const result: any = host.executeLeadTool('myteam_get_tokens', {}, {})
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(typeof result.teamId, 'string')
    assert.ok(result.teamId.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
