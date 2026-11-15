    function BatchBar({ t, tasks, allTasks, teams, memberName, onExit, onClear, runBatch, onDone }) {
      const [reason, setReason] = react.useState('')
      const [priority, setPriority] = react.useState('P2')
      const [memberIds, setMemberIds] = react.useState(new Set())
      const [showMembers, setShowMembers] = react.useState(false)
      const [strategy, setStrategy] = react.useState('leave')
      const [rewireTo, setRewireTo] = react.useState('')
      const [pending, setPending] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const picked = tasks ?? []
      const ownerTeams = [...new Set(picked.map((task) => task.ownerTeamId))]
      const memberOptions = (teams ?? [])
        .filter((team) => ownerTeams.includes(team.teamId))
        .flatMap((team) => (team.members ?? []).map((member) => ({ id: member.id, teamId: team.teamId, label: `${team.name || team.teamId} · ${member.instanceName}` })))
      /* CHG-76 A：新上游候选 = 所选任务所属团队内、不在所选集合、非 cancelled/failed；done 可选并标「（已完成）」 */
      const selectedIds = new Set(picked.map((task) => task.id))
      const ownerTeamSet = new Set(ownerTeams)
      const rewireOptions = (allTasks ?? [])
        .filter((task) => ownerTeamSet.has(task.ownerTeamId) && !selectedIds.has(task.id))
        .filter((task) => !['cancelled', 'failed'].includes(String(task.state ?? '')))
        .map((task) => ({ id: task.id, title: task.title ?? '', done: String(task.state ?? '') === 'done' }))
      /* rewire 档：选了具体上游才带 rewireTo；不选 = 解除依赖（下游变独立） */
      const rewireArgs = strategy === 'rewire' && rewireTo ? { rewireTo } : {}
      const toggle = (set, value) => {
        const next = new Set(set)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }
      const finish = (r) => {
        setPending(null)
        onDone?.(r)
      }
      const exec = async (op) => {
        if (busy) return
        setErr(null)
        if ((op === 'cancel' || op === 'rescope') && !String(reason).trim()) { setErr(t('batch.needReason')); return }
        if (op === 'assign' && memberIds.size === 0) { setErr(t('batch.needMembers')); return }
        /* rewireTo 是单值：跨团队混选没法给每个团队同一个合法上游，先让用户按团队筛选（防整批 MT_VALIDATION） */
        if (op === 'cancel' && strategy === 'rewire' && ownerTeams.length > 1) { setErr(t('batch.rewireOneTeam')); return }
        setBusy(true)
        try {
          const extra = {
            reason: String(reason).trim(),
            ...(op === 'cancel' ? { downstream: strategy, ...rewireArgs } : {}),
            ...(op === 'assign' ? { memberIds: [...memberIds] } : {}),
            ...(op === 'priority' ? { priority } : {}),
          }
          const r = await runBatch(op, extra, false)
          if (r?.kind === 'confirm') { setPending({ op, impacts: r.impacts ?? [] }); return }
          finish(r)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      const confirmCancel = async () => {
        if (busy) return
        setErr(null)
        if (strategy === 'rewire' && ownerTeams.length > 1) { setErr(t('batch.rewireOneTeam')); return }
        setBusy(true)
        try {
          const r = await runBatch('cancel', { reason: String(reason).trim(), downstream: strategy, ...rewireArgs }, true)
          finish(r)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      const impact = (pending?.impacts ?? []).reduce((acc, item) => ({
        tasks: acc.tasks + Number(item?.impact?.tasks ?? 0),
        dependents: [...acc.dependents, ...(item?.impact?.dependents ?? [])],
        /* CHG-76 A：服务端按所选任务给出各自要被改挂的直接下游（多团队混选时合并展示） */
        rewireByTask: [...acc.rewireByTask, ...(item?.impact?.rewireByTask ?? [])],
      }), { tasks: 0, dependents: [], rewireByTask: [] })
      const disabled = busy || picked.length === 0 || picked.length > 50
      return js('div', { className: 'mt-batchbar', role: 'toolbar', 'aria-label': t('batch.title'), children: [
        j('strong', { children: `${t('batch.title')} · ${t('multi.count').replace('{n}', String(picked.length))}` }),
        picked.length > 50 ? j('span', { className: 'mt-hint', children: t('multi.max').replace('{n}', '50') }) : null,
        j('input', { value: reason, placeholder: t('batch.reason'), 'aria-label': t('batch.reason'), onChange: (e) => setReason(e.target.value) }),
        j('button', { className: 'mt-btn mt-btn-sm mt-btn-danger', disabled, onClick: () => exec('cancel'), children: t('batch.cancelTask') }),
        /* CHG-76 A：批量取消的下游策略三选一（默认 leave；rewire 需选新上游，不选 = 解除依赖） */
        js('span', { className: 'mt-batchbar-group', children: ['leave', 'cancel', 'rewire'].map((value) => js('label', {
          key: value,
          className: 'mt-radio mt-batchbar-opt',
          title: value === 'rewire' ? (ownerTeams.length > 1 ? t('batch.rewireOneTeam') : t('batch.rewireHint')) : undefined,
          children: [
            j('input', {
              type: 'radio',
              name: 'mt-batch-downstream',
              checked: strategy === value,
              /* rewireTo 是单值：跨团队混选时这一档不可用（避免整批 MT_VALIDATION） */
              disabled: busy || (value === 'rewire' && ownerTeams.length > 1),
              onChange: () => { setStrategy(value); setPending(null) },
            }),
            /* cancel 档沿用「同时取消下游」文案（batch.cancel 只剩旧值「取消」，避免与按钮混淆） */
            j('span', { children: t(value === 'cancel' ? 'batch.cascade' : `batch.${value}`) }),
          ],
        })) }),
        strategy === 'rewire' ? js('span', { className: 'mt-batchbar-group', children: [
          j('select', {
            className: 'mt-select',
            value: rewireTo,
            'aria-label': t('batch.rewireTo'),
            title: t('batch.rewireHint'),
            disabled: busy,
            onChange: (e) => { setRewireTo(e.target.value); setPending(null) },
            children: [
              j('option', { value: '', children: t('batch.rewireNone') }),
              ...rewireOptions.map((option) => j('option', {
                key: option.id,
                value: option.id,
                children: `${option.id} · ${option.title}${option.done ? ` ${t('batch.rewireDone')}` : ''}`,
              })),
            ],
          }),
        ] }) : null,
        j('button', { className: 'mt-btn mt-btn-sm', disabled, onClick: () => exec('rescope'), children: t('batch.rescope') }),
        js('select', {
          className: 'mt-select',
          value: priority,
          'aria-label': t('batch.priority'),
          title: t('batch.priority'),
          onChange: (e) => setPriority(e.target.value),
          children: ['P0', 'P1', 'P2', 'P3'].map((value) => j('option', { key: value, value, children: value })),
        }),
        j('button', { className: 'mt-btn mt-btn-sm', disabled, onClick: () => exec('priority'), children: t('batch.priority') }),
        j('button', { className: 'mt-chipbtn' + (showMembers ? ' mt-chipbtn-active' : ''), 'aria-expanded': showMembers, onClick: () => setShowMembers(!showMembers), children: t('batch.assign') }),
        showMembers ? js('div', { className: 'mt-batchbar-group', children: [
          memberOptions.length === 0
            ? j('span', { className: 'mt-hint', children: t('batch.needMembers') })
            : js('div', { className: 'mt-checklist', children: memberOptions.map((opt) => js('label', { key: opt.id, className: 'mt-check', children: [
              j('input', { type: 'checkbox', checked: memberIds.has(opt.id), onChange: () => setMemberIds((prev) => toggle(prev, opt.id)) }),
              j('span', { children: opt.label }),
            ] })) }),
          j('button', { className: 'mt-btn mt-btn-sm', disabled, onClick: () => exec('assign'), children: t('batch.run') }),
        ] }) : null,
        pending ? js('div', { className: 'mt-batchbar-impact', children: [
          j('span', { children: t(strategy === 'cancel' ? 'batch.impactCascade' : strategy === 'rewire' ? 'batch.impactRewire' : 'batch.impact').replace('{tasks}', String(impact.tasks)).replace('{dependents}', String(impact.dependents.length)) }),
          strategy === 'rewire' ? j('span', { className: 'mt-hint', children: `${t('batch.rewireTo')}：${rewireTo || t('batch.rewireNone')}` }) : null,
          strategy === 'rewire' && impact.rewireByTask.length > 0 ? js('div', { className: 'mt-impactlist', children: [
            j('span', { className: 'mt-hint', children: t('batch.rewireByTask') }),
            ...impact.rewireByTask.map((item) => j('span', {
              key: String(item.taskId),
              children: `${item.taskId} → ${(item.directDependents ?? []).join('、') || t('batch.rewireNoDeps')}`,
            })),
          ] }) : null,
          impact.dependents.length > 0 ? j('span', { children: t('batch.impactDeps').replace('{deps}', impact.dependents.join('、')) }) : null,
          j('span', { children: t('batch.confirmHint') }),
          js('span', { className: 'mt-batchbar-group', children: [
            j('button', { className: 'mt-btn mt-btn-sm mt-btn-danger', disabled: busy, onClick: confirmCancel, children: busy ? t('state.loading') : t('batch.confirm') }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setPending(null), children: t('action.cancel') }),
          ] }),
        ] }) : null,
        err ? j('span', { className: 'mt-batchbar-impact', role: 'alert', children: err }) : null,
        js('div', { className: 'mt-batchbar-group', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onClear, children: t('multi.clear') }),
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onExit, children: t('multi.off') }),
        ] }),
      ] })
    }

    /**
     * 主工作台（CHG-201：**两个作用域物理分离**，由挂载点决定，界面内不可切换）。
     *
     *  - `mode="global"`（`main` 槽 = 左侧侧边栏页）：**只有全局信息**——内置 + 全局角色、
     *    预设、技能 & MCP、插件贡献。没有团队列表 / 项目清单 / 任务看板（全局不记录项目）。
     *  - `mode="project"`（`conversation.view` 槽 = 画布「团队视图」tab）：**一个具体项目**的
     *    视图——本项目团队列表 + 团队内看板/参与任务/知识/审计/设置，工作区由会话解析。
     *
     * 为什么不让界面内切作用域（旧 `全局 | 项目` seg 已删除）：两个作用域的数据面不同
     * （全局根 vs 项目根），放在同一个可切换的壳里必然互相串数据（「所有项目看起来都一样」）。
     */