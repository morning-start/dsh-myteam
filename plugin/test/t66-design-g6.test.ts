/**
 * T66 · CHG-82 G6 设计稿对齐（design/new-team-1.html · new-team.html · tasks.html ·
 * team-tasks.html · conversation.html · guest.html）
 *
 * 自证方式（不依赖真实浏览器/宿主）：
 *  - 模拟 window.__ModuleLoader__ 捕获 factory；模拟 react / react/jsx-runtime 模块表（同 t13c）；
 *  - ①插槽：conversation.view（id=myteam/order/label）+ 4 个 tool.call.toolview（按 wire 工具名 keyed 注册）；
 *  - ②可渲染的组件（建团向导第 1 步 / 会话页团队视图 / 三张工具卡 / 注入卡 / 命令输入）逐块断言 class 与文案；
 *  - ③tasks（项目级任务列表）与 team-tasks（团队参与任务）在 Panel 内联，用源码级结构断言
 *    （含 class 与设计稿文案；Panel 的 root 槽需要真实会话，mock 下只浅渲染）；
 *  - ④样式纪律：G6 全部规则只用 --dsw-alias-* token，无十六进制色、无 font-family（t13c-3 同口径）；
 *  - ⑤zh/en 词条成对（g6.* 键集合一致，en 是兜底语言，漏 key 会显示 raw key）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

/** 最小 jsx-runtime：jsx/jsxs 返回可检查的元素树（子节点挂在 .children） */
const j = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
const js = (type, props, ...children) => j(type, props, ...children)
const reactShim = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/** 加载 client.js（模拟宿主 Loader），返回 { registered, styles, apply, ctx, module }
 *  t13c-1 起插槽数不再硬编码 3，这里按 name 取用。 */
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
  const ctx = {
    slots,
    remote: { myteam: { getBoard: async () => { throw new Error('not in test') } } },
    locale: { bind: () => (k) => k, register: () => {} },
    uiWorkspace: {},
    effect: (fn) => {
      const cleanup = fn()
      effects.push(typeof cleanup === 'function' ? cleanup : () => {})
      return cleanup
    },
  }
  let module
  const loader = {
    load: (def) => {
      const require_ = (name) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      }
      module = def.factory(require_)
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(v) { styles.push(v) }, style: {} }),
    head: { appendChild: () => {} },
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { registered, styles, effects, apply: module?.apply, ctx, module, source }
}

/** 收集元素树里所有 className（含复合类名，按 class 拆分）；type 是函数时按组件渲染再走 */
function collectClasses(tree, out = new Set()) {
  if (!tree || typeof tree !== 'object') return out
  if (typeof tree.type === 'function') return collectClasses(tree.type(tree.props ?? {}), out)
  const props = tree.props ?? {}
  if (typeof props.className === 'string') {
    for (const name of props.className.split(/\s+/)) if (name) out.add(name)
  }
  for (const child of tree.children ?? []) collectClasses(child, out)
  return out
}
/** 收集元素树里的纯文本（拼接）；type 是函数时按组件渲染再走 */
function collectText(tree, out = []) {
  if (tree === null || tree === undefined || tree === false) return out
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out }
  if (typeof tree !== 'object') return out
  if (typeof tree.type === 'function') return collectText(tree.type(tree.props ?? {}), out)
  for (const child of tree.children ?? []) collectText(child, out)
  return out
}

const PRESETS = {
  entries: [
    {
      origin: 'project',
      file: 'basic-dev.json',
      definition: {
        id: 'basic-dev', name: '基础开发团队', description: '标准三人组',
        members: [
          { roleId: 'captain', instanceName: 'captain' },
          { roleId: 'implementer', instanceName: 'implementer' },
          { roleId: 'reviewer', instanceName: 'reviewer' },
          { roleId: 'req-validator', instanceName: 'req-validator' },
        ],
        board: { columns: ['待规划', '就绪', '进行中', '门禁', '已完成'] },
      },
    },
    {
      origin: 'global',
      file: 'api-review.json',
      definition: {
        id: 'api-review', name: '接口评审团队',
        members: [{ roleId: 'captain', instanceName: 'captain' }, { roleId: 'api-reviewer', instanceName: 'api-reviewer' }],
        board: { columns: ['待规划', '评审中', '门禁', '已完成'] },
      },
    },
  ],
}
const ROLES = [
  { id: 'acceptor', name: '验收员', origin: 'builtin', description: '门禁终审与交付签收', model: { model: 'claude-opus-4.6' } },
  { id: 'tech-writer', name: '技术文档', origin: 'project', description: '迁移说明、README 与对外文档' },
]

