/**
 * T108 · CHG-138（docs/19 §3 / CHG-137）：**工具权限档位运行时门禁**。
 *
 * 为什么必须有：CHG-137 只做了「档位元数据 + 纯函数 `canCall`」——没有接到真实分发。
 * 元数据不接线 = 纸面规则：成员照样能调到 C 档工具。
 *
 * 断言：
 *  ① **成员通道硬拦**：C 档工具 → `MT_UNAVAILABLE`；A 档工具 → 正常进入（不误伤）；
 *  ② **lead 通道默认不拦**（H 档由 lead 代言人审，硬拦会断审批流）；
 *  ③ **lead 通道显式开启 `enforceTier`**：H 档 → `MT_UNAVAILABLE`；C 档 → 放行；
 *  ④ 未登记工具**不改原有行为**（走 switch 默认分支，不是被门禁吃掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { TOOL_TIERS, toolsByTier } from '../src/core/tools/tool-tiers.ts'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t108-'))
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

const member = (teamId: string) => ({ teamId, memberId: 'm-1', roleId: 'developer', instanceName: 'dev-1' })

test('t108-1: 成员通道硬拦 —— C 档不可调，A 档照常', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T108', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    /* C 档：成员不可调 */
    const forbidden = (host as any).executeMemberTool(member(teamId), 'myteam_create_task', { title: 'x' })
    assert.equal(forbidden.status, 'error', JSON.stringify(forbidden))
    assert.equal(forbidden.code, 'MT_UNAVAILABLE')
    assert.ok(String(forbidden.message).includes('仅队长'), forbidden.message)
    /* A 档：成员可调（不误伤） */
    const allowed = (host as any).executeMemberTool(member(teamId), 'myteam_list_tasks', {})
    assert.notEqual(allowed.code, 'MT_UNAVAILABLE', JSON.stringify(allowed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t108-2: 成员侧 9 个工具全部是 A 档（不会自锁）', () => {
  const aTier = new Set(toolsByTier().A)
  for (const name of ['myteam_get_task', 'myteam_list_tasks', 'myteam_claim_task', 'myteam_update_task', 'myteam_peer_message', 'myteam_wait_for_change', 'myteam_propose_task_change', 'myteam_escalate_task', 'myteam_read_knowledge']) {
    assert.equal(TOOL_TIERS[name], 'A', `${name} 必须是 A 档（否则成员自锁）`)
    assert.equal(aTier.has(name), true)
  }
})

test('t108-3: lead 通道 —— 默认放行 H，开启 enforceTier 后拦下', async () => {
  const { host, root } = setup()
  try {
    /* 默认：H 档由 lead 代言（不拦）——用 publish_role 验证（它会走到业务校验，而不是门禁） */
    const byDefault: any = await host.executeLeadTool('myteam_publish_role', { roleId: 'no-such-role' }, {})
    assert.notEqual(byDefault.code, 'MT_UNAVAILABLE', '默认不得被门禁拦（否则断审批流）')
    /* 开启 enforceTier：H 档拦下 */
    const enforced: any = await host.executeLeadTool('myteam_publish_role', { roleId: 'x' }, { enforceTier: true })
    assert.equal(enforced.status, 'error')
    assert.equal(enforced.code, 'MT_UNAVAILABLE')
    /* C 档在 enforceTier 下仍放行 */
    const cTier: any = await host.executeLeadTool('myteam_list_roles', {}, { enforceTier: true })
    assert.equal(cTier.status, 'ok', JSON.stringify(cTier))
    /* human 可调 H 档 */
    const human: any = await host.executeLeadTool('myteam_publish_role', { roleId: 'no-such-role' }, { actor: 'human', enforceTier: true })
    assert.notEqual(human.code, 'MT_UNAVAILABLE', 'human 应可调 H 档')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t108-4: 未登记工具 —— 门禁不吃掉原有分支', async () => {
  const { host, root } = setup()
  try {
    const unknown: any = await host.executeLeadTool('myteam_not_a_real_tool', {}, { enforceTier: true })
    assert.equal(unknown.status, 'error')
    assert.equal(unknown.code, 'MT_UNKNOWN_TOOL', JSON.stringify(unknown))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
