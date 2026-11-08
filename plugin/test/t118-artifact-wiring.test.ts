/**
 * T118 · P1-1/P1-2 接线（docs/21 §6；CHG-144 交付的纯函数模块接进任务生命周期）。
 *
 * 锁五件事：
 *  ① **阶段起点拍基线**：claim 成功（= 任务进入 in_progress）时把 `deliverableSpec` 的产物
 *     指纹落到任务夹（`state/artifacts/<teamId>/<taskId>.json`）；
 *  ② **stale 的当不存在**：上游越界写了下游产物、下游什么都没写时，产物「在磁盘上」也不算交付
 *     （TF 实锤：`tf-mv9o5fkk-orjou4` 架构师写了 `QA-REPORT.md`，验收阶段凭它判已交付）；
 *  ③ **续跑只补缺失键**：重拍基线不覆盖首次快照（否则「第一轮写了、第二轮没写」会被洗成新鲜）；
 *  ④ **空文件不算交付**：0 字节产物只有「存在」这一个事实，`docText.trim().length > 0` 是独立判据；
 *  ⑤ **有证据时拒绝词不否决**：带 `[Verification evidence]` / 结构化证据的产出如实汇报环境限制，
 *     不该被措辞误杀（TF `tf-mtwvwpxa-p3vw08`：16 分钟 + 一轮重跑）。
 *
 * 全部走**真实入口**（`myteam_claim_task` / `myteam_update_task` / `myteam_review_task`），
 * 不用 `host.commit()` 替身——接线断链正是「单测绕过入口」时最容易被漏掉的那类缺陷。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

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

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, dispose: () => {} }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '产物新鲜度接线',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  ...over,
})

/** 证据块（结构化；FR-5.0 要求 done 必须先落 task.evidence） */
const EVIDENCE = { kind: 'commands', commands: [{ cmd: 'npm test', exitCode: 0, assertions: 42 }] }

async function team(root: string) {
  const host = new MyTeamHost(makeRuntime(root), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T118',
    goal: '产物新鲜度接线',
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

function baselineFileOf(root: string, teamId: string, taskId: string): string {
  return join(root, '.dsh-myteam', 'state', 'artifacts', teamId, `${taskId}.json`)
}

function readBaseline(root: string, teamId: string, taskId: string): any {
  return JSON.parse(readFileSync(baselineFileOf(root, teamId, taskId), 'utf8'))
}

function ledgerOf(root: string, teamId: string): any[] {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

/** 申报 done（summary 为空 = 空收尾：此时只能靠产物内容顶替） */
function reportDone(host: MyTeamHost, member: any, taskId: string, attemptId: string, summary: string, evidence: unknown = EVIDENCE) {
  return host.executeMemberTool(member, 'myteam_update_task', {
    taskId,
    attemptId,
    status: 'done',
    summary,
    evidence,
  }) as any
}

/* ── ① 阶段起点拍基线；② 上游产物陈旧 → 交付判定拒绝 ─────────── */

test('t118-1: claim 拍产物基线；上游越界写了下游产物 → 成员没重写 → archive 交付判定拒绝', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t118-stale')
  try {
    const { host, teamId, implMember } = await team(root)
    // 上游阶段越界写了本该属于本任务的产物（TF tf-mv9o5fkk-orjou4 同款形态）
    writeDeliverable(root, 'docs/x.md', `上游越界写的内容 ${'x'.repeat(80)}`)
    const taskId = createTask(host, teamId, { gateChain: ['archive'], taskType: 'dev' })

    // ① claim = 任务进入 in_progress = 阶段起点 → 拍基线
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed', JSON.stringify(claim))
    assert.ok(existsSync(baselineFileOf(root, teamId, taskId)), '阶段起点必须落基线（任务夹 sidecar）')
    const baseline = readBaseline(root, teamId, taskId)
    assert.equal(baseline.teamId, teamId)
    assert.equal(baseline.taskId, taskId)
    assert.match(String(baseline.baseline['docs/x.md']), /^\d+:\d+$/, '基线里必须是 size:mtimeMs 指纹')

    // 成员什么都没写（空收尾，summary 为空）→ 产物指纹没变 = 陈旧。
    // 门禁链只有 archive 门 → 申报 done 时 host **立即**做落位 + 交付判定（archive 不是人工裁决门）
    const done = reportDone(host, implMember, taskId, claim.attemptId, '')
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.match(String(done.note), /交付判定未通过/, JSON.stringify(done))
    assert.match(String(done.note), /空收尾但产物不可用/)
    // ② 交付判定拒绝 → 任务回到修复队列（不是 done）
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'ready')

    // 判定结论落账本（复用 task.gate.result 载荷，不新增事件型）
    const gateResult = ledgerOf(root, teamId).filter((event) => event.type === 'task.gate.result').at(-1)!
    assert.equal(gateResult.payload.gate, 'archive')
    assert.equal(gateResult.payload.verdict, 'fail')
    assert.equal(gateResult.payload.delivery.verdict, 'needs-human')
    assert.equal(gateResult.payload.delivery.signal, 'empty-turn')
    assert.deepEqual(gateResult.payload.delivery.staleArtifacts, ['docs/x.md'], '陈旧产物必须留痕（审计能看出假绿）')
    assert.deepEqual(gateResult.payload.delivery.freshArtifacts, [])
  } finally {
    cleanup()
  }
})

/* ── 差异性对照：同一份输入，只有「本阶段写没写」不同 ─────────── */

test('t118-2: 同样的空收尾，成员重写了产物（指纹变了 = 新鲜）→ 用文件内容顶替，archive 通过', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t118-fresh')
  try {
    const { host, teamId, implMember } = await team(root)
    writeDeliverable(root, 'docs/x.md', '上游越界写的旧内容')
    const taskId = createTask(host, teamId, { gateChain: ['archive'], taskType: 'dev' })
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')

    // 本阶段真的写了（长度 ≥ dev 下限 60，且大小/时间都变 → 指纹变 → 新鲜）
    writeDeliverable(root, 'docs/x.md', `# 交付物\n\n${'本阶段真实产出。'.repeat(20)}\n`)
    const done = reportDone(host, implMember, taskId, claim.attemptId, '')
    assert.equal(done.status, 'completed')
    assert.match(String(done.note), /archive gate pass/, JSON.stringify(done))
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'done')

    const gateResult = ledgerOf(root, teamId).filter((event) => event.type === 'task.gate.result').at(-1)!
    assert.equal(gateResult.payload.delivery.verdict, 'delivered')
    assert.equal(gateResult.payload.delivery.signal, 'empty-turn', '空收尾兜底：用产物内容顶替空回复')
    assert.deepEqual(gateResult.payload.delivery.staleArtifacts, [])
    assert.deepEqual(gateResult.payload.delivery.freshArtifacts, ['docs/x.md'])
  } finally {
    cleanup()
  }
})

