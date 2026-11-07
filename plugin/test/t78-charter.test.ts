/**
 * T78 · CHG-93：两笔「文档承诺、实现分叉」的收口。
 *
 * ① **团队章程注入队长 system prompt**（FR-18 职责③ F8）——CHG-88 实装了 create-team
 *    技能**写** `.dsh-myteam/structure.md`，但**没有任何读取方**：章程写进磁盘就没人看，
 *    队长自己的系统提示里一个字都没有。
 * ② **`drained.pending` 硬编码 0**（docs/14 §7.4 遗留）——账本上写「排空完成」，
 *    实际成员收件箱里还压着消息。释放是**不可逆**动作（`mode:'remove'` 删私有空间），
 *    它宣称的「排空」必须是真的。
 *
 * 纪律：走真实入口（`MyTeamHost.initialize()` / `executeLeadTool`），不 mock 装载器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { readTeamCharter, MAX_CHARTER_BYTES, TEAM_CHARTER_SECTION, TEAM_CHARTER_VARIABLE } from '../src/core/host/team-charter.ts'

/* ── 宿主桩（可注入 systemPrompt 服务）──────────────────────────── */

interface RecordedSection { name: string; order: number; text: string }
interface RecordedVariable { name: string; provider: () => string }

function makeRuntime(root: string, opts: { withSystemPrompt?: boolean; withVariable?: boolean } = {}): HostRuntime {
  const sections: RecordedSection[] = []
  const variables: RecordedVariable[] = []
  const systemPrompt = opts.withSystemPrompt === false
    ? undefined
    : {
      section: (section: RecordedSection) => { sections.push(section); return () => {} },
      ...(opts.withVariable === false
        ? {}
        : { variable: (name: string, provider: () => string) => { variables.push({ name, provider }); return () => {} } }),
    }
  const runtime = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: (o: { sessionId: string }) => ({ session: { id: o.sessionId }, followup: () => {} }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
    ...(systemPrompt ? { systemPrompt } : {}),
  } as unknown as HostRuntime
  return Object.assign(runtime, { __sections: sections, __variables: variables }) as never
}

function setup(root: string, opts: { withSystemPrompt?: boolean; withVariable?: boolean } = {}) {
  const runtime = makeRuntime(root, opts)
  const host = new MyTeamHost(runtime)
  host.initialize()
  return { host, runtime: runtime as unknown as { __sections: RecordedSection[]; __variables: RecordedVariable[] } }
}

function writeCharter(root: string, content: string): void {
  const dir = join(root, '.dsh-myteam')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'structure.md'), content, 'utf8')
}

/* ── 1. 纯函数（readTeamCharter）───────────────────────────────── */

test('t78-1: readTeamCharter —— 文件缺失是合法状态（空串，不抛）', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-charter-'))
  const charter = readTeamCharter(root)
  assert.equal(charter.text, '', '没有章程 → 空串（不注册 section）')
  assert.equal(charter.truncated, false)
  assert.ok(charter.path.endsWith('structure.md'))
})

test('t78-2: readTeamCharter —— 去 BOM + 包成「只读参考」段落（不是裸贴 markdown）', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-charter-'))
  writeCharter(root, '\uFEFF# 结构约定\n\n- 文件放 src/\n')
  const charter = readTeamCharter(root)
  assert.ok(!charter.text.includes('\uFEFF'), 'BOM 必须去掉（混进 system prompt 是垃圾字符）')
  assert.ok(charter.text.includes('## 团队章程'), '要有明确标题')
  assert.ok(charter.text.includes('不是权限'), '必须框成「约定不是权限」——否则模型会当指令执行')
  assert.ok(charter.text.includes('- 文件放 src/'), '正文原样保留')
})

test('t78-3: readTeamCharter —— 超过 64 KiB 截断并显式标注（不能让章程挤爆 system prompt）', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-charter-'))
  writeCharter(root, 'x'.repeat(MAX_CHARTER_BYTES + 1000))
  const charter = readTeamCharter(root)
  assert.equal(charter.truncated, true)
  assert.ok(charter.bytes > MAX_CHARTER_BYTES)
  assert.ok(charter.text.includes('已截断'), '必须显式告诉模型内容不完整')
  assert.ok(charter.text.length < MAX_CHARTER_BYTES + 2000, '注入体积有界')
})

/* ── 2. 注入（host 真实装载路径）────────────────────────────────── */

