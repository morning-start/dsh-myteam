    let pendingNav = null
    /** 团队摘要 → 工作台入口上下文（纯函数，测试直接断言） */
    function entryNavForTeam(team) {
      if (!team || !team.teamId) return {}
      return {
        workspaceRoot: String(team.workspaceRoot ?? ''),
        teamId: String(team.teamId),
        projectTab: 'teams',
        teamTab: 'members',
      }
    }
    function openWorkbench(ctx, nav) {
      const next = nav && typeof nav === 'object' ? nav : null
      try {
        const layout = typeof ctx?.get === 'function' ? ctx.get('layout') : undefined
        if (!layout || typeof layout.selectPanel !== 'function') return false
        pendingNav = next
        layout.selectPanel(PANEL_KEY)
        return true
      } catch (e) {
        pendingNav = null
        /* 插件跑在用户真实桌面里：任一入口失败都不能让面板消失，只 warn 降级 */
        console.warn('[myteam] 打开面板失败：', e)
        return false
      }
    }
    function takePendingNav() {
      const nav = pendingNav
      pendingNav = null
      return nav
    }
    async function resolveNavForSession(connection, sessionId) {
      if (!connection || !sessionId) return {}
      try {
        /* CHG-201：项目作用域按**会话**解析（getProjectScope），不再跨工作区发现团队。 */
        const scope = await makeApi(connection, sessionId).getProjectScope()
        return entryNavForTeam((scope?.teams ?? []).find((entry) => entry.sessionId === sessionId))
      } catch {
        return {}
      }
    }