    function RoleFormDrawer({ t, initial, onClose, save, catalog }) {
      const def = initial?.definition ?? {}
      const [name, setName] = react.useState(def.name ?? '')
      const [id, setId] = react.useState(def.id ?? '')
      const [idTouched, setIdTouched] = react.useState(Boolean(def.id))
      const [description, setDescription] = react.useState(def.description ?? '')
      const [systemPrompt, setSystemPrompt] = react.useState(def.systemPrompt ?? '')
      const [interest, setInterest] = react.useState((def.interestWords ?? []).join('，'))
      const [skills, setSkills] = react.useState([...(def.skills ?? [])])
      const [mcps, setMcps] = react.useState([...(def.mcpAllowlist ?? [])])
      const [provider, setProvider] = react.useState(def.model?.provider ?? '')
      const [model, setModel] = react.useState(def.model?.model ?? '')
      const [err, setErr] = react.useState(null)
      const [confirm, setConfirm] = react.useState(false)
      /* CHG-103：作用域（缺省项目级；全局必须明示 + 二次确认） */
      const [scope, setScope] = react.useState(initial?.scope === 'global' ? 'global' : 'project')
      const [busy, setBusy] = react.useState(false)
      const deriveId = (value) => String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
      react.useEffect(() => {
        if (!idTouched) setId(deriveId(name))
      }, [name, idTouched])
      const split = (value) => String(value ?? '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
      const submit = async () => {
        if (busy) return
        setErr(null)
        const role = {
          id: id.trim(),
          name: name.trim() || id.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          skills: [...skills],
          mcpAllowlist: [...mcps],
          interestWords: split(interest).slice(0, 8),
          ...(initial?.forkOrigin === 'builtin' ? { origin: `builtin:${def.id}` } : {}),
          version: (def.version ?? 1) + (initial?.mode === 'edit' ? 1 : 0),
        }
        if (!role.id) { setErr(t('role.needId')); return }
        if (!role.systemPrompt) { setErr(t('role.needPrompt')); return }
        if (provider.trim() && model.trim()) role.model = { provider: provider.trim(), model: model.trim() }
        setBusy(true)
        try {
          const result = await save(role, confirm, scope)
          if (result?.status === 'confirm-required') {
            setConfirm(true)
            /* 服务端确认文案随作用域不同（全局影响所有项目），原样展示 */
            setErr(result?.message ?? null)
            return
          }
          if (result?.status !== 'saved') throw new Error(result?.message ?? result?.code ?? 'save failed')
          onClose()
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      return js('div', { className: 'mt-drawer mt-drawer-wide', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('strong', { children: `${t('role.formTitle')}${initial?.fork ? ` · ${t('role.fork')}` : ''}` }),
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        initial?.fork ? j('div', { className: 'mt-form-note', children: t('role.builtinReadonly') }) : null,
        js('div', { className: 'mt-form', children: [
          js('div', { className: 'mt-field-row', children: [
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.name') }),
              j('input', { value: name, onChange: (e) => setName(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.id') }),
              j('input', { value: id, onChange: (e) => { setIdTouched(true); setId(e.target.value) } }),
            ] }),
          ] }),
          /* CHG-103：作用域（缺省项目级；全局必须明示——用户定案「全局一定要明示」） */
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.scope') }),
            js('div', { className: 'mt-rolescope-row', role: 'radiogroup', children: [
              j('label', { className: scope === 'project' ? 'mt-rolescope-chip mt-rolescope-chip-active' : 'mt-scope-chip', children: [
                j('input', { type: 'radio', name: 'role-scope', checked: scope === 'project', onChange: () => { setScope('project'); setConfirm(false); setErr(null) } }),
                j('span', { children: t('role.scope.project') }),
                j('small', { children: t('role.scope.projectHint') }),
              ] }),
              j('label', { className: scope === 'global' ? 'mt-rolescope-chip mt-rolescope-chip-active' : 'mt-scope-chip', children: [
                j('input', { type: 'radio', name: 'role-scope', checked: scope === 'global', onChange: () => { setScope('global'); setConfirm(false); setErr(null) } }),
                j('span', { children: t('role.scope.global') }),
                j('small', { children: t('role.scope.globalHint') }),
              ] }),
            ] }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.desc') }),
            j('input', { value: description, onChange: (e) => setDescription(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.systemPrompt') }),
            j('textarea', { value: systemPrompt, onChange: (e) => setSystemPrompt(e.target.value) }),
          ] }),
          js('div', { className: 'mt-field', children: [
            j('label', { children: t('role.interestWords') }),
            j('input', { value: interest, placeholder: '代码审查，架构', onChange: (e) => setInterest(e.target.value) }),
          ] }),
          /* CHG-73：技能 / MCP 目录多选（getCapabilityCatalog；目录是提示不是白名单，仍可自由输入） */
          catalog === undefined
            ? j('div', { className: 'mt-form-note', children: t('state.loading') })
            : null,
          catalog?.fallback ? j('div', { className: 'mt-form-note mt-flow-warn', children: t('role.catalogFallback') }) : null,
          catalog?.warnings?.length ? j('div', { className: 'mt-form-note', children: `${t('presets.warnings')}：${catalog.warnings.join('；')}` }) : null,
          j(CapabilityPicker, {
            t,
            label: t('role.skills'),
            value: skills,
            onChange: setSkills,
            options: catalog?.skills ?? [],
            emptyText: t('role.skillsEmpty'),
          }),
          j(CapabilityPicker, {
            t,
            label: t('role.mcp'),
            value: mcps,
            onChange: setMcps,
            options: catalog?.mcp ?? [],
            emptyText: t('role.mcpEmpty'),
          }),
          js('div', { className: 'mt-field-row', children: [
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.modelProvider') }),
              j('input', { value: provider, onChange: (e) => setProvider(e.target.value) }),
            ] }),
            js('div', { className: 'mt-field', children: [
              j('label', { children: t('role.modelName') }),
              j('input', { value: model, onChange: (e) => setModel(e.target.value) }),
            ] }),
          ] }),
          confirm ? j('div', { className: 'mt-form-note mt-flow-warn', role: 'alert', children: t('role.confirmOverwrite') }) : null,
          err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: `${t('role.invalid').replace('{msg}', '')}${err}` }) : null,
          j('div', { className: 'mt-form-note', children: t('role.saveHint') }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: busy, onClick: submit, children: busy ? t('state.loading') : t('role.save') }),
          ] }),
        ] }),
      ] })
    }

    /** 任务表单（CHG-72，FR-29/31；CHG-73：新建单次 createTask，编辑结构改动给「保存并重新规划 / 只保存元数据」两个出口） */