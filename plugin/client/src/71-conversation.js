    /* ── 会话页（design-v2/README.md）与单角色调用（design-v2/README.md）──
     * 落点：conversation.view（团队视图壳）+ tool.call.toolview（myteam_* 工具卡）。
     * 纪律（design-v2/README.md §五）：会话页不重复造面板 —— 工具卡只给摘要 + 两个出口，
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
     * CHG-107：**演示数据已彻底删除**（连同调试开关）。
     *
     * 历史：会话页的初始 state 一度是十几条硬编码任务；后来改成「调试开关 + 样本兜底」，
     * 但「开关 + 样本」本身就是假数据的入口——团队视图里出现「没发生过的任务 / 对话」
     * 正是从这里来的。现在没有样本常量、没有开关：读不到看板就是空数组，渲染侧给空态。
     */
    /**
     * 会话页 / 工具卡共用的看板数据源（**只读真实数据**）。
     *
     * 返回 `{ tasks, live, gates, roles, members, team, loaded }`：
     *  - 任务/成员/计数全部来自 `getBoard` 现算；
     *  - 团队名与状态来自根级 `listTeams`（按 sessionId 命中，**不是硬编码**）；
     *  - 读不到时是空数组 / 0（渲染侧用 `—` 占位）。
     *
     * CHG-107：**删掉演示回落**。旧实现在「真实看板为空」时回落到演示样本，
     * 于是团队视图里会冒出没发生过的任务。现在没有演示分支：没有数据就是空态。
     */
    function useConvBoard(connection, sessionId) {
      const [state, setState] = react.useState(() => ({ tasks: [], rawTasks: [], live: 0, gates: 0, roles: 0, members: [], team: undefined, loaded: false, messageCount: null }))
      /* CHG-113：`tick` 由 watch 循环推进——账本有新事件就重拉看板（替代轮询刷新） */
      const [tick, setTick] = react.useState(0)
      react.useEffect(() => {
        if (!sessionId || !connection) return undefined
        let alive = true
        const api = makeApi(connection, sessionId)
        /* CHG-201：项目作用域按会话解析——`getProjectScope` 返回本项目团队 + workspaceRoot。 */
        const teamsCall = typeof api.getProjectScope === 'function' ? api.getProjectScope().catch(() => undefined) : Promise.resolve(undefined)
        Promise.all([api.getBoard({}).catch(() => undefined), teamsCall]).then(([data, teamsData]) => {
          if (!alive) return
          const members = data?.board?.members ?? []
          const boardTasks = (data?.board?.columns ?? []).flatMap((column) => column.tasks ?? [])
          const team = (teamsData?.teams ?? []).find((entry) => entry.sessionId === sessionId)
          const teamId = String(team?.teamId ?? '')
          const mapped = boardTasks.map((task) => ({
            id: String(task.id),
            title: task.title,
            state: task.state,
            who: (task.assignees ?? []).map((id) => String(id)).join('、'),
            /* CHG-109：真实时间戳（有就显示，绝不写死） */
            ...(typeof task.updatedAt === 'string' ? { ts: task.updatedAt } : typeof task.ts === 'string' ? { ts: task.ts } : {}),
          }))
          /**
           * CHG-115：**看板 / 流程 / 依赖图三视图的共用输入**——保留投影原始任务，
           * 只补视图需要的复合键（`teamId/taskId`，与面板任务页同构）与兜底数组。
           * 这样会话视图的三视图与面板是同一套组件、同一份字段，不再各自映射一份。
           */
          const rawTasks = boardTasks.map((task) => ({
            ...task,
            key: `${teamId}/${String(task.id)}`,
            code: String(task.id),
            ownerTeamId: teamId,
            assignees: Array.isArray(task.assignees) ? task.assignees : task.assignee ? [task.assignee] : [],
            deps: Array.isArray(task.deps) ? task.deps : [],
          }))
          setState({
            tasks: mapped,
            rawTasks,
            live: members.filter((member) => member.status === 'active' && member.currentTaskId).length,
            gates: boardTasks.filter((task) => String(task.state).startsWith('gate') || task.state === 'gates').length,
            roles: new Set(members.map((member) => member.roleId).filter(Boolean)).size,
            members,
            team,
            /* CHG-157：团队消息事件总数（旧宿主没有该字段 → null，总览卡显示 —） */
            messageCount: typeof data?.board?.messageCount === 'number' ? data.board.messageCount : null,
            loaded: Boolean(data || teamsData),
          })
        }).catch(() => { if (alive) setState((prev) => ({ ...prev, loaded: true })) })
        return () => { alive = false }
      }, [sessionId, connection, tick])

      /**
       * CHG-113：**团队视图自动追平**——拿到 teamId 后挂 `watch` 长轮询，
       * 账本一有新事件就 `setTick` 重拉（`changed:false` 就重开，空闲零请求）。
       * 旧宿主没有 `watch` → 直接返回，保持「打开时拉一次」的旧行为。
       */
      const teamId = state.team?.teamId
      const workspaceRoot = String(state.team?.workspaceRoot ?? '')
      react.useEffect(() => {
        if (!teamId || !connection) return undefined
        const api = makeApi(connection, sessionId)
        if (typeof api.watch !== 'function') return undefined
        let alive = true
        let since = 0
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        /**
         * CHG-155（P1 紧循环 → 整屏卡死/黑屏）：`watch` **必须带 `workspaceRoot`**。
         * 服务端 `offlineTarget` 只认绝对路径，缺了就直接返回 `MT_VALIDATION` **错误信封**
         * （不是抛异常）；旧实现只在 `catch` 里 `sleep`，错误信封走的是成功分支 →
         * `while (alive)` 无间隔重发 → 每秒上千次 RPC → 渲染进程被占满（黑屏）。
         *
         * 两道锁，缺一不可：
         *  ① 请求带真实 `workspaceRoot`（参数合法，服务端才可能进入长轮询）；
         *  ② **只要这一轮没有 `changed`，就至少隔 `MIN_POLL_MS` 再问**——与响应快慢无关，
         *     即使服务端立刻回错误/空态也不会紧循环（这是「以后不再黑屏」的那道锁）。
         */
        const MIN_POLL_MS = 1000
        const loop = async () => {
          while (alive) {
            if (isHidden()) { await sleep(1000); continue }
            const startedAt = Date.now()
            try {
              const r = await api.watch({
                teamId,
                ...(workspaceRoot ? { workspaceRoot } : {}),
                sinceSeq: since,
                timeoutMs: 20000,
              })
              if (!alive) return
              if (typeof r?.seq === 'number') since = r.seq
              if (r?.changed) { setTick((value) => value + 1); continue }
              const elapsed = Date.now() - startedAt
              if (elapsed < MIN_POLL_MS) await sleep(MIN_POLL_MS - elapsed)
            } catch {
              await sleep(3000)
            }
          }
        }
        void loop()
        return () => { alive = false }
      }, [teamId, workspaceRoot, connection, sessionId])
      return state
    }
    /** 计数渲染：0 条任务不等于「无数据」时照样显示 0；缺数据（未加载）显示 — 占位 */
    const convCount = (value, loaded) => (loaded ? String(Number(value) || 0) : '—')
    /** myteam_submit_plan 工具卡（摘要 + 两个出口）；key 必须与 defs.ts 的 wire 名逐字相同 */
    function TeamPlanTasksCard({ t, tasks, stat, onOpenPanel, onOpenTask, loaded = true }) {
      const list = (tasks ?? []).slice(0, 4)
      const rest = Math.max(0, (tasks ?? []).length - list.length)
      /* CHG-109：脚注的时间**不再写死 21:13**——有真实时间戳就显示，没有就只写「账本已记录」 */
      const lastTs = list.map((task) => task?.ts).filter((ts) => typeof ts === 'string' && ts.length > 0).sort().at(-1)
      const foot = [
        j('button', { key: 'panel', className: 'mt-btn mt-btn-sm', onClick: onOpenPanel, children: t('g6.conv.openPanel') }),
        j('button', { key: 'detail', className: 'mt-btn mt-btn-sm', onClick: onOpenTask, children: t('g6.conv.openDetail').replace('{id}', String(list[0]?.id ?? '—')) }),
        j('span', {
          key: 'note',
          className: 'mt-toolcard-note',
          children: lastTs ? t('g6.conv.ledger').replace('{time}', String(lastTs)) : t('g6.conv.ledgerNoTime'),
        }),
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
      /* CHG-158：卡名必须是**真实 wire 工具名**。此处原名在 defs.ts 里不存在（全仓无此工具），
       * 而 tool.call.toolview 按 key 精确匹配 wire 名 —— 注册的 key 也错，这张卡永远不会被渲染。
       * 对应的真实工具是 `myteam_submit_plan`（提交草稿 → 返回任务清单 + 名册 + 门禁计数）。 */
      return j(ToolCardShell, { t, icon: '⌘', name: 'myteam_submit_plan', stat, children: body, foot })
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
