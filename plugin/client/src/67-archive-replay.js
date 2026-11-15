    function ArchiveReplay({ t, team: teamProp, tasks: tasksProp, tokens: tokensProp, audit: auditProp, memberName, onBack, onMoreAudit, onOpenAll, onOpenTask, archive, archiveRoot }) {
      const snap = archive && typeof archive === 'object' ? archive : null
      /* 快照优先：字段名与 host 侧 ArchiveTeamSnapshot 一一对应（不重命名、不猜） */
      const team = snap
        ? {
          ...(teamProp ?? {}),
          teamId: snap.teamId ?? teamProp?.teamId,
          name: snap.name || teamProp?.name,
          goal: snap.goal || teamProp?.goal,
          state: snap.state ?? teamProp?.state,
          archivedAt: snap.archivedAt ?? teamProp?.archivedAt,
          updatedAt: snap.archivedAt ?? teamProp?.updatedAt,
          members: snap.members ?? [],
        }
        : teamProp
      const tasks = snap
        ? (snap.tasks ?? []).map((task) => ({
          ...task,
          assignees: task.assignee ? [task.assignee] : [],
          evidenceCount: Number(task.evidenceCount ?? 0),
          gates: task.gates ?? [],
          gateVerdicts: task.gateVerdicts ?? {},
        }))
        : tasksProp
      const tokens = snap ? (snap.tokens ?? tokensProp) : tokensProp
      const audit = snap ? { ...(auditProp ?? {}), total: snap.eventCount ?? auditProp?.total } : auditProp
      /* 真实归档目录（CHG-108）：优先用服务端的 `rootDisplay`（家目录已缩成 `~`），
       * 其次才回落 `snap.dir`（绝对路径）/ 相对路径——**绝对路径不能直接上屏**。 */
      const archiveDir = snap
        ? (archiveRoot
            ? `${archiveRoot.replace(/[\\/]+$/, '')}/${snap.teamId ?? team?.teamId ?? ''}`
            : (snap.dir || `archive/${snap.teamId ?? team?.teamId ?? '—'}/`))
        : `archive/${team?.teamId ?? '—'}/`
      const artifacts = snap?.artifacts ?? []
      const [showAudit, setShowAudit] = react.useState(false)
      /* CHG-202x（P1-12）：归档内嵌审计的三个视图（任务 / 成员 / 时间）曾把 setFilter 写成 `() => {}`——
       * 点了完全没反应。归档是只读回放，视图切换纯前端，没有任何理由不接。 */
      const [auditView, setAuditView] = react.useState('task')
      if (showAudit) {
        return js('div', { className: 'mt-panel', children: [
          js('div', { className: 'mt-archbar', children: [
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setShowAudit(false), children: t('team.backList') }),
            j('span', { className: 'mt-team-mark', 'aria-hidden': true, children: layerIcon('builtin') }),
            js('span', { className: 'mt-team-id', children: [j('b', { children: team?.name || team?.teamId }), j('span', { children: team?.teamId })] }),
            j('span', { className: 'mt-arch-date', children: t('archive.readonly') }),
            js('div', { className: 'mt-archbar-actions', children: [
              j('button', { className: 'mt-btn mt-btn-sm', onClick: onOpenAll, children: t('archive.allTeams') }),
            ] }),
          ] }),
          j(AuditTab, { t, audit, tasks, memberName, filter: auditView, setFilter: setAuditView, onMore: onMoreAudit, onNotice: () => {}, onOpen: (taskId) => onOpenTask?.({ id: taskId, ownerTeamId: team?.teamId, online: team?.online, ownerOnline: team?.online, sessionId: team?.sessionId }) }),
          j(CostBar, { t, tokens, readOnly: true }),
        ] })
      }
      const members = team?.members ?? []
      const list = tasks ?? []
      const done = list.filter((task) => task.state === 'done')
      const blocked = list.filter((task) => task.state === 'blocked')
      const pending = list.filter((task) => !['done', 'cancelled', 'failed', 'blocked'].includes(task.state))
      const sum = sumBuckets(Object.values(tokens?.totals ?? {}))
      const hit = hitRateOf(sum)
      const memberNameOf = (id) => members.find((member) => member.id === id)?.instanceName ?? id
      const totalTokens = sum.uncachedInput + sum.cacheRead + sum.cacheWrite + sum.output
      const tasksOfMember = (memberId) => list.filter((task) => (task.assignees ?? (task.assignee ? [task.assignee] : [])).includes(memberId))
      const dayRows = Object.entries(tokens?.days ?? {}).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([day, dayMembers]) => {
        const bucket = sumBuckets(Object.values(dayMembers ?? {}))
        const rate = hitRateOf(bucket)
        return { day, bucket, rate }
      })
      const cell = (value, key) => j('td', { className: 'mt-n', key, children: value })
      const stateChip = (state) => {
        const tone = state === 'done' ? 'done' : state === 'blocked' || state === 'failed' ? 'fail' : String(state).startsWith('gate:') ? 'gate' : 'idle'
        return js('span', { className: `mt-mini-chip mt-tone-${tone}`, children: [j('span', { className: 'mt-tc-dot', 'aria-hidden': true }), stateLabel(state)] })
      }
      const ledgerRow = (icon, title, sub, act, key) => js('article', { className: 'mt-listrow', key, children: [
        j('span', { className: 'mt-mavatar mt-mavatar-muted', 'aria-hidden': true, children: layerIcon(icon) }),
        js('div', { className: 'mt-listrow-main', children: [
          j('div', { className: 'mt-listrow-title', children: title }),
          j('div', { className: 'mt-listrow-sub', children: sub }),
        ] }),
        js('div', { className: 'mt-listrow-act', children: act ?? null }),
      ] })
      /* 视图条 = 回放分区锚点（design/archive.html 的 nav.seg：结局 / 名册 · N / 任务历史 · N / 账本与产物） */
      const archiveNav = (label, id) => j('button', {
        key: id,
        className: 'mt-audit-segbtn',
        onClick: () => { if (typeof document !== 'undefined') document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        children: label,
      })
      const archDate = team?.updatedAt ? t('archive.archivedAt').replace('{time}', fmtClock(team.updatedAt)) : t('archive.readonly')
      return js('div', { className: 'mt-panel', children: [
        js('div', { className: 'mt-archbar', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onBack, children: t('team.backList') }),
          j('span', { className: 'mt-team-mark', 'aria-hidden': true, children: layerIcon('builtin') }),
          js('span', { className: 'mt-team-id', children: [j('b', { children: team?.name || team?.teamId }), j('span', { children: team?.teamId })] }),
          js('span', { className: 'mt-mini-chip mt-tone-idle', children: [j('span', { className: 'mt-tc-dot', 'aria-hidden': true }), t('archive.status')] }),
          j('span', { className: 'mt-arch-date', children: archDate }),
          js('div', { className: 'mt-archbar-actions', children: [
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setShowAudit(true), children: t('archive.openAudit') }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: onOpenAll, children: t('archive.allTeams') }),
          ] }),
        ] }),
        js('div', { className: 'mt-audit-segbar', children: [
          js('nav', { className: 'mt-audit-seg', 'aria-label': t('archive.section.progress'), children: [
            archiveNav(t('archive.section.end'), 'mt-arch-end'),
            archiveNav(t('archive.section.roster').replace('{n}', String(members.length)), 'mt-arch-roster'),
            archiveNav(t('archive.section.tasks').replace('{n}', String(list.length)), 'mt-arch-tasks'),
            archiveNav(t('archive.section.ledger'), 'mt-arch-ledger'),
          ] }),
          js('div', { className: 'mt-audit-segright', children: [
            j('span', { className: 'mt-mini-chip', children: t('archive.eventCount').replace('{n}', String(audit?.total ?? '—')) }),
            j('span', { className: 'mt-mini-chip', children: t('archive.snapshot') }),
          ] }),
        ] }),
        js('div', { className: 'mt-page mt-archive-page', children: [
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-end', children: [
            j('h4', { children: t('archive.section.end') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: 'team.disbanded' }),
          ] }),
          js('div', { className: 'mt-endcard', children: [
            j('h5', { children: t('archive.endTitle') }),
            j('p', { children: team?.goal || t('archive.endFallback') }),
            js('div', { className: 'mt-endmeta', children: [
              j('span', { children: t('archive.endDisbander') }),
              j('span', { children: t('archive.endDrained').replace('{n}', String(members.length)) }),
              j('span', { children: t('archive.endBlocked').replace('{n}', String(pending.length + blocked.length)) }),
              /* CHG-86 / P0-2：真实归档目录（有快照时是 archiveRoot/teamId 的绝对路径） */
              js('span', { children: [t('archive.endPath').replace('{path}', ''), j('code', { children: archiveDir })] }),
            ] }),
          ] }),
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('archive.section.progress') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.taskDone').replace('{n}', `${done.length}/${list.length}`) }),
          ] }),
          js('div', { className: 'mt-secbox', children: [
            js('div', { className: 'mt-teambar-stats', children: [
              js('div', { className: 'mt-tstat', children: [j('b', { children: `${done.length}/${list.length}` }), j('span', { children: t('archive.done') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: String(blocked.length) }), j('span', { children: t('archive.blocked') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: String(pending.length) }), j('span', { children: t('archive.notStarted') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: fmtTokens(totalTokens) }), j('span', { children: t('archive.tokensTotal') })] }),
              js('div', { className: 'mt-tstat', children: [j('b', { children: String(sum.calls) }), j('span', { children: t('archive.calls') })] }),
            ] }),
            js('div', { className: 'mt-segbar', children: list.length === 0
              ? [j('i', { key: 'empty', className: 'mt-seg-done' })]
              : list.map((task) => j('i', {
                key: task.key ?? task.id,
                className: task.state === 'done' ? 'mt-seg-done' : task.state === 'blocked' || task.state === 'failed' ? 'mt-seg-blocked' : 'mt-seg-run',
                title: `${task.id} · ${stateLabel(task.state)}`,
              })) }),
          ] }),
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-roster', children: [
            j('h4', { children: t('archive.section.roster').replace('{n}', String(members.length)) }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.drained') }),
          ] }),
          members.length === 0
            ? j('div', { className: 'mt-empty-inline mt-hint', children: t('archive.rosterEmpty') })
            : js('div', { className: 'mt-grid2', children: members.map((member) => {
              const mine = tasksOfMember(member.id)
              return js('article', { className: 'mt-card2', key: member.id, children: [
                js('div', { className: 'mt-card2-top', children: [
                  j('span', { className: 'mt-mavatar', 'aria-hidden': true, children: String(member.instanceName ?? '?').slice(0, 1) }),
                  js('div', { children: [
                    js('div', { className: 'mt-card2-title', children: [j('span', { className: 'mt-iname', children: member.instanceName }), j('span', { className: 'mt-src mt-src-project', children: roleLabel(member.roleId) })] }),
                    j('div', { className: 'mt-card2-sub', children: memberStateLabel(member.status) }),
                  ] }),
                ] }),
                js('div', { className: 'mt-card2-row', children: [
                  j('span', { className: 'mt-mini-chip', children: t('archive.taskDone').replace('{n}', String(mine.filter((task) => task.state === 'done').length)) }),
                  j('span', { className: 'mt-mini-chip', children: t('archive.deliverables').replace('{n}', String(mine.reduce((total, task) => total + Number(task.evidenceCount ?? 0), 0))) }),
                  j('span', { className: 'mt-mini-chip', children: t('archive.tokenOf').replace('{v}', fmtTokens(sumBuckets([(tokens?.totals ?? {})[member.id]]).uncachedInput + sumBuckets([(tokens?.totals ?? {})[member.id]]).output)) }),
                ] }),
                j('div', { className: 'mt-card2-foot', children: j('span', { className: 'mt-role-name', children: t('archive.drained') }) }),
              ] })
            }) }),
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('archive.section.cost') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.costNote') }),
          ] }),
          js('div', { className: 'mt-secbox mt-secbox-tight', children: [
            js('table', { className: 'mt-toktable', children: [
              j('thead', { children: j('tr', { children: [
                j('th', { children: t('archive.costDay') }),
                j('th', { className: 'mt-n', children: t('archive.cost.uncached') }),
                j('th', { className: 'mt-n', children: t('archive.cost.hit') }),
                j('th', { className: 'mt-n', children: t('archive.cost.write') }),
                j('th', { className: 'mt-n', children: t('archive.cost.output') }),
                j('th', { className: 'mt-n', children: t('archive.cost.calls') }),
                j('th', { className: 'mt-n', children: t('archive.cost.rate') }),
              ] }) }),
              j('tbody', { children: dayRows.length === 0
                ? j('tr', { children: j('td', { colSpan: 7, children: t('cost.empty') }) })
                : dayRows.map((row) => j('tr', { key: row.day, children: [
                  j('td', { children: row.day }),
                  cell(fmtTokens(row.bucket.uncachedInput), 'u'),
                  cell(fmtTokens(row.bucket.cacheRead), 'r'),
                  cell(fmtTokens(row.bucket.cacheWrite), 'w'),
                  cell(fmtTokens(row.bucket.output), 'o'),
                  cell(String(row.bucket.calls), 'c'),
                  cell(row.rate === null ? '—' : `${(row.rate * 100).toFixed(1)}%`, 'h'),
                ] })) }),
              j('tfoot', { children: j('tr', { children: [
                j('td', { children: t('archive.cost.total') }),
                cell(fmtTokens(sum.uncachedInput), 'u'),
                cell(fmtTokens(sum.cacheRead), 'r'),
                cell(fmtTokens(sum.cacheWrite), 'w'),
                cell(fmtTokens(sum.output), 'o'),
                cell(String(sum.calls), 'c'),
                cell(hit === null ? '—' : `${(hit * 100).toFixed(1)}%`, 'h'),
              ] }) }),
            ] }),
          ] }),
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-tasks', children: [
            j('h4', { children: t('archive.section.tasks').replace('{n}', String(list.length)) }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.tasksNote') }),
          ] }),
          list.length === 0
            ? j('div', { className: 'mt-empty-inline mt-hint', children: t('tasks.empty') })
            : js('div', { className: 'mt-list', children: list.map((task) => js('article', { className: 'mt-listrow', key: task.key ?? task.id, children: [
              j('span', { className: 'mt-mavatar mt-mavatar-muted', 'aria-hidden': true, children: String(task.id ?? '?').slice(0, 2) }),
              js('div', { className: 'mt-listrow-main', children: [
                js('div', { className: 'mt-listrow-title', children: [
                  j('span', { children: task.title }),
                  j('span', { className: 'mt-mini-chip', children: task.id }),
                  stateChip(task.state),
                ] }),
                j('div', { className: 'mt-listrow-sub', children: [
                  (task.assignees ?? []).length > 0 ? `${(task.assignees ?? []).map(memberNameOf).join('、')} · ` : '',
                  t('archive.evidence').replace('{n}', String(task.evidenceCount ?? 0)),
                  (task.assignees ?? []).length === 0 ? ` · ${t('archive.neverClaimed')}` : '',
                ] }),
              ] }),
              js('div', { className: 'mt-listrow-act', children: [
                j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onOpenTask?.(task), children: task.state === 'blocked' ? t('archive.seeGate') : t('archive.seeEvidence') }),
              ] }),
            ] })) }),
          js('div', { className: 'mt-dsec-head', id: 'mt-arch-ledger', children: [
            j('h4', { children: t('archive.section.ledger') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('archive.ledgerPath').replace('{id}', team?.teamId ?? '—') }),
          ] }),
          js('div', { className: 'mt-list', children: [
            ledgerRow('builtin', [j('span', { className: 'mt-iname', children: 'ledger.jsonl' }), j('span', { className: 'mt-mini-chip', children: t('archive.ledgerJsonlEvents').replace('{n}', String(audit?.total ?? '—')) })], t('archive.ledgerJsonl'), [j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setShowAudit(true), children: t('archive.seeAll') })], 'ledger'),
            ledgerRow('project', [j('span', { className: 'mt-iname', children: 'team.json' }), j('span', { className: 'mt-iname', children: 'tokens.json' })], t('archive.teamJson'), null, 'team'),
            ledgerRow('global', j('span', { className: 'mt-iname', children: 'members/' }), t('archive.membersDir'), null, 'members'),
            /* 交付物清单：有真实快照时用 artifacts 条数（archive/artifacts/artifacts.json），否则按证据数派生 */
            ledgerRow('builtin', [j('span', { className: 'mt-iname', children: 'artifacts/' }), j('span', { className: 'mt-mini-chip', children: t('archive.artifactsCount').replace('{n}', String(snap ? artifacts.length : done.reduce((total, task) => total + Number(task.evidenceCount ?? 0), 0))) })], t('archive.artifactsDir'), [j('button', { className: 'mt-btn mt-btn-sm', disabled: true, title: t('settings.readonlyTip'), children: t('archive.openDir') })], 'artifacts'),
          ] }),
          js('p', { className: 'mt-note-box', children: [j('b', { children: t('archive.note') }), j('span', { children: t('archive.noteSub') })] }),
        ] }),
        j(CostBar, { t, tokens, readOnly: true }),
      ] })
    }

    /** 诊断 chip（CHG-72，FR-30）：把「为什么没人领」直接放在任务卡/详情上 */