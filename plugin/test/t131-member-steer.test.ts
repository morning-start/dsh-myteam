/**
 * T131 · A10（CHG-163）：成员菜单「指导（steer）」的**真写路径**。
 *
 * 缺陷现场（docs/14 §6.5 ③）：「指导」在成员菜单里可点，但 `memberOp` 的 op 枚举里没有 `steer`，
 * 点了只弹一句「请回团队模式会话」的说明——**UI 有、写路径没有**。FR-14.2 的指导档等于没实装。
 *
 * 本组用例钉住五件事（每一步都是「不假装成功」的一部分）：
 *  ① 在线成员：落 `message.sent`（`kind:'steer'` / `from:'human'` / `actor:'human'`）**并且**真的
 *     followup 投递出去（复用 `followupMessage` 的同一份构造，文本里带指导正文）；
 *  ② 边界：`content` 空 / 成员不存在 / 成员已 `removed`·`archived` → `MT_VALIDATION`，且**账本零写入**；
 *  ③ 成员会话不在线（无 handle）→ 账本照落、返回 `delivered:false` + `reason`——**不许假装送达**；
 *  ④ 成员在跑任务时自动带 `taskId`（成员要知道指导的是哪一单），显式 `taskId` 优先；
 *  ⑤ 门面（`MyTeamPanelFacade`）原样透传 `content` / `taskId`；客户端源码里 `delivered:false` 走
 *     警示分支、locale 中英成对、只读团队隐藏入口。
 *
 * 测试纪律：`DSH_HOME` 指到临时目录（否则会写用户真实 `~/.dsh/myteam/`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'

type LogEntry = { level: 'info' | 'warn'; msg: string }

/** 临时工作区 + 临时 DSH_HOME（清理必须还原 env，否则污染同进程其它用例） */
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
  return { root, home, cleanup }
}

function makeRuntime(root: string, agents: unknown, logs: LogEntry[] = []): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents,
    logger: {
      info: (msg: string) => { logs.push({ level: 'info', msg }) },
      warn: (msg: string) => { logs.push({ level: 'warn', msg }) },
    },
    workspace: { root },
  } as unknown as HostRuntime
}

/**
 * agents 桩：`create` 返回**在线** handle（followup 把消息收进 `followups`），
 * `get` 走 sessionId 查找表（冷启动重连用）。
 */
function agentsStub(followups: Record<string, unknown>[] = []) {
  const bySession = new Map<string, any>()
  return {
    bySession,
    followups,
    service: {
      create: (opts: { sessionId: string }) => {
        const handle = {
          session: { id: opts.sessionId },
          followup: (msg: unknown) => { followups.push(msg as Record<string, unknown>) },
        }
        bySession.set(opts.sessionId, handle)
        return handle
      },
      get: (sessionId: string) => bySession.get(sessionId),
    },
  }
}

