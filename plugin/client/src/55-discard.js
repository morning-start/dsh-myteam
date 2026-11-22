    /* ── 丢弃暂存计划的两段确认（design-v2/p-approval.html）──
     * 影响面（N 任务作废 / 归档路径 / 不产生 token）+ 引导改用 Revise；
     * 影响面的计数从 getBoard 现算（单一事实源，不缓存第二份）。 */
    function DiscardDialog({ t, api, teamId, staged, onClose, onDone }) {
      const [board, setBoard] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      react.useEffect(() => {
        let alive = true
        if (!api || typeof api.getBoard !== 'function') { setBoard(null); return () => { alive = false } }
        api.getBoard({ teamId })
          .then((r) => { if (alive) setBoard(r?.board ? r : null) })
          .catch(() => { if (alive) setBoard(null) })
        return () => { alive = false }
      }, [api, teamId])
      const tasks = (board?.board?.columns ?? []).reduce((sum, column) => sum + (column.tasks ?? []).length, 0)
      const members = (board?.board?.members ?? []).length
      const planId = staged?.planId ?? 'plan-latest'
      const confirm = async () => {
        if (busy) return
        setBusy(true); setErr(null)
        try {
          const r = await api.planAction({ teamId, action: 'discard', planId, confirm: true })
          if (r?.status === 'error' || r?.ok === false) { setErr(t('discard.failed').replace('{msg}', String(r?.message ?? r?.code ?? '—'))); return }
          onDone?.(r)
        } catch (e) {
          setErr(t('discard.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-overlay', children: js('div', {
        className: 'mt-dialog',
        role: 'alertdialog',
        'aria-modal': true,
        'aria-labelledby': 'mt-discard-title',
        'aria-describedby': 'mt-discard-impact',
        children: [
          js('div', { className: 'mt-dialog-head', children: [
            js('div', { className: 'mt-dialog-steps', children: [
              js('span', { className: 'mt-mini-chip mt-mini-chip-gate', children: [
                j('span', { 'aria-hidden': true, children: '◆' }),
                j('span', { children: t('discard.step') }),
              ] }),
            ] }),
            j('strong', { id: 'mt-discard-title', children: t('discard.title') }),
            j('p', { className: 'mt-hint', children: t('discard.desc') }),
          ] }),
          js('div', { className: 'mt-dialog-body', children: [
            js('div', { className: 'mt-impact mt-impact-gate', id: 'mt-discard-impact', children: [
              j('b', { children: t('discard.impactTitle') }),
              js('ul', { children: [
                j('li', { children: t('discard.impactTasks').replace('{n}', String(tasks)).replace('{path}', `archive/${teamId}/`) }),
                j('li', { children: t('discard.impactState') }),
                j('li', { children: t('discard.impactNoToken') }),
                j('li', { children: t('discard.impactKeep') }),
              ] }),
            ] }),
            /* design .rows 的「计划摘要」是一张有边框的整块卡 */
            js('div', { className: 'mt-dt-summary', children: [
              j('div', { className: 'mt-dt-summary-title', children: t('discard.summary') }),
              j('div', { className: 'mt-dt-summary-sub', children: t('discard.summaryText').replace('{tasks}', String(tasks)).replace('{members}', String(members)).replace('{planId}', planId) }),
            ] }),
            j('p', { className: 'mt-dialog-note', children: t('discard.reviseHint') }),
            err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
          ] }),
          js('div', { className: 'mt-dialog-foot', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('discard.archive') }),
            js('div', { className: 'mt-right', children: [
              j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
              j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: confirm, children: busy ? t('state.loading') : t('discard.discardBtn') }),
            ] }),
          ] }),
        ],
      }) })
    }