/* ── ④ 空文件不算交付 ───────────────────────────────────────── */

test('t118-3: 本阶段写了产物但是**空文件** → 不算交付（docText.trim().length > 0 是独立判据）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t118-empty')
  try {
    const { host, teamId, implMember } = await team(root)
    // 起点上产物还不存在（基线落哨兵 absent）
    const taskId = createTask(host, teamId, { gateChain: ['archive'], taskType: 'dev' })
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')
    assert.equal(readBaseline(root, teamId, taskId).baseline['docs/x.md'], 'absent', '起点不存在 → 哨兵指纹')

    // 本阶段创建了它，但是 0 字节：指纹变了（新鲜），但空文件绝不算交付
    writeDeliverable(root, 'docs/x.md', '')
    const done = reportDone(host, implMember, taskId, claim.attemptId, '')
    assert.equal(done.status, 'completed')
    assert.match(String(done.note), /空文件不算交付/, JSON.stringify(done))
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'ready')
    const gateResult = ledgerOf(root, teamId).filter((event) => event.type === 'task.gate.result').at(-1)!
    assert.equal(gateResult.payload.delivery.verdict, 'needs-human')
    assert.equal(gateResult.payload.delivery.docLength, 0)
    assert.deepEqual(gateResult.payload.delivery.freshArtifacts, ['docs/x.md'], '新鲜但空：新鲜度不是交付的充分条件')
  } finally {
    cleanup()
  }
})

/* ── ⑤ 有证据时拒绝词不否决 ───────────────────────────────── */

test('t118-4: 带证据块 + 如实汇报「无法执行」→ 拒绝词不否决，archive 通过（措辞只作诊断）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t118-evidence')
  try {
    const { host, teamId, implMember } = await team(root)
    writeDeliverable(root, 'docs/x.md', `本阶段产出 ${'y'.repeat(80)}`)
    const taskId = createTask(host, teamId, { gateChain: ['archive'], taskType: 'dev' })
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')

    // TF 实锤形态：子代理如实汇报环境限制（命中拒绝词「无法执行」），但证据块齐全
    const done = reportDone(host, implMember, taskId, claim.attemptId, '7 条 runCli 用例与 spec/verify.mjs 全部 26 例无法执行（沙箱禁止子进程管道）。')
    assert.equal(done.status, 'completed')
    assert.match(String(done.note), /archive gate pass/, JSON.stringify(done))
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'done')
    const gateResult = ledgerOf(root, teamId).filter((event) => event.type === 'task.gate.result').at(-1)!
    assert.equal(gateResult.payload.delivery.hasEvidence, true)
    assert.equal(gateResult.payload.delivery.verdict, 'delivered')
  } finally {
    cleanup()
  }
})

