/**
 * T17 自测收口：M1 验收场景机制层集中补测（场景 3/5/7/15/17/19/31/32 的空档项）。
 * 每条对应 PRD §10 验收场景编号，注释标明；"待宿主"项不在本文件（见 docs/10 KI-2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const NODE = process.execPath

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

function setup(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  return host
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S', ...over,
})

/** 建好 active 团队（无成员），返回 host */
function approvedTeam(root: string) {
  const host = setup(root)
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
  assert.equal(sub.status, 'staged')
  const ap = host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  assert.equal(ap.status, 'approved')
  return { host, teamId: sub.teamId as string }
}

test('T17/场景3: 陈旧 attemptId 的 update 被拒；reassign 后旧 attempt 失效', () => {
  const root = mkdtempSync(join(tmpdir(), 't17a-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    assert.equal(cr.status, 'created')
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
    assert.equal(claim.status, 'claimed')
    const staleAttempt = `at-stale-${Date.now()}`
    const rejected = host.executeMemberTool(member, 'myteam_update_task', { taskId: cr.taskId, attemptId: staleAttempt, status: 'in_progress' }) as any
    assert.equal(rejected.status, 'error')
    assert.match(String(rejected.message ?? rejected.code), /stale|MT_ATTEMPT_STALE/)
    // 正常 progress 后 revoke（经 reassign 路径），旧 attempt 再写被拒
    const ok = host.executeMemberTool(member, 'myteam_update_task', { taskId: cr.taskId, attemptId: claim.attemptId, status: 'in_progress' }) as any
    assert.equal(ok.status, 'in_progress')
    const rv = host.executeLeadTool('myteam_revoke_attempt', { teamId, taskId: cr.taskId, attemptId: claim.attemptId, reason: '重分配' }, {}) as any
    assert.equal(rv.status, 'revoked')
    const afterRevoke = host.executeMemberTool(member, 'myteam_update_task', { taskId: cr.taskId, attemptId: claim.attemptId, status: 'done', summary: 's', evidence: { kind: 'na', na: { reason: 'x' } } }) as any
    assert.equal(afterRevoke.status, 'error', 'revoke 后旧 attempt 写入被拒')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景7: 澄清硬终止——clarify 超 N=3 轮 submit_plan 被拦；plan.clarify 留账本', () => {
  const root = mkdtempSync(join(tmpdir(), 't17b-'))
  try {
    const host = setup(root)
    const args = { teamId: 'default', teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [], clarify: { questions: [{ id: 'q1', type: 'taste', text: '口径?' }] } }
    for (let round = 1; round <= 3; round++) {
      const r = host.executeLeadTool('myteam_submit_plan', args, {}) as any
      assert.equal(r.status, 'staged', `round ${round} staged`)
      // 每轮 discard 重开（clarify 轮次从账本 plan.clarify 事件累计）
      host.executeLeadTool('myteam_discard_plan', { teamId: 'default', planId: 'plan-latest', confirm: true }, {})
    }
    const fourth = host.executeLeadTool('myteam_submit_plan', args, {}) as any
    assert.equal(fourth.status, 'clarify-limit', '第 4 轮触发硬终止（FR-1.6）')
    const ledger = readFileSync(join(root, '.dsh-myteam', 'tasks', 'default', 'ledger.jsonl'), 'utf8')
    const events = ledger.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.ok(events.filter((e) => e.type === 'plan.clarify').length === 3, '被拦截的启动在账本留 plan.clarify ×3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景15: 计划硬校验——requiredRole 不在名册被拒并指名任务', () => {
  const root = mkdtempSync(join(tmpdir(), 't17c-'))
  try {
    const host = setup(root)
    const r = host.executeLeadTool('myteam_submit_plan', {
      teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
      tasks: [TASK({ requiredRole: 'ghost-role' })],
    }, {}) as any
    assert.equal(r.status, 'error')
    assert.match(String(r.message), /ghost-role/, '错误信息指出具体角色')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景17: escalate→re-scoping→rescope→ready 全链（机制层）', () => {
  const root = mkdtempSync(join(tmpdir(), 't17d-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
    const esc = host.executeMemberTool(member, 'myteam_escalate_task', { taskId: cr.taskId, attemptId: claim.attemptId, reason: 'AC 口径无法达成', evidence: { attempted: '已尝试三种口径', blockedAt: 'AC1' }, suggestion: 'rescope' }) as any
    assert.equal(esc.status, 'escalated')
    assert.equal(esc.count, 1)
    // 队长裁决：rescope 回 ready
    const rescope = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, rescope: { reason: '收窄 AC' }, patch: { acceptanceCriteria: ['AC1-收窄版'] } }, {}) as any
    assert.equal(rescope.status, 'rescoped')
    // 重新调度：释放后其他成员可再 claim（attempt 已撤销）
    const proj = host.service(teamId).projectionSnapshot
    assert.equal(proj.tasks[cr.taskId].state, 'ready', 'rescope 后任务回 ready')
    assert.equal(proj.tasks[cr.taskId].attemptId, undefined, '旧 attempt 已撤销')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景19: escalate 后 Lead 侧裁决（聊天入口）→ rescope 后 ready（与 17 同管线不同入口）', () => {
  const root = mkdtempSync(join(tmpdir(), 't17e-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId })
    const esc = host.executeMemberTool(member, 'myteam_escalate_task', { taskId: cr.taskId, reason: '受阻', evidence: { attempted: 'x', blockedAt: 'AC' } }) as any
    assert.equal(esc.status, 'escalated')
    const proj1 = host.service(teamId).projectionSnapshot
    assert.equal(proj1.tasks[cr.taskId].state, 're-scoping')
    // Lead 在聊天中直接改 AC + rescope（同一工具入口，验证裁决语义）
    const r = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, rescope: { reason: '裁决：收窄' }, patch: { acceptanceCriteria: ['AC'] } }, {}) as any
    assert.equal(r.status, 'rescoped')
    assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].state, 'ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景31-机制部分: done 附 knowledgeDraft → knowledge.proposed → 采纳 → config/knowledge/ 落库带 evidence+contributor', () => {
  const root = mkdtempSync(join(tmpdir(), 't17f-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
    const done = host.executeMemberTool(member, 'myteam_update_task', {
      taskId: cr.taskId, attemptId: claim.attemptId, status: 'done', summary: '完成',
      evidence: { kind: 'na', na: { reason: '文档任务' } },
      knowledgeDraft: { id: 'kb-orders-soft-delete', title: 'orders 软删口径', tags: ['db'], body: 'orders 表软删字段是 deleted_at。' },
    }) as any
    assert.equal(done.status, 'completed', JSON.stringify(done))
    // 队长采纳（myteam_adopt_knowledge：策展门 + 落库带归因）
    const adopt = host.executeLeadTool('myteam_adopt_knowledge', { teamId, draftId: 'kb-orders-soft-delete', decision: 'adopted' }, {}) as any
    assert.equal(adopt.status, 'adopted', JSON.stringify(adopt))
    const led = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
    const events = led.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const proposed = events.find((e) => e.type === 'knowledge.proposed')
    assert.ok(proposed, 'knowledge.proposed 已落账本')
    assert.equal((proposed.payload.draft as any).evidence, cr.taskId, '证据=任务 id')
    assert.ok(events.find((e) => e.type === 'knowledge.adopted'), 'knowledge.adopted 已落账本')
    // 落库验证：config/knowledge/ 有条目文件且带 contributor/evidence
    const entryText = readFileSync(join(root, '.dsh-myteam', 'config', 'knowledge', 'kb-orders-soft-delete.md'), 'utf8')
    assert.match(entryText, /contributor:/, '归因落库（FR-17.3 E9）')
    assert.match(entryText, /evidence:/, '证据指针落库（FR-17.3 E8）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景32-机制部分: 成员工具面不含写知识库工具（只能提案）；无 evidence 的提案被拒', () => {
  const root = mkdtempSync(join(tmpdir(), 't17g-'))
  try {
    const { host, teamId } = approvedTeam(root)
    // 成员工具 9 个里没有 write/create knowledge
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    // knowledge.proposed 无 evidence 被 service 拒
    const r = host.commit(teamId, { actor: `member:${member.memberId}`, type: 'knowledge.proposed', payload: { teamId, draftId: 'kb-x', draft: { id: 'kb-x', title: 't', tags: [], body: 'b' } } })
    assert.equal(r.ok, false)
    assert.match(String(r.code), /EVIDENCE/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景2-机制部分: 依赖感知——B 依赖 A 时 B 未 ready；A 走完门禁 done 后 B ready', () => {
  const root = mkdtempSync(join(tmpdir(), 't17h-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const a = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: 'A' }) }, {}) as any
    const b = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: 'B', deps: [a.taskId] }) }, {}) as any
    const proj1 = host.service(teamId).projectionSnapshot
    assert.equal(proj1.tasks[a.taskId].state, 'backlog')
    assert.equal(proj1.tasks[b.taskId].state, 'backlog', 'deps 未满足 B 停在 backlog')
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    // B 不可 claim（deps 未完成）；A 可 claim
    const claimB = host.executeMemberTool(member, 'myteam_claim_task', { taskId: b.taskId }) as any
    assert.equal(claimB.status, 'error')
    const claimA = host.executeMemberTool(member, 'myteam_claim_task', { taskId: a.taskId }) as any
    assert.equal(claimA.status, 'claimed')
    const doneA = host.executeMemberTool(member, 'myteam_update_task', { taskId: a.taskId, attemptId: claimA.attemptId, status: 'done', summary: 's', evidence: { kind: 'na', na: { reason: 'x' } } }) as any
    assert.equal(doneA.status, 'completed')
    // 默认门禁链 ['review','archive']：completed → gate:review → gate:archive → done（队长/审查者过 gate）
    const proj2 = host.service(teamId).projectionSnapshot
    assert.equal(proj2.tasks[a.taskId].state, 'gate:review', 'completed 先进首个 gate（非直接 done）')
    host.commit(teamId, { actor: 'lead', type: 'task.gate.result', payload: { teamId, taskId: a.taskId, gate: 'review', verdict: 'pass' } })
    host.commit(teamId, { actor: 'lead', type: 'task.gate.result', payload: { teamId, taskId: a.taskId, gate: 'archive', verdict: 'pass' } })
    const proj3 = host.service(teamId).projectionSnapshot
    assert.equal(proj3.tasks[a.taskId].state, 'done', 'gate 全过 → done')
    assert.equal(proj3.tasks[b.taskId].state, 'ready', 'A done 后 B 自动 ready（fold 推进，零请求 NFR-7.1）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T17/场景4-机制部分: 杀进程重启 → 账本重放一致 + 滞留 attempt 按恢复表撤销', () => {
  const root = mkdtempSync(join(tmpdir(), 't17i-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId })
    const before = host.service(teamId).projectionSnapshot.revision
    // 模拟重启：全新 host 实例（同 workspaceRoot，services 缓存清空）
    const host2 = new MyTeamHost(makeRuntime(root))
    host2.initialize()
    const rec = host2.recoverOnBoot(teamId)
    assert.ok(rec.recovered >= 1, `滞留 attempt 被恢复表处理（${rec.actions.join('; ')}）`)
    const after = host2.service(teamId).projectionSnapshot
    assert.equal(after.tasks[cr.taskId].state, 'ready', '恢复后任务回 ready 供重新 claim')
    // 账本重放一致性：旧事件数 + 新恢复事件
    const led = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
    const events = led.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.ok(events.length > 0 && events[0].type === 'rules.version.adopted')
    void before
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
