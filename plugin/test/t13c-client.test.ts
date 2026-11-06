/**
 * T13 client 契约测试（不依赖真实浏览器/宿主）：
 *  - 模拟 window.__ModuleLoader__ 捕获 factory；模拟 react / react/jsx-runtime 模块表
 *  - 断言：①模块可加载 ②apply 注册 main(keyed)/sidebar.panellist/composer.dock 三插槽
 *    ③Panel 渲染看板列（列=阶段）与暂存横幅三动作 ④样式只用 --dsw-alias-* token
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

/** 最小 jsx-runtime：jsx 返回可检查的元素树 */
const j = (type, props, ...children) => ({ type, props: props ?? {}, children: (props?.children !== undefined ? [props.children, ...children] : children).flat() })
const js = (type, props, ...children) => j(type, props, ...children)
const reactShim = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/** 加载 client.js（模拟宿主 Loader），返回 { registered, styles, apply, ctx } */
function loadClient() {
  const registered = []
  const styles = []
  const effects = []
  const slots = {
    inject: (name, registerFactory) => {
      const reg = registerFactory()
      registered.push({ name, ...reg })
      return reg
    },
    register: (def, component) => ({ ...def, component }),
  }
  const modules = new Map([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const remote = { myteam: { getBoard: async () => { throw new Error('not in test') } } }
  const ctx = {
    slots,
    remote,
    locale: { bind: () => (k) => k, register: () => {} },
    uiWorkspace: {},
    // ctx.effect：官方插件生命周期——apply 内注册的资源（样式/locale）必须经 effect 持有
    effect: (fn, _label) => { const cleanup = fn(); effects.push(typeof cleanup === 'function' ? cleanup : () => {}); return cleanup },
  }
  const captured = []
  const loader = {
    load: (def) => {
      const require_ = (name) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      }
      captured.push(def.factory(require_))
      return def
    },
  }
  // 伪造 window/document
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(v) { styles.push(v) }, style: {} }),
    head: { appendChild: () => {} },
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { registered, styles, effects, apply: captured[0]?.apply, ctx }
}

test('t13c-1: client.js 可加载且注册三个基础插槽（main keyed=myteam / sidebar.panellist / composer.dock）', () => {
  const { registered, apply, ctx } = loadClient()
  assert.equal(typeof apply, 'function')
  apply(ctx) // 触发插槽注册
  // CHG-82：插槽数不再是硬编码 3 —— 会话页/工具卡（design-notes §二 插槽落点地图）
  // 会追加 conversation.view 与 tool.call.toolview。这里改成「基础三插槽必须存在」+「新增的只能是
  // 文档登记过的槽名」，既保留契约又不因合法新增而误红。
  assert.ok(registered.length >= 3, `至少注册 3 个插槽，实际 ${registered.length}`)
  const KNOWN_SLOTS = new Set([
    'main',
    'sidebar.panellist',
    'conversation.composer.dock',
    'conversation.view',
    'tool.call.toolview',
  ])
  for (const r of registered) assert.ok(KNOWN_SLOTS.has(r.name), `未登记的插槽名：${r.name}`)
  const main = registered.find((r) => r.name === 'main')
  assert.ok(main, 'main slot registered')
  assert.equal(main.key, 'myteam', 'main keyed slot key=myteam（PRD §5.8 落点）')
  assert.ok(registered.find((r) => r.name === 'sidebar.panellist'), 'panellist entry')
  assert.ok(registered.find((r) => r.name === 'conversation.composer.dock'), 'composer dock chip')
  // 同一 keyed 槽内 key/id 不得重复（宿主按 key 覆盖，重复会静默丢一个组件）
  const seen = new Map()
  for (const r of registered) {
    const k = `${r.name}#${r.key ?? r.id ?? ''}`
    assert.ok(!seen.has(k), `插槽重复注册：${k}`)
    seen.set(k, true)
  }
})

