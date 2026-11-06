/**
 * T63 设计稿对齐 G3（CHG-82）—— knowledge.html / presets.html / skills.html
 *
 * 三屏都落在 `plugin/client/client.js`（单文件、浏览器直载、不经 build-lib），
 * 6 个组并行改同一文件，所以这里只做「mock loader 渲染 + 结构断言」自证（CDP 由 Lead 统一做）：
 *  - 知识库：三层记忆（AGENTS.md 共识 / 项目共享 / 实例私有）+ 证据数 + 可能过期 + 待确认提案 +
 *    「仅本人可见」+ 搜索框 + 提案入口；
 *  - 预设库：三层来源分区 + 名册预览（队长高亮 + 角色引用 chips）+ 模板三行 + 引用计数 +
 *    内置层兜底模板 + 删除守门；
 *  - 技能与 MCP：技能四层来源 + 成员级隔离 + 绑定次数 / 绑进角色 + MCP 两段式（连接层 ∩ 可见层）。
 *
 * 另外把「设计纪律」变成断言：只用 --dsw-alias-* token、无十六进制颜色、无 font-family
 * （t13c-3 是硬断言，这里再按 G3 区块精确复核一次），以及 locale 三组键 zh / en 同键。
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
const j = (type: any, props: any, ...children: any[]) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
const js = j
const reactShim = {
  useState: (init: any) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
}

/** 加载 client.js（模拟宿主 __ModuleLoader__），返回 { registered, styles, effects, apply, ctx } */
function loadClient() {
  const registered: any[] = []
  const styles: string[] = []
  const effects: any[] = []
  const slots = {
    inject: (_name: string, registerFactory: () => any) => {
      const reg = registerFactory()
      registered.push(reg)
      return reg
    },
    register: (def: any, component: any) => ({ ...def, component }),
  }
  const modules = new Map<string, any>([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const ctx: any = {
    slots,
    remote: { myteam: { getBoard: async () => { throw new Error('not in test') } } },
    locale: { bind: () => (k: string) => k, register: () => {} },
    uiWorkspace: {},
    effect: (fn: () => any, _label?: string) => {
      const cleanup = fn()
      effects.push(typeof cleanup === 'function' ? cleanup : () => {})
      return cleanup
    },
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
    createElement: () => ({
      dataset: {},
      set textContent(v: string) { styles.push(v) },
      style: {},
    }),
    head: { appendChild: () => {} },
  }
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { registered, styles, effects, apply: captured[0]?.apply, ctx }
}

/* ── 一、知识库（design/knowledge.html） ─────────────────────────────── */

test('t63-1: 知识库——三层记忆（共识 / 共享 / 实例私有）+ 证据数 + 可能过期 + 待确认提案 + 仅本人可见', () => {
  // 三层记忆清单：复用 design/app.css 的 .layers / .layer / .layer-ico 结构
  assert.ok(source.includes("className: 'mt-layers'"), '三层记忆容器')
  assert.ok(source.includes('mt-layer-ico-builtin') && source.includes('mt-layer-ico-project') && source.includes('mt-layer-ico-global'), '三层各自的图标底（内置 / 项目 / 全局）')
  for (const key of ['kb3.consensus', 'kb3.shared', 'kb3.private']) {
    assert.ok(source.includes(`'${key}'`), `${key} 层名`)
  }
  assert.ok(source.includes('kb3.consensusPath') && source.includes('kb3.sharedPath') && source.includes('kb3.privatePath'), '每层写清存储路径（AGENTS.md / config/knowledge / members/<id>/memory.md）')
  // 证据数 + 可能过期 + 待确认提案
  assert.ok(source.includes("t('kb3.proofChip')") && source.includes("t('kb3.proofNone')"), '证据数（无证据也如实说）')
  assert.ok(source.includes('mt-chip mt-chip-stale') && source.includes("t('kb3.stale')"), '「可能过期」标记')
  assert.ok(source.includes("t('kb3.proposalTitle')") && source.includes("t('kb3.review')"), '待确认提案 + 审阅提案入口')
  // 成员私有条目：「仅本人可见」
  assert.ok(source.includes("t('kb3.privateOnly')"), '实例私有条目给「仅本人可见」')
  assert.ok(source.includes("t('kb3.privateEntrySub')"), '私有条目说明谁能读')
  // 搜索框 + 提案入口 + 索引
  assert.ok(source.includes("className: 'mt-kb-search'") && source.includes("t('kb.search')"), '搜索框（沿用 mt-kb-search）')
  assert.ok(source.includes("t('kb3.index')") && source.includes("t('kb3.indexBudget')"), '查看索引（40 行预算）')
  assert.ok(source.includes("t('kb3.curation')"), '策展制口径')
  // 接线：teamsPage 的知识 tab 把 members 一起传下去（私有层要知道是哪个实例）
  assert.ok(source.includes('j(KnowledgeTab, { t, data: kb, members })'), '知识 tab 传 data + members')
  assert.ok(source.includes("getKnowledge: (query) => call('getKnowledge'"), '数据面仍是门面 getKnowledge（不造第二事实源）')
})

/* ── 二、预设库（design/presets.html） ─────────────────────────────── */

test('t63-2: 预设库——三层来源分区 + 名册预览（队长高亮 + 角色引用 chips）+ 模板三行 + 引用计数', () => {
  assert.ok(source.includes('function PresetsPage('), '预设库子页组件')
  assert.ok(source.includes('presets.entries.map'), '预设卡从预设目录渲染')
  // 三层来源
  assert.ok(source.includes("'preset3.layer.builtin'") && source.includes("'preset3.layer.global'") && source.includes("'preset3.layer.project'"), '三层来源标签')
  assert.ok(source.includes("t('preset3.sectionProject')") && source.includes("t('preset3.sectionGlobal')") && source.includes("t('preset3.sectionBuiltin')"), '按来源分区（项目 / 全局 / 内置）')
  assert.ok(source.includes("t('preset3.globalOff')"), '全局层如实说明只存角色')
  // 名册预览：队长高亮 + 角色引用 chips
  assert.ok(source.includes("className: 'mt-p3-roster'"), '名册预览行')
  assert.ok(source.includes('mt-p3-lead-chip') && source.includes("t('preset3.captain')"), '队长高亮 chip')
  assert.ok(source.includes("t('preset3.roster').replace('{n}'"), '名册计数（队长 + N 个角色引用）')
  // 模板三行：看板列 → 流程 → 门禁链
  assert.ok(source.includes("t('presets.columns')") && source.includes('mt-colpreview'), '模板第一行：看板列 → 泳道维度')
  assert.ok(source.includes("t('preset3.flow')") && source.includes('swimlaneText'), '模板第二行：流程维度')
  assert.ok(source.includes("t('preset3.gates')") && source.includes("t('preset3.gateTimeout')") && source.includes("t('preset3.gatesOff')"), '模板第三行：门禁链（含命令超时 / 已关）')
  // 引用计数
  assert.ok(source.includes('usageOf') && source.includes("t('preset3.usedBy')") && source.includes("t('preset3.unused')"), '引用计数（已用于 N 个团队 / 还没人用）')
  // 内置层兜底模板 + 删除守门
  assert.ok(source.includes('mt-p3-card-builtin') && source.includes("t('preset3.builtinNote')") && source.includes("t('preset3.builtinDesc')"), '内置层「标准三人组」兜底模板')
  assert.ok(source.includes("t('preset3.guard')"), '删除守门提示')
  assert.ok(source.includes("t('preset3.readonly')"), '内置层只读标注')
  // 入口不藏：随行资产卡直接进预设页；页内 teambar 可切回角色库 / 技能
  assert.ok(source.includes("setGlobalPage('presets')"), '随行资产卡 → 预设库')
  assert.ok(source.includes("t('preset3.tabRoles')") && source.includes("t('preset3.tabSkills')"), '角色 / 预设 / 技能 切换')
})

/* ── 三、技能 & MCP（design/skills.html） ───────────────────────────── */

test('t63-3: 技能与 MCP——四层来源 + 成员级隔离 + 绑定次数 / 绑进角色 + MCP 两段式（连接层 ∩ 可见层）', () => {
  assert.ok(source.includes('function SkillsPage('), '技能 & MCP 子页组件')
  // 技能四层来源（按 role.origin 分区，§八-6 不在前端自己算来源）
  for (const key of ['skill3.layer.builtin', 'skill3.layer.global', 'skill3.layer.project', 'skill3.layer.bound']) {
    assert.ok(source.includes(`'${key}'`), `${key} 层标签`)
  }
  assert.ok(source.includes('layerOfSkill') && source.includes('skillsOf'), '按角色来源分区（builtin / global / project / 角色绑定）')
  assert.ok(source.includes("t('skill3.unitBound')"), '第四层单位是「条绑定」')
  // 成员级隔离说明
  assert.ok(source.includes("t('skill3.isolation')") && source.includes("t('skill3.isolationBody')"), '成员级隔离说明')
  // 技能条目：绑定次数 + 未绑定的给「绑进角色」
  assert.ok(source.includes("t('skill3.bindCount')") && source.includes("t('skill3.bindNone')"), '绑定次数 / 本项目 0 个角色绑定')
  assert.ok(source.includes("t('skill3.bind')") && source.includes('onBind'), '未绑定的给「绑进角色」')
  // MCP 两段式：连接层（已连接 / 未连接，插件只读不代连）∩ 可见层（各角色 allowlist）
  assert.ok(source.includes("className: 'mt-mcp-split'"), 'MCP 左右对照栅格')
  assert.ok(source.includes("t('skill3.conn')") && source.includes("t('skill3.vis')"), '两段式：连接层 / 可见层')
  assert.ok(source.includes("t('skill3.connNote')"), '插件只读、绝不代连')
  assert.ok(source.includes("t('skill3.connected')") && source.includes("t('skill3.disconnected')"), '已连接 / 未连接')
  assert.ok(source.includes("className: 'mt-mcp-join'") && source.includes("t('skill3.join')"), '中间链接图标表示交集（∩）')
  assert.ok(source.includes("t('skill3.visNote')") && source.includes('mt-mcp-tags'), '可见层按角色 allowlist 列 chips')
  assert.ok(source.includes("t('skill3.footnote')"), 'allowlist 与连接状态的说明')
  // 数据面：能力目录（getCapabilityCatalog），失败降级为角色声明
  assert.ok(source.includes('getCapabilityCatalog: (query) => rpcCall(connection, \'myteam/getCapabilityCatalog\', { query })'), '能力目录端点')
  assert.ok(source.includes("globalPage === 'skills'"), '技能页加载能力目录')
  assert.ok(source.includes("setGlobalPage('skills')"), '随行资产卡 → 技能 & MCP')
})

/* ── 四、locale：三组键 zh / en 同键 ──────────────────────────────── */

test('t63-4: locale——kb3 / preset3 / skill3 三组键在 zh 与 en 同时存在且非空', () => {
  const { apply, ctx } = loadClient()
  let dicts: any = null
  ctx.locale = {
    bind: () => (k: string) => k,
    register: (_ns: string, d: any) => { dicts = d },
  }
  apply(ctx)
  assert.ok(dicts?.zh && dicts?.en, 'locale.register 收到 zh / en 两份字典')
  const keys = Object.keys(dicts.zh).filter((k) => /^(kb3|preset3|skill3)\./.test(k)).sort()
  assert.ok(keys.length >= 110, `G3 三屏的 locale 键不少于 110 个（实际 ${keys.length}）`)
  const missEn = keys.filter((k) => !(k in dicts.en))
  assert.deepEqual(missEn, [], 'en 与 zh 同键（缺的会回落到键名）')
  const empty = keys.filter((k) => String(dicts.zh[k]).trim() === '' || String(dicts.en[k]).trim() === '')
  assert.deepEqual(empty, [], '没有空文案')
  // 本组用到的 t('literal') 都必须能在两份字典里解析（拼错的键会显示成键名本身）。
  // 只看 kb3/preset3/skill3：别的组在飞的时候键可能还没落到字典里，不替别人背。
  const used = new Set<string>()
  for (const m of source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)) {
    if (/^(kb3|preset3|skill3)\./.test(m[1])) used.add(m[1])
  }
  assert.ok(used.size >= 60, `G3 三屏引用的键不少于 60 个（实际 ${used.size}）`)
  const missing = [...used].filter((k) => !dicts.zh[k] || !dicts.en[k]).sort()
  assert.deepEqual(missing, [], 'G3 所有 t(literal) 都能解析')
})

/* ── 五、样式纪律（t13c-3 的 G3 复核） ─────────────────────────────── */

test('t63-5: 样式纪律——G3 区块只用 --dsw-alias-* token，无十六进制颜色、无 font-family', () => {
  const { styles, apply, ctx } = loadClient()
  assert.equal(styles.length, 0, 'factory 阶段无副作用（不注入样式）')
  apply(ctx)
  assert.equal(styles.length, 1, '样式经 ctx.effect 注入一次')
  const css = styles[0]
  // 取出 G3 那一段（三层清单 → MCP 两段式）
  const start = css.indexOf('.mt-layers{')
  const end = css.indexOf('.mt-mcp-item .mt-avatar{')
  assert.ok(start > 0 && end > start, 'G3 样式区块存在')
  const block = css.slice(start, end)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), 'G3 区块无十六进制颜色')
  assert.ok(!/font-family\s*:/i.test(block), 'G3 区块无 font-family')
  assert.ok(/var\(--dsw-alias-/.test(block), 'G3 区块使用 dsw alias token')
  // 新类名各自有规则（避免「用了类名但没样式」）
  for (const cls of ['mt-layers', 'mt-layer-ico-builtin', 'mt-src-project', 'mt-kb3-rows', 'mt-p3-card', 'mt-colpreview', 'mt-mcp-split', 'mt-mcp-join']) {
    assert.ok(css.includes(`.${cls}`), `.${cls} 有样式规则`)
  }
})

