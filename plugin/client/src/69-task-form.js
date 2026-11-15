    function TaskFormDrawer({ t, mode, teams, tasks, initial, defaultTeamId, connection, onClose, onSaved }) {
      const src = initial?.input ?? {}
      const [teamId, setTeamId] = react.useState(initial?.ownerTeamId ?? defaultTeamId ?? '')
      const [title, setTitle] = react.useState(src.title ?? '')
      const [description, setDescription] = react.useState(src.description ?? '')
      const [ac, setAc] = react.useState((src.acceptanceCriteria ?? []).join('\n'))
      const [deliverable, setDeliverable] = react.useState(src.deliverableSpec?.path ?? '')
      const [role, setRole] = react.useState(src.requiredRole ?? '')
      const [priority, setPriority] = react.useState(src.priority ?? 'P2')
      const [gates, setGates] = react.useState((src.gateChain ?? []).join(', '))
      /* CHG-202x（P1-1）：verify 门要执行的命令（argv 空格分隔 + 可选 cwd）。
       * 修复前面板**没有任何**写 verifyCommand 的控件，而门禁链又能配成含 verify →
       * 能从面板造出一个「永远过不去的门」（按钮恒 disabled，也没有出口）。 */
      const [verifyCmd, setVerifyCmd] = react.useState((src.verifyCommand?.argv ?? []).join(' '))
      const [verifyCwd, setVerifyCwd] = react.useState(src.verifyCommand?.cwd ?? '')
      const [deps, setDeps] = react.useState(new Set(src.deps ?? []))
      const [assignees, setAssignees] = react.useState(new Set(initial?.assignees ?? []))
      const [coops, setCoops] = react.useState(new Set((initial?.participants ?? []).filter((p) => p.role === 'coop').map((p) => p.teamId)))
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      /* CHG-89（QA-4 乐观锁）：编辑表单打开时的版本快照。保存时回传 expectedRevision，
       * 服务端与当前 revision 不等即 MT_REVISION_CONFLICT（账本零写入）——
       * 面板据此提示「别人刚改过，重新加载再改」，而不是静默覆盖对方的修改。 */
      const expectedRevision = typeof initial?.revision === 'number' ? initial.revision : undefined
      const [structural, setStructural] = react.useState(null)
      const [rescopeReason, setRescopeReason] = react.useState('')
      const team = teams.find((item) => item.teamId === teamId)
      const members = team?.members ?? []
      const roleOptions = [...new Set(members.map((member) => member.roleId))]
      const depOptions = (tasks ?? []).filter((task) => task.ownerTeamId === teamId && task.id !== initial?.id)
      const coopOptions = teams.filter((item) => item.teamId !== teamId)
      const online = Boolean(team?.online && team?.sessionId)
      react.useEffect(() => {
        if (!role && roleOptions.length > 0) setRole(roleOptions[0])
      }, [teamId, members.length])
      const initialNorm = initial ? {
        title: src.title ?? '', description: src.description ?? '', ac: (src.acceptanceCriteria ?? []).join('\n'),
        deliverable: src.deliverableSpec?.path ?? '', deps: (src.deps ?? []).join(','), role: src.requiredRole ?? '',
        priority: src.priority ?? 'P2', gates: (src.gateChain ?? []).join(','),
        verify: `${(src.verifyCommand?.argv ?? []).join(' ')}|${src.verifyCommand?.cwd ?? ''}`,
      } : null
      const toggle = (set, value) => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }
      const running = initial ? (initial.state === 'in_progress' || String(initial.state ?? '').startsWith('gate:')) : false
      /**
       * CHG-89（QA-4）：版本冲突的统一提示。
       *
       * 服务端在 `MT_REVISION_CONFLICT` 时回显 `currentRevision`——直接展示两侧版本号，
       * 用户才知道「我基于哪一版改、现在是哪一版」，而不是只看到一句「保存失败」。
       */
      const conflictText = (r) => t('task.revisionConflict')
        .replace('{current}', String(r?.currentRevision ?? '—'))
        .replace('{snapshot}', String(expectedRevision ?? '—'))
      /** mode: 'save' 普通保存 | 'meta' 只保存元数据 | 'rescope' 保存并重新规划（理由必填） */
      const submit = async (intent = 'save') => {
        if (busy) return
        setErr(null)
        const metaOnly = intent === 'meta'
        const rescoping = intent === 'rescope'
        const acList = ac.split('\n').map((line) => line.trim()).filter(Boolean)
        if (!title.trim()) { setErr(t('task.needTitle')); return }
        if (acList.length === 0) { setErr(t('task.needAc')); return }
        if (!online) { setErr(t('task.needOnline')); return }
        if (!role) { setErr(t('task.needRole')); return }
        if (rescoping && !rescopeReason.trim()) { setErr(t('task.rescopeNeedReason')); return }
        const gateList = gates.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        /* CHG-202x（P1-1）：argv 以空白切分（与 CLI 习惯一致；带空格的参数请用引号包住的单个 token 不在此支持） */
        const verifyArgv = verifyCmd.split(/\s+/).map((part) => part.trim()).filter(Boolean)
        const verifyCwdValue = verifyCwd.trim()
        const api = makeApi(connection, team.sessionId)
        setBusy(true)
        try {
          if (mode === 'create') {
            const payload = {
              title: title.trim(),
              description: description.trim(),
              acceptanceCriteria: acList,
              deps: [...deps],
              requiredRole: role,
              priority,
              ...(deliverable.trim() ? { deliverableSpec: { path: deliverable.trim() } } : {}),
              ...(gateList.length > 0 ? { gateChain: gateList } : {}),
              ...(verifyArgv.length > 0 ? { verifyCommand: { argv: verifyArgv, ...(verifyCwdValue ? { cwd: verifyCwdValue } : {}) } } : {}),
            }
            // CHG-73：新建改为单次 createTask（assignees/participants 随创建一起落账，服务端补写标注）
            const created = await api.createTask({
              teamId,
              task: payload,
              ...(assignees.size > 0 ? { assignees: [...assignees] } : {}),
              ...(coops.size > 0 ? { participants: [...coops].map((coopId) => ({ teamId: coopId })) } : {}),
            })
            if (created?.status !== 'created') throw new Error(created?.message ?? created?.code ?? 'create failed')
            const warnings = (created.warnings ?? []).filter(Boolean)
            const message = t('task.created').replace('{id}', created.taskId) + (warnings.length > 0 ? ` · ${warnings.join('；')}` : '')
            onSaved(created.taskId, message)
            return
          }
          const normalized = {
            title: title.trim(), description: description.trim(), ac: acList.join('\n'),
            deliverable: deliverable.trim(), deps: [...deps].join(','), role,
            priority, gates: gateList.join(','), verify: `${verifyArgv.join(' ')}|${verifyCwdValue}`,
          }
          const patch = {}
          if (normalized.title !== initialNorm.title) patch.title = normalized.title
          if (normalized.description !== initialNorm.description) patch.description = normalized.description
          if (normalized.ac !== initialNorm.ac) patch.acceptanceCriteria = acList
          if (normalized.deps !== initialNorm.deps) patch.deps = [...deps]
          if (normalized.role !== initialNorm.role) patch.requiredRole = role
          if (normalized.priority !== initialNorm.priority) patch.priority = priority
          if (normalized.gates !== initialNorm.gates) patch.gateChain = gateList
          /* CHG-202x（P1-1）：verifyCommand 是任务定义的一部分（结构性改动 → 在跑任务走 rescope 出口） */
          /* CHG-202x（P1-1）：只有真的填了命令才进补丁——服务端 `validateVerifyCommand` 拒绝 null/空 argv，
           * 而清空命令本身没有语义（门禁链里没有 verify 时它不参与任何判定）。 */
          if (normalized.verify !== initialNorm.verify && verifyArgv.length > 0) {
            patch.verifyCommand = { argv: verifyArgv, ...(verifyCwdValue ? { cwd: verifyCwdValue } : {}) }
          }
          if (normalized.deliverable !== initialNorm.deliverable) patch.deliverableSpec = { path: normalized.deliverable }
          const structuralKeys = ['acceptanceCriteria', 'deps', 'requiredRole', 'gateChain', 'deliverableSpec', 'verifyCommand'].filter((key) => key in patch)
          const initialAssignees = new Set(initial?.assignees ?? [])
          const assigneesChanged = assignees.size !== initialAssignees.size || [...assignees].some((id) => !initialAssignees.has(id))
          // CHG-73：结构字段改动且任务在跑 → 两个出口：保存并重新规划（rescopeTask）/ 只保存元数据（updateTask）
          if (running && structuralKeys.length > 0 && !metaOnly) {
            if (!rescoping) {
              setStructural(structuralKeys)
              return
            }
          }
          if (rescoping) {
            const r = await api.rescopeTask({
              teamId,
              taskId: initial.id,
              reason: rescopeReason.trim(),
              ...(Object.keys(patch).length > 0 ? { patch } : {}),
              ...(assigneesChanged && assignees.size > 0 ? { memberIds: [...assignees] } : {}),
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            })
            if (r?.code === 'MT_REVISION_CONFLICT') { setErr(conflictText(r)); return }
            if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'rescope failed')
            if (r?.status !== 'rescoped') throw new Error(r?.message ?? 'rescope failed')
            onSaved(null, t('task.rescopeDone').replace('{id}', String(initial.id)).replace('{state}', stateLabel(r.state)))
            return
          }
          if (metaOnly) for (const key of structuralKeys) delete patch[key]
          if (Object.keys(patch).length === 0 && !assigneesChanged) { onClose(); return }
          let updated = null
          if (Object.keys(patch).length > 0) {
            updated = await api.updateTask({
              teamId,
              taskId: initial.id,
              patch,
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            })
          }
          if (updated?.code === 'MT_REVISION_CONFLICT') { setErr(conflictText(updated)); return }
          if (updated?.status === 'error' && updated?.code === 'MT_TASK_STRUCTURAL_EDIT') {
            setStructural(structuralKeys.length > 0 ? structuralKeys : ['acceptanceCriteria'])
            return
          }
          if (updated && updated.status !== 'updated') throw new Error(updated?.message ?? updated?.code ?? 'update failed')
          if (assigneesChanged && assignees.size > 0) {
            const assigned = await api.assignTask({
              teamId,
              taskId: initial.id,
              memberIds: [...assignees],
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            })
            if (assigned?.code === 'MT_REVISION_CONFLICT') { setErr(conflictText(assigned)); return }
          }
          for (const coopId of coops) {
            if ((initial.participants ?? []).some((p) => p.teamId === coopId)) continue
            await api.participateTask({ teamId, taskId: initial.id, participantTeamId: coopId, role: 'coop' })
          }
          onSaved(null, t('task.updated'))
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-drawer mt-drawer-wide', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('strong', { children: mode === 'create' ? t('task.formTitleNew') : t('task.formTitleEdit') }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-form', children: [
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.team') }),
            js('select', {
              value: teamId,
              disabled: mode === 'edit',
              onChange: (e) => { setTeamId(e.target.value); setRole(''); setDeps(new Set()); setAssignees(new Set()); setCoops(new Set()) },
              children: teams.map((item) => j('option', { key: item.teamId, value: item.teamId, children: `${item.name || item.teamId}${item.online ? '' : ` · ${t('global.offline')}`}` })),
            }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.title') }),
            j('input', { value: title, onChange: (e) => setTitle(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.desc') }),
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
              j('label', { children: t('task.field.priority') }),
              js('select', {
                value: priority,
                onChange: (e) => setPriority(e.target.value),
                children: ['P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value, value, children: value })),
              }),
            ] }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.deliverable') }),
            j('input', { value: deliverable, placeholder: 'docs/x.md', onChange: (e) => setDeliverable(e.target.value) }),
          ] }),
          depOptions.length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.deps') }),
            js('div', { className: 'mt-checklist', children: depOptions.map((task) => js('label', { key: task.key, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: deps.has(task.id), onChange: () => setDeps((prev) => toggle(prev, task.id)) }),
              j('span', { children: `${task.id} · ${task.title}` }),
            ] })) }),
          ] }) : null,
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.gates') }),
            j('input', { value: gates, placeholder: 'review, verify, archive', onChange: (e) => setGates(e.target.value) }),
            /* CHG-202x（P1-1）：门禁链含 verify 时必须能填命令，否则死锁（见上） */
            gates.split(/[,，]/).map((item) => item.trim()).includes('verify')
              ? js('div', { className: 'mt-field-row', children: [
                j('input', { value: verifyCmd, placeholder: 'npm test', 'aria-label': t('task.field.verifyArgv'), onChange: (e) => setVerifyCmd(e.target.value) }),
                j('input', { value: verifyCwd, placeholder: t('task.field.verifyCwdPlaceholder'), 'aria-label': t('task.field.verifyCwd'), onChange: (e) => setVerifyCwd(e.target.value) }),
              ] })
              : null,
            j('p', { className: 'mt-hint', children: t('task.field.verifyHint') }),
          ] }),
          members.length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.assignees') }),
            js('div', { className: 'mt-checklist', children: members.map((member) => js('label', { key: member.id, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: assignees.has(member.id), onChange: () => setAssignees((prev) => toggle(prev, member.id)) }),
              j('span', { children: `${member.instanceName} · ${roleLabel(member.roleId)}` }),
            ] })) }),
          ] }) : null,
          coopOptions.length > 0 ? js('div', { className: 'mt-field', children: [
            j('label', { children: t('task.field.participants') }),
            js('div', { className: 'mt-checklist', children: coopOptions.map((item) => js('label', { key: item.teamId, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: coops.has(item.teamId), onChange: () => setCoops((prev) => toggle(prev, item.teamId)) }),
              j('span', { children: item.name || item.teamId }),
            ] })) }),
          ] }) : null,
          structural ? js('div', { className: 'mt-form-note mt-flow-warn', role: 'alert', children: [
            j('div', { children: t('task.structuralBlocked') }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('task.structuralReason') }),
              j('input', { value: rescopeReason, placeholder: t('rescope.reason'), onChange: (e) => setRescopeReason(e.target.value) }),
            ] }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn', onClick: () => setStructural(null), children: t('task.dismissStructural') }),
              j('button', { className: 'mt-btn', disabled: busy, onClick: () => submit('meta'), children: t('task.saveMetaOnly') }),
              j('button', {
                className: 'mt-btn mt-btn-primary',
                disabled: busy || !rescopeReason.trim(),
                title: rescopeReason.trim() ? t('task.rescopeAndSave') : t('task.rescopeNeedReason'),
                onClick: () => submit('rescope'),
                children: busy ? t('state.loading') : t('task.rescopeAndSave'),
              }),
            ] }),
          ] }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
          !online ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('task.needOnline') }) : null,
          online && members.length === 0 ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('task.noMembers') }) : null,
          j('div', { className: 'mt-form-note', children: t('task.formHint') }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: busy || !online || members.length === 0 || Boolean(structural), onClick: () => submit('save'), children: busy ? t('state.loading') : t('task.save') }),
          ] }),
        ] }),
      ] })
    }

    /* ══ CHG-76 B：批量新建草稿（目标 + 行列表 → 预览 impact → 一次创建） ══ */

    /** 草稿行的稳定 key（只用于列表渲染；不参与提交内容） */