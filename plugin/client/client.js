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

    /**
     * 加载中（L5 三态之一，设计稿 p-states「首屏只给一行字」）。
     *
     * 设计稿要求：**已经读到过的数据不清空**，切栏回来先显示旧值再刷新。
     * 所以这里只画一行字，不画 spinner、不占位骨架 —— 骨架在「切回来」时会造成闪白。
     * `stale` 为真时额外说明「显示的是上一份」，避免用户以为数据是新的。
     */
    function Loading(props) {
      return h(
        'div',
        { className: 'body pad' },
        h('p', { className: 'muted', style: { fontSize: 12, margin: 0 } }, props.what ?? '加载中…'),
        props.stale === true
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: '6px 0 0' } }, '下面显示的是上一次读到的内容，正在刷新。')
          : null,
      )
    }

    /**
     * 未初始化壳（L2-A / `p-unavailable`）。
     *
     * 什么时候出这一屏：整个视图的第一枪（`status`）就打不开 —— 工作区里没有可读的
     * 团队视图状态。这时**不要**让每个标签各弹一条「读不到这份数据」：那会让人以为是
     * 某一栏坏了，其实是这一整个视图都还没有。
     *
     * 这一屏只做三件事：说清是什么状态、给出下一步、留一个重试。
     * 不猜「可能还没建队」这种细节 —— 状态读不到时连有没有队都不知道。
     */
    function NotInitializedShell(props) {
      const steps = [
        '在会话里让队长建队（发一条「建一支团队」即可）',
        '确认当前工作区就是你要看的那一个',
        '换一个工作区后再打开这个标签',
      ]
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'box', style: { padding: '18px 16px' } },
          h(
            'div',
            { className: 'rc-h' },
            h(Dot, { tone: 'gate' }),
            h('span', { className: 'nm' }, '这个工作区还没有可读的团队视图'),
            h('span', { className: 'tag' }, '未初始化'),
          ),
          h(
            'p',
            { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } },
            '左侧这些栏都要读同一份项目状态；它现在读不出来，所以每一栏都会是空的。先把状态建起来，再回来看。',
          ),
          props.reason === undefined || props.reason === ''
            ? null
            : h(
                'p',
                { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } },
                '读失败的原因：',
                h('span', { className: 'mono' }, String(props.reason)),
              ),
          h(SectionHeader, { title: '下一步', note: `${steps.length} 条` }),
          h(
            'div',
            { className: 'list', style: { marginTop: 6 } },
            steps.map((step, index) =>
              h(ListRow, { key: index, title: `${index + 1}. ${step}`, sub: [] }),
            ),
          ),
          props.onRetry === undefined
            ? null
            : h(
                'div',
                { style: { marginTop: 12 } },
                h('button', { type: 'button', className: 'btn primary', onClick: props.onRetry }, '重试'),
              ),
        ),
      )
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

    /**
     * 空态（L5 共用件，`p-states` 的规范）。
     *
     * 设计稿那句话是硬要求：**只写「暂无数据」等于没有设计**。所以这个组件强制两件事——
     *   1. `reason`：为什么空（没有它就没法判断是该等、该建，还是该换个地方看）；
     *   2. `action`：下一步能做什么（可以是按钮，也可以只是一句「去哪做什么」）。
     * 两者都不给就渲染不出来，逼着调用方想清楚，而不是随手甩一句「没有数据」。
     */
    function EmptyState(props) {
      const { reason, action } = props
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        // 宁可显眼地坏，也不要静默出一个「没有说明的空态」。
        return h('p', { className: 'muted', style: { fontSize: 12, margin: 0 } }, '（空态缺说明：这是实现错误）')
      }
      return h(
        'div',
        { className: 'box', style: { padding: '14px 12px', textAlign: 'center' } },
        h('div', { className: 'muted', style: { fontSize: 12 } }, reason),
        action === undefined || action === null
          ? null
          : h('div', { style: { marginTop: 8 } }, action),
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
      if (data.status === 'loading') {
        // 设计稿 p-states：已读到过的数据不清空，切栏回来先显示旧值再刷新。
        // 有上一份就继续渲染它（带一行「正在刷新」），没有才显示加载中。
        if (data.data !== undefined && data.data !== null) {
          return h('div', null, h(Loading, { what, stale: true }), children(data.data))
        }
        return h(Loading, { what })
      }
      if (data.status === 'error') {
        // 失败也保留上一份成功数据（设计稿：「保留上一次成功的数据；失败原因原样露出」）。
        if (data.data !== undefined && data.data !== null) {
          return h('div', null, h(Failure, { reason: data.reason, onRetry: onRetry ?? data.reload }), children(data.data))
        }
        return h(Failure, { reason: data.reason, onRetry: onRetry ?? data.reload })
      }
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
    /** 成员状态的中文名。`archived` 是「已归档（可回放）」，与 `released`「已释放」分开写。 */
    const MEMBER_STATUS = {
      appointed: '已聘任',
      active: '在岗',
      paused: '已暂停',
      archived: '已归档',
      released: '已释放',
    }

    /** 指标卡（L1 共用件）：概览与全局库概览用同一份，别再各写一遍。 */
    function MetricCard(props) {
      return h(
        'div',
        { className: 'rc', style: { gap: 4 } },
        h('div', { className: 'desc' }, props.label),
        h('div', { className: 'mval' }, String(props.value)),
        props.hint === undefined ? null : h('div', { className: 'desc' }, props.hint),
      )
    }

    /** 分节头（L1 共用件）：`标题 + 计数 + 分隔线 (+ 右侧动作)`；九栏里到处是这一行。 */
    function SectionHeader(props) {
      return h(
        'div',
        { className: 'layer' },
        h('b', null, props.title),
        props.note === undefined ? null : h('span', null, props.note),
        h('i', { className: 'rule' }),
        props.action === undefined ? null : props.action,
      )
    }

    /**
     * 列表行（L1 共用件）：左标题+副信息、右状态片；有 onClick 就自动带可点的视觉与手型。
     * `sub` 里的字符串默认按等宽副信息渲染，要别的元素直接传节点。
     */
    function ListRow(props) {
      const subs = Array.isArray(props.sub) ? props.sub.filter((item) => item !== undefined && item !== null && item !== '') : []
      return h(
        'div',
        {
          className: joinClass('item', props.onClick === undefined ? undefined : 'pick', props.className),
          onClick: props.onClick,
        },
        h(
          'div',
          { className: 'l' },
          h('div', { className: 't' }, props.title),
          subs.length === 0
            ? null
            : h(
                'div',
                { className: 's' },
                subs.map((item, index) =>
                  typeof item === 'string' ? h('span', { key: index, className: 'mono' }, item) : h('span', { key: index }, item),
                ),
              ),
          props.extra ?? null,
        ),
        props.right === undefined ? null : h('div', { className: 'r' }, props.right),
      )
    }

    /**`n     * 表单域（L1 共用件）：标签 + 控件 + 提示，三者一起出现，别再各屏各写。`n     * 注意控件本体用既有的 `span.field`（28px 边框盒）——这里只做外层的标签与说明。`n     */
    function Field(props) {
      return h(
        'label',
        { className: 'fld' },
        h('span', { className: 'fl' }, props.label),
        props.children,
        props.hint === undefined ? null : h('span', { className: 'fh' }, props.hint),
      )
    }

    /** 事件行里只留 id 前 8 个字符（完整值去审计栏看），否则一行全是 uuid。 */
    function shortId(id) {
      const text = String(id ?? '')
      return text.length <= 12 ? text : `${text.slice(0, 8)}…`
    }

    /** 实体写成 `task_43c…`：id 已经带类型前缀时不再重复写类型。 */
    function entityText(entity) {
      const kind = String(entity?.kind ?? '—')
      const id = String(entity?.id ?? '')
      if (id === '') return kind
      return id.startsWith(kind) ? shortId(id) : `${kind} ${shortId(id)}`
    }

    /** 谁写的：会话型 actor（captain）只留 kind，成员类留短 id。 */
    function actorText(actor) {
      const kind = String(actor?.kind ?? '—')
      const id = String(actor?.id ?? '')
      if (id === '' || kind === 'captain') return kind
      return `${kind}:${shortId(id)}`
    }

    function TeamCards(props) {
      const { teams } = props
      if (teams.length === 0) {
        return h(EmptyState, {
          reason: '这个项目还没有团队。团队由人类在「团队」栏建，或让队长在会话里建。',
          action: null,
        })
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
                  team.captain === null ? '暂无队长会话' : `队长会话 · generation ${team.captain.generation}`)),
              h('div', { className: 'i' }, h(Dot, { tone: 'idle' }), h('span', { className: 'nm' }, `${team.tasks} 个任务`)),
            ),
          ),
        ),
      )
    }

    function OverviewScreen(props) {
      const { data, events, onSelect, board, onExpandApprovals } = props
      const totals = data.totals ?? { all: 0, done: 0, blocked: 0, review: 0 }
      const attention = data.attention ?? { review: 0, blocked: 0, unknownEffects: 0 }
      const teamList = Array.isArray(data.teams) ? data.teams : []
      const waiting = (attention.review ?? 0) + (attention.blocked ?? 0)
      const recent = Array.isArray(events) ? events.slice(0, 5) : []

  // 跨团队依赖：看板卡片带完整 dependencies（G7），这里把「前置任务属于别的团队」挑出来。
  // 只统计未完成的前置（blockedBy），因为已完成的边不影响「现在谁卡着谁」。
  const boardTasks = (() => {
    const columns = Array.isArray(board?.columns) ? board.columns : []
    return columns.flatMap((column) => (Array.isArray(column.tasks) ? column.tasks : []))
  })()
  const taskById = new Map(boardTasks.map((task) => [task.id, task]))
  const crossEdges = []
  for (const task of boardTasks) {
    for (const dependencyId of Array.isArray(task.blockedBy) ? task.blockedBy : []) {
      const dependency = taskById.get(dependencyId)
      if (dependency === undefined) continue
      if (dependency.ownerTeamId === null || task.ownerTeamId === null) continue
      if (dependency.ownerTeamId === task.ownerTeamId) continue
      crossEdges.push({
        from: dependency.id,
        to: task.id,
        fromTitle: dependency.title,
        fromName: dependency.ownerTeamName ?? '未指定团队',
        toTitle: task.title,
        toName: task.ownerTeamName ?? '未指定团队',
      })
    }
  }
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'grid c4' },
          h(MetricCard, { label: '团队', value: teamList.length, hint: `${teamList.filter((team) => team.status === 'active').length} 个进行中` }),
          h(MetricCard, { label: '任务', value: totals.all, hint: `已完成 ${totals.done}` }),
          h(MetricCard, { label: '等你确认', value: attention.review, hint: '门禁、计划等待你的结论' }),
          h(MetricCard, { label: '受阻', value: attention.blocked, hint: `未知副作用 ${attention.unknownEffects}` }),
        ),
        waiting === 0
          ? null
          : h(
              'div',
              { className: 'banner plan', style: { marginTop: 12 } },
              h(Icon, { name: 'clock' }),
              h(
                'div',
                { className: 'b-t' },
                h('b', null, `${waiting} 件事等你处理`),
                h('span', null,
                  [
                    attention.review > 0 ? `${attention.review} 个任务待裁决` : null,
                    attention.blocked > 0 ? `${attention.blocked} 个任务受阻` : null,
                    (attention.unknownEffects ?? 0) > 0 ? `${attention.unknownEffects} 个副作用结果未知` : null,
                  ].filter((item) => item !== null).join(' · ')),
              ),
              onExpandApprovals === undefined
                ? null
                : h('div', { className: 'acts' },
                    h('button', { type: 'button', className: 'btn primary', onClick: () => onExpandApprovals() }, '逐项确认')),
            ),
        h(SectionHeader, { title: '团队', note: `${teamList.length} 个` }),
        h(TeamCards, { teams: teamList }),
        h(SectionHeader, { title: '跨团队依赖', note: `${crossEdges.length} 条` }),
        crossEdges.length === 0
          ? h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '任务之间还没有跨团队依赖。')
          : h(
              'div',
              { className: 'box', style: { padding: '2px 14px' } },
              crossEdges.map((edge, index) =>
                h(
                  'div',
                  { key: `${edge.from}-${edge.to}`, className: 'ev', style: index === crossEdges.length - 1 ? { borderBottom: 0 } : undefined },
                  h('span', { className: 'tm' }, edge.fromName),
                  h(
                    'div',
                    { className: 'tx' },
                    h('b', null, edge.toTitle),
                    h('span', { className: 'm' }, ` · ${edge.toName} · 被 ${edge.fromTitle} 阻塞`),
                  ),
                ),
              ),
            ),
        h(
          'div',
          { className: 'layer' },
          h('b', null, '最近事件'),
          h('span', null, `projectSeq ${data.observedProjectSeq ?? '—'}`),
          h('i', { className: 'rule' }),
        ),
        recent.length === 0
          ? h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, '还没有写进事件日志的动作。')
          : h(
              'div',
              { className: 'box', style: { padding: '2px 14px' } },
              recent.map((event, index) =>
                h(
                  'div',
                  { key: event.seq, className: 'ev', style: index === recent.length - 1 ? { borderBottom: 0 } : undefined },
                  h('span', { className: 'tm' }, String(event.seq)),
                  h(
                    'div',
                    { className: 'tx' },
                    h('b', null, String(event.type)),
                    h('span', { className: 'm' },
                      ` · ${entityText(event.entity)} · ${actorText(event.actor)}`),
                  ),
                ),
              ),
            ),
        h(
          'p',
          { className: 'muted', style: { margin: '12px 0 0', fontSize: 12 } },
          `看板、审计、设置读的是同一份项目投影（graphRevision ${data.graphRevision ?? '—'}）；跨团队依赖还没有单独成图。`,
        ),
      )
    }




    /**
     * 名册树（L2-C / `p-roster-tree`）：父成员 → 子成员按层级缩进。
     *
     * 数据就是 `team.members` 的 `parentMemberId`：父子关系是聘任时定的，不额外请求。
     * 找不到父成员（父已释放/被删）的成员单列成「孤儿」，不要静默吞掉。
     */
    /**
     * 名册树（`p-roster-tree`）。
     *
     * 设计稿的三条要求，逐条落在这里：
     *   1. **深度徽标**（d0 / d1 / d2）：父子是聘任结构，不是会话嵌套；
     *   2. **深度上限**：到上限的那层标「硬上限」，提示不能再派生 —— 上限取团队生效配置
     *      的 `limits.maxMemberDepth`（平台还有更硬的 `SAFETY_LIMITS.maxMemberDepth`）；
     *   3. **子成员数**：每个成员后面写「N 个子成员」，为 0 时写「无子成员」。
     *
     * 孤儿（父成员已不在名册）单独标出来：它在树里只能挂到根层，不标的话会被误读成「没爹」。
     * 已归档成员**也在树里**（设计稿：名册保留这条记录），只是状态徽标不同。
     */
    function RosterTree(props) {
      const members = Array.isArray(props.members) ? props.members : []
      const roleName = (roleId) => props.roles?.find((role) => role.id === roleId)?.name ?? roleId
      // 深度上限：优先用团队生效配置，取不到就退回平台安全上限（宁严不宽）。
      const maxDepth = (() => {
        const fromConfig = props.config?.limits?.maxMemberDepth
        if (typeof fromConfig === 'number' && Number.isFinite(fromConfig)) return fromConfig
        return props.safetyMaxDepth ?? null
      })()
      if (members.length === 0) {
        return h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '这支团队还没有成员。在会话里让队长召唤，或从团队栏发起。')
      }
      const ids = new Set(members.map((member) => member.id))
      const children = new Map()
      const roots = []
      for (const member of members) {
        if (member.parentMemberId === null || member.parentMemberId === undefined || !ids.has(member.parentMemberId)) {
          roots.push(member)
        } else {
          const list = children.get(member.parentMemberId) ?? []
          list.push(member)
          children.set(member.parentMemberId, list)
        }
      }
      const rows = []
      const walk = (member, depth) => {
        const orphan = member.parentMemberId !== null && member.parentMemberId !== undefined && !ids.has(member.parentMemberId)
        rows.push({ member, depth, orphan, childCount: (children.get(member.id) ?? []).length })
        for (const child of children.get(member.id) ?? []) walk(child, depth + 1)
      }
      for (const root of roots.sort((left, right) => (left.id < right.id ? -1 : 1))) walk(root, 0)

      return h(
        'div',
        { style: { marginTop: 8 } },
        rows.map((row) => {
          // 到上限那层：不能再派生。只有「确实有上限」时才标，避免 0/undefined 误报。
          const atCap = maxDepth !== null && row.depth >= maxDepth
          const archived = row.member.status === 'archived'
          return h(
            'div',
            { key: row.member.id, className: 'item', style: { paddingLeft: 2 + row.depth * 18 } },
            h(
              'div',
              { className: 'l' },
              h(
                'div',
                { className: 't' },
                `${row.depth === 0 ? '●' : '└'} ${roleName(row.member.roleId)}`,
                h('span', { className: 'tag', style: { marginLeft: 6 } }, `d${String(row.depth)}`),
                atCap ? h('span', { className: 'tag', style: { marginLeft: 4 }, title: `深度上限 ${String(maxDepth)}：这一层不能再派生` }, '硬上限') : null,
                archived ? h('span', { className: 'tag', style: { marginLeft: 4 } }, '已归档') : null,
              ),
              h(
                'div',
                { className: 's' },
                h('span', { className: 'mono' }, row.member.id),
                h('span', null, row.childCount === 0 ? '无子成员' : `${String(row.childCount)} 个子成员`),
                row.orphan ? h('span', null, '（父成员已不在名册）') : null,
              ),
            ),
            h('div', { className: 'r' }, h('span', { className: 'st-chip' }, MEMBER_STATUS[row.member.status] ?? String(row.member.status))),
          )
        }),
      )
    }
    /** 角色详情（L2-C / `p-role`）：profile + 能力矩阵 + 谁在用。数据来自 definitions.detail。 */
    function RoleDetailBox(props) {
      const item = props.item
      const detail = item?.detail
      if (detail === null || detail === undefined) {
        return h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, '这个角色定义的正文已经不在投影里（可能被归档）。')
      }
      const profile = detail.profile ?? {}
      const caps = detail.capabilities ?? {}
      const list = (value) => (Array.isArray(value) ? value : [])
      const usedBy = Array.isArray(props.members) ? props.members.filter((member) => member.roleId === item.id) : []
      return h(
        'div',
        { style: { marginTop: 8 } },
        h(SectionHeader, { title: profile.name ?? item.id, note: `rev ${item.revision}` }),
        h('div', { className: 's', style: { marginTop: 4 } }, h('span', null, profile.purpose ?? '')),
        h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, String(profile.instructions ?? '')),
        h(SectionHeader, { title: '能力', note: `${list(caps.tools?.allow).length} 工具 / ${list(caps.skills).length} 技能` }),
        h(
          'div',
          { className: 'kws', style: { marginTop: 6 } },
          list(caps.tools?.allow).length === 0
            ? h('span', { className: 'kw' }, '未声明工具')
            : list(caps.tools.allow).map((tool) => h('span', { key: `t-${tool}`, className: 'kw' }, String(tool))),
          list(caps.skills).map((skill) => h('span', { key: `s-${skill}`, className: 'kw' }, String(skill))),
        ),
        h(SectionHeader, { title: '谁在用', note: `${usedBy.length} 个成员` }),
        usedBy.length === 0
          ? h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '还没有成员用这个角色。')
          : h(
              'div',
              { className: 's', style: { marginTop: 4 } },
              usedBy.map((member) => h('span', { key: member.id, className: 'mono' }, member.id)),
            ),
      )
    }
    /**
     * 流程泳道（L2-F / `p-lanes`）：一条 Run 一条泳道，泳道内按 templateKey 排列任务。
     *
     * 数据不额外请求：`runs` 给 Run 清单，`board` 的卡片带 `runId`，两边一join 就是泳道。
     * 没有 Run 时不画空泳道，直接说「还没有工作流运行」并指向流程栏。
     */
    function LanesSection(props) {
      const runs = Array.isArray(props.runs?.items) ? props.runs.items : []
      const columns = Array.isArray(props.board?.columns) ? props.board.columns : []
      const tasks = columns.flatMap((column) => (Array.isArray(column.tasks) ? column.tasks : []))
      const byRun = new Map()
      for (const task of tasks) {
        if (task.runId === null || task.runId === undefined) continue
        const list = byRun.get(task.runId) ?? []
        list.push(task)
        byRun.set(task.runId, list)
      }

      return h(
        'div',
        { className: 'body pad tight' },
        h(SectionHeader, { title: '流程泳道', note: `${runs.length} 条 Run` }),
        runs.length === 0
          ? h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '还没有工作流运行，所以没有泳道。实例化一个工作流后，这里会按 Run 分行。')
          : h(
              'div',
              { className: 'list', style: { marginTop: 6 } },
              runs.map((run) => {
                const laneTasks = (byRun.get(run.id) ?? []).slice().sort((left, right) => (left.id < right.id ? -1 : 1))
                return h(
                  'div',
                  { key: run.id, className: 'item' },
                  h(
                    'div',
                    { className: 'l' },
                    h('div', { className: 't' }, run.workflowId, ' ', h('span', { className: 'muted' }, run.id)),
                    laneTasks.length === 0
                      ? h('div', { className: 's' }, h('span', null, '这条 Run 还没有挂任务'))
                      : h(
                          'div',
                          { className: 's' },
                          laneTasks.map((task) =>
                            h(
                              'span',
                              { key: task.id, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                              h('span', { className: 'mono' }, task.title),
                              h('span', { className: 'st-chip' }, String(task.status)),
                            ),
                          ),
                        ),
                  ),
                  h('div', { className: 'r' }, h('span', { className: 'mono' }, `${laneTasks.length}/${run.taskCount ?? 0}`)),
                )
              }),
            ),
      )
    }

    /**
     * 待你确认（L2-F / `p-approval`）：把「人类专属、等结论」的事收在一处。
     *
     * 来源是两份现成数据：`overview.attention` 给计数，`board` 的 review 列给具体任务。
     * 没有就直接说没有 —— 不要让用户从九栏里自己找。
     */
    function ApprovalSection(props) {
      const attention = props.overview?.attention ?? { review: 0, blocked: 0, unknownEffects: 0 }
      const columns = Array.isArray(props.board?.columns) ? props.board.columns : []
      const reviewColumn = columns.find((column) => column.status === 'review')
      const reviewTasks = Array.isArray(reviewColumn?.tasks) ? reviewColumn.tasks : []
      const blockedColumn = columns.find((column) => column.status === 'blocked')
      const blockedTasks = Array.isArray(blockedColumn?.tasks) ? blockedColumn.tasks : []
      const total = (attention.review ?? 0) + (attention.blocked ?? 0) + (attention.unknownEffects ?? 0)

      return h(
        'div',
        { className: 'body pad tight' },
        h(SectionHeader, { title: '待你确认', note: `${total} 件` }),
        total === 0
          ? h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '没有等你确认的事。门禁、计划与未知副作用都会出现在这里。')
          : h(
              'div',
              { className: 'list', style: { marginTop: 6 } },
              reviewTasks.map((task) =>
                h(ListRow, {
                  key: task.id,
                  title: task.title,
                  sub: ['门禁裁决', task.ownerTeamName ?? '未指派团队', task.id],
                  right: h('span', { className: 'st-chip' }, '待评审'),
                  onClick: props.onOpenTask === undefined ? undefined : () => props.onOpenTask(task),
                }),
              ),
              blockedTasks.map((task) =>
                h(ListRow, {
                  key: `blocked-${task.id}`,
                  title: task.title,
                  sub: [`受阻 ${task.blockedBy?.length ?? 0} 项`, task.ownerTeamName ?? '未指派团队'],
                  right: h('span', { className: 'st-chip' }, '受阻'),
                  onClick: props.onOpenTask === undefined ? undefined : () => props.onOpenTask(task),
                }),
              ),
            ),
      )
    }
    /**
     * 依赖图（L2-F / `p-dag`）：把看板里的完整依赖边画成「层级 + 前置清单」。
     *
     * 为什么不做画布：宿主只给我们一块面板，SVG 布局得自己算坐标、还得处理缩放；
     * 先把**结构**表达清楚（层级、前置、环路）比先画得好看重要。层级 = 最长前置链，
     * 有环时明确报出来，而不是悄悄画成一条线。
     */
    function DagSection(props) {
      const columns = Array.isArray(props.board?.columns) ? props.board.columns : []
      const tasks = columns.flatMap((column) => (Array.isArray(column.tasks) ? column.tasks : []))
      const byId = new Map(tasks.map((task) => [task.id, task]))
      const edges = []
      for (const task of tasks) {
        for (const dependencyId of Array.isArray(task.dependencies) ? task.dependencies : []) {
          if (byId.has(dependencyId)) edges.push({ from: dependencyId, to: task.id })
        }
      }

      // 最长前置链深度（同时检测环路：visiting 里再遇到就是环）。
      const depth = new Map()
      const visiting = new Set()
      const cycle = []
      const depthOf = (id) => {
        if (depth.has(id)) return depth.get(id)
        if (visiting.has(id)) {
          cycle.push(id)
          return 0
        }
        visiting.add(id)
        const task = byId.get(id)
        const deps = (Array.isArray(task?.dependencies) ? task.dependencies : []).filter((dep) => byId.has(dep))
        const level = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depthOf(dep) + 1))
        visiting.delete(id)
        depth.set(id, level)
        return level
      }
      for (const task of tasks) depthOf(task.id)

      const rows = [...tasks].sort((left, right) => {
        const byLevel = (depth.get(left.id) ?? 0) - (depth.get(right.id) ?? 0)
        return byLevel !== 0 ? byLevel : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      })

      const titleOf = (id) => byId.get(id)?.title ?? id

      return h(
        'div',
        { className: 'body pad tight' },
        h(SectionHeader, { title: '依赖图', note: `${rows.length} 个任务 · ${edges.length} 条依赖` }),
        cycle.length > 0
          ? h('div', { className: 'banner plan', style: { marginTop: 8 } },
              h(Icon, { name: 'alert' }),
              h('div', { className: 'b-t' }, h('b', null, '检测到依赖环路'), h('span', null, `涉及 ${cycle.length} 个任务，图不完整`)))
          : null,
        edges.length === 0
          ? h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '任务之间还没有依赖。')
          : h(
              'div',
              { className: 'list', style: { marginTop: 6 } },
              rows.map((task) =>
                h(
                  'div',
                  { key: task.id, className: 'item', style: { paddingLeft: 2 + (depth.get(task.id) ?? 0) * 18 } },
                  h(
                    'div',
                    { className: 'l' },
                    h(
                      'div',
                      { className: 't' },
                      h('span', { className: 'mono', style: { marginRight: 8 } }, `L${depth.get(task.id) ?? 0}`),
                      task.title,
                    ),
                    h(
                      'div',
                      { className: 's' },
                      h('span', { className: 'mono' }, `前置 ${task.dependencies?.length ?? 0}`),
                      ...[...(Array.isArray(task.dependencies) ? task.dependencies : [])].map((dependencyId) =>
                        h('span', { key: dependencyId }, `← ${titleOf(dependencyId)}`),
                      ),
                    ),
                  ),
                  h('div', { className: 'r' }, h('span', { className: 'st-chip' }, String(task.status))),
                ),
              ),
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
        h(
          Field,
          { label: '任务标题' },
          h('input', {
            type: 'text',
            className: 'box',
            placeholder: '任务标题',
            value: title,
            style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
            onChange: (event) => setTitle(event.target.value),
          }),
        ),
        h(
          Field,
          { label: '验收标准', hint: '一行一条；至少一条，写成可验证的事实。' },
          h('textarea', {
            className: 'box mono',
            placeholder: '一行一条验收标准',
            value: acceptance,
            rows: 3,
            style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 12 },
            onChange: (event) => setAcceptance(event.target.value),
          }),
        ),
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
                  ? h('p', { className: 'muted', style: { fontSize: 12, margin: '2px 0 0' } }, '这个状态还没有任务')
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
        h(DagSection, { board: data }),
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

    /**
     * 任务状态流转（`taskMove`）：面板只开两个人类方向——
     * 取消（`cancelled`）与重开（`ready`）。
     *
     * 认领（`claimed`）不在这里：它要求 `memberId`，而认领是**成员自己的事**
     * （成员会话用 `myteam_claim_task`）。完成（`done`）不在这里：必须走门禁裁决，
     * 面板直连 done 是不存在的路径，所以也不做按钮。
     */
    function TaskMoveBox(props) {
      const { taskId, status, sessionId, onDone } = props
      const [reason, setReason] = useState('')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const move = async (targetStatus) => {
        if (busy) return
        setBusy(true)
        setProblem(null)
        try {
          await callWrite('taskMove', sessionId, {
            confirm: true,
            params: {
              taskId,
              targetStatus,
              ...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
            },
          })
          onDone()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(false)
        }
      }

      if (status === 'done') {
        return h(
          'p',
          { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } },
          '已完成的任务不在面板上移动：完成与撤销都走门禁裁决与账本，面板不直连。',
        )
      }

      const reopening = status === 'cancelled'
      return h(
        'div',
        { style: { marginTop: 12 } },
        h(Field, {
          label: reopening ? '重开理由（可选，会进账本）' : '取消理由（可选，会进账本）',
          hint: reopening ? '重开回到「待认领」。' : '取消是不可逆终态，之后只能重开。',
        }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: reopening ? '重开理由' : '取消理由',
          value: reason,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setReason(event.target.value),
        })),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没动成：${problem}`),
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h(
            'button',
            {
              type: 'button',
              className: joinClass('btn', reopening ? 'primary' : ''),
              disabled: busy === true,
              onClick: () => void move(reopening ? 'ready' : 'cancelled'),
            },
            busy === true ? '提交中…' : reopening ? '重开任务' : '取消任务',
          ),
          h('span', { className: 'grow' }),
          h('span', { className: 'muted', style: { fontSize: 12 } }, '认领由成员在自己会话里做；完成走门禁裁决'),
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
            h(TaskMoveBox, {
              taskId,
              status: data.task.status,
              sessionId,
              onDone: () => void detail.reload(),
            }),
          ),
        ),
      )
    }

    /** 建团队（`teamCreate`，`p-team-new`）：名字 + 目标 + 队长会话，可选蓝图。 */
    function TeamCreateForm(props) {
      const { sessionId, blueprints, onDone, onCancel } = props
      const [name, setName] = useState('')
      const [goal, setGoal] = useState('')
      const [captainSessionId, setCaptainSessionId] = useState(sessionId ?? '')
      const [blueprintId, setBlueprintId] = useState('')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)
      const list = Array.isArray(blueprints) ? blueprints : []

      const submit = async () => {
        if (busy) return
        if (name.trim().length === 0) {
          setProblem('团队名字不能为空')
          return
        }
        if (goal.trim().length === 0) {
          setProblem('目标不能为空：没有目标的团队没法验收')
          return
        }
        if (captainSessionId.trim().length === 0) {
          setProblem('队长会话不能为空：团队必须绑一个队长会话')
          return
        }
        setBusy(true)
        setProblem(null)
        try {
          await callWrite('teamCreate', sessionId, {
            confirm: true,
            params: {
              name: name.trim(),
              goal: goal.trim(),
              captainSessionId: captainSessionId.trim(),
              ...(blueprintId.length === 0 ? {} : { blueprintId }),
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
        { className: 'box', style: { padding: '14px 16px', margin: '0 0 12px' } },
        h(Field, { label: '团队名字' }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: '团队名字',
          value: name,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setName(event.target.value),
        })),
        h(Field, { label: '目标', hint: '一句话说清这支团队要交付什么。' }, h('textarea', {
          className: 'box',
          placeholder: '团队目标',
          value: goal,
          rows: 2,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setGoal(event.target.value),
        })),
        h(
          Field,
          { label: '队长会话', hint: '默认用当前会话；换的话要填一个已经能跑队长预设的会话 id。' },
          h('input', {
            type: 'text',
            className: 'box mono',
            placeholder: '队长会话 id',
            value: captainSessionId,
            style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 12 },
            onChange: (event) => setCaptainSessionId(event.target.value),
          }),
        ),
        list.length === 0
          ? null
          : h(
              'div',
              { className: 'kws', style: { marginTop: 8 } },
              h('span', { className: 'muted', style: { fontSize: 12, marginRight: 6 } }, '蓝图'),
              h(
                'button',
                { type: 'button', className: joinClass('btn', blueprintId === '' ? 'primary' : ''), style: { marginRight: 6 }, onClick: () => setBlueprintId('') },
                '不套蓝图',
              ),
              list.map((blueprint) =>
                h(
                  'button',
                  {
                    key: blueprint.id,
                    type: 'button',
                    className: joinClass('btn', blueprintId === blueprint.id ? 'primary' : ''),
                    style: { marginRight: 6 },
                    onClick: () => setBlueprintId(blueprint.id),
                  },
                  blueprint.name ?? blueprint.id,
                ),
              ),
            ),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没建成：${problem}`),
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h('button', { type: 'button', className: 'btn primary', disabled: busy === true, onClick: () => void submit() }, busy === true ? '创建中…' : '建团队'),
          h('button', { type: 'button', className: 'btn', style: { marginLeft: 8 }, onClick: onCancel }, '取消'),
        ),
      )
    }

    /**
     * 团队名册上的两个人事写动作（`memberAppoint` / `memberRelease`）：
     * 召唤按角色开一个成员，释放把成员推到终态。两者都只由人类在面板发起，
     * 所以走 `direct` + `confirm: true`，不套令牌（令牌用于「影响面会变」的解散/接管/发布）。
     */
    function TeamAdminBox(props) {
      const { teamId, sessionId, members, roles, onDone } = props
      const roster = Array.isArray(members) ? members : []
      const roleList = Array.isArray(roles) ? roles : []
      const [roleId, setRoleId] = useState(roleList.length > 0 ? roleList[0].id : '')
      const [busy, setBusy] = useState(null)
      const [problem, setProblem] = useState(null)
      /** 归档撞上进行中尝试时记下成员，界面给「先暂停 / 等结束」二选一（设计稿 p-member-archive）。 */
      const [pendingArchive, setPendingArchive] = useState(null)
      /** 归档撞上进行中尝试时，记下要归档的成员，界面上给「先暂停 / 等结束」二选一。 */

      const appoint = async () => {
        if (busy !== null) return
        if (roleId.length === 0) {
          setProblem('先选一个角色：成员必须带角色快照')
          return
        }
        setBusy('appoint')
        setProblem(null)
        try {
          await callWrite('memberAppoint', sessionId, { confirm: true, params: { teamId, roleId } })
          onDone()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(null)
        }
      }

      const release = async (memberId) => {
        if (busy !== null) return
        setBusy(memberId)
        setProblem(null)
        try {
          await callWrite('memberRelease', sessionId, { confirm: true, params: { teamId, memberId } })
          onDone()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(null)
        }
      }

      /**
       * 归档 / 恢复。归档是「退役但可回放」，和释放是两件事；
       * 有进行中尝试时后端会报 CONFLICT 并给出 attemptIds —— 这里原样显示，
       * 并提示可以选「先暂停再归档」（drain=pause），不替用户决定。
       */
      const archive = async (memberId, drain) => {
        if (busy !== null) return
        setBusy(memberId)
        setProblem(null)
        try {
          await callWrite('memberArchive', sessionId, {
            confirm: true,
            params: { teamId, memberId, ...(drain === undefined ? {} : { drain }) },
          })
          setPendingArchive(null)
          onDone()
        } catch (error) {
          // 设计稿 p-member-archive 的「先排空、再归档」：有进行中尝试时后端报 CONFLICT，
          // 这里把它变成**二选一**（先暂停 / 等这轮结束），而不是甩一句错误让人自己猜。
          const message = messageOf(error)
          setProblem(message)
          if (/进行中的尝试|active attempt/i.test(message)) setPendingArchive(memberId)
        } finally {
          setBusy(null)
        }
      }

      /** 恢复归档成员：archived → active。只对归档态有效（已释放不可恢复，由后端拒）。 */
      const restoreMember = async (memberId) => {
        if (busy !== null) return
        setBusy(memberId)
        setProblem(null)
        try {
          await callWrite('memberRestore', sessionId, { confirm: true, params: { teamId, memberId } })
          onDone()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(null)
        }
      }

      // 名册主列表只排除 released（终态、不提供恢复）；archived **必须留在名册里** ——
      // 设计稿 p-member-archive 的原话是「名册里保留这条记录，记忆 bank 与证据都还在」。
      // 之前把它从主列表筛掉、只放归档区，等于让人以为「归档后就看不见了」，正好反了。
      const releasable = roster.filter((member) => member.status !== 'released')
      const archivedMembers = roster.filter((member) => member.status === 'archived')

      return h(
        'div',
        { style: { marginTop: 12 } },
        h('p', { className: 'muted', style: { margin: '0 0 4px', fontSize: 12 } }, '人事（召唤按角色固化能力快照；释放是终态）'),
        roleList.length === 0
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: '4px 0 0' } }, '这支团队还没有可用角色，先给团队加角色再召唤。')
          : h(
              'div',
              { className: 'kws' },
              roleList.map((role) =>
                h(
                  'button',
                  {
                    key: role.id,
                    type: 'button',
                    className: joinClass('btn', role.id === roleId ? 'primary' : ''),
                    style: { marginRight: 6 },
                    onClick: () => setRoleId(role.id),
                  },
                  role.name ?? role.id,
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn primary',
                  disabled: busy !== null,
                  style: { marginLeft: 6 },
                  onClick: () => void appoint(),
                },
                busy === 'appoint' ? '召唤中…' : '召唤成员',
              ),
            ),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没成功：${problem}`),
        pendingArchive === null
          ? null
          : h(
              'div',
              { className: 'box', style: { padding: '10px 12px', marginTop: 8 } },
              h('p', { className: 'muted', style: { margin: '0 0 8px', fontSize: 12 } },
                '这个成员还有进行中的尝试。归档前要先排空——二选一：'),
              h('div', { className: 'acts' },
                h('button', {
                  type: 'button',
                  className: 'btn primary',
                  disabled: busy !== null,
                  title: '先落 paused，再归档（两条事件，中间态可追溯）',
                  onClick: () => void archive(pendingArchive, 'pause'),
                }, '先暂停，再归档'),
                h('button', {
                  type: 'button',
                  className: 'btn',
                  style: { marginLeft: 8 },
                  onClick: () => { setPendingArchive(null); setProblem(null) },
                }, '我来等这轮结束'),
              ),
            ),
        archivedMembers.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 10 } },
              h('p', { className: 'muted', style: { margin: '0 0 4px', fontSize: 12 } },
                '已归档（退役但可回放：记录、记忆与证据都在；不再接新活）'),
              archivedMembers.map((member) =>
                h(
                  'div',
                  { key: member.id, className: 'item' },
                  h(
                    'div',
                    { className: 'l' },
                    h('div', { className: 't' }, member.id),
                    h('div', { className: 's' }, h('span', { className: 'mono' }, MEMBER_STATUS.archived ?? '已归档')),
                  ),
                  h(
                    'div',
                    { className: 'r' },
                    h('button', {
                      type: 'button',
                      className: 'btn',
                      disabled: busy !== null,
                      title: '恢复成在岗；归档时保留的记录与记忆继续可用',
                      onClick: () => void restoreMember(member.id),
                    }, busy === member.id ? '恢复中…' : '恢复'),
                  ),
                ),
              ),
            ),
        releasable.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8 } },
              releasable.map((member) =>
                h(
                  'div',
                  { key: member.id, className: 'item' },
                  h(
                    'div',
                    { className: 'l' },
                    h('div', { className: 't' }, member.id),
                    h('div', { className: 's' }, h('span', { className: 'mono' }, MEMBER_STATUS[member.status] ?? member.status)),
                  ),
                  h(
                    'div',
                    { className: 'r' },
                    member.status === 'archived'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'btn',
                            style: { marginRight: 6 },
                            disabled: busy !== null,
                            title: '恢复成在岗；归档时保留的记录与记忆继续可用',
                            onClick: () => void restoreMember(member.id),
                          },
                          busy === member.id ? '恢复中…' : '恢复',
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'btn',
                            style: { marginRight: 6 },
                            disabled: busy !== null,
                            title: '归档：名册留痕、记忆与证据保留，之后可恢复；与「释放（终态）」不同',
                            onClick: () => void archive(member.id),
                          },
                          busy === member.id ? '归档中…' : '归档',
                        ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'btn',
                        disabled: busy !== null,
                        onClick: () => void release(member.id),
                      },
                      busy === member.id ? '释放中…' : '释放',
                    ),
                  ),
                ),
              ),
            ),
      )
    }

    function TeamsScreen(props) {
      const { overview, sessionId } = props
      const teams = overview.data?.teams ?? []
      const [selected, setSelected] = useState(null)
      const [creating, setCreating] = useState(false)
      const detail = usePanelData(selected === null ? undefined : sessionId, 'team', selected === null ? {} : { teamId: selected })
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'bar', style: { padding: '0 0 10px' } },
          h(
            'button',
            {
              type: 'button',
              className: joinClass('btn', creating === true ? 'primary' : ''),
              onClick: () => setCreating(creating !== true),
            },
            creating === true ? '收起' : '建团队',
          ),
          h('span', { className: 'grow' }),
          h('span', { className: 'muted', style: { fontSize: 12 } }, `${teams.length} 个团队`),
        ),
        creating === true
          ? h(TeamCreateForm, {
              sessionId,
              onDone: () => {
                setCreating(false)
                if (props.onChanged !== undefined) props.onChanged()
              },
              onCancel: () => setCreating(false),
            })
          : null,
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
                  h(RosterTree, { members: data.members, roles: data.roles, config: data.config }),
                  h('p', { className: 'muted', style: { margin: '10px 0 0', fontSize: 12 } },
                    `任务 ${data.tasks.length} 个 · 可用角色 ${data.roles.length} 个 · 配置 ${data.config === null ? '未落盘' : `revision ${data.config.revision ?? '—'}`}`),
                  h(TeamAdminBox, {
                    teamId: selected,
                    sessionId,
                    members: data.members,
                    roles: data.roles,
                    onDone: () => {
                      void detail.reload()
                      if (props.onChanged !== undefined) props.onChanged()
                    },
                  }),
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

    /**
     * 编辑角色定义（`definitionSave`，`g-role-edit` 的项目副本版）：
     * 只改 profile 的文本字段，能力集**原样带回去**——面板不该顺手改权限。
     * 工作流与蓝图不在这一版：前者的 templates 是结构化图，后者还没有保存命令。
     */
    function RoleEditBox(props) {
      const { item, sessionId, onChanged } = props
      const detail = item.detail ?? {}
      const profile = detail.profile ?? {}
      const [name, setName] = useState(String(profile.name ?? item.name ?? ''))
      const [purpose, setPurpose] = useState(String(profile.purpose ?? ''))
      const [instructions, setInstructions] = useState(String(profile.instructions ?? ''))
      const [specialties, setSpecialties] = useState(Array.isArray(profile.specialties) ? profile.specialties.join(', ') : '')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)
      const [saved, setSaved] = useState(false)

      const submit = async () => {
        if (busy) return
        if (name.trim().length === 0) {
          setProblem('角色名不能为空')
          return
        }
        setBusy(true)
        setProblem(null)
        setSaved(false)
        try {
          await callWrite('definitionSave', sessionId, {
            confirm: true,
            params: {
              kind: 'role',
              id: item.id,
              profile: {
                ...profile,
                name: name.trim(),
                purpose: purpose.trim(),
                instructions: instructions.trim(),
                specialties: specialties
                  .split(/[,，\s]+/)
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              },
              // 能力集原样回传：这个表单不负责改权限。
              ...(detail.capabilities === undefined ? {} : { capabilities: detail.capabilities }),
            },
          })
          setSaved(true)
          if (onChanged !== undefined) onChanged()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'box', style: { padding: '12px 16px', marginTop: 12 } },
        h('p', { className: 'muted', style: { margin: '0 0 6px', fontSize: 12 } },
          `编辑这份项目副本（rev ${item.revision}；保存后 revision 递增、记 previousHash）`),
        h(Field, { label: '角色名' }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: '角色名',
          value: name,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setName(event.target.value),
        })),
        h(Field, { label: '用途', hint: '一句话：这个角色解决什么问题。' }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: '用途',
          value: purpose,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setPurpose(event.target.value),
        })),
        h(Field, { label: '工作说明', hint: '写清楚怎么做、边界在哪。' }, h('textarea', {
          className: 'box',
          placeholder: '工作说明',
          value: instructions,
          rows: 3,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setInstructions(event.target.value),
        })),
        h(Field, { label: '专长', hint: '可选；逗号或空格分隔。' }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: '专长',
          value: specialties,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setSpecialties(event.target.value),
        })),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没存上：${problem}`),
        saved === true
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, '已保存：revision 已递增。')
          : null,
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h('button', { type: 'button', className: 'btn primary', disabled: busy === true, onClick: () => void submit() },
            busy === true ? '保存中…' : '保存定义'),
          h('span', { className: 'grow' }),
          h('span', { className: 'muted', style: { fontSize: 12 } }, '能力集不在这里改（保存时原样带回）'),
        ),
      )
    }

    /**
     * 蓝图编辑（`definitionSave`，`kind: 'blueprint'`；项目副本版）。
     *
     * 队形用「一行一个槽位」的自由文本编辑：`key | 角色 | 数量 | 父槽位`。
     * 为什么不做拖拽/图形编辑器：蓝图的校验规则（引用必须能解析、父子不能成环、
     * 数量为正整数）都在域里，界面的责任只是**如实把错误原样显示出来**；画成图反而
     * 会让「哪个槽位引用了不存在的角色」变得难看出来。真正的把关在 t53。
     */
    function BlueprintEditBox(props) {
      const { item, roles, workflows, sessionId, onChanged } = props
      const detail = item?.detail ?? {}
      const blueprint = detail.blueprint ?? null
      const roleList = Array.isArray(roles) ? roles : []
      const workflowList = Array.isArray(workflows) ? workflows : []

      const toLines = (formation) =>
        (Array.isArray(formation) ? formation : [])
          .map((slot) => [slot.key, slot.roleId, String(slot.count ?? 1), slot.parentSlotKey ?? ''].join(' | '))
          .join('\n')

      const [name, setName] = useState(String(blueprint?.name ?? item?.name ?? ''))
      const [description, setDescription] = useState(String(blueprint?.description ?? ''))
      const [formationText, setFormationText] = useState(toLines(blueprint?.formation))
      const [pickedWorkflows, setPickedWorkflows] = useState(Array.isArray(blueprint?.workflows) ? blueprint.workflows : [])
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)
      const [saved, setSaved] = useState(false)

      const submit = async () => {
        if (busy) return
        if (name.trim().length === 0) {
          setProblem('蓝图名不能为空')
          return
        }
        // 逐行解析；格式不对就在本地拦下来，不要让一行错格式变成一条难看懂的域错误。
        const formation = []
        const lines = formationText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
        for (const [index, line] of lines.entries()) {
          const parts = line.split('|').map((part) => part.trim())
          if (parts.length < 3) {
            setProblem(`第 ${index + 1} 行格式不对：要写成 key | 角色 | 数量（| 父槽位）`)
            return
          }
          const count = Number(parts[2])
          if (!Number.isInteger(count) || count < 1) {
            setProblem(`第 ${index + 1} 行数量必须是正整数（现在是「${parts[2]}」）`)
            return
          }
          formation.push({
            key: parts[0],
            roleId: parts[1],
            count,
            parentSlotKey: parts.length > 3 && parts[3].length > 0 ? parts[3] : null,
          })
        }
        if (formation.length === 0) {
          setProblem('至少需要一个队形槽位')
          return
        }
        setBusy(true)
        setProblem(null)
        setSaved(false)
        try {
          await callWrite('definitionSave', sessionId, {
            confirm: true,
            params: {
              kind: 'blueprint',
              // 没有 id = 新建（域里 createProjectBlueprint）；有 id 走修订。
              ...(item === null || item === undefined ? {} : { id: item.id }),
              name: name.trim(),
              description: description.trim(),
              formation,
              workflows: pickedWorkflows,
              defaults: blueprint?.defaults ?? {},
            },
          })
          setSaved(true)
          if (onChanged !== undefined) onChanged()
        } catch (error) {
          setProblem(messageOf(error))
        } finally {
          setBusy(false)
        }
      }

      const toggleWorkflow = (id) => {
        setPickedWorkflows((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
      }

      return h(
        'div',
        { className: 'box', style: { padding: '12px 16px', marginTop: 12 } },
        h('p', { className: 'muted', style: { margin: '0 0 6px', fontSize: 12 } },
          item === null || item === undefined
            ? '新建项目蓝图（队形引用必须能解析，否则域里会拒绝并说明原因）'
            : `编辑这张蓝图（rev ${item.revision}；保存后 revision 递增、记 previousHash）`),
        h(Field, { label: '蓝图名' }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: '蓝图名',
          value: name,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setName(event.target.value),
        })),
        h(Field, { label: '说明' }, h('input', {
          type: 'text',
          className: 'box',
          placeholder: '说明',
          value: description,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => setDescription(event.target.value),
        })),
        h(Field, {
          label: '队形',
          hint: roleList.length === 0
            ? '这个项目还没有角色，先建角色再写队形。每行：key | 角色 | 数量（| 父槽位）'
            : `每行一个槽位：key | 角色 | 数量（| 父槽位）。可用角色：${roleList.map((role) => `${role.id}（${role.name}）`).join(' / ')}`,
        }, h('textarea', {
          className: 'box mono',
          placeholder: 'impl | role_xxx | 1\nreview | role_yyy | 1 | impl',
          value: formationText,
          rows: 4,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 12 },
          onChange: (event) => setFormationText(event.target.value),
        })),
        workflowList.length === 0
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, '还没有工作流可引用：蓝图可以不挂工作流。')
          : [
              h('p', { className: 'muted', style: { margin: '8px 0 4px', fontSize: 12 } }, '引用的工作流（可多选）'),
              h('div', { className: 'kws' }, workflowList.map((workflow) =>
                h('button', {
                  key: workflow.id,
                  type: 'button',
                  className: joinClass('btn', pickedWorkflows.includes(workflow.id) ? 'primary' : ''),
                  style: { marginRight: 6 },
                  onClick: () => toggleWorkflow(workflow.id),
                }, workflow.name ?? workflow.id))),
            ],
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没存上：${problem}`),
        saved === true
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, item === null || item === undefined ? '已新建。' : '已保存：revision 已递增。')
          : null,
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h('button', { type: 'button', className: 'btn primary', disabled: busy === true, onClick: () => void submit() },
            busy === true ? '保存中…' : item === null || item === undefined ? '新建蓝图' : '保存蓝图'),
          h('span', { className: 'grow' }),
          h('span', { className: 'muted', style: { fontSize: 12 } }, '队形写错时按域里报的原因改'),
        ),
      )
    }

    function DefinitionsScreen(props) {
      const { data, sessionId, onChanged } = props
      const items = Array.isArray(data.items) ? data.items : []
      const roles = items.filter((item) => item.kind === 'role')
      const workflows = items.filter((item) => item.kind === 'workflow')
      const [creatingBlueprint, setCreatingBlueprint] = useState(false)
      const [opened, setOpened] = useState(null)
      // 注意：这里必须是 `${kind}:${id}` 与 opened 比。写成 `':' === opened` 会让
      // openedItem 恒为 null —— 点定义行看起来「有反应」（状态变了）但什么都不渲染。
      const openedItem = items.find((item) => `${item.kind}:${item.id}` === opened) ?? null
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'bar', style: { padding: '0 0 10px' } },
          h(
            'button',
            {
              type: 'button',
              className: joinClass('btn', creatingBlueprint === true ? 'primary' : ''),
              onClick: () => setCreatingBlueprint(creatingBlueprint !== true),
            },
            creatingBlueprint === true ? '收起' : '新建蓝图',
          ),
        ),
        creatingBlueprint === true
          ? h(BlueprintEditBox, {
              item: null,
              roles,
              workflows,
              sessionId,
              onChanged: () => {
                setCreatingBlueprint(false)
                if (onChanged !== undefined) onChanged()
              },
            })
          : null,
        items.length === 0
          ? h(EmptyState, {
              reason: '这个项目还没有定义副本。定义来自内置角色、会话里保存的修改，以及从全局库复制。',
              action: null,
            })
          : h(
              'div',
              { className: 'list' },
              items.map((item) =>
                h(
                  'div',
                  { key: `${item.kind}:${item.id}`, className: 'item pick', onClick: () => setOpened(opened === `${item.kind}:${item.id}` ? null : `${item.kind}:${item.id}`) },
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
        openedItem === null
          ? null
          : openedItem.kind === 'role'
            ? h(
                'div',
                null,
                h('div', { className: 'box', style: { padding: '12px 16px', marginTop: 12 } }, h(RoleDetailBox, { item: openedItem, members: props.members })),
                h(RoleEditBox, { item: openedItem, sessionId, onChanged }),
              )
            : openedItem.kind === 'blueprint'
              ? h(BlueprintEditBox, { item: openedItem, roles, workflows, sessionId, onChanged })
              : null,
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

    /**
     * 列表外壳。空态直接交给 {@link EmptyState}（要求「为什么空 + 下一步」），
     * 传字符串是过去的用法，会被当成 reason、没有 action —— 所以新代码请传节点。
     */
    function ListPane(props) {
      return h(
        'div',
        { className: props.tight === true ? 'body pad tight' : 'body pad' },
        props.items.length === 0
          ? typeof props.empty === 'string'
            ? h(EmptyState, { reason: props.empty, action: props.emptyAction })
            : props.empty
          : h('div', { className: 'list' }, props.children),
        props.footer ?? null,
      )
    }

    function RunsScreen(props) {
      const items = Array.isArray(props.data.items) ? props.data.items : []
      const onOpenRun = props.onOpenRun
      return h(
        ListPane,
        { items, tight: true, empty: '还没有工作流运行。实例化一个工作流后，Run 与它的任务图会一起写进账本。' },
        items.map((run) =>
          h(ListRow, {
            key: run.id,
            title: h('span', null, run.workflowId, ' ', h('span', { className: 'muted' }, run.id)),
            sub: [
              `rev ${run.revision}`,
              `定义 rev ${run.workflowRevision}`,
              `完成规则 rev ${run.completionRevision}`,
              `${run.taskCount} 个任务`,
            ],
            right: h('span', { className: 'st-chip' }, RUN_STATUS[run.status] ?? run.status),
            ...(onOpenRun === undefined ? {} : { onClick: () => onOpenRun(run) }),
          }),
        ),
      )
    }

    /** 单个运行的详情：完成规则、templateKey → taskId 映射与各任务当前状态。 */
    function RunDetail(props) {
      const detail = usePanelData(props.sessionId, 'run', { runId: props.runId })
      return h(Data, { data: detail, what: '运行详情', onRetry: detail.reload }, (data) => {
        const run = data.run ?? {}
        const completion = data.completion ?? null
        const tasks = Array.isArray(data.tasks) ? data.tasks : []
        return h(
          'div',
          { className: 'body pad' },
          h(SectionHeader, {
            title: '运行',
            note: String(run.id ?? props.runId),
            action: h('button', { type: 'button', className: 'btn', onClick: props.onBack }, '返回流程'),
          }),
          h(
            'div',
            { className: 'list', style: { marginTop: 8 } },
            h(
              'div',
              { className: 'item' },
              h(
                'div',
                { className: 'l' },
                h('div', { className: 't' }, String(run.workflowId ?? '—')),
                h(
                  'div',
                  { className: 's' },
                  h('span', { className: 'mono' }, `rev ${run.revision ?? '—'}`),
                  h('span', { className: 'mono' }, `定义 rev ${run.workflowRevision ?? '—'}`),
                  h('span', { className: 'mono' }, `完成规则 rev ${run.completionRevision ?? '—'}`),
                  h('span', { className: 'mono' }, `${run.taskIds?.length ?? tasks.length} 个任务`),
                ),
              ),
              h('div', { className: 'r' }, h('span', { className: 'st-chip' }, RUN_STATUS[run.status] ?? String(run.status ?? '—'))),
            ),
          ),
          h(
            'div',
            { className: 'layer' },
            h('b', null, '完成规则'),
            h('span', null, completion === null ? '还没有完成规则' : `templateKey → task 映射 ${completion.templateTasks === undefined ? '' : Object.keys(completion.templateTasks).length} 条`),
            h('i', { className: 'rule' }),
          ),
          completion === null
            ? h('p', { className: 'muted', style: { fontSize: 12, margin: '0 0 8px' } }, '这个运行还没有写完成规则（实例化时缺 completion）。')
            : h(
                'div',
                { className: 'box mono', style: { padding: '10px 12px', marginBottom: 10, fontSize: 12, whiteSpace: 'pre-wrap' } },
                JSON.stringify(completion, null, 2),
              ),
          h(
            'div',
            { className: 'layer' },
            h('b', null, '任务'),
            h('span', null, `${tasks.length} 个`),
            h('i', { className: 'rule' }),
          ),
          tasks.length === 0
            ? h('p', { className: 'muted', style: { fontSize: 12, margin: 0 } }, '这个运行还没挂任务。')
            : h(
                'div',
                { className: 'list' },
                tasks.map((task, index) =>
                  h(
                    'div',
                    { key: task.id ?? `task-${index}`, className: 'item' },
                    h(
                      'div',
                      { className: 'l' },
                      h('div', { className: 't' }, String(task.title ?? task.id ?? '—')),
                      h(
                        'div',
                        { className: 's' },
                        h('span', { className: 'mono' }, String(task.id ?? '')),
                        task.templateKey === undefined || task.templateKey === null
                          ? null
                          : h('span', { className: 'mono' }, `templateKey ${String(task.templateKey)}`),
                      ),
                    ),
                    h('div', { className: 'r' }, h('span', { className: 'st-chip' }, String(task.status ?? '—'))),
                  ),
                ),
              ),
        )
      })
    }

    /** 副作用：三态计数 + 清单。数据面是项目级（`effects`），放在「流程」栏下看一眼就够。 */
    function EffectsSection(props) {
      const data = props.data
      const counts = data.counts ?? {}
      const items = Array.isArray(data.items) ? data.items : []
      const order = ['requested', 'accepted', 'completed', 'failed', 'cancelled', 'outcome-unknown']
      return h(
        'div',
        { className: 'body pad tight' },
        h(SectionHeader, { title: '副作用', note: `${items.length} 条` }),
        h(
          'div',
          { className: 'bar', style: { borderTop: 0, borderBottom: 0, paddingLeft: 0 } },
          order.map((key) => h('span', { key, className: 'st-chip' }, `${key} ${counts[key] ?? 0}`)),
        ),
        items.length === 0
          ? h('p', { className: 'muted', style: { fontSize: 12, margin: '6px 0 0' } }, '这个项目还没有副作用记录。')
          : h(
              'div',
              { className: 'list', style: { marginTop: 6 } },
              items.map((effect) =>
                h(
                  'div',
                  { key: effect.id, className: 'item' },
                  h(
                    'div',
                    { className: 'l' },
                    h('div', { className: 't' }, String(effect.kind)),
                    h('div', { className: 's' }, h('span', { className: 'mono' }, String(effect.id))),
                  ),
                  h('div', { className: 'r' }, h('span', { className: 'st-chip' }, String(effect.status))),
                ),
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

    /**
     * 从记忆 bank id 解析归属，规则与 `plugin/src/contracts/memory.ts` 的 `parseBankId` 一致：
     * `team:<teamId>` 是团队公开 bank，`team:<teamId>:member:<memberId>` 是成员私有 bank。
     * 客户端只用它**推导写记忆要带哪个 teamId**，解析不出来就拒绝而不是猜一个。
     */
    function parseMemoryBankId(bankId) {
      if (typeof bankId !== 'string') return null
      if (!bankId.startsWith('team:')) return null
      const rest = bankId.slice('team:'.length)
      const marker = ':member:'
      const index = rest.indexOf(marker)
      if (index === -1) return rest.length === 0 ? null : { teamId: rest, memberId: null }
      const teamId = rest.slice(0, index)
      const memberId = rest.slice(index + marker.length)
      if (teamId.length === 0 || memberId.length === 0) return null
      return { teamId, memberId }
    }

    /** 记一条长期记忆：写团队 bank（成员私有 bank 归 agent 自己用，面板不碰）。 */
    function MemoryForm(props) {
      const { sessionId, teams, onDone, onCancel } = props
      const [text, setText] = useState('')
      const [tags, setTags] = useState('')
      const [teamId, setTeamId] = useState(teams.length > 0 ? teams[0].id : '')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const submit = async () => {
        if (busy) return
        if (text.trim().length === 0) {
          setProblem('记忆正文不能为空')
          return
        }
        if (teamId.length === 0) {
          setProblem('先选一个团队：记忆按团队 bank 存')
          return
        }
        setBusy(true)
        setProblem(null)
        try {
          await callWrite('memoryRemember', sessionId, {
            confirm: true,
            params: {
              teamId,
              text: text.trim(),
              tags: tags
                .split(/[,，\s]+/)
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
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
              '这个项目还没有团队：记忆按团队 bank 存，先在会话里让队长建队。',
            )
          : null,
        h(
          Field,
          { label: '记忆正文', hint: '一句能被后来的人直接使用的事实，不要写「待补充」。' },
          h('textarea', {
            className: 'box',
            placeholder: '要记住的事实',
            value: text,
            rows: 3,
            style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
            onChange: (event) => setText(event.target.value),
          }),
        ),
        h(
          Field,
          { label: '标签', hint: '可选；逗号或空格分隔。' },
          h('input', {
            type: 'text',
            className: 'box',
            placeholder: 'gate, testing',
            value: tags,
            style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
            onChange: (event) => setTags(event.target.value),
          }),
        ),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, `没记上：${problem}`),
        h(
          'div',
          { className: 'acts', style: { marginTop: 10 } },
          h(
            'button',
            { type: 'button', className: 'btn primary', disabled: busy === true, onClick: () => void submit() },
            busy === true ? '写入中…' : '记住',
          ),
          h('button', { type: 'button', className: 'btn', style: { marginLeft: 8 }, onClick: onCancel }, '取消'),
        ),
      )
    }

    function MemoryScreen(props) {
      const data = props.data
      const teams = Array.isArray(props.teams) ? props.teams : []
      const sessionId = props.sessionId
      const onChanged = props.onChanged
      const banks = Array.isArray(data.banks) ? data.banks : []
      const entries = Array.isArray(data.entries) ? data.entries : []
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      const [adding, setAdding] = useState(false)
      const [forgetting, setForgetting] = useState(null)

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

      /** 遗忘一条：团队从 bankId 推出来，解析不出就拒绝（不猜归属）。 */
      const forget = async (entry, hard) => {
        const owner = parseMemoryBankId(entry.bankId)
        if (owner === null) {
          setForgetting({ id: entry.id, problem: `bank ${entry.bankId} 归属解析不出来，不敢删` })
          return
        }
        setForgetting({ id: entry.id, problem: null })
        try {
          await callWrite('memoryForget', sessionId, {
            confirm: true,
            params: {
              teamId: owner.teamId,
              ...(owner.memberId === null ? {} : { memberId: owner.memberId }),
              id: entry.id,
              ...(hard ? { hard: true } : {}),
            },
          })
          setForgetting(null)
          if (onChanged !== undefined) onChanged()
        } catch (error) {
          setForgetting({ id: entry.id, problem: messageOf(error) })
        }
      }

      return h(
        'div',
        { className: 'body flat' },
        h(
          'div',
          { className: 'bar', style: { padding: '0 16px' } },
          h(
            'button',
            { type: 'button', className: joinClass('btn', adding === true ? 'primary' : ''), onClick: () => setAdding(adding !== true) },
            adding === true ? '收起' : '记一条',
          ),
          h('span', { className: 'grow' }),
          h('span', { className: 'muted', style: { fontSize: 12 } }, `共 ${entries.length} 条`),
        ),
        adding === true
          ? h(MemoryForm, {
              sessionId,
              teams,
              onDone: () => {
                setAdding(false)
                if (onChanged !== undefined) onChanged()
              },
              onCancel: () => setAdding(false),
            })
          : null,
        h(
          ListPane,
          {
            items: entries,
            empty: '记忆库是空的。记忆只在成员真正写入、或人类在面板「记一条」之后才出现。',
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
                  forgetting !== null && forgetting.id === entry.id && forgetting.problem !== null
                    ? h('div', { className: 's' }, h('span', { className: 'mono' }, `没删成：${forgetting.problem}`))
                    : null,
                ),
                h(
                  'div',
                  { className: 'r' },
                  entry.forgotten === true
                    ? h('span', { className: 'st-chip' }, '已遗忘')
                    : [
                        h(
                          'button',
                          {
                            key: 'soft',
                            type: 'button',
                            className: 'btn',
                            style: { marginLeft: 6 },
                            disabled: sessionId === undefined,
                            onClick: () => void forget(entry, false),
                          },
                          '遗忘',
                        ),
                        h(
                          'button',
                          {
                            key: 'hard',
                            type: 'button',
                            className: 'btn',
                            style: { marginLeft: 6 },
                            disabled: sessionId === undefined,
                            title: '硬删除不可恢复：库里直接删行，只剩审计记录',
                            onClick: () => void forget(entry, true),
                          },
                          '彻底删除',
                        ),
                      ],
                ),
              ),
            ),
          ],
        ),
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
          empty: '这个项目还没有事件。每个写动作都会落一条账本事件，所以空账本意味着还没人动过它。',
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
        props.sessionId === undefined
          ? null
          : h(DestroyProjectBox, {
              projectName: props.projectName,
              sessionId: props.sessionId,
              onDone: () => {
                if (props.onChanged !== undefined) props.onChanged()
              },
            }),
      )
    }

    /**
     * 删除项目数据（设计稿 `p-settings` 的「生命周期」区）。
     *
     * 这是**唯一不可撤销**的动作，所以界面比别的写动作多一道：必须手输项目名。
     * 设计稿原话：「删除事件日志、SQLite 与生成视图，不可撤销。只在你确实要丢掉
     * 整个项目历史时使用；归档只是停止写入。」
     *
     * 两段式：先「读影响面」拿到要删的每一项与总大小，再输入项目名 + 确认。
     */
    function DestroyProjectBox(props) {
      const { projectName, sessionId, onDone } = props
      const [stage, setStage] = useState('idle')
      const [preview, setPreview] = useState(null)
      const [typed, setTyped] = useState('')
      const [problem, setProblem] = useState(null)

      const begin = async () => {
        setStage('busy')
        setProblem(null)
        try {
          const result = await callWrite('projectDestroy', sessionId, { params: {} })
          setPreview(result)
          setStage('preview')
        } catch (error) {
          setProblem(messageOf(error))
          setStage('failed')
        }
      }

      const commit = async () => {
        if (typed.trim() !== projectName) {
          setProblem('输入的项目名不对，不能删除')
          return
        }
        setStage('busy')
        setProblem(null)
        try {
          await callWrite('projectDestroy', sessionId, {
            params: { name: typed.trim() },
            action: 'confirm',
            confirmation: preview.confirmation,
            reason: '面板确认（删除项目数据）',
          })
          setPreview(null)
          setStage('done')
          if (onDone !== undefined) onDone()
        } catch (error) {
          setProblem(messageOf(error))
          setStage('failed')
        }
      }

      const busy = stage === 'busy'
      return h(
        'div',
        { className: 'box', style: { padding: '12px 16px', marginTop: 12 } },
        h(SectionHeader, { title: '生命周期', note: '不可撤销' }),
        h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } },
          '删除事件日志、SQLite 与生成视图，不可撤销。只在你确实要丢掉整个项目历史时使用；归档只是停止写入。'),
        stage === 'done'
          ? h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } },
              '项目数据已删除。这个工作区下次打开会重新初始化一个空项目。')
          : preview === null
            ? h('div', { className: 'acts', style: { marginTop: 10 } },
                h('button', { type: 'button', className: 'btn', disabled: busy, onClick: () => void begin() },
                  busy ? '读影响面…' : '删除项目数据'))
            : h('div', null,
                h('div', { className: 'rc-h', style: { marginTop: 10 } },
                  h(Dot, { tone: 'fail' }),
                  h('span', { className: 'nm' }, preview.summary === undefined ? '删除项目数据' : preview.summary),
                  h('span', { className: 'tag' }, '不可撤销')),
                impactLines(preview.impact).map((line) =>
                  h('p', { key: line, className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, line)),
                h('p', { className: 'muted', style: { margin: '10px 0 4px', fontSize: 12 } },
                  '输入项目名「' + projectName + '」继续：'),
                h('input', {
                  type: 'text',
                  className: 'box',
                  placeholder: projectName,
                  value: typed,
                  style: { display: 'block', width: '100%', padding: '8px 10px', fontSize: 13 },
                  onChange: (event) => setTyped(event.target.value),
                }),
                h('div', { className: 'acts', style: { marginTop: 10 } },
                  h('button', {
                    type: 'button',
                    className: 'btn primary',
                    disabled: busy || typed.trim() !== projectName,
                    onClick: () => void commit(),
                  }, busy ? '删除中…' : '删除项目数据'),
                  h('button', { type: 'button', className: 'btn', style: { marginLeft: 8 },
                    onClick: () => { setPreview(null); setTyped(''); setStage('idle') } }, '取消')),
              ),
        problem === null
          ? null
          : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, '没成功：' + problem),
      )
    }

    /**
     * 待你确认（`p-approval`）—— 从概览横幅的「逐项确认」进来，是一整页而不是折叠区。
     *
     * 设计稿分三态（待确认 / 已处理 / 已拒绝）。这里只做两态，因为**数据只支持两态**：
     *   - 待确认：任务停在 review（等人下门禁结论）+ 待确认的全局发布；
     *   - 已处理：已下过的门禁裁决（含拒绝的，用 outcome 区分）。
     * 「已拒绝」不单独一栏：门禁的拒绝结果和通过一样是裁决，放在已处理里按 outcome 标色更省事。
     *
     * **计划批准 / 队长接管 这两类画不出来**，原因见 `queries.ts` 的
     * `pendingApprovalsView`：前者域里没有 draft 聚合，后者是当场两段式、不排队。
     * 界面照实说明，不用假数据凑数。
     */
    function ApprovalScreen(props) {
      const data = props.data ?? {}
      const pending = Array.isArray(data.pending) ? data.pending : []
      const decided = Array.isArray(data.decided) ? data.decided : []
      const [lane, setLane] = useState('pending')
      const unsupported = data.unsupported ?? {}

      const kindLabel = (kind) =>
        kind === 'gate' ? '门禁裁决' : kind === 'publish' ? '全局发布' : kind === 'handoff' ? '队长接管' : String(kind)
      const rows = lane === 'pending' ? pending : decided

      const card = (item) =>
        h(
          'div',
          { key: item.id, className: 'item' },
          h(
            'div',
            { className: 'l' },
            h('div', { className: 't' }, item.title),
            h(
              'div',
              { className: 's' },
              h('span', null, kindLabel(item.kind)),
              item.detail === null || item.detail === undefined ? null : h('span', { className: 'mono' }, String(item.detail)),
              item.by === null || item.by === undefined ? null : h('span', null, `提出：${String(item.by)}`),
              lane === 'pending'
                ? h('span', { className: 'mono' }, String(item.since ?? ''))
                : h('span', { className: 'mono' }, `${String(item.outcome ?? '')} · ${String(item.decidedAt ?? '')}`),
            ),
          ),
          h(
            'div',
            { className: 'r' },
            item.kind === 'gate' && props.onOpenTask !== undefined
              ? h('button', { type: 'button', className: 'btn', onClick: () => props.onOpenTask(item) }, '看任务')
              : null,
          ),
        )

      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h('button', { type: 'button', className: 'btn', onClick: () => props.onBack() }, '返回概览'),
          h(SectionHeader, { title: '待你确认', note: `${String(pending.length)} 件在等` }),
        ),
        h('p', { className: 'muted', style: { margin: '0 0 10px', fontSize: 12 } },
          '这些动作队长只能提案；执行必须来自人类入口并重新校验 —— confirm: true 不是授权。'),
        h(
          'div',
          { className: 'acts', style: { marginBottom: 10 } },
          h('button', {
            type: 'button',
            className: lane === 'pending' ? 'btn primary' : 'btn',
            onClick: () => setLane('pending'),
          }, `待确认 ${String(pending.length)}`),
          h('button', {
            type: 'button',
            className: lane === 'decided' ? 'btn primary' : 'btn',
            style: { marginLeft: 8 },
            onClick: () => setLane('decided'),
          }, `已处理 ${String(decided.length)}`),
        ),
        rows.length === 0
          ? h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } },
              lane === 'pending' ? '没有等你确认的事。门禁裁决与待确认的发布都会出现在这里。' : '还没有已处理的裁决。')
          : h('div', { className: 'list' }, rows.map(card)),
        unsupported.planApproval === true || unsupported.captainTakeover === true
          ? h('p', { className: 'muted', style: { margin: '14px 0 0', fontSize: 12 } },
              '这一页覆盖门禁裁决、全局发布与队长接管。「计划批准」还没有对应的领域模型'
              + '（团队只有在岗 / 归档 / 解散，没有草稿态），所以不会出现在这里。')
          : null,
      )
    }

    // 导航里的九栏现在都有端点；留这个兜底是为了将来加栏时的默认文案。
    const PROJECT_FALLBACK = { title: '未接入', reason: '这一栏还没有端点。' }

    function ProjectView(props) {
      const { sessionId } = props
      const [tab, setTab] = useState('overview')
      const [taskId, setTaskId] = useState(null)
      /** 概览底部「待你确认」明细默认折叠（与顶部横幅重复）；点横幅才展开。 */
      const [approvalsOpen, setApprovalsOpen] = useState(false)
      const [runId, setRunId] = useState(null)

      useEffect(() => {
        return mountDesignStyle()
      }, [])

      const status = usePanelData(sessionId, METHOD_STATUS)
      const overview = usePanelData(sessionId, METHOD_OVERVIEW)
      const board = usePanelData(sessionId, METHOD_BOARD)
      const definitions = usePanelData(sessionId, METHOD_DEFINITIONS)
      const migration = usePanelData(tab === 'settings' ? sessionId : undefined, METHOD_MIGRATION)
      // 五个后接的只读面：只在切到那一栏时才请求，避免每次开面板打七枪。
      const runs = usePanelData(tab === 'runs' ? sessionId : undefined, 'runs')
      const effects = usePanelData(tab === 'runs' ? sessionId : undefined, 'effects')
      const knowledge = usePanelData(tab === 'knowledge' ? sessionId : undefined, 'knowledge')
      const memory = usePanelData(tab === 'memory' ? sessionId : undefined, 'memory')
      const audit = usePanelData(tab === 'audit' ? sessionId : undefined, 'audit', { limit: 200 })
      // 概览底部那 5 条「最近事件」：只在概览上拉，切走就停，不额外多打一枪。
      const overviewEvents = usePanelData(tab === 'overview' ? sessionId : undefined, 'audit', { limit: 5 })
      // 待你确认整页：只在真的打开它时才拉，切走就停。
      const approvals = usePanelData(approvalsOpen === true ? sessionId : undefined, 'pendingApprovals')
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
        void overviewEvents.reload()
        void board.reload()
        void definitions.reload()
        if (tab === 'runs') {
          void runs.reload()
          void effects.reload()
        }
        if (tab === 'settings') {
          void settings.reload()
          void migration.reload()
        }
        if (tab === 'knowledge') void knowledge.reload()
        if (tab === 'memory') void memory.reload()
        if (tab === 'audit') void audit.reload()
      }

      // 栏内跳转（概览横幅的「去任务栏处理」用）：先收掉详情层，再切栏。
      const go = (next) => {
        setTaskId(null)
        setRunId(null)
        setTab(next)
      }

      let body
      if (taskId !== null) {
        body = h(TaskDetail, { taskId, sessionId, onBack: () => setTaskId(null) })
      } else if (approvalsOpen === true) {
        // 设计稿 p-approval 是一整页（从概览横幅的「逐项确认」进来），不是折叠区。
        body = h(Data, { data: approvals, what: '待你确认' }, (data) =>
          h(ApprovalScreen, {
            data,
            onBack: () => setApprovalsOpen(false),
            onOpenTask: (item) => {
              setApprovalsOpen(false)
              setTaskId(item.id)
            },
          }))
      } else if (tab === 'overview') {
        body = h(Data, { data: overview, what: '项目概览' }, (data) =>
          h(OverviewScreen, {
            data,
            events: overviewEvents.data?.items,
            board: board.data,
            onSelect: go,
            onExpandApprovals: () => setApprovalsOpen(true),
          }))
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
          h(DefinitionsScreen, { data, sessionId, members: [], onChanged: () => void definitions.reload() }))
      } else if (tab === 'runs') {
        body =
          runId === null
            ? [
                h(Data, { data: runs, what: '工作流运行' }, (data) =>
                  h(RunsScreen, { data, onOpenRun: (run) => setRunId(run.id) })),
                h(LanesSection, { runs: runs.data, board: board.data }),
                h(Data, { data: effects, what: '副作用' }, (data) => h(EffectsSection, { data })),
              ]
            : h(RunDetail, { runId, sessionId, onBack: () => setRunId(null) })
      } else if (tab === 'knowledge') {
        body = h(Data, { data: knowledge, what: '项目知识' }, (data) => h(KnowledgeScreen, { data }))
      } else if (tab === 'memory') {
        body = h(Data, { data: memory, what: '长期记忆' }, (data) =>
          h(MemoryScreen, {
            data,
            teams: overview.data?.teams ?? [],
            sessionId,
            onChanged: () => void memory.reload(),
          }))
      } else if (tab === 'audit') {
        body = h(Data, { data: audit, what: '审计' }, (data) => h(AuditScreen, { data }))
      } else if (tab === 'settings') {
        body = [
          h(Data, { data: settings, what: '项目设置' }, (data) =>
            h(SettingsScreen, {
              data,
              sessionId,
              projectName,
              onChanged: () => void settings.reload(),
            })),
          h(Data, { data: migration, what: 'v1 迁移影响面' }, (data) => h(MigrationScreen, { data })),
        ]
      } else {
        const missing = PROJECT_FALLBACK
        body = h(Unavailable, { ...missing, title: tab })
      }

      // A 批（p-unavailable）：第一枪就失败时整屏交给未初始化壳。
      // 放在这里（所有 hook 之后）是为了不改 hook 顺序；导航仍然可点，
      // 但每一栏都读同一份状态，所以壳里明说「每栏都会是空的」。
      if (status.status === 'error') {
        return h(Shell, {
          initials: 'mt',
          railTitle: '团队视图 · 未初始化',
          nav: PROJECT_NAV,
          active: tab,
          onSelect: go,
          pane: [h(NotInitializedShell, { reason: status.reason, onRetry: () => void status.reload() })],
        })
      }

      return h(Shell, {
        initials: String(projectName).slice(0, 2),
        railTitle: `团队视图 ${projectName}`,
        nav: PROJECT_NAV,
        active: tab,
        onSelect: go,
        pane: [
          h(PaneHeader, { title: projectName, scope, summary, onRefresh, busy: status.status === 'loading' }),
          h(StatusBar, { chips, note: '只读 · 与看板、审计同源' }),
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

    function globalEntryRows(entries, onOpen) {
      return entries.map((entry) =>
        h(
          'div',
          {
            key: `${entry.kind}:${entry.id}`,
            className: onOpen === undefined ? 'item' : 'item pick',
            onClick: onOpen === undefined ? undefined : () => onOpen(entry),
          },
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

    /**
     * 全局定义详情（L2-H / `g-role` `g-workflow` `g-blueprint`）：直接渲染文件正文里认得的字段。
     *
     * 为什么按字段挑着渲染而不是把 JSON 全打出来：发布到全局的是「定义资产」，正文里有
     * 时间戳、哈希这些过程字段，界面要看的是 profile / 模板 / 组成。认不出的字段不猜。
     */
    function GlobalEntryDetail(props) {
      const entry = props.entry
      const content = entry?.content
      if (content === null || typeof content !== 'object') {
        return h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, '这个文件解析不出正文（可能不是本工具写的定义）。')
      }
      const record = content
      const list = (value) => (Array.isArray(value) ? value : [])
      const sections = []
      if (entry.kind === 'role') {
        const profile = record.profile ?? {}
        const caps = record.capabilities ?? {}
        sections.push(h(SectionHeader, { key: 'p', title: '职责', note: String(profile.name ?? entry.name) }))
        sections.push(
          h(
            'div',
            { key: 'pb', className: 's', style: { marginTop: 4 } },
            h('span', null, String(profile.purpose ?? '')),
          ),
        )
        sections.push(h('p', { key: 'pi', className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, String(profile.instructions ?? '')))
        sections.push(h(SectionHeader, { key: 'c', title: '能力', note: `${list(caps.tools?.allow).length} 工具 / ${list(caps.skills).length} 技能` }))
        sections.push(
          h(
            'div',
            { key: 'ck', className: 'kws', style: { marginTop: 6 } },
            list(caps.tools?.allow).map((tool) => h('span', { key: `t-${tool}`, className: 'kw' }, String(tool))),
            list(caps.skills).map((skill) => h('span', { key: `s-${skill}`, className: 'kw' }, String(skill))),
          ),
        )
        sections.push(h(SectionHeader, { key: 'ref', title: '被项目引用', note: '看各项目的「定义」栏' }))
        sections.push(
          h(
            'p',
            { key: 'refb', className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } },
            '全局库只记定义本身，不记哪个项目抄了副本；某个项目里有哪些定义，去那个项目的「定义」栏看。',
          ),
        )
      } else if (entry.kind === 'workflow') {
        const templates = list(record.templates)
        sections.push(h(SectionHeader, { key: 't', title: '任务模板', note: `${templates.length} 个` }))
        sections.push(
          templates.length === 0
            ? h('p', { key: 'te', className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '这份工作流没有任务模板。')
            : h(
                'div',
                { key: 'tl', className: 'list', style: { marginTop: 6 } },
                templates.map((template) =>
                  h(ListRow, {
                    key: String(template.key ?? template.title),
                    title: String(template.title ?? template.key ?? '—'),
                    sub: [
                      `key ${String(template.key ?? '—')}`,
                      template.requiredRoleId === null || template.requiredRoleId === undefined ? '不限角色' : String(template.requiredRoleId),
                      `验收 ${list(template.acceptance).length} 条`,
                    ],
                    right: h('span', { className: 'st-chip' }, list(template.dependsOn).length === 0 ? '无前置' : `前置 ${list(template.dependsOn).length}`),
                  }),
                ),
              ),
        )
        const completion = record.completion ?? null
        sections.push(h(SectionHeader, { key: 'cp', title: '完成规则', note: completion === null ? '未声明' : String(completion.mode ?? '—') }))
      } else {
        // 引用解析：蓝图上写的是 id，但那份角色/工作流不一定真在全局库里。
        // 解析不到的必须标出来 —— 否则这份蓝图装到别的机器上会缺件，而界面看起来一切正常。
        const known = new Set((Array.isArray(props.entries) ? props.entries : []).map((item) => item.kind + ':' + item.id))
        const refRow = (kind, ref) => {
          const missing = !known.has(kind + ':' + String(ref))
          return h(
            'span',
            { key: kind + ':' + String(ref), className: missing ? 'kw miss' : 'mono', title: missing ? '全局库里没有这份定义' : undefined },
            missing ? String(ref) + ' · 缺失' : String(ref),
          )
        }
        const formation = list(record.formation)
        sections.push(h(SectionHeader, { key: 'f', title: '组建槽位', note: `${formation.length} 个` }))
        sections.push(
          formation.length === 0
            ? h('p', { key: 'fe', className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '这份蓝图没有组建槽位。')
            : h(
                'div',
                { key: 'fl', className: 's', style: { marginTop: 6 } },
                formation.map((slot) => refRow('role', slot.roleId ?? '—')),
              ),
        )
        const workflows = list(record.workflows)
        sections.push(h(SectionHeader, { key: 'w', title: '关联工作流', note: `${workflows.length} 个` }))
        sections.push(
          workflows.length === 0
            ? h('p', { key: 'we', className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, '这份蓝图没有关联工作流。')
            : h(
                'div',
                { key: 'wl', className: 's', style: { marginTop: 6 } },
                workflows.map((workflowId) => refRow('workflow', workflowId)),
              ),
        )
        sections.push(h(SectionHeader, { key: 'd', title: '默认配置', note: record.defaults === undefined ? '无覆盖' : '有覆盖' }))
      }
      return h(
        'div',
        { style: { marginTop: 8 } },
        h(SectionHeader, {
          title: entry.name,
          note: entry.file,
          action: props.onBack === undefined ? undefined : h('button', { type: 'button', className: 'btn', onClick: props.onBack }, '返回列表'),
        }),
        ...sections,
      )
    }

    /**
     * 全局库定义编辑（G4）—— 直接改全局库里的一个定义，不经项目。
     *
     * 为什么复用项目侧的字段形状：角色就是 profile + capabilities，蓝图就是 formation + workflows，
     * 换个作用域不该换一套术语。与项目侧的差别只有两点：
     *   1. 提交走 globalDefinitionSave（token 通道），必须带上 entry.contentHash ——
     *      服务端据此判断「你改的是不是你看到的那个版本」；
     *   2. 影响面要先看：全局蓝图引用的必须是全局角色。
     *
     * 全局条目不属任何项目，所以这张表单也**不带 sessionId**（写通道对 globalDefinitionSave 免会话）。
     */
    function GlobalDefinitionEdit(props) {
      const { entry, entries, onDone } = props
      const content = entry === undefined || entry === null ? null : entry.content
      const record = content !== null && typeof content === 'object' ? content : {}
      const kind = entry === undefined || entry === null ? 'role' : entry.kind
      const profile0 = kind === 'role' ? (record.profile ?? {}) : {}
      const [name, setName] = useState(String(profile0.name ?? (entry === undefined ? '' : entry.name) ?? ''))
      const [purpose, setPurpose] = useState(String(profile0.purpose ?? ''))
      const [instructions, setInstructions] = useState(String(profile0.instructions ?? ''))
      const [specialties, setSpecialties] = useState(Array.isArray(profile0.specialties) ? profile0.specialties.join(', ') : '')
      const [blueprintName, setBlueprintName] = useState(String(record.name ?? (entry === undefined ? '' : entry.name) ?? ''))
      const [description, setDescription] = useState(String(record.description ?? ''))
      const [formationText, setFormationText] = useState(
        (Array.isArray(record.formation) ? record.formation : [])
          .map((slot) => [slot.key, slot.roleId, String(slot.count === undefined ? 1 : slot.count), slot.parentSlotKey === null || slot.parentSlotKey === undefined ? '' : slot.parentSlotKey].join(' | '))
          .join('\n'),
      )
      const [workflowText, setWorkflowText] = useState((Array.isArray(record.workflows) ? record.workflows : []).join(', '))
  const [wfName, setWfName] = useState(String(record.name ?? (entry === undefined ? '' : entry.name) ?? ''))
  const [wfDescription, setWfDescription] = useState(String(record.description ?? ''))
  const [templateText, setTemplateText] = useState(
    (Array.isArray(record.templates) ? record.templates : [])
      .map((template) => [
        template.key,
        template.title,
        (Array.isArray(template.acceptance) ? template.acceptance : []).join(' / '),
        template.requiredRoleId === null || template.requiredRoleId === undefined ? '' : template.requiredRoleId,
        (Array.isArray(template.dependsOn) ? template.dependsOn : []).join(' / '),
        (Array.isArray(template.gate === undefined ? [] : template.gate.commands) ? template.gate.commands : []).join(' / '),
      ].join(' | '))
      .join('\n'),
  )
      const [stage, setStage] = useState('idle')
      const [preview, setPreview] = useState(null)
      const [problem, setProblem] = useState(null)
      const [saved, setSaved] = useState(false)
      const roleList = (Array.isArray(entries) ? entries : []).filter((item) => item.kind === 'role')
      const workflowList = (Array.isArray(entries) ? entries : []).filter((item) => item.kind === 'workflow')
    
      const buildDefinition = () => {
        if (kind === 'role') {
          if (name.trim().length === 0) return { problem: '角色名不能为空' }
          return {
            definition: {
              ...record,
              profile: {
                ...profile0,
                name: name.trim(),
                purpose: purpose.trim(),
                instructions: instructions.trim(),
                specialties: specialties.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item.length > 0),
              },
            },
          }
        }
        if (kind === 'workflow') {
      if (wfName.trim().length === 0) return { problem: '工作流名称不能为空' }
      const templates = []
      const rows = templateText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      for (let index = 0; index < rows.length; index += 1) {
        const parts = rows[index].split('|').map((item) => item.trim())
        if (parts.length < 3) {
          return { problem: '第 ' + String(index + 1) + ' 个模板格式不对：key | 标题 | 验收（| 角色 | 依赖 | 命令）' }
        }
        const split = (value) => (value === undefined || value.length === 0 ? [] : value.split(/[/,，\s]+/).map((item) => item.trim()).filter((item) => item.length > 0))
        templates.push({
          key: parts[0],
          title: parts[1],
          description: '',
          acceptance: split(parts[2]),
          requiredRoleId: parts[3] === undefined || parts[3].length === 0 ? null : parts[3],
          dependsOn: split(parts[4]),
          gate: { commands: split(parts[5]), requireEvidence: false, requireArtifacts: false },
          deliverable: null,
        })
      }
      if (templates.length === 0) return { problem: '工作流至少需要一个任务模板' }
      return {
        definition: {
          ...record,
          name: wfName.trim(),
          description: wfDescription.trim(),
          templates,
          completion: record.completion === undefined ? { mode: 'all-tasks', requiredKeys: [] } : record.completion,
        },
      }
    }
        if (blueprintName.trim().length === 0) return { problem: '蓝图名不能为空' }
        const formation = []
        const lines = formationText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
        for (let index = 0; index < lines.length; index += 1) {
          const parts = lines[index].split('|').map((item) => item.trim())
          if (parts.length < 3) return { problem: '第 ' + String(index + 1) + ' 行格式不对：key | 角色 | 数量（| 父槽位）' }
          const count = Number(parts[2])
          if (!Number.isInteger(count) || count < 1) return { problem: '第 ' + String(index + 1) + ' 行数量必须是正整数' }
          formation.push({ key: parts[0], roleId: parts[1], count, parentSlotKey: parts.length > 3 && parts[3].length > 0 ? parts[3] : null })
        }
        if (formation.length === 0) return { problem: '至少需要一个组建槽位' }
        return {
          definition: {
            ...record,
            name: blueprintName.trim(),
            description: description.trim(),
            formation,
            workflows: workflowText.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item.length > 0),
            defaults: record.defaults === undefined ? {} : record.defaults,
          },
        }
      }
    
      const submitParams = (built) => ({
        kind: kind,
        id: entry.id,
        definition: built.definition,
        expectedHash: entry.contentHash === undefined ? null : entry.contentHash,
      })
    
      const begin = async () => {
        const built = buildDefinition()
        if (built.problem !== undefined) { setProblem(built.problem); return }
        setStage('busy')
        setProblem(null)
        setSaved(false)
        try {
          const result = await callWrite('globalDefinitionSave', undefined, { params: submitParams(built) })
          setPreview(result)
          setStage('preview')
        } catch (error) {
          setProblem(messageOf(error))
          setStage('failed')
        }
      }
    
      const commit = async () => {
        const built = buildDefinition()
        if (built.problem !== undefined) { setProblem(built.problem); return }
        setStage('busy')
        setProblem(null)
        try {
          await callWrite('globalDefinitionSave', undefined, {
            params: submitParams(built),
            action: 'confirm',
            confirmation: preview.confirmation,
            reason: '面板确认（全局库直改）',
          })
          setPreview(null)
          setStage('idle')
          setSaved(true)
          if (onDone !== undefined) onDone()
        } catch (error) {
          setProblem(messageOf(error))
          setStage('failed')
        }
      }
    
      const busy = stage === 'busy'

      /** 下架：两段式（预览影响面 → 确认）；语义是「从目录隐藏，不删文件」。 */
      const [unpublishStage, setUnpublishStage] = useState('idle')
      const [unpublishPreview, setUnpublishPreview] = useState(null)
      const beginUnpublish = async () => {
        setUnpublishStage('busy')
        setProblem(null)
        try {
          const result = await callWrite('globalUnpublish', undefined, {
            params: { kind: kind, id: entry.id, expectedHash: entry.contentHash === undefined ? null : entry.contentHash },
          })
          setUnpublishPreview(result)
          setUnpublishStage('preview')
        } catch (error) {
          setProblem(messageOf(error))
          setUnpublishStage('failed')
        }
      }
      const commitUnpublish = async () => {
        setUnpublishStage('busy')
        setProblem(null)
        try {
          await callWrite('globalUnpublish', undefined, {
            params: { kind: kind, id: entry.id, expectedHash: entry.contentHash === undefined ? null : entry.contentHash },
            action: 'confirm',
            confirmation: unpublishPreview.confirmation,
            reason: '面板确认（下架全局定义）',
          })
          setUnpublishPreview(null)
          setUnpublishStage('idle')
          setSaved(true)
          if (onDone !== undefined) onDone()
        } catch (error) {
          setProblem(messageOf(error))
          setUnpublishStage('failed')
        }
      }

      const textInput = (value, onChange, placeholder) =>
        h('input', { type: 'text', className: 'box', placeholder, value,
          style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
          onChange: (event) => onChange(event.target.value) })
      const field = (label, hint, control) => h(Field, { label, hint }, control)
      const toolCount = (Array.isArray(record.capabilities) ? 0 : Array.isArray(record.capabilities === undefined ? undefined : record.capabilities.tools === undefined ? undefined : record.capabilities.tools.allow) ? record.capabilities.tools.allow.length : 0)
    
      const form =
        kind === 'role'
          ? [
              field('角色名', undefined, textInput(name, setName, '角色名')),
              field('用途', '一句话：这个角色解决什么问题。', textInput(purpose, setPurpose, '用途')),
              h(Field, { label: '工作说明', hint: '写清楚怎么做、边界在哪里。' }, h('textarea', {
                className: 'box', placeholder: '工作说明', value: instructions, rows: 3,
                style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 13 },
                onChange: (event) => setInstructions(event.target.value),
              })),
              field('专长', '可选；逗号或空格分隔。', textInput(specialties, setSpecialties, '专长')),
              h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } },
                '能力集不在这里改（保存时原样带回）；工具 ' + String(toolCount) + ' 个'),
            ]
        : kind === 'workflow'
          ? [
              field('工作流名称', undefined, textInput(wfName, setWfName, '工作流名称')),
              field('说明', undefined, textInput(wfDescription, setWfDescription, '说明')),
              h(Field, {
                label: '任务模板',
                hint: '每行一个：key | 标题 | 验收（多条用 / 分隔）| 所需角色（可空）| 依赖 key（可空）| 门禁命令（可空）',
              }, h('textarea', {
                className: 'box mono',
                placeholder: 'impl | 实现 | 可验证 / 测试绿 | | | node --test',
                value: templateText, rows: 6,
                style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 12 },
                onChange: (event) => setTemplateText(event.target.value),
              })),
              h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } },
                '完成规则不在这里改（保存时原样带回）：' + String(record.completion === undefined ? '未声明' : String(record.completion.mode))),
            ]
          : kind === 'blueprint'
            ? [
                field('蓝图名', undefined, textInput(blueprintName, setBlueprintName, '蓝图名')),
                field('说明', undefined, textInput(description, setDescription, '说明')),
                h(Field, {
                  label: '组建槽位',
                  hint: roleList.length === 0
                    ? '全局库里还没有角色，先有全局角色再写槽位。每行：key | 角色 | 数量（| 父槽位）'
                    : '每行一个：key | 角色 | 数量（| 父槽位）。可用全局角色：' + roleList.map((item) => item.id).join(' / '),
                }, h('textarea', {
                  className: 'box mono',
                  placeholder: 'impl | role_xxx | 1\nreview | role_yyy | 1 | impl',
                  value: formationText, rows: 4,
                  style: { display: 'block', width: '100%', marginTop: 2, padding: '8px 10px', fontSize: 12 },
                  onChange: (event) => setFormationText(event.target.value),
                })),
                field('关联工作流', workflowList.length === 0 ? '全局库里还没有工作流。' : '逗号分隔；必须是全局库里的工作流 id。', textInput(workflowText, setWorkflowText, 'wf_1, wf_2')),
              ]
              : [h('p', { className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } },
                  '这份定义的正文不是本工具能编辑的形状（可能是别的版本写的）。')]
    
      const action =
        preview === null
          ? h('div', { className: 'acts', style: { marginTop: 10 } },
              h('button', { type: 'button', className: 'btn primary', disabled: busy, onClick: () => void begin() },
                busy ? '读影响面…' : '预览并准备保存'))
          : h('div', { className: 'box', style: { padding: '12px 14px', marginTop: 10 } },
              h('div', { className: 'rc-h' }, h(Dot, { tone: 'gate' }),
                h('span', { className: 'nm' }, preview.summary === undefined ? '全局直改' : preview.summary),
                h('span', { className: 'tag' }, '待确认')),
              impactLines(preview.impact).map((line) =>
                h('p', { key: line, className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, line)),
              h('div', { className: 'acts', style: { marginTop: 10 } },
                h('button', { type: 'button', className: 'btn primary', disabled: busy, onClick: () => void commit() },
                  busy ? '提交中…' : '确认写入全局库'),
                h('button', { type: 'button', className: 'btn', style: { marginLeft: 8 },
                  onClick: () => { setPreview(null); setStage('idle') } }, '取消')))
    
      return h('div', { className: 'box', style: { padding: '12px 16px', marginTop: 12 } },
        h('p', { className: 'muted', style: { margin: '0 0 6px', fontSize: 12 } },
          '直接改全局库里的这份定义（改完所有引用它的项目下次读到新版本；审计留 previousHash）'),
        ...form,
        action,
        problem === null ? null : h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, '没成功：' + problem),
        saved === true ? h('p', { className: 'muted', style: { fontSize: 12, margin: '8px 0 0' } }, '已写入全局库。') : null,
        h('div', { style: { marginTop: 14, paddingTop: 10 } },
          h('p', { className: 'muted', style: { margin: '0 0 6px', fontSize: 12 } },
            '下架只是从目录里隐藏：文件与审计都保留，已经引用它的工作流/蓝图/团队照常能读到这一版。'),
          unpublishPreview === null
            ? h('button', {
                type: 'button',
                className: 'btn',
                disabled: busy,
                onClick: () => void beginUnpublish(),
              }, unpublishStage === 'busy' ? '读影响面…' : '下架这份定义')
            : h('div', { className: 'box', style: { padding: '10px 12px' } },
                h('div', { className: 'rc-h' }, h(Dot, { tone: 'gate' }),
                  h('span', { className: 'nm' }, unpublishPreview.summary === undefined ? '下架' : unpublishPreview.summary),
                  h('span', { className: 'tag' }, '待确认')),
                impactLines(unpublishPreview.impact).map((line) =>
                  h('p', { key: line, className: 'muted', style: { margin: '6px 0 0', fontSize: 12 } }, line)),
                h('div', { className: 'acts', style: { marginTop: 10 } },
                  h('button', { type: 'button', className: 'btn primary', disabled: busy, onClick: () => void commitUnpublish() },
                    unpublishStage === 'busy' ? '提交中…' : '确认下架'),
                  h('button', { type: 'button', className: 'btn', style: { marginLeft: 8 },
                    onClick: () => { setUnpublishPreview(null); setUnpublishStage('idle') } }, '取消')),
              ),
        ))
    }
    
    /** 计数卡上那行小字：写清这一类的文件落在哪个目录（与读目录的实现一一对应）。 */
    const GLOBAL_KIND_DIR = {
      role: 'roles/',
      workflow: 'workflows/',
      blueprint: 'team-blueprints/',
      team: 'teams/ · v1 只读',
    }

    /** 状态条里只留根目录最后两段；完整路径仍可从头部的 title 看到。 */
    function shortRoot(root) {
      if (typeof root !== 'string' || root === '') return '$DSH_HOME/myteam'
      const parts = root.split(/[\\/]+/).filter((part) => part !== '')
      return parts.length <= 2 ? root : `…/${parts.slice(-2).join('/')}`
    }

    function GlobalOverviewScreen(props) {
      const { data, operations } = props
      const counts = data.counts ?? {}
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      const entries = Array.isArray(data.entries) ? data.entries : []
      const ops = Array.isArray(operations) ? operations.slice(0, 5) : []
      return h(
        'div',
        { className: 'body pad' },
        h(
          'div',
          { className: 'grid c4' },
          ['role', 'workflow', 'blueprint', 'team'].map((kind) =>
            h(
              'div',
              { key: kind, className: 'rc', style: { gap: 4 } },
              h('div', { className: 'desc' }, GLOBAL_KIND_LABEL[kind]),
              h('div', { style: { fontWeight: 600, fontSize: 16, lineHeight: 1.2 } }, String(counts[kind] ?? 0)),
              h('div', { className: 'desc mono' }, GLOBAL_KIND_DIR[kind]),
            ),
          ),
        ),
        entries.length === 0
          ? h(
              'div',
              { className: 'box', style: { padding: '16px', marginTop: 14 } },
              h(
                'div',
                { className: 'rc-h' },
                h(Dot, { tone: 'gate' }),
                h('span', { className: 'nm' }, '全局库还是空的'),
                h('span', { className: 'tag' }, data.exists === true ? '可写' : '第一次发布会创建'),
              ),
              h(
                'p',
                { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } },
                '在项目的「定义」栏发起发布、走完人类确认，角色 / 工作流 / 蓝图就写进这里；别的项目复制它，就能复用同一份定义。',
              ),
            )
          : [
              h(
                'div',
                { className: 'layer' },
                h('b', null, '定义清单'),
                h('span', null, `${entries.length} 条`),
                h('i', { className: 'rule' }),
              ),
              h('div', { className: 'list' }, globalEntryRows(entries.slice(0, 6))),
              h(
                'div',
                { className: 'layer' },
                h('b', null, '最近全局操作'),
                h('span', null, ops.length === 0 ? '还没有' : `最近 ${ops.length} 条`),
                h('i', { className: 'rule' }),
              ),
              ops.length === 0
                ? h('p', { className: 'muted', style: { margin: '8px 0 0', fontSize: 12 } }, '还没有全局操作记录。发布、下架等人类确认动作会写进这里。')
                : h(
                    'div',
                    { className: 'list' },
                    ops.map((item) =>
                      h(
                        'div',
                        { key: `${item.at ?? ''}:${item.operationId ?? ''}`, className: 'item' },
                        h(
                          'div',
                          { className: 'l' },
                          h('div', { className: 't' }, String(item.action ?? '未知操作'), ' ', h('span', { className: 'muted' }, String(item.target ?? ''))),
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
                  ),
            ],
        warnings.length === 0
          ? h('p', { className: 'muted', style: { margin: '12px 0 0', fontSize: 12 } }, '读到的定义都是完整的。')
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
      const [opened, setOpened] = useState(null)

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
      const openedEntry = opened === null ? null : (entries.find((entry) => entry.kind + ':' + entry.id === opened) ?? null)

      let body
      if (tab === 'publish') {
        body = h(Data, { data: globalAudit, what: '全局操作审计' }, (data) => h(GlobalAuditScreen, { data }))
      } else if (kindForTab === null) {
        body = h(Data, { data: library, what: '全局库概览' }, (data) =>
          h(GlobalOverviewScreen, { data, operations: globalAudit.data?.items }))
      } else {
        body = h(Data, { data: library, what: navItem.label }, () =>
          openedEntry === null
            ? h(ListPane, { items: ofKind, empty: `${navItem.label}里还没有全局条目。` }, globalEntryRows(ofKind, (entry) => setOpened(entry.kind + ':' + entry.id)))
            : h('div', { style: { padding: '12px 16px' } },
                h(GlobalEntryDetail, { entry: openedEntry, entries, onBack: () => setOpened(null) }),
                h(GlobalDefinitionEdit, {
                  entry: openedEntry,
                  entries,
                  onDone: () => { setOpened(null); void library.reload() },
                }),
              ),
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
            summary: ['全局定义库', '只有人类确认才写入', '团队与任务都在各自项目'],
            onRefresh,
            busy: library.status === 'loading',
          }),
          h(StatusBar, {
            chips: [
              { text: '人类可写（令牌确认）', tone: 'run' },
              { text: `条目 ${entries.length}` },
              { text: `根目录 ${shortRoot(library.data?.root)}` },
            ],
            note: '这些定义可被任何项目复制',
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
