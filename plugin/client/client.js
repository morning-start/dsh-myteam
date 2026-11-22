/**
 * myteam 客户端插件：左栏「myteam」（全局库）+ 会话「团队视图」标签（团队视图工作台）。
 *
 * 两个作用域各一套导航轨，按 `design-v2/README.md` 的分域画：
 *   左侧栏入口 = 全局库（角色 / 工作流 / 蓝图 / 发布，只有人类确认后写）；
 *   会话标签页 = 当前团队视图的工作台（团队、任务、Run、定义副本、配置…）。
 *
 * 视觉完全取设计稿：`design-v2/myteam.css` 由宿主面板行按 `/__myteam/assets/design.css`
 * 供出（作用域已换成 `[data-myteam]`），本文件只写结构类名，**不写色值、不写字体**。
 *
 * 数据只有一条路：`POST /__myteam/<method>`（宿主面板行注册的 webServer 路由），
 * 准入走 Harness 自己的浏览器认证。没接通的页面如实说「通道未接入」，不画假数据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-myteam',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const METHOD_STATUS = 'status'
    const METHOD_OVERVIEW = 'overview'
    const METHOD_BOARD = 'board'
    const METHOD_TEAM = 'team'
    const METHOD_DEFINITIONS = 'definitions'
    const METHOD_MIGRATION = 'migration'

    // ───────────────────────── 样式表（设计稿） ─────────────────────────

    /** 设计稿样式表在页面里的挂载计数：两侧同时挂载只引一次，最后卸载时移除。 */
    const styleState = { count: 0, element: null }

    function mountDesignStyle() {
      if (typeof document === 'undefined') return () => {}
      styleState.count += 1
      if (styleState.element === null) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = new URL('__myteam/assets/design.css', document.baseURI).href
        link.dataset.myteamStyle = 'design'
        document.head.appendChild(link)
        styleState.element = link
      }
      return () => {
        styleState.count -= 1
        if (styleState.count > 0) return
        if (styleState.element !== null) styleState.element.remove()
        styleState.element = null
      }
    }

    // ───────────────────────── 数据 ─────────────────────────

    /** 宿主回包解包：门面回 `{ok,data}`，传输层也接受 `{ok,value}`。 */
    function unwrap(payload) {
      if (payload === null || typeof payload !== 'object') throw new Error('myteam 返回了非对象响应')
      if ('ok' in payload && payload.ok === false) {
        const error = payload.error ?? {}
        throw new Error(error.message ?? 'myteam 调用失败')
      }
      const value = 'value' in payload ? payload.value : payload
      if (value !== null && typeof value === 'object' && 'ok' in value) {
        if (value.ok === false) throw new Error(value.error?.message ?? 'myteam 返回失败')
        return value.data
      }
      return value
    }

    /** 调一个只读门面方法。 */
    async function callFacade(method, sessionId, query) {
      const url = new URL(`__myteam/${method}`, document.baseURI)
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, query: query ?? {} }),
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`myteam/${method} 返回了非 JSON（HTTP ${response.status}）`)
      }
      if (response.status === 401) throw new Error('会话未认证，请刷新页面后重试')
      if (response.status === 403) throw new Error(payload?.error?.message ?? '这个 Host 不在信任栅栏里')
      return unwrap(payload)
    }

    /**
     * 读一份面板数据。
     * @param sessionId - 当前会话；root scope 的面板没有它时不发请求（不编造身份）。
     * @param method - 门面方法名。
     * @param query - 方法参数。
     */
    function usePanelData(sessionId, method, query) {
      const [state, setState] = useState({ status: 'loading' })
      const generation = useRef(0)

      const load = useCallback(async () => {
        const mine = (generation.current += 1)
        if (!sessionId) {
          setState({ status: 'no-session' })
          return
        }
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }))
        try {
          const data = await callFacade(method, sessionId, query)
          if (mine !== generation.current) return
          setState({ status: 'ready', data })
        } catch (error) {
          if (mine !== generation.current) return
          setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, method, query === undefined ? '' : JSON.stringify(query)])

      useEffect(() => {
        void load()
      }, [load])

      return { ...state, reload: load }
    }

    // ───────────────────────── 小零件 ─────────────────────────

    /** 设计稿 icons.svg 里用到的那几个，路径原样搬过来（currentColor）。 */
    const ICONS = {
      grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
      board: ['M3 4h5v16H3z', 'M10 4h5v11h-5z', 'M17 4h4v7h-4z'],
      users: ['M9 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3 20a6 6 0 0 1 12 0', 'M16 5.5a3 3 0 0 1 0 5', 'M17 14a6 6 0 0 1 4 6'],
      flow: ['M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M18 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M12 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M8.5 6h7', 'M7 8.4l4 7.2', 'M17 8.4l-4 7.2'],
      layers: ['M12 3l8 4-8 4-8-4z', 'M4 12l8 4 8-4', 'M4 17l8 4 8-4'],
      book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5z', 'M8 7h7', 'M8 11h5'],
      db: ['M12 9c3.9 0 7-1.3 7-3s-3.1-3-7-3-7 1.3-7 3 3.1 3 7 3z', 'M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6', 'M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6'],
      clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
      sliders: ['M4 8h10', 'M18 8h2', 'M4 16h2', 'M10 16h10', 'M16 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M8 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
      refresh: ['M20 11a8 8 0 1 0-2 5.5', 'M20 5v6h-6'],
      more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
      terminal: ['M4 5h16v14H4z', 'M8 10l2.5 2.5L8 15', 'M13 15h3'],
    }

    function Icon(props) {
      const { name, small, tiny, title } = props
      const paths = ICONS[name] ?? ICONS.grid
      const className = tiny ? 'ic xs' : small ? 'ic s' : 'ic'
      return h(
        'svg',
        { className, viewBox: '0 0 24 24', 'aria-hidden': title === undefined ? 'true' : undefined, role: title === undefined ? undefined : 'img' },
        title === undefined ? null : h('title', null, title),
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    function Dot(props) {
      return h('span', { className: `dot ${props.tone ?? 'idle'}` })
    }

    function joinClass(...parts) {
      return parts.filter((part) => typeof part === 'string' && part.length > 0).join(' ')
    }

    /** 页面骨架：左导航轨 + 右内容区。设计稿里 `[data-slot="main"]` 的作用域就是这里。 */
    function Shell(props) {
      const { icon, initials, railTitle, nav, active, onSelect, pane } = props
      return h(
        'div',
        { className: 'wt', 'data-myteam': '' },
        h(
          'aside',
          { className: 'ir' },
          h('div', { className: 'team mono', title: railTitle }, initials),
          h('div', { className: 'line' }),
          h(
            'nav',
            { className: 'ir-nav', role: 'tablist' },
            nav.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': item.id === active,
                  className: joinClass('ri', item.id === active ? 'on' : ''),
                  title: item.hint ?? item.label,
                  onClick: () => onSelect(item.id),
                },
                h(Icon, { name: item.icon }),
                h('span', null, item.label),
                item.badge === undefined || item.badge === 0 ? null : h('i', { className: 'bdg' }),
              ),
            ),
          ),
        ),
        h('div', { className: 'pane' }, pane),
      )
    }

    /** 页头：标题 + 作用域 + 一行摘要 + 右侧操作。 */
    function PaneHeader(props) {
      const { title, scope, summary, onRefresh, busy } = props
      return h(
        'div',
        { className: 'hd' },
        h(
          'div',
          { className: 'hd-l' },
          h('h2', null, title, h('span', { className: 'scope' }, h('b', null, scope.kind), ` · ${scope.detail}`)),
          h('p', { className: 'sub' },
            summary.flatMap((item, index) =>
              index === 0
                ? [h('span', { key: `s${index}`, className: 'l' }, item)]
                : [h('i', { key: `sep${index}`, className: 'sep' }), h('span', { key: `s${index}`, className: 'l' }, item)])),
        ),
        h(
          'div',
          { className: 'hd-r' },
          onRefresh === undefined
            ? null
            : h('button', { type: 'button', className: 'ibtn', title: '刷新', onClick: onRefresh, 'aria-busy': busy === true },
                h(Icon, { name: 'refresh', small: true })),
        ),
      )
    }

    /** 状态条：一条细 chip 行。 */
    function StatusBar(props) {
      const { chips, note } = props
      return h(
        'div',
        { className: 'bar' },
        chips.map((chip, index) =>
          h('span', { key: index, className: joinClass('st-chip', chip.tone ?? '') }, chip.tone === undefined ? null : h(Dot, { tone: chip.tone }), chip.text),
        ),
        h('span', { className: 'grow' }),
        note === undefined ? null : h('span', { className: 'muted', style: { fontSize: 12 } }, note),
      )
    }

    /** 空态 / 不可用态：说明「为什么没有」，而不是留白。 */
    function Unavailable(props) {
      const { title, reason, hints } = props
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'box', style: { padding: '18px 16px' } },
          h('div', { className: 'rc-h' }, h(Dot, { tone: 'gate' }), h('span', { className: 'nm' }, title), h('span', { className: 'tag' }, '通道未接入')),
          h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, reason),
          hints === undefined || hints.length === 0
            ? null
            : h('div', { className: 'kws', style: { marginTop: 10 } }, hints.map((hint, index) => h('span', { key: index, className: 'kw' }, hint))),
        ),
      )
    }

    function Loading(props) {
      return h('div', { className: 'body pad' }, h('p', { className: 'muted', style: { fontSize: 12 } }, props.what ?? '加载中…'))
    }

    function Failure(props) {
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'banner plan' },
          h(Icon, { name: 'clock' }),
          h('div', { className: 'b-t' }, h('b', null, '读不到这份数据'), h('span', null, props.reason ?? '未知原因')),
          props.onRetry === undefined
            ? null
            : h('div', { className: 'acts' }, h('button', { type: 'button', className: 'btn primary', onClick: props.onRetry }, '重试')),
        ),
      )
    }

    function Data(props) {
      const { data, what, children, onRetry } = props
      if (data.status === 'no-session') {
        return h(Unavailable, {
          title: what,
          reason: '这个面板是全局的，宿主不给它绑定会话；在队长会话里打开「团队视图」标签才能读视图数据。',
        })
      }
      if (data.status === 'loading') return h(Loading, { what })
      if (data.status === 'error') return h(Failure, { reason: data.reason, onRetry: onRetry ?? data.reload })
      return children(data.data)
    }

    // ───────────────────────── 项目工作台 ─────────────────────────

    const PROJECT_NAV = [
      { id: 'overview', label: '概览', icon: 'grid', hint: '团队视图概览' },
      { id: 'tasks', label: '任务', icon: 'board', hint: '任务与看板' },
      { id: 'teams', label: '团队', icon: 'users', hint: '团队与成员' },
      { id: 'runs', label: '流程', icon: 'flow', hint: '工作流运行' },
      { id: 'definitions', label: '定义', icon: 'layers', hint: '项目定义副本' },
      { id: 'knowledge', label: '知识', icon: 'book', hint: '项目知识' },
      { id: 'memory', label: '记忆', icon: 'db', hint: '长期记忆' },
      { id: 'audit', label: '审计', icon: 'clock', hint: '审计' },
      { id: 'settings', label: '设置', icon: 'sliders', hint: '项目设置' },
    ]

    const TASK_COLUMNS = [
      { status: 'planned', label: '待规划', tone: 'idle' },
      { status: 'ready', label: '待认领', tone: 'idle' },
      { status: 'claimed', label: '已认领', tone: 'run' },
      { status: 'in_progress', label: '进行中', tone: 'run' },
      { status: 'blocked', label: '受阻', tone: 'fail' },
      { status: 'review', label: '待评审', tone: 'gate' },
      { status: 'done', label: '已完成', tone: 'run' },
      { status: 'cancelled', label: '已取消', tone: 'idle' },
    ]

    const TEAM_STATUS = { active: '进行中', draft: '草稿', archived: '已归档' }

    function counter(label, value, hint) {
      return h(
        'div',
        { className: 'rc', style: { gap: 4 } },
        h('div', { className: 'desc' }, label),
        h('div', { style: { fontWeight: 600, fontSize: 16, lineHeight: 1.2 } }, String(value)),
        hint === undefined ? null : h('div', { className: 'desc' }, hint),
      )
    }

    function TeamCards(props) {
      const { teams } = props
      if (teams.length === 0) {
        return h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, '这个项目还没有团队。')
      }
      return h(
        'div',
        { className: 'grid c2' },
        teams.map((team) =>
          h(
            'div',
            { key: team.id, className: 'rc' },
            h(
              'div',
              { className: 'rc-h' },
              h(Dot, { tone: team.status === 'active' ? 'run' : team.status === 'draft' ? 'gate' : 'idle' }),
              h('span', { className: 'nm' }, team.name),
              h('span', { className: 'tag' }, TEAM_STATUS[team.status] ?? team.status),
              h('span', { className: 'cnt' }, `${team.members} 名成员`),
            ),
            h(
              'div',
              { className: 'inst' },
              h('div', { className: 'i' },
                h('span', { className: 'nm muted' },
                  team.captain === null ? '暂无队长会话' : `队长会话 ${team.captain.sessionId.slice(0, 8)} · generation ${team.captain.generation}`)),
              h('div', { className: 'i' }, h(Dot, { tone: 'idle' }), h('span', { className: 'nm' }, `${team.tasks} 个任务`)),
            ),
          ),
        ),
      )
    }

    function OverviewScreen(props) {
      const { data, teams } = props
      const totals = data.totals ?? { all: 0, done: 0, blocked: 0, review: 0 }
      const attention = data.attention ?? { review: 0, blocked: 0, unknownEffects: 0 }
      const teamList = Array.isArray(data.teams) ? data.teams : teams
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'grid', style: { gridTemplateColumns: 'repeat(4,minmax(0,1fr))' } },
          counter('团队', teamList.length, `${teamList.filter((team) => team.status === 'active').length} 个进行中`),
          counter('任务', totals.all, `完成 ${totals.done}`),
          counter('待裁决', attention.review, '门禁或计划等人类结论'),
          counter('受阻', attention.blocked, `unknown effect ${attention.unknownEffects}`),
        ),
        h('div', { className: 'layer' }, h('b', null, '团队'), h('span', null, `${teamList.length} 个`), h('i', { className: 'rule' })),
        h(TeamCards, { teams: teamList }),
        h(
          'div',
          { className: 'layer' },
          h('b', null, '投影'),
          h('span', null, `projectSeq ${data.observedProjectSeq ?? '—'}`),
          h('i', { className: 'rule' }),
        ),
        h(
          'div',
          { className: 'box', style: { padding: '12px 14px' } },
          h('p', { className: 'muted', style: { margin: 0, fontSize: 12 } },
            `看板与概览来自同一份项目投影（graphRevision ${data.graphRevision ?? '—'}）。事件流、跨团队依赖与最近事件的读取端点尚未接入，本页只画已投影的部分。`),
        ),
      )
    }

    function TasksScreen(props) {
      const { data, onOpenTask } = props
      const columns = Array.isArray(data.columns) ? data.columns : []
      const byStatus = new Map(columns.map((column) => [column.status, column]))
      return h(
        'div',
        { className: 'body flat' },
        h(
          'div',
          { className: 'board' },
          TASK_COLUMNS.map((column) => {
            const source = byStatus.get(column.status)
            const tasks = source?.tasks ?? []
            return h(
              'section',
              { key: column.status, className: 'col' },
              h(
                'div',
                { className: 'col-h' },
                h(Dot, { tone: column.tone }),
                h('span', { className: 'nm' }, column.label),
                h('span', { className: 'n' }, String(source?.count ?? tasks.length)),
              ),
              h(
                'div',
                { className: 'col-b' },
                tasks.length === 0
                  ? h('p', { className: 'muted', style: { fontSize: 12, margin: '2px 0 0' } }, '空')
                  : tasks.map((task) =>
                      h(
                        'button',
                        { key: task.id, type: 'button', className: 'card', onClick: () => onOpenTask(task) },
                        h(
                          'div',
                          { className: 'top' },
                          h('span', { className: 'mono' }, task.id),
                          h('span', { className: 'sp' }),
                          task.ownerTeamName === null
                            ? h('span', { className: 'tm' }, '未指派')
                            : h('span', { className: 'tm', title: task.ownerTeamName }, task.ownerTeamName.slice(0, 2)),
                        ),
                        h('div', { className: 't' }, task.title),
                        h(
                          'div',
                          { className: 'meta' },
                          task.blockedBy.length === 0
                            ? h('span', { className: 'mt' }, task.attemptId === null ? '无活跃尝试' : `尝试 ${task.attemptId.slice(0, 6)}`)
                            : h('span', { className: 'mt' }, `${task.blockedBy.length} 项上游未完成`),
                        ),
                      ),
                    ),
              ),
            )
          }),
        ),
      )
    }

    function TaskDetail(props) {
      const { taskId, sessionId, onBack } = props
      const detail = usePanelData(sessionId, 'task', { taskId })
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'layer' },
          h('button', { type: 'button', className: 'btn', onClick: onBack }, '返回看板'),
          h('span', null, taskId),
          h('i', { className: 'rule' }),
        ),
        h(Data, { data: detail, what: '任务详情' }, (data) =>
          h(
            'div',
            { className: 'box', style: { padding: '14px 16px' } },
            h('div', { className: 'rc-h' }, h(Dot, { tone: data.task.status === 'blocked' ? 'fail' : 'run' }), h('span', { className: 'nm' }, data.task.title), h('span', { className: 'tag' }, data.task.status)),
            h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } },
              `主责团队 ${data.team?.name ?? '未指派'} · 依赖 ${data.dependencies.length} · 下游 ${data.dependents.length} · 证据 ${data.evidence.length}`),
            data.verdict === null
              ? null
              : h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, `门禁结论：${data.verdict.verdict ?? data.verdict.status ?? '已记录'}`),
            data.dependencies.length === 0
              ? null
              : h('div', { className: 'kws', style: { marginTop: 10 } },
                  data.dependencies.map((dependency) => h('span', { key: dependency.taskId, className: 'kw' }, `${dependency.taskId} ${dependency.status ?? '缺失'}`))),
          ),
        ),
      )
    }

    function TeamsScreen(props) {
      const { overview, sessionId } = props
      const teams = overview.data?.teams ?? []
      const [selected, setSelected] = useState(null)
      const detail = usePanelData(selected === null ? undefined : sessionId, 'team', selected === null ? {} : { teamId: selected })
      return h(
        'div',
        { className: 'body pad' },
        h(TeamCards, { teams }),
        selected === null
          ? h('p', { className: 'muted', style: { margin: '12px 0 0', fontSize: 12 } }, '点一个团队查看名册与角色。')
          : h(
              'div',
              { className: 'box', style: { padding: '14px 16px', marginTop: 12 } },
              h(Data, { data: detail, what: '团队名册' }, (data) =>
                h(
                  'div',
                  null,
                  h('div', { className: 'rc-h' }, h(Dot, { tone: 'run' }), h('span', { className: 'nm' }, data.team.name), h('span', { className: 'tag' }, TEAM_STATUS[data.team.status] ?? data.team.status)),
                  h('div', { className: 'kws', style: { marginTop: 10 } },
                    data.members.length === 0
                      ? h('span', { className: 'kw' }, '暂无成员')
                      : data.members.map((member) => h('span', { key: member.id, className: 'kw' }, `${member.roleId} · ${member.status}`))),
                  h('p', { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } },
                    `任务 ${data.tasks.length} 个 · 可用角色 ${data.roles.length} 个 · 配置 ${data.config === null ? '未落盘' : `revision ${data.config.revision ?? '—'}`}`),
                ),
              ),
            ),
        teams.map((team) =>
          h(
            'button',
            { key: team.id, type: 'button', className: joinClass('btn', selected === team.id ? 'primary' : ''), style: { marginTop: 8, marginRight: 6 }, onClick: () => setSelected(team.id) },
            team.name,
          ),
        ),
      )
    }

    function definitionChips(item) {
      const chips = []
      if (item.archived === true) chips.push('已归档')
      if (item.localChanged === true) chips.push('可发布')
      if (item.updateAvailable === true) chips.push('有更新')
      if (item.updateAvailable === null) chips.push('上游未判定')
      if (chips.length === 0) chips.push('一致')
      return chips
    }

    function DefinitionsScreen(props) {
      const { data } = props
      const items = Array.isArray(data.items) ? data.items : []
      return h(
        'div',
        { className: 'body pad' },
        items.length === 0
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: 0 } }, '这个项目还没有定义副本。')
          : h(
              'div',
              { className: 'list' },
              items.map((item) =>
                h(
                  'div',
                  { key: `${item.kind}:${item.id}`, className: 'item' },
                  h(
                    'div',
                    { className: 'l' },
                    h('div', { className: 't' }, `${item.name} `, h('span', { className: 'muted' }, `${item.kind} · ${item.id}`)),
                    h('div', { className: 's' },
                      h('span', { className: 'mono' }, `rev ${item.revision}`),
                      h('span', { className: 'mono' }, `base ${String(item.baseHash).slice(0, 8)}`),
                      h('span', { className: 'mono' }, `head ${String(item.contentHash).slice(0, 8)}`)),
                  ),
                  h('div', { className: 'r' }, definitionChips(item).map((chip) => h('span', { key: chip, className: 'st-chip' }, chip))),
                ),
              ),
            ),
      )
    }

    function MigrationScreen(props) {
      const { data } = props
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'banner plan' },
          h(Icon, { name: 'clock' }),
          h('div', { className: 'b-t' }, h('b', null, data.verdict === 'ready' ? '可以迁移' : '迁移被拦下'), h('span', null, data.headline ?? '')),
        ),
        h('pre', { className: 'box mono', style: { padding: '12px 14px', marginTop: 12, whiteSpace: 'pre-wrap', fontSize: 12 } }, data.markdown ?? ''),
      )
    }

    const PROJECT_MISSING = {
      runs: {
        title: '工作流运行',
        reason: 'v2 还只有 status / overview / board / task / team / definitions / migration 七个只读端点，没有 Run 列表与 Run 详情。',
        hints: ['Run 的事件已经写进账本', '端点接上后这一页直接读同一份投影'],
      },
      knowledge: {
        title: '项目知识',
        reason: '知识条目已经在投影里（counts.knowledge 能读到数量），但还没有把条目、证据与修订读出来的端点。',
        hints: ['counts.knowledge 来自 status'],
      },
      memory: {
        title: '长期记忆',
        reason: '记忆 bank 属于 SQLite 侧，面板端点还没接。',
        hints: ['memory 不进全局库'],
      },
      audit: {
        title: '审计',
        reason: '审计要按批次读事件流与 Effect 三态，v2 还没有这个端点。',
        hints: ['看板与概览都标了 projectSeq', '事件流端点接上后按批次翻页'],
      },
      settings: {
        title: '项目设置',
        reason: '配置链（四层合并、硬上限、写者路径）目前在 host 内部，没有只读端点。',
        hints: ['teamView.config 能读到单个团队的生效配置'],
      },
    }

    function ProjectView(props) {
      const { sessionId } = props
      const [tab, setTab] = useState('overview')
      const [taskId, setTaskId] = useState(null)

      useEffect(() => {
        return mountDesignStyle()
      }, [])

      const status = usePanelData(sessionId, METHOD_STATUS)
      const overview = usePanelData(sessionId, METHOD_OVERVIEW)
      const board = usePanelData(sessionId, METHOD_BOARD)
      const definitions = usePanelData(sessionId, METHOD_DEFINITIONS)
      const migration = usePanelData(tab === 'migration' ? sessionId : undefined, METHOD_MIGRATION)

      const projectName = status.data?.name ?? overview.data?.name ?? '未命名'
      const counts = status.data?.counts ?? {}
      const scope = { kind: '团队视图', detail: PROJECT_NAV.find((item) => item.id === tab)?.label ?? tab }
      const summary = [
        `${overview.data?.teams?.length ?? counts.teams ?? 0} 个团队`,
        `${counts.tasks ?? overview.data?.totals?.all ?? 0} 个任务`,
        `${counts.runs ?? 0} 个 Run`,
        `${overview.data?.attention?.review ?? 0} 件待确认`,
      ]
      const chips = [
        { text: projectName, tone: undefined },
        { text: `projectSeq ${status.data?.observedProjectSeq ?? overview.data?.observedProjectSeq ?? '—'}` },
        { text: `graphRevision ${status.data?.graphRevision ?? board.data?.graphRevision ?? '—'}` },
        { text: `configRevision ${status.data?.configRevision ?? '—'}` },
      ]

      const onRefresh = () => {
        void status.reload()
        void overview.reload()
        void board.reload()
        void definitions.reload()
        if (tab === 'migration') void migration.reload()
      }

      let body
      if (taskId !== null) {
        body = h(TaskDetail, { taskId, sessionId, onBack: () => setTaskId(null) })
      } else if (tab === 'overview') {
        body = h(Data, { data: overview, what: '项目概览' }, (data) => h(OverviewScreen, { data }))
      } else if (tab === 'tasks') {
        body = h(Data, { data: board, what: '任务看板' }, (data) => h(TasksScreen, { data, onOpenTask: (task) => setTaskId(task.id) }))
      } else if (tab === 'teams') {
        body = h(Data, { data: overview, what: '团队' }, () => h(TeamsScreen, { overview, sessionId }))
      } else if (tab === 'definitions') {
        body = h(Data, { data: definitions, what: '项目定义副本' }, (data) => h(DefinitionsScreen, { data }))
      } else if (tab === 'migration') {
        body = h(Data, { data: migration, what: '迁移' }, (data) => h(MigrationScreen, { data }))
      } else {
        const missing = PROJECT_MISSING[tab] ?? { title: tab, reason: '这个页面还没有端点。' }
        body = h(Unavailable, missing)
      }

      return h(Shell, {
        initials: String(projectName).slice(0, 2),
        railTitle: `团队视图 ${projectName}`,
        nav: PROJECT_NAV,
        active: tab,
        onSelect: (next) => {
          setTaskId(null)
          setTab(next)
        },
        pane: [
          h(PaneHeader, { title: projectName, scope, summary, onRefresh, busy: status.status === 'loading' }),
          h(StatusBar, { chips, note: '只读投影 · 同一份事件日志' }),
          body,
        ],
      })
    }

    // ───────────────────────── 全局库（左栏入口） ─────────────────────────

    const GLOBAL_NAV = [
      { id: 'overview', label: '概览', icon: 'grid', hint: '全局库概览' },
      { id: 'roles', label: '角色', icon: 'users', hint: '角色定义' },
      { id: 'workflows', label: '工作流', icon: 'flow', hint: '工作流定义' },
      { id: 'blueprints', label: '蓝图', icon: 'layers', hint: '团队蓝图' },
      { id: 'publish', label: '发布', icon: 'book', hint: '发布与全局审计' },
    ]

    const GLOBAL_MISSING = {
      overview: '全局库要读 $DSH_HOME/myteam 下的角色 / 工作流 / 蓝图文件与 global-operations.jsonl；v2 的面板端点只读项目，没有全局库读取面。',
      roles: 'RoleDefinition 的全局库读取端点还没接；项目里的定义副本可以在「定义」里看到。',
      workflows: 'WorkflowDefinition 的全局库读取端点还没接；项目里的定义副本可以在「定义」里看到。',
      blueprints: 'TeamBlueprint 的全局库读取端点还没接。',
      publish: '发布确认与 global-operations.jsonl 审计端点是人类专属写路径，还没接。',
    }

    function GlobalPanel(props) {
      const { ctx } = props
      const [tab, setTab] = useState('overview')

      useEffect(() => {
        return mountDesignStyle()
      }, [])

      const back = useCallback(() => {
        try {
          ctx?.layout?.selectPanel?.(null)
        } catch (error) {
          console.error('[myteam] 回到对话失败', error)
        }
      }, [ctx])

      const navItem = GLOBAL_NAV.find((item) => item.id === tab) ?? GLOBAL_NAV[0]

      return h(Shell, {
        initials: 'mt',
        railTitle: '全局库 myteam',
        nav: GLOBAL_NAV,
        active: tab,
        onSelect: setTab,
        pane: [
          h(PaneHeader, {
            title: '全局库',
            scope: { kind: '全局', detail: navItem.label },
            summary: ['$DSH_HOME/myteam', '只有人类确认后写', '项目侧在会话「团队视图」标签'],
            onRefresh: undefined,
          }),
          h(StatusBar, {
            chips: [{ text: '只读', tone: undefined }, { text: '作用域 全局' }, { text: '设计 design-v2' }],
            note: '全局资产与项目运行态分开',
          }),
          h(
            'div',
            { className: 'body pad' },
            h(Unavailable, {
              title: navItem.label,
              reason: GLOBAL_MISSING[tab] ?? GLOBAL_MISSING.overview,
              hints: ['左侧入口 = 全局库', '会话「团队视图」标签 = 当前团队视图'],
            }),
            h('div', { className: 'layer' }, h('b', null, '回到对话'), h('i', { className: 'rule' })),
            h('button', { type: 'button', className: 'btn', onClick: back }, '回到对话'),
          ),
        ],
      })
    }

    // ───────────────────────── 注册 ─────────────────────────

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'myteam',
                order: 20,
                label: () => '团队视图',
                inject: (sessionId) => ({ sessionId }),
              },
              ProjectView,
            ),
          ),
        'myteam: conversation view',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'myteam',
                order: 50,
                label: () => 'myteam',
              },
              function MyTeamRailIcon(properties) {
                const size = properties.size ?? 18
                return h(
                  'svg',
                  {
                    width: size,
                    height: size,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.6,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    'aria-hidden': 'true',
                  },
                  h('path', { d: 'M3 4h5v16H3z' }),
                  h('path', { d: 'M10 4h5v11h-5z' }),
                  h('path', { d: 'M17 4h4v7h-4z' }),
                )
              },
            ),
          ),
        'myteam: sidebar entry',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: 'myteam',
                inject: () => ({ ctx }),
              },
              GlobalPanel,
            ),
          ),
        'myteam: global panel',
      )

      return ['conversation.view', 'sidebar.panellist', 'main']
    }

    return { apply, inject: ['slots'] }
  },
})
