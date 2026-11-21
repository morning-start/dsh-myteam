/**
 * T123 · P1-5 成员护栏接线 + P2-1 `wait_agent` 的 `no-active-peer` 短路（docs/21 §6）。
 *
 * 锁五件事：
 *  ① **四类判据都能通过 `executeMemberTool` 冒出来**（CHG-147 只交付了纯函数；接线的全部价值
 *     在于「成员真的会收到提醒」）：repeat / stuck / empty-turn / env-unavailable 各一条；
 *  ② **判定不改变现有字段**：结果里只**新增** `guard: {kind,message,hint}`，`status` / `code`
 *     等老字段照旧（老代码与面板不受影响）；
 *  ③ **`blocksCompletion` 优先于「完成了」**：env-unavailable latch 后 archive 门判
 *     `needs-human`，且**不落 gate.result fail**（fail 会被 fold 放回 ready = 自动重试，
 *     而环境不可用时重试只会继续烧 token）；
 *  ④ **无活跃 peer 立即返回**：团队里只有自己时，等待在数学上等不到任何事件——必须短路，
 *     并且给的是可执行文案（先看名册 → 再唤醒 → 最后才等），不是错误；
 *  ⑤ **有活跃 peer 时行为不变**：仍然正常轮询到超时（短路不能把「真的在等别人」也砍掉）。
 *
 * 测试纪律：护栏阈值经 `guardOptions` 行配置收紧（stuckTimeoutMs / emptyTurnThreshold /
 * envThreshold），**不靠 sleep 造时间**——`observeCall` 的时间由调用方注入，sleep 只会让
 * 用例既慢又不稳。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARD_TURN_BOUNDARY_TOOLS,
  MyTeamHost,
  NO_ACTIVE_PEER_HINT,
  guardCallOf,
  guardExitCodeOf,
  guardOutputHash,
  stableGuardJson,
  type HostRuntime,
  type MyTeamConfig,
} from '../src/host.ts'

type LogEntry = { level: 'info' | 'warn' | 'error'; msg: string }

function tempWorkspace(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const cleanup = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  return { root, cleanup }
}

function makeRuntime(root: string, logs: LogEntry[] = []): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, dispose: () => {} }) },
    logger: {
      info: (msg: string) => { logs.push({ level: 'info', msg }) },
      warn: (msg: string) => { logs.push({ level: 'warn', msg }) },
      error: (msg: string) => { logs.push({ level: 'error', msg }) },
    },
    workspace: { root },
  } as unknown as HostRuntime
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '护栏接线用例',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  ...over,
})

const EVIDENCE = { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 7 }] }

/** 建团队（+ implementer 成员），返回 host 与成员句柄 */
async function team(root: string, config: MyTeamConfig = {}, logs: LogEntry[] = []) {
  const host = new MyTeamHost(makeRuntime(root, logs), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0, ...config })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T123',
    goal: 'P1-5 / P2-1 接线',
    roster: [{ roleId: 'captain' }],
    tasks: [],
  }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  const impl = host.executeLeadTool('myteam_spawn_member', { teamId: sub.teamId, roleId: 'implementer' }, {}) as any
  await new Promise((resolve) => setTimeout(resolve, 0)) // handle 回填是 microtask
  const teamId = String(sub.teamId)
  const implMember = { memberId: impl.memberId, roleId: 'implementer', instanceName: 'impl', sessionId: impl.sessionId, teamId }
  return { host, teamId, implMember }
}

function createTask(host: MyTeamHost, teamId: string, over: Record<string, unknown> = {}): string {
  const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK(over) }, {}) as any
  assert.equal(created.status, 'created', JSON.stringify(created))
  return String(created.taskId)
}

function writeDeliverable(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
}

