/**
 * CHG-89：把 CHG-86/87/88 之后仍然「服务端通了、面板点不到」的 3 个缺口接通，
 * 并把两条长期挂着的 P2 技术债（QA-1 中部坏行 / QA-3 task.created 语义偏差）**用真实入口锁死**。
 *
 * 为什么单开一个文件（而不是塞进 t71/t73/t74）：
 *  - 这三条的共同形态是「**端点存在、客户端零命中**」——契约测试必须同时盯
 *    服务端响应形状 **和** 客户端真的把参数发出去了，两边分开测都会漏；
 *  - QA-1 / QA-3 是**行为**而不是契约：只断言「有那个字符串」会让回归在无人察觉时复活。
 *
 * 纪律（沿用 t71 的教训）：门禁 / 调度 / 面板一律走真实入口
 * （`executeLeadTool` / `MyTeamPanelFacade` / `host.handoffTeam()`），不用 `host.commit()` 替身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamPanelFacade } from '../src/panel.ts'
import { openLedger, appendEvent } from '../src/core/ledger/ledger.ts'
import type { SessionHandoffCapability } from '../src/core/host/session-handoff.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')
const clientSource = readFileSync(clientPath, 'utf8')

/* ── mock loader：把 client.js 当浏览器模块加载，拿真实组件渲染出树 ──── */

const j = (type: any, props: any, ...children: any[]) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
const reactShim = {
  useState: (init: any) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
}

function loadClient() {
  const modules = new Map<string, unknown>([
    ['react/jsx-runtime', { jsx: j, jsxs: j }],
    ['react', reactShim],
  ])
  const ctx = {
    slots: { inject: (_name: string, registerFactory: () => unknown) => registerFactory(), register: (def: unknown) => def },
    remote: {},
    locale: { bind: () => (k: string) => k, register: () => {} },
    uiWorkspace: {},
    effect: (fn: () => unknown) => fn(),
  }
  const captured: any[] = []
  const loader = {
    load: (def: any) => {
      const require_ = (name: string) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      }
      captured.push(def.factory(require_))
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(_v: string) {}, style: {} }),
    head: { appendChild: () => {} },
  }
  const fn = new Function('window', 'document', clientSource)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { mod: captured[0], apply: captured[0]?.apply, ctx }
}

const textOf = (node: any): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
const collect = (node: any, out: any[] = []): any[] => {
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out)); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  ;(node.children ?? []).forEach((child: any) => collect(child, out))
  return out
}
const classOf = (node: any): string => String(node?.props?.className ?? '')
const G89 = () => {
  const { mod } = loadClient()
  assert.ok(mod?.__testG89, '__testG89 出口存在')
  return mod.__testG89
}
const t = (key: string) => key

/* ── 宿主桩 ─────────────────────────────────────────────────────── */

function makeRuntime(root: string, capability?: SessionHandoffCapability): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: (opts: { sessionId: string }) => ({ session: { id: opts.sessionId }, followup: () => {} }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: { root },
    ...(capability ? { get: (name: string) => (name === 'sessionController' ? capability : undefined) } : {}),
  } as unknown as HostRuntime
}

function setup(root: string, capability?: SessionHandoffCapability) {
  const host = new MyTeamHost(makeRuntime(root, capability))
  host.initialize()
  return host
}

function ledgerEvents(root: string, teamId: string): any[] {
  const path = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const TASK = (over: Record<string, unknown> = {}) => ({
  title: '任务', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md' },
  deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'], ...over,
})

function approvedTeam(root: string) {
  const host = setup(root)
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G',
    roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
    tasks: [],
  }, {}) as any
  assert.equal(sub.status, 'staged')
  const ap = host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {}) as any
  assert.equal(ap.status, 'approved')
  return { host, teamId: sub.teamId as string }
}

/* ── 1. 客户端 RPC 面：两个「服务端有、客户端零命中」的端点 ─────────── */

test('t75-1: makeApi 接上 roleOp（根级）+ handoff（会话门面）——此前 client 零命中', () => {
  // roleOp 是「只发 query」的根级端点（角色是配置资产，离线团队也能改）
  assert.match(
    clientSource,
    /roleOp: \(query\) => rpcCall\(connection, 'myteam\/roleOp', \{ query \}\)/,
    'roleOp 必须走根级 rpcCall（不带 agentId），否则离线团队改不了角色库',
  )
  // handoff 需要活动队长会话（摘要从投影 + 账本提取）
  assert.match(clientSource, /handoff: \(query\) => call\('handoff', query\)/, 'handoff 必须走会话门面端点')
})

