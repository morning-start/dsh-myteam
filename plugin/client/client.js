/**
 * dsh-myteam client 插件（T13，M1 收窄版 CHG-16 第一刀 + 官方生命周期对齐修订）。
 *
 * 形态（与官方 dsh-experimental-client-ui-agent-team 同构，ui-plugin.md 契约）：
 *   window.__ModuleLoader__.load({ id, factory(require) }) — 懒 CJS 模块表消费；
 *   factory 返回 { apply, inject }：inject 声明必需的浏览器服务，apply(ctx) 注册资源，
 *   所有注册（locale 字典/样式/插槽）放进 ctx.effect —— 卸载即回收。
 *
 * 修订记录（对照官方 client 的三处结构缺陷）：
 *   ① apply 未导出 inject、未注册 locale 字典 → 补（visible text 走 locale service）；
 *   ② 样式在 factory 阶段注入（不可清理）→ 移入 ctx.effect；
 *   ③ Panel/DockChip 依赖的 ctx 经插槽 inject: () => ({ ctx }) 传入（原实现传 () => ({})
 *      导致组件拿到 undefined 一渲染即崩）。
 *
 * 纪律（NFR-7.2/F2）：面板只读服务投影，数据绝不进模型上下文；
 * 写只走 planAction/postComment/disband（ADR-006 面板唯一写入口 = 账本管线）。
 * 样式只用 --dsw-alias-* token（PRD 落点纪律），H4 三通道（文字+图标+形状）不依赖颜色。
 *
 * M2 RPC 通道（阶段四十七~四十九网关取证后定案）：宿主侧新增根级门面服务
 * MyTeamPanelFacade（src/panel.ts，namespace=myteam），方法首参 `agent` 由网关
 * lookup 解析成 Agent 实例（客户端传 sessionId）；隔离的 MyTeamRemote 经
 * agentPresets.serviceFor(agent,'myteam') 读取。客户端不走 $mount/生成描述符
 * （strip-only 无 codegen），直连网关 RPC：connection.rpc.call('/api','myteam/<method>',
 * { args: { agentId, query } })，返回 {ok,value}|{ok,error} 信封（官方 invokeRemote 同形）。
 * slot inject 回调首参 = binding.key = sessionId（dsh-client-ui-renderer runInject）；
 * root 槽（main）无 binding → Panel 先 listTeams 发现队长会话。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-myteam',
  factory: (require) => {
    const { jsx: j, jsxs: js } = require('react/jsx-runtime')
    const react = require('react')

    const PANEL_KEY = 'myteam'
    const NS = 'myteam.panel'
    /**
     * 轮询间隔（R34 / design-notes §十：面板 5s 轮询）。
     *
     * 修复前两处各自写死 15000 / 20000，且**完全不看** `document.visibilityState`——
     * 面板切到后台（或宿主窗口最小化）时仍在按秒发 RPC，白烧网关与账本折叠。
     * 现在统一走这个常量：到点先看可见性，hidden 直接跳过（不请求），
     * `visibilitychange` 回到 visible 时立刻补一次。
     */
    const POLL_MS = 5000
    /** 后台标签页是否该跳过本轮（无 document 的 SSR/测试环境一律视为可见） */
    const isHidden = () => (typeof document === 'undefined' ? false : document.visibilityState === 'hidden')

    /* ── CHG-99（C13）：宿主深色信号 ──────────────────────────────────────────
     * 宿主 ui-layout 的 ThemePresenter 把**解析后的**主题写在 `body[data-ds-dark-theme]`
     * （dark → `setAttribute("")`，light → `removeAttribute`），同一份 apply 里还写
     * `document.documentElement.style.color-scheme` 与 `data-ds-theme-source`。
     * 面板原来读「系统偏好」媒体查询：用户在宿主里手动切深色（不跟随系统）时它不触发
     * → 13 组 color-mix 叠加色不重算 → 深色底上叠出浅色胶囊
     * （`.mt-note-info` / `.mt-mini-chip-lead` / `.mt-rolecard-captain` / `.mt-guestbar` /
     * `.mt-status-filled` 等，对比度低于 2:1）。
     * 现在按宿主自己的发布方式读：MutationObserver 订阅 body 属性 +
     * useSyncExternalStore 接进 React（参照 dsh-talk-map `use-dark.ts`）。
     * **降级是必需项**：老宿主从不发布该属性 → 回退 `matchMedia` 的系统偏好（见 darkMediaQuery）。
     * 全程 try/catch：factory 求值期与渲染期都不得抛（宿主把插件 entry 未激活当致命错误）。 */
    const DARK_ATTRIBUTE = 'data-ds-dark-theme'
    /** 宿主是否在发布「解析后的主题」（新宿主同时写 root 的 color-scheme / data-ds-theme-source） */
    const hostPublishesResolvedTheme = () => {
      if (typeof document === 'undefined') return false
      try {
        const root = document.documentElement
        if (!root) return false
        if (root.style && root.style.colorScheme) return true
        return typeof root.hasAttribute === 'function' && root.hasAttribute('data-ds-theme-source')
      } catch {
        return false
      }
    }
    /** 系统偏好媒体查询（老宿主的降级通道；没有 matchMedia 的环境返回 null） */
    const darkMediaQuery = () => {
      try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)')
          : null
      } catch {
        return null
      }
    }
    /** 系统是否偏好深色（无 matchMedia 一律浅色） */
    const systemPrefersDark = () => darkMediaQuery()?.matches === true
    /** 当前**解析后**的深色态：宿主信号优先，老宿主回退系统偏好（返回裸布尔，快照才稳定） */
    const readDarkTheme = () => {
      if (typeof document === 'undefined') return false
      try {
        const body = document.body
        if (body && typeof body.hasAttribute === 'function' && body.hasAttribute(DARK_ATTRIBUTE)) return true
        return hostPublishesResolvedTheme() ? false : systemPrefersDark()
      } catch {
        return false
      }
    }
    /** 订阅：body 的主题属性变化 +（老宿主）系统偏好变化；返回退订函数 */
    const subscribeDarkTheme = (listener) => {
      if (typeof document === 'undefined' || !document.body) return () => {}
      const unsubs = []
      try {
        if (typeof MutationObserver === 'function') {
          const observer = new MutationObserver(() => listener())
          observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
          unsubs.push(() => observer.disconnect())
        }
      } catch { /* 无 MutationObserver：退化为一次性快照，至少首帧正确 */ }
      try {
        const media = darkMediaQuery()
        if (media && typeof media.addEventListener === 'function') {
          media.addEventListener('change', listener)
          unsubs.push(() => media.removeEventListener('change', listener))
        }
      } catch { /* 同上 */ }
      return () => { for (const off of unsubs) { try { off() } catch { /* 退订失败不影响卸载 */ } } }
    }
    /** useSyncExternalStore 的兜底（老 React / 测试替身没有该 API 时退化为 useState + useEffect） */
    const useSyncExternalStoreSafe = typeof react.useSyncExternalStore === 'function'
      ? react.useSyncExternalStore
      : (subscribe, getSnapshot) => {
        const [value, setValue] = react.useState(getSnapshot)
        react.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot])
        return value
      }
    /** useRef 的兜底（测试替身没有 useRef 时不 throw；与 DAG 测量处的写法一致） */
    const useRefSafe = react.useRef ?? ((init) => ({ current: init }))
    /** 面板表面根：把「解析后的深色态」写到插件自己的根节点上（见 CHG-99 / C13） */
    const useDarkTheme = () => useSyncExternalStoreSafe(subscribeDarkTheme, readDarkTheme) === true

    /* ── locale 字典（ui-plugin.md：visible text 走 locale service；zh 为键源，en 对照）── */
    const zh = {
      'panel.title': 'myteam 团队面板',
      'panel.roster': '名册',
      'panel.board': '阶段看板',
      'banner.staged': '计划已暂存',
      'banner.waiting': '等待人工裁决',
      'action.approve': '✓ Approve & Run',
      'action.revise': '↻ Revise',
      'action.discard': '✕ Discard',
      'action.reload': '↻',
      'action.close': '关闭',
      'action.send': '发送',
      'detail.timeline': '流转时间线',
      'detail.evidence': '验证证据',
      'detail.thread': '沟通 thread',
      'detail.commentPlaceholder': '留言进任务 thread（actor=human）…',
      'detail.commentSent': '✓ 已留痕',
      'roster.empty': '暂无队员。在队长会话用 myteam_spawn_member 召唤。',
      'chip.title': 'myteam 团队状态（点击打开面板）',
      'error.unreadable': '无法读取团队状态：',
      'error.hint': '（在项目工作区中用 team 预设会话创建团队后重试）',
      'panel.unavailable': '当前工作区暂无活跃的 myteam 团队——在队长会话（团队模式）提交计划后，这里会出现看板。',
      'scope.label': '视图',
      'scope.global': '全局',
      'scope.team': '团队',
      'scope.hint': '所有工作区的 myteam 团队',
      'global.createHint': '面板只做查看与管理；团队/角色在「团队模式」预设会话中创建',
      'global.empty': '还没有团队。',
      'global.emptyHint': '团队与角色通过「团队模式」预设会话创建——新开一个团队模式会话，队长会出现在这里。',
      'global.counts': '完成 {done}/{total}',
      'global.running': '进行中 {n}',
      'global.online': '在线',
      'global.offline': '离线',
      'global.updated': '更新 {time}',
      'global.groupCount': '{n} 个团队',
      'global.search': '筛选团队（名称/目标/项目）…',
      'global.noMatch': '没有匹配的团队。',
      'offline.banner': '离线快照 · 会话未运行，数据来自账本（只读）',
      'offline.updated': '最后活动 {time}',
      'offline.empty': '该团队账本暂无可展示的事件。',
      'offline.degraded': '账本有 {n} 条无法解析的记录，已跳过。',
      'offline.readonlyTip': '只读视图：启动「团队模式」会话后可继续操作。',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'rel.none': '暂无角色使用记录',
      'action.disband': '解散…',
      'disband.impact': '解散将排空 {members} 名队员、{tasks} 个任务转 blocked，账本与 token 归档。',
      'disband.confirm': '确认解散',
      'disband.cancel': '取消',
      'rel.title': '角色 ↔ 团队',
      'rel.usedBy': '{n} 个队员在用',
      'flow.empty': '暂无任务流转。',
      'flow.deps': '依赖',
      'flow.unlocks': '解锁',
      'flow.escalate': '升级',
      'team.pick': '从全局视图选择一个团队进入。',
      'team.back': '← 全局',
      'tab.board': '看板',
      'tab.roles': '角色',
      'tab.presets': '开箱团队',
      'presets.note': '开箱团队 = 标准队长 + 3 名队员。队长固定为 myteam-captain 预设（所有团队相同）；每名队员可单独绑定不同的技能与 MCP。全局只提供角色，团队模板在项目层按任务组合角色得到；面板只读展示。',
      'presets.origin.project': '项目团队模板',
      'presets.origin.builtin': '内置开箱团队',
      'presets.empty': '该层暂无团队模板。目录：{path}',
      'presets.captain': '队长',
      'presets.captainLine': '队长：标准预设 myteam-captain（不在队员名册、不占团队规模）',
      'presets.members': '队员',
      'presets.skills': '技能',
      'presets.mcp': 'MCP',
      'presets.inherit': '继承角色',
      'presets.roster': '队员',
      'presets.columns': '看板列',
      'presets.pipeline': '泳道',
      'presets.gates': '门禁',
      'presets.gatesOff': '关闭',
      'presets.warnings': '预设读取告警',
      'presets.readonly': '只读',
      'tab.knowledge': '知识',
      'tab.cost': '成本',
      'tab.members': '队员',
      'tab.inbox': '收件箱',
      'tab.audit': '审计',
      'tab.settings': '设置',
      'view.label': '视图',
      'view.board': '看板',
      'view.lanes': '泳道',
      'view.dag': '依赖图',
      'view.flow': '流转',
      'view.dragRules': '状态机约束',
      'board.emptyCol': '暂无任务',
      'board.deps': '依赖',
      'board.evidence': '证据',
      'board.blockedBy': '被 {deps} 阻塞',
      'board.addToCol': '在「{col}」新建任务',
      'board.colHint': '列 = 阶段',
      'filter.task': '筛选任务（标题 / 任务号 / 队员）…',
      'filter.priority': '优先级',
      'filter.member': '队员',
      'filter.all': '全部',
      'filter.clear': '清除筛选',
      'filter.showing': '显示 {n}/{total}',
      'rules.title': '状态机约束',
      'rules.body': '待规划 → 就绪/受阻；就绪 → 进行中；进行中 → 门禁/重规划/失败；门禁 → 下一道门/退回进行中；完成与失败为终态。面板不提供拖拽改状态——状态只能由队员 claim / 申报推进，避免绕过门禁。',
      'dag.hint': '单击高亮依赖链，双击打开详情',
      'detail.attemptGroup': '尝试 {id}',
      'detail.exitCode': '退出码',
      'inbox.approveHint': '批准后立即按名册召唤队员，计划任务入库上板。',
      'inbox.offlineHint': '只读视图：启动团队模式会话后可在这里裁决。',
      'inbox.revisePrompt': '修订说明（会作为 plan.revised 落账，队员按新计划执行）',
      'inbox.actionFailed': '操作失败：',
      'roster.captain': '队长',
      'roster.captainNote': '队长是团队模式会话本身，不在名册里，也不占团队规模。',
      'roster.count': '{n} 名队员',
      'roster.inactive': '已挂起 / 归档',
      'lanes.unassigned': '未认领',
      'lanes.empty': '暂无任务',
      'lanes.count': '{n} 个任务',
      'dag.depth': '第 {n} 层',
      'dag.empty': '暂无任务',
      'inbox.title': '待人工处理',
      'inbox.empty': '没有待处理事项。',
      'inbox.staged': '计划待裁决',
      'inbox.stagedNote': '在看板顶部用 Approve & Run / Revise / Discard 处理。',
      'inbox.escalations': '受阻申报（{n}）',
      'inbox.escalationsNote': '队员申报受阻，等待队长重规划；点任务看详情与时间线。',
      'inbox.proposals': '知识提案（{n}）',
      'inbox.proposalsNote': '在知识 tab 查看提案详情；采纳/驳回由队长用 myteam_adopt_knowledge 执行。',
      'inbox.unread': '未读消息（{n}）',
      'inbox.unreadNote': '任务 thread 与队长收件箱的未读消息。',
      'inbox.openBoard': '回到看板',
      'audit.title': '账本事件流',
      'audit.total': '共 {n} 条',
      'audit.readOnly': '只读 · 逐事件重放',
      'audit.empty': '暂无事件。',
      'audit.loadMore': '加载更早的 {n} 条',
      'audit.end': '已到底',
      'audit.filter.all': '全部',
      'audit.filter.task': '任务',
      'audit.filter.gate': '门禁',
      'audit.filter.member': '队员',
      'audit.filter.knowledge': '知识',
      'audit.filter.team': '团队',
      'settings.title': '生效配置',
      'settings.source': '配置来源',
      'settings.default': '插件默认',
      'settings.project': '项目配置',
      'settings.team': '团队模板',
      'settings.notWired': '未读到项目/团队配置，当前为插件默认值。',
      'settings.teamNote': '当前配置来自建团时应用的团队模板（团队级 team.config.json）。',
      'settings.board': '看板列',
      'settings.columns': '列映射',
      'settings.pipeline': '流水线',
      'settings.limits': '限制（硬上限）',
      'settings.gates': '门禁',
      'settings.taskTypes': '任务类型 → 门禁链',
      'settings.views': '视图',
      'settings.warnings': '配置告警',
      'settings.offline': '离线快照：按项目层 + 团队层 team.config.json 合并（只读）。',
      'settings.maxMembers': '团队规模',
      'settings.maxDepth': '委派深度',
      'settings.maxTasks': '任务上限',
      'settings.gateTimeout': '门禁超时（ms）',
      'settings.clarify': '澄清轮次',
      'settings.memory': '记忆证据必填',
      'costbar.label': '成本（估算）',
      'costbar.estimate': '估算',
      'costbar.calls': '调用',
      'costbar.input': '输入',
      'costbar.output': '输出',
      'costbar.hit': '命中率',
      'cost.total': '合计',
      'cost.member': '队员',
      'cost.calls': '调用',
      'cost.uncached': '未缓存输入',
      'cost.cacheRead': '缓存读',
      'cost.cacheWrite': '缓存写',
      'cost.output': '输出',
      'cost.hit': '命中率',
      'cost.note': '口径：tokenMeter 实时读数（启发式估算，非账单）；账本事件用量是另一口径，不合并对账。',
      'cost.updated': '更新 {time}',
      'cost.empty': '暂无用量记录（队员尚未产生调用）。',
      'cost.offlineEmpty': '离线快照中没有 tokens.json（团队还没有队员调用记录）。',
      'detail.priority': '优先级',
      'detail.ac': '验收标准',
      'detail.assignee': '负责人',
      'detail.role': '所需角色',
      'detail.deps': '依赖',
      'detail.gates': '门禁',
      'detail.deliverables': '交付物',
      'detail.attempt': '尝试',
      'detail.gatePending': '待裁决',
      /* CHG-93（docs/14 §7.4）：verify 结果的可信度徽标 —— 账本里一直有，界面没画 */
      'detail.gateExecutedByHost': '宿主执行',
      'detail.gateExecutedByHint': '命令由宿主 subprocess 真实执行，按退出码判定（不是人工自述）',
      'detail.gateForcedByHuman': '人工强制放行',
      'detail.gateForcedByHint': '打回预算已用尽，由人工确认放行——结论可信度低于自动判定',      'detail.gatePass': '通过',
      'detail.gateFail': '未通过',
      'member.suspend': '暂停',
      'member.archive': '归档',
      'member.remove': '移除',
      'member.restore': '恢复',
      'member.removeConfirm': '移除队员会删除其私有空间（不可恢复），确认移除？',
      'member.busy': '处理中…',
      'roles.origin.builtin': '内置角色',
      'roles.origin.global': '全局角色',
      'roles.origin.project': '项目角色',
      'roles.captain': '队长',
      'roles.loading': '加载角色目录…',
      'roles.empty': '暂无角色定义',
      'roles.unavailable': '角色目录需要活跃的团队会话（先在「团队模式」会话提交计划）。',
      'kb.search': '搜索标题、标签或正文…',
      'kb.queue': '待审提案',
      'kb.entries': '知识条目',
      'kb.empty': '暂无知识条目。队员在任务完成时提交知识提案，队长用 myteam_adopt_knowledge 采纳后入库。',
      'kb.core': '核心',
      'kb.unverified': '未验证',
      'kb.stale': '待复核',
      'kb.proof': '证据',
      'kb.evidence': '证据指针',
      'kb.timeline': '演化时间线',
      'kb.rel.new': '新增',
      'kb.rel.refine': '精炼',
      'kb.rel.contradict': '矛盾',
      'kb.target': '目标条目',
      /* ── CHG-69：全局/项目分层 + 角色/团队/任务 + 参与关系 ── */
      'scope.project': '项目',
      'project.tabs.roles': '角色',
      'project.tabs.teams': '团队',
      'project.tabs.tasks': '任务',
      'project.root': '项目',
      'project.pick': '选择项目',
      'team.tab.participating': '参与任务',
      /* ── CHG-102：项目级存储空态（还没进团队模式时只画这一屏） ── */
      'store.emptyTitle': '这个项目还没进入团队模式',
      'store.emptyBody': '团队模式的所有内容都放在项目级目录里：角色 / 团队 / 技能 / 工具（config/）、任务与依赖（tasks/）、流程与历史（history/）。初始化只会建目录与 .gitignore，不会建团队、不会召唤成员。',
      'store.init': '初始化 .dsh-myteam',
      'store.initDone': '已初始化项目存储：{path}',
      'store.uploadHint': '上传纪律写在 .dsh-myteam/.gitignore 里：config/ 与 tasks/ 随仓库共享；state/、history/、export/ 不入库（可从账本重建）。',
      /* ── CHG-103：角色作用域（全局必须明示） ── */
      'role.scope': '作用域',
      'role.scope.project': '项目级（默认）',
      'role.scope.projectHint': '只对本项目可见，随仓库共享',
      'role.scope.global': '全局',
      'role.scope.globalHint': '所有项目可见；需二次确认',
      'team.backList': '← 团队列表',
      'task.participants': '参与团队',
      'task.assignees': '负责队员',
      'task.owner': '主责',
      'task.coop': '协作',
      'task.ownerTeam': '主责团队',
      'detail.participants': '参与团队',
      'detail.assignees': '负责队员',
      'detail.assigneeNote': '一个任务可由一个或多个队员负责；执行仍按角色 claim。',
      'tasks.rail': '参与团队',
      'tasks.railAll': '全部团队',
      'tasks.empty': '还没有任务。任务在团队模式会话里由队长规划，或在任务面板查看其它团队的产出。',
      'tasks.view.list': '列表',
      'tasks.filterTeam': '团队',
      'tasks.count': '{lead} 主责 · {coop} 协作',
      'role.interest': '兴趣词',
      'role.skills': '技能',
      'role.mcp': 'MCP',
      'role.model': '模型',
      'role.prompt': '系统提示词',
      'role.memberships': '在册情况',
      'role.membershipsEmpty': '还没有团队聘任它。',
      'role.usage': '被 {teams} 个团队聘任 · {instances} 个实例',
      'role.snapshot': '召唤时固化身份快照；之后改角色不影响在跑实例。',
      'role.origin.project-role': '项目自身角色',
      'role.origin.builtin': '内置',
      'role.origin.plugin': '插件',
      'role.origin.global': '全局',
      'role.origin.project': '项目',
      /* CHG-91（插件团队贡献契约 v1）：插件贡献的角色只读 + 插件贡献区 */
      'contrib.title': '能力包',
      'contrib.desc': '第三方插件把「一个能打的角色 / 一支配好的队」打包成能力包；装好后直接进角色库与建队向导，组队时按名字聘任即可。',
      'contrib.empty': '还没有装能力包（把插件放进 $DSH_HOME/myteam/plugins/ 即可）',
      'contrib.reload': '重新扫描插件',
      'contrib.reloading': '扫描中…',
      'contrib.reloaded': '已重新扫描：{plugins} 个能力包 · {roles} 个角色 · {teams} 个团队模板',
      'contrib.pluginCount': '{n} 个能力包',
      'contrib.roles': '角色',
      'contrib.teams': '团队模板',
      'contrib.capRoles': '角色',
      'contrib.capTeams': '模板',
      'contrib.members': '{n} 人',
      'contrib.providedBy': '由插件「{plugin}」提供',
      'contrib.readonly': '只读',
      'contrib.readonlyHint': '能力包里的角色只读；想改请先「复制到项目」再编辑项目库那份',
      'contrib.warnTitle': '能力包装载有问题（{n} 条 error）',
      'contrib.warnHint': '这些条目已被跳过。按每条提示改插件目录后点「重新扫描插件」。',
      'contrib.ok': '能力包装载正常（{plugins} 个包 / {roles} 个角色 / {teams} 个团队模板）',
      'contrib.root': '贡献目录：{root}',
      /* CHG-74：同名副本（内置/全局/项目库可能有同一 id）——被压过的那份标注「谁让位」 */
      'role.shadowedBy': '同名{origin}副本（以此为准）',
      'role.effective': '生效中',
      'role.detailShadowed': '同名副本：{list}（只读）；当前显示的是{origin}副本，运行时也用这份。',
      'roles.page.project': '项目角色库',
      'roles.page.global': '全局角色',
      'roles.page.builtin': '内置角色',
      'roles.projectRole': '项目自身角色',
      'roles.projectRoleNote': '项目自己的角色 · 不属于任何团队，可被本项目各团队聘任',
      'roles.noProjectRole': '未指定项目自身角色——由团队模式会话里的队长用 myteam_set_project_role 指定。',
      'roles.introduce': '可引入的角色',
      'roles.filter.all': '全部',
      'roles.filter.project': '项目',
      'roles.filter.global': '全局',
      'roles.filter.builtin': '内置',
      'roles.detail': '角色详情',
      'roles.interestEmpty': '未设置兴趣词',
      'roles.interest': '兴趣词',
      'global.title': '全局',
      'global.rolesNote': '全局只有角色：内置（随插件只读）+ 全局个人资产；团队与任务属于项目。',
      'global.assets': '随行资产',
      'global.assetsNote': '建团模板与系统能力，同样跨项目',
      'global.presets': '预设（建团模板）',
      'global.presetsSub': '建团模板：一组角色的编排，一条预设开一个团队',
      'global.presetsEmpty': '还没有预设；团队建好后可另存为预设。',
      'global.skills': '技能 & MCP',
      'global.skillsSub': '全局能力库：角色详情里按需引用，不在角色里重复定义',
      'global.skillsEmpty': '尚未被任何角色引用',
      'global.skillsNote': '技能与 MCP 是角色的能力配置：在角色详情里勾选启用，召唤时生效。',
      'global.jumpPresets': '打开预设列表',
      'global.jumpRoles': '打开角色库',
      'global.presetCount': '{n} 个预设',
      'global.skillCount': '技能 {s} · MCP {m}',
      'global.skillItem': '{n}',
      'global.mcpItem': '{n} MCP',
      'global.crossProject': '跨项目共享',
      'global.builtinNote': '随插件分发 · 只读，复制到项目后可改',
      'global.globalNote': '你的个人资产 · 换项目还在',
      'global.newRole': '新建角色',
      'global.count': '{n} 个角色',
      'view.dir': '方向',
      'view.dir.h': '横向',
      'view.dir.v': '竖向',
      'cost.open': '用量明细',
      'state.loading': '加载中…',
      'discard.confirm': 'Discard 是两段确认：草稿将归档且不会自动重建。确认丢弃？',
      /* ── CHG-72：面板闭环入口（建队引导 / 角色表单 / 任务新建编辑 / 无人可领诊断） ── */
      'team.new': '新建团队',
      'team.newHint': '填名称与目标后打开一个「团队模式」会话，队长会在那里出计划草稿；你批准后才算建成，面板不直接建队。',
      'team.new.name': '团队名',
      'team.new.goal': '目标（一句话）',
      'team.new.preset': '模板（可选）',
      'team.new.presetNone': '不套模板（自定义名册）',
      'team.new.promptTitle': '将发送给队长的首条消息',
      'team.new.open': '打开团队模式会话',
      'team.new.copy': '复制指令',
      'team.new.copied': '已复制',
      'team.new.needName': '先填团队名',
      'team.new.needGoal': '先填目标（一句话即可）',
      'team.new.unavailable': '当前窗口没有这个项目的工作区入口：请在左侧打开该项目，或直接复制指令到团队模式会话。',
      'team.new.noWorkspace': '先在左侧打开一个项目工作区',
      'team.draft': '待批准',
      'team.draftHint': '草稿：等你在团队页批准或退回',
      'role.new': '新建角色',
      'role.edit': '编辑',
      'role.fork': '复制到项目并编辑',
      'role.formTitle': '角色编辑器',
      'role.name': '名称',
      'role.id': 'id（小写字母 / 数字 / -）',
      'role.desc': '职责一句话',
      'role.systemPrompt': '系统提示词',
      'role.interestWords': '兴趣词（逗号分隔，≤8）',
      'role.modelProvider': '模型 provider（可空）',
      'role.modelName': '模型名（可空）',
      'role.save': '保存',
      'role.saved': '已保存 {id}',
      'role.confirmOverwrite': '同名角色已存在：再点一次「保存」即覆盖项目库文件（在跑实例不变）。',
      'role.saveHint': '保存后：在跑实例不变（召唤时快照），下次召唤生效。',
      'role.builtinReadonly': '内置/全局角色是复制源：编辑会先复制成项目角色，原文件不动。',
      'role.invalid': '保存失败：{msg}',
      'task.new': '新建任务',
      'task.formTitleNew': '新建任务',
      'task.formTitleEdit': '编辑任务',
      'task.field.team': '主责团队（在线）',
      'task.field.title': '标题',
      'task.field.desc': '描述',
      'task.field.ac': '验收标准（一行一条）',
      'task.field.deliverable': '交付物路径（叶子任务必填）',
      'task.field.deps': '依赖（同团队任务）',
      'task.field.role': '所需角色',
      'task.field.priority': '优先级',
      'task.field.gates': '门禁链（逗号分隔，留空用模板默认）',
      'task.field.assignees': '负责队员（可多选）',
      'task.field.participants': '协作团队（可多选）',
      'task.needOnline': '只有在线团队能建/改任务：先在左侧打开该团队的团队模式会话。',
      'task.created': '已创建 {id}',
      'task.updated': '已保存',
      'task.structuralBlocked': 'AC / 依赖 / 所需角色 / 交付物 / 门禁链属于结构字段，任务在跑时改动必须先重规划（队长 rescope）。可以先只保存元数据。',
      'task.saveMetaOnly': '只保存元数据',
      'task.dismissStructural': '返回修改',
      'task.formHint': '保存后：无依赖 → 立即就绪并派单；有依赖 → 上游完成时自动解锁。',
      'task.noTeam': '还没有可用的在线团队',
      'task.noMembers': '该团队还没有队员：先在团队模式会话里召唤队员（或让队长批准计划），再来建任务。',
      'task.needTitle': '请填写标题',
      'task.needAc': '至少填写一条验收标准',
      'task.needRole': '请选择所需角色',
      'role.needId': '请填写角色 id（小写字母/数字/-）',
      'role.needPrompt': '请填写系统提示词',
      'diag.title': '无人可领',
      'diag.team-inactive': '团队未运行',
      'diag.deps-pending': '上游未完成：{deps}',
      'diag.no-role': '名册缺少角色：{role}',
      'diag.role-busy': '该角色都在忙：{members}',
      'diag.more': '在册 {n}',
      'task.save': '保存',
      'task.edit': '编辑',
      /* ── CHG-73 P2：重新规划 / 取消 / 改动记录 / 证据过期 / 批量编排 / 角色目录 ── */
      'action.cancel': '取消',
      'action.unavailable': '当前状态不可用',
      'task.rescope': '重新规划',
      'task.rescopeDone': '已重新规划 {id}（{state}）',
      'task.revisionConflict': '保存失败：这份任务已被改过（当前版本 {current}，你基于版本 {snapshot}）。请关闭表单重新打开，确认最新内容后再改——本次没有写入任何内容。',
      'task.rescopeFailed': '重新规划失败：{msg}',
      'task.rescopeNeedReason': '请填写重新规划的理由',
      'task.readonlyTitle': '离线/只读团队：写操作已禁用',
      'detail.actions': '操作',
      'detail.evidenceStale': '证据已过期：{fields} 在 {time} 被改动，当前证据早于改动，建议重新规划重跑',
      'detail.edits': '改动记录',
      'detail.editsEmpty': '暂无改动记录',
      'detail.editsLimit': '仅展示最近 {n} 条',
      'detail.editReason': '理由',
      'detail.cancelled': '任务已取消（{time}）：{reason}',
      'detail.cancelLeave': '下游任务保持原样（诊断显示「上游已取消」）',
      'detail.cancelCascade': '下游已级联取消',
      'detail.cancelRewire': '下游已改挂到新上游',
      /* CHG-75：依赖被改挂（原上游取消 → 依赖改到新上游 / 解除） */
      'detail.rewiredTo': '依赖已从 {from} 改挂到 {to}',
      'detail.rewiredFree': '依赖已从 {from} 解除（本任务独立）',
      'board.evidenceStale': '证据过期',
      'board.cancelled': '已取消',
      'board.cancelledTitle': '已取消：{reason}',
      /* CHG-75：被改挂过的小标记 */
      'board.rewired': '已改挂',
      'board.rewiredTitle': '依赖被改挂过（原上游已取消）',
      'board.staleTitle': '证据过期：{fields} 在 {time} 后被改动',
      'diag.dep-cancelled': '上游已取消：{deps}',
      'field.title': '标题',
      'field.description': '描述',
      'field.acceptanceCriteria': '验收标准',
      'field.deps': '依赖',
      'field.requiredRole': '所需角色',
      'field.gateChain': '门禁链',
      'field.deliverableSpec': '交付物',
      'field.priority': '优先级',
      'field.assignees': '负责队员',
      'field.participants': '参与团队',
      'field.state': '状态',
      'multi.on': '多选',
      'multi.off': '退出多选',
      'multi.all': '全选',
      'multi.invert': '反选',
      'multi.clear': '清空',
      'multi.count': '已选 {n}',
      'multi.max': '一次最多 {n} 个任务',
      'multi.hint': '多选模式：点卡片勾选，底部浮动条批量操作。',
      'batch.title': '批量操作',
      'batch.reason': '理由（取消/重新规划必填）',
      'batch.cancel': '取消',
      'batch.cancelTask': '取消任务',
      'batch.rescope': '重新规划',
      'batch.assign': '指派',
      'batch.priority': '改优先级',
      'batch.cascade': '同时取消下游',
      'batch.impactCascade': '影响面：{tasks} 个任务；下游 {dependents} 个，将一并取消',
      'batch.needReason': '请填写理由',
      'batch.needMembers': '请选择要指派的队员',
      'batch.run': '执行',
      'batch.confirmHint': '两段确认：确认后不可撤销。',
      'batch.impact': '影响面：{tasks} 个任务；下游 {dependents} 个（保持原样）',
      'batch.impactDeps': '下游任务：{deps}',
      'batch.confirm': '确认执行',
      'batch.done': '批量操作完成：成功 {ok} / 失败 {failed}',
      'batch.offlineSkipped': '所选任务里有离线团队的任务，已跳过（只读）。',
      'batch.assignTeamEmpty': '所选队员不属于该任务的团队',
      'rescope.title': '重新规划',
      'rescope.hint': '重新规划会撤销当前尝试，任务回到「就绪/待规划」，并按下面的补丁更新结构字段。',
      'rescope.reason': '理由（必填，写入账本）',
      'rescope.patch': '结构补丁（可选）',
      'rescope.patchHint': '只填要改的字段；留空表示不修改。',
      'rescope.reassign': '重派队员（可选）',
      'rescope.reassignHint': '勾选后任务改派给这些队员（不勾 = 保持原样）。',
      'rescope.submit': '提交重新规划',
      'cancel.title': '取消任务',
      'cancel.reason': '取消原因（必填，写入账本）',
      'cancel.strategy': '下游策略',
      'cancel.leave': '只取消本任务',
      'cancel.cascade': '级联取消下游任务',
      'cancel.rewire': '改挂到新上游',
      'cancel.rewireTo': '新的上游',
      'cancel.rewireNone': '（不选：解除依赖，让它独立）',
      'cancel.rewireDone': '（已完成）',
      'cancel.rewireHint': '把下游任务对本任务的依赖改到新上游；不选则解除依赖，下游任务变成独立任务。已完成的也可以选（下游会立刻可领）。',
      'cancel.rewireEmpty': '这个团队没有可选的新上游（只能解除依赖）。',
      'cancel.step1': '下一步：查看影响面',
      'cancel.confirm': '确认取消',
      'cancel.impact': '影响面：下游 {dependents} 个任务（保持原样）',
      'cancel.impactCascade': '影响面：下游 {dependents} 个任务，将一并取消',
      'cancel.impactRewire': '影响面：下游 {dependents} 个任务，将改挂到新上游',
      'cancel.hasAttempt': '当前有进行中的尝试，将被撤销。',
      'cancel.noAttempt': '当前没有进行中的尝试。',
      'cancel.dependents': '下游任务',
      'cancel.done': '已取消 {n} 个任务',
      'cancel.rewired': '已改挂 {n} 个任务',
      'cancel.failed': '取消失败：{msg}',
      'cancel.needReason': '请填写取消原因',
      'task.rescopeAndSave': '保存并重新规划',
      'task.structuralReason': '结构字段改动需要理由（会作为 task.rescoped 落账）',
      'role.catalog': '候选目录',
      'role.catalogHint': '点选加入；目录不是白名单，可以直接输入目录外的名字。',
      'role.catalogEmpty': '目录为空',
      'role.catalogFallback': '候选目录不可用：已降级为「已有角色出现过的名字」。',
      'role.catalogAdd': '添加',
      'role.catalogFree': '目录里没有的名字可直接输入后回车',
      'role.skillsEmpty': '未选技能',
      'role.mcpEmpty': '未选 MCP',
      'role.delete': '删除角色',
      'role.deleteConfirmBtn': '确认删除',
      'role.deleteUsage': '在册团队 {teams} · 实例 {instances} · 占用模板 {presets}',
      'role.deleteConfirm': '两段确认：先看占用情况，确认后再删除项目角色库文件（会计审计）。',
      'role.deleteOccupied': '该角色仍被模板或在册团队占用，不能删除（先解除聘任/模板引用）。',
      'role.deleted': '已删除 {id}',
      'role.deleteFailed': '删除失败：{msg}',
      'role.published': '已发布到全局角色库：{id}',
      'role.publishBtn': '发布到全局',
      'role.publishHint': '把这份项目库角色写进全局角色库（该工作区所有项目可见）',
      'role.publishConfirm': '确认发布到全局角色库？',
      'role.publishImpact': '将写入：{path}。全局库对所有项目可见——单向流动，发布后各项目仍需显式「复制到项目」才进各自项目库。',
      'role.publishImpactNote': '全局库是复制源，不是发布源：内置/全局角色不能再发布。',
      'role.publishConfirmBtn': '确认发布',
      'role.publishFailed': '发布失败：{msg}',
      'role.deletePresets': '占用模板：{presets}',
      /* ── CHG-76 P3：A 批量改挂档 / B 批量新建草稿 / C 无人可领一键修复 ── */
      'batch.leave': '只取消所选任务',
      'batch.rewire': '改挂到新上游',
      'batch.rewireTo': '新的上游',
      'batch.rewireNone': '（不选：解除依赖，让它独立）',
      'batch.rewireDone': '（已完成）',
      'batch.rewireHint': '把下游任务对所选任务的依赖改到新上游；不选则解除依赖（下游变独立任务）。',
      'batch.rewireByTask': '改挂明细（任务 → 直接下游）',
      'batch.rewireNoDeps': '无直接下游',
      'batch.rewireOneTeam': '改挂档只支持同一团队的任务：先按团队筛选再批量取消（跨团队请分两次）。',
      'batch.failedItems': '失败原因：{items}',
      'batch.impactRewire': '影响面：{tasks} 个任务；下游 {dependents} 个，将改挂到新上游（未选则为独立任务）',
      'batch.rewiredDone': '已改挂 {n} 个任务',
      'tasks.newBatch': '批量新建',
      'batchCreate.title': '批量新建任务',
      'batchCreate.hint': '按目标列草稿：每行一条任务；「依赖行号」填本批里的第几行（如 1,2），留空 = 无依赖。',
      'batchCreate.team': '主责团队（在线）',
      'batchCreate.goal': '目标（这批任务服务于什么）',
      'batchCreate.rows': '草稿',
      'batchCreate.rowTitle': '标题',
      'batchCreate.rowRole': '角色',
      'batchCreate.rowPriority': '优先级',
      'batchCreate.rowDeps': '依赖行号（如 1,2）',
      'batchCreate.addRow': '加一行',
      'batchCreate.removeRow': '删除',
      'batchCreate.preview': '预览',
      'batchCreate.submit': '创建',
      'batchCreate.impact': '将创建 {n} 个任务',
      'batchCreate.byRole': '角色分布',
      'batchCreate.rolesMissing': '名册里没有：{roles} —— 这些会创建失败（requiredRole 不在名册）',
      'batchCreate.edges': '依赖边',
      'batchCreate.warnings': '警告',
      'batchCreate.done': '已创建 {n} 个任务（失败 {failed}）',
      'batchCreate.failedItems': '失败条目：{items}',
      'batchCreate.failed': '创建失败：{msg}',
      'batchCreate.needTitle': '每条草稿都要有标题',
      'batchCreate.needRole': '每条草稿都要选角色',
      'batchCreate.needRows': '至少保留一行草稿',
      'batchCreate.offline': '只有在线团队能批量建任务：先打开该团队的团队模式会话。',
      'batchCreate.previewFirst': '预览不写账本；确认后才逐条落账。',
      'diag.fix': '一键修复',
      'diag.fixAssign': '一键指派 {member}',
      'diag.fixAssignDone': '已指派 {member}',
      'diag.fixRoleSwap': '改用已有人角色',
      'diag.fixRoleSwapOption': '{role}（空闲 {n}）',
      'diag.fixRoleSwapDone': '已把所需角色改为 {role}',
      'diag.fixSpawn': '去召唤「{role}」成员',
      'diag.fixSpawnHint': '名册里没有在册的该角色成员：先在团队模式会话里召唤这名队员。',
      'diag.fixSpawnHintCanSwap': '也可以先用左边的动作，换成有人空闲的角色。',
      'diag.fixReinforce': '再召唤一名「{role}」增援',
      'diag.fixReinforceHint': '这个角色的人手都在忙：先在团队模式会话里召唤增援。',
      'diag.fixReinforceHintCanSwap': '这个角色的人手都在忙：可以先换成有人空闲的角色，或召唤增援。',
      'diag.fixFailed': '修复失败：{msg}',
      /* [G1 detail] 任务详情 / 两段确认（design/detail.html · confirm.html · discard.html） */
      'detail.crumb': '面包屑',
      'detail.crumbBoard': '看板',
      'detail.attemptN': '第 {n} 次尝试',
      'detail.claimedBy': '由{role}认领',
      'detail.elapsed': '已跑 {time}',
      'detail.estimate': '体量 {value}',
      'detail.toolCalls': '{n} 次模型调用',
      'detail.humanAvatar': '我',
      'detail.acVerified': '{pass} / {total} 已验',
      'detail.acEvidence': '· {time} 由证据 #{seq} 验证',
      'detail.assertions': '断言',
      'detail.evidenceEmpty': '还没有提交证据：任务完成时会带上命令、退出码与耗时。',
      'detail.evidenceHead': '第 {attempt} 次尝试 · {n} 条',
      'detail.threadCount': '{n} 条 · 账本派生',
      'detail.threadEmpty': '还没有留言。想补要求就在下面写一句，会以 human 身份落账本。',
      'detail.depsTitle': '依赖关系',
      'detail.depsUpstream': '上游',
      'detail.depsEmpty': '没有上游依赖（就绪即派单）',
      'detail.depsHint': '上游全部完成后本任务才会被领取。',
      'detail.gatesTitle': '门禁链',
      'detail.gatesCount': '{n} 项',
      'detail.gatesEmpty': '门禁链为空（完成即终态）',
      /* CHG-86 / M2-C：门禁裁决区（任务详情抽屉，gate:* 时） */
      'gate.title': '门禁裁决',
      'gate.current': '当前门禁：{gate}（任务状态 {state}）',
      'gate.reviewerLabel': '审查人（强制交叉审查：不能是实现者本人）',
      'gate.reviewerPick': '选择审查人…',
      'gate.selfReview': '实现者本人不可自审，请另选一名成员',
      'gate.reasonPlaceholder': '打回理由（打回必填，写清要改什么）',
      'gate.pass': '通过',
      'gate.fail': '打回',
      'gate.recheck': '重新校验',
      'gate.archiveNote': '归档门不是人工裁决门：由宿主按交付物约定路径做落位校验，不接受「已归档」自述；这里只能重新校验一次。',
      'gate.needReason': '打回必须写清理由。',
      'gate.needReviewer': '请先选择审查人（不能是实现者本人）。',
      'gate.budgetConfirm': '该门禁已打回 {n} 轮，达到复验预算上限。确认以人工身份放行？',
      'gate.budgetBlocked': '已达复验预算上限，需人工裁决。',
      'gate.done': '裁决已记录。',
      'gate.failed': '裁决失败。',
      /* CHG-87 §1.3：verify 门（真跑命令，FR-5.3） */
      'gate.verifyTitle': '命令门禁（verify）',
      'gate.verifyNote': 'verify 门不看人工结论：由宿主执行任务声明的命令，取真实退出码判定。绝不采信「测试通过」自述。',
      'gate.verifyCmd': '要执行的命令',
      'gate.verifyCwd': '工作目录：{cwd}',
      'gate.verifyRun': '运行门禁命令',
      'gate.verifyRunning': '运行中…',
      'gate.verifyExit': '退出码 {code}',
      'gate.verifyDuration': '耗时 {ms}ms',
      'gate.verifySignal': '信号 {signal}',
      'gate.verifyOutput': '输出（末尾 2000 字符）',
      'gate.verifyNoOutput': '（无输出）',
      'gate.verifyUnavailable': '宿主未提供 subprocess 服务，verify 门无法执行；请改用人工强制放行（需写理由）。',
      'gate.verifyNoCommand': '该任务未声明 verifyCommand，无法执行 command 门禁。请先在任务里补 verifyCommand.argv。',
      'gate.verifyForce': '强制放行',
      'gate.verifyForced': '已由人工强制放行。',
      /* CHG-87 §2.3：写入范围审计 */
      'scope.title': '写入范围审计',
      'scope.declared': '声明范围',
      'scope.files': '申报文件',
      'scope.outOfScope': '越界文件',
      'scope.ok': '✓ 未越界',
      'scope.bad': '越界 {n} 个文件',
      'scope.empty': '—',
      'scope.warn': '越界写入 {n} 个文件：{files}',
      'scope.warnNote': '仅警告，不阻断门禁（FR-5.4）。',
      'scope.badge': '越界 {n}',
      'scope.checkedAt': '审计时间 {time}',
      /* CHG-87 §3.3：乐观锁冲突 */
      'edit.conflict': '任务已被修改（当前 revision {revision}），请重新加载后重试。',
      /* CHG-87 §4.3：证据指针 */
      'evref.task': '任务',
      'evref.file': '文件',
      'evref.session': '会话',
      'evref.unknown': '其它',
      'evref.sessionHint': '跨会话引用（宿主 @ 会话），读取已留痕 session.read',
      'evref.empty': '无证据指针',
      /* CHG-87 §5.3：单角色调用（/myteam+ 语法） */
      'rolecall.title': '单角色调用',
      'rolecall.desc': '输入 /myteam+<角色 id> 启用（可累加：/myteam+researcher+reviewer），/myteam-<角色 id> 卸载。只在以 /myteam 开头时解析。',
      'rolecall.placeholder': '/myteam+researcher',
      'rolecall.apply': '应用',
      'rolecall.applied': '已启用：{roles}',
      'rolecall.removed': '已卸载：{roles}',
      'rolecall.nothing': '没有可应用的改动（示例：/myteam+researcher 或 /myteam-researcher）。',
      'rolecall.notCommand': '不是 /myteam 命令：这条按普通消息发送。',
      'rolecall.failed': '单角色调用失败：{message}',
      'rolecall.filePath': '会话默认值：{path}',
      'rolecall.readonly': '只读视图（离线团队）：需要活跃团队会话才能调用角色。',
      'rolecall.unavailable': '宿主未提供 applyRoles 端点。',
      /* CHG-87 §5.3：myteam_apply_roles 工具卡（读真实返回值） */
      'applyRoles.name': '单角色调用',
      'applyRoles.roles': '已启用角色',
      'applyRoles.empty': '本次调用没有启用任何角色',
      'applyRoles.skills': '技能',
      'applyRoles.mcp': 'MCP',
      'applyRoles.removed': '已卸载',
      'applyRoles.none': '—',
      'applyRoles.promptSection': '注入的提示词段落',
      'applyRoles.note': '说明',
      'applyRoles.error': '调用失败',
      'detail.teamMembers': '队员',
      'detail.teamMembersEmpty': '还没有登记队员',
      'detail.participantsCount': '主责 {lead} · 协作 {coop}',
      'detail.messageMember': '私讯',
      'detail.enterTeam': '进入团队',
      'detail.enterTeamHint': '回到看板（按团队筛选）',
      'detail.cost': '成本归因',
      'detail.costEstimate': '估算',
      'detail.costTask': '本任务累计',
      'detail.costHit': '缓存命中',
      'detail.costMiss': '未命中 / 输出',
      'detail.costShare': '占团队消耗',
      'detail.costNote': '按 tokenMeter 用量比例分摊，非精确计量。',
      'detail.costUnavailable': '成本数据不可用（离线团队读 tokens.json 失败或还没产生用量）',
      'detail.ops': '任务操作',
      'detail.cancelTaskBtn': '取消此任务',
      'detail.cancelNote': '取消后已产出证据保留，任务转 blocked 并回到队长重规划。',
      /* 解散团队（design/confirm.html）：四条不可撤销影响 + 输入团队 ID 才能提交 */
      'disband.title': '解散「{name}」？',
      'disband.irreversible': '不可撤销',
      'disband.step': '第 2 步，共 2 步',
      'disband.desc': '这个团队的所有会话会被终止，在册角色被释放。以下影响会发生，且没有撤销按钮。',
      'disband.impactTitle': '解散后的影响面',
      'disband.impactMembers': '{n} 个角色将被排空后释放，正在跑任务的成员也包含在内',
      'disband.impactTasks': '{n} 个未完成任务转为 blocked，不会自动续跑',
      'disband.impactDrained': '排空明细：在跑 {running} 个、待领取 {pending} 个（由宿主排空后回填；取不到时显示 —）',
      'disband.impactArchive': '账本与 token 记录归档至 archive/，只读可查，但不能再启动',
      'disband.impactPrivate': '各实例的私有空间（工作笔记、临时文件）会被删除',
      'disband.inputLabel': '输入团队 ID 确认',
      'disband.inputHint': '如果你只是想让团队停下来，用「归档」就好——归档保留全部数据，之后还能重新打开。',
      'disband.archive': '改用归档',
      'disband.archiveHint': '归档保留全部数据、可重新打开；入口在团队设置里（这里不代做归档）。',
      'disband.needId': '输入的团队 ID 与 {teamId} 不一致',
      'disband.failed': '解散失败：{msg}',
      /* 丢弃暂存计划（design/discard.html）：影响面 + 引导改用 Revise */
      'discard.step': '第 2 步，共 2 步',
      'discard.title': '丢弃这份计划？',
      'discard.desc': '丢弃后这份草稿会归档到 archive/，团队回到没有计划的状态。角色一个都还没拉进来，不涉及任何实例会话。',
      'discard.impactTitle': '丢弃后会发生',
      'discard.impactTasks': '{n} 个任务全部作废，草稿归档到 {path}，只读可查',
      'discard.impactState': '团队状态回到 draft，不会自动重建计划，也不会自动再派活',
      'discard.impactNoToken': '实例会话尚未创建，不产生 token 消耗',
      'discard.impactKeep': '想保留计划稍后再批，用「关闭」而不是丢弃',
      'discard.summary': '计划摘要',
      'discard.summaryText': '{tasks} 个任务 · {members} 个角色 · 计划 {planId}',
      'discard.reviseHint': '如果只是想改计划，点「取消」回到看板，然后用 Revise 让队长重排——那样任务和验收标准都会保留。',
      'discard.archive': '看草稿归档',
      'discard.discardBtn': '丢弃这份计划',
      'discard.failed': '丢弃失败：{msg}',
      /* CHG-82：设计稿对齐的 locale 落点（zh 为键源；en 在下面同序追加） */
      /* [G1 detail] */ /* [G2 roster] */ /* [G3 knowledge] */
      /* [G2 roster] 角色库 / 名册 / 角色详情 / 实例管理菜单（design/roles.html · roster.html · role-detail.html · member-menu.html） */
      'roles.page.title': '角色库',
      'roles.page.desc': '角色是配置单元：职责、系统提示词、工具策略、技能引用、模型路由。同一个角色可以被多次召唤，每次产生一个实例。改角色不会影响已经在跑的实例 —— 它们拿的是召唤那一刻的快照。',
      'roles.createRole': '创建角色',
      'roles.createRoleHint': '对话式建角色，确认预览后才落库',
      'roles.chatCreate': '对话式创建',
      'roles.introGlobal': '引入全局角色',
      'roles.filterHint': '按作用域从近到远排列',
      'roles.searchPlaceholder': '搜角色名或职责',
      'roles.projectSectionNote': '复制自内置角色，可改可删',
      'roles.globalSectionNote': '跨项目复用，本团队未使用',
      'roles.builtinSectionNote': '只读，随插件升级',
      'roles.noMatch': '没有匹配的角色。',
      'roles.copyToProject': '复制进项目',
      'roles.copyToProjectFresh': '复制到项目',
      'roles.compare': '对比差异',
      'roles.hasCopy': '项目里已有副本',
      'roles.noCopy': '项目里没有',
      'roles.zeroInstances': '本项目 0 实例',
      'roles.instanceCount': '{n} 实例',
      'roles.guest': '用它单干',
      'roles.guestCopied': '已复制单角色调用命令：{cmd}',
      'roles.guestCopyFailed': '复制失败，请手动输入：{cmd}',
      'roles.inheritRoute': '继承队长路由',
      'roles.captainLock': '不可召唤 · 即当前会话',
      'roles.copiedFromBuiltin': '复制自 内置 · {name}',
      'roles.skillCount': '{n} Skill',
      'roles.mcpCount': '{n} MCP',
      'roles.projectRoleOnline': '在线',
      'roles.deleteGuard': '删除有守门。角色仍被某个预设绑定、或有实例正在跑时，删除会被拒绝并列出占用方 —— 先让实例归档，或把它从预设名册里摘掉。同名角色在项目里只存一份，重复复制会被拒（不会静默覆盖）。',
      'roster.page.title': '队员',
      'roster.page.desc': '队员是角色与团队之间的聘任记录，不是独立实体：从角色库（全局 / 项目）挑一个角色拉进来，它就成为这个团队的队员，带召唤那一刻的角色快照；同一角色召唤多次，实例自动 -2 编号，各跑各的会话。',
      'roster.summon': '召唤角色',
      'roster.noCaptain': '队员里没有队长',
      'roster.noCaptainHint': '队长就是你正在聊的那个 team 预设会话，它不是队员。队员列的是队长拉进来的角色，按各自的兴趣词认领任务。',
      'roster.instanceCount': '{n} 个实例',
      'roster.inheritRoute': '继承队长路由',
      'roster.delivery': '交付 {done}/{total}',
      'roster.noTask': '无进行中任务',
      'roster.running': '运行中',
      'roster.gate': '等人裁决',
      'roster.idle': '空闲',
      'roster.gateAction': '看门禁',
      'roster.multiNote': '{n} 个实例独立会话与上下文 · 角色更新不影响在跑实例',
      'roster.gateNote': '等你定夺：重派 / 跳过 / 改期望',
      'roster.idleNote': '已排空，可接新任务',
      'roster.activeNote': '正在执行：{task}',
      'roster.sameRoleOtherTeam': '同时在「{team}」在跑',
      'roster.limitNote': '团队规模上限 {n}（不含队长），当前在册 {active}。上限在设置页可调，但受插件硬上限约束。移除实例会删除其私有空间，归档只排空不删除。',
      'roster.summonCardHint': '从角色库挑一个，拉进来就能领任务；同名角色召唤多次自动编号',
      'roster.menu.label': '对 {name} 做什么',
      'roster.menu.steer': '指导一下',
      'roster.menu.steerHint': '在团队模式会话里指导实例（面板不另开写路径）。',
      'roster.menu.steerNotice': '面板不另开写路径：请回到团队模式会话 —— 用 myteam_message（kind=steer）发指导，或用 myteam_interrupt 打断当前轮。',
      'roster.menu.suspend': '暂停领取新任务',
      'roster.menu.archive': '归档（排空后）',
      'roster.menu.remove': '移除实例',
      'roster.menu.restore': '恢复实例',
      'roster.menu.impact': '在跑 {running} 个任务、{gate} 条门禁待审。归档会先排空再收进 archive/，移除会删掉它的私有空间。',
      'roster.menu.readonly': '只读视图：启动团队模式会话后才能管理实例。',
      'role.section.definition': '定义与设定',
      'role.section.definitionNote': '角色的全部本体，改这里就是改角色',
      'role.responsibility': '职责',
      'role.boundary': '边界',
      'role.boundaryDefault': '未声明额外工具边界：工具策略只收窄，不扩权。',
      'role.boundaryAllow': '允许 {tools}',
      'role.boundaryDeny': '禁止 {tools}',
      'role.interestHint': '派单的软信号，不是权限',
      'role.promptTokens': '{n} tokens',
      'role.expandEdit': '展开编辑',
      'role.route': '模型路由',
      'role.routePrimary': '主 {model}',
      'role.routeInherit': '继承队长路由',
      'role.skillsNote': '启用 {n} / 全局库 {total} · 引用而非内联',
      'role.skillAdd': '从技能库添加',
      'role.skillAddHint': '还有 {n} 个可用：契约比对、灰度开关、迁移说明、取数口径…',
      'role.browse': '浏览',
      'role.mcpNote': '工具策略跟随角色，实例不越权',
      'role.mcpRef': '已引用',
      'role.builtinTools': '内置工具',
      'role.toolDeny': '无 {tools}',
      'role.snapshotTitle': '快照规则',
      'role.snapshotBody': '快照在召唤那一刻固化：队员带着角色当时的快照上路，之后改这个角色不影响在跑实例 —— 想让新设定生效，重新召唤。',
      'role.actions': '操作',
      'role.tryInCaptain': '在队长会话试召唤',
      'role.deleteReadonly': '删除（内置只读）',
      'role.readonlyBadge': '只读',
      'role.membershipCount': '被 {teams} 个团队聘任 · {instances} 个实例',
      'role.skillEnabled': '在角色编辑器里改技能',
      'role.browseSkills': '浏览技能库',
      /* [G4 ledger] */ /* [G5 graph] */ /* [G6 flow] */
      /* ── G4 ledger：审计回放 / 团队设置 / 归档回放 / 全部团队 / 项目团队列表 ── */
      'audit.view.task': '按任务',
      'audit.view.member': '按角色',
      'audit.view.time': '按时间',
      'audit.events': '全部 {n} 条事件',
      'audit.derived': '只读 · 从账本派生',
      'audit.export': '导出 JSONL',
      'audit.cap': '任务',
      'audit.role': '角色',
      'audit.attempt': '第 {n} 次尝试',
      'audit.attemptEvents': '{n} 条事件',
      'audit.attempts': '{n} 次尝试',
      'audit.latest': '最新',
      'audit.detail': '看任务详情',
      'audit.eyebrow': '{id} · {role} · 共 {n} 条事件',
      'audit.taskLabel': '任务',
      'audit.ledgerNote': '本页只读，数据 100% 从账本派生，不产生新事件。账本 append-only，归档后仍可在此回放。',
      'audit.emptyTask': '这个任务还没有账本事件。',
      'settings.page.title': '团队设置',
      'settings.page.desc': '这里的改动写入 .dsh-myteam/config/team.config.json。插件默认 < 项目配置 < 团队模板，后者优先级最高；数组是整条替换，不做深度合并。',
      'settings.jsonView': 'JSON 源视图',
      'settings.sourceTitle': '配置来源',
      'settings.sourceNote': '后者覆盖前者',
      'settings.layer.default': '插件默认',
      'settings.layer.project': '项目配置',
      'settings.layer.team': '团队模板',
      'settings.layer.effective': '（生效）',
      'settings.layer.defaultPath': 'plugin/config/team.config.default.json · 随插件升级',
      'settings.layer.projectPath': '.dsh-myteam/config/team.config.json · 只写你改过的项',
      'settings.layer.teamPath': '.dsh-myteam/tasks/<teamId>/team.config.json · 建团时按模板落盘',
      'settings.layer.items': '{n} 项',
      'settings.layer.covered': '{n} 项覆盖',
      'settings.layer.idle': '未生效',
      'settings.layer.readonly': '只读',
      'settings.layer.thisFile': '本文件',
      'settings.layer.teamScope': '随团队生命周期',
      'settings.mergeNote': '数组整条替换，不做深度合并；命令行临时参数只影响本次会话',
      'settings.behavior': '行为配置',
      'settings.behaviorNote': '只读列为插件硬上限',
      'settings.teamSize': '团队规模',
      'settings.teamSizeSub': '一个团队最多同时聘任多少个角色（不含队长）',
      'settings.delegateDepth': '委派深度',
      'settings.delegateDepthSub': '实例能否自己再拉一个角色进团队，0 表示禁止',
      'settings.gatesSub': '任务完成前必须跑通类型检查与单测',
      'settings.gateTimeoutLabel': '门禁命令超时',
      'settings.gateTimeoutSub': '单条门禁命令的最长执行时间，超时按失败计',
      'settings.seconds': '秒',
      'settings.hideTools': '隐藏内置团队工具',
      'settings.hideToolsSub': '在会话里隐藏 myteam_* 工具的原始调用记录，只看结果',
      'settings.evidenceLabel': '知识必须带证据',
      'settings.evidenceSub': '没有证据引用的结论不能写进共享知识库',
      'settings.ceiling': '硬上限 {v}',
      'settings.stateDir': '状态目录',
      'settings.openDir': '打开目录',
      'settings.gitignore': 'gitignore 托管块已就位',
      'settings.ledgerAppend': '账本 ledger.jsonl 只追加，运行时不会被整体重写',
      'settings.lifecycle': '团队生命周期',
      'settings.archiveTitle': '归档此团队',
      'settings.archiveSub': '在册角色会被排空释放，账本与 token 记录归档到 archive/，可随时重新打开查看',
      'settings.archiveBtn': '归档',
      'settings.handoffTitle': '移交到新会话',
      'settings.handoffSub': '把当前团队的上下文摘要带进一个新建的团队预设会话；原会话保留不动',
      'settings.handoffBtn': '移交',
      'settings.handoffHint': '只移交上下文：不复制名册、不复制任务，新队长自行决定分工',
      'settings.handoffConfirm': '确认移交到新会话？',
      'settings.handoffConfirmBody': '将为「{team}」新建一个团队预设会话，并把上下文摘要作为首条消息注入。原会话保持原样（不做原地变身）。',
      'settings.handoffConfirmBtn': '新建会话并注入',
      'settings.handoffDone': '移交完成 · 新会话',
      'settings.handoffPartial': '会话已建，但摘要注入失败（可手动粘贴）',
      'settings.handoffFailed': '移交失败：{msg}',
      'settings.disbandTitle': '解散此团队',
      'settings.disbandSub': '不可撤销。{members} 个在册角色将被排空释放，{tasks} 个未完成任务转 blocked',
      'settings.disbandBtn': '解散',
      'settings.confirmDisband': '确认解散',
      'settings.cancelDisband': '取消',
      'settings.footNote': '改配置不会重跑已派发的任务。',
      'settings.footNoteSub': '新值只影响后续派发；正在跑的门禁仍按启动时的超时值执行。',
      'settings.readonlyTip': '只读：离线团队的配置来自账本折叠，启动团队模式会话后可编辑。',
      'settings.failed': '操作失败：{msg}',
      'costbar.total': '累计 token',
      'costbar.hitRate': '缓存命中率',
      'costbar.today': '今日未命中 / 输出',
      'costbar.callsCount': '{n} 次调用',
      'costbar.context': '上下文占用',
      'costbar.na': '未接入口径',
      'archive.status': '已归档',
      'archive.archivedAt': '归档于 {time} · 只读',
      'archive.readonly': '只读',
      'archive.replayChip': '只读回放',
      'archive.openAudit': '在审计视图打开',
      'archive.allTeams': '全部团队',
      'archive.section.end': '为什么结束',
      'archive.section.progress': '进度',
      'archive.section.roster': '名册 · {n}',
      'archive.section.cost': '花费 · 按天桶',
      'archive.section.tasks': '任务历史 · {n}',
      'archive.section.ledger': '账本与产物',
      'archive.eventCount': '{n} 条事件',
      'archive.snapshot': '归档快照 · 可导出',
      'archive.done': '已完成',
      'archive.blocked': 'blocked',
      'archive.notStarted': '未开始',
      'archive.tokensTotal': '累计 token',
      'archive.calls': '次调用',
      'archive.endTitle': '团队已归档：实例会话释放，任务不再推进',
      'archive.endFallback': '这个团队在归档时没有留下解散说明，账本与产物按归档时的终态原样保留。',
      'archive.endDisbander': '解散人 · 你',
      'archive.endDrained': '{n} 个角色已排空释放',
      'archive.endBlocked': '{n} 个未完成任务转 blocked',
      'archive.endPath': '归档至 {path}',
      'archive.rosterEmpty': '归档时名册为空。',
      'archive.taskDone': '{n} 个任务',
      'archive.deliverables': '交付 {n} 份产物',
      'archive.tokenOf': '{v} token',
      'archive.drained': '归档时已排空，私有空间保留在快照里',
      'archive.costNote': '从 tokens.json 侧车读，可重建',
      'archive.costDay': '日期',
      'archive.cost.uncached': '未命中',
      'archive.cost.hit': '命中',
      'archive.cost.write': '写缓存',
      'archive.cost.output': '输出',
      'archive.cost.calls': '调用',
      'archive.cost.rate': '命中率',
      'archive.cost.total': '合计',
      'archive.tasksNote': '终态如实保留，失败不隐藏',
      'archive.evidence': '{n} 条证据',
      'archive.neverClaimed': '依赖未满足 —— 从头到尾没有实例认领过它',
      'archive.seeEvidence': '看证据',
      'archive.seeGate': '看门禁',
      'archive.ledgerTitle': '账本与产物',
      'archive.ledgerPath': 'archive/{id}/',
      'archive.ledgerJsonl': 'append-only 原件 —— 回放是逐事件重放，不是快照',
      'archive.ledgerJsonlEvents': '{n} 条事件',
      'archive.seeAll': '逐条看',
      'archive.teamJson': '名册与终态 · 按天桶花费侧车（派生，可从 tokenMeter 重建）',
      'archive.membersDir': 'identity.json 配置快照 + 各自的 memory.md 与私有笔记',
      'archive.artifactsDir': '产物索引，正文仍在原仓库路径',
      'archive.artifactsCount': '{n} 项',
      'archive.openDir': '打开目录',
      'archive.note': '归档是终点，不是暂停。',
      'archive.noteSub': '实例会话已释放，任务不能再推进，账本只读。想接着做同类的事，用同一个预设新建一个团队 —— 旧团队不会被自动重建，也不会被新团队引用。',
      'shell.filter': '筛选团队（名称/目标/项目）…',
      'shell.hint': '面板只做查看与管理；「新建团队」走建团向导，角色的完整定义在「团队模式」预设会话中',
      'shell.groupCount': '{n} 个团队',
      'shell.online': '在线',
      'shell.offline': '离线',
      'shell.done': '完成 {done}/{total}',
      'shell.running': '进行中 {n}',
      'shell.gatePending': '门禁待审 {n}',
      'shell.members': '角色 {n}',
      'shell.draft': '草稿',
      'shell.empty': '这个项目还没有团队。',
      'shell.noMatch': '没有匹配的团队。',
      'shell.newTeam': '新建团队',
      /* G5 · design/lanes.html · dag.html · dag-vertical.html · dragging.html */
      'view.dir.arrow.h': '横向 →',
      'view.dir.arrow.v': '竖向 ↓',
      'lanes.groupBy': '行 = 角色',
      'lanes.byStage': '按阶段',
      'lanes.byPriority': '按优先级',
      'lanes.byStageHint': '泳道分行方式由设置页 pipeline.swimlaneBy 决定（角色 / 阶段 / 优先级）',
      'lanes.noMembers': '名册里还没有角色：先在团队模式会话里召唤队员',
      'lanes.emptyRow': '无进行中任务',
      'lanes.unassignedNote': '没有指派给在册角色',
      'lanes.more': '还有 {n} 个',
      'lanes.moreHint': '该格还有 {n} 个任务，滚到底可看全部（或切到看板）',
      'lanes.noteLead': '泳道按角色分行',
      'lanes.noteBody': '，每个格子是该实例在某个阶段的任务节点。在设置页可切换为按阶段或按优先级分行（pipeline.swimlaneBy），蛇形布局让阶段流转方向始终向右。',
      'dag.showModel': '显示模型',
      'dag.showModelHint': '运行中的节点在卡片脚下标出实际模型',
      'dag.hotChain': '已高亮 {ids} 依赖链',
      'dag.hotChainHint': '在跑任务的上下游依赖链用主色加粗高亮',
      'dag.hotChainEmpty': '当前没有在跑的依赖链',
      'dag.noteLead': '箭头从上游指到下游：',
      'dag.noteLeadV': '竖向读法：',
      'dag.arrowNote': '一条边表示「下游要等上游，上游完成即解锁」；一个任务可以同时解锁多个下游（t5 → t4 / t8 / t9）。高亮的是当前在跑的依赖链。',
      'dag.arrowNoteV': '从上往下按依赖层级排，箭头自上而下指向下游；同一任务可同时解锁多个下游，高亮的是当前在跑的依赖链。',
      'dag.edge': '依赖边',
      'dag.graphLabel': '任务依赖图',
      'dag.targets': '解锁 {n} 个下游',
      'dag.teams': '{n} 个团队',
      'dag.evidence': '{n} 条证据',
      'drag.liftTag': '松手放入',
      'drag.ghost': '{code} 正被拖动',
      'drag.dropzone': '释放移入 · 进入后走 审查 → 命令验证 → 存档',
      'drag.rejectedTitle': '{code} → {col} 被拒',
      'drag.rejectedBody': '它的命令门禁还没过（超时 {n} 次）。gate 未过的卡进不了已完成 —— 先让它走完门禁链，或在任务菜单里「重跑这条门禁」。',
      'drag.rejectedLink': '看 {code} 卡在哪 →',
      'drag.accepted': '{code} → {col}：落点合法，松手后由该阶段的门禁链接手（状态仍由队员 claim 推进）',
      'drag.locked': '锁住不可拖',
      'drag.lockedTitle': 'attempt 失效：这张卡锁住不可拖（gate 未过或已取消）',
      'drag.rulesBadge': '流转规则',
      'drag.rulesTitle': '拖拽流转仍受状态机约束',
      /* CHG-82 G6：建团向导 / 项目级任务列表 / 团队参与任务 / 会话页 / 单角色调用 */
      'g6.wizard.title1': '用什么分工起这个团队',
      'g6.wizard.title2': '谁来干这件事',
      'g6.wizard.title3': '这个团队要达成什么',
      'g6.step.preset': '选预设',
      'g6.step.roster': '组建名册',
      'g6.step.goal': '写目标',
      'g6.wizard.desc1': '选一个预设就得到现成的名册、看板列和门禁链，下一步可以逐个调整。不知道选哪个就选第一个 —— 它照标准三人组配，需求、开发、验收三段都有人守。',
      'g6.wizard.desc2': '从角色库挑角色组建名册，每挑一个就拉进来成为在册角色，名字由实例名决定（同名自动加 -2）。队长不需要选，它就是这个会话本身；实例会话在你点下一步后才会创建。',
      'g6.wizard.desc3': '给团队起个名字、写一句目标，队长按这句话拆任务。目标之后还能改，但拆出来的任务不会自动重排。',
      'g6.wizard.rosterMeta': '名册 {n} · {roles} · {tail}',
      'g6.wizard.noPreset': '不套预设，从角色库自己挑',
      'g6.wizard.noPresetSub': '名册 0 · 看板用插件默认五列 · 门禁用默认链，之后都能改',
      'g6.wizard.globalHint': '来自全局库，用之前会先复制一份进本项目',
      'g6.wizard.presetNote': '预设只是起点，不是约束。',
      'g6.wizard.presetNoteBody': '名册里存的是角色引用，之后加人减人都不改预设；看板列与门禁链也能在这个团队自己的配置里单独改，不影响别的团队。',
      'g6.wizard.managePresets': '管理预设库',
      'g6.wizard.nextRoster': '下一步：组建名册',
      'g6.wizard.nextGoal': '下一步：写目标',
      'g6.wizard.prev': '上一步',
      'g6.wizard.cancel': '取消',
      'g6.wizard.selected': '已选 {n} 名',
      'g6.wizard.cap': '上限 {n} 名',
      'g6.wizard.captainNote': '队长已自动加入。',
      'g6.wizard.captainNoteBody': '队长就是这个团队预设会话本身，不是在册角色；它负责拆任务、派活和裁决门禁。',
      'g6.wizard.fromLibrary': '从角色库再挑几个',
      'g6.wizard.pickHint': '选中即创建实例',
      'g6.wizard.willCreate': '将创建 {name} · {model} · {desc}',
      'g6.wizard.inheritRoute': '继承队长路由',
      'g6.wizard.later': '实例会话在你点下一步后才会创建',
      'g6.wizard.start': '创建团队',
      'g6.wizard.copy': '复制提示词',
      'g6.wizard.copied': '✓ 已复制',
      'g6.wizard.remove': '移除 {name}',
      'g6.wizard.name': '团队名称',
      'g6.wizard.goal': '目标一句话',
      'g6.wizard.promptTitle': '队长提示词预览',
      'g6.wizard.needName': '先给团队起个名字',
      'g6.wizard.needGoal': '写一句这个团队要达成的目标',
      'g6.wizard.unavailable': '当前工作区不支持直接开会话：请手动复制提示词到新的 team 预设会话。',
      'g6.wizard.loadingPresets': '正在加载预设…',
      'g6.wizard.presetsFailed': '预设读取失败。',
      'g6.wizard.presetsFailedBody': '可以直接「不套预设」从角色库自己挑，或重试。',
      'g6.wizard.retry': '重试',
      'g6.tasks.headTitle': '任务',
      'g6.tasks.headMeta': '{n} 个 · {m} 个团队参与',
      'g6.tasks.headGoal': '任务是项目级实体：团队通过「参与」接手，一张任务可多团队参与（主责 / 协作），一个团队也负责多个任务',
      'g6.tasks.summaryTasks': '任务',
      'g6.tasks.summaryLinks': '参与关系（主责 {lead} · 协作 {coop}）',
      'g6.tasks.summaryRunning': '进行中',
      'g6.tasks.summaryGates': '门禁待审',
      'g6.tasks.summaryDone': '已完成',
      'g6.tasks.stageNote': '阶段口径按各团队状态机',
      'g6.tasks.pageTitle': '任务清单',
      'g6.tasks.pageDesc': '任务是项目级实体，团队通过「参与」接手：一张任务可以有多个团队参与（主责一个、协作若干），一个团队也同时参与多个任务。队员分配仍在团队内管理。',
      'g6.tasks.boardView': '看板视图',
      'g6.tasks.filterAll': '全部 {n}',
      'g6.tasks.groupMeta': '{id} · {state} · 主责 {lead} · 协作 {coop}',
      'g6.tasks.boardLink': '看板 →',
      'g6.tasks.restInBoard': '待规划 {backlog} · 已完成 {done}，其余在看板',
      'g6.tasks.restAll': '其余 {n} 个任务在看板',
      'g6.tasks.draftEmpty': '草稿 · 还没有任务，也没有参与关系',
      'g6.tasks.draftNote': '草稿团队还没有参与任何任务。团队组建完成后，由队长在项目里派单（主责）或接到协作邀请，任务与团队的关系在这里显性化。',
      'g6.tasks.viewList': '列表',
      'g6.tasks.viewBoard': '看板',
      'g6.tasks.viewFlow': '流程',
      'g6.tasks.viewDag': '依赖图',
      'g6.tasks.searchPlaceholder': '搜索任务号、标题、团队',
      'g6.tasks.filter': '筛选',
      'g6.teamTasks.title': '参与任务',
      'g6.teamTasks.desc': '任务是项目级实体，团队通过「参与」接手：这里只列本团队参与的任务，以及本团队在其中是主责还是协作。任务本身的看板、流程、依赖图在项目 · 任务里看。',
      'g6.teamTasks.boardBtn': '项目任务看板',
      'g6.teamTasks.filterAll': '全部 {n}',
      'g6.teamTasks.filterLead': '主责 {n}',
      'g6.teamTasks.filterCoop': '协作 {n}',
      'g6.teamTasks.filterHint': '本队队员分配在任务详情里改',
      'g6.teamTasks.coopTeam': '协作 · {name}',
      'g6.teamTasks.leadTeam': '主责 · {name}',
      'g6.teamTasks.rest': '其余 {n} 个：待规划 {backlog} · 已完成 {done}',
      'g6.teamTasks.gotoBoard': '去项目看板 →',
      'g6.teamTasks.note': '任务与团队是两件事：任务在项目里独立存在（派单、依赖、门禁、证据都在任务上），团队只是「参与」它。同一张任务被多个团队参与时，各自出人、各管各的队员，门禁由任务的验收口径统一裁决。',
      'g6.dock.running': '{n} 个角色在跑',
      'g6.dock.gates': '{n} 个门禁待审',
      'g6.conv.view': '团队视图',
      'g6.conv.chat': '对话',
      'g6.conv.planStat': '· {tasks} 个任务 · {roles} 个角色 · {gates} 轮门禁',
      'g6.conv.openPanel': '在面板打开',
      'g6.conv.openDetail': '看 {id} 详情',
      'g6.conv.ledger': '账本已记录 · {time}',
      'g6.conv.moreTasks': '另有 {n} 个任务',
      'g6.conv.tasksEmpty': '当前看板还没有任务（面板只读真实账本，不展示演示数据）',
      'g6.conv.approvedStat': '· 计划已批准，{n} 个角色的会话已创建',
      'g6.conv.peerStat': '· {from} ⇠ {to}',
      'g6.conv.hint': '这个会话是 team 预设，队长会持续维护计划与账本。想让某个角色单独干活，输入 {cmd}。',
      'g6.conv.hintLink': '看单角色调用长什么样 →',
      'g6.conv.inputPlaceholder': '对队长说点什么，或者用 /myteam+roleId 直接找某个角色',
      'g6.guest.banner': '{n} 个角色的配置已注入这个会话',
      'g6.guest.bannerBody': ' —— 提示词、工具策略、技能与 MCP 都按角色声明加载。这次调用不属于任何团队，不进团队账本，也不会产生实例会话。',
      'g6.guest.inspect': '看注入了什么',
      'g6.guest.applyStat': '· {n} 个角色 · 只收窄，不扩权',
      'g6.guest.systemPrompt': '系统提示',
      'g6.guest.toolPolicy': '工具策略',
      'g6.guest.skills': '技能',
      'g6.guest.mcp': 'MCP',
      'g6.guest.modelRoute': '模型路由',
      'g6.guest.onceInject': '一次性注入',
      'g6.guest.narrowOnly': '只能收窄',
      'g6.guest.seeRole': '看角色定义',
      'g6.guest.seeSkills': '看技能与 MCP',
      'g6.guest.unload': '卸载角色',
      'g6.guest.candCap': '匹配到 {n} 个角色 · 选一个',
      'g6.guest.candFoot': '已加载的再输一次是刷新；要卸掉就写 -reviewer',
      'g6.guest.hint': '这个会话不是团队，所以 /myteam new 在这里不可用 —— 团队只能从 team 预设新建。单角色调用随时可用，两者互不干扰。',
      'g6.guest.section': '单角色调用（/myteam+ 演示）',
      'g6.guest.blurb': '按审查准则过了一遍，三个风险点，文档缺两块：',
      'g6.guest.risk1': '风险 1 · 灰度开关没有默认值。',
      'g6.guest.risk2': '风险 2 · 契约里没写金额精度。',
      'g6.guest.risk3': '风险 3 · t3 删旧目录没有前置检查。',
      'g6.guest.writeStat': '· docs/settlement-migration.md · 已收窄到 docs/',
    }
    const en = {
      'panel.title': 'myteam panel',
      'panel.roster': 'Roster',
      'panel.board': 'Stage board',
      'banner.staged': 'Plan staged',
      'banner.waiting': 'Awaiting human decision',
      'action.approve': '✓ Approve & Run',
      'action.revise': '↻ Revise',
      'action.discard': '✕ Discard',
      'action.reload': '↻',
      'action.close': 'Close',
      'action.send': 'Send',
      'detail.timeline': 'Timeline',
      'detail.evidence': 'Verification evidence',
      'detail.thread': 'Thread',
      'detail.commentPlaceholder': 'Comment into the task thread (actor=human)…',
      'detail.commentSent': '✓ recorded',
      'roster.empty': 'No members yet. Summon with myteam_spawn_member in the captain session.',
      'chip.title': 'myteam team status (click to open panel)',
      'error.unreadable': 'Cannot read team state: ',
      'error.hint': '(create a team in a team-preset session inside the project workspace, then retry)',
      'panel.unavailable': 'No active myteam team in this workspace yet — submit a plan in the captain session (Team Mode) and the board will appear here.',
      'scope.label': 'View',
      'scope.global': 'Global',
      'scope.team': 'Team',
      'scope.hint': 'myteam teams across all workspaces',
      'global.createHint': 'Read-only view; teams and roles are created in the Team Mode preset session',
      'global.empty': 'No teams yet.',
      'global.emptyHint': 'Teams and roles are created in a Team Mode preset session — start one and the captain will show up here.',
      'global.counts': '{done}/{total} done',
      'global.running': '{n} running',
      'global.online': 'Online',
      'global.offline': 'Offline',
      'global.updated': 'updated {time}',
      'global.groupCount': '{n} team(s)',
      'global.search': 'Filter teams (name / goal / project)…',
      'global.noMatch': 'No matching teams.',
      'offline.banner': 'Offline snapshot · no running session, read from the ledger (read-only)',
      'offline.updated': 'Last activity {time}',
      'offline.empty': 'This team ledger has no displayable events yet.',
      'offline.degraded': '{n} unreadable record(s) in the ledger were skipped.',
      'offline.readonlyTip': 'Read-only view: start a Team Mode session to keep working.',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n}m ago',
      'time.hoursAgo': '{n}h ago',
      'time.daysAgo': '{n}d ago',
      'rel.none': 'No role usage yet',
      'action.disband': 'Disband…',
      'disband.impact': 'Disband drains {members} member(s), moves {tasks} task(s) to blocked, and archives the ledger and tokens.',
      'disband.confirm': 'Confirm disband',
      'disband.cancel': 'Cancel',
      'rel.title': 'Roles ↔ Teams',
      'rel.usedBy': '{n} member(s)',
      'flow.empty': 'No task flow yet.',
      'flow.deps': 'deps',
      'flow.unlocks': 'unlocks',
      'flow.escalate': 'escalations',
      'team.pick': 'Pick a team from the global view.',
      'team.back': '← Global',
      'tab.board': 'Board',
      'tab.roles': 'Roles',
      'tab.presets': 'Starter team',
      'presets.note': 'A starter team = the standard captain + 3 members. The captain is always the myteam-captain preset (identical across teams); each member can bind different skills and MCP allowlists. Global scope holds roles only; team templates are composed from roles per task at the project level. This panel is read-only.',
      'presets.origin.project': 'Project team templates',
      'presets.origin.builtin': 'Built-in starter team',
      'presets.empty': 'No team templates in this layer. Directory: {path}',
      'presets.captain': 'Captain',
      'presets.captainLine': 'Captain: standard myteam-captain preset (not in the member roster, not counted against the member limit)',
      'presets.members': 'Members',
      'presets.skills': 'Skills',
      'presets.mcp': 'MCP',
      'presets.inherit': 'inherit from role',
      'presets.roster': 'Members',
      'presets.columns': 'Columns',
      'presets.pipeline': 'Swimlanes',
      'presets.gates': 'Gates',
      'presets.gatesOff': 'off',
      'presets.warnings': 'Preset warnings',
      'presets.readonly': 'read-only',
      'tab.knowledge': 'Knowledge',
      'tab.cost': 'Cost',
      'tab.members': 'Members',
      'tab.inbox': 'Inbox',
      'tab.audit': 'Audit',
      'tab.settings': 'Settings',
      'view.label': 'View',
      'view.board': 'Board',
      'view.lanes': 'Swimlanes',
      'view.dag': 'Dependencies',
      'view.flow': 'Flow',
      'view.dragRules': 'state-machine',
      'board.emptyCol': 'No tasks',
      'board.deps': 'deps',
      'board.evidence': 'evidence',
      'board.blockedBy': 'blocked by {deps}',
      'board.addToCol': 'New task in {col}',
      'board.colHint': 'columns = stages',
      'filter.task': 'Filter tasks (title / id / member)…',
      'filter.priority': 'Priority',
      'filter.member': 'Member',
      'filter.all': 'All',
      'filter.clear': 'Clear',
      'filter.showing': 'showing {n}/{total}',
      'rules.title': 'State machine',
      'rules.body': 'backlog → ready/blocked; ready → in progress; in progress → gate/re-scoping/failed; gate → next gate/back; done and failed are terminal. The panel does not drag tasks between states — only member claim/declarations advance a task, so gates cannot be bypassed.',
      'dag.hint': 'Click to highlight the dependency chain, double-click to open details',
      'detail.attemptGroup': 'Attempt {id}',
      'detail.exitCode': 'exit',
      'inbox.approveHint': 'Approving spawns the roster and puts plan tasks on the board immediately.',
      'inbox.offlineHint': 'Read-only: start a Team Mode session to decide here.',
      'inbox.revisePrompt': 'Revision note (recorded as plan.revised)',
      'inbox.actionFailed': 'Action failed: ',
      'roster.captain': 'Captain',
      'roster.captainNote': 'The captain is the Team Mode session itself: not a roster member and not counted against the member limit.',
      'roster.count': '{n} member(s)',
      'roster.inactive': 'Suspended / archived',
      'lanes.unassigned': 'Unassigned',
      'lanes.empty': 'No tasks',
      'lanes.count': '{n} task(s)',
      'dag.depth': 'Layer {n}',
      'dag.empty': 'No tasks',
      'inbox.title': 'Waiting for you',
      'inbox.empty': 'Nothing waiting.',
      'inbox.staged': 'Plan awaiting decision',
      'inbox.stagedNote': 'Use Approve & Run / Revise / Discard in the banner above the board.',
      'inbox.escalations': 'Escalations ({n})',
      'inbox.escalationsNote': 'A member reported a blocker; the captain will re-plan. Open a task for its timeline.',
      'inbox.proposals': 'Knowledge proposals ({n})',
      'inbox.proposalsNote': 'See details under Knowledge; adopting/rejecting is done by the captain via myteam_adopt_knowledge.',
      'inbox.unread': 'Unread messages ({n})',
      'inbox.unreadNote': 'Unread items in task threads and the captain inbox.',
      'inbox.openBoard': 'Back to board',
      'audit.title': 'Ledger event stream',
      'audit.total': '{n} event(s)',
      'audit.readOnly': 'Read-only · replayed event by event',
      'audit.empty': 'No events yet.',
      'audit.loadMore': 'Load {n} earlier',
      'audit.end': 'End reached',
      'audit.filter.all': 'All',
      'audit.filter.task': 'Tasks',
      'audit.filter.gate': 'Gates',
      'audit.filter.member': 'Members',
      'audit.filter.knowledge': 'Knowledge',
      'audit.filter.team': 'Team',
      'settings.title': 'Effective config',
      'settings.source': 'Config source',
      'settings.default': 'Plugin default',
      'settings.project': 'Project config',
      'settings.team': 'Team template',
      'settings.notWired': 'No project/team config found; showing plugin defaults.',
      'settings.teamNote': 'Config comes from the team template applied at creation (team-level team.config.json).',
      'settings.board': 'Board columns',
      'settings.columns': 'Column mapping',
      'settings.pipeline': 'Pipeline',
      'settings.limits': 'Limits (hard caps)',
      'settings.gates': 'Gates',
      'settings.taskTypes': 'Task types → gate chain',
      'settings.views': 'Views',
      'settings.warnings': 'Config warnings',
      'settings.offline': 'Offline snapshot: merged from project + team team.config.json (read-only).',
      'settings.maxMembers': 'Max members',
      'settings.maxDepth': 'Delegation depth',
      'settings.maxTasks': 'Max tasks',
      'settings.gateTimeout': 'Gate timeout (ms)',
      'settings.clarify': 'Clarify rounds',
      'settings.memory': 'Evidence required',
      'costbar.label': 'Cost (estimate)',
      'costbar.estimate': 'estimate',
      'costbar.calls': 'calls',
      'costbar.input': 'in',
      'costbar.output': 'out',
      'costbar.hit': 'hit',
      'cost.total': 'Total',
      'cost.member': 'Member',
      'cost.calls': 'Calls',
      'cost.uncached': 'Uncached in',
      'cost.cacheRead': 'Cache read',
      'cost.cacheWrite': 'Cache write',
      'cost.output': 'Output',
      'cost.hit': 'Hit rate',
      'cost.note': 'Caliber: live tokenMeter readings (heuristic estimate, not a bill); ledger usage is a separate caliber and is not reconciled here.',
      'cost.updated': 'updated {time}',
      'cost.empty': 'No usage recorded yet (member calls have not run).',
      'cost.offlineEmpty': 'No tokens.json in this offline snapshot (no member calls recorded yet).',
      'detail.priority': 'Priority',
      'detail.ac': 'Acceptance criteria',
      'detail.assignee': 'Assignee',
      'detail.role': 'Role',
      'detail.deps': 'Deps',
      'detail.gates': 'Gates',
      'detail.deliverables': 'Deliverables',
      'detail.attempt': 'Attempt',
      'detail.gatePending': 'pending',
      'detail.gateExecutedByHost': 'Host-executed',
      'detail.gateExecutedByHint': 'The command ran in the host subprocess and was judged by its real exit code (not a self-report)',
      'detail.gateForcedByHuman': 'Human force-release',
      'detail.gateForcedByHint': 'The reject budget was exhausted and a human released it - lower confidence than an automatic verdict',      'detail.gatePass': 'pass',
      'detail.gateFail': 'fail',
      'member.suspend': 'Suspend',
      'member.archive': 'Archive',
      'member.remove': 'Remove',
      'member.restore': 'Restore',
      'member.removeConfirm': 'Removing a member deletes their private workspace (irreversible). Remove?',
      'member.busy': 'Working…',
      'roles.origin.builtin': 'Built-in roles',
      'roles.origin.global': 'Global roles',
      'roles.origin.project': 'Project roles',
      'roles.captain': 'Captain',
      'roles.loading': 'Loading role catalog…',
      'roles.empty': 'No role definitions',
      'roles.unavailable': 'The role catalog requires an active team session (submit a plan in a Team Mode session first).',
      'kb.search': 'Search title, tags or body…',
      'kb.queue': 'Pending proposals',
      'kb.entries': 'Knowledge entries',
      'kb.empty': 'No knowledge entries yet. Members propose on task completion; the captain adopts via myteam_adopt_knowledge.',
      'kb.core': 'Core',
      'kb.unverified': 'Unverified',
      'kb.stale': 'Stale',
      'kb.proof': 'proof',
      'kb.evidence': 'Evidence',
      'kb.timeline': 'Evolution timeline',
      'kb.rel.new': 'New',
      'kb.rel.refine': 'Refine',
      'kb.rel.contradict': 'Contradict',
      'kb.target': 'Target entry',
      'scope.project': 'Project',
      'project.tabs.roles': 'Roles',
      'project.tabs.teams': 'Teams',
      'project.tabs.tasks': 'Tasks',
      'project.root': 'Project',
      'project.pick': 'Choose project',
      'team.tab.participating': 'Participating',
      /* CHG-102: project store empty state */
      'store.emptyTitle': 'This project has not entered team mode yet',
      'store.emptyBody': 'Everything team-mode owns lives under the project store: roles / teams / skills / tools (config/), tasks and dependencies (tasks/), workflow history (history/). Initializing only creates the directory and its .gitignore — no team, no members.',
      'store.init': 'Initialize .dsh-myteam',
      'store.initDone': 'Project store initialized: {path}',
      'store.uploadHint': 'Upload policy lives in .dsh-myteam/.gitignore: config/ and tasks/ are shared; state/, history/ and export/ stay out (rebuildable from the ledger).',
      /* CHG-103: role scope (global must be explicit) */
      'role.scope': 'Scope',
      'role.scope.project': 'Project (default)',
      'role.scope.projectHint': 'Visible in this project only; shared with the repo',
      'role.scope.global': 'Global',
      'role.scope.globalHint': 'Visible to every project; needs confirmation',
      'team.backList': '← Teams',
      'task.participants': 'Teams',
      'task.assignees': 'Assignees',
      'task.owner': 'lead',
      'task.coop': 'coop',
      'task.ownerTeam': 'Lead team',
      'detail.participants': 'Participating teams',
      'detail.assignees': 'Assignees',
      'detail.assigneeNote': 'A task can have one or more assignees; execution still follows role claim.',
      'tasks.rail': 'Teams',
      'tasks.railAll': 'All teams',
      'tasks.empty': 'No tasks yet. Tasks are planned by the captain in Team Mode sessions.',
      'tasks.view.list': 'List',
      'tasks.filterTeam': 'Team',
      'tasks.count': '{lead} lead · {coop} coop',
      'role.interest': 'Interest words',
      'role.skills': 'Skills',
      'role.mcp': 'MCP',
      'role.model': 'Model',
      'role.prompt': 'System prompt',
      'role.memberships': 'Appointments',
      'role.membershipsEmpty': 'No team has appointed it yet.',
      'role.usage': '{teams} teams · {instances} instances',
      'role.snapshot': 'Identity snapshot is frozen at summon time; later role edits do not affect running instances.',
      'role.origin.project-role': 'Project role',
      'role.origin.builtin': 'Built-in',
      'role.origin.plugin': 'Plugin',
      'role.origin.global': 'Global',
      'role.origin.project': 'Project',
      /* CHG-91 / CHG-106: capability packs (roles + team templates bundled by plugins) */
      'contrib.title': 'Capability packs',
      'contrib.desc': 'Third-party plugins bundle a capable role or a ready-made team into a capability pack. Once installed it shows up in the role library and team wizard - pick it by name when forming a team.',
      'contrib.empty': 'No capability packs installed (drop a plugin into $DSH_HOME/myteam/plugins/)',
      'contrib.reload': 'Rescan plugins',
      'contrib.reloading': 'Scanning…',
      'contrib.reloaded': 'Rescanned: {plugins} pack(s) · {roles} role(s) · {teams} team template(s)',
      'contrib.pluginCount': '{n} pack(s)',
      'contrib.roles': 'Roles',
      'contrib.teams': 'Team templates',
      'contrib.capRoles': 'Roles',
      'contrib.capTeams': 'Templates',
      'contrib.members': '{n} members',
      'contrib.providedBy': 'Provided by plugin "{plugin}"',
      'contrib.readonly': 'Read-only',
      'contrib.readonlyHint': 'Roles inside a capability pack are read-only; copy to project to edit that copy',
      'contrib.warnTitle': 'Capability packs have {n} error(s)',
      'contrib.warnHint': 'Those entries were skipped. Fix the plugin directory per each message, then click "Rescan plugins".',
      'contrib.ok': 'Capability packs loaded ({plugins} pack(s) / {roles} role(s) / {teams} team template(s))',
      'contrib.root': 'Contribution root: {root}',
      /* CHG-74: same-id copies (built-in / global / project) — the shadowed one says who won */
      'role.shadowedBy': 'Same id in {origin} (that one wins)',
      'role.effective': 'Effective',
      'role.detailShadowed': 'Same id copies: {list} (read-only). Showing the {origin} copy — it is the one the runtime uses.',
      'roles.page.project': 'Project roles',
      'roles.page.global': 'Global roles',
      'roles.page.builtin': 'Built-in roles',
      'roles.projectRole': 'Project role',
      'roles.projectRoleNote': 'The project\'s own role · belongs to no team; any team in this project can appoint it',
      'roles.noProjectRole': 'No project role yet — the captain sets it via myteam_set_project_role.',
      'roles.introduce': 'Available to introduce',
      'roles.filter.all': 'All',
      'roles.filter.project': 'Project',
      'roles.filter.global': 'Global',
      'roles.filter.builtin': 'Built-in',
      'roles.detail': 'Role detail',
      'roles.interestEmpty': 'No interest words',
      'roles.interest': 'Interests',
      'global.title': 'Global',
      'global.rolesNote': 'Global holds roles only: built-in (read-only) + personal global assets; teams and tasks live in projects.',
      'global.assets': 'Companion assets',
      'global.assetsNote': 'Team templates and system capabilities — shared across projects',
      'global.presets': 'Presets (team templates)',
      'global.presetsSub': 'A preset is one role arrangement; one preset opens one team',
      'global.presetsEmpty': 'No presets yet — save a team as a preset once it is set up.',
      'global.skills': 'Skills & MCP',
      'global.skillsSub': 'Global capability library: referenced from role detail, never redefined per role',
      'global.skillsEmpty': 'Not referenced by any role yet',
      'global.skillsNote': 'Skills and MCP are role capabilities, enabled in role detail and applied at summon time.',
      'global.jumpPresets': 'Open preset list',
      'global.jumpRoles': 'Open role library',
      'global.presetCount': '{n} preset(s)',
      'global.skillCount': '{s} skills · {m} MCP',
      'global.skillItem': '{n}',
      'global.mcpItem': '{n} MCP',
      'global.crossProject': 'Shared across projects',
      'global.builtinNote': 'Shipped with the plugin · read-only; copy into a project to edit',
      'global.globalNote': 'Your personal assets · they follow you across projects',
      'global.newRole': 'New role',
      'global.count': '{n} roles',
      'view.dir': 'Direction',
      'view.dir.h': 'Horizontal',
      'view.dir.v': 'Vertical',
      'cost.open': 'Usage detail',
      'state.loading': 'Loading…',
      'discard.confirm': 'Discard is two-step: the draft will be archived and never auto-rebuilt. Discard?',
      /* CHG-72 */
      'team.new': 'New team',
      'team.newHint': 'Fill in a name and goal, then open a "team mode" session where the captain drafts the plan; the team exists only after you approve it — the panel does not create teams directly.',
      'team.new.name': 'Team name',
      'team.new.goal': 'Goal (one sentence)',
      'team.new.preset': 'Template (optional)',
      'team.new.presetNone': 'No template (custom roster)',
      'team.new.promptTitle': 'First message to the captain',
      'team.new.open': 'Open team-mode session',
      'team.new.copy': 'Copy prompt',
      'team.new.copied': 'Copied',
      'team.new.needName': 'Enter a team name first',
      'team.new.needGoal': 'Enter a goal first (one sentence is enough)',
      'team.new.unavailable': 'No workspace entry for this project in the current window: open the project on the left, or copy the prompt into a team-mode session.',
      'team.new.noWorkspace': 'Open a project workspace on the left first',
      'team.draft': 'Awaiting approval',
      'team.draftHint': 'Draft: approve or revise it on the team page',
      'role.new': 'New role',
      'role.edit': 'Edit',
      'role.fork': 'Copy to project and edit',
      'role.formTitle': 'Role editor',
      'role.name': 'Name',
      'role.id': 'id (lowercase / digits / -)',
      'role.desc': 'One-line responsibility',
      'role.systemPrompt': 'System prompt',
      'role.interestWords': 'Interest words (comma separated, ≤8)',
      'role.modelProvider': 'Model provider (optional)',
      'role.modelName': 'Model name (optional)',
      'role.save': 'Save',
      'role.saved': 'Saved {id}',
      'role.confirmOverwrite': 'A role with this id exists: press Save again to overwrite the project file (running instances stay on their snapshot).',
      'role.saveHint': 'After saving: running instances keep their summon-time snapshot; the next summon picks it up.',
      'role.builtinReadonly': 'Built-in/global roles are copy sources: editing copies into a project role and leaves the original untouched.',
      'role.invalid': 'Save failed: {msg}',
      'task.new': 'New task',
      'task.formTitleNew': 'New task',
      'task.formTitleEdit': 'Edit task',
      'task.field.team': 'Owning team (online)',
      'task.field.title': 'Title',
      'task.field.desc': 'Description',
      'task.field.ac': 'Acceptance criteria (one per line)',
      'task.field.deliverable': 'Deliverable path (required for leaf tasks)',
      'task.field.deps': 'Dependencies (same team)',
      'task.field.role': 'Required role',
      'task.field.priority': 'Priority',
      'task.field.gates': 'Gate chain (comma separated; empty uses template default)',
      'task.field.assignees': 'Assignees (multi)',
      'task.field.participants': 'Coop teams (multi)',
      'task.needOnline': 'Only online teams accept task writes: open that team\'s team-mode session first.',
      'task.created': 'Created {id}',
      'task.updated': 'Saved',
      'task.structuralBlocked': 'AC / deps / required role / deliverable / gate chain are structural: while the task runs they need a rescope by the captain. Save metadata only for now.',
      'task.saveMetaOnly': 'Save metadata only',
      'task.dismissStructural': 'Back to edit',
      'task.formHint': 'After saving: no deps → ready and dispatched immediately; with deps → unlocked when upstream completes.',
      'task.noTeam': 'No online team available yet',
      'task.noMembers': 'This team has no members yet: summon members (or approve the plan) in the team-mode session first.',
      'task.needTitle': 'Title is required',
      'task.needAc': 'At least one acceptance criterion',
      'task.needRole': 'Pick a required role',
      'role.needId': 'Enter a role id (lowercase / digits / -)',
      'role.needPrompt': 'Enter a system prompt',
      'diag.title': 'Nobody can claim',
      'diag.team-inactive': 'Team is not running',
      'diag.deps-pending': 'Upstream unfinished: {deps}',
      'diag.no-role': 'Roster lacks role: {role}',
      'diag.role-busy': 'That role is busy: {members}',
      'diag.more': '{n} in roster',
      'task.save': 'Save',
      'task.edit': 'Edit',
      /* CHG-73 P2 */
      'action.cancel': 'Cancel',
      'action.unavailable': 'Not available in this state',
      'task.rescope': 'Re-plan',
      'task.rescopeDone': 'Re-planned {id} ({state})',
      'task.revisionConflict': 'Save failed: this task changed since you opened it (current revision {current}, your snapshot {snapshot}). Close the form and reopen it to see the latest content - nothing was written.',
      'task.rescopeFailed': 'Re-plan failed: {msg}',
      'task.rescopeNeedReason': 'Enter a reason for re-planning',
      'task.readonlyTitle': 'Offline / read-only team: write actions are disabled',
      'detail.actions': 'Actions',
      'detail.evidenceStale': 'Evidence is stale: {fields} changed at {time} — the latest evidence predates the edit; re-plan and re-run.',
      'detail.edits': 'Change history',
      'detail.editsEmpty': 'No edits recorded',
      'detail.editsLimit': 'Showing the latest {n} only',
      'detail.editReason': 'Reason',
      'detail.cancelled': 'Task cancelled ({time}): {reason}',
      'detail.cancelLeave': 'Downstream tasks left untouched (diagnosis shows "upstream cancelled")',
      'detail.cancelCascade': 'Downstream tasks were cancelled too',
      'detail.cancelRewire': 'Downstream tasks were re-wired to a new upstream',
      /* CHG-75: dependency re-wired (old upstream cancelled → moved to a new upstream / detached) */
      'detail.rewiredTo': 'Dependency re-wired from {from} to {to}',
      'detail.rewiredFree': 'Dependency on {from} dropped (this task stands alone)',
      'board.evidenceStale': 'Stale evidence',
      'board.cancelled': 'Cancelled',
      'board.cancelledTitle': 'Cancelled: {reason}',
      /* CHG-75: small marker for a re-wired dependency */
      'board.rewired': 'Rewired',
      'board.rewiredTitle': 'Dependency was re-wired (its upstream was cancelled)',
      'board.staleTitle': 'Stale evidence: {fields} changed at {time}',
      'diag.dep-cancelled': 'Upstream cancelled: {deps}',
      'field.title': 'Title',
      'field.description': 'Description',
      'field.acceptanceCriteria': 'Acceptance criteria',
      'field.deps': 'Dependencies',
      'field.requiredRole': 'Required role',
      'field.gateChain': 'Gate chain',
      'field.deliverableSpec': 'Deliverable',
      'field.priority': 'Priority',
      'field.assignees': 'Assignees',
      'field.participants': 'Participating teams',
      'field.state': 'State',
      'multi.on': 'Select',
      'multi.off': 'Exit selection',
      'multi.all': 'All',
      'multi.invert': 'Invert',
      'multi.clear': 'Clear',
      'multi.count': '{n} selected',
      'multi.max': 'Up to {n} tasks per batch',
      'multi.hint': 'Selection mode: click a card to select, then use the floating batch bar.',
      'batch.title': 'Batch actions',
      'batch.reason': 'Reason (required for cancel / re-plan)',
      'batch.cancel': 'Cancel',
      'batch.cancelTask': 'Cancel tasks',
      'batch.rescope': 'Re-plan',
      'batch.assign': 'Assign',
      'batch.priority': 'Priority',
      'batch.cascade': 'Also cancel downstream',
      'batch.impactCascade': 'Impact: {tasks} task(s); {dependents} downstream will be cancelled too',
      'batch.needReason': 'Enter a reason',
      'batch.needMembers': 'Pick at least one assignee',
      'batch.run': 'Apply',
      'batch.confirmHint': 'Two-step confirmation: this cannot be undone.',
      'batch.impact': 'Impact: {tasks} task(s); {dependents} downstream (left untouched)',
      'batch.impactDeps': 'Downstream tasks: {deps}',
      'batch.confirm': 'Confirm',
      'batch.done': 'Batch finished: {ok} ok / {failed} failed',
      'batch.offlineSkipped': 'Some selected tasks belong to offline teams and were skipped (read-only).',
      'batch.assignTeamEmpty': 'The selected assignees do not belong to that task\'s team',
      'rescope.title': 'Re-plan',
      'rescope.hint': 'Re-planning revokes the current attempt, returns the task to ready/backlog and applies the patch below.',
      'rescope.reason': 'Reason (required, written to the ledger)',
      'rescope.patch': 'Structural patch (optional)',
      'rescope.patchHint': 'Only fill the fields you want to change; empty means unchanged.',
      'rescope.reassign': 'Reassign members (optional)',
      'rescope.reassignHint': 'Selected members become the new assignees (none = leave as is).',
      'rescope.submit': 'Submit re-plan',
      'cancel.title': 'Cancel task',
      'cancel.reason': 'Cancel reason (required, written to the ledger)',
      'cancel.strategy': 'Downstream policy',
      'cancel.leave': 'Cancel this task only',
      'cancel.cascade': 'Cancel downstream tasks too',
      'cancel.rewire': 'Re-wire to a new upstream',
      'cancel.rewireTo': 'New upstream',
      'cancel.rewireNone': '(none: drop the dependency, it becomes independent)',
      'cancel.rewireDone': '(done)',
      'cancel.rewireHint': 'Replaces the downstream dependency on this task with a new upstream; pick none to drop it so downstream tasks stand alone. Completed tasks are allowed (downstream becomes claimable right away).',
      'cancel.rewireEmpty': 'This team has no candidate upstream (only dropping the dependency is possible).',
      'cancel.step1': 'Next: preview impact',
      'cancel.confirm': 'Confirm cancel',
      'cancel.impact': 'Impact: {dependents} downstream task(s) stay as they are',
      'cancel.impactCascade': 'Impact: {dependents} downstream task(s) will be cancelled too',
      'cancel.impactRewire': 'Impact: {dependents} downstream task(s) will be re-wired to a new upstream',
      'cancel.hasAttempt': 'A running attempt will be revoked.',
      'cancel.noAttempt': 'No running attempt.',
      'cancel.dependents': 'Downstream tasks',
      'cancel.done': '{n} task(s) cancelled',
      'cancel.rewired': '{n} task(s) re-wired',
      'cancel.failed': 'Cancel failed: {msg}',
      'cancel.needReason': 'Enter a cancel reason',
      'task.rescopeAndSave': 'Save and re-plan',
      'task.structuralReason': 'Structural edits need a reason (recorded as task.rescoped)',
      'role.catalog': 'Catalog',
      'role.catalogHint': 'Click to include; the catalog is not an allowlist — type names outside it freely.',
      'role.catalogEmpty': 'Catalog is empty',
      'role.catalogFallback': 'Catalog unavailable: fell back to names already used by existing roles.',
      'role.catalogAdd': 'Add',
      'role.catalogFree': 'Names outside the catalog: type and press Enter',
      'role.skillsEmpty': 'No skills selected',
      'role.mcpEmpty': 'No MCP selected',
      'role.delete': 'Delete role',
      'role.deleteConfirmBtn': 'Delete',
      'role.deleteUsage': 'Appointed by {teams} team(s) · {instances} instance(s) · {presets} preset(s)',
      'role.deleteConfirm': 'Two-step confirmation: review usage first, then delete the project role file (audited).',
      'role.deleteOccupied': 'This role is still used by a preset or an appointed team member; it cannot be deleted (release the appointment/preset reference first).',
      'role.deleted': 'Deleted {id}',
      'role.deleteFailed': 'Delete failed: {msg}',
      'role.published': 'Published to the global role library: {id}',
      'role.publishBtn': 'Publish to global',
      'role.publishHint': 'Write this project-library role into the global role library (visible to every project in this workspace)',
      'role.publishConfirm': 'Publish to the global role library?',
      'role.publishImpact': 'Will write: {path}. The global library is visible to all projects - the flow is one-way, each project still has to "copy to project" explicitly.',
      'role.publishImpactNote': 'The global library is a copy source, not a publish source: builtin/global roles cannot be published again.',
      'role.publishConfirmBtn': 'Publish',
      'role.publishFailed': 'Publish failed: {msg}',
      'role.deletePresets': 'Used by presets: {presets}',
      /* CHG-76 P3 */
      'batch.leave': 'Cancel selected tasks only',
      'batch.rewire': 'Rewire to a new upstream',
      'batch.rewireTo': 'New upstream',
      'batch.rewireNone': '(none: detach dependencies, make them standalone)',
      'batch.rewireDone': '(done)',
      'batch.rewireHint': 'Move dependents of the selected tasks onto a new upstream; none = detach (dependents become standalone).',
      'batch.rewireByTask': 'Rewire detail (task → direct dependents)',
      'batch.rewireNoDeps': 'no direct dependents',
      'batch.rewireOneTeam': 'Rewire only supports tasks from one team: filter by team and cancel in batches of one team.',
      'batch.failedItems': 'Failures: {items}',
      'batch.impactRewire': 'Impact: {tasks} task(s); {dependents} downstream will be rewired (standalone if none selected)',
      'batch.rewiredDone': '{n} task(s) rewired',
      'tasks.newBatch': 'Batch create',
      'batchCreate.title': 'Batch create tasks',
      'batchCreate.hint': 'Draft one row per task; "deps row numbers" refers to rows in this batch (e.g. 1,2), empty = no deps.',
      'batchCreate.team': 'Owning team (online)',
      'batchCreate.goal': 'Goal (what this batch serves)',
      'batchCreate.rows': 'Drafts',
      'batchCreate.rowTitle': 'Title',
      'batchCreate.rowRole': 'Role',
      'batchCreate.rowPriority': 'Priority',
      'batchCreate.rowDeps': 'Deps row numbers (e.g. 1,2)',
      'batchCreate.addRow': 'Add row',
      'batchCreate.removeRow': 'Remove',
      'batchCreate.preview': 'Preview',
      'batchCreate.submit': 'Create',
      'batchCreate.impact': 'Will create {n} task(s)',
      'batchCreate.byRole': 'By role',
      'batchCreate.rolesMissing': 'Not in the roster: {roles} — those entries will fail to create (requiredRole not in roster)',
      'batchCreate.edges': 'Dependency edges',
      'batchCreate.warnings': 'Warnings',
      'batchCreate.done': 'Created {n} task(s) ({failed} failed)',
      'batchCreate.failedItems': 'Failed entries: {items}',
      'batchCreate.failed': 'Create failed: {msg}',
      'batchCreate.needTitle': 'Every draft needs a title',
      'batchCreate.needRole': 'Every draft needs a role',
      'batchCreate.needRows': 'Keep at least one draft row',
      'batchCreate.offline': 'Batch create requires an online team: open that team\'s team-mode session first.',
      'batchCreate.previewFirst': 'Preview writes nothing; tasks are appended one by one only after you confirm.',
      'diag.fix': 'Quick fix',
      'diag.fixAssign': 'Assign {member}',
      'diag.fixAssignDone': 'Assigned {member}',
      'diag.fixRoleSwap': 'Switch to a staffed role',
      'diag.fixRoleSwapOption': '{role} ({n} idle)',
      'diag.fixRoleSwapDone': 'Required role switched to {role}',
      'diag.fixSpawn': 'Summon a "{role}" member',
      'diag.fixSpawnHint': 'No member of this role is on the roster yet: summon one in the team-mode session first.',
      'diag.fixSpawnHintCanSwap': 'You can also use the action on the left to switch to a staffed role.',
      'diag.fixReinforce': 'Summon another "{role}" member',
      'diag.fixReinforceHint': 'Everyone in this role is busy: summon backup in the team-mode session.',
      'diag.fixReinforceHintCanSwap': 'Everyone in this role is busy: switch to a staffed role first, or summon backup.',
      'diag.fixFailed': 'Fix failed: {msg}',
      /* [G1 detail] task detail / two-step confirmations (design/detail.html · confirm.html · discard.html) */
      'detail.crumb': 'Breadcrumb',
      'detail.crumbBoard': 'Board',
      'detail.attemptN': 'attempt {n}',
      'detail.claimedBy': 'claimed by {role}',
      'detail.elapsed': 'running {time}',
      'detail.estimate': 'estimate {value}',
      'detail.toolCalls': '{n} model calls',
      'detail.humanAvatar': 'Me',
      'detail.acVerified': '{pass} / {total} verified',
      'detail.acEvidence': '· verified at {time} by evidence #{seq}',
      'detail.assertions': 'assertions',
      'detail.evidenceEmpty': 'No evidence yet: a finished task brings commands, exit codes and duration.',
      'detail.evidenceHead': 'attempt {attempt} · {n} item(s)',
      'detail.threadCount': '{n} message(s) · derived from the ledger',
      'detail.threadEmpty': 'No comments yet. Add a requirement below — it is recorded as human in the ledger.',
      'detail.depsTitle': 'Dependencies',
      'detail.depsUpstream': 'upstream',
      'detail.depsEmpty': 'No upstream dependency (dispatched as soon as ready)',
      'detail.depsHint': 'This task is claimed only after all upstream tasks complete.',
      'detail.gatesTitle': 'Gate chain',
      'detail.gatesCount': '{n} gate(s)',
      'detail.gatesEmpty': 'Empty gate chain (completion is terminal)',
      'gate.title': 'Gate decision',
      'gate.current': 'Current gate: {gate} (task state {state})',
      'gate.reviewerLabel': 'Reviewer (cross-review: cannot be the implementer)',
      'gate.reviewerPick': 'Choose a reviewer…',
      'gate.selfReview': 'The implementer cannot review their own work — pick another member',
      'gate.reasonPlaceholder': 'Rejection reason (required to reject — say what must change)',
      'gate.pass': 'Pass',
      'gate.fail': 'Reject',
      'gate.recheck': 'Re-check',
      'gate.archiveNote': 'The archive gate is not a human decision gate: the host validates the deliverable paths, and an "already archived" self-report is never trusted. All you can do here is re-check.',
      'gate.needReason': 'A rejection must state a reason.',
      'gate.needReviewer': 'Choose a reviewer first (not the implementer).',
      'gate.budgetConfirm': 'This gate has been rejected {n} time(s), reaching the re-verification budget. Release it as a human?',
      'gate.budgetBlocked': 'Re-verification budget reached; a human decision is required.',
      'gate.done': 'Decision recorded.',
      'gate.failed': 'Decision failed.',
      'gate.verifyTitle': 'Command gate (verify)',
      'gate.verifyNote': 'The verify gate ignores human verdicts: the host runs the command the task declares and judges by its real exit code. A "tests pass" self-report is never trusted.',
      'gate.verifyCmd': 'Command to run',
      'gate.verifyCwd': 'cwd: {cwd}',
      'gate.verifyRun': 'Run gate command',
      'gate.verifyRunning': 'Running…',
      'gate.verifyExit': 'exit {code}',
      'gate.verifyDuration': '{ms}ms',
      'gate.verifySignal': 'signal {signal}',
      'gate.verifyOutput': 'Output (last 2000 chars)',
      'gate.verifyNoOutput': '(no output)',
      'gate.verifyUnavailable': 'The host exposes no subprocess service, so the verify gate cannot run; use a human force-release (a reason is required).',
      'gate.verifyNoCommand': 'This task declares no verifyCommand, so the command gate cannot run. Add verifyCommand.argv to the task first.',
      'gate.verifyForce': 'Force release',
      'gate.verifyForced': 'Force-released by a human.',
      'scope.title': 'Write-scope audit',
      'scope.declared': 'Declared scope',
      'scope.files': 'Declared files',
      'scope.outOfScope': 'Out of scope',
      'scope.ok': '✓ No out-of-scope writes',
      'scope.bad': '{n} file(s) out of scope',
      'scope.empty': '—',
      'scope.warn': 'Out-of-scope writes: {n} file(s): {files}',
      'scope.warnNote': 'Warning only; the gate is not blocked (FR-5.4).',
      'scope.badge': '{n} out of scope',
      'scope.checkedAt': 'Audited {time}',
      'edit.conflict': 'The task was modified (current revision {revision}); reload and retry.',
      'evref.task': 'task',
      'evref.file': 'file',
      'evref.session': 'session',
      'evref.unknown': 'other',
      'evref.sessionHint': 'Cross-session reference (host @ session); the read is audited as session.read',
      'evref.empty': 'No evidence pointers',
      'rolecall.title': 'Single-role invocation',
      'rolecall.desc': 'Type /myteam+<roleId> to enable (stackable: /myteam+researcher+reviewer) and /myteam-<roleId> to unload. Parsed only when the message starts with /myteam.',
      'rolecall.placeholder': '/myteam+researcher',
      'rolecall.apply': 'Apply',
      'rolecall.applied': 'Enabled: {roles}',
      'rolecall.removed': 'Unloaded: {roles}',
      'rolecall.nothing': 'Nothing to apply (examples: /myteam+researcher or /myteam-researcher).',
      'rolecall.notCommand': 'Not a /myteam command: this is sent as ordinary text.',
      'rolecall.failed': 'Single-role invocation failed: {message}',
      'rolecall.filePath': 'Session defaults: {path}',
      'rolecall.readonly': 'Read-only view (offline team): a live team session is required.',
      'rolecall.unavailable': 'The host exposes no applyRoles endpoint.',
      'applyRoles.name': 'Single-role invocation',
      'applyRoles.roles': 'Enabled roles',
      'applyRoles.empty': 'This call enabled no roles',
      'applyRoles.skills': 'Skills',
      'applyRoles.mcp': 'MCP',
      'applyRoles.removed': 'Unloaded',
      'applyRoles.none': '—',
      'applyRoles.promptSection': 'Injected prompt section',
      'applyRoles.note': 'Note',
      'applyRoles.error': 'Call failed',
      'detail.teamMembers': 'Members',
      'detail.teamMembersEmpty': 'No member registered yet',
      'detail.participantsCount': 'lead {lead} · coop {coop}',
      'detail.messageMember': 'Message',
      'detail.enterTeam': 'Open team',
      'detail.enterTeamHint': 'Back to the board (filtered by team)',
      'detail.cost': 'Cost attribution',
      'detail.costEstimate': 'estimate',
      'detail.costTask': 'Task total',
      'detail.costHit': 'Cache hit rate',
      'detail.costMiss': 'Uncached / output',
      'detail.costShare': 'Share of team',
      'detail.costNote': 'Apportioned by tokenMeter usage, not a precise measurement.',
      'detail.costUnavailable': 'Cost data unavailable (offline team: tokens.json unreadable or no usage yet)',
      'detail.ops': 'Task actions',
      'detail.cancelTaskBtn': 'Cancel this task',
      'detail.cancelNote': 'Cancelling keeps produced evidence; the task turns blocked and goes back to the captain for re-planning.',
      'disband.title': 'Disband "{name}"?',
      'disband.irreversible': 'Irreversible',
      'disband.step': 'Step 2 of 2',
      'disband.desc': 'All sessions of this team are terminated and registered roles are released. These effects happen, and there is no undo.',
      'disband.impactTitle': 'Impact of disbanding',
      'disband.impactMembers': '{n} role(s) drained then released, including members currently running tasks',
      'disband.impactTasks': '{n} unfinished task(s) turn blocked and never resume automatically',
      'disband.impactDrained': 'Drain detail: {running} running, {pending} pending (filled in by the host after draining; shows — when unavailable)',
      'disband.impactArchive': 'Ledger and token records are archived to archive/ — read-only, cannot be started again',
      'disband.impactPrivate': 'Member private spaces (notes, scratch files) are deleted',
      'disband.inputLabel': 'Type the team ID to confirm',
      'disband.inputHint': 'If you only want the team to stop, use "Archive" — archiving keeps all data and can be reopened later.',
      'disband.archive': 'Use archive instead',
      'disband.archiveHint': 'Archiving keeps all data and can be reopened; the entry lives in team settings (this panel does not archive for you).',
      'disband.needId': 'Typed team ID does not match {teamId}',
      'disband.failed': 'Disband failed: {msg}',
      'discard.step': 'Step 2 of 2',
      'discard.title': 'Discard this plan?',
      'discard.desc': 'The draft is archived to archive/ and the team returns to having no plan. No role has been summoned yet, so no member session is involved.',
      'discard.impactTitle': 'What happens after discarding',
      'discard.impactTasks': '{n} task(s) are voided; the draft is archived to {path} (read-only)',
      'discard.impactState': 'Team state returns to draft; the plan is not rebuilt and no work is dispatched',
      'discard.impactNoToken': 'No member session exists yet, so no token is consumed',
      'discard.impactKeep': 'To keep the plan and approve later, use "Close" instead of discarding',
      'discard.summary': 'Plan summary',
      'discard.summaryText': '{tasks} task(s) · {members} role(s) · plan {planId}',
      'discard.reviseHint': 'If you only want a different plan, hit "Cancel", go back to the board and use Revise — tasks and acceptance criteria are kept.',
      'discard.archive': 'View draft archive',
      'discard.discardBtn': 'Discard this plan',
      'discard.failed': 'Discard failed: {msg}',
      /* CHG-82：设计稿对齐的 locale 落点（与 zh 同序） */
      /* [G1 detail] */ /* [G2 roster] */ /* [G3 knowledge] */
      /* [G2 roster] role library / roster / role detail / instance menu */
      'roles.page.title': 'Role library',
      'roles.page.desc': 'A role is a configuration unit: responsibility, system prompt, tool policy, skill references, model routing. One role can be summoned many times, each time producing an instance. Editing a role never affects running instances — they carry the snapshot taken at summon time.',
      'roles.createRole': 'Create role',
      'roles.createRoleHint': 'Create a role by chat; nothing is saved until you confirm the preview',
      'roles.chatCreate': 'Create by chat',
      'roles.introGlobal': 'Import global roles',
      'roles.filterHint': 'Sorted by scope, nearest first',
      'roles.searchPlaceholder': 'Search role name or responsibility',
      'roles.projectSectionNote': 'Copies of builtin roles — editable, deletable',
      'roles.globalSectionNote': 'Shared across projects, not used by this team',
      'roles.builtinSectionNote': 'Read-only, ships with the plugin',
      'roles.noMatch': 'No matching roles.',
      'roles.copyToProject': 'Copy into project',
      'roles.copyToProjectFresh': 'Copy to project',
      'roles.compare': 'Compare',
      'roles.hasCopy': 'Already a copy in the project',
      'roles.noCopy': 'Not in the project',
      'roles.zeroInstances': '0 instances in this project',
      'roles.instanceCount': '{n} instance(s)',
      'roles.guest': 'Run solo',
      'roles.guestCopied': 'Single-role command copied: {cmd}',
      'roles.guestCopyFailed': 'Copy failed — type it manually: {cmd}',
      'roles.inheritRoute': 'Inherit captain route',
      'roles.captainLock': 'Not summonable · this session',
      'roles.copiedFromBuiltin': 'Copied from builtin · {name}',
      'roles.skillCount': '{n} Skill',
      'roles.mcpCount': '{n} MCP',
      'roles.projectRoleOnline': 'Online',
      'roles.deleteGuard': 'Deletion is gated. While a preset references the role or an instance is running, deletion is refused and the blockers are listed — archive the instances first, or drop it from the preset roster. A project holds exactly one copy per name; duplicate copies are refused (no silent overwrite).',
      'roster.page.title': 'Members',
      'roster.page.desc': 'A member is the appointment record between a role and a team, not a separate entity: pick a role from the library (global / project) and it becomes a member of this team with the role snapshot taken at summon time. Summoning the same role again yields an instance named with a -2 suffix; each runs its own session.',
      'roster.summon': 'Summon role',
      'roster.noCaptain': 'There is no captain on the roster',
      'roster.noCaptainHint': 'The captain is the Team Mode session you are chatting in — not a member. The roster lists the roles the captain pulled in; each claims tasks by its interest words.',
      'roster.instanceCount': '{n} instance(s)',
      'roster.inheritRoute': 'Inherit captain route',
      'roster.delivery': 'Delivered {done}/{total}',
      'roster.noTask': 'No task in progress',
      'roster.running': 'Running',
      'roster.gate': 'Awaiting decision',
      'roster.idle': 'Idle',
      'roster.gateAction': 'Open gate',
      'roster.multiNote': '{n} instances run independent sessions and contexts · role edits never affect running instances',
      'roster.gateNote': 'Your call: reassign / skip / change expectation',
      'roster.idleNote': 'Drained, ready for new work',
      'roster.activeNote': 'Working on: {task}',
      'roster.sameRoleOtherTeam': 'Also running in "{team}"',
      'roster.limitNote': 'Team size limit {n} (captain excluded); {active} on the roster. The limit is adjustable in Settings but capped by the plugin hard limit. Removing an instance deletes its private space; archiving only drains.',
      'roster.summonCardHint': 'Pick a role from the library and it can claim tasks right away; summoning the same role twice auto-numbers it',
      'roster.menu.label': 'What to do with {name}',
      'roster.menu.steer': 'Steer it',
      'roster.menu.steerHint': 'Steer the instance from the team-mode session (the panel opens no extra write path).',
      'roster.menu.steerNotice': 'The panel opens no extra write path: go back to the team-mode session — send guidance with myteam_message (kind=steer), or interrupt the current turn with myteam_interrupt.',
      'roster.menu.suspend': 'Stop claiming new tasks',
      'roster.menu.archive': 'Archive (after draining)',
      'roster.menu.remove': 'Remove instance',
      'roster.menu.restore': 'Restore instance',
      'roster.menu.impact': '{running} running task(s), {gate} gate(s) awaiting review. Archive drains first and moves it into archive/; remove deletes its private space.',
      'roster.menu.readonly': 'Read-only view: start a Team Mode session to manage instances.',
      'role.section.definition': 'Definition & settings',
      'role.section.definitionNote': 'The role itself — editing here edits the role',
      'role.responsibility': 'Responsibility',
      'role.boundary': 'Boundary',
      'role.boundaryDefault': 'No extra tool boundary declared: tool policy can only narrow, never widen.',
      'role.boundaryAllow': 'Allow {tools}',
      'role.boundaryDeny': 'Deny {tools}',
      'role.interestHint': 'Soft signal for dispatch, not a permission',
      'role.promptTokens': '{n} tokens',
      'role.expandEdit': 'Expand & edit',
      'role.route': 'Model routing',
      'role.routePrimary': 'Primary {model}',
      'role.routeInherit': 'Inherit captain route',
      'role.skillsNote': 'Enabled {n} / global library {total} · referenced, not inlined',
      'role.skillAdd': 'Add from skill library',
      'role.skillAddHint': '{n} more available: contract diff, feature flag, migration notes, data definitions…',
      'role.browse': 'Browse',
      'role.mcpNote': 'Tool policy follows the role; instances never gain more',
      'role.mcpRef': 'Referenced',
      'role.builtinTools': 'Built-in tools',
      'role.toolDeny': 'no {tools}',
      'role.snapshotTitle': 'Snapshot rule',
      'role.snapshotBody': 'The snapshot is frozen at summon time: the member carries the role as it was then, so later edits never affect running instances — summon again to apply new settings.',
      'role.actions': 'Actions',
      'role.tryInCaptain': 'Try summoning in the captain session',
      'role.deleteReadonly': 'Delete (builtin is read-only)',
      'role.readonlyBadge': 'Read-only',
      'role.membershipCount': 'Appointed by {teams} team(s) · {instances} instance(s)',
      'role.skillEnabled': 'Edit skills in the role editor',
      'role.browseSkills': 'Browse skill library',
      /* [G4 ledger] */ /* [G5 graph] */ /* [G6 flow] */
      /* ── G4 ledger: audit replay / team settings / archive replay / all teams / project team list ── */
      'audit.view.task': 'By task',
      'audit.view.member': 'By role',
      'audit.view.time': 'By time',
      'audit.events': '{n} events total',
      'audit.derived': 'Read-only · derived from the ledger',
      'audit.export': 'Export JSONL',
      'audit.cap': 'Tasks',
      'audit.role': 'role',
      'audit.attempt': 'Attempt {n}',
      'audit.attemptEvents': '{n} events',
      'audit.attempts': '{n} attempt(s)',
      'audit.latest': 'latest',
      'audit.detail': 'Task detail',
      'audit.eyebrow': '{id} · {role} · {n} events',
      'audit.taskLabel': 'task',
      'audit.ledgerNote': 'This page is read-only: every number is derived from the ledger and writes nothing. The ledger is append-only, so archived teams can still be replayed here.',
      'audit.emptyTask': 'No ledger events for this task yet.',
      'settings.page.title': 'Team settings',
      'settings.page.desc': 'Changes land in .dsh-myteam/config/team.config.json. Plugin defaults < project config < team template, later wins; arrays are replaced whole, never deep-merged.',
      'settings.jsonView': 'JSON source view',
      'settings.sourceTitle': 'Config sources',
      'settings.sourceNote': 'later overrides earlier',
      'settings.layer.default': 'Plugin defaults',
      'settings.layer.project': 'Project config',
      'settings.layer.team': 'Team template',
      'settings.layer.effective': ' (active)',
      'settings.layer.defaultPath': 'plugin/config/team.config.default.json · ships with the plugin',
      'settings.layer.projectPath': '.dsh-myteam/config/team.config.json · only the keys you changed',
      'settings.layer.teamPath': '.dsh-myteam/tasks/<teamId>/team.config.json · written from the template',
      'settings.layer.items': '{n} keys',
      'settings.layer.covered': '{n} overrides',
      'settings.layer.idle': 'not applied',
      'settings.layer.readonly': 'read-only',
      'settings.layer.thisFile': 'this file',
      'settings.layer.teamScope': 'team lifecycle',
      'settings.mergeNote': 'Arrays are replaced whole, never deep-merged; CLI overrides only affect the current session',
      'settings.behavior': 'Behaviour',
      'settings.behaviorNote': 'read-only columns are plugin hard ceilings',
      'settings.teamSize': 'Team size',
      'settings.teamSizeSub': 'How many roles one team may appoint at once (the captain does not count)',
      'settings.delegateDepth': 'Delegation depth',
      'settings.delegateDepthSub': 'Whether an instance may pull another role into the team; 0 disables it',
      'settings.gatesSub': 'Type check and unit tests must pass before a task completes',
      'settings.gateTimeoutLabel': 'Gate command timeout',
      'settings.gateTimeoutSub': 'Longest run time for one gate command; a timeout counts as failure',
      'settings.seconds': 's',
      'settings.hideTools': 'Hide built-in team tools',
      'settings.hideToolsSub': 'Hide raw myteam_* tool calls in the conversation and only show results',
      'settings.evidenceLabel': 'Knowledge needs evidence',
      'settings.evidenceSub': 'Conclusions without an evidence pointer cannot enter the shared knowledge base',
      'settings.ceiling': 'ceiling {v}',
      'settings.stateDir': 'State directory',
      'settings.openDir': 'Open directory',
      'settings.gitignore': 'gitignore managed block in place',
      'settings.ledgerAppend': 'ledger.jsonl is append-only; it is never rewritten at runtime',
      'settings.lifecycle': 'Team lifecycle',
      'settings.archiveTitle': 'Archive this team',
      'settings.archiveSub': 'Appointed roles are drained and released; the ledger and token records are archived under archive/ and can be replayed any time',
      'settings.archiveBtn': 'Archive',
      'settings.handoffTitle': 'Hand off to a new session',
      'settings.handoffSub': 'Carry this team\'s context summary into a freshly created team-preset session; the current session stays untouched',
      'settings.handoffBtn': 'Hand off',
      'settings.handoffHint': 'Context only: no roster, no tasks are copied - the new captain decides the split',
      'settings.handoffConfirm': 'Hand off to a new session?',
      'settings.handoffConfirmBody': 'This creates a new team-preset session for "{team}" and injects the context summary as its first message. The current session is left as-is (no in-place transformation).',
      'settings.handoffConfirmBtn': 'Create session and inject',
      'settings.handoffDone': 'Handoff complete - new session',
      'settings.handoffPartial': 'Session created, but injecting the summary failed (you can paste it manually)',
      'settings.handoffFailed': 'Handoff failed: {msg}',
      'settings.disbandTitle': 'Disband this team',
      'settings.disbandSub': 'Irreversible. {members} appointed role(s) will be drained and released, {tasks} unfinished task(s) turn blocked',
      'settings.disbandBtn': 'Disband',
      'settings.confirmDisband': 'Confirm disband',
      'settings.cancelDisband': 'Cancel',
      'settings.footNote': 'Changing config never re-runs dispatched tasks.',
      'settings.footNoteSub': 'New values only affect later dispatch; gates already running keep the timeout they started with.',
      'settings.readonlyTip': 'Read-only: an offline team derives config from its folded ledger; start a team-mode session to edit.',
      'settings.failed': 'Action failed: {msg}',
      'costbar.total': 'Cumulative tokens',
      'costbar.hitRate': 'Cache hit rate',
      'costbar.today': 'Today uncached / output',
      'costbar.callsCount': '{n} calls',
      'costbar.context': 'Context usage',
      'costbar.na': 'not wired',
      'archive.status': 'Archived',
      'archive.archivedAt': 'Archived {time} · read-only',
      'archive.readonly': 'read-only',
      'archive.replayChip': 'Read-only replay',
      'archive.openAudit': 'Open in audit view',
      'archive.allTeams': 'All teams',
      'archive.section.end': 'Why it ended',
      'archive.section.progress': 'Progress',
      'archive.section.roster': 'Roster · {n}',
      'archive.section.cost': 'Spend · by day bucket',
      'archive.section.tasks': 'Task history · {n}',
      'archive.section.ledger': 'Ledger and artifacts',
      'archive.eventCount': '{n} events',
      'archive.snapshot': 'Archive snapshot · exportable',
      'archive.done': 'done',
      'archive.blocked': 'blocked',
      'archive.notStarted': 'not started',
      'archive.tokensTotal': 'cumulative tokens',
      'archive.calls': 'calls',
      'archive.endTitle': 'Team archived: instances released, tasks can no longer advance',
      'archive.endFallback': 'This team left no disband note behind; the ledger and artifacts keep the terminal state they had when archived.',
      'archive.endDisbander': 'Disbanded by · you',
      'archive.endDrained': '{n} role(s) drained and released',
      'archive.endBlocked': '{n} unfinished task(s) turned blocked',
      'archive.endPath': 'Archived to {path}',
      'archive.rosterEmpty': 'The roster was empty when archived.',
      'archive.taskDone': '{n} task(s)',
      'archive.deliverables': '{n} deliverable(s)',
      'archive.tokenOf': '{v} tokens',
      'archive.drained': 'Drained when archived; the private space stays in the snapshot',
      'archive.costNote': 'Read from the tokens.json sidecar; rebuildable',
      'archive.costDay': 'Date',
      'archive.cost.uncached': 'Uncached',
      'archive.cost.hit': 'Cache read',
      'archive.cost.write': 'Cache write',
      'archive.cost.output': 'Output',
      'archive.cost.calls': 'Calls',
      'archive.cost.rate': 'Hit rate',
      'archive.cost.total': 'Total',
      'archive.tasksNote': 'Terminal states kept as they are; failures never hidden',
      'archive.evidence': '{n} evidence item(s)',
      'archive.neverClaimed': 'dependencies unmet — no instance ever claimed it',
      'archive.seeEvidence': 'See evidence',
      'archive.seeGate': 'See gates',
      'archive.ledgerTitle': 'Ledger and artifacts',
      'archive.ledgerPath': 'archive/{id}/',
      'archive.ledgerJsonl': 'append-only original — replay is event by event, not a snapshot',
      'archive.ledgerJsonlEvents': '{n} events',
      'archive.seeAll': 'Event by event',
      'archive.teamJson': 'Roster and terminal state · per-day spend sidecar (derived, rebuildable from tokenMeter)',
      'archive.membersDir': 'identity.json config snapshots + each memory.md and private notes',
      'archive.artifactsDir': 'Artifact index; the content still lives at its repository path',
      'archive.artifactsCount': '{n} item(s)',
      'archive.openDir': 'Open directory',
      'archive.note': 'Archiving is an endpoint, not a pause.',
      'archive.noteSub': 'Instance sessions are released, tasks can no longer advance and the ledger is read-only. To do similar work again, create a new team from the same preset — the old team is never rebuilt automatically and is never referenced by a new one.',
      'shell.filter': 'Filter teams (name / goal / project)…',
      'shell.hint': 'The panel only views and manages; "New team" opens the wizard, full role definitions live in a team-mode preset session',
      'shell.groupCount': '{n} teams',
      'shell.online': 'online',
      'shell.offline': 'offline',
      'shell.done': 'Done {done}/{total}',
      'shell.running': 'Running {n}',
      'shell.gatePending': 'Gates pending {n}',
      'shell.members': 'Roles {n}',
      'shell.draft': 'draft',
      'shell.empty': 'This project has no teams yet.',
      'shell.noMatch': 'No matching teams.',
      'shell.newTeam': 'New team',
      /* G5 · design/lanes.html · dag.html · dag-vertical.html · dragging.html */
      'view.dir.arrow.h': 'Horizontal →',
      'view.dir.arrow.v': 'Vertical ↓',
      'lanes.groupBy': 'Rows = roles',
      'lanes.byStage': 'By stage',
      'lanes.byPriority': 'By priority',
      'lanes.byStageHint': 'Lane grouping comes from settings pipeline.swimlaneBy (role / stage / priority)',
      'lanes.noMembers': 'No roles on the roster yet: summon members in the team-mode session first',
      'lanes.emptyRow': 'No tasks in progress',
      'lanes.unassignedNote': 'Not assigned to any role on the roster',
      'lanes.more': '{n} more',
      'lanes.moreHint': '{n} more tasks in this cell — scroll for all (or switch to the board)',
      'lanes.noteLead': 'Lanes are grouped by role',
      'lanes.noteBody': '; each cell holds the nodes of that instance at one stage. Switch to stage or priority grouping in settings (pipeline.swimlaneBy); the serpentine layout keeps the stage flow pointing right.',
      'dag.showModel': 'Show model',
      'dag.showModelHint': 'Running nodes print their actual model in the card foot',
      'dag.hotChain': 'Highlighted {ids} chain',
      'dag.hotChainHint': 'The upstream/downstream chain of running tasks is drawn in bold primary color',
      'dag.hotChainEmpty': 'No running dependency chain',
      'dag.arrowNote': 'an edge means "downstream waits for upstream; finishing upstream unlocks downstream". One task can unlock several downstream tasks (t5 → t4 / t8 / t9). The running chain is highlighted.',
      'dag.arrowNoteV': 'layers run top to bottom by dependency depth and arrows point downstream; one task can unlock several downstream tasks, and the running chain is highlighted.',
      'dag.edge': 'Dependency edge',
      'dag.graphLabel': 'Task dependency graph',
      'dag.targets': 'Unlocks {n} downstream',
      'dag.teams': '{n} teams',
      'dag.evidence': '{n} evidence',
      'dag.noteLead': 'Arrows point from upstream to downstream: ',
      'dag.noteLeadV': 'Vertical reading: ',
      'drag.liftTag': 'Drop to place',
      'drag.ghost': '{code} is being dragged',
      'drag.dropzone': 'Drop to move · then Review → Command verification → Archive',
      'drag.rejectedTitle': '{code} → {col} rejected',
      'drag.rejectedBody': 'Its command gate has not passed yet ({n} timeout(s)). A card whose gate has not passed cannot enter Done — let it finish the gate chain first, or re-run that gate from the task menu.',
      'drag.rejectedLink': 'See where {code} is stuck →',
      'drag.accepted': '{code} → {col}: legal drop; the stage gate takes over (state still advances via member claim)',
      'drag.locked': 'Locked',
      'drag.lockedTitle': 'Invalid attempt: this card is locked (gate not passed or cancelled)',
      'drag.rulesBadge': 'Flow rules',
      'drag.rulesTitle': 'Dragging still obeys the state machine',
      /* CHG-82 G6: team wizard / project tasks / team participation / conversation / guest call */
      'g6.wizard.title1': 'How should this team divide the work?',
      'g6.wizard.title2': 'Who is doing it?',
      'g6.wizard.title3': 'What is this team here to achieve?',
      'g6.step.preset': 'Pick a preset',
      'g6.step.roster': 'Build the roster',
      'g6.step.goal': 'Write the goal',
      'g6.wizard.desc1': 'Pick a preset and you get a ready-made roster, board columns and gate chain; adjust each of them on the next step. If unsure pick the first one — it follows the standard trio, so requirement, development and acceptance each have an owner.',
      'g6.wizard.desc2': 'Pick roles from the library to build the roster; each pick joins as an appointed role and its instance name comes from the role (duplicates get -2). The captain is not picked — it is this very session. Member sessions are created only after you hit next.',
      'g6.wizard.desc3': 'Name the team and write one goal; the captain splits tasks from it. You can change the goal later, but tasks already split are not reshuffled automatically.',
      'g6.wizard.rosterMeta': 'Roster {n} · {roles} · {tail}',
      'g6.wizard.noPreset': 'No preset — pick roles from the library myself',
      'g6.wizard.noPresetSub': 'Roster 0 · board uses the plugin default five columns · gates use the default chain, all editable later',
      'g6.wizard.globalHint': 'From the global library; a copy is made into this project before use',
      'g6.wizard.presetNote': 'A preset is a starting point, not a constraint.',
      'g6.wizard.presetNoteBody': 'The roster stores role references; adding or removing people never changes the preset. Board columns and gate chains can be edited for this team alone without affecting other teams.',
      'g6.wizard.managePresets': 'Manage presets',
      'g6.wizard.nextRoster': 'Next: build roster',
      'g6.wizard.nextGoal': 'Next: write goal',
      'g6.wizard.prev': 'Back',
      'g6.wizard.cancel': 'Cancel',
      'g6.wizard.selected': '{n} selected',
      'g6.wizard.cap': 'Limit {n}',
      'g6.wizard.captainNote': 'The captain has joined automatically.',
      'g6.wizard.captainNoteBody': 'The captain is this team-preset session itself, not an appointed role; it splits tasks, dispatches work and adjudicates gates.',
      'g6.wizard.fromLibrary': 'Add a few more from the role library',
      'g6.wizard.pickHint': 'Selecting creates an instance',
      'g6.wizard.willCreate': 'Will create {name} · {model} · {desc}',
      'g6.wizard.inheritRoute': 'inherits the captain route',
      'g6.wizard.later': 'Member sessions are created only after you hit next',
      'g6.wizard.start': 'Create team',
      'g6.wizard.copy': 'Copy prompt',
      'g6.wizard.copied': '✓ Copied',
      'g6.wizard.remove': 'Remove {name}',
      'g6.wizard.name': 'Team name',
      'g6.wizard.goal': 'Goal in one line',
      'g6.wizard.promptTitle': 'Captain prompt preview',
      'g6.wizard.needName': 'Give the team a name first',
      'g6.wizard.needGoal': 'Write one goal this team must achieve',
      'g6.wizard.unavailable': 'This workspace cannot open a session directly: copy the prompt into a new team-preset session.',
      'g6.wizard.loadingPresets': 'Loading presets…',
      'g6.wizard.presetsFailed': 'Could not load presets.',
      'g6.wizard.presetsFailedBody': 'Pick "No preset — choose roles myself" below, or retry.',
      'g6.wizard.retry': 'Retry',
      'g6.tasks.headTitle': 'Tasks',
      'g6.tasks.headMeta': '{n} tasks · {m} teams involved',
      'g6.tasks.headGoal': 'Tasks live at project level: teams take them on through participation, one task can involve several teams (one lead, several co-ops) and one team can hold several tasks',
      'g6.tasks.summaryTasks': 'Tasks',
      'g6.tasks.summaryLinks': 'Participations (lead {lead} · co-op {coop})',
      'g6.tasks.summaryRunning': 'In progress',
      'g6.tasks.summaryGates': 'Gates pending',
      'g6.tasks.summaryDone': 'Done',
      'g6.tasks.stageNote': 'Stage wording follows each team state machine',
      'g6.tasks.pageTitle': 'Task list',
      'g6.tasks.pageDesc': 'Tasks live at project level and teams take them on through participation: one task may involve several teams (one lead, several co-ops) and one team may join several tasks. Member assignment stays inside the team.',
      'g6.tasks.boardView': 'Board view',
      'g6.tasks.filterAll': 'All {n}',
      'g6.tasks.groupMeta': '{id} · {state} · lead {lead} · co-op {coop}',
      'g6.tasks.boardLink': 'Board →',
      'g6.tasks.restInBoard': 'Backlog {backlog} · done {done}, the rest on the board',
      'g6.tasks.restAll': '{n} more tasks on the board',
      'g6.tasks.draftEmpty': 'Draft · no tasks and no participations yet',
      'g6.tasks.draftNote': 'A draft team has not taken on any task yet. Once the team is set up, the captain dispatches work in the project (lead) or accepts co-op invitations, and task-team relations show up here.',
      'g6.tasks.viewList': 'List',
      'g6.tasks.viewBoard': 'Board',
      'g6.tasks.viewFlow': 'Lanes',
      'g6.tasks.viewDag': 'Dependencies',
      'g6.tasks.searchPlaceholder': 'Search task id, title or team',
      'g6.tasks.filter': 'Filter',
      'g6.teamTasks.title': 'Participating tasks',
      'g6.teamTasks.desc': 'Tasks live at project level and teams take them on through participation: this page lists only the tasks this team joins and whether it leads or co-ops. The board, lanes and dependency graph live in Project · Tasks.',
      'g6.teamTasks.boardBtn': 'Project task board',
      'g6.teamTasks.filterAll': 'All {n}',
      'g6.teamTasks.filterLead': 'Lead {n}',
      'g6.teamTasks.filterCoop': 'Co-op {n}',
      'g6.teamTasks.filterHint': 'Assign this team members on the task detail',
      'g6.teamTasks.coopTeam': 'Co-op · {name}',
      'g6.teamTasks.leadTeam': 'Lead · {name}',
      'g6.teamTasks.rest': '{n} more: backlog {backlog} · done {done}',
      'g6.teamTasks.gotoBoard': 'Go to project board →',
      'g6.teamTasks.note': 'Tasks and teams are two things: a task exists on its own in the project (dispatch, deps, gates and evidence all belong to the task) and a team merely participates. When several teams join one task, each brings its own people and manages its own members, while gates are adjudicated by the task acceptance criteria.',
      'g6.dock.running': '{n} roles running',
      'g6.dock.gates': '{n} gates pending',
      'g6.conv.view': 'Team view',
      'g6.conv.chat': 'Chat',
      'g6.conv.planStat': '· {tasks} tasks · {roles} roles · {gates} gate rounds',
      'g6.conv.openPanel': 'Open in panel',
      'g6.conv.openDetail': 'See {id} detail',
      'g6.conv.ledger': 'Recorded in ledger · {time}',
      'g6.conv.moreTasks': '{n} more tasks',
      'g6.conv.tasksEmpty': 'No tasks on the board yet (the panel reads the real ledger and shows no demo data)',
      'g6.conv.approvedStat': '· plan approved, sessions for {n} roles created',
      'g6.conv.peerStat': '· {from} ⇠ {to}',
      'g6.conv.hint': 'This is a team-preset session; the captain keeps the plan and ledger up to date. To let one role work alone, type {cmd}.',
      'g6.conv.hintLink': 'See what a single-role call looks like →',
      'g6.conv.inputPlaceholder': 'Say something to the captain, or use /myteam+roleId to reach one role',
      'g6.guest.banner': 'Configuration of {n} roles is injected into this session',
      'g6.guest.bannerBody': ' — prompts, tool policy, skills and MCP load as declared by each role. This call belongs to no team, never reaches a team ledger and creates no member sessions.',
      'g6.guest.inspect': 'See what was injected',
      'g6.guest.applyStat': '· {n} roles · narrows only, never widens',
      'g6.guest.systemPrompt': 'System prompt',
      'g6.guest.toolPolicy': 'Tool policy',
      'g6.guest.skills': 'Skills',
      'g6.guest.mcp': 'MCP',
      'g6.guest.modelRoute': 'Model route',
      'g6.guest.onceInject': 'one-off injection',
      'g6.guest.narrowOnly': 'narrow only',
      'g6.guest.seeRole': 'See role definition',
      'g6.guest.seeSkills': 'See skills & MCP',
      'g6.guest.unload': 'Unload role',
      'g6.guest.candCap': '{n} roles matched · pick one',
      'g6.guest.candFoot': 'Typing a loaded role again refreshes it; write -reviewer to unload',
      'g6.guest.hint': 'This session is not a team, so /myteam new is unavailable here — teams are only created from the team preset. Single-role calls are always available and the two never interfere.',
      'g6.guest.section': 'Single-role call (/myteam+ demo)',
      'g6.guest.blurb': 'Went through it against the review checklist: three risks, two documents missing:',
      'g6.guest.risk1': 'Risk 1 · the rollout switch has no default.',
      'g6.guest.risk2': 'Risk 2 · the contract does not state amount precision.',
      'g6.guest.risk3': 'Risk 3 · deleting the old t3 folder has no pre-check.',
      'g6.guest.writeStat': '· docs/settlement-migration.md · narrowed to docs/',
    }

    /* ══ [G3 knowledge] design/knowledge.html · presets.html · skills.html ══
     * 三屏的 locale（zh 为键源，en 同序）。
     * 用 Object.assign 追加而不是改写 zh/en 字面量：六组的落点在同一行，
     * 逐组往字面量里插行会互相踩（并发写协议 §三-2「少而大」）。 */
    Object.assign(zh, {
      /* 知识库（团队内「知识」tab，design/knowledge.html） */
      'kb3.title': '团队知识库',
      'kb3.desc': '团队记忆分三层：AGENTS.md 是共识层，config/knowledge/ 是共享知识库，实例私有 memory.md 只属于本人。常驻的只有 40 行以内的索引，正文按需读取。',
      'kb3.index': '查看索引',
      'kb3.indexBudget': '常驻索引预算 40 行；正文按需读取',
      'kb3.newEntry': '新建条目',
      'kb3.newEntryHint': '知识条目由队长提案、你确认后入库；面板不直接写库（走 myteam_adopt_knowledge）',
      'kb3.layers': '三层记忆',
      'kb3.layersNote': '按作用域分层，团队之间不共享私有层',
      'kb3.consensus': '共识层',
      'kb3.consensusSrc': '仓库根 · 人写',
      'kb3.consensusPath': 'AGENTS.md · 所有实例每次任务都会读，改动需你确认',
      'kb3.consensusUnit': '文件',
      'kb3.shared': '项目共享库',
      'kb3.sharedSrc': '本团队 + 同项目其他团队',
      'kb3.sharedPath': '.dsh-myteam/config/knowledge/ · 入库共享，索引常驻 40 行，正文按需读',
      'kb3.sharedUnit': '条目',
      'kb3.private': '实例私有',
      'kb3.privateSrc': '只有本人能读',
      'kb3.privatePath': 'state/teams/<teamId>/members/<memberId>/memory.md · 队长与其他实例都读不到',
      'kb3.privateUnit': '份笔记',
      'kb3.filterAll': '全部 {n}',
      'kb3.filterShared': '共享库 {n}',
      'kb3.filterConsensus': '共识层 {n}',
      'kb3.filterPrivate': '实例私有 {n}',
      'kb3.pending': '待刷新 {n}',
      'kb3.proposalTitle': '{n} 条待你确认的提案',
      'kb3.proposalBody': '：任务验收通过后，队长建议把过程结论沉淀进共享库。确认后才会写入，不会被自动收录。',
      /* CHG-86 / UI-5：提案裁决（采纳 / 驳回）面板写路径 */
      'kb3.adopt': '采纳入库',
      'kb3.reject': '驳回',
      'kb3.note': '备注',
      'kb3.notePlaceholder': '裁定备注（可选，建议写清理由）',
      'kb3.adoptDone': '已采纳「{title}」并写入共享库',
      'kb3.rejectDone': '已驳回「{title}」',
      'kb3.adoptUnavailable': '宿主暂未提供 adoptKnowledge 端点（{message}）：请回到团队模式会话，用 myteam_adopt_knowledge 处理这条提案。',
      'kb3.readonlyHint': '只读视图（离线团队）：启动团队模式会话后才能采纳 / 驳回。',
      'kb3.by': '提案人 {name} · {time}',
      'kb3.review': '审阅提案',
      'kb3.proofChip': '{n} 条证据',
      'kb3.proofNone': '无证据',
      'kb3.stale': '可能过期',
      'kb3.refresh': '待刷新',
      'kb3.privateOnly': '仅本人可见',
      'kb3.more': '更多',
      'kb3.curation': '策展制，不做全自动记忆。',
      'kb3.curationNote': '知识只在 onboarding 采集或验收通过后由队长提案，你确认才落库；每条必须带证据，没有证据的结论不会进库。',
      'kb3.consensusEntry': 'AGENTS.md 团队共识',
      'kb3.consensusEntrySub': '仓库根目录的协作约定，所有实例每次任务都会读。改动需经你确认。',
      'kb3.privateEntrySub': '只在「{name}」自己的任务上下文里可见，其他实例与队长都读不到。',
      'kb3.empty': '没有匹配的知识条目。',
      'kb3.layerBadge.consensus': '共识层',
      'kb3.layerBadge.shared': '共享库',
      'kb3.layerBadge.private': '实例私有',
      /* CHG-84：无活跃会话 / 读取中——骨架照出，用一条说明讲清为什么还没有条目 */
      'kb3.needsSession': '当前团队没有活跃的团队会话：上面是知识库的三层骨架。在「团队模式」会话里提交计划后，条目、证据与提案会出现在这里。',
      'kb3.loadingHint': '正在读取团队知识库…',
      /* 预设库（全局作用域子页，design/presets.html） */
      'preset3.title': '预设库',
      'preset3.desc': '预设是团队模板：名册（队长 + N 个角色引用）加上看板列、流程维度、门禁链。新建团队时选一个，就得到一套现成的分工与流程。名册里存的是角色引用（聘任记录），不是副本 —— 改角色会立刻影响之后新建的团队，但不会影响已经聘任的实例。',
      'preset3.new': '新建预设',
      'preset3.layers': '三个来源',
      'preset3.layersNote': '和角色库同一套分层规则',
      'preset3.layer.builtin': '内置',
      'preset3.layer.builtinSrc': '只读',
      'preset3.layer.builtinPath': 'plugin/config/presets · seed-once 写进项目一份，之后不覆盖你的改动',
      'preset3.layer.global': '全局',
      'preset3.layer.globalSrc': '跨项目',
      'preset3.layer.globalPath': '../.dsh/myteam/presets · 换项目也带着，可复制进任意项目',
      'preset3.layer.project': '项目',
      'preset3.layer.projectSrc': '可编辑 · 运行时真相',
      'preset3.layer.projectPath': '.dsh-myteam/config/teams · 新建团队时能选的只有这一层',
      'preset3.unit': '预设',
      'preset3.globalOff': '全局只存角色，不存团队模板',
      'preset3.restore': '恢复默认',
      'preset3.seeAll': '看全部',
      'preset3.overwriteNote': '预设只存差异覆写。',
      'preset3.overwriteBody': '没写的字段沿用插件默认值 —— 所以升级插件后，你没改过的地方会跟着变好，改过的地方保持你的版本。数组是整条替换的：写了自己的看板列，就不会和默认列合并。',
      'preset3.search': '搜预设名或用途',
      'preset3.filterAll': '全部 {n}',
      'preset3.filterProject': '项目 {n}',
      'preset3.filterGlobal': '全局 {n}',
      'preset3.filterBuiltin': '内置 {n}',
      'preset3.sorted': '按作用域从近到远排列',
      'preset3.sectionProject': '项目 · {n}',
      'preset3.sectionProjectNote': '建团队时可选',
      'preset3.sectionGlobal': '全局 · {n}',
      'preset3.sectionGlobalNote': '跨项目复用，本项目还没用',
      'preset3.sectionBuiltin': '内置 · {n}',
      'preset3.sectionBuiltinNote': '随插件分发，不可改',
      'preset3.roster': '名册 · {n}',
      'preset3.captain': '队长',
      'preset3.flow': '流程',
      'preset3.gates': '门禁',
      'preset3.cols': '看板列',
      'preset3.byMember': '按角色分组',
      'preset3.byStage': '按阶段分组',
      'preset3.byPriority': '按优先级分组',
      'preset3.serpentine': '蛇形排布',
      'preset3.linear': '线性排布',
      'preset3.gateTimeout': '命令超时 {ms}s',
      'preset3.gatesOff': '命令门禁已关（写作没有可跑的测试）',
      'preset3.use': '用这个建团队',
      'preset3.edit': '编辑',
      'preset3.copy': '复制到项目',
      'preset3.viewRoles': '看用到的角色',
      'preset3.readonly': '只读',
      'preset3.readonlyHint': '预设写入口在队长会话的工具里（myteam_save_preset / myteam_copy_preset / myteam_delete_preset）；面板只做查看与建团',
      'preset3.builtinNote': '队长没给名册时的兜底模板',
      'preset3.builtinDesc': '队长提交计划时没显式给名册，就按这个模板成团 —— 需求侧守门、开发侧执行、验收侧独立复核。把这三个内置角色拉进团队时，会自动复制进项目库。',
      'preset3.guard': '删预设会被挡住：只要还有团队是照它建的，就拒绝删除并列出占用方 —— 和角色的守门规则一样。想换流程，先改预设再让新团队用它，已经跑起来的团队不会跟着变。',
      'preset3.usedBy': '已用于 {n} 个团队',
      'preset3.unused': '还没有团队用它',
      'preset3.empty': '该层暂无预设。',
      'preset3.newCardHint': '从现有预设 fork 一份再改，比从零配快得多',
      'preset3.back': '全局',
      'preset3.teambarSub': '全局 · 建团模板',
      'preset3.teambarGoal': '一组角色的编排加看板列、流程维度、门禁链；一条预设开一个团队',
      'preset3.tabRoles': '角色',
      'preset3.tabPresets': '预设',
      'preset3.tabSkills': '技能',
      'preset3.more': '预设操作',
      /* 技能 & MCP（全局作用域子页，design/skills.html） */
      'skill3.title': '技能与 MCP',
      'skill3.desc': '角色的能力由两样东西组成：技能按四层来源取，MCP 分两段看。实例化时按角色绑定注入，注入后只对那个实例可见，不会漏到别的实例身上。',
      'skill3.teambarSub': '全局 · 能力库',
      'skill3.teambarGoal': '系统级能力清单；角色详情里按需引用，不在角色里重复定义',
      'skill3.layers': '技能 · 四层来源',
      'skill3.layersNote': '实例拿到的是「内置 + 项目 + 该角色绑定」',
      'skill3.layer.builtin': '内置',
      'skill3.layer.builtinSrc': '只读',
      'skill3.layer.builtinPath': 'plugin/skills · 随行技能（按实际清单派生）',
      'skill3.layer.global': '全局',
      'skill3.layer.globalSrc': '跨项目',
      'skill3.layer.globalPath': '../.dsh/myteam/skills · 你自己的技能，换项目也带着',
      'skill3.layer.project': '项目',
      'skill3.layer.projectSrc': '可编辑 · 运行时真相',
      'skill3.layer.projectPath': '.dsh-myteam/config/skills · 这个项目里所有角色都能用',
      'skill3.layer.bound': '角色绑定',
      'skill3.layer.boundSrc': '按角色声明',
      'skill3.layer.boundPath': '角色配置里的 skill 引用列表 · 只对声明了它的角色实例生效',
      'skill3.unitSkill': '技能',
      'skill3.unitBound': '条绑定',
      'skill3.boundAction': '看绑定',
      'skill3.isolation': '隔离发生在实例身上。',
      'skill3.isolationBody': '实例化时，插件在它自己的 scope 里注册一份技能清单 —— 只有「内置 + 项目 + 该角色绑定」这三样，全局技能要显式绑进角色才生效。所以 A 实例装了技能，B 实例看不到。',
      'skill3.search': '搜技能名或用途',
      'skill3.filterAll': '全部 {n}',
      'skill3.filterBuiltin': '内置 {n}',
      'skill3.filterGlobal': '全局 {n}',
      'skill3.filterProject': '项目 {n}',
      'skill3.boundTimes': '被角色绑定 {n} 次',
      'skill3.bindCount': '被 {n} 个角色绑定',
      'skill3.bindNone': '本项目 0 个角色绑定',
      'skill3.bind': '绑进角色',
      'skill3.mcp': 'MCP · 两段式',
      'skill3.mcpNote': '可见范围 = 连接层 ∩ 角色 allowlist',
      'skill3.conn': '连接层',
      'skill3.connNote': '宿主 / 用户全局配置 · 插件只读，绝不代连',
      'skill3.vis': '可见层',
      'skill3.visNote': '角色声明 allowlist · 实例只能看到这里面的',
      'skill3.connected': '已连接',
      'skill3.disconnected': '未连接',
      'skill3.join': '∩',
      'skill3.footnote': 'allowlist 里写了但宿主没连的 server 只标灰，不拦着你建角色 —— 连上之后自动生效。反过来，宿主连了但角色没声明的，实例一律看不到。',
      'skill3.catalogOff': '能力目录不可用：连接层为空，可见层按角色声明展示。',
      'skill3.empty': '没有匹配的技能条目。',
      'skill3.more': '更多',
      'skill3.back': '全局',
      'skill3.tabRoles': '角色',
      'skill3.tabPresets': '预设',
      'skill3.tabSkills': '技能',
    })
    Object.assign(en, {
      /* Knowledge (team Knowledge tab) */
      'kb3.title': 'Team knowledge base',
      'kb3.desc': 'Team memory has three layers: AGENTS.md is the consensus layer, config/knowledge/ is the shared library, and each instance private memory.md belongs to that instance alone. Only a 40-line index is resident; bodies are read on demand.',
      'kb3.index': 'View index',
      'kb3.indexBudget': 'Resident index budget: 40 lines; bodies are read on demand',
      'kb3.newEntry': 'New entry',
      'kb3.newEntryHint': 'Entries are proposed by the captain and adopted by you; the panel never writes the library (use myteam_adopt_knowledge)',
      'kb3.layers': 'Three memory layers',
      'kb3.layersNote': 'Layered by scope; the private layer is never shared across teams',
      'kb3.consensus': 'Consensus',
      'kb3.consensusSrc': 'repo root · human-written',
      'kb3.consensusPath': 'AGENTS.md · read by every instance on every task; changes need your confirmation',
      'kb3.consensusUnit': 'file',
      'kb3.shared': 'Project library',
      'kb3.sharedSrc': 'this team + other teams in the project',
      'kb3.sharedPath': '.dsh-myteam/config/knowledge/ · shared on adoption, 40-line resident index, bodies on demand',
      'kb3.sharedUnit': 'entries',
      'kb3.private': 'Instance private',
      'kb3.privateSrc': 'only the owner can read',
      'kb3.privatePath': 'state/teams/<teamId>/members/<memberId>/memory.md · neither the captain nor other instances can read it',
      'kb3.privateUnit': 'notes',
      'kb3.filterAll': 'All {n}',
      'kb3.filterShared': 'Shared {n}',
      'kb3.filterConsensus': 'Consensus {n}',
      'kb3.filterPrivate': 'Private {n}',
      'kb3.pending': 'Pending {n}',
      'kb3.proposalTitle': '{n} proposal(s) awaiting your confirmation',
      'kb3.proposalBody': ': once the task is accepted the captain suggests distilling the conclusions into the shared library. Nothing is written until you confirm; it is never collected automatically.',
      'kb3.adopt': 'Adopt into library',
      'kb3.reject': 'Reject',
      'kb3.note': 'Note',
      'kb3.notePlaceholder': 'Decision note (optional; a reason is recommended)',
      'kb3.adoptDone': 'Adopted “{title}” into the shared library',
      'kb3.rejectDone': 'Rejected “{title}”',
      'kb3.adoptUnavailable': 'The host does not expose an adoptKnowledge endpoint yet ({message}): go back to the team-mode session and handle this proposal with myteam_adopt_knowledge.',
      'kb3.readonlyHint': 'Read-only view (offline team): start a team-mode session to adopt or reject.',
      'kb3.by': 'Proposed by {name} · {time}',
      'kb3.review': 'Review proposals',
      'kb3.proofChip': '{n} evidence',
      'kb3.proofNone': 'No evidence',
      'kb3.stale': 'May be stale',
      'kb3.refresh': 'Pending refresh',
      'kb3.privateOnly': 'Owner only',
      'kb3.more': 'More',
      'kb3.curation': 'Curated, never automatic.',
      'kb3.curationNote': 'Knowledge is proposed by the captain during onboarding or after acceptance and lands only when you confirm; every entry must carry evidence - conclusions without evidence never enter the library.',
      'kb3.consensusEntry': 'AGENTS.md team consensus',
      'kb3.consensusEntrySub': 'Collaboration rules at the repo root, read by every instance on every task. Changes need your confirmation.',
      'kb3.privateEntrySub': 'Visible only inside the {name} own task context; neither other instances nor the captain can read it.',
      'kb3.empty': 'No matching knowledge entries.',
      'kb3.layerBadge.consensus': 'Consensus',
      'kb3.layerBadge.shared': 'Shared',
      'kb3.layerBadge.private': 'Private',
      /* CHG-84: no active session / loading — the skeleton stays, one note explains why entries are missing */
      'kb3.needsSession': 'This team has no active team session yet: above is the three-layer skeleton of the knowledge base. Once a plan is submitted in a Team Mode session, entries, evidence and proposals show up here.',
      'kb3.loadingHint': 'Reading the team knowledge base…',
      /* Presets (global sub-page) */
      'preset3.title': 'Preset library',
      'preset3.desc': 'A preset is a team template: a roster (captain + N role references) plus board columns, flow dimension and gate chain. Pick one when creating a team and you get a ready-made split of work and process. The roster stores role references (appointment records), not copies - editing a role immediately affects teams created later, but never the instances already appointed.',
      'preset3.new': 'New preset',
      'preset3.layers': 'Three sources',
      'preset3.layersNote': 'Same layering rules as the role library',
      'preset3.layer.builtin': 'Built-in',
      'preset3.layer.builtinSrc': 'read-only',
      'preset3.layer.builtinPath': 'plugin/config/presets · seeded once into the project, your edits are never overwritten',
      'preset3.layer.global': 'Global',
      'preset3.layer.globalSrc': 'across projects',
      'preset3.layer.globalPath': '../.dsh/myteam/presets · travels with you, copyable into any project',
      'preset3.layer.project': 'Project',
      'preset3.layer.projectSrc': 'editable · runtime truth',
      'preset3.layer.projectPath': '.dsh-myteam/config/teams · the only layer selectable when creating a team',
      'preset3.unit': 'presets',
      'preset3.globalOff': 'the global layer holds roles only, no team templates',
      'preset3.restore': 'Restore default',
      'preset3.seeAll': 'See all',
      'preset3.overwriteNote': 'Presets store overrides only.',
      'preset3.overwriteBody': 'Unwritten fields keep the plugin defaults - so after an upgrade the parts you never touched get better, and the parts you did keep your version. Arrays are replaced whole: write your own board columns and they will not merge with the defaults.',
      'preset3.search': 'Search preset name or purpose',
      'preset3.filterAll': 'All {n}',
      'preset3.filterProject': 'Project {n}',
      'preset3.filterGlobal': 'Global {n}',
      'preset3.filterBuiltin': 'Built-in {n}',
      'preset3.sorted': 'Ordered by scope, nearest first',
      'preset3.sectionProject': 'Project · {n}',
      'preset3.sectionProjectNote': 'selectable when creating a team',
      'preset3.sectionGlobal': 'Global · {n}',
      'preset3.sectionGlobalNote': 'reused across projects, not used by this project yet',
      'preset3.sectionBuiltin': 'Built-in · {n}',
      'preset3.sectionBuiltinNote': 'ships with the plugin, not editable',
      'preset3.roster': 'Roster · {n}',
      'preset3.captain': 'captain',
      'preset3.flow': 'Flow',
      'preset3.gates': 'Gates',
      'preset3.cols': 'Columns',
      'preset3.byMember': 'grouped by role',
      'preset3.byStage': 'grouped by stage',
      'preset3.byPriority': 'grouped by priority',
      'preset3.serpentine': 'serpentine layout',
      'preset3.linear': 'linear layout',
      'preset3.gateTimeout': 'command timeout {ms}s',
      'preset3.gatesOff': 'command gate disabled (writing has no tests to run)',
      'preset3.use': 'Create a team with this',
      'preset3.edit': 'Edit',
      'preset3.copy': 'Copy into project',
      'preset3.viewRoles': 'See the roles used',
      'preset3.readonly': 'read-only',
      'preset3.readonlyHint': 'Preset writes live in the captain session tools (myteam_save_preset / myteam_copy_preset / myteam_delete_preset); the panel only views and creates teams',
      'preset3.builtinNote': 'fallback template when the captain submits no roster',
      'preset3.builtinDesc': 'When the captain submits a plan without an explicit roster, the team forms from this template - requirements side gates, development side executes, acceptance side reviews independently. Pulling these three built-in roles into a team copies them into the project library automatically.',
      'preset3.guard': 'Deleting a preset is blocked: as long as any team was created from it, deletion is refused and the occupying teams are listed - the same guard rule as roles. To change the flow, edit the preset and let new teams use it; teams already running will not follow.',
      'preset3.usedBy': 'Used by {n} team(s)',
      'preset3.unused': 'No team uses it yet',
      'preset3.empty': 'No presets in this layer.',
      'preset3.newCardHint': 'Fork an existing preset and edit it - much faster than starting from scratch',
      'preset3.back': 'Global',
      'preset3.teambarSub': 'Global · team templates',
      'preset3.teambarGoal': 'A role arrangement plus board columns, flow dimension and gate chain; one preset opens one team',
      'preset3.tabRoles': 'Roles',
      'preset3.tabPresets': 'Presets',
      'preset3.tabSkills': 'Skills',
      'preset3.more': 'Preset actions',
      /* Skills and MCP (global sub-page) */
      'skill3.title': 'Skills & MCP',
      'skill3.desc': 'A role capability has two parts: skills come from four layers, MCP is read in two panes. Both are injected per role binding at instantiation and only visible to that instance - never leaked to another one.',
      'skill3.teambarSub': 'Global · capability library',
      'skill3.teambarGoal': 'System-level capability list; referenced on demand from role detail, never redefined per role',
      'skill3.layers': 'Skills · four sources',
      'skill3.layersNote': 'An instance gets built-in + project + that role bindings',
      'skill3.layer.builtin': 'Built-in',
      'skill3.layer.builtinSrc': 'read-only',
      'skill3.layer.builtinPath': 'plugin/skills · bundled skills (derived from the actual list)',
      'skill3.layer.global': 'Global',
      'skill3.layer.globalSrc': 'across projects',
      'skill3.layer.globalPath': '../.dsh/myteam/skills · your own skills, they travel with you',
      'skill3.layer.project': 'Project',
      'skill3.layer.projectSrc': 'editable · runtime truth',
      'skill3.layer.projectPath': '.dsh-myteam/config/skills · usable by every role in this project',
      'skill3.layer.bound': 'Role bindings',
      'skill3.layer.boundSrc': 'declared per role',
      'skill3.layer.boundPath': 'the skill reference list in role config · effective only for instances of roles that declare it',
      'skill3.unitSkill': 'skills',
      'skill3.unitBound': 'bindings',
      'skill3.boundAction': 'See bindings',
      'skill3.isolation': 'Isolation happens on the instance.',
      'skill3.isolationBody': 'At instantiation the plugin registers a skill list in that instance own scope - only built-in + project + that role bindings; global skills take effect only when explicitly bound into a role. So skills installed in instance A are invisible to instance B.',
      'skill3.search': 'Search skill name or purpose',
      'skill3.filterAll': 'All {n}',
      'skill3.filterBuiltin': 'Built-in {n}',
      'skill3.filterGlobal': 'Global {n}',
      'skill3.filterProject': 'Project {n}',
      'skill3.boundTimes': 'bound by {n} role(s)',
      'skill3.bindCount': 'Bound by {n} role(s)',
      'skill3.bindNone': '0 roles in this project bind it',
      'skill3.bind': 'Bind into a role',
      'skill3.mcp': 'MCP · two panes',
      'skill3.mcpNote': 'Visible = connection layer ∩ role allowlist',
      'skill3.conn': 'Connection layer',
      'skill3.connNote': 'host / user global config · read-only, the plugin never connects on your behalf',
      'skill3.vis': 'Visibility layer',
      'skill3.visNote': 'role allowlists · instances only see what is listed here',
      'skill3.connected': 'Connected',
      'skill3.disconnected': 'Not connected',
      'skill3.join': '∩',
      'skill3.footnote': 'A server listed in an allowlist but not connected on the host is shown greyed out and never blocks role creation - it takes effect once connected. Conversely, a server connected on the host but not declared by any role is invisible to instances.',
      'skill3.catalogOff': 'Capability catalog unavailable: the connection layer is empty and the visibility layer shows role declarations only.',
      'skill3.empty': 'No matching skills.',
      'skill3.more': 'More',
      'skill3.back': 'Global',
      'skill3.tabRoles': 'Roles',
      'skill3.tabPresets': 'Presets',
      'skill3.tabSkills': 'Skills',
    })

    /* ── M2 RPC 通道：直连网关（官方 invokeRemote 信封 {ok,value}|{ok,error}）── */
    async function rpcCall(connection, endpoint, args, signal) {
      const r = await connection.rpc.call('/api', endpoint, { args }, signal)
      // 官方连接层成功返回 {ok:true,value}；失败 {ok:false,error:{code,message}} 或直接 throw
      if (r && typeof r === 'object' && 'ok' in r) {
        if (!r.ok) throw new Error(r.error?.message ?? `rpc ${endpoint} failed`)
        return r.value
      }
      return r
    }

    /** 绑定到某个队长会话（sessionId）的 myteam API 面；query 透传给门面第二参 */
    function makeApi(connection, sessionId) {
      const call = (method, query) => rpcCall(connection, `myteam/${method}`, { agentId: sessionId, query })
      return {
        listTeams: () => rpcCall(connection, 'myteam/listTeams', {}),
        /* CHG-102：项目级存储状态 / 初始化（根级端点，只收 query）。
         * CHG-104 教训：面板门面加了方法、客户端的 api 表没加 → `discoveryApi.getStoreState` 是
         * undefined → 调用即 TypeError → catch 里 setStoreState(null) → 面板永远停在「加载中」。
         * 现在由 t85 交叉校验「服务端 marker ⊆ 客户端 api 表」，漏一个就红。 */
        getStoreState: (query) => rpcCall(connection, 'myteam/getStoreState', { query }),
        initStore: (query) => rpcCall(connection, 'myteam/initStore', { query }),
        // T25：离线只读视图——网关门面方法无 agent 首参，args 只允许 { query }（assertExactArguments）
        getOfflineBoard: (query) => rpcCall(connection, 'myteam/getOfflineBoard', { query }),
        getOfflineTaskDetail: (query) => rpcCall(connection, 'myteam/getOfflineTaskDetail', { query }),
        getOfflineTokens: (query) => rpcCall(connection, 'myteam/getOfflineTokens', { query }),
        getOfflineAudit: (query) => rpcCall(connection, 'myteam/getOfflineAudit', { query }),
        getOfflinePresets: (query) => rpcCall(connection, 'myteam/getOfflinePresets', { query }),
        // CHG-69：项目级聚合（门面方法只收 query，不需要会话）
        getProject: (query) => rpcCall(connection, 'myteam/getProject', { query }),
        getRoleDetail: (query) => rpcCall(connection, 'myteam/getRoleDetail', { query }),
        // CHG-72：面板内闭环写入口（角色 = 配置资产；任务 = 账本，actor=human）
        saveRole: (query) => rpcCall(connection, 'myteam/saveRole', { query }),
        // CHG-73 P2：项目级配置资产（删除角色 / 能力目录）——无会话，只发 query
        deleteRole: (query) => rpcCall(connection, 'myteam/deleteRole', { query }),
        getCapabilityCatalog: (query) => rpcCall(connection, 'myteam/getCapabilityCatalog', { query }),
        /* CHG-91（插件团队贡献契约 v1）：插件贡献的只读视图 + 显式重载。
         * 根级端点（只发 query）——插件贡献是配置资产，离线团队也能看。 */
        getContributions: (query) => rpcCall(connection, 'myteam/getContributions', { query }),
        reloadContributions: (query) => rpcCall(connection, 'myteam/reloadContributions', { query }),
        // CHG-73 P2：账本写（重新规划 / 取消 / 批量编排）——绑定队长会话
        rescopeTask: (query) => call('rescopeTask', query),
        cancelTask: (query) => call('cancelTask', query),
        batchTaskOp: (query) => call('batchTaskOp', query),
        createTask: (query) => call('createTask', query),
        /* CHG-76 B：批量建任务（预览 / 确认同一端点；逐条 task.created 同一 batchId） */
        createTasks: (query) => call('createTasks', query),
        updateTask: (query) => call('updateTask', query),
        assignTask: (query) => call('assignTask', query),
        participateTask: (query) => call('participateTask', query),
        /* CHG-86 新增端点（面板直连；与队长工具同一条管线，actor=human）：
         *  - reviewTask：门禁裁决（pass / fail；review·verify 门强制交叉审查，archive 门由 host 落位校验）；
         *  - getArchive / getArchives：归档快照读面（archive/<teamId>/team.json 等真实落盘文件）；
         *  - adoptKnowledge：知识提案采纳 / 驳回（UI-5 验收门的按钮写路径）。 */
        reviewTask: (query) => call('reviewTask', query),
        getArchive: (query) => call('getArchive', query),
        getArchives: (query) => call('getArchives', query),
        adoptKnowledge: (query) => call('adoptKnowledge', query),
        /* CHG-87（FR-16.1 / 契约 §5.1）：单角色调用写入口。
         * `applyRoles({ teamId?, roles: string[], remove?: string[], confirm? })`——
         * 面板 `/myteam+<roleId>` / `/myteam-<roleId>` 语法解析后落到这里。 */
        applyRoles: (query) => call('applyRoles', query),
        /* CHG-89（FR-13.1 / docs/04 §2）：角色库统一写入口。
         * `roleOp({ op, payload, confirm })`，op ∈ save / delete / publish / fork——
         * 面板的「发布到全局」按钮走这里（publish 两段确认）。 */
        roleOp: (query) => rpcCall(connection, 'myteam/roleOp', { query }),
        /* CHG-88/89（M2-E / FR-16.3）：会话移交（摘要 → 新团队预设会话；不写团队账本）。
         * 服务端链路 CHG-88 已通，这里补面板入口——此前 client 零命中，用户点不到。 */
        handoff: (query) => call('handoff', query),
        getBoard: (query) => call('getBoard', query),
        getTaskDetail: (query) => call('getTaskDetail', query),
        getTokens: (query) => call('getTokens', query),
        getInbox: (query) => call('getInbox', query),
        getRoles: (query) => call('getRoles', query),
        getKnowledge: (query) => call('getKnowledge', query),
        getAudit: (query) => call('getAudit', query),
        getConfig: (query) => call('getConfig', query),
        getPresets: (query) => call('getPresets', query),
        memberOp: (query) => call('memberOp', query),
        planAction: (query) => call('planAction', query),
        postComment: (query) => call('postComment', query),
        disband: (query) => call('disband', query),
      }
    }

    /* ── 状态徽标（H4：文字 + 形状，不依赖颜色）── */
    const STATE_LABEL = {
      backlog: '待规划', ready: '就绪', running: '进行中', gates: '门禁中', done: '完成',
      draft: '草稿', active: '运行中', archived: '已归档', discarded: '已废弃', disbanded: '已解散',
      in_progress: '进行中', 're-scoping': '重规划', 'gate:review': '审查中', 'gate:verify': '验证中', 'gate:archive': '归档中',
      failed: '失败', blocked: '受阻', cancelled: '已取消',
    }
    const SHAPE = { running: '◐', 're-scoping': '△', failed: '✕', blocked: '▣', done: '●', draft: '○', active: '●' }
    const stateLabel = (s) => STATE_LABEL[s] ?? s
    const stateShape = (s) => SHAPE[s] ?? '·'
    /** 成员状态（与团队状态区分：团队 active=运行中，成员 active=在岗） */
    const MEMBER_STATE_LABEL = { active: '在岗', suspended: '挂起', archived: '已归档', removed: '已移除', spawn_failed: '上岗失败' }
    const memberStateLabel = (s) => MEMBER_STATE_LABEL[s] ?? stateLabel(s)
    /** 泳道名（团队模板 pipeline.stages 是业务阶段名，不套任务状态表） */
    const STAGE_LABEL = { plan: '规划', dev: '开发', gates: '门禁', integrate: '集成' }
    const stageLabel = (s) => STAGE_LABEL[s] ?? s
    /** 门禁名（review/verify/archive 是固定门禁 id） */
    const GATE_LABEL = { review: '交叉审查', verify: '验证', archive: '归档' }
    const gateLabel = (g) => GATE_LABEL[g] ?? g
    /** 角色显示名（内置角色；自定义角色回落 id，id 仍作为副标识展示） */
    const ROLE_LABEL = {
      captain: '队长', implementer: '实现者', reviewer: '评审者',
      'req-validator': '需求验证员', developer: '开发者', acceptor: '验收员',
    }
    const roleLabel = (id) => ROLE_LABEL[id] ?? id
    /** 账本事件中文名（审计/时间线可读性；未知类型回落原始 id，前向兼容） */
    const EVENT_LABEL = {
      'rules.version.adopted': '规则版本',
      'team.created': '团队创建', 'team.disbanded': '团队解散',
      'plan.clarify': '计划澄清', 'plan.staged': '计划暂存', 'plan.revised': '计划修订',
      'plan.approved': '计划批准', 'plan.discarded': '计划丢弃',
      'member.spawned': '成员上岗', 'member.released': '成员释放', 'member.archived': '成员归档',
      'member.restored': '成员恢复', 'member.interrupted': '成员中断',
      'task.created': '任务创建', 'task.claimed': '任务领取', 'task.assigned': '任务指派',
      'task.progress': '任务进展', 'task.evidence': '提交证据', 'task.completed': '任务完成申报',
      'task.failed': '任务失败', 'task.escalated': '任务受阻申报', 'task.rescoped': '任务重规划', 'task.updated': '任务修改', 'team.updated': '团队修改',
      'task.attempt.revoked': '尝试撤销', 'task.proposal': '任务提案', 'task.proposal.resolved': '提案裁决',
      'task.deliverable': '交付物登记', 'task.gate.result': '门禁裁决',
      'message.sent': '消息发送', 'message.consumed': '消息已读',
      'knowledge.proposed': '知识提案', 'knowledge.adopted': '知识采纳', 'knowledge.revised': '知识演化',
      'memory.audit': '记忆审计',
    }
    const eventLabel = (type) => EVENT_LABEL[type] ?? type
    const ACTOR_LABEL = { lead: '队长', human: '人工', host: '宿主', system: '系统' }
    /** 事件 actor → 显示名（成员 id 走成员实例名；lead/human/host 走固定词表） */
    const actorLabel = (actor, memberName) => {
      const raw = String(actor ?? '')
      if (!raw) return '—'
      const member = memberName?.(raw)
      if (member && member !== raw) return member
      return ACTOR_LABEL[raw] ?? raw
    }
    /** CHG-73：结构字段 → 词条 key（改动记录与证据过期横幅共用；未知字段回落原始 key） */
    const FIELD_LABEL_KEY = {
      title: 'field.title', description: 'field.description', acceptanceCriteria: 'field.acceptanceCriteria',
      deps: 'field.deps', requiredRole: 'field.requiredRole', gateChain: 'field.gateChain',
      deliverableSpec: 'field.deliverableSpec', priority: 'field.priority', assignees: 'field.assignees',
      participants: 'field.participants', state: 'field.state',
    }
    const fieldLabel = (t, field) => {
      const key = FIELD_LABEL_KEY[field]
      return key ? t(key) : String(field ?? '')
    }
    /** 改动值 → 一行可读文本（数组用、连接；交付物取 path；角色取显示名） */
    const fieldValueText = (t, field, value) => {
      if (value === null || value === undefined || value === '') return '—'
      if (field === 'requiredRole') return roleLabel(String(value))
      if (Array.isArray(value)) {
        if (value.length === 0) return '—'
        return value.map((item) => (item && typeof item === 'object' ? fieldValueText(t, field, item) : String(item))).join('、')
      }
      if (typeof value === 'object') {
        if (typeof value.path === 'string') return value.path
        try { return JSON.stringify(value) } catch { return String(value) }
      }
      return String(value)
    }
    /** 字段列表 → 中文名（证据过期横幅：改了哪些字段） */
    const fieldListText = (t, fields) => {
      const list = fields ?? []
      return list.length > 0 ? list.map((field) => fieldLabel(t, field)).join('、') : '—'
    }
    /** 任务筛选（标题/id/成员/依赖 + 优先级 + 成员；视图层共用，不改投影） */
    const taskMatches = (task, f, memberName) => {
      if (!f) return true
      if (f.prio && f.prio !== 'all' && String(task.priority ?? '') !== f.prio) return false
      if (f.member && f.member !== 'all' && String(task.assignee ?? '') !== f.member) return false
      const needle = String(f.query ?? '').trim().toLowerCase()
      if (!needle) return true
      const hay = [
        task.id, task.title, task.assignee ? memberName?.(task.assignee) ?? task.assignee : '',
        ...(task.deps ?? []),
      ].join(' ').toLowerCase()
      return hay.includes(needle)
    }
    /** 看板/泳道/DAG/流转共用的筛选后 board（列结构保持，只过滤 tasks） */
    const filterBoard = (board, f, memberName) => {
      if (!board || !f || (!f.query && (!f.prio || f.prio === 'all') && (!f.member || f.member === 'all'))) return board
      const inner = board.board
      if (!inner) return board
      return {
        ...board,
        board: {
          ...inner,
          columns: (inner.columns ?? []).map((col) => ({ ...col, tasks: (col.tasks ?? []).filter((task) => taskMatches(task, f, memberName)) })),
        },
      }
    }
    /** 任务卡状态点（CHG-62：颜色只做辅助，文字仍在 meta 行，H4 不依赖颜色） */
    const stateDotClass = (s) =>
      s === 'done' ? 'mt-task-dot-done'
        : s === 'in_progress' || s === 'gate:review' || s === 'gate:verify' || s === 'gate:archive' ? 'mt-task-dot-active'
          : s === 'failed' || s === 'blocked' || s === 're-scoping' ? 'mt-task-dot-fail'
            : 'mt-task-dot'
    /** 毫秒 → 人话（预设卡门禁超时等；避免设置页/预设卡出现裸 120000 ms） */
    const humanMs = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (n < 1000) return `${n} ms`
      if (n % 60000 === 0 && n < 3600000) return `${n / 60000} 分钟`
      if (n % 1000 === 0 && n < 60000) return `${n / 1000} 秒`
      return `${(n / 1000).toFixed(1)} 秒`
    }
    /** 工作区路径 → 项目名（全局列表分组标签；空值显示 —） */
    const projectLabel = (root) => {
      if (!root) return '—'
      const parts = String(root).replace(/\\/g, '/').split('/').filter(Boolean)
      return parts[parts.length - 1] ?? String(root)
    }
    /** 时间戳 → 相对时间（索引的 updatedAt 为 epoch ms；0/缺失显示 —） */
    const relTime = (ts, t) => {
      if (!ts) return '—'
      const diff = Date.now() - ts
      if (!Number.isFinite(diff) || diff < 0) return t('time.justNow')
      if (diff < 60e3) return t('time.justNow')
      const minutes = Math.floor(diff / 60e3)
      if (minutes < 60) return t('time.minutesAgo').replace('{n}', String(minutes))
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo').replace('{n}', String(hours))
      return t('time.daysAgo').replace('{n}', String(Math.floor(hours / 24)))
    }

    /**
     * 影响面计数渲染（FR-14.1 / CHG-86 P0-2）。
     *
     * 已知缺陷：host 的 `member.released` 事件里 `drained: { running: 0, pending: 0 }` 是**硬编码**
     * （`plugin/src/host.ts:1808`，客户端无权改）。所以 UI 侧的口径是：
     *  - 有真实值（有限数）→ 如实渲染；
     *  - 缺失 / 不可用 → 显示占位 `—`，**不显示伪造的 0**（0 会被读成「没有影响」）。
     */
    const impactCountText = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : String(Number(value)))

    /**
     * 深色覆盖的作用域根（CHG-99 / C13）。
     *
     * 面板在各插槽里是**互不相邻的根节点**（main 面板 / 会话视图 / composer dock / 侧栏入口 /
     * 工具卡），没有共同祖先；宿主自己的容器不能挂属性（会污染面板之外）。
     * 所以 `data-theme` 写在每个 `.mt-*` 表面根上，深色规则统一以本选择器作前缀。
     */
    const DARK_SURFACE = ':is(.mt-panel,.mt-conv,.mt-dockrow,.mt-entry,.mt-toolcard)[data-theme="dark"]'

    /* ── 样式（单文件形态；只用 --dsw-alias-* token；由 ctx.effect 持有）── */
    const css = [
      '.mt-panel{position:relative;display:flex;flex-direction:column;height:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.mt-topbar{display:flex;align-items:center;gap:8px 12px;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap;min-height:44px;box-sizing:border-box}',
      '.mt-title{font-size:14px}',
      '.mt-goal{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
      '.mt-chip{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;max-width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-primary);margin-left:auto}',
      '.mt-btn{cursor:pointer;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:3px 10px;font-size:12px}',
      '.mt-btn:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mt-btn-primary{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-border-l3)}',
      '.mt-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.mt-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 16px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}',
      '.mt-banner-actions{display:flex;gap:8px}',
      /* CHG-82：领域 tab 对齐 design/app.css 的 .tabbar/.tab（40px 高、13px、选中 2px 下划线走 ::after） */
      '.mt-tabs{display:flex;gap:0;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}',
      '.mt-tab{position:relative;display:inline-flex;align-items:center;gap:5px;margin-right:20px;padding:0 1px;height:40px;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;cursor:pointer}',
      '.mt-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.mt-tab-active{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-tab-active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px;background:var(--dsw-alias-label-primary)}',
      '.mt-roles{flex:1;min-height:0;padding:12px 16px;overflow:auto}',
      '.mt-role{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-role-head{display:flex;align-items:center;gap:6px;min-width:0}',
      '.mt-role-id{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.mt-role-desc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px}',
      /* 知识 tab（FR-17.5，M2-0b） */
      '.mt-kb{flex:1;min-width:0;padding:10px 14px;overflow:auto}',
      '.mt-kb h3{margin:14px 0 8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}',
      '.mt-kb h3:first-child{margin-top:0}',
      '.mt-kb-search{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:7px 10px;font-size:13px;margin-bottom:4px}',
      '.mt-kb-proposal{border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-kb-phead{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}',
      '.mt-kb-rel{flex:none;font-size:11px;border-radius:4px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-kb-rel-refine{border-color:var(--dsw-alias-border-accent,var(--dsw-alias-border-l2))}',
      '.mt-kb-rel-contradict{border-color:var(--dsw-alias-border-warning,var(--dsw-alias-border-l2));font-weight:700}',
      '.mt-kb-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}',
      '.mt-kb-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}',
      '.mt-kb-entry{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-kb-ehead{display:flex;align-items:center;gap:6px;min-width:0;width:100%;background:none;border:none;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer;flex-wrap:wrap}',
      '.mt-kb-badge{flex:none;font-size:11px;border-radius:4px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-kb-core{border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3));font-weight:700}',
      '.mt-kb-unverified{font-style:italic}',
      '.mt-kb-stale{border-color:var(--dsw-alias-border-warning,var(--dsw-alias-border-l2));font-weight:700}',
      '.mt-kb-detail{margin-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}',
      '.mt-kb-body{white-space:pre-wrap;font-size:12px;color:var(--dsw-alias-label-primary);margin-bottom:8px}',
      '.mt-kb-ev{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
      '.mt-kb-evitem{font-size:11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 6px;color:var(--dsw-alias-label-secondary)}',
      '.mt-kb-timeline h4{margin:0 0 6px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}',
      '.mt-kb-tlitem{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0;border-bottom:.5px dashed var(--dsw-alias-border-l2)}',
      '.mt-body{display:flex;flex:1;min-height:0;align-items:stretch}',
      '.mt-roster{width:200px;flex:none;border-right:.5px solid var(--dsw-alias-border-l2);padding:10px;overflow-y:auto;background:var(--dsw-alias-bg-base)}',
      '.mt-roster h3,.mt-board h3{margin:0 0 8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}',
      '.mt-member{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-member-line{display:flex;align-items:center;gap:6px;min-width:0}',
      '.mt-member-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l3)}',
      '.mt-member-dot.mt-live{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 18%, transparent)}',
      '.mt-member-role{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.mt-member-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;align-items:baseline}',
      '.mt-member-meta .mt-link{font-size:11px}',
      '.mt-member-caps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}',
      '.mt-member-caps .mt-chip{margin-left:0}',
      /* CHG-85：列多时必须能横向滚到最后一列。宿主 centerCol 是 overflow-x:hidden，
         .mt-board 自身再 hidden 就会把 .mt-columns 的 overflow-x:auto 一起裁掉（滚不动、看不见）。
         做法：.mt-board 不裁（visible），由 .mt-columns 自己滚；列头行与列体共用同一滚动容器。 */
      '.mt-columns{flex:1;min-height:0;display:flex;gap:10px;align-items:stretch;overflow-x:auto;overflow-y:hidden;padding-bottom:2px;min-width:0}',
      /* design/app.css 的 .board{display:flex;gap:10px;overflow:auto} + .col{flex:1 1 200px;min-width:200px}：
         列要能一起放进面板宽度，而不是每列硬占 200px 把自己顶出容器（原来用 grid-auto-columns，
         6 列 ×200px 必然溢出，第 6 列被裁且滚不动）。
         CHG-85：min-width 降到 150px —— 6 列（含 gap）在 1109px 的面板里能各分到 ~176px 全部可见；
         再窄就交给 overflow-x:auto 横向滚。 */
      '.mt-col{flex:1 1 200px;min-width:150px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px;overflow:hidden}',
      /* design/app.css 的 .col.done-col{flex:0 0 168px;background:transparent;border-style:dashed}：
         末列（未完成/异常收口）固定窄宽 + 虚线，视觉上与主列区分。 */
      '.mt-col-done{flex:0 1 168px;min-width:132px;background:transparent;border-style:dashed}',
      '.mt-col-head{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);margin:0 2px 10px;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}',
      '.mt-col-head .mt-count{margin-left:auto}',
      /* CHG-81：列头形状点 + 列名 + 列内新建（design/board.html 的 .col-head） */
      '.mt-col-shape{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l3)}',
      '.mt-col-name{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary);white-space:nowrap}',
      '.mt-col-add{flex:none;width:22px;height:22px;display:grid;place-items:center;border:0;background:none;color:var(--dsw-alias-label-primary);border-radius:5px;cursor:pointer;font-size:13px;line-height:1;padding:0}',
      '.mt-col-add:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-col-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}',
      '.mt-col-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center;padding:18px 0;border:.5px dashed var(--dsw-alias-border-l2);border-radius:8px}',
      '.mt-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      /* CHG-81：看板卡按 design/board.html 的 .tcard 五段结构（号+优先级 / 标题 / 角色 / 团队 / 阻塞） */
      '.mt-task{box-sizing:border-box;display:flex;flex-direction:column;width:100%;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 10px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4}',
      '.mt-task:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}',
      '.mt-task-top{display:flex;align-items:center;gap:5px;margin-bottom:3px;flex-wrap:wrap}',
      '.mt-task-dot{flex:none;width:6px;height:6px;border-radius:50%;margin-top:5px;background:var(--dsw-alias-border-l3)}',
      '.mt-task-dot-active{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-task-dot-done{background:var(--dsw-alias-state-ok-primary)}',
      '.mt-task-dot-fail{background:var(--dsw-alias-state-error-primary)}',
      '.mt-task-id{flex:none;font-size:11px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.mt-task-title-text{font-size:12px;font-weight:500;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.mt-task-model{flex:none;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:3px;padding:0 4px;line-height:17px}',
      '.mt-pri{flex:none;font-size:11px;font-weight:600;line-height:16px;padding:0 5px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.mt-pri-P0,.mt-pri-P1{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mt-pri-P3{color:var(--dsw-alias-label-primary)}',
      '.mt-task-meta{display:flex;gap:4px;flex-wrap:wrap;align-items:center;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:5px}',
      /* CHG-85：卡片里的 chip 不能用页头那套 margin-left:auto（会把 chip 顶到卡外），
         也不能无限撑宽 —— 长团队名省略号收尾（design/app.css .tcard-teams 的 mini-chip 靠左排）。 */
      '.mt-task .mt-chip{margin-left:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-task-meta .mt-flow-warn{font-weight:600}',
      '.mt-task-dep{display:flex;align-items:center;gap:4px;min-width:0;font-size:11px;color:var(--dsw-alias-label-primary);margin-top:5px;padding-top:5px;border-top:.5px dashed var(--dsw-alias-border-l2);line-height:1.4}',
      '.mt-task-dep-blocked{color:var(--dsw-alias-state-warning-primary)}',
      '.mt-viewbar{display:flex;align-items:center;gap:6px;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}',
      '.mt-seg{border:none;background:none;color:var(--dsw-alias-label-primary);padding:3px 10px;font-size:12px;border-radius:6px;cursor:pointer}',
      '.mt-seg:hover{color:var(--dsw-alias-label-primary)}',
      '.mt-seg-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-workspace{display:flex;flex:1;min-height:0;min-width:0}',
      '.mt-view{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.mt-lane-head .mt-count{margin-left:auto}',
      '.mt-lane-body{display:flex;gap:8px;flex-wrap:wrap}',
      '.mt-lane-body .mt-task{width:210px}',
      '.mt-dag{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;gap:14px;align-items:flex-start}',
      '.mt-dag-layer{min-width:180px;flex:none;display:flex;flex-direction:column;gap:8px}',
      '.mt-dag-head{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-dag-node{box-sizing:border-box;display:block;width:100%;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary);font:inherit}',
      '.mt-dag-node:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mt-dag-title{display:flex;align-items:center;gap:6px}',
      '.mt-dag-name{margin-top:3px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mt-dag-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.mt-members-page{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-members-page h3{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:12px 0 8px}',
      '.mt-capcard{border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:4px}',
      '.mt-capcard p{margin:2px 0 0}',
      '.mt-member-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}',
      '.mt-inbox{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}',
      '.mt-inbox-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}',
      '.mt-inbox-card p{margin:0}',
      '.mt-inbox-row{align-self:stretch;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.mt-inbox-row:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mt-audit{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-audit-head .mt-chip{margin-left:auto}',
      '.mt-audit-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}',
      '.mt-audit-filter{border:.5px solid var(--dsw-alias-border-l2);background:none;border-radius:999px;padding:2px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.mt-audit-filter-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-audit-list{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-audit-row{display:flex;align-items:center;gap:10px;padding:5px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mt-audit-seq{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:44px}',
      '.mt-audit-type{min-width:180px}',
      '.mt-audit-actor{color:var(--dsw-alias-label-tertiary);min-width:90px}',
      '.mt-audit-ts{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
      '.mt-settings{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-settings-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
      '.mt-settings-head .mt-chip{margin-left:auto}',
      '.mt-chain{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin-bottom:8px}',
      '.mt-chain-cur{color:var(--dsw-alias-label-primary)}',
      '.mt-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}',
      '.mt-settings-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}',
      '.mt-settings-card h4{margin:8px 0 6px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:500}',
      '.mt-settings-card h4:first-child{margin-top:0}',
      '.mt-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.mt-chips .mt-chip{margin-left:0}',
      '.mt-rows{display:flex;flex-direction:column}',
      '.mt-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:3px 0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mt-row-v{color:var(--dsw-alias-label-primary);text-align:right;word-break:break-all}',
      '.mt-presets{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-preset-section{margin-bottom:14px}',
      '.mt-preset-section-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}',
      '.mt-preset-section-head h3{margin:0;font-size:13px}',
      '.mt-preset-section-head .mt-hint{margin-left:auto;font-size:10px;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}',
      '.mt-preset{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.mt-preset-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.mt-preset-head .mt-chip{margin-left:auto}',
      '.mt-preset-roster{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mt-preset-roster .mt-chip{margin-left:0}',
      '.mt-preset-members{display:flex;flex-direction:column;gap:6px}',
      '.mt-preset-member{display:flex;flex-direction:column;gap:3px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:5px}',
      '.mt-preset-member strong{font-size:12px}',
      '.mt-preset-caps{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mt-preset-caps .mt-chip{margin-left:0}',
      '.mt-chip-captain{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-preset-meta{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-costbar strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-costbar-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex:none}',
      '.mt-costbar .mt-link{flex:none}',
      '.mt-drawer{width:340px;flex:none;border-left:.5px solid var(--dsw-alias-border-l2);padding:12px;overflow-y:auto;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-drawer-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.mt-drawer-head strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.mt-drawer h4{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:12px 0 6px;font-weight:500}',
      '.mt-detail-meta{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}',
      '.mt-detail-pill{border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mt-detail-gates{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0 2px}',
      '.mt-gate{border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mt-gate-pass{color:var(--dsw-alias-state-ok-primary);border-color:var(--dsw-alias-state-ok-primary)}',
      '.mt-gate-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mt-deliverables{list-style:none;margin:0;padding:0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mt-deliverables li{padding:2px 0;word-break:break-all}',
      '.mt-cost{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-cost-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
      '.mt-cost-head h3{margin:0;font-size:13px}',
      '.mt-cost-scroll{overflow-x:auto}',
      '.mt-cost-table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}',
      '.mt-cost-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.mt-cost-table th:first-child,.mt-cost-table td:first-child{text-align:left}',
      '.mt-cost-table td{text-align:right;padding:5px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.mt-cost-sum td{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-cost-note{margin-top:8px}',
      '.mt-timeline li{display:flex;gap:8px;font-size:11px;padding:2px 0;color:var(--dsw-alias-label-secondary)}',
      '.mt-seq{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-actor{color:var(--dsw-alias-label-tertiary)}',
      '.mt-thread li{display:flex;gap:8px;font-size:11px;padding:2px 0}',
      '.mt-comment{display:flex;gap:6px;align-items:center}',
      '.mt-comment input{flex:1;min-width:0;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 8px;font-size:12px}',
      '.mt-ok{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}',
      '.mt-empty{padding:40px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.mt-switch{display:flex;gap:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;padding:2px;margin-left:4px}',
      '.mt-switch-btn{border:none;background:none;color:var(--dsw-alias-label-primary);padding:3px 10px;font-size:12px;border-radius:5px;cursor:pointer}',
      '.mt-switch-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.mt-switch-btn:disabled{opacity:.45;cursor:default}',
      '.mt-switch-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-global{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-global-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap}',
      '.mt-search{flex:1;min-width:0;max-width:340px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 8px;font-size:12px}',
      '.mt-team-list{display:flex;flex-direction:column;gap:8px}',
      '.mt-group{display:flex;flex-direction:column;gap:8px}',
      '.mt-group-head{display:flex;align-items:baseline;gap:8px;margin:10px 2px 2px}',
      '.mt-team-head .mt-chip{margin-left:auto}',
      '.mt-chip-online{color:var(--dsw-alias-state-ok-primary)}',
      '.mt-chip-offline{color:var(--dsw-alias-label-tertiary);border-style:dashed}',
      '.mt-offline-banner{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.mt-rel{margin-top:18px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}',
      '.mt-rel-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}',
      '.mt-rel-members{display:flex;gap:4px;flex-wrap:wrap}',
      '.mt-flow{flex:1;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-flow-item{box-sizing:border-box;display:block;width:100%;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font:inherit}',
      '.mt-flow-item:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mt-flow-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.mt-flow-head .mt-chip{margin-left:auto}',
      '.mt-flow-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-flow-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:4px}',
      '.mt-flow-warn{color:var(--dsw-alias-state-warning-primary)}',
      '.mt-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      /* CHG-79：工具条分组与筛选标签（两个「全部」下拉没有标签，用户分不清是优先级还是队员） */
      '.mt-topbar-sep{flex:none;width:1px;height:14px;background:var(--dsw-alias-border-l2);margin:0 2px}',
      '.mt-filterlabel{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:2px}',
      '.mt-empty-inline{padding:8px 10px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:8px}',
      '.mt-link{background:none;border:none;padding:0;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));cursor:pointer;font:inherit;font-size:11px;text-decoration:underline;text-underline-offset:2px}',
      '.mt-link:disabled{opacity:.5;cursor:default}',
      '.mt-link-danger{color:var(--dsw-alias-state-error-primary)}',
      '.mt-member-actions{display:flex;gap:10px;margin-top:4px;flex-wrap:wrap}',
      '.mt-error-banner{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.mt-chipbtn{cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:2px 10px;font-size:11px}',
      '.mt-chipbtn:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.mt-entry{display:inline-flex;align-items:center;justify-content:center}',
      '.mt-navicon{display:block}',
      /* CHG-63：看板筛选 / 状态机说明 / 收件箱动作 / 证据分组 / DAG 高亮 */
      '.mt-search-sm{flex:0 1 210px;min-width:130px;max-width:none;padding:3px 8px;font-size:11px}',
      '.mt-select{background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:3px 6px;font-size:11px}',
      '.mt-btn-sm{padding:2px 8px;font-size:11px}',
      '.mt-chipbtn-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '.mt-rules{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:6px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
      '.mt-rules strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-inbox-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.mt-evgroup-head .mt-hint{margin-left:auto}',
      '.mt-cmds li{display:flex;align-items:center;gap:8px;min-width:0}',
      /* CHG-69：全局/项目分层、角色卡、任务参与团队、DAG 画布 */
      '.mt-subtabs{display:flex;gap:2px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}',
      '.mt-page{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px}',
      '.mt-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:2px 0 0}',
      '.mt-section-head h3{margin:0;font-size:13px;font-weight:600}',
      '.mt-section-head .mt-hint{margin-left:auto}',
      '.mt-cardgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));align-items:start;gap:8px}',
      /* CHG-80：随行资产按 design/global.html 的 .card 结构重做（图标 + 标题 + 副标题 + 内容行 + 跳转脚） */
      '.mt-assets{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px}',
      '.mt-assetcard{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;color:var(--dsw-alias-label-primary);font:inherit}',
      '.mt-assetcard:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-assetcard-top{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.mt-assetcard-icon{flex:none;width:32px;height:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-assetcard-body{min-width:0}',
      '.mt-assetcard-title{font-size:13px;font-weight:600;line-height:1.35}',
      '.mt-assetcard-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);margin-top:2px;overflow-wrap:anywhere}',
      '.mt-assetcard-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.mt-assetcard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;border-top:.5px dashed var(--dsw-alias-border-l2);padding-top:8px;margin-top:2px}',
      /* CHG-85：跳转 chevron（design/icons.svg#i-chevron-right） */
      '.mt-assetcard-chev{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}',
      '.mt-section-head .mt-rule{flex:1;height:1px;background:var(--dsw-alias-border-l2);align-self:center;min-width:12px}',
      /* CHG-80：角色卡按 design/global.html 的 .card 结构（圆形头像 + 标题/副标题 + 兴趣词行 + 能力行 + 脚） */
      '.mt-rolecard{display:flex;flex-direction:column;gap:8px;text-align:left;width:100%;box-sizing:border-box;min-height:132px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;color:var(--dsw-alias-label-primary);font:inherit}',
      '.mt-rolecard:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-avatar{flex:none;width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-avatar-lead{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base)}',
      '.mt-rolecard-top{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.mt-rolecard-body{flex:1;min-width:0}',
      '.mt-rolecard-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.mt-rolecard-title strong{font-size:13px;font-weight:600}',
      '.mt-rolecard-id{color:var(--dsw-alias-label-primary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.mt-rolecard-sub{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.mt-rolecard-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
      '.mt-rolecard-rowlabel{font-size:12px;color:var(--dsw-alias-label-primary);flex:none}',
      '.mt-rolecard-chev{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1;margin-left:auto}',
      '.mt-rolechips{display:flex;gap:4px;flex-wrap:wrap}',
      '.mt-rolechip{border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-rolecard-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:auto;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:11px}',
      '.mt-rolecard-foot .mt-chip{margin-left:0}',
      /* CHG-80：全局页信息条（design/global.html 的 header.teambar） */
      '.mt-teambar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}',
      '.mt-teambar-title{display:inline-flex;align-items:baseline;gap:8px;flex:none}',
      '.mt-teambar-title b{font-size:13px;font-weight:600}',
      '.mt-teambar-id{font-size:11px;color:var(--dsw-alias-label-primary)}',
      '.mt-teambar-goal{flex:1;min-width:200px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.mt-teambar-actions{display:inline-flex;gap:8px;flex:none}',
      '.mt-projectrole{border:.5px solid var(--dsw-alias-border-l3);border-left:3px solid var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.mt-projectrole-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mt-teamrail{width:220px;flex:none;border-right:.5px solid var(--dsw-alias-border-l2);padding:10px;overflow-y:auto;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:4px}',
      '.mt-teamrail-head{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);margin:0 0 6px}',
      '.mt-teamrail-item{box-sizing:border-box;display:block;width:100%;text-align:left;cursor:pointer;background:none;border:.5px solid transparent;border-radius:6px;padding:7px 9px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.mt-teamrail-item:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.mt-teamrail-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 2px 0 0 var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-teamrail-meta{display:block;color:var(--dsw-alias-label-primary);font-size:11px;margin-top:2px;font-weight:400}',
      '.mt-tchip{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 7px;font-size:11px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:0}',
      '.mt-tchip-lead{border-style:solid;border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.mt-tchip-coop{border-style:dashed}',
      '.mt-tchip-team{font-weight:600}',
      '.mt-kv{display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0}',
      '.mt-kv b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-role-side{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:8px}',
      '.mt-membership{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:3px 0;border-bottom:.5px dashed var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.mt-membership .mt-hint{margin-left:auto}',
      '.mt-prompt{white-space:pre-wrap;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;max-height:220px;overflow:auto}',
      '.mt-evt{color:var(--dsw-alias-label-secondary)}',
      /* CHG-72：面板内表单与诊断（建队引导 / 角色 / 任务 / 无人可领） */
      '.mt-page-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mt-diag{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}',
      '.mt-diag-chip{display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:1px 7px;font-size:11px;color:var(--dsw-alias-state-warning-primary);border:.5px solid var(--dsw-alias-state-warning-primary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-form{display:flex;flex-direction:column;gap:8px;margin-top:4px}',
      '.mt-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.mt-field>label{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-field input,.mt-field textarea,.mt-field select{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 8px;font:inherit;font-size:12px}',
      '.mt-field textarea{min-height:64px;resize:vertical;line-height:1.45}',
      '.mt-field-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      /* CHG-103：角色作用域选择（项目级默认 / 全局需确认） */
      '.mt-rolescope-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.mt-rolescope-chip{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-line-divider);border-radius:8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-rolescope-chip small{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}',
      '.mt-rolescope-chip input{margin:0 6px 0 0;vertical-align:middle}',
      '.mt-rolescope-chip-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}',
      '.mt-checklist{display:flex;flex-wrap:wrap;gap:4px 10px;max-height:118px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px}',
      '.mt-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mt-form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap}',
      '.mt-form-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}',
      '.mt-drawer-wide{width:420px;max-width:100%}',
      '.mt-prompt-preview{white-space:pre-wrap;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-2);border:.5px dashed var(--dsw-alias-border-l2);border-radius:6px;padding:8px;max-height:160px;overflow:auto}',
      '.mt-notice{color:var(--dsw-alias-state-ok-primary);font-size:11px}',
      '.mt-chip-draft{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      /* CHG-73 P2：证据过期 / 已取消 chip、改动记录、批量条、模态对话框、能力目录多选、角色删除 */
      '.mt-chip-stale{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-chip-cancelled{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      /* CHG-75：被改挂过的小标记（中性色，与"已取消"的危险色区分） */
      '.mt-chip-rewired{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}',
      '.mt-chip-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mt-task-selected{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 20%, transparent)}',
      '.mt-task-check{flex:none;width:14px;height:14px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));margin-top:2px}',
      '.mt-task-check-on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-flow-item-selected{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 20%, transparent)}',
      '.mt-flow-check{flex:none;width:13px;height:13px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3);display:inline-flex;align-items:center;justify-content:center;font-size:9px;line-height:1;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-detail-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0 2px}',
      '.mt-banner-stale{background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-warning-primary)}',
      /* CHG-75：依赖改挂横幅（中性提示色——不是错误，是依赖关系变了） */
      '.mt-banner-rewired{background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l3)}',
      '.mt-banner-cancel{background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-error-primary)}',
      /* CHG-104：未初始化引导横幅（非阻塞——面板永远照常渲染） */
      '.mt-banner-info{background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-brand-primary);flex-wrap:wrap;justify-content:flex-start;font-size:12px;line-height:1.5}',
      '.mt-banner-text{flex:1 1 320px;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.mt-banner-path{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.mt-banner-stack{display:flex;flex-direction:column;gap:6px}',
      '.mt-foldhead{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;color:inherit;font:inherit;padding:0;cursor:pointer}',
      '.mt-foldhead .mt-count{margin-left:auto}',
      '.mt-editlist{margin-top:6px}',
      '.mt-edititem{border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.mt-edithead{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-edithead .mt-hint{margin-left:auto}',
      '.mt-editreason{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow-wrap:anywhere}',
      '.mt-change{font-size:11px;color:var(--dsw-alias-label-secondary);padding:1px 0;overflow-wrap:anywhere}',
      '.mt-change b{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mt-change-from{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-thickness:1px}',
      '.mt-change-arrow{color:var(--dsw-alias-label-tertiary);margin:0 4px}',
      '.mt-batchbar{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;flex:none;max-height:38vh;overflow-y:auto;max-width:100%;box-sizing:border-box;padding:6px 10px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l3);box-shadow:0 -4px 12px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.mt-batchbar strong{font-size:12px;flex:none}',
      '.mt-batchbar-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.mt-batchbar input{flex:1 1 168px;min-width:120px;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:3px 8px;font-size:12px}',
      '.mt-batchbar .mt-checklist{max-height:74px;min-width:160px;flex:1 1 200px}',
      '.mt-batchbar-impact{flex:1 1 100%;font-size:11px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mt-batchbar .mt-radio{flex:none;white-space:nowrap;font-size:11px}',
      '.mt-batch-spacer{height:56px;flex:none}',
      /* CHG-75：改挂新上游的下拉——在抽屉内不撑破宽度（选项文本过长时由 select 自身裁切） */
      '.mt-dialog .mt-select{width:100%;max-width:100%;box-sizing:border-box;text-overflow:ellipsis}',
      '.mt-overlay{position:absolute;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent)}',
      '.mt-dialog{width:min(520px,100%);max-height:100%;overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:12px 14px;box-shadow:0 10px 36px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)}',
      '.mt-dialog-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.mt-dialog-head strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-dialog-body{display:flex;flex-direction:column;gap:8px}',
      '.mt-dialog-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}',
      '.mt-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0}',
      '.mt-impactbox{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:3px}',
      '.mt-impactbox strong{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.mt-capbox{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px}',
      '.mt-cap-picked{display:flex;gap:4px;flex-wrap:wrap;min-height:18px}',
      '.mt-cap-opt{cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:1px 8px;font-size:11px}',
      '.mt-cap-opt:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.mt-cap-opt-on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-cap-src{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:3px}',
      '.mt-cap-row{display:flex;gap:6px;align-items:center}',
      '.mt-cap-row input{flex:1;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:3px 8px;font:inherit;font-size:12px}',
      '.mt-cap-label{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:baseline;gap:6px}',
      '.mt-cap-label .mt-hint{margin-left:auto}',
      '.mt-usagebox{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:3px}',
      '.mt-usagebox strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      /* CHG-76 P3：诊断一键修复 / 批量新建草稿行（全部 flex/grid + wrap，窄抽屉不横向溢出） */
      '.mt-diag-fix{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:2px 0 4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-diag-fix .mt-select{flex:0 1 190px;width:auto;max-width:100%;min-width:110px}',
      '.mt-diag-fix-label{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.mt-diag-fix .mt-btn{flex:none}',
      '.mt-drawrow{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.mt-drawrow-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-drawrow-head .mt-hint{margin-left:auto}',
      '.mt-drawgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:6px}',
      '.mt-impactlist{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.mt-impactlist .mt-chip{margin-left:0}',
      /* ══════════════════════════════════════════════════════════════════════════
       * CHG-82：设计稿对齐（design/*.html）—— 按分组预留的样式落点
       * 纪律：只用 --dsw-alias-* token；禁写十六进制颜色；禁写 font-family。
       * 每组只在自己那一行后面追加规则，不要动别人的落点。
       * ══════════════════════════════════════════════════════════════════════════ */
      /* [G1 detail] design/detail.html · confirm.html · discard.html */
      /* 任务详情 = 主区整页（design/detail.html）：盖住工作台，自己的面包屑 + 双栏 + 成本归因 */
      '.mt-detail-page{display:flex;flex-direction:column;flex:1 1 100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.mt-workspace:has(> .mt-detail-page){position:relative}',
      '.mt-workspace:has(> .mt-detail-page) > :not(.mt-detail-page){display:none}',
      '.mt-crumbbar{flex:none;display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-crumb-link{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 2px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.mt-crumb-link:hover{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-crumb-sep{color:var(--dsw-alias-label-tertiary)}',
      '.mt-crumb-gap{flex:1;min-width:0}',
      '.mt-crumbbar .mt-cur{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
      '.mt-detail-grid{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:minmax(0,1fr) 372px;gap:16px;padding:16px 16px 32px;align-items:start}',
      '.mt-detail-main,.mt-detail-side{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.mt-detail-eyebrow{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-detail-title{margin:0;font-size:20px;font-weight:600;letter-spacing:-.02em;line-height:1.4;text-wrap:balance;color:var(--dsw-alias-label-primary)}',
      '.mt-detail-desc{margin:10px 0 0;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);max-width:60ch;font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.mt-sec{display:flex;flex-direction:column;min-width:0;padding:12px 16px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.mt-ac-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.mt-ac{margin:4px 0;padding-left:18px;color:var(--dsw-alias-label-secondary);display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.6}',
      '.mt-ac-mark{flex:none;width:16px;height:16px;margin-top:2px;border-radius:50%;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.mt-ac-pass .mt-ac-mark{background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 45%, transparent);color:var(--dsw-alias-state-ok-primary)}',
      '.mt-ac-pending .mt-ac-mark{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-ac-note{margin-left:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-evidence{background:none;border:0;border-radius:6px;padding:0;font-size:10px;overflow-x:auto;white-space:normal;display:flex;flex-direction:column;gap:6px;overflow:visible}',
      '.mt-evgroup{border:0;border-radius:8px;padding:0;margin:6px 0 0;background:none}',
      '.mt-evgroup-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-evitem{margin:0 0 6px}',
      '.mt-cmds{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.mt-cmds > li{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}',
      '.mt-cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.mt-exit{flex:none;font-size:12px;border-radius:3px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-weight:600;line-height:17px}',
      '.mt-exit-ok{color:var(--dsw-alias-state-ok-primary);border-color:var(--dsw-alias-state-ok-primary);background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 16%, transparent)}',
      '.mt-exit-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)}',
      '.mt-ev-meta{flex:1 1 100%;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-ev-code{margin:0;padding:6px 8px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all}',
      '.mt-timeline{list-style:none;margin:0;padding:0 0 0 4px;position:relative}',
      '.mt-timeline::before{content:"";position:absolute;left:8px;top:6px;bottom:6px;width:1px;background:var(--dsw-alias-border-l2)}',
      '.mt-tl{position:relative;padding:0 0 12px 22px;font-size:12px}',
      '.mt-tl:last-child{padding-bottom:0}',
      '.mt-tl::before{content:"";position:absolute;left:4px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);border:1.5px solid var(--dsw-alias-border-l3)}',
      '.mt-tl-run::before{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 24%, transparent)}',
      '.mt-tl-ok::before{border-color:var(--dsw-alias-state-ok-primary);background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 24%, transparent)}',
      '.mt-tl-warn::before{border-color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 24%, transparent)}',
      '.mt-tl-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}',
      '.mt-tl-row .mt-seq,.mt-tl-time{font-variant-numeric:tabular-nums}',
      '.mt-tl-time{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
      '.mt-thread{list-style:none;margin:0 0 6px;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.mt-msg{display:flex;gap:7px}',
      '.mt-msg-av{flex:none;width:22px;height:22px;margin-top:1px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-msg-av-human{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-msg-body{flex:1;min-width:0}',
      '.mt-msg-meta{display:flex;align-items:baseline;gap:5px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-msg-meta b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.mt-msg-text{margin:1px 0 0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
      '.mt-composer-mini{display:flex;align-items:center;gap:6px;margin-top:8px;padding:3px 3px 3px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}',
      '.mt-composer-mini input{flex:1;min-width:0;height:30px;border:0;outline:none;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.mt-composer-mini input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.mt-send-btn{flex:none;width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:6px;background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base);cursor:pointer;font-size:12px}',
      '.mt-tc-card{box-sizing:border-box;display:block;width:100%;margin:0 0 8px;padding:10px 12px;text-align:left;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-tc-head{display:flex;align-items:center;gap:10px}',
      '.mt-mini-chip-gate{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 40%, transparent);color:var(--dsw-alias-state-warning-primary)}',
      /* 详情页内的 mini-chip 用设计稿度量（4px 圆角 / 12px）；提高一级特异性，免受其它分组同名类的覆盖 */
      '.mt-detail-page .mt-mini-chip{flex:none;padding:0 6px;border-radius:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-detail-page .mt-mini-chip-gate{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 40%, transparent);color:var(--dsw-alias-state-warning-primary)}',
      '.mt-dt-rows{display:flex;flex-direction:column;border:0}',
      '.mt-dt-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-dt-row:first-child{border-top:0}',
      '.mt-dt-row-main{flex:1;min-width:0}',
      '.mt-dt-row-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.mt-dt-row-sub{margin-top:1px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
      '.mt-dt-dep-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));font-variant-numeric:tabular-nums}',
      '.mt-dt-costrow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:2px 0}',
      '.mt-cost-label{font-size:12px;line-height:1.35;color:var(--dsw-alias-label-tertiary)}',
      '.mt-cost-val{font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.mt-cost-val small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      /* 两段确认（design/confirm.html · discard.html）：先说影响面 → 再输入 / 再点一次 */
      '.mt-impact{margin:0;padding:12px;border:.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.75}',
      '.mt-impact b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-impact ul{margin:4px 0 0;padding-left:16px}',
      '.mt-impact li{margin-bottom:2px}',
      '.mt-impact-gate{border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, transparent)}',
      '.mt-dialog-steps{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
      '.mt-dialog-steps .mt-hint{margin-left:0}',
      '.mt-dialog-note{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
      '.mt-form-row{display:flex;align-items:center;gap:12px}',
      /* CHG-86 / M2-C：门禁裁决区（详情抽屉内） */
      '.mt-gate-review .mt-form-row{flex-wrap:wrap;align-items:flex-start;gap:6px}',
      '.mt-gate-review .mt-form-row>label{flex:0 0 100%;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-gate-review select.mt-input{width:100%;box-sizing:border-box}',
      '.mt-gate-review textarea.mt-input{width:100%;box-sizing:border-box;resize:vertical;font:inherit;font-size:13px;margin-top:8px}',
      '.mt-gate-current{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-gate-review .mt-detail-actions{margin-top:8px}',
      /* CHG-87 §1.3：verify 门「要执行的命令」代码块 + 运行态 spinner + 输出尾巴 */
      '.mt-gate-cmd{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-gate-cmd code{font-variant-numeric:tabular-nums;padding:2px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.mt-gate-cmd .mt-hint{margin:0}',
      '.mt-gate-cwd{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.mt-gate-spin{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-gate-spin::before{content:"";width:10px;height:10px;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-radius:50%;animation:mt-gate-spin .9s linear infinite}',
      '@keyframes mt-gate-spin{to{transform:rotate(360deg)}}',
      '.mt-gate-result{margin-top:8px;display:flex;flex-direction:column;gap:6px}',
      '.mt-gate-result-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-gate-result pre.mt-ev-code{max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}',
      /* CHG-87 §2.3：写入范围审计（声明范围 / 申报文件 / 越界文件；警告不阻断） */
      '.mt-scope-audit{display:flex;flex-direction:column;gap:6px}',
      '.mt-scope-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;line-height:1.6}',
      '.mt-scope-k{flex:none;width:5.4em;color:var(--dsw-alias-label-tertiary)}',
      '.mt-scope-v{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px}',
      '.mt-scope-ok{color:var(--dsw-alias-state-ok-primary);font-weight:600}',
      '.mt-scope-bad{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.mt-scope-chip{font-size:11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 6px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.mt-scope-chip-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      /* 看板卡上的越界徽标（§2.3） */
      '.mt-scope-badge{font-size:11px;font-weight:600;border:.5px solid var(--dsw-alias-state-warning-primary);border-radius:999px;padding:0 6px;color:var(--dsw-alias-state-warning-primary)}',
      /* CHG-87 §4.3：证据指针按 kind 上色（task 蓝 / file 灰 / session 紫 / unknown 中性） */
      '.mt-ev-ref{font-size:11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 6px;color:var(--dsw-alias-label-secondary)}',
      '.mt-ev-ref-task{border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 45%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-ev-ref-file{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}',
      '.mt-ev-ref-session{border-color:color-mix(in srgb, var(--dsw-alias-border-accent, var(--dsw-alias-border-l3)) 70%, transparent);color:var(--dsw-alias-border-accent, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)));font-weight:600}',
      '.mt-ev-ref-unknown{color:var(--dsw-alias-label-secondary)}',
      /* CHG-87 §5.3：单角色调用（/myteam+ 语法）小卡 */
      '.mt-rolecall{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-rolecall-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mt-rolecall-row .mt-input{flex:1;min-width:180px}',
      '.mt-rolecall-hint{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.mt-rolecall code{font-size:11px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-rolecall-chips{display:flex;flex-wrap:wrap;gap:4px}',
      '.mt-form-row > label{flex:none;width:148px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-input{flex:1;min-width:0;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);outline:none;font-variant-numeric:tabular-nums}',
      '.mt-input:focus{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 18%, transparent)}',
      '.mt-dialog-foot{display:flex;align-items:center;gap:8px}',
      '.mt-dialog-foot .mt-right{margin-left:auto;display:flex;gap:8px}',
      /* ── CHG-84 复检：对着 design/detail.html 补齐的形态 ── */
      /* 参与团队卡里的 主责/协作 是 chip（design .chip.run / .chip.idle），不是 mini-chip */
      '.mt-detail-page .mt-tc-head .mt-chip{display:inline-flex;align-items:center;gap:5px;height:20px;margin:0;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap;flex:none;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.mt-detail-page .mt-tc-head .mt-chip .mt-task-dot{width:7px;height:7px;margin-top:0}',
      '.mt-detail-page .mt-tc-head .mt-chip-run{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 35%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-detail-page .mt-tc-head .mt-chip-idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
      /* 团队卡底部两颗按钮（design .btn.sm 并排等宽） */
      '.mt-tc-actions{display:flex;gap:6px;margin-top:8px}',
      '.mt-tc-actions .mt-btn{flex:1;justify-content:center}',
      /* 任务操作：design 是竖排左对齐的三颗按钮 */
      '.mt-detail-page .mt-detail-actions{flex-direction:column;align-items:stretch;gap:6px;margin:0}',
      '.mt-detail-page .mt-detail-actions .mt-btn{justify-content:flex-start;width:100%}',
      /* 门禁链的行：design .row 里右侧是 exit 徽标，名称与说明两行 */
      '.mt-detail-page .mt-dt-row .mt-gate{flex:none}',
      /* 两段确认的「第 2 步，共 2 步」chip：design 带形状（◆ gate / ✕ fail） */
      '.mt-mini-chip.mt-mini-chip-fail{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);color:var(--dsw-alias-state-error-primary)}',
      /* 丢弃对话框的「计划摘要」卡（design .rows 有边框的整块，不是行） */
      '.mt-dt-summary{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-dt-summary-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-dt-summary-sub{margin-top:2px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
      /* [G2 roster] design/roles.html · roster.html · role-detail.html · member-menu.html */
      /* CHG-82 G2：角色库（design/roles.html 的 .page-head / .dsec-head / .filterbar / .card / 创建卡） */
      '.mt-dsec-block{display:flex;flex-direction:column;gap:8px}',
      '.mt-searchfield{display:inline-flex;align-items:center;gap:6px;flex:0 1 240px;min-width:160px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);padding:3px 8px}',
      '.mt-searchfield-ico{flex:none;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary)}',
      '.mt-searchfield input{flex:1;min-width:0;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0}',
      '.mt-seg-group{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-segbtn{border:0;background:none;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-radius:6px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.mt-segbtn:hover{color:var(--dsw-alias-label-primary)}',
      '.mt-segbtn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-cardgrid-3{grid-template-columns:repeat(auto-fill,minmax(256px,1fr));gap:12px;align-items:stretch}',
      '.mt-rolecard-lib{min-height:150px}',
      /* design/roles.html：队长卡主色描边 + 浅主色底（.card 的 border-color:primary-line / background:primary-soft） */
      '.mt-rolecard-captain{border-color:var(--dsw-alias-border-accent,var(--dsw-alias-border-l3));background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 7%, transparent)}',
      '.mt-avatar-a1{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 30%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-avatar-a2{background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 32%, transparent);color:var(--dsw-alias-state-ok-primary)}',
      '.mt-avatar-a3{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 32%, transparent);color:var(--dsw-alias-state-warning-primary)}',
      '.mt-avatar-a4{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.mt-chip-origin{flex:none;color:var(--dsw-alias-label-tertiary)}',
      /* CHG-91（插件团队贡献契约 v1）：插件贡献区块 —— 与角色库同层级但不抢视觉
       * CHG-105：三层套嵌卡片 → 每插件一张卡 + 扁平行列表
       * CHG-106：**能力包**心智——包 = 一张卡；包里的能力用**内联胶囊**平铺，
       * 一行能放几个放几个，不再「一个角色占一整行、中间拉一条空档」。 */
      '.mt-contrib{margin-bottom:16px}',
      '.mt-contrib-body{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      '.mt-contrib-plugin{border:1px solid var(--dsw-alias-line-soft);border-radius:10px;overflow:hidden;background:var(--dsw-alias-surface-raised)}',
      '.mt-contrib-plugin-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-line-soft)}',
      '.mt-contrib-pack-glyph{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:6px;font-size:11px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary)}',
      '.mt-contrib-counts{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-contrib-caps{display:flex;flex-direction:column;gap:6px;padding:8px 12px}',
      '.mt-contrib-cap-row{display:flex;align-items:flex-start;gap:8px}',
      '.mt-contrib-cap-label{flex:none;width:32px;padding-top:3px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}',
      '.mt-contrib-chips{display:flex;flex-wrap:wrap;gap:6px;min-width:0}',
      '.mt-contrib-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 8px;border:1px solid var(--dsw-alias-line-soft);border-radius:999px;font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-contrib-chip:hover{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, var(--dsw-alias-line-soft))}',
      '.mt-contrib-chip-icon{flex:none;font-size:11px;opacity:.85}',
      '.mt-contrib-chip-name{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-contrib-chip-id{flex:none;font-size:10px;font-variant-numeric:tabular-nums;letter-spacing:.01em;color:var(--dsw-alias-label-tertiary)}',
      '.mt-contrib-foot{display:flex;align-items:center;gap:8px;padding:5px 12px;border-top:1px solid var(--dsw-alias-line-soft);background:var(--dsw-alias-bg-layer-2);font-size:11px}',
      '.mt-contrib-lock{flex:none}',
      '.mt-contrib-root{min-width:0;margin-left:auto;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-contrib-warns{margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12px}',
      '.mt-contrib-warn-err{color:var(--dsw-alias-state-error-primary)}',
      '.mt-contrib-warn-info{color:var(--dsw-alias-label-secondary)}',
      /* CHG-93：门禁结论的可信度徽标（宿主执行 / 人工强制放行）——用状态色区分分量 */
      '.mt-chip-executed{color:var(--dsw-alias-state-ok-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 32%, transparent)}',
      '.mt-chip-forced{color:var(--dsw-alias-state-warning-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 32%, transparent)}',
      '.mt-rolechip-mono{font-variant-numeric:tabular-nums;letter-spacing:.01em}',
      '.mt-rolecard-fork{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-rolecard-fork-ico{color:var(--dsw-alias-label-tertiary)}',
      '.mt-rolecard-instances{display:inline-flex;gap:4px;flex-wrap:wrap}',
      '.mt-rolecard-lock{font-size:11px;font-weight:500;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-rolecard-create{align-items:center;justify-content:center;gap:6px;border-style:dashed;min-height:150px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.mt-rolecard-create-ico{font-size:20px;line-height:1;color:var(--dsw-alias-label-tertiary)}',
      '.mt-rolecard-create-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mt-rolecard-create-hint{font-size:12px;line-height:1.5;text-align:center;color:var(--dsw-alias-label-tertiary);padding:0 12px}',
      '.mt-projectrole-card{gap:4px}',
      '.mt-team-zone{display:inline-flex;align-items:center;gap:4px;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-team-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-ok-primary)}',
      '.mt-team-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mt-team-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:4px;align-items:center;margin:0}',
      '.mt-note-alert{display:flex;gap:8px;align-items:flex-start;margin:0}',
      '.mt-note-ico{flex:none;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:.5px solid var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary);font-size:11px;line-height:1}',
      /* CHG-82 G2：名册 = 本团队的角色编排（design/roster.html + member-menu.html） */
      '.mt-roster-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(348px,1fr));gap:12px;align-items:stretch}',
      '.mt-roster-card{display:flex;flex-direction:column;gap:6px;min-width:0;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px}',
      '.mt-roster-card-gate{border-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-roster-top{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.mt-roster-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.mt-roster-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mt-roster-title strong{font-size:13px;font-weight:600}',
      '.mt-roster-sub{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mt-roster-words{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
      '.mt-roster-rowlabel{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mt-chip-plain{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.mt-chip-run{flex:none;color:var(--dsw-alias-state-ok-primary);border-color:var(--dsw-alias-state-ok-primary)}',
      '.mt-chip-idle{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.mt-shape{flex:none;display:inline-block;width:7px;height:7px}',
      '.mt-shape-run{border-radius:50%;background:var(--dsw-alias-state-ok-primary)}',
      '.mt-shape-gate{border-radius:1px;background:var(--dsw-alias-state-warning-primary);transform:rotate(45deg)}',
      '.mt-shape-idle{border-radius:50%;border:.5px solid var(--dsw-alias-label-tertiary)}',
      '.mt-inst-row{display:flex;align-items:center;gap:8px;min-width:0;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-minichip{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 6px;font:inherit;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);text-align:left}',
      'button.mt-minichip{cursor:pointer}',
      '.mt-minichip-gate{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}',
      '.mt-inst-right{flex:none;margin-left:auto;font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-inst-menu-btn{flex:none;width:24px;height:24px;display:grid;place-items:center;border:0;background:none;color:var(--dsw-alias-label-secondary);border-radius:5px;cursor:pointer;font-size:13px;line-height:1;padding:0}',
      '.mt-inst-menu-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-roster-row{display:flex;gap:4px;flex-wrap:wrap}',
      '.mt-roster-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-roster-foot-gate{color:var(--dsw-alias-state-warning-primary)}',
      '.mt-roster-card-summon{align-items:center;justify-content:center;gap:6px;border-style:dashed;min-height:170px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.mt-roster-summon-ico{font-size:20px;line-height:1;color:var(--dsw-alias-label-tertiary)}',
      '.mt-roster-summon-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mt-roster-summon-hint{padding:0 12px;font-size:12px;line-height:1.55;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.mt-roster-inactive{display:flex;flex-direction:column;gap:8px}',
      '.mt-roster-inactive h4{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.mt-menupop{display:flex;flex-direction:column;gap:1px;margin-top:6px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)}',
      '.mt-menu-label{padding:2px 8px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-menu-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;cursor:pointer}',
      '.mt-menu-item:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.mt-menu-item:disabled{opacity:.55;cursor:default}',
      '.mt-menu-item-danger{color:var(--dsw-alias-state-error-primary)}',
      '.mt-menu-ico{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.mt-kbd{margin-left:auto;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}',
      '.mt-menu-sep{height:1px;margin:3px 2px;background:var(--dsw-alias-border-l2)}',
      '.mt-menu-note{margin-top:3px;padding:4px 8px 2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l2)}',
      /* CHG-82 G2：角色详情（design/role-detail.html 的 .detail-grid + .sec + .abl-row + 侧列） */
      '.mt-roledetail{width:min(680px,100%)}',
      '.mt-roledetail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;align-items:start}',
      '.mt-roledetail-main,.mt-roledetail-side{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.mt-roledetail .mt-sec{display:flex;flex-direction:column;gap:8px;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}',
      '.mt-roledetail .mt-sec-info{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 8%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 24%, transparent)}',
      '.mt-kvline{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mt-kvline .mt-minichip{flex:none}',
      '.mt-prompt-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-prompt-block{margin:0;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}',
      '.mt-abl-list{display:flex;flex-direction:column}',
      '.mt-abl-row{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-abl-row:first-child{border-top:0}',
      '.mt-abl-ico{flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mt-abl-main{flex:1;min-width:0}',
      '.mt-abl-name{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-abl-name .mt-rolecard-id{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      '.mt-abl-sub{display:flex;gap:4px;flex-wrap:wrap;margin-top:1px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-tgl{flex:none;width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));position:relative}',
      '.mt-tgl::after{content:"";position:absolute;top:2px;right:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-base)}',
      '.mt-tgl-off{background:var(--dsw-alias-border-l3)}',
      '.mt-tgl-off::after{right:auto;left:2px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-roledetail .mt-membership{font-size:12px}',
      '.mt-roledetail .mt-membership .mt-tchip{margin-left:0}',
      '.mt-side-actions{display:flex;flex-direction:column;gap:6px}',
      '.mt-side-actions .mt-btn{width:100%;box-sizing:border-box}',
      /* [G3 knowledge] design/knowledge.html · presets.html · skills.html */
      /* ── CHG-84 复检补充（design/app.css 的 .grid-2 / .iname / 空态兜底卡）── */
      '.mt-presetgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(348px,1fr));gap:8px;align-items:start}',
      '.mt-kb3-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:-.01em;overflow-wrap:anywhere}',
      '.mt-p3-newcard-icon{font-size:18px;line-height:1;color:var(--dsw-alias-label-tertiary)}',
      /* ── 三层作用域清单（design/app.css .layers / .layer / .layer-ico / .layer-n；knowledge 三层记忆、
       *    presets 三个来源、skills 四层来源共用。来源小标 .mt-src 同源同形）── */
      '.mt-layers{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.mt-layer+.mt-layer{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-layer-ico-builtin{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-layer-ico-global{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 16%, transparent);color:var(--dsw-alias-state-warning-primary)}',
      '.mt-layer-ico-project{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 14%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-layer-ico-bound{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.mt-layer .mt-btn{flex:none}',
      /* ── 知识库：页头 + 筛选条 + 行列表（design/knowledge.html .page-head / .filterbar / .rows）── */
      '.mt-kb3{display:flex;flex-direction:column;gap:10px;flex:1;min-width:0;min-height:0;overflow:auto;padding:12px 16px}',
      '.mt-kb3-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
      '.mt-kb3-head h2{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}',
      '.mt-kb3-head p{margin:2px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:64ch}',
      '.mt-kb3-head-actions{margin-left:auto;display:flex;gap:6px;flex:none;flex-wrap:wrap}',
      '.mt-kb3-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mt-kb3-search{display:inline-flex;align-items:center;flex:0 1 280px;min-width:160px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);padding:0 10px;height:28px}',
      '.mt-kb3-search input{flex:1;min-width:0;border:none;background:none;outline:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.mt-kb3-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.mt-kb3-seg button{border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.mt-kb3-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-kb3-rows{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-kb3-row{box-sizing:border-box;display:flex;align-items:flex-start;gap:12px;padding:10px 12px;min-height:54px;margin:0;border:0;border-radius:0;background:none;text-align:left;width:100%}',
      '.mt-kb3-row+.mt-kb3-row{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-kb3-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-kb3-row-main{flex:1;min-width:0}',
      '.mt-kb3-row-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.mt-kb3-row-sub{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin-top:1px;overflow-wrap:anywhere}',
      '.mt-kb3-row-act{flex:none;display:flex;align-items:center;gap:6px}',
      '.mt-kb3-meta{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.mt-kb3-index{display:flex;flex-direction:column;gap:2px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;max-height:200px;overflow:auto}',
      '.mt-kb3-index-row{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-kb3-note{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
      '.mt-kb3-note>span{flex:1;min-width:200px}',
      '.mt-kb3-note b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-kb3-note-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, transparent);color:var(--dsw-alias-label-primary)}',
      '.mt-kb3-note-info{border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 8%, transparent);color:var(--dsw-alias-label-primary)}',
      /* CHG-86 / UI-5：知识提案裁决区（采纳 / 驳回 + 备注），与 .mt-kb-proposal 同一视觉族 */
      '.mt-kb3-proposals{display:flex;flex-direction:column;gap:8px;margin:8px 0 12px}',
      '.mt-kb3-proposals .mt-kb-proposal{margin-bottom:0}',
      '.mt-kb3-proposals .mt-kb-tags{margin-top:0}',
      '.mt-kb3-proposals input.mt-input{margin-top:6px}',
      '.mt-kb3-note .mt-btn{flex:none;margin-left:auto}',
      '.mt-mini-chip-off{color:var(--dsw-alias-label-tertiary);border-style:dashed;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-iconbtn{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border:.5px solid transparent;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:1;cursor:pointer}',
      '.mt-iconbtn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.mt-btn-ghost{background:none;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.mt-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      /* ── 预设卡：名册预览（队长高亮 + 角色引用 chips）+ 模板三行 + 引用计数（design/presets.html）── */
      '.mt-p3-card{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px;min-width:0}',
      '.mt-p3-card-builtin{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-p3-card:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mt-p3-top{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.mt-p3-topbody{flex:1;min-width:0}',
      '.mt-p3-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-p3-sub{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.mt-p3-desc{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.mt-p3-roster{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
      '.mt-p3-roster .mt-mini-chip{padding:1px 7px 1px 2px;gap:4px}',
      '.mt-p3-roster .mt-avatar{width:18px;height:18px;font-size:10px}',
      '.mt-p3-lead-chip{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 40%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-p3-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px;margin-top:auto}',
      '.mt-p3-newcard{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;min-height:180px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:10px;background:none;color:inherit;font:inherit;cursor:pointer;padding:12px}',
      '.mt-p3-newcard strong{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-p3-newcard span{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);max-width:22em}',
      '.mt-tmpl{display:flex;flex-direction:column;gap:6px}',
      '.mt-tmpl-row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5}',
      '.mt-tmpl-k{flex:none;width:3.9em;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.mt-tmpl-v{flex:1;min-width:0;display:flex;align-items:center;gap:4px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}',
      '.mt-colpreview{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap}',
      '.mt-colpreview b{font-weight:400;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.mt-colpreview .mt-ar{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      /* ── MCP 两段式：连接层 ∩ 可见层（design/skills.html）── */
      '.mt-mcp-split{display:grid;grid-template-columns:minmax(0,1fr) 40px minmax(0,1fr);align-items:stretch}',
      '.mt-mcp-pane{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:0}',
      '.mt-mcp-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-mcp-badge{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary);padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3)}',
      '.mt-mcp-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.mt-mcp-list{list-style:none;margin:0;padding:0}',
      '.mt-mcp-item{display:flex;align-items:center;gap:7px;min-height:38px;padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-mcp-item:last-child{border-bottom:0}',
      '.mt-mcp-item-off{color:var(--dsw-alias-label-tertiary)}',
      '.mt-mcp-name{font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.mt-mcp-item-off .mt-mcp-name{color:var(--dsw-alias-label-tertiary)}',
      '.mt-mcp-desc{color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-mcp-tags{margin-left:auto;display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}',
      '.mt-mcp-join{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:600}',
      '.mt-mcp-item .mt-avatar{width:22px;height:22px;font-size:10px}',
      '@media (max-width:760px){.mt-mcp-split{grid-template-columns:minmax(0,1fr)}.mt-mcp-join{display:none}}',
      /* [G4 ledger] design/audit.html · settings.html · archive.html · overview.html · shell.html */
      /* ── 审计视图（design/audit.html：三档回放 + attempt 分组事件流 + 只读标注）── */
      '.mt-audit-page{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.mt-audit-segbar{flex:none;display:flex;align-items:center;gap:8px;padding:8px 20px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.mt-audit-seg{display:flex;gap:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;padding:2px}',
      '.mt-audit-segbtn{display:inline-flex;align-items:center;gap:5px;border:0;background:none;color:var(--dsw-alias-label-secondary);padding:3px 10px;font-size:12px;border-radius:5px;cursor:pointer;font:inherit}',
      '.mt-audit-segbtn:hover{color:var(--dsw-alias-label-primary)}',
      '.mt-audit-segbtn-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-audit-segright{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mt-audit-body{flex:1;display:grid;grid-template-columns:268px minmax(0,1fr);min-height:0;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-audit-body-single{grid-template-columns:minmax(0,1fr)}',
      '.mt-audit-rail{border-right:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);overflow-y:auto;padding:8px 8px 16px;display:flex;flex-direction:column;gap:1px;min-height:0}',
      '.mt-audit-cap{padding:8px 8px 4px;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
      '.mt-audit-item{box-sizing:border-box;display:flex;align-items:flex-start;gap:7px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:none;text-align:left;cursor:pointer;font:inherit;color:inherit}',
      '.mt-audit-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-audit-item[aria-current="true"]{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 10%, transparent)}',
      '.mt-tid{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;padding-top:1px}',
      '.mt-audit-item[aria-current="true"] .mt-tid{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));font-weight:600}',
      '.mt-audit-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.mt-audit-item-main b{font-size:12px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-secondary)}',
      '.mt-audit-item[aria-current="true"] .mt-audit-item-main b{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));font-weight:600}',
      '.mt-audit-item-main span{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.4}',
      '.mt-audit-item .mt-mdot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l3);margin-top:5px}',
      '.mt-audit-item .mt-mdot.mt-mdot-gate{background:var(--dsw-alias-state-warning-primary);border-radius:2px;transform:rotate(45deg)}',
      '.mt-audit-sep{height:1px;background:var(--dsw-alias-border-l2);margin:5px 0;flex:none}',
      '.mt-audit-pane{overflow-y:auto;min-width:0;padding:16px 20px 32px}',
      '.mt-audit-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px}',
      '.mt-audit-eyebrow{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;flex-wrap:wrap}',
      '.mt-audit-title{font-size:20px;font-weight:600;letter-spacing:-.02em;line-height:1.35;margin-top:2px}',
      '.mt-audit-head-actions{margin-left:auto;flex:none}',
      '.mt-attempt-sep{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin:16px 0 8px;flex-wrap:wrap}',
      '.mt-attempt-sep:first-of-type{margin-top:0}',
      '.mt-attempt-line{flex:1;height:1px;background:var(--dsw-alias-border-l2);min-width:12px}',
      '.mt-evstream{list-style:none;margin:0;padding:0 0 0 6px;position:relative}',
      '.mt-evstream::before{content:"";position:absolute;left:52px;top:8px;bottom:8px;width:1px;background:var(--dsw-alias-border-l2)}',
      '.mt-evrow{position:relative;display:flex;gap:12px;padding:0 0 12px}',
      '.mt-evrow:last-child{padding-bottom:0}',
      '.mt-evtime{width:46px;flex:none;text-align:right;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.9;font-variant-numeric:tabular-nums}',
      '.mt-evdot{width:9px;height:9px;flex:none;border-radius:50%;background:var(--dsw-alias-bg-base);border:1.5px solid var(--dsw-alias-border-l3);margin-top:6px;position:relative;z-index:1;box-sizing:content-box}',
      '.mt-evdot-claimed{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 18%, transparent)}',
      '.mt-evdot-run{border-color:var(--dsw-alias-state-ok-primary);background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 18%, transparent)}',
      '.mt-evdot-warn{border-color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 18%, transparent)}',
      '.mt-evdot-failed{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent)}',
      '.mt-evmain{flex:1;min-width:0}',
      '.mt-evrow-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:1.9}',
      '.mt-evrow-title .mt-audit-type{min-width:0;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mt-who{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.mt-evrow-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.65;margin-top:1px;overflow-wrap:anywhere}',
      '.mt-mini-chip[aria-current="true"]{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 12%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 40%, transparent)}',
      '.mt-tone-run{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 10%, transparent)}',
      '.mt-tone-gate{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-tone-done{color:var(--dsw-alias-state-ok-primary);border-color:var(--dsw-alias-state-ok-primary)}',
      '.mt-tone-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mt-tone-idle{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      /* ── 团队设置（design/settings.html：三层合并链 + 行为配置硬上限 + 状态目录 + 生命周期）── */
      '.mt-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}',
      '.mt-page-head h2{margin:0;font-size:20px;font-weight:600;letter-spacing:-.02em;line-height:1.35}',
      '.mt-page-head p{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px;max-width:64ch;line-height:1.6}',
      '.mt-page-head-actions{display:flex;gap:8px;flex:none;flex-wrap:wrap;margin-left:auto}',
      '.mt-page-narrow{max-width:1000px}',
      '.mt-ssection{margin-bottom:16px}',
      '.mt-dsec-line{flex:1;height:1px;min-width:12px;background:var(--dsw-alias-border-l2)}',
      '.mt-dsec-n{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-layer{display:flex;align-items:center;gap:12px;padding:10px 12px;min-height:54px}',
      '.mt-layer + .mt-layer{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-layer-ico{flex:none;width:28px;height:28px;border-radius:6px;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
      '.mt-layer-ico.mt-layer-global{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 12%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-layer-ico.mt-layer-project{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 18%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-layer-main{flex:1;min-width:0}',
      '.mt-layer-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-layer-path{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-layer-n{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mt-layer-n span{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin-left:2px}',
      '.mt-merge-chain{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:8px}',
      '.mt-merge-chain b{font-weight:500;font-size:12px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.mt-merge-chain .mt-lt{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.mt-merge-chain b.mt-cur{border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 12%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));font-weight:600}',
      '.mt-setrows{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.mt-setrow{display:flex;align-items:center;gap:12px;padding:10px 16px;min-height:54px}',
      '.mt-setrow + .mt-setrow{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-setrow-main{flex:1;min-width:0}',
      '.mt-setrow-title{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mt-setrow-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:1px;line-height:1.55;max-width:45em}',
      '.mt-setrow-act{flex:none;display:flex;align-items:center;gap:12px}',
      '.mt-readonly-val{font-size:12px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.mt-input-num{width:64px;box-sizing:border-box;text-align:center;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);padding:5px 8px;font-size:12px;font-variant-numeric:tabular-nums}',
      '.mt-input-num:focus{outline:0;border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-toggle{width:40px;height:24px;border-radius:999px;background:var(--dsw-alias-border-l3);border:0;padding:0;position:relative;cursor:pointer;flex:none}',
      '.mt-toggle::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .18s ease}',
      '.mt-toggle[aria-checked="true"]{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-toggle[aria-checked="true"]::after{transform:translateX(16px)}',
      '.mt-toggle[disabled]{opacity:.5;cursor:not-allowed}',
      '.mt-secbox{background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 16px;display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.mt-secbox-tight{padding:0;overflow:hidden}',
      '.mt-inline-note{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}',
      '.mt-ok-ink{color:var(--dsw-alias-state-ok-primary)}',
      '.mt-note-box{display:flex;gap:8px;padding:9px 12px;border-radius:6px;font-size:12px;line-height:1.6;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);margin-top:16px}',
      '.mt-note-box b{color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.mt-note-box.mt-note-info{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 8%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 30%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-json{margin-top:8px;max-height:260px;overflow:auto;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}',
      '.mt-impact-box{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:4px}',
      '.mt-impact-box strong{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.mt-danger-ink{color:var(--dsw-alias-state-error-primary)}',
      /* ── 归档回放（design/archive.html：归档条 + 结局卡 + 进度分段 + 五项分解 + 任务历史 + 账本）── */
      '.mt-archbar{flex:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;min-height:58px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-team-id{display:flex;flex-direction:column;align-items:flex-start;min-width:0}',
      '.mt-team-id b{font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-secondary)}',
      '.mt-team-id span{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.3;font-variant-numeric:tabular-nums}',
      '.mt-arch-date{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-archbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mt-archive-page{max-width:1080px;padding-top:12px}',
      '.mt-endcard{border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-base);padding:12px 16px;display:flex;flex-direction:column;gap:6px}',
      '.mt-endcard h5{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-endcard p{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);max-width:45em}',
      '.mt-endmeta{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-segbar{display:flex;gap:2px;height:6px;margin-top:6px}',
      '.mt-segbar i{flex:1;border-radius:2px;background:var(--dsw-alias-border-l2);display:block}',
      '.mt-segbar i.mt-seg-done{background:var(--dsw-alias-state-ok-primary)}',
      '.mt-segbar i.mt-seg-blocked{background:var(--dsw-alias-state-error-primary)}',
      '.mt-segbar i.mt-seg-run{background:var(--dsw-alias-state-warning-primary)}',
      '.mt-teambar-stats{display:flex;align-items:center;gap:20px;flex-wrap:wrap}',
      '.mt-toktable{width:100%;border-collapse:collapse;font-size:12px}',
      '.mt-toktable th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:7px 12px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.mt-toktable td{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mt-toktable tr:last-child td{border-bottom:0}',
      '.mt-toktable th.mt-n,.mt-toktable td.mt-n{text-align:right}',
      '.mt-toktable td.mt-n{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.mt-toktable tfoot td{border-top:.5px solid var(--dsw-alias-border-l2);border-bottom:0;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-list{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.mt-listrow{display:flex;align-items:center;gap:12px;padding:10px 16px;min-height:54px}',
      '.mt-listrow + .mt-listrow{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-listrow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-listrow-main{flex:1;min-width:0}',
      '.mt-listrow-title{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mt-listrow-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:1px;line-height:1.55;max-width:45em}',
      '.mt-listrow-act{flex:none;display:flex;align-items:center;gap:6px}',
      '.mt-mavatar-muted{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
      '.mt-iname{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.mt-role-name{font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.mt-grid2{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(348px,1fr))}',
      '.mt-card2{background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.mt-card2-hoverable{cursor:pointer;transition:border-color .16s ease}',
      '.mt-card2-hoverable:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mt-card2-top{display:flex;align-items:flex-start;gap:8px;min-width:0}',
      '.mt-card2-title{font-size:13px;font-weight:600;line-height:1.45;display:flex;align-items:center;flex-wrap:wrap;gap:6px}',
      '.mt-card2-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.mt-card2-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-card2-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      /* ── 成本栏（design 底部：累计 token / 命中率 / 今日未命中·输出 / 估算标注）── */
      '.mt-costbar{display:flex;align-items:center;gap:12px;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;padding:0 16px;height:54px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none;min-height:54px}',
      '.mt-costbar-item{display:flex;align-items:center;gap:8px;padding-right:12px;border-right:.5px solid var(--dsw-alias-border-l2);flex:none}',
      '.mt-costbar-item:last-of-type{border-right:0}',
      '.mt-costbar-label{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.35}',
      '.mt-costbar-val{font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.mt-costbar-val small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      /* ── 项目 · 团队列表（design/shell.html：按工作区分组的团队卡）── */
      '.mt-home{flex:1;overflow-y:auto;min-height:0;padding:16px 20px 24px}',
      '.mt-home-filter{display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap}',
      '.mt-search-field{display:flex;align-items:center;gap:8px;width:360px;max-width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:0 10px;height:34px}',
      '.mt-search-field input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;height:32px}',
      '.mt-search-field input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.mt-search-ico{display:inline-flex;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.mt-home-hint{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:right;line-height:1.55;white-space:nowrap}',
      '.mt-home-group{margin-bottom:20px}',
      '.mt-home-group-head{display:flex;align-items:baseline;gap:8px;padding:0 2px 8px;flex-wrap:wrap}',
      '.mt-home-group-head b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-group-n{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-group-path{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%;font-variant-numeric:tabular-nums}',
      '.mt-team-card{box-sizing:border-box;display:block;width:100%;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 16px;color:inherit;font:inherit;margin-bottom:10px;transition:border-color .16s ease,background .16s ease}',
      '.mt-team-card:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3)}',
      '.mt-team-offline{opacity:.9;border-style:dashed}',
      '.mt-team-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.mt-tc-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-tc-zone{flex:none;margin-left:auto;padding:2px 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:5px}',
      '.mt-tc-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-ok-primary);flex:none}',
      '.mt-tc-desc{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px;line-height:1.6}',
      '.mt-tc-meta{margin-top:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      /* ── 全局 · 全部团队（design/overview.html：库作用域 + 活跃团队卡 + 已归档 run 列表）── */
      '.mt-ov-page{max-width:1080px}',
      '.mt-ov-active{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(348px,1fr));margin-bottom:20px}',
      '.mt-ov-gap{margin-bottom:20px}',
      /* [G5 graph] design/lanes.html · dag.html · dag-vertical.html · dragging.html */
      /* ── 泳道（design/lanes.html：蛇形泳道，行 = 角色，列 = 四阶段，格 = 该角色在该阶段的节点）── */
      '.mt-trail{width:156px}',
      '.mt-trail-cap{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:2px 6px 6px}',
      '.mt-titem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 6px;border:0;border-radius:8px;background:none;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;transition:background .16s ease}',
      '.mt-titem:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-titem[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-tav{width:26px;height:26px;flex:none;border-radius:6px;display:grid;place-items:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-tinfo{min-width:0;flex:1}',
      '.mt-tinfo b{display:block;font-size:12px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-tinfo span{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.4;font-variant-numeric:tabular-nums}',
      '.mt-lanes{flex:1;min-height:0;overflow:auto;padding:12px 16px 20px;display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.mt-lane{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-border-l2);padding:10px 12px;display:grid;grid-template-columns:128px repeat(var(--mt-lane-cols,4),minmax(0,1fr));gap:1px;overflow:hidden;margin-bottom:6px}',
      '.mt-lane-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-2);padding:6px 10px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}',
      '.mt-lane-head .mt-lane-count{margin-left:0;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      /* 行高统一：行头与格子同高（design 的泳道是等高表格，空列不能被内容撑成两种高度） */
      '.mt-lane-label{background:var(--dsw-alias-bg-base);padding:8px 10px;display:flex;flex-direction:column;gap:2px;justify-content:center;min-width:0;min-height:96px}',
      '.mt-lane-label-unassigned{background:var(--dsw-alias-bg-layer-1)}',
      '.mt-lane-label b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-lane-label .mt-lane-role{display:flex;align-items:center;gap:6px;min-width:0}',
      '.mt-lane-label .mt-lane-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.mt-lane-label .mt-avatar{width:24px;height:24px;font-size:12px}',
      '.mt-lane-label .mt-avatar-dashed{border-style:dashed;color:var(--dsw-alias-label-tertiary)}',
      /* CHG-85：格子内卡片多了要能滚，不该把整行撑到几百 px（未认领行 9 张卡时行高失控，
         泳道页底部被面板裁掉）。design/app.css 的 .lane-cell{min-height:56px} 是「最小」不是「无限」。
         CHG-85 后续：改成「限 4 张 + 折叠成『还有 N 个』」，格子本身不再需要限高。 */
      '.mt-lane-cell{background:var(--dsw-alias-bg-base);padding:5px;display:flex;flex-direction:column;gap:4px;min-height:96px;min-width:0}',
      /* CHG-85：折叠行（design/tasks.html 的 mt-trow-more 同款） */
      '.mt-lane-more{display:block;width:100%;box-sizing:border-box;margin-top:1px;padding:3px 6px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:4px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1.5;text-align:center;cursor:default}',
      '.mt-lane-cell-empty{background:var(--dsw-alias-bg-layer-1)}',
      '.mt-lane-node{display:flex;align-items:center;gap:5px;min-width:0;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsw-alias-border-l3);border-radius:4px;padding:4px 6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.mt-lane-node:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-lane-node b{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-lane-node span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.mt-lane-node .mt-lane-tk{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-lane-node-run{border-left-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));background:var(--dsw-alias-bg-layer-2)}',
      '.mt-lane-node-gate{border-left-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-lane-node-done{border-left-color:var(--dsw-alias-state-ok-primary)}',
      '.mt-lane-node-blocked{border-left-color:var(--dsw-alias-state-error-primary)}',
      '.mt-lane-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;margin:auto}',
      '.mt-lanes-note{display:flex;gap:6px;align-items:flex-start;margin-top:4px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      '.mt-lanes-note svg{flex:none;margin-top:2px;color:var(--dsw-alias-state-warning-primary)}',
      '.mt-lanes-note b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-viewbar-right{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}',
      /* ── 依赖图（design/dag.html + dag-vertical.html：真实 DOM 测量 + SVG 贝塞尔连线 + marker 箭头）── */
      '.mt-viewbar-dir{display:flex;align-items:center;gap:6px;margin-left:auto}',
      '.mt-viewbar-dir .mt-filterlabel{margin-left:0}',
      /* design/dag.html 的画布是点阵底（16px 网格），撑满视图条与图注之间 */
      '.mt-dagwrap{flex:1 1 0;min-height:0;position:relative;overflow:auto;padding:0;display:flex;min-width:0;gap:0;background:radial-gradient(circle at 1px 1px, var(--dsw-alias-border-l2) 1px, transparent 0) 0 0 / 16px 16px, var(--dsw-alias-bg-layer-1)}',
      '.mt-dag-canvas{position:relative;margin:auto;flex:none}',
      '.mt-dag-svg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}',
      '.mt-dag-card{position:absolute;width:190px;box-sizing:border-box;text-align:left;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary);font:inherit;transition:border-color .16s ease,box-shadow .16s ease}',
      '.mt-dag-card:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 1px 3px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)}',
      '.mt-dag-card-run{border-left:3px solid var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-dag-card-gate{border-left:3px solid var(--dsw-alias-state-warning-primary)}',
      '.mt-dag-card-done{border-left:3px solid var(--dsw-alias-state-ok-primary);background:var(--dsw-alias-bg-layer-1)}',
      '.mt-dag-card-blocked{border-style:dashed;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-dag-card-fail{border-left:3px solid var(--dsw-alias-state-error-primary)}',
      '.mt-dag-card-top{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}',
      '.mt-dag-code{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;letter-spacing:-.02em}',
      '.mt-dag-chip{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}',
      '.mt-dag-chip .mt-task-dot{width:6px;height:6px;margin-top:0}',
      '.mt-dag-chip-gate{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-dag-card-title{font-size:12px;margin:3px 0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;font-weight:500;line-height:1.45;text-wrap:balance}',
      '.mt-dag-card-meta{display:flex;gap:6px;flex-wrap:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary);align-items:center;margin-top:5px;min-height:17px;overflow:hidden}',
      '.mt-dag-card-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-dag-card-meta .mt-task-model{margin-left:auto;flex:none}',
      '.mt-chip-gate{flex:none;font-weight:600;color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, transparent)}',
      '.mt-chip svg{flex:none}',
      '.mt-dag-node-focus{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 22%, transparent)}',
      '.mt-dag-node-chain{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}',
      '.mt-dag-node-dim{opacity:.55}',
      '.mt-dag-edge{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:1.6}',
      '.mt-dag-edge-hot{stroke:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));stroke-width:2}',
      '.mt-dag-edge-dim{opacity:.28}',
      '.mt-dag-arrow{fill:var(--dsw-alias-border-l3)}',
      '.mt-dag-arrow-hot{fill:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-dag-note{padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;display:flex;gap:8px;align-items:flex-start;margin:0 16px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);line-height:1.6}',
      '.mt-dag-note b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-dag-note svg{flex:none;margin-top:2px;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-dag-empty{flex:1;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary)}',
      /* ── 拖拽流转态（design/dragging.html：lift 悬空卡 + 源列幽灵 + 合法落点高亮 + 被拒回执）── */
      '.mt-workbench{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;position:relative}',
      '.mt-board{flex:1;min-width:0;padding:10px 14px;display:flex;flex-direction:column;min-height:0;overflow:hidden;border-left:.5px solid var(--dsw-alias-border-l2);position:relative}',
      '.mt-col-drop{position:relative;border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 10%, var(--dsw-alias-bg-base))}',
      '.mt-col-nodrop{position:relative;border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-base))}',
      '.mt-dropzone{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;margin-top:6px;min-height:56px;padding:10px 8px;border:1.5px dashed color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 45%, transparent);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));text-align:center;line-height:1.6}',
      '.mt-task-ghost{display:flex;align-items:center;justify-content:center;min-height:58px;background:transparent;border:1.5px dashed var(--dsw-alias-border-l3);box-shadow:none;color:var(--dsw-alias-label-tertiary);font-size:12px;pointer-events:none;text-align:center;padding:6px}',
      '.mt-task-lift{position:absolute;top:46px;right:302px;width:210px;z-index:20;transform:rotate(-1.6deg);background:var(--dsw-alias-bg-base);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 45%, transparent);box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);cursor:grabbing}',
      '.mt-task-lift::after{content:"";position:absolute;inset:0;border-radius:inherit;outline:1.5px solid var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));outline-offset:0;pointer-events:none}',
      '.mt-lift-tag{position:absolute;top:-10px;right:10px;z-index:1;background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base);font-size:12px;font-weight:600;line-height:1;padding:4px 8px;border-radius:999px}',
      '.mt-dragtoast{position:absolute;left:16px;bottom:64px;z-index:22;max-width:400px;display:flex;gap:10px;padding:12px 14px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-state-error-primary);border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:10px;box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)}',
      '.mt-dragtoast b{display:block;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-dragtoast p{margin:2px 0 0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
      '.mt-dragtoast .mt-link{margin-left:2px}',
      '.mt-dragtoast-close{margin-left:auto;align-self:flex-start;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px;padding:0 2px;line-height:1.2}',
      '.mt-task-locked{cursor:not-allowed}',
      '.mt-task-locked .mt-task-title-text{color:var(--dsw-alias-label-tertiary)}',
      '.mt-lock-icon{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}',
      '.mt-task-shake{animation:mt-shake 150ms ease}',
      '@keyframes mt-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
      '@media (max-width: 980px){.mt-task-lift{right:24px;top:40px}}',
      /* [G6 flow] design/new-team.html · new-team-1.html · conversation.html · guest.html · tasks.html · team-tasks.html */
      /* CHG-84：向导是绝对定位浮层，必须让工作区成为定位祖先（否则会被裁到视口外/丢失背景遮罩） */
      '.mt-panel .mt-workspace{position:relative}',
      '.mt-wizard{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent)}',
      '.mt-wizard-dialog{width:min(680px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);overflow:hidden}',
      '.mt-wizard-head{padding:14px 18px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;flex:none}',
      '.mt-wizard-steprow{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.mt-wizard-title{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}',
      '.mt-wizard-desc{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);max-width:42em}',
      '.mt-wizard-body{padding:14px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;min-height:0;flex:1}',
      '.mt-wizard-foot{padding:12px 18px;border-top:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-wizard-footnote{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-wizard-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}',
      '.mt-steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mt-step{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-step b{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}',
      '.mt-step-on{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));font-weight:600}',
      '.mt-step-on b{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base)}',
      '.mt-step-done b{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-step-sep{flex:none;width:14px;height:1px;background:var(--dsw-alias-border-l3)}',
      /* [G6 flow · 向导单选项] */
      '.mt-opt-list{display:flex;flex-direction:column;gap:6px}',
      '.mt-opt{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;padding:10px 12px;text-align:left;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.mt-opt:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-opt[aria-checked="true"]{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));background-color:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 .5px var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-opt-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-top:1px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:transparent;font-size:10px;line-height:1}',
      '.mt-opt[aria-checked="true"] .mt-opt-mark{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));background-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base);font-weight:700}',
      '.mt-opt-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.mt-opt-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:600}',
      '.mt-opt-sub{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.mt-opt-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.mt-src{display:inline-flex;align-items:center;gap:3px;flex:none;font-size:11px;font-weight:500;line-height:16px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mt-src-project{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3));background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 8%, transparent)}',
      '.mt-src-global{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-src-builtin{color:var(--dsw-alias-label-tertiary)}',
      '.mt-rosterline{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px}',
      '.mt-mini-chip{display:inline-flex;align-items:center;gap:5px;flex:none;padding:2px 8px 2px 3px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.mt-mini-chip-lead{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 8%, transparent);border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3));color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-mini-chip-team{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 10%, transparent);border-style:solid;border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3));color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-mini-chip-coop{background:transparent;border-style:dashed;color:var(--dsw-alias-label-secondary)}',
      '.mt-mini-chip-num{font-variant-numeric:tabular-nums;padding:2px 7px}',
      '.mt-mini-chip-x{flex:none;margin-left:auto;border:0;background:none;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.mt-mavatar{width:18px;height:18px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mt-mavatar-lead{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base)}',
      '.mt-mavatar-a1{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 32%, transparent);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-mavatar-a2{background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 32%, transparent);color:var(--dsw-alias-state-ok-primary)}',
      '.mt-mavatar-a3{background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 32%, transparent);color:var(--dsw-alias-state-warning-primary)}',
      '.mt-mavatar-a4{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.mt-dsec-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}',
      '.mt-dsec-head h4{margin:0;font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary)}',
      '.mt-dsec-head .mt-line{flex:1;min-width:12px;height:1px;background:var(--dsw-alias-border-l2)}',
      '.mt-dsec-head .mt-n{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-dsec-head .mt-mini-link{margin-left:auto}',
      '.mt-note{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:10px;display:flex;align-items:flex-start;gap:8px;line-height:1.6}',
      '.mt-note-info{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 6%, transparent);border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3));color:var(--dsw-alias-label-primary);display:flex;gap:6px;flex-wrap:wrap;margin:0}',
      '.mt-note b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-note-icon{flex:none;font-size:12px;line-height:1.6}',
      '.mt-mini-link{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));text-decoration:none;white-space:nowrap;min-height:24px;display:inline-flex;align-items:center;background:none;border:0;cursor:pointer;font:inherit;padding:0;text-align:left}',
      '.mt-mini-link:hover{text-decoration:underline}',
      /* [G6 flow · 任务列表/tasks.html] */
      '.mt-taskhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}',
      '.mt-taskhead-title{display:inline-flex;align-items:baseline;gap:8px;flex:none}',
      '.mt-taskhead-title b{font-size:13px;font-weight:600}',
      '.mt-taskhead-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-taskhead-goal{flex:1;min-width:200px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mt-taskhead-stats{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-taskhead-actions{display:inline-flex;gap:6px;flex:none;flex-wrap:wrap}',
      '.mt-summary{display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;padding:12px 16px;margin-bottom:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-tstat{display:flex;flex-direction:column;align-items:flex-start;line-height:1.35}',
      '.mt-tstat b{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.mt-tstat span{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-summary-note{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-filterbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px}',
      '.mt-filterbar-hint{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-trow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;box-sizing:border-box;margin-bottom:6px;padding:8px 10px;text-align:left;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.mt-trow:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-trow .mt-tid{flex:none;min-width:22px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-trow .mt-tt{flex:1;min-width:120px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-trow .mt-who{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.mt-trow .mt-chev{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.mt-trow-more{background:transparent;border-style:dashed}',
      '.mt-trow-selected{border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 20%, transparent)}',
      '.mt-trow-more .mt-tt{color:var(--dsw-alias-label-tertiary)}',
      '.mt-status-chip{display:inline-flex;align-items:center;gap:4px;flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}',
      '.mt-status-chip .mt-shape{flex:none;width:6px;height:6px;border-radius:1px;background:currentColor}',
      '.mt-status-run{color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3))}',
      '.mt-status-run .mt-shape{border-radius:50%}',
      '.mt-status-gate{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-status-gate .mt-shape{border-radius:2px;transform:rotate(45deg)}',
      '.mt-status-done{color:var(--dsw-alias-state-ok-primary);border-color:var(--dsw-alias-state-ok-primary)}',
      '.mt-status-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mt-status-fail .mt-shape{clip-path:polygon(50% 0,100% 100%,0 100%);border-radius:0}',
      '.mt-status-idle .mt-shape{background:none;border:1.5px solid currentColor;border-radius:50%}',
      '.mt-viewlinks{display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap}',
      '.mt-vlink{border:0;background:none;padding:3px 9px;border-radius:6px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.mt-vlink:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-vlink-on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.mt-viewbar-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      /* [G6 flow · 会话页 conversation.html / 单角色调用 guest.html] */
      '.mt-conv{display:flex;flex-direction:column;height:100%;min-height:0;overflow-y:auto;padding:14px 16px;box-sizing:border-box;color:var(--dsw-alias-label-primary)}',
      '.mt-conv-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}',
      '.mt-conv-title{display:inline-flex;align-items:center;gap:8px;min-width:0}',
      '.mt-conv-title b{font-size:13px;font-weight:600}',
      '.mt-conv-title span{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-team-mark{width:26px;height:26px;border-radius:8px;display:inline-flex;place-items:center;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));flex:none;align-items:center;justify-content:center;border:.5px solid var(--dsw-alias-border-l2);font-size:12px}',
      '.mt-conv-seg{display:inline-flex;align-items:center;gap:2px;margin-left:auto;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.mt-conv-seg button{border:0;background:none;padding:3px 10px;border-radius:999px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.mt-conv-seg .mt-conv-seg-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mt-stream{display:flex;flex-direction:column;gap:16px;width:100%;max-width:764px;margin:0 auto;padding:14px 0}',
      '.mt-turn{display:flex;gap:8px}',
      '.mt-turn-av{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600}',
      '.mt-turn-av-human{background:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-base)}',
      '.mt-turn-body{flex:1;min-width:0}',
      '.mt-turn-meta{display:flex;align-items:baseline;gap:6px;margin-bottom:3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-turn-meta b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mt-bubble{margin:0;font-size:13px;line-height:1.72;color:var(--dsw-alias-label-primary)}',
      '.mt-toolcard{margin-top:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.mt-toolcard-head{display:flex;align-items:center;gap:6px;padding:7px 10px;font-size:12px}',
      '.mt-toolcard-name{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-toolcard-stat{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.mt-toolcard-chev{flex:none;margin-left:auto;border:0;background:none;padding:0;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}',
      '.mt-toolcard-body{display:flex;flex-direction:column;gap:0;padding:4px 10px 6px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-toolcard-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;color:var(--dsw-alias-label-primary);border-bottom:.5px solid color-mix(in srgb, var(--dsw-alias-border-l2) 55%, transparent)}',
      '.mt-toolcard-row:last-child{border-bottom:0}',
      '.mt-toolcard-row .mt-tid{flex:none;min-width:24px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.mt-toolcard-row .mt-tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mt-toolcard-row .mt-who{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-toolcard-more{color:var(--dsw-alias-label-tertiary)}',
      '.mt-toolcard-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.mt-toolcard-note{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-injrow{display:flex;align-items:flex-start;gap:8px;padding:5px 0;font-size:12px;line-height:1.6}',
      '.mt-injrow+.mt-injrow{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-inj-k{flex:none;width:4.4em;color:var(--dsw-alias-label-tertiary)}',
      '.mt-inj-v{flex:1;min-width:0;display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--dsw-alias-label-primary)}',
      '.mt-guestbar{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 6%, transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;flex:none}',
      '.mt-guestbar>span{flex:1;min-width:0;max-width:62em}',
      '.mt-guestbar b{font-weight:600}',
      '.mt-guestchips{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
      '.mt-composerbox{display:flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));border-radius:10px;padding:6px 10px;background:var(--dsw-alias-bg-base);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 12%, transparent)}',
      '.mt-cmdprefix{flex:none;margin-right:6px;padding-right:6px;border-right:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary));font-size:12px;font-weight:600}',
      '.mt-cmdinput{flex:1;min-width:0;border:0;background:none;outline:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.mt-composerhint{margin:6px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.mt-candpop{margin-top:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 16px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);overflow:hidden}',
      '.mt-cand-cap{padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.mt-cand{display:flex;align-items:center;gap:7px;min-height:36px;padding:6px 12px;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
      '.mt-cand:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mt-cand[aria-selected="true"]{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 8%, transparent)}',
      '.mt-cand-name{font-weight:600;font-variant-numeric:tabular-nums}',
      '.mt-cand-sub{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
      '.mt-cand-foot{padding:6px 12px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.mt-dockrow{display:flex;align-items:center;gap:8px;width:100%;max-width:764px;margin:0 auto;padding:0 0 8px;flex:none}',
      '.mt-dockchip{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}',
      '.mt-dockchip:hover{border-color:var(--dsw-alias-state-warning-primary)}',
      '.mt-dockchip .mt-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-ok-primary)}',
      '.mt-dockchip .mt-vline{flex:none;width:1px;height:11px;background:var(--dsw-alias-border-l3)}',
      '.mt-dockchip .mt-go{color:var(--dsw-alias-state-warning-primary)}',
      '.mt-dockrow .mt-spacer{flex:1}',
      '.mt-conv-section{display:flex;flex-direction:column;gap:8px;width:100%;max-width:764px;margin:0 auto;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mt-conv-section-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      /* CHG-84 复检：建团向导加载态（骨架）· 预设读取失败提示 · 参与关系 chip 实心/虚线 */
      '.mt-skeleton{display:flex;flex-direction:column;gap:6px}',
      '.mt-skeleton-cap{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mt-skeleton-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.mt-skeleton-dot{flex:none;width:16px;height:16px;margin-top:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);animation:mt-skeleton-pulse 1.2s ease-in-out infinite}',
      '.mt-skeleton-lines{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;padding-top:3px}',
      '.mt-skeleton-line{height:10px;max-width:70%;border-radius:4px;background:var(--dsw-alias-bg-layer-2);animation:mt-skeleton-pulse 1.2s ease-in-out infinite}',
      '.mt-skeleton-line-lg{height:12px;max-width:100%}',
      '@keyframes mt-skeleton-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
      '.mt-note-warn{flex-wrap:wrap;background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, transparent);border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-label-primary)}',
      '.mt-note-warn .mt-note-icon{color:var(--dsw-alias-state-warning-primary)}',
      '.mt-status-filled{background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 10%, transparent);border-color:var(--dsw-alias-border-accent, var(--dsw-alias-border-l3));color:var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary))}',
      '.mt-status-filled .mt-shape{border-radius:50%}',
      '.mt-status-dashed{border-style:dashed;color:var(--dsw-alias-label-secondary)}',
      /* ── 深色模式（R34 / UI-1 过门条件；CHG-99 C13 改为读宿主**解析后**的信号）──────
       * design/design-notes.md §九：颜色按「角色」定义，深色整段换值、变量名不动。
       * **修复前这里是 13 组双写**：`@media`（系统偏好媒体查询）+ `:root[data-theme="dark"]`
       * （自建属性）。媒体查询读的是**系统**偏好——用户在宿主里
       * 手动切深色（不跟随系统）时它不触发，13 组 color-mix 叠加色停在旧模式，深色底上叠出
       * 浅色胶囊（`.mt-note-info` / `.mt-mini-chip-lead` / `.mt-rolecard-captain` /
       * `.mt-guestbar` / `.mt-status-filled` 对比度掉到 2:1 以下）。
       * 现在只保留属性选择器：`data-theme` 由 `useDarkTheme()`（读宿主
       * `body[data-ds-dark-theme]`，老宿主回退 `matchMedia`）写到面板表面根上；
       * 作用域钉在 `.mt-*` 根而不是 `:root` —— **不污染面板之外**。
       * 只从 --dsw-alias-* 取色，**不新增 hex**；深色下低透明度 wash 会被暗底吃掉，
       * 故按「暗底上视觉等价」上调混合百分比（同一个 token，不是新色）。 */
      `${DARK_SURFACE}{color-scheme:dark}`,
      /* 浅底 wash（6~14%）在暗底几乎不可见 → 统一抬到 16% */
      `${DARK_SURFACE} :is(.mt-note-info,.mt-mini-chip-lead,.mt-kb3-note-info,.mt-layer-ico-project,.mt-layer-ico.mt-layer-project,.mt-src-project,.mt-src-project.mt-mini-chip,.mt-rolecard-captain,.mt-guestbar,.mt-cand[aria-selected="true"],.mt-status-filled,.mt-mini-chip-team,.mt-merge-chain b.mt-cur,.mt-note-box.mt-note-info){background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 16%, transparent)}`,
      `${DARK_SURFACE} :is(.mt-note-info,.mt-mini-chip-lead,.mt-mini-chip-team,.mt-kb3-note-info,.mt-src-project,.mt-toolcard-row,.mt-impact){border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 44%, transparent)}`,
      /* 成员四色头像（14% 底 / 30~32% 边）→ 24% / 48%，深底上头像仍能分辨 */
      `${DARK_SURFACE} :is(.mt-avatar-a1,.mt-mavatar-a1){background:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 24%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-label-emphasis, var(--dsw-alias-label-primary)) 48%, transparent)}`,
      `${DARK_SURFACE} :is(.mt-avatar-a2,.mt-mavatar-a2){background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 24%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 48%, transparent)}`,
      `${DARK_SURFACE} :is(.mt-avatar-a3,.mt-mavatar-a3){background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 24%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 48%, transparent)}`,
      `${DARK_SURFACE} :is(.mt-avatar-a4,.mt-mavatar-a4){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 46%, transparent)}`,
      /* 门禁 / 警示 chip（10~14% 底）→ 22% 底 / 58% 边 */
      `${DARK_SURFACE} :is(.mt-chip-gate,.mt-mini-chip-gate,.mt-detail-page .mt-mini-chip-gate,.mt-impact-gate,.mt-note-warn){background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 22%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 58%, transparent)}`,
      /* 通过 / 失败底（16% / 14%）→ 26% / 24% */
      `${DARK_SURFACE} :is(.mt-exit-ok,.mt-ac-pass .mt-ac-mark){background:color-mix(in srgb, var(--dsw-alias-state-ok-primary) 26%, transparent)}`,
      `${DARK_SURFACE} :is(.mt-exit-fail,.mt-mini-chip.mt-mini-chip-fail,.mt-impact){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent)}`,
      /* 遮罩：浅色用 62% 白纱；暗底上同比例几乎无遮罩感 → 80% 暗纱 */
      `${DARK_SURFACE} .mt-overlay{background:color-mix(in srgb, var(--dsw-alias-bg-base) 80%, transparent)}`,
      /* 阴影：浅色用「深字色 10~22%」投影；暗色下深字色变成近白，会成发光边 → 改用 bg-base 投影 */
      `${DARK_SURFACE} :is(.mt-dialog,.mt-menupop,.mt-candpop,.mt-wizard-dialog,.mt-dragtoast,.mt-task-lift,.mt-dag-card,.mt-dag-node-focus){box-shadow:0 10px 36px color-mix(in srgb, var(--dsw-alias-bg-base) 85%, transparent)}`,
      `${DARK_SURFACE} .mt-batchbar{box-shadow:0 -4px 12px color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent)}`,
      /* ── 动效降级（CHG-99 C14）：一条通配兜底覆盖全部 transition/animation ───────────
       * 修复前只覆盖 3/8（3 个 @keyframes 各一条），5 处 transition（`.mt-toggle::after` /
       * `.mt-card2-hoverable` / `.mt-team-card` / `.mt-titem` / `.mt-dag-card`）零覆盖。
       * 用 0.01ms 而非 none：transitionend 仍会触发（依赖它的代码安全），动效瞬完成。
       * 第二条保留「非法落点」的静态 outline 兜底——H4 三通道：运动去掉，语义通道保留。 */
      '@media (prefers-reduced-motion: reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}',
      '@media (prefers-reduced-motion: reduce){.mt-task-shake{animation:none;outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px}}',
    ].join('\n')
    const STYLE_ID = 'dsh-plugin-myteam/panel.css'
    /** 注入样式并返回清理函数（ctx.effect 持有；重复注入防重） */
    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-myteam'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /* ── G2：角色/名册展示小工具（纯展示派生，不造第二事实源）── */
    const TOKEN_BUCKET_KEYS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']
    /** token 侧车单成员合计 → 386k / 1.2M（四桶相加，成本口径仍是估算值） */
    const fmtTokenCount = (n) => {
      const value = Number(n ?? 0)
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value >= 1e6) return `${(value / 1e6).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`
      if (value >= 1e3) return `${Math.round(value / 1e3)}k`
      return String(Math.round(value))
    }
    /** 角色头像配色（a1~a4 四档；按角色 id 稳定取一档，避免每次渲染换色） */
    const AVATAR_CLASSES = ['mt-avatar-a1', 'mt-avatar-a2', 'mt-avatar-a3', 'mt-avatar-a4']
    const avatarClassOf = (key) => {
      const text = String(key ?? '')
      let hash = 0
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 9973
      return AVATAR_CLASSES[hash % AVATAR_CLASSES.length]
    }
    /** 头像字（角色名首字；无名时回落 id 首字） */
    const avatarCharOf = (name, fallback) => String(name || fallback || '?').trim().slice(0, 1) || '?'
    /** 单成员 token 合计（侧车四桶；无记录 = 0，不编数字） */
    const tokenTotalOf = (tokens, memberId) => {
      const bucket = tokens?.totals?.[memberId]
      if (!bucket) return 0
      return TOKEN_BUCKET_KEYS.reduce((sum, key) => sum + Number(bucket[key] ?? 0), 0)
    }
    /** 交付 x/y = 该实例被指派的已完成任务 / 被指派任务总数（从项目任务派生） */
    const deliveryOf = (tasks, memberId) => {
      const mine = (tasks ?? []).filter((task) => (task.assignees ?? (task.assignee ? [task.assignee] : [])).includes(memberId))
      return { done: mine.filter((task) => String(task.state ?? '') === 'done').length, total: mine.length }
    }

    /* ── G2 名册卡：一张卡一个角色（design/roster.html + member-menu.html）
     * 实现者 ×2 是同一张卡的两个实例行；队长不在名册里（roster.captainNote）。
     * 实例行 = iname / 在跑任务 / 交付 x/y · token；⋯ 展开实例管理菜单（指导 / 暂停 / 归档 / 移除 + 影响面）。 */
    function MemberCard({ t, roleId, role, members, tasks, tokens, teamName, taskTitle, readOnly, api, teamId, onOpen, onChanged, onError, onNotice }) {
      const [menuFor, setMenuFor] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const list = members ?? []
      const roleName = role?.name ?? roleLabel(roleId)
      const words = role?.interestWords ?? []
      const rows = list.map((member) => ({
        member,
        delivery: deliveryOf(tasks, member.id),
        tokenTotal: tokenTotalOf(tokens, member.id),
        task: (tasks ?? []).find((item) => item.id === member.currentTaskId),
      }))
      const running = list.some((member) => member.status === 'active' && member.currentTaskId)
      const gate = rows.some((row) => String(row.task?.state ?? '').startsWith('gate'))
      const idle = list.length > 0 && list.every((member) => member.status === 'active' && !member.currentTaskId)
      const others = (role?.memberships ?? []).filter((membership) => membership.teamId !== teamId && membership.online)
      const gateTask = rows.find((row) => String(row.task?.state ?? '').startsWith('gate'))?.task
      /** 实例当前任务标题（名册显示任务名而非 id；无标题时回落 id） */
      const instanceTaskTitle = (m) => taskTitle?.(m.currentTaskId) ?? (tasks ?? []).find((task) => task.id === m.currentTaskId)?.title
      const act = async (op, member) => {
        if (readOnly || busy || !api) return
        setBusy(true)
        try {
          let r = await api.memberOp({ teamId, memberId: member.id, op, confirm: op === 'remove' ? false : undefined })
          if (r?.status === 'confirm-required' && window.confirm(t('member.removeConfirm'))) {
            r = await api.memberOp({ teamId, memberId: member.id, op, confirm: true })
          }
          if (r?.status === 'error' || r?.status === 'drain-pending') onError?.(r.message ?? r.note ?? 'member op failed')
          else onError?.(null)
          setMenuFor(null)
          await onChanged?.()
        } catch (e) {
          onError?.(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      const statusChip = gate
        ? j('span', { className: 'mt-chip mt-chip-gate', children: [j('span', { className: 'mt-shape mt-shape-gate', 'aria-hidden': true }), t('roster.gate')] })
        : running
          ? j('span', { className: 'mt-chip mt-chip-run', children: [j('span', { className: 'mt-shape mt-shape-run', 'aria-hidden': true }), t('roster.running')] })
          : j('span', { className: 'mt-chip mt-chip-idle', children: [j('span', { className: 'mt-shape mt-shape-idle', 'aria-hidden': true }), t('roster.idle')] })
      const menuRow = menuFor ? rows.find((row) => row.member.id === menuFor) : undefined
      const menu = menuRow ? (() => {
        const member = menuRow.member
        const runningCount = (tasks ?? []).filter((task) => (task.assignees ?? []).includes(member.id)
          && !['done', 'failed', 'cancelled', 'blocked'].includes(String(task.state ?? ''))).length
        const gateCount = (tasks ?? []).filter((task) => (task.assignees ?? []).includes(member.id)
          && String(task.state ?? '').startsWith('gate')).length
        const item = (op, labelKey, ico, extra) => j('button', {
          className: extra?.danger ? 'mt-menu-item mt-menu-item-danger mt-link-danger' : 'mt-menu-item',
          role: 'menuitem',
          disabled: readOnly || busy || Boolean(extra?.disabled),
          title: extra?.title,
          /* `extra.onAct` 优先：没有宿主写路径的项（steer）走「可用 + 明确说明」，
           * 不再留永久 disabled 的假按钮（R34 / UI-1：看起来能点但永远点不动 = 欺骗）。 */
          onClick: () => { if (!extra?.disabled) (extra?.onAct ?? (() => act(op, member)))() },
          children: [j('span', { className: 'mt-menu-ico', 'aria-hidden': true, children: ico }), t(labelKey), extra?.kbd ? j('span', { className: 'mt-kbd', children: extra.kbd }) : null],
        })
        return js('div', { className: 'mt-menupop mt-member-actions', role: 'menu', children: [
          j('div', { className: 'mt-menu-label', children: t('roster.menu.label').replace('{name}', member.instanceName) }),
          /* 引导 / 接管：宿主 memberOp 只认 suspend|archive|remove|restore，没有 steer 写路径；
           * 语义上等价的是队长会话里的 myteam_message(kind=steer) / myteam_interrupt。
           * 面板不新造写路径（I2 账本唯一权威），点击给出可直接照做的说明。 */
          item('steer', 'roster.menu.steer', '→', {
            title: t('roster.menu.steerHint'),
            kbd: 'steer',
            onAct: () => { setMenuFor(null); onNotice?.(t('roster.menu.steerNotice')) },
          }),
          item('suspend', 'roster.menu.suspend', '‖', { disabled: member.status !== 'active' }),
          j('div', { className: 'mt-menu-sep', 'aria-hidden': true }),
          item('archive', 'roster.menu.archive', '▤', { disabled: !['active', 'suspended'].includes(member.status) }),
          item('remove', 'roster.menu.remove', '✕', { danger: true, disabled: member.status === 'removed' }),
          member.status === 'suspended' || member.status === 'archived' ? item('restore', 'roster.menu.restore', '↺', {}) : null,
          j('div', { className: 'mt-menu-note', children: t('roster.menu.impact').replace('{running}', String(runningCount)).replace('{gate}', String(gateCount)) }),
          readOnly ? j('div', { className: 'mt-menu-note', children: t('roster.menu.readonly') }) : null,
        ] })
      })() : null
      return js('article', {
        className: 'mt-roster-card' + (gate ? ' mt-roster-card-gate' : ''),
        children: [
          js('div', { className: 'mt-roster-top', children: [
            j('span', { className: `mt-avatar ${avatarClassOf(roleId)}`, 'aria-hidden': true, children: avatarCharOf(roleName, roleId) }),
            js('div', { className: 'mt-roster-body', children: [
              js('div', { className: 'mt-roster-title', children: [
                j('strong', { children: roleName }),
                j('span', { className: 'mt-chip mt-chip-plain', children: t('roster.instanceCount').replace('{n}', String(list.length)) }),
              ] }),
              j('div', { className: 'mt-roster-sub', children: role?.model ? `${role.model.model || role.model.provider} · ${t('roster.inheritRoute')}` : t('roster.inheritRoute') }),
              js('div', { className: 'mt-roster-words', children: [
                j('span', { className: 'mt-roster-rowlabel', children: t('roles.interest') }),
                ...(words.length > 0
                  ? words.map((word) => j('span', { key: word, className: 'mt-rolechip', children: word }))
                  : [j('span', { className: 'mt-hint', children: t('roles.interestEmpty') })]),
              ] }),
            ] }),
            statusChip,
          ] }),
          ...rows.map((row) => js('div', { className: 'mt-inst-row', key: row.member.id, children: [
            j('span', { className: 'mt-iname', children: row.member.instanceName }),
            row.task
              ? j('button', {
                className: 'mt-minichip' + (String(row.task.state ?? '').startsWith('gate') ? ' mt-minichip-gate' : ''),
                title: instanceTaskTitle(row.member) ?? row.task.title,
                onClick: () => onOpen?.(row.member.currentTaskId),
                children: `${row.task.id} ${instanceTaskTitle(row.member) ?? row.task.title}`,
              })
              : j('span', { className: 'mt-minichip', children: t('roster.noTask') }),
            j('span', { className: 'mt-inst-right', children: `${t('roster.delivery').replace('{done}', String(row.delivery.done)).replace('{total}', String(row.delivery.total))} · ${fmtTokenCount(row.tokenTotal)}` }),
            j('button', {
              className: 'mt-inst-menu-btn',
              'aria-expanded': menuFor === row.member.id,
              'aria-label': t('roster.menu.label').replace('{name}', row.member.instanceName),
              onClick: () => setMenuFor(menuFor === row.member.id ? null : row.member.id),
              children: '⋯',
            }),
          ] })),
          others.length > 0 ? js('div', { className: 'mt-roster-row', children: others.slice(0, 2).map((membership) => j('span', {
            key: `${membership.teamId}-${membership.instanceName}`,
            className: 'mt-minichip mt-minichip-gate',
            children: t('roster.sameRoleOtherTeam').replace('{team}', teamName?.(membership.teamId) || membership.teamName || membership.teamId),
          })) }) : null,
          js('div', { className: 'mt-roster-foot', children: [
            j('span', {
              className: gate ? 'mt-roster-foot-gate' : 'mt-hint',
              children: gate
                ? t('roster.gateNote')
                : list.length > 1
                  ? t('roster.multiNote').replace('{n}', String(list.length))
                  : idle ? t('roster.idleNote') : t('roster.activeNote').replace('{task}', rows.find((row) => row.task)?.task.title ?? '—'),
            }),
            gateTask ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onOpen?.(gateTask.id), children: t('roster.gateAction') }) : null,
          ] }),
          menu,
        ],
      })
    }

    /** 名册末尾的「召唤角色」虚线卡（design/roster.html 最后一格） */
    function RosterSummonCard({ t, onSummon }) {
      return js('button', {
        className: 'mt-roster-card mt-roster-card-summon',
        onClick: () => onSummon?.(),
        children: [
          j('span', { className: 'mt-roster-summon-ico', 'aria-hidden': true, children: '＋' }),
          j('span', { className: 'mt-roster-summon-title', children: t('roster.summon') }),
          j('span', { className: 'mt-roster-summon-hint', children: t('roster.summonCardHint') }),
        ],
      })
    }

    /**
     * `/myteam` 命令解析（CHG-87 §5.3 / FR-15.1）。
     *
     * 只有**以 `/myteam` 开头**才当命令（句中出现按普通文本 —— 闭合命名空间）；
     * `+id` 启用、`-id` 卸载、可累加：`/myteam+researcher+reviewer` / `/myteam-researcher`。
     * 角色 id 本身含 `-`（`tech-writer`）也能正确解析：只按 `+` 切 token，
     * token 首字符是 `-` 才当卸载标记。
     *
     * @returns {{roles: string[], remove: string[]}|null} 不是命令 → `null`
     */
    const parseMyteamCommand = (text) => {
      const raw = String(text ?? '').trim()
      if (!raw.startsWith('/myteam')) return null
      const rest = raw.slice('/myteam'.length)
      const roles = []
      const remove = []
      for (const token of rest.split('+')) {
        const part = token.trim()
        if (!part) continue
        if (part.startsWith('-')) {
          const id = part.slice(1).trim()
          if (id) remove.push(id)
        } else {
          roles.push(part)
        }
      }
      return { roles, remove }
    }

    /**
     * 单角色调用小卡（CHG-87 §5.3 / FR-16.1）。
     *
     * **挂载点选择（已在报告里说明）**：面板没有会话输入框 —— composer 属于宿主，
     * 插件只注册 slot；硬塞一个全局输入框会抢宿主键盘。按 Lead 给的兜底方案，
     * 落在团队页（队员 tab）：输入 `/myteam+<roleId>` / `/myteam-<roleId>` → `api.applyRoles`。
     */
    function GuestRoleCallCard({ t, api, teamId, readOnly, onChanged, onNotice, onError }) {
      const [value, setValue] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const submit = async () => {
        if (busy) return
        const parsed = parseMyteamCommand(value)
        if (!parsed) { onNotice?.(t('rolecall.notCommand')); return }
        if (parsed.roles.length === 0 && parsed.remove.length === 0) { onNotice?.(t('rolecall.nothing')); return }
        if (readOnly) { onNotice?.(t('rolecall.readonly')); return }
        if (typeof api?.applyRoles !== 'function') { onNotice?.(t('rolecall.unavailable')); return }
        setBusy(true)
        setResult(null)
        try {
          const r = await api.applyRoles({
            teamId,
            roles: parsed.roles,
            ...(parsed.remove.length > 0 ? { remove: parsed.remove } : {}),
          })
          setResult(r ?? null)
          if (r?.status === 'error') {
            /* 解析失败 / 角色不存在：显示 host 返回的 message，不发消息（契约 §5.3） */
            onError?.(r.message ?? r.code ?? t('applyRoles.error'))
            return
          }
          if (parsed.roles.length > 0) onNotice?.(t('rolecall.applied').replace('{roles}', parsed.roles.join('、')))
          else onNotice?.(t('rolecall.removed').replace('{roles}', parsed.remove.join('、')))
          setValue('')
          await onChanged?.()
        } catch (e) {
          onError?.(t('rolecall.failed').replace('{message}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const roles = Array.isArray(result?.roles) ? result.roles : []
      const removed = Array.isArray(result?.removed) ? result.removed.map((id) => String(id)) : []
      return js('div', { className: 'mt-rolecall', children: [
        j('b', { children: t('rolecall.title') }),
        j('p', { className: 'mt-rolecall-hint', children: t('rolecall.desc') }),
        js('div', { className: 'mt-rolecall-row', children: [
          j('input', {
            className: 'mt-input',
            value,
            placeholder: t('rolecall.placeholder'),
            'aria-label': t('rolecall.title'),
            autoComplete: 'off',
            disabled: busy,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          }),
          j('button', { className: 'mt-btn mt-btn-primary mt-btn-sm', disabled: busy, onClick: submit, children: busy ? t('state.loading') : t('rolecall.apply') }),
        ] }),
        roles.length > 0 ? js('div', { className: 'mt-rolecall-chips', children: [
          j('span', { className: 'mt-hint', children: t('applyRoles.roles') }),
          ...roles.map((role, index) => j('span', {
            key: `role-${String(role?.roleId ?? index)}`,
            className: 'mt-mini-chip mt-mini-chip-lead',
            children: `${String(role?.roleId ?? '—')} · ${String(role?.name ?? '—')}`,
          })),
        ] }) : null,
        removed.length > 0 ? js('div', { className: 'mt-rolecall-chips', children: [
          j('span', { className: 'mt-hint', children: t('applyRoles.removed') }),
          ...removed.map((id, index) => j('span', { key: `rm-${index}`, className: 'mt-mini-chip mt-mini-chip-coop', children: `− ${id}` })),
        ] }) : null,
        typeof result?.promptSection === 'string' && result.promptSection.trim()
          ? j('pre', { className: 'mt-ev-code', children: result.promptSection.trim() })
          : null,
        typeof result?.note === 'string' && result.note.trim() ? j('p', { className: 'mt-rolecall-hint', children: result.note.trim() }) : null,
        typeof result?.filePath === 'string' && result.filePath ? j('p', { className: 'mt-rolecall-hint', children: t('rolecall.filePath').replace('{path}', result.filePath) }) : null,
      ] })
    }

    /* ── 看板卡（CHG-69：多队员负责 + 参与团队 chip；优先级只渲染一次）──
     * CHG-73：证据过期 / 已取消 chip；多选模式下点卡片 = 勾选（不嵌套 button，用 aria-pressed） */
    function TaskCard({ task, onOpen, memberName, t, teamName, selectable, selected, onToggle, showTeamName = true, drag }) {
      const deps = (task.deps ?? []).filter((dep) => dep !== task.id)
      const names = (task.assignees && task.assignees.length > 0 ? task.assignees : task.assignee ? [task.assignee] : [])
        .map((id) => memberName?.(id) || id)
      const participants = task.participants ?? []
      const shown = participants.slice(0, 2)
      const stale = task.evidenceStale
      const cancelled = task.cancelled
      /* CHG-87 §2.3：越界写入清单（ok === true 或无 scopeAudit 时不显示徽标） */
      const scopeOut = task.scopeAudit && task.scopeAudit.ok === false && Array.isArray(task.scopeAudit.outOfScope)
        ? task.scopeAudit.outOfScope.map(String)
        : []
      const picking = Boolean(selectable)
      // CHG-82：attempt 失效（门禁未过 / 已取消）的卡「锁住不可拖」——图标换锁 + cursor:not-allowed
      const locked = Boolean(drag?.locked)
      const cardClass = 'mt-task'
        + (picking && selected ? ' mt-task-selected' : '')
        + (locked ? ' mt-task-locked' : '')
        + (drag?.shake ? ' mt-task-shake' : '')
      return js('button', {
        className: cardClass,
        title: locked ? `${t('drag.lockedTitle')} · ${task.title}` : picking ? `${t('multi.on')} · ${task.title}` : task.title,
        draggable: drag ? !locked : undefined,
        'aria-disabled': locked ? 'true' : undefined,
        onDragStart: drag ? (event) => drag.onDragStart?.(event, task) : undefined,
        onDragEnd: drag ? (event) => drag.onDragEnd?.(event, task) : undefined,
        'aria-pressed': picking ? Boolean(selected) : undefined,
        onClick: () => (picking ? onToggle?.(task) : onOpen(task.id)),
        children: [
          /* design/board.html 的 .tcard-top：任务号 + 优先级（+ 模型徽标） */
          js('span', { className: 'mt-task-top', children: [
            picking ? j('span', { className: 'mt-task-check' + (selected ? ' mt-task-check-on' : ''), 'aria-hidden': true, children: selected ? '✓' : '' }) : null,
            locked ? j('span', { className: 'mt-lock-icon', 'aria-hidden': true, children: j('svg', {
              width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none',
              children: [
                j('rect', { x: 2.2, y: 5.2, width: 7.6, height: 5.2, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.1 }),
                j('path', { d: 'M4 5.2V3.8a2 2 0 0 1 4 0v1.4', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
              ],
            }) }) : null,
            j('span', { className: 'mt-task-id', children: task.code ?? task.id }),
            task.priority ? j('span', { className: `mt-pri mt-pri-${task.priority}`, children: task.priority }) : null,
            task.model ? j('span', { className: 'mt-task-model', title: task.model, children: task.model }) : null,
          ] }),
          /* .tcard-title：标题独占一行，最多 3 行 */
          j('span', { className: 'mt-task-title-text', children: task.title }),
          /* .tcard-meta：承接角色的队员 + 状态 + 证据数 */
          js('span', { className: 'mt-task-meta', children: [
            names.length > 0 ? j('span', { className: 'mt-rolechip', children: names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2}` : '') }) : null,
            j('span', { className: 'mt-hint', children: stateLabel(task.state) }),
            task.evidenceCount > 0 ? j('span', { className: 'mt-hint', children: `${t('board.evidence')} ${task.evidenceCount}` }) : null,
            task.escalateCount > 0 ? j('span', { className: 'mt-flow-warn', children: `⚠×${task.escalateCount}` }) : null,
            locked ? j('span', { className: 'mt-chip mt-chip-stale', children: t('drag.locked') }) : null,
          ] }),
          /* .tcard-meta：团队归属（主责 / 协作）——单团队时是噪音，按 showTeamName 收 */
          showTeamName && participants.length > 0 ? js('span', { className: 'mt-task-meta', children: [
            ...shown.map((p) => j('span', {
              key: p.teamId,
              className: `mt-tchip mt-tchip-${p.role === 'lead' ? 'lead' : 'coop'}`,
              title: `${teamName?.(p.teamId) || p.teamId} · ${p.role === 'lead' ? t('task.owner') : t('task.coop')}`,
              children: `${teamName?.(p.teamId) || p.teamId} · ${p.role === 'lead' ? t('task.owner') : t('task.coop')}`,
            })),
            participants.length > shown.length ? j('span', { className: 'mt-tchip', children: `+${participants.length - shown.length}` }) : null,
          ] }) : null,
          /* CHG-87 §2.3：写入范围越界徽标（警告不阻断；title 给全量清单） */
          scopeOut.length > 0
            ? j('span', { className: 'mt-task-meta', children: j('span', {
              className: 'mt-scope-badge',
              title: t('scope.warn').replace('{n}', String(scopeOut.length)).replace('{files}', scopeOut.join('、')),
              children: t('scope.badge').replace('{n}', String(scopeOut.length)),
            }) })
            : null,
          stale || cancelled || task.rewired ? js('span', { className: 'mt-task-meta', children: [
            stale
              ? j('span', {
                className: 'mt-chip mt-chip-stale',
                title: t('board.staleTitle')
                  .replace('{fields}', fieldListText(t, stale.fields))
                  .replace('{time}', fmtClock(stale.since)),
                children: t('board.evidenceStale'),
              })
              : null,
            cancelled
              ? j('span', {
                className: 'mt-chip mt-chip-cancelled',
                title: t('board.cancelledTitle').replace('{reason}', cancelled.reason || '—'),
                children: t('board.cancelled'),
              })
              : null,
            /* CHG-75：被改挂过（下游换了上游）——给个小标记，让人知道依赖动过 */
            task.rewired
              ? j('span', { className: 'mt-chip mt-chip-rewired', title: t('board.rewiredTitle'), children: t('board.rewired') })
              : null,
          ] }) : null,
          j(DiagChips, { t, diagnosis: task.diagnosis }),
          /* .tcard-dep：阻塞提示（虚线分隔） */
          deps.length > 0 ? j('span', { className: 'mt-task-dep mt-task-dep-blocked', children: t('board.blockedBy').replace('{deps}', deps.join('、')) }) : null,
        ],
      })
    }

    /* ── 泳道（design/lanes.html：蛇形泳道，行 = 角色实例，列 = 四阶段，格 = 该实例在该阶段的节点）──
     * 三视图同源同抽屉：节点点开仍是同一个任务详情（onOpen）。列取四个流转阶段；完成 / 未完成是终态桶，不进泳道。 */
    const LANE_STAGES = ['待规划', '就绪', '进行中', '门禁']
    /** CHG-85：泳道格子内最多显示几张卡，超出折叠（design/tasks.html 同款「还有 N 个」） */
    const LANE_CELL_LIMIT = 4
    const laneStageOf = (state) => {
      for (const name of LANE_STAGES) {
        const col = PROJECT_COLUMNS.find((item) => item.name === name)
        if (col && col.states.includes(state)) return name
      }
      return null
    }
    const laneAvatarChar = (member) => String(roleLabel(member?.roleId) ?? member?.id ?? '?').trim().slice(0, 1) || '?'
    const assigneesOf = (task) => (task.assignees && task.assignees.length > 0 ? task.assignees : task.assignee ? [task.assignee] : [])

    function LanesView({ t, tasks, members, onOpen }) {
      const stageStates = LANE_STAGES.map((name) => ({ name, states: PROJECT_COLUMNS.find((col) => col.name === name)?.states ?? [] }))
      const memberIds = new Set((members ?? []).map((member) => String(member.id ?? member.instanceName ?? '')))
      /** 在册实例 id —— 指派不到任何在册实例的任务 = 未认领（不丢任务、也不假造分配） */
      const assignedTo = (task) => assigneesOf(task).map(String).filter((id) => memberIds.has(id))
      const rows = (members ?? []).map((member, index) => ({
        key: String(member.id ?? member.instanceName ?? index),
        member,
        unassigned: false,
        cells: stageStates.map((stage) => tasks.filter((task) => laneStageOf(task.state) === stage.name && assignedTo(task).includes(String(member.id)))),
      }))
      /* 未认领行：保证「列头计数 = 格子里看得见的节点」，同时不把任务改成假指派 */
      const unassignedTasks = tasks.filter((task) => assignedTo(task).length === 0)
      if (unassignedTasks.length > 0) {
        rows.push({
          key: 'mt-lane-unassigned',
          member: null,
          unassigned: true,
          cells: stageStates.map((stage) => unassignedTasks.filter((task) => laneStageOf(task.state) === stage.name)),
        })
      }
      const counts = stageStates.map((_, i) => rows.reduce((sum, row) => sum + row.cells[i].length, 0))
      const labelOf = (row) => (row.unassigned
        ? { avatar: '?', title: t('lanes.unassigned'), sub: t('lanes.unassignedNote') }
        : {
          avatar: laneAvatarChar(row.member),
          title: roleLabel(row.member.roleId),
          sub: `${row.member.instanceName ?? row.member.id ?? '—'} · ${memberStateLabel(row.member.status)}`,
        })
      return js('div', { className: 'mt-lanes', style: { '--mt-lane-cols': String(stageStates.length) }, children: [
        js('div', { className: 'mt-lane', children: [
          j('div', { className: 'mt-lane-head', children: t('lanes.groupBy') }),
          ...stageStates.map((stage, i) => j('span', { key: stage.name, className: 'mt-lane-head', children: [
            j('span', { children: stage.name }),
            j('span', { className: 'mt-lane-count', children: `· ${counts[i]}` }),
          ] })),
        ] }),
        rows.length === 0
          ? j('div', { className: 'mt-lane-empty', children: t('lanes.noMembers') })
          : rows.map((row) => {
            const label = labelOf(row)
            const total = row.cells.reduce((sum, cell) => sum + cell.length, 0)
            return js('div', { className: 'mt-lane', key: row.key, children: [
              js('div', { className: 'mt-lane-label' + (row.unassigned ? ' mt-lane-label-unassigned' : ''), children: [
                js('div', { className: 'mt-lane-role', children: [
                  j('span', { className: row.unassigned ? 'mt-avatar mt-avatar-dashed' : 'mt-avatar', 'aria-hidden': true, children: label.avatar }),
                  j('b', { children: label.title }),
                ] }),
                j('span', { className: 'mt-lane-sub', title: label.title, children: label.sub }),
                j('span', { className: 'mt-lane-sub', children: t('lanes.count').replace('{n}', String(total)) }),
              ] }),
              ...row.cells.map((cell, i) => j('div', {
                key: `${row.key}-${stageStates[i].name}`,
                className: 'mt-lane-cell' + (cell.length === 0 ? ' mt-lane-cell-empty' : ''),
                children: [
                  ...cell.slice(0, LANE_CELL_LIMIT).map((task) => js('button', {
                    key: task.key,
                    className: 'mt-lane-node mt-lane-node-' + dagChipOf(task.state),
                    title: task.title,
                    onClick: () => onOpen(task),
                    children: [
                      j('b', { children: task.id }),
                      j('span', { children: task.title }),
                      j('span', { className: 'mt-lane-tk', children: stateLabel(task.state) }),
                    ],
                  })),
                  /* CHG-85：格子内卡片过多时折叠成「还有 N 个」——否则一行被撑到几百 px、底部被面板裁掉。 */
                  cell.length > LANE_CELL_LIMIT ? j('span', {
                    className: 'mt-lane-more',
                    title: t('lanes.moreHint').replace('{n}', String(cell.length - LANE_CELL_LIMIT)),
                    children: t('lanes.more').replace('{n}', String(cell.length - LANE_CELL_LIMIT)),
                  }) : null,
                  /* 整行没有任务：末格给「无进行中任务」（design 的验收员行） */
                  cell.length === 0 && total === 0 && i === stageStates.length - 1 ? j('span', { className: 'mt-lane-empty', children: t('lanes.emptyRow') }) : null,
                ],
              })),
            ] })
          }),
        js('p', { className: 'mt-lanes-note', children: [
          j('svg', {
            width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
            children: [
              j('path', { d: 'M8 2.2 14 13H2z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
              j('path', { d: 'M8 6v3.4M8 11.1v.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
            ],
          }),
          j('span', { children: [j('b', { children: t('lanes.noteLead') }), t('lanes.noteBody')] }),
        ] }),
      ] })
    }

    /**
     * 门禁裁决区（CHG-86 / M2-C，FR-5.1~5.2；**UI-1 过门条件**）。
     *
     * 修复的断链：默认门禁链是 `['review','archive']`，任务 done 后进 `gate:review`；
     * 此前详情抽屉**没有任何裁决写路径**（只有队长工具），任务永远到不了 done，
     * 下游依赖、归档与成本管线全部悬空。现在 drawer 内直接给按钮 → `reviewTask`。
     *
     * 口径（与 host 侧 `reviewTask` 一一对应，不在前端重实现规则）：
     *  - review / verify 门：**强制交叉审查** —— 审查人必选，且不能是实现者本人
     *    （本人选项 disabled + 明确提示，host 侧也会以 MT_CROSS_REVIEW 拒绝）；
     *  - archive 门：不是人工裁决门，host 按 deliverableSpec 约定路径做**落位校验**
     *    （FR-10.4），只给「重新校验」一个动作，绝不采信模型自述「已归档」；
     *  - 打回（fail）必须写清理由（host 侧校验非空 reason）；
     *  - 打回预算超限（needs-human / MT_REJECT_BUDGET）：人工二次确认后带 confirm=true 放行。
     */
    function GateReview({ t, api, teamId, taskId, detail, readOnly, memberName, members: roster, onDone, onError }) {
      const state = String(detail?.state ?? '')
      const gate = state.startsWith('gate:') ? state.slice('gate:'.length) : ''
      /* CHG-86：名册优先用面板**已经加载好的** board.members —— 离线团队没有活动会话，
         `getBoard` 返回 unavailable，审查人下拉会是空的（等于无法裁决）。只有外层没给名册时
         才回落到 getBoard（在线路径）。 */
      const hasRoster = Array.isArray(roster) && roster.length > 0
      /* CHG-87 §1.3：只有 review 门要选审查人；verify 门没有人审（host 跑命令），archive 门是落位校验 */
      const needsRoster = gate === 'review'
      const [fetched, setFetched] = react.useState(null)
      const [reviewer, setReviewer] = react.useState('')
      const [reason, setReason] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState(null)
      /* CHG-87 §1.2/§1.3：verify 门的运行态 / 最近一次返回 / 「宿主没有 subprocess」降级态 */
      const [running, setRunning] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const [noSubprocess, setNoSubprocess] = react.useState(false)
      react.useEffect(() => {
        if (hasRoster || !needsRoster) return undefined
        if (!teamId || typeof api?.getBoard !== 'function') { setFetched([]); return undefined }
        let alive = true
        api.getBoard({ teamId }).then((r) => {
          if (!alive) return
          setFetched((r?.board?.members ?? []).map((member) => ({
            id: String(member.id),
            name: String(member.instanceName ?? member.id),
            status: member.status,
          })))
        }).catch(() => { if (alive) setFetched([]) })
        return () => { alive = false }
      }, [gate, teamId, api, hasRoster, needsRoster])
      if (!gate) return null
      const isArchiveGate = gate === 'archive'
      const isVerifyGate = gate === 'verify'
      /* 契约 §1.1：任务输入里的 verifyCommand（argv 必填数组、cwd 可选） */
      const verifyCommand = detail?.input?.verifyCommand ?? null
      const verifyArgv = Array.isArray(verifyCommand?.argv) ? verifyCommand.argv.map((part) => String(part)) : []
      const verifyCwd = verifyCommand?.cwd ? String(verifyCommand.cwd) : ''
      /* 契约 §2.2：投影带的最近一次 scope 审计（警告不阻断门禁，FR-5.4） */
      const scopeAudit = detail?.scopeAudit ?? null
      const scopeBad = Boolean(scopeAudit) && scopeAudit.ok === false && Array.isArray(scopeAudit.outOfScope) && scopeAudit.outOfScope.length > 0
      /* 实现者 = 任务主责（多主责时取第一个）；交叉审查禁的是「审自己」 */
      const implementer = String(detail?.assignee ?? (detail?.assignees ?? [])[0] ?? '')
      const list = hasRoster
        ? roster.map((member) => ({ id: String(member.id), name: String(member.instanceName ?? member.id), status: member.status }))
        : (fetched ?? [])
      const selfReview = Boolean(needsRoster && implementer && reviewer === implementer)
      /** review / archive 门的裁决提交（verify 门走 runVerify） */
      const submit = async (verdict) => {
        if (readOnly || busy) return
        if (verdict === 'fail' && !reason.trim()) { setNote(t('gate.needReason')); return }
        if (needsRoster && !reviewer) { setNote(t('gate.needReviewer')); return }
        setBusy(true)
        setNote(null)
        try {
          const r = await api.reviewTask({
            teamId,
            taskId,
            verdict,
            ...(needsRoster && reviewer ? { reviewerMemberId: reviewer } : {}),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          })
          if (r?.status === 'needs-human') {
            const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
              ? window.confirm(t('gate.budgetConfirm').replace('{n}', String(r.rejectCount ?? 0)))
              : false
            if (!ok) { setNote(r.message ?? t('gate.budgetBlocked')); return }
            const forced = await api.reviewTask({
              teamId,
              taskId,
              verdict,
              ...(reviewer ? { reviewerMemberId: reviewer } : {}),
              confirm: true,
            })
            setNote(forced?.note ?? forced?.message ?? t('gate.done'))
            if (forced?.status !== 'error' && forced?.status !== 'needs-human') { setReason(''); await onDone?.() }
            return
          }
          if (r?.status === 'error') {
            setNote(r.message ?? r.code ?? t('gate.failed'))
            onError?.(r.message ?? r.code)
            return
          }
          setNote(r?.note ?? t('gate.done'))
          setReason('')
          await onDone?.()
        } catch (e) {
          const message = String(e?.message ?? e)
          setNote(message)
          onError?.(message)
        } finally {
          setBusy(false)
        }
      }
      /**
       * 契约 §1.3：verify 门**真跑命令**。
       * verdict 固定传 'pass' —— host 在 verify 门忽略它、自己跑命令取退出码，
       * 前端不编造裁决语义（FR-5.3「绝不采信模型自述测试通过」）。
       * `force=true` 是「宿主没有 subprocess 服务」时的人工强制放行（confirm + 必填 reason）。
       */
      const runVerify = async (force) => {
        if (readOnly || busy || running) return
        if (force && !reason.trim()) { setNote(t('gate.needReason')); return }
        setRunning(true)
        setNote(null)
        try {
          const r = await api.reviewTask({
            teamId,
            taskId,
            verdict: 'pass',
            ...(force ? { confirm: true, reason: reason.trim() } : {}),
          })
          setResult(r ?? null)
          if (r?.status === 'error') {
            if (r.code === 'MT_UNAVAILABLE') { setNoSubprocess(true); setNote(t('gate.verifyUnavailable')) }
            else if (r.code === 'MT_VERIFY_NO_COMMAND') setNote(t('gate.verifyNoCommand'))
            else setNote(r.message ?? r.code ?? t('gate.failed'))
            if (r.code !== 'MT_UNAVAILABLE' && r.code !== 'MT_VERIFY_NO_COMMAND') onError?.(r.message ?? r.code)
            return
          }
          setNote(force ? t('gate.verifyForced') : (r?.note ?? t('gate.done')))
          setReason('')
          await onDone?.()
        } catch (e) {
          const message = String(e?.message ?? e)
          setNote(message)
          onError?.(message)
        } finally {
          setRunning(false)
        }
      }
      const exitKnown = Boolean(result) && result.exitCode !== undefined && result.exitCode !== null
      return js('section', { className: 'mt-sec mt-gate-review', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: isVerifyGate ? t('gate.verifyTitle') : t('gate.title') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: gateLabel(gate) }),
        ] }),
        j('p', { className: 'mt-gate-current', children: t('gate.current').replace('{gate}', gateLabel(gate)).replace('{state}', stateLabel(state)) }),
        /* 越界写入黄条：**只警告不阻断**（FR-5.4） */
        scopeBad ? js('div', { className: 'mt-note mt-note-warn', role: 'status', children: [
          j('span', { children: t('scope.warn').replace('{n}', String(scopeAudit.outOfScope.length)).replace('{files}', scopeAudit.outOfScope.join('、')) }),
          j('span', { className: 'mt-hint', children: t('scope.warnNote') }),
        ] }) : null,
        /* ── verify 门：要执行的命令 + 运行结果 + 降级放行 ── */
        isVerifyGate ? js('div', { children: [
          j('p', { className: 'mt-hint', children: t('gate.verifyNote') }),
          verifyArgv.length > 0
            ? js('p', { className: 'mt-gate-cmd', children: [
              j('span', { children: t('gate.verifyCmd') }),
              j('code', { children: verifyArgv.join(' ') }),
              verifyCwd ? j('span', { className: 'mt-gate-cwd', children: t('gate.verifyCwd').replace('{cwd}', verifyCwd) }) : null,
            ] })
            : j('p', { className: 'mt-form-note', children: t('gate.verifyNoCommand') }),
          running ? j('p', { className: 'mt-gate-spin', role: 'status', children: t('gate.verifyRunning') }) : null,
          exitKnown ? js('div', { className: 'mt-gate-result', children: [
            js('div', { className: 'mt-gate-result-meta', children: [
              j('span', {
                className: 'mt-exit ' + (Number(result.exitCode) === 0 ? 'mt-exit-ok' : 'mt-exit-fail'),
                children: t('gate.verifyExit').replace('{code}', String(result.exitCode)),
              }),
              result.durationMs !== undefined && result.durationMs !== null
                ? j('span', { children: t('gate.verifyDuration').replace('{ms}', String(result.durationMs)) })
                : null,
              result.signal ? j('span', { children: t('gate.verifySignal').replace('{signal}', String(result.signal)) }) : null,
            ] }),
            j('span', { className: 'mt-hint', children: t('gate.verifyOutput') }),
            j('pre', { className: 'mt-ev-code', children: result.outputTail ? String(result.outputTail) : t('gate.verifyNoOutput') }),
          ] }) : null,
          /* 合同 §1.3：宿主没有 subprocess 服务 → 明确提示 + 人工强制放行（理由必填） */
          noSubprocess ? js('div', { children: [
            j('p', { className: 'mt-form-note', children: t('gate.verifyUnavailable') }),
            j('textarea', {
              className: 'mt-input mt-gate-reason',
              value: reason,
              rows: 2,
              placeholder: t('gate.reasonPlaceholder'),
              'aria-label': t('gate.reasonPlaceholder'),
              disabled: readOnly || busy || running,
              onChange: (e) => setReason(e.target.value),
            }),
            j('button', {
              className: 'mt-btn mt-btn-danger',
              disabled: readOnly || busy || running || !reason.trim(),
              title: readOnly ? t('task.readonlyTitle') : t('gate.verifyForce'),
              onClick: () => runVerify(true),
              children: t('gate.verifyForce'),
            }),
          ] }) : null,
        ] })
          : isArchiveGate
            ? j('p', { className: 'mt-hint', children: t('gate.archiveNote') })
            : js('div', { className: 'mt-form-row', children: [
              j('label', { htmlFor: 'mt-gate-reviewer', children: t('gate.reviewerLabel') }),
              js('select', {
                id: 'mt-gate-reviewer',
                className: 'mt-input',
                value: reviewer,
                disabled: readOnly || busy,
                'aria-describedby': selfReview ? 'mt-gate-selfreview' : undefined,
                onChange: (e) => { setReviewer(e.target.value); setNote(null) },
                children: [
                  j('option', { value: '', children: t('gate.reviewerPick') }),
                  ...list.map((member) => {
                    const self = member.id === implementer
                    return j('option', {
                      key: member.id,
                      value: member.id,
                      disabled: self,
                      title: self ? t('gate.selfReview') : undefined,
                      children: self ? `${member.name} · ${t('gate.selfReview')}` : member.name,
                    })
                  }),
                ],
              }),
            ] }),
        selfReview ? j('p', { id: 'mt-gate-selfreview', className: 'mt-hint mt-danger-ink', children: t('gate.selfReview') }) : null,
        /* 打回理由：review 门常显；verify 门只在降级放行时出现（上面那块） */
        needsRoster ? j('textarea', {
          className: 'mt-input mt-gate-reason',
          value: reason,
          rows: 2,
          placeholder: t('gate.reasonPlaceholder'),
          'aria-label': t('gate.reasonPlaceholder'),
          disabled: readOnly || busy,
          onChange: (e) => setReason(e.target.value),
        }) : null,
        js('div', { className: 'mt-detail-actions', role: 'toolbar', 'aria-label': t('gate.title'), children: [
          isVerifyGate
            ? j('button', {
              className: 'mt-btn mt-btn-primary',
              disabled: readOnly || busy || running || verifyArgv.length === 0,
              title: readOnly ? t('task.readonlyTitle') : t('gate.verifyRun'),
              onClick: () => runVerify(false),
              children: running ? t('gate.verifyRunning') : t('gate.verifyRun'),
            })
            : j('button', {
              className: 'mt-btn mt-btn-primary',
              disabled: readOnly || busy || (needsRoster && !reviewer) || selfReview,
              title: readOnly ? t('task.readonlyTitle') : isArchiveGate ? t('gate.archiveNote') : t('gate.pass'),
              onClick: () => submit('pass'),
              children: isArchiveGate ? t('gate.recheck') : t('gate.pass'),
            }),
          needsRoster ? j('button', {
            className: 'mt-btn mt-btn-danger',
            disabled: readOnly || busy || !reviewer || selfReview,
            title: readOnly ? t('task.readonlyTitle') : t('gate.fail'),
            onClick: () => submit('fail'),
            children: t('gate.fail'),
          }) : null,
        ] }),
        note ? j('p', { className: 'mt-form-note', role: 'status', children: note }) : null,
      ] })
    }

    /**
     * 写入范围审计（CHG-87 §2.3 / FR-5.4）：「声明范围 / 申报文件 / 越界文件」三段。
     * 无 `scopeAudit` 时**整块不渲染**；`ok === true` 显示 ✓ 未越界；越界只警告不阻断。
     */
    function ScopeAuditBlock({ t, audit }) {
      if (!audit || typeof audit !== 'object') return null
      const declared = Array.isArray(audit.writeScopes) ? audit.writeScopes.map(String) : []
      const files = Array.isArray(audit.declared) ? audit.declared.map(String) : []
      const out = Array.isArray(audit.outOfScope) ? audit.outOfScope.map(String) : []
      const ok = audit.ok === true
      const chip = (value, bad) => j('span', { key: value, className: bad ? 'mt-scope-chip mt-scope-chip-bad' : 'mt-scope-chip', children: value })
      const row = (key, label, values, empty = t('scope.empty'), bad = false) => js('div', { key, className: 'mt-scope-row', children: [
        j('span', { className: 'mt-scope-k', children: label }),
        j('span', { className: 'mt-scope-v', children: values.length > 0 ? values.map((value) => chip(value, bad)) : [j('span', { className: 'mt-hint', children: empty })] }),
      ] })
      return js('section', { className: 'mt-sec mt-scope-audit', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('scope.title') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: ok ? 'mt-n mt-scope-ok' : 'mt-n mt-scope-bad', children: ok ? t('scope.ok') : t('scope.bad').replace('{n}', String(out.length)) }),
        ] }),
        row('declared', t('scope.declared'), declared),
        row('files', t('scope.files'), files),
        row('out', t('scope.outOfScope'), out, t('scope.empty'), true),
        audit.checkedAt ? j('p', { className: 'mt-hint', children: t('scope.checkedAt').replace('{time}', fmtClock(audit.checkedAt)) }) : null,
      ] })
    }

    /* ── 任务详情（design/detail.html）：主区整页 = 面包屑 + 主列/侧列 + 成本归因 ── */
    // T25：离线团队走 loader（getOfflineTaskDetail），readOnly=true 时隐藏沟通输入
    // CHG-73：动作条（重新规划/取消/编辑）+ 证据过期横幅 + 改动记录折叠区 + 取消横幅
    function TaskDetail({ api, t, teamId, taskId, onClose, readOnly, loader, memberName, teamName, members, onEdit, onRescope, onCancel, refreshToken, onDiagnosisFixed }) {
      const load = loader ?? ((q) => api.getTaskDetail(q))
      const [detail, setDetail] = react.useState(null)
      /* 门禁裁决成功后就地重载详情（不整页刷新、不关抽屉） */
      const [gateToken, setGateToken] = react.useState(0)
      const [comment, setComment] = react.useState('')
      const [sent, setSent] = react.useState(false)
      /* FR-8.3：任务级成本归因（best-effort；离线团队 / 无 token 侧车时为 null） */
      const [cost, setCost] = react.useState(undefined)
      react.useEffect(() => {
        let alive = true
        load({ teamId, taskId }).then((r) => { if (alive) setDetail(r?.detail ?? null) }).catch(() => {})
        return () => { alive = false }
      }, [teamId, taskId, refreshToken, gateToken])
      react.useEffect(() => {
        let alive = true
        if (readOnly || !api || typeof api.getTokens !== 'function') { setCost(null); return () => { alive = false } }
        api.getTokens({ teamId })
          .then((r) => { if (alive) setCost(r?.status === 'ok' ? (r.tokens ?? null) : null) })
          .catch(() => { if (alive) setCost(null) })
        return () => { alive = false }
      }, [teamId, readOnly, refreshToken])
      const closeBtn = j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') })
      if (!detail) {
        return js('div', { className: 'mt-detail-page', children: [
          js('nav', { className: 'mt-crumbbar', 'aria-label': t('detail.crumb'), children: [
            j('span', { className: 'mt-cur', children: taskId }),
            j('span', { className: 'mt-crumb-gap' }),
            closeBtn,
          ] }),
          j('div', { className: 'mt-empty', children: t('state.loading') }),
        ] })
      }
      const post = async () => {
        if (readOnly || !comment.trim()) return
        await api.postComment({ teamId, taskId, content: comment.trim() })
        setComment(''); setSent(true)
        const r = await api.getTaskDetail({ teamId, taskId })
        setDetail(r.detail ?? null)
      }
      // CHG-63：证据块结构化渲染（按 attempt 分组；命令 + 退出码 + 断言/耗时，na 给理由）
      const renderEvidence = (ev) => {
        const e = ev.evidence ?? {}
        if (e.kind === 'commands' && Array.isArray(e.commands)) {
          return js('ul', { className: 'mt-cmds', children: e.commands.map((c, i) => {
            const okExit = Number(c.exitCode) === 0
            const meta = [`${t('detail.exitCode')} ${c.exitCode}`]
            if (c.assertions !== undefined && c.assertions !== null) meta.push(`${t('detail.assertions')} ${c.assertions}`)
            if (c.durationMs) meta.push(humanMs(c.durationMs))
            return js('li', { key: i, children: [
              j('span', { className: 'mt-exit ' + (okExit ? 'mt-exit-ok' : 'mt-exit-fail'), children: String(c.exitCode) }),
              j('code', { className: 'mt-cmd', children: String(c.cmd ?? '') }),
              j('span', { className: 'mt-hint', children: fmtClock(ev.ts) }),
              j('span', { className: 'mt-ev-meta', children: meta.join(' · ') }),
            ] })
          }) })
        }
        if (e.kind === 'na') return j('div', { className: 'mt-hint', children: `N/A · ${e.na?.reason ?? '—'}` })
        return j('pre', { className: 'mt-ev-code', children: JSON.stringify(e, null, 1) })
      }
      const evidenceGroups = new Map()
      for (const ev of detail.evidenceRefs ?? []) {
        const key = ev.attemptId ?? '—'
        if (!evidenceGroups.has(key)) evidenceGroups.set(key, [])
        evidenceGroups.get(key).push(ev)
      }
      const acts = detail.actions ?? {}
      const stale = detail.evidenceStale
      const cancellation = detail.cancellation
      /** 动作按钮的禁用说明（只读优先，其次「当前状态不可用」） */
      const actionTitle = (allowed, label) => (readOnly ? t('task.readonlyTitle') : allowed === false ? t('action.unavailable') : label)
      const input = detail.input ?? {}
      const acs = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []
      const deps = Array.isArray(input.deps) ? input.deps : []
      const gates = detail.gates ?? []
      const participants = detail.participants ?? []
      const timeline = detail.timeline ?? []
      const messages = detail.messages ?? []
      const deliverables = detail.deliverables ?? []
      const assignees = detail.assignees ?? (detail.assignee ? [detail.assignee] : [])
      const evidenceRefs = detail.evidenceRefs ?? []
      const attemptNo = Number(detail.escalateCount ?? 0) + 1
      const leadCount = participants.filter((party) => party.role === 'lead').length
      const coopCount = participants.length - leadCount
      /* 验收标准逐条 pass：证据载荷带 acs（1 基序号）时以它为准；任务已完成 = 全部通过 */
      const verifiedAcs = new Set()
      for (const item of evidenceRefs) {
        const raw = item?.evidence?.acs
        if (Array.isArray(raw)) for (const n of raw) verifiedAcs.add(Number(n))
      }
      const taskDone = String(detail.state ?? '') === 'done'
      const acPass = (index) => taskDone || verifiedAcs.has(index + 1)
      const acPassCount = acs.filter((ac, index) => acPass(index)).length
      const acEvidence = (index) => evidenceRefs.find((item) => Array.isArray(item?.evidence?.acs) && item.evidence.acs.map(Number).includes(index + 1))
      /* 成本归因（FR-8.3）：按 tokenMeter 用量比例分摊到本任务的负责队员，非精确计量 */
      const totals = cost?.totals ?? {}
      const sumBuckets = (ids) => {
        const sum = { calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        for (const id of ids) for (const key of Object.keys(sum)) sum[key] += Number(totals[id]?.[key] ?? 0)
        return sum
      }
      const taskSum = sumBuckets(assignees)
      const teamSum = sumBuckets(Object.keys(totals))
      const tokenCount = (bucket) => Number(bucket.uncachedInput ?? 0) + Number(bucket.cacheRead ?? 0) + Number(bucket.cacheWrite ?? 0) + Number(bucket.output ?? 0)
      const fmtTok = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value))
      /** 已跑时长（design「已跑 12m」的形态：秒 / 分 / 时+分） */
      const fmtElapsed = (ms) => {
        const total = Math.max(0, Number(ms) || 0)
        const minutes = Math.floor(total / 60000)
        if (minutes < 1) return `${Math.max(1, Math.round(total / 1000))}s`
        if (minutes < 60) return `${minutes}m`
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      }
      const hitRateOf = (bucket) => {
        const denom = Number(bucket.uncachedInput ?? 0) + Number(bucket.cacheRead ?? 0) + Number(bucket.cacheWrite ?? 0)
        return denom > 0 ? `${((Number(bucket.cacheRead ?? 0) / denom) * 100).toFixed(1)}%` : '—'
      }
      const costKnown = cost !== undefined && cost !== null
      const teamTokens = tokenCount(teamSum)
      /* 时间线节点语义（H4：形状 + 文字；颜色只作第三顺位） */
      const tlTone = (type) => {
        const raw = String(type ?? '')
        if (raw.includes('completed') || raw.includes('approved') || raw.includes('adopted')) return 'mt-tl-ok'
        if (raw.includes('failed') || raw.includes('escalated') || raw.includes('cancelled') || raw.includes('blocked')) return 'mt-tl-warn'
        if (raw.includes('claimed') || raw.includes('progress') || raw.includes('gate') || raw.includes('evidence')) return 'mt-tl-run'
        return ''
      }
      return js('div', { className: 'mt-detail-page', children: [
        /* 面包屑（design .crumbbar）：看板 / 当前阶段 / 任务号 */
        js('nav', { className: 'mt-crumbbar', 'aria-label': t('detail.crumb'), children: [
          j('button', { className: 'mt-crumb-link', onClick: onClose, children: [j('span', { 'aria-hidden': true, children: '‹' }), j('span', { children: t('detail.crumbBoard') })] }),
          j('span', { className: 'mt-crumb-sep', 'aria-hidden': true, children: '/' }),
          j('span', { children: stateLabel(detail.state) }),
          j('span', { className: 'mt-crumb-sep', 'aria-hidden': true, children: '/' }),
          j('span', { className: 'mt-cur', children: detail.id }),
          j('span', { className: 'mt-crumb-gap' }),
          readOnly ? j('span', { className: 'mt-chip', children: t('global.offline') }) : null,
          closeBtn,
        ] }),
        js('div', { className: 'mt-detail-grid', children: [
          /* ── 主列 ── */
          js('div', { className: 'mt-detail-main', children: [
            /* 标题区：眉标（任务号 · 第 N 次尝试 · 由谁认领）+ 标题 + 标签 + 描述 */
            js('div', { className: 'mt-sec', children: [
              j('div', { children: [
                j('div', { className: 'mt-detail-eyebrow', children: `${detail.id} · ${t('detail.attemptN').replace('{n}', String(attemptNo))}${input.requiredRole ? ` · ${t('detail.claimedBy').replace('{role}', roleLabel(String(input.requiredRole)))}` : ''}` }),
                j('h1', { className: 'mt-detail-title', children: input.title ?? detail.id }),
                js('div', { className: 'mt-drawer-tags', children: [
                  js('span', { className: 'mt-chip', children: [j('span', { className: stateDotClass(detail.state), 'aria-hidden': true }), j('span', { children: stateLabel(detail.state) })] }),
                  input.priority ? j('span', { className: 'mt-detail-pill', children: String(input.priority) }) : null,
                  detail.createdAt ? j('span', { className: 'mt-mini-chip', children: t('detail.elapsed').replace('{time}', fmtElapsed(Date.now() - detail.createdAt)) }) : null,
                  input.estimate ? j('span', { className: 'mt-mini-chip', children: t('detail.estimate').replace('{value}', String(input.estimate)) }) : null,
                  costKnown ? j('span', { className: 'mt-mini-chip', children: t('detail.toolCalls').replace('{n}', String(taskSum.calls)) }) : null,
                ] }),
              ] }),
              input.description ? j('p', { className: 'mt-detail-desc', children: String(input.description) }) : null,
            ] }),
        stale ? js('div', { className: 'mt-banner mt-banner-stale', role: 'status', children: [
          j('span', {
            children: t('detail.evidenceStale')
              .replace('{fields}', fieldListText(t, stale.fields))
              .replace('{time}', fmtClock(stale.since)),
          }),
        ] }) : null,
        cancellation ? js('div', { className: 'mt-banner mt-banner-cancel', role: 'status', children: [
          j('span', {
            children: `${t('detail.cancelled').replace('{time}', fmtClock(cancellation.ts)).replace('{reason}', cancellation.reason || '—')} · ${cancellation.downstream === 'cancel' ? t('detail.cancelCascade') : cancellation.downstream === 'rewire' ? t('detail.cancelRewire') : t('detail.cancelLeave')}`,
          }),
        ] }) : null,
        /* CHG-75：依赖被改挂过（原上游已取消，依赖改到新上游或解除） */
        detail.rewiredFrom ? js('div', { className: 'mt-banner mt-banner-rewired', role: 'status', children: [
          j('span', {
            children: detail.rewiredFrom.added
              ? t('detail.rewiredTo').replace('{from}', String(detail.rewiredFrom.removed)).replace('{to}', String(detail.rewiredFrom.added))
              : t('detail.rewiredFree').replace('{from}', String(detail.rewiredFrom.removed)),
          }),
        ] }) : null,
            j(DiagChips, { t, diagnosis: detail.diagnosis }),
            /* CHG-76 C：诊断一键修复（assignable → 一键指派 / roleSwap → 改用已有人角色 / spawnRole → 纯提示） */
            j(DiagFix, { t, api, teamId, taskId, diagnosis: detail.diagnosis, readOnly, onFixed: onDiagnosisFixed, expectedRevision: detail.revision }),
            /* 门禁裁决（CHG-86 / M2-C）：任务处于 gate:* 时的唯一人工裁决入口 */
            j(GateReview, {
              t,
              api,
              teamId,
              taskId,
              detail,
              readOnly,
              memberName,
              members,
              onDone: () => setGateToken((value) => value + 1),
              onError: onDiagnosisFixed,
            }),
            /* 写入范围审计（CHG-87 §2.3 / FR-5.4）：紧跟在门禁区下方；无 scopeAudit 时整块不渲染 */
            j(ScopeAuditBlock, { t, audit: detail.scopeAudit }),
            /* 验收标准：逐条 pass 标记（证据带 acs 时以证据为准；任务已完成 = 全通过） */
            acs.length > 0 ? js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.ac') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.acVerified').replace('{pass}', String(acPassCount)).replace('{total}', String(acs.length)) }),
              ] }),
              j('ul', { className: 'mt-ac-list', children: acs.map((ac, index) => {
                const ok = acPass(index)
                const evidence = ok ? acEvidence(index) : undefined
                return js('li', { key: index, className: 'mt-ac ' + (ok ? 'mt-ac-pass' : 'mt-ac-pending'), children: [
                  j('span', { className: 'mt-ac-mark', 'aria-hidden': true, children: ok ? '✓' : String(index + 1) }),
                  js('span', { children: [
                    j('span', { children: ac }),
                    evidence ? j('span', { className: 'mt-ac-note', children: t('detail.acEvidence').replace('{time}', fmtClock(evidence.ts)).replace('{seq}', String(evidence.seq)) }) : null,
                  ] }),
                ] })
              }) }),
            ] }) : null,
            /* 验证证据：按 attempt 分组（命令 + 退出码 + 断言/耗时 + 时间） */
            js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.evidence') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.evidenceHead').replace('{attempt}', String(attemptNo)).replace('{n}', String(evidenceRefs.length)) }),
              ] }),
              evidenceRefs.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.evidenceEmpty') })
                : js('div', { className: 'mt-evidence', children: [...evidenceGroups.entries()].map(([attempt, list]) => js('div', { key: attempt, className: 'mt-evgroup', children: [
                  js('div', { className: 'mt-evgroup-head', children: [
                    j('strong', { children: t('detail.attemptGroup').replace('{id}', attempt) }),
                    j('span', { className: 'mt-hint', children: list.length > 1 ? `#${list[0].seq} … #${list[list.length - 1].seq}` : `#${list[0].seq}` }),
                  ] }),
                  ...list.map((ev) => j('div', { key: ev.seq, className: 'mt-evitem', children: renderEvidence(ev) })),
                ] })) }),
            ] }),
            /* 时间线（design .timeline）：账本派生，新→旧，最多 20 条 */
            timeline.length > 0 ? js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.timeline') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: String(timeline.length) }),
              ] }),
              j('ul', { className: 'mt-timeline', children: [...timeline].slice(-20).reverse().map((event) => js('li', { key: event.seq, className: 'mt-tl ' + tlTone(event.type), children: [
                js('div', { className: 'mt-tl-row', children: [
                  j('span', { className: 'mt-seq', children: `#${event.seq}` }),
                  j('b', { title: event.type, children: eventLabel(event.type) }),
                  j('span', { className: 'mt-actor', children: actorLabel(event.actor, memberName) }),
                  j('span', { className: 'mt-tl-time', children: fmtClock(event.ts) }),
                ] }),
              ] })) }),
            ] }) : null,
            /* 交付物（FR-10.4）：叶子任务必填 */
            deliverables.length > 0 ? js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.deliverables') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: String(deliverables.length) }),
              ] }),
              j('ul', { className: 'mt-deliverables', children: deliverables.map((item) => j('li', { key: String(item.seq), children: item.path })) }),
            ] }) : null,
            /* CHG-73：改动记录（新→旧，最多 20 条；字段中文名 + 旧→新 + actor + 时间 + 理由） */
            j(EditHistory, { t, edits: detail.edits ?? [], memberName }),
            /* 沟通 thread（FR-12.2）：账本派生，留言以 human 身份落账 */
            js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.thread') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.threadCount').replace('{n}', String(messages.length)) }),
              ] }),
              messages.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.threadEmpty') })
                : js('div', { className: 'mt-thread', children: messages.map((message) => {
                  const human = String(message.actor ?? '') === 'human'
                  return js('div', { key: message.seq, className: 'mt-msg', children: [
                    j('span', { className: 'mt-msg-av' + (human ? ' mt-msg-av-human' : ''), 'aria-hidden': true, children: human ? t('detail.humanAvatar') : String(actorLabel(message.actor, memberName)).slice(0, 1) }),
                    js('div', { className: 'mt-msg-body', children: [
                      js('div', { className: 'mt-msg-meta', children: [
                        j('b', { children: actorLabel(message.actor, memberName) }),
                        j('span', { children: fmtClock(message.ts) }),
                      ] }),
                      j('p', { className: 'mt-msg-text', children: eventLabel(message.type) }),
                    ] }),
                  ] })
                }) }),
              js('div', { className: 'mt-composer-mini', children: [
                readOnly
                  ? j('span', { className: 'mt-hint', children: t('offline.readonlyTip') })
                  : j('input', { id: 'mt-detail-comment', value: comment, placeholder: t('detail.commentPlaceholder'), 'aria-label': t('detail.commentPlaceholder'), onChange: (e) => setComment(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') post() } }),
                readOnly ? null : j('button', { className: 'mt-send-btn', onClick: post, title: t('action.send'), 'aria-label': t('action.send'), children: '➤' }),
                sent ? j('span', { className: 'mt-ok', children: t('detail.commentSent') }) : null,
              ] }),
            ] }),
          ] }),
          /* ── 侧列 ── */
          js('aside', { className: 'mt-detail-side', children: [
            /* 参与团队（FR-21）：任务与团队是多对多关系，主责 1 / 协作 N */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: `${t('detail.participants')} · ${participants.length}` }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.participantsCount').replace('{lead}', String(leadCount)).replace('{coop}', String(coopCount)) }),
              ] }),
              ...participants.map((party) => js('div', { key: party.teamId, className: 'mt-tc-card', children: [
                js('div', { className: 'mt-tc-head', children: [
                  j('span', { className: 'mt-tc-name', children: teamName?.(party.teamId) || party.teamId }),
                  js('span', { className: 'mt-chip ' + (party.role === 'lead' ? 'mt-chip-run' : 'mt-chip-idle'), children: [
                    j('span', { className: 'mt-task-dot' + (party.role === 'lead' ? '-active' : ''), 'aria-hidden': true }),
                    j('span', { children: party.role === 'lead' ? t('task.owner') : t('task.coop') }),
                  ] }),
                  j('span', { className: 'mt-tc-zone', children: party.teamId }),
                ] }),
                j('p', { className: 'mt-tc-desc', children: (party.memberIds ?? []).length > 0 ? `${t('detail.teamMembers')} · ${(party.memberIds ?? []).map((id) => memberName?.(id) ?? id).join('、')}` : t('detail.teamMembersEmpty') }),
              ] })),
              /* design .btn.sm 并排两颗：私讯（聚焦留言框）/ 进入团队（回到看板） */
              participants.length > 0 ? js('div', { className: 'mt-tc-actions', children: [
                j('button', {
                  className: 'mt-btn',
                  title: t('detail.messageMember'),
                  onClick: () => { if (typeof document !== 'undefined' && document.getElementById) document.getElementById('mt-detail-comment')?.focus() },
                  children: t('detail.messageMember'),
                }),
                j('button', {
                  className: 'mt-btn',
                  title: t('detail.enterTeamHint'),
                  onClick: onClose,
                  children: t('detail.enterTeam'),
                }),
              ] }) : null,
              assignees.length > 0 ? js('div', { className: 'mt-detail-meta', children: [
                j('span', { className: 'mt-detail-pill', title: assignees.join(', '), children: `${t('detail.assignees')} ${assignees.map((id) => memberName?.(id) ?? id).join('、')}` }),
                input.requiredRole ? j('span', { className: 'mt-detail-pill', children: `${t('detail.role')} ${roleLabel(String(input.requiredRole))}` }) : null,
                detail.attemptId ? j('span', { className: 'mt-detail-pill', children: `${t('detail.attempt')} ${detail.attemptId}` }) : null,
              ] }) : null,
              j('div', { className: 'mt-hint', children: t('detail.assigneeNote') }),
            ] }),
            /* 依赖关系：上游（全部完成才会被领取）；design 标题「依赖关系」不带计数 */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.depsTitle') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
              ] }),
              deps.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.depsEmpty') })
                : js('div', { className: 'mt-dt-rows', children: deps.map((dep) => js('div', { key: dep, className: 'mt-dt-row', children: [
                  j('span', { className: 'mt-mini-chip', children: t('detail.depsUpstream') }),
                  j('span', { className: 'mt-dt-dep-id', title: String(dep), children: String(dep) }),
                ] })) }),
              j('div', { className: 'mt-hint', children: t('detail.depsHint') }),
            ] }),
            /* 门禁链（CHG-47）：走到了哪一道门 + 逐门裁决 */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.gatesTitle') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.gatesCount').replace('{n}', String(gates.length)) }),
              ] }),
              gates.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.gatesEmpty') })
                : js('div', { className: 'mt-dt-rows', children: gates.map((gate) => {
                  const verdict = detail.gateVerdicts?.[gate]
                  /* CHG-93：最近一次裁决的完整摘要（executedBy / forcedBy / 退出码） */
                  const gateResult = detail.gateResults?.[gate]
                  const label = verdict === 'pass' ? t('detail.gatePass') : verdict === 'fail' ? t('detail.gateFail') : t('detail.gatePending')
                  return js('div', { key: gate, className: 'mt-dt-row', children: [
                    js('div', { className: 'mt-dt-row-main', children: [
                      j('div', { className: 'mt-dt-row-title', children: gateLabel(gate) }),
                      j('div', { className: 'mt-dt-row-sub', children: [
                        label,
                        /* CHG-93：可信度徽标——「谁跑的 / 是不是人硬放的」直接决定结论分量 */
                        gateResult?.executedBy === 'host'
                          ? j('span', { className: 'mt-mini-chip mt-chip-executed', title: t('detail.gateExecutedByHint'), children: t('detail.gateExecutedByHost') })
                          : null,
                        gateResult?.forcedBy === 'human'
                          ? j('span', { className: 'mt-mini-chip mt-chip-forced', title: t('detail.gateForcedByHint'), children: t('detail.gateForcedByHuman') })
                          : null,
                      ] }),
                    ] }),
                    j('span', { className: 'mt-gate' + (verdict ? ` mt-gate-${verdict}` : ''), children: verdict === 'pass' ? t('detail.gatePass') : label }),
                  ] })
                }) }),
            ] }),
            /* 成本归因（FR-8.3）：一律标「估算」——按 tokenMeter 用量比例分摊，非精确计量 */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.cost') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-mini-chip', children: t('detail.costEstimate') }),
              ] }),
              /* design 的四行常显：没有 token 侧车时值留「—」，不造假数据 */
              js('div', { children: [
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costTask') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? fmtTok(tokenCount(taskSum)) : '—' }),
                ] }),
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costHit') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? hitRateOf(taskSum) : '—' }),
                ] }),
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costMiss') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? `${fmtTok(taskSum.uncachedInput)} / ${fmtTok(taskSum.output)}` : '—' }),
                ] }),
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costShare') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? `${fmtTok(tokenCount(taskSum))} / ${fmtTok(teamTokens)}` : '—' }),
                ] }),
                j('p', { className: 'mt-hint', children: t('detail.costNote') }),
                costKnown ? null : j('p', { className: 'mt-hint', children: t('detail.costUnavailable') }),
              ] }),
            ] }),
            /* 任务操作：重新规划 / 编辑 / 取消（RPC 动作一个不丢） */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.ops') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
              ] }),
              js('div', { className: 'mt-detail-actions', role: 'toolbar', 'aria-label': t('detail.actions'), children: [
                j('button', {
                  className: 'mt-btn',
                  disabled: readOnly || acts.rescope === false,
                  title: actionTitle(acts.rescope, t('task.rescope')),
                  onClick: () => onRescope?.(detail),
                  children: t('task.rescope'),
                }),
                j('button', {
                  className: 'mt-btn',
                  disabled: readOnly || acts.edit === false || !onEdit,
                  title: actionTitle(onEdit ? acts.edit : false, t('task.edit')),
                  onClick: () => onEdit?.(detail),
                  children: t('task.edit'),
                }),
                j('button', {
                  className: 'mt-btn mt-btn-danger',
                  disabled: readOnly || acts.cancel === false,
                  title: actionTitle(acts.cancel, t('detail.cancelTaskBtn')),
                  onClick: () => onCancel?.(detail),
                  children: t('detail.cancelTaskBtn'),
                }),
              ] }),
              j('p', { className: 'mt-hint', children: t('detail.cancelNote') }),
            ] }),
          ] }),
        ] }),
      ] })
    }

    /* ── 丢弃暂存计划的两段确认（design/discard.html）──
     * 影响面（N 任务作废 / 归档路径 / 不产生 token）+ 引导改用 Revise；
     * 影响面的计数从 getBoard 现算（单一事实源，不缓存第二份）。 */
    function DiscardDialog({ t, api, teamId, staged, onClose, onDone }) {
      const [board, setBoard] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      react.useEffect(() => {
        let alive = true
        if (!api || typeof api.getBoard !== 'function') { setBoard(null); return () => { alive = false } }
        api.getBoard({ teamId })
          .then((r) => { if (alive) setBoard(r?.board ? r : null) })
          .catch(() => { if (alive) setBoard(null) })
        return () => { alive = false }
      }, [api, teamId])
      const tasks = (board?.board?.columns ?? []).reduce((sum, column) => sum + (column.tasks ?? []).length, 0)
      const members = (board?.board?.members ?? []).length
      const planId = staged?.planId ?? 'plan-latest'
      const confirm = async () => {
        if (busy) return
        setBusy(true); setErr(null)
        try {
          const r = await api.planAction({ teamId, action: 'discard', planId, confirm: true })
          if (r?.status === 'error' || r?.ok === false) { setErr(t('discard.failed').replace('{msg}', String(r?.message ?? r?.code ?? '—'))); return }
          onDone?.(r)
        } catch (e) {
          setErr(t('discard.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-overlay', children: js('div', {
        className: 'mt-dialog',
        role: 'alertdialog',
        'aria-modal': true,
        'aria-labelledby': 'mt-discard-title',
        'aria-describedby': 'mt-discard-impact',
        children: [
          js('div', { className: 'mt-dialog-head', children: [
            js('div', { className: 'mt-dialog-steps', children: [
              js('span', { className: 'mt-mini-chip mt-mini-chip-gate', children: [
                j('span', { 'aria-hidden': true, children: '◆' }),
                j('span', { children: t('discard.step') }),
              ] }),
            ] }),
            j('strong', { id: 'mt-discard-title', children: t('discard.title') }),
            j('p', { className: 'mt-hint', children: t('discard.desc') }),
          ] }),
          js('div', { className: 'mt-dialog-body', children: [
            js('div', { className: 'mt-impact mt-impact-gate', id: 'mt-discard-impact', children: [
              j('b', { children: t('discard.impactTitle') }),
              js('ul', { children: [
                j('li', { children: t('discard.impactTasks').replace('{n}', String(tasks)).replace('{path}', `archive/${teamId}/`) }),
                j('li', { children: t('discard.impactState') }),
                j('li', { children: t('discard.impactNoToken') }),
                j('li', { children: t('discard.impactKeep') }),
              ] }),
            ] }),
            /* design .rows 的「计划摘要」是一张有边框的整块卡 */
            js('div', { className: 'mt-dt-summary', children: [
              j('div', { className: 'mt-dt-summary-title', children: t('discard.summary') }),
              j('div', { className: 'mt-dt-summary-sub', children: t('discard.summaryText').replace('{tasks}', String(tasks)).replace('{members}', String(members)).replace('{planId}', planId) }),
            ] }),
            j('p', { className: 'mt-dialog-note', children: t('discard.reviseHint') }),
            err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
          ] }),
          js('div', { className: 'mt-dialog-foot', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('discard.archive') }),
            js('div', { className: 'mt-right', children: [
              j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
              j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: confirm, children: busy ? t('state.loading') : t('discard.discardBtn') }),
            ] }),
          ] }),
        ],
      }) })
    }

    /* ── 解散团队的两段确认（design/confirm.html）──
     * 四条不可撤销影响 + 输入团队 ID 才能提交 + 「改用归档」出口；
     * 第一段（confirm:false 拿影响面）由调用方 askDisband 完成，本组件只做第二段。 */
    function DisbandDialog({ t, teamId, teamName, impact, busy, error, onConfirm, onClose, onArchive }) {
      const [typed, setTyped] = react.useState('')
      const [hint, setHint] = react.useState(null)
      /* 排空影响面：`impact.drained` 目前是 host 侧硬编码的 {running:0,pending:0}，
       * 这里不把它当真实值——缺失时显示「—」占位（impactCountText），有值时如实渲染。 */
      const drained = impact?.drained
      const members = impactCountText(impact?.members)
      const tasks = impactCountText(impact?.tasks)
      const matched = String(typed).trim() === String(teamId ?? '')
      const needId = t('disband.needId').replace('{teamId}', String(teamId ?? ''))
      return js('div', { className: 'mt-overlay', children: js('div', {
        className: 'mt-dialog',
        role: 'alertdialog',
        'aria-modal': true,
        'aria-labelledby': 'mt-disband-title',
        'aria-describedby': 'mt-disband-impact',
        children: [
          js('div', { className: 'mt-dialog-head', children: [
            js('div', { className: 'mt-dialog-steps', children: [
              js('span', { className: 'mt-mini-chip mt-mini-chip-fail', children: [
                j('span', { 'aria-hidden': true, children: '⚠' }),
                j('span', { children: t('disband.irreversible') }),
              ] }),
              j('span', { className: 'mt-hint', children: t('disband.step') }),
            ] }),
            j('strong', { id: 'mt-disband-title', children: t('disband.title').replace('{name}', String(teamName || teamId || '')) }),
            j('p', { className: 'mt-hint', children: t('disband.desc') }),
          ] }),
          js('div', { className: 'mt-dialog-body', children: [
            js('div', { className: 'mt-impact', id: 'mt-disband-impact', children: [
              j('b', { children: t('disband.impactTitle') }),
              js('ul', { children: [
                j('li', { children: t('disband.impactMembers').replace('{n}', String(members)) }),
                j('li', { children: t('disband.impactTasks').replace('{n}', String(tasks)) }),
                drained ? j('li', { children: t('disband.impactDrained').replace('{running}', impactCountText(drained.running)).replace('{pending}', impactCountText(drained.pending)) }) : null,
                j('li', { children: t('disband.impactArchive') }),
                j('li', { children: t('disband.impactPrivate') }),
              ] }),
            ] }),
            js('div', { className: 'mt-form-row', children: [
              j('label', { htmlFor: 'mt-disband-input', children: t('disband.inputLabel') }),
              j('input', {
                id: 'mt-disband-input',
                className: 'mt-input',
                value: typed,
                placeholder: String(teamId ?? ''),
                'aria-invalid': !matched && String(typed).length > 0,
                onChange: (e) => { setTyped(e.target.value); setHint(null) },
              }),
            ] }),
            j('p', { className: 'mt-dialog-note', children: t('disband.inputHint') }),
            hint ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: hint }) : null,
            error ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: error }) : null,
          ] }),
          js('div', { className: 'mt-dialog-foot', children: [
            j('button', {
              className: 'mt-btn',
              onClick: () => { if (onArchive) { onArchive(); return } setHint(t('disband.archiveHint')) },
              children: t('disband.archive'),
            }),
            js('div', { className: 'mt-right', children: [
              j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
              j('button', {
                className: 'mt-btn mt-btn-danger',
                disabled: busy || !matched,
                title: matched ? undefined : needId,
                onClick: () => { if (!matched) { setHint(needId); return } onConfirm?.() },
                children: busy ? t('state.loading') : t('disband.confirm'),
              }),
            ] }),
          ] }),
        ],
      }) })
    }

    /* ── 暂存横幅三动作（FR-1.2：面板唯一写入口）──
     * CHG-82（G1）：Discard 换成 design/discard.html 的两段确认对话框（不再用 window.confirm） */
    function StagedBanner({ api, t, teamId, inbox, onAct }) {
      const [discard, setDiscard] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      if (!inbox?.staged) return null
      const planId = inbox.staged.planId
      const act = async (action) => {
        if (busy) return
        setErr(null)
        try {
          if (action === 'discard') {
            /* 两段确认第一段：服务端只回 confirm-required，影响面由 DiscardDialog 用 getBoard 现算 */
            const first = await api.planAction({ teamId, action, planId, confirm: false })
            if (first?.status === 'confirm-required') { setDiscard({ planId }); return }
            if (first?.status === 'error') { setErr(String(first?.message ?? first?.code ?? 'plan action failed')); return }
            onAct()
            return
          }
          setBusy(true)
          const r = await api.planAction({ teamId, action, planId })
          if (r?.status === 'error') { setErr(String(r?.message ?? r?.code ?? 'plan action failed')); return }
          onAct()
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-banner', role: 'alert', children: [
        js('span', { children: [`${t('banner.staged')}（`, inbox.staged.state === 'draft' ? '草稿' : inbox.staged.state, `）— ${t('banner.waiting')}`] }),
        js('span', { className: 'mt-banner-actions', children: [
          j('button', { className: 'mt-btn mt-btn-primary', disabled: busy, onClick: () => act('approve'), children: t('action.approve') }),
          j('button', { className: 'mt-btn', disabled: busy, onClick: () => act('revise'), children: t('action.revise') }),
          j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: () => act('discard'), children: t('action.discard') }),
        ] }),
        err ? j('span', { className: 'mt-hint', children: err }) : null,
        discard ? j(DiscardDialog, { t, api, teamId, staged: discard, onClose: () => setDiscard(null), onDone: () => { setDiscard(null); onAct() } }) : null,
      ] })
    }

    /* ── 成本 tab（FR-8.2/8.4，CHG-47）：四桶 + 命中率；在线读侧车，离线读 tokens.json ── */
    function TokensTab({ t, tokens, members, emptyText }) {
      if (tokens === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (!tokens) return j('div', { className: 'mt-empty', children: emptyText ?? t('cost.empty') })
      const totals = tokens.totals ?? {}
      const ids = Object.keys(totals)
      const nameOf = (id) => (members ?? []).find((m) => m.id === id)?.instanceName ?? id
      const fmt = (n) => Number(n ?? 0).toLocaleString()
      const pct = (h) => (h === null || h === undefined ? '—' : `${(h * 100).toFixed(1)}%`)
      const sum = { calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const id of ids) for (const key of Object.keys(sum)) sum[key] += Number(totals[id]?.[key] ?? 0)
      const denom = sum.uncachedInput + sum.cacheRead + sum.cacheWrite
      const sumHit = denom === 0 ? null : sum.cacheRead / denom
      const rows = [...ids].sort((a, b) => Number(totals[b]?.calls ?? 0) - Number(totals[a]?.calls ?? 0))
      const cell = (value, key) => j('td', { key, children: value })
      return js('div', { className: 'mt-cost', children: [
        js('div', { className: 'mt-cost-head', children: [
          j('h3', { children: t('cost.total') }),
          tokens.updatedAt ? j('span', { className: 'mt-hint', children: t('cost.updated').replace('{time}', relTime(tokens.updatedAt, t)) }) : null,
          j('span', { className: 'mt-hint', children: `${t('cost.calls')} ${fmt(sum.calls)} · ${t('cost.output')} ${fmt(sum.output)}` }),
        ] }),
        js('div', { className: 'mt-cost-scroll', children: [
          js('table', { className: 'mt-cost-table', children: [
            j('thead', { children: j('tr', { children: [t('cost.member'), t('cost.calls'), t('cost.uncached'), t('cost.cacheRead'), t('cost.cacheWrite'), t('cost.output'), t('cost.hit')].map((h, i) => j('th', { key: `${i}`, children: h })) }) }),
            j('tbody', { children: [
              ...rows.map((id) => js('tr', { children: [
                cell(nameOf(id), 'name'),
                cell(fmt(totals[id]?.calls), 'calls'),
                cell(fmt(totals[id]?.uncachedInput), 'uncached'),
                cell(fmt(totals[id]?.cacheRead), 'cacheRead'),
                cell(fmt(totals[id]?.cacheWrite), 'cacheWrite'),
                cell(fmt(totals[id]?.output), 'output'),
                cell(pct(totals[id]?.hitRate), 'hit'),
              ] }, id)),
              js('tr', { className: 'mt-cost-sum', children: [
                cell(t('cost.total'), 'name'),
                cell(fmt(sum.calls), 'calls'),
                cell(fmt(sum.uncachedInput), 'uncached'),
                cell(fmt(sum.cacheRead), 'cacheRead'),
                cell(fmt(sum.cacheWrite), 'cacheWrite'),
                cell(fmt(sum.output), 'output'),
                cell(pct(sumHit), 'hit'),
              ] }, '__total'),
            ] }),
          ] }),
        ] }),
        j('p', { className: 'mt-hint mt-cost-note', children: t('cost.note') }),
      ] })
    }


    /** 三层来源的图标（design/icons.svg 的 i-lock / i-globe / i-folder / i-link；内联，不依赖外部 sprite） */
    function G3LayerIcon({ kind }) {
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }
      const paths = kind === 'builtin'
        ? [j('rect', { key: 'b', x: 3.6, y: 7, width: 8.8, height: 5.8, rx: 1.3, ...stroke }), j('path', { key: 's', d: 'M5.9 7V5.5a2.1 2.1 0 0 1 4.2 0V7', ...stroke })]
        : kind === 'global'
          ? [j('circle', { key: 'c', cx: 8, cy: 8, r: 5.5, ...stroke }), j('path', { key: 'm', d: 'M2.5 8h11M8 2.5c1.9 1.6 1.9 9.4 0 11M8 2.5c-1.9 1.6-1.9 9.4 0 11', ...stroke })]
          : kind === 'bound'
            ? [j('path', { key: 'l', d: 'M6.7 9.3 9.3 6.7M6.2 7.3 4.9 8.6a2 2 0 0 0 2.9 2.9l1.3-1.3M9.8 8.7l1.3-1.3a2 2 0 0 0-2.9-2.9L6.9 5.8', ...stroke })]
            : kind === 'role'
              ? [j('circle', { key: 'h', cx: 8, cy: 5.6, r: 2.1, ...stroke }), j('path', { key: 't', d: 'M3.6 13.2c0-2.2 2-3.6 4.4-3.6s4.4 1.4 4.4 3.6', ...stroke })]
              : [j('path', { key: 'f', d: 'M2.4 4.7h4l1.2 1.5h6v5.3a1.3 1.3 0 0 1-1.3 1.3H3.7a1.3 1.3 0 0 1-1.3-1.3z', ...stroke })]
      return j('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, children: paths })
    }

    /**
     * 证据指针 kind 判定（CHG-87 §4.1 / FR-16.4③）：
     * `task:<id>` / `file:<path>` / `session:<id>` / 其它 → `unknown`（兼容旧账本，不拒绝）。
     */
    const EVIDENCE_KINDS = new Set(['task', 'file', 'session'])
    const evKindOf = (raw) => {
      const text = String(raw ?? '')
      const head = text.slice(0, text.indexOf(':'))
      if (text.includes(':') && EVIDENCE_KINDS.has(head)) return head
      return 'unknown'
    }
    /** 证据指针列表：优先 `evidenceRefs:[{raw,kind,value}]`，回退旧的 `evidence: string[]` */
    const evidenceRefList = (entry) => (Array.isArray(entry?.evidenceRefs) && entry.evidenceRefs.length > 0
      ? entry.evidenceRefs.map((ref) => {
        const raw = String(ref?.raw ?? ref?.value ?? '')
        const kind = String(ref?.kind ?? evKindOf(raw))
        return { raw, kind: EVIDENCE_KINDS.has(kind) ? kind : 'unknown' }
      })
      : (Array.isArray(entry?.evidence) ? entry.evidence.map((raw) => ({ raw: String(raw), kind: evKindOf(raw) })) : []))
    /** 证据指针 chips（按 kind 上色；session 指针带 session.read 留痕说明） */
    const evidenceChips = (t, entry) => {
      const refs = evidenceRefList(entry)
      if (refs.length === 0) return null
      return js('div', { className: 'mt-kb-ev', children: [
        j('span', { className: 'mt-kb-meta', children: t('kb.evidence') }),
        ...refs.map((ref, index) => j('span', {
          key: `${ref.kind}-${index}-${ref.raw}`,
          className: `mt-ev-ref mt-ev-ref-${ref.kind}`,
          title: ref.kind === 'session' ? t('evref.sessionHint') : ref.raw,
          children: `${t(`evref.${ref.kind}`)} · ${ref.raw}`,
        })),
      ] })
    }

    /**
     * 知识提案裁决区（CHG-86 / UI-5，FR-17.4）。
     *
     * 修复前：知识 tab 只写「采纳/驳回由队长用 myteam_adopt_knowledge 执行」——按钮根本不存在，
     * 面板没有任何写路径，UI-5 验收门因此不过。现在「采纳 / 驳回」直通宿主
     * `adoptKnowledge({ teamId, draftId, decision, note? })`；端点缺失（旧宿主）/ 离线团队时
     * 给明确说明并**优雅降级**（catch 后提示，不崩、不静默）。
     *
     * 单独成组件而不是塞进 `KnowledgeTab`：知识 tab 是**只读**数据面（getKnowledge 投影），
     * 写路径独立成块，读面的 props 契约保持 `{ t, data, members }` 不变。
     */
    function KnowledgeProposals({ t, proposals, members, api, teamId, readOnly, onChanged, onNotice, onError }) {
      const [deciding, setDeciding] = react.useState(null)   // 正在提交的 draftId
      const [noteFor, setNoteFor] = react.useState(null)     // 打开备注输入的 draftId
      const [note, setNote] = react.useState('')
      const list = proposals ?? []
      if (list.length === 0) return null
      const memberNameOf = (id) => (members ?? []).find((m) => m.id === id || m.roleId === id)?.instanceName ?? id
      const relBadge = (rel) => (rel === 'refine' ? t('kb.rel.refine') : rel === 'contradict' ? t('kb.rel.contradict') : t('kb.rel.new'))
      /** 提案裁决（采纳 / 驳回）：直通宿主 adoptKnowledge；失败只提示不崩（UI-5 降级要求） */
      const decide = async (proposal, decision) => {
        if (readOnly) { onNotice?.(t('kb3.readonlyHint')); return }
        if (!api || typeof api.adoptKnowledge !== 'function') {
          onNotice?.(t('kb3.adoptUnavailable').replace('{message}', 'adoptKnowledge'))
          return
        }
        setDeciding(proposal.draftId)
        try {
          const trimmed = note.trim()
          const r = await api.adoptKnowledge({
            teamId,
            draftId: proposal.draftId,
            decision,
            ...(trimmed ? { note: trimmed } : {}),
          })
          if (r?.status === 'error') {
            onError?.(r.message ?? r.code ?? 'adoptKnowledge failed')
          } else {
            onNotice?.((decision === 'adopted' ? t('kb3.adoptDone') : t('kb3.rejectDone')).replace('{title}', String(proposal.title ?? proposal.draftId)))
            setNoteFor(null)
            setNote('')
            await onChanged?.()
          }
        } catch (e) {
          /* 端点不存在 / 网关不可达：降级成明确说明（禁止静默失败与崩溃） */
          onNotice?.(t('kb3.adoptUnavailable').replace('{message}', String(e?.message ?? e)))
        } finally {
          setDeciding(null)
        }
      }
      return js('div', { className: 'mt-kb3-proposals', children: list.map((proposal) => {
        const rel = proposal.relation === 'refine' ? 'refine' : proposal.relation === 'contradict' ? 'contradict' : 'new'
        const busy = deciding === proposal.draftId
        return js('div', { key: proposal.draftId, className: 'mt-kb-proposal', children: [
          js('div', { className: 'mt-kb-phead', children: [
            j('strong', { children: String(proposal.title ?? proposal.draftId) }),
            j('span', { className: `mt-kb-rel mt-kb-rel-${rel}`, children: relBadge(rel) }),
            j('span', {
              className: 'mt-kb-meta',
              children: t('kb3.by')
                .replace('{name}', memberNameOf(proposal.proposedBy))
                .replace('{time}', String(proposal.at ?? '').slice(0, 16).replace('T', ' ')),
            }),
          ] }),
          (proposal.tags ?? []).length > 0
            ? js('div', { className: 'mt-kb-tags', children: (proposal.tags ?? []).map((tag) => j('span', { key: tag, className: 'mt-mini-chip', children: `#${tag}` })) })
            : null,
          /* CHG-87 §4.3：提案的证据指针同样按 kind 上色 */
          evidenceChips(t, proposal),
          noteFor === proposal.draftId ? j('input', {
            className: 'mt-input',
            value: note,
            placeholder: t('kb3.notePlaceholder'),
            'aria-label': t('kb3.notePlaceholder'),
            onChange: (e) => setNote(e.target.value),
          }) : null,
          js('div', { className: 'mt-form-actions', children: [
            j('button', {
              className: 'mt-btn mt-btn-sm mt-btn-primary',
              disabled: busy || Boolean(readOnly),
              title: readOnly ? t('kb3.readonlyHint') : t('kb3.adopt'),
              onClick: () => decide(proposal, 'adopted'),
              children: t('kb3.adopt'),
            }),
            j('button', {
              className: 'mt-btn mt-btn-sm mt-btn-danger',
              disabled: busy || Boolean(readOnly),
              title: readOnly ? t('kb3.readonlyHint') : t('kb3.reject'),
              onClick: () => decide(proposal, 'rejected'),
              children: t('kb3.reject'),
            }),
            j('button', {
              className: 'mt-btn mt-btn-sm',
              'aria-expanded': noteFor === proposal.draftId,
              onClick: () => { setNoteFor(noteFor === proposal.draftId ? null : proposal.draftId); setNote('') },
              children: t('kb3.note'),
            }),
          ] }),
        ] })
      }) })
    }

    /* ── 知识 tab（FR-17.5 / CHG-82 设计稿对齐，design/knowledge.html）：
          三层记忆（AGENTS.md 共识 / 项目共享库 / 实例私有）+ 证据数 + 「可能过期」标记
          + 待确认提案 + 搜索 + 提案入口 + 条目详情演化时间线（knowledge.revised 账本流）── */
    function KnowledgeTab({ t, data, members }) {
      const [q, setQ] = react.useState('')
      const [layer, setLayer] = react.useState('all')
      const [openId, setOpenId] = react.useState(null)
      const [showIndex, setShowIndex] = react.useState(false)
      /* CHG-84：无活跃会话（null）/ 读取中（undefined）也要给满屏骨架 —— design/knowledge.html 是满屏内容，
       * 不能整页只剩一句话：三层记忆、筛选条、空态与脚注照常渲染，只在提案位放一条说明 note。 */
      const loading = data === undefined
      const unavailable = data === null
      const proposals = data?.proposals ?? []
      const timeline = data?.timeline ?? {}
      const all = data?.entries ?? []
      /* 层次按数据派生（§八-6：前端不造第二事实源）：audience 非空 = 只对该角色可见 → 实例私有层。
       * 共识层是仓库根的 AGENTS.md（人写、只读），恒为 1 个文件，不来自条目列表。 */
      const isPrivate = (e) => (e.audience ?? []).length > 0
      const shared = all.filter((e) => !isPrivate(e))
      const priv = all.filter(isPrivate)
      const kw = q.trim().toLowerCase()
      const hit = (e) => !kw || [e.title, e.body, e.id, ...(e.tags ?? []), ...(e.evidence ?? [])]
        .some((x) => String(x ?? '').toLowerCase().includes(kw))
      const inLayer = (e) => layer === 'all' || (isPrivate(e) ? 'private' : 'shared') === layer
      const entries = all.filter((e) => inLayer(e) && hit(e))
      const showConsensus = (layer === 'all' || layer === 'consensus') && (!kw || t('kb3.consensusEntry').toLowerCase().includes(kw))
      const relBadge = (rel) => (rel === 'refine' ? t('kb.rel.refine') : rel === 'contradict' ? t('kb.rel.contradict') : t('kb.rel.new'))
      const memberNameOf = (id) => (members ?? []).find((m) => m.id === id || m.roleId === id)?.instanceName ?? id
      const proofChip = (n) => j('span', { className: 'mt-mini-chip', children: (n ?? 0) > 0 ? t('kb3.proofChip').replace('{n}', String(n)) : t('kb3.proofNone') })
      const srcBadge = (kind) => j('span', { className: `mt-src mt-src-${kind}`, children: t(`kb3.layerBadge.${kind}`) })
      const avatarOf = (title, lead) => j('span', { className: `mt-avatar${lead ? ' mt-avatar-lead' : ''}`, 'aria-hidden': true, children: String(title ?? '').trim().slice(0, 1) || '知' })
      const detailOf = (e) => js('div', { className: 'mt-kb-detail', children: [
        j('div', { className: 'mt-kb-body', children: String(e.body ?? '') }),
        /* CHG-87 §4.3：证据指针按 kind 上色（优先 evidenceRefs，回退旧 evidence 字符串数组） */
        evidenceChips(t, e),
        (timeline[e.id] ?? []).length ? js('div', { className: 'mt-kb-timeline', children: [
          j('h4', { children: t('kb.timeline') }),
          ...[...timeline[e.id]].reverse().map((r, i) => j('div', { key: i, className: 'mt-kb-tlitem', children: `${String(r.ts ?? '').slice(0, 10)} · ${relBadge(r.relation)} · ${r.diff}` })),
        ] }) : null,
      ] })
      const entryRow = (e) => {
        const kind = isPrivate(e) ? 'private' : 'shared'
        const open = openId === e.id
        const owner = (e.audience ?? []).map(memberNameOf).join('、') || (e.contributor ? memberNameOf(e.contributor) : '—')
        return js('article', { key: e.id, className: 'mt-kb3-row mt-kb-entry', children: [
          avatarOf(e.title, false),
          js('div', { className: 'mt-kb3-row-main', children: [
            js('div', { className: 'mt-kb3-row-title', children: [
              j('strong', { children: e.title }),
              srcBadge(kind),
              kind === 'private' ? null : proofChip(e.proofCount),
              e.core ? j('span', { className: 'mt-kb-badge mt-kb-core', children: t('kb.core') }) : null,
              e.unverified ? j('span', { className: 'mt-kb-badge mt-kb-unverified', children: t('kb.unverified') }) : null,
              e.staleSince ? js('span', { className: 'mt-chip mt-chip-stale', children: [stateShape('gate'), t('kb3.stale')] }) : null,
            ] }),
            j('div', { className: 'mt-kb3-row-sub', children: kind === 'private'
              ? t('kb3.privateEntrySub').replace('{name}', owner)
              : String(e.body ?? '') }),
            open ? detailOf(e) : null,
          ] }),
          js('div', { className: 'mt-kb3-row-act', children: [
            kind === 'private'
              ? j('span', { className: 'mt-kb3-meta', children: t('kb3.privateOnly') })
              : j('span', { className: 'mt-kb3-meta', children: `${e.contributor ? memberNameOf(e.contributor) : '—'} · ${String(e.updated ?? '').slice(0, 10)}` }),
            j('button', { className: 'mt-iconbtn', 'aria-label': t('kb3.more'), title: t('kb3.more'), 'aria-expanded': open, onClick: () => setOpenId(open ? null : e.id), children: '⋯' }),
          ] }),
        ] })
      }
      const consensusRow = js('article', { className: 'mt-kb3-row', children: [
        avatarOf('共', true),
        js('div', { className: 'mt-kb3-row-main', children: [
          js('div', { className: 'mt-kb3-row-title', children: [j('strong', { children: t('kb3.consensusEntry') }), srcBadge('consensus')] }),
          j('div', { className: 'mt-kb3-row-sub', children: t('kb3.consensusEntrySub') }),
        ] }),
        js('div', { className: 'mt-kb3-row-act', children: [
          j('span', { className: 'mt-kb3-meta', children: t('preset3.readonly') }),
          j('button', { className: 'mt-iconbtn', 'aria-label': t('kb3.more'), title: t('kb3.more'), children: '⋯' }),
        ] }),
      ] })
      const layerRow = (key, title, icoKind, kind, srcText, path, n, unit) => js('div', { key, className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-ico-${kind}`, 'aria-hidden': true, children: j(G3LayerIcon, { kind: icoKind }) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [j('b', { children: title }), j('span', { className: `mt-src mt-src-${kind}`, children: srcText })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), j('span', { children: unit })] }),
      ] })
      const segBtn = (key, label) => j('button', { key, 'aria-pressed': layer === key, onClick: () => setLayer(key), children: label })
      return js('div', { className: 'mt-kb3', children: [
        js('div', { className: 'mt-kb3-head', children: [
          js('div', { children: [j('h2', { children: t('kb3.title') }), j('p', { children: t('kb3.desc') })] }),
          js('div', { className: 'mt-kb3-head-actions', children: [
            j('button', { className: 'mt-btn', 'aria-expanded': showIndex, onClick: () => setShowIndex(!showIndex), children: t('kb3.index') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: true, title: t('kb3.newEntryHint'), children: t('kb3.newEntry') }),
          ] }),
        ] }),
        js('div', { className: 'mt-section-head', children: [
          j('h3', { children: t('kb3.layers') }),
          j('span', { className: 'mt-rule', 'aria-hidden': true }),
          j('span', { className: 'mt-hint', children: t('kb3.layersNote') }),
        ] }),
        js('div', { className: 'mt-layers', children: [
          layerRow('consensus', t('kb3.consensus'), 'builtin', 'builtin', t('kb3.consensusSrc'), t('kb3.consensusPath'), 1, t('kb3.consensusUnit')),
          layerRow('shared', t('kb3.shared'), 'project', 'project', t('kb3.sharedSrc'), t('kb3.sharedPath'), shared.length, t('kb3.sharedUnit')),
          layerRow('private', t('kb3.private'), 'role', 'global', t('kb3.privateSrc'), t('kb3.privatePath'), priv.length, t('kb3.privateUnit')),
        ] }),
        showIndex ? js('div', { className: 'mt-kb3-index', children: [
          j('div', { className: 'mt-kb3-meta', children: t('kb3.indexBudget') }),
          ...all.slice(0, 40).map((e) => j('div', { key: e.id, className: 'mt-kb3-index-row', children: `${e.core ? '[core] ' : e.unverified ? '[unverified] ' : e.staleSince ? '[stale] ' : ''}${e.title}` })),
          all.length === 0 ? j('div', { className: 'mt-kb3-meta', children: t('kb.empty') }) : null,
        ] }) : null,
        js('div', { className: 'mt-kb3-filter', children: [
          js('label', { className: 'mt-kb3-search', children: [
            j('input', { type: 'search', className: 'mt-kb-search', placeholder: t('kb.search'), 'aria-label': t('kb.search'), value: q, onChange: (e) => setQ(e.target.value) }),
          ] }),
          js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('kb3.layers'), children: [
            segBtn('all', t('kb3.filterAll').replace('{n}', String(all.length))),
            segBtn('shared', t('kb3.filterShared').replace('{n}', String(shared.length))),
            segBtn('consensus', t('kb3.filterConsensus').replace('{n}', '1')),
            segBtn('private', t('kb3.filterPrivate').replace('{n}', String(priv.length))),
          ] }),
          j('button', { className: 'mt-btn mt-btn-sm', style: { marginLeft: 'auto' }, onClick: () => setLayer('all'), children: t('kb3.pending').replace('{n}', String(proposals.length)) }),
        ] }),
        proposals.length > 0 ? js('div', { className: 'mt-kb3-note mt-kb3-note-warn', role: 'note', children: [
          j('span', { children: [j('b', { children: t('kb3.proposalTitle').replace('{n}', String(proposals.length)) }), t('kb3.proposalBody')] }),
          j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setLayer('all'), children: t('kb3.review') }),
        ] }) : null,
        /* CHG-86 / UI-5：提案裁决（采纳 / 驳回）由 KnowledgeProposals 单独渲染（写路径与只读数据面分离） */
        /* CHG-84：无活跃会话 / 读取中不做整页空态——骨架照出，用一条说明 note 讲清为什么还没有条目 */
        loading || unavailable
          ? js('div', { className: 'mt-kb3-note mt-kb3-note-info', role: 'note', children: [
            j('span', { children: loading ? t('kb3.loadingHint') : t('kb3.needsSession') }),
          ] })
          : null,
        entries.length === 0 && !showConsensus
          ? j('div', { className: 'mt-empty', children: t('kb3.empty') })
          : js('div', { className: 'mt-kb3-rows', children: [
            ...entries.filter((e) => !isPrivate(e)).map(entryRow),
            showConsensus ? consensusRow : null,
            ...entries.filter(isPrivate).map(entryRow),
          ] }),
        js('div', { className: 'mt-kb3-note', role: 'note', children: [
          j('span', { children: [j('b', { children: t('kb3.curation') }), t('kb3.curationNote')] }),
        ] }),
      ] })
    }

    /* ── 预设库（design/presets.html）—— 全局作用域子页：
          三层来源分区 + 每张卡的「名册预览（队长高亮 + 角色引用 chips）+ 模板三行 + 引用计数」
          + 内置层兜底模板 + 删除守门提示。数据只从 getOfflinePresets / getProject().teams 派生。── */
    function PresetsPage({ t, presets, teams, onBack, onUse, onNotice, onSkills }) {
      const [q, setQ] = react.useState('')
      const [origin, setOrigin] = react.useState('all')
      if (presets === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (presets === null) return j('div', { className: 'mt-empty', children: t('roles.unavailable') })
      const entries = presets.entries.map((entry) => entry)
      const originOf = (entry) => String(entry.origin ?? 'project')
      const byOrigin = (o) => entries.filter((entry) => originOf(entry) === o)
      const projectEntries = byOrigin('project')
      const builtinEntries = byOrigin('builtin')
      const globalEntries = byOrigin('global')
      const kw = q.trim().toLowerCase()
      const hit = (entry) => {
        const def = entry.definition ?? {}
        return !kw || [def.name, def.id, def.description, entry.file].some((x) => String(x ?? '').toLowerCase().includes(kw))
      }
      /* 引用计数：名册里的角色是否都在某团队在册（派生自 getProject().teams，不造第二事实源） */
      const usageOf = (entry) => {
        const roster = entry.definition?.members ?? []
        if (roster.length === 0) return 0
        return (teams ?? []).filter((team) => roster.every((m) => (team.members ?? []).some((x) => x.roleId === m.roleId))).length
      }
      const gateLabels = (def) => [...new Set(Object.values(def.taskTypes ?? {}).flatMap((x) => x?.gateChain ?? []))].map((g) => gateLabel(String(g)))
      const swimlaneText = (def) => {
        const by = def.pipeline?.swimlaneBy
        const layout = def.pipeline?.layout
        const byText = by === 'member' ? t('preset3.byMember') : by === 'stage' ? t('preset3.byStage') : by === 'priority' ? t('preset3.byPriority') : (by ?? '—')
        const layoutText = layout === 'serpentine' ? t('preset3.serpentine') : layout === 'linear' ? t('preset3.linear') : (layout ?? '')
        return layoutText ? `${byText} · ${layoutText}` : byText
      }
      const tmplRows = (def) => js('div', { className: 'mt-tmpl', children: [
        js('div', { className: 'mt-tmpl-row', children: [
          j('span', { className: 'mt-tmpl-k', children: t('presets.columns') }),
          js('span', { className: 'mt-tmpl-v mt-colpreview', children: (def.board?.columns ?? []).flatMap((col, i) => (i === 0
            ? [j('b', { key: `c-${col}`, children: stateLabel(col) })]
            : [j('span', { key: `a-${col}`, className: 'mt-ar', 'aria-hidden': true, children: '→' }), j('b', { key: `c-${col}`, children: stateLabel(col) })])) }),
        ] }),
        js('div', { className: 'mt-tmpl-row', children: [
          j('span', { className: 'mt-tmpl-k', children: t('preset3.flow') }),
          j('span', { className: 'mt-tmpl-v', children: swimlaneText(def) }),
        ] }),
        js('div', { className: 'mt-tmpl-row', children: [
          j('span', { className: 'mt-tmpl-k', children: t('preset3.gates') }),
          js('span', { className: 'mt-tmpl-v', children: def.gates?.enabled
            ? [
              ...gateLabels(def).map((g) => j('span', { key: g, className: 'mt-mini-chip', children: g })),
              j('span', { className: 'mt-kb3-meta', children: t('preset3.gateTimeout').replace('{ms}', String(Math.round(Number(def.gates?.commandTimeoutMs ?? 0) / 1000))) }),
            ]
            : [j('span', { className: 'mt-kb3-meta', children: t('preset3.gatesOff') })] }),
        ] }),
      ] })
      const card = (entry) => {
        const def = entry.definition ?? {}
        const title = def.name ?? def.id ?? entry.file
        const isBuiltin = originOf(entry) === 'builtin'
        const roster = def.members ?? []
        const used = usageOf(entry)
        return js('article', { key: `${originOf(entry)}:${def.id ?? entry.file}`, className: `mt-p3-card${isBuiltin ? ' mt-p3-card-builtin' : ''}`, children: [
          js('div', { className: 'mt-p3-top', children: [
            j('span', { className: 'mt-avatar mt-avatar-lead', 'aria-hidden': true, children: '队' }),
            js('div', { className: 'mt-p3-topbody', children: [
              js('div', { className: 'mt-p3-title', children: [
                j('strong', { children: title }),
                j('span', { className: 'mt-rolecard-id', children: def.id ?? entry.file }),
                j('span', { className: `mt-src mt-src-${isBuiltin ? 'builtin' : 'project'}`, title: t('presets.origin.' + entry.origin), children: t(`preset3.layer.${isBuiltin ? 'builtin' : 'project'}`) }),
              ] }),
              j('div', { className: 'mt-p3-sub', children: isBuiltin ? t('preset3.builtinNote') : (used > 0 ? t('preset3.usedBy').replace('{n}', String(used)) : t('preset3.unused')) }),
            ] }),
          ] }),
          js('div', { children: [
            j('div', { className: 'mt-tmpl-k', children: t('preset3.roster').replace('{n}', String(roster.length + 1)) }),
            js('div', { className: 'mt-p3-roster', children: [
              js('span', { className: 'mt-mini-chip mt-p3-lead-chip', children: [j('span', { className: 'mt-avatar mt-avatar-lead', 'aria-hidden': true, children: '队' }), t('preset3.captain')] }),
              ...roster.map((m, i) => js('span', { key: `${m.roleId}-${i}`, className: 'mt-mini-chip', title: m.roleId, children: [
                j('span', { className: 'mt-avatar', 'aria-hidden': true, children: String(m.instanceName ?? m.roleId).trim().slice(0, 1) || '员' }),
                m.instanceName ?? m.roleId,
              ] })),
            ] }),
          ] }),
          isBuiltin ? j('p', { className: 'mt-p3-desc', children: t('preset3.builtinDesc') }) : tmplRows(def),
          isBuiltin
            ? js('div', { className: 'mt-p3-foot', children: [
              j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: t('preset3.copy') }),
              j('button', { className: 'mt-btn mt-btn-ghost mt-btn-sm', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: t('preset3.restore') }),
              j('span', { className: 'mt-kb3-meta', style: { marginLeft: 'auto' }, children: t('preset3.readonly') }),
            ] })
            : js('div', { className: 'mt-p3-foot', children: [
              j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onUse?.(def), children: t('preset3.use') }),
              j('button', { className: 'mt-btn mt-btn-ghost mt-btn-sm', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: t('preset3.edit') }),
              j('button', { className: 'mt-iconbtn', style: { marginLeft: 'auto' }, 'aria-label': t('preset3.more'), title: t('preset3.more'), onClick: () => onNotice?.(t('preset3.readonlyHint')), children: '⋯' }),
            ] }),
        ] })
      }
      const originBtn = (key, label) => j('button', { key, 'aria-pressed': origin === key, onClick: () => setOrigin(key), children: label })
      const layerRow = (key, title, icoKind, kind, srcText, path, n, unit, action, actionLabel) => js('div', { key, className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-ico-${kind}`, 'aria-hidden': true, children: j(G3LayerIcon, { kind: icoKind }) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [j('b', { children: title }), j('span', { className: `mt-src mt-src-${kind}`, children: srcText })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), j('span', { children: unit })] }),
        action ? j('button', { className: 'mt-btn mt-btn-sm', onClick: action, children: actionLabel }) : null,
      ] })
      /* design/presets.html：项目分区末尾跟着一张虚线「新建预设」卡（和卡片同栅格），不是页头按钮的重复 */
      const newCard = js('button', {
        className: 'mt-p3-newcard',
        onClick: () => onNotice?.(t('preset3.readonlyHint')),
        children: [
          j('span', { className: 'mt-p3-newcard-icon', 'aria-hidden': true, children: '＋' }),
          j('strong', { children: t('preset3.new') }),
          j('span', { children: t('preset3.newCardHint') }),
        ],
      })
      const section = (key, title, note, list, extra) => [
        js('div', { key: `head-${key}`, className: 'mt-section-head', children: [
          j('h3', { children: title }),
          j('span', { className: 'mt-rule', 'aria-hidden': true }),
          j('span', { className: 'mt-hint', children: note }),
        ] }),
        list.length === 0 ? j('div', { key: `empty-${key}`, className: 'mt-hint', children: t('preset3.empty') }) : null,
        list.length > 0 || extra
          ? js('div', { key: `grid-${key}`, className: 'mt-presetgrid', children: [...list.map(card), ...(extra ? [extra] : [])] })
          : null,
      ]
      return js('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }, children: [
        js('div', { className: 'mt-teambar', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onBack, children: `← ${t('preset3.back')}` }),
          js('span', { className: 'mt-teambar-title', children: [j('b', { children: t('preset3.title') }), j('span', { className: 'mt-teambar-id', children: t('preset3.teambarSub') })] }),
          j('span', { className: 'mt-teambar-goal', children: t('preset3.teambarGoal') }),
          js('span', { className: 'mt-teambar-actions', children: [
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('preset3.layers'), children: [
              j('button', { 'aria-pressed': false, onClick: onBack, children: t('preset3.tabRoles') }),
              j('button', { 'aria-pressed': true, children: t('preset3.tabPresets') }),
              j('button', { 'aria-pressed': false, onClick: onSkills, children: t('preset3.tabSkills') }),
            ] }),
          ] }),
        ] }),
        js('div', { className: 'mt-kb3', children: [
          js('div', { className: 'mt-kb3-head', children: [
            js('div', { children: [j('h2', { children: t('preset3.title') }), j('p', { children: t('preset3.desc') })] }),
            js('div', { className: 'mt-kb3-head-actions', children: [
              /* design/presets.html：页头主按钮是描边（不是实底主色），只有空态兜底卡用虚线 */
              j('button', { className: 'mt-btn', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: `＋ ${t('preset3.new')}` }),
            ] }),
          ] }),
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('preset3.layers') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('span', { className: 'mt-hint', children: t('preset3.layersNote') }),
          ] }),
          js('div', { className: 'mt-layers', children: [
            layerRow('builtin', t('preset3.layer.builtin'), 'builtin', 'builtin', t('preset3.layer.builtinSrc'), t('preset3.layer.builtinPath'), builtinEntries.length, t('preset3.unit'), () => setOrigin('builtin'), t('preset3.restore')),
            layerRow('global', t('preset3.layer.global'), 'global', 'global', t('preset3.layer.globalSrc'), `${t('preset3.layer.globalPath')} · ${t('preset3.globalOff')}`, globalEntries.length, t('preset3.unit'), () => setOrigin('global'), t('preset3.seeAll')),
            layerRow('project', t('preset3.layer.project'), 'project', 'project', t('preset3.layer.projectSrc'), t('preset3.layer.projectPath'), projectEntries.length, t('preset3.unit'), () => setOrigin('project'), t('preset3.seeAll')),
          ] }),
          js('div', { className: 'mt-kb3-note mt-kb3-note-info', role: 'note', children: [
            j('span', { children: [j('b', { children: t('preset3.overwriteNote') }), t('preset3.overwriteBody')] }),
          ] }),
          js('div', { className: 'mt-kb3-filter', children: [
            js('label', { className: 'mt-kb3-search', children: [
              j('input', { type: 'search', className: 'mt-kb-search', placeholder: t('preset3.search'), 'aria-label': t('preset3.search'), value: q, onChange: (e) => setQ(e.target.value) }),
            ] }),
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('preset3.layers'), children: [
              originBtn('all', t('preset3.filterAll').replace('{n}', String(entries.length))),
              originBtn('project', t('preset3.filterProject').replace('{n}', String(projectEntries.length))),
              originBtn('global', t('preset3.filterGlobal').replace('{n}', String(globalEntries.length))),
              originBtn('builtin', t('preset3.filterBuiltin').replace('{n}', String(builtinEntries.length))),
            ] }),
            j('span', { className: 'mt-kb3-meta', children: t('preset3.sorted') }),
          ] }),
          ...section('project', t('preset3.sectionProject').replace('{n}', String(projectEntries.length)), t('preset3.sectionProjectNote'), (origin === 'all' || origin === 'project' ? projectEntries.filter(hit) : []), newCard),
          ...section('global', t('preset3.sectionGlobal').replace('{n}', String(globalEntries.length)), t('preset3.sectionGlobalNote'), (origin === 'all' || origin === 'global' ? globalEntries.filter(hit) : [])),
          ...section('builtin', t('preset3.sectionBuiltin').replace('{n}', String(builtinEntries.length)), t('preset3.sectionBuiltinNote'), (origin === 'all' || origin === 'builtin' ? builtinEntries.filter(hit) : [])),
          js('div', { className: 'mt-kb3-note', role: 'note', children: [j('span', { children: t('preset3.guard') })] }),
        ] }),
      ] })
    }

    /* ── 技能 & MCP（design/skills.html）—— 全局作用域子页：
          技能四层来源（内置 / 全局 / 项目 / 角色绑定）+ 成员级隔离说明 + 技能条目（绑定次数 / 绑进角色）
          + 下半部 MCP 两段式左右对照（连接层 ∩ 可见层，中间链接图标表示交集）。── */
    function SkillsPage({ t, roles, catalog, onBack, onBind, onNotice, onPresets }) {
      const [q, setQ] = react.useState('')
      const [origin, setOrigin] = react.useState('all')
      if (catalog === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      const roleList = roles ?? []
      /* 目录不可用时降级为「已有角色出现过的名字」（与角色表单同口径，§八-6 不造第二事实源） */
      const fallback = (() => {
        const collect = (key) => [...new Set(roleList.flatMap((role) => role?.[key] ?? []))].sort()
        return {
          skills: collect('skills').map((name) => ({ name, source: 'role' })),
          mcp: collect('mcpAllowlist').map((name) => ({ name, source: 'role' })),
          warnings: [],
          fallback: true,
        }
      })()
      const cat = catalog ?? fallback
      const skillsOf = (origins) => [...new Set(roleList.filter((role) => origins.includes(String(role.origin))).flatMap((role) => role.skills ?? []))].sort()
      const builtinSkills = skillsOf(['builtin'])
      const globalSkills = skillsOf(['global'])
      const projectSkills = skillsOf(['project', 'project-role'])
      const bindCount = (name) => roleList.filter((role) => (role.skills ?? []).includes(name)).length
      const boundRoles = (name) => roleList.filter((role) => (role.skills ?? []).includes(name)).map((role) => role.name ?? role.id)
      const layerOfSkill = (name) => {
        if (projectSkills.includes(name)) return 'project'
        if (globalSkills.includes(name)) return 'global'
        if (builtinSkills.includes(name)) return 'builtin'
        return 'host'
      }
      const names = [...new Set([...(cat.skills ?? []).map((s) => s.name), ...builtinSkills, ...globalSkills, ...projectSkills])].sort()
      const kw = q.trim().toLowerCase()
      const shown = names.filter((name) => {
        const kind = layerOfSkill(name)
        if (origin !== 'all' && kind !== origin) return false
        return !kw || name.toLowerCase().includes(kw) || boundRoles(name).join(' ').toLowerCase().includes(kw)
      })
      const hostMcp = [...new Set((cat.mcp ?? []).filter((m) => m.source === 'host').map((m) => m.name))].sort()
      const declaredMcp = [...new Set(roleList.flatMap((role) => role.mcpAllowlist ?? []))].sort()
      const notConnected = declaredMcp.filter((name) => !hostMcp.includes(name))
      const mcpRoles = roleList.filter((role) => (role.mcpAllowlist ?? []).length > 0)
      /* CHG-88：内置技能层的说明不再写死"两个技能"——随实际内置技能集合派生。
       * 旧文案硬编码「含 create-role、create-team 两个随行技能」，但内置技能早已是
       * create-role / modify-role / choose-team-template / manage-team-template 四个，
       * 文案与实现分叉（面板说的不是真话）。改为按实际技能名列表渲染，永远不说谎。
       * 语言跟随 t()：用 locale 字典自身的措辞探测当前语言（连接符不同），不硬编码两份文案。 */
      const builtinSkillNames = (cat.skills ?? []).filter((s) => s.source === 'builtin').map((s) => s.name).sort()
      const builtinIsZh = String(t('skill3.layer.builtinPath')).includes('、')
      const builtinPathText = builtinSkillNames.length > 0
        ? `plugin/skills · ${builtinSkillNames.join(builtinIsZh ? '、' : ', ')}`
        : t('skill3.layer.builtinPath')
      const layerRow = (key, title, icoKind, kind, srcText, path, n, unit, action) => js('div', { key, className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-ico-${kind}`, 'aria-hidden': true, children: j(G3LayerIcon, { kind: icoKind }) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [j('b', { children: title }), j('span', { className: `mt-src mt-src-${kind}`, children: srcText })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), j('span', { children: unit })] }),
        action ? j('button', { className: 'mt-btn mt-btn-sm', onClick: action, children: t('preset3.seeAll') }) : null,
      ] })
      const originBtn = (key, label) => j('button', { key, 'aria-pressed': origin === key, onClick: () => setOrigin(key), children: label })
      const mcpChip = (name) => (hostMcp.includes(name)
        ? j('span', { key: name, className: 'mt-mini-chip', children: name })
        : js('span', { key: name, className: 'mt-mini-chip mt-mini-chip-off', children: [`${name} ${t('skill3.disconnected')}`] }))
      return js('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }, children: [
        js('div', { className: 'mt-teambar', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onBack, children: `← ${t('skill3.back')}` }),
          js('span', { className: 'mt-teambar-title', children: [j('b', { children: t('skill3.title') }), j('span', { className: 'mt-teambar-id', children: t('skill3.teambarSub') })] }),
          j('span', { className: 'mt-teambar-goal', children: t('skill3.teambarGoal') }),
          js('span', { className: 'mt-teambar-actions', children: [
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('skill3.layers'), children: [
              j('button', { 'aria-pressed': false, onClick: onBack, children: t('skill3.tabRoles') }),
              j('button', { 'aria-pressed': false, onClick: onPresets, children: t('skill3.tabPresets') }),
              j('button', { 'aria-pressed': true, children: t('skill3.tabSkills') }),
            ] }),
          ] }),
        ] }),
        js('div', { className: 'mt-kb3', children: [
          js('div', { className: 'mt-kb3-head', children: [
            js('div', { children: [j('h2', { children: t('skill3.title') }), j('p', { children: t('skill3.desc') })] }),
          ] }),
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('skill3.layers') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('span', { className: 'mt-hint', children: t('skill3.layersNote') }),
          ] }),
          js('div', { className: 'mt-layers', children: [
            layerRow('builtin', t('skill3.layer.builtin'), 'builtin', 'builtin', t('skill3.layer.builtinSrc'), builtinPathText, builtinSkills.length, t('skill3.unitSkill'), () => setOrigin('builtin')),
            layerRow('global', t('skill3.layer.global'), 'global', 'global', t('skill3.layer.globalSrc'), t('skill3.layer.globalPath'), globalSkills.length, t('skill3.unitSkill'), () => setOrigin('global')),
            layerRow('project', t('skill3.layer.project'), 'project', 'project', t('skill3.layer.projectSrc'), t('skill3.layer.projectPath'), projectSkills.length, t('skill3.unitSkill'), () => setOrigin('project')),
            layerRow('bound', t('skill3.layer.bound'), 'bound', 'bound', t('skill3.layer.boundSrc'), t('skill3.layer.boundPath'), roleList.reduce((sum, role) => sum + (role.skills ?? []).length, 0), t('skill3.unitBound'), () => setOrigin('all')),
          ] }),
          js('div', { className: 'mt-kb3-note mt-kb3-note-info', role: 'note', children: [
            j('span', { children: [j('b', { children: t('skill3.isolation') }), t('skill3.isolationBody')] }),
          ] }),
          js('div', { className: 'mt-kb3-filter', children: [
            js('label', { className: 'mt-kb3-search', children: [
              j('input', { type: 'search', className: 'mt-kb-search', placeholder: t('skill3.search'), 'aria-label': t('skill3.search'), value: q, onChange: (e) => setQ(e.target.value) }),
            ] }),
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('skill3.layers'), children: [
              originBtn('all', t('skill3.filterAll').replace('{n}', String(names.length))),
              originBtn('builtin', t('skill3.filterBuiltin').replace('{n}', String(builtinSkills.length))),
              originBtn('global', t('skill3.filterGlobal').replace('{n}', String(globalSkills.length))),
              originBtn('project', t('skill3.filterProject').replace('{n}', String(projectSkills.length))),
            ] }),
            j('span', { className: 'mt-kb3-meta', children: t('skill3.boundTimes').replace('{n}', String(roleList.reduce((sum, role) => sum + (role.skills ?? []).length, 0))) }),
          ] }),
          shown.length === 0
            ? j('div', { className: 'mt-empty', children: t('skill3.empty') })
            : js('div', { className: 'mt-kb3-rows', children: shown.map((name) => {
              const kind = layerOfSkill(name)
              const bound = bindCount(name)
              return js('article', { key: name, className: 'mt-kb3-row', children: [
                j('span', { className: 'mt-avatar', 'aria-hidden': true, children: name.trim().slice(0, 1) || '技' }),
                js('div', { className: 'mt-kb3-row-main', children: [
                  js('div', { className: 'mt-kb3-row-title', children: [
                    j('span', { className: 'mt-kb3-name', title: name, children: name }),
                    j('span', { className: `mt-src mt-src-${kind === 'host' ? 'builtin' : kind}`, children: kind === 'host' ? t('skill3.layer.builtin') : t(`skill3.layer.${kind}`) }),
                    bound > 0 ? j('span', { className: 'mt-mini-chip', children: t('skill3.bindCount').replace('{n}', String(bound)) }) : j('span', { className: 'mt-mini-chip mt-mini-chip-off', children: t('skill3.bindNone') }),
                  ] }),
                  j('div', { className: 'mt-kb3-row-sub', children: bound > 0 ? boundRoles(name).join(' · ') : t('skill3.bindNone') }),
                ] }),
                js('div', { className: 'mt-kb3-row-act', children: [
                  bound > 0
                    ? j('button', { className: 'mt-iconbtn', 'aria-label': t('skill3.more'), title: t('skill3.more'), onClick: () => onNotice?.(boundRoles(name).join(' · ')), children: '⋯' })
                    : j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onBind?.(name), children: t('skill3.bind') }),
                ] }),
              ] })
            }) }),
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('skill3.mcp') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('span', { className: 'mt-hint', children: t('skill3.mcpNote') }),
          ] }),
          js('div', { className: 'mt-mcp-split', children: [
            js('div', { className: 'mt-mcp-pane', children: [
              js('div', { className: 'mt-mcp-head', children: [
                j('span', { className: 'mt-mcp-badge', children: t('skill3.conn') }),
                j('span', { className: 'mt-mcp-note', children: t('skill3.connNote') }),
              ] }),
              js('ul', { className: 'mt-mcp-list', children: [
                ...hostMcp.map((name) => js('li', { key: `on-${name}`, className: 'mt-mcp-item', children: [
                  j('span', { className: 'mt-chip mt-chip-online', children: '✓' }),
                  j('span', { className: 'mt-mcp-name', children: name }),
                  j('span', { className: 'mt-mini-chip', style: { marginLeft: 'auto' }, children: t('skill3.connected') }),
                ] })),
                ...notConnected.map((name) => js('li', { key: `off-${name}`, className: 'mt-mcp-item mt-mcp-item-off', children: [
                  j('span', { className: 'mt-chip mt-chip-offline', children: '×' }),
                  j('span', { className: 'mt-mcp-name', children: name }),
                  j('span', { className: 'mt-mini-chip mt-mini-chip-off', style: { marginLeft: 'auto' }, children: t('skill3.disconnected') }),
                ] })),
                hostMcp.length + notConnected.length === 0 ? j('li', { className: 'mt-mcp-item mt-mcp-item-off', children: t('skill3.catalogOff') }) : null,
              ] }),
            ] }),
            j('div', { className: 'mt-mcp-join', 'aria-hidden': true, children: t('skill3.join') }),
            js('div', { className: 'mt-mcp-pane', children: [
              js('div', { className: 'mt-mcp-head', children: [
                j('span', { className: 'mt-mcp-badge', children: t('skill3.vis') }),
                j('span', { className: 'mt-mcp-note', children: t('skill3.visNote') }),
              ] }),
              js('ul', { className: 'mt-mcp-list', children: [
                ...mcpRoles.map((role) => js('li', { key: role.id, className: 'mt-mcp-item', children: [
                  j('span', { className: 'mt-avatar', 'aria-hidden': true, children: String(role.name ?? role.id).trim().slice(0, 1) || '角' }),
                  j('span', { className: 'mt-mcp-name', children: role.id }),
                  js('span', { className: 'mt-mcp-tags', children: (role.mcpAllowlist ?? []).map((name) => mcpChip(name)) }),
                ] })),
                mcpRoles.length === 0 ? j('li', { className: 'mt-mcp-item mt-mcp-item-off', children: t('skill3.bindNone') }) : null,
              ] }),
            ] }),
          ] }),
          js('div', { className: 'mt-kb3-note', role: 'note', children: [j('span', { children: t('skill3.footnote') })] }),
        ] }),
      ] })
    }


    /** 看板列 → 扁平任务（三视图共用同一份数据，CHG-49） */
    const allTasksOf = (board) => (board?.board?.columns ?? []).flatMap((col) => col.tasks ?? [])


    /* ── 依赖图（CHG-69/CHG-82：真实 DOM 测量 + SVG 贝塞尔连线 + 横向/竖向两种布局）──
     * 口径对齐 design/dag.js：先把节点宽度钉死再测量（横向 176 定宽；竖向按容器 ~34%、240–400），
     * 依赖层级 = 主轴（h: 列 / v: 行），同层多节点在副轴居中，层间距 60；
     * 画布宽高取 max(内容, 容器)，节点在画布里居中；箭头永远从上游指到下游。
     * tasks 需要已把 deps 映射成图内 id（项目级用 ownerTeamId/taskId 复合键）。 */
    const DAG_GAP_MAIN = 60
    const DAG_GAP_CROSS = 16
    const DAG_PAD = 16
    const DAG_FALLBACK_H = 78
    const DAG_NODE_W_H = 176
    const DAG_MODEL_RE = /^(sonnet|gpt-|claude|opus|qwen|gemini|deepseek|llama|mistral|glm)/i
    /** 任务状态 → 节点色带（H4：文字 + 形状为主，色带只作第三顺位） */
    const dagChipOf = (state) => {
      const s = String(state ?? '')
      if (s.startsWith('gate:')) return 'gate'
      if (s === 'done') return 'done'
      if (s === 'in_progress' || s === 're-scoping') return 'run'
      if (s === 'failed' || s === 'cancelled') return 'fail'
      if (s === 'blocked') return 'blocked'
      return 'idle'
    }
    /** 状态机允许的拖拽落点（design/dragging.html：门禁未过的卡进不了已完成） */
    const DRAG_LEGAL_TARGETS = {
      '待规划': ['就绪'],
      '就绪': ['进行中'],
      '进行中': ['门禁'],
      '门禁': ['已完成'],
      '已完成': [],
      '未完成': [],
    }

    function DagView({ t, tasks, onOpen, memberName, teamName, dir = 'h' }) {
      const [focus, setFocus] = react.useState(null)
      // 真实矩形：横向钉死 176 宽；高度靠 useLayoutEffect 量回来（mock 下量不到 → 固定 78）
      const [heights, setHeights] = react.useState({})
      const [avail, setAvail] = react.useState({ w: 320, h: 320 })
      const wrapRef = (react.useRef ?? ((init) => ({ current: init })))(null)
      const nodeRefs = (react.useRef ?? ((init) => ({ current: init })))(new Map())
      const useLayoutEffect = react.useLayoutEffect ?? react.useEffect ?? (() => {})
      const ready = Boolean(tasks && tasks.length > 0)
      useLayoutEffect(() => {
        if (!ready) return
        const wrap = wrapRef.current
        const w = Math.max((wrap && wrap.clientWidth) || 0, 320)
        const h = Math.max((wrap && wrap.clientHeight) || 0, 320)
        if (w !== avail.w || h !== avail.h) setAvail({ w, h })
        let changed = false
        const next = {}
        for (const task of tasks) {
          const el = nodeRefs.current?.get?.(task.id)
          const measured = el ? el.offsetHeight : 0
          if (measured > 0) { next[task.id] = measured; if (heights[task.id] !== measured) changed = true }
        }
        if (changed) setHeights(next)
      }, [tasks, dir, heights, avail.w, avail.h, ready])
      if (!ready) return j('div', { className: 'mt-empty', children: t('dag.empty') })
      const byId = new Map(tasks.map((task) => [task.id, task]))
      // 层级 = 最长路径（与后端 core/tasks/graph.ts 同算法；环按 0 截断）
      const memo = new Map()
      const depthOf = (id, stack) => {
        if (memo.has(id)) return memo.get(id)
        const seen = stack ?? new Set()
        if (seen.has(id)) return 0
        seen.add(id)
        const deps = (byId.get(id)?.deps ?? []).filter((dep) => byId.has(dep))
        const depth = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)))
        seen.delete(id)
        memo.set(id, depth)
        return depth
      }
      const layers = new Map()
      for (const task of tasks) {
        const depth = depthOf(task.id)
        if (!layers.has(depth)) layers.set(depth, [])
        layers.get(depth).push(task)
      }
      const depths = [...layers.keys()].sort((a, b) => a - b)
      const chain = new Set()
      if (focus && byId.has(focus)) {
        const walkUp = (id) => {
          for (const dep of byId.get(id)?.deps ?? []) {
            if (byId.has(dep) && !chain.has(dep)) { chain.add(dep); walkUp(dep) }
          }
        }
        walkUp(focus)
        let changed = true
        while (changed) {
          changed = false
          for (const task of tasks) {
            if (task.id === focus || chain.has(task.id)) continue
            if ((task.deps ?? []).some((dep) => dep === focus || chain.has(dep))) { chain.add(task.id); changed = true }
          }
        }
      }
      // 1) 主轴尺寸：横向钉死 176 宽；竖向按容器 ~34% 宽（240–400），单列不再挤在中间一条
      const nodeW = dir === 'v'
        ? Math.max(240, Math.min(400, Math.floor(avail.w * 0.34)))
        : DAG_NODE_W_H
      const heightOf = (id) => heights[id] ?? DAG_FALLBACK_H
      /* 同层节点超出容器宽度时折行。
       * CHG-85：横向模式原来同层节点全部纵向堆叠 —— 9 个无依赖任务拉成一列 900px 高，
       * 底部被面板裁掉、右侧还空一大片。现在横向也把层摊开：同层节点分成若干「列组」，
       * 组内横向并排、组间纵向堆叠（边仍指向节点真实坐标，语义不变）。 */
      const perRowV = Math.max(1, Math.floor((Math.max(avail.w, 320) - DAG_PAD * 2 + DAG_GAP_CROSS) / (nodeW + DAG_GAP_CROSS)))
      /* 横向：层内每行放几个（按可用宽度算，最多 3 —— 再多每张卡就太窄了） */
      const perRowH = dir === 'h'
        ? Math.max(1, Math.min(3, Math.floor((Math.max(avail.w, 640) - DAG_PAD * 2 + DAG_GAP_CROSS) / (nodeW + DAG_GAP_CROSS))))
        : 1
      const layerRows = new Map()
      for (const depth of depths) {
        const layer = layers.get(depth)
        const rowsOfLayer = []
        const per = dir === 'v' ? perRowV : perRowH
        for (let i = 0; i < layer.length; i += per) rowsOfLayer.push(layer.slice(i, i + per))
        layerRows.set(depth, rowsOfLayer)
      }
      // 2) 每层的主轴 / 副轴尺寸（h：主轴 = 层宽（列组数 × 节点宽），副轴 = 层内高度和；v：对调）
      const bandMain = new Map()
      const bandCross = new Map()
      let crossMax = 0
      for (const depth of depths) {
        const rowsOfLayer = layerRows.get(depth)
        if (dir === 'h') {
          /* 横向：层宽 = 最宽的一组有几个节点（每组横向占一格） */
          bandMain.set(depth, Math.max(...rowsOfLayer.map((row) => row.length)) * (nodeW + DAG_GAP_CROSS))
          bandCross.set(depth, rowsOfLayer.reduce((sum, row) => sum + Math.max(...row.map((task) => heightOf(task.id))), 0)
            + (rowsOfLayer.length - 1) * DAG_GAP_CROSS)
        } else {
          bandMain.set(depth, rowsOfLayer.reduce((sum, row) => sum + Math.max(...row.map((task) => heightOf(task.id))), 0) + (rowsOfLayer.length - 1) * DAG_GAP_CROSS)
          bandCross.set(depth, Math.max(...rowsOfLayer.map((row) => row.length * nodeW + (row.length - 1) * DAG_GAP_CROSS)))
        }
        crossMax = Math.max(crossMax, bandCross.get(depth))
      }
      // 3) 定位：主轴游标按层主轴尺寸推进，副轴在内容带内居中（每组各自居中）
      const pos = new Map()
      let cursor = DAG_PAD
      for (const depth of depths) {
        const rowsOfLayer = layerRows.get(depth)
        if (dir === 'h') {
          /* CHG-85：层内横向并排 —— 一层的节点占若干个 x 槽位，组内并排、组间纵向 */
          const layerW = bandMain.get(depth)
          const widest = Math.max(...rowsOfLayer.map((row) => row.length * (nodeW + DAG_GAP_CROSS) - DAG_GAP_CROSS))
          let groupY = DAG_PAD + (crossMax - bandCross.get(depth)) / 2
          for (const row of rowsOfLayer) {
            const rowH = Math.max(...row.map((task) => heightOf(task.id)))
            const rowW = row.length * (nodeW + DAG_GAP_CROSS) - DAG_GAP_CROSS
            let x = cursor + (layerW - rowW) / 2
            for (const task of row) {
              pos.set(task.id, { x, y: groupY, w: nodeW, h: heightOf(task.id) })
              x += nodeW + DAG_GAP_CROSS
            }
            groupY += rowH + DAG_GAP_CROSS
          }
        } else {
          let rowY = cursor
          for (const row of rowsOfLayer) {
            const rowW = row.length * nodeW + (row.length - 1) * DAG_GAP_CROSS
            let x = DAG_PAD + (crossMax - rowW) / 2
            const rowH = Math.max(...row.map((task) => heightOf(task.id)))
            for (const task of row) {
              pos.set(task.id, { x, y: rowY, w: nodeW, h: heightOf(task.id) })
              x += nodeW + DAG_GAP_CROSS
            }
            rowY += rowH + DAG_GAP_CROSS
          }
        }
        cursor += bandMain.get(depth) + DAG_GAP_MAIN
      }
      // 4) 画布撑满容器：宽高取「内容 vs 容器」较大值，内容在画布里居中（design 宽度修正）
      const contentW = dir === 'h' ? cursor - DAG_GAP_MAIN + DAG_PAD : crossMax + DAG_PAD * 2
      const contentH = dir === 'h' ? crossMax + DAG_PAD * 2 : cursor - DAG_GAP_MAIN + DAG_PAD
      const canvasW = Math.max(contentW, avail.w)
      const canvasH = Math.max(contentH, avail.h)
      const extraX = Math.max(0, (canvasW - contentW) / 2)
      const extraY = Math.max(0, (canvasH - contentH) / 2)
      // 5) 在跑的依赖链 = 运行节点 + 全部上游 + 全部下游（design/dag.js 的 HOT 口径）
      const hot = new Set()
      for (const task of tasks) {
        if (dagChipOf(task.state) !== 'run') continue
        hot.add(task.id)
        const walkUp = (id) => {
          for (const dep of byId.get(id)?.deps ?? []) {
            if (byId.has(dep) && !hot.has(dep)) { hot.add(dep); walkUp(dep) }
          }
        }
        walkUp(task.id)
      }
      let hotChanged = true
      while (hotChanged) {
        hotChanged = false
        for (const task of tasks) {
          if (hot.has(task.id)) continue
          if ((task.deps ?? []).some((dep) => hot.has(dep))) { hot.add(task.id); hotChanged = true }
        }
      }
      const edges = []
      for (const task of tasks) {
        for (const dep of task.deps ?? []) {
          if (!byId.has(dep)) continue
          const a = pos.get(dep)
          const b = pos.get(task.id)
          if (!a || !b) continue
          let d
          if (dir === 'h') {
            const sx = a.x + a.w + 1
            const sy = a.y + a.h / 2
            const tx = b.x - 2
            const ty = b.y + b.h / 2
            const c = Math.max(24, Math.abs(tx - sx) * 0.45)
            d = `M${sx} ${sy} C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}`
          } else {
            const sx = a.x + a.w / 2
            const sy = a.y + a.h + 1
            const tx = b.x + b.w / 2
            const ty = b.y - 2
            const c = Math.max(20, Math.abs(ty - sy) * 0.45)
            d = `M${sx} ${sy} C${sx} ${sy + c} ${tx} ${ty - c} ${tx} ${ty}`
          }
          const isHot = hot.has(dep) && hot.has(task.id)
          const dim = Boolean(focus) && !(dep === focus || task.id === focus || (chain.has(dep) && chain.has(task.id)))
          edges.push(j('path', {
            key: `${dep}->${task.id}`,
            d,
            className: 'mt-dag-edge' + (isHot ? ' mt-dag-edge-hot' : '') + (dim ? ' mt-dag-edge-dim' : ''),
            markerEnd: isHot ? 'url(#mt-arrow-hot)' : 'url(#mt-arrow)',
            'data-from': dep,
            'data-to': task.id,
          }))
        }
      }
      const nodeClass = (id) => {
        const focused = focus === id
        const related = !focus || focused || chain.has(id) || hot.has(id)
        return 'mt-dag-card mt-dag-card-' + dagChipOf(byId.get(id)?.state)
          + (focused ? ' mt-dag-node-focus' : '')
          + (hot.has(id) && !focused ? ' mt-dag-node-chain' : '')
          + (related ? '' : ' mt-dag-node-dim')
      }
      return js('div', {
        className: 'mt-dagwrap',
        ref: (el) => { wrapRef.current = el },
        children: [
          js('div', { className: 'mt-dag-canvas', style: { width: `${canvasW}px`, height: `${canvasH}px` }, children: [
            j('svg', {
              className: 'mt-dag-svg',
              width: canvasW,
              height: canvasH,
              viewBox: `0 0 ${canvasW} ${canvasH}`,
              role: 'img',
              'aria-label': t('dag.graphLabel'),
              children: [
                j('defs', { children: [
                  j('marker', { id: 'mt-arrow', viewBox: '0 0 10 10', refX: 8.6, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse', children: j('path', { d: 'M0 1 L9.2 5 L0 9 z', className: 'mt-dag-arrow' }) }),
                  j('marker', { id: 'mt-arrow-hot', viewBox: '0 0 10 10', refX: 8.6, refY: 5, markerWidth: 8.5, markerHeight: 8.5, orient: 'auto-start-reverse', children: j('path', { d: 'M0 1 L9.2 5 L0 9 z', className: 'mt-dag-arrow-hot' }) }),
                ] }),
                ...edges,
              ],
            }),
            ...tasks.map((task) => {
              const p = pos.get(task.id)
              const chip = dagChipOf(task.state)
              const names = (task.assignees ?? []).slice(0, 2).map((id) => memberName?.(id) ?? id)
              return js('button', {
                key: task.id,
                ref: (el) => { if (el) nodeRefs.current.set(task.id, el); else nodeRefs.current.delete(task.id) },
                className: nodeClass(task.id),
                style: { left: `${p.x + (dir === 'v' ? extraX : 0)}px`, top: `${p.y + (dir === 'h' ? extraY : 0)}px`, width: `${p.w}px` },
                'aria-current': focus === task.id ? 'true' : undefined,
                title: t('dag.hint'),
                onClick: () => setFocus(focus === task.id ? null : task.id),
                onDoubleClick: () => onOpen(task.id),
                children: [
                  js('div', { className: 'mt-dag-card-top', children: [
                    j('span', { className: 'mt-dag-code', children: task.code ?? task.id }),
                    js('span', { className: `mt-dag-chip mt-dag-chip-${chip}`, children: [
                      j('span', { className: 'mt-task-dot ' + stateDotClass(task.state), 'aria-hidden': true }),
                      j('span', { children: stateLabel(task.state) }),
                    ] }),
                  ] }),
                  j('div', { className: 'mt-dag-card-title', children: task.title }),
                  js('div', { className: 'mt-dag-card-meta', children: [
                    names.length > 0 ? j('span', { children: names.join('、') }) : null,
                    (task.participants ?? []).length > 1 ? j('span', { children: t('dag.teams').replace('{n}', String((task.participants ?? []).length)) }) : null,
                    task.evidenceCount > 0 ? j('span', { children: t('dag.evidence').replace('{n}', String(task.evidenceCount)) }) : null,
                    task.model ? j('span', { className: 'mt-task-model', title: task.model, children: task.model }) : null,
                  ] }),
                ],
              })
            }),
          ] }),
        ],
      })
    }


    /* ── 审计回放（design/audit.html：按任务/角色/时间三档 + attempt 分组 + 只读标注 + 分页）── */
    const AUDIT_VIEWS = ['task', 'member', 'time']
    /** 事件 → 圆点语义（claimed 领取 / run 进展 / warn 门禁·知识 / failed 失败；颜色只作第三顺位） */
    const auditDotClass = (type) => {
      const raw = String(type ?? '')
      if (raw === 'task.claimed' || raw === 'task.assigned' || raw === 'plan.approved' || raw === 'plan.staged') return 'mt-evdot-claimed'
      if (raw === 'task.progress' || raw === 'task.evidence' || raw === 'task.completed' || raw === 'task.deliverable') return 'mt-evdot-run'
      if (raw === 'task.failed' || raw === 'team.disbanded' || raw === 'task.cancelled') return 'mt-evdot-failed'
      if (raw === 'task.escalated' || raw === 'task.gate.result' || raw === 'plan.revised' || raw.startsWith('knowledge.')) return 'mt-evdot-warn'
      return ''
    }
    /** 审计左轨的任务状态点（design/audit.html：门禁 = 琥珀菱形，其余走状态点；文字另有，颜色只作第三顺位） */
    const auditRailDotClass = (state) => {
      const raw = String(state ?? '')
      if (!raw) return 'mt-mdot'
      if (raw.startsWith('gate')) return 'mt-mdot mt-mdot-gate'
      if (raw === 'done' || raw === 'failed' || raw === 'blocked' || raw === 'cancelled' || raw === 're-scoping') return `mt-mdot ${stateDotClass(raw)}`
      if (raw === 'in_progress' || raw === 'running') return 'mt-mdot mt-task-dot-active'
      return 'mt-mdot'
    }
    /** 事件流 → attempt 分组（task.claimed / task.rescoped 开启新一次尝试；返回新→旧） */
    const auditAttempts = (events) => {
      const asc = [...(events ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq))
      const groups = []
      for (const event of asc) {
        const startsAttempt = String(event.type) === 'task.claimed' || String(event.type) === 'task.rescoped'
        if (groups.length === 0 || startsAttempt) groups.push({ start: event.ts, end: event.ts, events: [] })
        const group = groups[groups.length - 1]
        group.end = event.ts
        group.events.push(event)
      }
      const total = groups.length
      return groups.reverse().map((group, index) => ({ ...group, index: total - index }))
    }
    /** 事件流 → 按任务分组（新→旧，按最后一条事件时间排序） */
    const auditTasks = (events) => {
      const map = new Map()
      for (const event of events ?? []) {
        const id = event.taskId ?? '—'
        const bucket = map.get(id)
        if (bucket) { bucket.events.push(event); bucket.last = Math.max(bucket.last, Number(event.ts) ?? 0) } else map.set(id, { taskId: id, events: [event], last: Number(event.ts) ?? 0 })
      }
      return [...map.values()].sort((a, b) => b.last - a.last)
    }
    const fmtClock = (ts) => {
      if (!ts) return '—'
      const d = new Date(ts)
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
      return d.toDateString() === now.toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
    }

    function AuditTab({ t, audit, tasks, filter, setFilter, onMore, onOpen, memberName }) {
      const [pickedTaskId, setPickedTaskId] = react.useState(null)
      if (audit === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (!audit) return j('div', { className: 'mt-empty', children: t('audit.empty') })
      const view = AUDIT_VIEWS.includes(filter) ? filter : 'task'
      const events = audit.events ?? []
      const groups = auditTasks(events)
      const taskOf = (id) => (tasks ?? []).find((task) => task.id === id)
      const pickedId = pickedTaskId && groups.some((group) => group.taskId === pickedTaskId) ? pickedTaskId : groups[0]?.taskId
      const pickedGroup = groups.find((group) => group.taskId === pickedId)
      const pickedTask = pickedId ? taskOf(pickedId) : undefined
      const roleOf = (task) => (task?.requiredRole ? roleLabel(task.requiredRole) : t('audit.role'))
      const exportJsonl = () => {
        const text = events.map((event) => JSON.stringify(event)).join('\n')
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {})
        } catch { /* 剪贴板不可用：静默 */ }
      }
      const renderRow = (event) => js('li', { className: 'mt-evrow', key: event.seq, children: [
        j('span', { className: 'mt-evtime', children: fmtClock(event.ts) }),
        j('span', { className: `mt-evdot ${auditDotClass(event.type)}`.trim(), 'aria-hidden': true }),
        js('div', { className: 'mt-evmain', children: [
          js('div', { className: 'mt-evrow-title', children: [
            j('b', { className: 'mt-audit-type', title: event.type, children: eventLabel(event.type) }),
            j('span', { className: 'mt-who', children: actorLabel(event.actor, memberName) }),
            event.taskId ? j('button', { className: 'mt-mini-chip', onClick: () => onOpen(event.taskId), children: event.taskId }) : null,
          ] }),
          j('div', { className: 'mt-evrow-note', children: `#${event.seq} · ${t('audit.taskLabel')} ${event.taskId ?? '—'}` }),
        ] }),
      ] })
      const attemptBlock = (group) => [
        js('div', { className: 'mt-attempt-sep', key: `sep-${group.index}`, children: [
          j('span', { children: `${t('audit.attempt').replace('{n}', String(group.index))} · ${fmtClock(group.start)} – ${fmtClock(group.end)}` }),
          j('span', { className: 'mt-attempt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-mini-chip', children: t('audit.attemptEvents').replace('{n}', String(group.events.length)) }),
        ] }),
        js('ol', { className: 'mt-evstream', key: `stream-${group.index}`, children: group.events.map(renderRow) }),
      ]
      const body = view === 'task'
        ? [
            js('aside', { className: 'mt-audit-rail', children: [
              j('div', { className: 'mt-audit-cap', children: t('audit.cap') }),
              ...groups.map((group) => {
                const task = taskOf(group.taskId)
                return js('button', {
                  key: group.taskId,
                  className: 'mt-audit-item',
                  'aria-current': group.taskId === pickedId ? 'true' : undefined,
                  onClick: () => setPickedTaskId(group.taskId),
                  children: [
                    j('span', { className: 'mt-tid', children: group.taskId }),
                    js('span', { className: 'mt-audit-item-main', children: [
                      j('b', { children: task?.title ?? group.taskId }),
                      j('span', { children: `${roleOf(task)} · ${t('audit.attemptEvents').replace('{n}', String(group.events.length))} · ${t('audit.attempts').replace('{n}', String(auditAttempts(group.events).length))}` }),
                    ] }),
                    j('span', { className: auditRailDotClass(task?.state), 'aria-hidden': true }),
                  ],
                })
              }),
            ] }),
            js('section', { className: 'mt-audit-pane', children: [
              js('div', { className: 'mt-audit-head', children: [
                js('div', { children: [
                  j('div', { className: 'mt-audit-eyebrow', children: t('audit.eyebrow').replace('{id}', pickedId ?? '—').replace('{role}', roleOf(pickedTask)).replace('{n}', String(pickedGroup?.events.length ?? 0)) }),
                  j('h3', { className: 'mt-audit-title', children: pickedTask?.title ?? pickedId ?? t('audit.empty') }),
                ] }),
                pickedId ? js('div', { className: 'mt-audit-head-actions', children: [
                  j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onOpen(pickedId), children: t('audit.detail') }),
                ] }) : null,
              ] }),
              ...auditAttempts(pickedGroup?.events ?? []).flatMap(attemptBlock),
              js('div', { className: 'mt-note-box mt-note-info', children: [
                j('span', { children: t('audit.ledgerNote') }),
                j('div', { className: 'mt-audit-ledger-path', children: `.dsh-myteam/tasks/${pickedId ?? '—'}/ledger.jsonl · ${audit.total ?? events.length}` }),
              ] }),
              audit.nextBeforeSeq
                ? j('button', { className: 'mt-btn', onClick: onMore, children: t('audit.loadMore').replace('{n}', '100') })
                : j('div', { className: 'mt-hint', children: t('audit.end') }),
            ] }),
          ]
        : view === 'member'
          ? [js('section', { className: 'mt-audit-pane', children: [...new Set(events.map((event) => String(event.actor ?? '—')))].sort().flatMap((actor) => {
            const mine = events.filter((event) => String(event.actor) === actor)
            return [
              js('div', { className: 'mt-attempt-sep', key: `who-${actor}`, children: [
                j('span', { children: actorLabel(actor, memberName) }),
                j('span', { className: 'mt-attempt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-mini-chip', children: t('audit.attemptEvents').replace('{n}', String(mine.length)) }),
              ] }),
              js('ol', { className: 'mt-evstream', key: `whos-${actor}`, children: mine.map(renderRow) }),
            ]
          }) })]
          : [js('section', { className: 'mt-audit-pane', children: [
              js('ol', { className: 'mt-evstream', children: events.map(renderRow) }),
            ] })]
      return js('div', { className: 'mt-audit-page', children: [
        js('div', { className: 'mt-audit-segbar', children: [
          js('div', { className: 'mt-audit-seg', role: 'group', 'aria-label': t('audit.title'), children: AUDIT_VIEWS.map((key) => j('button', {
            key,
            className: view === key ? 'mt-audit-segbtn mt-audit-segbtn-on' : 'mt-audit-segbtn',
            'aria-pressed': view === key,
            onClick: () => setFilter(key),
            children: t(`audit.view.${key}`),
          })) }),
          js('div', { className: 'mt-audit-segright', children: [
            j('span', { className: 'mt-mini-chip', children: t('audit.events').replace('{n}', String(audit.total ?? events.length)) }),
            j('span', { className: 'mt-mini-chip', children: t('audit.derived') }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: exportJsonl, children: t('audit.export') }),
          ] }),
        ] }),
        js('div', { className: view === 'task' ? 'mt-audit-body' : 'mt-audit-body mt-audit-body-single', children: body }),
      ] })
    }

    /* ── 团队设置（design/settings.html：配置来源三层合并链 + 行为配置硬上限 + 状态目录 + 生命周期）── */
    const CONFIG_CEILINGS = { maxMembers: 6, memberMaxDepth: 0, commandTimeoutMs: 600000 }
    const LAYER_ICONS = {
      builtin: ['M4.6 7.4V5.6a3.4 3.4 0 0 1 6.8 0v1.8', 'M3.4 7.4h9.2v5.4H3.4z'],
      global: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z', 'M2.2 8h11.6', 'M8 2.2c2.5 3.4 2.5 8.2 0 11.6'],
      project: ['M2.4 5.2 8 2.6l5.6 2.6v5.6L8 13.4 2.4 10.8z', 'M2.4 5.2 8 7.8l5.6-2.6M8 7.8v5.6'],
    }
    const layerIcon = (key) => j('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      children: (LAYER_ICONS[key] ?? []).map((d, index) => j('path', { key: index, d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' })),
    })

    function SettingsTab({ t, config, offline, team, connection, onDisbanded }) {
      const [impact, setImpact] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const [showJson, setShowJson] = react.useState(false)
      /* CHG-89（M2-E / FR-16.3）：会话移交——摘要 → 新团队预设会话。
       * 两段确认：第一段无 confirm 只做能力探测 + 摘要预览，第二段才真建会话。 */
      const [handoffBusy, setHandoffBusy] = react.useState(false)
      const [handoffErr, setHandoffErr] = react.useState(null)
      const [handoffResult, setHandoffResult] = react.useState(null)
      if (config === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (!config) return j('div', { className: 'mt-empty', children: offline ? t('settings.offline') : t('settings.notWired') })
      const c = config.config ?? {}
      const limits = c.limits ?? {}
      const gates = c.gates ?? {}
      const sections = Object.keys(c).length
      const activeLayer = (key) => (config.chain ?? []).some((item) => item.layer === key && item.active === true) || config.source === key
      const pending = Math.max(0, Number(team?.counts?.tasks ?? 0) - Number(team?.counts?.done ?? 0))
      const askDisband = async () => {
        if (!team?.online) return
        try {
          const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: false })
          if (r?.status === 'confirm-required') setImpact(r.impact ?? {})
        } catch (e) { setErr(String(e?.message ?? e)) }
      }
      const doDisband = async () => {
        if (!team?.online || busy) return
        setBusy(true)
        try {
          const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: true })
          if (r?.ok === false || r?.status === 'error') { setErr(r?.message ?? t('settings.failed').replace('{msg}', '')); return }
          setImpact(null)
          onDisbanded?.()
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
      }
      /**
       * CHG-89（M2-E / FR-16.3）：会话移交的两段式入口。
       *
       * 为什么面板侧要加一段确认：移交会**程序化新建一个团队预设会话**并注入摘要——
       * 这是用户可见的副作用（新会话会出现），不能点一下就发生。服务端 `handoffTeam`
       * 本身是单段的（它只管「建会话 + 注入」），确认放在这里。
       *
       * 失败不静默：`MT_UNAVAILABLE`（宿主无 sessionController）与「注入失败但会话已建」
       * 都原样回显——后者服务端会带 `sessionId`，人可以手动粘贴摘要。
       */
      const askHandoff = () => {
        if (!team?.online || !team?.sessionId || handoffBusy) return
        setHandoffErr(null)
        setHandoffResult({ stage: 'confirm' })
      }
      const doHandoff = async () => {
        if (!team?.online || !team?.sessionId || handoffBusy) return
        setHandoffErr(null)
        setHandoffBusy(true)
        try {
          const r = await makeApi(connection, team.sessionId).handoff({
            teamId: team.teamId,
            sourceSessionId: team.sessionId,
          })
          if (r?.status === 'ok') {
            setHandoffResult({ stage: 'done', sessionId: r.sessionId, summary: r.summary, metadata: r.metadata, note: r.note })
            return
          }
          /* 会话已建但注入失败：把 sessionId 一起显示，用户可手动粘贴摘要 */
          setHandoffResult(r?.sessionId ? { stage: 'partial', sessionId: r.sessionId, message: r.message ?? r.code } : null)
          setHandoffErr(r?.message ?? r?.code ?? t('settings.handoffFailed').replace('{msg}', ''))
        } catch (e) {
          setHandoffErr(t('settings.handoffFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setHandoffBusy(false)
        }
      }
      const layerRow = (key, title, src, path, n, unit) => js('div', { className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-${key}`, 'aria-hidden': true, children: layerIcon(key) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [title, j('span', { className: key === 'builtin' ? 'mt-src' : `mt-src mt-src-${key}`, children: src })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), unit ? j('span', { children: unit }) : null] }),
      ] })
      const row = (key, title, sub, act) => js('div', { className: 'mt-setrow', key, children: [
        js('div', { className: 'mt-setrow-main', children: [
          j('div', { className: 'mt-setrow-title', children: title }),
          j('div', { className: 'mt-setrow-sub', children: sub }),
        ] }),
        js('div', { className: 'mt-setrow-act', children: act }),
      ] })
      const numInput = (value, label) => j('input', { className: 'mt-input-num', value: String(value ?? ''), readOnly: true, tabIndex: -1, 'aria-label': label })
      const toggle = (checked, label) => j('button', { className: 'mt-toggle', role: 'switch', 'aria-checked': Boolean(checked), 'aria-label': label, disabled: true })
      const ceiling = (value) => j('span', { className: 'mt-readonly-val', children: t('settings.ceiling').replace('{v}', String(value)) })
      return js('div', { className: 'mt-page mt-page-narrow', children: [
        js('div', { className: 'mt-page-head', children: [
          js('div', { children: [
            j('h2', { children: t('settings.page.title') }),
            j('p', { children: t('settings.page.desc') }),
          ] }),
          js('div', { className: 'mt-page-head-actions', children: [
            j('button', { className: 'mt-btn', 'aria-pressed': showJson, onClick: () => setShowJson(!showJson), children: t('settings.jsonView') }),
          ] }),
        ] }),
        showJson ? j('pre', { className: 'mt-json', children: JSON.stringify(c, null, 2) }) : null,
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.sourceTitle') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('settings.sourceNote') }),
          ] }),
          js('div', { className: 'mt-layers', children: [
            layerRow('builtin', t('settings.layer.default'), t('settings.layer.readonly'), t('settings.layer.defaultPath'), sections, t('settings.layer.items').replace('{n}', '')),
            layerRow('project', t('settings.layer.project'), t('settings.layer.thisFile'), t('settings.layer.projectPath'), activeLayer('project') ? sections : '—', activeLayer('project') ? t('settings.layer.covered').replace('{n}', '') : t('settings.layer.idle')),
            layerRow('global', t('settings.layer.team'), t('settings.layer.teamScope'), t('settings.layer.teamPath'), activeLayer('team') ? sections : '—', activeLayer('team') ? t('settings.layer.covered').replace('{n}', '') : t('settings.layer.idle')),
          ] }),
          js('div', { className: 'mt-merge-chain', children: [
            j('b', { className: activeLayer('default') ? 'mt-cur' : '', children: t('settings.layer.default') }),
            j('span', { className: 'mt-lt', children: '<' }),
            j('b', { className: activeLayer('project') ? 'mt-cur' : '', children: activeLayer('project') ? `${t('settings.layer.project')}${t('settings.layer.effective')}` : t('settings.layer.project') }),
            j('span', { className: 'mt-lt', children: '<' }),
            j('b', { className: activeLayer('team') ? 'mt-cur' : '', children: activeLayer('team') ? `${t('settings.layer.team')}${t('settings.layer.effective')}` : t('settings.layer.team') }),
            j('span', { children: t('settings.mergeNote') }),
          ] }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.behavior') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('settings.behaviorNote') }),
          ] }),
          js('div', { className: 'mt-setrows', children: [
            row('teamSize', t('settings.teamSize'), t('settings.teamSizeSub'), [ceiling(CONFIG_CEILINGS.maxMembers), numInput(limits.maxMembers, t('settings.teamSize'))]),
            row('depth', t('settings.delegateDepth'), t('settings.delegateDepthSub'), [ceiling(CONFIG_CEILINGS.memberMaxDepth), numInput(limits.memberMaxDepth, t('settings.delegateDepth'))]),
            row('gates', t('settings.gates'), t('settings.gatesSub'), [toggle(gates.enabled, t('settings.gates'))]),
            row('timeout', t('settings.gateTimeoutLabel'), t('settings.gateTimeoutSub'), [ceiling(CONFIG_CEILINGS.commandTimeoutMs / 1000), numInput(Number(gates.commandTimeoutMs ?? 0) / 1000, t('settings.gateTimeoutLabel')), j('span', { className: 'mt-hint', children: t('settings.seconds') })]),
            row('hideTools', t('settings.hideTools'), t('settings.hideToolsSub'), [toggle(false, t('settings.hideTools'))]),
            row('evidence', t('settings.evidenceLabel'), t('settings.evidenceSub'), [toggle(c.memory?.evidenceRequired, t('settings.evidenceLabel'))]),
          ] }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.stateDir') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          ] }),
          js('div', { className: 'mt-secbox', children: [
            js('div', { className: 'mt-inline-note', children: [
              j('button', { className: 'mt-btn mt-btn-sm', disabled: true, title: t('settings.readonlyTip'), children: t('settings.openDir') }),
            ] }),
            js('div', { className: 'mt-inline-note', children: [
              j('span', { className: 'mt-ok-ink', children: `✓ ${t('settings.gitignore')}` }),
              j('span', { children: t('settings.ledgerAppend') }),
            ] }),
          ] }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.lifecycle') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          ] }),
          js('div', { className: 'mt-setrows', children: [
            row('archive', t('settings.archiveTitle'), t('settings.archiveSub'), [j('button', { className: 'mt-btn mt-btn-sm', disabled: true, title: t('settings.readonlyTip'), children: t('settings.archiveBtn') })]),
            /* CHG-89（M2-E / FR-16.3）：会话移交——把当前团队上下文摘要带进一个新团队预设会话 */
            row('handoff', t('settings.handoffTitle'), t('settings.handoffSub'), [j('button', { className: 'mt-btn mt-btn-sm', disabled: !team?.online || handoffBusy, title: team?.online ? t('settings.handoffHint') : t('settings.offline'), onClick: askHandoff, children: handoffBusy ? t('state.loading') : t('settings.handoffBtn') })]),
            row('disband', j('span', { className: 'mt-danger-ink', children: t('settings.disbandTitle') }), t('settings.disbandSub').replace('{members}', String((team?.members ?? []).length)).replace('{tasks}', String(pending)), [j('button', { className: 'mt-btn mt-btn-danger mt-btn-sm', disabled: !team?.online, onClick: askDisband, children: t('settings.disbandBtn') })]),
          ] }),
          impact ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: t('disband.impact').replace('{members}', impactCountText(impact?.members)).replace('{tasks}', impactCountText(impact?.tasks)) }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: doDisband, children: busy ? t('state.loading') : t('settings.confirmDisband') }),
              j('button', { className: 'mt-btn', onClick: () => setImpact(null), children: t('settings.cancelDisband') }),
            ] }),
          ] }) : null,
          /* CHG-89：移交确认 / 结果（新会话 id + 摘要预览；原会话保留） */
          handoffResult?.stage === 'confirm' ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: t('settings.handoffConfirm') }),
            j('span', { children: t('settings.handoffConfirmBody').replace('{team}', String(team?.name ?? team?.teamId ?? '')) }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn mt-btn-primary', disabled: handoffBusy, onClick: doHandoff, children: handoffBusy ? t('state.loading') : t('settings.handoffConfirmBtn') }),
              j('button', { className: 'mt-btn', onClick: () => setHandoffResult(null), children: t('action.cancel') }),
            ] }),
          ] }) : null,
          handoffResult?.stage === 'done' || handoffResult?.stage === 'partial' ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: handoffResult.stage === 'done' ? t('settings.handoffDone') : t('settings.handoffPartial') }),
            j('span', { className: 'mt-rolechip mt-rolechip-mono', children: String(handoffResult.sessionId ?? '—') }),
            handoffResult.note ? j('span', { children: String(handoffResult.note) }) : null,
            handoffResult.summary ? j('pre', { className: 'mt-prompt-block', children: String(handoffResult.summary) }) : null,
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn', onClick: () => setHandoffResult(null), children: t('action.close') }),
            ] }),
          ] }) : null,
          handoffErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: handoffErr }) : null,
        ] }),
        js('p', { className: 'mt-note-box', children: [j('b', { children: t('settings.footNote') }), j('span', { children: t('settings.footNoteSub') })] }),
        (config.warnings ?? []).length > 0 ? j('div', { className: 'mt-note-box mt-note-info', children: `${t('settings.warnings')}：${config.warnings.join('；')}` }) : null,
        err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
      ] })
    }


    /* ── 成本栏（底部常驻：累计 token / 缓存命中率 / 今日未命中·输出 / 估算标注）── */
    const fmtTokens = (n) => {
      const value = Number(n ?? 0)
      if (!Number.isFinite(value) || value === 0) return '0'
      if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(value)
    }
    const dayKeyOf = (ts) => {
      const d = new Date(Number(ts) || Date.now())
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    const sumBuckets = (buckets) => {
      const sum = { calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const bucket of buckets) for (const key of Object.keys(sum)) sum[key] += Number(bucket?.[key] ?? 0)
      return sum
    }
    const hitRateOf = (sum) => {
      const denom = sum.uncachedInput + sum.cacheRead + sum.cacheWrite
      return denom === 0 ? null : sum.cacheRead / denom
    }
    function CostBar({ t, tokens, onOpen, readOnly }) {
      if (!tokens) return null
      const sum = sumBuckets(Object.values(tokens.totals ?? {}))
      const hit = hitRateOf(sum)
      const today = sumBuckets(Object.values((tokens.days ?? {})[dayKeyOf()] ?? {}))
      const item = (label, value) => js('div', { className: 'mt-costbar-item', children: [
        js('div', { children: [
          j('div', { className: 'mt-costbar-label', children: label }),
          j('div', { className: 'mt-costbar-val', children: value }),
        ] }),
      ] })
      return js('div', { className: 'mt-costbar', children: [
        item(t('costbar.total'), fmtTokens(sum.uncachedInput + sum.cacheRead + sum.cacheWrite + sum.output)),
        item(t('costbar.hitRate'), js('span', { children: [hit === null ? '—' : (hit * 100).toFixed(1), j('small', { children: '%' })] })),
        item(t('costbar.today'), js('span', { children: [`${fmtTokens(today.uncachedInput)} `, j('small', { children: '/' }), ` ${fmtTokens(today.output)}`] })),
        item(t('costbar.calls'), fmtTokens(sum.calls)),
        js('div', { className: 'mt-costbar-right', children: [
          readOnly
            ? j('span', { className: 'mt-mini-chip mt-tone-idle', children: t('archive.replayChip') })
            : j('span', { className: 'mt-mini-chip', title: t('costbar.na'), children: t('costbar.context') }),
          j('span', { className: 'mt-mini-chip', children: t('costbar.estimate') }),
          onOpen ? j('button', { className: 'mt-link', onClick: onOpen, children: t('cost.open') }) : null,
        ] }),
      ] })
    }

    /* ── 主工作台（常驻面板：全局视图=团队列表+角色↔团队关系；团队视图=工作台+任务流转）── */
/* ══ CHG-69：全局 / 项目双作用域面板（角色 · 团队 · 任务） ══ */

    /** 项目任务按状态分列（项目级看板：不依赖单个团队的 config 列） */
    const PROJECT_COLUMNS = [
      { name: '待规划', states: ['backlog'] },
      { name: '就绪', states: ['ready'] },
      { name: '进行中', states: ['in_progress', 're-scoping'] },
      { name: '门禁', states: ['gate:review', 'gate:verify', 'gate:archive'] },
      /* CHG-85：列名对齐 design/board.html（「已完成」；末列是虚线收口列） */
      { name: '已完成', states: ['done'] },
      { name: '未完成', states: ['failed', 'blocked', 'cancelled'], done: true },
    ]

    const projectColumnOf = (state) => {
      for (const col of PROJECT_COLUMNS) if (col.states.includes(state)) return col.name
      return PROJECT_COLUMNS[0].name
    }

    /** 项目任务行 → DAG 输入（id 用复合键，deps 同步映射；跨团队依赖不存在） */
    const toGraphTasks = (tasks) => tasks.map((task) => ({
      ...task,
      id: task.key,
      code: task.id,
      deps: (task.deps ?? []).map((dep) => `${task.ownerTeamId}/${dep}`),
    }))

    /** CHG-82 G2：角色卡按 design/roles.html 的 .card 结构——
     *  圆形头像 + 角色名/ID + 来源 chip + 描述 + 兴趣词 + 模型路由/Skill/MCP + 复制来源 + 脚（实例 / 用它单干 / 复制进项目）。
     *  CHG-74：同名副本要能一眼分辨——被压过的那份标「同名 X 副本（以此为准）」。 */
    function RoleCard({ t, role, onOpen, onGuest, onCopyToProject, onCompare, projectCopyExists }) {
      const words = role.interestWords ?? []
      const instances = (role.memberships ?? []).map((membership) => membership.instanceName)
      const fork = role.shadowedBy
        ? t('role.shadowedBy').replace('{origin}', t(`role.origin.${role.shadowedBy}`))
        : role.origin === 'project' && roleLabel(role.id) !== role.id
          ? t('roles.copiedFromBuiltin').replace('{name}', roleLabel(role.id))
          : null
      const copyAction = role.origin === 'project'
        ? null
        : projectCopyExists
          ? j('button', { className: 'mt-btn mt-btn-ghost mt-btn-sm', onClick: (event) => { event.stopPropagation(); onCompare?.(role) }, children: t('roles.compare') })
          : j('button', { className: 'mt-btn mt-btn-sm', onClick: (event) => { event.stopPropagation(); onCopyToProject?.(role) }, children: role.origin === 'global' ? t('roles.copyToProject') : t('roles.copyToProjectFresh') })
      return js('div', {
        className: 'mt-rolecard mt-rolecard-lib' + (role.isCaptain ? ' mt-rolecard-captain' : ''),
        role: 'button',
        tabIndex: 0,
        title: role.description,
        onClick: () => onOpen(role.id),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(role.id) },
        children: [
          js('div', { className: 'mt-rolecard-top', children: [
            j('span', { className: `mt-avatar ${role.isCaptain ? 'mt-avatar-lead' : avatarClassOf(role.id)}`, 'aria-hidden': true, children: avatarCharOf(role.name, role.id) }),
            js('div', { className: 'mt-rolecard-body', children: [
              js('div', { className: 'mt-rolecard-title', children: [
                j('strong', { children: role.name }),
                j('span', { className: 'mt-rolecard-id', children: role.id }),
                j('span', { className: 'mt-chip mt-chip-origin', title: role.pluginId ? t('contrib.providedBy').replace('{plugin}', role.pluginId) : undefined, children: role.origin === 'builtin' || role.origin === 'plugin' ? `🔒 ${t(`role.origin.${role.origin}`)}` : t(`role.origin.${role.origin}`) }),
              ] }),
              j('div', { className: 'mt-rolecard-sub', children: role.description }),
              js('div', { className: 'mt-rolecard-row', children: [
                j('span', { className: 'mt-rolecard-rowlabel', children: t('roles.interest') }),
                ...(words.length > 0
                  ? words.map((word) => j('span', { key: word, className: 'mt-rolechip', children: word }))
                  : [j('span', { className: 'mt-hint', children: t('roles.interestEmpty') })]),
              ] }),
            ] }),
          ] }),
          js('div', { className: 'mt-rolecard-row', children: [
            j('span', { className: 'mt-rolechip mt-rolechip-mono', children: role.model ? `${role.model.provider}/${role.model.model}` : t('roles.inheritRoute') }),
            j('span', { className: 'mt-rolechip', children: t('roles.skillCount').replace('{n}', String((role.skills ?? []).length)) }),
            j('span', { className: 'mt-rolechip', children: t('roles.mcpCount').replace('{n}', String((role.mcpAllowlist ?? []).length)) }),
          ] }),
          fork ? js('div', { className: 'mt-rolecard-row mt-rolecard-fork', children: [
            j('span', { className: 'mt-rolecard-fork-ico', 'aria-hidden': true, children: '⑂' }),
            j('span', { children: fork }),
          ] }) : null,
          js('div', { className: 'mt-rolecard-foot', children: [
            /* design/roles.html：队长卡脚只写「不可召唤 · 即当前会话」（不列 0 实例） */
            role.isCaptain && instances.length === 0
              ? null
              : role.origin === 'project'
                ? (instances.length > 0
                  ? js('span', { className: 'mt-rolecard-instances', children: instances.slice(0, 4).map((name) => j('span', { key: name, className: 'mt-rolechip mt-rolechip-mono', children: name })) })
                  : j('span', { className: 'mt-hint', children: t('roles.zeroInstances') }))
                : j('span', { className: 'mt-hint', children: role.origin === 'global' ? t('roles.zeroInstances') : projectCopyExists ? t('roles.hasCopy') : t('roles.noCopy') }),
            role.isCaptain
              ? j('span', { className: 'mt-rolecard-lock', children: t('roles.captainLock') })
              : j('button', { className: 'mt-link', onClick: (event) => { event.stopPropagation(); onGuest?.(role) }, children: t('roles.guest') }),
            copyAction,
            role.origin === 'project' && instances.length > 0
              ? j('span', { className: 'mt-hint', children: t('roles.instanceCount').replace('{n}', String(instances.length)) })
              : null,
          ] }),
        ],
      })
    }

    /** 项目自身角色卡（design/roles.html 的 .team-card：名称 + ID chip + 在线点 + 描述 + meta） */
    function ProjectRoleCard({ t, role, onOpen }) {
      return js('div', { className: 'mt-team-card mt-projectrole-card', children: [
        js('div', { className: 'mt-team-head', children: [
          j('strong', { children: role.name }),
          j('span', { className: 'mt-chip mt-chip-idle', children: [j('span', { className: 'mt-shape mt-shape-idle', 'aria-hidden': true }), role.id] }),
          j('span', { className: 'mt-team-zone', children: [j('span', { className: 'mt-team-dot', 'aria-hidden': true }), t('roles.projectRoleOnline')] }),
        ] }),
        j('p', { className: 'mt-team-desc', children: role.description }),
        js('p', { className: 'mt-team-meta', children: [
          j('span', { children: role.model ? `${role.model.provider}/${role.model.model}` : t('roles.inheritRoute') }),
          j('span', { children: t('roles.skillCount').replace('{n}', String((role.skills ?? []).length)) }),
          j('span', { children: t('roles.mcpCount').replace('{n}', String((role.mcpAllowlist ?? []).length)) }),
          j('button', { className: 'mt-link', onClick: () => onOpen(role.id), children: t('roles.detail') }),
        ] }),
      ] })
    }

    /** 创建角色虚线卡（design/roles.html 最后一格） */
    function RoleCardCreate({ t, onCreate }) {
      return js('button', { className: 'mt-rolecard mt-rolecard-lib mt-rolecard-create', onClick: () => onCreate?.(), children: [
        j('span', { className: 'mt-rolecard-create-ico', 'aria-hidden': true, children: '＋' }),
        j('span', { className: 'mt-rolecard-create-title', children: t('roles.createRole') }),
        j('span', { className: 'mt-rolecard-create-hint', children: t('roles.createRoleHint') }),
      ] })
    }

    /** CHG-82 G2：角色库（design/roles.html）——三层来源分区 + 搜索/来源筛选 + 引用计数 + 复制/对比 + 创建卡 */
    function RoleLibrary({ t, pv, onOpen, onGuest, onCopyToProject, onCompare, onCreate, onIntroGlobal }) {
      const [query, setQuery] = react.useState('')
      const [originFilter, setOriginFilter] = react.useState('all')
      const roles = pv?.roles ?? []
      const needle = String(query ?? '').trim().toLowerCase()
      const hit = (role) => !needle || [role.name, role.id, role.description].some((text) => String(text ?? '').toLowerCase().includes(needle))
      const projectIds = new Set(roles.filter((role) => role.origin === 'project').map((role) => role.id))
      const countOf = (origin) => roles.filter((role) => role.origin === origin).length
      const sections = [
        { origin: 'project', note: t('roles.projectSectionNote') },
        { origin: 'global', note: t('roles.globalSectionNote') },
        { origin: 'builtin', note: t('roles.builtinSectionNote') },
      ]
      return js('div', { className: 'mt-page', children: [
        js('div', { className: 'mt-page-head', children: [
          js('div', { children: [j('h2', { children: t('roles.page.title') }), j('p', { children: t('roles.page.desc') })] }),
          js('div', { className: 'mt-page-head-actions', children: [
            j('button', { className: 'mt-btn mt-btn-primary', onClick: () => onIntroGlobal?.(), children: `↗ ${t('roles.introGlobal')}` }),
            j('button', { className: 'mt-btn', onClick: () => onCreate?.(), children: `＋ ${t('roles.chatCreate')}` }),
          ] }),
        ] }),
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('roles.projectRole') }),
          j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          j('span', { className: 'mt-dsec-n', children: t('roles.projectRoleNote') }),
        ] }),
        pv?.projectRole
          ? j(ProjectRoleCard, { t, role: pv.projectRole, onOpen })
          : j('div', { className: 'mt-hint', children: t('roles.noProjectRole') }),
        js('div', { className: 'mt-filterbar', children: [
          js('label', { className: 'mt-searchfield', children: [
            j('span', { className: 'mt-searchfield-ico', 'aria-hidden': true, children: '⌕' }),
            j('input', {
              type: 'search',
              value: query,
              placeholder: t('roles.searchPlaceholder'),
              'aria-label': t('roles.searchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
            }),
          ] }),
          js('div', { className: 'mt-seg-group', role: 'group', 'aria-label': t('roles.page.title'), children: [
            ['all', t('roles.filter.all'), roles.length],
            ['project', t('roles.filter.project'), countOf('project')],
            ['global', t('roles.filter.global'), countOf('global')],
            ['builtin', t('roles.filter.builtin'), countOf('builtin')],
          ].map(([value, label, count]) => j('button', {
            key: value,
            className: 'mt-segbtn',
            'aria-pressed': originFilter === value,
            onClick: () => setOriginFilter(value),
            children: `${label} ${count}`,
          })) }),
          j('span', { className: 'mt-hint', children: t('roles.filterHint') }),
        ] }),
        ...sections.filter((section) => originFilter === 'all' || originFilter === section.origin).map((section) => {
          const list = roles.filter((role) => role.origin === section.origin && hit(role))
          return js('div', { className: 'mt-dsec-block', key: section.origin, children: [
            js('div', { className: 'mt-dsec-head', children: [
              j('h4', { children: `${t(`role.origin.${section.origin}`)} · ${countOf(section.origin)}` }),
              j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
              j('span', { className: 'mt-dsec-n', children: section.note }),
            ] }),
            list.length === 0 && section.origin !== 'project'
              ? j('div', { className: 'mt-hint', children: needle ? t('roles.noMatch') : t('roles.empty') })
              : js('div', { className: 'mt-cardgrid mt-cardgrid-3', children: [
                ...list.map((role) => j(RoleCard, {
                  key: `${role.origin}:${role.id}`,
                  t,
                  role,
                  onOpen,
                  onGuest,
                  onCopyToProject,
                  onCompare,
                  projectCopyExists: projectIds.has(role.id),
                })),
                section.origin === 'project' ? j(RoleCardCreate, { key: 'create-role', t, onCreate }) : null,
              ] }),
          ] })
        }),
        js('p', { className: 'mt-note mt-note-alert', children: [
          j('span', { className: 'mt-note-ico', 'aria-hidden': true, children: '!' }),
          j('span', { children: t('roles.deleteGuard') }),
        ] }),
      ] })
    }

    /** CHG-82 G2：角色详情（design/role-detail.html）——
     *  左列：定义与设定（职责 / 边界 / 兴趣词 + 系统提示词块 + 模型路由）· 技能（启用开关）· MCP 与工具；
     *  侧列：在册情况（跨团队聘任与实例）· 快照规则 · 操作（复制到项目 / 在队长会话试召唤 / 删除）。
     *  CHG-73：删除角色两段确认（先展示 usage）。 */
    /**
     * CHG-91（插件团队贡献契约 v1 / docs/16 §12.3）：「插件贡献」区块。
     *
     * 为什么要有它（而不是让插件角色混在全局库里）：**用户必须能看出「这个角色是谁给的」**——
     *  - 插件来源只读（想改走「复制到项目」），混在可编辑列表里会让人以为编辑坏了；
     *  - 插件装载失败必须**大声**（P4）：有 error 时顶部红条 + 每条带修法；
     *  - 装/卸插件不必重启宿主：一个「重新扫描插件」按钮。
     */
    /**
     * CHG-93：插件贡献区块的**纯渲染函数**（无状态）。
     *
     * 为什么抽出来：面板只负责「取数 + 触发重扫」，而「空态 / 有插件 / 有 error 红条」
     * 三个分支是**数据决定的**——抽成纯函数才能逐分支断言（CDP 只能验一个真实状态，
     * 单测能验全部）。
     *
     * @param data `undefined` = 加载中（渲染外壳 + loading 占位，不闪烁）
     */
    function contributionsBody(t, data, { busy = false, onReload, err } = {}) {
      const loading = data === undefined
      const plugins = data?.plugins ?? []
      const roles = data?.roles ?? []
      const teams = data?.teams ?? []
      const warnings = data?.warnings ?? []
      const errors = warnings.filter((warning) => warning.level === 'error')
      const displayNameOf = (pluginId) => (plugins.find((plugin) => plugin.pluginId === pluginId)?.displayName ?? pluginId)
      return js('section', { className: 'mt-sec mt-contrib', id: 'mt-contributions-section', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('contrib.title') }),
          j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          j('button', { className: 'mt-btn mt-btn-sm', disabled: busy, onClick: onReload, children: busy ? t('contrib.reloading') : t('contrib.reload') }),
        ] }),
        j('p', { className: 'mt-hint', children: t('contrib.desc') }),
        errors.length > 0
          ? js('div', { className: 'mt-banner mt-error-banner', role: 'alert', children: [
            j('strong', { children: t('contrib.warnTitle').replace('{n}', String(errors.length)) }),
            j('div', { className: 'mt-hint', children: t('contrib.warnHint') }),
            js('ul', { className: 'mt-contrib-warns', children: warnings.map((warning, index) => j('li', {
              key: `w-${index}`,
              className: warning.level === 'error' ? 'mt-contrib-warn-err' : 'mt-contrib-warn-info',
              children: [j('code', { children: warning.code }), ` ${warning.message}`],
            })) }),
          ] })
          : null,
        loading
          ? j('div', { className: 'mt-hint', children: t('state.loading') })
          : plugins.length === 0
            ? j('div', { className: 'mt-empty', children: t('contrib.empty') })
            : js('div', { className: 'mt-contrib-body', children: plugins.map((plugin) => js('div', { key: plugin.pluginId, className: 'mt-contrib-plugin', children: [
              /* CHG-106：能力包头部——包名 + 版本 + 计数（一行读完「这是什么、带了多少能力」） */
              js('div', { className: 'mt-contrib-plugin-head', children: [
                j('span', { className: 'mt-contrib-pack-glyph', 'aria-hidden': true, title: plugin.pluginId, children: '▣' }),
                j('strong', { children: plugin.displayName }),
                j('span', { className: 'mt-rolechip mt-rolechip-mono', children: `v${plugin.version}` }),
                j('span', { className: 'mt-contrib-counts', children: `${t('contrib.capRoles')} ${plugin.roles.length} · ${t('contrib.capTeams')} ${plugin.teams.length}` }),
              ] }),
              /* CHG-106：能力用**内联胶囊**平铺——一个包一条能力行，横向排满就换行，
               * 不再「一个角色占一整行、名字和 id 之间拉一条空档」。 */
              js('div', { className: 'mt-contrib-caps', children: [
                roles.length > 0 ? js('div', { className: 'mt-contrib-cap-row', children: [
                  j('span', { className: 'mt-contrib-cap-label', children: t('contrib.roles') }),
                  js('div', { className: 'mt-contrib-chips', children: roles.map((role) => {
                    const provider = displayNameOf(String(role.origin ?? '').replace(/^plugin:/, ''))
                    return j('span', {
                      key: role.id,
                      className: 'mt-contrib-chip',
                      title: `${role.id} · ${role.name} · ${t('contrib.providedBy').replace('{plugin}', provider)}`,
                      children: [
                        j('span', { className: 'mt-contrib-chip-icon', 'aria-hidden': true, children: '🛡' }),
                        j('span', { className: 'mt-contrib-chip-name', children: role.name }),
                        j('code', { className: 'mt-contrib-chip-id', children: role.id }),
                      ],
                    })
                  }) }),
                ] }) : null,
                teams.length > 0 ? js('div', { className: 'mt-contrib-cap-row', children: [
                  j('span', { className: 'mt-contrib-cap-label', children: t('contrib.teams') }),
                  js('div', { className: 'mt-contrib-chips', children: teams.map((team) => {
                    const roster = (team.members ?? []).map((member) => member.roleId).join(' · ')
                    return j('span', {
                      key: team.id,
                      className: 'mt-contrib-chip',
                      title: `${team.id} · ${team.name} · ${roster}`,
                      children: [
                        j('span', { className: 'mt-contrib-chip-icon', 'aria-hidden': true, children: '👥' }),
                        j('span', { className: 'mt-contrib-chip-name', children: team.name }),
                        j('span', { className: 'mt-contrib-chip-id', children: t('contrib.members').replace('{n}', String((team.members ?? []).length)) }),
                      ],
                    })
                  }) }),
                ] }) : null,
              ] }),
              /* 只读 + 目录：压到卡片脚注一行，不占正文高度 */
              js('div', { className: 'mt-contrib-foot', children: [
                j('span', { className: 'mt-chip mt-chip-origin mt-contrib-lock', title: t('contrib.readonlyHint'), children: `🔒 ${t('contrib.readonly')}` }),
                j('span', { className: 'mt-contrib-root', title: String(data?.root ?? ''), children: t('contrib.root').replace('{root}', String(data?.root ?? '')) }),
              ] }),
            ] })) }),
        j('div', { className: 'mt-hint', children: t('contrib.root').replace('{root}', String(data?.root ?? '')) }),
        err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
      ] })
    }

    function ContributionsSection({ t, api, workspaceRoot, onChanged, onNotice }) {
      const [data, setData] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const load = react.useCallback(async () => {
        if (!api) return
        try {
          setData((await api.getContributions({ workspaceRoot })) ?? { status: 'ok', plugins: [], roles: [], teams: [], warnings: [] })
        } catch (e) {
          setErr(String(e?.message ?? e))
          setData({ status: 'ok', plugins: [], roles: [], teams: [], warnings: [] })
        }
      }, [api, workspaceRoot])
      react.useEffect(() => { load() }, [load])
      const reload = async () => {
        if (busy || !api) return
        setBusy(true)
        setErr(null)
        try {
          const r = await api.reloadContributions({ workspaceRoot })
          setData(r ?? { status: 'ok', plugins: [], roles: [], teams: [], warnings: [] })
          onNotice?.(t('contrib.reloaded')
            .replace('{plugins}', String((r?.plugins ?? []).length))
            .replace('{roles}', String((r?.roles ?? []).length))
            .replace('{teams}', String((r?.teams ?? []).length)))
          onChanged?.()
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      /* CHG-93：渲染体抽成纯函数（`contributionsBody`）——面板只负责取数，
       * 纯函数可对「空态 / 有插件 / 有 error」三个分支直接断言（CDP 只能验一个真实状态）。 */
      return contributionsBody(t, data, { busy, onReload: reload, err })
    }

    function RoleDetailDrawer({ t, data, onClose, teamName, onEdit, onDelete, deleteHint, onCopyToProject, onGuest, skillTotal, onPublish }) {
      const [usage, setUsage] = react.useState(null)
      const [delBusy, setDelBusy] = react.useState(false)
      const [delErr, setDelErr] = react.useState(null)
      /* CHG-89（FR-13.1「发布到全局库」）：两段确认——全局库对该工作区所有项目可见，是显式动作 */
      const [pubBusy, setPubBusy] = react.useState(false)
      const [pubErr, setPubErr] = react.useState(null)
      const [pubImpact, setPubImpact] = react.useState(null)
      if (!data) return js('div', { className: 'mt-drawer', children: [j('div', { className: 'mt-drawer-head', children: j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }) }), j('div', { className: 'mt-empty', children: t('state.loading') })] })
      const def = data.definition ?? {}
      const readOnlyRole = data.origin !== 'project'
      const chips = (items, empty) => (items ?? []).length > 0
        ? js('div', { className: 'mt-rolechips', children: items.map((item) => j('span', { key: item, className: 'mt-rolechip', children: item })) })
        : j('div', { className: 'mt-hint', children: empty })
      const promptTokens = Math.max(1, Math.round(String(def.systemPrompt ?? '').length / 4))
      const promptTokenText = promptTokens >= 1000 ? `${(promptTokens / 1000).toFixed(1)}k` : String(promptTokens)
      const toolAllow = def.toolPolicy?.allow ?? []
      const toolDeny = def.toolPolicy?.deny ?? []
      const boundaryText = toolAllow.length === 0 && toolDeny.length === 0
        ? t('role.boundaryDefault')
        : [
          toolAllow.length > 0 ? t('role.boundaryAllow').replace('{tools}', toolAllow.join(' / ')) : null,
          toolDeny.length > 0 ? t('role.boundaryDeny').replace('{tools}', toolDeny.join(' / ')) : null,
        ].filter(Boolean).join('；')
      /** 第一段：不带 confirm 调用，拿 usage（在册团队/实例数/占用模板） */
      const askDelete = async () => {
        if (!onDelete || delBusy) return
        setDelErr(null)
        setDelBusy(true)
        try {
          const r = await onDelete(false)
          if (r?.status === 'confirm-required') { setUsage(r.usage ?? {}); return }
          if (r?.status === 'deleted') return
          setDelErr(t('role.deleteFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setDelErr(t('role.deleteFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setDelBusy(false)
        }
      }
      /** 第二段：带 confirm:true 提交 */
      const doDelete = async () => {
        if (!onDelete || delBusy) return
        setDelErr(null)
        setDelBusy(true)
        try {
          const r = await onDelete(true)
          if (r?.status === 'deleted') return
          setDelErr(t('role.deleteFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setDelErr(t('role.deleteFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setDelBusy(false)
        }
      }
      /** 第一段：不带 confirm 调用，拿发布影响面（目标全局库路径 + 可见范围） */
      const askPublish = async () => {
        if (!onPublish || pubBusy) return
        setPubErr(null)
        setPubBusy(true)
        try {
          const r = await onPublish(false)
          if (r?.status === 'confirm-required') { setPubImpact(r.impact ?? {}); return }
          if (r?.status === 'published') return
          setPubErr(t('role.publishFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setPubErr(t('role.publishFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setPubBusy(false)
        }
      }
      /** 第二段：带 confirm:true 落盘到全局库 */
      const doPublish = async () => {
        if (!onPublish || pubBusy) return
        setPubErr(null)
        setPubBusy(true)
        try {
          const r = await onPublish(true)
          if (r?.status === 'published') { setPubImpact(null); return }
          setPubErr(t('role.publishFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setPubErr(t('role.publishFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setPubBusy(false)
        }
      }
      const membershipRows = (data.memberships ?? []).length === 0
        ? j('div', { className: 'mt-hint', children: t('role.membershipsEmpty') })
        : js('div', { children: (data.memberships ?? []).map((membership, index) => js('div', { className: 'mt-membership', key: `${membership.teamId}-${membership.instanceName}-${index}`, children: [
          j('span', { className: 'mt-tchip ' + (membership.online ? 'mt-tchip-lead' : 'mt-tchip-coop'), children: teamName?.(membership.teamId) || membership.teamName || membership.teamId }),
          j('strong', { children: membership.instanceName }),
          j('span', { className: 'mt-hint', children: memberStateLabel(membership.status) }),
        ] })) })
      const spacedHead = (titleKey, note) => js('div', { className: 'mt-dsec-head', children: [
        j('h4', { children: t(titleKey) }),
        j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
        note ? j('span', { className: 'mt-dsec-n', children: note }) : null,
      ] })
      return js('div', { className: 'mt-drawer mt-drawer-wide mt-roledetail', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('span', { className: `mt-avatar ${avatarClassOf(def.id ?? data.roleId)}`, 'aria-hidden': true, children: avatarCharOf(def.name, def.id ?? data.roleId) }),
          j('strong', { children: def.name ?? data.roleId }),
          j('span', { className: 'mt-rolecard-id', children: def.id }),
          j('span', { className: 'mt-chip mt-chip-origin', children: data.origin === 'plugin' ? `🔒 ${t('role.origin.plugin')}` : t(`role.origin.${data.origin}`) }),
          readOnlyRole ? j('span', { className: 'mt-chip mt-chip-idle', children: t('role.readonlyBadge') }) : null,
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-roledetail-grid', children: [
          js('div', { className: 'mt-roledetail-main', children: [
            /* ① 定义与设定 */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.section.definition', t('role.section.definitionNote')),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.responsibility') }),
                j('span', { children: def.description ?? '—' }),
              ] }),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.boundary') }),
                j('span', { children: boundaryText }),
              ] }),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.interest') }),
                js('span', { className: 'mt-rolechips', children: [
                  ...((def.interestWords ?? []).length > 0
                    ? (def.interestWords ?? []).map((word) => j('span', { key: word, className: 'mt-rolechip', children: word }))
                    : [j('span', { className: 'mt-hint', children: t('roles.interestEmpty') })]),
                  j('span', { className: 'mt-hint', children: t('role.interestHint') }),
                ] }),
              ] }),
              js('div', { className: 'mt-prompt-head', children: [
                j('span', { children: t('role.prompt') }),
                j('span', { className: 'mt-rolechip mt-rolechip-mono', children: t('role.promptTokens').replace('{n}', promptTokenText) }),
                onEdit ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onEdit(data), children: t('role.expandEdit') }) : null,
              ] }),
              j('pre', { className: 'mt-prompt-block', children: def.systemPrompt ?? '' }),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.route') }),
                js('span', { className: 'mt-rolechips', children: def.model
                  ? [
                    j('span', { className: 'mt-rolechip mt-rolechip-mono', children: t('role.routePrimary').replace('{model}', `${def.model.provider}/${def.model.model}`) }),
                    j('span', { className: 'mt-rolechip', children: t('role.routeInherit') }),
                  ]
                  : [j('span', { className: 'mt-rolechip', children: t('role.routeInherit') })] }),
              ] }),
            ] }),
            /* ② 技能（引用而非内联；启用开关是展示态——改技能走角色编辑器） */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.skills', t('role.skillsNote').replace('{n}', String((def.skills ?? []).length)).replace('{total}', String(skillTotal ?? (def.skills ?? []).length))),
              js('div', { className: 'mt-abl-list', children: [
                ...(def.skills ?? []).map((skill) => js('div', { className: 'mt-abl-row', key: skill, children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '❖' }),
                  js('div', { className: 'mt-abl-main', children: [
                    js('div', { className: 'mt-abl-name', children: [skill, j('span', { className: 'mt-rolecard-id', children: skill })] }),
                    j('div', { className: 'mt-abl-sub', children: t('role.mcpRef') }),
                  ] }),
                  j('span', { className: 'mt-tgl', role: 'switch', 'aria-checked': true, 'aria-label': skill, title: t('role.skillEnabled') }),
                ] })),
                js('div', { className: 'mt-abl-row', children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '＋' }),
                  js('div', { className: 'mt-abl-main', children: [
                    j('div', { className: 'mt-abl-name', children: t('role.skillAdd') }),
                    j('div', { className: 'mt-abl-sub', children: t('role.skillAddHint').replace('{n}', String((def.skills ?? []).length)) }),
                  ] }),
                  j('button', { className: 'mt-btn mt-btn-sm', title: t('role.browseSkills'), onClick: () => onEdit?.(data), children: t('role.browse') }),
                ] }),
              ] }),
            ] }),
            /* ③ MCP 与工具（连接层插件只读：这里只标「已引用」） */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.mcp', t('role.mcpNote')),
              js('div', { className: 'mt-abl-list', children: [
                ...(def.mcpAllowlist ?? []).map((name) => js('div', { className: 'mt-abl-row', key: name, children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '⌘' }),
                  js('div', { className: 'mt-abl-main', children: [
                    js('div', { className: 'mt-abl-name', children: [name, j('span', { className: 'mt-rolecard-id', children: t('role.mcp') })] }),
                    j('div', { className: 'mt-abl-sub', children: t('role.mcpRef') }),
                  ] }),
                  j('span', { className: 'mt-chip mt-chip-run', children: [j('span', { className: 'mt-shape mt-shape-run', 'aria-hidden': true }), t('role.mcpRef')] }),
                ] })),
                js('div', { className: 'mt-abl-row', children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '⌗' }),
                  js('div', { className: 'mt-abl-main', children: [
                    j('div', { className: 'mt-abl-name', children: t('role.builtinTools') }),
                    js('div', { className: 'mt-abl-sub', children: [
                      ...(toolAllow.length > 0
                        ? toolAllow.map((tool) => j('span', { key: tool, className: 'mt-rolechip', children: tool }))
                        : [j('span', { className: 'mt-hint', children: '—' })]),
                      toolDeny.length > 0 ? j('span', { className: 'mt-rolechip', children: t('role.toolDeny').replace('{tools}', toolDeny.join(' / ')) }) : null,
                    ] }),
                  ] }),
                ] }),
              ] }),
            ] }),
          ] }),
          js('aside', { className: 'mt-roledetail-side', children: [
            /* 在册情况（跨团队聘任与实例） */
            js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('role.memberships') }),
                j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
              ] }),
              j('div', { className: 'mt-kvline', children: j('strong', { children: t('role.membershipCount').replace('{teams}', String(data.usage?.teams ?? 0)).replace('{instances}', String(data.usage?.instances ?? 0)) }) }),
              membershipRows,
            ] }),
            /* 快照规则 */
            js('section', { className: 'mt-sec mt-sec-info', children: [
              spacedHead('role.snapshotTitle', null),
              j('div', { className: 'mt-kvline', children: j('span', { children: t('role.snapshotBody') }) }),
            ] }),
            /* 操作 */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.actions', null),
              js('div', { className: 'mt-side-actions', children: [
                readOnlyRole
                  ? j('button', { className: 'mt-btn mt-btn-primary', onClick: () => (onCopyToProject ? onCopyToProject(def) : onEdit?.(data)), children: t('roles.copyToProjectFresh') })
                  : (onEdit ? j('button', { className: 'mt-btn mt-btn-primary', onClick: () => onEdit(data), children: t('role.edit') }) : null),
                /* CHG-89（FR-13.1）：项目库角色可「发布到全局库」——内置/全局来源没有发布意义，故不渲染 */
                onPublish ? j('button', { className: 'mt-btn', disabled: pubBusy, title: t('role.publishHint'), onClick: askPublish, children: pubBusy ? t('state.loading') : t('role.publishBtn') }) : null,
                onGuest ? j('button', { className: 'mt-btn', onClick: () => onGuest(def), children: t('role.tryInCaptain') }) : null,
                onDelete
                  ? j('button', { className: 'mt-btn mt-btn-danger', disabled: delBusy, title: t('role.delete'), onClick: askDelete, children: delBusy ? t('state.loading') : t('role.delete') })
                  : j('button', { className: 'mt-btn', disabled: true, title: deleteHint ?? t('role.deleteReadonly'), children: t('role.deleteReadonly') }),
              ] }),
              usage ? js('div', { className: 'mt-usagebox', role: 'alert', children: [
                j('strong', { children: t('role.deleteConfirm') }),
                j('span', { children: t('role.deleteUsage').replace('{teams}', String(usage.teams ?? 0)).replace('{instances}', String(usage.instances ?? 0)).replace('{presets}', String((usage.presets ?? []).length)) }),
                (usage.presets ?? []).length > 0 ? j('span', { children: t('role.deletePresets').replace('{presets}', (usage.presets ?? []).join('、')) }) : null,
                js('div', { className: 'mt-form-actions', children: [
                  j('button', { className: 'mt-btn', onClick: () => setUsage(null), children: t('action.cancel') }),
                  j('button', { className: 'mt-btn mt-btn-danger', disabled: delBusy, onClick: doDelete, children: delBusy ? t('state.loading') : t('role.deleteConfirmBtn') }),
                ] }),
              ] }) : null,
              /* CHG-89：发布影响面确认框（全局库对所有项目可见 → 必须显式确认） */
              pubImpact ? js('div', { className: 'mt-usagebox', role: 'alert', children: [
                j('strong', { children: t('role.publishConfirm') }),
                j('span', { children: t('role.publishImpact').replace('{path}', String(pubImpact.filePath ?? '—')) }),
                t('role.publishImpactNote') ? j('span', { children: t('role.publishImpactNote') }) : null,
                js('div', { className: 'mt-form-actions', children: [
                  j('button', { className: 'mt-btn', onClick: () => setPubImpact(null), children: t('action.cancel') }),
                  j('button', { className: 'mt-btn mt-btn-primary', disabled: pubBusy, onClick: doPublish, children: pubBusy ? t('state.loading') : t('role.publishConfirmBtn') }),
                ] }),
              ] }) : null,
              delErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: delErr }) : null,
              pubErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: pubErr }) : null,
            ] }),
            /* CHG-74：同名副本说明——让用户知道「为什么详情是这份」而不是另一份 */
            (data.shadowed ?? []).length > 0
              ? js('div', { className: 'mt-hint', children: t('role.detailShadowed')
                .replace('{list}', (data.shadowed ?? []).map((origin) => t(`role.origin.${origin}`)).join('、'))
                .replace('{origin}', t(`role.origin.${data.origin}`)) })
              : null,
          ] }),
        ] }),
      ] })
    }

    /** 团队卡（design/shell.html 的 .team-card：名称 + 状态 chip + 在线/离线 + 描述 + 完成度行） */
    function TeamCard({ t, team, taskCount, gateCount, onOpen }) {
      const counts = team.counts ?? {}
      const tone = team.state === 'archived' ? 'idle' : team.state === 'draft' ? 'gate' : team.online ? 'run' : 'idle'
      return js('button', {
        className: 'mt-team-card' + (team.online ? '' : ' mt-team-offline'),
        onClick: () => onOpen(team.teamId),
        children: [
          js('div', { className: 'mt-team-head mt-tc-head', children: [
            js('span', { className: 'mt-tc-name', children: team.name || team.teamId }),
            js('span', { className: `mt-mini-chip mt-tone-${tone}`, children: [j('span', { className: 'mt-tc-dot', 'aria-hidden': true }), stateLabel(team.state)] }),
            js('span', { className: 'mt-tc-zone', children: [team.online ? j('span', { className: 'mt-tc-dot', 'aria-hidden': true }) : null, team.online ? t('shell.online') : t('shell.offline')] }),
          ] }),
          team.goal ? j('p', { className: 'mt-tc-desc', children: team.goal }) : null,
          js('p', { className: 'mt-tc-meta', children: [
            j('span', { children: t('shell.done').replace('{done}', String(counts.done ?? 0)).replace('{total}', String(counts.tasks ?? 0)) }),
            j('span', { children: t('shell.running').replace('{n}', String(counts.running ?? 0)) }),
            gateCount > 0 ? j('span', { children: t('shell.gatePending').replace('{n}', String(gateCount)) }) : null,
            j('span', { children: t('shell.members').replace('{n}', String((team.members ?? []).length)) }),
          ] }),
        ],
      })
    }

    /* CHG-83：design/overview.html 的「全部团队」不再内联在全局页 —— 它把「角色库三层」与
     * 「团队 tab」两处内容又摆了一遍（用户："怎么还有一个这个区域"）。归档团队仍从
     * 「团队」tab 进来（TeamCard 带「已归档」状态 chip，点开就是归档回放）。 */
    /** 项目 · 团队列表（design/shell.html：筛选行 + 按工作区分组的团队卡） */
    function TeamsHome({ t, teams, tasks, gateOf, onOpen, workspaceRoot, onCreateTeam }) {
      const [query, setQuery] = react.useState('')
      const needle = String(query ?? '').trim().toLowerCase()
      const list = (teams ?? []).filter((team) => !needle
        || [team.name, team.teamId, team.goal, team.workspaceRoot, workspaceRoot].some((field) => String(field ?? '').toLowerCase().includes(needle)))
      /* 项目聚合按单个 workspaceRoot 查询，团队摘要本身不带 workspaceRoot —— 组头的
       * 工作区名/路径回落当前项目根（跨工作区多组时才会用到 team 上的字段）。 */
      const groups = new Map()
      for (const team of list) {
        const key = team.workspaceRoot || workspaceRoot || '—'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(team)
      }
      const groupList = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      return js('div', { className: 'mt-home', children: [
        js('div', { className: 'mt-home-filter', children: [
          js('label', { className: 'mt-search-field', children: [
            j('span', { className: 'mt-search-ico', 'aria-hidden': true, children: j('svg', {
              width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
              children: j('path', { d: 'M10.6 10.6 14 14M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
            }) }),
            j('input', {
              type: 'search',
              value: query,
              placeholder: t('shell.filter'),
              'aria-label': t('shell.filter'),
              onChange: (event) => setQuery(event?.target?.value ?? ''),
            }),
          ] }),
          j('p', { className: 'mt-home-hint', children: t('shell.hint') }),
          /* CHG-84 收口：CHG-83 撤掉全局页的「全部团队」后，面板里就没有建团入口了
           * （预设卡上的「用这个建团队」只在项目层有预设时出现）。按 design/shell.html
           * 工作区头的「新建」补回一颗，落在「项目 → 团队」tab。 */
          onCreateTeam ? j('button', { className: 'mt-btn mt-btn-primary', onClick: onCreateTeam, children: t('shell.newTeam') }) : null,
        ] }),
        list.length === 0
          ? j('div', { className: 'mt-empty-inline mt-hint', children: (teams ?? []).length === 0 ? t('shell.empty') : t('shell.noMatch') })
          : groupList.map(([root, group]) => js('section', { className: 'mt-home-group', key: root, children: [
            js('div', { className: 'mt-home-group-head', children: [
              j('b', { children: projectLabel(root) }),
              j('span', { className: 'mt-group-n', children: t('shell.groupCount').replace('{n}', String(group.length)) }),
              j('span', { className: 'mt-group-path', title: root, children: root }),
            ] }),
            ...group.map((team) => j(TeamCard, {
              key: team.teamId,
              t,
              team,
              taskCount: (tasks ?? []).filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId)).length,
              gateCount: gateOf ? gateOf(team.teamId) : 0,
              onOpen,
            })),
          ] })),
      ] })
    }


    /** 归档回放（design/archive.html：归档条 + 结局卡 + 进度分段 + 名册 + 五项分解 + 任务历史 + 账本） */
    /**
     * 归档回放（design/archive.html）。
     *
     * CHG-86 / P0-2：**优先用 `getArchive` 返回的真实快照**（`archive/<teamId>/team.json`、
     * `tokens.json`、`members/*.json`、`artifacts/` 的落盘内容），拿不到时（离线团队 /
     * 端点缺失 / 团队未归档）降级到 board + tokens + audit 派生——两条路径都走同一套渲染，
     * 但路径文案必须是真的：`archive.endPath` 显示 `archiveRoot/teamId`，不显示拼出来的假路径。
     */
    function ArchiveReplay({ t, team: teamProp, tasks: tasksProp, tokens: tokensProp, audit: auditProp, memberName, onBack, onMoreAudit, onOpenAll, onOpenTask, archive, archiveRoot }) {
      const snap = archive && typeof archive === 'object' ? archive : null
      /* 快照优先：字段名与 host 侧 ArchiveTeamSnapshot 一一对应（不重命名、不猜） */
      const team = snap
        ? {
          ...(teamProp ?? {}),
          teamId: snap.teamId ?? teamProp?.teamId,
          name: snap.name || teamProp?.name,
          goal: snap.goal || teamProp?.goal,
          state: snap.state ?? teamProp?.state,
          archivedAt: snap.archivedAt ?? teamProp?.archivedAt,
          updatedAt: snap.archivedAt ?? teamProp?.updatedAt,
          members: snap.members ?? [],
        }
        : teamProp
      const tasks = snap
        ? (snap.tasks ?? []).map((task) => ({
          ...task,
          assignees: task.assignee ? [task.assignee] : [],
          evidenceCount: Number(task.evidenceCount ?? 0),
          gates: task.gates ?? [],
          gateVerdicts: task.gateVerdicts ?? {},
        }))
        : tasksProp
      const tokens = snap ? (snap.tokens ?? tokensProp) : tokensProp
      const audit = snap ? { ...(auditProp ?? {}), total: snap.eventCount ?? auditProp?.total } : auditProp
      /* 真实归档目录：优先 panel.getArchive 的 root，其次快照里的 dir，最后才回落相对路径 */
      const archiveDir = snap
        ? (snap.dir || (archiveRoot ? `${archiveRoot}/${snap.teamId ?? team?.teamId ?? ''}` : `archive/${snap.teamId ?? team?.teamId ?? '—'}/`))
        : `archive/${team?.teamId ?? '—'}/`
      const artifacts = snap?.artifacts ?? []
      const [showAudit, setShowAudit] = react.useState(false)
      if (showAudit) {
        return js('div', { className: 'mt-panel', children: [
          js('div', { className: 'mt-archbar', children: [
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setShowAudit(false), children: t('team.backList') }),
            j('span', { className: 'mt-team-mark', 'aria-hidden': true, children: layerIcon('builtin') }),
            js('span', { className: 'mt-team-id', children: [j('b', { children: team?.name || team?.teamId }), j('span', { children: team?.teamId })] }),
            j('span', { className: 'mt-arch-date', children: t('archive.readonly') }),
            js('div', { className: 'mt-archbar-actions', children: [
              j('button', { className: 'mt-btn mt-btn-sm', onClick: onOpenAll, children: t('archive.allTeams') }),
            ] }),
          ] }),
          j(AuditTab, { t, audit, tasks, memberName, filter: 'task', setFilter: () => {}, onMore: onMoreAudit, onOpen: (taskId) => onOpenTask?.({ id: taskId, ownerTeamId: team?.teamId, online: team?.online, ownerOnline: team?.online, sessionId: team?.sessionId }) }),
          j(CostBar, { t, tokens, readOnly: true }),
        ] })
      }
      const members = team?.members ?? []
      const list = tasks ?? []
      const done = list.filter((task) => task.state === 'done')
      const blocked = list.filter((task) => task.state === 'blocked')
      const pending = list.filter((task) => !['done', 'cancelled', 'failed', 'blocked'].includes(task.state))
      const sum = sumBuckets(Object.values(tokens?.totals ?? {}))
      const hit = hitRateOf(sum)
      const memberNameOf = (id) => members.find((member) => member.id === id)?.instanceName ?? id
      const totalTokens = sum.uncachedInput + sum.cacheRead + sum.cacheWrite + sum.output
      const tasksOfMember = (memberId) => list.filter((task) => (task.assignees ?? (task.assignee ? [task.assignee] : [])).includes(memberId))
      const dayRows = Object.entries(tokens?.days ?? {}).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([day, dayMembers]) => {
        const bucket = sumBuckets(Object.values(dayMembers ?? {}))
        const rate = hitRateOf(bucket)
        return { day, bucket, rate }
      })
      const cell = (value, key) => j('td', { className: 'mt-n', key, children: value })
      const stateChip = (state) => {
        const tone = state === 'done' ? 'done' : state === 'blocked' || state === 'failed' ? 'fail' : String(state).startsWith('gate:') ? 'gate' : 'idle'
        return js('span', { className: `mt-mini-chip mt-tone-${tone}`, children: [j('span', { className: 'mt-tc-dot', 'aria-hidden': true }), stateLabel(state)] })
      }
      const ledgerRow = (icon, title, sub, act, key) => js('article', { className: 'mt-listrow', key, children: [
        j('span', { className: 'mt-mavatar mt-mavatar-muted', 'aria-hidden': true, children: layerIcon(icon) }),
        js('div', { className: 'mt-listrow-main', children: [
          j('div', { className: 'mt-listrow-title', children: title }),
          j('div', { className: 'mt-listrow-sub', children: sub }),
        ] }),
        js('div', { className: 'mt-listrow-act', children: act ?? null }),
      ] })
      /* 视图条 = 回放分区锚点（design/archive.html 的 nav.seg：结局 / 名册 · N / 任务历史 · N / 账本与产物） */
      const archiveNav = (label, id) => j('button', {
        key: id,
        className: 'mt-audit-segbtn',
        onClick: () => { if (typeof document !== 'undefined') document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        children: label,
      })
      const archDate = team?.updatedAt ? t('archive.archivedAt').replace('{time}', fmtClock(team.updatedAt)) : t('archive.readonly')
      return js('div', { className: 'mt-panel', children: [
        js('div', { className: 'mt-archbar', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onBack, children: t('team.backList') }),
          j('span', { className: 'mt-team-mark', 'aria-hidden': true, children: layerIcon('builtin') }),
          js('span', { className: 'mt-team-id', children: [j('b', { children: team?.name || team?.teamId }), j('span', { children: team?.teamId })] }),
          js('span', { className: 'mt-mini-chip mt-tone-idle', children: [j('span', { className: 'mt-tc-dot', 'aria-hidden': true }), t('archive.status')] }),
          j('span', { className: 'mt-arch-date', children: archDate }),
          js('div', { className: 'mt-archbar-actions', children: [
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setShowAudit(true), children: t('archive.openAudit') }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: onOpenAll, children: t('archive.allTeams') }),
          ] }),
        ] }),
        js('div', { className: 'mt-audit-segbar', children: [
          js('nav', { className: 'mt-audit-seg', 'aria-label': t('archive.section.progress'), children: [
            archiveNav(t('archive.section.end'), 'mt-arch-end'),
            archiveNav(t('archive.section.roster').replace('{n}', String(members.length)), 'mt-arch-roster'),
            archiveNav(t('archive.section.tasks').replace('{n}', String(list.length)), 'mt-arch-tasks'),
            archiveNav(t('archive.section.ledger'), 'mt-arch-ledger'),
          ] }),
          js('div', { className: 'mt-audit-segright', children: [
            j('span', { className: 'mt-mini-chip', children: t('archive.eventCount').replace('{n}', String(audit?.total ?? '—')) }),
            j('span', { className: 'mt-mini-chip', children: t('archive.snapshot') }),
          ] }),
        ] }),
        js('div', { className: 'mt-page mt-archive-page', children: [
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-end', children: [
            j('h4', { children: t('archive.section.end') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: 'team.disbanded' }),
          ] }),
          js('div', { className: 'mt-endcard', children: [
            j('h5', { children: t('archive.endTitle') }),
            j('p', { children: team?.goal || t('archive.endFallback') }),
            js('div', { className: 'mt-endmeta', children: [
              j('span', { children: t('archive.endDisbander') }),
              j('span', { children: t('archive.endDrained').replace('{n}', String(members.length)) }),
              j('span', { children: t('archive.endBlocked').replace('{n}', String(pending.length + blocked.length)) }),
              /* CHG-86 / P0-2：真实归档目录（有快照时是 archiveRoot/teamId 的绝对路径） */
              js('span', { children: [t('archive.endPath').replace('{path}', ''), j('code', { children: archiveDir })] }),
            ] }),
          ] }),
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('archive.section.progress') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.taskDone').replace('{n}', `${done.length}/${list.length}`) }),
          ] }),
          js('div', { className: 'mt-secbox', children: [
            js('div', { className: 'mt-teambar-stats', children: [
              js('div', { className: 'mt-tstat', children: [j('b', { children: `${done.length}/${list.length}` }), j('span', { children: t('archive.done') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: String(blocked.length) }), j('span', { children: t('archive.blocked') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: String(pending.length) }), j('span', { children: t('archive.notStarted') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: fmtTokens(totalTokens) }), j('span', { children: t('archive.tokensTotal') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: String(sum.calls) }), j('span', { children: t('archive.calls') })] }),
            ] }),
            js('div', { className: 'mt-segbar', children: list.length === 0
              ? [j('i', { key: 'empty', className: 'mt-seg-done' })]
              : list.map((task) => j('i', {
                key: task.key ?? task.id,
                className: task.state === 'done' ? 'mt-seg-done' : task.state === 'blocked' || task.state === 'failed' ? 'mt-seg-blocked' : 'mt-seg-run',
                title: `${task.id} · ${stateLabel(task.state)}`,
              })) }),
          ] }),
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-roster', children: [
            j('h4', { children: t('archive.section.roster').replace('{n}', String(members.length)) }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.drained') }),
          ] }),
          members.length === 0
            ? j('div', { className: 'mt-empty-inline mt-hint', children: t('archive.rosterEmpty') })
            : js('div', { className: 'mt-grid2', children: members.map((member) => {
              const mine = tasksOfMember(member.id)
              return js('article', { className: 'mt-card2', key: member.id, children: [
                js('div', { className: 'mt-card2-top', children: [
                  j('span', { className: 'mt-mavatar', 'aria-hidden': true, children: String(member.instanceName ?? '?').slice(0, 1) }),
                  js('div', { children: [
                    js('div', { className: 'mt-card2-title', children: [j('span', { className: 'mt-iname', children: member.instanceName }), j('span', { className: 'mt-src mt-src-project', children: roleLabel(member.roleId) })] }),
                    j('div', { className: 'mt-card2-sub', children: memberStateLabel(member.status) }),
                  ] }),
                ] }),
                js('div', { className: 'mt-card2-row', children: [
                  j('span', { className: 'mt-mini-chip', children: t('archive.taskDone').replace('{n}', String(mine.filter((task) => task.state === 'done').length)) }),
                  j('span', { className: 'mt-mini-chip', children: t('archive.deliverables').replace('{n}', String(mine.reduce((total, task) => total + Number(task.evidenceCount ?? 0), 0))) }),
                  j('span', { className: 'mt-mini-chip', children: t('archive.tokenOf').replace('{v}', fmtTokens(sumBuckets([(tokens?.totals ?? {})[member.id]]).uncachedInput + sumBuckets([(tokens?.totals ?? {})[member.id]]).output)) }),
                ] }),
                j('div', { className: 'mt-card2-foot', children: j('span', { className: 'mt-role-name', children: t('archive.drained') }) }),
              ] })
            }) }),
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('archive.section.cost') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.costNote') }),
          ] }),
          js('div', { className: 'mt-secbox mt-secbox-tight', children: [
            js('table', { className: 'mt-toktable', children: [
              j('thead', { children: j('tr', { children: [
                j('th', { children: t('archive.costDay') }),
                j('th', { className: 'mt-n', children: t('archive.cost.uncached') }),
                j('th', { className: 'mt-n', children: t('archive.cost.hit') }),
                j('th', { className: 'mt-n', children: t('archive.cost.write') }),
                j('th', { className: 'mt-n', children: t('archive.cost.output') }),
                j('th', { className: 'mt-n', children: t('archive.cost.calls') }),
                j('th', { className: 'mt-n', children: t('archive.cost.rate') }),
              ] }) }),
              j('tbody', { children: dayRows.length === 0
                ? j('tr', { children: j('td', { colSpan: 7, children: t('cost.empty') }) })
                : dayRows.map((row) => j('tr', { key: row.day, children: [
                  j('td', { children: row.day }),
                  cell(fmtTokens(row.bucket.uncachedInput), 'u'),
                  cell(fmtTokens(row.bucket.cacheRead), 'r'),
                  cell(fmtTokens(row.bucket.cacheWrite), 'w'),
                  cell(fmtTokens(row.bucket.output), 'o'),
                  cell(String(row.bucket.calls), 'c'),
                  cell(row.rate === null ? '—' : `${(row.rate * 100).toFixed(1)}%`, 'h'),
                ] })) }),
              j('tfoot', { children: j('tr', { children: [
                j('td', { children: t('archive.cost.total') }),
                cell(fmtTokens(sum.uncachedInput), 'u'),
                cell(fmtTokens(sum.cacheRead), 'r'),
                cell(fmtTokens(sum.cacheWrite), 'w'),
                cell(fmtTokens(sum.output), 'o'),
                cell(String(sum.calls), 'c'),
                cell(hit === null ? '—' : `${(hit * 100).toFixed(1)}%`, 'h'),
              ] }) }),
            ] }),
          ] }),
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-tasks', children: [
            j('h4', { children: t('archive.section.tasks').replace('{n}', String(list.length)) }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.tasksNote') }),
          ] }),
          list.length === 0
            ? j('div', { className: 'mt-empty-inline mt-hint', children: t('tasks.empty') })
            : js('div', { className: 'mt-list', children: list.map((task) => js('article', { className: 'mt-listrow', key: task.key ?? task.id, children: [
              j('span', { className: 'mt-mavatar mt-mavatar-muted', 'aria-hidden': true, children: String(task.id ?? '?').slice(0, 2) }),
              js('div', { className: 'mt-listrow-main', children: [
                js('div', { className: 'mt-listrow-title', children: [
                  j('span', { children: task.title }),
                  j('span', { className: 'mt-mini-chip', children: task.id }),
                  stateChip(task.state),
                ] }),
                j('div', { className: 'mt-listrow-sub', children: [
                  (task.assignees ?? []).length > 0 ? `${(task.assignees ?? []).map(memberNameOf).join('、')} · ` : '',
                  t('archive.evidence').replace('{n}', String(task.evidenceCount ?? 0)),
                  (task.assignees ?? []).length === 0 ? ` · ${t('archive.neverClaimed')}` : '',
                ] }),
              ] }),
              js('div', { className: 'mt-listrow-act', children: [
                j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onOpenTask?.(task), children: task.state === 'blocked' ? t('archive.seeGate') : t('archive.seeEvidence') }),
              ] }),
            ] })) }),
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-ledger', children: [
            j('h4', { children: t('archive.section.ledger') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.ledgerPath').replace('{id}', team?.teamId ?? '—') }),
          ] }),
          js('div', { className: 'mt-list', children: [
            ledgerRow('builtin', [j('span', { className: 'mt-iname', children: 'ledger.jsonl' }), j('span', { className: 'mt-mini-chip', children: t('archive.ledgerJsonlEvents').replace('{n}', String(audit?.total ?? '—')) })], t('archive.ledgerJsonl'), [j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setShowAudit(true), children: t('archive.seeAll') })], 'ledger'),
            ledgerRow('project', [j('span', { className: 'mt-iname', children: 'team.json' }), j('span', { className: 'mt-iname', children: 'tokens.json' })], t('archive.teamJson'), null, 'team'),
            ledgerRow('global', j('span', { className: 'mt-iname', children: 'members/' }), t('archive.membersDir'), null, 'members'),
            /* 交付物清单：有真实快照时用 artifacts 条数（archive/artifacts/artifacts.json），否则按证据数派生 */
            ledgerRow('builtin', [j('span', { className: 'mt-iname', children: 'artifacts/' }), j('span', { className: 'mt-mini-chip', children: t('archive.artifactsCount').replace('{n}', String(snap ? artifacts.length : done.reduce((total, task) => total + Number(task.evidenceCount ?? 0), 0))) })], t('archive.artifactsDir'), [j('button', { className: 'mt-btn mt-btn-sm', disabled: true, title: t('settings.readonlyTip'), children: t('archive.openDir') })], 'artifacts'),
          ] }),
          js('p', { className: 'mt-note-box', children: [j('b', { children: t('archive.note') }), j('span', { children: t('archive.noteSub') })] }),
        ] }),
        j(CostBar, { t, tokens, readOnly: true }),
      ] })
    }

    /** 诊断 chip（CHG-72，FR-30）：把「为什么没人领」直接放在任务卡/详情上 */
    function DiagChips({ t, diagnosis }) {
      if (!diagnosis?.codes?.length) return null
      const textOf = (code) => {
        if (code === 'deps-pending') return t('diag.deps-pending').replace('{deps}', (diagnosis.depsPending ?? []).join('、') || '—')
        if (code === 'dep-cancelled') return t('diag.dep-cancelled').replace('{deps}', (diagnosis.depsCancelled ?? []).join('、') || '—')
        if (code === 'no-role') return t('diag.no-role').replace('{role}', roleLabel(diagnosis.roleId))
        if (code === 'role-busy') return t('diag.role-busy').replace('{members}', (diagnosis.busyMembers ?? []).join('、') || '—')
        return t('diag.team-inactive')
      }
      return js('span', { className: 'mt-diag', children: diagnosis.codes.map((code) => j('span', {
        key: code,
        className: code === 'dep-cancelled' ? 'mt-diag-chip mt-chip-cancelled' : 'mt-diag-chip',
        title: `${t('diag.title')} · ${textOf(code)}`,
        children: textOf(code),
      })) })
    }

    /** CHG-76 C：无人可领的一键修复（诊断 fix: assignable / roleSwap / spawnRole）
     *  - assignable 非空 → 每个空闲队员一个「一键指派 <队员>」（assignTask）
     *  - roleSwap 非空 → 「改用已有人角色」下拉（选中即 updateTask patch.requiredRole）
     *  - 都没有但有 spawnRole → 纯提示「去召唤 <角色> 成员」（不自动执行）
     *  离线/只读：按钮 disabled + title 用既有只读文案。 */
    function DiagFix({ t, api, teamId, taskId, diagnosis, readOnly, onFixed, expectedRevision }) {
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const [chosenRole, setChosenRole] = react.useState('')
      const fix = diagnosis?.fix
      if (!fix) return null
      const assignable = fix.assignable ?? []
      const roleSwap = fix.roleSwap ?? []
      const spawnRole = fix.spawnRole
      if (assignable.length === 0 && roleSwap.length === 0 && !spawnRole) return null
      const run = async (fn, message) => {
        if (readOnly || busy) return
        setErr(null)
        setBusy(true)
        try {
          await fn()
          onFixed?.(message)
        } catch (e) {
          setErr(t('diag.fixFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const assign = (option) => run(async () => {
        const r = await api.assignTask({
          teamId,
          taskId,
          memberIds: [option.memberId],
          /* CHG-89（QA-4 乐观锁）：诊断修复也是写路径——详情页打开时的版本快照必须回传，
           * 否则「表单那条路有锁、诊断这条路没有」就是同一个洞开了两个口。 */
          ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
        })
        if (r?.code === 'MT_REVISION_CONFLICT') throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
        if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'assign failed')
      }, t('diag.fixAssignDone').replace('{member}', option.instanceName ?? option.memberId))
      const swapRole = (roleId) => {
        setChosenRole(roleId)
        if (!roleId) return
        run(async () => {
          const r = await api.updateTask({
            teamId,
            taskId,
            patch: { requiredRole: roleId },
            ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
          })
          if (r?.code === 'MT_REVISION_CONFLICT') throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
          if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'update failed')
        }, t('diag.fixRoleSwapDone').replace('{role}', roleLabel(roleId)))
      }
      const tip = readOnly ? t('task.readonlyTitle') : undefined
      return js('div', { className: 'mt-diag-fix', children: [
        j('span', { className: 'mt-diag-fix-label', children: t('diag.fix') }),
        ...assignable.map((option) => j('button', {
          key: `assign-${option.memberId}`,
          className: 'mt-btn mt-btn-sm mt-btn-primary',
          disabled: readOnly || busy,
          title: tip ?? t('diag.fixAssign').replace('{member}', option.instanceName ?? option.memberId),
          onClick: () => assign(option),
          children: t('diag.fixAssign').replace('{member}', option.instanceName ?? option.memberId),
        })),
        roleSwap.length > 0 ? j('select', {
          className: 'mt-select',
          value: chosenRole,
          'aria-label': t('diag.fixRoleSwap'),
          title: tip ?? t('diag.fixRoleSwap'),
          disabled: readOnly || busy,
          onChange: (e) => swapRole(e.target.value),
          children: [
            j('option', { value: '', children: t('diag.fixRoleSwap') }),
            ...roleSwap.map((option) => j('option', {
              key: option.roleId,
              value: option.roleId,
              children: t('diag.fixRoleSwapOption')
                .replace('{role}', roleLabel(option.roleId))
                .replace('{n}', String((option.idleMembers ?? []).length)),
            })),
          ],
        }) : null,
        /* CHG-76 C：三者可同时存在（deps-pending 时 assignable 也可能非空）——能做的都列出来，不互相排斥。
         * 召唤措辞按诊断码分开：no-role（名册没这个人）vs role-busy（人都在忙，是增援不是补漏）。 */
        spawnRole
          ? (() => {
            const roleBusy = (diagnosis?.codes ?? []).includes('role-busy')
            const canSwap = assignable.length > 0 || roleSwap.length > 0
            const label = roleBusy
              ? t('diag.fixReinforce').replace('{role}', roleLabel(spawnRole))
              : t('diag.fixSpawn').replace('{role}', roleLabel(spawnRole))
            const hint = roleBusy
              ? (canSwap ? t('diag.fixReinforceHintCanSwap') : t('diag.fixReinforceHint'))
              : (canSwap ? t('diag.fixSpawnHintCanSwap') : t('diag.fixSpawnHint'))
            return js('span', { className: 'mt-hint', title: hint, children: `${label} · ${hint}` })
          })()
          : null,
        err ? j('span', { className: 'mt-error-banner', role: 'alert', children: err }) : null,
      ] })
    }

    /** 剪贴板（建队指令复制；不可用时降级 execCommand） */
    const copyText = async (text) => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* 降级 */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /** 建队指令（P1 引导：不新增写路径，把结构交给团队模式会话里的队长） */
    const buildTeamPrompt = ({ name, goal, presetId, presetName }) => {
      const lines = ['请帮我创建一个团队：', `- 团队名：${name || '（待定）'}`, `- 目标：${goal || '（待补充）'}`]
      if (presetId) lines.push(`- 模板：${presetId}${presetName ? `（${presetName}）` : ''}`)
      lines.push('', '要求：')
      lines.push('1. 先澄清必要信息（taste 类必须问，fact 类给默认值并标注假设），追问不超过 3 轮；')
      lines.push('2. 用 myteam_submit_plan 提交草稿（roster 必含且仅含一个 captain），不要直接开跑；')
      lines.push('3. 等我批准后再召唤队员、开始执行。')
      return lines.join('\n')
    }

    /** 建队引导抽屉（CHG-72，FR-26 P1）：填名称/目标/模板 → 打开团队模式会话并预填首条消息 */
    /** 建团向导（CHG-82 / G6）：design/new-team-1.html 第 1 步「选预设」→ design/new-team.html 第 2 步「组建名册」→ 第 3 步「写目标」。
     *  名册里存角色引用（实例名决定将创建的实例，同名自动加 -2）；队长 = 会话本身，不占名册；成员会话在点「创建团队」后才创建。 */
    function TeamCreateDrawer({ t, ctx, projectRoot, presets, roles, onClose, onManagePresets, onRetryPresets }) {
      const [step, setStep] = react.useState(1)
      const [name, setName] = react.useState('')
      const [goal, setGoal] = react.useState('')
      /** null = 还没动过（默认套第一个预设，与设计稿「不知道选哪个就选第一个」一致） */
      const [picked, setPicked] = react.useState(null)
      /** null = 名册跟着预设走；一旦手动增删就切到显式列表 */
      const [rosterOverride, setRosterOverride] = react.useState(null)
      const [err, setErr] = react.useState(null)
      const [copied, setCopied] = react.useState(false)
      const entries = presets?.entries ?? []
      const MAX_ROSTER = 6
      /** design/new-team-1.html 的加载态：预设目录是异步拉的（getOfflinePresets 要读预设目录），
       *  未就绪时立刻给骨架，别让用户以为点了没反应；读取失败给「重试」+ 兜底「不套预设」。 */
      const presetsLoading = presets === undefined
      const presetsFailed = presets === null
      const presetOf = (entry) => entry?.definition?.id ?? entry?.file
      const firstPresetId = entries[0] ? presetOf(entries[0]) : ''
      const presetId = picked === null ? firstPresetId : picked
      const preset = entries.find((entry) => presetOf(entry) === presetId)
      const prompt = buildTeamPrompt({ name, goal, presetId, presetName: preset?.definition?.name })
      const avatarClass = (index) => (index === 0 ? 'mt-mavatar mt-mavatar-lead' : `mt-mavatar mt-mavatar-a${(index % 4) + 1}`)
      /** 实例名 = 角色 id；同名第二个起加 -2、-3（与成员实例名规则一致） */
      const instanceNameFor = (roleId, list) => {
        if (!list.some((item) => item.instanceName === roleId)) return roleId
        let n = 2
        while (list.some((item) => item.instanceName === `${roleId}-${n}`)) n += 1
        return `${roleId}-${n}`
      }
      const presetRoster = ((preset?.definition?.members ?? []).slice(0, MAX_ROSTER))
        .map((member) => ({ roleId: member.roleId, instanceName: member.instanceName ?? member.roleId }))
      const roster = rosterOverride ?? presetRoster
      const pickPreset = (id) => {
        setErr(null)
        setPicked(id)
        const entry = entries.find((item) => presetOf(item) === id)
        setRosterOverride(id ? (entry?.definition?.members ?? []).slice(0, MAX_ROSTER)
          .map((member) => ({ roleId: member.roleId, instanceName: member.instanceName ?? member.roleId })) : [])
      }
      const addRole = (role) => {
        if (roster.length >= MAX_ROSTER) return
        setRosterOverride([...roster, { roleId: role.id, instanceName: instanceNameFor(role.id, roster) }])
      }
      const removeAt = (index) => setRosterOverride(roster.filter((_, i) => i !== index))
      const start = () => {
        if (!name.trim()) { setStep(3); setErr(t('g6.wizard.needName')); return }
        if (!goal.trim()) { setStep(3); setErr(t('g6.wizard.needGoal')); return }
        // ctx.uiWorkspace 是「未 inject 就抛错」的服务属性；这里用 ctx.get 取，拿不到再降级为复制指令
        let workspace
        try { workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined } catch { workspace = undefined }
        const snapshot = workspace?.workspaces?.list?.getSnapshot?.()
        const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase()
        const target = (snapshot?.items ?? []).find((item) => norm(item.path) === norm(projectRoot))
        if (!workspace?.startSession || !target) { setErr(t('g6.wizard.unavailable')); return }
        workspace.startSession(target.workspaceId, { agentPreset: 'myteam-captain', prompt, whenDraftExists: 'replace' })
        onClose()
      }
      const copy = async () => {
        if (!name.trim()) { setStep(3); setErr(t('g6.wizard.needName')); return }
        if (!goal.trim()) { setStep(3); setErr(t('g6.wizard.needGoal')); return }
        setErr(null)
        if (await copyText(prompt)) setCopied(true)
      }
      const STEP_KEYS = [['preset', 1], ['roster', 2], ['goal', 3]]
      const stepBar = js('div', { className: 'mt-steps', children: STEP_KEYS.flatMap(([key, n], index) => {
        const cls = step === n ? 'mt-step mt-step-on' : step > n ? 'mt-step mt-step-done' : 'mt-step'
        return [
          js('span', { key: `step-${key}`, className: cls, 'aria-current': step === n ? 'step' : undefined, children: [
            j('b', { 'aria-hidden': true, children: step > n ? '✓' : String(n) }),
            j('span', { children: t(`g6.step.${key}`) }),
          ] }),
          index < STEP_KEYS.length - 1 ? j('span', { key: `sep-${key}`, className: 'mt-step-sep', 'aria-hidden': true }) : null,
        ]
      }) })
      const presetOption = (entry, index) => {
        const def = entry.definition ?? {}
        const id = presetOf(entry)
        const members = (def.members ?? []).slice(0, MAX_ROSTER)
        const checked = presetId === id
        const columns = (def.board?.columns ?? []).join(' / ') || '—'
        const rolesText = members.map((member) => roleLabel(member.roleId)).join(' + ') || '—'
        return js('div', {
          key: `preset-${id}`,
          className: 'mt-opt',
          role: 'radio',
          tabIndex: 0,
          'aria-checked': checked,
          onClick: () => pickPreset(id),
          children: [
            j('span', { className: 'mt-opt-mark', 'aria-hidden': true, children: checked ? '✓' : '' }),
            js('div', { className: 'mt-opt-main', children: [
              js('div', { className: 'mt-opt-title', children: [
                j('span', { children: def.name ?? id }),
                j('span', { className: `mt-src mt-src-${entry.origin ?? 'project'}`, children: t(`roles.origin.${entry.origin ?? 'project'}`) }),
              ] }),
              j('div', { className: 'mt-opt-sub', children: t('g6.wizard.rosterMeta').replace('{n}', String(members.length)).replace('{roles}', rolesText).replace('{tail}', columns) }),
              js('div', { className: 'mt-rosterline', children: members.map((member, memberIndex) => js('span', {
                key: `${member.roleId}-${memberIndex}`,
                className: memberIndex === 0 ? 'mt-mini-chip mt-mini-chip-lead' : 'mt-mini-chip',
                children: [
                  j('span', { className: avatarClass(memberIndex), 'aria-hidden': true, children: String(roleLabel(member.roleId)).slice(0, 1) }),
                  j('span', { children: member.instanceName ?? member.roleId }),
                ],
              })) }),
              entry.origin === 'global' ? j('div', { className: 'mt-opt-hint', children: t('g6.wizard.globalHint') }) : null,
            ] }),
          ],
        })
      }
      const presetList = js('div', { className: 'mt-opt-list', children: [
        ...entries.map(presetOption),
        js('div', {
          key: 'preset-none',
          className: 'mt-opt',
          role: 'radio',
          tabIndex: 0,
          'aria-checked': presetId === '',
          onClick: () => pickPreset(''),
          children: [
            j('span', { className: 'mt-opt-mark', 'aria-hidden': true, children: presetId === '' ? '✓' : '' }),
            js('div', { className: 'mt-opt-main', children: [
              j('div', { className: 'mt-opt-title', children: t('g6.wizard.noPreset') }),
              j('div', { className: 'mt-opt-sub', children: t('g6.wizard.noPresetSub') }),
            ] }),
          ],
        }),
      ] })
      const presetNote = js('div', { className: 'mt-note mt-note-info', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '◱' }),
        j('span', { children: [j('b', { children: t('g6.wizard.presetNote') }), t('g6.wizard.presetNoteBody')] }),
      ] })
      const roleOptions = (roles ?? []).filter((role) => !roster.some((item) => item.roleId === role.id))
      const rosterSection = js('div', { children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('g6.wizard.selected').replace('{n}', String(roster.length)) }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: t('g6.wizard.cap').replace('{n}', String(MAX_ROSTER)) }),
        ] }),
        roster.length === 0
          ? j('div', { className: 'mt-hint', children: t('g6.wizard.noPresetSub') })
          : js('div', { className: 'mt-rosterline', children: roster.map((item, index) => js('span', {
            key: `${item.instanceName}-${index}`,
            className: 'mt-mini-chip',
            children: [
              j('span', { className: avatarClass(index), 'aria-hidden': true, children: String(roleLabel(item.roleId)).slice(0, 1) }),
              j('span', { children: roleLabel(item.roleId) }),
              j('code', { className: 'mt-mini-chip-num', children: item.instanceName }),
              j('button', {
                className: 'mt-mini-chip-x',
                'aria-label': t('g6.wizard.remove').replace('{name}', item.instanceName),
                onClick: () => removeAt(index),
                children: '✕',
              }),
            ],
          })) }),
      ] })
      const captainNote = js('div', { className: 'mt-note mt-note-info', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⬢' }),
        j('span', { children: [j('b', { children: t('g6.wizard.captainNote') }), t('g6.wizard.captainNoteBody')] }),
      ] })
      const librarySection = js('div', { children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('g6.wizard.fromLibrary') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: t('g6.wizard.pickHint') }),
        ] }),
        roleOptions.length === 0
          ? j('div', { className: 'mt-hint', children: t('roles.empty') })
          : js('div', { className: 'mt-opt-list', children: roleOptions.map((role) => js('div', {
            key: role.id,
            className: 'mt-opt',
            role: 'checkbox',
            tabIndex: 0,
            'aria-checked': false,
            onClick: () => addRole(role),
            children: [
              j('span', { className: 'mt-opt-mark', 'aria-hidden': true }),
              js('div', { className: 'mt-opt-main', children: [
                js('div', { className: 'mt-opt-title', children: [
                  j('span', { children: role.name ?? roleLabel(role.id) }),
                  j('span', { className: `mt-src mt-src-${role.origin ?? 'project'}`, children: t(`roles.origin.${role.origin ?? 'project'}`) }),
                ] }),
                j('div', { className: 'mt-opt-sub', children: t('g6.wizard.willCreate')
                  .replace('{name}', instanceNameFor(role.id, roster))
                  .replace('{model}', role.model?.model ?? t('g6.wizard.inheritRoute'))
                  .replace('{desc}', role.description ?? '') }),
              ] }),
            ],
          })) }),
      ] })
      const goalSection = js('div', { className: 'mt-form', children: [
        js('div', { className: 'mt-field', children: [
          j('label', { children: t('g6.wizard.name') }),
          j('input', { value: name, placeholder: 'myteam-web', onChange: (e) => setName(e.target.value) }),
        ] }),
        js('div', { className: 'mt-field', children: [
          j('label', { children: t('g6.wizard.goal') }),
          j('input', { value: goal, placeholder: '把 X 做成 Y', onChange: (e) => setGoal(e.target.value) }),
        ] }),
        js('div', { className: 'mt-field', children: [
          j('label', { children: t('g6.wizard.promptTitle') }),
          j('div', { className: 'mt-prompt-preview', children: prompt }),
        ] }),
      ] })
      const TITLE_KEYS = { 1: 'g6.wizard.title1', 2: 'g6.wizard.title2', 3: 'g6.wizard.title3' }
      const DESC_KEYS = { 1: 'g6.wizard.desc1', 2: 'g6.wizard.desc2', 3: 'g6.wizard.desc3' }
      /** 预设加载态：3 行骨架 + 「正在加载预设…」（aria-live，读屏也知道在等） */
      const presetSkeleton = js('div', { className: 'mt-skeleton', role: 'status', 'aria-live': 'polite', children: [
        j('span', { className: 'mt-skeleton-cap', children: t('g6.wizard.loadingPresets') }),
        ...[0, 1, 2].map((index) => js('div', { key: `skeleton-${index}`, className: 'mt-skeleton-row', 'aria-hidden': true, children: [
          j('span', { className: 'mt-skeleton-dot' }),
          js('span', { className: 'mt-skeleton-lines', children: [
            j('span', { className: 'mt-skeleton-line mt-skeleton-line-lg' }),
            j('span', { className: 'mt-skeleton-line' }),
          ] }),
        ] })),
      ] })
      /** 预设读取失败：给出重试 + 「不套预设」兜底（不伪造预设数据） */
      const presetFailedNote = js('div', { className: 'mt-note mt-note-warn', role: 'alert', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⚠' }),
        j('span', { children: [j('b', { children: t('g6.wizard.presetsFailed') }), t('g6.wizard.presetsFailedBody')] }),
        j('button', { className: 'mt-btn mt-btn-sm', onClick: () => (onRetryPresets ? onRetryPresets() : undefined), children: t('g6.wizard.retry') }),
      ] })
      const foot = js('div', { className: 'mt-wizard-foot', children: [
        step === 1
          ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => (onManagePresets ? onManagePresets() : undefined), children: t('g6.wizard.managePresets') })
          : j('span', { className: 'mt-wizard-footnote', children: t('g6.wizard.later') }),
        js('div', { className: 'mt-wizard-actions', children: [
          step === 1 ? j('button', { className: 'mt-btn', onClick: onClose, children: t('g6.wizard.cancel') }) : null,
          step > 1 ? j('button', { className: 'mt-btn', onClick: () => setStep(step === 2 ? 1 : 2), children: t('g6.wizard.prev') }) : null,
          step === 3 ? j('button', { className: 'mt-btn', onClick: copy, children: copied ? t('g6.wizard.copied') : t('g6.wizard.copy') }) : null,
          step < 3
            ? j('button', {
              className: 'mt-btn mt-btn-primary',
              disabled: step === 1 && presetsLoading,
              onClick: () => setStep(step + 1),
              children: step === 1 ? t('g6.wizard.nextRoster') : t('g6.wizard.nextGoal'),
            })
            : j('button', { className: 'mt-btn mt-btn-primary', onClick: start, children: t('g6.wizard.start') }),
        ] }),
      ] })
      return js('div', { className: 'mt-wizard', role: 'dialog', 'aria-modal': 'true', 'aria-label': t(TITLE_KEYS[step]), children: [
        js('div', { className: 'mt-wizard-dialog', children: [
          js('div', { className: 'mt-wizard-head', children: [
            js('div', { className: 'mt-wizard-steprow', children: [
              stepBar,
              j('button', { className: 'mt-btn mt-btn-sm', onClick: onClose, 'aria-label': t('action.close'), children: '✕' }),
            ] }),
            j('h2', { className: 'mt-wizard-title', children: t(TITLE_KEYS[step]) }),
            j('p', { className: 'mt-wizard-desc', children: t(DESC_KEYS[step]) }),
          ] }),
          js('div', { className: 'mt-wizard-body', children: [
            /* 第 1 步：预设未就绪先给骨架/失败态，再给选项（design/new-team-1.html） */
            step === 1 && presetsLoading ? presetSkeleton : null,
            step === 1 && presetsFailed ? presetFailedNote : null,
            /* 失败时仍给「不套预设」兜底（presetList 在 entries 为空时只剩这一条） */
            step === 1 && !presetsLoading ? presetList : null,
            step === 1 && !presetsLoading && !presetsFailed ? presetNote : null,
            step === 2 ? rosterSection : null,
            step === 2 ? captainNote : null,
            step === 2 ? librarySection : null,
            step === 3 ? goalSection : null,
            err ? j('div', { className: 'mt-note mt-note-info', role: 'alert', children: err }) : null,
          ] }),
          foot,
        ] }),
      ] })
    }

    /** 角色表单（CHG-72，FR-27；CHG-73：技能/MCP 改目录多选）：写项目角色库；同名两段确认；内置/全局走「复制到项目」 */
    function RoleFormDrawer({ t, initial, onClose, save, catalog }) {
      const def = initial?.definition ?? {}
      const [name, setName] = react.useState(def.name ?? '')
      const [id, setId] = react.useState(def.id ?? '')
      const [idTouched, setIdTouched] = react.useState(Boolean(def.id))
      const [description, setDescription] = react.useState(def.description ?? '')
      const [systemPrompt, setSystemPrompt] = react.useState(def.systemPrompt ?? '')
      const [interest, setInterest] = react.useState((def.interestWords ?? []).join('，'))
      const [skills, setSkills] = react.useState([...(def.skills ?? [])])
      const [mcps, setMcps] = react.useState([...(def.mcpAllowlist ?? [])])
      const [provider, setProvider] = react.useState(def.model?.provider ?? '')
      const [model, setModel] = react.useState(def.model?.model ?? '')
      const [err, setErr] = react.useState(null)
      const [confirm, setConfirm] = react.useState(false)
      /* CHG-103：作用域（缺省项目级；全局必须明示 + 二次确认） */
      const [scope, setScope] = react.useState(initial?.scope === 'global' ? 'global' : 'project')
      const [busy, setBusy] = react.useState(false)
      const deriveId = (value) => String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
      react.useEffect(() => {
        if (!idTouched) setId(deriveId(name))
      }, [name, idTouched])
      const split = (value) => String(value ?? '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
      const submit = async () => {
        if (busy) return
        setErr(null)
        const role = {
          id: id.trim(),
          name: name.trim() || id.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          skills: [...skills],
          mcpAllowlist: [...mcps],
          interestWords: split(interest).slice(0, 8),
          ...(initial?.forkOrigin === 'builtin' ? { origin: `builtin:${def.id}` } : {}),
          version: (def.version ?? 1) + (initial?.mode === 'edit' ? 1 : 0),
        }
        if (!role.id) { setErr(t('role.needId')); return }
        if (!role.systemPrompt) { setErr(t('role.needPrompt')); return }
        if (provider.trim() && model.trim()) role.model = { provider: provider.trim(), model: model.trim() }
        setBusy(true)
        try {
          const result = await save(role, confirm, scope)
          if (result?.status === 'confirm-required') {
            setConfirm(true)
            /* 服务端确认文案随作用域不同（全局影响所有项目），原样展示 */
            setErr(result?.message ?? null)
            return
          }
          if (result?.status !== 'saved') throw new Error(result?.message ?? result?.code ?? 'save failed')
          onClose()
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-drawer mt-drawer-wide', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('strong', { children: `${t('role.formTitle')}${initial?.fork ? ` · ${t('role.fork')}` : ''}` }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        initial?.fork ? j('div', { className: 'mt-form-note', children: t('role.builtinReadonly') }) : null,
        js('div', { className: 'mt-form', children: [
          js('div', { className: 'mt-field-row', children: [
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.name') }),
              j('input', { value: name, onChange: (e) => setName(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.id') }),
              j('input', { value: id, onChange: (e) => { setIdTouched(true); setId(e.target.value) } }),
            ] }),
          ] }),
          /* CHG-103：作用域（缺省项目级；全局必须明示——用户定案「全局一定要明示」） */
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.scope') }),
            js('div', { className: 'mt-rolescope-row', role: 'radiogroup', children: [
              j('label', { className: scope === 'project' ? 'mt-rolescope-chip mt-rolescope-chip-active' : 'mt-scope-chip', children: [
                j('input', { type: 'radio', name: 'role-scope', checked: scope === 'project', onChange: () => { setScope('project'); setConfirm(false); setErr(null) } }),
                j('span', { children: t('role.scope.project') }),
                j('small', { children: t('role.scope.projectHint') }),
              ] }),
              j('label', { className: scope === 'global' ? 'mt-rolescope-chip mt-rolescope-chip-active' : 'mt-scope-chip', children: [
                j('input', { type: 'radio', name: 'role-scope', checked: scope === 'global', onChange: () => { setScope('global'); setConfirm(false); setErr(null) } }),
                j('span', { children: t('role.scope.global') }),
                j('small', { children: t('role.scope.globalHint') }),
              ] }),
            ] }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.desc') }),
            j('input', { value: description, onChange: (e) => setDescription(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.systemPrompt') }),
            j('textarea', { value: systemPrompt, onChange: (e) => setSystemPrompt(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.interestWords') }),
            j('input', { value: interest, placeholder: '代码审查，架构', onChange: (e) => setInterest(e.target.value) }),
          ] }),
          /* CHG-73：技能 / MCP 目录多选（getCapabilityCatalog；目录是提示不是白名单，仍可自由输入） */
          catalog === undefined
            ? j('div', { className: 'mt-form-note', children: t('state.loading') })
            : null,
          catalog?.fallback ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('role.catalogFallback') }) : null,
          catalog?.warnings?.length ? j('div', { className: 'mt-form-note', children: `${t('presets.warnings')}：${catalog.warnings.join('；')}` }) : null,
          j(CapabilityPicker, {
            t,
            label: t('role.skills'),
            value: skills,
            onChange: setSkills,
            options: catalog?.skills ?? [],
            emptyText: t('role.skillsEmpty'),
          }),
          j(CapabilityPicker, {
            t,
            label: t('role.mcp'),
            value: mcps,
            onChange: setMcps,
            options: catalog?.mcp ?? [],
            emptyText: t('role.mcpEmpty'),
          }),
          js('div', { className: 'mt-field-row', children: [
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.modelProvider') }),
              j('input', { value: provider, onChange: (e) => setProvider(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.modelName') }),
              j('input', { value: model, onChange: (e) => setModel(e.target.value) }),
            ] }),
          ] }),
          confirm ? j('div', { className: 'mt-form-note mt-flow-warn', role: 'alert', children: t('role.confirmOverwrite') }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: `${t('role.invalid').replace('{msg}', '')}${err}` }) : null,
          j('div', { className: 'mt-form-note', children: t('role.saveHint') }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: busy, onClick: submit, children: busy ? t('state.loading') : t('role.save') }),
          ] }),
        ] }),
      ] })
    }

    /** 任务表单（CHG-72，FR-29/31；CHG-73：新建单次 createTask，编辑结构改动给「保存并重新规划 / 只保存元数据」两个出口） */
    function TaskFormDrawer({ t, mode, teams, tasks, initial, defaultTeamId, connection, onClose, onSaved }) {
      const src = initial?.input ?? {}
      const [teamId, setTeamId] = react.useState(initial?.ownerTeamId ?? defaultTeamId ?? '')
      const [title, setTitle] = react.useState(src.title ?? '')
      const [description, setDescription] = react.useState(src.description ?? '')
      const [ac, setAc] = react.useState((src.acceptanceCriteria ?? []).join('\n'))
      const [deliverable, setDeliverable] = react.useState(src.deliverableSpec?.path ?? '')
      const [role, setRole] = react.useState(src.requiredRole ?? '')
      const [priority, setPriority] = react.useState(src.priority ?? 'P2')
      const [gates, setGates] = react.useState((src.gateChain ?? []).join(', '))
      const [deps, setDeps] = react.useState(new Set(src.deps ?? []))
      const [assignees, setAssignees] = react.useState(new Set(initial?.assignees ?? []))
      const [coops, setCoops] = react.useState(new Set((initial?.participants ?? []).filter((p) => p.role === 'coop').map((p) => p.teamId)))
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      /* CHG-89（QA-4 乐观锁）：编辑表单打开时的版本快照。保存时回传 expectedRevision，
       * 服务端与当前 revision 不等即 MT_REVISION_CONFLICT（账本零写入）——
       * 面板据此提示「别人刚改过，重新加载再改」，而不是静默覆盖对方的修改。 */
      const expectedRevision = typeof initial?.revision === 'number' ? initial.revision : undefined
      const [structural, setStructural] = react.useState(null)
      const [rescopeReason, setRescopeReason] = react.useState('')
      const team = teams.find((item) => item.teamId === teamId)
      const members = team?.members ?? []
      const roleOptions = [...new Set(members.map((member) => member.roleId))]
      const depOptions = (tasks ?? []).filter((task) => task.ownerTeamId === teamId && task.id !== initial?.id)
      const coopOptions = teams.filter((item) => item.teamId !== teamId)
      const online = Boolean(team?.online && team?.sessionId)
      react.useEffect(() => {
        if (!role && roleOptions.length > 0) setRole(roleOptions[0])
      }, [teamId, members.length])
      const initialNorm = initial ? {
        title: src.title ?? '', description: src.description ?? '', ac: (src.acceptanceCriteria ?? []).join('\n'),
        deliverable: src.deliverableSpec?.path ?? '', deps: (src.deps ?? []).join(','), role: src.requiredRole ?? '',
        priority: src.priority ?? 'P2', gates: (src.gateChain ?? []).join(','),
      } : null
      const toggle = (set, value) => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }
      const running = initial ? (initial.state === 'in_progress' || String(initial.state ?? '').startsWith('gate:')) : false
      /**
       * CHG-89（QA-4）：版本冲突的统一提示。
       *
       * 服务端在 `MT_REVISION_CONFLICT` 时回显 `currentRevision`——直接展示两侧版本号，
       * 用户才知道「我基于哪一版改、现在是哪一版」，而不是只看到一句「保存失败」。
       */
      const conflictText = (r) => t('task.revisionConflict')
        .replace('{current}', String(r?.currentRevision ?? '—'))
        .replace('{snapshot}', String(expectedRevision ?? '—'))
      /** mode: 'save' 普通保存 | 'meta' 只保存元数据 | 'rescope' 保存并重新规划（理由必填） */
      const submit = async (intent = 'save') => {
        if (busy) return
        setErr(null)
        const metaOnly = intent === 'meta'
        const rescoping = intent === 'rescope'
        const acList = ac.split('\n').map((line) => line.trim()).filter(Boolean)
        if (!title.trim()) { setErr(t('task.needTitle')); return }
        if (acList.length === 0) { setErr(t('task.needAc')); return }
        if (!online) { setErr(t('task.needOnline')); return }
        if (!role) { setErr(t('task.needRole')); return }
        if (rescoping && !rescopeReason.trim()) { setErr(t('task.rescopeNeedReason')); return }
        const gateList = gates.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        const api = makeApi(connection, team.sessionId)
        setBusy(true)
        try {
          if (mode === 'create') {
            const payload = {
              title: title.trim(),
              description: description.trim(),
              acceptanceCriteria: acList,
              deps: [...deps],
              requiredRole: role,
              priority,
              ...(deliverable.trim() ? { deliverableSpec: { path: deliverable.trim() } } : {}),
              ...(gateList.length > 0 ? { gateChain: gateList } : {}),
            }
            // CHG-73：新建改为单次 createTask（assignees/participants 随创建一起落账，服务端补写标注）
            const created = await api.createTask({
              teamId,
              task: payload,
              ...(assignees.size > 0 ? { assignees: [...assignees] } : {}),
              ...(coops.size > 0 ? { participants: [...coops].map((coopId) => ({ teamId: coopId })) } : {}),
            })
            if (created?.status !== 'created') throw new Error(created?.message ?? created?.code ?? 'create failed')
            const warnings = (created.warnings ?? []).filter(Boolean)
            const message = t('task.created').replace('{id}', created.taskId) + (warnings.length > 0 ? ` · ${warnings.join('；')}` : '')
            onSaved(created.taskId, message)
            return
          }
          const normalized = {
            title: title.trim(), description: description.trim(), ac: acList.join('\n'),
            deliverable: deliverable.trim(), deps: [...deps].join(','), role,
            priority, gates: gateList.join(','),
          }
          const patch = {}
          if (normalized.title !== initialNorm.title) patch.title = normalized.title
          if (normalized.description !== initialNorm.description) patch.description = normalized.description
          if (normalized.ac !== initialNorm.ac) patch.acceptanceCriteria = acList
          if (normalized.deps !== initialNorm.deps) patch.deps = [...deps]
          if (normalized.role !== initialNorm.role) patch.requiredRole = role
          if (normalized.priority !== initialNorm.priority) patch.priority = priority
          if (normalized.gates !== initialNorm.gates) patch.gateChain = gateList
          if (normalized.deliverable !== initialNorm.deliverable) patch.deliverableSpec = { path: normalized.deliverable }
          const structuralKeys = ['acceptanceCriteria', 'deps', 'requiredRole', 'gateChain', 'deliverableSpec'].filter((key) => key in patch)
          const initialAssignees = new Set(initial?.assignees ?? [])
          const assigneesChanged = assignees.size !== initialAssignees.size || [...assignees].some((id) => !initialAssignees.has(id))
          // CHG-73：结构字段改动且任务在跑 → 两个出口：保存并重新规划（rescopeTask）/ 只保存元数据（updateTask）
          if (running && structuralKeys.length > 0 && !metaOnly) {
            if (!rescoping) {
              setStructural(structuralKeys)
              return
            }
          }
          if (rescoping) {
            const r = await api.rescopeTask({
              teamId,
              taskId: initial.id,
              reason: rescopeReason.trim(),
              ...(Object.keys(patch).length > 0 ? { patch } : {}),
              ...(assigneesChanged && assignees.size > 0 ? { memberIds: [...assignees] } : {}),
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            })
            if (r?.code === 'MT_REVISION_CONFLICT') { setErr(conflictText(r)); return }
            if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'rescope failed')
            if (r?.status !== 'rescoped') throw new Error(r?.message ?? 'rescope failed')
            onSaved(null, t('task.rescopeDone').replace('{id}', String(initial.id)).replace('{state}', stateLabel(r.state)))
            return
          }
          if (metaOnly) for (const key of structuralKeys) delete patch[key]
          if (Object.keys(patch).length === 0 && !assigneesChanged) { onClose(); return }
          let updated = null
          if (Object.keys(patch).length > 0) {
            updated = await api.updateTask({
              teamId,
              taskId: initial.id,
              patch,
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            })
          }
          if (updated?.code === 'MT_REVISION_CONFLICT') { setErr(conflictText(updated)); return }
          if (updated?.status === 'error' && updated?.code === 'MT_TASK_STRUCTURAL_EDIT') {
            setStructural(structuralKeys.length > 0 ? structuralKeys : ['acceptanceCriteria'])
            return
          }
          if (updated && updated.status !== 'updated') throw new Error(updated?.message ?? updated?.code ?? 'update failed')
          if (assigneesChanged && assignees.size > 0) {
            const assigned = await api.assignTask({
              teamId,
              taskId: initial.id,
              memberIds: [...assignees],
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            })
            if (assigned?.code === 'MT_REVISION_CONFLICT') { setErr(conflictText(assigned)); return }
          }
          for (const coopId of coops) {
            if ((initial.participants ?? []).some((p) => p.teamId === coopId)) continue
            await api.participateTask({ teamId, taskId: initial.id, participantTeamId: coopId, role: 'coop' })
          }
          onSaved(null, t('task.updated'))
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-drawer mt-drawer-wide', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('strong', { children: mode === 'create' ? t('task.formTitleNew') : t('task.formTitleEdit') }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-form', children: [
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.team') }),
            js('select', {
              value: teamId,
              disabled: mode === 'edit',
              onChange: (e) => { setTeamId(e.target.value); setRole(''); setDeps(new Set()); setAssignees(new Set()); setCoops(new Set()) },
              children: teams.map((item) => j('option', { key: item.teamId, value: item.teamId, children: `${item.name || item.teamId}${item.online ? '' : ` · ${t('global.offline')}`}` })),
            }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.title') }),
            j('input', { value: title, onChange: (e) => setTitle(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.desc') }),
            j('textarea', { value: description, onChange: (e) => setDescription(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.ac') }),
            j('textarea', { value: ac, onChange: (e) => setAc(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field-row', children: [
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.role') }),
              js('select', {
                value: role,
                onChange: (e) => setRole(e.target.value),
                children: [
                  j('option', { value: '', children: '—' }),
                  ...roleOptions.map((id) => j('option', { key: id, value: id, children: roleLabel(id) })),
                ],
              }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.priority') }),
              js('select', {
                value: priority,
                onChange: (e) => setPriority(e.target.value),
                children: ['P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value, value, children: value })),
              }),
            ] }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.deliverable') }),
            j('input', { value: deliverable, placeholder: 'docs/x.md', onChange: (e) => setDeliverable(e.target.value) }),
          ] }),
          depOptions.length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.deps') }),
            js('div', { className: 'mt-checklist', children: depOptions.map((task) => js('label', { key: task.key, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: deps.has(task.id), onChange: () => setDeps((prev) => toggle(prev, task.id)) }),
              j('span', { children: `${task.id} · ${task.title}` }),
            ] })) }),
          ] }) : null,
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.gates') }),
            j('input', { value: gates, placeholder: 'review, verify, archive', onChange: (e) => setGates(e.target.value) }),
          ] }),
          members.length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.assignees') }),
            js('div', { className: 'mt-checklist', children: members.map((member) => js('label', { key: member.id, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: assignees.has(member.id), onChange: () => setAssignees((prev) => toggle(prev, member.id)) }),
              j('span', { children: `${member.instanceName} · ${roleLabel(member.roleId)}` }),
            ] })) }),
          ] }) : null,
          coopOptions.length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.participants') }),
            js('div', { className: 'mt-checklist', children: coopOptions.map((item) => js('label', { key: item.teamId, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: coops.has(item.teamId), onChange: () => setCoops((prev) => toggle(prev, item.teamId)) }),
              j('span', { children: item.name || item.teamId }),
            ] })) }),
          ] }) : null,
          structural ? js('div', { className: 'mt-form-note mt-flow-warn', role: 'alert', children: [
            j('div', { children: t('task.structuralBlocked') }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.structuralReason') }),
              j('input', { value: rescopeReason, placeholder: t('rescope.reason'), onChange: (e) => setRescopeReason(e.target.value) }),
            ] }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn', onClick: () => setStructural(null), children: t('task.dismissStructural') }),
              j('button', { className: 'mt-btn', disabled: busy, onClick: () => submit('meta'), children: t('task.saveMetaOnly') }),
              j('button', {
                className: 'mt-btn mt-btn-primary',
                disabled: busy || !rescopeReason.trim(),
                title: rescopeReason.trim() ? t('task.rescopeAndSave') : t('task.rescopeNeedReason'),
                onClick: () => submit('rescope'),
                children: busy ? t('state.loading') : t('task.rescopeAndSave'),
              }),
            ] }),
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
          !online ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('task.needOnline') }) : null,
          online && members.length === 0 ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('task.noMembers') }) : null,
          j('div', { className: 'mt-form-note', children: t('task.formHint') }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: busy || !online || members.length === 0 || Boolean(structural), onClick: () => submit('save'), children: busy ? t('state.loading') : t('task.save') }),
          ] }),
        ] }),
      ] })
    }

    /* ══ CHG-76 B：批量新建草稿（目标 + 行列表 → 预览 impact → 一次创建） ══ */

    /** 草稿行的稳定 key（只用于列表渲染；不参与提交内容） */
    let batchDraftSeq = 0
    const newBatchDraftRow = (role) => ({ k: `bd-${++batchDraftSeq}`, title: '', role: role ?? '', priority: 'P2', deps: '' })

    /** 批量新建抽屉：每行一条任务；「依赖行号」= 本批 1-based 行号（如 1,2）→ 提交成 after[]
     *  预览 = createTasks 不带 confirm（不写账本）；创建 = 带 confirm 逐条落账。 */
    function BatchCreateDrawer({ t, connection, teams, defaultTeamId, onClose, onCreated }) {
      const [teamId, setTeamId] = react.useState(defaultTeamId ?? '')
      const [goal, setGoal] = react.useState('')
      const [rows, setRows] = react.useState(() => [newBatchDraftRow('')])
      const [impact, setImpact] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const team = (teams ?? []).find((item) => item.teamId === teamId)
      const online = Boolean(team?.online && team?.sessionId)
      const roleOptions = [...new Set((team?.members ?? []).map((member) => member.roleId).filter(Boolean))]
      const rowRole = (row) => row.role || roleOptions[0] || ''
      /** 行列表 → createTasks.tasks[]（数字 = 本批行号 → after[]；非数字 = 既有任务 id → deps[]） */
      const buildTasks = () => rows.map((row, index) => {
        const tokens = String(row.deps ?? '').split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
        const after = [...new Set(tokens.map((item) => Number(item)))]
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= rows.length && n !== index + 1)
        const ids = tokens.filter((item) => !/^\d+$/.test(item))
        return {
          title: String(row.title ?? '').trim(),
          requiredRole: rowRole(row),
          priority: row.priority || 'P2',
          ...(ids.length > 0 ? { deps: ids } : {}),
          ...(after.length > 0 ? { after } : {}),
        }
      })
      /* 草稿行一改，旧预览就过期了——立刻清掉，免得"看着旧影响面点创建" */
      const updateRow = (key, patch) => { setImpact(null); return setRows((prev) => prev.map((row) => (row.k === key ? { ...row, ...patch } : row))) }
      const addRow = () => { setImpact(null); return setRows((prev) => [...prev, newBatchDraftRow(roleOptions[0] ?? '')]) }
      const removeRow = (key) => { setImpact(null); return setRows((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.k !== key))) }
      const validate = () => {
        if (!online) return t('batchCreate.offline')
        if (rows.length === 0) return t('batchCreate.needRows')
        if (rows.some((row) => !String(row.title ?? '').trim())) return t('batchCreate.needTitle')
        if (roleOptions.length === 0 || rows.some((row) => !rowRole(row))) return t('batchCreate.needRole')
        return null
      }
      const callCreate = (confirm) => makeApi(connection, team.sessionId).createTasks({
        teamId,
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        tasks: buildTasks(),
        ...(confirm ? { confirm: true } : {}),
      })
      const preview = async () => {
        if (busy) return
        setErr(null)
        const invalid = validate()
        if (invalid) { setErr(invalid); return }
        setBusy(true)
        try {
          const r = await callCreate(false)
          if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'preview failed')
          if (r?.status !== 'confirm-required') throw new Error(r?.message ?? 'preview failed')
          setImpact(r.impact ?? {})
        } catch (e) {
          setErr(t('batchCreate.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const submit = async () => {
        if (busy) return
        setErr(null)
        const invalid = validate()
        if (invalid) { setErr(invalid); return }
        setBusy(true)
        try {
          const r = await callCreate(true)
          if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'create failed')
          if (r?.status !== 'created') throw new Error(r?.message ?? 'create failed')
          const summary = r.summary ?? {}
          const created = Number(summary.created ?? (r.tasks ?? []).length)
          const failed = Number(summary.failed ?? 0)
          /* 部分失败不中断：把逐条失败的 message/code 原样带进 notice（依赖失败那条会是 MT_DEPENDENCY_FAILED） */
          const failureNotes = [...new Set((r.results ?? [])
            .filter((item) => item && item.ok === false)
            .map((item) => String(item.message ?? item.code ?? ''))
            .filter(Boolean))].slice(0, 3)
          const message = t('batchCreate.done').replace('{n}', String(created)).replace('{failed}', String(failed))
            + (failureNotes.length > 0 ? ` · ${t('batchCreate.failedItems').replace('{items}', failureNotes.join('；'))}` : '')
          onCreated?.(message)
        } catch (e) {
          setErr(t('batchCreate.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const impactTasks = Number(impact?.tasks ?? rows.length)
      return js('div', { className: 'mt-drawer mt-drawer-wide', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('strong', { children: t('batchCreate.title') }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        j('div', { className: 'mt-form-note', children: t('batchCreate.hint') }),
        js('div', { className: 'mt-form', children: [
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('batchCreate.team') }),
            js('select', {
              value: teamId,
              onChange: (e) => { setTeamId(e.target.value); setRows([newBatchDraftRow('')]); setImpact(null) },
              children: (teams ?? []).map((item) => j('option', {
                key: item.teamId,
                value: item.teamId,
                children: `${item.name || item.teamId}${item.online ? '' : ` · ${t('global.offline')}`}`,
              })),
            }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('batchCreate.goal') }),
            j('input', { value: goal, onChange: (e) => setGoal(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('batchCreate.rows') }),
            ...rows.map((row, index) => js('div', { key: row.k, className: 'mt-drawrow', children: [
              js('div', { className: 'mt-drawrow-head', children: [
                j('strong', { children: `#${index + 1}` }),
                j('span', { className: 'mt-hint', children: t('batchCreate.rowDeps') }),
                j('button', {
                  className: 'mt-link mt-link-danger',
                  disabled: rows.length <= 1,
                  onClick: () => removeRow(row.k),
                  children: t('batchCreate.removeRow'),
                }),
              ] }),
              js('div', { className: 'mt-drawgrid', children: [
                js('div', { className: 'mt-field', children: [
                  j('label', { children: t('batchCreate.rowTitle') }),
                  j('input', { value: row.title, onChange: (e) => updateRow(row.k, { title: e.target.value }) }),
                ] }),
                js('div', { className: 'mt-field', children: [
                  j('label', { children: t('batchCreate.rowRole') }),
                  js('select', {
                    value: rowRole(row),
                    onChange: (e) => updateRow(row.k, { role: e.target.value }),
                    children: roleOptions.length === 0
                      ? [j('option', { value: '', children: '—' })]
                      : roleOptions.map((id) => j('option', { key: id, value: id, children: roleLabel(id) })),
                  }),
                ] }),
                js('div', { className: 'mt-field', children: [
                  j('label', { children: t('batchCreate.rowPriority') }),
                  js('select', {
                    value: row.priority,
                    onChange: (e) => updateRow(row.k, { priority: e.target.value }),
                    children: ['P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value, value, children: value })),
                  }),
                ] }),
                js('div', { className: 'mt-field', children: [
                  j('label', { children: t('batchCreate.rowDeps') }),
                  j('input', { value: row.deps, placeholder: '1,2', onChange: (e) => updateRow(row.k, { deps: e.target.value }) }),
                ] }),
              ] }),
            ] })),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: addRow, children: t('batchCreate.addRow') }),
          ] }),
          impact ? js('div', { className: 'mt-impactbox', role: 'alert', children: [
            j('strong', { children: t('batchCreate.impact').replace('{n}', String(impactTasks)) }),
            impact.byRole && Object.keys(impact.byRole).length > 0 ? js('div', { className: 'mt-impactlist', children: [
              j('span', { className: 'mt-hint', children: t('batchCreate.byRole') }),
              js('div', { className: 'mt-rolechips', children: Object.entries(impact.byRole).map(([roleId, count]) => j('span', { key: roleId, className: 'mt-rolechip', children: `${roleLabel(roleId)} ×${count}` })) }),
            ] }) : null,
            (impact.rolesMissing ?? []).length > 0 ? j('span', { className: 'mt-hint mt-flow-warn', children: t('batchCreate.rolesMissing').replace('{roles}', (impact.rolesMissing ?? []).map((id) => roleLabel(String(id))).join('、')) }) : null,
            (impact.edges ?? []).length > 0 ? js('div', { className: 'mt-impactlist', children: [
              j('span', { className: 'mt-hint', children: t('batchCreate.edges') }),
              ...(impact.edges ?? []).map((edge, i) => j('span', { key: `${i}`, children: `${edge.from} → ${edge.to}` })),
            ] }) : null,
            /* 服务端自动补齐（缺 AC / 叶子缺交付物）会逐条带序号回来——原样列出，别吞掉 */
            (impact.warnings ?? []).length > 0 ? js('div', { className: 'mt-impactlist', children: [
              j('span', { className: 'mt-hint', children: t('batchCreate.warnings') }),
              ...(impact.warnings ?? []).map((item, i) => j('span', { key: `${i}`, children: String(item) })),
            ] }) : null,
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
          !online ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('batchCreate.offline') }) : null,
          j('div', { className: 'mt-form-note', children: t('batchCreate.previewFirst') }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
            j('button', { className: 'mt-btn', disabled: busy || !online, onClick: preview, children: busy ? t('state.loading') : t('batchCreate.preview') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: busy || !online, onClick: submit, children: busy ? t('state.loading') : t('batchCreate.submit') }),
          ] }),
        ] }),
      ] })
    }

    /* ══ CHG-73 P2：改动记录 / 重新规划 / 取消 / 批量操作 / 能力目录多选 ══ */

    /** 改动记录折叠区（TaskDetail）：字段中文名 + 旧→新 + actor + 时间 + 理由（新→旧，最多 20 条） */
    function EditHistory({ t, edits, memberName, limit = 20 }) {
      const [open, setOpen] = react.useState(false)
      const all = edits ?? []
      const list = all.slice(0, limit)
      return js('div', { children: [
        j('h4', { children: js('button', {
          className: 'mt-foldhead',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
          children: [
            j('span', { 'aria-hidden': true, children: open ? '▾' : '▸' }),
            j('span', { children: t('detail.edits') }),
            j('span', { className: 'mt-count', children: all.length }),
          ],
        }) }),
        open ? (list.length === 0
          ? j('div', { className: 'mt-hint', children: t('detail.editsEmpty') })
          : js('div', { className: 'mt-editlist', children: [
            all.length > list.length ? j('div', { className: 'mt-hint', children: t('detail.editsLimit').replace('{n}', String(list.length)) }) : null,
            ...list.map((edit) => js('div', { key: edit.seq, className: 'mt-edititem', children: [
              js('div', { className: 'mt-edithead', children: [
                j('span', { className: 'mt-seq', children: `#${edit.seq}` }),
                j('span', { className: 'mt-actor', children: actorLabel(edit.actor, memberName) }),
                j('span', { className: 'mt-hint', children: fmtClock(edit.ts) }),
              ] }),
              ...(edit.changes ?? []).map((change, i) => js('div', { key: i, className: 'mt-change', children: [
                j('b', { children: fieldLabel(t, change.field) }),
                j('span', { children: '：' }),
                j('span', { className: 'mt-change-from', children: fieldValueText(t, change.field, change.from) }),
                j('span', { className: 'mt-change-arrow', children: '→' }),
                j('span', { className: 'mt-change-to', children: fieldValueText(t, change.field, change.to) }),
              ] })),
              edit.reason ? j('div', { className: 'mt-editreason', children: `${t('detail.editReason')}：${edit.reason}` }) : null,
            ] })),
          ] })) : null,
      ] })
    }

    /** 能力目录多选（技能 / MCP）：点选 chip 增删 + 自由输入（目录是提示不是白名单） */
    function CapabilityPicker({ t, label, value, options, onChange, emptyText, placeholder }) {
      const picked = value ?? []
      const opts = options ?? []
      const [draft, setDraft] = react.useState('')
      const has = (name) => picked.includes(name)
      const push = (names) => {
        const next = [...picked]
        for (const raw of names) {
          const name = String(raw ?? '').trim()
          if (name && !next.includes(name)) next.push(name)
        }
        onChange(next)
      }
      const remove = (name) => onChange(picked.filter((item) => item !== name))
      const commit = () => {
        const parts = String(draft).split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
        if (parts.length > 0) push(parts)
        setDraft('')
      }
      return js('div', { className: 'mt-field', children: [
        js('div', { className: 'mt-cap-label', children: [
          j('label', { children: label }),
          j('span', { className: 'mt-hint', children: `${t('role.catalog')} ${opts.length}` }),
        ] }),
        js('div', { className: 'mt-capbox', children: [
          picked.length > 0
            ? js('div', { className: 'mt-cap-picked', children: picked.map((name) => j('button', {
              key: name,
              className: 'mt-cap-opt mt-cap-opt-on',
              title: `${name} ×`,
              onClick: () => remove(name),
              children: `${name} ×`,
            })) })
            : j('div', { className: 'mt-hint', children: emptyText ?? t('role.catalogEmpty') }),
          js('div', { className: 'mt-cap-row', children: [
            j('input', {
              value: draft,
              placeholder: placeholder ?? t('role.catalogFree'),
              'aria-label': label,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault?.(); commit() } },
            }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: commit, children: t('role.catalogAdd') }),
          ] }),
          opts.length > 0 ? js('div', { className: 'mt-rolechips', children: opts.map((opt) => js('button', {
            key: opt.name,
            className: has(opt.name) ? 'mt-cap-opt mt-cap-opt-on' : 'mt-cap-opt',
            'aria-pressed': has(opt.name),
            title: opt.name,
            onClick: () => (has(opt.name) ? remove(opt.name) : push([opt.name])),
            children: [
              j('span', { children: opt.name }),
              j('span', { className: 'mt-cap-src', children: opt.source === 'host' ? 'host' : 'role' }),
            ],
          })) }) : null,
          j('div', { className: 'mt-hint', children: t('role.catalogHint') }),
        ] }),
      ] })
    }

    /** 重新规划对话框（CHG-73 §4.3）：理由必填 + 可选结构补丁 + 可选重派队员 → rescopeTask */
    function RescopeDialog({ t, api, teamId, taskId, title, input, members, tasks, expectedRevision, onClose, onDone }) {
      const src = input ?? {}
      const [reason, setReason] = react.useState('')
      const [showPatch, setShowPatch] = react.useState(false)
      const [nextTitle, setNextTitle] = react.useState(src.title ?? '')
      const [description, setDescription] = react.useState(src.description ?? '')
      const [ac, setAc] = react.useState((src.acceptanceCriteria ?? []).join('\n'))
      const [deliverable, setDeliverable] = react.useState(src.deliverableSpec?.path ?? '')
      const [role, setRole] = react.useState(src.requiredRole ?? '')
      const [priority, setPriority] = react.useState(src.priority ?? '')
      const [gates, setGates] = react.useState((src.gateChain ?? []).join(', '))
      const [deps, setDeps] = react.useState(new Set(src.deps ?? []))
      const [memberIds, setMemberIds] = react.useState(new Set())
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const toggle = (set, value) => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }
      const roleOptions = [...new Set((members ?? []).map((member) => member.roleId).filter(Boolean))]
      const depOptions = (tasks ?? []).filter((task) => task.id !== taskId)
      const submit = async () => {
        if (busy) return
        setErr(null)
        const trimmed = String(reason).trim()
        if (!trimmed) { setErr(t('task.rescopeNeedReason')); return }
        const acList = ac.split('\n').map((line) => line.trim()).filter(Boolean)
        const gateList = gates.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        const patch = {}
        if (nextTitle.trim() !== (src.title ?? '')) patch.title = nextTitle.trim()
        if (description.trim() !== (src.description ?? '')) patch.description = description.trim()
        if (acList.join('\n') !== (src.acceptanceCriteria ?? []).join('\n')) patch.acceptanceCriteria = acList
        if (deliverable.trim() !== (src.deliverableSpec?.path ?? '')) patch.deliverableSpec = { path: deliverable.trim() }
        if (role !== (src.requiredRole ?? '')) patch.requiredRole = role
        if (priority !== (src.priority ?? '')) patch.priority = priority
        if (gateList.join(',') !== (src.gateChain ?? []).join(',')) patch.gateChain = gateList
        if ([...deps].join(',') !== (src.deps ?? []).join(',')) patch.deps = [...deps]
        setBusy(true)
        try {
          const r = await api.rescopeTask({
            teamId,
            taskId,
            reason: trimmed,
            ...(Object.keys(patch).length > 0 ? { patch } : {}),
            ...(memberIds.size > 0 ? { memberIds: [...memberIds] } : {}),
            /* CHG-89（QA-4 乐观锁）：与编辑表单同一条规则——基于过期版本的重新规划不落地 */
            ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
          })
          if (r?.code === 'MT_REVISION_CONFLICT') {
            throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
          }
          if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'rescope failed')
          if (r?.status !== 'rescoped') throw new Error(r?.message ?? 'rescope failed')
          onDone?.(r)
        } catch (e) {
          setErr(t('task.rescopeFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-overlay', children: js('div', { className: 'mt-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('rescope.title'), children: [
        js('div', { className: 'mt-dialog-head', children: [
          j('strong', { children: `${t('rescope.title')} · ${title || taskId}` }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-dialog-body', children: [
          j('div', { className: 'mt-form-note', children: t('rescope.hint') }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('rescope.reason') }),
            j('textarea', { value: reason, placeholder: t('rescope.reason'), onChange: (e) => setReason(e.target.value) }),
          ] }),
          j('button', { className: 'mt-chipbtn', 'aria-expanded': showPatch, onClick: () => setShowPatch(!showPatch), children: `${showPatch ? '▾' : '▸'} ${t('rescope.patch')}` }),
          showPatch ? js('div', { className: 'mt-form', children: [
            j('div', { className: 'mt-hint', children: t('rescope.patchHint') }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('field.title') }),
              j('input', { value: nextTitle, onChange: (e) => setNextTitle(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('field.description') }),
              j('textarea', { value: description, onChange: (e) => setDescription(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.ac') }),
              j('textarea', { value: ac, onChange: (e) => setAc(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field-row', children: [
              js('div', { className: 'mt-field', children: [
                j('label', { children: t('task.field.role') }),
                js('select', {
                  value: role,
                  onChange: (e) => setRole(e.target.value),
                  children: [
                    j('option', { value: '', children: '—' }),
                    ...roleOptions.map((id) => j('option', { key: id, value: id, children: roleLabel(id) })),
                  ],
                }),
              ] }),
              js('div', { className: 'mt-field', children: [
                j('label', { children: t('field.priority') }),
                js('select', {
                  value: priority,
                  onChange: (e) => setPriority(e.target.value),
                  children: ['', 'P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value || 'none', value, children: value || '—' })),
                }),
              ] }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.deliverable') }),
              j('input', { value: deliverable, onChange: (e) => setDeliverable(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.gates') }),
              j('input', { value: gates, onChange: (e) => setGates(e.target.value) }),
            ] }),
            depOptions.length > 0 ? js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.deps') }),
              js('div', { className: 'mt-checklist', children: depOptions.map((task) => js('label', { key: task.key ?? task.id, className: 'mt-check', children: [
                j('input', { type: 'checkbox', checked: deps.has(task.id), onChange: () => setDeps((prev) => toggle(prev, task.id)) }),
                j('span', { children: `${task.id} · ${task.title}` }),
              ] })) }),
            ] }) : null,
          ] }) : null,
          (members ?? []).length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('rescope.reassign') }),
            js('div', { className: 'mt-checklist', children: (members ?? []).map((member) => js('label', { key: member.id, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: memberIds.has(member.id), onChange: () => setMemberIds((prev) => toggle(prev, member.id)) }),
              j('span', { children: `${member.instanceName} · ${roleLabel(member.roleId)}` }),
            ] })) }),
            j('div', { className: 'mt-hint', children: t('rescope.reassignHint') }),
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
        ] }),
        js('div', { className: 'mt-dialog-actions', children: [
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
          j('button', {
            className: 'mt-btn mt-btn-primary',
            disabled: busy || !String(reason).trim(),
            title: String(reason).trim() ? t('rescope.submit') : t('task.rescopeNeedReason'),
            onClick: submit,
            children: busy ? t('state.loading') : t('rescope.submit'),
          }),
        ] }),
      ] }) })
    }

    /** 取消对话框（CHG-73 §4.4 / CHG-75 §5）：理由必填 + 下游策略三档（leave / cancel / rewire）；
     *  先拿 impact 再 confirm:true。rewire 档可指定新上游（不选 = 解除依赖让下游独立）。 */
    function CancelDialog({ t, api, teamId, taskId, title, dependents, upstreams, memberName, onClose, onDone }) {
      const [reason, setReason] = react.useState('')
      const [downstream, setDownstream] = react.useState('leave')
      const [rewireTo, setRewireTo] = react.useState('')
      const [impact, setImpact] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      /** rewire 档：选了具体上游才带 rewireTo；不选 = 解除依赖（下游变独立） */
      const rewireArgs = downstream === 'rewire' && rewireTo ? { rewireTo } : {}
      /** 两段确认的两步各自的响应处理（rewire 与常规两档共用，避免分支里重复） */
      const handleAsk = (r) => {
        if (r?.status === 'confirm-required') { setImpact(r.impact ?? {}); return }
        if (r?.status === 'cancelled') { onDone?.(r); return }
        throw new Error(r?.message ?? r?.code ?? 'cancel failed')
      }
      const handleConfirm = (r) => {
        if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'cancel failed')
        if (r?.status !== 'cancelled') throw new Error(r?.message ?? 'cancel failed')
        onDone?.(r)
      }
      const ask = async () => {
        if (busy) return
        setErr(null)
        const trimmed = String(reason).trim()
        if (!trimmed) { setErr(t('cancel.needReason')); return }
        setBusy(true)
        try {
          /* rewire 档单独一条调用：rewireTo 只在这一档出现，不选则不传（= 解除依赖） */
          if (downstream === 'rewire') {
            const r = await api.cancelTask({ teamId, taskId, reason: trimmed, downstream, ...rewireArgs })
            handleAsk(r)
            return
          }
          const r = await api.cancelTask({ teamId, taskId, reason: trimmed, downstream })
          handleAsk(r)
        } catch (e) {
          setErr(t('cancel.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const confirm = async () => {
        if (busy) return
        setErr(null)
        setBusy(true)
        try {
          if (downstream === 'rewire') {
            const r = await api.cancelTask({ teamId, taskId, reason: String(reason).trim(), downstream, ...rewireArgs, confirm: true })
            handleConfirm(r)
            return
          }
          const r = await api.cancelTask({ teamId, taskId, reason: String(reason).trim(), downstream, confirm: true })
          handleConfirm(r)
        } catch (e) {
          setErr(t('cancel.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const deps = impact?.dependents ?? dependents ?? []
      /** 影响面文案按档位分述（leave 保持原样 / cancel 一并取消 / rewire 改挂新上游） */
      const impactKey = downstream === 'cancel' ? 'cancel.impactCascade' : downstream === 'rewire' ? 'cancel.impactRewire' : 'cancel.impact'
      const upstreamOptions = upstreams ?? []
      return js('div', { className: 'mt-overlay', children: js('div', { className: 'mt-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('cancel.title'), children: [
        js('div', { className: 'mt-dialog-head', children: [
          j('strong', { children: `${t('cancel.title')} · ${title || taskId}` }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-dialog-body', children: [
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('cancel.reason') }),
            j('textarea', { value: reason, placeholder: t('cancel.reason'), onChange: (e) => { setReason(e.target.value); setImpact(null) } }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('cancel.strategy') }),
            js('label', { className: 'mt-radio', children: [
              j('input', { type: 'radio', name: 'mt-downstream', checked: downstream === 'leave', onChange: () => { setDownstream('leave'); setImpact(null) } }),
              j('span', { children: t('cancel.leave') }),
            ] }),
            js('label', { className: 'mt-radio', children: [
              j('input', { type: 'radio', name: 'mt-downstream', checked: downstream === 'cancel', onChange: () => { setDownstream('cancel'); setImpact(null) } }),
              j('span', { children: t('cancel.cascade') }),
            ] }),
            js('label', { className: 'mt-radio', children: [
              j('input', { type: 'radio', name: 'mt-downstream', checked: downstream === 'rewire', onChange: () => { setDownstream('rewire'); setImpact(null) } }),
              j('span', { children: t('cancel.rewire') }),
            ] }),
          ] }),
          downstream === 'rewire' ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('cancel.rewireTo') }),
            j('select', {
              className: 'mt-select',
              value: rewireTo,
              'aria-label': t('cancel.rewireTo'),
              onChange: (e) => { setRewireTo(e.target.value); setImpact(null) },
              children: [
                j('option', { value: '', children: t('cancel.rewireNone') }),
                ...upstreamOptions.map((option) => j('option', {
                  key: option.id,
                  value: option.id,
                  children: `${option.id} · ${option.title ?? ''}${option.done ? ` ${t('cancel.rewireDone')}` : ''}`,
                })),
              ],
            }),
            j('div', { className: 'mt-hint', children: upstreamOptions.length === 0 ? t('cancel.rewireEmpty') : t('cancel.rewireHint') }),
          ] }) : null,
          impact ? js('div', { className: 'mt-impactbox', role: 'alert', children: [
            j('strong', { children: t(impactKey).replace('{dependents}', String(deps.length)) }),
            j('span', { children: impact.hasAttempt ? t('cancel.hasAttempt') : t('cancel.noAttempt') }),
            deps.length > 0 ? js('div', { children: [
              j('span', { children: `${t('cancel.dependents')}：` }),
              j('span', { className: 'mt-hint', children: deps.join('、') }),
            ] }) : null,
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
        ] }),
        js('div', { className: 'mt-dialog-actions', children: [
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
          impact
            ? j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: confirm, children: busy ? t('state.loading') : t('cancel.confirm') })
            : j('button', { className: 'mt-btn mt-btn-primary', disabled: busy || !String(reason).trim(), onClick: ask, children: busy ? t('state.loading') : t('cancel.step1') }),
        ] }),
      ] }) })
    }

    /** 批量操作条（CHG-73 §4.2）：底部浮动；取消两段确认并显示影响面；指派/优先级就地选参数
     *  CHG-76 A：下游策略三档 leave / cancel / rewire + 「新的上游」下拉（不选 = 解除依赖） */
    function BatchBar({ t, tasks, allTasks, teams, memberName, onExit, onClear, runBatch, onDone }) {
      const [reason, setReason] = react.useState('')
      const [priority, setPriority] = react.useState('P2')
      const [memberIds, setMemberIds] = react.useState(new Set())
      const [showMembers, setShowMembers] = react.useState(false)
      const [strategy, setStrategy] = react.useState('leave')
      const [rewireTo, setRewireTo] = react.useState('')
      const [pending, setPending] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const picked = tasks ?? []
      const ownerTeams = [...new Set(picked.map((task) => task.ownerTeamId))]
      const memberOptions = (teams ?? [])
        .filter((team) => ownerTeams.includes(team.teamId))
        .flatMap((team) => (team.members ?? []).map((member) => ({ id: member.id, teamId: team.teamId, label: `${team.name || team.teamId} · ${member.instanceName}` })))
      /* CHG-76 A：新上游候选 = 所选任务所属团队内、不在所选集合、非 cancelled/failed；done 可选并标「（已完成）」 */
      const selectedIds = new Set(picked.map((task) => task.id))
      const ownerTeamSet = new Set(ownerTeams)
      const rewireOptions = (allTasks ?? [])
        .filter((task) => ownerTeamSet.has(task.ownerTeamId) && !selectedIds.has(task.id))
        .filter((task) => !['cancelled', 'failed'].includes(String(task.state ?? '')))
        .map((task) => ({ id: task.id, title: task.title ?? '', done: String(task.state ?? '') === 'done' }))
      /* rewire 档：选了具体上游才带 rewireTo；不选 = 解除依赖（下游变独立） */
      const rewireArgs = strategy === 'rewire' && rewireTo ? { rewireTo } : {}
      const toggle = (set, value) => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }
      const finish = (r) => {
        setPending(null)
        onDone?.(r)
      }
      const exec = async (op) => {
        if (busy) return
        setErr(null)
        if ((op === 'cancel' || op === 'rescope') && !String(reason).trim()) { setErr(t('batch.needReason')); return }
        if (op === 'assign' && memberIds.size === 0) { setErr(t('batch.needMembers')); return }
        /* rewireTo 是单值：跨团队混选没法给每个团队同一个合法上游，先让用户按团队筛选（防整批 MT_VALIDATION） */
        if (op === 'cancel' && strategy === 'rewire' && ownerTeams.length > 1) { setErr(t('batch.rewireOneTeam')); return }
        setBusy(true)
        try {
          const extra = {
            reason: String(reason).trim(),
            ...(op === 'cancel' ? { downstream: strategy, ...rewireArgs } : {}),
            ...(op === 'assign' ? { memberIds: [...memberIds] } : {}),
            ...(op === 'priority' ? { priority } : {}),
          }
          const r = await runBatch(op, extra, false)
          if (r?.kind === 'confirm') { setPending({ op, impacts: r.impacts ?? [] }); return }
          finish(r)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      const confirmCancel = async () => {
        if (busy) return
        setErr(null)
        if (strategy === 'rewire' && ownerTeams.length > 1) { setErr(t('batch.rewireOneTeam')); return }
        setBusy(true)
        try {
          const r = await runBatch('cancel', { reason: String(reason).trim(), downstream: strategy, ...rewireArgs }, true)
          finish(r)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      const impact = (pending?.impacts ?? []).reduce((acc, item) => ({
        tasks: acc.tasks + Number(item?.impact?.tasks ?? 0),
        dependents: [...acc.dependents, ...(item?.impact?.dependents ?? [])],
        /* CHG-76 A：服务端按所选任务给出各自要被改挂的直接下游（多团队混选时合并展示） */
        rewireByTask: [...acc.rewireByTask, ...(item?.impact?.rewireByTask ?? [])],
      }), { tasks: 0, dependents: [], rewireByTask: [] })
      const disabled = busy || picked.length === 0 || picked.length > 50
      return js('div', { className: 'mt-batchbar', role: 'toolbar', 'aria-label': t('batch.title'), children: [
        j('strong', { children: `${t('batch.title')} · ${t('multi.count').replace('{n}', String(picked.length))}` }),
        picked.length > 50 ? j('span', { className: 'mt-hint', children: t('multi.max').replace('{n}', '50') }) : null,
        j('input', { value: reason, placeholder: t('batch.reason'), 'aria-label': t('batch.reason'), onChange: (e) => setReason(e.target.value) }),
        j('button', { className: 'mt-btn mt-btn-sm mt-btn-danger', disabled, onClick: () => exec('cancel'), children: t('batch.cancelTask') }),
        /* CHG-76 A：批量取消的下游策略三选一（默认 leave；rewire 需选新上游，不选 = 解除依赖） */
        js('span', { className: 'mt-batchbar-group', children: ['leave', 'cancel', 'rewire'].map((value) => js('label', {
          key: value,
          className: 'mt-radio mt-batchbar-opt',
          title: value === 'rewire' ? (ownerTeams.length > 1 ? t('batch.rewireOneTeam') : t('batch.rewireHint')) : undefined,
          children: [
            j('input', {
              type: 'radio',
              name: 'mt-batch-downstream',
              checked: strategy === value,
              /* rewireTo 是单值：跨团队混选时这一档不可用（避免整批 MT_VALIDATION） */
              disabled: busy || (value === 'rewire' && ownerTeams.length > 1),
              onChange: () => { setStrategy(value); setPending(null) },
            }),
            /* cancel 档沿用「同时取消下游」文案（batch.cancel 只剩旧值「取消」，避免与按钮混淆） */
            j('span', { children: t(value === 'cancel' ? 'batch.cascade' : `batch.${value}`) }),
          ],
        })) }),
        strategy === 'rewire' ? js('span', { className: 'mt-batchbar-group', children: [
          j('select', {
            className: 'mt-select',
            value: rewireTo,
            'aria-label': t('batch.rewireTo'),
            title: t('batch.rewireHint'),
            disabled: busy,
            onChange: (e) => { setRewireTo(e.target.value); setPending(null) },
            children: [
              j('option', { value: '', children: t('batch.rewireNone') }),
              ...rewireOptions.map((option) => j('option', {
                key: option.id,
                value: option.id,
                children: `${option.id} · ${option.title}${option.done ? ` ${t('batch.rewireDone')}` : ''}`,
              })),
            ],
          }),
        ] }) : null,
        j('button', { className: 'mt-btn mt-btn-sm', disabled, onClick: () => exec('rescope'), children: t('batch.rescope') }),
        js('select', {
          className: 'mt-select',
          value: priority,
          'aria-label': t('batch.priority'),
          title: t('batch.priority'),
          onChange: (e) => setPriority(e.target.value),
          children: ['P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value, value, children: value })),
        }),
        j('button', { className: 'mt-btn mt-btn-sm', disabled, onClick: () => exec('priority'), children: t('batch.priority') }),
        j('button', { className: 'mt-chipbtn' + (showMembers ? ' mt-chipbtn-active' : ''), 'aria-expanded': showMembers, onClick: () => setShowMembers(!showMembers), children: t('batch.assign') }),
        showMembers ? js('div', { className: 'mt-batchbar-group', children: [
          memberOptions.length === 0
            ? j('span', { className: 'mt-hint', children: t('batch.needMembers') })
            : js('div', { className: 'mt-checklist', children: memberOptions.map((opt) => js('label', { key: opt.id, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: memberIds.has(opt.id), onChange: () => setMemberIds((prev) => toggle(prev, opt.id)) }),
              j('span', { children: opt.label }),
            ] })) }),
          j('button', { className: 'mt-btn mt-btn-sm', disabled, onClick: () => exec('assign'), children: t('batch.run') }),
        ] }) : null,
        pending ? js('div', { className: 'mt-batchbar-impact', children: [
          j('span', { children: t(strategy === 'cancel' ? 'batch.impactCascade' : strategy === 'rewire' ? 'batch.impactRewire' : 'batch.impact').replace('{tasks}', String(impact.tasks)).replace('{dependents}', String(impact.dependents.length)) }),
          strategy === 'rewire' ? j('span', { className: 'mt-hint', children: `${t('batch.rewireTo')}：${rewireTo || t('batch.rewireNone')}` }) : null,
          strategy === 'rewire' && impact.rewireByTask.length > 0 ? js('div', { className: 'mt-impactlist', children: [
            j('span', { className: 'mt-hint', children: t('batch.rewireByTask') }),
            ...impact.rewireByTask.map((item) => j('span', {
              key: String(item.taskId),
              children: `${item.taskId} → ${(item.directDependents ?? []).join('、') || t('batch.rewireNoDeps')}`,
            })),
          ] }) : null,
          impact.dependents.length > 0 ? j('span', { children: t('batch.impactDeps').replace('{deps}', impact.dependents.join('、')) }) : null,
          j('span', { children: t('batch.confirmHint') }),
          js('span', { className: 'mt-batchbar-group', children: [
            j('button', { className: 'mt-btn mt-btn-sm mt-btn-danger', disabled: busy, onClick: confirmCancel, children: busy ? t('state.loading') : t('batch.confirm') }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setPending(null), children: t('action.cancel') }),
          ] }),
        ] }) : null,
        err ? j('span', { className: 'mt-batchbar-impact', role: 'alert', children: err }) : null,
        js('div', { className: 'mt-batchbar-group', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onClear, children: t('multi.clear') }),
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onExit, children: t('multi.off') }),
        ] }),
      ] })
    }

    function Panel(props) {
      const { ctx, connection, t: tProp } = props
      const t = tProp ?? ((k) => zh[k] ?? k)
      /* CHG-99（C13）：宿主**解析后**的深色态写到面板表面根上；样式侧只用 `.mt-*[data-theme="dark"]`，
       * 不再依赖系统偏好媒体查询（宿主手动切深色时媒体查询不触发）。 */
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      const discoveryApi = react.useMemo(() => makeApi(connection), [connection])
      const [scope, setScope] = react.useState('global')          // 全局 | 项目
      const [projectTab, setProjectTab] = react.useState('tasks') // 角色 | 团队 | 任务
      const [projectRoot, setProjectRoot] = react.useState('')
      /**
       * CHG-102：项目级存储状态（`.dsh-myteam/` 是否已初始化）。
       *
       * 为什么必须有：用户还没进团队模式时，面板此前照样渲染角色库/团队/任务
       * （内置角色 + 全局库 + 别的项目的离线团队）——「所有项目看起来都一样、
       * 还没开始就一堆内容」。未初始化时只画一句空态 + 初始化入口。
       */
      const [storeState, setStoreState] = react.useState(undefined)
      const [teams, setTeams] = react.useState(null)
      const [project, setProject] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [selectedTeamId, setSelectedTeamId] = react.useState(null)
      const [teamTab, setTeamTab] = react.useState('members')     // 队员 | 参与任务 | 知识 | 审计 | 设置
      /* design/team-tasks.html：本队角色筛选（全部 / 主责 / 协作） */
      const [teamTaskFilter, setTeamTaskFilter] = react.useState('all')
      const [taskView, setTaskView] = react.useState('board')     // 列表 | 看板 | 流程 | 依赖图
      const [dagDir, setDagDir] = react.useState('h')
      // CHG-82：拖拽流转态（design/dragging.html）—— 被拖起的卡 + 当前落点列 + 被拒回执
      const [dragTask, setDragTask] = react.useState(null)
      const [dragToast, setDragToast] = react.useState(null)
      const [dragShake, setDragShake] = react.useState(null)      // 非法落点：源卡抖动 + 弹回 150ms
      const [railTeam, setRailTeam] = react.useState('all')
      const [taskQuery, setTaskQuery] = react.useState('')
      const [taskPrio, setTaskPrio] = react.useState('all')
      const [taskMember, setTaskMember] = react.useState('all')
      const [openTask, setOpenTask] = react.useState(null)        // { key, teamId, taskId, online, sessionId }
      const [openRole, setOpenRole] = react.useState(null)
      const [roleDetail, setRoleDetail] = react.useState(null)
      const [kb, setKb] = react.useState(undefined)
      const [audit, setAudit] = react.useState(undefined)
      const [auditFilter, setAuditFilter] = react.useState('all')
      const [config, setConfig] = react.useState(undefined)
      const [tokens, setTokens] = react.useState(undefined)
      const [inbox, setInbox] = react.useState(null)
      const [presets, setPresets] = react.useState(undefined)
      const [showCost, setShowCost] = react.useState(false)
      /* CHG-82（G3）：全局作用域的随行资产子页——角色库 / 预设库 / 技能 & MCP（design/presets.html · skills.html） */
      const [globalPage, setGlobalPage] = react.useState('roles')
      const [showRules, setShowRules] = react.useState(false)
      const [disband, setDisband] = react.useState(null)
      /* CHG-86 / P0-2：归档快照（getArchive 的真实落盘内容；undefined=未加载，null=未归档） */
      const [archiveSnap, setArchiveSnap] = react.useState(undefined)
      const [archiveRoot, setArchiveRoot] = react.useState('')
      const [disbandBusy, setDisbandBusy] = react.useState(false)
      /* CHG-72：面板闭环（建队引导 / 角色表单 / 任务表单 / 成功提示） */
      const [notice, setNotice] = react.useState(null)
      const [teamCreate, setTeamCreate] = react.useState(false)
      const [roleForm, setRoleForm] = react.useState(null)
      const [taskForm, setTaskForm] = react.useState(null)
      /* CHG-73：多选批量 / 重新规划 / 取消 / 详情刷新 / 能力目录 */
      const [selectMode, setSelectMode] = react.useState(false)
      const [selected, setSelected] = react.useState(() => new Set())
      const [rescopeFor, setRescopeFor] = react.useState(null)
      const [cancelFor, setCancelFor] = react.useState(null)
      const [detailToken, setDetailToken] = react.useState(0)
      const [capCatalog, setCapCatalog] = react.useState(undefined)
      /* CHG-76 B：批量新建草稿抽屉（参与既有抽屉互斥，不另起状态库） */
      const [batchCreate, setBatchCreate] = react.useState(false)

      /* CHG-72：抽屉互斥——同一时间只开一个表单，避免「点了新建团队却看到任务表单」 */
      /* CHG-84：打开建团向导时若预设目录还没就绪（或上次读取失败），立刻触发拉取 ——
       * 抽屉里先渲染骨架，避免「点了没反应」；已就绪则不重复拉。 */
      const openTeamCreator = () => {
        setTeamCreate(true)
        setRoleForm(null)
        setTaskForm(null)
        setOpenRole(null)
        setBatchCreate(false)
        if (presets === null) setPresets(undefined)
      }
      const openRoleEditor = (form) => { setRoleForm(form); setTaskForm(null); setTeamCreate(false); setBatchCreate(false) }
      const openTaskEditor = (form) => { setTaskForm(form); setRoleForm(null); setTeamCreate(false); setOpenRole(null); setOpenTask(null); setBatchCreate(false) }
      /* CHG-76 B：批量新建抽屉也走同一互斥 */
      const openBatchCreator = () => { setBatchCreate(true); setTaskForm(null); setRoleForm(null); setTeamCreate(false); setOpenRole(null); setOpenTask(null) }
      const closeDrawers = () => { setTeamCreate(false); setRoleForm(null); setTaskForm(null); setBatchCreate(false) }
      /* CHG-82 G2：角色库的两个跨页动作（全局作用域也要能「复制进项目 / 用它单干」） */
      /** 复制进项目 = 打开角色编辑器（fork 语义：先复制再改，不静默覆盖；同名由服务端两段确认） */
      const copyRoleToProject = async (role) => {
        if (!role?.id) return
        try {
          const detail = await discoveryApi.getRoleDetail({ workspaceRoot: projectRoot, roleId: role.id })
          const definition = detail?.status === 'ok' ? detail.definition : undefined
          openRoleEditor({ mode: 'create', fork: true, forkOrigin: role.origin, definition: definition ?? { ...role } })
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }
      /** 用它单干 = 复制 /myteam+<roleId> 命令（不新增写路径；单角色调用在普通会话里发起） */
      const guestRoleCommand = async (role) => {
        const roleId = role?.id
        if (!roleId) return
        const command = `/myteam+${roleId}`
        const ok = await copyText(command)
        setNotice(t(ok ? 'roles.guestCopied' : 'roles.guestCopyFailed').replace('{cmd}', command))
      }
      const exitSelect = () => { setSelectMode(false); setSelected(new Set()) }
      const toggleSelected = (task) => setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(task.key)) next.delete(task.key)
        else next.add(task.key)
        return next
      })

      const loadTeams = react.useCallback(async () => {
        try {
          const d = await discoveryApi.listTeams()
          setTeams(d?.teams ?? [])
        } catch (e) {
          setTeams([])
          setError(String(e?.message ?? e))
        }
      }, [discoveryApi])

      /* CHG-99（C3）：请求序号 + 项目根快照 —— 并发/切项目时只认**最后一次**请求的响应。
       * 修复前 `loadProject` 无序号、无 alive 守卫，两个可复现 bug：
       *  ① 切项目闪回：从「结算页」切到「插件 v0.2」时旧项目的 `getProject` 还在飞，
       *     回来照样 `setProject(旧项目)` → 面板闪回上一个项目，等下次 5s 轮询才纠正；
       *  ② 写后数据倒退：点「批准计划」→ `await planAction()` → `await loadProject()`
       *     （9 处写后全量刷新）与 5s 轮询撞车时，慢的响应覆盖新状态 → 界面显示「批准前」，
       *     用户以为没生效再点一次 → **二次操作**。
       * 序号用 ref（useState 会多一轮渲染）；`projectRootRef` 是 projectRoot 的渲染期镜像——
       * 异步回调里的 `projectRoot` 是发起时那次渲染的闭包值，读 ref 才是当前值。 */
      const loadSeqRef = useRefSafe(0)
      const projectRootRef = useRefSafe(projectRoot)
      projectRootRef.current = projectRoot
      const loadProject = react.useCallback(async (root) => {
        if (!root) { setProject(null); return }
        const seq = ++loadSeqRef.current
        /** 过期响应：被更新的请求顶掉，或调用方的 root 已不是当前项目 */
        const stale = () => seq !== loadSeqRef.current || root !== projectRootRef.current
        try {
          const p = await discoveryApi.getProject({ workspaceRoot: root })
          if (stale()) return
          if (p?.status === 'ok') { setProject(p); setError(null) } else setError(p?.message ?? t('error.unreadable'))
        } catch (e) {
          /* 错误分支同样要守卫：过期响应的 error 也不能盖掉当前项目的状态 */
          if (stale()) return
          setError(String(e?.message ?? e))
        }
      }, [discoveryApi, t])

      react.useEffect(() => { loadTeams() }, [loadTeams])
      // 项目候选：优先有团队的工作区；一个团队都没有时退回当前 GUI 的工作区列表（新项目也能建队/建角色）
      const rootCandidates = react.useMemo(() => {
        const teamRoots = [...new Set((teams ?? []).map((team) => team.workspaceRoot).filter(Boolean))]
        if (teamRoots.length > 0) return teamRoots.sort()
        try {
          const service = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined
          const items = service?.workspaces?.list?.getSnapshot?.()?.items ?? []
          return [...new Set(items.map((item) => String(item.path ?? '')).filter(Boolean))].sort()
        } catch {
          return []
        }
      }, [teams, ctx])
      react.useEffect(() => {
        if (rootCandidates.length === 0) return
        if (!projectRoot || !rootCandidates.includes(projectRoot)) setProjectRoot(rootCandidates[0])
      }, [rootCandidates, projectRoot])
      react.useEffect(() => { loadProject(projectRoot) }, [projectRoot, loadProject])
      /* CHG-102 / CHG-104：项目存储状态。
       * 纪律：**读取失败绝不阻塞面板**——失败/方法缺失/加载中一律视为「未知」(undefined)，
       * 照常渲染面板；只有明确拿到 `initialized:false` 才显示引导横幅（不替换整屏）。 */
      react.useEffect(() => {
        if (!projectRoot) { setStoreState(undefined); return undefined }
        // 宿主 lib 可能是旧版本（门面方法未注册）→ 不能调用，否则 TypeError 会让面板卡死
        if (typeof discoveryApi.getStoreState !== 'function') { setStoreState(undefined); return undefined }
        let alive = true
        discoveryApi.getStoreState({ workspaceRoot: projectRoot })
          .then((r) => { if (alive) setStoreState(r?.status === 'ok' ? r : undefined) })
          .catch(() => { if (alive) setStoreState(undefined) })
        return () => { alive = false }
      }, [projectRoot, discoveryApi])
      /** 空态里的「初始化」：只建目录与元文件（幂等，不建团队不写账本） */
      const initStore = async () => {
        if (!projectRoot) return
        try {
          const r = await discoveryApi.initStore({ workspaceRoot: projectRoot })
          if (r?.status !== 'ok') { setError(r?.message ?? String(r)); return }
          setNotice(t('store.initDone').replace('{path}', String(r.root ?? '')))
          await loadProject(projectRoot)
        } catch (e) { setError(String(e?.message ?? e)) }
      }
      /* 5s 轮询（POLL_MS）：切到后台（visibilityState=hidden）时跳过本轮，不请求网关；
       * 回到可见时立刻补一次，避免「切回来要等一个周期才更新」。监听器在 effect 清理时移除。 */
      react.useEffect(() => {
        const tick = () => {
          if (isHidden()) return
          loadTeams()
          if (projectRoot) loadProject(projectRoot)
        }
        const timer = setInterval(tick, POLL_MS)
        const onVisible = () => { if (!isHidden()) tick() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [loadTeams, loadProject, projectRoot])

      // 角色详情：点开时按当前项目角色库拉一次（含定义全文与在册情况）
      react.useEffect(() => {
        if (!openRole || !projectRoot) { setRoleDetail(null); return undefined }
        let alive = true
        discoveryApi.getRoleDetail({ workspaceRoot: projectRoot, roleId: openRole }).then((r) => {
          if (alive) setRoleDetail(r?.status === 'ok' ? r : null)
        }).catch(() => { if (alive) setRoleDetail(null) })
        return () => { alive = false }
      }, [openRole, projectRoot, discoveryApi])

      const teamList = project?.teams ?? []
      const selectedTeam = selectedTeamId ? teamList.find((team) => team.teamId === selectedTeamId) : undefined
      const teamName = (id) => teamList.find((team) => team.teamId === id)?.name || id
      const memberName = (id) => {
        for (const team of teamList) {
          const m = (team.members ?? []).find((member) => member.id === id)
          if (m) return m.instanceName
        }
        return id
      }
      const api = react.useMemo(() => makeApi(connection, selectedTeam?.sessionId), [connection, selectedTeam?.sessionId])
      const offline = selectedTeam ? !selectedTeam.online : false

      const resetTeamCaches = () => {
        setKb(undefined); setAudit(undefined); setAuditFilter('all'); setConfig(undefined); setTokens(undefined); setInbox(null); setDisband(null)
        setArchiveSnap(undefined); setArchiveRoot('')
      }
      const openTeam = (teamId) => {
        setSelectedTeamId(teamId)
        setProjectTab('teams')
        setTeamTab('members')
        resetTeamCaches()
      }
      const closeTeam = () => { setSelectedTeamId(null); resetTeamCaches(); setShowCost(false) }

      /* CHG-86 / P0-2：归档团队选中时拉一次**真实快照**（archive/<teamId>/team.json 等落盘文件）。
       * 在线团队走 panel.getArchive（需要活跃会话）；离线团队 / 端点缺失 → 保持 undefined，
       * 归档视图降级到 board/tokens/audit 派生（不猜半个快照）。 */
      react.useEffect(() => {
        if (!selectedTeam || selectedTeam.state !== 'archived' || !selectedTeam.online || !selectedTeam.sessionId) {
          setArchiveSnap(undefined)
          setArchiveRoot('')
          return undefined
        }
        let alive = true
        makeApi(connection, selectedTeam.sessionId).getArchive({ teamId: selectedTeam.teamId }).then((r) => {
          if (!alive) return
          setArchiveSnap(r?.status === 'ok' ? (r.archive ?? null) : undefined)
          setArchiveRoot(r?.root ? String(r.root) : '')
        }).catch(() => { if (alive) { setArchiveSnap(undefined); setArchiveRoot('') } })
        return () => { alive = false }
      }, [selectedTeam?.teamId, selectedTeam?.state, selectedTeam?.online, selectedTeam?.sessionId, connection])

      // 团队 tab 数据懒加载（知识/审计/设置/成本）
      react.useEffect(() => {
        if (!selectedTeam || !selectedTeamId) return undefined
        let alive = true
        const offlineCall = (method, query) => discoveryApi[method]({ workspaceRoot: projectRoot, teamId: selectedTeamId, ...query })
        if (teamTab === 'knowledge' && kb === undefined) {
          const pending = selectedTeam.online ? api.getKnowledge({ teamId: selectedTeamId }) : Promise.resolve({ status: 'unavailable' })
          pending.then((r) => { if (alive) setKb(r?.status === 'ok' ? (r.knowledge ?? null) : null) }).catch(() => { if (alive) setKb(null) })
        }
        if (teamTab === 'audit' && audit === undefined) {
          const pending = selectedTeam.online ? api.getAudit({ teamId: selectedTeamId, limit: 100 }) : offlineCall('getOfflineAudit', { limit: 100 })
          pending.then((r) => { if (alive) setAudit(r?.status === 'ok' ? { events: r.events ?? [], total: r.total ?? 0, nextBeforeSeq: r.nextBeforeSeq ?? null } : null) }).catch(() => { if (alive) setAudit(null) })
        }
        if (teamTab === 'settings' && config === undefined) {
          // 离线团队：getOfflineBoard 带出账本折叠后的生效配置（来源链 + 值），与在线同构
          const pending = selectedTeam.online
            ? api.getConfig({ teamId: selectedTeamId })
            : discoveryApi.getOfflineBoard({ workspaceRoot: projectRoot, teamId: selectedTeamId }).then((r) => (r?.status === 'ok' && r.config ? { status: 'ok', ...r.config } : { status: 'unavailable' }))
          pending.then((r) => { if (alive) setConfig(r?.status === 'ok' ? r : null) }).catch(() => { if (alive) setConfig(null) })
        }
        return () => { alive = false }
      }, [teamTab, selectedTeam, selectedTeamId, projectRoot, api, discoveryApi, kb, audit, config])
      // 成本：选中团队即加载（底部成本栏 + 抽屉共用）
      react.useEffect(() => {
        if (!selectedTeam || tokens !== undefined) return undefined
        let alive = true
        const pending = selectedTeam.online
          ? makeApi(connection, selectedTeam.sessionId).getTokens({ teamId: selectedTeam.teamId })
          : discoveryApi.getOfflineTokens({ workspaceRoot: projectRoot, teamId: selectedTeam.teamId })
        pending.then((r) => { if (alive) setTokens(r?.status === 'ok' ? (r.tokens ?? null) : null) }).catch(() => { if (alive) setTokens(null) })
        return () => { alive = false }
      }, [selectedTeam, tokens, connection, discoveryApi, projectRoot])
      // 暂存横幅（在线团队）
      react.useEffect(() => {
        if (!selectedTeam || !selectedTeam.online || !selectedTeam.sessionId) { setInbox(null); return undefined }
        let alive = true
        makeApi(connection, selectedTeam.sessionId).getInbox({ teamId: selectedTeam.teamId }).then((r) => {
          if (alive) setInbox(r?.inbox ?? null)
        }).catch(() => { if (alive) setInbox(null) })
        return () => { alive = false }
      }, [selectedTeam, connection])
      // 全局预设（文件目录，不需要会话）——CHG-72：建队引导在项目页也要用，故不再限 scope
      react.useEffect(() => { setPresets(undefined) }, [projectRoot])
      react.useEffect(() => {
        if (!projectRoot || presets !== undefined) return undefined
        let alive = true
        discoveryApi.getOfflinePresets({ workspaceRoot: projectRoot }).then((r) => {
          if (alive) setPresets(r?.status === 'ok' ? r : null)
        }).catch(() => { if (alive) setPresets(null) })
        return () => { alive = false }
      }, [scope, projectRoot, presets, discoveryApi])
      // CHG-73：技能 / MCP 候选目录——角色表单打开时才拉（失败降级为「已有角色出现过的名字」）
      react.useEffect(() => { setCapCatalog(undefined) }, [projectRoot])
      react.useEffect(() => {
        /* CHG-82（G3）：技能 & MCP 页也要目录——角色表单没开、但全局作用域停在技能页时照样拉 */
        if (!projectRoot || capCatalog !== undefined) return undefined
        if (!roleForm && !(scope === 'global' && globalPage === 'skills')) return undefined
        let alive = true
        discoveryApi.getCapabilityCatalog({ workspaceRoot: projectRoot }).then((r) => {
          if (alive) setCapCatalog(r?.status === 'ok' ? r : null)
        }).catch(() => { if (alive) setCapCatalog(null) })
        return () => { alive = false }
      }, [roleForm, projectRoot, capCatalog, discoveryApi, scope, globalPage])

      // CHG-63/69：筛选生效时把看板列区滚到第一个命中列（否则命中任务可能藏在右滚区）
      react.useEffect(() => {
        if (!taskQuery.trim() && taskPrio === 'all' && taskMember === 'all' && railTeam === 'all') return undefined
        const timer = setTimeout(() => {
          const el = typeof document !== 'undefined' ? document.querySelector('.mt-columns') : null
          if (!el) return
          const first = Array.from(el.children).find((col) => col.querySelector('.mt-task'))
          if (first) el.scrollLeft = Math.max(0, first.offsetLeft - el.offsetLeft - 8)
        }, 0)
        return () => clearTimeout(timer)
      }, [taskQuery, taskPrio, taskMember, railTeam])

      /* ── 顶部：作用域 + 项目选择 ── */
      const roots = rootCandidates
      const scopeSwitch = js('div', { className: 'mt-switch', role: 'tablist', 'aria-label': t('scope.label'), children: [
        j('button', { className: scope === 'global' ? 'mt-switch-btn mt-switch-active' : 'mt-switch-btn', role: 'tab', 'aria-selected': scope === 'global', onClick: () => setScope('global'), children: `${t('scope.global')}（${(project?.roles ?? []).filter((role) => role.origin !== 'project' && role.origin !== 'project-role').length}）` }),
        j('button', { className: scope === 'project' ? 'mt-switch-btn mt-switch-active' : 'mt-switch-btn', role: 'tab', 'aria-selected': scope === 'project', disabled: !projectRoot, onClick: () => { if (projectRoot) { setScope('project'); setSelectedTeamId(null) } }, children: t('scope.project') }),
      ] })
      const topbar = js('div', { className: 'mt-topbar', children: [
        j('strong', { className: 'mt-title', children: 'myteam' }),
        scopeSwitch,
        j('span', { className: 'mt-topbar-sep', 'aria-hidden': true }),
        roots.length > 1
          ? js('select', {
            className: 'mt-select',
            value: projectRoot,
            'aria-label': t('project.pick'),
            title: t('project.pick'),
            onChange: (e) => { setProjectRoot(e.target.value); setSelectedTeamId(null); resetTeamCaches() },
            children: roots.map((root) => j('option', { key: root, value: root, children: projectLabel(root) })),
          })
          /* CHG-79：只有一个工作区时没有下拉，才用文本兜底；两者同时出现等于把工作区名写两遍 */
          : (projectRoot ? j('span', { className: 'mt-hint', title: projectRoot, children: projectLabel(projectRoot) }) : null),
        j('button', { className: 'mt-btn', onClick: () => { loadTeams(); if (projectRoot) loadProject(projectRoot) }, 'aria-label': t('action.reload'), children: t('action.reload') }),
      ] })

      /* CHG-82（G3）：全局作用域的随行资产子页——预设库（design/presets.html）与技能 & MCP（design/skills.html）。
       * 两层都是「入口不藏」：随行资产卡直接进，页内 teambar 的「← 全局」回角色库。 */
      if (scope === 'global' && projectRoot && globalPage !== 'roles') {
        const globalRoleList = [...(project?.roles ?? []), ...(project?.projectRole ? [project.projectRole] : [])]
        return js('div', { className: 'mt-panel', ...themeAttr, children: [
          topbar,
          globalPage === 'presets'
            ? j(PresetsPage, {
              t,
              presets,
              teams: project?.teams ?? [],
              onBack: () => setGlobalPage('roles'),
              onUse: () => openTeamCreator(),
              onNotice: setNotice,
              onSkills: () => setGlobalPage('skills'),
            })
            : j(SkillsPage, {
              t,
              roles: globalRoleList,
              catalog: capCatalog,
              onBack: () => setGlobalPage('roles'),
              onPresets: () => setGlobalPage('presets'),
              onNotice: setNotice,
              onBind: () => { setScope('project'); setProjectTab('roles'); setSelectedTeamId(null) },
            }),
        ] })
      }

      /* ── 全局页：只有角色 + 随行资产（预设 / 技能&MCP） ── */
      if (scope === 'global') {
        const globalRoles = (project?.roles ?? []).filter((role) => role.origin === 'global')
        const builtinRoles = (project?.roles ?? []).filter((role) => role.origin === 'builtin')
        const skills = new Set()
        const mcps = new Set()
        for (const role of project?.roles ?? []) {
          for (const s of role.skills ?? []) skills.add(s)
          for (const m of role.mcpAllowlist ?? []) mcps.add(m)
        }
        return js('div', { className: 'mt-panel', ...themeAttr, children: [
          topbar,
          /* CHG-80：信息条按 design/global.html 的 header.teambar——作用域标题 + 副标题 + 说明 + 主按钮 */
          js('div', { className: 'mt-teambar', children: [
            js('span', { className: 'mt-teambar-title', children: [
              j('b', { children: t('scope.global') }),
              j('span', { className: 'mt-teambar-id', children: t('global.crossProject') }),
            ] }),
            j('span', { className: 'mt-teambar-goal', children: t('global.rolesNote') }),
            js('span', { className: 'mt-teambar-actions', children: [
              j('button', {
                className: 'mt-btn mt-btn-primary mt-btn-sm',
                title: t('global.newRole'),
                onClick: () => { setScope('project'); setProjectTab('roles'); setSelectedTeamId(null) },
                children: `＋ ${t('global.newRole')}`,
              }),
            ] }),
          ] }),
          js('div', { className: 'mt-workspace', children: [
          js('div', { className: 'mt-page', children: [
            /* CHG-96：插件贡献区块必须在**全局作用域**可见。
             *
             * 为什么：`$DSH_HOME/myteam/plugins` 是全局位置，贡献的角色进的就是「全局角色库」——
             * 而这一段原本只在「项目」作用域的「角色」tab 里渲染，且「项目」按钮在未选工作区时
             * 是 disabled 的。结果：用户装完插件、打开面板（默认停「全局」）看不到任何入口，
             * 区块自己的文案却说「贡献进全局角色库」。放在这里才和它的语义一致。 */
            j(ContributionsSection, {
              t,
              api: discoveryApi,
              workspaceRoot: projectRoot,
              onNotice: setNotice,
              onChanged: () => loadProject(projectRoot),
            }),
            /* CHG-80：区块顺序对齐设计稿——内置 → 全局 → 随行资产；每段「标题 · N + 横线 + 右侧说明」 */
            js('div', { id: 'mt-roles-section', className: 'mt-section-head', children: [
              j('h3', { children: `${t('roles.page.builtin')} · ${builtinRoles.length}` }),
              j('span', { className: 'mt-rule', 'aria-hidden': true }),
              j('span', { className: 'mt-hint', children: t('global.builtinNote') }),
            ] }),
            js('div', { className: 'mt-cardgrid', children: builtinRoles.map((role) => j(RoleCard, { key: `${role.origin}:${role.id}`, t, role, onOpen: setOpenRole })) }),
            js('div', { id: 'mt-global-roles-section', className: 'mt-section-head', children: [
              j('h3', { children: `${t('roles.page.global')} · ${globalRoles.length}` }),
              j('span', { className: 'mt-rule', 'aria-hidden': true }),
              j('span', { className: 'mt-hint', children: t('global.globalNote') }),
            ] }),
            globalRoles.length === 0
              ? j('div', { className: 'mt-empty-inline mt-hint', children: t('roles.empty') })
              : js('div', { className: 'mt-cardgrid', children: globalRoles.map((role) => j(RoleCard, { key: `${role.origin}:${role.id}`, t, role, onOpen: setOpenRole })) }),
            /* CHG-80：随行资产按 design/global.html 的卡片结构重做——
             * 图标 + 标题 + 副标题 + 一行内容 + 跳转脚；点击滚到下方对应区块，不再用大留白静态卡。 */
            js('div', { className: 'mt-section-head', children: [
              j('h3', { children: t('global.assets') }),
              j('span', { className: 'mt-rule', 'aria-hidden': true }),
              j('span', { className: 'mt-hint', children: t('global.assetsNote') }),
            ] }),
            js('div', { className: 'mt-assets', children: [
              j('button', {
                className: 'mt-assetcard',
                title: t('global.jumpPresets'),
                onClick: () => setGlobalPage('presets'),
                children: [
                  js('div', { className: 'mt-assetcard-top', children: [
                    j('span', { className: 'mt-assetcard-icon', 'aria-hidden': true, children: j('svg', {
                      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                      children: [
                        j('path', { d: 'M8 1.8 14.2 5 8 8.2 1.8 5z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                        j('path', { d: 'M1.8 8 8 11.2 14.2 8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                        j('path', { d: 'M1.8 11 8 14.2 14.2 11', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                      ],
                    }) }),
                    js('div', { className: 'mt-assetcard-body', children: [
                      j('div', { className: 'mt-assetcard-title', children: t('global.presets') }),
                      j('div', { className: 'mt-assetcard-sub', children: t('global.presetsSub') }),
                    ] }),
                  ] }),
                  j('div', { className: 'mt-assetcard-row', children: (presets?.entries ?? []).length > 0
                    ? presets.entries.map((entry) => entry.definition?.name ?? entry.definition?.id ?? entry.file).join(' · ')
                    : t('global.presetsEmpty') }),
                  js('div', { className: 'mt-assetcard-foot', children: [
                    j('span', { className: 'mt-hint', children: t('global.presetCount').replace('{n}', String(presets?.entries?.length ?? 0)) }),
                    /* CHG-85：跳转指示用 SVG chevron（design/icons.svg#i-chevron-right），不用 → 字符 */
                    j('span', { className: 'mt-assetcard-chev', 'aria-hidden': true, children: j('svg', {
                      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
                      children: j('path', { d: 'M9.5 6l6 6-6 6', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                    }) }),
                  ] }),
                ],
              }),
              j('button', {
                className: 'mt-assetcard',
                title: t('global.jumpRoles'),
                onClick: () => setGlobalPage('skills'),
                children: [
                  js('div', { className: 'mt-assetcard-top', children: [
                    j('span', { className: 'mt-assetcard-icon', 'aria-hidden': true, children: j('svg', {
                      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                      children: [
                        j('path', { d: 'M2.2 4.6 8 2l5.8 2.6v6.8L8 14 2.2 11.4z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                        j('path', { d: 'M2.2 4.6 8 7.2l5.8-2.6M8 7.2V14', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                      ],
                    }) }),
                    js('div', { className: 'mt-assetcard-body', children: [
                      j('div', { className: 'mt-assetcard-title', children: t('global.skills') }),
                      j('div', { className: 'mt-assetcard-sub', children: t('global.skillsSub') }),
                    ] }),
                  ] }),
                  j('div', { className: 'mt-assetcard-row', children: skills.size + mcps.size > 0
                    ? [...skills].map((name) => t('global.skillItem').replace('{n}', name)).concat([...mcps].map((name) => t('global.mcpItem').replace('{n}', name))).join(' · ')
                    : t('global.skillsEmpty') }),
                  js('div', { className: 'mt-assetcard-foot', children: [
                    j('span', { className: 'mt-hint', children: t('global.skillCount').replace('{s}', String(skills.size)).replace('{m}', String(mcps.size)) }),
                    j('span', { className: 'mt-assetcard-chev', 'aria-hidden': true, children: j('svg', {
                      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
                      children: j('path', { d: 'M9.5 6l6 6-6 6', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                    }) }),
                  ] }),
                ],
              }),
            ] }),
            /* CHG-82（G3）：预设库与技能 & MCP 各自成页（design/presets.html · skills.html），
             * 入口就是上面的随行资产卡——这里不再内联一份预设卡列表（避免两套模板渲染）。 */
          ] }),
          openRole ? j(RoleDetailDrawer, {
            t,
            data: roleDetail,
            onClose: () => setOpenRole(null),
            teamName,
            onCopyToProject: copyRoleToProject,
            onGuest: guestRoleCommand,
            skillTotal: (capCatalog?.skills ?? []).length || undefined,
            onEdit: roleDetail ? (detail) => openRoleEditor({ mode: detail.origin === 'project' ? 'edit' : 'create', fork: detail.origin !== 'project', forkOrigin: detail.origin, definition: detail.definition }) : undefined,
            /* 全局页只看与复制：删除是项目库的动作（deleteRoleFlow 在项目页作用域内），这里给只读说明 */
          }) : null,
          ] }),
        ] })
      }

      /* ── 项目页 ── */
      const pv = project
      const rolesCount = (pv?.roles ?? []).length + (pv?.projectRole ? 1 : 0)
      const projectTabs = js('div', { className: 'mt-subtabs', role: 'tablist', children: [
        j('button', { className: projectTab === 'roles' ? 'mt-tab mt-tab-active' : 'mt-tab', role: 'tab', 'aria-selected': projectTab === 'roles', onClick: () => { setProjectTab('roles'); setSelectedTeamId(null); exitSelect() }, children: `${t('project.tabs.roles')}（${rolesCount}）` }),
        j('button', { className: projectTab === 'teams' ? 'mt-tab mt-tab-active' : 'mt-tab', role: 'tab', 'aria-selected': projectTab === 'teams', onClick: () => { setProjectTab('teams'); exitSelect() }, children: `${t('project.tabs.teams')}（${(pv?.teams ?? []).length}）` }),
        j('button', { className: projectTab === 'tasks' ? 'mt-tab mt-tab-active' : 'mt-tab', role: 'tab', 'aria-selected': projectTab === 'tasks', onClick: () => { setProjectTab('tasks'); setSelectedTeamId(null) }, children: `${t('project.tabs.tasks')}（${(pv?.tasks ?? []).length}）` }),
      ] })

      if (!projectRoot) {
        return js('div', { className: 'mt-panel', ...themeAttr, children: [topbar, j('div', { className: 'mt-empty', children: [t('global.empty'), j('br'), t('global.emptyHint')] })] })
      }
      /**
       * CHG-104：**面板永不因为存储状态白屏**（用户反馈「UI 加载不出来」）。
       *
       * 修复前的两个 early return 把整屏换成了「加载中」/「一句话空态」：
       *  - `storeState === null`（读取失败或方法不存在）→ 永远停在「加载中」，没有出口；
       *  - `initialized === false` → 连 tab 和目录都不给看。
       *
       * 现在改成**非阻塞横幅**：未初始化时顶部提示 + 初始化按钮，**tab 与内容照常渲染**；
       * 未知（undefined）时什么都不显示，直接渲染正常面板。
       */
      const storeBanner = scope === 'project' && storeState && storeState.initialized === false
        ? js('div', { className: 'mt-banner mt-banner-info', role: 'status', children: [
            j('b', { children: t('store.emptyTitle') }),
            j('span', { className: 'mt-banner-text', children: t('store.emptyBody') }),
            j('code', { className: 'mt-banner-path', children: String(storeState.layout?.root ?? '') }),
            j('button', { className: 'mt-btn mt-btn-primary mt-btn-sm', onClick: initStore, children: t('store.init') }),
          ] })
        : null
      if (!pv) {
        return js('div', { className: 'mt-panel', ...themeAttr, children: [topbar, j('div', { className: 'mt-empty', children: error ?? t('state.loading') })] })
      }

      /* CHG-73：详情抽屉动作条的打开器（重新规划 / 取消）；成功后刷新看板 + 详情就地重载 */
      const openRescopeDialog = (detail) => {
        const ownerTeamId = openTask?.teamId
        const ownerTeam = (pv.teams ?? []).find((item) => item.teamId === ownerTeamId)
        setRescopeFor({
          teamId: ownerTeamId,
          taskId: detail?.id ?? openTask?.taskId,
          sessionId: openTask?.sessionId,
          title: detail?.input?.title ?? detail?.id ?? '',
          input: detail?.input ?? {},
          /* CHG-89（QA-4 乐观锁）：重新规划也是写路径——快照打开时的 revision */
          revision: detail?.revision,
          members: ownerTeam?.members ?? [],
          tasks: (pv.tasks ?? []).filter((task) => task.ownerTeamId === ownerTeamId),
        })
      }
      const openCancelDialog = (detail) => {
        const taskId = detail?.id ?? openTask?.taskId
        const ownerTeamId = openTask?.teamId
        /* CHG-75：rewire 档的候选新上游 = 同团队、排除自己、排除 cancelled/failed。
         * `done` 是合法候选（依赖已满足 → 下游立刻可领，这正是"改挂"的常见用途）；
         * `failed` 必须排除（永远不会完成，依赖它等于换一个死锁）。服务端语义为准。 */
        const upstreams = (pv.tasks ?? [])
          .filter((task) => task.ownerTeamId === ownerTeamId)
          .filter((task) => task.id !== taskId)
          .filter((task) => !['cancelled', 'failed'].includes(String(task.state ?? '')))
          .map((task) => ({ id: task.id, title: task.title ?? '', done: String(task.state ?? '') === 'done' }))
        setCancelFor({
          teamId: ownerTeamId,
          taskId,
          sessionId: openTask?.sessionId,
          title: detail?.input?.title ?? detail?.id ?? '',
          dependents: (pv.tasks ?? [])
            .filter((task) => task.ownerTeamId === ownerTeamId && (task.deps ?? []).includes(taskId))
            .map((task) => task.id),
          upstreams,
        })
      }
      const afterTaskMutation = async (message) => {
        setRescopeFor(null)
        setCancelFor(null)
        if (message) setNotice(message)
        setDetailToken((value) => value + 1)
        await loadProject(projectRoot)
      }
      const submitRescope = async (result) => {
        await afterTaskMutation(t('task.rescopeDone').replace('{id}', String(result?.taskId ?? '')).replace('{state}', stateLabel(result?.state)))
      }
      const submitCancel = async (result) => {
        const count = (result?.cancelled ?? []).length || 1
        /* CHG-75：rewire 档额外报「已改挂 N 个任务」（就地提示，不新开窗口） */
        const rewiredCount = (result?.rewired ?? []).length
        const message = rewiredCount > 0
          ? `${t('cancel.done').replace('{n}', String(count))}；${t('cancel.rewired').replace('{n}', String(rewiredCount))}`
          : t('cancel.done').replace('{n}', String(count))
        await afterTaskMutation(message)
      }
      /** CHG-76 C：诊断一键修复成功 → notice + 详情就地重载 + 看板刷新 */
      const onDiagnosisFixed = async (message) => {
        if (message) setNotice(message)
        setDetailToken((value) => value + 1)
        await loadProject(projectRoot)
      }
      /** CHG-76 B：批量新建成功 → 关抽屉 + notice + 刷新看板 */
      const onBatchCreated = async (message) => {
        setBatchCreate(false)
        if (message) setNotice(message)
        await loadProject(projectRoot)
      }
      /* CHG-73：批量编排——按主责团队分组逐个 batchTaskOp（每条事件同一 batchId 由服务端落） */
      /* 角色页（design/roles.html）：三层来源分区 + 搜索/来源筛选 + 引用计数 + 复制/对比 + 创建卡 */
      const rolesPage = js('div', { children: [
        /* CHG-91：插件贡献（只读 + 装载告警 + 重新扫描）——放在角色库顶部，
         * 因为「这个角色是谁给的」必须在用户看列表之前就有答案 */
        j(ContributionsSection, {
          t,
          api: discoveryApi,
          workspaceRoot: projectRoot,
          onNotice: setNotice,
          onChanged: () => loadProject(projectRoot),
        }),
        j(RoleLibrary, {
          t,
          pv,
          onOpen: setOpenRole,
          onGuest: guestRoleCommand,
          onCopyToProject: copyRoleToProject,
          onCompare: (role) => setOpenRole(role.id),
          onCreate: () => openRoleEditor({ mode: 'create' }),
          onIntroGlobal: () => { setScope('global'); setProjectTab('roles') },
        }),
      ] })

      /* 团队页：列表 or 团队工作台（队员/参与任务/知识/审计/设置） */
      const participatingCount = (teamId) => (pv.tasks ?? []).filter((task) => (task.participants ?? []).some((p) => p.teamId === teamId)).length
      const teamsPage = selectedTeam
        ? (() => {
          const team = selectedTeam
          /* [G4 ledger · 归档回放] —— design/archive.html：归档团队整体换归档条 + 只读回放 */
          if (team.state === 'archived') {
            const archivedTasks = (pv.tasks ?? []).filter((task) => task.ownerTeamId === team.teamId)
            const loadMoreAudit = async () => {
              if (!audit?.nextBeforeSeq) return
              const call = team.online
                ? api.getAudit({ teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
                : discoveryApi.getOfflineAudit({ workspaceRoot: projectRoot, teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
              try {
                const r = await call
                if (r?.status !== 'ok') return
                setAudit({ events: [...(audit.events ?? []), ...(r.events ?? [])], total: r.total ?? audit.total, nextBeforeSeq: r.nextBeforeSeq ?? null })
              } catch (e) { setError(String(e?.message ?? e)) }
            }
            return j(ArchiveReplay, {
              t,
              team,
              tasks: archivedTasks,
              tokens,
              audit,
              memberName,
              /* CHG-86 / P0-2：真实归档快照（拿不到时组件内降级到 board 派生） */
              archive: archiveSnap,
              archiveRoot,
              onMoreAudit: loadMoreAudit,
              onBack: closeTeam,
              onOpenAll: () => { closeTeam(); setProjectTab('teams') },
              onOpenTask: (task) => setOpenTask({ teamId: task.ownerTeamId, taskId: task.id, online: task.ownerOnline, sessionId: task.ownerSessionId }),
            })
          }
          const teamTasksAll = (pv.tasks ?? []).filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId))
          const members = team.members ?? []
          const taskTitle = (id) => (teamTasksAll.find((task) => task.id === id)?.title)
          const tabs = ['members', 'participating', 'knowledge', 'audit', 'settings']
          const tabLabel = (key) => {
            if (key === 'members') return `${t('tab.members')}（${members.length}）`
            if (key === 'participating') return `${t('team.tab.participating')}（${teamTasksAll.length}）`
            return t(`tab.${key}`)
          }
          let content
          /* [G2 roster · 名册 tab] —— 团队内「队员」tab（design/roster.html）：一张卡一个角色 + 实例行 + 召唤卡 */
          if (teamTab === 'members') {
            const active = members.filter((m) => m.status === 'active' || m.status === 'suspended')
            const inactive = members.filter((m) => m.status !== 'active' && m.status !== 'suspended')
            const roleOf = (roleId) => (pv.roles ?? []).find((role) => role.id === roleId && role.origin === 'project')
              ?? (pv.roles ?? []).find((role) => role.id === roleId)
            const groupByRole = (list) => {
              const map = new Map()
              for (const member of list) {
                const bucket = map.get(member.roleId)
                if (bucket) bucket.push(member)
                else map.set(member.roleId, [member])
              }
              return [...map.entries()]
            }
            const summon = () => { setProjectTab('roles'); setSelectedTeamId(null) }
            const maxMembers = config?.config?.limits?.maxMembers ?? 6
            const openMemberTask = (taskId) => setOpenTask({ teamId: team.teamId, taskId, online: team.online, sessionId: team.sessionId })
            content = js('div', { className: 'mt-page', children: [
              team.online ? null : j('div', { className: 'mt-note', children: t('offline.readonlyTip') }),
              js('div', { className: 'mt-page-head', children: [
                js('div', { children: [j('h2', { children: t('roster.page.title') }), j('p', { children: t('roster.page.desc') })] }),
                js('div', { className: 'mt-page-head-actions', children: [
                  j('button', { className: 'mt-btn mt-btn-primary', onClick: summon, children: `＋ ${t('roster.summon')}` }),
                ] }),
              ] }),
              js('div', { className: 'mt-note mt-note-info', children: [
                j('b', { children: t('roster.noCaptain') }),
                j('span', { children: ` — ${t('roster.noCaptainHint')}` }),
              ] }),
              active.length === 0
                ? j('div', { className: 'mt-empty', children: t('roster.empty') })
                : js('div', { className: 'mt-roster-grid', children: [
                  ...groupByRole(active).map(([roleId, list]) => j(MemberCard, {
                    key: roleId,
                    t,
                    roleId,
                    role: roleOf(roleId),
                    members: list,
                    tasks: teamTasksAll,
                    tokens,
                    teamName,
                    taskTitle,
                    readOnly: !team.online,
                    api,
                    teamId: team.teamId,
                    onOpen: openMemberTask,
                    onChanged: () => loadProject(projectRoot),
                    onError: setError,
                    onNotice: setNotice,
                  })),
                  j(RosterSummonCard, { key: 'summon', t, onSummon: summon }),
                ] }),
              inactive.length > 0 ? js('div', { className: 'mt-roster-inactive', children: [
                j('h4', { children: `${t('roster.inactive')}（${inactive.length}）` }),
                js('div', { className: 'mt-roster-grid', children: groupByRole(inactive).map(([roleId, list]) => j(MemberCard, {
                  key: `inactive-${roleId}`,
                  t,
                  roleId,
                  role: roleOf(roleId),
                  members: list,
                  tasks: teamTasksAll,
                  tokens,
                  teamName,
                  taskTitle,
                  readOnly: !team.online,
                  api,
                  teamId: team.teamId,
                  onOpen: openMemberTask,
                  onChanged: () => loadProject(projectRoot),
                  onError: setError,
                  onNotice: setNotice,
                })) }),
              ] }) : null,
              /* CHG-87 §5.3：单角色调用（/myteam+<roleId> 语法）—— 面板没有会话输入框，
               * 挂载点落在团队页（见 GuestRoleCallCard 注释）。 */
              j(GuestRoleCallCard, {
                t,
                api,
                teamId: team.teamId,
                readOnly: !team.online,
                onChanged: () => loadProject(projectRoot),
                onNotice: setNotice,
                onError: setError,
              }),
              j('p', { className: 'mt-note', children: t('roster.limitNote').replace('{n}', String(maxMembers)).replace('{active}', String(members.filter((m) => m.status === 'active' || m.status === 'suspended').length)) }),
            ] })
          /* [G2 roster · 参与任务 tab] —— 团队参与的跨团队任务（design/team-tasks.html） */
          } else if (teamTab === 'participating') {
            const leadCount = teamTasksAll.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'lead')).length
            const coopCount = teamTasksAll.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'coop')).length
            const stateChip = (state) => (state === 'done' ? 'mt-status-done'
              : state === 'failed' || state === 'cancelled' ? 'mt-status-fail'
              : String(state).startsWith('gate') || state === 'gates' ? 'mt-status-gate'
              : state === 'in_progress' || state === 'running' || state === 're-scoping' ? 'mt-status-run'
              : 'mt-status-idle')
            const PARTICIPATING_LIMIT = 8
            const filtered = teamTasksAll.filter((task) => {
              if (teamTaskFilter === 'all') return true
              const mine = (task.participants ?? []).find((p) => p.teamId === team.teamId)
              return (mine?.role ?? 'coop') === teamTaskFilter
            })
            const shown = filtered.slice(0, PARTICIPATING_LIMIT)
            const rest = filtered.slice(PARTICIPATING_LIMIT)
            content = js('div', { className: 'mt-page', children: [
              /* 任务头 + 页头（design/team-tasks.html 的 .page-head：只列本团队参与的任务与主责/协作） */
              js('div', { className: 'mt-section-head', children: [
                j('h3', { children: t('g6.teamTasks.title') }),
                j('span', { className: 'mt-rule', 'aria-hidden': true }),
                j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setOpenTask(null), children: t('g6.teamTasks.boardBtn') }),
              ] }),
              j('p', { className: 'mt-hint', children: t('g6.teamTasks.desc') }),
              /* 本队角色筛选：全部 / 主责 / 协作（实线 = 主责，虚线 = 协作） */
              js('div', { className: 'mt-filterbar', children: [
                js('div', { className: 'mt-seg', role: 'group', 'aria-label': t('g6.teamTasks.title'), children: [
                  ['all', t('g6.teamTasks.filterAll').replace('{n}', String(teamTasksAll.length))],
                  ['lead', t('g6.teamTasks.filterLead').replace('{n}', String(leadCount))],
                  ['coop', t('g6.teamTasks.filterCoop').replace('{n}', String(coopCount))],
                ].map(([key, label]) => j('button', {
                  key,
                  className: teamTaskFilter === key ? 'mt-seg mt-seg-active' : 'mt-seg',
                  'aria-pressed': teamTaskFilter === key,
                  onClick: () => setTeamTaskFilter(key),
                  children: label,
                })) }),
                j('span', { className: 'mt-filterbar-hint', children: t('g6.teamTasks.filterHint') }),
              ] }),
              teamTasksAll.length === 0
                ? j('div', { className: 'mt-empty', children: t('tasks.empty') })
                : js('div', { children: shown.map((task) => {
                  const mine = (task.participants ?? []).find((p) => p.teamId === team.teamId) ?? {}
                  const others = (task.participants ?? []).filter((p) => p.teamId !== team.teamId)
                  return js('button', {
                    key: task.key,
                    className: 'mt-trow',
                    onClick: () => setOpenTask({ teamId: task.ownerTeamId, taskId: task.id, online: task.ownerOnline, sessionId: task.ownerSessionId }),
                    children: [
                      j('span', { className: 'mt-tid', children: task.id }),
                      j('span', { className: 'mt-tt', children: task.title }),
                      j('span', {
                        /* design/team-tasks.html：主责 = 实心主色 chip，协作 = 虚线 chip */
                        className: `mt-status-chip ${mine.role === 'lead' ? 'mt-status-filled' : 'mt-status-dashed'}`,
                        children: [
                          j('span', { className: 'mt-shape', 'aria-hidden': true }),
                          j('span', { children: mine.role === 'lead' ? t('task.owner') : t('task.coop') }),
                        ],
                      }),
                      j('span', {
                        className: `mt-status-chip ${stateChip(task.state)}`,
                        children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: stateLabel(task.state) })],
                      }),
                      j('span', { className: 'mt-who', children: (task.assignees ?? []).map((id) => j('span', { key: id, className: 'mt-mini-chip mt-mini-chip-num', children: memberName(id) })) }),
                      ...others.map((p) => j('span', {
                        key: `other-${p.teamId}`,
                        className: 'mt-mini-chip mt-mini-chip-coop',
                        children: t(p.role === 'lead' ? 'g6.teamTasks.leadTeam' : 'g6.teamTasks.coopTeam').replace('{name}', teamName(p.teamId)),
                      })),
                      j('span', { className: 'mt-chev', 'aria-hidden': true, children: '›' }),
                    ],
                  })
                }) }),
              rest.length > 0
                ? js('button', {
                  className: 'mt-trow mt-trow-more',
                  onClick: () => setOpenTask(null),
                  children: [
                    j('span', { className: 'mt-tid', children: '…' }),
                    j('span', { className: 'mt-tt', children: t('g6.teamTasks.rest')
                      .replace('{n}', String(rest.length))
                      .replace('{backlog}', String(rest.filter((task) => task.state === 'backlog' || task.state === 'ready').length))
                      .replace('{done}', String(rest.filter((task) => task.state === 'done').length)) }),
                    j('span', { className: 'mt-who', children: j('span', { className: 'mt-mini-link', children: t('g6.teamTasks.gotoBoard') }) }),
                  ],
                })
                : null,
              js('p', { className: 'mt-note mt-note-info', children: [
                j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⑃' }),
                j('span', { children: t('g6.teamTasks.note') }),
              ] }),
            ] })
          /* [G3 knowledge · 知识 tab] —— design/knowledge.html */
          } else if (teamTab === 'knowledge') {
            /* 写路径（提案裁决）与只读数据面分开渲染：KnowledgeTab 的 props 契约保持
             * `{ t, data, members }`（t63-1 断言），采纳 / 驳回由 KnowledgeProposals 直通 adoptKnowledge。 */
            content = js('div', { children: [
              j(KnowledgeProposals, {
                t,
                proposals: kb?.proposals ?? [],
                members,
                api,
                teamId: team.teamId,
                readOnly: !team.online,
                onChanged: () => { setKb(undefined); loadProject(projectRoot) },
                onNotice: setNotice,
                onError: setError,
              }),
              j(KnowledgeTab, { t, data: kb, members }),
            ] })
          /* [G4 ledger · 审计 tab] —— design/audit.html */
          } else if (teamTab === 'audit') {
            content = j(AuditTab, {
              t, audit, tasks: teamTasksAll, memberName,
              filter: auditFilter,
              setFilter: setAuditFilter,
              onOpen: (taskId) => setOpenTask({ teamId: team.teamId, taskId, online: team.online, sessionId: team.sessionId }),
              onMore: async () => {
                if (!audit?.nextBeforeSeq) return
                const pending = team.online
                  ? api.getAudit({ teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
                  : discoveryApi.getOfflineAudit({ workspaceRoot: projectRoot, teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
                try {
                  const r = await pending
                  if (r?.status !== 'ok') return
                  setAudit({ events: [...(audit.events ?? []), ...(r.events ?? [])], total: r.total ?? audit.total, nextBeforeSeq: r.nextBeforeSeq ?? null })
                } catch (e) { setError(String(e?.message ?? e)) }
              },
            })
          /* [G4 ledger · 设置 tab] —— design/settings.html */
          } else {
            content = j(SettingsTab, {
              t,
              config: config ?? undefined,
              offline: !team.online,
              team,
              connection,
              onDisbanded: () => { closeTeam(); loadProject(projectRoot) },
            })
          }
          const askDisband = async () => {
            if (!team.online) return
            try {
              const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: false })
              if (r?.status === 'confirm-required') setDisband({ impact: r.impact ?? {} })
            } catch (e) { setError(String(e?.message ?? e)) }
          }
          const doDisband = async () => {
            if (!team.online || disbandBusy) return
            setDisbandBusy(true)
            try {
              const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: true })
              if (r?.ok === false || r?.status === 'error') { setError(r?.message ?? 'disband failed'); return }
              setDisband(null)
              closeTeam()
              await loadProject(projectRoot)
            } catch (e) { setError(String(e?.message ?? e)) } finally { setDisbandBusy(false) }
          }
          return js('div', { className: 'mt-panel', ...themeAttr, children: [
            js('div', { className: 'mt-topbar', children: [
              j('button', { className: 'mt-btn', onClick: closeTeam, children: t('team.backList') }),
              j('strong', { className: 'mt-title', children: team.name || team.teamId }),
              team.name && team.name !== team.teamId ? j('span', { className: 'mt-hint', children: team.teamId }) : null,
              team.goal ? j('span', { className: 'mt-goal', children: team.goal }) : null,
              j('span', { className: 'mt-chip', children: `${stateShape(team.state)} ${stateLabel(team.state)}` }),
              team.online ? null : j('span', { className: 'mt-chip mt-chip-offline', children: t('global.offline') }),
              j('span', { className: 'mt-hint', children: `${t('global.counts').replace('{done}', String(team.counts?.done ?? 0)).replace('{total}', String(team.counts?.tasks ?? 0))} · ${t('global.running').replace('{n}', String(team.counts?.running ?? 0))}` }),
              team.online ? j('button', { className: 'mt-btn mt-btn-danger', onClick: askDisband, children: t('action.disband') }) : null,
            ] }),
            /* CHG-82 G1：解散改走 design/confirm.html 的两段确认（四条不可撤销影响 + 输入 teamId 才可提交） */
            disband ? j(DisbandDialog, {
              t,
              teamId: team.teamId,
              teamName: team.name || team.teamId,
              impact: disband.impact,
              busy: disbandBusy,
              error: null,
              onConfirm: doDisband,
              onClose: () => setDisband(null),
            }) : null,
            team.online ? j(StagedBanner, { api: makeApi(connection, team.sessionId), t, teamId: team.teamId, inbox, onAct: () => loadProject(projectRoot) }) : null,
            js('div', { className: 'mt-tabs', role: 'tablist', children: tabs.map((key) => j('button', {
              key,
              className: teamTab === key ? 'mt-tab mt-tab-active' : 'mt-tab',
              role: 'tab',
              'aria-selected': teamTab === key,
              onClick: () => setTeamTab(key),
              children: tabLabel(key),
            })) }),
            js('div', { className: 'mt-workspace', children: [content, openTask ? j(TaskDetail, {
              api: makeApi(connection, openTask.sessionId),
              t,
              teamId: openTask.teamId,
              taskId: openTask.taskId,
              readOnly: !openTask.online,
              memberName,
              teamName,
              /* CHG-86：门禁裁决的审查人下拉需要名册（离线团队 getBoard 不可用） */
              members,
              refreshToken: detailToken,
              loader: openTask.online ? undefined : (q) => discoveryApi.getOfflineTaskDetail({ ...q, workspaceRoot: projectRoot }),
              onRescope: openTask.online ? openRescopeDialog : undefined,
              onCancel: openTask.online ? openCancelDialog : undefined,
              onDiagnosisFixed,
              onEdit: openTask.online ? (detail) => openTaskEditor({
                mode: 'edit',
                task: {
                  id: detail.id,
                  ownerTeamId: openTask.teamId,
                  ownerOnline: true,
                  ownerSessionId: openTask.sessionId,
                  state: detail.state,
                  /* CHG-89（QA-4 乐观锁）：打开表单时快照 revision，保存时作为
                   * expectedRevision 回传——服务端不等即 MT_REVISION_CONFLICT（账本零写入）。 */
                  revision: detail.revision,
                  input: detail.input,
                  assignees: detail.assignees,
                  participants: detail.participants,
                },
              }) : undefined,
              onClose: () => setOpenTask(null),
            }) : null] }),
            j(CostBar, { t, tokens, onOpen: () => setShowCost(true) }),
          ] })
        })()
        : j(TeamsHome, {
          t,
          teams: pv.teams ?? [],
          tasks: pv.tasks ?? [],
          workspaceRoot: projectRoot,
          gateOf: (teamId) => (pv.tasks ?? []).filter((task) => task.ownerTeamId === teamId && String(task.state).startsWith('gate:')).length,
          onOpen: openTeam,
          onCreateTeam: openTeamCreator,
        })

      /* 任务页：左参与团队轨 + 视图条 + 四视图 + 详情抽屉 */
      const allProjectTasks = pv.tasks ?? []
      const matches = (task) => {
        if (railTeam !== 'all' && !(task.participants ?? []).some((p) => p.teamId === railTeam)) return false
        if (taskPrio !== 'all' && String(task.priority) !== taskPrio) return false
        if (taskMember !== 'all') {
          const ids = task.assignees ?? (task.assignee ? [task.assignee] : [])
          if (!ids.includes(taskMember)) return false
        }
        const needle = taskQuery.trim().toLowerCase()
        if (!needle) return true
        const hay = [task.id, task.title, task.key, ...(task.deps ?? []), ...(task.participants ?? []).map((p) => p.teamId)].join(' ').toLowerCase()
        return hay.includes(needle)
      }
      const shownTasks = allProjectTasks.filter(matches)
      const filtersActive = Boolean(taskQuery.trim()) || taskPrio !== 'all' || taskMember !== 'all' || railTeam !== 'all'
      /* CHG-73：批量编排——按主责团队分组逐个 batchTaskOp（同一 op 的多团队选择也能一次跑完） */
      const selectedTasks = shownTasks.filter((task) => selected.has(task.key))
      const runBatch = async (op, extra, confirmed) => {
        const groups = new Map()
        for (const task of selectedTasks) {
          const bucket = groups.get(task.ownerTeamId)
          if (bucket) bucket.push(task)
          else groups.set(task.ownerTeamId, [task])
        }
        const results = []
        const impacts = []
        for (const [teamId, list] of groups) {
          const team = (pv.teams ?? []).find((item) => item.teamId === teamId)
          if (!team?.online || !team?.sessionId) {
            results.push({ taskId: list[0]?.id ?? '—', ok: false, code: 'MT_OFFLINE', message: t('batch.offlineSkipped') })
            continue
          }
          const query = { teamId, op, taskIds: list.map((task) => task.id) }
          if (extra?.reason) query.reason = extra.reason
          /* CHG-73：批量取消下游策略（leave 默认 / cancel 级联），与影响面预览同一档 */
          if (op === 'cancel' && extra?.downstream) query.downstream = extra.downstream
          /* CHG-76 A：rewire 档带统一新上游（缺省 = 解除依赖） */
          if (op === 'cancel' && extra?.rewireTo) query.rewireTo = extra.rewireTo
          if (op === 'assign') {
            const own = new Set((team.members ?? []).map((member) => member.id))
            const memberIds = (extra?.memberIds ?? []).filter((id) => own.has(id))
            if (memberIds.length === 0) {
              results.push({ taskId: list[0]?.id ?? '—', ok: false, code: 'MT_VALIDATION', message: t('batch.assignTeamEmpty') })
              continue
            }
            query.memberIds = memberIds
          }
          if (op === 'priority') query.priority = extra?.priority
          if (confirmed) query.confirm = true
          try {
            const r = await makeApi(connection, team.sessionId).batchTaskOp(query)
            if (r?.status === 'confirm-required') { impacts.push({ teamId, impact: r.impact ?? {} }); continue }
            if (r?.status === 'error') { results.push({ taskId: list[0]?.id ?? '—', ok: false, code: r.code, message: r.message }); continue }
            results.push(...(r?.results ?? []))
          } catch (e) {
            results.push({ taskId: list[0]?.id ?? '—', ok: false, message: String(e?.message ?? e) })
          }
        }
        if (impacts.length > 0) return { kind: 'confirm', impacts }
        const ok = results.filter((item) => item.ok).length
        /* CHG-76 A：把逐条 results 带回（afterBatch 要汇总 results[].rewired 报「已改挂 N 个任务」） */
        return { kind: 'done', ok, failed: results.length - ok, results }
      }
      const afterBatch = async (result) => {
        await loadProject(projectRoot)
        const results = result?.results ?? []
        /* CHG-76 A：已改挂 = results.flatMap(r => r.rewired ?? []).length（added 缺省 = 解除依赖，同样计数） */
        const rewiredCount = results.flatMap((item) => (Array.isArray(item?.rewired) ? item.rewired : [])).length
        const base = t('batch.done').replace('{ok}', String(result?.ok ?? 0)).replace('{failed}', String(result?.failed ?? 0))
        const withRewired = rewiredCount > 0 ? `${base} · ${t('batch.rewiredDone').replace('{n}', String(rewiredCount))}` : base
        /* 失败条目把服务端 message 原样带出来（如整批拒绝的 MT_VALIDATION「这一批…」/ 逐条 MT_TASK_CYCLE） */
        const failureNotes = [...new Set(results
          .filter((item) => item && item.ok === false)
          .map((item) => String(item.message ?? item.code ?? ''))
          .filter(Boolean))].slice(0, 2)
        setNotice(failureNotes.length > 0 ? `${withRewired} · ${t('batch.failedItems').replace('{items}', failureNotes.join('；'))}` : withRewired)
        exitSelect()
      }
      /* design/lanes.html 的 .trail：参与团队轨（行首头像 + 名称 + 参与统计） */
      const railItem = (key, name, meta, avatar, pressed) => js('button', {
        key,
        className: 'mt-teamrail-item mt-titem',
        'aria-pressed': pressed ? 'true' : 'false',
        title: meta,
        onClick: () => setRailTeam(key),
        children: [
          j('span', { className: 'mt-tav', 'aria-hidden': true, children: avatar }),
          js('span', { className: 'mt-tinfo', children: [
            j('b', { children: name }),
            j('span', { children: meta }),
          ] }),
        ],
      })
      const rail = js('aside', { className: 'mt-teamrail mt-trail', 'aria-label': t('tasks.rail'), children: [
        j('span', { className: 'mt-teamrail-head mt-trail-cap', children: t('tasks.rail') }),
        railItem('all', t('tasks.railAll'), `${allProjectTasks.length} 个任务`, '全', railTeam === 'all'),
        ...(pv.teams ?? []).map((team) => {
          const lead = allProjectTasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'lead')).length
          const coop = allProjectTasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'coop')).length
          const name = team.name || team.teamId
          return railItem(team.teamId, name, `${t('task.owner')} ${lead} · ${t('task.coop')} ${coop}`, String(name).trim().slice(0, 1), railTeam === team.teamId)
        }),
      ] })

      const openTaskOf = (task) => setOpenTask({ teamId: task.ownerTeamId, taskId: task.id, online: task.ownerOnline, sessionId: task.ownerSessionId })

      /* CHG-82：拖拽流转（design/dragging.html）—— 落点由状态机判定；非法落点抖动 + 弹回 + 左下角回执 */
      /** attempt 失效（门禁未过 / 已取消）的卡锁住不可拖 */
      const dragLocked = (task) => Boolean(task?.evidenceStale || task?.cancelled)
      /** 状态机允许的落点：门禁 → 完成要求门禁已过（超时过的卡 = 门禁未过） */
      const canDropOn = (task, colName) => {
        if (!task) return false
        if (!(DRAG_LEGAL_TARGETS[projectColumnOf(task.state)] ?? []).includes(colName)) return false
        if (colName === '已完成' && (task.escalateCount ?? 0) > 0) return false
        return true
      }
      const startDrag = (event, task) => {
        if (dragLocked(task)) { event?.preventDefault?.(); return }
        setDragToast(null)
        setDragTask({ key: task.key, code: task.id, title: task.title, from: projectColumnOf(task.state), over: null })
      }
      const dragOverCol = (event, colName) => {
        if (!dragTask) return
        event?.preventDefault?.()
        if (dragTask.over !== colName) setDragTask({ ...dragTask, over: colName })
      }
      const dropOnCol = (event, colName) => {
        if (!dragTask) return
        event?.preventDefault?.()
        const task = allProjectTasks.find((item) => item.key === dragTask.key)
        if (task && canDropOn(task, colName)) {
          setNotice(t('drag.accepted').replace('{code}', String(task.id)).replace('{col}', colName))
          setDragToast(null)
        } else {
          /* 非法落点：抖动 + 弹回 150ms（reduced-motion 下只闪边框），并给左下角回执 */
          setDragToast({ code: dragTask.code, col: colName, timeouts: task?.escalateCount ?? 0 })
          setDragShake(dragTask.key)
          setTimeout(() => setDragShake(null), 220)
        }
        setDragTask(null)
      }
      const endDrag = () => setDragTask(null)
      const dragPropsOf = (task) => ({ locked: dragLocked(task), shake: dragShake === task.key, onDragStart: startDrag, onDragEnd: endDrag })
      const draggedTask = dragTask ? allProjectTasks.find((item) => item.key === dragTask.key) : null
      const runningCodes = shownTasks.filter((task) => task.state === 'in_progress' || task.state === 're-scoping').map((task) => task.id)
      /** 拖起的卡悬在「进行中 → 门禁」交界的空中（design/dragging.html 的 .tcard.lift） */
      const liftCard = draggedTask ? js('div', {
        className: 'mt-task mt-task-lift',
        'aria-grabbed': 'true',
        children: [
          j('span', { className: 'mt-lift-tag', children: t('drag.liftTag') }),
          js('span', { className: 'mt-task-top', children: [
            j('span', { className: 'mt-task-id', children: draggedTask.id }),
            draggedTask.priority ? j('span', { className: `mt-pri mt-pri-${draggedTask.priority}`, children: draggedTask.priority }) : null,
          ] }),
          j('span', { className: 'mt-task-title-text', children: draggedTask.title }),
          js('span', { className: 'mt-task-meta', children: [
            j('span', { className: 'mt-rolechip', children: (draggedTask.assignees ?? []).slice(0, 2).map((id) => memberName(id)).join(' · ') || stateLabel(draggedTask.state) }),
            j('span', { className: 'mt-hint', children: `${stateLabel(draggedTask.state)} · ${projectColumnOf(draggedTask.state)}` }),
          ] }),
          draggedTask.model ? j('span', { className: 'mt-task-meta', children: j('span', { className: 'mt-task-model', children: draggedTask.model }) }) : null,
        ],
      }) : null

      let tasksContent
      if (taskView === 'board') {
        tasksContent = js('div', { className: 'mt-board', children: [
          liftCard,
          js('div', { className: 'mt-columns', children: PROJECT_COLUMNS.map((col) => {
            const list = shownTasks.filter((task) => projectColumnOf(task.state) === col.name && task.key !== dragTask?.key)
            const over = dragTask?.over === col.name
            const legal = Boolean(over && draggedTask && canDropOn(draggedTask, col.name))
            const source = Boolean(dragTask) && dragTask.from === col.name
            return js('div', {
              key: col.name,
              className: 'mt-col' + (col.done ? ' mt-col-done' : '') + (over ? (legal ? ' mt-col-drop' : ' mt-col-nodrop') : ''),
              onDragOver: (event) => dragOverCol(event, col.name),
              onDrop: (event) => dropOnCol(event, col.name),
              children: [
                js('div', { className: 'mt-col-head', children: [
                  j('span', { className: 'mt-col-shape', 'aria-hidden': true }),
                  j('h4', { className: 'mt-col-name', children: col.name }),
                  j('span', { className: 'mt-count', children: list.length }),
                  /* design/board.html 的 .col-head .add：列内直达新建 */
                  j('button', {
                    className: 'mt-col-add',
                    title: t('board.addToCol').replace('{col}', col.name),
                    onClick: () => {
                      const teams = pv.teams ?? []
                      const first = teams.find((team) => team.online && team.state === 'active' && (team.members ?? []).length > 0)
                        ?? teams.find((team) => team.online && team.state === 'active')
                        ?? teams.find((team) => team.online)
                      openTaskEditor({ mode: 'create', defaultTeamId: first?.teamId ?? '' })
                    },
                    children: '＋',
                  }),
                ] }),
                /* design/dragging.html 的 .dropzone：合法落点给「释放移入 · 进入后走 审查 → 命令验证 → 存档」 */
                legal ? js('div', { className: 'mt-dropzone', children: [
                  j('svg', {
                    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                    children: j('path', { d: 'M3 8.4 6.4 11.8 13 5.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                  }),
                  j('span', { children: t('drag.dropzone') }),
                ] }) : null,
                js('div', { className: 'mt-col-body', children: [
                  ...list.map((task) => j(TaskCard, {
                    key: task.key,
                    task,
                    t,
                    teamName,
                    memberName,
                    showTeamName: new Set(shownTasks.map((item) => item.ownerTeamId)).size > 1,
                    onOpen: () => openTaskOf(task),
                    selectable: selectMode,
                    selected: selected.has(task.key),
                    onToggle: toggleSelected,
                    drag: dragPropsOf(task),
                  })),
                  /* 源列留虚线幽灵占位「t6 正被拖动」 */
                  source ? j('div', { className: 'mt-task mt-task-ghost', children: t('drag.ghost').replace('{code}', dragTask.code) }) : null,
                  list.length === 0 && !source ? j('div', { className: 'mt-col-empty', children: t('board.emptyCol') }) : null,
                ] }),
              ],
            })
          }) }),
        ] })
      } else if (taskView === 'list') {
        /* 项目级任务列表（design/tasks.html）：任务头 + 汇总条 + 按团队分组任务行 + 视图条 */
        /** design/tasks.html：每个团队组只列 6 行，其余收成「… 其余在看板」 */
        const TASK_GROUP_LIMIT = 6
        const stateChipClass = (state) => (state === 'done' ? 'mt-status-done'
          : state === 'failed' || state === 'cancelled' ? 'mt-status-fail'
          : String(state).startsWith('gate') || state === 'gates' ? 'mt-status-gate'
          : state === 'in_progress' || state === 'running' || state === 're-scoping' ? 'mt-status-run'
          : 'mt-status-idle')
        const teamGroups = (pv.teams ?? [])
          .map((team) => ({ team, tasks: shownTasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId)) }))
          .filter((group) => group.tasks.length > 0)
        const orphanTasks = shownTasks.filter((task) => (task.participants ?? []).length === 0)
        const taskRow = (task) => js('button', {
          key: task.key,
          className: 'mt-trow' + (selectMode && selected.has(task.key) ? ' mt-trow-selected' : ''),
          'aria-pressed': selectMode ? selected.has(task.key) : undefined,
          onClick: () => (selectMode ? toggleSelected(task) : openTaskOf(task)),
          children: [
            selectMode
              ? j('span', { className: 'mt-flow-check', 'aria-hidden': true, children: selected.has(task.key) ? '✓' : '' })
              : j('span', { className: 'mt-tid', children: task.id }),
            j('span', { className: 'mt-tt', children: task.title }),
            ...(task.participants ?? []).map((p) => j('span', {
              key: `p-${p.teamId}`,
              className: p.role === 'lead' ? 'mt-mini-chip mt-mini-chip-team' : 'mt-mini-chip mt-mini-chip-coop',
              children: p.role === 'lead'
                ? `${teamName(p.teamId)} · ${t('task.owner')}`
                : `${t('task.coop')} · ${teamName(p.teamId)}`,
            })),
            j('span', {
              className: `mt-status-chip ${stateChipClass(task.state)}`,
              children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: stateLabel(task.state) })],
            }),
            task.evidenceStale ? j('span', {
              className: 'mt-status-chip mt-status-gate',
              title: t('board.staleTitle').replace('{fields}', fieldListText(t, task.evidenceStale.fields)).replace('{time}', fmtClock(task.evidenceStale.since)),
              children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: t('board.evidenceStale') })],
            }) : null,
            task.cancelled ? j('span', {
              className: 'mt-status-chip mt-status-fail',
              title: t('board.cancelledTitle').replace('{reason}', task.cancelled.reason || '—'),
              children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: t('board.cancelled') })],
            }) : null,
            j(DiagChips, { t, diagnosis: task.diagnosis }),
            j('span', { className: 'mt-who', children: (task.assignees ?? []).map((id) => j('span', { key: id, className: 'mt-mini-chip mt-mini-chip-num', children: memberName(id) })) }),
            j('span', { className: 'mt-chev', 'aria-hidden': true, children: '›' }),
          ],
        })
        const runningCount = shownTasks.filter((task) => task.state === 'in_progress' || task.state === 're-scoping' || task.state === 'running').length
        const gateCount = shownTasks.filter((task) => String(task.state).startsWith('gate') || task.state === 'gates').length
        const doneCount = shownTasks.filter((task) => task.state === 'done').length
        const leadTotal = shownTasks.flatMap((task) => task.participants ?? []).filter((p) => p.role === 'lead').length
        const coopTotal = shownTasks.flatMap((task) => task.participants ?? []).filter((p) => p.role === 'coop').length
        const draftTeam = (pv.teams ?? []).find((team) => team.state === 'draft' && !teamGroups.some((group) => group.team.teamId === team.teamId))
        tasksContent = js('div', { className: 'mt-page', children: [
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('g6.tasks.pageTitle') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setTaskView('board'), children: t('g6.tasks.boardView') }),
          ] }),
          j('p', { className: 'mt-hint', children: t('g6.tasks.pageDesc') }),
          /* 汇总条：任务 / 参与关系 / 进行中 / 门禁待审 / 已完成 */
          js('div', { className: 'mt-summary', children: [
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(shownTasks.length) }), j('span', { children: t('g6.tasks.summaryTasks') })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(leadTotal + coopTotal) }), j('span', { children: t('g6.tasks.summaryLinks').replace('{lead}', String(leadTotal)).replace('{coop}', String(coopTotal)) })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(runningCount) }), j('span', { children: t('g6.tasks.summaryRunning') })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(gateCount) }), j('span', { children: t('g6.tasks.summaryGates') })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(doneCount) }), j('span', { children: t('g6.tasks.summaryDone') })] }),
            j('span', { className: 'mt-summary-note', children: t('g6.tasks.stageNote') }),
          ] }),
          /* 按团队筛选 seg（全部 / 各团队 n） */
          teamGroups.length > 1 ? js('div', { className: 'mt-filterbar', children: [
            js('div', { className: 'mt-seg', role: 'group', 'aria-label': t('tasks.rail'), children: [
              j('button', { className: railTeam === 'all' ? 'mt-seg mt-seg-active' : 'mt-seg', 'aria-pressed': railTeam === 'all', onClick: () => setRailTeam('all'), children: t('g6.tasks.filterAll').replace('{n}', String(shownTasks.length)) }),
              ...teamGroups.map((group) => j('button', {
                key: group.team.teamId,
                className: railTeam === group.team.teamId ? 'mt-seg mt-seg-active' : 'mt-seg',
                'aria-pressed': railTeam === group.team.teamId,
                onClick: () => setRailTeam(group.team.teamId),
                children: `${group.team.name || group.team.teamId} ${group.tasks.length}`,
              })),
            ] }),
          ] }) : null,
          teamGroups.length === 0 && orphanTasks.length === 0
            ? j('div', { className: 'mt-empty', children: t('tasks.empty') })
            : null,
          ...teamGroups.map((group) => js('div', { key: `group-${group.team.teamId}`, children: [
            js('div', { className: 'mt-dsec-head', children: [
              j('h4', { children: group.team.name || group.team.teamId }),
              j('span', { className: 'mt-line', 'aria-hidden': true }),
              j('span', {
                className: 'mt-n',
                children: t('g6.tasks.groupMeta')
                  .replace('{id}', group.team.teamId)
                  .replace('{state}', stateLabel(group.team.state ?? 'active'))
                  .replace('{lead}', String(group.tasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === group.team.teamId && p.role === 'lead')).length))
                  .replace('{coop}', String(group.tasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === group.team.teamId && p.role === 'coop')).length)),
              }),
              j('button', { className: 'mt-mini-link', onClick: () => setTaskView('board'), children: t('g6.tasks.boardLink') }),
            ] }),
            ...group.tasks.slice(0, TASK_GROUP_LIMIT).map(taskRow),
            /* design/tasks.html：每组只列前几行 + 一条虚线「… 其余在看板」行（完整清单去看板/其他视图） */
            group.tasks.length > TASK_GROUP_LIMIT
              ? js('button', {
                className: 'mt-trow mt-trow-more',
                onClick: () => setTaskView('board'),
                children: [
                  j('span', { className: 'mt-tid', children: '…' }),
                  j('span', {
                    className: 'mt-tt',
                    children: t('g6.tasks.restInBoard')
                      .replace('{backlog}', String(group.tasks.slice(TASK_GROUP_LIMIT).filter((task) => task.state === 'backlog' || task.state === 'ready').length))
                      .replace('{done}', String(group.tasks.slice(TASK_GROUP_LIMIT).filter((task) => task.state === 'done').length)),
                  }),
                  j('span', { className: 'mt-who', children: j('span', { className: 'mt-mini-link', children: t('g6.tasks.boardLink') }) }),
                ],
              })
              : null,
          ] })),
          orphanTasks.length > 0 ? js('div', { children: [
            js('div', { className: 'mt-dsec-head', children: [
              j('h4', { children: t('tasks.railAll') }),
              j('span', { className: 'mt-line', 'aria-hidden': true }),
              j('span', { className: 'mt-n', children: t('g6.tasks.draftEmpty') }),
            ] }),
            ...orphanTasks.map(taskRow),
          ] }) : null,
          draftTeam ? js('p', { className: 'mt-note mt-note-info', children: [
            j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '◷' }),
            j('span', { children: t('g6.tasks.draftNote') }),
          ] }) : null,
        ] })
      } else if (taskView === 'lanes') {
        const laneMembers = (pv.teams ?? []).flatMap((team) => (team.members ?? []).map((member) => ({ ...member, teamId: team.teamId })))
        tasksContent = j(LanesView, { t, tasks: shownTasks, members: laneMembers, onOpen: (task) => openTaskOf(task) })
      } else {
        tasksContent = j(DagView, { t, tasks: toGraphTasks(shownTasks), onOpen: (id) => {
          const task = shownTasks.find((item) => item.key === id)
          if (task) openTaskOf(task)
        }, memberName, teamName, dir: dagDir })
      }

      const tasksPage = js('div', { className: 'mt-workbench', children: [
        /* design/tasks.html 的任务头（.teambar）：任务 + 数量 / 团队参与数 + 一句话说明 + 阶段统计 + 操作 */
        js('div', { className: 'mt-taskhead', children: [
          js('span', { className: 'mt-taskhead-title', children: [
            j('b', { children: t('g6.tasks.headTitle') }),
            j('span', {
              className: 'mt-taskhead-meta',
              children: t('g6.tasks.headMeta')
                .replace('{n}', String(allProjectTasks.length))
                .replace('{m}', String(new Set(allProjectTasks.flatMap((task) => (task.participants ?? []).map((p) => p.teamId))).size)),
            }),
          ] }),
          j('span', { className: 'mt-taskhead-goal', children: t('g6.tasks.headGoal') }),
          j('span', {
            className: 'mt-taskhead-stats',
            children: [
              `${t('g6.tasks.summaryRunning')} ${allProjectTasks.filter((task) => task.state === 'in_progress' || task.state === 're-scoping' || task.state === 'running').length}`,
              `${t('g6.tasks.summaryGates')} ${allProjectTasks.filter((task) => String(task.state).startsWith('gate') || task.state === 'gates').length}`,
              `${t('g6.tasks.summaryDone')} ${allProjectTasks.filter((task) => task.state === 'done').length}`,
            ].join(' · '),
          }),
          js('span', { className: 'mt-taskhead-actions', children: [
            j('button', {
              className: 'mt-btn mt-btn-primary mt-btn-sm',
              disabled: (pv.teams ?? []).filter((team) => team.online).length === 0,
              title: (pv.teams ?? []).some((team) => team.online) ? t('task.formTitleNew') : t('task.needOnline'),
              onClick: () => {
                const teams = pv.teams ?? []
                const first = teams.find((team) => team.online && team.state === 'active' && (team.members ?? []).length > 0)
                  ?? teams.find((team) => team.online && team.state === 'active')
                  ?? teams.find((team) => team.online)
                openTaskEditor({ mode: 'create', defaultTeamId: first?.teamId ?? '' })
              },
              children: t('task.new'),
            }),
            j('button', {
              className: 'mt-btn mt-btn-sm',
              disabled: (pv.teams ?? []).filter((team) => team.online && team.sessionId).length === 0,
              title: (pv.teams ?? []).some((team) => team.online && team.sessionId) ? t('batchCreate.title') : t('batchCreate.offline'),
              onClick: () => openBatchCreator(),
              children: t('tasks.newBatch'),
            }),
          ] }),
        ] }),
        js('div', { className: 'mt-viewbar', children: [
          /* CHG-84：新建任务 / 批量新建 已在任务头（.mt-taskhead-actions）里，视图条不再重复 */
          j('span', { className: 'mt-viewbar-hint', children: t('view.label') }),
          /* design/tasks.html 的 .viewbar .vlinks：列表 / 看板 / 流程 / 依赖图（保留 mt-seg 供既有交互脚本与样式复用） */
          js('div', { className: 'mt-viewlinks', role: 'group', 'aria-label': t('view.label'), children: [
            ...['list', 'board', 'lanes', 'dag'].map((key) => j('button', {
              key,
              className: taskView === key ? 'mt-seg mt-seg-active mt-vlink mt-vlink-on' : 'mt-seg mt-vlink',
              'aria-pressed': taskView === key,
              onClick: () => setTaskView(key),
              children: key === 'list' ? t('g6.tasks.viewList')
                : key === 'board' ? t('g6.tasks.viewBoard')
                : key === 'lanes' ? t('g6.tasks.viewFlow') : t('g6.tasks.viewDag'),
            })),
          ] }),
          /* design/dag.html · dag-vertical.html：视图条右上「方向」seg 两版互链 + 显示模型 + 已高亮依赖链 */
          taskView === 'dag' ? js('span', { className: 'mt-viewbar-dir', children: [
            j('span', { className: 'mt-filterlabel', children: t('view.dir') }),
            j('button', {
              className: dagDir === 'h' ? 'mt-switch-btn mt-switch-active' : 'mt-switch-btn',
              'aria-pressed': dagDir === 'h',
              onClick: () => setDagDir('h'),
              children: t('view.dir.arrow.h'),
            }),
            j('button', {
              className: dagDir === 'v' ? 'mt-switch-btn mt-switch-active' : 'mt-switch-btn',
              'aria-pressed': dagDir === 'v',
              onClick: () => setDagDir('v'),
              children: t('view.dir.arrow.v'),
            }),
            j('span', {
              className: 'mt-chip',
              title: t('dag.showModelHint'),
              children: [
                j('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true, children: j('circle', { cx: 5, cy: 5, r: 3, fill: 'currentColor' }) }),
                j('span', { children: t('dag.showModel') }),
              ],
            }),
            j('span', {
              className: 'mt-chip mt-chip-gate',
              title: t('dag.hotChainHint'),
              children: [
                j('svg', {
                  width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                  children: [
                    j('path', { d: 'M6.4 9.6 9.6 6.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
                    j('path', { d: 'M7.4 5.2 8.6 4a2.6 2.6 0 0 1 3.7 3.7l-1.2 1.2M8.6 10.8 7.4 12a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
                  ],
                }),
                j('span', { children: runningCodes.length > 0 ? t('dag.hotChain').replace('{ids}', runningCodes.join(' / ')) : t('dag.hotChainEmpty') }),
              ],
            }),
          ] }) : null,
          /* design/lanes.html：行 = 角色（分行方式由设置页 pipeline.swimlaneBy 决定） */
          taskView === 'lanes' ? js('span', { className: 'mt-viewbar-right', children: [
            j('span', { className: 'mt-chip', children: t('lanes.groupBy') }),
            j('button', { className: 'mt-btn mt-btn-sm', title: t('lanes.byStageHint'), onClick: () => setNotice(t('lanes.byStageHint')), children: t('lanes.byStage') }),
            j('button', { className: 'mt-btn mt-btn-sm', title: t('lanes.byStageHint'), onClick: () => setNotice(t('lanes.byStageHint')), children: t('lanes.byPriority') }),
          ] }) : null,
          j('input', {
            className: 'mt-search mt-search-sm',
            value: taskQuery,
            /* design/tasks.html 的搜索框文案：任务号 / 标题 / 团队 */
            placeholder: t('g6.tasks.searchPlaceholder'),
            'aria-label': t('g6.tasks.searchPlaceholder'),
            onChange: (e) => setTaskQuery(e.target.value),
          }),
          j('span', { className: 'mt-filterlabel', children: t('filter.priority') }),
          js('select', {
            className: 'mt-select',
            value: taskPrio,
            'aria-label': t('filter.priority'),
            title: t('filter.priority'),
            onChange: (e) => setTaskPrio(e.target.value),
            children: [['all', t('filter.all')], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']]
              .map(([value, label]) => j('option', { key: value, value, children: label })),
          }),
          j('span', { className: 'mt-filterlabel', children: t('filter.member') }),
          js('select', {
            className: 'mt-select',
            value: taskMember,
            'aria-label': t('filter.member'),
            title: t('filter.member'),
            onChange: (e) => setTaskMember(e.target.value),
            children: [
              j('option', { key: 'all', value: 'all', children: t('filter.all') }),
              ...teamList.flatMap((team) => (team.members ?? []).map((m) => j('option', { key: m.id, value: m.id, children: m.instanceName }))),
            ],
          }),
          filtersActive ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => { setTaskQuery(''); setTaskPrio('all'); setTaskMember('all'); setRailTeam('all') }, children: t('filter.clear') }) : null,
          filtersActive ? j('span', { className: 'mt-hint', children: t('filter.showing').replace('{n}', String(shownTasks.length)).replace('{total}', String(allProjectTasks.length)) }) : null,
          /* CHG-73：多选模式（卡片/列表复选框 + 全选/反选 → 底部批量操作条） */
          j('button', {
            className: selectMode ? 'mt-chipbtn mt-chipbtn-active' : 'mt-chipbtn',
            'aria-pressed': selectMode,
            title: selectMode ? t('multi.off') : t('multi.hint'),
            onClick: () => (selectMode ? exitSelect() : setSelectMode(true)),
            children: selectMode ? t('multi.off') : t('multi.on'),
          }),
          selectMode ? js('span', { className: 'mt-batchbar-group', children: [
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setSelected(new Set(shownTasks.map((task) => task.key))), children: t('multi.all') }),
            j('button', {
              className: 'mt-btn mt-btn-sm',
              onClick: () => setSelected(new Set(shownTasks.filter((task) => !selected.has(task.key)).map((task) => task.key))),
              children: t('multi.invert'),
            }),
            j('span', { className: 'mt-hint', children: t('multi.count').replace('{n}', String(selectedTasks.length)) }),
          ] }) : null,
          /* CHG-85：拖拽规则说明。design/dragging.html 把它当 mini-chip 放在 viewbar 里，
             但文案是开发调试串（dragRules: state-machine）—— 换成人能读的说法；
             且只在该屏（看板视图）出现，其余视图不该常驻。 */
          taskView === 'board' ? j('button', {
            className: showRules ? 'mt-chipbtn mt-chipbtn-active' : 'mt-chipbtn',
            'aria-expanded': showRules,
            title: t('drag.rulesTitle'),
            onClick: () => setShowRules(!showRules),
            children: t('drag.rulesBadge'),
          }) : null,
        ] }),
        showRules ? js('div', { className: 'mt-rules', role: 'note', children: [
          j('strong', { children: t('rules.title') }),
          j('span', { children: t('rules.body') }),
        ] }) : null,
        js('div', { className: 'mt-body', children: [
          /* 列表视图用「按团队筛选」seg 取代参与团队轨（design/tasks.html 无左轨） */
          taskView === 'list' ? null : rail,
          js('div', { className: 'mt-view', children: [tasksContent] }),
        ] }),
        /* design/dragging.html：左下角拖拽回执（被拒案例：gate 未过的卡进不了已完成） */
        dragToast ? js('div', { className: 'mt-dragtoast', role: 'status', children: [
          j('svg', {
            width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: 'mt-lock-icon',
            children: [
              j('path', { d: 'M8 2.2 13.4 5v6L8 13.8 2.6 11V5z', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
              j('path', { d: 'M8 7.2v3.2M8 5.4v.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
            ],
          }),
          js('div', { children: [
            j('b', { children: t('drag.rejectedTitle').replace('{code}', String(dragToast.code)).replace('{col}', String(dragToast.col)) }),
            j('p', { children: t('drag.rejectedBody').replace('{n}', String(dragToast.timeouts ?? 0)) }),
            j('button', { className: 'mt-link', onClick: () => { const task = allProjectTasks.find((item) => item.id === dragToast.code); if (task) openTaskOf(task) }, children: t('drag.rejectedLink').replace('{code}', String(dragToast.code)) }),
          ] }),
          j('button', { className: 'mt-dragtoast-close', 'aria-label': t('action.close'), onClick: () => setDragToast(null), children: '✕' }),
        ] }) : null,
        /* design/dag.html · dag-vertical.html：图注（箭头从上游指到下游 / 一个任务可同时解锁多个下游） */
        taskView === 'dag' ? js('div', { className: 'mt-dag-note', children: [
          j('svg', {
            width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
            children: [
              j('path', { d: 'M4 2.4v11.2M4 8h5.2M9.2 8l2.6-2.6M9.2 8l2.6 2.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
              j('circle', { cx: 4, cy: 2.4, r: 1.2, fill: 'currentColor' }),
              j('circle', { cx: 12.4, cy: 5, r: 1.1, fill: 'currentColor' }),
              j('circle', { cx: 12.4, cy: 11, r: 1.1, fill: 'currentColor' }),
            ],
          }),
          j('span', { children: [
            j('b', { children: dagDir === 'v' ? t('dag.noteLeadV') : t('dag.noteLead') }),
            dagDir === 'v' ? t('dag.arrowNoteV') : t('dag.arrowNote'),
          ] }),
        ] }) : null,
      ] })

      const onTaskSaved = async (taskId, message) => {
        setTaskForm(null)
        setNotice(message)
        setDetailToken((value) => value + 1)
        await loadProject(projectRoot)
      }
      /** 角色保存（CHG-72 / CHG-103）：配置资产写文件；作用域缺省项目级，全局由服务端返回 confirm-required */
      const saveRoleDef = async (role, confirm, scope) => {
        const result = await discoveryApi.saveRole({
          workspaceRoot: projectRoot,
          role,
          scope: scope === 'global' ? 'global' : 'project',
          ...(scope === 'global' ? { confirmGlobal: confirm === true } : {}),
          confirm,
        })
        if (result?.status === 'saved') {
          setNotice(t('role.saved').replace('{id}', String(role.id)))
          await loadProject(projectRoot)
        }
        return result
      }
      /** 角色删除（CHG-73 / CHG-103）：deleteRole 两段确认；全局作用域需 confirmGlobal */
      const deleteRoleFlow = async (roleId, confirm, scope) => {
        if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'missing roleId' }
        const result = await discoveryApi.deleteRole({
          workspaceRoot: projectRoot,
          roleId,
          scope: scope === 'global' ? 'global' : 'project',
          ...(scope === 'global' ? { confirmGlobal: confirm === true } : {}),
          confirm,
        })
        if (result?.status === 'deleted') {
          setNotice(t('role.deleted').replace('{id}', roleId))
          setOpenRole(null)
          setRoleDetail(null)
          await loadProject(projectRoot)
        }
        return result
      }
      /**
       * CHG-89（FR-13.1「发布到全局库」）：项目库角色 → 全局角色库。
       *
       * 两段确认：第一段只问影响面（目标文件 + 「全局库对该工作区所有项目可见」），
       * 第二段带 `confirm:true` 才落盘。**单向流动**——发布后各项目仍需显式
       * copyToProject 才进各自项目库，所以这里不做「已发布」的本地状态推断，
       * 只把服务端返回的 filePath 如实回显。
       */
      const publishRoleFlow = async (roleId, confirm) => {
        if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'missing roleId' }
        const result = await discoveryApi.roleOp({ workspaceRoot: projectRoot, op: 'publish', payload: { roleId }, confirm })
        if (result?.status === 'published') {
          setNotice(t('role.published').replace('{id}', roleId))
          await loadProject(projectRoot)
        }
        return result
      }
      /** 角色能力目录（getCapabilityCatalog；失败降级为「已有角色出现过的名字」并提示） */
      const fallbackCatalog = (() => {
        const collect = (key) => [...new Set((pv.roles ?? []).flatMap((role) => role?.[key] ?? []))].sort()
        return {
          skills: collect('skills').map((name) => ({ name, source: 'role' })),
          mcp: collect('mcpAllowlist').map((name) => ({ name, source: 'role' })),
          warnings: [],
          fallback: true,
        }
      })()
      const catalogForForm = capCatalog === undefined ? undefined : (capCatalog ?? fallbackCatalog)
      /** CHG-74：同一 id 可能有多份副本（内置/全局/项目库）——「生效的那份」= 优先级最高者，
       *  与服务端 resolveEffectiveRole 同口径（项目库 > 项目自身角色 > 全局 > 内置）。 */
      const roleEntryOf = (roleId) => {
        const candidates = (pv.roles ?? []).filter((role) => role.id === roleId)
        if (candidates.length === 0) return undefined
        const rank = { builtin: 0, global: 1, 'project-role': 2, project: 3 }
        return candidates.reduce((best, role) => ((rank[role.origin] ?? 0) > (rank[best.origin] ?? 0) ? role : best))
      }
      const openRoleEntry = openRole ? roleEntryOf(openRole) : undefined
      const canDeleteOpenRole = Boolean(openRoleEntry) && (typeof openRoleEntry.canDelete === 'boolean'
        ? openRoleEntry.canDelete
        : openRoleEntry.origin === 'project' && (openRoleEntry.memberships ?? []).length === 0)
      /* CHG-76 B：批量新建默认团队 = 优先「在线 + active + 有队员」（能真正派单），否则任意在线团队 */
      const firstOnlineTeamId = (pv.teams ?? []).find((team) => team.online && team.sessionId && team.state === 'active' && (team.members ?? []).length > 0)?.teamId
        ?? (pv.teams ?? []).find((team) => team.online && team.sessionId)?.teamId
        ?? ''

      const tasksTabContent = js('div', { className: 'mt-workspace', children: [
        tasksPage,
        openTask ? j(TaskDetail, {
          api: makeApi(connection, openTask.sessionId),
          t,
          teamId: openTask.teamId,
          taskId: openTask.taskId,
          readOnly: !openTask.online,
          memberName,
          teamName,
          /* CHG-86：门禁裁决的审查人下拉需要名册（离线团队 getBoard 不可用） */
          members: (pv.teams ?? []).find((tm) => tm.teamId === openTask.teamId)?.members ?? [],
          refreshToken: detailToken,
          loader: openTask.online ? undefined : (q) => discoveryApi.getOfflineTaskDetail({ ...q, workspaceRoot: projectRoot }),
          onRescope: openTask.online ? openRescopeDialog : undefined,
          onCancel: openTask.online ? openCancelDialog : undefined,
          onDiagnosisFixed,
          onEdit: openTask.online ? (detail) => openTaskEditor({
            mode: 'edit',
            task: {
              id: detail.id,
              ownerTeamId: openTask.teamId,
              ownerOnline: true,
              ownerSessionId: openTask.sessionId,
              state: detail.state,
              /* CHG-89（QA-4 乐观锁）：同上看板入口——快照 revision 供保存时回传 */
              revision: detail.revision,
              input: detail.input,
              assignees: detail.assignees,
              participants: detail.participants,
            },
          }) : undefined,
          onClose: () => setOpenTask(null),
        }) : null,
      ] })

      const content = projectTab === 'roles' ? rolesPage : projectTab === 'teams' ? teamsPage : tasksTabContent

      return js('div', { className: 'mt-panel', ...themeAttr, children: [
        topbar,
        projectTabs,
        /* CHG-104：未初始化引导是横幅，不替换整屏（面板永远可加载、可浏览） */
        storeBanner,
        error ? j('div', { className: 'mt-banner mt-error-banner', role: 'alert', children: error }) : null,
        notice ? js('div', { className: 'mt-banner', children: [
          j('span', { className: 'mt-notice', children: notice }),
          j('button', { className: 'mt-btn', onClick: () => setNotice(null), children: t('action.close') }),
        ] }) : null,
        js('div', { className: 'mt-workspace', children: [
          content,
          openRole ? j(RoleDetailDrawer, {
            t,
            data: roleDetail,
            onClose: () => setOpenRole(null),
            teamName,
            onEdit: (data) => openRoleEditor({ mode: data.origin === 'project' ? 'edit' : 'create', fork: data.origin !== 'project', forkOrigin: data.origin, definition: data.definition }),
            onCopyToProject: copyRoleToProject,
            onGuest: guestRoleCommand,
            /* CHG-89（FR-13.1）：只有「项目库」来源才有发布到全局的语义（内置/全局是复制源不是发布源） */
            onPublish: openRoleEntry?.origin === 'project' ? (confirm) => publishRoleFlow(openRole ?? roleDetail?.roleId, confirm) : undefined,
            skillTotal: (capCatalog?.skills ?? []).length || undefined,
            onDelete: canDeleteOpenRole ? (confirm) => deleteRoleFlow(openRole ?? roleDetail?.roleId, confirm) : undefined,
            /* CHG-73：deleteRole 是根级端点（只要 workspaceRoot）——离线项目也能清理未占用角色，
             * 因此不再按「有无在线团队会话」禁用；唯一门控是 canDelete（项目库 + 无在册 + 未被模板引用）。 */
            deleteHint: !canDeleteOpenRole && openRoleEntry?.origin === 'project' ? t('role.deleteOccupied') : undefined,
          }) : null,
          roleForm ? j(RoleFormDrawer, {
            key: `role-${roleForm.mode}-${roleForm.definition?.id ?? 'new'}`,
            t,
            initial: roleForm,
            catalog: catalogForForm,
            onClose: () => setRoleForm(null),
            save: saveRoleDef,
          }) : null,
          taskForm ? j(TaskFormDrawer, {
            key: `task-${taskForm.mode}-${taskForm.task?.id ?? 'new'}`,
            t,
            mode: taskForm.mode,
            teams: pv.teams ?? [],
            tasks: pv.tasks ?? [],
            initial: taskForm.task,
            defaultTeamId: taskForm.defaultTeamId,
            connection,
            onClose: () => setTaskForm(null),
            onSaved: onTaskSaved,
          }) : null,
          teamCreate ? j(TeamCreateDrawer, {
            t,
            ctx,
            projectRoot,
            presets,
            roles: pv.roles ?? [],
            onClose: () => setTeamCreate(false),
            onRetryPresets: () => setPresets(undefined),
            /* design/new-team-1.html 的脚注「管理预设库」：跳到全局页的预设区块（同一份目录） */
            onManagePresets: () => {
              setTeamCreate(false)
              setScope('global')
              setTimeout(() => {
                if (typeof document !== 'undefined') document.getElementById('mt-presets-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 0)
            },
          }) : null,
          /* CHG-76 B：批量新建抽屉（与其它抽屉互斥；预览/创建都走 createTasks） */
          batchCreate ? j(BatchCreateDrawer, {
            t,
            connection,
            teams: pv.teams ?? [],
            defaultTeamId: firstOnlineTeamId,
            onClose: () => setBatchCreate(false),
            onCreated: onBatchCreated,
          }) : null,
          showCost && tokens !== undefined ? js('div', { className: 'mt-drawer', children: [
            js('div', { className: 'mt-drawer-head', children: [j('strong', { children: t('cost.open') }), j('button', { className: 'mt-btn', onClick: () => setShowCost(false), children: t('action.close') })] }),
            j(TokensTab, { t, tokens, members: selectedTeam?.members ?? [], emptyText: offline ? t('cost.offlineEmpty') : t('cost.empty') }),
          ] }) : null,
        ] }),
        /* CHG-73：多选批量操作条 + 重新规划 / 取消对话框（模态层级在抽屉之上） */
        selectMode && projectTab === 'tasks' ? j(BatchBar, {
          t,
          tasks: selectedTasks,
          allTasks: pv.tasks ?? [],
          teams: pv.teams ?? [],
          memberName,
          onExit: exitSelect,
          onClear: () => setSelected(new Set()),
          runBatch,
          onDone: afterBatch,
        }) : null,
        rescopeFor ? j(RescopeDialog, {
          t,
          api: makeApi(connection, rescopeFor.sessionId),
          teamId: rescopeFor.teamId,
          taskId: rescopeFor.taskId,
          title: rescopeFor.title,
          input: rescopeFor.input,
          members: rescopeFor.members,
          tasks: rescopeFor.tasks,
          expectedRevision: rescopeFor.revision,
          onClose: () => setRescopeFor(null),
          onDone: submitRescope,
        }) : null,
        cancelFor ? j(CancelDialog, {
          t,
          api: makeApi(connection, cancelFor.sessionId),
          teamId: cancelFor.teamId,
          taskId: cancelFor.taskId,
          title: cancelFor.title,
          dependents: cancelFor.dependents,
          upstreams: cancelFor.upstreams,
          memberName,
          onClose: () => setCancelFor(null),
          onDone: submitCancel,
        }) : null,
      ] })
    }

    /* ── 会话页（design/conversation.html）与单角色调用（design/guest.html）──
     * 落点：conversation.view（团队视图壳）+ tool.call.toolview（myteam_* 工具卡）。
     * 纪律（design-notes §五）：会话页不重复造面板 —— 工具卡只给摘要 + 两个出口，
     * 不把整个看板塞进对话流；composer 输入框属于宿主，插件侧以视图内演示区块代替。 */

    /** 工具卡外壳（design .toolcard）：图标 + 工具名 + 摘要 + 折叠箭头 + 体 + 脚 */
    function ToolCardShell({ t, icon, name, stat, expanded = true, children, foot }) {
      const [open, setOpen] = react.useState(expanded)
      /* CHG-99（C13）：工具卡也是面板表面根（`.mt-toolcard`），深色态同源 */
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      return js('div', { className: 'mt-toolcard', ...themeAttr, children: [
        js('div', { className: 'mt-toolcard-head', children: [
          j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: icon }),
          j('span', { className: 'mt-toolcard-name', children: name }),
          j('span', { className: 'mt-toolcard-stat', children: stat }),
          j('button', {
            className: 'mt-toolcard-chev',
            'aria-expanded': open,
            'aria-label': t('action.send'),
            onClick: () => setOpen(!open),
            children: open ? '⌄' : '›',
          }),
        ] }),
        open && children ? j('div', { className: 'mt-toolcard-body', children }) : null,
        open && foot ? j('div', { className: 'mt-toolcard-foot', children: foot }) : null,
      ] })
    }
    /** 状态 chip 的类名（H4 三通道：文字 + 形状 + 颜色） */
    const CONV_STATE_CLASS = (state) => (state === 'done' ? 'mt-status-done'
      : state === 'failed' || state === 'cancelled' ? 'mt-status-fail'
      : String(state).startsWith('gate') || state === 'gates' ? 'mt-status-gate'
      : state === 'in_progress' || state === 'running' || state === 're-scoping' ? 'mt-status-run'
      : 'mt-status-idle')
    /**
     * 演示数据开关（R34 / UI-1：**会话页演示数据不得污染真实视图**）。
     *
     * 修复前：`useState(CONV_DEMO_TASKS)` 让会话页初始 state 就是 11 条硬编码任务，
     * 任何真实会话打开都先闪一遍别人的结算页任务——真实看板为空时更是永远显示假数据。
     * 现在默认**不展示**；只有显式打开调试开关 `globalThis.__MYTEAM_DEMO__ === true`
     * （设计稿对齐 / 截图用）才回落到演示样本。
     */
    const convDemoOn = () => {
      try { return globalThis.__MYTEAM_DEMO__ === true } catch { return false }
    }
    /** 会话页演示数据（仅调试开关打开时用作「读不到看板」的兜底，与 design/conversation.html 同源口径） */
    const CONV_DEMO_TASKS = [
      { id: 't7', title: '抽结算服务边界与接口草案', state: 'in_progress', who: '实现者' },
      { id: 't6', title: '结算页 UI 迁移到模块包', state: 'in_progress', who: '实现者 2' },
      { id: 't4', title: '替换调用点并跑通 4 条冒烟', state: 'gates', who: '验收员' },
      { id: 't1', title: '梳理结算页现有调用点清单', state: 'backlog', who: '需求验证' },
      { id: 't2', title: '确定模块包对外 API 契约', state: 'done', who: '评审者' },
      { id: 't3', title: '移除旧结算组件目录', state: 'gates', who: '需求验证员' },
      { id: 't5', title: '旧调用点替换与灰度开关', state: 'ready', who: '评审者' },
      { id: 't8', title: '补 12 条结算回归用例', state: 'ready', who: '需求验证员' },
      { id: 't9', title: '结算页性能基线', state: 'backlog', who: '实现者' },
      { id: 'v1', title: '评审口径对齐', state: 'done', who: '评审者' },
      { id: 'v2', title: '锁定 v0.2 对外契约基线', state: 'in_progress', who: '接口评审' },
    ]
    /**
     * 会话页 / 工具卡共用的看板数据源（真实优先）。
     *
     * 返回 `{ tasks, live, gates, roles, loaded }`：全部来自 `getBoard` 现算，
     * **不用任何硬编码计数**；读不到时是空数组 / 0（渲染侧用 `—` 占位），
     * 只有 `__MYTEAM_DEMO__` 打开时才回落到演示样本。
     */
    function useConvBoard(connection, sessionId) {
      const [state, setState] = react.useState(() => ({ tasks: [], live: 0, gates: 0, roles: 0, loaded: false }))
      react.useEffect(() => {
        if (!sessionId || !connection) return undefined
        let alive = true
        makeApi(connection, sessionId).getBoard({}).then((data) => {
          if (!alive || !data) return
          const members = data.board?.members ?? []
          const boardTasks = (data.board?.columns ?? []).flatMap((column) => column.tasks ?? [])
          const mapped = boardTasks.map((task) => ({
            id: String(task.id),
            title: task.title,
            state: task.state,
            who: (task.assignees ?? []).map((id) => String(id)).join('、'),
          }))
          setState({
            tasks: mapped.length > 0 ? mapped : (convDemoOn() ? CONV_DEMO_TASKS : []),
            live: members.filter((member) => member.status === 'active' && member.currentTaskId).length,
            gates: boardTasks.filter((task) => String(task.state).startsWith('gate') || task.state === 'gates').length,
            roles: new Set(members.map((member) => member.roleId).filter(Boolean)).size,
            loaded: true,
          })
        }).catch(() => {})
        return () => { alive = false }
      }, [sessionId, connection])
      return state
    }
    /** 计数渲染：0 条任务不等于「无数据」时照样显示 0；缺数据（未加载）显示 — 占位 */
    const convCount = (value, loaded) => (loaded ? String(Number(value) || 0) : '—')
    /** myteam_plan_tasks 工具卡：迷你任务列表（摘要 + 两个出口） */
    function TeamPlanTasksCard({ t, tasks, stat, onOpenPanel, onOpenTask, loaded = true }) {
      const list = (tasks ?? []).slice(0, 4)
      const rest = Math.max(0, (tasks ?? []).length - list.length)
      const foot = [
        j('button', { key: 'panel', className: 'mt-btn mt-btn-sm', onClick: onOpenPanel, children: t('g6.conv.openPanel') }),
        j('button', { key: 'detail', className: 'mt-btn mt-btn-sm', onClick: onOpenTask, children: t('g6.conv.openDetail').replace('{id}', String(list[0]?.id ?? '—')) }),
        j('span', { key: 'note', className: 'mt-toolcard-note', children: t('g6.conv.ledger').replace('{time}', '21:13') }),
      ]
      /* 加载中骨架：只给**设计稿结构**（行 + 状态位 + 计数占位），不含任何演示任务 */
      const skeleton = [0, 1].map((index) => js('div', { key: `sk-${index}`, className: 'mt-toolcard-row', children: [
        j('span', { className: 'mt-tid', 'aria-hidden': true, children: '…' }),
        j('span', { className: 'mt-tt mt-toolcard-more', children: t('state.loading') }),
        j('span', {
          className: 'mt-status-chip mt-status-idle',
          children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: '—' })],
        }),
      ] }))
      const body = [
        ...(loaded ? [] : skeleton),
        /* 空看板不编数据：给一行「暂无任务」占位（R34 / P0-5），不闪演示样本 */
        loaded && list.length === 0 ? js('div', { key: 'empty', className: 'mt-toolcard-row', children: [
          j('span', { className: 'mt-tid', 'aria-hidden': true, children: '—' }),
          j('span', { className: 'mt-tt mt-toolcard-more', children: t('g6.conv.tasksEmpty') }),
        ] }) : null,
        ...list.map((task) => js('div', { key: task.id, className: 'mt-toolcard-row', children: [
          j('span', { className: 'mt-tid', children: task.id }),
          j('span', { className: 'mt-tt', children: task.title }),
          j('span', {
            className: `mt-status-chip ${CONV_STATE_CLASS(task.state)}`,
            children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: stateLabel(task.state) })],
          }),
          j('span', { className: 'mt-who', children: task.who ?? '' }),
        ] })),
        /* 「另有 N 个」：未加载时计数未知 → 显示 — 占位（不写死数字，也不隐藏设计稿的这一行） */
        rest > 0 || !loaded ? js('div', { key: 'rest', className: 'mt-toolcard-row', children: [
          j('span', { className: 'mt-tid', children: '…' }),
          j('span', { className: 'mt-tt mt-toolcard-more', children: t('g6.conv.moreTasks').replace('{n}', loaded ? String(rest) : '—') }),
        ] }) : null,
      ]
      return j(ToolCardShell, { t, icon: '⌘', name: 'myteam_plan_tasks', stat, children: body, foot })
    }
    /** 折叠工具卡（myteam_approve_plan / myteam_peer_message）：只给一行摘要，不展开看板 */
    function TeamCollapsedCard({ icon, name, stat }) {
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      return js('div', { className: 'mt-toolcard', ...themeAttr, children: js('div', { className: 'mt-toolcard-head', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: icon }),
        j('span', { className: 'mt-toolcard-name', children: name }),
        j('span', { className: 'mt-toolcard-stat', children: stat }),
        j('span', { className: 'mt-toolcard-chev', 'aria-hidden': true, children: '›' }),
      ] }) })
    }
    /** myteam_apply_roles 注入卡（design/guest.html）：系统提示 / 工具策略只收窄 / 技能 / MCP 交集 / 模型路由五行 */
    function ApplyRolesCard({ t }) {
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      const chips = (list) => list.map((item, index) => j('span', { key: `${item}-${index}`, className: 'mt-mini-chip', children: item }))
      const rows = [
        ['systemPrompt', [
          j('span', { key: 'a', children: '追加 2 段角色提示（' }),
          j('code', { key: 'b', children: 'reviewer' }),
          j('span', { key: 'c', children: ' 审查准则、' }),
          j('code', { key: 'd', children: 'tech-writer' }),
          j('span', { key: 'e', children: ' 文档骨架）' }),
          j('span', { key: 'f', className: 'mt-mini-chip', children: t('g6.guest.onceInject') }),
        ]],
        ['toolPolicy', [
          j('span', { key: 'a', children: '取交集后收窄 2 项：' }),
          j('code', { key: 'b', children: 'bash' }),
          j('span', { key: 'c', children: ' 移除 · ' }),
          j('code', { key: 'd', children: 'write' }),
          j('span', { key: 'e', children: ' 限文档目录' }),
          j('span', { key: 'f', className: 'mt-mini-chip mt-mini-chip-lead', children: t('g6.guest.narrowOnly') }),
        ]],
        ['skills', chips(['review-playbook', 'doc-outline'])],
        ['mcp', [
          j('span', { key: 'a', children: '连接层 ∩ allowlist = ' }),
          /* 演示样本走 locale（t63-6：实现里不硬编码设计稿演示数据），最后一个＝未连接的降级项 */
          ...t('g6.guest.mcpSamples').split(' · ').map((name, index, all) => j('span', {
            key: `mcp-${index}`,
            className: index === all.length - 1 ? 'mt-mini-chip mt-mini-chip-coop' : 'mt-mini-chip',
            children: index === all.length - 1 ? `⚠ ${name}` : name,
          })),
        ]],
        ['modelRoute', [
          j('code', { key: 'a', children: 'claude-opus-4.6' }),
          j('span', { key: 'b', children: '（来自 reviewer，冲突时取后加载的那个）' }),
        ]],
      ]
      return js('div', { className: 'mt-toolcard', ...themeAttr, children: [
        js('div', { className: 'mt-toolcard-head', children: [
          j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⛓' }),
          j('span', { className: 'mt-toolcard-name', children: 'myteam_apply_roles' }),
          j('span', { className: 'mt-toolcard-stat', children: t('g6.guest.applyStat').replace('{n}', '2') }),
          j('span', { className: 'mt-toolcard-chev', 'aria-hidden': true, children: '⌄' }),
        ] }),
        js('div', { className: 'mt-toolcard-body', children: rows.map(([key, value]) => js('div', { key, className: 'mt-injrow', children: [
          j('span', { className: 'mt-inj-k', children: t(`g6.guest.${key}`) }),
          j('span', { className: 'mt-inj-v', children: value }),
        ] })) }),
        js('div', { className: 'mt-toolcard-foot', children: [
          j('button', { className: 'mt-btn mt-btn-sm', children: t('g6.guest.seeRole') }),
          j('button', { className: 'mt-btn mt-btn-sm', children: t('g6.guest.seeSkills') }),
        ] }),
      ] })
    }
    /** /myteam+ 命令输入 + 前缀匹配候选弹层（多义回显不猜：把全部匹配列出来让人点选） */
    function GuestCallComposer({ t }) {
      const [value, setValue] = react.useState('tech-w')
      const label = t('g6.guest.candCap').replace('{n}', '2')
      return js('div', { children: [
        js('div', { className: 'mt-composerbox', children: [
          j('span', { className: 'mt-cmdprefix', 'aria-hidden': true, children: '/myteam+' }),
          j('input', {
            className: 'mt-cmdinput',
            value,
            'aria-label': t('g6.guest.section'),
            autoComplete: 'off',
            onChange: (event) => setValue(event.target.value),
          }),
          j('button', { className: 'mt-btn mt-btn-sm', 'aria-label': t('action.send'), children: '↑' }),
        ] }),
        js('div', { className: 'mt-candpop', role: 'listbox', 'aria-label': label, children: [
          j('div', { className: 'mt-cand-cap', children: label }),
          js('div', { className: 'mt-cand', role: 'option', 'aria-selected': 'true', children: [
            j('span', { className: 'mt-mavatar mt-mavatar-a4', 'aria-hidden': true, children: '文' }),
            j('span', { className: 'mt-cand-name', children: 'tech-writer' }),
            j('span', { className: 'mt-src mt-src-project', children: t('roles.origin.project') }),
            j('span', { className: 'mt-cand-sub', children: 'gpt-5.1 · 迁移说明与对外文档' }),
          ] }),
          js('div', { className: 'mt-cand', role: 'option', 'aria-selected': 'false', children: [
            j('span', { className: 'mt-mavatar mt-mavatar-a4', 'aria-hidden': true, children: '文' }),
            j('span', { className: 'mt-cand-name', children: 'tech-writer-cn' }),
            j('span', { className: 'mt-src mt-src-global', children: t('roles.origin.global') }),
            j('span', { className: 'mt-cand-sub', children: '继承队长路由 · 只写中文文档' }),
          ] }),
          j('div', { className: 'mt-cand-foot', children: t('g6.guest.candFoot') }),
        ] }),
        j('p', { className: 'mt-composerhint', children: t('g6.guest.hint') }),
      ] })
    }
    /** 对话轮次（design .turn） */
    function ConvTurn({ avatar, human, who, time, children }) {
      return js('div', { className: 'mt-turn', children: [
        j('span', { className: human ? 'mt-turn-av mt-turn-av-human' : 'mt-turn-av', 'aria-hidden': true, children: avatar }),
        js('div', { className: 'mt-turn-body', children: [
          js('div', { className: 'mt-turn-meta', children: [j('b', { children: who }), j('span', { children: time })] }),
          ...(Array.isArray(children) ? children : [children]),
        ] }),
      ] })
    }
    /** 会话页团队视图（conversation.view 落点）：会话头 seg + 工具卡 + 输入框上方 dock chip + 单角色调用演示 */
    function MyTeamConversationView(props) {
      const { ctx, sessionId, t: tProp } = props ?? {}
      const t = tProp ?? ((k) => zh[k] ?? k)
      /* CHG-99（C13）：会话视图根（`.mt-conv`）也是表面根 */
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      const [view, setView] = react.useState('chat')
      /* 真实数据源（getBoard 现算）；默认空，不再用 CONV_DEMO_TASKS 当初始 state（R34 / P0-5） */
      const board = useConvBoard(props?.connection, sessionId)
      const tasks = board.tasks
      const live = board.live
      const gates = board.gates
      const openPanel = () => {
        try {
          const workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined
          workspace?.openPanel?.(PANEL_KEY)
        } catch { /* 降级：无 openPanel 时静默 */ }
      }
      /* 摘要行：全部来自真实计数；未加载 / 取不到时显示 — 占位，不写死 5 / 3 */
      const planStat = t('g6.conv.planStat')
        .replace('{tasks}', convCount(tasks.length, board.loaded))
        .replace('{roles}', convCount(board.roles, board.loaded))
        .replace('{gates}', convCount(board.gates, board.loaded))
      return js('div', { className: 'mt-conv', ...themeAttr, children: [
        js('div', { className: 'mt-conv-head', children: [
          j('span', { className: 'mt-team-mark', 'aria-hidden': true, children: '⬢' }),
          js('div', { className: 'mt-conv-title', children: [
            j('b', { children: '结算页模块化' }),
            j('span', { children: `队长 · 队长 · t-8f3a2c` }),
          ] }),
          js('div', { className: 'mt-conv-seg', role: 'group', 'aria-label': t('g6.conv.view'), children: [
            j('button', { className: view === 'chat' ? 'mt-conv-seg-on' : '', 'aria-pressed': view === 'chat', onClick: () => setView('chat'), children: t('g6.conv.chat') }),
            j('button', { className: view === 'team' ? 'mt-conv-seg-on' : '', 'aria-pressed': view === 'team', onClick: () => setView('team'), children: t('g6.conv.view') }),
          ] }),
          j('button', { className: 'mt-btn mt-btn-sm', 'aria-label': t('team.tab.audit'), onClick: openPanel, children: '⋯' }),
        ] }),
        js('div', { className: 'mt-stream', children: [
          j(ConvTurn, { avatar: '你', human: true, who: '你', time: '21:12', children: j('p', { className: 'mt-bubble', children: '把结算页拆成独立模块，补齐回归测试并替换旧调用点。先给我看拆分计划再动手。' }) }),
          j(ConvTurn, {
            avatar: '岚',
            who: '队长 · 队长',
            time: '21:13',
            children: [
              j('p', { className: 'mt-bubble', children: '拆完了，11 个任务、5 个角色，其中 t7 是硬前置 —— 它不产出接口契约，后面的 UI 迁移会整个返工。计划已暂存，等你裁决。' }),
              j(TeamPlanTasksCard, { t, tasks, stat: planStat, onOpenPanel: openPanel, onOpenTask: openPanel, loaded: board.loaded }),
            ],
          }),
          j(ConvTurn, { avatar: '你', human: true, who: '你', time: '21:20', children: j('p', { className: 'mt-bubble', children: '批准。t7 交付后先给我看一眼接口契约再往下派。' }) }),
          j(ConvTurn, {
            avatar: '岚',
            who: '队长 · 队长',
            time: '21:21',
            children: [
              j('p', { className: 'mt-bubble', children: '已把 5 个角色拉进团队。t7 交付时我会把契约摘出来单独发你，未批准前不派 t6 之后的任务。' }),
              j(TeamCollapsedCard, { icon: '✓', name: 'myteam_approve_plan', stat: t('g6.conv.approvedStat').replace('{n}', '5') }),
              j(TeamCollapsedCard, { icon: '✉', name: 'myteam_peer_message', stat: t('g6.conv.peerStat').replace('{from}', '实现者').replace('{to}', '队长') }),
            ],
          }),
          j(ConvTurn, { avatar: '你', human: true, who: '你', time: '21:41', children: j('p', { className: 'mt-bubble', children: '评审者那个门禁超时我看一下，先别让他跳过。' }) }),
        ] }),
        /* 输入框上方 composer.dock 状态 chip。
         * design/conversation.html 的 `.dockrow` 是会话视图的**固定组成部分**（不随数据有无增删），
         * 计数一律来自真实看板（0 是真实值，不是演示数据）；只有 DockChip（composer 槽）才在
         * live=0 且 unread=0 时整块不渲染。 */
        js('div', { className: 'mt-dockrow', children: [
          j('button', { className: 'mt-dockchip', onClick: openPanel, children: [
            j('span', { className: 'mt-dot', 'aria-hidden': true }),
            j('span', { children: t('g6.dock.running').replace('{n}', convCount(live, board.loaded)) }),
            j('span', { className: 'mt-vline', 'aria-hidden': true }),
            j('span', { children: t('g6.dock.gates').replace('{n}', convCount(gates, board.loaded)) }),
            j('span', { className: 'mt-go', 'aria-hidden': true, children: '→' }),
          ] }),
          j('span', { className: 'mt-spacer' }),
        ] }),
        js('div', { className: 'mt-composerhint', children: [
          j('span', { children: t('g6.conv.hint').replace('{cmd}', '/myteam+reviewer') }),
          j('span', { children: ' ' }),
          j('button', { className: 'mt-mini-link', children: t('g6.conv.hintLink') }),
        ] }),
        /* 单角色调用（guest.html）：头部角色 chips + 不属于任何团队的横幅 + 注入卡 + /myteam+ 命令输入 + 候选弹层 */
        js('div', { className: 'mt-conv-section', children: [
          j('h4', { className: 'mt-conv-section-title', children: t('g6.guest.section') }),
          js('div', { className: 'mt-guestchips', children: [
            js('span', { className: 'mt-mini-chip mt-mini-chip-lead', children: [
              j('span', { className: 'mt-mavatar mt-mavatar-a2', 'aria-hidden': true, children: '评' }),
              j('span', { children: 'reviewer' }),
            ] }),
            js('span', { className: 'mt-mini-chip', children: [
              j('span', { className: 'mt-mavatar mt-mavatar-a4', 'aria-hidden': true, children: '文' }),
              j('span', { children: 'tech-writer' }),
            ] }),
            j('button', { className: 'mt-btn mt-btn-sm', 'aria-label': t('g6.guest.unload'), children: '✕' }),
          ] }),
          js('div', { className: 'mt-guestbar', children: [
            j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⛨' }),
            j('span', { children: [j('b', { children: t('g6.guest.banner').replace('{n}', '2') }), t('g6.guest.bannerBody')] }),
            j('button', { className: 'mt-btn mt-btn-sm', children: t('g6.guest.inspect') }),
          ] }),
          j(ApplyRolesCard, { t }),
          j(GuestCallComposer, { t }),
        ] }),
      ] })
    }
    /** 四个 myteam_* 工具卡（tool.call.toolview 的 keyed 组件，按 wire 工具名精确注册） */
    /** myteam_plan_tasks 工具卡（R34 / P0-5）：真实看板数据源，默认不再展示演示任务 */
    function MyTeamPlanTasksToolView(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k)
      const board = useConvBoard(props?.connection, props?.sessionId)
      return j(TeamPlanTasksCard, {
        t,
        tasks: board.tasks,
        stat: t('g6.conv.planStat')
          .replace('{tasks}', convCount(board.tasks.length, board.loaded))
          .replace('{roles}', convCount(board.roles, board.loaded))
          .replace('{gates}', convCount(board.gates, board.loaded)),
        onOpenPanel: () => {},
        onOpenTask: () => {},
        loaded: board.loaded,
      })
    }
    function MyTeamApprovePlanToolView(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k)
      return j(TeamCollapsedCard, { icon: '✓', name: 'myteam_approve_plan', stat: t('g6.conv.approvedStat').replace('{n}', '5') })
    }
    function MyTeamPeerMessageToolView(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k)
      return j(TeamCollapsedCard, { icon: '✉', name: 'myteam_peer_message', stat: t('g6.conv.peerStat').replace('{from}', '实现者').replace('{to}', '队长') })
    }
    /**
     * myteam_apply_roles 工具卡（CHG-87 §5.3 / FR-16.1）。
     *
     * 修复前：这里是**硬编码演示卡**（角色名 `reviewer` / `tech-writer` / `claude-opus-4.6`
     * 全部写死，连 `myteam_apply_roles` 工具本身都不存在）——UI 展示的是假数据。
     * 现在只读工具调用返回值（契约 §5.2）：
     * `{ status, roles:[{roleId,name,skills,mcpAllowlist}], removed, filePath, promptSection, note }`；
     * `status === 'error'` 时渲染 `code` + `message`。**零硬编码角色名。**
     */
    function MyTeamApplyRolesToolView(props) {
      const t = props?.t ?? ((k) => zh[k] ?? k)
      /* 工具调用返回可能挂在 result / output / data，或直接平铺在 props 上 */
      const raw = props?.result ?? props?.output ?? props?.call?.result ?? props?.data ?? props ?? {}
      const status = String(raw?.status ?? '')
      const roles = Array.isArray(raw?.roles) ? raw.roles : []
      const removed = Array.isArray(raw?.removed) ? raw.removed.map((id) => String(id)) : []
      const promptSection = typeof raw?.promptSection === 'string' ? raw.promptSection.trim() : ''
      const note = typeof raw?.note === 'string' ? raw.note.trim() : ''
      const filePath = typeof raw?.filePath === 'string' ? raw.filePath : ''
      const stat = t('g6.guest.applyStat').replace('{n}', String(roles.length))
      const chip = (value, key, extra) => j('span', { key, className: extra ? `mt-mini-chip ${extra}` : 'mt-mini-chip', children: value })
      /** 技能 / MCP 绑定行（空则不渲染该段，契约 §5.3） */
      const bindRow = (label, values, key) => (values.length === 0 ? null : js('div', { key, className: 'mt-injrow', children: [
        j('span', { className: 'mt-inj-k', children: label }),
        j('span', { className: 'mt-inj-v', children: values.map((value, index) => chip(value, `${key}-${index}`)) }),
      ] }))
      const body = status === 'error'
        ? js('div', { className: 'mt-injrow', children: [
          j('span', { className: 'mt-inj-k', children: t('applyRoles.error') }),
          j('span', { className: 'mt-inj-v', children: [
            j('code', { children: String(raw?.code ?? '—') }),
            j('span', { children: String(raw?.message ?? '') }),
          ] }),
        ] })
        : js('div', { children: [
          roles.length === 0
            ? j('p', { className: 'mt-hint', children: t('applyRoles.empty') })
            : js('div', { className: 'mt-injrow', children: [
              j('span', { className: 'mt-inj-k', children: t('applyRoles.roles') }),
              j('span', { className: 'mt-inj-v', children: roles.map((role, index) => chip(
                `${String(role?.roleId ?? '—')} · ${String(role?.name ?? '—')}`,
                `role-${String(role?.roleId ?? index)}`,
                'mt-mini-chip-lead',
              )) }),
            ] }),
          ...roles.map((role, index) => {
            const key = String(role?.roleId ?? index)
            const skills = Array.isArray(role?.skills) ? role.skills.map((item) => String(item)) : []
            const mcp = Array.isArray(role?.mcpAllowlist) ? role.mcpAllowlist.map((item) => String(item)) : []
            if (skills.length === 0 && mcp.length === 0) return null
            return js('div', { key: `bind-${key}`, children: [
              bindRow(`${key} · ${t('applyRoles.skills')}`, skills, `sk-${key}`),
              bindRow(`${key} · ${t('applyRoles.mcp')}`, mcp, `mcp-${key}`),
            ] })
          }),
          removed.length > 0 ? js('div', { className: 'mt-injrow', children: [
            j('span', { className: 'mt-inj-k', children: t('applyRoles.removed') }),
            j('span', { className: 'mt-inj-v', children: removed.map((id, index) => chip(`− ${id}`, `rm-${index}`, 'mt-mini-chip-coop')) }),
          ] }) : null,
          promptSection ? js('details', { className: 'mt-injrow', children: [
            j('summary', { children: t('applyRoles.promptSection') }),
            j('pre', { className: 'mt-ev-code', children: promptSection }),
          ] }) : null,
          note ? j('p', { className: 'mt-hint', children: note }) : null,
          filePath ? j('p', { className: 'mt-hint', children: t('rolecall.filePath').replace('{path}', filePath) }) : null,
        ] })
      return j(ToolCardShell, { t, icon: '⛓', name: 'myteam_apply_roles', stat, children: body })
    }

    /* ── composer dock chip（会话槽：inject 回调首参 = sessionId；非队长会话轮询得 unavailable → 不亮）── */
    function DockChip(props) {
      const { ctx, connection, sessionId, t: tProp } = props
      const t = tProp ?? ((k) => zh[k] ?? k)
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      const [unread, setUnread] = react.useState(0)
      const [live, setLive] = react.useState(0)
      react.useEffect(() => {
        if (sessionId === undefined || !connection) return
        let alive = true
        const api = makeApi(connection, sessionId)
        const tick = async () => {
          if (isHidden()) return
          try {
            const i = await api.getInbox({})
            if (!alive || !i?.inbox) return
            setUnread(i.inbox.unread ?? 0)
            const b = await api.getBoard({})
            const running = (b?.board?.members ?? []).filter((m) => m.status === 'active' && m.currentTaskId).length
            if (alive) setLive(running)
          } catch { /* 面板数据失败静默（不干扰对话） */ }
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        /* 同上：后台不轮询；回到可见立刻补一次（DockChip 挂在会话输入框上方，切回来要马上对） */
        const onVisible = () => { if (!isHidden()) tick() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [sessionId, connection])
      /* design/conversation.html 的 .dockrow：live=0 且 unread=0 时整块不渲染 */
      if (live === 0 && unread === 0) return null
      return js('div', { className: 'mt-dockrow', ...themeAttr, children: [
        j('button', {
          className: 'mt-dockchip',
          title: t('chip.title'),
          onClick: () => {
            try {
              const workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined
              workspace?.openPanel?.(PANEL_KEY)
            } catch { /* 降级：无 openPanel 时静默 */ }
          },
          children: [
            j('span', { className: 'mt-dot', 'aria-hidden': true }),
            live > 0 ? j('span', { children: t('g6.dock.running').replace('{n}', String(live)) }) : null,
            live > 0 && unread > 0 ? j('span', { className: 'mt-vline', 'aria-hidden': true }) : null,
            unread > 0 ? j('span', { children: t('g6.dock.gates').replace('{n}', String(unread)) }) : null,
            j('span', { className: 'mt-go', 'aria-hidden': true, children: '→' }),
          ],
        }),
        j('span', { className: 'mt-spacer' }),
      ] })
    }

    /**
     * 侧栏入口图标（CHG-99 / C13）。
     *
     * 它也是面板表面根之一（`.mt-entry`）：宿主侧栏里的 `color-scheme` 由这里带出来，
     * 与面板共用同一份 `useDarkTheme()` 解析结果，避免「面板深色、入口还是浅色」。
     */
    function SidebarEntry() {
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      return j('span', { className: 'mt-entry', ...themeAttr, title: zh['panel.title'], 'aria-hidden': true, children: j('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', className: 'mt-navicon',
        children: [
          j('circle', { cx: 8, cy: 3.4, r: 2.1, stroke: 'currentColor', strokeWidth: 1.2 }),
          j('circle', { cx: 3.6, cy: 11.8, r: 2.1, stroke: 'currentColor', strokeWidth: 1.2 }),
          j('circle', { cx: 12.4, cy: 11.8, r: 2.1, stroke: 'currentColor', strokeWidth: 1.2 }),
          j('path', { d: 'M6.7 5.3 4.7 9.9M9.3 5.3l2 4.6M5.7 11.8h4.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ],
      }) })
    }

    /* ── 注册（官方形态：inject 导出 + apply(ctx) + ctx.effect 持清理）── */
    // connection：M2 直连网关 RPC 通道（connection.rpc.call('/api', endpoint, {args}, signal)）
    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      // ① locale 字典（effect 持有，卸载即注销）
      if (typeof ctx.effect === 'function' && ctx.locale?.register) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'myteam.panel: dictionaries')
      } else if (ctx.locale?.register) {
        ctx.locale.register(NS, { zh, en })
      }
      // ② 样式（effect 持有，卸载即移除；原实现挂在 factory 阶段不可清理）
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => injectStyles(), 'myteam.panel: styles')
      } else {
        injectStyles()
      }
      // ③ 插槽注册：slot inject 回调首参 = binding.key = sessionId
      //    （dsh-client-ui-renderer runInject：session 槽有 binding，root 'main' 槽没有）
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_KEY,
        locale: NS,
        // root 槽无 sessionId → Panel 先 listTeams 发现队长会话（M2 门面）
        inject: () => ({ ctx, connection: ctx.connection }),
      }, Panel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_KEY,
        order: 20,
        locale: NS,
        label: () => 'myteam',
      }, SidebarEntry))
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: PANEL_KEY,
        order: 30,
        locale: NS,
        // 会话槽：首参 sessionId → DockChip 只在队长会话轮询出数据（非队长 → unavailable → 不亮）
        inject: (sessionId) => ({ ctx, connection: ctx.connection, sessionId }),
      }, DockChip))
      /* ④ CHG-82 G6：会话页团队视图（conversation.view）+ myteam_* 工具卡（tool.call.toolview）。
       * 官方契约：conversation.view 用 id + order + label（按会话绑定）；tool.call.toolview 用 key
       * （按 wire 工具名精确注册，见 dsh-client-ui-tool 的 ask_user_question 参考实现）。
       * 插件跑在用户真实桌面里 —— 任一注册失败都不能让 apply 抛错（否则整个面板消失），只 warn 降级。 */
      try {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: PANEL_KEY,
          order: 20,
          locale: NS,
          label: () => zh['g6.conv.view'] ?? 'myteam',
          inject: (sessionId) => ({ ctx, connection: ctx.connection, sessionId }),
        }, MyTeamConversationView))
        const TOOL_VIEWS = [
          ['myteam_plan_tasks', MyTeamPlanTasksToolView],
          ['myteam_approve_plan', MyTeamApprovePlanToolView],
          ['myteam_peer_message', MyTeamPeerMessageToolView],
          ['myteam_apply_roles', MyTeamApplyRolesToolView],
        ]
        for (const [key, component] of TOOL_VIEWS) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key,
            locale: NS,
            inject: (sessionId) => ({ ctx, sessionId, connection: ctx.connection }),
          }, component))
        }
      } catch (e) {
        console.warn('[myteam] 插槽注册失败：', e)
      }
    }

    /* 测试专用出口（t65-design-g5）：设计稿对齐的纯组件，供 mock loader 直接渲染断言结构。
     * 生产路径不消费它（官方只认 apply / inject）。 */
    const __test = { DagView, LanesView, TaskCard, DRAG_LEGAL_TARGETS, dagChipOf }

    /* 测试专用出口（t64-design-g4）：G4 五屏的纯组件，供 mock loader 直接渲染断言结构。
     * 生产路径不消费它（官方只认 apply / inject）。 */
    const __testG4 = { AuditTab, SettingsTab, CostBar, TeamCard, TeamsHome, ArchiveReplay }

    /* 测试专用出口（t66-design-g6）：G6 六屏的纯组件，供 mock loader 直接渲染断言结构。
     * 生产路径不消费它（官方只认 apply / inject）。 */
    const __testG6 = {
      TeamCreateDrawer, MyTeamConversationView,
      MyTeamPlanTasksToolView, MyTeamApprovePlanToolView, MyTeamPeerMessageToolView, MyTeamApplyRolesToolView,
      TeamPlanTasksCard, TeamCollapsedCard, ApplyRolesCard, GuestCallComposer, DockChip,
    }

    /* 测试专用出口（t75-chg89-gaps）：CHG-89 三个新入口所在组件的纯渲染面。
     * 生产路径不消费它（官方只认 apply / inject）——存在只为让「按钮到底渲没渲染」
     * 能在 mock loader 下断言，而不是只 grep 源码字符串。 */
    const __testG89 = { RoleDetailDrawer, TaskFormDrawer, SettingsTab, DiagFix, RescopeDialog, ContributionsSection, contributionsBody }

    return { apply, inject, __test, __testG4, __testG6, __testG89 }
  },
})
