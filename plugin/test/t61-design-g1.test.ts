/**
 * T61 · G1 设计稿对齐（CHG-82）—— design/detail.html · confirm.html · discard.html
 *
 * 覆盖口径（docs/13-UI对齐分工.md §四）：
 *  1) mock loader 能加载 client.js（window.__ModuleLoader__ + react / react/jsx-runtime 模块表），
 *     apply 后注入样式、注册三插槽；
 *  2) 任务详情从「右侧抽屉」改为主区整页：mt-detail-page + 面包屑 + 主列/侧列双栏；
 *  3) 设计稿元素都能找到对应 class 与文案（验收标准 / 证据按 attempt 分组 / 时间线 / thread /
 *     依赖 · 门禁 · 成本归因 / 团队卡 / 两段确认）；
 *  4) 成本数字一律带「估算」（FR-8.3）；
 *  5) 样式纪律：G1 落点内只用 --dsw-alias-* token、无十六进制颜色、无 font-family；
 *  6) 原有 RPC 动作（重新规划 / 取消 / 编辑 / 留言 / 诊断修复）一个不丢。
 *
 * 说明：CDP 整屏截图由 Lead 统一做（docs/13 §四），本文件只做结构断言。
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
const j = (type, props, ...children) => ({ type, props: props ?? {}, children: (props?.children !== undefined ? [props.children, ...children] : children).flat() })
const js = (type, props, ...children) => j(type, props, ...children)
const reactShim = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/** 加载 client.js（模拟宿主 Loader），返回 { registered, styles, effects, apply, ctx } */
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
    effect: (fn) => { const cleanup = fn(); effects.push(typeof cleanup === 'function' ? cleanup : () => {}); return cleanup },
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
    createElement: () => ({ dataset: {}, set textContent(v) { styles.push(v) }, style: {} }),
    head: { appendChild: () => {} },
  }
  const fn = new Function('window', 'document', source)
  fn({ __ModuleLoader__: loader }, documentObj)
  return { registered, styles, effects, apply: captured[0]?.apply, ctx }
}

/** 源码切片（左闭右开）：从 from 到下一个 to；只在自己的区域里断言，不越界 */
function slice(from, to) {
  const start = source.indexOf(from)
  assert.ok(start >= 0, `anchor not found: ${from}`)
  const end = to ? source.indexOf(to, start + from.length) : source.length
  assert.ok(end > start, `end anchor not found: ${to}`)
  return source.slice(start, end)
}

const TASK_DETAIL_FROM = '    /* ── 任务详情（design/detail.html）：主区整页 = 面包屑 + 主列/侧列 + 成本归因 ── */'
const DISCARD_FROM = '    /* ── 丢弃暂存计划的两段确认（design/discard.html）──'
const DISBAND_FROM = '    /* ── 解散团队的两段确认（design/confirm.html）──'
const BANNER_FROM = '    /* ── 暂存横幅三动作（FR-1.2：面板唯一写入口）──'
const TABS_END = '    /* ── 成本 tab（FR-8.2/8.4，CHG-47）'

/** 任务详情组件源码（TaskDetail 全文） */
const taskDetailSrc = () => slice(TASK_DETAIL_FROM, DISCARD_FROM)
/** 丢弃对话框源码 */
const discardSrc = () => slice(DISCARD_FROM, DISBAND_FROM)
/** 解散对话框源码 */
const disbandSrc = () => slice(DISBAND_FROM, BANNER_FROM)
/** 暂存横幅源码 */
const bannerSrc = () => slice(BANNER_FROM, TABS_END)
/** G1 的样式落点：`/* [G1 detail] design/detail.html` 到 `/* [G2 roster] design/roles.html` 之间 */
const g1CssSrc = () => slice('/* [G1 detail] design/detail.html', '/* [G2 roster] design/roles.html')

/* ── 1. mock loader：可加载、注样式、注册插槽 ─────────────────────────── */