/* ── 2. 乐观锁（QA-4 收尾）：面板真的把 expectedRevision 发出去了 ──── */

test('t75-2: 乐观锁 —— 编辑表单快照 revision，三处写调用都回传 expectedRevision', () => {
  // 两个打开编辑表单的入口（团队工作台 / 看板）都要快照 revision
  const snapshots = clientSource.match(/revision: detail\.revision,/g) ?? []
  assert.equal(snapshots.length, 2, '两个 openTaskEditor 入口都必须快照 detail.revision')

  // 表单里把它读出来（不是每次渲染重取，否则冲突检测失效）
  assert.match(
    clientSource,
    /const expectedRevision = typeof initial\?\.revision === 'number' \? initial\.revision : undefined/,
    'expectedRevision 必须来自打开表单时的快照',
  )
  // **每一条**写路径都要带（少一条就会有「某个入口能绕过乐观锁」的洞）。
  // 这是本测试最有价值的一条：初版只盯编辑表单，漏掉了任务详情页的「诊断一键修复」
  // （DiagFix 里的 assignTask / updateTask）——同一个洞开了第二个口。
  for (const method of ['updateTask', 'rescopeTask', 'assignTask']) {
    const needle = `api.${method}({`
    let index = clientSource.indexOf(needle)
    let sites = 0
    while (index >= 0) {
      const block = clientSource.slice(index, index + 500)
      assert.ok(
        block.includes('expectedRevision'),
        `${method} 的第 ${sites + 1} 个调用点必须回传 expectedRevision（偏移 ${index}）：\n${block.slice(0, 220)}`,
      )
      sites += 1
      index = clientSource.indexOf(needle, index + needle.length)
    }
    assert.ok(sites > 0, `没找到 api.${method} 调用点`)
  }
  // 冲突要给可操作提示（两侧版本号都显示），不能只说「保存失败」
  assert.match(clientSource, /const conflictText = \(r\) => t\('task\.revisionConflict'\)/)
  assert.ok(clientSource.includes("'task.revisionConflict'"), '缺冲突词条')
  assert.ok(clientSource.includes('{current}') && clientSource.includes('{snapshot}'), '冲突词条要带两侧版本号')
})

/* ── 3. 发布到全局（FR-13.1）：角色详情页的按钮 + 两段确认 ─────────── */

test('t75-3: 角色详情「发布到全局」—— 仅项目库来源可发布、两段确认、服务端 published 才提示', () => {
  assert.match(clientSource, /function RoleDetailDrawer\(\{[^}]*onPublish \}\)/, '抽屉必须接收 onPublish')
  assert.match(
    clientSource,
    /onPublish: openRoleEntry\?\.origin === 'project' \? \(confirm\) => publishRoleFlow\(/,
    '只有项目库来源才有发布语义（内置/全局是复制源，不是发布源）',
  )
  // 两段确认：先拿 impact（confirm=false），再 confirm:true
  assert.match(
    clientSource,
    /const result = await discoveryApi\.roleOp\(\{ workspaceRoot: projectRoot, op: 'publish', payload: \{ roleId \}, confirm \}\)/,
  )
  assert.match(clientSource, /if \(r\?\.status === 'confirm-required'\) \{ setPubImpact\(r\.impact \?\? \{\}\); return \}/)
  assert.match(clientSource, /if \(r\?\.status === 'published'\) \{ setPubImpact\(null\); return \}/)
  for (const key of ['role.publishBtn', 'role.publishConfirm', 'role.publishImpact', 'role.publishConfirmBtn', 'role.published']) {
    assert.ok(clientSource.includes(`'${key}'`), `缺词条 ${key}`)
  }
})