function ledgerOf(root: string, teamId: string): any[] {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

const guardWarns = (logs: LogEntry[], kind?: string): LogEntry[] =>
  logs.filter((entry) => entry.level === 'warn' && entry.msg.includes('[GUARD ·') && (kind ? entry.msg.includes(`[GUARD · ${kind}]`) : true))

/* ── 1. repeat：同签名连续第 3 次 ───────────────────────────── */

test('t123-1: repeat —— 同工具同参数连续第 3 次 → 结果里带 guard 提醒（且老字段不变）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-repeat')
  try {
    const logs: LogEntry[] = []
    const { host, teamId, implMember } = await team(root, {}, logs)
    const taskId = createTask(host, teamId)

    const first = host.executeMemberTool(implMember, 'myteam_get_task', { taskId }) as any
    assert.equal(first.status, 'ok', '第 1 次正常')
    assert.equal(first.guard, undefined, '未达阈值不打扰')
    /* CHG-213（实机）：**认领前**的任务视图不许带 undefined 字段——工具返回值要过 lossless JSON
     * 校验，一个 `attemptId: undefined` 就让整次读取报 `invalid output: value is not lossless JSON`
     * （成员在长跑里实测到，认领后才有 attemptId 所以「领完就正常」，很容易被误判成偶发）。 */
    const hasUndefined = (value: unknown): boolean =>
      value === undefined || (typeof value === 'object' && value !== null && Object.values(value as Record<string, unknown>).some(hasUndefined))
    assert.equal(hasUndefined(first.task), false, `任务视图不许含 undefined：${JSON.stringify(first.task)}`)
    assert.equal('attemptId' in (first.task as Record<string, unknown>), false, '未认领时连键都不能出现')
    const second = host.executeMemberTool(implMember, 'myteam_get_task', { taskId }) as any
    assert.equal(second.guard, undefined, '第 2 次还不算打转（一次重试是正常自愈）')
    const third = host.executeMemberTool(implMember, 'myteam_get_task', { taskId }) as any

    assert.equal(third.guard.kind, 'repeat')
    assert.ok(String(third.guard.hint).length > 0, 'hint 必须给下一步动作')
    assert.match(String(third.guard.message), /复读/)
    // 老字段不受影响（只新增 guard）
    assert.equal(third.status, 'ok')
    assert.equal(third.task.id, taskId)
    // 日志有 grep 锚点
    assert.equal(guardWarns(logs, 'repeat').length, 1)
    assert.equal(host.guardVerdict(implMember.memberId)?.kind, 'repeat')
  } finally {
    cleanup()
  }
})

/* ── 2. stuck：同签名 + 同输出指纹 + 超时间窗 ───────────────── */

test('t123-2: stuck —— 同签名同输出连续 2 次且超过时间窗 → 判挂死（阈值经 guardOptions 收紧）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-stuck')
  try {
    const logs: LogEntry[] = []
    // 时间窗收到 1ms：真实时间窗是 120s，靠长 sleep 造时间既慢又不稳（护栏的时间由调用方注入）。
    // 但「静默」本身必须有真实流逝——两次调用挤在同一毫秒里等于「没有静默」，故留 10ms。
    const { host, teamId, implMember } = await team(root, { guardOptions: { stuckTimeoutMs: 1, stuckThreshold: 2 } }, logs)
    const taskId = createTask(host, teamId)

    host.executeMemberTool(implMember, 'myteam_get_task', { taskId })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = host.executeMemberTool(implMember, 'myteam_get_task', { taskId }) as any

    assert.equal(second.guard.kind, 'stuck')
    assert.match(String(second.guard.message), /挂死/)
    assert.ok(String(second.guard.hint).includes('非交互'), 'hint 要指向具体做法（加非交互参数 / 超时）')
    assert.equal(guardWarns(logs, 'stuck').length, 1)
  } finally {
    cleanup()
  }
})

/* ── 3. empty-turn：连续空回合（只申报、零真实动作）──────────── */

test('t123-3: empty-turn —— 连续两个回合只申报进度、没有任何真实动作 → 判空转', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-empty')
  try {
    const logs: LogEntry[] = []
    const { host, teamId, implMember } = await team(root, { guardOptions: { emptyTurnThreshold: 2 } }, logs)
    const taskId = createTask(host, teamId)
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')

    const progress = () => host.executeMemberTool(implMember, 'myteam_update_task', {
      taskId,
      attemptId: claim.attemptId,
      status: 'in_progress',
      progress: '只说不做',
    }) as any

    assert.equal(progress().guard, undefined, '第 1 个空回合只计数（刚接手可能只是还没动手）')
    assert.equal(progress().guard, undefined, '空回合计数 1 → 阈值 2 还没到（单次只说不做不足以判定打转）')
    const third = progress()
    assert.equal(third.guard.kind, 'empty-turn')
    assert.match(String(third.guard.message), /空转/)
    assert.ok(String(third.guard.hint).length > 0)
    assert.equal(guardWarns(logs, 'empty-turn').length, 1)
  } finally {
    cleanup()
  }
})