test('t61-1: client.js 可经 mock loader 加载，apply 注入样式并注册基础三插槽', () => {
  const { registered, styles, apply, ctx, effects } = loadClient()
  assert.equal(styles.length, 0, 'factory 无副作用（不在加载期注入样式）')
  apply(ctx)
  // CHG-82：插槽数不再硬编码 3 —— 会话页/工具卡（design-notes §二）追加了
  // conversation.view + 4 个 keyed tool.call.toolview。这里只保证「基础三插槽存在」。
  assert.ok(registered.length >= 3, `至少 3 个插槽，实际 ${registered.length}`)
  for (const name of ['main', 'sidebar.panellist', 'conversation.composer.dock']) {
    assert.ok(registered.some((r) => r.name === name), `缺基础插槽：${name}`)
  }
  assert.equal(styles.length, 1, '样式经 ctx.effect 注入一次')
  assert.ok(effects.length >= 2 && effects.every((fn) => typeof fn === 'function'), '资源都可清理')
  const css = styles[0]
  assert.ok(css.includes('.mt-detail-page{'), '注入的 css 里有详情页根容器')
  assert.ok(css.includes('.mt-crumbbar{'), '注入的 css 里有面包屑')
  assert.ok(css.includes('.mt-detail-grid{'), '注入的 css 里有双栏栅格')
})

/* ── 2. 任务详情 = 主区整页（不再是右侧抽屉）─────────────────────────── */

test('t61-2: 任务详情改为主区整页（面包屑 + 主列/侧列双栏），不再渲染 mt-drawer', () => {
  const detail = taskDetailSrc()
  assert.ok(detail.includes("className: 'mt-detail-page'"), '根容器 = 整页')
  assert.ok(detail.includes("className: 'mt-crumbbar'"), 'design .crumbbar 面包屑')
  assert.ok(detail.includes("className: 'mt-detail-grid'"), 'design .detail-grid 双栏')
  assert.ok(detail.includes("className: 'mt-detail-main'") && detail.includes("className: 'mt-detail-side'"), '主列 + 侧列')
  assert.ok(detail.includes("className: 'mt-detail-title'") && detail.includes("className: 'mt-detail-eyebrow'"), '标题 + 眉标')
  assert.ok(!detail.includes("className: 'mt-drawer'"), '不再用右侧抽屉容器')
  const css = g1CssSrc()
  assert.ok(css.includes('.mt-workspace:has(> .mt-detail-page)'), '工作台里只有详情页时盖住其余内容（不动别人的挂载点）')
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) 372px'), '主区整页双栏（主列自适应 + 侧列 372px）')
})

/* ── 3. 设计稿元素 → class + 文案 ───────────────────────────────────── */

test('t61-3: detail.html 元素齐全（验收标准逐条 pass / 证据按 attempt 分组 / 时间线 / thread / 团队卡）', () => {
  const detail = taskDetailSrc()
  // 验收标准：逐条 pass 标记 + 计数
  assert.ok(detail.includes("className: 'mt-ac-list'"), 'design .ac-list')
  assert.ok(detail.includes("'mt-ac ' + (ok ? 'mt-ac-pass' : 'mt-ac-pending')"), 'pass / pending 两态')
  assert.ok(detail.includes("t('detail.acVerified')"), '「N / M 已验」计数')
  // 证据：按 attempt 分组 + 命令 + 退出码
  assert.ok(detail.includes("className: 'mt-evidence'") && detail.includes("className: 'mt-evgroup'"), '证据分组容器')
  assert.ok(detail.includes("t('detail.attemptGroup')"), 'attempt 组标题')
  assert.ok(detail.includes('mt-exit-ok') && detail.includes('mt-exit-fail'), '退出码徽标两态')
  assert.ok(detail.includes("t('detail.exitCode')"), '退出码文案')
  // 时间线
  assert.ok(detail.includes("className: 'mt-timeline'") && detail.includes("'mt-tl ' + tlTone(event.type)"), '时间线（节点三通道）')
  assert.ok(detail.includes("t('detail.timeline')"), '时间线标题')
  // thread + 留言框
  assert.ok(detail.includes("className: 'mt-thread'") && detail.includes("className: 'mt-composer-mini'"), 'thread + 留言框')
  assert.ok(detail.includes("t('detail.commentPlaceholder')") && detail.includes('api.postComment('), '留言走 postComment（human 身份）')
  // 参与团队卡（主责 / 协作 + 团队号）
  assert.ok(detail.includes("className: 'mt-tc-card'") && detail.includes("className: 'mt-tc-zone'"), 'design .team-card')
  assert.ok(detail.includes("t('task.owner')") && detail.includes("t('task.coop')"), '主责 / 协作')
  // 依赖 / 门禁
  assert.ok(detail.includes("t('detail.depsUpstream')") && detail.includes("className: 'mt-dt-dep-id'"), '依赖：上游行')
  assert.ok(detail.includes("className: 'mt-gate' + (verdict"), '门禁链逐门裁决')
  // 交付物（FR-10.4）
  assert.ok(detail.includes("className: 'mt-deliverables'") && detail.includes("t('detail.deliverables')"), '交付物清单')
  // 改动记录（CHG-73）
  assert.ok(detail.includes('j(EditHistory, { t, edits: detail.edits'), '改动记录折叠区')
})

