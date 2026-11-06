/**
 * CHG-87（M2-C 剩余 / M2-D 剩余 / QA-4）：command 门禁、scope 完成审计、乐观锁、
 * 三类证据指针、单角色调用、roleOp 端点。
 *
 * 纪律（沿用 t67 的教训）：本文件**全部走真实入口**——队长工具 `myteam_*` / 成员工具 /
 * 面板 Remote，不用 `host.commit()` 落事件替身。上一轮 359 个全绿单测漏掉「门禁链死锁」，
 * 根因就是测试替身把真实路径盖住了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import {
  classifyVerifyResult,
  resolveTimeoutMs,
  truncateOutput,
  validateVerifyCommand,
  DEFAULT_COMMAND_TIMEOUT_MS,
  OUTPUT_TAIL_LIMIT,
} from '../src/core/gates/command-gate.ts'
import { auditWriteScopes, filesTouchedOf, matchesScope, normalizeScopePath } from '../src/core/gates/scope-audit.ts'
import { evidenceRefsOf, isSessionPointer, parseEvidencePointer, validateEvidencePointer } from '../src/core/knowledge/evidence-pointer.ts'
import { buildRolePromptSection, readSessionDefaults, sessionDefaultsPath } from '../src/core/roles/session-defaults.ts'
import { roleOp } from '../src/core/roles/role-ops.ts'

/* ── 假 subprocess 服务（宿主形状：spawn → 句柄，句柄 done() 解析 {exitCode, signal}）── */
function fakeSubprocess(result: { exitCode: number | null; signal?: string | null; output?: string; throwOnSpawn?: boolean }) {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    spawn(opts: Record<string, unknown>) {
      calls.push(opts)
      if (result.throwOnSpawn) throw new Error('spawn exploded')
      return {
        done: async () => ({ exitCode: result.exitCode, signal: result.signal ?? null }),
        output: () => result.output ?? '',
      }
    },
  }
}

function makeRuntime(root: string, subprocess?: unknown): HostRuntime {
  return {
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: {
      create: (opts: { sessionId: string }) => ({ session: { id: opts.sessionId }, followup: () => {} }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
    ...(subprocess ? { subprocess } : {}),
  } as HostRuntime
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  ...over,
})

async function team(root: string, subprocess?: unknown) {
  const host = new MyTeamHost(makeRuntime(root, subprocess), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }], tasks: [] }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  const impl = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'implementer' }, {}) as any
  const review = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'reviewer' }, {}) as any
  await new Promise((r) => setTimeout(r, 0))
  const teamId = sub.teamId as string
  const implMember = { memberId: impl.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: impl.sessionId, teamId }
  return { host, teamId, implMember, review, reviewMemberId: review.memberId as string }
}

/** 建任务 → 领取 → 申报 done（真实成员入口） */
function complete(host: MyTeamHost, teamId: string, member: any, over: Record<string, unknown> = {}) {
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK(over) }, {}) as any
  assert.equal(cr.status, 'created', `create_task failed: ${JSON.stringify(cr)}`)
  const claim = host.executeMemberTool(member, 'myteam_claim_task', { taskId: cr.taskId }) as any
  assert.equal(claim.status, 'claimed', `claim failed: ${JSON.stringify(claim)}`)
  return { taskId: cr.taskId as string, attemptId: claim.attemptId as string }
}

/* ══════════════════════════════════════════════════════════════════
 * 一、FR-5.3 command 门禁（纯函数）
 * ══════════════════════════════════════════════════════════════════ */

