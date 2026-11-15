    /* ── 成本 tab（FR-8.2/8.4，CHG-47）：四桶 + 命中率；在线读侧车，离线读 tokens.json ── */
    /* CHG-153（P2-5 / FR-8.4）：计量覆盖率徽标（三态三色 + 口径文案 title）+ 上下文占比 /
       命中率段条（复用 .mt-segbar 写法；颜色只走 --dsw-alias-* 语义 token，不硬编码色值） */
    function TokensTab({ t, tokens, members, emptyText }) {
      if (tokens === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (!tokens) return j('div', { className: 'mt-empty', children: emptyText ?? t('cost.empty') })
      const totals = tokens.totals ?? {}
      const ids = Object.keys(totals)
      const nameOf = (id) => (members ?? []).find((m) => m.id === id)?.instanceName ?? id
      const fmt = (n) => Number(n ?? 0).toLocaleString()
      const pct = (h) => (h === null || h === undefined ? '—' : `${(h * 100).toFixed(1)}%`)
      const sum = { calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const id of ids) for (const key of Object.keys(sum)) sum[key] += Number(totals[id]?.[key] ?? 0)
      const denom = sum.uncachedInput + sum.cacheRead + sum.cacheWrite
      const sumHit = denom === 0 ? null : sum.cacheRead / denom
      /* FR-8.4：上下文占比与命中率是同一分母（uncached + read + write）的两个派生，
         分母 0 一律「—」——不显示 0（0% 会被读成「全都是未命中」，是谎报） */
      const sumCtx = denom === 0 ? null : sum.uncachedInput / denom
      const rows = [...ids].sort((a, b) => Number(totals[b]?.calls ?? 0) - Number(totals[a]?.calls ?? 0))
      const cell = (value, key) => j('td', { key, children: value })
      /* P2-5 覆盖率徽标：三态三色 + 口径文案作 title。
         旧宿主不带 coverage → 显示「—」（「不知道」既不等于 full 也不等于 none，不许编 0）。 */
      const COVERAGES = ['full', 'partial', 'none']
      const coverage = COVERAGES.includes(tokens.coverage) ? tokens.coverage : null
      const coverageBadge = coverage
        ? j('span', {
            className: `mt-cov mt-cov-${coverage}`,
            title: `${t(`cost.coverage.hint.${coverage}`)}${tokens.coverageText ? ` · ${tokens.coverageText}` : ''}`,
            children: `${t('cost.coverage')} · ${t(`cost.coverage.${coverage}`)}`,
          })
        : j('span', { className: 'mt-cov mt-cov-unknown', title: t('cost.coverage.unknownHint'), children: `${t('cost.coverage')} · —` })
      /* 段条：复用 .mt-segbar（与看板 .mt-ovbar / 归档回放同一写法）；段宽 = 占比 ×1000 且至少 1，
         保证极小的非零段也可看见（否则「写缓存 0.1%」会整段消失，读者以为没写） */
      const seg = (key, cls, ratio) => j('i', { key, className: cls, style: { flex: Math.max(1, Math.round(ratio * 1000)) } })
      const shareBar = denom === 0
        ? [j('i', { key: 'empty', className: 'mt-seg-empty', style: { flex: 1 } })]
        : [
            seg('uncached', 'mt-seg-uncached', sum.uncachedInput / denom),
            seg('read', 'mt-seg-read', sum.cacheRead / denom),
            seg('write', 'mt-seg-write', sum.cacheWrite / denom),
          ]
      const hitBar = sumHit === null
        ? [j('i', { key: 'empty', className: 'mt-seg-empty', style: { flex: 1 } })]
        : [seg('hit', 'mt-seg-read', sumHit), seg('miss', 'mt-seg-uncached', 1 - sumHit)]
      const ring = (label, value, parts) => js('div', { className: 'mt-ctx', children: [
        js('div', { className: 'mt-ctx-head', children: [j('span', { children: label }), j('strong', { children: value })] }),
        js('div', { className: 'mt-segbar mt-ctxbar', role: 'img', 'aria-label': `${label} ${value}`, children: parts }),
      ] })
      return js('div', { className: 'mt-cost', children: [
        js('div', { className: 'mt-cost-head', children: [
          j('h3', { children: t('cost.total') }),
          coverageBadge,
          tokens.updatedAt ? j('span', { className: 'mt-hint', children: t('cost.updated').replace('{time}', relTime(tokens.updatedAt, t)) }) : null,
          j('span', { className: 'mt-hint', children: `${t('cost.calls')} ${fmt(sum.calls)} · ${t('cost.output')} ${fmt(sum.output)}` }),
        ] }),
        js('div', { className: 'mt-cost-rings', children: [
          ring(t('cost.contextShare'), pct(sumCtx), shareBar),
          ring(t('cost.hit'), pct(sumHit), hitBar),
        ] }),
        js('div', { className: 'mt-cost-scroll', children: [
          js('table', { className: 'mt-cost-table', children: [
            j('thead', { children: j('tr', { children: [t('cost.member'), t('cost.calls'), t('cost.uncached'), t('cost.cacheRead'), t('cost.cacheWrite'), t('cost.output'), t('cost.contextShare'), t('cost.hit')].map((h, i) => j('th', { key: `${i}`, children: h })) }) }),
            j('tbody', { children: [
              ...rows.map((id) => js('tr', { children: [
                cell(nameOf(id), 'name'),
                cell(fmt(totals[id]?.calls), 'calls'),
                cell(fmt(totals[id]?.uncachedInput), 'uncached'),
                cell(fmt(totals[id]?.cacheRead), 'cacheRead'),
                cell(fmt(totals[id]?.cacheWrite), 'cacheWrite'),
                cell(fmt(totals[id]?.output), 'output'),
                cell(pct(totals[id]?.contextShare), 'contextShare'),
                cell(pct(totals[id]?.hitRate), 'hit'),
              ] }, id)),
              js('tr', { className: 'mt-cost-sum', children: [
                cell(t('cost.total'), 'name'),
                cell(fmt(sum.calls), 'calls'),
                cell(fmt(sum.uncachedInput), 'uncached'),
                cell(fmt(sum.cacheRead), 'cacheRead'),
                cell(fmt(sum.cacheWrite), 'cacheWrite'),
                cell(fmt(sum.output), 'output'),
                cell(pct(sumCtx), 'contextShare'),
                cell(pct(sumHit), 'hit'),
              ] }, '__total'),
            ] }),
          ] }),
        ] }),
        j('p', { className: 'mt-hint mt-cost-note', children: t('cost.note') }),
      ] })
    }


    /** 三层来源的图标（design/icons.svg 的 i-lock / i-globe / i-folder / i-link；内联，不依赖外部 sprite） */
    function G3LayerIcon({ kind }) {
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }
      const paths = kind === 'builtin'
        ? [j('rect', { key: 'b', x: 3.6, y: 7, width: 8.8, height: 5.8, rx: 1.3, ...stroke }), j('path', { key: 's', d: 'M5.9 7V5.5a2.1 2.1 0 0 1 4.2 0V7', ...stroke })]
        : kind === 'global'
          ? [j('circle', { key: 'c', cx: 8, cy: 8, r: 5.5, ...stroke }), j('path', { key: 'm', d: 'M2.5 8h11M8 2.5c1.9 1.6 1.9 9.4 0 11M8 2.5c-1.9 1.6-1.9 9.4 0 11', ...stroke })]
          : kind === 'bound'
            ? [j('path', { key: 'l', d: 'M6.7 9.3 9.3 6.7M6.2 7.3 4.9 8.6a2 2 0 0 0 2.9 2.9l1.3-1.3M9.8 8.7l1.3-1.3a2 2 0 0 0-2.9-2.9L6.9 5.8', ...stroke })]
            : kind === 'role'
              ? [j('circle', { key: 'h', cx: 8, cy: 5.6, r: 2.1, ...stroke }), j('path', { key: 't', d: 'M3.6 13.2c0-2.2 2-3.6 4.4-3.6s4.4 1.4 4.4 3.6', ...stroke })]
              : [j('path', { key: 'f', d: 'M2.4 4.7h4l1.2 1.5h6v5.3a1.3 1.3 0 0 1-1.3 1.3H3.7a1.3 1.3 0 0 1-1.3-1.3z', ...stroke })]
      return j('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, children: paths })
    }

    /**
     * 证据指针 kind 判定（CHG-87 §4.1 / FR-16.4③）：
     * `task:<id>` / `file:<path>` / `session:<id>` / 其它 → `unknown`（兼容旧账本，不拒绝）。
     */
    const EVIDENCE_KINDS = new Set(['task', 'file', 'session'])
    const evKindOf = (raw) => {
      const text = String(raw ?? '')
      const head = text.slice(0, text.indexOf(':'))
      if (text.includes(':') && EVIDENCE_KINDS.has(head)) return head
      return 'unknown'
    }
    /** 证据指针列表：优先 `evidenceRefs:[{raw,kind,value}]`，回退旧的 `evidence: string[]` */
    const evidenceRefList = (entry) => (Array.isArray(entry?.evidenceRefs) && entry.evidenceRefs.length > 0
      ? entry.evidenceRefs.map((ref) => {
        const raw = String(ref?.raw ?? ref?.value ?? '')
        const kind = String(ref?.kind ?? evKindOf(raw))
        return { raw, kind: EVIDENCE_KINDS.has(kind) ? kind : 'unknown' }
      })
      : (Array.isArray(entry?.evidence) ? entry.evidence.map((raw) => ({ raw: String(raw), kind: evKindOf(raw) })) : []))
    /** 证据指针 chips（按 kind 上色；session 指针带 session.read 留痕说明） */
    const evidenceChips = (t, entry) => {
      const refs = evidenceRefList(entry)
      if (refs.length === 0) return null
      return js('div', { className: 'mt-kb-ev', children: [
        j('span', { className: 'mt-kb-meta', children: t('kb.evidence') }),
        ...refs.map((ref, index) => j('span', {
          key: `${ref.kind}-${index}-${ref.raw}`,
          className: `mt-ev-ref mt-ev-ref-${ref.kind}`,
          title: ref.kind === 'session' ? t('evref.sessionHint') : ref.raw,
          children: `${t(`evref.${ref.kind}`)} · ${ref.raw}`,
        })),
      ] })
    }

    /**
     * 知识提案裁决区（CHG-86 / UI-5，FR-17.4）。
     *
     * 修复前：知识 tab 只写「采纳/驳回由队长用 myteam_adopt_knowledge 执行」——按钮根本不存在，
     * 面板没有任何写路径，UI-5 验收门因此不过。现在「采纳 / 驳回」直通宿主
     * `adoptKnowledge({ teamId, draftId, decision, note? })`；端点缺失（旧宿主）/ 离线团队时
     * 给明确说明并**优雅降级**（catch 后提示，不崩、不静默）。
     *
     * 单独成组件而不是塞进 `KnowledgeTab`：知识 tab 是**只读**数据面（getKnowledge 投影），
     * 写路径独立成块，读面的 props 契约保持 `{ t, data, members }` 不变。
     */
    function KnowledgeProposals({ t, proposals, members, api, teamId, readOnly, onChanged, onNotice, onError }) {
      const [deciding, setDeciding] = react.useState(null)   // 正在提交的 draftId
      const [noteFor, setNoteFor] = react.useState(null)     // 打开备注输入的 draftId
      const [note, setNote] = react.useState('')
      const list = proposals ?? []
      if (list.length === 0) return null
      const memberNameOf = (id) => (members ?? []).find((m) => m.id === id || m.roleId === id)?.instanceName ?? id
      const relBadge = (rel) => (rel === 'refine' ? t('kb.rel.refine') : rel === 'contradict' ? t('kb.rel.contradict') : t('kb.rel.new'))
      /** 提案裁决（采纳 / 驳回）：直通宿主 adoptKnowledge；失败只提示不崩（UI-5 降级要求） */
      const decide = async (proposal, decision) => {
        if (readOnly) { onNotice?.(t('kb3.readonlyHint')); return }
        if (!api || typeof api.adoptKnowledge !== 'function') {
          onNotice?.(t('kb3.adoptUnavailable').replace('{message}', 'adoptKnowledge'))
          return
        }
        setDeciding(proposal.draftId)
        try {
          const trimmed = note.trim()
          const r = await api.adoptKnowledge({
            /* CHG-202x（P0-5）：提案列表是**全区聚合**的（host 遍历每个 teamId 的账本），
             * 每条带自己的 `teamId`。写端点必须用它——传「当前选中团队」会在多团队项目里
             * 把 A 团队的提案发到 B 团队（服务端按该 teamId 找不到提案 → MT_VALIDATION）。 */
            teamId: proposal.teamId ?? teamId,
            draftId: proposal.draftId,
            decision,
            ...(trimmed ? { note: trimmed } : {}),
          })
          if (r?.status === 'error') {
            onError?.(r.message ?? r.code ?? 'adoptKnowledge failed')
          } else {
            onNotice?.((decision === 'adopted' ? t('kb3.adoptDone') : t('kb3.rejectDone')).replace('{title}', String(proposal.title ?? proposal.draftId)))
            setNoteFor(null)
            setNote('')
            await onChanged?.()
          }
        } catch (e) {
          /* 端点不存在 / 网关不可达：降级成明确说明（禁止静默失败与崩溃） */
          onNotice?.(t('kb3.adoptUnavailable').replace('{message}', String(e?.message ?? e)))
        } finally {
          setDeciding(null)
        }
      }
      return js('div', { id: 'mt-kb-proposals', className: 'mt-kb3-proposals', children: list.map((proposal) => {
        const rel = proposal.relation === 'refine' ? 'refine' : proposal.relation === 'contradict' ? 'contradict' : 'new'
        const busy = deciding === proposal.draftId
        return js('div', { key: proposal.draftId, className: 'mt-kb-proposal', children: [
          js('div', { className: 'mt-kb-phead', children: [
            j('strong', { children: String(proposal.title ?? proposal.draftId) }),
            j('span', { className: `mt-kb-rel mt-kb-rel-${rel}`, children: relBadge(rel) }),
            j('span', {
              className: 'mt-kb-meta',
              children: t('kb3.by')
                .replace('{name}', memberNameOf(proposal.proposedBy))
                .replace('{time}', String(proposal.at ?? '').slice(0, 16).replace('T', ' ')),
            }),
          ] }),
          (proposal.tags ?? []).length > 0
            ? js('div', { className: 'mt-kb-tags', children: (proposal.tags ?? []).map((tag) => j('span', { key: tag, className: 'mt-mini-chip', children: `#${tag}` })) })
            : null,
          /* CHG-87 §4.3：提案的证据指针同样按 kind 上色 */
          evidenceChips(t, proposal),
          noteFor === proposal.draftId ? j('input', {
            className: 'mt-input',
            value: note,
            placeholder: t('kb3.notePlaceholder'),
            'aria-label': t('kb3.notePlaceholder'),
            onChange: (e) => setNote(e.target.value),
          }) : null,
          js('div', { className: 'mt-form-actions', children: [
            j('button', {
              className: 'mt-btn mt-btn-sm mt-btn-primary',
              disabled: busy || Boolean(readOnly),
              title: readOnly ? t('kb3.readonlyHint') : t('kb3.adopt'),
              onClick: () => decide(proposal, 'adopted'),
              children: t('kb3.adopt'),
            }),
            j('button', {
              className: 'mt-btn mt-btn-sm mt-btn-danger',
              disabled: busy || Boolean(readOnly),
              title: readOnly ? t('kb3.readonlyHint') : t('kb3.reject'),
              onClick: () => decide(proposal, 'rejected'),
              children: t('kb3.reject'),
            }),
            j('button', {
              className: 'mt-btn mt-btn-sm',
              'aria-expanded': noteFor === proposal.draftId,
              onClick: () => { setNoteFor(noteFor === proposal.draftId ? null : proposal.draftId); setNote('') },
              children: t('kb3.note'),
            }),
          ] }),
        ] })
      }) })
    }
