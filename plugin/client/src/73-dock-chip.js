    /* ── composer dock chip（会话槽：inject 回调首参 = sessionId；非队长会话轮询得 unavailable → 不亮）── */
    function DockChip(props) {
      const { ctx, connection, sessionId, t: tProp } = props
      const t = tProp ?? ((k) => zh[k] ?? k)
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      const [unread, setUnread] = react.useState(0)
      const [live, setLive] = react.useState(0)
      /* CHG-114：入口上下文一次解析（会话 → 团队）；解析不到就回全局库，点击不空转 */
      const [entryNav, setEntryNav] = react.useState(null)
      react.useEffect(() => {
        if (sessionId === undefined || !connection) return undefined
        let alive = true
        resolveNavForSession(connection, sessionId).then((nav) => { if (alive) setEntryNav(nav) })
        return () => { alive = false }
      }, [sessionId, connection])
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
            /* CHG-114：走宿主真实 API `ctx.layout.selectPanel`（旧 `uiWorkspace.openPanel` 不存在）。
             * 交接解析还没回来就再解析一次——点击永远带团队上下文，不落到全局库。 */
            if (entryNav) openWorkbench(ctx, entryNav)
            else resolveNavForSession(connection, sessionId).then((nav) => openWorkbench(ctx, nav))
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