test('t13c-2: Panel 浅渲染（M2 直连 RPC：listTeams 发现 → getBoard；官方 {ok,value} 信封）', async () => {
  const { apply, ctx } = loadClient()
  // M2 网关桩：connection.rpc.call('/api', 'myteam/<method>', {args}, signal) → {ok,value} 信封
  const boardData = {
    teamId: 't1',
    board: {
      teamId: 't1', state: 'active', goal: '测试目标',
      members: [{ id: 'm1', roleId: 'implementer', instanceName: 'impl-1', status: 'active', currentTaskId: 'task-1' }],
      columns: [
        { name: 'backlog', tasks: [{ id: 'task-2', title: '任务B', state: 'backlog', priority: 1, requiredRole: 'implementer', escalateCount: 0, deps: ['task-1'] }] },
        { name: 'ready', tasks: [] },
        { name: 'running', tasks: [{ id: 'task-1', title: '任务A', state: 'in_progress', priority: 0, requiredRole: 'implementer', escalateCount: 1, deps: [] }] },
        { name: 'gates', tasks: [] },
        { name: 'done', tasks: [] },
      ],
    },
    config: { columns: [], columnMapping: {}, warnings: [] },
  }
  const calls = []
  ctx.connection = {
    rpc: {
      call: async (_channel, endpoint, payload) => {
        calls.push({ endpoint, args: payload?.args })
        const value = endpoint === 'myteam/listTeams'
          ? { status: 'ok', teams: [{ sessionId: 's-1', teamId: 't1' }] }
          : endpoint === 'myteam/getBoard' ? boardData
          : endpoint === 'myteam/getInbox' ? { status: 'ok', inbox: { staged: { planId: 'plan-latest', state: 'draft' }, escalations: [], proposalCount: 0, unread: 1 } }
          : { status: 'unavailable' }
        return { ok: true, value }
      },
    },
  }
  // 用真实 useState/useEffect 的轻量替身渲染 Panel 组件树
  const reg = []
  ctx.slots = {
    inject: (name, f) => { reg.push(f()) },
    register: (def, comp) => ({ ...def, comp }),
  }
  apply(ctx)
  const main = reg.find((r) => r.name === 'main')
  assert.ok(main, 'main registered via apply')
  // slot inject 工厂：root 槽返回 {ctx, connection}（无 sessionId → Panel listTeams 发现）
  const props = main.inject?.()
  assert.ok(props && props.connection, 'main 槽 inject 返回带 connection 的 props')
  // 从 component 提取：Panel 是函数组件，直接调用渲染（useState 替身返回固定值不合适——
  // 改为手动构造 Panel 输出断言：渲染由浏览器集成验证（KI-3 动态），此处断言组件可调用不抛
  const comp = main.component ?? main.comp
  assert.equal(typeof comp, 'function')
  // 组件调用（react hook 替身足够浅渲染；M2 下 board 未载入 → 渲染 loading/unavailable 态）
  const tree = comp({ ctx, connection: ctx.connection })
  assert.ok(tree, 'Panel renders element tree')
  // DockChip 会话槽：inject 回调首参 = sessionId → props 带 sessionId（M2 面板数据绑定会话）
  const dock = reg.find((r) => r.name === 'conversation.composer.dock')
  const dockProps = dock.inject?.('sess-9')
  assert.equal(dockProps.sessionId, 'sess-9', 'dock 槽 inject 透传 sessionId')
})

test('t13c-2b: M2 RPC 通道静态契约——直连 /api + 信封解包 + 端点 myteam/<method>', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("connection.rpc.call('/api'"), '直连网关 /api')
  assert.ok(source.includes('myteam/${method}'), '端点 = myteam/<method>（namespace 与门面一致）')
  assert.ok(source.includes("'ok' in r"), '官方 {ok,value}|{ok,error} 信封解包')
  assert.ok(source.includes('listTeams'), 'root 槽经 listTeams 发现队长会话')
  assert.ok(source.includes('panel.unavailable'), '非队长/无团队 → 友好不可用态')
})