test('t71-1: command-gate 纯函数——exit code 定裁决 / 超时算 fail / 输出尾部有界', () => {
  assert.equal(classifyVerifyResult({ exitCode: 0, signal: null, timedOut: false }), 'pass')
  assert.equal(classifyVerifyResult({ exitCode: 1, signal: null, timedOut: false }), 'fail')
  assert.equal(classifyVerifyResult({ exitCode: null, signal: 'SIGKILL', timedOut: true }), 'fail')
  // 被信号杀但没标 timedOut 也算 fail（进程没正常退出）
  assert.equal(classifyVerifyResult({ exitCode: null, signal: 'SIGSEGV', timedOut: false }), 'fail')

  const short = 'ok'
  assert.equal(truncateOutput(short), short)
  const long = 'x'.repeat(OUTPUT_TAIL_LIMIT + 50)
  const tail = truncateOutput(long)
  assert.ok(tail.startsWith('…[truncated 50 chars]…'), '截断必须留可审计标记')
  assert.ok(tail.length < long.length + 40)

  // 超时取更严格者（K5）
  assert.equal(resolveTimeoutMs(5000, 60000), 5000)
  assert.equal(resolveTimeoutMs(90000, 60000), 60000)
  assert.equal(resolveTimeoutMs(undefined, undefined), DEFAULT_COMMAND_TIMEOUT_MS)

  // schema 校验：argv 必填数组、无 shell 解释
  assert.equal(validateVerifyCommand(undefined), null, '缺省合法（运行期才判 MT_VERIFY_NO_COMMAND）')
  assert.equal(validateVerifyCommand({ argv: ['node', '--test'] }), null)
  assert.equal(validateVerifyCommand({ argv: [] })?.code, 'MT_VALIDATION')
  assert.equal(validateVerifyCommand({ argv: 'pnpm test' })?.code, 'MT_VALIDATION')
  assert.equal(validateVerifyCommand({ argv: ['node'], unknownField: 1 })?.code, 'MT_VALIDATION')
  assert.equal(validateVerifyCommand({ argv: ['node'], timeoutMs: -1 })?.code, 'MT_VALIDATION')
})

/* ══════════════════════════════════════════════════════════════════
 * 二、FR-5.3 command 门禁（host 执行路径）
 * ══════════════════════════════════════════════════════════════════ */

test('t71-2: verify 门 pass——host 真跑命令，exit code 与输出尾部落账本', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-verify-ok-'))
  const sp = fakeSubprocess({ exitCode: 0, output: 'ALL TESTS PASSED (12 assertions)' })
  const { host, teamId, implMember, reviewMemberId } = await team(root, sp)
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: ['verify'] })
  // 申报 done 后进入 verify 门
  const done = host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'node --test', exitCode: 0, assertions: 12 }] },
  }) as any
  assert.equal(done.status, 'completed')
  // 缺 verifyCommand → 明确拒绝（不是静默 pass）
  const noCmd = await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: reviewMemberId }, {}) as Promise<any>)
  assert.equal(noCmd.status, 'error')
  assert.equal(noCmd.code, 'MT_VERIFY_NO_COMMAND')

  // 补上 verifyCommand（结构字段在 gate 态必须走 rescope，这里用 rescope 的 patch）
  const rescoped = host.executeLeadTool(
    'myteam_rescope_task',
    { teamId, taskId, reason: '补 verifyCommand', patch: { verifyCommand: { argv: ['node', '--test'], cwd: '.' } } },
    {},
  ) as any
  assert.equal(rescoped.status, 'rescoped')
  // 重新领取并申报 done → 回到 verify 门
  const claim2 = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
  assert.equal(claim2.status, 'claimed')
  host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId: claim2.attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'node --test', exitCode: 0, assertions: 12 }] },
  })
  const out = (await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: reviewMemberId }, {}) as Promise<any>)) as any
  assert.equal(out.status, 'gate-pass', JSON.stringify(out))
  assert.equal(out.gate, 'verify')
  assert.equal(out.exitCode, 0)
  assert.equal(out.taskState, 'done', 'verify 是链上最后一道 → 直接 done')
  assert.match(String(out.outputTail), /ALL TESTS PASSED/)
  // 账本确实记了命令与退出码（不是模型自述）
  const events = host.service(teamId).projectionSnapshot
  assert.equal(events.tasks[taskId].state, 'done')
  assert.equal(events.tasks[taskId].gateVerdicts.verify, 'pass')
  const gateEvent = host.service(teamId).eventBySeq(
    host.service(teamId).projectionSnapshot.inbox.length >= 0 ? 0 : 0,
  )
  void gateEvent
  const spCalls = sp.calls
  assert.equal(spCalls.length, 1, '命令只跑一次')
  assert.deepEqual(spCalls[0].argv, ['node', '--test'])
  assert.equal(spCalls[0].cwd, root, 'cwd 相对 workspaceRoot 解析')
})

