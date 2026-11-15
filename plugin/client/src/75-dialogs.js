    function RescopeDialog({ t, api, teamId, taskId, title, input, members, tasks, expectedRevision, onClose, onDone }) {
      const src = input ?? {}
      const [reason, setReason] = react.useState('')
      const [showPatch, setShowPatch] = react.useState(false)
      const [nextTitle, setNextTitle] = react.useState(src.title ?? '')
      const [description, setDescription] = react.useState(src.description ?? '')
      const [ac, setAc] = react.useState((src.acceptanceCriteria ?? []).join('\n'))
      const [deliverable, setDeliverable] = react.useState(src.deliverableSpec?.path ?? '')
      const [role, setRole] = react.useState(src.requiredRole ?? '')
      const [priority, setPriority] = react.useState(src.priority ?? '')
      const [gates, setGates] = react.useState((src.gateChain ?? []).join(', '))
      const [deps, setDeps] = react.useState(new Set(src.deps ?? []))
      const [memberIds, setMemberIds] = react.useState(new Set())
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const toggle = (set, value) => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }
      const roleOptions = [...new Set((members ?? []).map((member) => member.roleId).filter(Boolean))]
      const depOptions = (tasks ?? []).filter((task) => task.id !== taskId)
      const submit = async () => {
        if (busy) return
        setErr(null)
        const trimmed = String(reason).trim()
        if (!trimmed) { setErr(t('task.rescopeNeedReason')); return }
        const acList = ac.split('\n').map((line) => line.trim()).filter(Boolean)
        const gateList = gates.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        const patch = {}
        if (nextTitle.trim() !== (src.title ?? '')) patch.title = nextTitle.trim()
        if (description.trim() !== (src.description ?? '')) patch.description = description.trim()
        if (acList.join('\n') !== (src.acceptanceCriteria ?? []).join('\n')) patch.acceptanceCriteria = acList
        if (deliverable.trim() !== (src.deliverableSpec?.path ?? '')) patch.deliverableSpec = { path: deliverable.trim() }
        if (role !== (src.requiredRole ?? '')) patch.requiredRole = role
        if (priority !== (src.priority ?? '')) patch.priority = priority
        if (gateList.join(',') !== (src.gateChain ?? []).join(',')) patch.gateChain = gateList
        if ([...deps].join(',') !== (src.deps ?? []).join(',')) patch.deps = [...deps]
        setBusy(true)
        try {
          const r = await api.rescopeTask({
            teamId,
            taskId,
            reason: trimmed,
            ...(Object.keys(patch).length > 0 ? { patch } : {}),
            ...(memberIds.size > 0 ? { memberIds: [...memberIds] } : {}),
            /* CHG-89（QA-4 乐观锁）：与编辑表单同一条规则——基于过期版本的重新规划不落地 */
            ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
          })
          if (r?.code === 'MT_REVISION_CONFLICT') {
            throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
          }
          if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'rescope failed')
          if (r?.status !== 'rescoped') throw new Error(r?.message ?? 'rescope failed')
          onDone?.(r)
        } catch (e) {
          setErr(t('task.rescopeFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-overlay', children: js('div', { className: 'mt-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('rescope.title'), children: [
        js('div', { className: 'mt-dialog-head', children: [
          j('strong', { children: `${t('rescope.title')} · ${title || taskId}` }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-dialog-body', children: [
          j('div', { className: 'mt-form-note', children: t('rescope.hint') }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('rescope.reason') }),
            j('textarea', { value: reason, placeholder: t('rescope.reason'), onChange: (e) => setReason(e.target.value) }),
          ] }),
          j('button', { className: 'mt-chipbtn', 'aria-expanded': showPatch, onClick: () => setShowPatch(!showPatch), children: `${showPatch ? '▾' : '▸'} ${t('rescope.patch')}` }),
          showPatch ? js('div', { className: 'mt-form', children: [
            j('div', { className: 'mt-hint', children: t('rescope.patchHint') }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('field.title') }),
              j('input', { value: nextTitle, onChange: (e) => setNextTitle(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('field.description') }),
              j('textarea', { value: description, onChange: (e) => setDescription(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.ac') }),
              j('textarea', { value: ac, onChange: (e) => setAc(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field-row', children: [
              js('div', { className: 'mt-field', children: [
                j('label', { children: t('task.field.role') }),
                js('select', {
                  value: role,
                  onChange: (e) => setRole(e.target.value),
                  children: [
                    j('option', { value: '', children: '—' }),
                    ...roleOptions.map((id) => j('option', { key: id, value: id, children: roleLabel(id) })),
                  ],
                }),
              ] }),
              js('div', { className: 'mt-field', children: [
                j('label', { children: t('field.priority') }),
                js('select', {
                  value: priority,
                  onChange: (e) => setPriority(e.target.value),
                  children: ['', 'P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value || 'none', value, children: value || '—' })),
                }),
              ] }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.deliverable') }),
              j('input', { value: deliverable, onChange: (e) => setDeliverable(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.gates') }),
              j('input', { value: gates, onChange: (e) => setGates(e.target.value) }),
            ] }),
            depOptions.length > 0 ? js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.field.deps') }),
              js('div', { className: 'mt-checklist', children: depOptions.map((task) => js('label', { key: task.key ?? task.id, className: 'mt-check', children: [
                j('input', { type: 'checkbox', checked: deps.has(task.id), onChange: () => setDeps((prev) => toggle(prev, task.id)) }),
                j('span', { children: `${task.id} · ${task.title}` }),
              ] })) }),
            ] }) : null,
          ] }) : null,
          (members ?? []).length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('rescope.reassign') }),
            js('div', { className: 'mt-checklist', children: (members ?? []).map((member) => js('label', { key: member.id, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: memberIds.has(member.id), onChange: () => setMemberIds((prev) => toggle(prev, member.id)) }),
              j('span', { children: `${member.instanceName} · ${roleLabel(member.roleId)}` }),
            ] })) }),
            j('div', { className: 'mt-hint', children: t('rescope.reassignHint') }),
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
        ] }),
        js('div', { className: 'mt-dialog-actions', children: [
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
          j('button', {
            className: 'mt-btn mt-btn-primary',
            disabled: busy || !String(reason).trim(),
            title: String(reason).trim() ? t('rescope.submit') : t('task.rescopeNeedReason'),
            onClick: submit,
            children: busy ? t('state.loading') : t('rescope.submit'),
          }),
        ] }),
      ] }) })
    }

    /** 取消对话框（CHG-73 §4.4 / CHG-75 §5）：理由必填 + 下游策略三档（leave / cancel / rewire）；
     *  先拿 impact 再 confirm:true。rewire 档可指定新上游（不选 = 解除依赖让下游独立）。 */
    function CancelDialog({ t, api, teamId, taskId, title, dependents, upstreams, memberName, onClose, onDone }) {
      const [reason, setReason] = react.useState('')
      const [downstream, setDownstream] = react.useState('leave')
      const [rewireTo, setRewireTo] = react.useState('')
      const [impact, setImpact] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      /** rewire 档：选了具体上游才带 rewireTo；不选 = 解除依赖（下游变独立） */
      const rewireArgs = downstream === 'rewire' && rewireTo ? { rewireTo } : {}
      /** 两段确认的两步各自的响应处理（rewire 与常规两档共用，避免分支里重复） */
      const handleAsk = (r) => {
        if (r?.status === 'confirm-required') { setImpact(r.impact ?? {}); return }
        if (r?.status === 'cancelled') { onDone?.(r); return }
        throw new Error(r?.message ?? r?.code ?? 'cancel failed')
      }
      const handleConfirm = (r) => {
        if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'cancel failed')
        if (r?.status !== 'cancelled') throw new Error(r?.message ?? 'cancel failed')
        onDone?.(r)
      }
      const ask = async () => {
        if (busy) return
        setErr(null)
        const trimmed = String(reason).trim()
        if (!trimmed) { setErr(t('cancel.needReason')); return }
        setBusy(true)
        try {
          /* rewire 档单独一条调用：rewireTo 只在这一档出现，不选则不传（= 解除依赖） */
          if (downstream === 'rewire') {
            const r = await api.cancelTask({ teamId, taskId, reason: trimmed, downstream, ...rewireArgs })
            handleAsk(r)
            return
          }
          const r = await api.cancelTask({ teamId, taskId, reason: trimmed, downstream })
          handleAsk(r)
        } catch (e) {
          setErr(t('cancel.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const confirm = async () => {
        if (busy) return
        setErr(null)
        setBusy(true)
        try {
          if (downstream === 'rewire') {
            const r = await api.cancelTask({ teamId, taskId, reason: String(reason).trim(), downstream, ...rewireArgs, confirm: true })
            handleConfirm(r)
            return
          }
          const r = await api.cancelTask({ teamId, taskId, reason: String(reason).trim(), downstream, confirm: true })
          handleConfirm(r)
        } catch (e) {
          setErr(t('cancel.failed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const deps = impact?.dependents ?? dependents ?? []
      /** 影响面文案按档位分述（leave 保持原样 / cancel 一并取消 / rewire 改挂新上游） */
      const impactKey = downstream === 'cancel' ? 'cancel.impactCascade' : downstream === 'rewire' ? 'cancel.impactRewire' : 'cancel.impact'
      const upstreamOptions = upstreams ?? []
      return js('div', { className: 'mt-overlay', children: js('div', { className: 'mt-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('cancel.title'), children: [
        js('div', { className: 'mt-dialog-head', children: [
          j('strong', { children: `${t('cancel.title')} · ${title || taskId}` }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-dialog-body', children: [
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('cancel.reason') }),
            j('textarea', { value: reason, placeholder: t('cancel.reason'), onChange: (e) => { setReason(e.target.value); setImpact(null) } }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('cancel.strategy') }),
            js('label', { className: 'mt-radio', children: [
              j('input', { type: 'radio', name: 'mt-downstream', checked: downstream === 'leave', onChange: () => { setDownstream('leave'); setImpact(null) } }),
              j('span', { children: t('cancel.leave') }),
            ] }),
            js('label', { className: 'mt-radio', children: [
              j('input', { type: 'radio', name: 'mt-downstream', checked: downstream === 'cancel', onChange: () => { setDownstream('cancel'); setImpact(null) } }),
              j('span', { children: t('cancel.cascade') }),
            ] }),
            js('label', { className: 'mt-radio', children: [
              j('input', { type: 'radio', name: 'mt-downstream', checked: downstream === 'rewire', onChange: () => { setDownstream('rewire'); setImpact(null) } }),
              j('span', { children: t('cancel.rewire') }),
            ] }),
          ] }),
          downstream === 'rewire' ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('cancel.rewireTo') }),
            j('select', {
              className: 'mt-select',
              value: rewireTo,
              'aria-label': t('cancel.rewireTo'),
              onChange: (e) => { setRewireTo(e.target.value); setImpact(null) },
              children: [
                j('option', { value: '', children: t('cancel.rewireNone') }),
                ...upstreamOptions.map((option) => j('option', {
                  key: option.id,
                  value: option.id,
                  children: `${option.id} · ${option.title ?? ''}${option.done ? ` ${t('cancel.rewireDone')}` : ''}`,
                })),
              ],
            }),
            j('div', { className: 'mt-hint', children: upstreamOptions.length === 0 ? t('cancel.rewireEmpty') : t('cancel.rewireHint') }),
          ] }) : null,
          impact ? js('div', { className: 'mt-impactbox', role: 'alert', children: [
            j('strong', { children: t(impactKey).replace('{dependents}', String(deps.length)) }),
            j('span', { children: impact.hasAttempt ? t('cancel.hasAttempt') : t('cancel.noAttempt') }),
            deps.length > 0 ? js('div', { children: [
              j('span', { children: `${t('cancel.dependents')}：` }),
              j('span', { className: 'mt-hint', children: deps.join('、') }),
            ] }) : null,
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
        ] }),
        js('div', { className: 'mt-dialog-actions', children: [
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.cancel') }),
          impact
            ? j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: confirm, children: busy ? t('state.loading') : t('cancel.confirm') })
            : j('button', { className: 'mt-btn mt-btn-primary', disabled: busy || !String(reason).trim(), onClick: ask, children: busy ? t('state.loading') : t('cancel.step1') }),
        ] }),
      ] }) })
    }

    /** 批量操作条（CHG-73 §4.2）：底部浮动；取消两段确认并显示影响面；指派/优先级就地选参数
     *  CHG-76 A：下游策略三档 leave / cancel / rewire + 「新的上游」下拉（不选 = 解除依赖） */