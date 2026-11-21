/**
 * T168 · CHG-210 批 6.5：**私讯的收件人必须存在**。
 *
 * 缺陷现场：`peerMessage` 不校验收件人——发给一个不存在的 id（包括 `'lead'`），
 * 账本照落 `message.sent`，`agentOf(handle)` 拿到 undefined → followup 静默跳过。
 * 于是**发送方以为送达了**，收件人那边什么都没有。这是最难查的一类失败：
 * 账本上说有，人却说没收到。
 *
 * 本文件钉三件事：
 *   ① 收件人不存在 → 拒绝，且**账本零改动**；
 *   ② 发给队长 → 拒绝，并把正确出口写进错误（`myteam_escalate_task`）；
 *   ③ 发给真实成员 → 正常落账（修法不能把正常路径一起拦掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [],
  }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  const a = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'a' }, {}) as any
  const b = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer', instanceName: 'b' }, {}) as any
  const as = (m: any) => ({ memberId: String(m.memberId), roleId: String(m.roleId), instanceName: String(m.instanceName ?? m.memberId), sessionId: String(m.sessionId), teamId })
  return { host, teamId, a: as(a), b: as(b) }
}

const messageCount = (host: MyTeamHost, teamId: string) =>
  Object.values(host.service(teamId).projectionSnapshot.perTaskMessages).flat().length

test('t168-1: 收件人不存在 → 拒绝，且账本零改动', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t168-ghost-'))
  try {
    const { host, teamId, a } = setup(root)
    const before = messageCount(host, teamId)
    const r = host.executeMemberTool(a, 'myteam_peer_message', { toMemberId: 'm-ghost', content: '在吗' }) as any
    assert.equal(r.status, 'error', JSON.stringify(r))
    assert.equal(r.code, 'MT_VALIDATION')
    assert.match(String(r.message), /没有发送/, '要明确「什么都没发」')
    assert.equal(messageCount(host, teamId), before, '被拒的消息不得落账')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t168-2: 发给队长 → 拒绝，并把正确出口写进错误', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t168-lead-'))
  try {
    const { host, teamId, a } = setup(root)
    const before = messageCount(host, teamId)
    const r = host.executeMemberTool(a, 'myteam_peer_message', { toMemberId: 'lead', content: '汇报一下' }) as any
    assert.equal(r.status, 'error')
    assert.match(String(r.message), /escalate_task/, '要指向真正能上报的那个工具')
    assert.match(String(r.message), /inbox/, '也要给出「发给人类」的出口')
    assert.equal(messageCount(host, teamId), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t168-3: 发给真实成员 → 正常落账（修法不能拦掉正常路径）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t168-ok-'))
  try {
    const { host, teamId, a, b } = setup(root)
    const r = host.executeMemberTool(a, 'myteam_peer_message', { toMemberId: b.memberId, content: '帮我看下这段实现' }) as any
    assert.equal(r.status, 'sent', JSON.stringify(r))
    /* 不带 taskId 的私讯不进 perTaskMessages（那是按任务分组的），要看账本本体 */
    const events = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    const sent = events.find((e) => e.type === 'message.sent' && e.payload?.to === b.memberId)
    assert.ok(sent, '消息必须真的落进账本')
    assert.equal(sent.payload.from, a.memberId)
    assert.equal(sent.payload.content, '帮我看下这段实现')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t168-4: 空收件人 → 拒绝（不是「发给自己」）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t168-empty-'))
  try {
    const { host, teamId, a } = setup(root)
    const r = host.executeMemberTool(a, 'myteam_peer_message', { content: '没写发给谁' }) as any
    assert.equal(r.status, 'error')
    assert.match(String(r.message), /toMemberId/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})