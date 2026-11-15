/**
 * T13 Remote service 测试（ADR-006：读盘真相 + 唯一写入口走账本管线）。
 * 覆盖：getBoard/getInbox/getTaskDetail 读投影、planAction 三动作（discard 两段确认）、
 * postComment actor=human 留痕、disband 影响面确认、错误路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'

function makeRuntime(root: string) {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

function setup(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const remote = new MyTeamRemote(rt, host)
  return { host, remote }
}

/** 建团队 + 一任务 + 一成员（active 态） */
async function seedActiveTeam(host: MyTeamHost, remote: MyTeamRemote) {
  const task = {
    title: '实现X', description: 'd', acceptanceCriteria: ['AC1'],
    deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
    deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
  }
  host.executeLeadTool('myteam_submit_plan', { teamId: 'default', teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {})
  await remote.planAction({ teamId: 'default', action: 'approve' })
  const cr = host.executeLeadTool('myteam_create_task', { teamId: 'default', task }, {}) as any
  return { taskId: cr.taskId as string }
}

test('t13r-1: getBoard 返回列=阶段（config 驱动）+ 看板只读投影', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r-'))
  try {
    const { remote } = setup(root)
    const r = await remote.getBoard({})
    assert.equal(r.teamId, 'default')
    assert.deepEqual(r.board.columns.map((c: any) => c.name), ['backlog', 'ready', 'running', 'gates', 'done'])
    assert.equal(r.config.warnings.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-2: 暂存横幅 getInbox.staged（draft 态）→ planAction approve → 横幅消失', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r2-'))
  try {
    const { host, remote } = setup(root)
    host.executeLeadTool('myteam_submit_plan', { teamId: 'default', teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {})
    const inbox1 = await remote.getInbox({})
    assert.ok(inbox1.inbox.staged, 'draft 态显示横幅')
    const act = await remote.planAction({ teamId: 'default', action: 'approve' })
    assert.equal(act.status, 'approved')
    const inbox2 = await remote.getInbox({})
    assert.equal(inbox2.inbox.staged, null, 'approve 后横幅消失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-3: discard 两段确认——无 confirm 拒绝，confirm=true 执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r3-'))
  try {
    const { host, remote } = setup(root)
    host.executeLeadTool('myteam_submit_plan', { teamId: 'default', teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {})
    const first = await remote.planAction({ teamId: 'default', action: 'discard', confirm: false })
    assert.equal(first.status, 'confirm-required')
    const second = await remote.planAction({ teamId: 'default', action: 'discard', confirm: true })
    assert.equal(second.status, 'discarded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-4: postComment 以 actor=human 落账本并进任务 thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r4-'))
  try {
    const { host, remote } = setup(root)
    const { taskId } = await seedActiveTeam(host, remote)
    const r = await remote.postComment({ teamId: 'default', taskId, content: '人工补充口径' })
    assert.equal(r.status, 'sent')
    const detail = await remote.getTaskDetail({ teamId: 'default', taskId })
    assert.ok(detail.detail.messages.some((m: any) => m.actor === 'human'), 'human 留痕进 thread')
    // 账本验证 actor
    const ledger = readFileSync(join(root, '.dsh-myteam', 'tasks', 'default', 'ledger.jsonl'), 'utf8')
    const events = ledger.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const msg = events.filter((e) => e.type === 'message.sent').pop()
    assert.equal(msg.actor, 'human')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-5: disband 两段确认带影响面；getTaskDetail 不存在任务报 MT_VALIDATION', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r5-'))
  try {
    const { host, remote } = setup(root)
    await seedActiveTeam(host, remote)
    const first = await remote.disband({ teamId: 'default', confirm: false })
    assert.equal(first.status, 'confirm-required')
    assert.ok(first.impact && typeof first.impact.tasks === 'number', '影响面含任务数')
    const bad = await remote.getTaskDetail({ teamId: 'default', taskId: 'task-99' })
    assert.equal(bad.status, 'error')
    assert.equal(bad.code, 'MT_VALIDATION')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-6: getTokens 返回侧车四桶视图', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r6-'))
  try {
    const { remote } = setup(root)
    const r = await remote.getTokens({})
    assert.equal(r.status, 'ok')
    assert.ok(r.tokens.totals !== undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-7: Remote 方法标记描述符（version 1 + direct invocation，gateway 发现协议）', async () => {
  const desc = (MyTeamRemote.prototype as Record<string, any>)['@deepseek-ai/dsh-typert-protocol/remote-methods']
  assert.ok(desc, 'marker descriptor present on own prototype')
  assert.equal(desc.version, 1)
  const names = desc.methods.map((m: any) => m.method)
  assert.deepEqual(names, ['getBoard', 'getTaskDetail', 'getTokens', 'getInbox', 'getAudit', 'getConfig', 'saveTeamConfig', 'resetTeamConfig', 'getPlanFeedback', 'getTaskGraph', 'listSkills', 'listMembers', 'copyTeam', 'publishTeam', 'exportTeam', 'importTeam', 'createSkill', 'createTool', 'readSessionHistory', 'getPresets', 'planAction', 'postComment', 'memberOp', 'disband', 'createTask', 'createTasks', 'updateTask', 'assignTask', 'participateTask', 'rescopeTask', 'cancelTask', 'deleteTask', 'batchTaskOp', 'reviewTask', 'getArchive', 'getArchives', 'adoptKnowledge', 'roleOp', 'applyRoles', 'handoff', 'getContributions', 'reloadContributions'])
  assert.ok(desc.methods.every((m: any) => m.invocation.kind === 'direct'))
})

test('t13r-8: getAudit 账本事件流新→旧分页；getConfig 生效配置 + 来源链', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r8-'))
  try {
    const { host, remote } = setup(root)
    await seedActiveTeam(host, remote)

    const first: any = await remote.getAudit({ limit: 2 })
    assert.equal(first.status, 'ok')
    assert.ok(first.total >= 3, '种子账本至少有 team.created/plan/task 事件')
    assert.equal(first.events.length, 2)
    assert.ok(first.events[0].seq > first.events[1].seq, '新→旧')
    assert.ok(first.nextBeforeSeq, '还有更早事件')

    const older: any = await remote.getAudit({ limit: 100, beforeSeq: first.nextBeforeSeq })
    assert.ok(older.events.length > 0)
    assert.ok(older.events[0].seq < first.nextBeforeSeq, '游标之前的页')

    const cfg: any = await remote.getConfig({})
    assert.equal(cfg.status, 'ok')
    assert.equal(cfg.source, 'default')
    assert.deepEqual(cfg.config.board.columns, ['backlog', 'ready', 'running', 'gates', 'done'])
    assert.equal(cfg.config.limits.maxMembers, 6)
    assert.deepEqual(cfg.chain.map((c: any) => c.layer), ['default', 'project', 'team'])
    assert.equal(cfg.chain.find((c: any) => c.layer === 'team').active, false)

    const presets: any = await remote.getPresets({})
    assert.equal(presets.status, 'ok')
    assert.ok(presets.entries.some((entry: any) => entry.origin === 'builtin' && entry.definition.id === 'starter-team'))
    assert.equal(presets.entries.find((entry: any) => entry.definition.id === 'starter-team').definition.members.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t13r-9: getConfig.runtime.builtinToolsHide —— 实际生效的隐藏状态（R41-③ / CHG-170）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't13r9-'))
  try {
    /* ① 默认 rt（restrict 存在、schemas() 为空 → 名单视为全已知）：9/9 生效 */
    {
      const { remote } = setup(root)
      const cfg: any = await remote.getConfig({})
      const hide = cfg.runtime?.builtinToolsHide
      assert.ok(hide, 'getConfig 附 runtime.builtinToolsHide')
      assert.equal(hide.enabled, true)
      assert.equal(hide.restricted, true)
      assert.equal(hide.configured.length, 9, 'configured = 完整名单')
      assert.equal(hide.effective.length, 9, 'schemas() 为空 → 全名单生效')
      assert.ok(hide.effective.every((n: string) => hide.configured.includes(n)), 'effective ⊆ configured')
    }
    /* ② 宿主没有 tools.restrict：restricted=false、effective=[]（诚实降级，不假装生效） */
    {
      const rt = makeRuntime(root) as any
      delete rt.tools.restrict
      const host = new MyTeamHost(rt)
      host.initialize()
      const remote = new MyTeamRemote(rt, host)
      const hide = (await remote.getConfig({})).runtime.builtinToolsHide
      assert.equal(hide.restricted, false)
      assert.deepEqual(hide.effective, [], '没执行 restrict → 生效清单为空')
      assert.equal(hide.configured.length, 9, 'configured 仍列完整名单')
    }
    /* ③ 宿主 schemas() 只认识部分名单（CHG-58 语义）：只 deny 宿主真正存在的名字 */
    {
      const rt = makeRuntime(root) as any
      rt.tools.schemas = () => [{ name: 'spawn_teammate' }, { name: 'bash' }]
      const host = new MyTeamHost(rt)
      host.initialize()
      const remote = new MyTeamRemote(rt, host)
      const hide = (await remote.getConfig({})).runtime.builtinToolsHide
      assert.deepEqual(hide.effective, ['spawn_teammate'], 'effective 只含宿主全局工具集里真实存在的')
      assert.equal(hide.restricted, true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
