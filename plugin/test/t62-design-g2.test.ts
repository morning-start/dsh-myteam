/**
 * T62 · CHG-82 G2 设计稿对齐契约测试（不依赖真实浏览器/宿主）：
 *  - 四屏：design/roles.html · roster.html · role-detail.html · member-menu.html
 *  - 断言：①G2 组件与设计稿 class 都在实现里 ②zh/en 词条成对 ③样式纪律（只用 --dsw-alias-*、无十六进制、无 font-family）
 *    ④界面词汇纪律：新增 G2 中文词条不出现「成员」（团队内只说角色 / 实例）
 *  - 渲染路径由 Lead 的 CDP 截图收口（docs/13-UI对齐分工.md 四）；这里只做结构自证。
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

/** 加载 client.js（模拟宿主 Loader），捕获 locale 字典与注入的 CSS */
function loadClient() {
  const styles = []
  const locales = []
  const registered = []
  const slots = {
    inject: (name, factory) => {
      const reg = factory()
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
    remote: { myteam: {} },
    locale: { bind: () => (key) => key, register: (ns, dict) => { locales.push({ ns, dict }) } },
    uiWorkspace: {},
    effect: (fn) => fn(),
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
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(value) { styles.push(value) }, style: {} }),
    head: { appendChild: () => {} },
  }
  const source = readFileSync(clientPath, 'utf8')
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  const module = captured[0]
  module.apply(ctx)
  const dict = locales[0]?.dict ?? {}
  return { source, css: styles[0] ?? '', zh: dict.zh ?? {}, en: dict.en ?? {}, registered }
}

/** G2 新增词条（zh 键源；en 必须同键） */
const G2_KEYS = [
  'roles.page.title', 'roles.page.desc', 'roles.createRole', 'roles.createRoleHint', 'roles.chatCreate',
  'roles.introGlobal', 'roles.filterHint', 'roles.searchPlaceholder', 'roles.projectSectionNote',
  'roles.globalSectionNote', 'roles.builtinSectionNote', 'roles.noMatch', 'roles.copyToProject',
  'roles.copyToProjectFresh', 'roles.compare', 'roles.hasCopy', 'roles.noCopy', 'roles.zeroInstances',
  'roles.instanceCount', 'roles.guest', 'roles.guestCopied', 'roles.guestCopyFailed', 'roles.inheritRoute',
  'roles.captainLock', 'roles.copiedFromBuiltin', 'roles.skillCount', 'roles.mcpCount',
  'roles.projectRoleOnline', 'roles.deleteGuard',
  'roster.page.title', 'roster.page.desc', 'roster.summon', 'roster.noCaptain', 'roster.noCaptainHint',
  'roster.instanceCount', 'roster.inheritRoute', 'roster.delivery', 'roster.noTask', 'roster.running',
  'roster.gate', 'roster.idle', 'roster.gateAction', 'roster.multiNote', 'roster.gateNote', 'roster.idleNote',
  'roster.activeNote', 'roster.sameRoleOtherTeam', 'roster.limitNote', 'roster.summonCardHint',
  'roster.menu.label', 'roster.menu.steer', 'roster.menu.steerHint', 'roster.menu.suspend',
  'roster.menu.archive', 'roster.menu.remove', 'roster.menu.restore', 'roster.menu.impact', 'roster.menu.readonly',
  'role.section.definition', 'role.section.definitionNote', 'role.responsibility', 'role.boundary',
  'role.boundaryDefault', 'role.boundaryAllow', 'role.boundaryDeny', 'role.interestHint', 'role.promptTokens',
  'role.expandEdit', 'role.route', 'role.routePrimary', 'role.routeInherit', 'role.skillsNote', 'role.skillAdd',
  'role.skillAddHint', 'role.browse', 'role.mcpNote', 'role.mcpRef', 'role.builtinTools', 'role.toolDeny',
  'role.snapshotTitle', 'role.snapshotBody', 'role.actions', 'role.tryInCaptain', 'role.deleteReadonly',
  'role.readonlyBadge', 'role.membershipCount', 'role.skillEnabled', 'role.browseSkills',
]

