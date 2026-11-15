    /* ── 暂存横幅三动作（FR-1.2：面板唯一写入口）──
     * CHG-82（G1）：Discard 换成 design/discard.html 的两段确认对话框（不再用 window.confirm） */
    function StagedBanner({ api, t, teamId, inbox, onAct }) {
      const [discard, setDiscard] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      if (!inbox?.staged) return null
      const planId = inbox.staged.planId
      const act = async (action) => {
        if (busy) return
        setErr(null)
        try {
          if (action === 'discard') {
            /* 两段确认第一段：服务端只回 confirm-required，影响面由 DiscardDialog 用 getBoard 现算 */
            const first = await api.planAction({ teamId, action, planId, confirm: false })
            if (first?.status === 'confirm-required') { setDiscard({ planId }); return }
            if (first?.status === 'error') { setErr(String(first?.message ?? first?.code ?? 'plan action failed')); return }
            onAct()
            return
          }
          setBusy(true)
          const r = await api.planAction({ teamId, action, planId })
          if (r?.status === 'error') { setErr(String(r?.message ?? r?.code ?? 'plan action failed')); return }
          onAct()
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-banner', role: 'alert', children: [
        js('span', { children: [`${t('banner.staged')}（`, inbox.staged.state === 'draft' ? '草稿' : inbox.staged.state, `）— ${t('banner.waiting')}`] }),
        js('span', { className: 'mt-banner-actions', children: [
          j('button', { className: 'mt-btn mt-btn-primary', disabled: busy, onClick: () => act('approve'), children: t('action.approve') }),
          j('button', { className: 'mt-btn', disabled: busy, onClick: () => act('revise'), children: t('action.revise') }),
          j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: () => act('discard'), children: t('action.discard') }),
        ] }),
        err ? j('span', { className: 'mt-hint', children: err }) : null,
        discard ? j(DiscardDialog, { t, api, teamId, staged: discard, onClose: () => setDiscard(null), onDone: () => { setDiscard(null); onAct() } }) : null,
      ] })
    }