test('t66-1: 插槽契约——conversation.view 团队视图 + 4 个 myteam_* 工具卡（tool.call.toolview 按 key 精确注册）', () => {
  const { apply, ctx, registered } = loadClient()
  apply(ctx)
  const names = registered.map((item) => item.name)
  for (const name of ['main', 'sidebar.panellist', 'conversation.composer.dock', 'conversation.view', 'tool.call.toolview']) {
    assert.ok(names.includes(name), `注册了 ${name}`)
  }
  const view = registered.find((item) => item.name === 'conversation.view')
  assert.equal(view.id, 'myteam', 'conversation.view 用 id 绑定')
  assert.equal(view.order, 20, 'conversation.view 有 order')
  assert.equal(typeof view.label, 'function', 'label 走 locale thunk')
  assert.equal(view.label(), '团队视图', 'label 文案')
  const toolKeys = registered.filter((item) => item.name === 'tool.call.toolview').map((item) => item.key)
  assert.deepEqual([...toolKeys].sort(), ['myteam_apply_roles', 'myteam_approve_plan', 'myteam_peer_message', 'myteam_plan_tasks'])
  for (const item of registered.filter((entry) => entry.name === 'tool.call.toolview')) {
    assert.equal(typeof item.component, 'function', `${item.key} 有可渲染组件`)
    assert.equal(typeof item.inject, 'function', `${item.key} 的 inject 拿 sessionId`)
  }
  const dock = registered.find((item) => item.name === 'conversation.composer.dock')
  assert.equal(dock.inject('sess-1').sessionId, 'sess-1', 'dock 槽透传 sessionId')
  assert.match(String(ctx.slots.inject), /function|\(name/, 'slots.inject 可用')
})

test('t66-2: 建团向导第 1 步（new-team-1）——四个单选项 + 名册预览 chips + 选中主色描边 + 管理预设库脚注', () => {
  const { module } = loadClient()
  const TeamCreateDrawer = module.__testG6?.TeamCreateDrawer
  assert.equal(typeof TeamCreateDrawer, 'function', '__testG6.TeamCreateDrawer 可渲染')
  const tree = TeamCreateDrawer({ t: (k) => k, ctx: {}, projectRoot: '/w', presets: PRESETS, roles: ROLES, onClose: () => {}, onManagePresets: () => {} })
  const classes = collectClasses(tree)
  for (const name of ['mt-wizard', 'mt-wizard-dialog', 'mt-wizard-head', 'mt-wizard-steprow', 'mt-steps', 'mt-step', 'mt-step-on', 'mt-step-sep', 'mt-wizard-title', 'mt-wizard-desc', 'mt-wizard-body', 'mt-wizard-foot', 'mt-wizard-actions', 'mt-opt-list', 'mt-opt', 'mt-opt-mark', 'mt-opt-main', 'mt-opt-title', 'mt-opt-sub', 'mt-src', 'mt-src-project', 'mt-src-global', 'mt-rosterline', 'mt-mini-chip', 'mt-mini-chip-lead', 'mt-mavatar', 'mt-mavatar-lead', 'mt-note', 'mt-note-info', 'mt-note-icon']) {
    assert.ok(classes.has(name), `第 1 步渲染出 .${name}`)
  }
  const text = collectText(tree).join('')
  // 设计稿文案：三个预设 + 一条「不套预设」兜底 + 脚注 + 下一步
  for (const copy of ['g6.wizard.title1', 'g6.step.preset', 'g6.step.roster', 'g6.step.goal', 'g6.wizard.noPreset', 'g6.wizard.managePresets', 'g6.wizard.nextRoster', 'g6.wizard.presetNote']) {
    assert.ok(text.includes(copy), `第 1 步文案含 ${copy}`)
  }
  // 四个单选项（两个预设 + 不套预设 = 3；预设数量以数据为准）
  const options = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.props?.role === 'radio' || node.props?.role === 'checkbox') options.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  assert.equal(options.length, PRESETS.entries.length + 1, '预设各一项 + 「不套预设」兜底一项')
  assert.equal(options.filter((item) => item.props['aria-checked'] === true).length, 1, '默认选中第一项（主色描边）')
})

