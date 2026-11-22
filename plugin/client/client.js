/**
 * myteam 客户端插件：会话页「团队」视图（只读看板）。
 *
 * 形态与 v1 相同：`window.__ModuleLoader__.load({ id, factory })`，factory 返回
 * `{ apply, inject }`；所有注册放进 `ctx.slots.inject(...)`，卸载即回收。
 *
 * 只读：数据走根级门面 `myteam/board`，本组件不写任何东西。渲染失败不冒泡到
 * 宿主（宿主只看到一块空白，用户拿不到任何信息），所以这里自带错误态与重试。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-myteam',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useState } = react

    const VIEW_ID = 'myteam'

    async function rpc(connection, method, args) {
      const result = await connection.rpc.call('/api', `myteam/${method}`, { args })
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error(result.error?.message ?? `myteam/${method} 调用失败`)
      }
      // 宿主可能返回 {ok,value}（连接层）或 {ok,data}（门面本身），两种都接受。
      const value = result && typeof result === 'object' && 'value' in result ? result.value : result
      if (value && typeof value === 'object' && 'ok' in value) {
        if (value.ok === false) throw new Error(value.error?.message ?? `myteam/${method} 返回失败`)
        return value.data
      }
      return value
    }

    function BoardView(props) {
      const { connection, sessionId } = props
      const [state, setState] = useState({ status: 'loading' })

      const load = useCallback(async () => {
        if (!sessionId) {
          setState({ status: 'empty', reason: '当前会话没有绑定工作区' })
          return
        }
        setState({ status: 'loading' })
        try {
          const data = await rpc(connection, 'board', { agentId: sessionId, query: {} })
          setState({ status: 'ready', data })
        } catch (error) {
          setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) })
        }
      }, [connection, sessionId])

      useEffect(() => {
        void load()
      }, [load])

      const styles = {
        root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 120 },
        head: { display: 'flex', alignItems: 'baseline', gap: 8 },
        title: { fontSize: 14, fontWeight: 600, margin: 0 },
        meta: { fontSize: 12, opacity: 0.7 },
        columns: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 },
        column: { border: '1px solid var(--dsw-alias-border)', borderRadius: 8, padding: 8 },
        columnHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 },
        card: { border: '1px solid var(--dsw-alias-border)', borderRadius: 6, padding: 6, marginBottom: 6, fontSize: 12 },
        muted: { fontSize: 12, opacity: 0.7 },
        button: { fontSize: 12, padding: '2px 8px', borderRadius: 6, cursor: 'pointer' },
      }

      if (state.status === 'loading') {
        return h('div', { style: styles.root }, h('p', { style: styles.muted }, 'myteam 看板加载中…'))
      }
      if (state.status !== 'ready') {
        return h(
          'div',
          { style: styles.root },
          h('p', { style: styles.muted }, `看板不可用：${state.reason ?? '未知原因'}`),
          h('div', null, h('button', { style: styles.button, onClick: () => void load() }, '重试')),
        )
      }

      const data = state.data ?? {}
      const totals = data.totals ?? { all: 0, done: 0, blocked: 0, review: 0 }
      const columns = Array.isArray(data.columns) ? data.columns : []

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.head },
          h('h3', { style: styles.title }, 'myteam 看板'),
          h('span', { style: styles.meta }, `共 ${totals.all} · 完成 ${totals.done} · 评审 ${totals.review} · 阻塞 ${totals.blocked}`),
          h('button', { style: styles.button, onClick: () => void load() }, '刷新'),
        ),
        h(
          'div',
          { style: styles.columns },
          columns.map((column) =>
            h(
              'section',
              { key: column.status, style: styles.column },
              h(
                'div',
                { style: styles.columnHead },
                h('span', null, column.status),
                h('span', null, String(column.count ?? 0)),
              ),
              column.count === 0
                ? h('p', { style: styles.muted }, '无任务')
                : (column.tasks ?? []).map((task) =>
                    h(
                      'article',
                      { key: task.id, style: styles.card },
                      h('div', null, task.title),
                      h(
                        'div',
                        { style: styles.muted },
                        `${task.ownerTeamName ?? '未分配团队'}${(task.blockedBy ?? []).length > 0 ? ' · 等待上游' : ''}`,
                      ),
                    ),
                  ),
            ),
          ),
        ),
      )
    }

    function apply(ctx) {
      try {
        if (!ctx?.slots?.inject) return
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: VIEW_ID,
              order: 90,
              label: () => '团队',
              inject: (sessionId) => ({ ctx, connection: ctx.connection, sessionId }),
            },
            BoardView,
          ),
        )
      } catch (error) {
        // 注册失败只记录：绝不让面板把整个会话页拖垮。
        console.error('[myteam] 视图注册失败', error)
      }
    }

    return { apply, inject: ['slots', 'connection'] }
  },
})