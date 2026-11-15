/**
 * T144 · CHG-200（用户定案）：**队长读面 + 成员检查面**。
 *
 * 背景（两句话）：
 *  ① 「它没有最基本的读取工具，这甚至是不允许接受的呀！」——修复前 55 个 Lead 工具里，
 *     队长能建任务 / 改任务 / 裁决任务，却**读不到任务**：没有任何工具能回答「这个任务
 *     现在什么状态、证据是什么、交付物在哪」。成员侧有 `get_task` / `list_tasks` /
 *     `read_knowledge`，但它们只注册在成员作用域（两个作用域零重名，CHG-86 口径）。
 *  ② 「任务检查应该由成员自己完成，队长只需要检查任务成果」——修复前 review/verify 门
 *     只有队长工具（C 档）能提交，审查者由队长在参数里点名；成员本人没有任何入口。
 *
 * 断言：
 *  ① 三表一致：3 个队长读工具 + 1 个成员检查工具都进 defs / 档位表 / 输出契约；
 *  ② `myteam_read_task`：完整视图（证据 / 交付物 / 门禁）**且不含 attemptId**；
 *     证据/时间线按最新截断并如实报 `omitted`（限界读 NFR-7.6）；
 *  ③ **只读**：读工具调用前后账本行数一致（不得借读落事件）；
 *  ④ `myteam_read_board`：计数 + 过滤 + 限界；返回行数 ≠ 已读全部内容；
 *  ⑤ `myteam_read_knowledge_entry`：读到条目；不存在 → `MT_KB_NOT_FOUND`；
 *  ⑥ `myteam_submit_review`（成员）：**审查者 = 调用者**；实现者审自己 → `MT_CROSS_REVIEW`；
 *     非 gate 状态 → `MT_VALIDATION`；另一名成员裁决 → `gate-pass` 且账本记的是**成员本人**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { TOOL_TIERS, toolsByTier } from '../src/core/tools/tool-tiers.ts'
import { describeContract } from '../src/core/tools/output-contract.ts'
import { leadToolDefs, memberToolDefs } from '../src/tools/defs.ts'
import { knowledgeDirOf, writeKnowledgeEntry } from '../src/core/knowledge/knowledge.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  return host
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'], ...over,
})

function approvedTeam(root: string) {
  const host = setup(root)
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }, { roleId: 'reviewer' }], tasks: [] }, {}) as any
  assert.equal(sub.status, 'staged')
  const ap = host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  assert.equal(ap.status, 'approved')
  return { host, teamId: sub.teamId as string }
}

function ledgerLines(root: string, teamId: string): number {
  const path = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0
}

/** 走完「认领 → 申报 done（带证据）」，任务进入 gate:review */
function doneTask(host: MyTeamHost, teamId: string, taskId: string) {
  const spawn = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
  const member = { memberId: spawn.memberId, roleId: 'implementer', instanceName: spawn.memberId, sessionId: spawn.sessionId, teamId }
  const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId }) as any
  host.executeMemberTool(member, 'myteam_update_task', { taskId, attemptId: claim.attemptId, status: 'in_progress', progress: '跑着' })
  host.executeMemberTool(member, 'myteam_update_task', {
    taskId, attemptId: claim.attemptId, status: 'done', summary: 's',
    evidence: { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 3 }] },
  })
  return member
}

test('t144-1: 三表一致 —— 队长读面 3 个 + 成员检查面 1 个都进 defs / 档位 / 契约', () => {
  const lead = leadToolDefs().map((def) => def.name)
  const member = memberToolDefs().map((def) => def.name)
  for (const name of ['myteam_read_task', 'myteam_read_board', 'myteam_read_knowledge_entry']) {
    assert.ok(lead.includes(name), `leadToolDefs 缺 ${name}`)
    assert.equal(TOOL_TIERS[name], 'A', `${name} 必须是 A 档（只读能力，全员可用）`)
    assert.ok(toolsByTier().A.includes(name))
    assert.ok(describeContract().some((entry) => entry.name === name), `输出契约缺 ${name}`)
  }
  assert.ok(member.includes('myteam_submit_review'), 'memberToolDefs 缺 myteam_submit_review')
  assert.equal(TOOL_TIERS['myteam_submit_review'], 'A', '成员检查是份内事（A 档），越权边界由交叉审查硬校验')
  assert.ok(describeContract().some((entry) => entry.name === 'myteam_submit_review'))
  // 两个作用域零重名（CHG-86 的教训：同名跨层注册时宿主按解析顺序取其一）
  assert.deepEqual(lead.filter((name) => member.includes(name)), [])
})

