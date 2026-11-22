    /* ── 任务详情（design-v2/p-task.html）：主区整页 = 面包屑 + 主列/侧列 + 成本归因 ── */
    // T25：离线团队走 loader（getOfflineTaskDetail），readOnly=true 时隐藏沟通输入
    // CHG-73：动作条（重新规划/取消/编辑）+ 证据过期横幅 + 改动记录折叠区 + 取消横幅
    function TaskDetail({ api, t, teamId, taskId, onClose, readOnly, loader, memberName, teamName, members, onEdit, onRescope, onCancel, onDelete, refreshToken, onDiagnosisFixed }) {
      const load = loader ?? ((q) => api.getTaskDetail(q))
      const [detail, setDetail] = react.useState(null)
      /* 门禁裁决成功后就地重载详情（不整页刷新、不关抽屉） */
      const [gateToken, setGateToken] = react.useState(0)
      const [comment, setComment] = react.useState('')
      const [sent, setSent] = react.useState(false)
      /* CHG-202x（P0-1）：删除任务的两段确认（第一次拿影响面，第二次落账） */
      const [delAsk, setDelAsk] = react.useState(null)
      const [delBusy, setDelBusy] = react.useState(false)
      const [delErr, setDelErr] = react.useState(null)
      /* FR-8.3：任务级成本归因（best-effort；离线团队 / 无 token 侧车时为 null） */
      const [cost, setCost] = react.useState(undefined)
      react.useEffect(() => {
        let alive = true
        load({ teamId, taskId }).then((r) => { if (alive) setDetail(r?.detail ?? null) }).catch(() => {})
        return () => { alive = false }
      }, [teamId, taskId, refreshToken, gateToken])
      react.useEffect(() => {
        let alive = true
        if (readOnly || !api || typeof api.getTokens !== 'function') { setCost(null); return () => { alive = false } }
        api.getTokens({ teamId })
          .then((r) => { if (alive) setCost(r?.status === 'ok' ? (r.tokens ?? null) : null) })
          .catch(() => { if (alive) setCost(null) })
        return () => { alive = false }
      }, [teamId, readOnly, refreshToken])
      /* CHG-185：sidecar 读取态 —— 只读（离线 / 归档团队）或没有端点 = 读不到（offline） */
      const costLoadState = readOnly || !api || typeof api.getTokens !== 'function' ? 'offline' : 'loaded'
      const closeBtn = j('button', { className: 'mt-btn', onClick: onClose, children: t('action.close') })
      if (!detail) {
        return js('div', { className: 'mt-detail-page', children: [
          js('nav', { className: 'mt-crumbbar', 'aria-label': t('detail.crumb'), children: [
            j('span', { className: 'mt-cur', children: taskId }),
            j('span', { className: 'mt-crumb-gap' }),
            closeBtn,
          ] }),
          j('div', { className: 'mt-empty', children: t('state.loading') }),
        ] })
      }
      const post = async () => {
        if (readOnly || !comment.trim()) return
        await api.postComment({ teamId, taskId, content: comment.trim() })
        setComment(''); setSent(true)
        const r = await api.getTaskDetail({ teamId, taskId })
        setDetail(r.detail ?? null)
      }
      // CHG-63：证据块结构化渲染（按 attempt 分组；命令 + 退出码 + 断言/耗时，na 给理由）
      const renderEvidence = (ev) => {
        const e = ev.evidence ?? {}
        if (e.kind === 'commands' && Array.isArray(e.commands)) {
          return js('ul', { className: 'mt-cmds', children: e.commands.map((c, i) => {
            const okExit = Number(c.exitCode) === 0
            const meta = [`${t('detail.exitCode')} ${c.exitCode}`]
            if (c.assertions !== undefined && c.assertions !== null) meta.push(`${t('detail.assertions')} ${c.assertions}`)
            if (c.durationMs) meta.push(humanMs(c.durationMs))
            return js('li', { key: i, children: [
              j('span', { className: 'mt-exit ' + (okExit ? 'mt-exit-ok' : 'mt-exit-fail'), children: String(c.exitCode) }),
              j('code', { className: 'mt-cmd', children: String(c.cmd ?? '') }),
              j('span', { className: 'mt-hint', children: fmtClock(ev.ts) }),
              j('span', { className: 'mt-ev-meta', children: meta.join(' · ') }),
            ] })
          }) })
        }
        if (e.kind === 'na') return j('div', { className: 'mt-hint', children: `N/A · ${e.na?.reason ?? '—'}` })
        return j('pre', { className: 'mt-ev-code', children: JSON.stringify(e, null, 1) })
      }
      const evidenceGroups = new Map()
      for (const ev of detail.evidenceRefs ?? []) {
        const key = ev.attemptId ?? '—'
        if (!evidenceGroups.has(key)) evidenceGroups.set(key, [])
        evidenceGroups.get(key).push(ev)
      }
      /** 第一段：不带 confirm 调用，拿影响面（标题 / 状态 / 直接下游 / 是否有活跃 attempt） */
      const askDelete = async () => {
        if (!onDelete || delBusy) return
        setDelErr(null)
        setDelBusy(true)
        try {
          const r = await onDelete(false)
          if (r?.status === 'confirm-required') { setDelAsk(r.impact ?? {}); return }
          if (r?.status === 'deleted') return
          setDelErr(t('detail.deleteFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setDelErr(t('detail.deleteFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setDelBusy(false)
        }
      }
      /** 第二段：带 confirm:true 落账 */
      const doDelete = async () => {
        if (!onDelete || delBusy) return
        setDelErr(null)
        setDelBusy(true)
        try {
          const r = await onDelete(true)
          if (r?.status === 'deleted') { setDelAsk(null); return }
          setDelErr(t('detail.deleteFailed').replace('{msg}', r?.message ?? r?.code ?? ''))
        } catch (e) {
          setDelErr(t('detail.deleteFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setDelBusy(false)
        }
      }
      const acts = detail.actions ?? {}
      const stale = detail.evidenceStale
      const cancellation = detail.cancellation
      /** 动作按钮的禁用说明（只读优先，其次「当前状态不可用」） */
      const actionTitle = (allowed, label) => (readOnly ? t('task.readonlyTitle') : allowed === false ? t('action.unavailable') : label)
      const input = detail.input ?? {}
      const acs = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []
      const deps = Array.isArray(input.deps) ? input.deps : []
      const gates = detail.gates ?? []
      const participants = detail.participants ?? []
      const timeline = detail.timeline ?? []
      const messages = detail.messages ?? []
      const deliverables = detail.deliverables ?? []
      const assignees = detail.assignees ?? (detail.assignee ? [detail.assignee] : [])
      const evidenceRefs = detail.evidenceRefs ?? []
      const attemptNo = Number(detail.escalateCount ?? 0) + 1
      const leadCount = participants.filter((party) => party.role === 'lead').length
      const coopCount = participants.length - leadCount
      /* 验收标准逐条 pass：证据载荷带 acs（1 基序号）时以它为准；任务已完成 = 全部通过 */
      const verifiedAcs = new Set()
      for (const item of evidenceRefs) {
        const raw = item?.evidence?.acs
        if (Array.isArray(raw)) for (const n of raw) verifiedAcs.add(Number(n))
      }
      const taskDone = String(detail.state ?? '') === 'done'
      const acPass = (index) => taskDone || verifiedAcs.has(index + 1)
      const acPassCount = acs.filter((ac, index) => acPass(index)).length
      const acEvidence = (index) => evidenceRefs.find((item) => Array.isArray(item?.evidence?.acs) && item.evidence.acs.map(Number).includes(index + 1))
      /* 成本归因（FR-8.3）：按 tokenMeter 用量比例分摊到本任务的负责队员，非精确计量 */
      const totals = cost?.totals ?? {}
      const sumBuckets = (ids) => {
        const sum = { calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        for (const id of ids) for (const key of Object.keys(sum)) sum[key] += Number(totals[id]?.[key] ?? 0)
        return sum
      }
      const taskSum = sumBuckets(assignees)
      const teamSum = sumBuckets(Object.keys(totals))
      const tokenCount = (bucket) => Number(bucket.uncachedInput ?? 0) + Number(bucket.cacheRead ?? 0) + Number(bucket.cacheWrite ?? 0) + Number(bucket.output ?? 0)
      const fmtTok = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value))
      /** 已跑时长（design「已跑 12m」的形态：秒 / 分 / 时+分） */
      const fmtElapsed = (ms) => {
        const total = Math.max(0, Number(ms) || 0)
        const minutes = Math.floor(total / 60000)
        if (minutes < 1) return `${Math.max(1, Math.round(total / 1000))}s`
        if (minutes < 60) return `${minutes}m`
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      }
      const hitRateOf = (bucket) => {
        const denom = Number(bucket.uncachedInput ?? 0) + Number(bucket.cacheRead ?? 0) + Number(bucket.cacheWrite ?? 0)
        return denom > 0 ? `${((Number(bucket.cacheRead ?? 0) / denom) * 100).toFixed(1)}%` : '—'
      }
      /* CHG-185：三档降级（离线 / 无用量 / 字段缺失）的判定收在纯函数里；渲染只认 tone */
      const degrade = costDegradeOf(costLoadState, cost, t)
      /* 只有 ok 才出真实数字；其余（含加载中）一律 —，绝不显示伪造的 0 */
      const costKnown = degrade.tone === 'ok'
      const teamTokens = tokenCount(teamSum)
      /* 时间线节点语义（H4：形状 + 文字；颜色只作第三顺位） */
      const tlTone = (type) => {
        const raw = String(type ?? '')
        if (raw.includes('completed') || raw.includes('approved') || raw.includes('adopted')) return 'mt-tl-ok'
        if (raw.includes('failed') || raw.includes('escalated') || raw.includes('cancelled') || raw.includes('blocked')) return 'mt-tl-warn'
        if (raw.includes('claimed') || raw.includes('progress') || raw.includes('gate') || raw.includes('evidence')) return 'mt-tl-run'
        return ''
      }
      return js('div', { className: 'mt-detail-page', children: [
        /* 面包屑（design .crumbbar）：看板 / 当前阶段 / 任务号 */
        js('nav', { className: 'mt-crumbbar', 'aria-label': t('detail.crumb'), children: [
          j('button', { className: 'mt-crumb-link', onClick: onClose, children: [j('span', { 'aria-hidden': true, children: '‹' }), j('span', { children: t('detail.crumbBoard') })] }),
          j('span', { className: 'mt-crumb-sep', 'aria-hidden': true, children: '/' }),
          j('span', { children: stateLabel(detail.state) }),
          j('span', { className: 'mt-crumb-sep', 'aria-hidden': true, children: '/' }),
          j('span', { className: 'mt-cur', children: detail.id }),
          j('span', { className: 'mt-crumb-gap' }),
          readOnly ? j('span', { className: 'mt-chip', children: t('global.offline') }) : null,
          closeBtn,
        ] }),
        js('div', { className: 'mt-detail-grid', children: [
          /* ── 主列 ── */
          js('div', { className: 'mt-detail-main', children: [
            /* 标题区：眉标（任务号 · 第 N 次尝试 · 由谁认领）+ 标题 + 标签 + 描述 */
            js('div', { className: 'mt-sec', children: [
              j('div', { children: [
                j('div', { className: 'mt-detail-eyebrow', children: `${detail.id} · ${t('detail.attemptN').replace('{n}', String(attemptNo))}${input.requiredRole ? ` · ${t('detail.claimedBy').replace('{role}', roleLabel(String(input.requiredRole)))}` : ''}` }),
                j('h1', { className: 'mt-detail-title', children: input.title ?? detail.id }),
                js('div', { className: 'mt-drawer-tags', children: [
                  js('span', { className: 'mt-chip', children: [j('span', { className: stateDotClass(detail.state), 'aria-hidden': true }), j('span', { children: stateLabel(detail.state) })] }),
                  input.priority ? j('span', { className: 'mt-detail-pill', children: String(input.priority) }) : null,
                  detail.createdAt ? j('span', { className: 'mt-mini-chip', children: t('detail.elapsed').replace('{time}', fmtElapsed(Date.now() - detail.createdAt)) }) : null,
                  input.estimate ? j('span', { className: 'mt-mini-chip', children: t('detail.estimate').replace('{value}', String(input.estimate)) }) : null,
                  costKnown ? j('span', { className: 'mt-mini-chip', children: t('detail.toolCalls').replace('{n}', String(taskSum.calls)) }) : null,
                ] }),
              ] }),
              input.description ? j('p', { className: 'mt-detail-desc', children: String(input.description) }) : null,
            ] }),
        stale ? js('div', { className: 'mt-banner mt-banner-stale', role: 'status', children: [
          j('span', {
            children: t('detail.evidenceStale')
              .replace('{fields}', fieldListText(t, stale.fields))
              .replace('{time}', fmtClock(stale.since)),
          }),
        ] }) : null,
        cancellation ? js('div', { className: 'mt-banner mt-banner-cancel', role: 'status', children: [
          j('span', {
            children: `${t('detail.cancelled').replace('{time}', fmtClock(cancellation.ts)).replace('{reason}', cancellation.reason || '—')} · ${cancellation.downstream === 'cancel' ? t('detail.cancelCascade') : cancellation.downstream === 'rewire' ? t('detail.cancelRewire') : t('detail.cancelLeave')}`,
          }),
        ] }) : null,
        /* CHG-75：依赖被改挂过（原上游已取消，依赖改到新上游或解除） */
        detail.rewiredFrom ? js('div', { className: 'mt-banner mt-banner-rewired', role: 'status', children: [
          j('span', {
            children: detail.rewiredFrom.added
              ? t('detail.rewiredTo').replace('{from}', String(detail.rewiredFrom.removed)).replace('{to}', String(detail.rewiredFrom.added))
              : t('detail.rewiredFree').replace('{from}', String(detail.rewiredFrom.removed)),
          }),
        ] }) : null,
            j(DiagChips, { t, diagnosis: detail.diagnosis }),
            /* CHG-76 C：诊断一键修复（assignable → 一键指派 / roleSwap → 改用已有人角色 / spawnRole → 纯提示） */
            j(DiagFix, { t, api, teamId, taskId, diagnosis: detail.diagnosis, readOnly, onFixed: onDiagnosisFixed, expectedRevision: detail.revision }),
            /* 门禁裁决（CHG-86 / M2-C）：任务处于 gate:* 时的唯一人工裁决入口 */
            j(GateReview, {
              t,
              api,
              teamId,
              taskId,
              detail,
              readOnly,
              memberName,
              members,
              onDone: () => setGateToken((value) => value + 1),
              onError: onDiagnosisFixed,
            }),
            /* 写入范围审计（CHG-87 §2.3 / FR-5.4）：紧跟在门禁区下方；无 scopeAudit 时整块不渲染 */
            j(ScopeAuditBlock, { t, audit: detail.scopeAudit }),
            /* 共享写范围（CHG-171 / R41 串行链收尾）：紧跟审计块；无 sharedScopes 时整块不渲染 */
            j(SharedScopesBlock, { t, shared: detail.sharedScopes }),
            /* 验收标准：逐条 pass 标记（证据带 acs 时以证据为准；任务已完成 = 全通过） */
            acs.length > 0 ? js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.ac') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.acVerified').replace('{pass}', String(acPassCount)).replace('{total}', String(acs.length)) }),
              ] }),
              j('ul', { className: 'mt-ac-list', children: acs.map((ac, index) => {
                const ok = acPass(index)
                const evidence = ok ? acEvidence(index) : undefined
                return js('li', { key: index, className: 'mt-ac ' + (ok ? 'mt-ac-pass' : 'mt-ac-pending'), children: [
                  j('span', { className: 'mt-ac-mark', 'aria-hidden': true, children: ok ? '✓' : String(index + 1) }),
                  js('span', { children: [
                    j('span', { children: ac }),
                    evidence ? j('span', { className: 'mt-ac-note', children: t('detail.acEvidence').replace('{time}', fmtClock(evidence.ts)).replace('{seq}', String(evidence.seq)) }) : null,
                  ] }),
                ] })
              }) }),
            ] }) : null,
            /* 验证证据：按 attempt 分组（命令 + 退出码 + 断言/耗时 + 时间） */
            js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.evidence') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.evidenceHead').replace('{attempt}', String(attemptNo)).replace('{n}', String(evidenceRefs.length)) }),
              ] }),
              evidenceRefs.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.evidenceEmpty') })
                : js('div', { className: 'mt-evidence', children: [...evidenceGroups.entries()].map(([attempt, list]) => js('div', { key: attempt, className: 'mt-evgroup', children: [
                  js('div', { className: 'mt-evgroup-head', children: [
                    j('strong', { children: t('detail.attemptGroup').replace('{id}', attempt) }),
                    j('span', { className: 'mt-hint', children: list.length > 1 ? `#${list[0].seq} … #${list[list.length - 1].seq}` : `#${list[0].seq}` }),
                  ] }),
                  ...list.map((ev) => j('div', { key: ev.seq, className: 'mt-evitem', children: renderEvidence(ev) })),
                ] })) }),
            ] }),
            /* 时间线（design .timeline）：账本派生，新→旧，最多 20 条 */
            timeline.length > 0 ? js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.timeline') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: String(timeline.length) }),
              ] }),
              j('ul', { className: 'mt-timeline', children: [...timeline].slice(-20).reverse().map((event) => js('li', { key: event.seq, className: 'mt-tl ' + tlTone(event.type), children: [
                js('div', { className: 'mt-tl-row', children: [
                  j('span', { className: 'mt-seq', children: `#${event.seq}` }),
                  j('b', { title: event.type, children: eventLabel(event.type) }),
                  j('span', { className: 'mt-actor', children: actorLabel(event.actor, memberName) }),
                  j('span', { className: 'mt-tl-time', children: fmtClock(event.ts) }),
                ] }),
              ] })) }),
            ] }) : null,
            /* 交付物（FR-10.4）：叶子任务必填 */
            deliverables.length > 0 ? js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.deliverables') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: String(deliverables.length) }),
              ] }),
              j('ul', { className: 'mt-deliverables', children: deliverables.map((item) => j('li', { key: String(item.seq), children: item.path })) }),
            ] }) : null,
            /* CHG-73：改动记录（新→旧，最多 20 条；字段中文名 + 旧→新 + actor + 时间 + 理由） */
            j(EditHistory, { t, edits: detail.edits ?? [], memberName }),
            /* 沟通 thread（FR-12.2）：账本派生，留言以 human 身份落账 */
            js('section', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.thread') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.threadCount').replace('{n}', String(messages.length)) }),
              ] }),
              messages.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.threadEmpty') })
                : js('div', { className: 'mt-thread', children: messages.map((message) => {
                  const human = String(message.actor ?? '') === 'human'
                  return js('div', { key: message.seq, className: 'mt-msg', children: [
                    j('span', { className: 'mt-msg-av' + (human ? ' mt-msg-av-human' : ''), 'aria-hidden': true, children: human ? t('detail.humanAvatar') : String(actorLabel(message.actor, memberName)).slice(0, 1) }),
                    js('div', { className: 'mt-msg-body', children: [
                      js('div', { className: 'mt-msg-meta', children: [
                        j('b', { children: actorLabel(message.actor, memberName) }),
                        j('span', { children: fmtClock(message.ts) }),
                      ] }),
                      j('p', { className: 'mt-msg-text', children: eventLabel(message.type) }),
                    ] }),
                  ] })
                }) }),
              js('div', { className: 'mt-composer-mini', children: [
                readOnly
                  ? j('span', { className: 'mt-hint', children: t('offline.readonlyTip') })
                  : j('input', { id: 'mt-detail-comment', value: comment, placeholder: t('detail.commentPlaceholder'), 'aria-label': t('detail.commentPlaceholder'), onChange: (e) => setComment(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') post() } }),
                readOnly ? null : j('button', { className: 'mt-send-btn', onClick: post, title: t('action.send'), 'aria-label': t('action.send'), children: '➤' }),
                sent ? j('span', { className: 'mt-ok', children: t('detail.commentSent') }) : null,
              ] }),
            ] }),
          ] }),
          /* ── 侧列 ── */
          js('aside', { className: 'mt-detail-side', children: [
            /* 参与团队（FR-21）：任务与团队是多对多关系，主责 1 / 协作 N */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: `${t('detail.participants')} · ${participants.length}` }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.participantsCount').replace('{lead}', String(leadCount)).replace('{coop}', String(coopCount)) }),
              ] }),
              ...participants.map((party) => js('div', { key: party.teamId, className: 'mt-tc-card', children: [
                js('div', { className: 'mt-tc-head', children: [
                  j('span', { className: 'mt-tc-name', children: teamName?.(party.teamId) || party.teamId }),
                  js('span', { className: 'mt-chip ' + (party.role === 'lead' ? 'mt-chip-run' : 'mt-chip-idle'), children: [
                    j('span', { className: 'mt-task-dot' + (party.role === 'lead' ? '-active' : ''), 'aria-hidden': true }),
                    j('span', { children: party.role === 'lead' ? t('task.owner') : t('task.coop') }),
                  ] }),
                  j('span', { className: 'mt-tc-zone', children: party.teamId }),
                ] }),
                j('p', { className: 'mt-tc-desc', children: (party.memberIds ?? []).length > 0 ? `${t('detail.teamMembers')} · ${(party.memberIds ?? []).map((id) => memberName?.(id) ?? id).join('、')}` : t('detail.teamMembersEmpty') }),
              ] })),
              /* design .btn.sm 并排两颗：私讯（聚焦留言框）/ 进入团队（回到看板） */
              participants.length > 0 ? js('div', { className: 'mt-tc-actions', children: [
                j('button', {
                  className: 'mt-btn',
                  title: t('detail.messageMember'),
                  onClick: () => { if (typeof document !== 'undefined' && document.getElementById) document.getElementById('mt-detail-comment')?.focus() },
                  children: t('detail.messageMember'),
                }),
                j('button', {
                  className: 'mt-btn',
                  title: t('detail.enterTeamHint'),
                  onClick: onClose,
                  children: t('detail.enterTeam'),
                }),
              ] }) : null,
              assignees.length > 0 ? js('div', { className: 'mt-detail-meta', children: [
                j('span', { className: 'mt-detail-pill', title: assignees.join(', '), children: `${t('detail.assignees')} ${assignees.map((id) => memberName?.(id) ?? id).join('、')}` }),
                input.requiredRole ? j('span', { className: 'mt-detail-pill', children: `${t('detail.role')} ${roleLabel(String(input.requiredRole))}` }) : null,
                detail.attemptId ? j('span', { className: 'mt-detail-pill', children: `${t('detail.attempt')} ${detail.attemptId}` }) : null,
              ] }) : null,
              j('div', { className: 'mt-hint', children: t('detail.assigneeNote') }),
            ] }),
            /* 依赖关系：上游（全部完成才会被领取）；design 标题「依赖关系」不带计数 */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.depsTitle') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
              ] }),
              deps.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.depsEmpty') })
                : js('div', { className: 'mt-dt-rows', children: deps.map((dep) => js('div', { key: dep, className: 'mt-dt-row', children: [
                  j('span', { className: 'mt-mini-chip', children: t('detail.depsUpstream') }),
                  j('span', { className: 'mt-dt-dep-id', title: String(dep), children: String(dep) }),
                ] })) }),
              j('div', { className: 'mt-hint', children: t('detail.depsHint') }),
            ] }),
            /* 门禁链（CHG-47）：走到了哪一道门 + 逐门裁决 */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.gatesTitle') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-n', children: t('detail.gatesCount').replace('{n}', String(gates.length)) }),
              ] }),
              gates.length === 0
                ? j('div', { className: 'mt-hint', children: t('detail.gatesEmpty') })
                : js('div', { className: 'mt-dt-rows', children: gates.map((gate) => {
                  const verdict = detail.gateVerdicts?.[gate]
                  /* CHG-93：最近一次裁决的完整摘要（executedBy / forcedBy / 退出码） */
                  const gateResult = detail.gateResults?.[gate]
                  const label = verdict === 'pass' ? t('detail.gatePass') : verdict === 'fail' ? t('detail.gateFail') : t('detail.gatePending')
                  return js('div', { key: gate, className: 'mt-dt-row', children: [
                    js('div', { className: 'mt-dt-row-main', children: [
                      j('div', { className: 'mt-dt-row-title', children: gateLabel(gate) }),
                      j('div', { className: 'mt-dt-row-sub', children: [
                        label,
                        /* CHG-93：可信度徽标——「谁跑的 / 是不是人硬放的」直接决定结论分量 */
                        gateResult?.executedBy === 'host'
                          ? j('span', { className: 'mt-mini-chip mt-chip-executed', title: t('detail.gateExecutedByHint'), children: t('detail.gateExecutedByHost') })
                          : null,
                        gateResult?.forcedBy === 'human'
                          ? j('span', { className: 'mt-mini-chip mt-chip-forced', title: t('detail.gateForcedByHint'), children: t('detail.gateForcedByHuman') })
                          : null,
                      ] }),
                    ] }),
                    j('span', { className: 'mt-gate' + (verdict ? ` mt-gate-${verdict}` : ''), children: verdict === 'pass' ? t('detail.gatePass') : label }),
                  ] })
                }) }),
            ] }),
            /* 成本归因（FR-8.3）：一律标「估算」——按 tokenMeter 用量比例分摊，非精确计量 */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.cost') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
                j('span', { className: 'mt-mini-chip', children: t('detail.costEstimate') }),
              ] }),
              /* design 的四行常显：没有 token 侧车时值留「—」，不造假数据 */
              js('div', { children: [
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costTask') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? fmtTok(tokenCount(taskSum)) : '—' }),
                ] }),
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costHit') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? hitRateOf(taskSum) : '—' }),
                ] }),
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costMiss') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? `${fmtTok(taskSum.uncachedInput)} / ${fmtTok(taskSum.output)}` : '—' }),
                ] }),
                js('div', { className: 'mt-dt-costrow', children: [
                  j('span', { className: 'mt-cost-label', children: t('detail.costShare') }),
                  j('span', { className: 'mt-cost-val', children: costKnown ? `${fmtTok(tokenCount(taskSum))} / ${fmtTok(teamTokens)}` : '—' }),
                ] }),
                j('p', { className: 'mt-hint', children: t('detail.costNote') }),
                /* CHG-185：三档各出一句（离线 / 无用量 / 字段缺失），加载中 text 为空不出；总说明在 title 里 */
                costKnown ? null : j('p', { className: `mt-hint mt-cost-${degrade.tone}`, title: t('detail.costUnavailable'), children: degrade.text }),
              ] }),
            ] }),
            /* 任务操作：重新规划 / 编辑 / 取消（RPC 动作一个不丢） */
            js('div', { className: 'mt-sec', children: [
              js('div', { className: 'mt-dsec-head', children: [
                j('h4', { children: t('detail.ops') }),
                j('span', { className: 'mt-line', 'aria-hidden': true }),
              ] }),
              js('div', { className: 'mt-detail-actions', role: 'toolbar', 'aria-label': t('detail.actions'), children: [
                j('button', {
                  className: 'mt-btn',
                  disabled: readOnly || acts.rescope === false,
                  title: actionTitle(acts.rescope, t('task.rescope')),
                  onClick: () => onRescope?.(detail),
                  children: t('task.rescope'),
                }),
                j('button', {
                  className: 'mt-btn',
                  disabled: readOnly || acts.edit === false || !onEdit,
                  title: actionTitle(onEdit ? acts.edit : false, t('task.edit')),
                  onClick: () => onEdit?.(detail),
                  children: t('task.edit'),
                }),
                j('button', {
                  className: 'mt-btn mt-btn-danger',
                  disabled: readOnly || acts.cancel === false,
                  title: actionTitle(acts.cancel, t('detail.cancelTaskBtn')),
                  onClick: () => onCancel?.(detail),
                  children: t('detail.cancelTaskBtn'),
                }),
                /* CHG-202x（P0-1）：产品定案「任务不能手动建，但是可以手动删除」——误建任务的清理出口。
                 * 与「取消」的区别：取消是终态（任务仍在看板「已取消」列）；删除让它不再存在。 */
                onDelete
                  ? j('button', {
                    className: 'mt-btn mt-btn-danger',
                    disabled: readOnly || delBusy,
                    title: t('detail.deleteTaskHint'),
                    onClick: askDelete,
                    children: delBusy ? t('state.loading') : t('detail.deleteTaskBtn'),
                  })
                  : null,
              ] }),
              delAsk ? js('div', { className: 'mt-usagebox', role: 'alert', children: [
                j('strong', { children: t('detail.deleteConfirm') }),
                j('span', { children: t('detail.deleteImpact')
                  .replace('{title}', String(delAsk.title ?? taskId))
                  .replace('{state}', stateLabel(delAsk.state))
                  .replace('{n}', String((delAsk.dependents ?? []).length)) }),
                js('div', { className: 'mt-form-actions', children: [
                  j('button', { className: 'mt-btn', onClick: () => setDelAsk(null), children: t('action.cancel') }),
                  j('button', { className: 'mt-btn mt-btn-danger', disabled: delBusy, onClick: doDelete, children: delBusy ? t('state.loading') : t('detail.deleteConfirmBtn') }),
                ] }),
              ] }) : null,
              delErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: delErr }) : null,
              j('p', { className: 'mt-hint', children: t('detail.cancelNote') }),
            ] }),
          ] }),
        ] }),
      ] })
    }
