    function RoleDetailDrawer({ t, data, onClose, teamName, onEdit, onDelete, deleteHint, onCopyToProject, onGuest, skillTotal, onPublish, copyHint }) {
      const [usage, setUsage] = react.useState(null)
      const [delBusy, setDelBusy] = react.useState(false)
      const [delErr, setDelErr] = react.useState(null)
      /* CHG-89（FR-13.1「发布到全局库」）：两段确认——全局库对该工作区所有项目可见，是显式动作 */
      const [pubBusy, setPubBusy] = react.useState(false)
      const [pubErr, setPubErr] = react.useState(null)
      const [pubImpact, setPubImpact] = react.useState(null)
      if (!data) return js('div', { className: 'mt-drawer', children: [j('div', { className: 'mt-drawer-head', children: j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }) }), j('div', { className: 'mt-empty', children: t('state.loading') })] })
      const def = data.definition ?? {}
      const readOnlyRole = data.origin !== 'project'
      const chips = (items, empty) => (items ?? []).length > 0
        ? js('div', { className: 'mt-rolechips', children: items.map((item) => j('span', { key: item, className: 'mt-rolechip', children: item })) })
        : j('div', { className: 'mt-hint', children: empty })
      const promptTokens = Math.max(1, Math.round(String(def.systemPrompt ?? '').length / 4))
      const promptTokenText = promptTokens >= 1000 ? `${(promptTokens / 1000).toFixed(1)}k` : String(promptTokens)
      const toolAllow = def.toolPolicy?.allow ?? []
      const toolDeny = def.toolPolicy?.deny ?? []
      const boundaryText = toolAllow.length === 0 && toolDeny.length === 0
        ? t('role.boundaryDefault')
        : [
          toolAllow.length > 0 ? t('role.boundaryAllow').replace('{tools}', toolAllow.join(' / ')) : null,
          toolDeny.length > 0 ? t('role.boundaryDeny').replace('{tools}', toolDeny.join(' / ')) : null,
        ].filter(Boolean).join('；')
      /** 第一段：不带 confirm 调用，拿 usage（在册团队/实例数/占用模板） */
      const askDelete = async () => {
        if (!onDelete || delBusy) return
        setDelErr(null)
        setDelBusy(true)
        try {
          const r = await onDelete(false)
          if (r?.status === 'confirm-required') { setUsage(r.usage ?? {}); return }
          if (r?.status === 'deleted') return
          setDelErr(t('role.deleteFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setDelErr(t('role.deleteFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setDelBusy(false)
        }
      }
      /** 第二段：带 confirm:true 提交 */
      const doDelete = async () => {
        if (!onDelete || delBusy) return
        setDelErr(null)
        setDelBusy(true)
        try {
          const r = await onDelete(true)
          if (r?.status === 'deleted') return
          setDelErr(t('role.deleteFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setDelErr(t('role.deleteFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setDelBusy(false)
        }
      }
      /** 第一段：不带 confirm 调用，拿发布影响面（目标全局库路径 + 可见范围） */
      const askPublish = async () => {
        if (!onPublish || pubBusy) return
        setPubErr(null)
        setPubBusy(true)
        try {
          const r = await onPublish(false)
          if (r?.status === 'confirm-required') { setPubImpact(r.impact ?? {}); return }
          if (r?.status === 'published') return
          setPubErr(t('role.publishFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setPubErr(t('role.publishFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setPubBusy(false)
        }
      }
      /** 第二段：带 confirm:true 落盘到全局库 */
      const doPublish = async () => {
        if (!onPublish || pubBusy) return
        setPubErr(null)
        setPubBusy(true)
        try {
          const r = await onPublish(true)
          if (r?.status === 'published') { setPubImpact(null); return }
          setPubErr(t('role.publishFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setPubErr(t('role.publishFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setPubBusy(false)
        }
      }
      const membershipRows = (data.memberships ?? []).length === 0
        ? j('div', { className: 'mt-hint', children: t('role.membershipsEmpty') })
        : js('div', { children: (data.memberships ?? []).map((membership, index) => js('div', { className: 'mt-membership', key: `${membership.teamId}-${membership.instanceName}-${index}`, children: [
          j('span', { className: 'mt-tchip ' + (membership.online ? 'mt-tchip-lead' : 'mt-tchip-coop'), children: teamName?.(membership.teamId) || membership.teamName || membership.teamId }),
          j('strong', { children: membership.instanceName }),
          j('span', { className: 'mt-hint', children: memberStateLabel(membership.status) }),
        ] })) })
      const spacedHead = (titleKey, note) => js('div', { className: 'mt-dsec-head', children: [
        j('h4', { children: t(titleKey) }),
        j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
        note ? j('span', { className: 'mt-dsec-n', children: note }) : null,
      ] })
      return js('div', { className: 'mt-drawer mt-drawer-wide mt-roledetail', children: [
        js('div', { className: 'mt-drawer-head', children: [
          j('span', { className: `mt-avatar ${avatarClassOf(def.id ?? data.roleId)}`, 'aria-hidden': true, children: avatarCharOf(def.name, def.id ?? data.roleId) }),
          j('strong', { children: def.name ?? data.roleId }),
          j('span', { className: 'mt-rolecard-id', children: def.id }),
          j('span', { className: 'mt-chip mt-chip-origin', children: data.origin === 'plugin' ? `🔒 ${t('role.origin.plugin')}` : t(`role.origin.${data.origin}`) }),
          readOnlyRole ? j('span', { className: 'mt-chip mt-chip-idle', children: t('role.readonlyBadge') }) : null,
          j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') }),
        ] }),
        js('div', { className: 'mt-roledetail-grid', children: [
          js('div', { className: 'mt-roledetail-main', children: [
            /* ① 定义与设定 */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.section.definition', t('role.section.definitionNote')),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.responsibility') }),
                j('span', { children: def.description ?? '—' }),
              ] }),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.boundary') }),
                j('span', { children: boundaryText }),
              ] }),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.interest') }),
                js('span', { className: 'mt-rolechips', children: [
                  ...((def.interestWords ?? []).length > 0
                    ? (def.interestWords ?? []).map((word) => j('span', { key: word, className: 'mt-rolechip', children: word }))
                    : [j('span', { className: 'mt-hint', children: t('roles.interestEmpty') })]),
                  j('span', { className: 'mt-hint', children: t('role.interestHint') }),
                ] }),
              ] }),
              js('div', { className: 'mt-prompt-head', children: [
                j('span', { children: t('role.prompt') }),
                j('span', { className: 'mt-rolechip mt-rolechip-mono', children: t('role.promptTokens').replace('{n}', promptTokenText) }),
                onEdit ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onEdit(data), children: t('role.expandEdit') }) : null,
              ] }),
              j('pre', { className: 'mt-prompt-block', children: def.systemPrompt ?? '' }),
              js('div', { className: 'mt-kvline', children: [
                j('span', { className: 'mt-minichip', children: t('role.route') }),
                js('span', { className: 'mt-rolechips', children: def.model
                  ? [
                    j('span', { className: 'mt-rolechip mt-rolechip-mono', children: t('role.routePrimary').replace('{model}', `${def.model.provider}/${def.model.model}`) }),
                    j('span', { className: 'mt-rolechip', children: t('role.routeInherit') }),
                  ]
                  : [j('span', { className: 'mt-rolechip', children: t('role.routeInherit') })] }),
              ] }),
            ] }),
            /* ② 技能（引用而非内联；启用开关是展示态——改技能走角色编辑器） */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.skills', t('role.skillsNote').replace('{n}', String((def.skills ?? []).length)).replace('{total}', String(skillTotal ?? (def.skills ?? []).length))),
              js('div', { className: 'mt-abl-list', children: [
                ...(def.skills ?? []).map((skill) => js('div', { className: 'mt-abl-row', key: skill, children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '❖' }),
                  js('div', { className: 'mt-abl-main', children: [
                    js('div', { className: 'mt-abl-name', children: [skill, j('span', { className: 'mt-rolecard-id', children: skill })] }),
                    j('div', { className: 'mt-abl-sub', children: t('role.mcpRef') }),
                  ] }),
                  j('span', { className: 'mt-tgl', role: 'switch', 'aria-checked': true, 'aria-label': skill, title: t('role.skillEnabled') }),
                ] })),
                js('div', { className: 'mt-abl-row', children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '＋' }),
                  js('div', { className: 'mt-abl-main', children: [
                    j('div', { className: 'mt-abl-name', children: t('role.skillAdd') }),
                    j('div', { className: 'mt-abl-sub', children: t('role.skillAddHint').replace('{n}', String((def.skills ?? []).length)) }),
                  ] }),
                  j('button', { className: 'mt-btn mt-btn-sm', title: t('role.browseSkills'), onClick: () => onEdit?.(data), children: t('role.browse') }),
                ] }),
              ] }),
            ] }),
            /* ③ MCP 与工具（连接层插件只读：这里只标「已引用」） */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.mcp', t('role.mcpNote')),
              js('div', { className: 'mt-abl-list', children: [
                ...(def.mcpAllowlist ?? []).map((name) => js('div', { className: 'mt-abl-row', key: name, children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '⌘' }),
                  js('div', { className: 'mt-abl-main', children: [
                    js('div', { className: 'mt-abl-name', children: [name, j('span', { className: 'mt-rolecard-id', children: t('role.mcp') })] }),
                    j('div', { className: 'mt-abl-sub', children: t('role.mcpRef') }),
                  ] }),
                  j('span', { className: 'mt-chip mt-chip-run', children: [j('span', { className: 'mt-shape mt-shape-run', 'aria-hidden': true }), t('role.mcpRef')] }),
                ] })),
                js('div', { className: 'mt-abl-row', children: [
                  j('span', { className: 'mt-abl-ico', 'aria-hidden': true, children: '⌗' }),
                  js('div', { className: 'mt-abl-main', children: [
                    j('div', { className: 'mt-abl-name', children: t('role.builtinTools') }),
                    js('div', { className: 'mt-abl-sub', children: [
                      ...(toolAllow.length > 0
                        ? toolAllow.map((tool) => j('span', { key: tool, className: 'mt-rolechip', children: tool }))
                        : [j('span', { className: 'mt-hint', children: '—' })]),
                      toolDeny.length > 0 ? j('span', { className: 'mt-rolechip', children: t('role.toolDeny').replace('{tools}', toolDeny.join(' / ')) }) : null,
                    ] }),
                  ] }),
                ] }),
              ] }),
            ] }),
          ] }),
          js('aside', { className: 'mt-roledetail-side', children: [
            /* 在册情况（跨团队聘任与实例） */
            js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('role.memberships') }),
                j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
              ] }),
              j('div', { className: 'mt-kvline', children: j('strong', { children: t('role.membershipCount').replace('{teams}', String(data.usage?.teams ?? 0)).replace('{instances}', String(data.usage?.instances ?? 0)) }) }),
              membershipRows,
            ] }),
            /* 快照规则 */
            js('section', { className: 'mt-sec mt-sec-info', children: [
              spacedHead('role.snapshotTitle', null),
              j('div', { className: 'mt-kvline', children: j('span', { children: t('role.snapshotBody') }) }),
            ] }),
            /* 操作 */
            js('section', { className: 'mt-sec', children: [
              spacedHead('role.actions', null),
              js('div', { className: 'mt-side-actions', children: [
                readOnlyRole
                  /* CHG-202x（P0-3）：「复制到项目」需要一个**项目库**——全局页（侧边栏）没有项目根，
                   * 这里置灰并说明去哪儿做，而不是点了一下什么都不发生（也不能写进进程 cwd）。 */
                  ? j('button', {
                    className: 'mt-btn mt-btn-primary',
                    disabled: Boolean(copyHint),
                    title: copyHint || undefined,
                    onClick: () => { if (copyHint) return; if (onCopyToProject) onCopyToProject(def); else onEdit?.(data) },
                    children: t('roles.copyToProjectFresh'),
                  })
                  : (onEdit ? j('button', { className: 'mt-btn mt-btn-primary', onClick: () => onEdit(data), children: t('role.edit') }) : null),
                /* CHG-89（FR-13.1）：项目库角色可「发布到全局库」——内置/全局来源没有发布意义，故不渲染 */
                onPublish ? j('button', { className: 'mt-btn', disabled: pubBusy, title: t('role.publishHint'), onClick: askPublish, children: pubBusy ? t('state.loading') : t('role.publishBtn') }) : null,
                onGuest ? j('button', { className: 'mt-btn', onClick: () => onGuest(def), children: t('role.tryInCaptain') }) : null,
                onDelete
                  ? j('button', { className: 'mt-btn mt-btn-danger', disabled: delBusy, title: t('role.delete'), onClick: askDelete, children: delBusy ? t('state.loading') : t('role.delete') })
                  : j('button', { className: 'mt-btn', disabled: true, title: deleteHint ?? t('role.deleteReadonly'), children: t('role.deleteReadonly') }),
              ] }),
              usage ? js('div', { className: 'mt-usagebox', role: 'alert', children: [
                j('strong', { children: t('role.deleteConfirm') }),
                j('span', { children: t('role.deleteUsage').replace('{teams}', String(usage.teams ?? 0)).replace('{instances}', String(usage.instances ?? 0)).replace('{presets}', String((usage.presets ?? []).length)) }),
                (usage.presets ?? []).length > 0 ? j('span', { children: t('role.deletePresets').replace('{presets}', (usage.presets ?? []).join('、')) }) : null,
                js('div', { className: 'mt-form-actions', children: [
                  j('button', { className: 'mt-btn', onClick: () => setUsage(null), children: t('action.cancel') }),
                  j('button', { className: 'mt-btn mt-btn-danger', disabled: delBusy, onClick: doDelete, children: delBusy ? t('state.loading') : t('role.deleteConfirmBtn') }),
                ] }),
              ] }) : null,
              /* CHG-89：发布影响面确认框（全局库对所有项目可见 → 必须显式确认） */
              pubImpact ? js('div', { className: 'mt-usagebox', role: 'alert', children: [
                j('strong', { children: t('role.publishConfirm') }),
                j('span', { children: t('role.publishImpact').replace('{path}', String(pubImpact.filePath ?? '—')) }),
                t('role.publishImpactNote') ? j('span', { children: t('role.publishImpactNote') }) : null,
                js('div', { className: 'mt-form-actions', children: [
                  j('button', { className: 'mt-btn', onClick: () => setPubImpact(null), children: t('action.cancel') }),
                  j('button', { className: 'mt-btn mt-btn-primary', disabled: pubBusy, onClick: doPublish, children: pubBusy ? t('state.loading') : t('role.publishConfirmBtn') }),
                ] }),
              ] }) : null,
              delErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: delErr }) : null,
              pubErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: pubErr }) : null,
            ] }),
            /* CHG-74：同名副本说明——让用户知道「为什么详情是这份」而不是另一份 */
            (data.shadowed ?? []).length > 0
              ? js('div', { className: 'mt-hint', children: t('role.detailShadowed')
                .replace('{list}', (data.shadowed ?? []).map((origin) => t(`role.origin.${origin}`)).join('、'))
                .replace('{origin}', t(`role.origin.${data.origin}`)) })
              : null,
          ] }),
        ] }),
      ] })
    }

    /** 团队卡（design/shell.html 的 .team-card：名称 + 状态 chip + 在线/离线 + 描述 + 完成度行） */