test('t61-3b: detail 区块顺序（眉标 → 验收标准 → 证据 → 时间线 → thread；侧列团队卡 → 成本 → 操作）', () => {
  const detail = taskDetailSrc()
  const order = [
    'mt-detail-eyebrow',
    "t('detail.ac')",
    "t('detail.evidence')",
    "t('detail.timeline')",
    "t('detail.thread')",
    "className: 'mt-tc-card'",
    "t('detail.cost')",
    "t('detail.ops')",
  ]
  const positions = order.map((needle) => detail.indexOf(needle))
  positions.forEach((pos, index) => assert.ok(pos >= 0, `区块存在: ${order[index]}`))
  const sorted = [...positions].sort((a, b) => a - b)
  assert.deepEqual(positions, sorted, `区块顺序应为 ${order.join(' → ')}`)
})

/* ── 4. 成本归因：一律带「估算」（FR-8.3）────────────────────────────── */

test('t61-4: 成本归因带「估算」标注，且数字从 getTokens 派生（不造第二事实源）', () => {
  const detail = taskDetailSrc()
  assert.ok(detail.includes("t('detail.costEstimate')"), '「估算」徽标')
  assert.ok(detail.includes("t('detail.costNote')"), '口径说明（按 tokenMeter 用量比例分摊）')
  assert.ok(detail.includes("t('detail.costTask')") && detail.includes("t('detail.costHit')"), '本任务累计 / 缓存命中')
  assert.ok(detail.includes('api.getTokens({ teamId })'), '成本走 getTokens（单一事实源）')
  assert.ok(detail.includes('readOnly || !api || typeof api.getTokens'), '离线/只读降级为「不可用」')
  assert.ok(detail.includes("t('detail.costUnavailable')"), '不可用文案')
  assert.ok(detail.includes("t('detail.costShare')") && detail.includes("t('detail.costMiss')"), '占团队消耗 / 未命中·输出')
})

/* ── 5. 两段确认（confirm.html 解散 / discard.html 丢弃）────────────── */

test('t61-5: 解散团队两段确认——四条不可撤销影响 + 输入团队 ID 才能提交 + 改用归档出口', () => {
  const dialog = disbandSrc()
  assert.ok(dialog.includes('function DisbandDialog('), 'DisbandDialog 组件')
  assert.ok(dialog.includes("t('disband.irreversible')") && dialog.includes("t('disband.step')"), '不可撤销 + 第 2 步，共 2 步')
  assert.ok(dialog.includes("t('disband.impactTitle')"), '影响面标题')
  for (const key of ['disband.impactMembers', 'disband.impactTasks', 'disband.impactArchive', 'disband.impactPrivate']) {
    assert.ok(dialog.includes(`t('${key}')`), `影响面条目: ${key}`)
  }
  assert.ok(dialog.includes("t('disband.inputLabel')"), '输入团队 ID 确认')
  assert.ok(dialog.includes("const matched = String(typed).trim() === String(teamId ?? '')"), 'ID 匹配判定')
  assert.ok(dialog.includes('disabled: busy || !matched'), 'ID 不匹配时不可提交')
  assert.ok(dialog.includes("t('disband.archive')"), '「改用归档」出口')
  assert.ok(dialog.includes("t('disband.inputHint')"), '引导归档的说明')
  assert.ok(dialog.includes("role: 'alertdialog'") && dialog.includes("'aria-modal': true"), '模态语义（aria-modal）')
  assert.ok(dialog.includes("t('disband.needId')"), 'ID 不一致的错误提示')
})