test('t144-2: read_task —— 完整视图（证据/交付物/门禁），且不含 attemptId', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t144-read-task-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: '读面任务' }) }, {}) as any
    doneTask(host, teamId, created.taskId)
    const read = host.executeLeadTool('myteam_read_task', { teamId, taskId: created.taskId }, {}) as any
    assert.equal(read.status, 'ok', JSON.stringify(read))
    assert.equal(read.task.id, created.taskId)
    assert.equal(read.task.input.title, '读面任务')
    assert.equal(read.task.state, 'gate:review')
    assert.deepEqual(read.task.gates, ['review'])
    assert.equal(read.task.evidenceRefs.length, 1, '证据块必须读得到（检查任务成果的输入）')
    assert.equal('attemptId' in read.task, false, '队长读面不得返回 attemptId（写凭据只发给当前持有人）')
    assert.equal('attemptId' in read.task.evidenceRefs[0], true, '证据按 attempt 分组字段保留（不是写凭据，是留痕）')
    assert.deepEqual(read.omitted, { evidence: 0, timeline: 0, messages: 0 })
    // 限界读：证据上限 0 → 不返回证据，但如实报 omitted（不能静默丢）
    const trimmed = host.executeLeadTool('myteam_read_task', { teamId, taskId: created.taskId, evidenceLimit: 0, timelineLimit: 0 }, {}) as any
    assert.deepEqual(trimmed.task.evidenceRefs, [])
    assert.equal(trimmed.omitted.evidence, 1)
    assert.ok(trimmed.note.includes('omitted'))
    // 不存在 → 明确报错（不返回空对象假装成功）
    const missing = host.executeLeadTool('myteam_read_task', { teamId, taskId: 'no-such-task' }, {}) as any
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_VALIDATION')
    const noId = host.executeLeadTool('myteam_read_task', { teamId }, {}) as any
    assert.equal(noId.code, 'MT_VALIDATION')
    assert.equal(noId.field, 'taskId')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t144-2b: read_task 必须 lossless JSON —— 未认领任务不得返回 undefined 字段（CHG-204 P0 回归）', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t144-lossless-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: '未认领' }) }, {}) as any
    const read = host.executeLeadTool('myteam_read_task', { teamId, taskId: created.taskId }, {}) as any
    assert.equal(read.status, 'ok', JSON.stringify(read))
    /* 宿主工具输出校验要求 lossless JSON：own key 的值可以是 null，但**不能是 undefined**。
     * 修复前 `attemptId` / `assignee` / `waitingSince` 无条件写成 undefined，
     * 任何「未认领 / 无 attempt」的任务都会让 myteam_read_task 整体报错。 */
    const assertLossless = (value: unknown, path = '$'): void => {
      assert.notEqual(value, undefined, `${path} 不得是 undefined`)
      if (Array.isArray(value)) return value.forEach((item, index) => assertLossless(item, `${path}[${index}]`))
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) assertLossless(child, `${path}.${key}`)
      }
    }
    assertLossless(read)
    assert.equal('attemptId' in read.task, false)
    assert.equal('assignee' in read.task, false)
    assert.equal('waitingSince' in read.task, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t144-3: 队长读面只读 —— 调用前后账本行数一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t144-readonly-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    const before = ledgerLines(root, teamId)
    host.executeLeadTool('myteam_read_task', { teamId, taskId: created.taskId }, {})
    host.executeLeadTool('myteam_read_board', { teamId }, {})
    const after = ledgerLines(root, teamId)
    assert.equal(after, before, '只读工具不得写账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t144-4: read_board —— 计数 + 过滤 + 限界（返回行数 ≠ 已读全部内容）', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t144-board-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const a = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: 'A', priority: 'P0' }) }, {}) as any
    host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: 'B', priority: 'P1' }) }, {}) as any
    host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: 'C', requiredRole: 'reviewer' }) }, {}) as any
    const board = host.executeLeadTool('myteam_read_board', { teamId }, {}) as any
    assert.equal(board.status, 'ok', JSON.stringify(board))
    assert.equal(board.counts.total, 3)
    assert.equal(board.counts.open, 3)
    assert.equal(board.counts.done, 0)
    assert.equal(board.tasks.length, 3)
    assert.ok(board.tasks.some((row: any) => row.id === a.taskId && row.priority === 'P0'))
    // 过滤：角色 / 状态 / 限界
    const byRole = host.executeLeadTool('myteam_read_board', { teamId, requiredRole: 'reviewer' }, {}) as any
    assert.equal(byRole.tasks.length, 1)
    const byState = host.executeLeadTool('myteam_read_board', { teamId, state: 'done' }, {}) as any
    assert.equal(byState.tasks.length, 0)
    const limited = host.executeLeadTool('myteam_read_board', { teamId, limit: 1 }, {}) as any
    assert.equal(limited.tasks.length, 1)
    assert.equal(limited.returnedCount, 1)
    assert.ok(limited.note.includes('≠ 已读全部内容'), '限界读必须明示行数口径（NFR-7.6）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t144-5: read_knowledge_entry —— 条目全文；不存在 → MT_KB_NOT_FOUND', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t144-kb-'))
  try {
    const { host } = approvedTeam(root)
    writeKnowledgeEntry(knowledgeDirOf(root), {
      id: 'kb-1', title: '口径', tags: ['口径'], audience: [], evidence: ['task:t1'],
      updated: '2026-11-14', unverified: false, core: true, proofCount: 1, body: '正文内容',
    })
    const read = host.executeLeadTool('myteam_read_knowledge_entry', { id: 'kb-1' }, {}) as any
    assert.equal(read.status, 'ok', JSON.stringify(read))
    assert.equal(read.entry.id, 'kb-1')
    assert.equal(String(read.entry.body).trim(), '正文内容')
    const missing = host.executeLeadTool('myteam_read_knowledge_entry', { id: 'no-such-entry' }, {}) as any
    assert.equal(missing.status, 'error')
    assert.equal(missing.code, 'MT_KB_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t144-6: 成员检查面 —— 审查者 = 调用者；不能审自己实现的任务', () => {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t144-review-'))
  try {
    const { host, teamId } = approvedTeam(root)
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    const implementer = doneTask(host, teamId, created.taskId)
    // ① 实现者不能审自己（强制交叉审查 FR-5.1）
    const selfReview = host.executeMemberTool(implementer, 'myteam_submit_review', { teamId, taskId: created.taskId, verdict: 'pass' }) as any
    assert.equal(selfReview.status, 'error', JSON.stringify(selfReview))
    assert.equal(selfReview.code, 'MT_CROSS_REVIEW')
    // ② 另一名成员可以审；账本记的是**成员本人**（不是队长代填）
    const spawned = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'reviewer' }, {}) as any
    const reviewer = { memberId: spawned.memberId, roleId: 'reviewer', instanceName: spawned.memberId, sessionId: spawned.sessionId, teamId }
    const pass = host.executeMemberTool(reviewer, 'myteam_submit_review', { teamId, taskId: created.taskId, verdict: 'pass' }) as any
    assert.equal(pass.status, 'gate-pass', JSON.stringify(pass))
    assert.equal(pass.gate, 'review')
    const events = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const gate = events.filter((event: any) => event.type === 'task.gate.result').pop()
    assert.ok(gate, '必须落 task.gate.result 事件')
    assert.equal(gate.payload.reviewerMemberId, reviewer.memberId, '审查者必须是成员本人')
    // ③ 非 gate 状态 → MT_VALIDATION（门禁裁决只对 gate:* 任务有效）
    const other = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: '未申报' }) }, {}) as any
    const notGate = host.executeMemberTool(reviewer, 'myteam_submit_review', { teamId, taskId: other.taskId, verdict: 'pass' }) as any
    assert.equal(notGate.status, 'error')
    assert.equal(notGate.code, 'MT_VALIDATION')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
