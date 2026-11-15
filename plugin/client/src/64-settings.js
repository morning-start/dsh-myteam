    /* ── 团队设置（design/settings.html：配置来源三层合并链 + 行为配置硬上限 + 状态目录 + 生命周期）── */
    /* CHG-187（FR-32 支柱一）：硬上限与 `PATCH_CEILINGS` 同源（memberMaxDepth 2 / maxChildren 5） */
    const CONFIG_CEILINGS = { maxMembers: 6, memberMaxDepth: 2, maxChildren: 5, commandTimeoutMs: 600000 }
    const LAYER_ICONS = {
      builtin: ['M4.6 7.4V5.6a3.4 3.4 0 0 1 6.8 0v1.8', 'M3.4 7.4h9.2v5.4H3.4z'],
      global: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z', 'M2.2 8h11.6', 'M8 2.2c2.5 3.4 2.5 8.2 0 11.6'],
      project: ['M2.4 5.2 8 2.6l5.6 2.6v5.6L8 13.4 2.4 10.8z', 'M2.4 5.2 8 7.8l5.6-2.6M8 7.8v5.6'],
    }
    const layerIcon = (key) => j('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      children: (LAYER_ICONS[key] ?? []).map((d, index) => j('path', { key: index, d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' })),
    })

    /**
     * CHG-119（FR-11.6）：**计划质量反馈**（只读观测）。
     *
     * 需求明确「先可观测不自动改」：这一屏只做三件事——把计划质量说清楚
     * （任务数 / 粒度分布 / 角色负载）、把 estimate vs 实际摆出来、把口径写在明面上。
     * **不提供**「自动重排 / 自动拆分」按钮：那是产品下一步的裁决，不是本轮实现。
     */
    function PlanFeedbackTab({ t, feedback }) {
      if (feedback === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (!feedback) return j('div', { className: 'mt-empty', children: t('feedback.empty') })
      const tasks = feedback.tasks ?? { total: 0, terminal: 0, open: 0, byState: {} }
      const granularity = feedback.granularity ?? { S: 0, M: 0, L: 0, unset: 0 }
      const roleLoad = feedback.roleLoad ?? []
      const deviations = feedback.deviations ?? []
      const stat = (label, value) => js('div', { className: 'mt-tstat', children: [j('b', { children: String(value) }), j('span', { children: label })] })
      const bucketRow = (key, label) => js('div', { key, className: 'mt-setrow', children: [
        js('div', { className: 'mt-setrow-main', children: [
          j('div', { className: 'mt-setrow-title', children: label }),
          j('div', { className: 'mt-setrow-sub', children: t('feedback.granularityNote') }),
        ] }),
        js('div', { className: 'mt-setrow-act', children: j('b', { children: String(granularity[key] ?? 0) }) }),
      ] })
      const roleRow = (row) => js('div', { key: row.roleId, className: 'mt-setrow', children: [
        js('div', { className: 'mt-setrow-main', children: [
          j('div', { className: 'mt-setrow-title', children: roleLabel(row.roleId) || row.roleId }),
          j('div', { className: 'mt-setrow-sub', children: `${t('feedback.planned')} ${row.planned} · ${t('feedback.members')} ${row.members}` }),
        ] }),
        js('div', { className: 'mt-setrow-act', children: row.members === 0 && row.open > 0
          ? j('span', { className: 'mt-chip mt-chip-warn', children: `${t('feedback.open')} ${row.open}` })
          : j('span', { className: 'mt-hint', children: `${t('feedback.open')} ${row.open}` }) }),
      ] })
      const deviationRow = (row) => js('div', { key: row.id, className: 'mt-setrow', children: [
        js('div', { className: 'mt-setrow-main', children: [
          j('div', { className: 'mt-setrow-title', children: row.title }),
          j('div', { className: 'mt-setrow-sub', children: `${row.id} · ${t('feedback.estimate')} ${row.estimate ?? '—'} · ${t('feedback.actual')} ${Math.round(Number(row.actualMs ?? 0) / 60000)} min` }),
        ] }),
        js('div', { className: 'mt-setrow-act', children: [
          row.running ? j('span', { className: 'mt-chip', children: t('feedback.running') }) : null,
          row.overrun ? j('span', { className: 'mt-chip mt-chip-warn', children: t('feedback.overrun') }) : null,
        ] }),
      ] })
      return js('div', { className: 'mt-page mt-page-narrow', children: [
        js('div', { className: 'mt-page-head', children: [
          js('div', { children: [
            j('h2', { children: t('feedback.title') }),
            j('p', { children: t('feedback.desc') }),
          ] }),
          j('span', { className: 'mt-chip', title: t('feedback.caliber'), children: t('feedback.caliber') }),
        ] }),
        /* 概览：只展示账本里真实存在的计数 */
        js('div', { className: 'mt-teambar-stats', children: [
          stat(t('feedback.total'), tasks.total),
          stat(t('feedback.terminal'), tasks.terminal),
          stat(t('feedback.open'), tasks.open),
          stat(t('feedback.overrun'), t('feedback.overCount').replace('{over}', String(feedback.overrun?.over ?? 0)).replace('{comparable}', String(feedback.overrun?.comparable ?? 0))),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('feedback.granularity') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('feedback.granularityNote') }),
          ] }),
          js('div', { className: 'mt-setrows', children: [
            bucketRow('S', 'S'), bucketRow('M', 'M'), bucketRow('L', 'L'), bucketRow('unset', '—'),
          ] }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('feedback.roleLoad') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('feedback.roleLoadNote') }),
          ] }),
          roleLoad.length === 0
            ? j('div', { className: 'mt-empty', children: t('feedback.noData') })
            : js('div', { className: 'mt-setrows', children: roleLoad.map(roleRow) }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('feedback.deviations') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          ] }),
          deviations.length === 0
            ? j('div', { className: 'mt-empty', children: t('feedback.noData') })
            : js('div', { className: 'mt-setrows', children: deviations.slice(0, 20).map(deviationRow) }),
        ] }),
        js('div', { className: 'mt-note-box mt-note-info', children: [
          j('b', { children: t('feedback.notes') }),
          ...(feedback.notes ?? []).map((note, index) => j('div', { key: index, children: String(note) })),
        ] }),
      ] })
    }

    function SettingsTab({ t, config, offline, team, connection, onDisbanded, onSaved }) {
      const [impact, setImpact] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const [showJson, setShowJson] = react.useState(false)
      /* CHG-89（M2-E / FR-16.3）：会话移交——摘要 → 新团队预设会话。
       * 两段确认：第一段无 confirm 只做能力探测 + 摘要预览，第二段才真建会话。 */
      const [handoffBusy, setHandoffBusy] = react.useState(false)
      const [handoffErr, setHandoffErr] = react.useState(null)
      const [handoffResult, setHandoffResult] = react.useState(null)
      /* CHG-118（FR-14.3 / docs/18 §7）：配置编辑——**单一真相是 `draft`**，
       * 表单与 JSON 源视图都改它；只有「保存」才走 `saveTeamConfig`（校验先于写）。 */
      const [draft, setDraft] = react.useState(null)
      const [jsonText, setJsonText] = react.useState('')
      const [jsonErr, setJsonErr] = react.useState(null)
      const [saveErr, setSaveErr] = react.useState(null)
      const [savedNote, setSavedNote] = react.useState(null)
      const [saving, setSaving] = react.useState(false)
      /* 两段确认：第一次保存回 `confirm-required` 时存下影响面 */
      const [pendingSave, setPendingSave] = react.useState(null)
      const [resetAsk, setResetAsk] = react.useState(false)
      /* CHG-120（M2-D ②）：会话考古——当前打开的一页历史（null = 抽屉关闭） */
      const [history, setHistory] = react.useState(null)
      /* CHG-140（docs/19 §7）：团队资产——技能清单 / 导出 / 复制 / 发布 */
      /* CHG-202x（P1-2）：`pending` = 上一轮返回 confirm-required 的操作，再点一次同一按钮才带 confirm。
       * 修复前 `publishTeam({ confirm: true })` 写死——服务端的 confirm-required 分支**永远不可达**，
       * 一次点击就把不可逆的全局写落了地。 */
      const [assets, setAssets] = react.useState({ skills: null, note: null, err: null, busy: false, pending: null })
      react.useEffect(() => {
        if (!config?.config) return
        const next = JSON.parse(JSON.stringify(config.config))
        setDraft(next)
        setJsonText(JSON.stringify(next, null, 2))
        setPendingSave(null)
        setJsonErr(null)
      }, [config])
      if (config === undefined) return j('div', { className: 'mt-empty', children: t('state.loading') })
      if (!config) return j('div', { className: 'mt-empty', children: offline ? t('settings.offline') : t('settings.notWired') })
      const c = config.config ?? {}
      /* 编辑中的值 = draft（未编辑过就回落生效配置） */
      const cfg = draft ?? c
      const limits = cfg.limits ?? {}
      const gates = cfg.gates ?? {}
      const editable = team?.online === true
      const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(c)
      /** 段落内浅合并（表单只改子键；数组整条替换由源视图负责） */
      const setSection = (section, patch) => setDraft((prev) => {
        const base = prev ?? JSON.parse(JSON.stringify(c))
        return { ...base, [section]: { ...(base[section] ?? {}), ...patch } }
      })
      const syncJson = (next) => setJsonText(JSON.stringify(next, null, 2))
      const editSection = (section, patch) => {
        setSaveErr(null)
        setSavedNote(null)
        setDraft((prev) => {
          const base = prev ?? JSON.parse(JSON.stringify(c))
          const next = { ...base, [section]: { ...(base[section] ?? {}), ...patch } }
          syncJson(next)
          return next
        })
      }
      /** CHG-173：顶层标量（taskPlanning）编辑——无段落，直接换值（合并走整条替换） */
      const editTop = (patch) => {
        setSaveErr(null)
        setSavedNote(null)
        setDraft((prev) => {
          const base = prev ?? JSON.parse(JSON.stringify(c))
          const next = { ...base, ...patch }
          syncJson(next)
          return next
        })
      }
      /** 源视图 → 表单：解析失败**不写**（错误就地显示，草稿不动） */
      const applyJson = () => {
        setJsonErr(null)
        setSaveErr(null)
        setSavedNote(null)
        try {
          const parsed = JSON.parse(jsonText)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be a JSON object')
          setDraft(parsed)
        } catch (e) {
          setJsonErr(t('settings.jsonInvalid').replace('{msg}', String(e?.message ?? e)))
        }
      }
      /**
       * 保存（CHG-118）：第一次不带 confirm——服务端若判定影响面非空会回 `confirm-required`，
       * 这里把影响面展示出来，用户点「确认保存」才带 `confirm:true` 重调。
       * 旧宿主没有 `saveTeamConfig` 端点 → 明确提示（不假装成功）。
       */
      const save = async (confirm) => {
        if (!editable || !team?.sessionId || saving || !draft) return
        setSaveErr(null)
        setSavedNote(null)
        setSaving(true)
        try {
          const api = makeApi(connection, team.sessionId)
          if (typeof api.saveTeamConfig !== 'function') { setSaveErr(t('settings.unavailable')); return }
          const r = await api.saveTeamConfig({ teamId: team.teamId, config: draft, ...(confirm ? { confirm: true } : {}) })
          if (r?.status === 'confirm-required') { setPendingSave({ impact: r.impact ?? {}, message: r.message }); return }
          if (r?.status !== 'ok') { setSaveErr(String(r?.message ?? r?.code ?? t('settings.saveFailed').replace('{msg}', ''))); return }
          setPendingSave(null)
          const next = JSON.parse(JSON.stringify(r.config ?? draft))
          setDraft(next)
          setJsonText(JSON.stringify(next, null, 2))
          setSavedNote(t('settings.saved'))
          onSaved?.(r)
        } catch (e) {
          setSaveErr(t('settings.saveFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setSaving(false)
        }
      }
      /**
       * CHG-120（M2-D ② / FR-16.4②）：**会话考古**——按 `session:<id>` 只读读一页历史。
       *
       * 为什么放在设置页：handoff 结果里的「会话索引」是 `session:<id>` 指针的产出处；
       * 没有读取方它就是死链接。旧宿主没有 `page` 能力 → 明确提示（不假装读到）。
       * 翻页用 `beforeSeq`（本页最早一条 seq）往回读。
       */
      const openHistory = async (sessionId, beforeSeq) => {        if (!team?.sessionId) return
        const request = { sessionId, ...(beforeSeq !== undefined ? { beforeSeq } : {}) }
        setHistory({ ...request, loading: true, data: null, err: null })
        try {
          const api = makeApi(connection, team.sessionId)
          if (typeof api.readSessionHistory !== 'function') {
            setHistory({ ...request, loading: false, data: null, err: t('settings.unavailable') })
            return
          }
          const r = await api.readSessionHistory({ teamId: team.teamId, ...request })
          if (r?.status !== 'ok') {
            setHistory({ ...request, loading: false, data: null, err: String(r?.message ?? r?.code ?? t('history.failed').replace('{msg}', '')) })
            return
          }
          setHistory({ ...request, loading: false, data: r, err: null })
        } catch (e) {
          setHistory({ ...request, loading: false, data: null, err: t('history.failed').replace('{msg}', String(e?.message ?? e)) })
        }
      }

      /**
       * CHG-140（docs/19 §7 UI 缺口）：**团队资产操作**——技能清单 / 导出快照 / 复制团队 / 发布到全局。
       *
       * 两条纪律（与后端同源）：
       *  - **两段确认透传**：`confirm-required` 不吞成成功，提示用户再点一次；
       *  - **隔离提示上屏**：只写 `$DSH_HOME/myteam/**`（绝不写全局 skills 与其它预设）。
       */
      const runAsset = async (op, opts = {}) => {
        if (!team?.sessionId) return
        setAssets((prev) => ({ ...prev, busy: true, note: null, err: null }))
        try {
          const api = makeApi(connection, team.sessionId)
          let result
          if (op === 'skills') result = await api.listSkills({ teamId: team.teamId })
          else if (op === 'export') result = await api.exportTeam({ teamId: team.teamId })
          else if (op === 'copy') result = await api.copyTeam({ sourceTeamId: team.teamId })
          /* CHG-202x（P1-2）：两段确认——第一次**不带** confirm，服务端返回影响面；再点一次才落盘。 */
          else result = await api.publishTeam({ teamId: team.teamId, ...(opts.confirm === true ? { confirm: true } : {}) })
          if (result?.status === 'confirm-required') {
            setAssets((prev) => ({
              ...prev,
              busy: false,
              pending: op,
              /* 服务端的确认文案优先（它带「全局库已有同 teamId」这类具体影响面）；缺失才回落词条 */
              note: String(result?.message ?? '') || t('assets.confirmPublish'),
            }))
            return
          }
          if (result?.status !== 'ok') {
            setAssets((prev) => ({ ...prev, busy: false, err: String(result?.message ?? result?.code ?? 'failed') }))
            return
          }
          setAssets((prev) => ({
            skills: op === 'skills' ? (result.declared ?? []) : prev.skills,
            note: op === 'skills' ? null : (op === 'export' && result.filePath ? String(result.filePath) : t('assets.done')),
            err: null,
            busy: false,
            pending: null,
          }))
        } catch (error) {
          setAssets((prev) => ({ ...prev, busy: false, err: String(error?.message ?? error) }))
        }
      }

      const doReset = async () => {
        if (!editable || !team?.sessionId || saving) return
        setSaveErr(null)
        setSaving(true)
        try {
          const api = makeApi(connection, team.sessionId)
          if (typeof api.resetTeamConfig !== 'function') { setSaveErr(t('settings.unavailable')); return }
          const r = await api.resetTeamConfig({ teamId: team.teamId, confirm: true })
          if (r?.status !== 'reset' && r?.status !== 'noop') {
            setSaveErr(String(r?.message ?? r?.code ?? t('settings.saveFailed').replace('{msg}', '')))
            return
          }
          setResetAsk(false)
          setSavedNote(t('settings.resetDone'))
          const view = await api.getConfig({ teamId: team.teamId })
          onSaved?.(view?.status === 'ok' ? view : null)
        } catch (e) {
          setSaveErr(t('settings.saveFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setSaving(false)
        }
      }
      const sections = Object.keys(c).length
      const activeLayer = (key) => (config.chain ?? []).some((item) => item.layer === key && item.active === true) || config.source === key
      const pending = Math.max(0, Number(team?.counts?.tasks ?? 0) - Number(team?.counts?.done ?? 0))
      const askDisband = async () => {
        if (!team?.online) return
        try {
          const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: false })
          if (r?.status === 'confirm-required') setImpact(r.impact ?? {})
        } catch (e) { setErr(String(e?.message ?? e)) }
      }
      const doDisband = async () => {
        if (!team?.online || busy) return
        setBusy(true)
        try {
          const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: true })
          if (r?.ok === false || r?.status === 'error') { setErr(r?.message ?? t('settings.failed').replace('{msg}', '')); return }
          setImpact(null)
          onDisbanded?.()
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
      }
      /**
       * CHG-89（M2-E / FR-16.3）：会话移交的两段式入口。
       *
       * 为什么面板侧要加一段确认：移交会**程序化新建一个团队预设会话**并注入摘要——
       * 这是用户可见的副作用（新会话会出现），不能点一下就发生。服务端 `handoffTeam`
       * 本身是单段的（它只管「建会话 + 注入」），确认放在这里。
       *
       * 失败不静默：`MT_UNAVAILABLE`（宿主无 sessionController）与「注入失败但会话已建」
       * 都原样回显——后者服务端会带 `sessionId`，人可以手动粘贴摘要。
       */
      const askHandoff = () => {
        if (!team?.online || !team?.sessionId || handoffBusy) return
        setHandoffErr(null)
        setHandoffResult({ stage: 'confirm' })
      }
      const doHandoff = async () => {
        if (!team?.online || !team?.sessionId || handoffBusy) return
        setHandoffErr(null)
        setHandoffBusy(true)
        try {
          const r = await makeApi(connection, team.sessionId).handoff({
            teamId: team.teamId,
            sourceSessionId: team.sessionId,
          })
          if (r?.status === 'ok') {
            setHandoffResult({ stage: 'done', sessionId: r.sessionId, summary: r.summary, metadata: r.metadata, note: r.note })
            return
          }
          /* 会话已建但注入失败：把 sessionId 一起显示，用户可手动粘贴摘要 */
          setHandoffResult(r?.sessionId ? { stage: 'partial', sessionId: r.sessionId, message: r.message ?? r.code } : null)
          setHandoffErr(r?.message ?? r?.code ?? t('settings.handoffFailed').replace('{msg}', ''))
        } catch (e) {
          setHandoffErr(t('settings.handoffFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setHandoffBusy(false)
        }
      }
      const layerRow = (key, title, src, path, n, unit) => js('div', { className: 'mt-layer', children: [
        j('span', { className: `mt-layer-ico mt-layer-${key}`, 'aria-hidden': true, children: layerIcon(key) }),
        js('div', { className: 'mt-layer-main', children: [
          js('div', { className: 'mt-layer-title', children: [title, j('span', { className: key === 'builtin' ? 'mt-src' : `mt-src mt-src-${key}`, children: src })] }),
          j('div', { className: 'mt-layer-path', children: path }),
        ] }),
        js('div', { className: 'mt-layer-n', children: [String(n), unit ? j('span', { children: unit }) : null] }),
      ] })
      const row = (key, title, sub, act) => js('div', { className: 'mt-setrow', key, children: [
        js('div', { className: 'mt-setrow-main', children: [
          j('div', { className: 'mt-setrow-title', children: title }),
          j('div', { className: 'mt-setrow-sub', children: sub }),
        ] }),
        js('div', { className: 'mt-setrow-act', children: act }),
      ] })
      /** CHG-118：可编辑数字——空值写 `undefined`（由服务端合并回默认），非数字不写 */
      const numInput = (value, label, onChange, range = {}) => j('input', {
        className: 'mt-input-num',
        value: value === undefined || value === null ? '' : String(value),
        inputMode: 'numeric',
        'aria-label': label,
        disabled: !editable,
        ...(range.min !== undefined ? { min: range.min } : {}),
        ...(range.max !== undefined ? { max: range.max } : {}),
        onChange: (event) => {
          const raw = String(event?.target?.value ?? '').trim()
          if (raw === '') { onChange?.(undefined); return }
          const parsed = Number(raw)
          if (!Number.isFinite(parsed)) return
          onChange?.(parsed)
        },
      })
      const toggle = (checked, label, onChange) => j('button', {
        className: 'mt-toggle',
        role: 'switch',
        'aria-checked': Boolean(checked),
        'aria-label': label,
        disabled: !editable || !onChange,
        onClick: () => onChange?.(!checked),
      })
      const ceiling = (value) => j('span', { className: 'mt-readonly-val', children: t('settings.ceiling').replace('{v}', String(value)) })
      /* CHG-170（R41-③）：内置工具隐藏显示「实际生效」——删除旧假开关（toggle(false) 永远关闭且禁用）。
       * hideBuiltinTeamTools 是 host 级行为（此处改不了），设置页只显示三个事实：启用与否 /
       * 宿主是否提供 tools.restrict（restricted=false = 隐藏未执行）/ 实际 deny 的工具清单。 */
      const hideInfo = config.runtime?.builtinToolsHide
      const hideToolsAct = (() => {
        if (!hideInfo) return j('span', { className: 'mt-readonly-val', children: '—' })
        if (!hideInfo.enabled) return j('span', { className: 'mt-readonly-val', children: t('settings.hideToolsOff') })
        if (!hideInfo.restricted) return j('span', { className: 'mt-hideeff-warn', children: t('settings.hideToolsNoRestrict') })
        return j('span', { className: 'mt-readonly-val', children: t('settings.hideToolsEff').replace('{n}', String(hideInfo.effective.length)).replace('{total}', String(hideInfo.configured.length)) })
      })()
      const hideToolsSub = js('div', { children: [
        j('div', { children: t('settings.hideToolsSub') }),
        hideInfo && hideInfo.enabled && hideInfo.restricted && hideInfo.effective.length > 0
          ? j('div', { className: 'mt-hint', children: t('settings.hideToolsList').replace('{list}', hideInfo.effective.join('、')) })
          : null,
      ] })
      return js('div', { className: 'mt-page mt-page-narrow', children: [
        js('div', { className: 'mt-page-head', children: [
          js('div', { children: [
            j('h2', { children: t('settings.page.title') }),
            j('p', { children: t('settings.page.desc') }),
          ] }),
          js('div', { className: 'mt-page-head-actions', children: [
            j('button', { className: 'mt-btn', 'aria-pressed': showJson, onClick: () => setShowJson(!showJson), children: t('settings.jsonView') }),
          ] }),
        ] }),
        /* CHG-118：JSON 源视图（可编辑）——「应用」解析进表单，解析失败草稿不动 */
        showJson ? js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.jsonView') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('settings.jsonNote') }),
          ] }),
          j('textarea', {
            className: 'mt-json',
            rows: 18,
            spellCheck: false,
            'aria-label': t('settings.jsonView'),
            value: jsonText,
            disabled: !editable,
            onChange: (event) => { setJsonErr(null); setJsonText(String(event?.target?.value ?? '')) },
          }),
          jsonErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: jsonErr }) : null,
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', disabled: !editable, onClick: applyJson, children: t('settings.jsonApply') }),
          ] }),
        ] }) : null,
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.sourceTitle') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('settings.sourceNote') }),
          ] }),
          js('div', { className: 'mt-layers', children: [
            layerRow('builtin', t('settings.layer.default'), t('settings.layer.readonly'), t('settings.layer.defaultPath'), sections, t('settings.layer.items').replace('{n}', '')),
            layerRow('project', t('settings.layer.project'), t('settings.layer.thisFile'), t('settings.layer.projectPath'), activeLayer('project') ? sections : '—', activeLayer('project') ? t('settings.layer.covered').replace('{n}', '') : t('settings.layer.idle')),
            layerRow('global', t('settings.layer.team'), t('settings.layer.teamScope'), t('settings.layer.teamPath'), activeLayer('team') ? sections : '—', activeLayer('team') ? t('settings.layer.covered').replace('{n}', '') : t('settings.layer.idle')),
          ] }),
          js('div', { className: 'mt-merge-chain', children: [
            j('b', { className: activeLayer('default') ? 'mt-cur' : '', children: t('settings.layer.default') }),
            j('span', { className: 'mt-lt', children: '<' }),
            j('b', { className: activeLayer('project') ? 'mt-cur' : '', children: activeLayer('project') ? `${t('settings.layer.project')}${t('settings.layer.effective')}` : t('settings.layer.project') }),
            j('span', { className: 'mt-lt', children: '<' }),
            j('b', { className: activeLayer('team') ? 'mt-cur' : '', children: activeLayer('team') ? `${t('settings.layer.team')}${t('settings.layer.effective')}` : t('settings.layer.team') }),
            j('span', { children: t('settings.mergeNote') }),
          ] }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.behavior') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('settings.behaviorNote') }),
          ] }),
          js('div', { className: 'mt-setrows', children: [
            row('teamSize', t('settings.teamSize'), t('settings.teamSizeSub'), [ceiling(CONFIG_CEILINGS.maxMembers), numInput(limits.maxMembers, t('settings.teamSize'), (v) => editSection('limits', { maxMembers: v }), { min: 1, max: CONFIG_CEILINGS.maxMembers })]),
            row('depth', t('settings.delegateDepth'), t('settings.delegateDepthSub'), [ceiling(CONFIG_CEILINGS.memberMaxDepth), numInput(limits.memberMaxDepth, t('settings.delegateDepth'), (v) => editSection('limits', { memberMaxDepth: v }), { min: 0, max: CONFIG_CEILINGS.memberMaxDepth })]),
            /* CHG-187（FR-32 支柱一）：单成员最多直接子成员数（默认 3，硬上限 5） */
            row('childrenLimit', t('settings.childrenLimit'), t('settings.childrenLimitSub'), [ceiling(CONFIG_CEILINGS.maxChildren), numInput(limits.maxChildren, t('settings.childrenLimit'), (v) => editSection('limits', { maxChildren: v }), { min: 0, max: CONFIG_CEILINGS.maxChildren })]),
            /* CHG-173（FR-1.3）：DAG 来源——captain（默认，队长推导）/ template（按 pipeline.stages 生成模板任务组） */
            row('taskPlanning', t('settings.taskPlanning'), t('settings.taskPlanningSub'), [toggle((cfg.taskPlanning ?? 'captain') === 'template', t('settings.taskPlanning'), (v) => editTop({ taskPlanning: v ? 'template' : 'captain' }))]),
            row('gates', t('settings.gates'), t('settings.gatesSub'), [toggle(gates.enabled !== false, t('settings.gates'), (v) => editSection('gates', { enabled: v }))]),
            row('timeout', t('settings.gateTimeoutLabel'), t('settings.gateTimeoutSub'), [ceiling(CONFIG_CEILINGS.commandTimeoutMs / 1000), numInput(Math.round(Number(gates.commandTimeoutMs ?? 0) / 1000), t('settings.gateTimeoutLabel'), (v) => editSection('gates', { commandTimeoutMs: v === undefined ? undefined : Math.round(Number(v) * 1000) }), { min: 1, max: CONFIG_CEILINGS.commandTimeoutMs / 1000 }), j('span', { className: 'mt-hint', children: t('settings.seconds') })]),
            row('hideTools', t('settings.hideTools'), hideToolsSub, [hideToolsAct]),
            row('evidence', t('settings.evidenceLabel'), t('settings.evidenceSub'), [toggle(cfg.memory?.evidenceRequired !== false, t('settings.evidenceLabel'), (v) => editSection('memory', { evidenceRequired: v }))]),
          ] }),
        ] }),
        /* CHG-118（FR-14.3 / docs/18 §7）：保存 / 恢复默认——两段确认 + 影响面 + 失败不静默 */
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.formTitle') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: dirty ? t('settings.dirty') : t('settings.formNote') }),
          ] }),
          js('div', { className: 'mt-inline-note', children: j('span', { className: 'mt-hint', children: t('settings.editHint') }) }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn mt-btn-primary', 'data-testid': 'settings-save', disabled: !editable || !dirty || saving, onClick: () => save(false), children: saving ? t('state.loading') : t('settings.save') }),
            j('button', { className: 'mt-btn', 'data-testid': 'settings-reset', disabled: !editable || saving, onClick: () => setResetAsk(true), children: t('settings.resetBtn') }),
          ] }),
          savedNote ? j('div', { className: 'mt-note-box mt-note-info', role: 'status', children: savedNote }) : null,
          saveErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: saveErr }) : null,
          pendingSave ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: t('settings.confirmSaveBody').replace('{members}', impactCountText(pendingSave.impact?.members)).replace('{tasks}', impactCountText(pendingSave.impact?.runningTasks)) }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn mt-btn-primary', 'data-testid': 'settings-confirm-save', disabled: saving, onClick: () => save(true), children: saving ? t('state.loading') : t('settings.confirmSave') }),
              j('button', { className: 'mt-btn', onClick: () => setPendingSave(null), children: t('action.cancel') }),
            ] }),
          ] }) : null,
          resetAsk ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: t('settings.resetConfirmBody') }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn mt-btn-danger', 'data-testid': 'settings-confirm-reset', disabled: saving, onClick: doReset, children: saving ? t('state.loading') : t('settings.resetBtn') }),
              j('button', { className: 'mt-btn', onClick: () => setResetAsk(false), children: t('action.cancel') }),
            ] }),
          ] }) : null,
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.stateDir') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          ] }),
          js('div', { className: 'mt-secbox', children: [
            js('div', { className: 'mt-inline-note', children: [
              j('button', { className: 'mt-btn mt-btn-sm', disabled: true, title: t('settings.readonlyTip'), children: t('settings.openDir') }),
            ] }),
            js('div', { className: 'mt-inline-note', children: [
              j('span', { className: 'mt-ok-ink', children: `✓ ${t('settings.gitignore')}` }),
              j('span', { children: t('settings.ledgerAppend') }),
            ] }),
          ] }),
        ] }),
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('settings.lifecycle') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
          ] }),
          js('div', { className: 'mt-setrows', children: [
            /* CHG-202x（P1-3）：修复前是 disabled 死按钮（title 写「只读」），而「可逆归档没有任何真正入口」。
             * 本仓的归档就是 `team.disbanded` 那一套（落 archive/ 快照 + 状态 archived，不可逆），
             * 所以这里给**真入口**：走同一份两段确认（输入 teamId 才可提交），文案如实说不可逆。 */
            row('archive', t('settings.archiveTitle'), t('settings.archiveSub'), [j('button', { className: 'mt-btn mt-btn-sm', disabled: !team?.online, title: team?.online ? t('settings.archiveHint') : t('settings.offline'), onClick: askDisband, children: t('settings.archiveBtn') })]),
            /* CHG-89（M2-E / FR-16.3）：会话移交——把当前团队上下文摘要带进一个新团队预设会话 */
            row('handoff', t('settings.handoffTitle'), t('settings.handoffSub'), [j('button', { className: 'mt-btn mt-btn-sm', disabled: !team?.online || handoffBusy, title: team?.online ? t('settings.handoffHint') : t('settings.offline'), onClick: askHandoff, children: handoffBusy ? t('state.loading') : t('settings.handoffBtn') })]),
            row('disband', j('span', { className: 'mt-danger-ink', children: t('settings.disbandTitle') }), t('settings.disbandSub').replace('{members}', String((team?.members ?? []).length)).replace('{tasks}', String(pending)), [j('button', { className: 'mt-btn mt-btn-danger mt-btn-sm', disabled: !team?.online, onClick: askDisband, children: t('settings.disbandBtn') })]),
          ] }),
          impact ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: t('disband.impact').replace('{members}', impactCountText(impact?.members)).replace('{tasks}', impactCountText(impact?.tasks)) }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn mt-btn-danger', disabled: busy, onClick: doDisband, children: busy ? t('state.loading') : t('settings.confirmDisband') }),
              j('button', { className: 'mt-btn', onClick: () => setImpact(null), children: t('settings.cancelDisband') }),
            ] }),
          ] }) : null,
          /* CHG-89：移交确认 / 结果（新会话 id + 摘要预览；原会话保留） */
          handoffResult?.stage === 'confirm' ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: t('settings.handoffConfirm') }),
            j('span', { children: t('settings.handoffConfirmBody').replace('{team}', String(team?.name ?? team?.teamId ?? '')) }),
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn mt-btn-primary', disabled: handoffBusy, onClick: doHandoff, children: handoffBusy ? t('state.loading') : t('settings.handoffConfirmBtn') }),
              j('button', { className: 'mt-btn', onClick: () => setHandoffResult(null), children: t('action.cancel') }),
            ] }),
          ] }) : null,
          handoffResult?.stage === 'done' || handoffResult?.stage === 'partial' ? js('div', { className: 'mt-impact-box', children: [
            j('strong', { children: handoffResult.stage === 'done' ? t('settings.handoffDone') : t('settings.handoffPartial') }),
            j('span', { className: 'mt-rolechip mt-rolechip-mono', children: String(handoffResult.sessionId ?? '—') }),
            handoffResult.note ? j('span', { children: String(handoffResult.note) }) : null,
            handoffResult.summary ? j('pre', { className: 'mt-prompt-block', children: String(handoffResult.summary) }) : null,
            /* CHG-120：会话索引 = session:<id> 指针列表，每条都能「考古」只读深读 */
            (handoffResult.metadata?.sessionIndex ?? []).length > 0 ? js('div', { className: 'mt-setrows', children: [
              j('b', { children: t('history.index') }),
              ...handoffResult.metadata.sessionIndex.map((ref) => js('div', { key: ref.sessionId, className: 'mt-setrow', children: [
                js('div', { className: 'mt-setrow-main', children: [
                  j('div', { className: 'mt-setrow-title', children: String(ref.title ?? ref.sessionId) }),
                  j('div', { className: 'mt-setrow-sub', children: `session:${ref.sessionId}${ref.taskId ? ` · ${ref.taskId}` : ''}` }),
                ] }),
                js('div', { className: 'mt-setrow-act', children: j('button', {
                  className: 'mt-btn mt-btn-sm',
                  'data-testid': `history-open-${ref.sessionId}`,
                  onClick: () => openHistory(String(ref.sessionId)),
                  children: t('history.open'),
                }) }),
              ] })),
            ] }) : null,
            js('div', { className: 'mt-form-actions', children: [
              j('button', { className: 'mt-btn', onClick: () => setHandoffResult(null), children: t('action.close') }),
            ] }),
          ] }) : null,
          handoffErr ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: handoffErr }) : null,
        ] }),
        /* CHG-140（docs/19 §7）：团队资产——技能清单 / 导出 / 复制 / 发布（隔离提示上屏） */
        js('section', { className: 'mt-ssection', children: [
          js('div', { className: 'mt-dsec-head', children: [
            j('h4', { children: t('assets.title') }),
            j('span', { className: 'mt-dsec-line', 'aria-hidden': true }),
            j('span', { className: 'mt-dsec-n', children: t('assets.desc') }),
          ] }),
          js('div', { className: 'mt-form-actions', children: [
            j('button', { className: 'mt-btn', 'data-testid': 'assets-skills', disabled: assets.busy, onClick: () => runAsset('skills'), children: t('assets.skills') }),
            j('button', { className: 'mt-btn', 'data-testid': 'assets-export', disabled: assets.busy, onClick: () => runAsset('export'), children: t('assets.export') }),
            j('button', { className: 'mt-btn', 'data-testid': 'assets-copy', disabled: assets.busy, onClick: () => runAsset('copy'), children: t('assets.copy') }),
            j('button', { className: 'mt-btn', 'data-testid': 'assets-publish', disabled: assets.busy, onClick: () => runAsset('publish', { confirm: assets.pending === 'publish' }), children: t('assets.publish') }),
          ] }),
          j('div', { className: 'mt-hint', children: t('assets.isolation') }),
          assets.skills === null ? null : (assets.skills ?? []).length === 0
            ? j('div', { className: 'mt-empty', children: t('assets.noSkills') })
            : js('div', { className: 'mt-setrows', 'data-testid': 'assets-skill-list', children: (assets.skills ?? []).map((item) => js('div', { key: String(item.name), className: 'mt-setrow', children: [
                js('div', { className: 'mt-setrow-main', children: [
                  j('div', { className: 'mt-setrow-title', children: String(item.name) }),
                  j('div', { className: 'mt-setrow-sub', children: (item.boundBy ?? []).map((binding) => String(binding.roleId)).join(' · ') || '—' }),
                ] }),
              ] })) }),
          assets.note ? j('div', { className: 'mt-note-box mt-note-info', 'data-testid': 'assets-note', children: assets.note }) : null,
          assets.err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: assets.err }) : null,
        ] }),
        js('p', { className: 'mt-note-box', children: [j('b', { children: t('settings.footNote') }), j('span', { children: t('settings.footNoteSub') })] }),
        (config.warnings ?? []).length > 0 ? j('div', { className: 'mt-note-box mt-note-info', children: `${t('settings.warnings')}：${config.warnings.join('；')}` }) : null,
        err ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: err }) : null,
        /* CHG-120：会话考古抽屉（只读一页历史；翻页用 beforeSeq 往回读） */
        history ? j('div', {
          className: 'mt-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('history.title'),
          onClick: (event) => { if (event?.target === event?.currentTarget) setHistory(null) },
          children: js('div', { className: 'mt-dialog', children: [
            js('div', { className: 'mt-dialog-head', children: [
              js('div', { children: [
                j('h3', { children: t('history.title') }),
                j('p', { className: 'mt-hint', children: t('history.desc') }),
              ] }),
              j('button', { className: 'mt-btn', 'data-testid': 'history-close', onClick: () => setHistory(null), children: t('action.close') }),
            ] }),
            js('div', { className: 'mt-dialog-body', children: [
              j('span', { className: 'mt-rolechip mt-rolechip-mono', children: `session:${history.sessionId}` }),
              history.loading
                ? j('div', { className: 'mt-hint', children: t('history.loading') })
                : history.err
                  ? j('div', { className: 'mt-form-note mt-error-banner', role: 'alert', children: history.err })
                  : (history.data?.items ?? []).length === 0
                    ? j('div', { className: 'mt-empty', children: t('history.empty') })
                    : js('ol', { className: 'mt-history-list', children: (history.data.items ?? []).map((item, index) => js('li', { key: index, className: 'mt-history-item', children: [
                      js('div', { className: 'mt-history-meta', children: [
                        item.role ? j('b', { children: String(item.role) }) : null,
                        item.type ? j('span', { children: String(item.type) }) : null,
                        item.seq !== undefined ? j('span', { children: `#${item.seq}` }) : null,
                        item.truncated ? j('span', { className: 'mt-chip mt-chip-warn', children: t('history.truncated') }) : null,
                      ] }),
                      j('div', { className: 'mt-history-text', children: String(item.text ?? '') }),
                    ] })) }),
              history.data ? js('div', { className: 'mt-form-actions', children: [
                j('span', { className: 'mt-hint', children: t('history.chars').replace('{n}', String(history.data.chars ?? 0)) }),
                history.data.hasMore ? j('button', {
                  className: 'mt-btn mt-btn-sm',
                  'data-testid': 'history-more',
                  onClick: () => openHistory(history.sessionId, Number((history.data.items ?? [])[0]?.seq ?? 0) || undefined),
                  children: t('history.more'),
                }) : null,
              ] }) : null,
              history.data ? js('div', { className: 'mt-note-box mt-note-info', children: [
                j('b', { children: t('history.notes') }),
                ...(history.data.notes ?? []).map((note, index) => j('div', { key: index, children: String(note) })),
              ] }) : null,
            ] }),
          ] }),
        }) : null,
      ] })
    }