test('t66-2b: 建团向导加载态（CHG-84）——presets 未就绪立刻出骨架；读取失败给重试 + 不套预设兜底', () => {
  const { module } = loadClient()
  const TeamCreateDrawer = module.__testG6.TeamCreateDrawer
  // ① 加载中（presets === undefined）：骨架 + 「正在加载预设…」+ 下一步禁用
  const loading = TeamCreateDrawer({ t: (k) => k, ctx: {}, projectRoot: '/w', presets: undefined, roles: [], onClose: () => {}, onManagePresets: () => {}, onRetryPresets: () => {} })
  const loadingClasses = collectClasses(loading)
  for (const name of ['mt-skeleton', 'mt-skeleton-cap', 'mt-skeleton-row', 'mt-skeleton-dot', 'mt-skeleton-lines', 'mt-skeleton-line']) {
    assert.ok(loadingClasses.has(name), `加载态渲染出 .${name}`)
  }
  const loadingText = collectText(loading).join('')
  assert.ok(loadingText.includes('g6.wizard.loadingPresets'), '加载态文案')
  assert.ok(!loadingText.includes('g6.wizard.noPreset'), '加载中不闪现空态选项（避免误以为没有预设）')
  const nextButton = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function') return walk(node.type(node.props ?? {}))
    const text = (node.children ?? []).filter((child) => typeof child === 'string').join('')
    if (node.type === 'button' && text === 'g6.wizard.nextRoster') nextButton.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(loading)
  assert.equal(nextButton.length, 1, '加载态有「下一步」按钮')
  assert.equal(nextButton[0].props.disabled, true, '加载中「下一步」禁用')
  // ② 读取失败（presets === null）：失败提示 + 重试 + 「不套预设」兜底可选
  const failed = TeamCreateDrawer({ t: (k) => k, ctx: {}, projectRoot: '/w', presets: null, roles: [], onClose: () => {}, onManagePresets: () => {}, onRetryPresets: () => {} })
  const failedClasses = collectClasses(failed)
  assert.ok(failedClasses.has('mt-note-warn'), '失败态用 warn 提示')
  const failedText = collectText(failed).join('')
  assert.ok(failedText.includes('g6.wizard.presetsFailed') && failedText.includes('g6.wizard.retry'), '失败文案 + 重试')
  assert.ok(failedText.includes('g6.wizard.noPreset'), '失败仍可「不套预设」兜底（不伪造预设数据）')
})

test('t66-3: 建团向导第 2/3 步（new-team）——已选角色带实例名 / 队长自动加入 / 从角色库补人 / 写目标', () => {
  const { source } = loadClient()
  // 步骤条：第 1 步完成态用 ✓（done），第 2 步 on
  assert.ok(source.includes('mt-step mt-step-done'), '完成态步骤')
  assert.ok(source.includes("'g6.wizard.title2'") && source.includes("'g6.wizard.title3'"), '第 2/3 步标题')
  assert.ok(source.includes("t('g6.wizard.selected').replace('{n}'") && source.includes("t('g6.wizard.cap').replace('{n}'"), '已选 N 名 / 上限 N 名')
  assert.ok(source.includes('instanceNameFor') && source.includes('-${n}'), '同名实例名自动加 -2')
  assert.ok(source.includes("t('g6.wizard.captainNote')") && source.includes("t('g6.wizard.captainNoteBody')"), '队长已自动加入说明')
  assert.ok(source.includes("t('g6.wizard.fromLibrary')") && source.includes("t('g6.wizard.pickHint')"), '从角色库再挑几个')
  assert.ok(source.includes("t('g6.wizard.willCreate')") && source.includes('role.model?.model'), '显示将创建的实例名与模型路由')
  assert.ok(source.includes("t('g6.wizard.later')"), '实例会话在你点下一步后才会创建')
  assert.ok(source.includes("t('g6.wizard.name')") && source.includes("t('g6.wizard.goal')") && source.includes("t('g6.wizard.promptTitle')"), '第 3 步写目标')
  assert.ok(source.includes('mt-dsec-head') && source.includes('mt-prompt-preview'), '第 2 步分区头 + 提示词预览')
})