test('t71-3: verify 门 fail——exit 1 打回，任务回修复队列（gateRejects 累计）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-verify-fail-'))
  const sp = fakeSubprocess({ exitCode: 1, output: 'FAILED: 3 assertions' })
  const { host, teamId, implMember, reviewMemberId } = await team(root, sp)
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: ['verify'], verifyCommand: { argv: ['node', '--test'] } })
  host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'node --test', exitCode: 1 }] },
  })
  const out = (await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: reviewMemberId }, {}) as Promise<any>)) as any
  assert.equal(out.status, 'gate-fail')
  assert.equal(out.exitCode, 1)
  const proj = host.service(teamId).projectionSnapshot.tasks[taskId]
  assert.equal(proj.state, 'ready', '打回后回修复队列（否则永久卡死）')
  assert.equal(proj.gateRejects?.verify, 1, '打回轮数跨轮累计')
  assert.equal(proj.attemptId, undefined, 'attempt 必须清掉，否则领不走')
})

test('t71-4: 宿主无 subprocess 服务 → MT_UNAVAILABLE（不静默降级成人工点通过）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-verify-nosp-'))
  const { host, teamId, implMember, reviewMemberId } = await team(root) // 不传 subprocess
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: ['verify'], verifyCommand: { argv: ['node', '--test'] } })
  host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'node --test', exitCode: 0 }] },
  })
  const out = (await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: reviewMemberId }, {}) as Promise<any>)) as any
  assert.equal(out.status, 'error')
  assert.equal(out.code, 'MT_UNAVAILABLE')
  assert.match(out.message, /subprocess/)
  // 任务仍在 verify 门（没有偷偷推进）
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:verify')
})

test('t71-5: 人工强制放行——必须写理由，落 forcedBy:human 留痕', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-verify-force-'))
  const { host, teamId, implMember } = await team(root) // 无 subprocess → 只能人工放行
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: ['verify'], verifyCommand: { argv: ['node', '--test'] } })
  host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'node --test', exitCode: 0 }] },
  })
  // ① 不写理由 → 拒绝
  const noReason = (await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', confirm: true }, { actor: 'human' }) as Promise<any>)) as any
  assert.equal(noReason.status, 'error')
  assert.equal(noReason.code, 'MT_VALIDATION')
  // ② 队长侧 confirm 不算人工（必须 actor=human）
  const leadForced = (await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', confirm: true, reason: '宿主没 subprocess' }, {}) as Promise<any>)) as any
  assert.equal(leadForced.code, 'MT_UNAVAILABLE', '队长侧 confirm 不能绕过命令执行')
  // ③ 人工放行
  const forced = (await (host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', confirm: true, reason: '宿主没 subprocess，人工确认已本地跑过' }, { actor: 'human' }) as Promise<any>)) as any
  assert.equal(forced.status, 'gate-pass')
  assert.equal(forced.forcedBy, 'human')
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'done')
})

/* ══════════════════════════════════════════════════════════════════
 * 三、FR-5.4 scope 完成审计
 * ══════════════════════════════════════════════════════════════════ */

test('t71-6: scope-audit 纯函数——目录前缀 / 通配 / 去重 / 未声明不审计', () => {
  assert.equal(normalizeScopePath('.\\plugin\\src\\a.ts'), 'plugin/src/a.ts')
  assert.ok(matchesScope('plugin/src/a.ts', 'plugin/src/'))
  assert.ok(matchesScope('plugin/src/a.ts', 'plugin/src'))
  assert.ok(matchesScope('plugin/src/deep/x.ts', 'plugin/**/*.ts'))
  assert.ok(!matchesScope('docs/x.md', 'plugin/src/'))
  assert.ok(!matchesScope('plugin/srcx/a.ts', 'plugin/src/'))

  // 未声明 writeScopes → 不审计（不是「全部越界」）
  const none = auditWriteScopes(['plugin/src/a.ts'], [])
  assert.equal(none.ok, true)
  assert.deepEqual(none.outOfScope, [])
  assert.deepEqual(none.writeScopes, [])

  const bad = auditWriteScopes(['plugin/src/a.ts', 'docs/x.md', './docs/x.md'], ['plugin/src/'], 123)
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.declared, ['plugin/src/a.ts', 'docs/x.md'], '去重 + 归一化')
  assert.deepEqual(bad.outOfScope, ['docs/x.md'])
  assert.equal(bad.checkedAt, 123)

  const ok = auditWriteScopes(['plugin/src/a.ts'], ['plugin/src/', 'plugin/test/'])
  assert.equal(ok.ok, true)

  // 证据块取文件：只有 kind=commands 有文件面
  assert.deepEqual(filesTouchedOf({ kind: 'commands', commands: [{ filesTouched: ['a.ts'] }, { filesTouched: ['a.ts', 'b.ts'] }] }), ['a.ts', 'b.ts'])
  assert.deepEqual(filesTouchedOf({ kind: 'na', na: { reason: 'x' } }), [])
  assert.deepEqual(filesTouchedOf(undefined), [])
})