test('t78-4: 动态路径 —— 注册 variable + section，provider 每次组装重新读盘（改章程不必重启）', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-inject-'))
  writeCharter(root, '# 初版约定\n')
  const { runtime } = setup(root)
  const variable = runtime.__variables.find((item) => item.name === TEAM_CHARTER_VARIABLE)
  assert.ok(variable, `必须注册变量 ${TEAM_CHARTER_VARIABLE}`)
  const section = runtime.__sections.find((item) => item.name === TEAM_CHARTER_SECTION.name)
  assert.ok(section, '必须注册 section')
  assert.equal(section.text, `{{${TEAM_CHARTER_VARIABLE}}}`, 'section 用插值引用变量（这样才是动态的）')
  assert.equal(section.order, TEAM_CHARTER_SECTION.order)

  // 关键：provider 求值时才读盘 → 写完立刻能看到新内容
  assert.ok(variable.provider().includes('初版约定'))
  writeCharter(root, '# 改版约定\n')
  assert.ok(variable.provider().includes('改版约定'), 'provider 必须每次重新读盘（动态注入的全部意义）')
})

test('t78-5: 静态退化 —— 宿主无 variable API 时静态注入并留痕（不假装即时生效）', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-static-'))
  writeCharter(root, '# 静态约定\n')
  const { runtime } = setup(root, { withVariable: false })
  assert.equal(runtime.__variables.length, 0, '没有 variable API')
  const section = runtime.__sections.find((item) => item.name === TEAM_CHARTER_SECTION.name)
  assert.ok(section, '退化路径仍要注入')
  assert.ok(section.text.includes('静态约定'), '静态注入的是当前快照')
  assert.ok(!section.text.includes('{{'), '不能残留未解析的插值')
})

test('t78-6: 空白章程 —— 静态路径不注册 section（空 section 是噪音）', () => {
  // 注意：initialize() 会播种默认 structure.md（ensureWorkplaceDirs），所以「没有章程」
  // 的真实形态是「文件存在但只有空白」——先造出这个状态再初始化。
  const root = mkdtempSync(join(tmpdir(), 't78-empty-'))
  mkdirSync(join(root, '.dsh-myteam'), { recursive: true })
  writeFileSync(join(root, '.dsh-myteam', 'structure.md'), '   \n\n  ', 'utf8')
  const { runtime } = setup(root, { withVariable: false })
  assert.equal(runtime.__sections.filter((item) => item.name === TEAM_CHARTER_SECTION.name).length, 0, '空白章程不注册 section')
})

test('t78-7: 宿主无 systemPrompt 服务 —— 只告警，不阻断启动', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-nosvc-'))
  writeCharter(root, '# x\n')
  assert.doesNotThrow(() => setup(root, { withSystemPrompt: false }), '章程是增强不是主链，缺服务不能拖垮初始化')
})

/* ── 3. drained 如实记录（docs/14 §7.4 遗留硬编码）──────────────── */

function approvedTeam(root: string) {
  const runtime = makeRuntime(root)
  const host = new MyTeamHost(runtime)
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(sub.status, 'staged')
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})
  return { host, teamId: sub.teamId as string, root }
}

function ledgerEvents(root: string, teamId: string): any[] {
  const path = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line: string) => JSON.parse(line))
}

test('t78-8: drained.pending 如实记录 —— 成员收件箱有未消费消息时不为 0', () => {
  const root = mkdtempSync(join(tmpdir(), 't78-drained-'))
  const { host, teamId } = approvedTeam(root)
  const spawned = host.executeLeadTool('myteam_spawn_member', { teamId, roleId: 'implementer' }, {}) as any
  assert.ok(['spawned', 'ok'].includes(String(spawned.status)), `召唤应成功：${JSON.stringify(spawned)}`)
  const memberId = String(spawned.memberId)

  // 给成员发两条消息（message.sent，收件人 = memberId）
  for (const content of ['第一条', '第二条']) {
    const sent = host.executeLeadTool('myteam_message', { to: memberId, content, kind: 'notify' }, {}) as any
    assert.ok(['sent', 'ok'].includes(String(sent.status)), `发消息应成功：${JSON.stringify(sent)}`)
  }

  // 释放成员 → 账本里的 drained.pending 必须是真实条数
  const released = host.executeLeadTool('myteam_release_member', { teamId, memberId, mode: 'suspend' }, {}) as any
  assert.equal(released.status, 'suspend', `释放应成功：${JSON.stringify(released)}`)

  const events = ledgerEvents(root, teamId)
  const releaseEvent = events.filter((event) => event.type === 'member.released').at(-1)
  assert.ok(releaseEvent, '应落 member.released')
  assert.equal(releaseEvent.payload.drained.pending, 2, '账本上的「排空」必须是真的（原实现硬编码 0）')
  assert.equal(releaseEvent.payload.drained.running, 0, '没有在跑任务')
})

/* ── 4. 门禁结论可信度（executedBy / forcedBy 上屏）────────────── */

/**
 * 造一条「任务走到 gate 态」的最小账本前缀。
 *
 * 为什么要有它：门禁只能从 \`in_progress\` 进（\`isLegalTransition('ready','gate:review')\` = false，
 * t3-t4 锁死），所以必须先 claim → completed 才能落 \`task.gate.result\`。
 * 用 foldEvents（纯函数）直接断言投影契约——比串起 spawn/claim/done 的宿主流程更能定位问题。
 */