test('t66-4: 项目级任务列表（tasks.html）——任务头 + 汇总条 + 按团队分组行 + 视图条四视图', () => {
  const { source } = loadClient()
  // 任务头：任务 · N 个 · M 个团队参与 + 一句话说明 + 阶段统计 + 操作
  assert.ok(source.includes("className: 'mt-taskhead'"), '任务头容器')
  assert.ok(source.includes("t('g6.tasks.headTitle')") && source.includes("t('g6.tasks.headMeta')"))
  assert.ok(source.includes("t('g6.tasks.headGoal')") && source.includes("t('g6.tasks.summaryRunning')"))
  // 汇总条：任务 / 参与关系（主责 N · 协作 M）/ 进行中 / 门禁待审 / 已完成
  assert.ok(source.includes("className: 'mt-summary'") && source.includes("className: 'mt-tstat'"))
  assert.ok(source.includes("t('g6.tasks.summaryLinks')") && source.includes("t('g6.tasks.summaryGates')") && source.includes("t('g6.tasks.summaryDone')"))
  assert.ok(source.includes("t('g6.tasks.stageNote')"), '阶段口径说明')
  // 按团队分组：组头（团队名 + 横线 + t-xxxxx · 状态 · 主责/协作）+ 任务行（状态 + 队员 chip）
  assert.ok(source.includes("className: 'mt-dsec-head'") && source.includes("t('g6.tasks.groupMeta')"))
  assert.ok(source.includes("className: 'mt-trow'") && source.includes('mt-mini-chip mt-mini-chip-team') && source.includes('mt-mini-chip-coop'))
  assert.ok(source.includes("t('g6.tasks.boardLink')"), '组头看板入口')
  assert.ok(source.includes("t('g6.tasks.draftNote')"), '草稿团队空态说明')
  // CHG-84：每组只列前 6 行 + 虚线「… 其余在看板」行（design/tasks.html）
  assert.ok(source.includes('TASK_GROUP_LIMIT') && source.includes('group.tasks.slice(0, TASK_GROUP_LIMIT)'), '分组行数上限')
  assert.ok(source.includes("t('g6.tasks.restInBoard')") && source.includes('mt-trow-more'), '「其余在看板」虚线行')
  // 视图条：列表 / 看板 / 流程 / 依赖图
  assert.ok(source.includes("className: 'mt-viewlinks'") && source.includes("t('g6.tasks.viewList')") && source.includes("t('g6.tasks.viewFlow')") && source.includes("t('g6.tasks.viewDag')"))
  assert.ok(source.includes("'list', 'board', 'lanes', 'dag'"), '四视图键位不变（既有契约）')
})

test('t66-5: 团队参与任务（team-tasks.html）——本队角色筛选 + 主责实线 / 协作虚线 + 其他参与团队 + 说明', () => {
  const { source } = loadClient()
  assert.ok(source.includes("t('g6.teamTasks.title')") && source.includes("t('g6.teamTasks.desc')"))
  assert.ok(source.includes("t('g6.teamTasks.boardBtn')"), '项目任务看板出口')
  assert.ok(source.includes("t('g6.teamTasks.filterAll')") && source.includes("t('g6.teamTasks.filterLead')") && source.includes("t('g6.teamTasks.filterCoop')"))
  assert.ok(source.includes('teamTaskFilter') && source.includes('setTeamTaskFilter'), '本队角色筛选状态')
  assert.ok(source.includes("t('g6.teamTasks.filterHint')"), '本队队员分配说明')
  // 参与关系 chip：主责实心（mt-status-filled）/ 协作虚线（mt-status-dashed）
  assert.ok(source.includes("mine.role === 'lead' ? 'mt-status-filled' : 'mt-status-dashed'"), '主责/协作 chip 实心/虚线区分')
  assert.ok(source.includes("t(p.role === 'lead' ? 'g6.teamTasks.leadTeam' : 'g6.teamTasks.coopTeam')"), '其他参与团队 chip')
  assert.ok(source.includes('mt-mini-chip-coop'), '协作虚线 chip 类')
  assert.ok(source.includes("t('g6.teamTasks.note')"), '任务与团队解耦说明')
  assert.ok(source.includes("t('g6.teamTasks.rest')"), '其余 N 个去向')
})