test('t75-3b: roleOp publish —— 两段确认 + 落全局库 + 内置 captain 拒发布（真实入口）', async () => {
  const root = mkdtempSync(join(tmpdir(), 't75-publish-'))
  // 通过面板门面走（workspaceRoot → 项目角色库 + 全局角色库）
  const facade = new MyTeamPanelFacade({ set: () => {}, get: () => undefined, workspace: { root } } as any)
  // 先落一个项目库角色
  const saved = (await (facade as any).roleOp({
    workspaceRoot: root, op: 'save', confirm: true,
    payload: { role: { id: 'publisher', name: '发布者', systemPrompt: 'p' } },
  })) as any
  assert.equal(saved.status, 'saved', '项目库角色保存成功')

  // 第一段：不带 confirm → 只回影响面，不落盘
  const ask = (await (facade as any).roleOp({ workspaceRoot: root, op: 'publish', payload: { roleId: 'publisher' } })) as any
  assert.equal(ask.status, 'confirm-required', '发布必须两段确认')
  assert.equal(ask.impact?.scope, 'global')
  assert.ok(String(ask.impact?.filePath ?? '').includes('publisher'), '影响面要指明目标文件')

  // 第二段：confirm:true → 真正写进全局库
  const done = (await (facade as any).roleOp({ workspaceRoot: root, op: 'publish', payload: { roleId: 'publisher' }, confirm: true })) as any
  assert.equal(done.status, 'published')
  assert.ok(existsSync(String(done.filePath)), `全局库文件应存在：${done.filePath}`)

  // 内置身份 captain 不能发布（名册「有且仅有一个队长」的锚点）
  const captain = (await (facade as any).roleOp({ workspaceRoot: root, op: 'publish', payload: { roleId: 'captain' }, confirm: true })) as any
  assert.equal(captain.status, 'error')
  assert.equal(captain.code, 'MT_ROLE_CAPTAIN')
})

/* ── 4. 会话移交（M2-E）：面板入口 + 两段确认 + 结果预览 ───────────── */

