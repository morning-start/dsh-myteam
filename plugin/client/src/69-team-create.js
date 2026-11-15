    function TeamCreateDrawer({ t, ctx, projectRoot, presets, roles, onClose, onManagePresets, onRetryPresets }) {
      const [step, setStep] = react.useState(1)
      const [name, setName] = react.useState('')
      const [goal, setGoal] = react.useState('')
      /** null = 还没动过（默认套第一个预设，与设计稿「不知道选哪个就选第一个」一致） */
      const [picked, setPicked] = react.useState(null)
      /** null = 名册跟着预设走；一旦手动增删就切到显式列表 */
      const [rosterOverride, setRosterOverride] = react.useState(null)
      const [err, setErr] = react.useState(null)
      const [copied, setCopied] = react.useState(false)
      const entries = presets?.entries ?? []
      const MAX_ROSTER = 6
      /** design/new-team-1.html 的加载态：预设目录是异步拉的（getOfflinePresets 要读预设目录），
       *  未就绪时立刻给骨架，别让用户以为点了没反应；读取失败给「重试」+ 兜底「不套预设」。 */
      const presetsLoading = presets === undefined
      const presetsFailed = presets === null
      const presetOf = (entry) => entry?.definition?.id ?? entry?.file
      const firstPresetId = entries[0] ? presetOf(entries[0]) : ''
      const presetId = picked === null ? firstPresetId : picked
      const preset = entries.find((entry) => presetOf(entry) === presetId)
      const avatarClass = (index) => (index === 0 ? 'mt-mavatar mt-mavatar-lead' : `mt-mavatar mt-mavatar-a${(index % 4) + 1}`)
      /** 实例名 = 角色 id；同名第二个起加 -2、-3（与成员实例名规则一致） */
      const instanceNameFor = (roleId, list) => {
        if (!list.some((item) => item.instanceName === roleId)) return roleId
        let n = 2
        while (list.some((item) => item.instanceName === `${roleId}-${n}`)) n += 1
        return `${roleId}-${n}`
      }
      const presetRoster = ((preset?.definition?.members ?? []).slice(0, MAX_ROSTER))
        .map((member) => ({ roleId: member.roleId, instanceName: member.instanceName ?? member.roleId }))
      const roster = rosterOverride ?? presetRoster
      /* CHG-202x（P0-7）：名册是用户在向导里做的唯一结构决策——必须进消息（见 buildTeamPrompt 头）。
       * 位置必须在 `roster` **之后**（之前放在 preset 后面，const 还没初始化就取用 = TDZ）。 */
      const prompt = buildTeamPrompt({ name, goal, presetId, presetName: preset?.definition?.name, roster })
      const pickPreset = (id) => {
        setErr(null)
        setPicked(id)
        const entry = entries.find((item) => presetOf(item) === id)
        setRosterOverride(id ? (entry?.definition?.members ?? []).slice(0, MAX_ROSTER)
          .map((member) => ({ roleId: member.roleId, instanceName: member.instanceName ?? member.roleId })) : [])
      }
      const addRole = (role) => {
        if (roster.length >= MAX_ROSTER) return
        setRosterOverride([...roster, { roleId: role.id, instanceName: instanceNameFor(role.id, roster) }])
      }
      const removeAt = (index) => setRosterOverride(roster.filter((_, i) => i !== index))
      const start = () => {
        if (!name.trim()) { setStep(3); setErr(t('g6.wizard.needName')); return }
        if (!goal.trim()) { setStep(3); setErr(t('g6.wizard.needGoal')); return }
        // ctx.uiWorkspace 是「未 inject 就抛错」的服务属性；这里用 ctx.get 取，拿不到再降级为复制指令
        let workspace
        try { workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined } catch { workspace = undefined }
        const snapshot = workspace?.workspaces?.list?.getSnapshot?.()
        const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase()
        const target = (snapshot?.items ?? []).find((item) => norm(item.path) === norm(projectRoot))
        if (!workspace?.startSession || !target) { setErr(t('g6.wizard.unavailable')); return }
        workspace.startSession(target.workspaceId, { agentPreset: 'myteam-captain', prompt, whenDraftExists: 'replace' })
        onClose()
      }
      const copy = async () => {
        if (!name.trim()) { setStep(3); setErr(t('g6.wizard.needName')); return }
        if (!goal.trim()) { setStep(3); setErr(t('g6.wizard.needGoal')); return }
        setErr(null)
        if (await copyText(prompt)) setCopied(true)
      }
      const STEP_KEYS = [['preset', 1], ['roster', 2], ['goal', 3]]
      const stepBar = js('div', { className: 'mt-steps', children: STEP_KEYS.flatMap(([key, n], index) => {
        const cls = step === n ? 'mt-step mt-step-on' : step > n ? 'mt-step mt-step-done' : 'mt-step'
        return [
          js('span', { key: `step-${key}`, className: cls, 'aria-current': step === n ? 'step' : undefined, children: [
            j('b', { 'aria-hidden': true, children: step > n ? '✓' : String(n) }),
            j('span', { children: t(`g6.step.${key}`) }),
          ] }),
          index < STEP_KEYS.length - 1 ? j('span', { key: `sep-${key}`, className: 'mt-step-sep', 'aria-hidden': true }) : null,
        ]
      }) })
      const presetOption = (entry, index) => {
        const def = entry.definition ?? {}
        const id = presetOf(entry)
        const members = (def.members ?? []).slice(0, MAX_ROSTER)
        const checked = presetId === id
        const columns = (def.board?.columns ?? []).join(' / ') || '—'
        const rolesText = members.map((member) => roleLabel(member.roleId)).join(' + ') || '—'
        return js('div', {
          key: `preset-${id}`,
          className: 'mt-opt',
          role: 'radio',
          tabIndex: 0,
          'aria-checked': checked,
          onClick: () => pickPreset(id),
          children: [
            j('span', { className: 'mt-opt-mark', 'aria-hidden': true, children: checked ? '✓' : '' }),
            js('div', { className: 'mt-opt-main', children: [
              js('div', { className: 'mt-opt-title', children: [
                j('span', { children: def.name ?? id }),
                j('span', { className: `mt-src mt-src-${entry.origin ?? 'project'}`, children: t(`roles.origin.${entry.origin ?? 'project'}`) }),
              ] }),
              j('div', { className: 'mt-opt-sub', children: t('g6.wizard.rosterMeta').replace('{n}', String(members.length)).replace('{roles}', rolesText).replace('{tail}', columns) }),
              js('div', { className: 'mt-rosterline', children: members.map((member, memberIndex) => js('span', {
                key: `${member.roleId}-${memberIndex}`,
                className: memberIndex === 0 ? 'mt-mini-chip mt-mini-chip-lead' : 'mt-mini-chip',
                children: [
                  j('span', { className: avatarClass(memberIndex), 'aria-hidden': true, children: String(roleLabel(member.roleId)).slice(0, 1) }),
                  j('span', { children: member.instanceName ?? member.roleId }),
                ],
              })) }),
              entry.origin === 'global' ? j('div', { className: 'mt-opt-hint', children: t('g6.wizard.globalHint') }) : null,
            ] }),
          ],
        })
      }
      const presetList = js('div', { className: 'mt-opt-list', children: [
        ...entries.map(presetOption),
        js('div', {
          key: 'preset-none',
          className: 'mt-opt',
          role: 'radio',
          tabIndex: 0,
          'aria-checked': presetId === '',
          onClick: () => pickPreset(''),
          children: [
            j('span', { className: 'mt-opt-mark', 'aria-hidden': true, children: presetId === '' ? '✓' : '' }),
            js('div', { className: 'mt-opt-main', children: [
              j('div', { className: 'mt-opt-title', children: t('g6.wizard.noPreset') }),
              j('div', { className: 'mt-opt-sub', children: t('g6.wizard.noPresetSub') }),
            ] }),
          ],
        }),
      ] })
      const presetNote = js('div', { className: 'mt-note mt-note-info', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '◱' }),
        j('span', { children: [j('b', { children: t('g6.wizard.presetNote') }), t('g6.wizard.presetNoteBody')] }),
      ] })
      const roleOptions = (roles ?? []).filter((role) => !roster.some((item) => item.roleId === role.id))
      const rosterSection = js('div', { children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('g6.wizard.selected').replace('{n}', String(roster.length)) }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: t('g6.wizard.cap').replace('{n}', String(MAX_ROSTER)) }),
        ] }),
        roster.length === 0
          ? j('div', { className: 'mt-hint', children: t('g6.wizard.noPresetSub') })
          : js('div', { className: 'mt-rosterline', children: roster.map((item, index) => js('span', {
            key: `${item.instanceName}-${index}`,
            className: 'mt-mini-chip',
            children: [
              j('span', { className: avatarClass(index), 'aria-hidden': true, children: String(roleLabel(item.roleId)).slice(0, 1) }),
              j('span', { children: roleLabel(item.roleId) }),
              j('code', { className: 'mt-mini-chip-num', children: item.instanceName }),
              j('button', {
                className: 'mt-mini-chip-x',
                'aria-label': t('g6.wizard.remove').replace('{name}', item.instanceName),
                onClick: () => removeAt(index),
                children: '✕',
              }),
            ],
          })) }),
      ] })
      const captainNote = js('div', { className: 'mt-note mt-note-info', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⬢' }),
        j('span', { children: [j('b', { children: t('g6.wizard.captainNote') }), t('g6.wizard.captainNoteBody')] }),
      ] })
      const librarySection = js('div', { children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('g6.wizard.fromLibrary') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: t('g6.wizard.pickHint') }),
        ] }),
        roleOptions.length === 0
          ? j('div', { className: 'mt-hint', children: t('roles.empty') })
          : js('div', { className: 'mt-opt-list', children: roleOptions.map((role) => js('div', {
            key: role.id,
            className: 'mt-opt',
            role: 'checkbox',
            tabIndex: 0,
            'aria-checked': false,
            onClick: () => addRole(role),
            children: [
              j('span', { className: 'mt-opt-mark', 'aria-hidden': true }),
              js('div', { className: 'mt-opt-main', children: [
                js('div', { className: 'mt-opt-title', children: [
                  j('span', { children: role.name ?? roleLabel(role.id) }),
                  j('span', { className: `mt-src mt-src-${role.origin ?? 'project'}`, children: t(`roles.origin.${role.origin ?? 'project'}`) }),
                ] }),
                j('div', { className: 'mt-opt-sub', children: t('g6.wizard.willCreate')
                  .replace('{name}', instanceNameFor(role.id, roster))
                  .replace('{model}', role.model?.model ?? t('g6.wizard.inheritRoute'))
                  .replace('{desc}', role.description ?? '') }),
              ] }),
            ],
          })) }),
      ] })
      const goalSection = js('div', { className: 'mt-form', children: [
        js('div', { className: 'mt-field', children: [
          j('label', { children: t('g6.wizard.name') }),
          j('input', { value: name, placeholder: 'myteam-web', onChange: (e) => setName(e.target.value) }),
        ] }),
        js('div', { className: 'mt-field', children: [
          j('label', { children: t('g6.wizard.goal') }),
          j('input', { value: goal, placeholder: '把 X 做成 Y', onChange: (e) => setGoal(e.target.value) }),
        ] }),
        js('div', { className: 'mt-field', children: [
          j('label', { children: t('g6.wizard.promptTitle') }),
          j('div', { className: 'mt-prompt-preview', children: prompt }),
        ] }),
      ] })
      const TITLE_KEYS = { 1: 'g6.wizard.title1', 2: 'g6.wizard.title2', 3: 'g6.wizard.title3' }
      const DESC_KEYS = { 1: 'g6.wizard.desc1', 2: 'g6.wizard.desc2', 3: 'g6.wizard.desc3' }
      /** 预设加载态：3 行骨架 + 「正在加载预设…」（aria-live，读屏也知道在等） */
      const presetSkeleton = js('div', { className: 'mt-skeleton', role: 'status', 'aria-live': 'polite', children: [
        j('span', { className: 'mt-skeleton-cap', children: t('g6.wizard.loadingPresets') }),
        ...[0, 1, 2].map((index) => js('div', { key: `skeleton-${index}`, className: 'mt-skeleton-row', 'aria-hidden': true, children: [
          j('span', { className: 'mt-skeleton-dot' }),
          js('span', { className: 'mt-skeleton-lines', children: [
            j('span', { className: 'mt-skeleton-line mt-skeleton-line-lg' }),
            j('span', { className: 'mt-skeleton-line' }),
          ] }),
        ] })),
      ] })
      /** 预设读取失败：给出重试 + 「不套预设」兜底（不伪造预设数据） */
      const presetFailedNote = js('div', { className: 'mt-note mt-note-warn', role: 'alert', children: [
        j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⚠' }),
        j('span', { children: [j('b', { children: t('g6.wizard.presetsFailed') }), t('g6.wizard.presetsFailedBody')] }),
        j('button', { className: 'mt-btn mt-btn-sm', onClick: () => (onRetryPresets ? onRetryPresets() : undefined), children: t('g6.wizard.retry') }),
      ] })
      const foot = js('div', { className: 'mt-wizard-foot', children: [
        step === 1
          ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => (onManagePresets ? onManagePresets() : undefined), children: t('g6.wizard.managePresets') })
          : j('span', { className: 'mt-wizard-footnote', children: t('g6.wizard.later') }),
        js('div', { className: 'mt-wizard-actions', children: [
          step === 1 ? j('button', { className: 'mt-btn', onClick: onClose, children: t('g6.wizard.cancel') }) : null,
          step > 1 ? j('button', { className: 'mt-btn', onClick: () => setStep(step === 2 ? 1 : 2), children: t('g6.wizard.prev') }) : null,
          step === 3 ? j('button', { className: 'mt-btn', onClick: copy, children: copied ? t('g6.wizard.copied') : t('g6.wizard.copy') }) : null,
          step < 3
            ? j('button', {
              className: 'mt-btn mt-btn-primary',
              disabled: step === 1 && presetsLoading,
              onClick: () => setStep(step + 1),
              children: step === 1 ? t('g6.wizard.nextRoster') : t('g6.wizard.nextGoal'),
            })
            : j('button', { className: 'mt-btn mt-btn-primary', onClick: start, children: t('g6.wizard.start') }),
        ] }),
      ] })
      return js('div', { className: 'mt-wizard', role: 'dialog', 'aria-modal': 'true', 'aria-label': t(TITLE_KEYS[step]), children: [
        js('div', { className: 'mt-wizard-dialog', children: [
          js('div', { className: 'mt-wizard-head', children: [
            js('div', { className: 'mt-wizard-steprow', children: [
              stepBar,
              j('button', { className: 'mt-btn mt-btn-sm', onClick: onClose, 'aria-label': t('action.close'), children: '✕' }),
            ] }),
            j('h2', { className: 'mt-wizard-title', children: t(TITLE_KEYS[step]) }),
            j('p', { className: 'mt-wizard-desc', children: t(DESC_KEYS[step]) }),
          ] }),
          js('div', { className: 'mt-wizard-body', children: [
            /* 第 1 步：预设未就绪先给骨架/失败态，再给选项（design/new-team-1.html） */
            step === 1 && presetsLoading ? presetSkeleton : null,
            step === 1 && presetsFailed ? presetFailedNote : null,
            /* 失败时仍给「不套预设」兜底（presetList 在 entries 为空时只剩这一条） */
            step === 1 && !presetsLoading ? presetList : null,
            step === 1 && !presetsLoading && !presetsFailed ? presetNote : null,
            step === 2 ? rosterSection : null,
            step === 2 ? captainNote : null,
            step === 2 ? librarySection : null,
            step === 3 ? goalSection : null,
            err ? j('div', { className: 'mt-note mt-note-info', role: 'alert', children: err }) : null,
          ] }),
          foot,
        ] }),
      ] })
    }

    /** 角色表单（CHG-72，FR-27；CHG-73：技能/MCP 改目录多选）：写项目角色库；同名两段确认；内置/全局走「复制到项目」 */