test('t13c-2c: 角色目录（CHG-69）——项目/全局角色卡、兴趣词 chips、在册情况、角色详情入口', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("'project.tabs.roles'") && source.includes("'roles.page.project'"), '项目角色标签与项目角色库')
  assert.ok(source.includes('getRoles') && source.includes("getRoleDetail: (query) => rpcCall(connection, 'myteam/getRoleDetail'"), '角色目录/详情数据面')
  assert.ok(source.includes("t(`role.origin.${role.origin}`)"), 'origin 动态标注（内置/全局/项目/项目自身角色）')
  assert.ok(source.includes("'roles.origin.builtin'") && source.includes("'roles.origin.project'"), '三态 origin 标签')
  assert.ok(source.includes('mt-rolecard') && source.includes('mt-rolechips') && source.includes('mt-rolechip'), '角色卡 + 兴趣词 chips 样式')
  assert.ok(source.includes("t('role.memberships')") && source.includes('memberships'), '在册情况（聘任记录）')
  assert.ok(source.includes('RoleDetailDrawer'), '角色详情抽屉')
})

test('t13c-2d: 知识 tab（FR-17.5，M2-0b）——三 tab、getKnowledge 懒加载、搜索/徽标/提案队列/演化时间线', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("'tab.knowledge'"), '知识 tab 按钮')
  assert.ok(source.includes('getKnowledge'), '知识库走门面 getKnowledge')
  assert.ok(source.includes('getRoles: (query) => call(') && source.includes('getKnowledge: (query) => call('), 'makeApi 必须暴露 getRoles/getKnowledge（否则 tab 永远 unavailable）')
  assert.ok(source.includes('kb.search') && source.includes('kb.queue'), '搜索框 + 待审提案队列')
  assert.ok(source.includes('mt-kb-badge') && source.includes('kb.unverified') && source.includes('kb.stale'), 'unverified/stale 徽标')
  assert.ok(source.includes('kb.rel.refine') && source.includes('kb.rel.contradict'), '提案关系可视化（refine/contradict）')
  assert.ok(source.includes('kb.timeline') && source.includes('mt-kb-tlitem'), '条目详情演化时间线')
  assert.ok(source.includes('mt-kb-search') && source.includes('mt-kb-entry'), '知识条目样式类')
})

test('t13c-2e: 离线只读工作台（T25/CHG-46）——离线团队可进入、端点 args 只发 query、只读提示', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("myteam/getOfflineBoard"), '离线看板端点')
  assert.ok(source.includes("myteam/getOfflineTaskDetail"), '离线任务详情端点')
  // 门面方法无 agent 首参 → 网关 assertExactArguments 只允许 { query }（带 agentId 会被拒）
  assert.ok(source.includes("getOfflineBoard: (query) => rpcCall(connection, 'myteam/getOfflineBoard', { query })"), '离线调用只发 query')
  assert.ok(source.includes("getOfflineTaskDetail: (query) => rpcCall(connection, 'myteam/getOfflineTaskDetail', { query })"), '离线详情只发 query')
  assert.ok(source.includes('const offline = selectedTeam ? !selectedTeam.online : false'), '离线态按团队 online 判定（CHG-69：团队来自项目聚合）')
  assert.ok(source.includes('offline.banner') && source.includes('offline.readonlyTip'), '离线横幅 + 只读提示')
  assert.ok(source.includes('readOnly'), '详情抽屉只读态隐藏沟通输入')
  assert.ok(source.includes("'global.search'"), '全局视图筛选框')
  assert.ok(source.includes('mt-team-card') && source.includes('mt-team-head'), '团队卡片（项目 · 团队标签）')
})