/** 落一个 draft 团队（角色在 spawn 时自动复制进项目库），返回 teamId */
function stagedTeam(host: MyTeamHost, name: string): string {
  const staged = host.executeLeadTool('myteam_submit_plan', {
    teamName: name,
    goal: '指导档写路径用例',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(staged.status, 'staged', JSON.stringify(staged))
  return String(staged.teamId)
}

function ledgerOf(root: string, teamId: string): any[] {
  const raw = readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

function messagesOf(root: string, teamId: string): any[] {
  return ledgerOf(root, teamId).filter((event) => event.type === 'message.sent')
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务',
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [],
  requiredRole: 'implementer',
  priority: 'P2',
  gateChain: ['review'],
  ...over,
})

/** 建团队 + 建成一个**在线**成员（spawn 成功 = memberHandles 里有 handle） */
function teamWithLiveMember(root: string) {
  const agents = agentsStub()
  const host = new MyTeamHost(makeRuntime(root, agents.service), { dispatchTeamCooldownMs: 0, dispatchMemberCooldownMs: 0 })
  host.initialize()
  const teamId = stagedTeam(host, '指导档')
  const spawned = host.spawnMember(teamId, 'implementer') as any
  assert.equal(spawned.status, 'spawned', JSON.stringify(spawned))
  return { agents, host, teamId, memberId: String(spawned.memberId), sessionId: String(spawned.sessionId) }
}

/* ── 1. 在线成员：落账 + 真投递 ─────────────────────────────────── */

test('t131-1: 在线成员 steer —— 落 message.sent（kind=steer / from=human / actor=human）且真的 followup 投递', () => {
  const { root, cleanup } = tempWorkspace('myteam-t131-online')
  try {
    const { agents, host, teamId, memberId } = teamWithLiveMember(root)
    const before = agents.followups.length
    const r = host.memberOp(teamId, memberId, 'steer', false, { content: '  先补一个回归用例再改实现  ' }) as any

    assert.equal(r.status, 'steered', JSON.stringify(r))
    assert.equal(r.memberId, memberId)
    assert.equal(r.delivered, true, '有 handle 就必须真的投递出去')
    assert.equal(r.reason, undefined, '送达了就不该有未送达原因')

    const messages = messagesOf(root, teamId)
    assert.equal(messages.length, 1, '恰好一条 message.sent')
    const event = messages[0]
    assert.equal(event.actor, 'human', '面板操作由人发起')
    assert.equal(event.payload.teamId, teamId)
    assert.equal(event.payload.to, memberId)
    assert.equal(event.payload.from, 'human')
    assert.equal(event.payload.kind, 'steer')
    assert.equal(event.payload.content, '先补一个回归用例再改实现', 'content 两端去空白')
    assert.ok(String(event.payload.messageId ?? '').length > 0, 'message.sent 必须带 messageId（账本必填字段）')
    assert.equal(event.payload.taskId, undefined, '成员没在跑任务就不带 taskId')

    // 投递复用 followupMessage 的构造（FIX-16 形状）：role=user + content[0].text 带指导正文。
    // 注意 `message.sent` 提交后 `afterCommit` 还会按「消息类事件」再唤醒一次，所以这里按**文案**
    // 挑出 steer 那一条（不是按条数——条数会随唤醒管线的策略漂移）。
    const texts = agents.followups.map((msg: any) => String(msg?.content?.[0]?.text ?? ''))
    const steerTexts = texts.filter((text: string) => text.includes('队长消息（steer）'))
    assert.equal(steerTexts.length, 1, `恰好一条 steer 投递（实际 ${JSON.stringify(texts)}）`)
    const delivered = agents.followups[texts.indexOf(steerTexts[0])] as any
    assert.equal(delivered.role, 'user')
    assert.equal(delivered.source.kind, 'plugin:dsh-plugin-myteam')
    assert.ok(String(delivered.id ?? '').length > 0, 'FIX-16：followup 必须带 id（裸消息会建空 turn）')
    assert.match(steerTexts[0], /先补一个回归用例再改实现/)
  } finally {
    cleanup()
  }
})

/* ── 2. 边界：空 content / 成员不存在 / 终态 ────────────────────── */

test('t131-2: content 为空（空串 / 纯空白 / 缺省）——MT_VALIDATION(field=content)，账本零写入', () => {
  const { root, cleanup } = tempWorkspace('myteam-t131-empty')
  try {
    const { agents, host, teamId, memberId } = teamWithLiveMember(root)
    const before = messagesOf(root, teamId).length
    const followupsBefore = agents.followups.length

    for (const content of ['', '   ', '\n\t ', undefined, 42]) {
      const r = host.memberOp(teamId, memberId, 'steer', false, { content }) as any
      assert.equal(r.status, 'error', `content=${JSON.stringify(content)} 必须被拒`)
      assert.equal(r.code, 'MT_VALIDATION')
      assert.equal(r.field, 'content', '错误必须点名字段（面板据此高亮输入框）')
    }
    assert.equal(messagesOf(root, teamId).length, before, '拒绝 = 账本零写入')
    assert.equal(agents.followups.length, followupsBefore, '拒绝 = 一条消息都不投')
  } finally {
    cleanup()
  }
})

test('t131-3: 成员不存在 / 已 removed / 已 archived —— 拒绝并说清状态（MT_VALIDATION）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t131-terminal')
  try {
    const { agents, host, teamId, memberId } = teamWithLiveMember(root)

    const ghost = host.memberOp(teamId, 'no-such-member', 'steer', false, { content: 'hi' }) as any
    assert.equal(ghost.status, 'error')
    assert.equal(ghost.code, 'MT_VALIDATION')
    assert.match(String(ghost.message), /not found/)

    // removed 是终态：往已移除的成员会话投消息没有收件人
    const removed = host.memberOp(teamId, memberId, 'remove', true) as any
    assert.equal(removed.status, 'remove', JSON.stringify(removed))
    const afterRemove = host.memberOp(teamId, memberId, 'steer', false, { content: '还在吗' }) as any
    assert.equal(afterRemove.status, 'error')
    assert.equal(afterRemove.code, 'MT_VALIDATION')
    assert.match(String(afterRemove.message), /removed/, '文案必须点名状态，不能只说「失败」')

    // archived 同理（另建一个成员走归档路径）
    const second = host.spawnMember(teamId, 'implementer') as any
    assert.equal(second.status, 'spawned', JSON.stringify(second))
    const archived = host.memberOp(teamId, String(second.memberId), 'archive', false) as any
    assert.equal(archived.status, 'archive', JSON.stringify(archived))
    const afterArchive = host.memberOp(teamId, String(second.memberId), 'steer', false, { content: '还在吗' }) as any
    assert.equal(afterArchive.status, 'error')
    assert.equal(afterArchive.code, 'MT_VALIDATION')
    assert.match(String(afterArchive.message), /archived/)

    // 终态拒绝时也不许投递（成员会话可能还挂着，但语义上已不是「在岗成员」）
    assert.equal(agents.followups.filter((msg: any) => String(msg?.content?.[0]?.text ?? '').includes('还在吗')).length, 0)
  } finally {
    cleanup()
  }
})

