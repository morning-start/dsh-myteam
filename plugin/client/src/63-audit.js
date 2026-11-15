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

    function AuditTab({ t, audit, tasks, filter, setFilter, onMore, onOpen, memberName, onNotice }) {
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
      /**
       * CHG-202x（P1-7）：导出 JSONL 必须**有反馈**。
       *
       * 修复前：只写剪贴板、零提示、剪贴板被拒时完全静默——用户不知道导没导出、导的是什么。
       * 现在：先走浏览器下载（真文件，可进版本库），下载不可用才回落剪贴板；
       * 两条路都给 notice 说明「导出了多少条（当前已加载页）」。
       */
      const exportJsonl = async () => {
        const text = events.map((event) => JSON.stringify(event)).join('\n')
        const count = String(events.length)
        try {
          if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            const href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
            const a = document.createElement('a')
            a.href = href
            a.download = 'myteam-audit.jsonl'
            a.rel = 'noopener'
            document.body?.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => { try { URL.revokeObjectURL(href) } catch { /* 已回收 */ } }, 0)
            onNotice?.(t('audit.exported').replace('{n}', count))
            return
          }
        } catch { /* 下载不可用（无 DOM / 被策略拦）→ 剪贴板兜底 */ }
        try {
          await navigator.clipboard.writeText(text)
          onNotice?.(t('audit.exportedClipboard').replace('{n}', count))
        } catch {
          onNotice?.(t('audit.exportFailed'))
        }
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
