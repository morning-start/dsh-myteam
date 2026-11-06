/**
 * T64 · G4 ledger 设计稿对齐（CHG-82）
 *
 * 对齐 design/audit.html · settings.html · archive.html · overview.html · shell.html 五屏。
 * 纪律：不碰 CDP（Lead 统一截图）；本文件用「mock loader 渲染 + 结构断言」自证。
 *
 * 断言口径：
 *  1) 五屏的骨架 class 与关键文案都能在实现里找到（设计稿元素 ↔ 实现）；
 *  2) 数字口径不混：审计/设置走团队口径，overview 走项目汇总，archive 走归档快照；
 *  3) 样式纪律：只用 --dsw-alias-* token、禁十六进制色、禁 font-family（t13c-3 同源）；
 *  4) Panel 浅渲染不抛（mock react + 网关桩）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/** 最小 jsx-runtime：jsx 返回可检查的元素树 */
const j = (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children: (props?.children !== undefined ? [props.children, ...children] : children).flat() })
const js = (type: any, props: any, ...children: any[]) => j(type, props, ...children)
const reactShim = {
  useState: (init: any) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
  useRef: (init: any) => ({ current: init }),
}

/** 加载 client.js（模拟宿主 Loader），返回 { registered, styles, apply, ctx } */
function loadClient() {
  const registered: any[] = []
  const styles: string[] = []
  const effects: any[] = []
  const slots = {
    inject: (name: string, registerFactory: () => any) => {
      const reg = registerFactory()
      registered.push({ name, ...reg })
      return reg
    },
    register: (def: any, component: any) => ({ ...def, component }),
  }
  const modules = new Map<string, any>([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const ctx = {
    slots,
    remote: { myteam: { getBoard: async () => { throw new Error('not in test') } } },
    locale: { bind: () => (k: string) => k, register: () => {} },
    uiWorkspace: {},
    effect: (fn: () => any, _label?: string) => { const cleanup = fn(); effects.push(typeof cleanup === 'function' ? cleanup : () => {}); return cleanup },
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
    createElement: () => ({ dataset: {}, set textContent(v: string) { styles.push(v) }, style: {} }),
    head: { appendChild: () => {} },
  }
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { registered, styles, effects, apply: captured[0]?.apply, ctx, mod: captured[0] }
}

/** 元素树遍历：收集全部节点（map 产生的嵌套数组也要下钻） */
const collect = (node: any, out: any[] = []): any[] => {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}
const classOf = (node: any) => String(node?.props?.className ?? '')
/** 是否含某个 class（按 token 精确匹配） */
const hasClass = (tree: any, cls: string) => collect(tree).some((node) => classOf(node).split(/\s+/).includes(cls))
/** 含某 class 的节点数 */
const countClass = (tree: any, cls: string) => collect(tree).filter((node) => classOf(node).split(/\s+/).includes(cls)).length
/** 文案（t 走 identity → 断言 locale key） */
const textOf = (node: any): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
const G4 = () => {
  const { mod } = loadClient()
  assert.ok(mod?.__testG4, '__testG4 出口存在')
  return mod.__testG4
}
const t = (key: string) => key

/* ── 1. 落点 ── */

test('t64-1: G4 只在自己的锚点后追加（CSS / zh / en / 审计 tab / 设置 tab）', () => {
  assert.ok(source.includes('/* [G4 ledger] design/audit.html · settings.html · archive.html · overview.html · shell.html */'), 'CSS G4 锚点')
  assert.ok(source.includes("/* [G4 ledger] */ /* [G5 graph] */ /* [G6 flow] */"), 'locale G4 锚点（zh + en 各一处）')
  assert.ok(source.includes('/* [G4 ledger · 审计 tab] —— design/audit.html */'), '审计 tab 锚点')
  assert.ok(source.includes('/* [G4 ledger · 设置 tab] —— design/settings.html */'), '设置 tab 锚点')
  // 五屏各自的组件/区块存在
  for (const name of ['function AuditTab(', 'function SettingsTab(', 'function ArchiveReplay(', 'function TeamsHome(', 'function TeamCard(', 'function CostBar(']) {
    assert.ok(source.includes(name), `${name} 存在`)
  }
  // CSS 追加在 G4 锚点之后（不是别人的段落里）
  const anchor = source.indexOf('/* [G4 ledger] design/audit.html')
  const firstRule = source.indexOf("'.mt-audit-page{", anchor)
  assert.ok(anchor > 0 && firstRule > anchor, 'G4 样式在锚点之后')
})

/* ── 2. audit.html ── */

test('t64-2: 审计视图（audit.html）—— 三档回放 + attempt 分组 + 只读标注 + 分页', () => {
  // 三档 seg：按任务 / 按角色 / 按时间
  assert.ok(source.includes("const AUDIT_VIEWS = ['task', 'member', 'time']"), '三档回放维度')
  assert.ok(source.includes("'audit.view.task'") && source.includes("'audit.view.member'") && source.includes("'audit.view.time'"), '三档文案（zh+en 各一份）')
  assert.ok(source.includes('mt-audit-segbar') && source.includes('mt-audit-seg') && source.includes('mt-audit-segbtn'), '视图条 seg 样式')
  // 左任务轨 + 右事件流
  assert.ok(source.includes('mt-audit-rail') && source.includes('mt-audit-pane'), '任务轨 + 主区两栏')
  assert.ok(source.includes("className: 'mt-audit-item'") && source.includes('mt-audit-item-main') && source.includes('mt-tid'), '任务条目（号 + 标题 + 元信息）')
  // attempt 分组：claimed 开新尝试
  assert.ok(source.includes('const auditAttempts = (events) =>'), 'attempt 分组纯函数')
  assert.ok(source.includes("String(event.type) === 'task.claimed' || String(event.type) === 'task.rescoped'"), 'claimed/rescoped 视为新尝试')
  assert.ok(source.includes('mt-attempt-sep') && source.includes('mt-attempt-line'), 'attempt 分隔条')
  // 事件流（时间 + 圆点 + 类型 + actor + 备注）
  assert.ok(source.includes("className: 'mt-evstream'") && source.includes("className: 'mt-evrow'"), '事件流行')
  assert.ok(source.includes('mt-evtime') && source.includes('mt-evdot') && source.includes('mt-evmain') && source.includes('mt-evrow-title') && source.includes('mt-evrow-note'), '事件行五段')
  assert.ok(source.includes('const auditDotClass = (type) =>'), '圆点语义（claimed/run/warn/failed）')
  for (const tone of ['mt-evdot-claimed', 'mt-evdot-run', 'mt-evdot-warn', 'mt-evdot-failed']) {
    assert.ok(source.includes(tone), `圆点语义 ${tone}`)
  }
  // 只读标注 + 账本路径 + 分页 + 导出
  assert.ok(source.includes("'audit.derived'") && source.includes('mt-note-info'), '只读 · 从账本派生')
  assert.ok(source.includes('ledger.jsonl') && source.includes('mt-audit-ledger-path'), '账本路径标注')
  assert.ok(source.includes("t('audit.loadMore')") && source.includes("t('audit.end')"), '加载更多 / 已到底')
  assert.ok(source.includes("'audit.export'") && source.includes('exportJsonl'), '导出 JSONL')
  // 原始 type 作 title（t13c 既有契约）
  assert.ok(source.includes('title: event.type, children: eventLabel(event.type)'), '保留原始 type 作 title')
  assert.ok(source.includes("t('audit.detail')"), '看任务详情')
})

/* ── 3. settings.html ── */

test('t64-3: 团队设置（settings.html）—— 三层合并链 + 行为配置硬上限 + 状态目录 + 生命周期', () => {
  assert.ok(source.includes("'settings.page.title'") && source.includes('mt-page-head'), '页头（标题 + 说明 + 动作）')
  assert.ok(source.includes("'settings.jsonView'") && source.includes('mt-json'), 'JSON 源视图')
  // 配置来源：三层 + 合并链（类名用 mt-cur，不占用 .win/.mt-switch）
  assert.ok(source.includes('mt-layers') && source.includes("className: 'mt-layer'"), '三层清单')
  for (const key of ["'settings.layer.default'", "'settings.layer.project'", "'settings.layer.team'"]) {
    assert.ok(source.includes(key), `层名 ${key}`)
  }
  assert.ok(source.includes('mt-merge-chain') && source.includes('mt-lt') && source.includes('mt-cur'), '合并链 + 生效层高亮（mt-cur）')
  assert.ok(!source.includes("'mt-win'") && !source.includes('mt-win '), '不占用 .win（design-notes §五点五 的坑）')
  assert.ok(source.includes("'settings.mergeNote'"), '数组整条替换说明')
  // 行为配置 + 硬上限只读列
  assert.ok(source.includes('const CONFIG_CEILINGS = { maxMembers: 6, memberMaxDepth: 0, commandTimeoutMs: 600000 }'), '硬上限口径（与 PATCH_CEILINGS 一致）')
  assert.ok(source.includes('mt-setrows') && source.includes('mt-setrow') && source.includes('mt-setrow-main') && source.includes('mt-setrow-act'), '行式配置')
  assert.ok(source.includes('mt-readonly-val') && source.includes("t('settings.ceiling')"), '硬上限只读列')
  assert.ok(source.includes('mt-input-num') && source.includes('mt-toggle'), '数值输入 + 开关')
  for (const key of ["'settings.teamSize'", "'settings.delegateDepth'", "'settings.gateTimeoutLabel'", "'settings.hideTools'", "'settings.evidenceLabel'"]) {
    assert.ok(source.includes(key), `行为配置项 ${key}`)
  }
  // 状态目录 + gitignore 托管块
  assert.ok(source.includes("'settings.stateDir'") && source.includes("'settings.gitignore'") && source.includes("'settings.ledgerAppend'"), '状态目录 / gitignore / 账本追加')
  // 生命周期（归档 + 解散两段确认）
  assert.ok(source.includes("'settings.lifecycle'") && source.includes("'settings.archiveTitle'") && source.includes("'settings.disbandTitle'"), '生命周期两行')
  assert.ok(source.includes('const askDisband = async () =>') && source.includes("disband({ teamId: team.teamId, confirm: false })"), '解散两段确认（第一段）')
  assert.ok(source.includes("disband({ teamId: team.teamId, confirm: true })"), '解散两段确认（第二段）')
  assert.ok(source.includes('mt-impact-box'), '影响面提示')
  assert.ok(source.includes("'settings.footNote'") && source.includes('mt-note-box'), '改配置不重跑已派发任务')
})

/* ── 4. archive.html ── */

test('t64-4: 归档回放（archive.html）—— 归档条 + 结局卡 + 进度分段 + 五项分解 + 任务历史 + 账本', () => {
  // 顶条换归档条
  assert.ok(source.includes('mt-archbar') && source.includes('mt-team-mark') && source.includes('mt-team-id') && source.includes('mt-arch-date'), '归档条（团队名 + 归档日期 + 只读）')
  assert.ok(source.includes("t('archive.openAudit')") && source.includes("t('archive.allTeams')"), '在审计视图打开 / 全部团队')
  assert.ok(source.includes("t('archive.status')"), '已归档 chip')
  // 结局卡
  assert.ok(source.includes('mt-endcard') && source.includes('mt-endmeta'), '结局卡（原因 + 影响面）')
  assert.ok(source.includes("t('archive.endTitle')") && source.includes("t('archive.endDisbander')") && source.includes("t('archive.endDrained')") && source.includes("t('archive.endBlocked')"), '结局卡四项元信息')
  // 进度分段条（完成 / blocked / 未开始 三色）
  assert.ok(source.includes('mt-segbar') && source.includes('mt-seg-done') && source.includes('mt-seg-blocked') && source.includes('mt-seg-run'), '进度分段条三色')
  assert.ok(source.includes('mt-teambar-stats') && source.includes('mt-tstat'), '进度统计（tstat）')
  for (const key of ["'archive.done'", "'archive.blocked'", "'archive.notStarted'", "'archive.tokensTotal'", "'archive.calls'"]) {
    assert.ok(source.includes(key), `进度统计项 ${key}`)
  }
  // 名册各带终态与花费
  assert.ok(source.includes("t('archive.section.roster')") && source.includes('mt-mavatar') && source.includes('mt-iname'), '名册卡（实例名 + 角色 + 终态）')
  assert.ok(source.includes("t('archive.tokenOf')") && source.includes("t('archive.drained')"), '名册花费 + 排空说明')
  // token 五项分解表 + 合计行
  assert.ok(source.includes("js('table', { className: 'mt-toktable'"), '五项分解表')
  assert.ok(source.includes("j('thead'") && source.includes("j('tbody'") && source.includes("j('tfoot'"), '表头 / 天桶 / 合计三段')
  assert.ok(source.includes('mt-toktable td.mt-n'), '数值列右对齐（tabular-nums）')
  for (const key of ["'archive.cost.uncached'", "'archive.cost.hit'", "'archive.cost.write'", "'archive.cost.output'", "'archive.cost.calls'", "'archive.cost.rate'", "'archive.cost.total'"]) {
    assert.ok(source.includes(key), `五项分解列 ${key}`)
  }
  // 任务历史（终态如实保留 + 从未认领）
  assert.ok(source.includes("t('archive.section.tasks')") && source.includes("t('archive.tasksNote')"), '任务历史（终态保留）')
  assert.ok(source.includes("t('archive.neverClaimed')"), '从未认领的任务如实标注')
  assert.ok(source.includes("t('archive.seeEvidence')") && source.includes("t('archive.seeGate')"), '看证据 / 看门禁')
  // 账本与产物
  assert.ok(source.includes("t('archive.section.ledger')") && source.includes('ledger.jsonl') && source.includes('team.json') && source.includes('tokens.json') && source.includes('members/') && source.includes('artifacts/'), '账本与产物清单')
  assert.ok(source.includes("t('archive.note')") && source.includes("t('archive.noteSub')"), '归档说明')
  // 归档团队整体换归档条：team.state === 'archived' 走 ArchiveReplay
  assert.ok(source.includes("if (team.state === 'archived')"), '归档团队切换到回放视图')
})

/* ── 5. overview.html（CHG-83：已从面板摘掉，只留回归护栏） ── */

test('t64-5: 全局页不再内联「全部团队」（CHG-83 回归护栏）', () => {
  // 用户反馈："怎么还有一个这个区域" —— overview 的「库的作用域 / 活跃团队 / 已归档」
  // 与「角色库三层」和「团队 tab」三处重复，故整块删除。归档团队仍从「团队」tab 进入。
  assert.ok(!source.includes('function OverviewTeams('), 'OverviewTeams 组件已删除')
  assert.ok(!source.includes("t('overview.title')"), '全局页不再渲染 overview 页头')
  assert.ok(!source.includes("t('overview.layers')"), '全局页不再渲染库的作用域三层')
  // 归档回放入口必须仍在（团队 tab 的 TeamCard → ArchiveReplay）
  assert.ok(source.includes('function ArchiveReplay('), '归档回放组件保留')
  assert.ok(source.includes("t('archive.allTeams')"), '归档条仍有「全部团队」出口')
})

/* ── 6. shell.html ── */

test('t64-6: 项目团队列表（shell.html）—— 按工作区分组 + 团队卡四段', () => {
  assert.ok(source.includes('function TeamsHome(') && source.includes('function TeamCard('), '列表 + 卡片组件')
  // 筛选行
  assert.ok(source.includes('mt-home') && source.includes('mt-home-filter') && source.includes('mt-search-field') && source.includes('mt-search-ico'), '筛选行（搜索框 + 图标）')
  assert.ok(source.includes("t('shell.filter')") && source.includes("t('shell.hint')"), '筛选占位 + 右侧提示')
  // 工作区分组（组头 = 工作区名 + n 个团队 + 路径）
  assert.ok(source.includes('mt-home-group') && source.includes('mt-home-group-head') && source.includes('mt-group-n') && source.includes('mt-group-path'), '组头三件')
  assert.ok(source.includes("t('shell.groupCount')"), '「n 个团队」')
  assert.ok(source.includes('projectLabel(root)'), '组头 = 工作区名')
  // 团队卡（名称 + 状态 chip + 在线/离线 + 描述 + 完成度行）
  assert.ok(source.includes('mt-team-card') && source.includes('mt-team-head') && source.includes('mt-tc-head'), '团队卡（保留旧 class + 设计稿 tc-head）')
  assert.ok(source.includes('mt-tc-name') && source.includes('mt-tc-zone') && source.includes('mt-tc-dot'), '名称 + 在线/离线 + 状态点')
  assert.ok(source.includes('mt-tc-desc') && source.includes('mt-tc-meta'), '描述 + 完成度行')
  assert.ok(source.includes("t('shell.done')") && source.includes("t('shell.running')") && source.includes("t('shell.gatePending')"), '完成度 / 进行中 / 门禁待审')
  assert.ok(source.includes("t('shell.online')") && source.includes("t('shell.offline')"), '在线 / 离线')
  // 统计口径不混：团队页用团队口径（counts），不拿项目汇总冒充
  assert.ok(source.includes('team.counts?.done') && source.includes('team.counts?.tasks'), '团队口径完成度')
})

/* ── 7. locale 双语 ── */

test('t64-7: 五屏文案中英双语齐全（zh 与 en 同序追加）', () => {
  const keys = [
    'audit.view.task', 'audit.attempt', 'audit.derived', 'audit.export',
    'settings.page.title', 'settings.layer.project', 'settings.ceiling', 'settings.footNote',
    'archive.archivedAt', 'archive.section.end', 'archive.cost.rate', 'archive.neverClaimed',
    'shell.filter', 'shell.groupCount', 'shell.gatePending', 'costbar.hitRate',
  ]
  for (const key of keys) {
    const hits = source.split(`'${key}'`).length - 1
    assert.ok(hits >= 2, `${key} 同时出现在 zh 与 en（实际 ${hits} 处）`)
  }
})

/* ── 8. 样式纪律（t13c-3 同源）+ 渲染不抛 ── */

test('t64-8: 样式纪律——只用 --dsw-alias-* token、无十六进制色、无 font-family', () => {
  const { apply, ctx, styles } = loadClient()
  apply(ctx)
  assert.equal(styles.length, 1, 'style tag 经 ctx.effect 注入一次')
  const css = styles[0]
  const stripped = css.replace(/--dsw-[a-z0-9-]+/g, '')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(stripped), 'no hex colors')
  assert.ok(!/font-family\s*:/i.test(css), 'no font-family overrides')
  assert.ok(/--dsw-alias-/.test(css), 'uses dsw alias tokens')
  for (const rule of ['.mt-audit-pane', '.mt-merge-chain', '.mt-archbar', '.mt-toktable', '.mt-team-card']) {
    assert.ok(css.includes(rule), `G4 样式 ${rule}`)
  }
})

test('t64-9: Panel 浅渲染不抛（mock react + 网关桩）', () => {
  const { apply, ctx, registered } = loadClient()
  ctx.slots = {
    inject: (name: string, factory: () => any) => { registered.push({ name, ...factory() }) },
    register: (def: any, component: any) => ({ ...def, component }),
  }
  ctx.connection = {
    rpc: {
      call: async (_channel: string, endpoint: string) => {
        const value = endpoint === 'myteam/listTeams'
          ? { status: 'ok', teams: [{ sessionId: 's-1', teamId: 't1', name: '结算页模块化', workspaceRoot: 'D:/Work/harbor-web', state: 'archived', online: false }] }
          : endpoint === 'myteam/getProject'
            ? { status: 'ok', workspaceRoot: 'D:/Work/harbor-web', teams: [], tasks: [], graph: { nodes: [], edges: [] }, roles: [], counts: { tasks: 0, done: 0, running: 0, gates: 0, teams: 0, members: 0, roles: 0 }, warnings: [] }
            : { status: 'unavailable' }
        return { ok: true, value }
      },
    },
  }
  apply(ctx)
  const main = registered.find((item: any) => item.name === 'main')
  assert.ok(main, 'main 槽注册')
  const comp = main.component ?? main.comp
  assert.equal(typeof comp, 'function')
  const tree = comp({ ctx, connection: ctx.connection })
  assert.ok(tree, 'Panel 渲染出元素树')
})

/* ── 10. 结构渲染（mock loader 直接渲染纯组件）── */

const auditFixture = {
  total: 6,
  nextBeforeSeq: 3,
  /* 新→旧（与 buildAuditView 同序）：seq 越大 ts 越新 */
  events: [
    { seq: 6, ts: 1762200180000, actor: 'lead', type: 'task.progress', taskId: 't1' },
    { seq: 5, ts: 1762200120000, actor: 'm1', type: 'task.gate.result', taskId: 't1' },
    { seq: 4, ts: 1762200060000, actor: 'm1', type: 'task.claimed', taskId: 't1' },
    { seq: 3, ts: 1762200000000, actor: 'm1', type: 'task.progress', taskId: 't2' },
  ],
}
const auditTasks = [
  { id: 't1', title: '抽结算服务边界与接口草案', state: 'in_progress', requiredRole: 'implementer' },
  { id: 't2', title: '结算页 UI 迁移到模块包', state: 'done', requiredRole: 'reviewer' },
]

test('t64-10: 审计视图渲染——任务轨 2 条、attempt 分组、事件行 4 条、只读标注 + 加载更多', () => {
  const { AuditTab } = G4()
  const tree = AuditTab({ t, audit: auditFixture, tasks: auditTasks, filter: 'task', setFilter: () => {}, onMore: () => {}, onOpen: () => {}, memberName: (id: string) => id })
  assert.ok(hasClass(tree, 'mt-audit-page'), '页面骨架')
  assert.equal(countClass(tree, 'mt-audit-item'), 2, '任务轨 2 条')
  assert.equal(countClass(tree, 'mt-attempt-sep'), 1, '当前任务只有 1 次尝试（claimed 开头）')
  assert.equal(countClass(tree, 'mt-evrow'), 3, '事件行 = 3 条（t1）')
  assert.ok(hasClass(tree, 'mt-audit-ledger-path'), '账本路径（只读派生）')
  assert.ok(textOf(tree).includes('audit.loadMore'), '分页「加载更多」')
  // CHG-84 复检：左轨元信息 = 角色 · N 条事件 · N 次尝试（design/audit.html）
  assert.ok(textOf(tree).includes('audit.attempts'), '左轨「N 次尝试」')
  // 任务轨状态点：in_progress → 有尺寸的状态点（mt-mdot 自带 6px，不再依赖 mt-task-dot 基类）
  const dots = collect(tree).filter((node) => classOf(node).split(/\s+/).includes('mt-mdot'))
  assert.ok(dots.length >= 2, '任务轨状态点')
  assert.ok(dots.some((node) => classOf(node).includes('mt-mdot-gate') || classOf(node).includes('mt-task-dot')), '状态点带语义')
  // 切「按角色」：不渲染任务轨，按 actor 分组
  const byMember = AuditTab({ t, audit: auditFixture, tasks: auditTasks, filter: 'member', setFilter: () => {}, onMore: () => {}, onOpen: () => {}, memberName: (id: string) => id })
  assert.equal(countClass(byMember, 'mt-audit-item'), 0, '按角色无任务轨')
  assert.ok(hasClass(byMember, 'mt-audit-body-single'), '单列布局')
  assert.equal(countClass(byMember, 'mt-evrow'), 4, '全部事件都在')
})

test('t64-11: 设置页渲染——三层 + 生效层高亮（mt-cur）+ 6 行行为配置 + 硬上限 + 生命周期', () => {
  const { SettingsTab } = G4()
  const config = {
    status: 'ok',
    source: 'project',
    chain: [{ layer: 'default', active: false }, { layer: 'project', active: true }, { layer: 'team', active: false }],
    config: {
      limits: { maxMembers: 6, memberMaxDepth: 0, maxTasks: 20 },
      gates: { enabled: true, commandTimeoutMs: 120000 },
      memory: { evidenceRequired: true },
      views: {}, board: {}, pipeline: {}, taskTypes: {}, clarify: {},
    },
    warnings: [],
  }
  const team = { teamId: 't1', online: true, members: [{ id: 'm1' }], counts: { tasks: 11, done: 3 } }
  const tree = SettingsTab({ t, config, offline: false, team, connection: {}, onDisbanded: () => {} })
  assert.equal(countClass(tree, 'mt-layer'), 3, '三层配置来源')
  const cur = collect(tree).filter((node) => classOf(node) === 'mt-cur')
  assert.equal(cur.length, 1, '只有一层生效')
  assert.ok(textOf(cur[0]).startsWith('settings.layer.project'), '生效层 = 项目配置')
  assert.ok(textOf(cur[0]).includes('settings.layer.effective'), '设计稿的「（生效）」后缀')
  assert.equal(countClass(tree, 'mt-setrow'), 8, '六行行为配置 + 两行生命周期')
  assert.equal(countClass(tree, 'mt-toggle'), 3, '三个开关')
  assert.equal(countClass(tree, 'mt-readonly-val'), 3, '三个硬上限只读列')
  assert.ok(textOf(tree).includes('settings.ceiling'), '硬上限文案')
  assert.ok(textOf(tree).includes('settings.disbandSub'), '解散影响面')
  assert.ok(hasClass(tree, 'mt-note-box'), '改配置不重跑已派发任务')
})

test('t64-12: 团队列表渲染——按工作区分组 2 组、团队卡 3 张、完成度行四段', () => {
  const { TeamsHome } = G4()
  const base = { state: 'active', online: true, goal: '目标', members: [{ id: 'm1' }], counts: { tasks: 11, done: 3, running: 2 } }
  const teams = [
    { ...base, teamId: 't1', name: '结算页模块化', workspaceRoot: 'D:/Work/harbor-web' },
    { ...base, teamId: 't2', name: '插件 v0.2 接口评审', workspaceRoot: 'D:/Work/harbor-web' },
    { ...base, teamId: 't3', name: '控制台国际化', workspaceRoot: 'D:/Work/mocha-lab', online: false, state: 'draft' },
  ]
  const tree = TeamsHome({ t, teams, tasks: [], gateOf: () => 2, onOpen: () => {}, workspaceRoot: 'D:/Work/harbor-web' })
  assert.equal(countClass(tree, 'mt-home-group'), 2, '按工作区分 2 组')
  assert.ok(hasClass(tree, 'mt-search-field') && hasClass(tree, 'mt-home-hint'), '筛选行 + 右侧提示')
  assert.ok(textOf(tree).includes('shell.groupCount'), '组头「n 个团队」')
  // CHG-84 复检：组头 = 工作区名 + 路径（项目聚合不带 workspaceRoot 时回落当前项目根）
  assert.ok(textOf(tree).includes('D:/Work/harbor-web'), '组头路径回落当前项目根')
  const single = TeamsHome({ t, teams: [{ ...base, teamId: 't1', name: 'x', workspaceRoot: '' }], tasks: [], gateOf: () => 0, onOpen: () => {}, workspaceRoot: 'D:/Work/fallback' })
  assert.ok(textOf(single).includes('D:/Work/fallback'), '团队摘要无 workspaceRoot 时用项目根分组')
  // 团队卡四段（TeamCard 是组件引用，单独渲染断言）
  const { TeamCard } = G4()
  const card = TeamCard({ t, team: teams[0], taskCount: 3, gateCount: 2, onOpen: () => {} })
  assert.ok(hasClass(card, 'mt-team-card') && hasClass(card, 'mt-team-head') && hasClass(card, 'mt-tc-head'), '团队卡（名称 + 状态 + 在线/离线）')
  assert.ok(hasClass(card, 'mt-tc-zone') && hasClass(card, 'mt-tc-meta'), '在线/离线 + 完成度行')
  assert.ok(textOf(card).includes('shell.gatePending'), '门禁待审')
  assert.ok(textOf(card).includes('shell.done'), '完成 x/y')
  // CHG-84 复检：设计稿团队卡只有「完成 x/y · 进行中 n · 门禁待审 n · 角色 n」，不出现「参与任务 N」
  assert.ok(!textOf(card).includes('team.tab.participating'), '卡片脚不再有「参与任务 N」')
  // 草稿态只留一枚状态 chip（不重复渲染「草稿」）
  const draftCard = TeamCard({ t, team: { ...teams[0], state: 'draft' }, taskCount: 0, gateCount: 0, onOpen: () => {} })
  assert.equal((textOf(draftCard).match(/shell\.draft/g) ?? []).length, 0, '草稿态不再额外渲染 draft chip')
  const offlineCard = TeamCard({ t, team: { ...teams[0], online: false }, taskCount: 0, gateCount: 0, onOpen: () => {} })
  assert.ok(classOf(offlineCard).includes('mt-team-offline'), '离线团队虚线卡')
})

test('t64-13: 团队列表渲染——按工作区分组 + 团队卡四段（CHG-83 后不再有 overview 组件）', () => {
  const { TeamsHome } = G4()
  const teams = [
    { teamId: 't1', name: '结算页模块化', state: 'active', online: true, goal: '拆模块', workspaceRoot: 'D:/w/a', members: [{ id: 'm1' }, { id: 'm2' }] },
    { teamId: 't2', name: 'CI 超时排查', state: 'archived', online: false, goal: '', workspaceRoot: 'D:/w/a', members: [] },
  ]
  const tree = TeamsHome({ t, teams, tasks: [{ ownerTeamId: 't1', participants: [] }], gateOf: () => 1, onOpen: () => {} })
  assert.equal(countClass(tree, 'mt-home-group'), 1, '按工作区分 1 组')
  // TeamCard 是组件引用（未展开），按 type 计数而不是 className
  const cards = collect(tree).filter((node: any) => typeof node?.type === 'function')
  assert.equal(cards.length, 2, '两张团队卡（含已归档）')
  assert.ok(countClass(tree, 'mt-search-field') >= 1, '筛选行有搜索框')
  // 团队卡内部（门禁待审 / 完成 x/y）由 t64-12 单独渲染 TeamCard 覆盖
  // CHG-84 收口：CHG-83 撤掉全局页「全部团队」后，建团入口补到「项目 → 团队」tab
  const withCreate = TeamsHome({ t, teams, tasks: [], gateOf: () => 0, onOpen: () => {}, onCreateTeam: () => {} })
  assert.ok(textOf(withCreate).includes('shell.newTeam'), '团队 tab 有「新团队」按钮（建团向导入口）')
  const noCreate = TeamsHome({ t, teams, tasks: [], gateOf: () => 0, onOpen: () => {} })
  assert.ok(!textOf(noCreate).includes('shell.newTeam'), '未传 onCreateTeam 时不渲染（组件可选）')
})

test('t64-14: 归档回放渲染——归档条 + 结局卡 + 分段条 + 五项分解（含合计）+ 任务历史 + 账本', () => {
  const { ArchiveReplay, CostBar } = G4()
  const team = {
    teamId: 't9',
    name: 'CI 超时排查',
    state: 'archived',
    online: false,
    goal: '定位 CI 超时',
    members: [
      { id: 'm1', instanceName: 'implementer', roleId: 'implementer', status: 'archived' },
      { id: 'm2', instanceName: 'reviewer', roleId: 'reviewer', status: 'archived' },
    ],
    counts: { tasks: 3, done: 1, running: 0 },
  }
  const tasks = [
    { id: 't1', key: 't9/t1', title: '定位 CI 超时发生在哪一段', state: 'done', assignees: ['m1'], evidenceCount: 2 },
    { id: 't2', key: 't9/t2', title: '修 pipeline 缓存与并发', state: 'blocked', assignees: ['m2'], evidenceCount: 0 },
    { id: 't3', key: 't9/t3', title: '回归验证与收口', state: 'backlog', assignees: [], evidenceCount: 0 },
  ]
  const tokens = {
    totals: { m1: { uncachedInput: 42000, cacheRead: 51000, cacheWrite: 8200, output: 11000, calls: 38 } },
    days: { '2026-10-23': { m1: { uncachedInput: 42000, cacheRead: 51000, cacheWrite: 8200, output: 11000, calls: 38 } } },
  }
  const tree = ArchiveReplay({ t, team, tasks, tokens, audit: { total: 14, events: [] }, memberName: (id: string) => id, onBack: () => {}, onOpenAll: () => {}, onOpenTask: () => {} })
  assert.ok(hasClass(tree, 'mt-archbar'), '归档条')
  assert.ok(textOf(tree).includes('archive.openAudit'), '「在审计视图打开」')
  assert.equal(countClass(tree, 'mt-endcard'), 1, '结局卡')
  assert.equal(countClass(tree, 'mt-endmeta'), 1, '结局卡影响面')
  assert.equal(countClass(tree, 'mt-segbar'), 1, '进度分段条')
  assert.equal(countClass(tree, 'mt-tstat'), 5, '五项进度统计')
  assert.equal(countClass(tree, 'mt-toktable'), 1, 'token 五项分解表')
  assert.ok(textOf(tree).includes('archive.cost.total'), '含合计行')
  assert.ok(textOf(tree).includes('archive.neverClaimed'), '从未认领的任务如实标注')
  // 名册 2 张卡 + 任务历史 3 条 + 账本 4 条
  assert.equal(countClass(tree, 'mt-card2'), 2, '名册两张卡')
  assert.equal(countClass(tree, 'mt-listrow'), 7, '任务历史 3 + 账本 4')
  assert.ok(collect(tree).some((node) => node.type === CostBar), '底部成本栏（归档快照）')
  // 点「在审计视图打开」→ 切到审计（本地状态；mock 下 setState 不生效，只断言按钮存在）
  const openBtn = collect(tree).find((node) => textOf(node) === 'archive.openAudit')
  assert.ok(openBtn && typeof openBtn.props.onClick === 'function', '可切到审计视图')
  // CHG-84 复检：设计稿的视图条 = 回放分区锚点（结局 / 名册·2 / 任务历史·3 / 账本与产物）
  const nav = collect(tree).filter((node) => classOf(node) === 'mt-audit-segbtn' && typeof node.props?.onClick === 'function')
  assert.equal(nav.length, 4, '回放分区锚点 4 项')
  const navText = nav.map((node) => textOf(node))
  assert.ok(navText.includes('archive.section.end') && navText.includes('archive.section.ledger'), '锚点文案（结局 / 账本与产物）')
  assert.ok(navText.some((text: string) => text.includes('archive.section.roster')), '名册 · N')
  assert.ok(navText.some((text: string) => text.includes('archive.section.tasks')), '任务历史 · N')
  // 四个分区都有 id 锚点
  const ids = collect(tree).map((node) => String(node.props?.id ?? '')).filter(Boolean)
  for (const id of ['mt-arch-end', 'mt-arch-roster', 'mt-arch-tasks', 'mt-arch-ledger']) {
    assert.ok(ids.includes(id), `分区锚点 ${id}`)
  }
  // 归档条：有 updatedAt 时显示「归档于 … · 只读」，没有时只显示「只读」
  assert.ok(textOf(tree).includes('archive.readonly'), '归档条只读标注')
  // 成本栏归档态：只读回放 chip（不是「上下文占用」）
  const bar = CostBar({ t, tokens, readOnly: true })
  assert.ok(textOf(bar).includes('archive.replayChip'), '成本栏「只读回放」chip')
  assert.ok(!textOf(bar).includes('costbar.context'), '归档态不显示「上下文占用」')
})

