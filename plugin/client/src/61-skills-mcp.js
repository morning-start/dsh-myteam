    /* ── 技能 & MCP（design/skills.html）—— 全局作用域子页：
          技能四层来源（内置 / 全局 / 项目 / 角色绑定）+ 成员级隔离说明 + 技能条目（绑定次数 / 绑进角色）
          + 下半部 MCP 两段式左右对照（连接层 ∩ 可见层，中间链接图标表示交集）。── */
    function SkillsPage({ t, roles, catalog, onBack, onBind, onNotice, onPresets }) {
      const [q, setQ] = react.useState('')
      const [origin, setOrigin] = react.useState('all')
      if (catalog === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      const roleList = roles ?? []
      /* 目录不可用时降级为「已有角色出现过的名字」（与角色表单同口径，§八-6 不造第二事实源） */
      const fallback = (() => {
        const collect = (key) => [...new Set(roleList.flatMap((role) => role?.[key] ?? []))].sort()
        return {
          skills: collect('skills').map((name) => ({ name, source: 'role' })),
          mcp: collect('mcpAllowlist').map((name) => ({ name, source: 'role' })),
          warnings: [],
          fallback: true,
        }
      })()
      const cat = catalog ?? fallback
      const skillsOf = (origins) => [...new Set(roleList.filter((role) => origins.includes(String(role.origin))).flatMap((role) => role.skills ?? []))].sort()
      const builtinSkills = skillsOf(['builtin'])
      const globalSkills = skillsOf(['global'])
      const projectSkills = skillsOf(['project', 'project-role'])
      const bindCount = (name) => roleList.filter((role) => (role.skills ?? []).includes(name)).length
      const boundRoles = (name) => roleList.filter((role) => (role.skills ?? []).includes(name)).map((role) => role.name ?? role.id)
      const layerOfSkill = (name) => {
        if (projectSkills.includes(name)) return 'project'
        if (globalSkills.includes(name)) return 'global'
        if (builtinSkills.includes(name)) return 'builtin'
        return 'host'
      }
      const names = [...new Set([...(cat.skills ?? []).map((s) => s.name), ...builtinSkills, ...globalSkills, ...projectSkills])].sort()
      const kw = q.trim().toLowerCase()
      const shown = names.filter((name) => {
        const kind = layerOfSkill(name)
        if (origin !== 'all' && kind !== origin) return false
        return !kw || name.toLowerCase().includes(kw) || boundRoles(name).join(' ').toLowerCase().includes(kw)
      })
      const hostMcp = [...new Set((cat.mcp ?? []).filter((m) => m.source === 'host').map((m) => m.name))].sort()
      const declaredMcp = [...new Set(roleList.flatMap((role) => role.mcpAllowlist ?? []))].sort()
      const notConnected = declaredMcp.filter((name) => !hostMcp.includes(name))
      const mcpRoles = roleList.filter((role) => (role.mcpAllowlist ?? []).length > 0)
      /* CHG-88：内置技能层的说明不再写死"两个技能"——随实际内置技能集合派生。
       * 旧文案硬编码「含 create-role、create-team 两个随行技能」，但内置技能早已是
       * create-role / modify-role / choose-team-template / manage-team-template 四个，
       * 文案与实现分叉（面板说的不是真话）。改为按实际技能名列表渲染，永远不说谎。
       * 语言跟随 t()：用 locale 字典自身的措辞探测当前语言（连接符不同），不硬编码两份文案。 */
      const builtinSkillNames = (cat.skills ?? []).filter((s) => s.source === 'builtin').map((s) => s.name).sort()
      const builtinIsZh = String(t('skill3.layer.builtinPath')).includes('、')
      const builtinPathText = builtinSkillNames.length > 0
        ? `plugin/skills · ${builtinSkillNames.join(builtinIsZh ? '、' : ', ')}`
        : t('skill3.layer.builtinPath')
      const layerRow = (key, title, icoKind, kind, srcText, path, n, unit, action) => js('div', { key, className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-ico-${kind}`, 'aria-hidden': true, children: j(G3LayerIcon, { kind: icoKind }) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [j('b', { children: title }), j('span', { className: `mt-src mt-src-${kind}`, children: srcText })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), j('span', { children: unit })] }),
        action ? j('button', { className: 'mt-btn mt-btn-sm', onClick: action, children: t('preset3.seeAll') }) : null,
      ] })
      const originBtn = (key, label) => j('button', { key, 'aria-pressed': origin === key, onClick: () => setOrigin(key), children: label })
      const mcpChip = (name) => (hostMcp.includes(name)
        ? j('span', { key: name, className: 'mt-mini-chip', children: name })
        : js('span', { key: name, className: 'mt-mini-chip mt-mini-chip-off', children: [`${name} ${t('skill3.disconnected')}`] }))
      return js('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }, children: [
        js('div', { className: 'mt-teambar', children: [
          j('button', { className: 'mt-btn mt-btn-sm', onClick: onBack, children: `← ${t('skill3.back')}` }),
          js('span', { className: 'mt-teambar-title', children: [j('b', { children: t('skill3.title') }), j('span', { className: 'mt-teambar-id', children: t('skill3.teambarSub') })] }),
          j('span', { className: 'mt-teambar-goal', children: t('skill3.teambarGoal') }),
          js('span', { className: 'mt-teambar-actions', children: [
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('skill3.layers'), children: [
              j('button', { 'aria-pressed': false, onClick: onBack, children: t('skill3.tabRoles') }),
              j('button', { 'aria-pressed': false, onClick: onPresets, children: t('skill3.tabPresets') }),
              j('button', { 'aria-pressed': true, children: t('skill3.tabSkills') }),
            ] }),
          ] }),
        ] }),
        js('div', { className: 'mt-kb3', children: [
          js('div', { className: 'mt-kb3-head', children: [
            js('div', { children: [j('h2', { children: t('skill3.title') }), j('p', { children: t('skill3.desc') })] }),
          ] }),
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('skill3.layers') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('span', { className: 'mt-hint', children: t('skill3.layersNote') }),
          ] }),
          js('div', { className: 'mt-layers', children: [
            layerRow('builtin', t('skill3.layer.builtin'), 'builtin', 'builtin', t('skill3.layer.builtinSrc'), builtinPathText, builtinSkills.length, t('skill3.unitSkill'), () => setOrigin('builtin')),
            layerRow('global', t('skill3.layer.global'), 'global', 'global', t('skill3.layer.globalSrc'), t('skill3.layer.globalPath'), globalSkills.length, t('skill3.unitSkill'), () => setOrigin('global')),
            layerRow('project', t('skill3.layer.project'), 'project', 'project', t('skill3.layer.projectSrc'), t('skill3.layer.projectPath'), projectSkills.length, t('skill3.unitSkill'), () => setOrigin('project')),
            layerRow('bound', t('skill3.layer.bound'), 'bound', 'bound', t('skill3.layer.boundSrc'), t('skill3.layer.boundPath'), roleList.reduce((sum, role) => sum + (role.skills ?? []).length, 0), t('skill3.unitBound'), () => setOrigin('all')),
          ] }),
          js('div', { className: 'mt-kb3-note mt-kb3-note-info', role: 'note', children: [
            j('span', { children: [j('b', { children: t('skill3.isolation') }), t('skill3.isolationBody')] }),
          ] }),
          js('div', { className: 'mt-kb3-filter', children: [
            js('label', { className: 'mt-kb3-search', children: [
              j('input', { type: 'search', className: 'mt-kb-search', placeholder: t('skill3.search'), 'aria-label': t('skill3.search'), value: q, onChange: (e) => setQ(e.target.value) }),
            ] }),
            js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('skill3.layers'), children: [
              originBtn('all', t('skill3.filterAll').replace('{n}', String(names.length))),
              originBtn('builtin', t('skill3.filterBuiltin').replace('{n}', String(builtinSkills.length))),
              originBtn('global', t('skill3.filterGlobal').replace('{n}', String(globalSkills.length))),
              originBtn('project', t('skill3.filterProject').replace('{n}', String(projectSkills.length))),
            ] }),
            j('span', { className: 'mt-kb3-meta', children: t('skill3.boundTimes').replace('{n}', String(roleList.reduce((sum, role) => sum + (role.skills ?? []).length, 0))) }),
          ] }),
          shown.length === 0
            ? j('div', { className: 'mt-empty', children: t('skill3.empty') })
            : js('div', { className: 'mt-kb3-rows', children: shown.map((name) => {
              const kind = layerOfSkill(name)
              const bound = bindCount(name)
              return js('article', { key: name, className: 'mt-kb3-row', children: [
                j('span', { className: 'mt-avatar', 'aria-hidden': true, children: name.trim().slice(0, 1) || '技' }),
                js('div', { className: 'mt-kb3-row-main', children: [
                  js('div', { className: 'mt-kb3-row-title', children: [
                    j('span', { className: 'mt-kb3-name', title: name, children: name }),
                    j('span', { className: `mt-src mt-src-${kind === 'host' ? 'builtin' : kind}`, children: kind === 'host' ? t('skill3.layer.builtin') : t(`skill3.layer.${kind}`) }),
                    bound > 0 ? j('span', { className: 'mt-mini-chip', children: t('skill3.bindCount').replace('{n}', String(bound)) }) : j('span', { className: 'mt-mini-chip mt-mini-chip-off', children: t('skill3.bindNone') }),
                  ] }),
                  j('div', { className: 'mt-kb3-row-sub', children: bound > 0 ? boundRoles(name).join(' · ') : t('skill3.bindNone') }),
                ] }),
                js('div', { className: 'mt-kb3-row-act', children: [
                  bound > 0
                    ? j('button', { className: 'mt-iconbtn', 'aria-label': t('skill3.more'), title: t('skill3.more'), onClick: () => onNotice?.(boundRoles(name).join(' · ')), children: '⋯' })
                    : j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onBind?.(name), children: t('skill3.bind') }),
                ] }),
              ] })
            }) }),
          js('div', { className: 'mt-section-head', children: [
            j('h3', { children: t('skill3.mcp') }),
            j('span', { className: 'mt-rule', 'aria-hidden': true }),
            j('span', { className: 'mt-hint', children: t('skill3.mcpNote') }),
          ] }),
          js('div', { className: 'mt-mcp-split', children: [
            js('div', { className: 'mt-mcp-pane', children: [
              js('div', { className: 'mt-mcp-head', children: [
                j('span', { className: 'mt-mcp-badge', children: t('skill3.conn') }),
                j('span', { className: 'mt-mcp-note', children: t('skill3.connNote') }),
              ] }),
              js('ul', { className: 'mt-mcp-list', children: [
                ...hostMcp.map((name) => js('li', { key: `on-${name}`, className: 'mt-mcp-item', children: [
                  j('span', { className: 'mt-chip mt-chip-online', children: '✓' }),
                  j('span', { className: 'mt-mcp-name', children: name }),
                  j('span', { className: 'mt-mini-chip', style: { marginLeft: 'auto' }, children: t('skill3.connected') }),
                ] })),
                ...notConnected.map((name) => js('li', { key: `off-${name}`, className: 'mt-mcp-item mt-mcp-item-off', children: [
                  j('span', { className: 'mt-chip mt-chip-offline', children: '×' }),
                  j('span', { className: 'mt-mcp-name', children: name }),
                  j('span', { className: 'mt-mini-chip mt-mini-chip-off', style: { marginLeft: 'auto' }, children: t('skill3.disconnected') }),
                ] })),
                hostMcp.length + notConnected.length === 0 ? j('li', { className: 'mt-mcp-item mt-mcp-item-off', children: t('skill3.catalogOff') }) : null,
              ] }),
            ] }),
            j('div', { className: 'mt-mcp-join', 'aria-hidden': true, children: t('skill3.join') }),
            js('div', { className: 'mt-mcp-pane', children: [
              js('div', { className: 'mt-mcp-head', children: [
                j('span', { className: 'mt-mcp-badge', children: t('skill3.vis') }),
                j('span', { className: 'mt-mcp-note', children: t('skill3.visNote') }),
              ] }),
              js('ul', { className: 'mt-mcp-list', children: [
                ...mcpRoles.map((role) => js('li', { key: role.id, className: 'mt-mcp-item', children: [
                  j('span', { className: 'mt-avatar', 'aria-hidden': true, children: String(role.name ?? role.id).trim().slice(0, 1) || '角' }),
                  j('span', { className: 'mt-mcp-name', children: role.id }),
                  js('span', { className: 'mt-mcp-tags', children: (role.mcpAllowlist ?? []).map((name) => mcpChip(name)) }),
                ] })),
                mcpRoles.length === 0 ? j('li', { className: 'mt-mcp-item mt-mcp-item-off', children: t('skill3.bindNone') }) : null,
              ] }),
            ] }),
          ] }),
          js('div', { className: 'mt-kb3-note', role: 'note', children: [j('span', { children: t('skill3.footnote') })] }),
        ] }),
      ] })
    }


    /** 看板列 → 扁平任务（三视图共用同一份数据，CHG-49） */
    const allTasksOf = (board) => (board?.board?.columns ?? []).flatMap((col) => col.tasks ?? [])