test('t61-6: 丢弃暂存计划两段确认——影响面 + 引导改用 Revise，且不再用 window.confirm', () => {
  const dialog = discardSrc()
  assert.ok(dialog.includes('function DiscardDialog('), 'DiscardDialog 组件')
  assert.ok(dialog.includes("t('discard.step')") && dialog.includes("t('discard.title')"), '第 2 步 + 标题')
  assert.ok(dialog.includes("t('discard.impactTitle')"), '影响面标题')
  for (const key of ['discard.impactTasks', 'discard.impactState', 'discard.impactNoToken', 'discard.impactKeep']) {
    assert.ok(dialog.includes(`t('${key}')`), `影响面条目: ${key}`)
  }
  assert.ok(dialog.includes("t('discard.summary')") && dialog.includes("t('discard.summaryText')"), '计划摘要行')
  assert.ok(dialog.includes("t('discard.reviseHint')"), '引导改用 Revise')
  assert.ok(dialog.includes("t('discard.archive')"), '「看草稿归档」出口')
  assert.ok(dialog.includes('api.getBoard({ teamId })'), '影响面计数从 getBoard 现算')
  assert.ok(dialog.includes("api.planAction({ teamId, action: 'discard', planId, confirm: true })"), '第二段：confirm:true 才落账')
  // 第一段：confirm:false 只拿 confirm-required，然后弹两段确认
  const banner = bannerSrc()
  assert.ok(banner.includes("confirm: false"), '第一段：confirm:false')
  assert.ok(banner.includes('setDiscard({ planId })'), 'confirm-required → 打开两段确认对话框')
  assert.ok(!banner.includes('window.confirm('), '不再用 window.confirm')
  assert.ok(banner.includes("act('approve')") && banner.includes("act('revise')") && banner.includes("act('discard')"), '暂存横幅三动作都在')
})

/* ── 6. 样式纪律（G1 落点内）────────────────────────────────────────── */

test('t61-7: G1 样式只用 --dsw-alias-* token；无十六进制颜色、无 font-family', () => {
  const css = g1CssSrc()
  const withoutTokens = css.replace(/--dsw-[a-z0-9-]+/g, '')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(withoutTokens), 'no hex colors')
  assert.ok(!/font-family\s*:/i.test(css), 'no font-family overrides')
  assert.ok(/--dsw-alias-/.test(css), 'uses dsw alias tokens')
  assert.ok(css.includes('color-mix(in srgb, var(--dsw-alias-'), '半透明一律走 color-mix（不写 rgba/hex）')
  assert.ok(!/rgba?\(/i.test(css), 'no rgb()/rgba() literals')
  // G1 落点覆盖三屏：详情页 + 两段确认
  for (const cls of ['.mt-detail-page{', '.mt-crumbbar{', '.mt-ac-list{', '.mt-evidence{', '.mt-timeline{', '.mt-thread{', '.mt-tc-card{', '.mt-impact{', '.mt-dialog-steps{']) {
    assert.ok(css.includes(cls), `样式规则存在: ${cls}`)
  }
  // 两套状态色只用语义 token（H4：形状 + 文字 + 颜色三通道）
  for (const token of ['--dsw-alias-state-ok-primary', '--dsw-alias-state-warning-primary', '--dsw-alias-state-error-primary', '--dsw-alias-label-emphasis']) {
    assert.ok(css.includes(token), `语义 token: ${token}`)
  }
})

/* ── 7. 原有 RPC 动作一个不丢 ──────────────────────────────────────── */

test('t61-8: 详情页保留全部 RPC 动作（重新规划 / 取消 / 编辑 / 留言 / 诊断修复）', () => {
  const detail = taskDetailSrc()
  assert.ok(detail.includes('onClick: () => onRescope?.(detail)'), '重新规划（rescope）')
  assert.ok(detail.includes('onClick: () => onCancel?.(detail)'), '取消（cancel）')
  assert.ok(detail.includes('onClick: () => onEdit?.(detail)'), '编辑（edit）')
  assert.ok(detail.includes('api.postComment({ teamId, taskId, content: comment.trim() })'), '留言（postComment）')
  assert.ok(detail.includes('j(DiagFix, { t, api, teamId, taskId, diagnosis: detail.diagnosis, readOnly, onFixed: onDiagnosisFixed })'), '诊断一键修复')
  assert.ok(detail.includes("t('task.readonlyTitle')") && detail.includes("t('action.unavailable')"), '只读 / 不可用说明（title）')
  for (const cls of ['mt-banner-stale', 'mt-banner-cancel', 'mt-banner-rewired']) {
    assert.ok(detail.includes(cls), `横幅保留: ${cls}`)
  }
  // 离线只读：隐藏留言输入
  assert.ok(detail.includes("t('offline.readonlyTip')"), '离线只读提示')
})

/* ── 8. locale：zh / en 两处都补，键集合一致 ────────────────────────── */