function gatePrefix(gateChain: string[]) {
  return [
    { seq: 0, ts: 1, actor: 'human', type: 'team.created', payload: { teamId: 't1', name: 'T', goal: 'G' } },
    { seq: 1, ts: 2, actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'idle' } },
    { seq: 2, ts: 3, actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'task-1', task: {
      title: 'x', description: 'd', acceptanceCriteria: ['AC'], deliverableSpec: { path: 'p' },
      deps: [], requiredRole: 'implementer', priority: 'P2', gateChain,
    } } },
    { seq: 3, ts: 4, actor: 'member:m1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'task-1', memberId: 'm1', attemptId: 'a1' } },
    { seq: 4, ts: 5, actor: 'member:m1', type: 'task.completed', payload: { teamId: 't1', taskId: 'task-1', attemptId: 'a1' } },
  ]
}

test('t78-9: gateResults 进投影 —— executedBy / exitCode 从账本透出（fold 契约）', async () => {
  const { foldEvents } = await import('../src/core/scheduler/fold.ts')
  const events = [
    ...gatePrefix(['verify']),
    { seq: 5, ts: 6, actor: 'host', type: 'task.gate.result', payload: {
      teamId: 't1', taskId: 'task-1', gate: 'verify', verdict: 'pass',
      executedBy: 'host', exitCode: 0, durationMs: 1200,
    } },
  ]
  const task = foldEvents('t1', events as never).tasks['task-1'] as any
  assert.equal(task.state, 'done', 'verify 是最后一门 → done（前置状态正确）')
  assert.ok(task.gateResults?.verify, 'fold 必须记下 gateResults')
  assert.equal(task.gateResults.verify.verdict, 'pass')
  assert.equal(task.gateResults.verify.executedBy, 'host', '「宿主真跑了命令」要能从投影读出来')
  assert.equal(task.gateResults.verify.exitCode, 0)
  assert.equal(task.gateResults.verify.at, 6, '要记裁决时刻（面板排序用）')
})

test('t78-10: gateResults 记人工强制放行 —— forcedBy 与 verdict 可并存（verify 门人工越预算）', async () => {
  const { foldEvents } = await import('../src/core/scheduler/fold.ts')
  const events = [
    ...gatePrefix(['verify']),
    { seq: 5, ts: 6, actor: 'human', type: 'task.gate.result', payload: {
      teamId: 't1', taskId: 'task-1', gate: 'verify', verdict: 'pass', forcedBy: 'human', reason: '预算用尽人工放行',
    } },
  ]
  const task = foldEvents('t1', events as never).tasks['task-1'] as any
  assert.equal(task.gateResults.verify.forcedBy, 'human', '人工强制放行必须可追溯（否则「过了」和「人放的」分不清）')
  assert.equal(task.gateResults.verify.verdict, 'pass')
})

test('t78-11: gateResults 只在真的落 task.gate.result 时出现（没裁决过就是 undefined，不造假）', async () => {
  const { foldEvents } = await import('../src/core/scheduler/fold.ts')
  const task = foldEvents('t1', gatePrefix(['review']) as never).tasks['task-1'] as any
  assert.equal(task.state, 'gate:review')
  assert.equal(task.gateResults, undefined, '还没裁决 → 不能有 gateResults（空对象也是造假）')
})

/* ── 5. M2-F 收口：create-role 技能的「记忆与汇报机制」──────────── */

test('t78-12 (M2-F): create-role 技能补「记忆与汇报机制」——FR-6.1 证据强制 + FR-5.0 证据块', async () => {
  const { CAPTAIN_SKILLS } = await import('../src/core/roles/captain-skills.ts')
  const createRole = CAPTAIN_SKILLS.find((skill: { name: string }) => skill.name === 'create-role')
  assert.ok(createRole, 'create-role 技能必须存在')
  const body = String((createRole as { content?: string }).content ?? '')
  // 记忆区（FR-6.1）
  assert.ok(body.includes('记忆与汇报机制'), '要有独立段（不写成员就各自发挥）')
  assert.ok(body.includes('memory.md'), '要说明记忆区落在哪')
  assert.ok(body.includes('Verification evidence'), '证据强制：无证据的记忆会被 memory.audit 记账')
  assert.ok(body.includes('什么值得记'), '要给出「记什么/不记什么」的判据（否则退化成第二份日志）')
  // 汇报机制（FR-5.0）
  assert.ok(body.includes('myteam_submit_done'), 'done 申报必须带证据块')
  assert.ok(body.includes('filesTouched'), '改了文件要带 filesTouched')
  assert.ok(body.includes('escalate'), 'escalate 时机要写清（不是遇到阻力就报）')
  assert.ok(body.includes('proposal'), '提案通道要提到（切分不合理时提 split/rescope）')
  // 反面：不能鼓励「没有拒绝词就算通过」
  assert.ok(body.includes('禁止'), '必须明确禁止「没有出现拒绝词就认为通过」')
})