/* ── 六、单一事实源：三屏都不硬编码演示数据 ───────────────────────── */

test('t63-6: 三屏不造第二事实源——不硬编码演示数据，全部从门面视图派生', () => {
  // design/*.html 里的演示内容（dsh-fs / 结算服务端点契约 / 标准三人组字面量）不得进实现
  for (const demo of ['dsh-fs', '结算服务端点契约', '接口评审团队', 'migration-checklist']) {
    assert.ok(!source.includes(`'${demo}'`), `未硬编码演示数据：${demo}`)
  }
  // 数据面：知识 getKnowledge / 预设 getOfflinePresets / 团队 getProject / 能力 getCapabilityCatalog
  assert.ok(source.includes("getOfflinePresets: (query) => rpcCall(connection, 'myteam/getOfflinePresets', { query })"), '预设目录只发 query')
  assert.ok(source.includes('getProject: (query) => rpcCall(connection, \'myteam/getProject\', { query })'), '团队/角色/任务走项目聚合')
  assert.ok(source.includes('teams: project?.teams ?? []'), '预设「已用于 N 个团队」派生自项目团队')
  // 三层来源直接按 origin 分区（§八-6：不要靠路径字符串猜来源）
  assert.ok(source.includes("role.origin") || source.includes(".origin)"), '按 origin 分区')
  assert.ok(!/origin\s*===\s*'[^']*(config|team-workplace|\.dsh)/.test(source), '不靠路径猜来源')
})