test('t61-9: G1 的 locale 键在 zh 与 en 都补齐（键集合一致）', () => {
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  assert.ok(zhStart >= 0 && enStart > zhStart, 'zh / en 两张表')
  const zh = source.slice(zhStart, enStart)
  const en = source.slice(enStart, source.indexOf('\n    }\n', enStart))
  const g1Keys = (text) => [...text.matchAll(/'(detail\.[A-Za-z]+|disband\.[A-Za-z]+|discard\.[A-Za-z]+)':/g)].map((m) => m[1])
  const zhKeys = new Set(g1Keys(zh))
  const enKeys = new Set(g1Keys(en))
  for (const key of zhKeys) assert.ok(enKeys.has(key), `en 缺键: ${key}`)
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh 缺键: ${key}`)
  for (const key of ['detail.crumb', 'detail.crumbBoard', 'detail.acVerified', 'detail.evidenceHead', 'detail.costEstimate', 'detail.costNote', 'disband.title', 'disband.irreversible', 'disband.archive', 'discard.title', 'discard.impactTitle', 'discard.reviseHint']) {
    assert.ok(zhKeys.has(key), `zh 缺键: ${key}`)
  }
  assert.ok(zhKeys.size >= 50, `G1 的 locale 键数量（实际 ${zhKeys.size}）`)
})

/* ── 9. CHG-84 复检：把对着设计稿补齐的形态锁住 ─────────────────────── */

test('t61-10: 复检（CHG-84）——区块标题字面 / 竖排任务操作 / 主责·协作 chip / 成本四行常显', () => {
  const detail = taskDetailSrc()
  // 区块标题与 design/detail.html 字面一致（依赖关系 / 门禁链）
  assert.ok(detail.includes("t('detail.depsTitle')"), '标题「依赖关系」')
  assert.ok(detail.includes("t('detail.gatesTitle')"), '标题「门禁链」')
  // 任务操作：design 是竖排三颗、「取消此任务」
  assert.ok(detail.includes("t('detail.cancelTaskBtn')"), '按钮「取消此任务」')
  // 参与团队卡：主责 / 协作是 chip（不是 mini-chip），卡下两颗按钮
  assert.ok(detail.includes("'mt-chip ' + (party.role === 'lead' ? 'mt-chip-run' : 'mt-chip-idle')"), '主责 / 协作 chip')
  assert.ok(detail.includes("className: 'mt-tc-actions'"), '卡下按钮容器')
  assert.ok(detail.includes("t('detail.messageMember')") && detail.includes("t('detail.enterTeam')"), '私讯 / 进入团队')
  // 成本归因：design 的四行常显（无 token 侧车时值留「—」）
  assert.ok(detail.includes("costKnown ? fmtTok(tokenCount(taskSum)) : '—'"), '本任务累计行常显')
  assert.ok(detail.includes("costKnown ? hitRateOf(taskSum) : '—'"), '缓存命中行常显')
  assert.ok(detail.includes("costKnown ? null : j('p'"), '不可用提示行（不造假数据）')
  // 已跑时长走「12m」形态；面包屑带回退箭头
  assert.ok(detail.includes('fmtElapsed(Date.now() - detail.createdAt)'), '已跑时长格式化')
  assert.ok(detail.includes("children: '‹'"), '面包屑回退箭头')
  // 样式：竖排按钮 / chip 形态 / 摘要卡 / 失败色 chip
  const css = g1CssSrc()
  for (const rule of ['.mt-tc-actions{', '.mt-detail-page .mt-detail-actions{flex-direction:column', '.mt-dt-summary{', '.mt-mini-chip.mt-mini-chip-fail{']) {
    assert.ok(css.includes(rule), `样式规则: ${rule}`)
  }
})

test('t61-11: 复检（CHG-84）——两段确认的措辞与形状（◆ 第 2 步 / ⚠ 不可撤销 / 计划摘要卡）', () => {
  const discard = discardSrc()
  assert.ok(discard.includes("t('discard.step')") && discard.includes("children: '◆'"), '丢弃：第 2 步 chip 带形状')
  assert.ok(discard.includes("className: 'mt-dt-summary'"), '丢弃：计划摘要卡')
  assert.ok(discard.includes("t('discard.reviseHint')"), '丢弃：引导改用 Revise')
  const disband = disbandSrc()
  assert.ok(disband.includes('mt-mini-chip-fail') && disband.includes("children: '⚠'"), '解散：不可撤销 chip（fail 色 + 警告形状）')
  assert.ok(disband.includes("t('disband.impactMembers')") && disband.includes("t('disband.impactTasks')"), '解散：四条不可撤销影响')
  assert.ok(disband.includes("t('disband.archive')") && disband.includes("t('disband.inputLabel')"), '解散：「改用归档」出口 + 输入团队 ID')
})