/* ── 3. 会话不在线：账本照落 + delivered:false + 原因 ────────────── */

test('t131-4: 成员会话不在线（无 handle）——账本照落、delivered:false + reason（不假装送达）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t131-offline')
  try {
    const first = teamWithLiveMember(root)
    const { teamId, memberId } = first
    assert.ok(messagesOf(root, teamId).length === 0, '前置：还没有任何消息')

    // 模拟重启：新 host 实例，宿主 lookup 拿不到会话（成员会话真的不在线）
    const logs: LogEntry[] = []
    const restarted = new MyTeamHost(makeRuntime(root, { create: () => { throw new Error('no spawn here') }, get: () => undefined }, logs))
    const r = restarted.memberOp(teamId, memberId, 'steer', false, { content: '重启后还能看到吗' }) as any

    assert.equal(r.status, 'steered', '账本已落 → 状态必须是 steered（不是 error）')
    assert.equal(r.memberId, memberId)
    assert.equal(r.delivered, false, '没有 handle 就必须如实回报未送达')
    assert.match(String(r.reason ?? ''), /offline|no live handle/, '必须给未送达原因')
    // 账本确实落了：重启后重连/读账本都能看到这条指导
    const messages = messagesOf(root, teamId)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].payload.content, '重启后还能看到吗')
    assert.equal(messages[0].payload.kind, 'steer')
  } finally {
    cleanup()
  }
})

/* ── 4. 在跑任务自动带 taskId ───────────────────────────────────── */

test('t131-5: 成员在跑任务时自动带 taskId（显式 taskId 优先）', () => {
  const { root, cleanup } = tempWorkspace('myteam-t131-task')
  try {
    const { host, teamId, memberId, sessionId } = teamWithLiveMember(root)
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK() }, {}) as any
    assert.equal(created.status, 'created', JSON.stringify(created))
    const claimed = host.executeMemberTool(
      { memberId, roleId: 'implementer', instanceName: 'impl', sessionId, teamId },
      'myteam_claim_task',
      { taskId: created.taskId },
    ) as any
    assert.equal(claimed.status, 'claimed', JSON.stringify(claimed))
    assert.equal(host.service(teamId).projectionSnapshot.members[memberId].currentTaskId, created.taskId)

    // ① 没显式给 → 自动带成员当前任务
    const auto = host.memberOp(teamId, memberId, 'steer', false, { content: '按新的验收标准改' }) as any
    assert.equal(auto.status, 'steered')
    assert.equal(auto.taskId, created.taskId, '返回里要带 taskId')
    const autoEvent = messagesOf(root, teamId).at(-1)!
    assert.equal(autoEvent.payload.taskId, created.taskId, '账本里也要带（成员据此知道指导的是哪一单）')

    // ② 显式给了 → 用调用方的（例如指导的是另一单的上下文）
    const explicit = host.memberOp(teamId, memberId, 'steer', false, { content: '顺带看下另一单', taskId: 'task-explicit' }) as any
    assert.equal(explicit.taskId, 'task-explicit')
    assert.equal(messagesOf(root, teamId).at(-1)!.payload.taskId, 'task-explicit')
  } finally {
    cleanup()
  }
})