/* ── 七、mock loader 真渲染：三个组件能出树（不是只有字符串） ─────────── */

/** 把三个组件挂到 factory 的测试出口上（只改测试里的源码副本，不动源文件） */
function loadComponents() {
  // 别的组已经在 factory 返回值上开了 __test / __testG4 之类的出口；这里在它后面并一个 __testG3
  // （对返回值形状做正则，别的组再加出口也不会把这个测试打挂）。
  const patched = source.replace(
    /return \{ apply, inject([^}]*)\}/,
    'return { apply, inject$1, __testG3: { KnowledgeTab, PresetsPage, SkillsPage } }',
  )
  assert.notEqual(patched, source, 'factory 返回值可挂测试出口')
  const registered: any[] = []
  const slots = {
    inject: (_n: string, f: () => any) => { const r = f(); registered.push(r); return r },
    register: (def: any, component: any) => ({ ...def, component }),
  }
  const modules = new Map<string, any>([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  const captured: any[] = []
  const loader = {
    load: (def: any) => {
      captured.push(def.factory((name: string) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      }))
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(_v: string) {}, style: {} }),
    head: { appendChild: () => {} },
  }
  new Function('window', 'document', patched)({ __ModuleLoader__: loader }, documentObj)
  const api = captured[0].__testG3
  assert.ok(api, '__testG3 出口存在')
  return api
}

