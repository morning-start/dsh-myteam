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

    /** 调一个写通道方法。`direct` 类一次提交（带 `confirm: true`）。 */
    async function callWrite(method, sessionId, body) {
      const url = new URL(`__myteam/write/${method}`, document.baseURI)
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`myteam/write/${method} 返回了非 JSON（HTTP ${response.status}）`)
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
     * @param options - `allowNoSession`：全局库方法不属任何项目，不带会话也要读。
     */
    function usePanelData(sessionId, method, query, options) {
      const allowNoSession = options !== undefined && options.allowNoSession === true
      const [state, setState] = useState({ status: 'loading' })
      const generation = useRef(0)

      const load = useCallback(async () => {
        const mine = (generation.current += 1)
        if (!sessionId && !allowNoSession) {
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

    /**
     * 页面骨架：左导航轨 + 右内容区。
     *
     * 两层根：外层带 `[data-myteam]`（样式作用域 + 主题变量落点），内层才是设计稿的
     * `.wt`。设计稿的选择器都写成 `[data-slot="main"] x` → 服务时换成
     * `[data-myteam] x`，**是后代选择器**：把 `data-myteam` 和 `.wt` 放在同一个节点上，
     * `[data-myteam] .wt` 就选不到这个骨架，`.wt` 的字号、行高、字族全失效（回落到宿主
     * 的 16px，导航轨和标题都被撑大）。所以必须是「作用域节点 > .wt」这个结构。
     */
    function Shell(props) {
      const { icon, initials, railTitle, nav, active, onSelect, pane } = props
      return h(
        'div',
        { 'data-myteam': '' },
        h(
          'div',
          { className: 'wt' },
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
        ),
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

    const TEAM_STATUS = { active: '进行中', draft: '草稿', archived: '已归档', disbanded: '已解散' }

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
          { className: 'grid c4' },
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
            `看板、审计、设置读的是同一份项目投影（graphRevision ${data.graphRevision ?? '—'}）；跨团队依赖还没有单独成图，这一页只画已投影的团队与计数。`),
        ),
      )
    }

    /**
     * 新建任务表单（`taskCreate`，直接确认类写动作）。
     *
     * 为什么不弹模态：宿主没给我们弹窗层，塞一个自造遮罩会盖住会话。
     * 就地展开一块表单，失败原因留在表单里，比 toast 更容易看清。
     */
    function NewTaskForm(props) {
      const { sessionId, teams, onDone, onCancel } = props
      const [title, setTitle] = useState('')
      const [acceptance, setAcceptance] = useState('')
      const [teamId, setTeamId] = useState(teams.length > 0 ? teams[0].id : '')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const submit = async () => {
        if (busy) return
        if (title.trim().length === 0) {
          setProblem('标题不能为空')
          return
        }
        if (teamId.length === 0) {
          setProblem('先选一个团队：任务必须有主责团队')
          return
        }
        setBusy(true)
        setProblem(null)
        try {
          await callWrite('taskCreate', sessionId, {
            confirm: true,
            params: {
              teamId,
              title: title.trim(),
              acceptance: acceptance
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            },
          })
          onDone()
        } catch (error) {
          setProblem(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'box', style: { padding: '14px 16px', margin: '0 16px 12px' } },
        h(
          'div',
          { className: 'kws' },
          teams.map((team) =>
            h(
              'button',
              {
                key: team.id,
                type: 'button',
                className: joinClass('btn', team.id === teamId ? 'primary' : ''),
                style: { marginRight: 6 },
                onClick: () => setTeamId(team.id),
              },
              team.name,
            ),
          ),
        ),
        teams.length === 0
          ? h(
              'p',
              { className: 'muted', style: { fontSize: 12, margin: '6px 0 0' } },
              '这个项目还没有团队：任务必须属于一个团队，先在会话里让队长建队。',
            )
          : null,
        h('input', {
          type: 'text',
          className: 'box',
          placeholder: '任务标题',
          value: title,
          style: { display: 'block', width: '100%', marginTop: 10, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setTitle(event.target.value),
        }),
        h('textarea', {
          className: 'box mono',
          placeholder: '一行一条验收标准',
          value: acceptance,
          rows: 3,
          style: { display: 'block', width: '100%', marginTop: 8, padding: '8px 10px', fontSize: 12 },
          onChange: (event) => setAcceptance(event.target.value),
        }),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没建成：${problem}`),
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h(
            'button',
            { type: 'button', className: 'btn primary', disabled: busy === true, onClick: () => void submit() },
            busy === true ? '创建中…' : '创建',
          ),
          h('button', { type: 'button', className: 'btn', style: { marginLeft: 8 }, onClick: onCancel }, '取消'),
        ),
      )
    }

    function TasksScreen(props) {
      const { data, teams, sessionId, onOpenTask, onCreated } = props
      const [creating, setCreating] = useState(false)
      const columns = Array.isArray(data.columns) ? data.columns : []
      const byStatus = new Map(columns.map((column) => [column.status, column]))
      return h(
        'div',
        { className: 'body flat' },
        h(
          'div',
          { className: 'bar', style: { padding: '0 16px' } },
          h(
            'button',
            { type: 'button', className: joinClass('btn', creating === true ? 'primary' : ''), onClick: () => setCreating(creating !== true) },
            creating === true ? '收起' : '新任务',
          ),
          h('span', { className: 'grow' }),
          h('span', { className: 'muted', style: { fontSize: 12 } }, `共 ${data.totals?.all ?? 0} 个任务`),
        ),
        creating === true
          ? h(NewTaskForm, {
              sessionId,
              teams: teams ?? [],
              onDone: () => {
                setCreating(false)
                if (onCreated !== undefined) onCreated()
              },
              onCancel: () => setCreating(false),
            })
          : null,
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

    // ───────────────────── 写交互：两段确认 / 门禁裁决 ─────────────────────

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** 预览返回的 impact 是各动作自己的形状；这里只翻成人话，不假设字段齐全。 */
    function impactLines(impact) {
      if (impact === null || typeof impact !== 'object') return []
      const list = (value) => (Array.isArray(value) ? value : [])
      const lines = []
      if (list(impact.members).length > 0) lines.push(`成员 ${list(impact.members).length} 名：${list(impact.members).join('、')}`)
      if (list(impact.activeAttempts).length > 0) lines.push(`在途 Attempt ${list(impact.activeAttempts).length} 个`)
      if (list(impact.unfinishedTasks).length > 0) lines.push(`未完成任务 ${list(impact.unfinishedTasks).length} 个`)
      if (list(impact.unsettledEffects).length > 0) lines.push(`未结算 Effect ${list(impact.unsettledEffects).length} 个`)
      if (impact.fromSessionId !== undefined || impact.toSessionId !== undefined) {
        lines.push(`队长会话 ${impact.fromSessionId ?? '（无）'} → ${impact.toSessionId ?? '—'}`)
      }
      if (impact.nextGeneration !== undefined) lines.push(`generation → ${impact.nextGeneration}`)
      lines.push('确认后不可撤销；令牌只认这一次，影响面变了会要求重新看')
      return lines
    }

    /**
     * 两段确认动作（`token` 类写方法）。
     *
     * 第一次点击只**预览**，拿回影响面与一次性令牌；确认按钮才会执行。
     * 这不是啰嗦：预览和确认各是一次请求，中间任何状态变化都会让服务端拒绝，
     * 才有「你确认的就是你看到的那件事」。
     */
    function TokenAction(props) {
      const { label, method, sessionId, params, onDone } = props
      const [stage, setStage] = useState('idle')
      const [preview, setPreview] = useState(null)
      const [problem, setProblem] = useState(null)

      const begin = async () => {
        setStage('busy')
        setProblem(null)
        try {
          const result = await callWrite(method, sessionId, { params })
          setPreview(result)
          setStage('preview')
        } catch (error) {
          setProblem(messageOf(error))
          setStage('failed')
        }
      }

      const commit = async () => {
        setStage('busy')
        setProblem(null)
        try {
          await callWrite(method, sessionId, {
            params,
            action: 'confirm',
            confirmation: preview.confirmation,
            reason: '面板确认',
          })
          setPreview(null)
          setStage('idle')
          if (onDone !== undefined) onDone()
        } catch (error) {
          setProblem(messageOf(error))
          setStage('failed')
        }
      }

      const busy = stage === 'busy'
      return h(
        'div',
        { style: { marginTop: 10 } },
        preview === null
          ? h(
              'button',
              { type: 'button', className: 'btn', disabled: busy, onClick: () => void begin() },
              busy ? '读影响面…' : label,
            )
          : h(
              'div',
              { className: 'box', style: { padding: '12px 14px' } },
              h(
                'div',
                { className: 'rc-h' },
                h(Dot, { tone: 'gate' }),
                h('span', { className: 'nm' }, preview.summary ?? label),
                h('span', { className: 'tag' }, '待确认'),
              ),
              impactLines(preview.impact).map((line) =>
                h('p', { key: line, className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, line),
              ),
              h(
                'div',
                { className: 'acts', style: { marginTop: 10 } },
                h(
                  'button',
                  { type: 'button', className: 'btn primary', disabled: busy, onClick: () => void commit() },
                  busy ? '提交中…' : '确认执行',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn',
                    style: { marginLeft: 8 },
                    onClick: () => {
                      setPreview(null)
                      setStage('idle')
                    },
                  },
                  '取消',
                ),
              ),
            ),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, `没成功：${problem}`),
      )
    }

    /** 队长接管：先填目标会话，再走两段确认。 */
    function TakeoverBox(props) {
      const { teamId, sessionId, onDone } = props
      const [toSessionId, setToSessionId] = useState('')
      return h(
        'div',
        { style: { marginTop: 8 } },
        h('input', {
          type: 'text',
          className: 'box',
          placeholder: '新队长会话 id',
          value: toSessionId,
          style: { display: 'block', width: '100%', padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setToSessionId(event.target.value),
        }),
        toSessionId.trim().length === 0
          ? h(
              'p',
              { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } },
              '填一个会话 id 才能预览接管：接管会把队长世代 +1，旧会话失去发令权。',
            )
          : h(TokenAction, {
              label: '预览接管',
              method: 'captainTakeover',
              sessionId,
              params: { teamId, toSessionId: toSessionId.trim() },
              onDone,
            }),
      )
    }

    /**
     * 门禁裁决（`gateVerdict`，直接确认类）。
     *
     * 只在任务处于 `review` 时出现：裁决绑定当前 Attempt，别的状态下提交会被域拒绝，
     * 与其让用户点了才知道，不如不显示。
     */
    function VerdictForm(props) {
      const { taskId, attemptId, sessionId, onDone } = props
      const [outcome, setOutcome] = useState('pass')
      const [command, setCommand] = useState('')
      const [exitCode, setExitCode] = useState('0')
      const [summary, setSummary] = useState('')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const submit = async () => {
        if (busy) return
        if (attemptId === null || attemptId === undefined) {
          setProblem('这个任务还没有活跃尝试：先认领再裁决')
          return
        }
        if (command.trim().length === 0) {
          setProblem('至少写一条检查命令：裁决必须能复查')
          return
        }
        const code = exitCode.trim() === '' ? null : Number(exitCode)
        if (code !== null && !Number.isFinite(code)) {
          setProblem('退出码要填数字，或留空')
          return
        }
        setBusy(true)
        setProblem(null)
        try {
          await callWrite('gateVerdict', sessionId, {
            confirm: true,
            params: {
              taskId,
              attemptId,
              outcome,
              checks: [{ command: command.trim(), exitCode: code, summary: summary.trim() }],
              evidence: [{ kind: 'command', ref: command.trim() }],
            },
          })
          onDone()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'box', style: { padding: '12px 14px', marginTop: 12 } },
        h('div', { className: 'rc-h' }, h(Dot, { tone: 'gate' }), h('span', { className: 'nm' }, '门禁裁决'), h('span', { className: 'tag' }, '写进账本 · 不可撤销')),
        h(
          'div',
          { className: 'kws', style: { marginTop: 10 } },
          ['pass', 'fail', 'blocked'].map((value) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                className: joinClass('btn', value === outcome ? 'primary' : ''),
                style: { marginRight: 6 },
                onClick: () => setOutcome(value),
              },
              value === 'pass' ? '通过' : value === 'fail' ? '不通过' : '受阻',
            ),
          ),
        ),
        h('input', {
          type: 'text',
          className: 'box mono',
          placeholder: '检查命令（必填，例如 node --test）',
          value: command,
          style: { display: 'block', width: '100%', marginTop: 10, padding: '8px 10px', fontSize: 12 },
          onChange: (event) => setCommand(event.target.value),
        }),
        h('input', {
          type: 'text',
          className: 'box mono',
          placeholder: '退出码（留空表示未知）',
          value: exitCode,
          style: { display: 'block', width: '100%', marginTop: 8, padding: '8px 10px', fontSize: 12 },
          onChange: (event) => setExitCode(event.target.value),
        }),
        h('input', {
          type: 'text',
          className: 'box',
          placeholder: '一句结论（可选）',
          value: summary,
          style: { display: 'block', width: '100%', marginTop: 8, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setSummary(event.target.value),
        }),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, `没提交：${problem}`),
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h(
            'button',
            { type: 'button', className: 'btn primary', disabled: busy === true, onClick: () => void submit() },
            busy === true ? '提交中…' : '提交裁决',
          ),
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
            data.task.status === 'review'
              ? h(VerdictForm, {
                  taskId,
                  attemptId: data.attempt === null || data.attempt === undefined ? null : data.attempt.id,
                  sessionId,
                  onDone: () => void detail.reload(),
                })
              : h('p', { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } },
                  `裁决只在任务处于「待评审」时可用（当前 ${data.task.status}）。`),
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
        selected === null
          ? null
          : h(
              'div',
              { style: { marginTop: 12 } },
              h('p', { className: 'muted', style: { margin: '0 0 4px', fontSize: 12 } }, '人类专属动作（先看影响面，再凭一次性令牌确认）'),
              h(TokenAction, {
                label: '解散团队',
                method: 'teamDisband',
                sessionId,
                params: { teamId: selected },
                onDone: () => {
                  void detail.reload()
                  if (props.onChanged !== undefined) props.onChanged()
                },
              }),
              h(TakeoverBox, {
                teamId: selected,
                sessionId,
                onDone: () => {
                  void detail.reload()
                  if (props.onChanged !== undefined) props.onChanged()
                },
              }),
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
      const { data, sessionId, onChanged } = props
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
                  h('div', { className: 'r' },
                    definitionChips(item).map((chip) => h('span', { key: chip, className: 'st-chip' }, chip)),
                    item.archived === true
                      ? null
                      : h(TokenAction, {
                          label: '发布',
                          method: 'definitionPublish',
                          sessionId,
                          params: { kind: item.kind, id: item.id },
                          onDone: onChanged,
                        })),
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

    // ───────────────────── 运行 / 知识 / 记忆 / 审计 / 设置 ─────────────────────
    //
    // 这五屏都只读同一份投影或同一个记忆库；没有数据时给一句「为什么空」，
    // 而不是画占位卡片冒充有数据。

    const RUN_STATUS = { active: '进行中', completed: '已完成', cancelled: '已取消' }

    function ListPane(props) {
      return h(
        'div',
        { className: 'body pad' },
        props.items.length === 0
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: 0 } }, props.empty)
          : h('div', { className: 'list' }, props.children),
        props.footer ?? null,
      )
    }

    function RunsScreen(props) {
      const items = Array.isArray(props.data.items) ? props.data.items : []
      return h(
        ListPane,
        { items, empty: '还没有工作流运行。实例化一个工作流后，Run 与它的任务图会一起写进账本。' },
        items.map((run) =>
          h(
            'div',
            { key: run.id, className: 'item' },
            h(
              'div',
              { className: 'l' },
              h('div', { className: 't' }, run.workflowId, ' ', h('span', { className: 'muted' }, run.id)),
              h(
                'div',
                { className: 's' },
                h('span', { className: 'mono' }, `rev ${run.revision}`),
                h('span', { className: 'mono' }, `定义 rev ${run.workflowRevision}`),
                h('span', { className: 'mono' }, `完成规则 rev ${run.completionRevision}`),
                h('span', { className: 'mono' }, `${run.taskCount} 个任务`),
              ),
            ),
            h('div', { className: 'r' }, h('span', { className: 'st-chip' }, RUN_STATUS[run.status] ?? run.status)),
          ),
        ),
      )
    }

    function KnowledgeScreen(props) {
      const items = Array.isArray(props.data.items) ? props.data.items : []
      return h(
        ListPane,
        { items, empty: '这个项目还没有知识条目。成员提出、队长采纳后会写进账本。' },
        items.map((entry) =>
          h(
            'div',
            { key: entry.id, className: 'item' },
            h(
              'div',
              { className: 'l' },
              h('div', { className: 't' }, entry.title),
              h(
                'div',
                { className: 's' },
                h('span', { className: 'mono' }, `rev ${entry.revision}`),
                h('span', { className: 'mono' }, `证据 ${Array.isArray(entry.evidence) ? entry.evidence.length : 0} 条`),
                entry.supersedes === null || entry.supersedes === undefined
                  ? null
                  : h('span', { className: 'mono' }, `取代 ${entry.supersedes}`),
              ),
              h('div', { className: 's' }, String(entry.body ?? '').slice(0, 160)),
            ),
            h('div', { className: 'r' }, h('span', { className: 'st-chip' }, String(entry.status))),
          ),
        ),
      )
    }

    function MemoryScreen(props) {
      const data = props.data
      const banks = Array.isArray(data.banks) ? data.banks : []
      const entries = Array.isArray(data.entries) ? data.entries : []
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      if (data.exists !== true) {
        return h(
          'div',
          { className: 'body pad' },
          h(
            'p',
            { className: 'muted', style: { fontSize: 12, margin: 0 } },
            `这个工作区还没有记忆库（${data.file ?? 'myteam.db'} 未创建）。记忆只在成员真正写入后才出现。`,
          ),
        )
      }
      return h(
        ListPane,
        {
          items: entries,
          empty: '记忆库是空的。',
          footer:
            warnings.length === 0
              ? null
              : h('p', { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } }, `读取告警：${warnings.join(' · ')}`),
        },
        [
          h(
            'div',
            { key: 'banks', className: 'kws', style: { marginBottom: 10 } },
            banks.length === 0
              ? h('span', { className: 'kw' }, '没有 bank')
              : banks.map((bank) =>
                  h('span', { key: bank.bankId, className: 'kw' }, `${bank.bankId} · ${bank.live}/${bank.total}`),
                ),
          ),
          ...entries.map((entry) =>
            h(
              'div',
              { key: entry.id, className: 'item' },
              h(
                'div',
                { className: 'l' },
                h('div', { className: 't' }, String(entry.text ?? '').slice(0, 120)),
                h(
                  'div',
                  { className: 's' },
                  h('span', { className: 'mono' }, entry.bankId),
                  h('span', { className: 'mono' }, `rev ${entry.revision}`),
                  (Array.isArray(entry.tags) ? entry.tags : []).map((tag) => h('span', { key: tag, className: 'mono' }, `#${tag}`)),
                ),
              ),
              h('div', { className: 'r' }, entry.forgotten === true ? h('span', { className: 'st-chip' }, '已遗忘') : null),
            ),
          ),
        ],
      )
    }

    function AuditScreen(props) {
      const data = props.data
      const items = Array.isArray(data.items) ? data.items : []
      const done = data.nextBeforeSeq === null || data.nextBeforeSeq === undefined
      return h(
        ListPane,
        {
          items,
          empty: '这个项目还没有事件。',
          footer: h(
            'p',
            { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } },
            done ? `已到最早一条（本页 ${items.length} 条）` : `本页 ${items.length} 条，更早的用 beforeSeq=${data.nextBeforeSeq} 继续翻`,
          ),
        },
        items.map((event) =>
          h(
            'div',
            { key: event.seq, className: 'item' },
            h(
              'div',
              { className: 'l' },
              h('div', { className: 't' }, h('span', { className: 'mono' }, `#${event.seq}`), ' ', String(event.type)),
              h(
                'div',
                { className: 's' },
                h('span', { className: 'mono' }, String(event.at ?? '')),
                h('span', { className: 'mono' }, `${event.actor.kind}${event.actor.id === null ? '' : `:${event.actor.id}`}`),
                h('span', { className: 'mono' }, `${event.entity.kind}${event.entity.id === '' ? '' : `:${event.entity.id}`}`),
              ),
            ),
          ),
        ),
      )
    }

    function SettingsScreen(props) {
      const data = props.data
      const teams = Array.isArray(data.teams) ? data.teams : []
      return h(
        'div',
        { className: 'body pad' },
        h('p', { className: 'muted', style: { margin: '0 0 6px', fontSize: 12 } }, `configRevision ${data.configRevision ?? '—'} · 项目默认值`),
        h(
          'pre',
          { className: 'box mono', style: { padding: '12px 14px', margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 } },
          JSON.stringify(data.defaults ?? {}, null, 2),
        ),
        h(
          'p',
          { className: 'muted', style: { margin: '12px 0 6px', fontSize: 12 } },
          teams.length === 0 ? '还没有团队的生效配置落盘。' : '各团队生效配置：',
        ),
        h(
          'div',
          { className: 'list' },
          teams.map((team) =>
            h(
              'div',
              { key: team.teamId, className: 'item' },
              h(
                'div',
                { className: 'l' },
                h('div', { className: 't' }, team.teamId),
                h(
                  'div',
                  { className: 's' },
                  h('span', { className: 'mono' }, `rev ${team.configRevision}`),
                  h('span', { className: 'mono' }, `hash ${String(team.contentHash ?? '').slice(0, 8)}`),
                  h('span', { className: 'mono' }, `merge ${team.mergeAlgorithmVersion ?? '—'}`),
                  h('span', { className: 'mono' }, `limits ${team.safetyLimitsVersion ?? '—'}`),
                ),
              ),
              h('div', { className: 'r' }, team.clamped === true ? h('span', { className: 'st-chip' }, '被上限夹住') : null),
            ),
          ),
        ),
      )
    }

    // 导航里的九栏现在都有端点；留这个兜底是为了将来加栏时的默认文案。
    const PROJECT_FALLBACK = { title: '未接入', reason: '这一栏还没有端点。' }

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
      // 五个后接的只读面：只在切到那一栏时才请求，避免每次开面板打七枪。
      const runs = usePanelData(tab === 'runs' ? sessionId : undefined, 'runs')
      const knowledge = usePanelData(tab === 'knowledge' ? sessionId : undefined, 'knowledge')
      const memory = usePanelData(tab === 'memory' ? sessionId : undefined, 'memory')
      const audit = usePanelData(tab === 'audit' ? sessionId : undefined, 'audit', { limit: 200 })
      const settings = usePanelData(tab === 'settings' ? sessionId : undefined, 'settings')

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
        if (tab === 'runs') void runs.reload()
        if (tab === 'knowledge') void knowledge.reload()
        if (tab === 'memory') void memory.reload()
        if (tab === 'audit') void audit.reload()
        if (tab === 'settings') void settings.reload()
      }

      let body
      if (taskId !== null) {
        body = h(TaskDetail, { taskId, sessionId, onBack: () => setTaskId(null) })
      } else if (tab === 'overview') {
        body = h(Data, { data: overview, what: '项目概览' }, (data) => h(OverviewScreen, { data }))
      } else if (tab === 'tasks') {
        body = h(Data, { data: board, what: '任务看板' }, (data) =>
          h(TasksScreen, {
            data,
            teams: overview.data?.teams ?? [],
            sessionId,
            onOpenTask: (task) => setTaskId(task.id),
            onCreated: () => void board.reload(),
          }))
      } else if (tab === 'teams') {
        body = h(Data, { data: overview, what: '团队' }, () =>
          h(TeamsScreen, { overview, sessionId, onChanged: () => void overview.reload() }))
      } else if (tab === 'definitions') {
        body = h(Data, { data: definitions, what: '项目定义副本' }, (data) =>
          h(DefinitionsScreen, { data, sessionId, onChanged: () => void definitions.reload() }))
      } else if (tab === 'migration') {
        body = h(Data, { data: migration, what: '迁移' }, (data) => h(MigrationScreen, { data }))
      } else if (tab === 'runs') {
        body = h(Data, { data: runs, what: '工作流运行' }, (data) => h(RunsScreen, { data }))
      } else if (tab === 'knowledge') {
        body = h(Data, { data: knowledge, what: '项目知识' }, (data) => h(KnowledgeScreen, { data }))
      } else if (tab === 'memory') {
        body = h(Data, { data: memory, what: '长期记忆' }, (data) => h(MemoryScreen, { data }))
      } else if (tab === 'audit') {
        body = h(Data, { data: audit, what: '审计' }, (data) => h(AuditScreen, { data }))
      } else if (tab === 'settings') {
        body = h(Data, { data: settings, what: '项目设置' }, (data) => h(SettingsScreen, { data }))
      } else {
        const missing = PROJECT_FALLBACK
        body = h(Unavailable, { ...missing, title: tab })
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

    // ───────────────────────── 全局库五栏（不属任何项目） ─────────────────────────

    const GLOBAL_KIND_LABEL = { role: '角色', workflow: '工作流', blueprint: '蓝图', team: 'v1 团队（只读兼容）' }

    function globalEntryRows(entries) {
      return entries.map((entry) =>
        h(
          'div',
          { key: `${entry.kind}:${entry.id}`, className: 'item' },
          h(
            'div',
            { className: 'l' },
            h('div', { className: 't' }, entry.name, ' ', h('span', { className: 'muted' }, entry.id)),
            h(
              'div',
              { className: 's' },
              h('span', { className: 'mono' }, entry.file),
              h('span', { className: 'mono' }, entry.revision === null ? '未标 revision' : `rev ${entry.revision}`),
              h('span', { className: 'mono' }, GLOBAL_KIND_LABEL[entry.kind] ?? entry.kind),
            ),
          ),
          h('div', { className: 'r' }, entry.legacy === true ? h('span', { className: 'st-chip' }, 'v1 兼容') : null),
        ),
      )
    }

    function GlobalOverviewScreen(props) {
      const data = props.data
      const counts = data.counts ?? {}
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      return h(
        'div',
        { className: 'body pad' },
        h(
          'p',
          { className: 'muted', style: { margin: '0 0 10px', fontSize: 12 } },
          `根目录 ${data.root ?? '—'}${data.exists === true ? '' : '（还不存在，第一次发布会创建）'}`,
        ),
        h(
          'div',
          { className: 'kws' },
          ['role', 'workflow', 'blueprint', 'team'].map((kind) =>
            h('span', { key: kind, className: 'kw' }, `${GLOBAL_KIND_LABEL[kind]} ${counts[kind] ?? 0}`),
          ),
        ),
        warnings.length === 0
          ? h('p', { className: 'muted', style: { margin: '12px 0 0', fontSize: 12 } }, '所有文件都读得懂。')
          : h(
              'div',
              { className: 'box', style: { padding: '12px 14px', marginTop: 12 } },
              h('b', null, `有 ${warnings.length} 个文件读不懂（已跳过，不影响其它条目）`),
              warnings.map((warning) =>
                h(
                  'p',
                  { key: `${warning.file}:${warning.reason}`, className: 'mono', style: { margin: '6px 0 0', fontSize: 12 } },
                  `${warning.file} · ${warning.reason}`,
                ),
              ),
            ),
      )
    }

    function GlobalAuditScreen(props) {
      const data = props.data
      const items = Array.isArray(data.items) ? data.items : []
      return h(
        ListPane,
        {
          items,
          empty: '还没有全局操作记录。发布、下架等人类确认动作会写进 global-operations.jsonl。',
          footer:
            data.truncated === true
              ? h('p', { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } }, '文件比本页更多：提高 limit 或直接看 jsonl。')
              : null,
        },
        items.map((item) =>
          h(
            'div',
            { key: `${item.at ?? ''}:${item.operationId ?? ''}`, className: 'item' },
            h(
              'div',
              { className: 'l' },
              h(
                'div',
                { className: 't' },
                String(item.action ?? '未知操作'),
                ' ',
                h('span', { className: 'muted' }, String(item.target ?? '')),
              ),
              h(
                'div',
                { className: 's' },
                h('span', { className: 'mono' }, String(item.at ?? '')),
                h('span', { className: 'mono' }, String(item.operationId ?? '')),
              ),
            ),
            h('div', { className: 'r' }, h('span', { className: 'st-chip' }, String(item.status ?? '—'))),
          ),
        ),
      )
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
      // 全局库不属任何项目：请求不带会话，路由对这两个方法也不要求 sessionId。
      const library = usePanelData(undefined, 'globalLibrary', undefined, { allowNoSession: true })
      const globalAudit = usePanelData(undefined, 'globalAudit', { limit: 100 }, { allowNoSession: true })

      const kindForTab = tab === 'roles' ? 'role' : tab === 'workflows' ? 'workflow' : tab === 'blueprints' ? 'blueprint' : null
      const entries = Array.isArray(library.data?.entries) ? library.data.entries : []
      const ofKind = kindForTab === null ? [] : entries.filter((entry) => entry.kind === kindForTab)

      let body
      if (tab === 'publish') {
        body = h(Data, { data: globalAudit, what: '全局操作审计' }, (data) => h(GlobalAuditScreen, { data }))
      } else if (kindForTab === null) {
        body = h(Data, { data: library, what: '全局库概览' }, (data) => h(GlobalOverviewScreen, { data }))
      } else {
        body = h(Data, { data: library, what: navItem.label }, () =>
          h(ListPane, { items: ofKind, empty: `${navItem.label}里还没有全局条目。` }, globalEntryRows(ofKind)),
        )
      }

      const onRefresh = () => {
        void library.reload()
        void globalAudit.reload()
      }

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
            summary: ['$DSH_HOME/myteam', '只有人类确认后写', '团队视图在会话标签上'],
            onRefresh,
            busy: library.status === 'loading',
          }),
          h(StatusBar, {
            chips: [
              { text: '只读', tone: undefined },
              { text: `条目 ${entries.length}` },
              { text: library.data?.root ?? '$DSH_HOME/myteam' },
            ],
            note: '全局资产与团队运行态分开',
          }),
          body,
          h('div', { className: 'ft' }, h('button', { type: 'button', className: 'btn', onClick: back }, '回到对话')),
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