test('t66-6: 会话页（conversation.html）——conversation.view 团队视图 + 三张工具卡 + composer.dock 状态 chip', () => {
  const { module } = loadClient()
  const G6 = module.__testG6
  assert.equal(typeof G6.MyTeamConversationView, 'function', '团队视图组件')
  const tree = G6.MyTeamConversationView({ t: (k) => k, ctx: {}, sessionId: undefined })
  const classes = collectClasses(tree)
  for (const name of ['mt-conv', 'mt-conv-head', 'mt-team-mark', 'mt-conv-title', 'mt-conv-seg', 'mt-conv-seg-on', 'mt-stream', 'mt-turn', 'mt-turn-av', 'mt-turn-av-human', 'mt-turn-body', 'mt-turn-meta', 'mt-bubble', 'mt-toolcard', 'mt-toolcard-head', 'mt-toolcard-name', 'mt-toolcard-stat', 'mt-toolcard-body', 'mt-toolcard-row', 'mt-toolcard-foot', 'mt-toolcard-note', 'mt-dockrow', 'mt-dockchip', 'mt-dot', 'mt-vline', 'mt-go', 'mt-composerhint', 'mt-conv-section', 'mt-guestbar', 'mt-guestchips', 'mt-injrow', 'mt-candpop', 'mt-cand', 'mt-cand-cap', 'mt-cand-foot', 'mt-composerbox', 'mt-cmdprefix', 'mt-cmdinput', 'mt-status-chip']) {
    assert.ok(classes.has(name), `会话页渲染出 .${name}`)
  }
  const text = collectText(tree).join('')
  for (const copy of ['g6.conv.chat', 'g6.conv.view', 'g6.conv.planStat', 'g6.conv.openPanel', 'g6.conv.openDetail', 'g6.conv.ledger', 'g6.conv.approvedStat', 'g6.conv.peerStat', 'g6.conv.hint', 'g6.dock.running', 'g6.dock.gates', 'myteam_plan_tasks', 'myteam_approve_plan', 'myteam_peer_message']) {
    assert.ok(text.includes(copy), `会话页文案含 ${copy}`)
  }
  // 工具卡只给摘要 + 两个出口（不把整个看板塞进对话流）：迷你列表最多 4 行 + 一个「另有 N 个」
  const rows = collectClasses(tree).size > 0
  assert.ok(rows)
  assert.ok(text.includes('g6.conv.moreTasks'), '迷你任务列表有「另有 N 个」')
  // dock chip：live=0 且 unread=0 时不渲染
  const { source } = loadClient()
  assert.ok(source.includes('if (live === 0 && unread === 0) return null'), 'dock chip 空态不渲染')
})