test('t75-4: 设置页「移交到新会话」—— 生命周期第三行、两段确认、结果带新 sessionId 与摘要', () => {
  assert.match(clientSource, /const \[handoffResult, setHandoffResult\] = react\.useState\(null\)/)
  assert.match(clientSource, /const askHandoff = \(\) => \{/, '第一段：只置确认态，不建会话')
  assert.match(
    clientSource,
    /const r = await makeApi\(connection, team\.sessionId\)\.handoff\(\{[\s\S]{0,120}sourceSessionId: team\.sessionId,/,
    '第二段：带 teamId + sourceSessionId 真建会话',
  )
  assert.match(clientSource, /row\('handoff', t\('settings\.handoffTitle'\)/, '生命周期区要有移交行')
  assert.match(clientSource, /handoffResult\?\.stage === 'confirm' \?/, '要有确认框')
  assert.match(clientSource, /handoffResult\?\.stage === 'done' \|\| handoffResult\?\.stage === 'partial' \?/, '要有结果框')
  // 「会话已建但注入失败」必须带 sessionId 让人能手动粘贴（不假装整体失败）
  assert.match(clientSource, /r\?\.sessionId \? \{ stage: 'partial', sessionId: r\.sessionId/, '注入失败要保住 sessionId')
  for (const key of ['settings.handoffTitle', 'settings.handoffConfirm', 'settings.handoffConfirmBtn', 'settings.handoffDone', 'settings.handoffPartial', 'settings.handoffFailed']) {
    assert.ok(clientSource.includes(`'${key}'`), `缺词条 ${key}`)
  }
})

/* ── 5. 词条对等（缺 en 会直接把 key 显示给英文用户）───────────────── */

test('t75-5: CHG-89 新词条 zh / en 全部对等（19 条）', () => {
  const zhStart = clientSource.indexOf("'settings.handoffTitle'")
  const enStart = clientSource.indexOf("'settings.handoffTitle'", zhStart + 1)
  assert.ok(zhStart > 0 && enStart > zhStart, 'zh / en 各有一处')

  const keys = [
    'settings.handoffTitle', 'settings.handoffSub', 'settings.handoffBtn', 'settings.handoffHint',
    'settings.handoffConfirm', 'settings.handoffConfirmBody', 'settings.handoffConfirmBtn',
    'settings.handoffDone', 'settings.handoffPartial', 'settings.handoffFailed',
    'role.published', 'role.publishBtn', 'role.publishHint', 'role.publishConfirm',
    'role.publishImpact', 'role.publishImpactNote', 'role.publishConfirmBtn', 'role.publishFailed',
    'task.revisionConflict',
  ]
  assert.equal(keys.length, 19)
  for (const key of keys) {
    const hits = clientSource.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh / en 各一条（实际 ${hits}）`)
  }
  // 占位符一致（zh 有的占位符 en 必须有，否则运行期显示 undefined）
  const ph = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  for (const key of keys) {
    const re = new RegExp(`'${key.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)'`, 'g')
    const all = [...clientSource.matchAll(re)].map((m) => m[1])
    assert.equal(all.length, 2, `${key} 要能取出两条文案`)
    assert.equal(ph(all[0]), ph(all[1]), `${key} 占位符不一致：${ph(all[0])} vs ${ph(all[1])}`)
  }
})

/* ── 6. QA-1：中部坏行（行为，不是字符串）──────────────────────────── */

test('t75-6: QA-1 中部坏行 —— 坏行之后的事件全部保留，重写后可继续追加（原缺陷是静默全丢）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't75-qa1-'))
  const path = join(dir, 'ledger.jsonl')
  const good = JSON.stringify({ seq: 0, ts: 1, actor: 'human', type: 'rules.version.adopted', payload: { version: 1 } })
  const second = JSON.stringify({ seq: 1, ts: 2, actor: 'human', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g' } })
  // QA 原始探针：中部坏行（其后仍有合法行）
  writeFileSync(path, `${good}\n${second.slice(0, 25)}\nnot-json\n`, 'utf8')

  const first = openLedger(path)
  assert.equal(first.events.length, 1, '只保留能解析的事件')
  assert.equal(first.truncated, 0, '中部坏行不是「尾部残行」')
  assert.equal(first.corrupted, 2, '两条坏行都要如实计数（loud 告警）')

  // 关键回归：重开 + 追加后，新事件**不能**被坏行带走
  appendEvent(path, { seq: first.nextSeq, ts: 3, actor: 'human', type: 'team.created', payload: { teamId: 't2', name: 'n2', goal: 'g2' } })
  const again = openLedger(path)
  assert.equal(again.events.length, 2, '坏行之后追加的事件必须能读回来（旧实现这里 events 仍是 1）')
  assert.deepEqual(again.events.map((e) => e.type), ['rules.version.adopted', 'team.created'])
  assert.equal(again.corrupted, 0, '重写后账本已干净')

  // seq 空洞要持续如实告警，但**不重编号**（seq 是账本身份，不是行号）
  writeFileSync(path, `${good}\nnot-json\n${second}\n`, 'utf8')
  const hole = openLedger(path)
  assert.equal(hole.events.length, 2, 'seq 空洞（无坏行残留）也不许丢事件')
  assert.equal(hole.events[1].seq, 1, 'seq 永不重编号')
})

/* ── 7. QA-3：编辑落 task.updated（行为）+ 乐观锁冲突零写入 ─────────── */

test('t75-7: QA-3 编辑 = task.updated（不是重复 task.created）且乐观锁冲突零写入', () => {
  const root = mkdtempSync(join(tmpdir(), 't75-qa3-'))
  const { host, teamId } = approvedTeam(root)
  const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK({ title: '原标题' }) }, {}) as any
  assert.equal(created.status, 'created')
  const taskId = created.taskId as string

  const before = ledgerEvents(root, teamId).length
  const edited = host.executeLeadTool('myteam_edit_task', { teamId, taskId, patch: { title: '新标题' } }, {}) as any
  assert.equal(edited.status, 'updated')
  const events = ledgerEvents(root, teamId)
  assert.equal(events.length, before + 1, '编辑只落一条事件')
  assert.equal(events.at(-1).type, 'task.updated', '编辑必须落 task.updated（旧实现落 task.created 造成同 taskId 重复「创建」）')
  assert.equal(events.filter((e) => e.type === 'task.created' && e.payload.taskId === taskId).length, 1, '同一个 taskId 只能有一条 task.created')

  // 乐观锁：基于过期版本的编辑必须「什么都没发生」
  const revision = (host.service(teamId).projectionSnapshot as any).revision
  assert.ok(typeof revision === 'number' && revision > 0)
  const stale = host.executeLeadTool('myteam_edit_task', { teamId, taskId, patch: { title: '过期版本改的' }, expectedRevision: revision - 1 }, {}) as any
  assert.equal(stale.status, 'error')
  assert.equal(stale.code, 'MT_REVISION_CONFLICT')
  assert.equal(stale.currentRevision, revision, '冲突要回显当前版本供用户重取')
  assert.equal(ledgerEvents(root, teamId).length, events.length, '冲突必须零写入（账本字节数不变）')

  // 版本正确时放行
  const ok = host.executeLeadTool('myteam_edit_task', { teamId, taskId, patch: { title: '正确版本改的' }, expectedRevision: revision }, {}) as any
  assert.equal(ok.status, 'updated')
  const after = host.service(teamId).projectionSnapshot.tasks[taskId] as any
  assert.equal(after.input.title, '正确版本改的')
})

/* ── 8. 移交的真实入口（面板门面）形态 ────────────────────────────── */

test('t75-8: 面板 handoff —— 无 sessionController → MT_UNAVAILABLE 且不抛；有 → ok + sessionId', async () => {
  const root = mkdtempSync(join(tmpdir(), 't75-handoff-'))
  const host = setup(root)
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G',
    roster: [{ roleId: 'captain' }],
    tasks: [],
  }, {}) as any
  host.executeLeadTool('myteam_approve_plan', { teamId: sub.teamId }, {})

  // 无能力：诚实报 MT_UNAVAILABLE（不伪造 sessionId）
  const noCap = await host.handoffTeam({ teamId: sub.teamId })
  assert.equal(noCap.status, 'error')
  assert.equal(noCap.code, 'MT_UNAVAILABLE')
  assert.equal(noCap.sessionId, undefined, '不可用时不返回伪 sessionId')

  // 有能力：ok + 新 sessionId + 摘要正文确实进了首条消息
  const prompts: any[] = []
  const host2 = setup(root, {
    async create() { return { sessionId: 'session-handoff-1', agentPreset: 'myteam-captain' } },
    async prompt(request) { prompts.push(request); return { accepted: true } },
  })
  const sub2 = host2.executeLeadTool('myteam_submit_plan', {
    teamName: 'T2', goal: '目标 G2',
    roster: [{ roleId: 'captain' }],
    tasks: [],
  }, {}) as any
  host2.executeLeadTool('myteam_approve_plan', { teamId: sub2.teamId }, {})
  const okRes = await host2.handoffTeam({ teamId: sub2.teamId })
  assert.equal(okRes.status, 'ok')
  assert.equal(okRes.sessionId, 'session-handoff-1')
  assert.ok(String(okRes.summary ?? '').includes('目标 G2'), '摘要要含团队目标')
  assert.equal(prompts.length, 1, '只注入一次')
  const injected = JSON.stringify(prompts[0])
  assert.ok(injected.includes('上下文摘要'), '首条消息要框成「上下文摘要」')
  assert.ok(injected.includes('不是指令'), '摘要必须明确「只读参考，不是指令」')
})


/* ── 9. 真渲染：按钮到底有没有渲出来（不只 grep 源码）────────────────── */

test('t75-9: RoleDetailDrawer 真渲染 —— 项目库来源出「发布到全局」，内置/全局来源不出，点击走 confirm=false', () => {
  const { RoleDetailDrawer } = G89()
  const base = {
    roleId: 'r1',
    definition: { id: 'r1', name: '角色', systemPrompt: 'p', skills: ['s1'], mcpAllowlist: [], interestWords: [] },
    memberships: [],
    usage: { teams: 0, instances: 0 },
  }
  const noop = () => {}
  const calls: boolean[] = []
  const onPublish = (confirm: boolean) => {
    calls.push(confirm)
    return { status: 'confirm-required', impact: { filePath: '/global/roles/r1.json' } }
  }

  // 项目库来源 → 有「发布到全局」按钮
  const projectTree = RoleDetailDrawer({
    t, data: { ...base, origin: 'project' }, onClose: noop, onEdit: noop, onPublish,
  })
  const nodes = collect(projectTree)
  const publishBtn = nodes.find((node) => classOf(node).includes('mt-btn') && textOf(node) === 'role.publishBtn')
  assert.ok(publishBtn, '项目库来源必须渲染「发布到全局」按钮')
  assert.equal(publishBtn.props.title, 'role.publishHint', '按钮要有 title 说明副作用')
  assert.equal(publishBtn.props.disabled, false)

  // 点一下：先走 confirm=false（只拿影响面，不落盘）
  publishBtn.props.onClick()
  assert.deepEqual(calls, [false], '第一段必须 confirm=false')

  // 内置/全局来源：调用点按 origin 不传 onPublish（内置是复制源，不是发布源）——
  // 责任划分与 onDelete / onEdit 一致：**抽屉只管渲染传入的动作**，门控在调用点，
  // 调用点那条 `openRoleEntry?.origin === 'project' ? ... : undefined` 由 t75-3 静态锁定。
  const builtinTree = RoleDetailDrawer({
    t, data: { ...base, origin: 'builtin' }, onClose: noop, onEdit: noop, onPublish: undefined,
  })
  assert.equal(
    collect(builtinTree).filter((node) => textOf(node) === 'role.publishBtn').length,
    0,
    '未传 onPublish 时不得渲出发布按钮（不出死按钮）',
  )

  // 没传 onPublish（全局页只读）→ 也不出
  const readOnlyTree = RoleDetailDrawer({ t, data: { ...base, origin: 'project' }, onClose: noop, onCopyToProject: noop })
  assert.equal(
    collect(readOnlyTree).filter((node) => textOf(node) === 'role.publishBtn').length,
    0,
    '未接线时不得出现死按钮',
  )
})

test('t75-10: TaskFormDrawer / DiagFix / RescopeDialog 真渲染不抛（编辑表单与诊断修复都带 revision 快照）', () => {
  const { TaskFormDrawer, DiagFix, RescopeDialog } = G89()
  const noop = () => {}
  const team = {
    teamId: 't1', name: 'T1', online: true, sessionId: 's1',
    members: [{ memberId: 'm1', roleId: 'implementer', instanceName: '实现者' }],
  }

  // 编辑态：initial 带 revision（表单会读成 expectedRevision）
  const editTree = TaskFormDrawer({
    t, mode: 'edit',
    teams: [team],
    tasks: [],
    initial: {
      id: 'task-1', ownerTeamId: 't1', ownerOnline: true, ownerSessionId: 's1',
      state: 'ready', revision: 7,
      input: { title: '标题', description: 'd', acceptanceCriteria: ['AC'], requiredRole: 'implementer', priority: 'P2', deps: [], deliverableSpec: { path: '' } },
      assignees: [], participants: [],
    },
    defaultTeamId: 't1', connection: {}, onClose: noop, onSaved: noop,
  })
  assert.ok(textOf(editTree).includes('task.formTitleEdit'), '编辑表单要渲出标题')

  // 诊断修复：assignable 分支渲按钮
  const diagTree = DiagFix({
    t, api: {}, teamId: 't1', taskId: 'task-1',
    diagnosis: { codes: ['no-role'], fix: { assignable: [{ memberId: 'm1', instanceName: '实现者' }], roleSwap: [] } },
    readOnly: false, onFixed: noop, expectedRevision: 7,
  })
  assert.ok(textOf(diagTree).includes('diag.fixAssign'), '一键指派按钮要渲出')

  // 重新规划对话框：理由输入框 + 提交按钮
  const rescopeTree = RescopeDialog({
    t, api: {}, teamId: 't1', taskId: 'task-1', title: '标题',
    input: { title: '标题', description: 'd', acceptanceCriteria: ['AC'], requiredRole: 'implementer' },
    members: team.members, tasks: [], expectedRevision: 7, onClose: noop, onDone: noop,
  })
  assert.ok(textOf(rescopeTree).includes('task.rescopeNeedReason') || collect(rescopeTree).some((node) => node?.type === 'textarea' || node?.type === 'input'), '重新规划对话框要可编辑理由')
})


/* ── 11. 插件贡献区块真渲染（CHG-91）────────────────────────────── */

test('t75-11 (CHG-91): ContributionsSection 真渲染 —— 首屏给 loading（不是空白），且不抛', () => {
  const { ContributionsSection } = G89()
  const noop = () => {}
  // mock react 的 useState 不触发重渲染，所以这里只断言「首屏是 loading 而不是空白/抛错」；
  // 有数据后的深度行为（插件名 / 只读徽标 / 告警红条）由 t77 走**真实宿主 + 真实端点**覆盖。
  const tree = ContributionsSection({
    t,
    api: { getContributions: async () => ({ status: 'ok', plugins: [], roles: [], teams: [], warnings: [], root: '/h/myteam/plugins' }) },
    workspaceRoot: '/w', onNotice: noop, onChanged: noop,
  })
  assert.ok(tree, '必须返回元素树（不能 null）')
  // CHG-93：加载中**渲染外壳 + loading 占位**（原来整块消失再出现 = 闪烁，且没有 id 锚点）
  const loadingText = textOf(tree)
  assert.ok(loadingText.includes('contrib.title'), '加载中也必须有标题（不能整块消失）')
  assert.ok(loadingText.includes('contrib.reload'), '加载中也要有「重新扫描插件」按钮')
  assert.ok(loadingText.includes('state.loading'), '内容区给 loading 占位')
  // 无 api（离线/未接线）也不抛
  assert.ok(ContributionsSection({ t, api: undefined, workspaceRoot: '/w' }), '无 api 时也要能渲染')
})

test('t75-12 (CHG-91): 插件贡献相关词条 zh / en 对等（16 条）', () => {
  const keys = [
    'contrib.title', 'contrib.desc', 'contrib.empty', 'contrib.reload', 'contrib.reloading',
    'contrib.reloaded', 'contrib.pluginCount', 'contrib.roles', 'contrib.teams', 'contrib.providedBy',
    'contrib.readonly', 'contrib.warnTitle', 'contrib.warnHint', 'contrib.ok', 'contrib.root',
    'role.origin.plugin',
  ]
  assert.equal(keys.length, 16)
  for (const key of keys) {
    const hits = clientSource.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh / en 各一条（实际 ${hits}）`)
  }
})

test('t75-13 (CHG-93): contributionsBody 三分支 —— 加载中外壳不闪 / 空态 / 有插件（角色只读徽标 + 模板名册）', () => {
  const { contributionsBody } = G89()
  const noop = () => {}

  // ① 加载中：仍渲染外壳（标题 + 重扫按钮 + 目录），内容给 loading
  const loadingTree = contributionsBody(t, undefined, { busy: false, onReload: noop })
  assert.ok(textOf(loadingTree).includes('contrib.title'), '加载中也必须有标题（不能整块消失）')
  assert.ok(textOf(loadingTree).includes('contrib.reload'), '加载中也要有「重新扫描插件」按钮')
  assert.ok(textOf(loadingTree).includes('state.loading'), '内容区给 loading 占位')

  // ② 空态：没有第三方插件贡献 —— 不是空白，是明确文案
  const emptyTree = contributionsBody(t, { status: 'ok', root: '/h/myteam/plugins', plugins: [], roles: [], teams: [], warnings: [] })
  assert.ok(textOf(emptyTree).includes('contrib.empty'), '空态必须有明确文案（空手等于没装）')

  // ③ 有插件：插件名 + 版本 + 角色 id + 只读徽标 + 模板名册
  const tree = contributionsBody(t, {
    status: 'ok', root: '/h/myteam/plugins', ok: true,
    plugins: [{ pluginId: 'acme-workflow', displayName: 'Acme 工作流插件', version: '1.0.0', namespace: 'acme', roles: ['acme-reviewer'], teams: ['acme-trio'], status: 'ok' }],
    roles: [{ id: 'acme-reviewer', name: 'Acme 复核', origin: 'plugin:acme-workflow' }],
    teams: [{ id: 'acme-trio', name: 'Acme 三人组', namespace: 'acme', members: [{ roleId: 'acme-reviewer' }, { roleId: 'acme-implementer' }] }],
    warnings: [],
  })
  const text = textOf(tree)
  assert.ok(text.includes('Acme 工作流插件'), '插件显示名')
  assert.ok(text.includes('acme-workflow · v1.0.0'), 'id + 版本')
  assert.ok(text.includes('acme-reviewer'), '角色 id（用户要能直接写进 roster）')
  assert.ok(text.includes('contrib.providedBy'), '「由插件 X 提供」溯源')
  assert.ok(text.includes('🔒'), '只读徽标')
  assert.ok(text.includes('acme-reviewer · acme-implementer'), '模板名册预览（建队向导要看「这个团队有谁」）')
  assert.ok(text.includes('contrib.root'), '贡献目录路径')
  // 只读徽标用 chip（不是普通文字）
  assert.ok(collect(tree).some((node) => classOf(node).includes('mt-chip-origin')), '只读徽标要有样式类')
})

test('t75-14 (CHG-93): contributionsBody 有 error 时红条 —— 列出每条 code 与修法（P4 大声）', () => {
  const { contributionsBody } = G89()
  const tree = contributionsBody(t, {
    status: 'ok', root: '/h/myteam/plugins', ok: false,
    plugins: [], roles: [], teams: [],
    warnings: [
      { level: 'error', code: 'MT_ROLE_CONTRIBUTION_CONFLICT', message: '角色 "implementer" 与内置角色冲突；请改用带前缀的 id' },
      { level: 'warn', code: 'MT_CONTRIBUTION_ORIGIN_STAMPED', message: 'origin 会被覆盖' },
    ],
  })
  const text = textOf(tree)
  assert.ok(text.includes('contrib.warnTitle'), '红条标题带 error 计数')
  assert.ok(text.includes('MT_ROLE_CONTRIBUTION_CONFLICT'), '必须显示错误码（用户拿去搜/提 issue）')
  assert.ok(text.includes('请改用带前缀的 id'), '必须带修法（只说「失败了」等于没说）')
  assert.ok(collect(tree).some((node) => classOf(node).includes('mt-error-banner')), '红条要有告警样式')
})

test('t75-15 (CHG-105): 贡献区块改为「每插件一张卡 + 卡内扁平行列表」——不再三层套嵌卡片', () => {
  const { contributionsBody } = G89()
  const tree = contributionsBody(t, {
    status: 'ok', root: '/h/myteam/plugins', ok: true,
    plugins: [{ pluginId: 'acme-review-kit', displayName: 'Acme 评审工具包', version: '1.0.0', namespace: 'acme', roles: ['acme-security-auditor'], teams: ['acme-review-squad'], status: 'ok' }],
    roles: [{ id: 'acme-security-auditor', name: '安全审计', origin: 'plugin:acme-review-kit' }],
    teams: [{ id: 'acme-review-squad', name: 'Acme 评审小队', namespace: 'acme', members: [{ roleId: 'acme-security-auditor' }, { roleId: 'reviewer' }] }],
    warnings: [],
  })
  const classes = collect(tree).flatMap((node) => classOf(node).split(/\s+/).filter(Boolean))
  const unique = new Set(classes)

  // ① 只有一层卡片：mt-sec 只出现在最外层 section 上（原实现内部还有两个 mt-sec 卡片）
  const secCount = classes.filter((cls) => cls === 'mt-sec').length
  assert.equal(secCount, 1, `mt-sec 只能出现一次（外层区块），实际 ${secCount} 次 —— 内部再套卡片就是三层边框`)
  // ② 行列表容器是扁平的 group，旧的带框列表容器必须消失
  assert.ok(unique.has('mt-contrib-group'), '角色/模板分组用 mt-contrib-group')
  assert.ok(!unique.has('mt-contrib-rolelist'), '不再使用带框的 rolelist 容器')
  assert.ok(!unique.has('mt-contrib-teamlist'), '不再使用带框的 teamlist 容器')
  // ③ 插件头一行放「名字 + id·版本 + 计数」，计数靠右
  assert.ok(unique.has('mt-contrib-plugin-head'), '插件头单独一行')
  assert.ok(unique.has('mt-contrib-counts'), '计数靠右（mt-contrib-counts）')
  // ④ 只读徽标是短标签 + title 承载完整说明（原实现长句直接铺满整行）
  const lock = collect(tree).find((node) => classOf(node).includes('mt-contrib-lock'))
  assert.ok(lock, '只读徽标要有 mt-contrib-lock（靠右不拉伸）')
  assert.ok(String(lock.props?.title ?? '').length > 10, '完整说明放 title（悬停可读，不占版面）')
  assert.equal(String(lock.children?.[0] ?? lock.children ?? ''), `🔒 ${t('contrib.readonly')}`, '徽标正文必须是短标签')
  // ⑤ 行内 id 用设计系统的 chip（不新增字体族覆盖）
  assert.ok(unique.has('mt-rolechip'), 'id 用既有 mt-rolechip')
  assert.ok(unique.has('mt-rolechip-mono'), 'id 用等宽数字 chip')
})
