    /* ── CHG-157：团队总览卡（对齐 AgentTeams 样例：成员/完成/消息 + 队长汇总 + 总进度分段条 + 等待前置叙述）──
     * 挂在会话视图（conversation.view）头部；数据全部来自 getBoard（members/currentTaskId/tasks/deps/messageCount），
     * 不新增服务端读取；「一眼看全局」而不用在三处拼数字。 */
    const OV_BUCKET_ORDER = ['done', 'run', 'assigned', 'waiting', 'stuck', 'idle']
    /** 单任务 → 六桶之一（纯函数）。waiting 优先于 assigned：有未完成上游就是等前置，认领了也在等。 */
    const ovBucketOf = (task, doneIds) => {
      const state = String(task?.state ?? '')
      if (state === 'done') return 'done'
      if (state === 'in_progress' || state === 're-scoping' || state === 'running' || state.startsWith('gate')) return 'run'
      if (state === 'failed' || state === 'blocked' || state === 'cancelled') return 'stuck'
      const deps = Array.isArray(task?.deps) ? task.deps : []
      if (deps.some((dep) => !doneIds.has(dep))) return 'waiting'
      if ((task?.assignees ?? []).length > 0) return 'assigned'
      return 'idle'
    }
    /** 任务 + 成员 + 消息数 → 总览数据（纯函数；「已认领」= 有指派且依赖已就绪、还没开工） */
    const teamOverviewOf = (tasks, members, messageCount) => {
      const list = Array.isArray(tasks) ? tasks : []
      const doneIds = new Set(list.filter((task) => task.state === 'done').map((task) => task.id))
      const buckets = { done: [], run: [], assigned: [], waiting: [], stuck: [], idle: [] }
      for (const task of list) buckets[ovBucketOf(task, doneIds)].push(task)
      const memberList = Array.isArray(members) ? members : []
      /* 在跑人数：名册带 currentTaskId 就按人数；离线名册没这个字段 → 退回「进行中任务数」
       *（如实的近似——没有成员在岗数据时不编「0 人在跑」，也不编人名） */
      const liveCount = memberList.length > 0
        ? memberList.filter((member) => member?.currentTaskId).length
        : buckets.run.length
      return {
        total: list.length,
        memberCount: memberList.length,
        liveCount,
        doneCount: buckets.done.length,
        idleCount: buckets.idle.length,
        buckets,
        messageCount: typeof messageCount === 'number' ? messageCount : null,
      }
    }
    /** 总进度叙述行（纯函数）：等待前置点名列前三；全交付 / 待认领 / 全开工各有口径，不写死 */
    const ovNarrativeText = (overview, t) => {
      if (!overview || overview.total === 0) return null
      const waiting = overview.buckets.waiting
      if (waiting.length > 0) {
        const codes = waiting.slice(0, 3).map((task) => String(task.code ?? task.id))
        const head = waiting.length > 3
          ? t('ov.waitingMore').replace('{codes}', codes.join('、')).replace('{n}', String(waiting.length))
          : t('ov.waiting').replace('{codes}', codes.join('、'))
        return head + (overview.idleCount > 0
          ? t('ov.waitingTailIdle').replace('{n}', String(overview.idleCount))
          : t('ov.waitingTailRun'))
      }
      if (overview.doneCount === overview.total) return t('ov.allDone')
      if (overview.idleCount > 0) return t('ov.idleNote').replace('{n}', String(overview.idleCount))
      return t('ov.allRunning')
    }
    /** 总览卡：元信息行（成员/已交付分数/消息）+ 队长汇总行 + 分段条 + 图例 + 叙述行 */
    function TeamOverviewCard({ t, tasks, members, messageCount, loaded }) {
      if (!loaded) return null
      const list = Array.isArray(tasks) ? tasks : []
      const overview = teamOverviewOf(list, members, messageCount)
      const doneIds = new Set(list.filter((task) => task.state === 'done').map((task) => task.id))
      const messages = overview.messageCount === null
        ? '—'
        : t('ov.messages').replace('{n}', String(overview.messageCount))
      const meta = [
        t('ov.members').replace('{n}', String(overview.memberCount)),
        t('ov.doneScore').replace('{x}', String(overview.doneCount)).replace('{y}', String(overview.total)),
        messages,
      ].join(' · ')
      const legend = OV_BUCKET_ORDER.map((key) => js('span', { key, className: 'mt-ov-legend-item', children: [
        j('i', { className: `mt-ov-dot mt-ov-dot-${key}`, 'aria-hidden': true }),
        j('span', { children: `${t(`ov.legend.${key}`)} ${overview.buckets[key].length}` }),
      ] }))
      return js('div', { className: 'mt-ov', children: [
        j('div', { className: 'mt-ov-meta', children: meta }),
        j('div', { className: 'mt-ov-lead', children: overview.total === 0
          ? t('ov.leadEmpty')
          : t('ov.lead').replace('{n}', String(overview.total)).replace('{m}', String(overview.memberCount)).replace('{k}', String(overview.liveCount)) }),
        js('div', { className: 'mt-ov-progress', children: [
          j('span', { className: 'mt-ov-label', children: t('ov.progress') }),
          js('div', { className: 'mt-segbar mt-ovbar', role: 'img', 'aria-label': t('ov.progress'), children: list.length === 0
            ? [j('i', { key: 'empty', className: 'mt-ov-seg-idle' })]
            : list.map((task) => j('i', {
              key: String(task.key ?? task.id),
              className: `mt-ov-seg-${ovBucketOf(task, doneIds)}`,
              title: `${String(task.code ?? task.id)} · ${stateLabel(task.state)}`,
            })) }),
        ] }),
        js('div', { className: 'mt-ov-legend', children: legend }),
        ovNarrativeText(overview, t) ? j('div', { className: 'mt-ov-note', children: ovNarrativeText(overview, t) }) : null,
      ] })
    }

    /**
     * 会话页团队视图（conversation.view 落点）——**只渲染真实账本数据**。
     *
     * CHG-107（用户：「这个团队视图怎么回事？」）：
     * 旧实现把**假对话**（几条写死的「你 21:12 …」+ 写死的团队名 / id / 计数 + 假 guest chips）
     * 直接画成了会话视图，而且「对话 / 团队视图」seg 只切按钮高亮、**不切内容**。
     *
     * 现在：团队名/id/状态/任务/成员/计数**全部来自 getBoard + listTeams**；
     * 没有团队就画空态；不再有任何演示样本。宿主的「对话 / 团队视图」切换器负责切视图，
     * 我们不再自己造一个假的 seg。
     */
    function MyTeamConversationView(props) {
      const { ctx, sessionId, t: tProp } = props ?? {}
      const t = tProp ?? ((k) => zh[k] ?? k)
      /* CHG-99（C13）：会话视图根（.mt-conv）也是表面根 */
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      const board = useConvBoard(props?.connection, sessionId)
      const team = board.team
      /* CHG-115：团队视图的三视图（看板 / 流程 / 依赖图）与任务详情抽屉——**只读**，写操作走面板 */
      const [convView, setConvView] = react.useState('board')
      const [openTaskId, setOpenTaskId] = react.useState(null)
      const memberNameOf = (id) => (board.members ?? []).find((member) => String(member.id) === String(id))?.instanceName ?? String(id)
      /* CHG-114：入口带层级——从团队视图进工作台落在**本团队的看板**（不是回全局库）。
       * 修的是「打开面板 / 输入框 chip 点了没反应」：旧实现调 `uiWorkspace.openPanel`，
       * 宿主没有这个方法（面板选择是 `ctx.layout.selectPanel`）。 */
      const openPanel = () => { openWorkbench(ctx, entryNavForTeam(team)) }
      /**
       * CHG-155（P2）：会话视图三视图的 `onOpen` 契约不一致——`BoardView` / `LanesView` 传**任务对象**，
       * 而 `DagView` 传的是**id 字符串**（`onOpen(task.id)`）。旧实现一律 `String(task.id)`，
       * 于是团队视图里双击依赖图卡片得到 `"undefined"`，打开一个不存在的任务详情。
       * 统一归一：两种入参都收；空 id 直接忽略（不制造假任务）。
       */
      const openConvTask = (target) => {
        const id = target && typeof target === 'object' ? target.id : target
        if (id === undefined || id === null || id === '') return
        setOpenTaskId(String(id))
      }
      const stat = (label, value) => js('div', { key: label, className: 'mt-conv-stat', children: [
        j('b', { children: board.loaded ? String(value) : '—' }),
        j('span', { children: label }),
      ] })
      const head = (title, sub) => js('div', { className: 'mt-conv-head', children: [
        j('span', { className: 'mt-team-mark', 'aria-hidden': true, children: '⬢' }),
        js('div', { className: 'mt-conv-title', children: [j('b', { children: title }), j('span', { children: sub })] }),
        j('button', { className: 'mt-btn mt-btn-sm', onClick: openPanel, children: t('conv.openPanel') }),
      ] })

      /* 空态：这个会话还没进团队模式 —— 明确说清楚，不画任何假数据 */
      if (!team) {
        /* CHG-180：整块空态居中（`.mt-conv-empty`）——空态不是文档，左对齐会显得只写了一半 */
        return js('div', { className: 'mt-conv mt-conv-empty', ...themeAttr, children: [
          head(t('conv.emptyTitle'), t('conv.emptySub')),
          js('div', { className: 'mt-conv-body', children: [
            j('p', { className: 'mt-hint', children: board.loaded ? t('conv.emptyBody') : t('state.loading') }),
            js('div', { className: 'mt-conv-cmd', children: [
              j('code', { children: '/myteam' }),
              j('span', { className: 'mt-hint', children: t('conv.emptyCmd') }),
            ] }),
            js('div', { className: 'mt-conv-stats', children: [
              stat(t('conv.stat.tasks'), 0),
              stat(t('conv.stat.live'), 0),
              stat(t('conv.stat.gates'), 0),
              stat(t('conv.stat.roles'), 0),
            ] }),
          ] }),
        ] })
      }

      return js('div', { className: 'mt-conv', ...themeAttr, children: [
        head(team.name || team.teamId, team.teamId + ' · ' + stateLabel(team.state) + ' · ' + board.members.length + ' 名成员'),
        /* 概览：四个真实计数（未加载时显示 —，不写死） */
        js('div', { className: 'mt-conv-stats', children: [
          stat(t('conv.stat.tasks'), board.tasks.length),
          stat(t('conv.stat.live'), board.live),
          stat(t('conv.stat.gates'), board.gates),
          stat(t('conv.stat.roles'), board.roles),
        ] }),
        /* CHG-157：团队总览卡——成员/已交付分数/消息 + 队长汇总 + 总进度分段条 + 等待前置叙述（未加载不渲染） */
        j(TeamOverviewCard, { t, tasks: board.rawTasks, members: board.members, messageCount: board.messageCount, loaded: board.loaded }),
        /* 任务：**同源三视图**（CHG-115）——看板 / 流程 / 依赖图，只读；点卡开同一个任务详情抽屉 */
        js('div', { className: 'mt-conv-section', children: [
          j('h4', { className: 'mt-conv-section-title', children: t('conv.section.tasks') }),
          !board.loaded
            ? j('div', { className: 'mt-hint', children: t('state.loading') })
            : (board.rawTasks ?? []).length === 0
              ? j('div', { className: 'mt-empty', children: t('conv.noTasks') })
              : js('div', { className: 'mt-conv-board', children: [
                js('div', { className: 'mt-viewlinks', role: 'group', 'aria-label': t('scope.label'), children: [
                  j('button', { className: convView === 'board' ? 'mt-seg mt-seg-active mt-vlink mt-vlink-on' : 'mt-seg mt-vlink', 'aria-pressed': convView === 'board', onClick: () => setConvView('board'), children: t('g6.tasks.viewBoard') }),
                  j('button', { className: convView === 'lanes' ? 'mt-seg mt-seg-active mt-vlink mt-vlink-on' : 'mt-seg mt-vlink', 'aria-pressed': convView === 'lanes', onClick: () => setConvView('lanes'), children: t('g6.tasks.viewFlow') }),
                  j('button', { className: convView === 'dag' ? 'mt-seg mt-seg-active mt-vlink mt-vlink-on' : 'mt-seg mt-vlink', 'aria-pressed': convView === 'dag', onClick: () => setConvView('dag'), children: t('g6.tasks.viewDag') }),
                ] }),
                convView === 'board'
                  ? j(BoardView, { t, tasks: board.rawTasks, memberName: memberNameOf, teamName: () => team.name || team.teamId, onOpen: openConvTask })
                  : convView === 'lanes'
                    ? j(LanesView, { t, tasks: board.rawTasks, members: board.members, onOpen: openConvTask })
                    : j(DagView, { t, tasks: board.rawTasks, onOpen: openConvTask, memberName: memberNameOf, teamName: () => team.name || team.teamId, dir: 'h' }),
              ] }),
        ] }),
        /* 成员：真实上岗名册（角色 · 实例 · 状态） */
        js('div', { className: 'mt-conv-section', children: [
          j('h4', { className: 'mt-conv-section-title', children: t('conv.section.members') }),
          board.members.length === 0
            ? j('div', { className: 'mt-empty', children: t('conv.noMembers') })
            : js('div', { className: 'mt-conv-members', children: board.members.map((member, index) => js('span', {
              key: String(member.memberId ?? member.roleId ?? index),
              className: 'mt-mini-chip',
              title: String(member.roleId ?? ''),
              children: [
                j('span', { className: 'mt-mavatar mt-mavatar-a' + ((index % 4) + 1), 'aria-hidden': true, children: String(member.roleId ?? '?').slice(0, 1) }),
                j('span', { children: String(member.instanceName ?? member.memberId ?? member.roleId ?? '—') }),
                j('span', { className: 'mt-contrib-chip-id', children: memberStateLabel(member.status) }),
              ],
            })) }),
        ] }),
        /* 输入框上方 composer.dock 状态 chip（真实计数；0 是真实值） */
        js('div', { className: 'mt-dockrow', children: [
          j('button', { className: 'mt-dockchip', onClick: openPanel, children: [
            j('span', { className: 'mt-dot', 'aria-hidden': true }),
            j('span', { children: t('g6.dock.running').replace('{n}', convCount(board.live, board.loaded)) }),
            j('span', { className: 'mt-vline', 'aria-hidden': true }),
            j('span', { children: t('g6.dock.gates').replace('{n}', convCount(board.gates, board.loaded)) }),
            j('span', { className: 'mt-go', 'aria-hidden': true, children: '→' }),
          ] }),
          j('span', { className: 'mt-spacer' }),
        ] }),
        js('div', { className: 'mt-composerhint', children: [
          j('span', { children: t('g6.conv.hint').replace('{cmd}', '/myteam+reviewer') }),
          j('span', { children: ' ' }),
          j('button', { className: 'mt-mini-link', onClick: openPanel, children: t('g6.conv.hintLink') }),
        ] }),
        /* CHG-115：点卡 → 同一个任务详情抽屉（只读；写操作走面板） */
        openTaskId ? j(TaskDetail, {
          api: makeApi(props?.connection, sessionId),
          t,
          teamId: team.teamId,
          taskId: openTaskId,
          readOnly: true,
          memberName: memberNameOf,
          teamName: () => team.name || team.teamId,
          members: board.members,
          refreshToken: 0,
          onClose: () => setOpenTaskId(null),
        }) : null,
      ] })
    }

    /** 四个 myteam_* 工具卡（tool.call.toolview 的 keyed 组件，按 wire 工具名精确注册） */
    /** myteam_submit_plan 工具卡（R34 / P0-5）：真实看板数据源，默认不再展示演示任务 */
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
