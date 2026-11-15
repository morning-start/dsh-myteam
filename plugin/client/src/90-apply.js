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
      /* CHG-155（P1）：三个可见表面都套渲染错误边界 —— 插槽里抛错不再让整块面板变成黑屏，
       * 而是渲染「渲染失败 + 摘要 + 重试」的可读兜底。 */
      /* CHG-201（用户定案「左侧侧边栏打开的页面，只有全局的信息」）：`main` 槽 = **全局页**。
       * 只读全局资产（内置 + 全局角色 / 预设 / 技能 & MCP / 插件贡献）；不列项目、不记录项目。 */
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_KEY,
        locale: NS,
        inject: () => ({ ctx, connection: ctx.connection, mode: 'global' }),
      }, withRenderBoundary(Panel)))
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
      }, withRenderBoundary(DockChip)))
      /* ④ CHG-82 G6：会话页团队视图（conversation.view）+ myteam_* 工具卡（tool.call.toolview）。
       * 官方契约：conversation.view 用 id + order + label（按会话绑定）；tool.call.toolview 用 key
       * （按 wire 工具名精确注册，见 dsh-client-ui-tool 的 ask_user_question 参考实现）。
       * 插件跑在用户真实桌面里 —— 任一注册失败都不能让 apply 抛错（否则整个面板消失），只 warn 降级。 */
      try {
        /* CHG-201（用户定案「画布中的团队视图 tag = 具体某个项目的视图」）：
         * `conversation.view` 槽 = **项目页**（按会话工作区解析），与全局页物理分离。 */
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: PANEL_KEY,
          order: 20,
          locale: NS,
          label: () => zh['g6.conv.view'] ?? 'myteam',
          inject: (sessionId) => ({ ctx, connection: ctx.connection, sessionId, mode: 'project' }),
        }, withRenderBoundary(Panel)))
        const TOOL_VIEWS = [
          /* CHG-158：key = **wire 工具名**（官方按 key 精确匹配）。原 key 在 defs.ts 里不存在，
           * 这张卡从来没渲染过；真实计划工具是 myteam_submit_plan。 */
          ['myteam_submit_plan', MyTeamPlanTasksToolView],
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
      TeamCreateDrawer,
      /* CHG-115：看板同源组件（面板任务页 + 团队会话视图共用） */
      BoardView,
      MyTeamPlanTasksToolView, MyTeamApprovePlanToolView, MyTeamPeerMessageToolView, MyTeamApplyRolesToolView,
      TeamPlanTasksCard, TeamCollapsedCard, DockChip,
      /* CHG-157：团队总览卡（组件 + 纯函数，mock loader 下可断言分桶/叙述） */
      TeamOverviewCard, teamOverviewOf, ovBucketOf, ovNarrativeText,
      /* CHG-172（A11）：单角色调用面板入口（角色 tab 管理场景，FR-16.1） */
      GuestApplySection,
    }

    /* 测试专用出口（t75-chg89-gaps）：CHG-89 三个新入口所在组件的纯渲染面。
     * 生产路径不消费它（官方只认 apply / inject）——存在只为让「按钮到底渲没渲染」
     * 能在 mock loader 下断言，而不是只 grep 源码字符串。 */
    const __testG89 = { RoleDetailDrawer, TaskFormDrawer, SettingsTab, DiagFix, RescopeDialog, ContributionsSection, contributionsBody }

    /* 测试专用出口（t87-entry-nav）：入口 → 工作台的纯函数面。
     * 生产路径不消费它——存在只为让「打开面板到底调了哪个宿主 API、交接了什么上下文」
     * 能在 mock loader 下断言，而不是只 grep 源码字符串。 */
    const __testEntry = { PANEL_KEY, entryNavForTeam, openWorkbench, takePendingNav, resolveNavForSession }

    /* 测试专用出口（t100-chg155）：**不再黑屏**的两块兜底——渲染错误边界 + 包装器。
     * 生产路径只看 apply/inject；导出它们是为了让「异常到底有没有兜住」「三个表面有没有套上」
     * 能在 mock loader 下真断言，而不是只 grep 源码字符串。 */
    const __testResilience = { MyTeamRenderBoundary, withRenderBoundary }

    /* 测试专用出口（t143-chg193）：**面板任务 tab 的消费方**——数据源归一（索引 → 兜底）与
     * 复合键打开目标。生产路径只看 apply/inject 与 Panel 内部调用；导出它们是为了让
     * 「跨团队聚合出几条」「两个 task-1 会不会互相覆盖」「索引坏了降级到哪条路」
     * 能在 mock loader 下**真渲染断言**，而不是只 grep 源码字符串。 */
    const __testBoard = { resolveProjectTasks, taskOpenTarget, makeApi }

    return { apply, inject, __test, __testG4, __testG6, __testG89, __testEntry, __testResilience, __testBoard }