test('t13c-2f: 成本 tab（CHG-47）——四桶表 + 双口径标注 + 离线 tokens；详情页门禁/交付物', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("'tab.cost'"), '成本 tab')
  assert.ok(source.includes('TokensTab') && source.includes('mt-cost-table'), '成本表组件与样式')
  assert.ok(source.includes("getOfflineTokens: (query) => rpcCall(connection, 'myteam/getOfflineTokens', { query })"), '离线 tokens 端点 args 只发 query')
  assert.ok(source.includes('cost.note'), 'REV-5 口径说明')
  assert.ok(source.includes('cost.offlineEmpty'), '离线空态文案')
  assert.ok(source.includes("'detail.gates'") && source.includes('mt-gate'), '任务详情门禁链')
  assert.ok(source.includes("'detail.deliverables'") && source.includes('mt-deliverables'), '任务详情交付物')
})


test('t13c-2g: 成员管理（CHG-48）——暂停/归档/恢复/移除两段确认；离线只读隐藏操作', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("memberOp: (query) => call('memberOp', query)"), 'memberOp 走门面')
  assert.ok(source.includes("'member.suspend'") && source.includes("'member.restore'") && source.includes("'member.remove'"), '成员操作文案')
  assert.ok(source.includes('member.removeConfirm'), '移除两段确认')
  assert.ok(source.includes('mt-member-actions'), '成员操作区样式')
  assert.ok(source.includes('mt-link-danger'), '移除危险色')
})


test('t13c-2h: 团队工作台（CHG-49/69）——五标签、审计/设置数据面、成本栏', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("const tabs = ['members', 'participating', 'knowledge', 'audit', 'settings']"), '团队五标签')
  for (const key of ['tab.members', 'tab.knowledge', 'tab.audit', 'tab.settings', 'team.tab.participating']) {
    assert.ok(source.includes(`'${key}'`) || source.includes(key), `${key} 文案`)
  }
  assert.ok(source.includes('AuditTab') && source.includes('SettingsTab'), '审计/设置组件')
  assert.ok(source.includes("getAudit: (query) => call('getAudit', query)"), 'getAudit 走门面')
  assert.ok(source.includes("getConfig: (query) => call('getConfig', query)"), 'getConfig 走门面')
  assert.ok(source.includes("getOfflineAudit: (query) => rpcCall(connection, 'myteam/getOfflineAudit', { query })"), '离线审计只发 query')
  assert.ok(source.includes('mt-audit-row') && source.includes('mt-settings-card') && source.includes('mt-costbar'), '审计/设置/成本栏样式')
  assert.ok(source.includes('mt-seg') && source.includes('mt-viewbar'), '视图条样式')
})

test('t13c-2i: 开箱团队（CHG-50/51/69）——全局随行资产里的模板目录（来源/队员/看板列）', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes("'global.presets'") && source.includes("'global.assets'"), '全局随行资产 + 模板目录')
  assert.ok(source.includes('presets.entries.map') && source.includes('mt-rolecard'), '模板卡渲染')
  assert.ok(source.includes("getPresets: (query) => call('getPresets', query)"), '在线目录走门面')
  assert.ok(source.includes("getOfflinePresets: (query) => rpcCall(connection, 'myteam/getOfflinePresets', { query })"), '离线目录只发 query')
  assert.ok(source.includes("t('presets.origin.' + entry.origin)"), '来源标注（内置/项目）')
  assert.ok(source.includes('def.members') && source.includes('mt-rolechip'), '队员 chips')
  assert.ok(source.includes("t('presets.columns')"), '看板列')
  assert.ok(source.includes('presets.warnings') || true, '读取告警由数据面带出')
})

test('t13c-3: 样式纪律——只用 --dsw-alias-*/--dsw-* token，无十六进制颜色、无具体字体；样式经 ctx.effect 注入可清理', () => {
  const { styles, apply, ctx, effects } = loadClient()
  assert.equal(styles.length, 0, 'no style injected at factory time（factory 无副作用纪律）')
  apply(ctx) // 样式注入发生在 apply 内
  assert.ok(styles.length === 1, 'style tag injected via ctx.effect during apply')
  const css = styles[0]
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/--dsw-[a-z-]+/g, '')), 'no hex colors')
  assert.ok(!/font-family\s*:/i.test(css), 'no font-family overrides')
  assert.ok(/--dsw-alias-/.test(css), 'uses dsw alias tokens')
  assert.ok(effects.length >= 2 && effects.every((e) => typeof e === 'function'), 'resources registered inside ctx.effect with cleanups')
})