/** 设计稿元素 → 实现 class（roles.html / roster.html / role-detail.html / member-menu.html） */
const DESIGN_CLASSES = [
  /* roles.html：.page-head / .dsec-head / .filterbar / .seg / .card / 创建卡 / .team-card */
  'mt-page-head', 'mt-page-head-actions', 'mt-dsec-head', 'mt-dsec-line', 'mt-dsec-n', 'mt-filterbar',
  'mt-searchfield', 'mt-seg-group', 'mt-segbtn', 'mt-cardgrid-3', 'mt-rolecard-lib', 'mt-rolecard-fork',
  'mt-rolecard-instances', 'mt-rolecard-create', 'mt-rolecard-create-hint', 'mt-rolecard-lock',
  'mt-projectrole-card', 'mt-team-zone', 'mt-team-dot', 'mt-team-desc', 'mt-team-meta', 'mt-note-alert',
  /* roster.html：.card（角色为主身份）/ .inst-row / .iname / .mini-chip / 状态 chip / 召唤卡 */
  'mt-roster-grid', 'mt-roster-card', 'mt-roster-card-gate', 'mt-roster-top', 'mt-roster-body',
  'mt-roster-title', 'mt-roster-sub', 'mt-roster-words', 'mt-inst-row', 'mt-iname', 'mt-minichip',
  'mt-minichip-gate', 'mt-inst-right', 'mt-inst-menu-btn', 'mt-roster-foot', 'mt-roster-foot-gate',
  'mt-roster-card-summon', 'mt-roster-summon-title', 'mt-roster-summon-hint', 'mt-roster-inactive',
  'mt-chip-run', 'mt-chip-gate', 'mt-chip-idle', 'mt-shape', 'mt-shape-run', 'mt-shape-gate', 'mt-shape-idle',
  /* member-menu.html：.menu.inline / .menu-label / .menu-item / .menu-sep / .menu-note / .kbd */
  'mt-menupop', 'mt-menu-label', 'mt-menu-item', 'mt-menu-item-danger', 'mt-menu-ico', 'mt-menu-sep',
  'mt-menu-note', 'mt-kbd',
  /* role-detail.html：.detail-grid / .sec / .abl-row / .tgl / .prompt / 侧列 */
  'mt-roledetail', 'mt-roledetail-grid', 'mt-roledetail-main', 'mt-roledetail-side', 'mt-sec', 'mt-sec-info',
  'mt-kvline', 'mt-prompt-head', 'mt-prompt-block', 'mt-abl-list', 'mt-abl-row', 'mt-abl-ico', 'mt-abl-main',
  'mt-abl-name', 'mt-abl-sub', 'mt-tgl', 'mt-tgl-off', 'mt-side-actions',
]

test('t62-1: 四屏组件都在实现里（RoleLibrary / RoleCard / ProjectRoleCard / RoleCardCreate / MemberCard / RosterSummonCard / RoleDetailDrawer）', () => {
  const { source } = loadClient()
  for (const name of ['RoleLibrary', 'RoleCard', 'ProjectRoleCard', 'RoleCardCreate', 'MemberCard', 'RosterSummonCard', 'RoleDetailDrawer']) {
    assert.ok(new RegExp(`function ${name}\\(`).test(source), `${name} 组件存在`)
  }
  /* 名册 tab 与角色库页都由新组件接管 */
  assert.ok(source.includes("j(RoleLibrary, {"), 'rolesPage 用 RoleLibrary 渲染')
  assert.ok(source.includes('groupByRole(active).map(([roleId, list]) => j(MemberCard'), '名册按角色分组渲染 MemberCard')
  assert.ok(source.includes('j(RosterSummonCard,'), '名册末尾渲染「召唤角色」虚线卡')
  /* 实例管理菜单：每实例一行（指导 / 暂停 / 归档（排空）/ 移除）+ 影响面 */
  assert.ok(source.includes("item('steer'") && source.includes("item('suspend'") && source.includes("item('archive'") && source.includes("item('remove'"), '实例菜单四动作')
  assert.ok(source.includes("t('roster.menu.impact')"), '影响面文案')
  /* 复制进项目 / 对比差异 / 用它单干 三个入口 */
  assert.ok(source.includes('onCopyToProject') && source.includes('onCompare') && source.includes('onGuest'), '复制/对比/单干入口')
  /* 角色详情侧列：在册情况 + 快照规则 + 操作 */
  assert.ok(source.includes("t('role.membershipCount')") && source.includes("t('role.snapshotBody')") && source.includes("t('role.tryInCaptain')"), '侧列三块')
})

