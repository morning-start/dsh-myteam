    /* ── 预设库（design-v2/g-blueprints.html）—— 全局作用域子页：
          三层来源分区 + 每张卡的「名册预览（队长高亮 + 角色引用 chips）+ 模板三行 + 引用计数」
          + 内置层兜底模板 + 删除守门提示。数据只从 getOfflinePresets / getProject().teams 派生。── */
    function PresetsPage({ t, presets, teams, onBack, onUse, onNotice, onSkills }) {
      const [q, setQ] = react.useState('')
      const [origin, setOrigin] = react.useState('all')
      if (presets === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (presets === null) return j('div', { className: 'mt-empty', children: t('roles.unavailable') })
      const entries = presets.entries.map((entry) => entry)
      const originOf = (entry) => String(entry.origin ?? 'project')
      const byOrigin = (o) => entries.filter((entry) => originOf(entry) === o)
      const projectEntries = byOrigin('project')
      const builtinEntries = byOrigin('builtin')
      const globalEntries = byOrigin('global')
      const kw = q.trim().toLowerCase()
      const hit = (entry) => {
        const def = entry.definition ?? {}
        return !kw || [def.name, def.id, def.description, entry.file].some((x) => String(x ?? '').toLowerCase().includes(kw))
      }
      /* 引用计数：名册里的角色是否都在某团队在册（派生自 getProject().teams，不造第二事实源） */
      const usageOf = (entry) => {
        const roster = entry.definition?.members ?? []
        if (roster.length === 0) return 0
        return (teams ?? []).filter((team) => roster.every((m) => (team.members ?? []).some((x) => x.roleId === m.roleId))).length
      }
      const gateLabels = (def) => [...new Set(Object.values(def.taskTypes ?? {}).flatMap((x) => x?.gateChain ?? []))].map((g) => gateLabel(String(g)))
      const swimlaneText = (def) => {
        const by = def.pipeline?.swimlaneBy
        const layout = def.pipeline?.layout
        const byText = by === 'member' ? t('preset3.byMember') : by === 'stage' ? t('preset3.byStage') : by === 'priority' ? t('preset3.byPriority') : (by ?? '—')
        const layoutText = layout === 'serpentine' ? t('preset3.serpentine') : layout === 'linear' ? t('preset3.linear') : (layout ?? '')
        return layoutText ? `${byText} · ${layoutText}` : byText
      }
      const tmplRows = (def) => js('div', { className: 'mt-tmpl', children: [
        js('div', { className: 'mt-tmpl-row', children: [
          j('span', { className: 'mt-tmpl-k', children: t('presets.columns') }),
          js('span', { className: 'mt-tmpl-v mt-colpreview', children: (def.board?.columns ?? []).flatMap((col, i) => (i === 0
            ? [j('b', { key: `c-${col}`, children: stateLabel(col) })]
            : [j('span', { key: `a-${col}`, className: 'mt-ar', 'aria-hidden': true, children: '→' }), j('b', { key: `c-${col}`, children: stateLabel(col) })])) }),
        ] }),
        js('div', { className: 'mt-tmpl-row', children: [
          j('span', { className: 'mt-tmpl-k', children: t('preset3.flow') }),
          j('span', { className: 'mt-tmpl-v', children: swimlaneText(def) }),
        ] }),
        js('div', { className: 'mt-tmpl-row', children: [
          j('span', { className: 'mt-tmpl-k', children: t('preset3.gates') }),
          js('span', { className: 'mt-tmpl-v', children: def.gates?.enabled
            ? [
              ...gateLabels(def).map((g) => j('span', { key: g, className: 'mt-mini-chip', children: g })),
              j('span', { className: 'mt-kb3-meta', children: t('preset3.gateTimeout').replace('{ms}', String(Math.round(Number(def.gates?.commandTimeoutMs ?? 0) / 1000))) }),
            ]
            : [j('span', { className: 'mt-kb3-meta', children: t('preset3.gatesOff') })] }),
        ] }),
      ] })
      const card = (entry) => {
        const def = entry.definition ?? {}
        const title = def.name ?? def.id ?? entry.file
        const isBuiltin = originOf(entry) === 'builtin'
        const roster = def.members ?? []
        const used = usageOf(entry)
        return js('article', { key: `${originOf(entry)}:${def.id ?? entry.file}`, className: `mt-p3-card${isBuiltin ? ' mt-p3-card-builtin' : ''}`, children: [
          js('div', { className: 'mt-p3-top', children: [
            j('span', { className: 'mt-avatar mt-avatar-lead', 'aria-hidden': true, children: '队' }),
            js('div', { className: 'mt-p3-topbody', children: [
              js('div', { className: 'mt-p3-title', children: [
                j('strong', { children: title }),
                j('span', { className: 'mt-rolecard-id', children: def.id ?? entry.file }),
                j('span', { className: `mt-src mt-src-${isBuiltin ? 'builtin' : 'project'}`, title: t('presets.origin.' + entry.origin), children: t(`preset3.layer.${isBuiltin ? 'builtin' : 'project'}`) }),
              ] }),
              j('div', { className: 'mt-p3-sub', children: isBuiltin ? t('preset3.builtinNote') : (used > 0 ? t('preset3.usedBy').replace('{n}', String(used)) : t('preset3.unused')) }),
            ] }),
          ] }),
          js('div', { children: [
            j('div', { className: 'mt-tmpl-k', children: t('preset3.roster').replace('{n}', String(roster.length + 1)) }),
            js('div', { className: 'mt-p3-roster', children: [
              js('span', { className: 'mt-mini-chip mt-p3-lead-chip', children: [j('span', { className: 'mt-avatar mt-avatar-lead', 'aria-hidden': true, children: '队' }), t('preset3.captain')] }),
              ...roster.map((m, i) => js('span', { key: `${m.roleId}-${i}`, className: 'mt-mini-chip', title: m.roleId, children: [
                j('span', { className: 'mt-avatar', 'aria-hidden': true, children: String(m.instanceName ?? m.roleId).trim().slice(0, 1) || '员' }),
                m.instanceName ?? m.roleId,
              ] })),
            ] }),
          ] }),
          isBuiltin ? j('p', { className: 'mt-p3-desc', children: t('preset3.builtinDesc') }) : tmplRows(def),
          isBuiltin
            ? js('div', { className: 'mt-p3-foot', children: [
              j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: t('preset3.copy') }),
              j('button', { className: 'mt-btn mt-btn-ghost mt-btn-sm', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: t('preset3.restore') }),
              j('span', { className: 'mt-kb3-meta', style: { marginLeft: 'auto' }, children: t('preset3.readonly') }),
            ] })
            : js('div', { className: 'mt-p3-foot', children: [
              j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onUse?.(def), children: t('preset3.use') }),
              j('button', { className: 'mt-btn mt-btn-ghost mt-btn-sm', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: t('preset3.edit') }),
              j('button', { className: 'mt-iconbtn', style: { marginLeft: 'auto' }, 'aria-label': t('preset3.more'), title: t('preset3.more'), onClick: () => onNotice?.(t('preset3.readonlyHint')), children: '⋯' }),
            ] }),
        ] })
      }
      const originBtn = (key, label) => j('button', { key, 'aria-pressed': origin === key, onClick: () => setOrigin(key), children: label })
      const layerRow = (key, title, icoKind, kind, srcText, path, n, unit, action, actionLabel) => js('div', { key, className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-ico-${kind}`, 'aria-hidden': true, children: j(G3LayerIcon, { kind: icoKind }) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [j('b', { children: title }), j('span', { className: `mt-src mt-src-${kind}`, children: srcText })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), j('span', { children: unit })] }),
        action ? j('button', { className: 'mt-btn mt-btn-sm', onClick: action, children: actionLabel }) : null,
      ] })
      /* design-v2/g-blueprints.html：项目分区末尾跟着一张虚线「新建预设」卡（和卡片同栅格），不是页头按钮的重复 */
      const newCard = js('button', {
        className: 'mt-p3-newcard',
        onClick: () => onNotice?.(t('preset3.readonlyHint')),
        children: [
          j('span', { className: 'mt-p3-newcard-icon', 'aria-hidden': true, children: '＋' }),
          j('strong', { children: t('preset3.new') }),
          j('span', { children: t('preset3.newCardHint') }),
        ],
      })
      const section = (key, title, note, list, extra) => [
        js('div', { key: `head-${key}`, className: 'mt-section-head', children: [
          j('h3', { children: title }),
          j('span', { className: 'mt-rule', 'aria-hidden': true }),
          j('span', { className: 'mt-hint', children: note }),
        ] }),
        list.length === 0 ? j('div', { key: `empty-${key}`, className: 'mt-hint', children: t('preset3.empty') }) : null,
        list.length > 0 || extra
          ? js('div', { key: `grid-${key}`, className: 'mt-presetgrid', children: [...list.map(card), ...(extra ? [extra] : [])] })
          : null,
      ]
      return js('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }, children: [
        js('div', { className: 'mt-teambar', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onBack, children: `← ${t('preset3.back')}` }),
          js('span', { className: 'mt-teambar-title', children: [j('b', { children: t('preset3.title') }), j('span', { className: 'mt-teambar-id', children: t('preset3.teambarSub') })] }),
          j('span', { className: 'mt-teambar-goal', children: t('preset3.teambarGoal') }),
          js('span', { className: 'mt-teambar-actions', children: [
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('preset3.layers'), children: [
              j('button', { 'aria-pressed': false, onClick: onBack, children: t('preset3.tabRoles') }),
              j('button', { 'aria-pressed': true, children: t('preset3.tabPresets') }),
              j('button', { 'aria-pressed': false, onClick: onSkills, children: t('preset3.tabSkills') }),
            ] }),
          ] }),
        ] }),
        js('div', { className: 'mt-kb3', children: [
          js('div', { className: 'mt-kb3-head', children: [
            js('div', { children: [j('h2', { children: t('preset3.title') }), j('p', { children: t('preset3.desc') })] }),
            js('div', { className: 'mt-kb3-head-actions', children: [
              /* design-v2/g-blueprints.html：页头主按钮是描边（不是实底主色），只有空态兜底卡用虚线 */
              j('button', { className: 'mt-btn', onClick: () => onNotice?.(t('preset3.readonlyHint')), children: `＋ ${t('preset3.new')}` }),
            ] }),
          ] }),
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('preset3.layers') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('span', { className: 'mt-hint', children: t('preset3.layersNote') }),
          ] }),
          js('div', { className: 'mt-layers', children: [
            layerRow('builtin', t('preset3.layer.builtin'), 'builtin', 'builtin', t('preset3.layer.builtinSrc'), t('preset3.layer.builtinPath'), builtinEntries.length, t('preset3.unit'), () => setOrigin('builtin'), t('preset3.restore')),
            layerRow('global', t('preset3.layer.global'), 'global', 'global', t('preset3.layer.globalSrc'), `${t('preset3.layer.globalPath')} · ${t('preset3.globalOff')}`, globalEntries.length, t('preset3.unit'), () => setOrigin('global'), t('preset3.seeAll')),
            layerRow('project', t('preset3.layer.project'), 'project', 'project', t('preset3.layer.projectSrc'), t('preset3.layer.projectPath'), projectEntries.length, t('preset3.unit'), () => setOrigin('project'), t('preset3.seeAll')),
          ] }),
          js('div', { className: 'mt-kb3-note mt-kb3-note-info', role: 'note', children: [
            j('span', { children: [j('b', { children: t('preset3.overwriteNote') }), t('preset3.overwriteBody')] }),
          ] }),
          js('div', { className: 'mt-kb3-filter', children: [
            js('label', { className: 'mt-kb3-search', children: [
              j('input', { type: 'search', className: 'mt-kb-search', placeholder: t('preset3.search'), 'aria-label': t('preset3.search'), value: q, onChange: (e) => setQ(e.target.value) }),
            ] }),
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('preset3.layers'), children: [
              originBtn('all', t('preset3.filterAll').replace('{n}', String(entries.length))),
              originBtn('project', t('preset3.filterProject').replace('{n}', String(projectEntries.length))),
              originBtn('global', t('preset3.filterGlobal').replace('{n}', String(globalEntries.length))),
              originBtn('builtin', t('preset3.filterBuiltin').replace('{n}', String(builtinEntries.length))),
            ] }),
            j('span', { className: 'mt-kb3-meta', children: t('preset3.sorted') }),
          ] }),
          ...section('project', t('preset3.sectionProject').replace('{n}', String(projectEntries.length)), t('preset3.sectionProjectNote'), (origin === 'all' || origin === 'project' ? projectEntries.filter(hit) : []), newCard),
          ...section('global', t('preset3.sectionGlobal').replace('{n}', String(globalEntries.length)), t('preset3.sectionGlobalNote'), (origin === 'all' || origin === 'global' ? globalEntries.filter(hit) : [])),
          ...section('builtin', t('preset3.sectionBuiltin').replace('{n}', String(builtinEntries.length)), t('preset3.sectionBuiltinNote'), (origin === 'all' || origin === 'builtin' ? builtinEntries.filter(hit) : [])),
          js('div', { className: 'mt-kb3-note', role: 'note', children: [j('span', { children: t('preset3.guard') })] }),
        ] }),
      ] })
    }