/** 收集元素树里的 class 名与文本（null 子节点跳过） */
function walk(node: any, out: { classes: Set<string>; text: string[] } = { classes: new Set(), text: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return out
  }
  const cls = node.props?.className
  if (typeof cls === 'string') for (const c of cls.split(/\s+/).filter(Boolean)) out.classes.add(c)
  walk(node.children ?? [], out)
  return out
}

const t = (k: string) => k

test('t63-7: mock loader 渲染——知识库三层 + 私有条目；预设库名册/模板；技能页四层 + MCP 两段式', () => {
  const { KnowledgeTab, PresetsPage, SkillsPage } = loadComponents()

  /* 知识库：共享 1 条（core+stale）+ 私有 1 条 + 1 条待审提案 */
  const kb = KnowledgeTab({
    t,
    members: [{ id: 'm1', roleId: 'implementer', instanceName: '实现者 2' }],
    data: {
      entries: [
        { id: 'k1', title: '结算服务端点契约', body: '金额字段一律整数分', tags: ['契约'], audience: [], evidence: ['t7#cmd'], proofCount: 4, unverified: false, core: true, staleSince: '2026-10-30', contributor: 'm1', updated: '2026-11-02' },
        { id: 'k2', title: '实现者 2 的工作笔记', body: '私有', tags: [], audience: ['implementer'], evidence: [], proofCount: 0, unverified: true, core: false, contributor: 'm1', updated: '2026-11-03' },
      ],
      proposals: [{ teamId: 't1', draftId: 'd1', title: '提案', tags: [], relation: 'refine', targetId: 'k1', proposedBy: 'captain', at: '2026-11-04T00:00:00Z', evidence: [] }],
      timeline: { k1: [{ teamId: 't1', ts: '2026-11-02T00:00:00Z', relation: 'refine', diff: '+2', actor: 'captain' }] },
    },
  })
  const kbTree = walk(kb)
  for (const cls of ['mt-kb3', 'mt-layers', 'mt-layer', 'mt-layer-ico-builtin', 'mt-layer-ico-project', 'mt-layer-ico-global', 'mt-kb3-rows', 'mt-kb-entry', 'mt-kb3-row', 'mt-kb-search']) {
    assert.ok(kbTree.classes.has(cls), `知识库渲染出 .${cls}`)
  }
  assert.ok(kbTree.text.includes('kb3.privateOnly'), '私有条目渲染「仅本人可见」')
  assert.ok(kbTree.text.includes('kb3.stale'), '可能过期标记')
  assert.ok(kbTree.text.includes('kb3.proposalTitle'), '待确认提案横幅')
  assert.ok(kbTree.text.includes('kb3.review'), '审阅提案入口')

  /* 预设库：项目 1 张（名册 2）+ 内置 1 张，团队里在册 1 个角色 → 引用计数 1 */
  const presets = PresetsPage({
    t,
    teams: [{ teamId: 't1', members: [{ id: 'm1', roleId: 'implementer' }, { id: 'm2', roleId: 'reviewer' }] }],
    presets: {
      entries: [
        { origin: 'project', definition: { id: 'basic-dev', name: '基础开发团队', description: '', members: [{ roleId: 'implementer' }, { roleId: 'reviewer' }], board: { columns: ['backlog', 'ready', 'running', 'gates', 'done'] }, pipeline: { swimlaneBy: 'member', layout: 'serpentine' }, gates: { enabled: true, commandTimeoutMs: 120000 }, taskTypes: { dev: { gateChain: ['review', 'archive'] } } } },
        { origin: 'builtin', definition: { id: 'starter-team', name: '标准三人组', members: [{ roleId: 'req-validator' }, { roleId: 'developer' }, { roleId: 'acceptor' }], board: { columns: ['backlog'] }, gates: { enabled: true, commandTimeoutMs: 120000 } } },
      ],
      warnings: [],
    },
    onBack: () => {},
    onUse: () => {},
    onNotice: () => {},
    onSkills: () => {},
  })
  const pTree = walk(presets)
  for (const cls of ['mt-teambar', 'mt-layers', 'mt-p3-card', 'mt-p3-roster', 'mt-p3-lead-chip', 'mt-tmpl', 'mt-tmpl-row', 'mt-colpreview', 'mt-mini-chip', 'mt-presetgrid']) {
    assert.ok(pTree.classes.has(cls), `预设库渲染出 .${cls}`)
  }
  assert.ok(pTree.classes.has('mt-p3-card-builtin'), '内置层卡片样式（兜底模板）')
  assert.ok(pTree.text.includes('preset3.usedBy'), '引用计数（已用于 N 个团队）')
  assert.ok(pTree.text.includes('preset3.guard'), '删除守门提示')
  assert.ok(pTree.text.includes('preset3.captain'), '名册预览里的队长')

  /* 技能 & MCP：内置 1 技能（1 个角色绑定）+ 全局 1 技能（未绑定）；MCP 已连接 1 / 未连接 1 */
  const skills = SkillsPage({
    t,
    roles: [
      { id: 'implementer', name: '实现者', origin: 'builtin', skills: ['create-role'], mcpAllowlist: ['dsh-fs', 'figma'] },
      { id: 'reviewer', name: '评审者', origin: 'global', skills: ['doc-outline'], mcpAllowlist: [] },
    ],
    catalog: { status: 'ok', skills: [{ name: 'create-role', source: 'host' }, { name: 'orphan-skill', source: 'host' }], mcp: [{ name: 'dsh-fs', source: 'host' }, { name: 'figma', source: 'role' }], warnings: [] },
    onBack: () => {},
    onBind: () => {},
    onNotice: () => {},
    onPresets: () => {},
  })
  const sTree = walk(skills)
  for (const cls of ['mt-teambar', 'mt-layers', 'mt-layer', 'mt-kb3-rows', 'mt-kb3-row', 'mt-mcp-split', 'mt-mcp-pane', 'mt-mcp-head', 'mt-mcp-list', 'mt-mcp-item', 'mt-mcp-join', 'mt-mcp-tags']) {
    assert.ok(sTree.classes.has(cls), `技能页渲染出 .${cls}`)
  }
  assert.ok(sTree.classes.has('mt-mcp-item-off'), '未连接的 server 标灰（mt-mcp-item-off）')
  assert.ok(sTree.text.includes('skill3.bind'), '未绑定的给「绑进角色」')
  assert.ok(sTree.text.includes('skill3.isolationBody'), '成员级隔离说明')
  assert.ok(sTree.text.includes('skill3.join'), '中间链接图标表示交集')
  assert.ok(sTree.text.includes('skill3.disconnected'), '未连接标注')
  // CHG-84：技能名要按设计稿的 .iname 形态（13px/600 主色），不是 11px 灰字
  assert.ok(sTree.classes.has('mt-kb3-name'), '技能条目名用 .mt-kb3-name')
})