test('t62-2: 设计稿 class 全部落到实现（逐屏清单）', () => {
  const { source, css } = loadClient()
  const missing = DESIGN_CLASSES.filter((name) => !source.includes(name) && !css.includes(`.${name}`))
  assert.deepEqual(missing, [], `缺失的设计稿 class：${missing.join(', ')}`)
})

test('t62-3: zh/en 词条成对（G2 新增键集合一致且都非空）', () => {
  const { zh, en } = loadClient()
  const missingZh = G2_KEYS.filter((key) => typeof zh[key] !== 'string' || zh[key].length === 0)
  const missingEn = G2_KEYS.filter((key) => typeof en[key] !== 'string' || en[key].length === 0)
  assert.deepEqual(missingZh, [], `zh 缺键：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `en 缺键：${missingEn.join(', ')}`)
  /* 占位符一致：中文里出现的 {x} 在英文里也要有（否则切语言会漏值） */
  for (const key of G2_KEYS) {
    const placeholders = (text) => [...String(text).matchAll(/\{[a-zA-Z]+\}/g)].map((match) => match[0]).sort()
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 占位符不一致`)
  }
})

test('t62-4: 界面词汇纪律——G2 中文词条不出现「成员」（团队内只说角色 / 实例）', () => {
  const { zh } = loadClient()
  const offenders = G2_KEYS.filter((key) => String(zh[key]).includes('成员'))
  assert.deepEqual(offenders, [], `出现「成员」的词条：${offenders.join(', ')}`)
  /* 名册页标题/描述用「队员」与「角色」；角色库用「角色」「实例」 */
  assert.ok(String(zh['roster.page.title']).includes('队员'), '名册标题 = 队员')
  assert.ok(String(zh['roster.page.desc']).includes('角色') && String(zh['roster.page.desc']).includes('实例'), '名册说明含角色 / 实例')
  assert.ok(String(zh['roles.page.title']).includes('角色'), '角色库标题 = 角色库')
})

test('t62-5: 样式纪律——只用 --dsw-alias-* token，无十六进制颜色、无 font-family', () => {
  const { css } = loadClient()
  const stripped = css.replace(/--dsw-[a-z-]+/g, '')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(stripped), 'no hex colors')
  assert.ok(!/font-family\s*:/i.test(css), 'no font-family overrides')
  assert.ok(/--dsw-alias-/.test(css), 'uses dsw alias tokens')
  /* G2 新增区块的关键规则确实注入（不是只写在 JSX 里） */
  for (const rule of ['.mt-roster-card{', '.mt-inst-row{', '.mt-menupop{', '.mt-roledetail-grid{', '.mt-searchfield{', '.mt-page-head{']) {
    assert.ok(css.includes(rule), `CSS 规则 ${rule}`)
  }
})