/* ── ③ 续跑 / 重试只补缺失键 ──────────────────────────────── */

test('t118-5: 续跑重拍基线只补缺失键 —— 首次指纹不被覆盖，新声明的候选路径补哨兵', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t118-merge')
  try {
    const { host, teamId, implMember } = await team(root)
    writeDeliverable(root, 'docs/x.md', `第一轮内容 ${'a'.repeat(40)}`)
    const taskId = createTask(host, teamId, {
      gateChain: ['archive'],
      taskType: 'dev',
      deliverableSpec: { path: 'docs/x.md', candidates: ['docs/y.md'] },
    })
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')
    const first = readBaseline(root, teamId, taskId)
    assert.match(String(first.baseline['docs/x.md']), /^\d+:\d+$/)
    assert.equal(first.baseline['docs/y.md'], 'absent', '候选清单里的路径也要拍（不存在 → 哨兵）')

    // 续跑：文件被改写后再申报 in_progress —— 重拍**不得**覆盖首次指纹
    writeDeliverable(root, 'docs/x.md', `第二轮内容 ${'b'.repeat(90)}`)
    const progress = host.executeMemberTool(implMember, 'myteam_update_task', {
      taskId,
      attemptId: claim.attemptId,
      status: 'in_progress',
      progress: '续跑',
    }) as any
    assert.equal(progress.status, 'in_progress')

    const second = readBaseline(root, teamId, taskId)
    assert.equal(second.baseline['docs/x.md'], first.baseline['docs/x.md'], '首次基线一经写下就固定（否则第一轮写入会被洗成基线）')
    assert.equal(second.capturedAt, first.capturedAt, 'capturedAt 也不该被重拍改写')
    // 新路径仍然只有哨兵（没写过）
    assert.equal(second.baseline['docs/y.md'], 'absent')
  } finally {
    cleanup()
  }
})

/* ── review 门：交付判定留痕但不否决（否决权在 archive 门）──────── */

test('t118-6: review 门裁决时交付判定进载荷留痕，但不改变裁决结果（人/队长的显式裁决优先）', async () => {
  const { root, cleanup } = tempWorkspace('myteam-t118-review')
  try {
    const { host, teamId, implMember } = await team(root)
    writeDeliverable(root, 'docs/x.md', '上游越界写的旧内容')
    const taskId = createTask(host, teamId, { gateChain: ['review', 'archive'], taskType: 'dev' })
    const claim = host.executeMemberTool(implMember, 'myteam_claim_task', { taskId }) as any
    assert.equal(claim.status, 'claimed')
    // 本阶段真的重写了产物 → 交付判定为 delivered（review 门只留痕，不否决）
    writeDeliverable(root, 'docs/x.md', `# 交付物\n\n${'本阶段真实产出。'.repeat(20)}\n`)
    const done = reportDone(host, implMember, taskId, claim.attemptId, '')
    assert.equal(done.status, 'completed')
    assert.equal(host.service(teamId).projectionSnapshot.tasks[taskId].state, 'gate:review')

    const reviewer = (host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'reviewer' }, {}) as any)
    and_ok(reviewer)
    const pass = host.executeLeadTool('myteam_review_task', { teamId, taskId, verdict: 'pass', reviewerMemberId: reviewer.memberId }, {}) as any
    assert.equal(pass.status, 'gate-pass', JSON.stringify(pass))
    assert.ok(pass.delivery, 'review 门也要把交付判定带回给调用方（面板展示 / 重试诊断）')

    const reviewResult = ledgerOf(root, teamId)
      .filter((event) => event.type === 'task.gate.result' && event.payload.gate === 'review')
      .at(-1)!
    assert.equal(reviewResult.payload.delivery.verdict, 'delivered')
    // review 门不否决：裁决结果仍由 review 门自己写（delivery 只是留痕字段）
    assert.equal(reviewResult.payload.verdict, 'pass')
  } finally {
    cleanup()
  }
})

/** 小断言辅助（避免在测试里写重复的 status 检查） */
function and_ok(value: any): void {
  assert.ok(value && typeof value === 'object', 'spawn 应返回对象')
  assert.notEqual(value.status, 'error', JSON.stringify(value))
}