/* ── 4. env-unavailable：同环境特征连续失败 → latch ─────────── */

test('t123-4: env-unavailable —— 同签名连续 2 次以环境特征失败 → latch 并给出可执行文案', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-env')
  try {
    const logs: LogEntry[] = []
    const { host, teamId, implMember } = await team(root, { guardOptions: { envThreshold: 2 } }, logs)
    void teamId
    // 工具结果里带上环境特征（read_knowledge 会把 id 回显进 message）：模拟「同一条命令连续
    // 以 command not found 失败」；错误状态映射成非 0 退出码（见 guardExitCodeOf 注释）。
    const failing = () => host.executeMemberTool(implMember, 'myteam_read_knowledge', { id: 'command not found' }) as any
    const first = failing()
    assert.equal(first.status, 'error', '老字段照旧：工具本身仍然返回 error')
    assert.equal(first.guard, undefined, '第 1 次失败不算环境故障')
    const second = failing()

    assert.equal(second.guard.kind, 'env-unavailable', JSON.stringify(second.guard))
    assert.match(String(second.guard.message), /环境不可用/)
    assert.ok(String(second.guard.hint).includes('停止重试'), 'hint 必须说「停止重试」')
    assert.equal(guardWarns(logs, 'env-unavailable').length, 1)
    assert.equal(host.guardVerdict(implMember.memberId)?.kind, 'env-unavailable')
  } finally {
    cleanup()
  }
})

/* ── 5. blocksCompletion → archive 判 needs-human 且不自动重试 ── */

test('t123-5: 环境不可用 latch 后交付判定转人工 —— archive 判 needs-human，且不落 fail（不自动重试）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-block')
  try {
    const logs: LogEntry[] = []
    const { host, teamId, implMember } = await team(root, { guardOptions: { envThreshold: 2 } }, logs)
    writeDeliverable(root, 'docs/x.md', `本阶段真实产出 ${'y'.repeat(80)}`)
    const taskId = createTask(host, teamId, { gateChain: ['archive'], taskType: 'dev' })
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')

    // 先 latch 环境不可用（同一条命令连续失败）
    host.executeMemberTool(implMember, 'myteam_read_knowledge', { id: 'command not found' })
    host.executeMemberTool(implMember, 'myteam_read_knowledge', { id: 'command not found' })
    assert.equal(host.guardVerdict(implMember.memberId)?.kind, 'env-unavailable')

    // 交付物齐全 + 证据齐全，但环境不可用 → 「完成了」一定是假的
    const done = host.executeMemberTool(implMember, 'myteam_update_task', {
      taskId,
      attemptId: claim.attemptId,
      status: 'done',
      summary: '',
      evidence: EVIDENCE,
    }) as any

    assert.equal(done.status, 'needs-human', JSON.stringify(done))
    assert.equal(done.code, 'MT_ENV_UNAVAILABLE')
    assert.match(String(done.note), /转人工|环境不可用/)
    // 任务停在 gate:archive（等人工），没有被 fold 放回 ready
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:archive')
    // 不落 gate.result fail —— 否则 fold 会把任务放回 ready 触发自动重试
    const archiveResults = ledgerOf(root, teamId).filter((event) => event.type === 'task.gate.result' && event.payload?.gate === 'archive')
    assert.deepEqual(archiveResults, [], '环境不可用不进自动重试：gate.result 一条都不该落')
  } finally {
    cleanup()
  }
})

/* ── 6. P2-1：无活跃 peer 立即返回 ─────────────────────────── */