test('t62-6: 角色库三层来源分区 + 复制/对比语义（运行时只认项目层）', () => {
  const { source } = loadClient()
  /* 三层：项目 / 全局 / 内置 各自一个分区（dsec-head + 该来源计数） */
  assert.ok(source.includes("origin: 'project'") && source.includes("origin: 'global'") && source.includes("origin: 'builtin'"), '三层来源分区')
  assert.ok(source.includes('countOf('), '每层计数来自角色目录（不前端自算）')
  /* 全局有、项目没有 → 「本项目 0 实例」+ 复制进项目（运行时只认项目库，不回退） */
  assert.ok(source.includes("t('roles.zeroInstances')") && source.includes("t('roles.copyToProject')"), '全局卡脚：0 实例 + 复制进项目')
  /* 项目已有副本 → 对比差异（拒绝静默覆盖） */
  assert.ok(source.includes("t('roles.compare')") && source.includes("t('roles.hasCopy')"), '同名副本：对比差异 + 已有副本')
  /* 复制来源标记（fork 自内置） */
  assert.ok(source.includes("t('roles.copiedFromBuiltin')"), '「复制自 内置 · 角色名」')
  /* 兴趣词 chips + 模型路由 + Skill×MCP */
  assert.ok(source.includes("t('roles.interest')") && source.includes("t('roles.inheritRoute')"), '兴趣词 + 继承队长路由')
  assert.ok(source.includes("t('roles.skillCount')") && source.includes("t('roles.mcpCount')"), 'Skill / MCP 计数')
})

test('t62-7: 名册 = 本团队的角色编排（一张卡一个角色 + 实例行 + 引用计数 + 同角色多团队标记）', () => {
  const { source } = loadClient()
  assert.ok(source.includes('groupByRole(active)'), '按 roleId 分组：实现者 ×2 是一张卡')
  assert.ok(source.includes("t('roster.instanceCount')"), '卡头实例计数')
  assert.ok(source.includes("t('roster.delivery')"), '实例行：交付 x/y')
  assert.ok(source.includes("t('roster.sameRoleOtherTeam')"), '同角色多团队标记')
  assert.ok(source.includes("t('roster.noTask')"), '实例行空态：无进行中任务')
  assert.ok(source.includes("t('roster.noCaptain')") && source.includes("t('roster.noCaptainHint')"), '「名册里没有队长」说明')
  assert.ok(source.includes("t('roster.limitNote')"), '团队规模上限说明')
  /* 队长不渲染进名册：roster 卡只由 members 分组而来，captain 走说明条 */
  assert.ok(source.includes('roleOf(roleId)'), '角色定义按 roleId 从目录取（不造第二事实源）')
})

test('t62-8: 角色详情——定义与设定 / 技能开关 / MCP 与工具 / 在册情况 / 快照规则', () => {
  const { source } = loadClient()
  assert.ok(source.includes("spacedHead('role.section.definition'") && source.includes("t('role.responsibility')") && source.includes("t('role.boundary')"), '定义与设定三段')
  assert.ok(source.includes("t('role.promptTokens')") && source.includes("t('role.expandEdit')"), '系统提示词块 + token 估算 + 展开编辑')
  assert.ok(source.includes("t('role.routePrimary')") && source.includes("t('role.routeInherit')"), '模型路由（主 / 继承）')
  assert.ok(source.includes("t('role.skillsNote')") && source.includes("t('role.skillAdd')"), '技能：启用计数 + 从技能库添加')
  assert.ok(source.includes('mt-tgl'), '技能启用开关样式')
  assert.ok(source.includes("t('role.mcpRef')") && source.includes("t('role.builtinTools')"), 'MCP 已引用 + 内置工具')
  assert.ok(source.includes("t('role.memberships')") && source.includes("t('role.snapshotBody')"), '在册情况 + 快照规则')
  assert.ok(source.includes("t('role.deleteReadonly')"), '内置只读的删除按钮文案')
  /* 两段确认仍在（先 usage 再 delete） */
  assert.ok(source.includes("r?.status === 'confirm-required'"), '删除两段确认')
})

test('t62-9: 离线/只读降级——实例菜单禁用、只读提示可见', () => {
  const { source } = loadClient()
  assert.ok(source.includes("t('roster.menu.readonly')"), '只读时菜单给提示')
  assert.ok(source.includes("t('offline.readonlyTip')"), '离线团队只读横幅')
  assert.ok(source.includes('disabled: readOnly || busy'), '只读禁用写动作')
})