/* ── 八、CHG-84 复检：空态骨架 / 栅格 / 层行动作 / 图标 ───────────── */

test('t63-8: CHG-84 复检——知识页无会话也是满屏骨架；预设卡栅格 + 虚线新建卡；层行图标与动作', () => {
  // ① 知识页：不再整页只剩一句话——三层骨架 + 说明 note + 空态脚注都照常渲染
  assert.ok(!/if \(data === null\) return j\('div', \{ className: 'mt-empty'/.test(source), '知识页不再用整页空态短路')
  assert.ok(source.includes('const loading = data === undefined') && source.includes('const unavailable = data === null'), 'loading / unavailable 走同一套骨架')
  assert.ok(source.includes("t('kb3.needsSession')") && source.includes("t('kb3.loadingHint')"), '无活跃会话 / 读取中的说明 note')
  assert.ok(source.includes('j(G3LayerIcon, { kind: icoKind })'), '三层图标用内联 SVG（i-lock / i-globe / i-folder / i-role）')
  assert.ok(source.includes("'role', 'global'") || source.includes("'role'"), '实例私有层用 role 图标')

  // ② 预设页：卡片栅格（design/app.css .grid-2 = minmax(348px,1fr)）+ 虚线「新建预设」卡
  assert.ok(source.includes("'.mt-presetgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(348px,1fr))"), '预设卡栅格（此前 CSS 缺失 → 卡片整行铺满）')
  assert.ok(source.includes("className: 'mt-p3-newcard'") && source.includes("t('preset3.newCardHint')"), '项目分区末尾的虚线「新建预设」卡')
  assert.ok(source.includes("className: 'mt-p3-newcard-icon'"), '虚线卡上的 ＋ 图标')
  assert.ok(source.includes("t('preset3.restore')") && source.includes("t('preset3.seeAll')"), '层行右侧动作（恢复默认 / 看全部）')
  assert.ok(source.includes("className: 'mt-btn', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: `＋ ${t('preset3.new')}`"), '页头「新建预设」是描边按钮（不是实底主色）')

  // ③ 技能页：四层都用同一套图标 + 行名形态
  assert.ok(source.includes("'.mt-kb3-name{font-size:13px;font-weight:600"), '技能名样式（13px/600 主色）')
  assert.ok(source.includes("t('skill3.tabRoles')") && source.includes("t('skill3.tabPresets')"), '技能页 teambar 的「角色 / 预设 / 技能」切换')
})

test('t63-9: 知识页空态渲染——data=null 时仍有三层骨架 + 每层说明 + 空态脚注，只有提案位换说明', () => {
  const { KnowledgeTab } = loadComponents()
  const tree = walk(KnowledgeTab({ t, data: null, members: [] }))
  for (const cls of ['mt-kb3', 'mt-kb3-head', 'mt-layers', 'mt-layer', 'mt-layer-ico-builtin', 'mt-layer-ico-project', 'mt-layer-ico-global', 'mt-kb3-filter', 'mt-kb3-rows', 'mt-kb3-note']) {
    assert.ok(tree.classes.has(cls), `空态渲染出 .${cls}`)
  }
  assert.ok(tree.text.includes('kb3.consensus') && tree.text.includes('kb3.shared') && tree.text.includes('kb3.private'), '三层标题都在')
  assert.ok(tree.text.includes('kb3.consensusPath') && tree.text.includes('kb3.sharedPath') && tree.text.includes('kb3.privatePath'), '每层说明都在')
  assert.ok(tree.text.includes('kb3.needsSession'), '说明条：需要活跃的团队会话')
  assert.ok(tree.text.includes('kb3.curationNote'), '脚注（策展制）仍在')
  assert.ok(tree.text.includes('kb3.consensusEntry'), '共识层条目（AGENTS.md）照常出现')
  assert.ok(!tree.text.includes('roles.unavailable'), '不再整页只有一句 unavailable')

  // 读取中：同一套骨架 + 读取中说明
  const loadingTree = walk(KnowledgeTab({ t, data: undefined, members: [] }))
  assert.ok(loadingTree.text.includes('kb3.loadingHint'), '读取中也给骨架 + 说明')
  assert.ok(loadingTree.classes.has('mt-layers'), '读取中渲染三层清单')
})
