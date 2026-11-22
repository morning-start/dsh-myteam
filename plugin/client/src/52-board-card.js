    /* ── 看板卡（CHG-69：多队员负责 + 参与团队 chip；优先级只渲染一次）──
     * CHG-73：证据过期 / 已取消 chip；多选模式下点卡片 = 勾选（不嵌套 button，用 aria-pressed） */
    function TaskCard({ task, onOpen, memberName, t, teamName, selectable, selected, onToggle, showTeamName = true, drag }) {
      const deps = (task.deps ?? []).filter((dep) => dep !== task.id)
      const names = (task.assignees && task.assignees.length > 0 ? task.assignees : task.assignee ? [task.assignee] : [])
        .map((id) => memberName?.(id) || id)
      const participants = task.participants ?? []
      const shown = participants.slice(0, 2)
      const stale = task.evidenceStale
      const cancelled = task.cancelled
      /* CHG-87 §2.3：越界写入清单（ok === true 或无 scopeAudit 时不显示徽标） */
      const scopeOut = task.scopeAudit && task.scopeAudit.ok === false && Array.isArray(task.scopeAudit.outOfScope)
        ? task.scopeAudit.outOfScope.map(String)
        : []
      const picking = Boolean(selectable)
      // CHG-82：attempt 失效（门禁未过 / 已取消）的卡「锁住不可拖」——图标换锁 + cursor:not-allowed
      const locked = Boolean(drag?.locked)
      const cardClass = 'mt-task'
        + (picking && selected ? ' mt-task-selected' : '')
        + (locked ? ' mt-task-locked' : '')
        + (drag?.shake ? ' mt-task-shake' : '')
      return js('button', {
        className: cardClass,
        title: locked ? `${t('drag.lockedTitle')} · ${task.title}` : picking ? `${t('multi.on')} · ${task.title}` : task.title,
        draggable: drag ? !locked : undefined,
        'aria-disabled': locked ? 'true' : undefined,
        onDragStart: drag ? (event) => drag.onDragStart?.(event, task) : undefined,
        onDragEnd: drag ? (event) => drag.onDragEnd?.(event, task) : undefined,
        'aria-pressed': picking ? Boolean(selected) : undefined,
        onClick: () => (picking ? onToggle?.(task) : onOpen(task.id)),
        children: [
          /* design-v2/p-tasks.html 的 .tcard-top：任务号 + 优先级（+ 模型徽标） */
          js('span', { className: 'mt-task-top', children: [
            picking ? j('span', { className: 'mt-task-check' + (selected ? ' mt-task-check-on' : ''), 'aria-hidden': true, children: selected ? '✓' : '' }) : null,
            locked ? j('span', { className: 'mt-lock-icon', 'aria-hidden': true, children: j('svg', {
              width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none',
              children: [
                j('rect', { x: 2.2, y: 5.2, width: 7.6, height: 5.2, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.1 }),
                j('path', { d: 'M4 5.2V3.8a2 2 0 0 1 4 0v1.4', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
              ],
            }) }) : null,
            j('span', { className: 'mt-task-id', children: task.code ?? task.id }),
            task.priority ? j('span', { className: `mt-pri mt-pri-${task.priority}`, children: task.priority }) : null,
            task.model ? j('span', { className: 'mt-task-model', title: task.model, children: task.model }) : null,
          ] }),
          /* .tcard-title：标题独占一行，最多 3 行 */
          j('span', { className: 'mt-task-title-text', children: task.title }),
          /* .tcard-meta：承接角色的队员 + 状态 + 证据数 */
          js('span', { className: 'mt-task-meta', children: [
            names.length > 0 ? j('span', { className: 'mt-rolechip', children: names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2}` : '') }) : null,
            j('span', { className: 'mt-hint', children: stateLabel(task.state) }),
            task.evidenceCount > 0 ? j('span', { className: 'mt-hint', children: `${t('board.evidence')} ${task.evidenceCount}` }) : null,
            task.escalateCount > 0 ? j('span', { className: 'mt-flow-warn', children: `⚠×${task.escalateCount}` }) : null,
            locked ? j('span', { className: 'mt-chip mt-chip-stale', children: t('drag.locked') }) : null,
          ] }),
          /* .tcard-meta：团队归属（主责 / 协作）——单团队时是噪音，按 showTeamName 收 */
          showTeamName && participants.length > 0 ? js('span', { className: 'mt-task-meta', children: [
            ...shown.map((p) => j('span', {
              key: p.teamId,
              className: `mt-tchip mt-tchip-${p.role === 'lead' ? 'lead' : 'coop'}`,
              title: `${teamName?.(p.teamId) || p.teamId} · ${p.role === 'lead' ? t('task.owner') : t('task.coop')}`,
              children: `${teamName?.(p.teamId) || p.teamId} · ${p.role === 'lead' ? t('task.owner') : t('task.coop')}`,
            })),
            participants.length > shown.length ? j('span', { className: 'mt-tchip', children: `+${participants.length - shown.length}` }) : null,
          ] }) : null,
          /* CHG-87 §2.3：写入范围越界徽标（警告不阻断；title 给全量清单） */
          scopeOut.length > 0
            ? j('span', { className: 'mt-task-meta', children: j('span', {
              className: 'mt-scope-badge',
              title: t('scope.warn').replace('{n}', String(scopeOut.length)).replace('{files}', scopeOut.join('、')),
              children: t('scope.badge').replace('{n}', String(scopeOut.length)),
            }) })
            : null,
          stale || cancelled || task.rewired ? js('span', { className: 'mt-task-meta', children: [
            stale
              ? j('span', {
                className: 'mt-chip mt-chip-stale',
                title: t('board.staleTitle')
                  .replace('{fields}', fieldListText(t, stale.fields))
                  .replace('{time}', fmtClock(stale.since)),
                children: t('board.evidenceStale'),
              })
              : null,
            cancelled
              ? j('span', {
                className: 'mt-chip mt-chip-cancelled',
                title: t('board.cancelledTitle').replace('{reason}', cancelled.reason || '—'),
                children: t('board.cancelled'),
              })
              : null,
            /* CHG-75：被改挂过（下游换了上游）——给个小标记，让人知道依赖动过 */
            task.rewired
              ? j('span', { className: 'mt-chip mt-chip-rewired', title: t('board.rewiredTitle'), children: t('board.rewired') })
              : null,
          ] }) : null,
          j(DiagChips, { t, diagnosis: task.diagnosis }),
          /* .tcard-dep：阻塞提示（虚线分隔） */
          deps.length > 0 ? j('span', { className: 'mt-task-dep mt-task-dep-blocked', children: t('board.blockedBy').replace('{deps}', deps.join('、')) }) : null,
        ],
      })
    }
