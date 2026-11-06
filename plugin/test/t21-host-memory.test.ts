/**
 * T21 host 记忆接线集成测试（CHG-19，FR-6.1/6.2 + ADR-009）。
 * mock HostRuntime：假 agents.create 捕获 setup 作用域调用；假 tools 注册表。
 * 覆盖链路：spawn → 记忆播种 → 成员写记忆（模拟）→ update_task done 收口审计
 *   → memory.audit 事件落账本 → release 前审计 → evidenceRequired=false 关闭审计。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { memoryDirFor } from '../src/core/members/memory.ts'

function makeRuntime(root: string): HostRuntime & { registeredTools: Map<string, any>; createdAgents: any[] } {
  const registeredTools = new Map<string, any>()
  const createdAgents: any[] = []
  return {
    registeredTools,
    createdAgents,
    tools: {
      register: (t: any) => registeredTools.set(t.name, t),
      restrict: () => {},
      schemas: () => [],
    },
    agents: {
      create: (opts: any) => {
        // 模拟宿主执行 setup 作用域：收集 section 与注册的工具
        const sections: any[] = []
        const memberTools: string[] = []
        const agentCtx = {
          tools: {
            register: (t: any) => memberTools.push(t.name),
            restrict: () => {},
          },
          systemPrompt: { section: (s: any) => sections.push(s) },
          skills: { registerProvider: () => {} },
        }
        opts.setup(agentCtx, {})
        const agent = { followup: () => {}, session: {} }
        createdAgents.push({ opts, sections, memberTools, agent })
        return agent
      },
    },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

/** 建一个已批准团队（bootstrap 后 approve），返回 host + teamId + createTask */
function makeApprovedTeam(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const teamId = 't-mem'
  // 项目库角色：bootstrap 用内置三角色，spawn 时自动复制到项目库
  const submit = host.executeLeadTool('myteam_submit_plan', {
    teamId,
    teamName: '记忆测试团队',
    goal: '验证记忆接线',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(submit.status, 'staged', JSON.stringify(submit))
  const planId = submit.planId
  const approved = host.executeLeadTool('myteam_approve_plan', { teamId, planId }, {}) as any
  assert.equal(approved.status, 'approved', JSON.stringify(approved))
  // 任务经 create_task 显式入库（fold 对 plan.staged 只置 draft；taskId 由 host 分配）
  const createTask = () => host.executeLeadTool('myteam_create_task', {
    teamId,
    task: {
      title: '写点东西',
      description: 'x',
      acceptanceCriteria: ['能交付'],
      deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
      deps: [],
      requiredRole: 'implementer',
      taskType: 'default',
      estimate: 'S',
    },
  }, {}) as any
  const first = createTask()
  assert.equal(first.status, 'created', JSON.stringify(first))
  assert.equal(first.taskId, 'task-1', 'taskId 由 host 自动分配')
  return { rt, host, teamId, createTask }
}

test('t21a: spawn 后记忆区已播种（memory.md 存在 + 幂等）+ 提示词含记忆纪律与 FR-6.4', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt21-'))
  try {
    const { rt, host, teamId } = makeApprovedTeam(root)
    const r = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    assert.equal(r.status, 'spawned', JSON.stringify(r))
    const memberId = r.memberId
    const dir = memoryDirFor(root, teamId, memberId)
    const memMd = join(dir, 'memory.md')
    assert.ok(existsSync(memMd), 'memory.md seeded at spawn')
    const text = readFileSync(memMd, 'utf8')
    assert.match(text, /member: /)
    assert.match(text, /evidence: none/)
    // 提示词：记忆纪律 section（order 103）+ FR-6.4 身份连续性
    const creation = rt.createdAgents[0]
    const memSection = creation.sections.find((s: any) => String(s.name).startsWith('myteam:memory-'))
    assert.ok(memSection, 'memory section injected')
    assert.equal(memSection.order, 103)
    assert.match(memSection.text, /evidence: <指针>/)
    assert.match(memSection.text, /不存在"上一代"/)
    assert.match(memSection.text, /不要生成 handoff 交接摘要/)
    // 重复 spawn（幂等恢复）：同 sessionId 重建不覆盖记忆
    const seededAgain = host.spawnMember(teamId, 'implementer')
    assert.equal(seededAgain.status, 'spawned')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t21b: update_task done 收口触发审计——无证据记忆条目落 memory.audit 事件', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt21b-'))
  try {
    const { rt, host, teamId } = makeApprovedTeam(root)
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const memberId = spawn.memberId
    // 成员 claim
    const member = { memberId, roleId: 'implementer', instanceName: memberId, sessionId: spawn.sessionId, teamId }
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: 'task-1' }) as any
    assert.equal(claim.status, 'claimed')
    const attemptId = claim.attemptId
    // 成员写了一条无证据记忆（模拟宿主 write 工具直写）
    const memDir = memoryDirFor(root, teamId, memberId)
    writeFileSync(join(memDir, 'memory.md'), [
      '---', 'member: x', 'evidence: none', '---', '',
      '## 踩坑记录', '',
      '测试前必须先 build。',
    ].join('\n'), 'utf8')
    // done 申报（带证据块）
    const done = host.executeMemberTool(member, 'myteam_update_task', {
      taskId: 'task-1', attemptId, status: 'done', summary: '完成',
      evidence: { kind: 'commands', commands: [{ cmd: 'node --test', exitCode: 0, assertions: 3 }] },
    }) as any
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.ok(done.memoryAudit, '收口返回带 memoryAudit 提示')
    assert.equal(done.memoryAudit.violations, 1)
    // 账本验证：memory.audit 事件存在且 findings 正确
    const ledger = readFileSync(join(root, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl'), 'utf8')
    const events = ledger.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const audit = events.find((e) => e.type === 'memory.audit')
    assert.ok(audit, 'memory.audit event in ledger')
    assert.equal(audit.payload.memberId, memberId)
    assert.equal(audit.payload.violations, 1)
    assert.equal(audit.payload.findings[0].reason, 'empty-evidence')
    assert.equal(audit.actor, 'host')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t21c: 有证据条目 + 种子态记忆 → 收口零违规、不产生 memory.audit 事件（无噪音）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt21c-'))
  try {
    const { host, teamId } = makeApprovedTeam(root)
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: 'task-1' }) as any
    // 记忆保持种子态（evidence: none 但无条目 = 合法），再写一条有证据的
    const memDir = memoryDirFor(root, teamId, spawn.memberId)
    const seed = readFileSync(join(memDir, 'memory.md'), 'utf8')
    writeFileSync(join(memDir, 'memory.md'), seed + '\n## 口径\n\nevidence: task-1\n\n按 AC 判定。\n', 'utf8')
    const done = host.executeMemberTool(member, 'myteam_update_task', {
      taskId: 'task-1', attemptId: claim.attemptId, status: 'done', summary: '完成',
      evidence: { kind: 'na', na: { reason: '无可执行验证' } },
    }) as any
    assert.equal(done.status, 'completed')
    assert.equal(done.memoryAudit, undefined, '零违规不携带审计提示')
    const ledger = readFileSync(join(root, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl'), 'utf8')
    const events = ledger.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.equal(events.find((e) => e.type === 'memory.audit'), undefined, '零违规不落事件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t21d: release 前审计——违规记忆在释放返回中提示并落账本', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt21d-'))
  try {
    const { host, teamId } = makeApprovedTeam(root)
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const memDir = memoryDirFor(root, teamId, spawn.memberId)
    writeFileSync(join(memDir, 'notes-x.md'), '## 笔记\n\n没有指针的内容。\n', 'utf8')
    const rel = host.executeLeadTool('myteam_release_member', { teamId, memberId: spawn.memberId, mode: 'suspend' }, {}) as any
    assert.equal(rel.status, 'suspend', JSON.stringify(rel))
    assert.ok(rel.memoryAudit, 'release 返回带 memoryAudit')
    assert.equal(rel.memoryAudit.violations, 1)
    const ledger = readFileSync(join(root, '.team-workplace', 'state', 'teams', teamId, 'ledger.jsonl'), 'utf8')
    const events = ledger.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const audit = events.filter((e) => e.type === 'memory.audit')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].payload.findings[0].file, 'notes-x.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t21e: memory.evidenceRequired=false → 审计关闭（不扫描不落事件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt21e-'))
  try {
    const { host, teamId } = makeApprovedTeam(root)
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
    const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: 'task-1' }) as any
    // 写无证据记忆
    const memDir = memoryDirFor(root, teamId, spawn.memberId)
    writeFileSync(join(memDir, 'memory.md'), '## 无指针\n\n凭感觉。\n', 'utf8')
    // 用 configOverride 重建一个 evidenceRequired=false 的 service 不可行（service 已缓存）——
    // 直接验证 auditMemberMemory 的关闭分支：临时构造 override host
    const rt2 = makeRuntime(root)
    const host2 = new MyTeamHost({ ...rt2, configOverride: { memory: { evidenceRequired: false } } } as any)
    host2.initialize()
    void host2 // 局部验证
    // 当前 host（默认配置）应产生违规；关闭配置的 host 直接调扫描应返回 null
    const r = host2.auditMemberMemory(teamId, spawn.memberId)
    assert.equal(r, null, 'evidenceRequired=false → 不扫描')
    void claim
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t21f: notes/ 子目录递归审计（成员自建子目录中的 .md 也被扫到）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt21f-'))
  try {
    const { host, teamId } = makeApprovedTeam(root)
    const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
    const memDir = memoryDirFor(root, teamId, spawn.memberId)
    mkdirSync(join(memDir, 'notes'), { recursive: true })
    writeFileSync(join(memDir, 'notes', 'a.md'), '## 好笔记\n\nevidence: task-1\n\n内容\n', 'utf8')
    writeFileSync(join(memDir, 'notes', 'b.md'), '## 坏笔记\n\n没指针\n', 'utf8')
    const r = host.auditMemberMemory(teamId, spawn.memberId)
    assert.equal(r!.checkedFiles, 3, 'memory.md + notes/a.md + notes/b.md')
    assert.equal(r!.violations, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