test('t123-6: 无活跃 peer → wait 立即返回 no-active-peer（耗时可忽略）+ 可执行 hint', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-peer')
  try {
    const { host, teamId, implMember } = await team(root)
    // 团队里只有本人一个成员 → 等待在数学上等不到任何事件
    const startedAt = Date.now()
    const out = (await host.executeMemberTool(implMember, 'myteam_wait_for_change', {
      teamId,
      sinceSeq: 999_999,
      timeoutMs: 5000,
    })) as any
    const elapsed = Date.now() - startedAt

    // 状态复用词表里的 unavailable（不新增状态字面量）；语义由 cause 承载
    assert.equal(out.status, 'unavailable')
    assert.equal(out.changed, false)
    assert.equal(out.cause, 'no-active-peer')
    assert.ok(elapsed < 300, `必须立即返回（实测 ${elapsed}ms；空等 5s 是修复前的形态）`)
    // 文案可执行：先看名册 → 再唤醒 → 最后才等
    assert.ok(String(out.hint).length > 0)
    assert.match(String(out.hint), /myteam_list_tasks/)
    assert.match(String(out.hint), /myteam_message/)
    assert.equal(out.hint, NO_ACTIVE_PEER_HINT)
  } finally {
    cleanup()
  }
})

/* ── 7. P2-1：有活跃 peer 时仍正常等待 ─────────────────────── */

test('t123-7: 有活跃 peer 时行为不变 —— 仍然轮询到超时（短路不能砍掉真实等待）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t123-wait')
  try {
    const { host, teamId, implMember } = await team(root)
    // 第二名成员（reviewer）= 活跃 peer
    const review = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'reviewer' }, {}) as any
    assert.notEqual(review.status, 'error', JSON.stringify(review))

    const startedAt = Date.now()
    const out = (await host.executeMemberTool(implMember, 'myteam_wait_for_change', {
      teamId,
      sinceSeq: 999_999,
      timeoutMs: 120,
    })) as any
    const elapsed = Date.now() - startedAt

    assert.equal(out.status, 'timeout', JSON.stringify(out))
    assert.equal(out.changed, false)
    assert.ok(elapsed >= 120, `有 peer 时必须真的等到超时（实测 ${elapsed}ms）`)
  } finally {
    cleanup()
  }
})

/* ── 8. 纯函数：护栏观测的构造口径 ─────────────────────────── */

test('t123-8: 观测构造 —— 签名与键序无关、失败映射非 0、回合边界工具集合固定', () => {
  // 键序不同 = 同一条命令（否则复读/挂死判据整体失效）
  assert.equal(stableGuardJson({ b: 1, a: 2 }), stableGuardJson({ a: 2, b: 1 }))
  assert.equal(guardCallOf('pwsh', { a: 1 }, { status: 'ok' }, 5).signature, guardCallOf('pwsh', { a: 1 }, { status: 'error' }, 9).signature)

  // 退出码口径：真实 exitCode 优先；error 映射 1；成功映射 0；unknown(null) 原样
  assert.equal(guardExitCodeOf({ exitCode: 3 }), 3)
  assert.equal(guardExitCodeOf({ exitCode: null }), null)
  assert.equal(guardExitCodeOf({ status: 'error' }), 1)
  assert.equal(guardExitCodeOf({ status: 'ok' }), 0)

  // 输出指纹稳定且与内容相关
  assert.equal(guardOutputHash('same'), guardOutputHash('same'))
  assert.notEqual(guardOutputHash('a'), guardOutputHash('b'))

  // 回合边界：申报/上报是边界；等待不是（老实等待不能被判成空转）
  assert.equal(GUARD_TURN_BOUNDARY_TOOLS.has('myteam_update_task'), true)
  assert.equal(GUARD_TURN_BOUNDARY_TOOLS.has('myteam_escalate_task'), true)
  assert.equal(GUARD_TURN_BOUNDARY_TOOLS.has('myteam_wait_for_change'), false)

  // 观测里的 output 是有界尾部（账本/日志不存全文）
  const long = guardCallOf('pwsh', {}, { status: 'ok', outputTail: 'x'.repeat(10_000) }, 1)
  assert.ok((long.output ?? '').length <= 2100, `output 必须有界（实测 ${(long.output ?? '').length}）`)
  assert.ok(long.outputHash && long.outputHash.length > 0)
})