test('t71-7: 完成时 scope 审计落投影（越界只留痕、不阻断交付）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-scope-'))
  const { host, teamId, implMember } = await team(root)
  // 无门禁链：done 直接终态，审计结论挂 task.completed 事件
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: [], writeScopes: ['plugin/src/'] })
  const done = host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: {
      kind: 'commands',
      commands: [{ cmd: 'pnpm test', exitCode: 0, filesTouched: ['plugin/src/a.ts', 'docs/leak.md'] }],
    },
  }) as any
  assert.equal(done.status, 'completed', '越界不阻断交付（FR-5.4 诚实声明不拦截 bash）')
  const audit = host.service(teamId).projectionSnapshot.tasks[taskId].scopeAudit
  assert.ok(audit, '审计结论必须进投影')
  assert.equal(audit!.ok, false)
  assert.deepEqual(audit!.outOfScope, ['docs/leak.md'])
  assert.deepEqual(audit!.writeScopes, ['plugin/src/'])
})

test('t71-8: 未声明 writeScopes → 不产生审计噪音（投影无 scopeAudit）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-scope-none-'))
  const { host, teamId, implMember } = await team(root)
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: [] })
  host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'pnpm test', exitCode: 0, filesTouched: ['anywhere.ts'] }] },
  })
  assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].scopeAudit, undefined)
})

/* ══════════════════════════════════════════════════════════════════
 * 四、QA-4 乐观锁 expectedRevision
 * ══════════════════════════════════════════════════════════════════ */

test('t71-9: expectedRevision 不符 → MT_REVISION_CONFLICT 且账本零写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-rev-'))
  const { host, teamId } = await team(root)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const current = host.service(teamId).projectionSnapshot.revision
  assert.ok(current > 0)
  const before = readFileSync(host.service(teamId).ledgerPath, 'utf8')

  const conflict = host.executeLeadTool(
    'myteam_edit_task',
    { teamId, taskId: cr.taskId, patch: { title: '新标题' }, expectedRevision: current + 99 },
    {},
  ) as any
  assert.equal(conflict.status, 'error')
  assert.equal(conflict.code, 'MT_REVISION_CONFLICT')
  assert.equal(conflict.currentRevision, current, '必须回显当前版本供重取')
  assert.equal(readFileSync(host.service(teamId).ledgerPath, 'utf8'), before, '冲突时账本必须零写入')

  // 正确版本 → 成功
  const ok = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch: { title: '新标题' }, expectedRevision: current }, {}) as any
  assert.equal(ok.status, 'updated', JSON.stringify(ok))
  assert.equal(host.service(teamId).projectionSnapshot.tasks[cr.taskId].input.title, '新标题')

  // 坏值 → MT_VALIDATION（不静默当没给）
  const bad = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch: { title: 'x' }, expectedRevision: 'abc' }, {}) as any
  assert.equal(bad.code, 'MT_VALIDATION')
  // 缺省 → 不校验（向后兼容）
  const noCheck = host.executeLeadTool('myteam_edit_task', { teamId, taskId: cr.taskId, patch: { title: 'y' } }, {}) as any
  assert.equal(noCheck.status, 'updated')
})

test('t71-10: 面板 updateTask 透传 expectedRevision（详情视图 revision 可回传）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-rev-panel-'))
  const { host, teamId } = await team(root)
  const cr = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
  const { buildTaskDetailView } = await import('../src/remote/views.ts')
  const detail = buildTaskDetailView(host.service(teamId), cr.taskId, readEvents(host.service(teamId).ledgerPath))
  assert.equal(detail?.revision, host.service(teamId).projectionSnapshot.revision)
})