/* ── 5. 门面透传（content / taskId 不改写）──────────────────────── */

test('t131-6: 面板门面原样透传 content / taskId 给 remote（门面不改写载荷）', async () => {
  const calls: Record<string, unknown>[] = []
  const stubRemote = {
    memberOp: async (query: Record<string, unknown>) => {
      calls.push(query)
      return { status: 'steered', memberId: String(query.memberId), delivered: true }
    },
  }
  const agents = { list: () => [{ session: { id: 's-1' } }] }
  const facade = new MyTeamPanelFacade(
    { agents, agentPresets: { serviceFor: (_agent: unknown, name: string) => (name === 'myteam' ? stubRemote : undefined) } },
    { globalIndexPath: join(tmpdir(), `myteam-t131-facade-${process.pid}-${Date.now()}`, 'workspaces.json') },
  )
  const r = await facade.memberOp({ session: { id: 's-1' } } as any, {
    teamId: 't1',
    memberId: 'm1',
    op: 'steer',
    content: '带上下文',
    taskId: 'task-9',
  })
  assert.deepEqual(r, { status: 'steered', memberId: 'm1', delivered: true })
  assert.deepEqual(calls, [{ teamId: 't1', memberId: 'm1', op: 'steer', content: '带上下文', taskId: 'task-9' }], '载荷原样透传')
})

/* ── 6. 客户端契约：警示分支 + 双语 locale + 只读隐藏 ─────────────── */

test('t131-7: 客户端契约 —— delivered:false 走警示分支、steer locale 中英成对、只读团队隐藏入口', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

  assert.ok(source.includes("op: 'steer'"), '成员卡必须真的调 memberOp(op:steer)（不再是纯说明）')
  assert.ok(source.includes('delivered === false'), 'delivered:false 必须有独立分支')
  assert.ok(source.includes('mt-menu-steer-alert'), '未送达用警示样式（不是成功提示）')
  assert.ok(
    source.includes('border:.5px solid var(--dsw-alias-state-warning-primary)'),
    '警示样式只用项目 token（--dsw-alias-*），不许硬编码颜色',
  )

  // 只读团队隐藏「指导」（离线没有写路径，留着就是假按钮）
  assert.match(
    source,
    /readOnly \? null : item\('steer'/,
    'readOnly 时 steer 入口必须隐藏（而不是可点后失败）',
  )

  // 双语 locale：每个新键 zh / en 各一条
  for (const key of [
    'roster.menu.steer',
    'roster.menu.steerHint',
    'roster.menu.steerPlaceholder',
    'roster.menu.steerSend',
    'roster.menu.steerCancel',
    'roster.menu.steerSent',
    'roster.menu.steerUndelivered',
  ]) {
    const hits = source.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh / en 各一条（实际 ${hits}）`)
  }
  // 占位符一致（zh 有 {name} 的，en 也要有）
  const ph = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  for (const key of ['roster.menu.steerSent', 'roster.menu.steerUndelivered']) {
    const re = new RegExp(`'${key}': '((?:[^'\\\\]|\\\\.)*)'`, 'g')
    const all = [...source.matchAll(re)].map((m) => m[1])
    assert.equal(all.length, 2, `${key} 要能取出两条文案`)
    assert.equal(ph(all[0]), ph(all[1]), `${key} 占位符不一致：${ph(all[0])} vs ${ph(all[1])}`)
  }
})
