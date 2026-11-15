    /* ── 知识 tab（FR-17.5 / CHG-82 设计稿对齐，design/knowledge.html）：
          三层记忆（AGENTS.md 共识 / 项目共享库 / 实例私有）+ 证据数 + 「可能过期」标记
          + 待确认提案 + 搜索 + 提案入口 + 条目详情演化时间线（knowledge.revised 账本流）── */
    function KnowledgeTab({ t, data, members }) {
      const [q, setQ] = react.useState('')
      const [layer, setLayer] = react.useState('all')
      const [openId, setOpenId] = react.useState(null)
      const [showIndex, setShowIndex] = react.useState(false)
      /* CHG-84：无活跃会话（null）/ 读取中（undefined）也要给满屏骨架 —— design/knowledge.html 是满屏内容，
       * 不能整页只剩一句话：三层记忆、筛选条、空态与脚注照常渲染，只在提案位放一条说明 note。 */
      const loading = data === undefined
      const unavailable = data === null
      const proposals = data?.proposals ?? []
      const timeline = data?.timeline ?? {}
      const all = data?.entries ?? []
      /* 层次按数据派生（§八-6：前端不造第二事实源）：audience 非空 = 只对该角色可见 → 实例私有层。
       * 共识层是仓库根的 AGENTS.md（人写、只读），恒为 1 个文件，不来自条目列表。 */
      const isPrivate = (e) => (e.audience ?? []).length > 0
      const shared = all.filter((e) => !isPrivate(e))
      const priv = all.filter(isPrivate)
      const kw = q.trim().toLowerCase()
      const hit = (e) => !kw || [e.title, e.body, e.id, ...(e.tags ?? []), ...(e.evidence ?? [])]
        .some((x) => String(x ?? '').toLowerCase().includes(kw))
      const inLayer = (e) => layer === 'all' || (isPrivate(e) ? 'private' : 'shared') === layer
      const entries = all.filter((e) => inLayer(e) && hit(e))
      const showConsensus = (layer === 'all' || layer === 'consensus') && (!kw || t('kb3.consensusEntry').toLowerCase().includes(kw))
      const relBadge = (rel) => (rel === 'refine' ? t('kb.rel.refine') : rel === 'contradict' ? t('kb.rel.contradict') : t('kb.rel.new'))
      /* CHG-202x（P1-11）：提案裁决区渲染在本 tab **上方**（KnowledgeProposals 由面板直挂），
       * 所以这两个入口的正确动作是「滚到那块」而不是 `setLayer('all')`（后者什么都不发生）。 */
      const jumpToProposals = () => {
        if (typeof document === 'undefined') return
        const el = document.getElementById('mt-kb-proposals')
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      const memberNameOf = (id) => (members ?? []).find((m) => m.id === id || m.roleId === id)?.instanceName ?? id
      const proofChip = (n) => j('span', { className: 'mt-mini-chip', children: (n ?? 0) > 0 ? t('kb3.proofChip').replace('{n}', String(n)) : t('kb3.proofNone') })
      const srcBadge = (kind) => j('span', { className: `mt-src mt-src-${kind}`, children: t(`kb3.layerBadge.${kind}`) })
      const avatarOf = (title, lead) => j('span', { className: `mt-avatar${lead ? ' mt-avatar-lead' : ''}`, 'aria-hidden': true, children: String(title ?? '').trim().slice(0, 1) || '知' })
      const detailOf = (e) => js('div', { className: 'mt-kb-detail', children: [
        j('div', { className: 'mt-kb-body', children: String(e.body ?? '') }),
        /* CHG-87 §4.3：证据指针按 kind 上色（优先 evidenceRefs，回退旧 evidence 字符串数组） */
        evidenceChips(t, e),
        (timeline[e.id] ?? []).length ? js('div', { className: 'mt-kb-timeline', children: [
          j('h4', { children: t('kb.timeline') }),
          ...[...timeline[e.id]].reverse().map((r, i) => j('div', { key: i, className: 'mt-kb-tlitem', children: `${String(r.ts ?? '').slice(0, 10)} · ${relBadge(r.relation)} · ${r.diff}` })),
        ] }) : null,
      ] })
      const entryRow = (e) => {
        const kind = isPrivate(e) ? 'private' : 'shared'
        const open = openId === e.id
        const owner = (e.audience ?? []).map(memberNameOf).join('、') || (e.contributor ? memberNameOf(e.contributor) : '—')
        return js('article', { key: e.id, className: 'mt-kb3-row mt-kb-entry', children: [
          avatarOf(e.title, false),
          js('div', { className: 'mt-kb3-row-main', children: [
            js('div', { className: 'mt-kb3-row-title', children: [
              j('strong', { children: e.title }),
              srcBadge(kind),
              kind === 'private' ? null : proofChip(e.proofCount),
              e.core ? j('span', { className: 'mt-kb-badge mt-kb-core', children: t('kb.core') }) : null,
              e.unverified ? j('span', { className: 'mt-kb-badge mt-kb-unverified', children: t('kb.unverified') }) : null,
              e.staleSince ? js('span', { className: 'mt-chip mt-chip-stale', children: [stateShape('gate'), t('kb3.stale')] }) : null,
            ] }),
            j('div', { className: 'mt-kb3-row-sub', children: kind === 'private'
              ? t('kb3.privateEntrySub').replace('{name}', owner)
              : String(e.body ?? '') }),
            open ? detailOf(e) : null,
          ] }),
          js('div', { className: 'mt-kb3-row-act', children: [
            kind === 'private'
              ? j('span', { className: 'mt-kb3-meta', children: t('kb3.privateOnly') })
              : j('span', { className: 'mt-kb3-meta', children: `${e.contributor ? memberNameOf(e.contributor) : '—'} · ${String(e.updated ?? '').slice(0, 10)}` }),
            j('button', { className: 'mt-iconbtn', 'aria-label': t('kb3.more'), title: t('kb3.more'), 'aria-expanded': open, onClick: () => setOpenId(open ? null : e.id), children: '⋯' }),
          ] }),
        ] })
      }
      const consensusRow = js('article', { className: 'mt-kb3-row', children: [
        avatarOf('共', true),
        js('div', { className: 'mt-kb3-row-main', children: [
          js('div', { className: 'mt-kb3-row-title', children: [j('strong', { children: t('kb3.consensusEntry') }), srcBadge('consensus')] }),
          j('div', { className: 'mt-kb3-row-sub', children: t('kb3.consensusEntrySub') }),
        ] }),
        js('div', { className: 'mt-kb3-row-act', children: [
          j('span', { className: 'mt-kb3-meta', children: t('preset3.readonly') }),
          j('button', { className: 'mt-iconbtn', 'aria-label': t('kb3.more'), title: t('kb3.more'), children: '⋯' }),
        ] }),
      ] })
      const layerRow = (key, title, icoKind, kind, srcText, path, n, unit) => js('div', { key, className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-ico-${kind}`, 'aria-hidden': true, children: j(G3LayerIcon, { kind: icoKind }) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [j('b', { children: title }), j('span', { className: `mt-src mt-src-${kind}`, children: srcText })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), j('span', { children: unit })] }),
      ] })
      const segBtn = (key, label) => j('button', { key, 'aria-pressed': layer === key, onClick: () => setLayer(key), children: label })
      return js('div', { className: 'mt-kb3', children: [
        js('div', { className: 'mt-kb3-head', children: [
          js('div', { children: [j('h2', { children: t('kb3.title') }), j('p', { children: t('kb3.desc') })] }),
          js('div', { className: 'mt-kb3-head-actions', children: [
            j('button', { className: 'mt-btn', 'aria-expanded': showIndex, onClick: () => setShowIndex(!showIndex), children: t('kb3.index') }),
            j('button', { className: 'mt-btn mt-btn-primary', disabled: true, title: t('kb3.newEntryHint'), children: t('kb3.newEntry') }),
          ] }),
        ] }),
        js('div', { className: 'mt-section-head', children: [
          j('h3', { children: t('kb3.layers') }),
          j('span', { className: 'mt-rule', 'aria-hidden': true }),
          j('span', { className: 'mt-hint', children: t('kb3.layersNote') }),
        ] }),
        js('div', { className: 'mt-layers', children: [
          layerRow('consensus', t('kb3.consensus'), 'builtin', 'builtin', t('kb3.consensusSrc'), t('kb3.consensusPath'), 1, t('kb3.consensusUnit')),
          layerRow('shared', t('kb3.shared'), 'project', 'project', t('kb3.sharedSrc'), t('kb3.sharedPath'), shared.length, t('kb3.sharedUnit')),
          layerRow('private', t('kb3.private'), 'role', 'global', t('kb3.privateSrc'), t('kb3.privatePath'), priv.length, t('kb3.privateUnit')),
        ] }),
        showIndex ? js('div', { className: 'mt-kb3-index', children: [
          j('div', { className: 'mt-kb3-meta', children: t('kb3.indexBudget') }),
          ...all.slice(0, 40).map((e) => j('div', { key: e.id, className: 'mt-kb3-index-row', children: `${e.core ? '[core] ' : e.unverified ? '[unverified] ' : e.staleSince ? '[stale] ' : ''}${e.title}` })),
          all.length === 0 ? j('div', { className: 'mt-kb3-meta', children: t('kb.empty') }) : null,
        ] }) : null,
        js('div', { className: 'mt-kb3-filter', children: [
          js('label', { className: 'mt-kb3-search', children: [
            j('input', { type: 'search', className: 'mt-kb-search', placeholder: t('kb.search'), 'aria-label': t('kb.search'), value: q, onChange: (e) => setQ(e.target.value) }),
          ] }),
          js('div', { className: 'mt-kb3-seg', role: 'group', 'aria-label': t('kb3.layers'), children: [
            segBtn('all', t('kb3.filterAll').replace('{n}', String(all.length))),
            segBtn('shared', t('kb3.filterShared').replace('{n}', String(shared.length))),
            segBtn('consensus', t('kb3.filterConsensus').replace('{n}', '1')),
            segBtn('private', t('kb3.filterPrivate').replace('{n}', String(priv.length))),
          ] }),
          j('button', { className: 'mt-btn mt-btn-sm', style: { marginLeft: 'auto' }, onClick: () => { setLayer('all'); jumpToProposals() }, children: t('kb3.pending').replace('{n}', String(proposals.length)) }),
        ] }),
        proposals.length > 0 ? js('div', { className: 'mt-kb3-note mt-kb3-note-warn', role: 'note', children: [
          j('span', { children: [j('b', { children: t('kb3.proposalTitle').replace('{n}', String(proposals.length)) }), t('kb3.proposalBody')] }),
          j('button', { className: 'mt-btn mt-btn-sm', onClick: () => { setLayer('all'); jumpToProposals() }, children: t('kb3.review') }),
        ] }) : null,
        /* CHG-86 / UI-5：提案裁决（采纳 / 驳回）由 KnowledgeProposals 单独渲染（写路径与只读数据面分离） */
        /* CHG-84：无活跃会话 / 读取中不做整页空态——骨架照出，用一条说明 note 讲清为什么还没有条目 */
        loading || unavailable
          ? js('div', { className: 'mt-kb3-note mt-kb3-note-info', role: 'note', children: [
            j('span', { children: loading ? t('kb3.loadingHint') : t('kb3.needsSession') }),
          ] })
          : null,
        entries.length === 0 && !showConsensus
          ? j('div', { className: 'mt-empty', children: t('kb3.empty') })
          : js('div', { className: 'mt-kb3-rows', children: [
            ...entries.filter((e) => !isPrivate(e)).map(entryRow),
            showConsensus ? consensusRow : null,
            ...entries.filter(isPrivate).map(entryRow),
          ] }),
        js('div', { className: 'mt-kb3-note', role: 'note', children: [
          j('span', { children: [j('b', { children: t('kb3.curation') }), t('kb3.curationNote')] }),
        ] }),
      ] })
    }
