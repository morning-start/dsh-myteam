    function RoleCard({ t, role, onOpen, onGuest, onCopyToProject, onCompare, projectCopyExists }) {
      const words = role.interestWords ?? []
      const instances = (role.memberships ?? []).map((membership) => membership.instanceName)
      const fork = role.shadowedBy
        ? t('role.shadowedBy').replace('{origin}', t(`role.origin.${role.shadowedBy}`))
        : role.origin === 'project' && roleLabel(role.id) !== role.id
          ? t('roles.copiedFromBuiltin').replace('{name}', roleLabel(role.id))
          : null
      const copyAction = role.origin === 'project'
        ? null
        : projectCopyExists
          ? j('button', { className: 'mt-btn mt-btn-ghost mt-btn-sm', onClick: (event) => { event.stopPropagation(); onCompare?.(role) }, children: t('roles.compare') })
          : j('button', { className: 'mt-btn mt-btn-sm', onClick: (event) => { event.stopPropagation(); onCopyToProject?.(role) }, children: role.origin === 'global' ? t('roles.copyToProject') : t('roles.copyToProjectFresh') })
      return js('div', {
        className: 'mt-rolecard mt-rolecard-lib' + (role.isCaptain ? ' mt-rolecard-captain' : ''),
        role: 'button',
        tabIndex: 0,
        title: role.description,
        onClick: () => onOpen(role.id),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(role.id) },
        children: [
          js('div', { className: 'mt-rolecard-top', children: [
            j('span', { className: `mt-avatar ${role.isCaptain ? 'mt-avatar-lead' : avatarClassOf(role.id)}`, 'aria-hidden': true, children: avatarCharOf(role.name, role.id) }),
            js('div', { className: 'mt-rolecard-body', children: [
              js('div', { className: 'mt-rolecard-title', children: [
                j('strong', { children: role.name }),
                j('span', { className: 'mt-rolecard-id', children: role.id }),
                j('span', { className: 'mt-chip mt-chip-origin', title: role.pluginId ? t('contrib.providedBy').replace('{plugin}', role.pluginId) : undefined, children: role.origin === 'builtin' || role.origin === 'plugin' ? `🔒 ${t(`role.origin.${role.origin}`)}` : t(`role.origin.${role.origin}`) }),
              ] }),
              j('div', { className: 'mt-rolecard-sub', children: role.description }),
              js('div', { className: 'mt-rolecard-row', children: [
                j('span', { className: 'mt-rolecard-rowlabel', children: t('roles.interest') }),
                ...(words.length > 0
                  ? words.map((word) => j('span', { key: word, className: 'mt-rolechip', children: word }))
                  : [j('span', { className: 'mt-hint', children: t('roles.interestEmpty') })]),
              ] }),
            ] }),
          ] }),
          js('div', { className: 'mt-rolecard-row', children: [
            j('span', { className: 'mt-rolechip mt-rolechip-mono', children: role.model ? `${role.model.provider}/${role.model.model}` : t('roles.inheritRoute') }),
            j('span', { className: 'mt-rolechip', children: t('roles.skillCount').replace('{n}', String((role.skills ?? []).length)) }),
            j('span', { className: 'mt-rolechip', children: t('roles.mcpCount').replace('{n}', String((role.mcpAllowlist ?? []).length)) }),
          ] }),
          fork ? js('div', { className: 'mt-rolecard-row mt-rolecard-fork', children: [
            j('span', { className: 'mt-rolecard-fork-ico', 'aria-hidden': true, children: '⑂' }),
            j('span', { children: fork }),
          ] }) : null,
          js('div', { className: 'mt-rolecard-foot', children: [
            /* design/roles.html：队长卡脚只写「不可召唤 · 即当前会话」（不列 0 实例） */
            role.isCaptain && instances.length === 0
              ? null
              : role.origin === 'project'
                ? (instances.length > 0
                  ? js('span', { className: 'mt-rolecard-instances', children: instances.slice(0, 4).map((name) => j('span', { key: name, className: 'mt-rolechip mt-rolechip-mono', children: name })) })
                  : j('span', { className: 'mt-hint', children: t('roles.zeroInstances') }))
                : j('span', { className: 'mt-hint', children: role.origin === 'global' ? t('roles.zeroInstances') : projectCopyExists ? t('roles.hasCopy') : t('roles.noCopy') }),
            role.isCaptain
              ? j('span', { className: 'mt-rolecard-lock', children: t('roles.captainLock') })
              : j('button', { className: 'mt-link', onClick: (event) => { event.stopPropagation(); onGuest?.(role) }, children: t('roles.guest') }),
            copyAction,
            role.origin === 'project' && instances.length > 0
              ? j('span', { className: 'mt-hint', children: t('roles.instanceCount').replace('{n}', String(instances.length)) })
              : null,
          ] }),
        ],
      })
    }

    /** 项目自身角色卡（design/roles.html 的 .team-card：名称 + ID chip + 在线点 + 描述 + meta） */
    function ProjectRoleCard({ t, role, onOpen }) {
      return js('div', { className: 'mt-team-card mt-projectrole-card', children: [
        js('div', { className: 'mt-team-head', children: [
          j('strong', { children: role.name }),
          j('span', { className: 'mt-chip mt-chip-idle', children: [j('span', { className: 'mt-shape mt-shape-idle', 'aria-hidden': true }), role.id] }),
          j('span', { className: 'mt-team-zone', children: [j('span', { className: 'mt-team-dot', 'aria-hidden': true }), t('roles.projectRoleOnline')] }),
        ] }),
        j('p', { className: 'mt-team-desc', children: role.description }),
        js('p', { className: 'mt-team-meta', children: [
          j('span', { children: role.model ? `${role.model.provider}/${role.model.model}` : t('roles.inheritRoute') }),
          j('span', { children: t('roles.skillCount').replace('{n}', String((role.skills ?? []).length)) }),
          j('span', { children: t('roles.mcpCount').replace('{n}', String((role.mcpAllowlist ?? []).length)) }),
          j('button', { className: 'mt-link', onClick: () => onOpen(role.id), children: t('roles.detail') }),
        ] }),
      ] })
    }

    /** 创建角色虚线卡（design/roles.html 最后一格） */
    function RoleCardCreate({ t, onCreate }) {
      return js('button', { className: 'mt-rolecard mt-rolecard-lib mt-rolecard-create', onClick: () => onCreate?.(), children: [
        j('span', { className: 'mt-rolecard-create-ico', 'aria-hidden': true, children: '＋' }),
        j('span', { className: 'mt-rolecard-create-title', children: t('roles.createRole') }),
        j('span', { className: 'mt-rolecard-create-hint', children: t('roles.createRoleHint') }),
      ] })
    }

    /**
     * 单角色调用（CHG-172 / A11 / FR-16.1）：`/myteam+` 的可视化多选入口，挂角色库顶部。
     *
     * PRD v2.3（CHG-13）拍板：UI 多选面板不作指派入口、**保留于角色 tab 管理场景**——这里就是那个保留点。
     * 诚实边界（不复活 CHG-110 删掉的演示版，零硬编码角色名）：
     *  - 只写 `.dsh-myteam/config/session-defaults.json`（下一轮会话生效），不进团队账本、不产生实例会话；
     *  - 写路径需要任一**在线团队会话**作载体（facade 按会话路由）——没有时明说 + 指向 /myteam+ 命令，不假装成功；
     *  - 角色来自已加载的真实角色库（含来源标注）。
     */
    function GuestApplySection({ t, roles, carrier, busy, note, onApply }) {
      const [picked, setPicked] = react.useState([])
      const toggle = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
      const list = Array.isArray(roles) ? roles : []
      return js('section', { className: 'mt-ssection mt-guest-apply', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('guest.section') }),
          j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          j('span', { className: 'mt-dsec-n', children: t('guest.sub') }),
        ] }),
        list.length > 0
          ? j('div', { className: 'mt-guest-chips', role: 'group', 'aria-label': t('guest.pick'), children: list.map((role) => j('button', {
            key: role.id,
            type: 'button',
            className: 'mt-guest-chip',
            'aria-pressed': picked.includes(role.id),
            onClick: () => toggle(role.id),
            children: [
              j('span', { className: 'mt-guest-chip-id', children: String(role.id) }),
              role.origin ? j('span', { className: `mt-src mt-src-${role.origin}`, children: t(`roles.origin.${role.origin}`) }) : null,
            ],
          })) })
          : j('p', { className: 'mt-hint', children: t('guest.empty') }),
        js('div', { className: 'mt-form-actions', children: [
          j('button', {
            className: 'mt-btn',
            disabled: busy || picked.length === 0,
            onClick: () => onApply?.(picked),
            children: busy ? t('guest.applying') : t('guest.apply').replace('{n}', String(picked.length)),
          }),
          carrier
            ? j('span', { className: 'mt-hint', children: t('guest.carrier').replace('{team}', String(carrier.teamId ?? carrier.name ?? '')) })
            : j('span', { className: 'mt-hint', children: t('guest.noCarrier') }),
        ] }),
        note ? j('div', { className: note.kind === 'ok' ? 'mt-hint' : 'mt-hint mt-guest-warn', role: note.kind === 'ok' ? 'status' : 'alert', children: note.text }) : null,
        j('p', { className: 'mt-hint', children: t('guest.honesty') }),
      ] })
    }

    /** CHG-82 G2：角色库（design/roles.html）——三层来源分区 + 搜索/来源筛选 + 引用计数 + 复制/对比 + 创建卡 */
    function RoleLibrary({ t, pv, onOpen, onGuest, onCopyToProject, onCompare, onCreate, onIntroGlobal, filter, onFilter }) {
      const [query, setQuery] = react.useState('')
      /* CHG-202x（P0-3）：来源筛选可**受控**——「引入全局角色」按钮把它切到 global（列表里就能复制/对比），
       * 而不是调空实现的 setScope。 */
      const [localFilter, setLocalFilter] = react.useState('all')
      const originFilter = filter ?? localFilter
      const setOriginFilter = onFilter ?? setLocalFilter
      const roles = pv?.roles ?? []
      const needle = String(query ?? '').trim().toLowerCase()
      const hit = (role) => !needle || [role.name, role.id, role.description].some((text) => String(text ?? '').toLowerCase().includes(needle))
      const projectIds = new Set(roles.filter((role) => role.origin === 'project').map((role) => role.id))
      const countOf = (origin) => roles.filter((role) => role.origin === origin).length
      const sections = [
        { origin: 'project', note: t('roles.projectSectionNote') },
        { origin: 'global', note: t('roles.globalSectionNote') },
        { origin: 'builtin', note: t('roles.builtinSectionNote') },
      ]
      return js('div', { className: 'mt-page', children: [
        js('div', { className: 'mt-page-head', children: [
          js('div', { children: [j('h2', { children: t('roles.page.title') }), j('p', { children: t('roles.page.desc') })] }),
          js('div', { className: 'mt-page-head-actions', children: [
            j('button', { className: 'mt-btn mt-btn-primary', onClick: () => onIntroGlobal?.(), children: `↗ ${t('roles.introGlobal')}` }),
            j('button', { className: 'mt-btn', onClick: () => onCreate?.(), children: `＋ ${t('roles.chatCreate')}` }),
          ] }),
        ] }),
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('roles.projectRole') }),
          j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          j('span', { className: 'mt-dsec-n', children: t('roles.projectRoleNote') }),
        ] }),
        pv?.projectRole
          ? j(ProjectRoleCard, { t, role: pv.projectRole, onOpen })
          : j('div', { className: 'mt-hint', children: t('roles.noProjectRole') }),
        js('div', { className: 'mt-filterbar', children: [
          js('label', { className: 'mt-searchfield', children: [
            j('span', { className: 'mt-searchfield-ico', 'aria-hidden': true, children: '⌕' }),
            j('input', {
              type: 'search',
              value: query,
              placeholder: t('roles.searchPlaceholder'),
              'aria-label': t('roles.searchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
            }),
          ] }),
          js('div', { className: 'mt-seg-group', role: 'group', 'aria-label': t('roles.page.title'), children: [
            ['all', t('roles.filter.all'), roles.length],
            ['project', t('roles.filter.project'), countOf('project')],
            ['global', t('roles.filter.global'), countOf('global')],
            ['builtin', t('roles.filter.builtin'), countOf('builtin')],
          ].map(([value, label, count]) => j('button', {
            key: value,
            className: 'mt-segbtn',
            'aria-pressed': originFilter === value,
            onClick: () => setOriginFilter(value),
            children: `${label} ${count}`,
          })) }),
          j('span', { className: 'mt-hint', children: t('roles.filterHint') }),
        ] }),
        ...sections.filter((section) => originFilter === 'all' || originFilter === section.origin).map((section) => {
          const list = roles.filter((role) => role.origin === section.origin && hit(role))
          return js('div', { className: 'mt-dsec-block', key: section.origin, children: [
            js('div', { className: 'mt-dsec-head', children: [
              j('h4', { children: `${t(`role.origin.${section.origin}`)} · ${countOf(section.origin)}` }),
              j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
              j('span', { className: 'mt-dsec-n', children: section.note }),
            ] }),
            list.length === 0 && section.origin !== 'project'
              ? j('div', { className: 'mt-hint', children: needle ? t('roles.noMatch') : t('roles.empty') })
              : js('div', { className: 'mt-cardgrid mt-cardgrid-3', children: [
                ...list.map((role) => j(RoleCard, {
                  key: `${role.origin}:${role.id}`,
                  t,
                  role,
                  onOpen,
                  onGuest,
                  onCopyToProject,
                  onCompare,
                  projectCopyExists: projectIds.has(role.id),
                })),
                section.origin === 'project' ? j(RoleCardCreate, { key: 'create-role', t, onCreate }) : null,
              ] }),
          ] })
        }),
        js('p', { className: 'mt-note mt-note-alert', children: [
          j('span', { className: 'mt-note-ico', 'aria-hidden': true, children: '!' }),
          j('span', { children: t('roles.deleteGuard') }),
        ] }),
      ] })
    }

    /** CHG-82 G2：角色详情（design/role-detail.html）——
     *  左列：定义与设定（职责 / 边界 / 兴趣词 + 系统提示词块 + 模型路由）· 技能（启用开关）· MCP 与工具；
     *  侧列：在册情况（跨团队聘任与实例）· 快照规则 · 操作（复制到项目 / 在队长会话试召唤 / 删除）。
     *  CHG-73：删除角色两段确认（先展示 usage）。 */
    /**
     * CHG-91（插件团队贡献契约 v1 / docs/16 §12.3）：「插件贡献」区块。
     *
     * 为什么要有它（而不是让插件角色混在全局库里）：**用户必须能看出「这个角色是谁给的」**——
     *  - 插件来源只读（想改走「复制到项目」），混在可编辑列表里会让人以为编辑坏了；
     *  - 插件装载失败必须**大声**（P4）：有 error 时顶部红条 + 每条带修法；
     *  - 装/卸插件不必重启宿主：一个「重新扫描插件」按钮。
     */
    /**
     * CHG-93：插件贡献区块的**纯渲染函数**（无状态）。
     *
     * 为什么抽出来：面板只负责「取数 + 触发重扫」，而「空态 / 有插件 / 有 error 红条」
     * 三个分支是**数据决定的**——抽成纯函数才能逐分支断言（CDP 只能验一个真实状态，
     * 单测能验全部）。
     *
     * @param data `undefined` = 加载中（渲染外壳 + loading 占位，不闪烁）
     */
    function contributionsBody(t, data, { busy = false, onReload, err } = {}) {
      const loading = data === undefined
      const plugins = data?.plugins ?? []
      const roles = data?.roles ?? []
      const teams = data?.teams ?? []
      const warnings = data?.warnings ?? []
      const errors = warnings.filter((warning) => warning.level === 'error')
      const displayNameOf = (pluginId) => (plugins.find((plugin) => plugin.pluginId === pluginId)?.displayName ?? pluginId)
      return js('section', { className: 'mt-sec mt-contrib', id: 'mt-contributions-section', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('contrib.title') }),
          j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          j('button', { className: 'mt-btn mt-btn-sm', disabled: busy, onClick: onReload, children: busy ? t('contrib.reloading') : t('contrib.reload') }),
        ] }),
        j('p', { className: 'mt-hint', children: t('contrib.desc') }),
        errors.length > 0
          ? js('div', { className: 'mt-banner mt-error-banner', role: 'alert', children: [
            j('strong', { children: t('contrib.warnTitle').replace('{n}', String(errors.length)) }),
            j('div', { className: 'mt-hint', children: t('contrib.warnHint') }),
            js('ul', { className: 'mt-contrib-warns', children: warnings.map((warning, index) => j('li', {
              key: `w-${index}`,
              className: warning.level === 'error' ? 'mt-contrib-warn-err' : 'mt-contrib-warn-info',
              children: [j('code', { children: warning.code }), ` ${warning.message}`],
            })) }),
          ] })
          : null,
        loading
          ? j('div', { className: 'mt-hint', children: t('state.loading') })
          : plugins.length === 0
            ? j('div', { className: 'mt-empty', children: t('contrib.empty') })
            : js('div', { className: 'mt-contrib-body', children: plugins.map((plugin) => js('div', { key: plugin.pluginId, className: 'mt-contrib-plugin', children: [
              /* CHG-106：能力包头部——包名 + 版本 + 计数（一行读完「这是什么、带了多少能力」） */
              js('div', { className: 'mt-contrib-plugin-head', children: [
                j('span', { className: 'mt-contrib-pack-glyph', 'aria-hidden': true, title: plugin.pluginId, children: '▣' }),
                j('strong', { children: plugin.displayName }),
                j('span', { className: 'mt-rolechip mt-rolechip-mono', children: `v${plugin.version}` }),
                j('span', { className: 'mt-contrib-counts', children: `${t('contrib.capRoles')} ${plugin.roles.length} · ${t('contrib.capTeams')} ${plugin.teams.length}` }),
              ] }),
              /* CHG-106：能力用**内联胶囊**平铺——一个包一条能力行，横向排满就换行，
               * 不再「一个角色占一整行、名字和 id 之间拉一条空档」。 */
              js('div', { className: 'mt-contrib-caps', children: [
                roles.length > 0 ? js('div', { className: 'mt-contrib-cap-row', children: [
                  j('span', { className: 'mt-contrib-cap-label', children: t('contrib.roles') }),
                  js('div', { className: 'mt-contrib-chips', children: roles.map((role) => {
                    const provider = displayNameOf(String(role.origin ?? '').replace(/^plugin:/, ''))
                    return j('span', {
                      key: role.id,
                      className: 'mt-contrib-chip',
                      title: `${role.id} · ${role.name} · ${t('contrib.providedBy').replace('{plugin}', provider)}`,
                      children: [
                        j('span', { className: 'mt-contrib-chip-icon', 'aria-hidden': true, children: '🛡' }),
                        j('span', { className: 'mt-contrib-chip-name', children: role.name }),
                        j('code', { className: 'mt-contrib-chip-id', children: role.id }),
                      ],
                    })
                  }) }),
                ] }) : null,
                teams.length > 0 ? js('div', { className: 'mt-contrib-cap-row', children: [
                  j('span', { className: 'mt-contrib-cap-label', children: t('contrib.teams') }),
                  js('div', { className: 'mt-contrib-chips', children: teams.map((team) => {
                    const roster = (team.members ?? []).map((member) => member.roleId).join(' · ')
                    return j('span', {
                      key: team.id,
                      className: 'mt-contrib-chip',
                      title: `${team.id} · ${team.name} · ${roster}`,
                      children: [
                        j('span', { className: 'mt-contrib-chip-icon', 'aria-hidden': true, children: '👥' }),
                        j('span', { className: 'mt-contrib-chip-name', children: team.name }),
                        j('span', { className: 'mt-contrib-chip-id', children: t('contrib.members').replace('{n}', String((team.members ?? []).length)) }),
                      ],
                    })
                  }) }),
                ] }) : null,
              ] }),
              /* 只读 + 目录：压到卡片脚注一行，不占正文高度 */
              js('div', { className: 'mt-contrib-foot', children: [
                j('span', { className: 'mt-chip mt-chip-origin mt-contrib-lock', title: t('contrib.readonlyHint'), children: `🔒 ${t('contrib.readonly')}` }),
                j('span', { className: 'mt-contrib-root', title: String(data?.root ?? ''), children: t('contrib.root').replace('{root}', String(data?.rootDisplay ?? data?.root ?? '')) }),
              ] }),
            ] })) }),
        err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
      ] })
    }

    function ContributionsSection({ t, api, workspaceRoot, onChanged, onNotice }) {
      const [data, setData] = react.useState(undefined)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const load = react.useCallback(async () => {
        if (!api) return
        try {
          setData((await api.getContributions({ workspaceRoot })) ?? { status: 'ok', plugins: [], roles: [], teams: [], warnings: [] })
        } catch (e) {
          setErr(String(e?.message ?? e))
          setData({ status: 'ok', plugins: [], roles: [], teams: [], warnings: [] })
        }
      }, [api, workspaceRoot])
      react.useEffect(() => { load() }, [load])
      const reload = async () => {
        if (busy || !api) return
        setBusy(true)
        setErr(null)
        try {
          const r = await api.reloadContributions({ workspaceRoot })
          setData(r ?? { status: 'ok', plugins: [], roles: [], teams: [], warnings: [] })
          onNotice?.(t('contrib.reloaded')
            .replace('{plugins}', String((r?.plugins ?? []).length))
            .replace('{roles}', String((r?.roles ?? []).length))
            .replace('{teams}', String((r?.teams ?? []).length)))
          onChanged?.()
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      /* CHG-93：渲染体抽成纯函数（`contributionsBody`）——面板只负责取数，
       * 纯函数可对「空态 / 有插件 / 有 error」三个分支直接断言（CDP 只能验一个真实状态）。 */
      return contributionsBody(t, data, { busy, onReload: reload, err })
    }