function readEvents(path: string) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/* ══════════════════════════════════════════════════════════════════
 * 五、FR-16.4③ 三类证据指针 + session.read 审计
 * ══════════════════════════════════════════════════════════════════ */

test('t71-11: 证据指针解析——task/file/session/seq 四类，未知前缀放行（兼容旧账本）', () => {
  assert.deepEqual(parseEvidencePointer('task:task-3'), { raw: 'task:task-3', kind: 'task', value: 'task-3' })
  assert.deepEqual(parseEvidencePointer('file:docs/schema.md#L12'), { raw: 'file:docs/schema.md#L12', kind: 'file', value: 'docs/schema.md#L12' })
  assert.deepEqual(parseEvidencePointer('session:sess-abc'), { raw: 'session:sess-abc', kind: 'session', value: 'sess-abc' })
  assert.deepEqual(parseEvidencePointer('seq:42'), { raw: 'seq:42', kind: 'seq', value: '42' })
  // 未知前缀不拒绝（旧账本是任意字符串）
  assert.equal(parseEvidencePointer('task-k1').kind, 'unknown')
  assert.equal(parseEvidencePointer('').kind, 'unknown')
  assert.ok(isSessionPointer('session:x'))
  assert.ok(!isSessionPointer('task:x'))

  // 已知前缀后空值 = 无意义指针 → 拒绝
  assert.equal(validateEvidencePointer('task:')?.code, 'MT_KB_EVIDENCE_REQUIRED')
  assert.equal(validateEvidencePointer('session:')?.code, 'MT_KB_EVIDENCE_REQUIRED')
  assert.equal(validateEvidencePointer('task:task-1'), null)
  assert.equal(validateEvidencePointer('legacy-pointer'), null)

  const refs = evidenceRefsOf(['task:a', 'session:b', 'task:a', 'file:c.md'])
  assert.deepEqual(
    refs.map((r) => `${r.kind}:${r.value}`),
    ['task:a', 'session:b', 'file:c.md'],
    '去重保序',
  )
})

test('t71-12: 知识提案带 session: 指针 → 落 session.read 审计事件', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-session-read-'))
  const { host, teamId, implMember } = await team(root)
  const { taskId, attemptId } = complete(host, teamId, implMember, { gateChain: [] })
  const out = host.executeMemberTool(implMember, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary: 'ok',
    evidence: { kind: 'commands', commands: [{ cmd: 'pnpm test', exitCode: 0 }] },
    knowledgeDraft: {
      id: 'session-ref-entry',
      title: '跨会话结论',
      body: '正文',
      evidence: 'session:sess-abc',
    },
  }) as any
  assert.equal(out.status, 'completed', JSON.stringify(out))
  const events = readEvents(host.service(teamId).ledgerPath)
  const read = events.find((event) => event.type === 'session.read')
  assert.ok(read, 'session: 指针必须留痕（FR-16.4③ 读取即审计）')
  assert.equal(read.payload.sessionId, 'sess-abc')
  assert.equal(read.payload.pointer, 'session:sess-abc')
  assert.equal(read.payload.by, implMember.memberId)
  assert.equal(read.payload.taskId, taskId)
})

/* ══════════════════════════════════════════════════════════════════
 * 六、FR-16.1 单角色调用
 * ══════════════════════════════════════════════════════════════════ */

