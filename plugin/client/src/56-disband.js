    /* ── 解散团队的两段确认（design/confirm.html）──
     * 四条不可撤销影响 + 输入团队 ID 才能提交 + 「改用归档」出口；
     * 第一段（confirm:false 拿影响面）由调用方 askDisband 完成，本组件只做第二段。 */
    function DisbandDialog({ t, teamId, teamName, impact, busy, error, onConfirm, onClose, onArchive }) {
      const [typed, setTyped] = react.useState('')
      const [hint, setHint] = react.useState(null)
      /* 排空影响面：`impact.drained` 目前是 host 侧硬编码的 {running:0,pending:0}，
       * 这里不把它当真实值——缺失时显示「—」占位（impactCountText），有值时如实渲染。 */
      const drained = impact?.drained
      const members = impactCountText(impact?.members)
      const tasks = impactCountText(impact?.tasks)
      const matched = String(typed).trim() === String(teamId ?? '')
      const needId = t('disband.needId').replace('{teamId}', String(teamId ?? ''))
      return js('div', { className: 'mt-overlay', children: js('div', {
        className: 'mt-dialog',
        role: 'alertdialog',
        'aria-modal': true,
        'aria-labelledby': 'mt-disband-title',
        'aria-describedby': 'mt-disband-impact',
        children: [
          js('div', { className: 'mt-dialog-head', children: [
            js('div', { className: 'mt-dialog-steps', children: [
              js('span', { className: 'mt-mini-chip mt-mini-chip-fail', children: [
                j('span', { 'aria-hidden': true, children: '⚠' }),
                j('span', { children: t('disband.irreversible') }),
              ] }),
              j('span', { className: 'mt-hint', children: t('disband.step') }),
            ] }),
            j('strong', { id: 'mt-disband-title', children: t('disband.title').replace('{name}', String(teamName || teamId || '')) }),
            j('p', { className: 'mt-hint', children: t('disband.desc') }),
          ] }),
          js('div', { className: 'mt-dialog-body', children: [
            js('div', { className: 'mt-impact', id: 'mt-disband-impact', children: [
              j('b', { children: t('disband.impactTitle') }),
              js('ul', { children: [
                j('li', { children: t('disband.impactMembers').replace('{n}', String(members)) }),
                j('li', { children: t('disband.impactTasks').replace('{n}', String(tasks)) }),
                drained ? j('li', { children: t('disband.impactDrained').replace('{running}', impactCountText(drained.running)).replace('{pending}', impactCountText(drained.pending)) }) : null,
                j('li', { children: t('disband.impactArchive') }),
                j('li', { children: t('disband.impactPrivate') }),
              ] }),
            ] }),
            js('div', { className: 'mt-form-row', children: [
              j('label', { htmlFor: 'mt-disband-input', children: t('disband.inputLabel') }),
              j('input', {
                id: 'mt-disband-input',
                className: 'mt-input',
                value: typed,
                placeholder: String(teamId ?? ''),
                'aria-invalid': !matched && String(typed).length > 0,
                onChange: (e) => { setTyped(e.target.value); setHint(null) },
              }),
            ] }),
            j('p', { className: 'mt-dialog-note', children: t('disband.inputHint') }),
            hint ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: hint }) : null,
            error ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: error }) : null,
          ] }),
          js('div', { className: 'mt-dialog-foot', children: [
            j('button', {
              className: 'mt-btn',
              /* CHG-202x（P1-3）：「改用归档」要么由调用方接管，要么**关掉对话框**（归档入口在团队设置里）。
               * 修复前只 setHint 一句、对话框不动——看起来像点了没反应。 */
              onClick: () => { if (onArchive) { onArchive(); return } onClose?.() },
              children: t('disband.archive'),
            }),
            js('div', { className: 'mt-right', children: [
              j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
              j('button', {
                className: 'mt-btn mt-btn-danger',
                disabled: busy || !matched,
                title: matched ? undefined : needId,
                onClick: () => { if (!matched) { setHint(needId); return } onConfirm?.() },
                children: busy ? t('state.loading') : t('disband.confirm'),
              }),
            ] }),
          ] }),
        ],
      }) })
    }