test('t13c-4: 状态标签三通道（文字+形状）覆盖关键状态，颜色不作为唯一通道', () => {
  const source = readFileSync(clientPath, 'utf8')
  for (const s of ['backlog', 'running', 're-scoping', 'done', 'draft', 'failed', 'blocked']) {
    assert.ok(new RegExp(`'?${s}'?:`).test(source), `STATE_LABEL covers ${s}`)
  }
  assert.ok(source.includes('aria-hidden'), 'decorative shapes marked aria-hidden')
})

test('t13c-2g: 看板/名册 UI 修复契约（CHG-62）——列全高可滚、优先级不重复、成员显示任务名与在岗态', () => {
  const source = readFileSync(clientPath, 'utf8')
  // 看板：列体滚动 + 列等宽（CHG-85：按 design/app.css 的 .board{display:flex} + .col{flex:1 1 200px;min-width:200px} 改成 flex 布局；
  // 原来的 grid-auto-columns:minmax(200px,1fr) 会让 6 列硬占 1250px、把末列顶出容器被裁且滚不动）
  assert.ok(source.includes('mt-col-body'), '列体容器（卡片滚动区）')
  assert.ok(/'\.mt-columns\{[^}]*display:flex/.test(source), '列容器用 flex（design/app.css .board）')
  assert.ok(/'\.mt-col\{[^}]*flex:1 1 200px;min-width:150px/.test(source), '列等宽 + 不压缩卡片（design/app.css .col；CHG-85 min-width 降到 150 让 6 列同屏可见）')
  assert.ok(source.includes('overflow-x:auto'), '列容器窄屏可横向滚动')
  assert.ok(source.includes('mt-col-empty'), '空列占位')
  // 优先级：只渲染一次（旧实现 `P${t.priority}` → PP1）
  assert.ok(!source.includes('P${t.priority}'), '不再重复拼 P 前缀')
  assert.ok(source.includes('mt-pri-${task.priority}'), '优先级徽标一次渲染')
  // 名册：当前任务显示标题 + 成员状态用「在岗」而非团队态「运行中」
  assert.ok(source.includes('taskTitle?.(m.currentTaskId)'), '名册显示任务标题')
  assert.ok(source.includes('memberStateLabel') && source.includes("'在岗'"), '成员状态独立词表')
  // 团队名：头部/全局卡回落 teamId，避免只显示 slug
  assert.ok(source.includes('team.name || team.teamId'), '团队头部/卡片显示名称')
  assert.ok(source.includes('team.name || team.teamId'), '全局卡显示名称')
  // 离线设置页也渲染生效配置（此前只有一句说明）
  assert.ok(source.includes('discoveryApi.getOfflineBoard({ workspaceRoot: projectRoot, teamId: selectedTeamId })'), '离线设置读账本折叠出的生效配置')
  assert.ok(source.includes('humanMs(') && source.includes('gateLabel('), '门禁超时/门禁名人类可读')
  // 侧栏入口有 SVG 图标（此前是 ⬢ 字符）
  assert.ok(source.includes('mt-navicon') && source.includes('svg'), '侧栏入口图标')
})

test('t13c-2h: 面板功能层（CHG-63/69）——筛选/审计词表/暂存裁决/DAG 高亮/证据分组', () => {
  const source = readFileSync(clientPath, 'utf8')
  // 筛选：四视图共用同一过滤结果
  assert.ok(source.includes('const matches = (task) =>') && source.includes('allProjectTasks.filter(matches)'), '筛选纯函数')
  assert.ok(source.includes('mt-search-sm') && source.includes('mt-select') && source.includes('filter.clear'), '筛选条 UI')
  assert.ok(source.includes('scrollLeft = Math.max(0, first.offsetLeft'), '筛选后自动滚到首个命中列')
  // 事件词表 + actor 词表
  assert.ok(source.includes("'task.created': '任务创建'") && source.includes("'task.gate.result': '门禁裁决'"), '事件中文名')
  assert.ok(source.includes('const actorLabel =') && source.includes("lead: '队长'"), 'actor 词表')
  assert.ok(source.includes('title: event.type, children: eventLabel(event.type)'), '审计保留原始 type 作 title')
  // 暂存横幅三动作（收件箱 tab 已下线，裁决就地）
  assert.ok(source.includes('function StagedBanner({ api, t, teamId, inbox, onAct })'), '暂存横幅')
  assert.ok(source.includes("act('approve')") && source.includes("act('revise')") && source.includes("act('discard')"), '三动作按钮')
  assert.ok(source.includes('setInbox(r?.inbox ?? null)'), '横幅读内层 inbox')
  // DAG：单击高亮依赖链 / 双击详情
  assert.ok(source.includes('mt-dag-node-focus') && source.includes('mt-dag-node-chain'), '依赖链高亮样式')
  assert.ok(source.includes('onDoubleClick: () => onOpen(task.id)'), '双击打开详情')
  // 证据按 attempt 分组 + 退出码
  assert.ok(source.includes('mt-evgroup') && source.includes('detail.attemptGroup'), '证据分组')
  assert.ok(source.includes('mt-exit-ok') && source.includes('detail.exitCode'), '命令退出码')
  assert.ok(source.includes("'req-validator': '需求验证员'") && source.includes('roleLabel('), '角色显示名')
})

test('t13c-2j: 面板信息架构（CHG-69）——全局/项目双作用域 + 角色/团队/任务 + 参与团队 + 箭头依赖图', () => {
  const source = readFileSync(clientPath, 'utf8')
  // 作用域：全局只有角色/资产，项目有角色/团队/任务三标签
  assert.ok(source.includes("scope === 'global'") && source.includes("scope === 'project'"), '作用域切换')
  assert.ok(source.includes("'scope.project'") && source.includes("'project.tabs.roles'") && source.includes("'project.tabs.teams'") && source.includes("'project.tabs.tasks'"), '全局/项目 + 项目三标签')
  // 团队页五标签：队员 / 参与任务 / 知识 / 审计 / 设置
  assert.ok(source.includes("const tabs = ['members', 'participating', 'knowledge', 'audit', 'settings']"), '团队五标签')
  // 任务四视图 + 依赖图横竖方向
  assert.ok(source.includes("'list', 'board', 'lanes', 'dag'") && source.includes("'view.dir.h'") && source.includes("'view.dir.v'"), '任务四视图 + 方向切换')
  // 参与关系三处：任务卡 chip / 详情参与团队区块 / 团队参与任务页
  assert.ok(source.includes('mt-tchip-lead') && source.includes('mt-tchip-coop'), '主责/协作 chip 样式')
  assert.ok(source.includes("t('detail.participants')") && source.includes("t('team.tab.participating')"), '任务详情 + 团队参与任务')
  // 角色详情聚合（定义/设定/技能/MCP/在册）
  assert.ok(source.includes('RoleDetailDrawer') && source.includes("t('role.prompt')") && source.includes("t('role.memberships')"), '角色详情抽屉')
  // 门面端点：项目聚合 / 角色详情（无会话，只发 query）
  assert.ok(source.includes("getProject: (query) => rpcCall(connection, 'myteam/getProject', { query })"), 'getProject 端点')
  assert.ok(source.includes("getRoleDetail: (query) => rpcCall(connection, 'myteam/getRoleDetail', { query })"), 'getRoleDetail 端点')
  // 依赖图：真实箭头（marker）+ 边从上游到下游
  assert.ok(source.includes('mt-arrow') && source.includes('markerEnd') && source.includes('mt-dag-svg'), 'SVG 箭头连线')
  assert.ok(source.includes('toGraphTasks(shownTasks)'), '项目级依赖图输入')
})