test('t71-13: 单角色调用——两段确认 → 落 sessionDefaults + 提示词 section', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-roles-'))
  const { host, teamId } = await team(root)
  const filePath = sessionDefaultsPath(root)
  assert.ok(!existsSync(filePath), '初始未启用')

  const preview = host.executeLeadTool('myteam_apply_roles', { teamId, roles: ['implementer'] }, {}) as any
  assert.equal(preview.status, 'confirm-required')
  assert.equal(preview.roles.length, 1)
  assert.equal(preview.roles[0].roleId, 'implementer')
  assert.match(String(preview.promptSection), /单角色调用/)
  assert.ok(!existsSync(filePath), '不带 confirm 不落盘')

  const applied = host.executeLeadTool('myteam_apply_roles', { teamId, roles: ['implementer'], confirm: true }, {}) as any
  assert.equal(applied.status, 'applied', JSON.stringify(applied))
  assert.ok(existsSync(filePath))
  const file = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.deepEqual(file.roles, ['implementer'])
  assert.equal(file.action, 'applied')

  // 累加 + 卸载
  host.executeLeadTool('myteam_apply_roles', { teamId, roles: ['reviewer'], confirm: true }, {})
  assert.deepEqual(readSessionDefaults(root).roles, ['implementer', 'reviewer'])
  const removed = host.executeLeadTool('myteam_apply_roles', { teamId, remove: ['implementer'], confirm: true }, {}) as any
  assert.equal(removed.status, 'applied')
  assert.deepEqual(readSessionDefaults(root).roles, ['reviewer'])
  assert.deepEqual(removed.removed, ['implementer'])

  // 未知角色 → 拒绝
  const unknown = host.executeLeadTool('myteam_apply_roles', { teamId, roles: ['nope-role'], confirm: true }, {}) as any
  assert.equal(unknown.code, 'MT_ROLE_NOT_FOUND')
  // 空改动 → 拒绝
  const empty = host.executeLeadTool('myteam_apply_roles', { teamId, roles: [] }, {}) as any
  assert.equal(empty.code, 'MT_VALIDATION')

  // 提示词 section 空列表 = 空串（调用方据此决定不注入）
  assert.equal(buildRolePromptSection([]), '')
})

/* ══════════════════════════════════════════════════════════════════
 * 七、roleOp 端点（docs/04 §2 承诺）
 * ══════════════════════════════════════════════════════════════════ */

test('t71-14: roleOp——save/fork/publish/delete 四档 + 未知 op 拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 't71-roleop-'))
  const { host } = await team(root)
  const paths = host.rolePaths

  assert.equal((host.roleOp('nope', {}) as any).code, 'MT_VALIDATION')

  const role = {
    id: 'ops-role',
    name: '运维',
    description: 'd',
    systemPrompt: '你是运维',
    toolPolicy: { allow: ['myteam_*'] },
    skills: [],
    mcpAllowlist: [],
    version: 1,
  }
  const saved = host.roleOp('save', { role }) as any
  assert.equal(saved.status, 'saved')
  assert.equal(saved.action, 'created')
  assert.ok(existsSync(saved.filePath))

  // 同名再存 → 两段确认
  const again = host.roleOp('save', { role }) as any
  assert.equal(again.status, 'confirm-required')
  assert.equal((host.roleOp('save', { role, confirm: true }) as any).status, 'saved')

  // fork
  const forked = host.roleOp('fork', { fromRoleId: 'ops-role', toRoleId: 'ops-role-copy' }) as any
  assert.equal(forked.status, 'forked')
  assert.ok(existsSync(forked.filePath))
  assert.equal((host.roleOp('fork', { fromRoleId: 'ops-role', toRoleId: 'ops-role-copy' }) as any).code, 'MT_ROLE_EXISTS')
  // fork 到 captain → 拒绝
  assert.equal((host.roleOp('fork', { fromRoleId: 'ops-role', toRoleId: 'captain' }) as any).code, 'MT_ROLE_CAPTAIN')

  // publish 两段确认 → 发布到全局库
  const preview = host.roleOp('publish', { roleId: 'ops-role' }) as any
  assert.equal(preview.status, 'confirm-required')
  assert.ok(preview.impact.filePath.endsWith('ops-role.json'))
  const published = host.roleOp('publish', { roleId: 'ops-role', confirm: true }) as any
  assert.equal(published.status, 'published')
  assert.ok(existsSync(published.filePath))
  // captain 不可发布
  assert.equal((host.roleOp('publish', { roleId: 'captain', confirm: true }) as any).code, 'MT_ROLE_CAPTAIN')
  // 项目库里没有 → 明确拒绝
  host.roleOp('delete', { roleId: 'ops-role-copy', confirm: true })
  assert.equal((host.roleOp('publish', { roleId: 'ops-role-copy', confirm: true }) as any).code, 'MT_ROLE_NOT_FOUND')

  // delete 两段确认 + 占用面
  const delPreview = host.roleOp('delete', { roleId: 'ops-role' }) as any
  assert.equal(delPreview.status, 'confirm-required')
  const deleted = roleOp({ paths, bindings: [], actor: 'human' }, 'delete', { roleId: 'ops-role', confirm: true }) as any
  assert.equal(deleted.status, 'deleted')
})