test('t66-7: 单角色调用（guest.html）——角色 chips + 不属于任何团队横幅 + apply_roles 五行 + /myteam+ 命令与候选弹层', () => {
  const { module, source } = loadClient()
  const G6 = module.__testG6
  const card = G6.ApplyRolesCard({ t: (k) => k })
  const cardClasses = collectClasses(card)
  for (const name of ['mt-toolcard', 'mt-toolcard-head', 'mt-toolcard-name', 'mt-toolcard-stat', 'mt-toolcard-body', 'mt-injrow', 'mt-inj-k', 'mt-inj-v', 'mt-toolcard-foot', 'mt-mini-chip', 'mt-mini-chip-lead']) {
    assert.ok(cardClasses.has(name), `注入卡渲染出 .${name}`)
  }
  const cardText = collectText(card).join('')
  for (const copy of ['myteam_apply_roles', 'g6.guest.applyStat', 'g6.guest.systemPrompt', 'g6.guest.toolPolicy', 'g6.guest.skills', 'g6.guest.mcp', 'g6.guest.modelRoute', 'g6.guest.onceInject', 'g6.guest.narrowOnly', 'g6.guest.seeRole', 'g6.guest.seeSkills', 'claude-opus-4.6']) {
    assert.ok(cardText.includes(copy), `注入卡文案含 ${copy}`)
  }
  const composer = G6.GuestCallComposer({ t: (k) => k })
  const composerClasses = collectClasses(composer)
  for (const name of ['mt-composerbox', 'mt-cmdprefix', 'mt-cmdinput', 'mt-candpop', 'mt-cand-cap', 'mt-cand', 'mt-cand-name', 'mt-cand-sub', 'mt-cand-foot', 'mt-composerhint', 'mt-src-project', 'mt-src-global']) {
    assert.ok(composerClasses.has(name), `命令输入渲染出 .${name}`)
  }
  const composerText = collectText(composer).join('')
  for (const copy of ['/myteam+', 'g6.guest.candCap', 'g6.guest.candFoot', 'g6.guest.hint', 'tech-writer', 'tech-writer-cn']) {
    assert.ok(composerText.includes(copy), `命令输入文案含 ${copy}`)
  }
  // 头部角色 chips + 「不属于任何团队、不进团队账本」横幅（会话页 section 内）
  assert.ok(source.includes("t('g6.guest.banner').replace('{n}', '2')") && source.includes("t('g6.guest.bannerBody')"), '不属于任何团队横幅')
  assert.ok(source.includes("t('g6.guest.unload')") && source.includes('mt-guestchips'), '头部角色 chips + 卸载')
  assert.ok(source.includes("t('g6.guest.section')"), '单角色调用演示区块')
  // 多义回显不猜：候选弹层把所有前缀匹配列出来（aria-selected 只是焦点，不是猜测）
  assert.ok(source.includes("role: 'listbox'") && source.includes("role: 'option'"), '候选弹层语义')
})

test('t66-8: 样式纪律——G6 规则只用 --dsw-alias-* token，无十六进制色、无 font-family', () => {
  const { styles, apply, ctx } = loadClient()
  apply(ctx)
  const css = styles[0] ?? ''
  assert.ok(css.length > 0, '样式已注入')
  // CSS 数组里的 /* [G6 flow] */ 是 JS 注释（不进样式文本），G6 规则块以 .mt-wizard 打头
  const g6 = css.slice(css.indexOf('.mt-wizard{position:absolute'))
  assert.ok(g6.length > 2000, 'G6 样式块存在')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(g6.replace(/--dsw-[a-z-]+/g, '')), 'G6 无十六进制颜色')
  assert.ok(!/font-family\s*:/i.test(g6), 'G6 无 font-family')
  for (const name of ['.mt-wizard-dialog', '.mt-opt[aria-checked="true"]', '.mt-rosterline', '.mt-taskhead', '.mt-summary', '.mt-trow', '.mt-status-chip', '.mt-viewlinks', '.mt-conv-head', '.mt-toolcard', '.mt-injrow', '.mt-candpop', '.mt-dockchip', '.mt-guestbar']) {
    assert.ok(g6.includes(name), `G6 样式含 ${name}`)
  }
  assert.ok(g6.includes('color-mix(in srgb, var(--dsw-alias-'), '浅底色用 color-mix 而非硬编码')
})

test('t66-9: 词条成对——zh / en 的 g6.* 键集合一致（en 是兜底语言，漏 key 会显示 raw key）', () => {
  const { source } = loadClient()
  const zhBlock = source.slice(source.indexOf('    const zh = {'), source.indexOf('    const en = {'))
  const enStart = source.indexOf('    const en = {')
  const enBlock = source.slice(enStart, source.indexOf('    }\n', enStart) + 6)
  const keysOf = (block) => new Set([...block.matchAll(/'(g6\.[a-zA-Z0-9.]+)':/g)].map((match) => match[1]))
  const zhKeys = keysOf(zhBlock)
  const enKeys = keysOf(enBlock)
  assert.ok(zhKeys.size > 80, `zh g6.* 词条数量（实际 ${zhKeys.size}）`)
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key))
  assert.deepEqual(missingInEn, [], `en 缺词条：${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `zh 缺词条：${missingInZh.join(', ')}`)
})
