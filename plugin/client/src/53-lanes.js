    /* ── 泳道（design/lanes.html：蛇形泳道，行 = 角色实例，列 = 四阶段，格 = 该实例在该阶段的节点）──
     * 三视图同源同抽屉：节点点开仍是同一个任务详情（onOpen）。列取四个流转阶段；完成 / 未完成是终态桶，不进泳道。 */
    const LANE_STAGES = ['待规划', '就绪', '进行中', '门禁']
    /** CHG-85：泳道格子内最多显示几张卡，超出折叠（design/tasks.html 同款「还有 N 个」） */
    const LANE_CELL_LIMIT = 4
    const laneStageOf = (state) => {
      for (const name of LANE_STAGES) {
        const col = PROJECT_COLUMNS.find((item) => item.name === name)
        if (col && col.states.includes(state)) return name
      }
      return null
    }
    const laneAvatarChar = (member) => String(roleLabel(member?.roleId) ?? member?.id ?? '?').trim().slice(0, 1) || '?'
    const assigneesOf = (task) => (task.assignees && task.assignees.length > 0 ? task.assignees : task.assignee ? [task.assignee] : [])

    /**
     * CHG-115：**看板同源换挂载点**（design-notes §五「会话页不重复造面板」）。
     *
     * 面板「任务」页与团队会话视图渲染的是**同一个** BoardView：
     *  - 面板传 `drag` / `onAdd` → 可拖拽、可列内新建的完整看板；
     *  - 会话视图不传 → **只读看板**（无拖拽、无列内新建）。
     * 两处各写一份看板就是 CHG-107「假数据」的温床——视图只换挂载点，不造第二份实现。
     */
    function BoardView({
      t,
      tasks: rawTasks,
      columns = PROJECT_COLUMNS,
      columnOf = projectColumnOf,
      memberName,
      teamName,
      showTeamName = false,
      selectMode = false,
      selected,
      onToggle,
      onOpen,
      onAdd,
      drag,
    }) {
      /* CHG-141（**判空**）：数据未到达时 `tasks` 是 `undefined`（load 中 / 离线团队 / 刚建团队），
       * 旧实现直接 `tasks.filter(...)` → **整屏白**。入口归一成空数组，下游按空态渲染。 */
      const tasks = Array.isArray(rawTasks) ? rawTasks : []
      const selectedSet = selected ?? new Set()
      const dragTask = drag?.task
      const draggedTask = drag?.dragged
      return js('div', { className: 'mt-board', children: [
        drag?.liftCard ?? null,
        js('div', { className: 'mt-columns', children: columns.map((col) => {
          const list = tasks.filter((task) => columnOf(task.state) === col.name && task.key !== dragTask?.key)
          const over = dragTask?.over === col.name
          const legal = Boolean(over && draggedTask && drag?.canDrop?.(draggedTask, col.name))
          const source = Boolean(dragTask) && dragTask.from === col.name
          return js('div', {
            key: col.name,
            className: 'mt-col' + (col.done ? ' mt-col-done' : '') + (over ? (legal ? ' mt-col-drop' : ' mt-col-nodrop') : ''),
            onDragOver: (event) => drag?.onDragOver?.(event, col.name),
            onDrop: (event) => drag?.onDrop?.(event, col.name),
            children: [
              js('div', { className: 'mt-col-head', children: [
                j('span', { className: 'mt-col-shape', 'aria-hidden': true }),
                j('h4', { className: 'mt-col-name', children: col.name }),
                j('span', { className: 'mt-count', children: list.length }),
                /* design/board.html 的 .col-head .add：列内直达新建（只读视图不传 onAdd） */
                onAdd ? j('button', {
                  className: 'mt-col-add',
                  title: t('board.addToCol').replace('{col}', col.name),
                  onClick: () => onAdd(col.name),
                  children: '＋',
                }) : null,
              ] }),
              /* design/dragging.html 的 .dropzone：合法落点给「释放移入 · 进入后走 审查 → 命令验证 → 存档」 */
              legal ? js('div', { className: 'mt-dropzone', children: [
                j('svg', {
                  width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                  children: j('path', { d: 'M3 8.4 6.4 11.8 13 5.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                }),
                j('span', { children: t('drag.dropzone') }),
              ] }) : null,
              js('div', { className: 'mt-col-body', children: [
                ...list.map((task) => j(TaskCard, {
                  key: task.key,
                  task,
                  t,
                  teamName,
                  memberName,
                  showTeamName,
                  onOpen: () => onOpen?.(task),
                  selectable: selectMode,
                  selected: selectedSet.has(task.key),
                  onToggle,
                  drag: drag ? drag.cardFor?.(task) : undefined,
                })),
                /* 源列留虚线幽灵占位「t6 正被拖动」 */
                source ? j('div', { className: 'mt-task mt-task-ghost', children: t('drag.ghost').replace('{code}', dragTask.code) }) : null,
                list.length === 0 && !source ? j('div', { className: 'mt-col-empty', children: t('board.emptyCol') }) : null,
              ] }),
            ],
          })
        }) }),
      ] })
    }

    function LanesView({ t, tasks: rawTasks, members, onOpen }) {
      /*
       * CHG-141（**判空**）：泳道/依赖视图在「看板数据未到达」时 `tasks` 是 `undefined`
       * （`BoardView` 的 `rawTasks` 还在 load / 团队刚建好 / 离线团队），旧实现直接
       * `tasks.filter(...)` → **整屏白**（这是用户报的「任务依赖视图渲染有问题」的根因）。
       * 统一在入口归一成数组：下游全部按「空数组」渲染空态，不再崩。
       */
      const tasks = Array.isArray(rawTasks) ? rawTasks : []
      const stageStates = LANE_STAGES.map((name) => ({ name, states: PROJECT_COLUMNS.find((col) => col.name === name)?.states ?? [] }))
      const memberIds = new Set((members ?? []).map((member) => String(member.id ?? member.instanceName ?? '')))
      /** 在册实例 id —— 指派不到任何在册实例的任务 = 未认领（不丢任务、也不假造分配） */
      const assignedTo = (task) => assigneesOf(task).map(String).filter((id) => memberIds.has(id))
      const rows = (members ?? []).map((member, index) => ({
        key: String(member.id ?? member.instanceName ?? index),
        member,
        unassigned: false,
        cells: stageStates.map((stage) => tasks.filter((task) => laneStageOf(task.state) === stage.name && assignedTo(task).includes(String(member.id)))),
      }))
      /* 未认领行：保证「列头计数 = 格子里看得见的节点」，同时不把任务改成假指派 */
      const unassignedTasks = tasks.filter((task) => assignedTo(task).length === 0)
      if (unassignedTasks.length > 0) {
        rows.push({
          key: 'mt-lane-unassigned',
          member: null,
          unassigned: true,
          cells: stageStates.map((stage) => unassignedTasks.filter((task) => laneStageOf(task.state) === stage.name)),
        })
      }
      const counts = stageStates.map((_, i) => rows.reduce((sum, row) => sum + row.cells[i].length, 0))
      const labelOf = (row) => (row.unassigned
        ? { avatar: '?', title: t('lanes.unassigned'), sub: t('lanes.unassignedNote') }
        : {
          avatar: laneAvatarChar(row.member),
          title: roleLabel(row.member.roleId),
          sub: `${row.member.instanceName ?? row.member.id ?? '—'} · ${memberStateLabel(row.member.status)}`,
        })
      return js('div', { className: 'mt-lanes', style: { '--mt-lane-cols': String(stageStates.length) }, children: [
        js('div', { className: 'mt-lane', children: [
          j('div', { className: 'mt-lane-head', children: t('lanes.groupBy') }),
          ...stageStates.map((stage, i) => j('span', { key: stage.name, className: 'mt-lane-head', children: [
            j('span', { children: stage.name }),
            j('span', { className: 'mt-lane-count', children: `· ${counts[i]}` }),
          ] })),
        ] }),
        rows.length === 0
          ? j('div', { className: 'mt-lane-empty', children: t('lanes.noMembers') })
          : rows.map((row) => {
            const label = labelOf(row)
            const total = row.cells.reduce((sum, cell) => sum + cell.length, 0)
            return js('div', { className: 'mt-lane', key: row.key, children: [
              js('div', { className: 'mt-lane-label' + (row.unassigned ? ' mt-lane-label-unassigned' : ''), children: [
                /* CHG-178（U3）：任务数并进「角色行」右侧 —— 原来单独占第三行，行高被撑到 96px 还
                 * 压到行底边上（文字被 overflow:hidden 切掉）。两行 = 设计稿口径。 */
                js('div', { className: 'mt-lane-role', children: [
                  j('span', { className: row.unassigned ? 'mt-avatar mt-avatar-dashed' : 'mt-avatar', 'aria-hidden': true, children: label.avatar }),
                  j('b', { title: label.title, children: label.title }),
                  j('span', { className: 'mt-lane-total', title: t('lanes.count').replace('{n}', String(total)), children: String(total) }),
                ] }),
                j('span', { className: 'mt-lane-sub', title: label.sub, children: label.sub }),
              ] }),
              ...row.cells.map((cell, i) => j('div', {
                key: `${row.key}-${stageStates[i].name}`,
                className: 'mt-lane-cell' + (cell.length === 0 ? ' mt-lane-cell-empty' : ''),
                children: [
                  ...cell.slice(0, LANE_CELL_LIMIT).map((task) => js('button', {
                    key: task.key,
                    className: 'mt-lane-node mt-lane-node-' + dagChipOf(task.state),
                    title: task.title,
                    onClick: () => onOpen(task),
                    children: [
                      j('b', { children: task.id }),
                      j('span', { children: task.title }),
                      j('span', { className: 'mt-lane-tk', children: stateLabel(task.state) }),
                    ],
                  })),
                  /* CHG-85：格子内卡片过多时折叠成「还有 N 个」——否则一行被撑到几百 px、底部被面板裁掉。 */
                  cell.length > LANE_CELL_LIMIT ? j('span', {
                    className: 'mt-lane-more',
                    title: t('lanes.moreHint').replace('{n}', String(cell.length - LANE_CELL_LIMIT)),
                    children: t('lanes.more').replace('{n}', String(cell.length - LANE_CELL_LIMIT)),
                  }) : null,
                  /* 整行没有任务：末格给「无进行中任务」（design 的验收员行） */
                  cell.length === 0 && total === 0 && i === stageStates.length - 1 ? j('span', { className: 'mt-lane-empty', children: t('lanes.emptyRow') }) : null,
                ],
              })),
            ] })
          }),
        js('p', { className: 'mt-lanes-note', children: [
          j('svg', {
            width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
            children: [
              j('path', { d: 'M8 2.2 14 13H2z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
              j('path', { d: 'M8 6v3.4M8 11.1v.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
            ],
          }),
          j('span', { children: [j('b', { children: t('lanes.noteLead') }), t('lanes.noteBody')] }),
        ] }),
      ] })
    }

    /**
     * 门禁裁决区（CHG-86 / M2-C，FR-5.1~5.2；**UI-1 过门条件**）。
     *
     * 修复的断链：默认门禁链是 `['review','archive']`，任务 done 后进 `gate:review`；
     * 此前详情抽屉**没有任何裁决写路径**（只有队长工具），任务永远到不了 done，
     * 下游依赖、归档与成本管线全部悬空。现在 drawer 内直接给按钮 → `reviewTask`。
     *
     * 口径（与 host 侧 `reviewTask` 一一对应，不在前端重实现规则）：
     *  - review / verify 门：**强制交叉审查** —— 审查人必选，且不能是实现者本人
     *    （本人选项 disabled + 明确提示，host 侧也会以 MT_CROSS_REVIEW 拒绝）；
     *  - archive 门：不是人工裁决门，host 按 deliverableSpec 约定路径做**落位校验**
     *    （FR-10.4），只给「重新校验」一个动作，绝不采信模型自述「已归档」；
     *  - 打回（fail）必须写清理由（host 侧校验非空 reason）；
     *  - 打回预算超限（needs-human / MT_REJECT_BUDGET）：人工二次确认后带 confirm=true 放行。
     */
    function GateReview({ t, api, teamId, taskId, detail, readOnly, memberName, members: roster, onDone, onError }) {
      const state = String(detail?.state ?? '')
      const gate = state.startsWith('gate:') ? state.slice('gate:'.length) : ''
      /* CHG-86：名册优先用面板**已经加载好的** board.members —— 离线团队没有活动会话，
         `getBoard` 返回 unavailable，审查人下拉会是空的（等于无法裁决）。只有外层没给名册时
         才回落到 getBoard（在线路径）。 */
      const hasRoster = Array.isArray(roster) && roster.length > 0
      /* CHG-87 §1.3：只有 review 门要选审查人；verify 门没有人审（host 跑命令），archive 门是落位校验 */
      const needsRoster = gate === 'review'
      const [fetched, setFetched] = react.useState(null)
      const [reviewer, setReviewer] = react.useState('')
      const [reason, setReason] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState(null)
      /* CHG-87 §1.2/§1.3：verify 门的运行态 / 最近一次返回 / 「宿主没有 subprocess」降级态 */
      const [running, setRunning] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const [noSubprocess, setNoSubprocess] = react.useState(false)
      react.useEffect(() => {
        if (hasRoster || !needsRoster) return undefined
        if (!teamId || typeof api?.getBoard !== 'function') { setFetched([]); return undefined }
        let alive = true
        api.getBoard({ teamId }).then((r) => {
          if (!alive) return
          setFetched((r?.board?.members ?? []).map((member) => ({
            id: String(member.id),
            name: String(member.instanceName ?? member.id),
            status: member.status,
          })))
        }).catch(() => { if (alive) setFetched([]) })
        return () => { alive = false }
      }, [gate, teamId, api, hasRoster, needsRoster])
      if (!gate) return null
      const isArchiveGate = gate === 'archive'
      const isVerifyGate = gate === 'verify'
      /* 契约 §1.1：任务输入里的 verifyCommand（argv 必填数组、cwd 可选） */
      const verifyCommand = detail?.input?.verifyCommand ?? null
      const verifyArgv = Array.isArray(verifyCommand?.argv) ? verifyCommand.argv.map((part) => String(part)) : []
      const verifyCwd = verifyCommand?.cwd ? String(verifyCommand.cwd) : ''
      /* 契约 §2.2：投影带的最近一次 scope 审计（警告不阻断门禁，FR-5.4） */
      const scopeAudit = detail?.scopeAudit ?? null
      const scopeBad = Boolean(scopeAudit) && scopeAudit.ok === false && Array.isArray(scopeAudit.outOfScope) && scopeAudit.outOfScope.length > 0
      /* 实现者 = 任务主责（多主责时取第一个）；交叉审查禁的是「审自己」 */
      const implementer = String(detail?.assignee ?? (detail?.assignees ?? [])[0] ?? '')
      const list = hasRoster
        ? roster.map((member) => ({ id: String(member.id), name: String(member.instanceName ?? member.id), status: member.status }))
        : (fetched ?? [])
      const selfReview = Boolean(needsRoster && implementer && reviewer === implementer)
      /** review / archive 门的裁决提交（verify 门走 runVerify） */
      const submit = async (verdict) => {
        if (readOnly || busy) return
        if (verdict === 'fail' && !reason.trim()) { setNote(t('gate.needReason')); return }
        if (needsRoster && !reviewer) { setNote(t('gate.needReviewer')); return }
        setBusy(true)
        setNote(null)
        try {
          const r = await api.reviewTask({
            teamId,
            taskId,
            verdict,
            ...(needsRoster && reviewer ? { reviewerMemberId: reviewer } : {}),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          })
          if (r?.status === 'needs-human') {
            const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
              ? window.confirm(t('gate.budgetConfirm').replace('{n}', String(r.rejectCount ?? 0)))
              : false
            if (!ok) { setNote(r.message ?? t('gate.budgetBlocked')); return }
            const forced = await api.reviewTask({
              teamId,
              taskId,
              verdict,
              ...(reviewer ? { reviewerMemberId: reviewer } : {}),
              confirm: true,
            })
            setNote(forced?.note ?? forced?.message ?? t('gate.done'))
            if (forced?.status !== 'error' && forced?.status !== 'needs-human') { setReason(''); await onDone?.() }
            return
          }
          if (r?.status === 'error') {
            setNote(r.message ?? r.code ?? t('gate.failed'))
            onError?.(r.message ?? r.code)
            return
          }
          setNote(r?.note ?? t('gate.done'))
          setReason('')
          await onDone?.()
        } catch (e) {
          const message = String(e?.message ?? e)
          setNote(message)
          onError?.(message)
        } finally {
          setBusy(false)
        }
      }
      /**
       * 契约 §1.3：verify 门**真跑命令**。
       * verdict 固定传 'pass' —— host 在 verify 门忽略它、自己跑命令取退出码，
       * 前端不编造裁决语义（FR-5.3「绝不采信模型自述测试通过」）。
       * `force=true` 是「宿主没有 subprocess 服务」时的人工强制放行（confirm + 必填 reason）。
       */
      const runVerify = async (force) => {
        if (readOnly || busy || running) return
        if (force && !reason.trim()) { setNote(t('gate.needReason')); return }
        setRunning(true)
        setNote(null)
        try {
          const r = await api.reviewTask({
            teamId,
            taskId,
            verdict: 'pass',
            ...(force ? { confirm: true, reason: reason.trim() } : {}),
          })
          setResult(r ?? null)
          if (r?.status === 'error') {
            if (r.code === 'MT_UNAVAILABLE') { setNoSubprocess(true); setNote(t('gate.verifyUnavailable')) }
            else if (r.code === 'MT_VERIFY_NO_COMMAND') setNote(t('gate.verifyNoCommand'))
            else setNote(r.message ?? r.code ?? t('gate.failed'))
            if (r.code !== 'MT_UNAVAILABLE' && r.code !== 'MT_VERIFY_NO_COMMAND') onError?.(r.message ?? r.code)
            return
          }
          setNote(force ? t('gate.verifyForced') : (r?.note ?? t('gate.done')))
          setReason('')
          await onDone?.()
        } catch (e) {
          const message = String(e?.message ?? e)
          setNote(message)
          onError?.(message)
        } finally {
          setRunning(false)
        }
      }
      const exitKnown = Boolean(result) && result.exitCode !== undefined && result.exitCode !== null
      return js('section', { className: 'mt-sec mt-gate-review', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: isVerifyGate ? t('gate.verifyTitle') : t('gate.title') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: gateLabel(gate) }),
        ] }),
        j('p', { className: 'mt-gate-current', children: t('gate.current').replace('{gate}', gateLabel(gate)).replace('{state}', stateLabel(state)) }),
        /* 越界写入黄条：**只警告不阻断**（FR-5.4） */
        scopeBad ? js('div', { className: 'mt-note mt-note-warn', role: 'status', children: [
          j('span', { children: t('scope.warn').replace('{n}', String(scopeAudit.outOfScope.length)).replace('{files}', scopeAudit.outOfScope.join('、')) }),
          j('span', { className: 'mt-hint', children: t('scope.warnNote') }),
        ] }) : null,
        /* ── verify 门：要执行的命令 + 运行结果 + 降级放行 ── */
        isVerifyGate ? js('div', { children: [
          j('p', { className: 'mt-hint', children: t('gate.verifyNote') }),
          verifyArgv.length > 0
            ? js('p', { className: 'mt-gate-cmd', children: [
              j('span', { children: t('gate.verifyCmd') }),
              j('code', { children: verifyArgv.join(' ') }),
              verifyCwd ? j('span', { className: 'mt-gate-cwd', children: t('gate.verifyCwd').replace('{cwd}', verifyCwd) }) : null,
            ] })
            : j('p', { className: 'mt-form-note', children: t('gate.verifyNoCommand') }),
          running ? j('p', { className: 'mt-gate-spin', role: 'status', children: t('gate.verifyRunning') }) : null,
          exitKnown ? js('div', { className: 'mt-gate-result', children: [
            js('div', { className: 'mt-gate-result-meta', children: [
              j('span', {
                className: 'mt-exit ' + (Number(result.exitCode) === 0 ? 'mt-exit-ok' : 'mt-exit-fail'),
                children: t('gate.verifyExit').replace('{code}', String(result.exitCode)),
              }),
              result.durationMs !== undefined && result.durationMs !== null
                ? j('span', { children: t('gate.verifyDuration').replace('{ms}', String(result.durationMs)) })
                : null,
              result.signal ? j('span', { children: t('gate.verifySignal').replace('{signal}', String(result.signal)) }) : null,
            ] }),
            j('span', { className: 'mt-hint', children: t('gate.verifyOutput') }),
            j('pre', { className: 'mt-ev-code', children: result.outputTail ? String(result.outputTail) : t('gate.verifyNoOutput') }),
          ] }) : null,
          /* 合同 §1.3：宿主没有 subprocess 服务 → 明确提示 + 人工强制放行（理由必填） */
          noSubprocess ? js('div', { children: [
            j('p', { className: 'mt-form-note', children: t('gate.verifyUnavailable') }),
            j('textarea', {
              className: 'mt-input mt-gate-reason',
              value: reason,
              rows: 2,
              placeholder: t('gate.reasonPlaceholder'),
              'aria-label': t('gate.reasonPlaceholder'),
              disabled: readOnly || busy || running,
              onChange: (e) => setReason(e.target.value),
            }),
            j('button', {
              className: 'mt-btn mt-btn-danger',
              disabled: readOnly || busy || running || !reason.trim(),
              title: readOnly ? t('task.readonlyTitle') : t('gate.verifyForce'),
              onClick: () => runVerify(true),
              children: t('gate.verifyForce'),
            }),
          ] }) : null,
        ] })
          : isArchiveGate
            ? j('p', { className: 'mt-hint', children: t('gate.archiveNote') })
            : js('div', { className: 'mt-form-row', children: [
              j('label', { htmlFor: 'mt-gate-reviewer', children: t('gate.reviewerLabel') }),
              js('select', {
                id: 'mt-gate-reviewer',
                className: 'mt-input',
                value: reviewer,
                disabled: readOnly || busy,
                'aria-describedby': selfReview ? 'mt-gate-selfreview' : undefined,
                onChange: (e) => { setReviewer(e.target.value); setNote(null) },
                children: [
                  j('option', { value: '', children: t('gate.reviewerPick') }),
                  ...list.map((member) => {
                    const self = member.id === implementer
                    return j('option', {
                      key: member.id,
                      value: member.id,
                      disabled: self,
                      title: self ? t('gate.selfReview') : undefined,
                      children: self ? `${member.name} · ${t('gate.selfReview')}` : member.name,
                    })
                  }),
                ],
              }),
            ] }),
        selfReview ? j('p', { id: 'mt-gate-selfreview', className: 'mt-hint mt-danger-ink', children: t('gate.selfReview') }) : null,
        /* 打回理由：review 门常显；verify 门只在降级放行时出现（上面那块） */
        needsRoster ? j('textarea', {
          className: 'mt-input mt-gate-reason',
          value: reason,
          rows: 2,
          placeholder: t('gate.reasonPlaceholder'),
          'aria-label': t('gate.reasonPlaceholder'),
          disabled: readOnly || busy,
          onChange: (e) => setReason(e.target.value),
        }) : null,
        js('div', { className: 'mt-detail-actions', role: 'toolbar', 'aria-label': t('gate.title'), children: [
          isVerifyGate
            ? j('button', {
              className: 'mt-btn mt-btn-primary',
              disabled: readOnly || busy || running || verifyArgv.length === 0,
              title: readOnly ? t('task.readonlyTitle') : t('gate.verifyRun'),
              onClick: () => runVerify(false),
              children: running ? t('gate.verifyRunning') : t('gate.verifyRun'),
            })
            : j('button', {
              className: 'mt-btn mt-btn-primary',
              disabled: readOnly || busy || (needsRoster && !reviewer) || selfReview,
              title: readOnly ? t('task.readonlyTitle') : isArchiveGate ? t('gate.archiveNote') : t('gate.pass'),
              onClick: () => submit('pass'),
              children: isArchiveGate ? t('gate.recheck') : t('gate.pass'),
            }),
          needsRoster ? j('button', {
            className: 'mt-btn mt-btn-danger',
            disabled: readOnly || busy || !reviewer || selfReview,
            title: readOnly ? t('task.readonlyTitle') : t('gate.fail'),
            onClick: () => submit('fail'),
            children: t('gate.fail'),
          }) : null,
        ] }),
        note ? j('p', { className: 'mt-form-note', role: 'status', children: note }) : null,
      ] })
    }

    /**
     * 写入范围审计（CHG-87 §2.3 / FR-5.4）：「声明范围 / 申报文件 / 越界文件」三段。
     * 无 `scopeAudit` 时**整块不渲染**；`ok === true` 显示 ✓ 未越界；越界只警告不阻断。
     */
    function ScopeAuditBlock({ t, audit }) {
      if (!audit || typeof audit !== 'object') return null
      const declared = Array.isArray(audit.writeScopes) ? audit.writeScopes.map(String) : []
      const files = Array.isArray(audit.declared) ? audit.declared.map(String) : []
      const out = Array.isArray(audit.outOfScope) ? audit.outOfScope.map(String) : []
      const ok = audit.ok === true
      const chip = (value, bad) => j('span', { key: value, className: bad ? 'mt-scope-chip mt-scope-chip-bad' : 'mt-scope-chip', children: value })
      const row = (key, label, values, empty = t('scope.empty'), bad = false) => js('div', { key, className: 'mt-scope-row', children: [
        j('span', { className: 'mt-scope-k', children: label }),
        j('span', { className: 'mt-scope-v', children: values.length > 0 ? values.map((value) => chip(value, bad)) : [j('span', { className: 'mt-hint', children: empty })] }),
      ] })
      return js('section', { className: 'mt-sec mt-scope-audit', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('scope.title') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: ok ? 'mt-n mt-scope-ok' : 'mt-n mt-scope-bad', children: ok ? t('scope.ok') : t('scope.bad').replace('{n}', String(out.length)) }),
        ] }),
        row('declared', t('scope.declared'), declared),
        row('files', t('scope.files'), files),
        row('out', t('scope.outOfScope'), out, t('scope.empty'), true),
        audit.checkedAt ? j('p', { className: 'mt-hint', children: t('scope.checkedAt').replace('{time}', fmtClock(audit.checkedAt)) }) : null,
      ] })
    }

    /**
     * 共享写范围（CHG-171 / R41 串行链收尾）：claim 闸门（CHG-161）的**事前**可见化——
     * 任务详情里直接点名「和谁共享写范围、现在等谁」。blocking = 此刻会被闸门拦；
     * queued = 排队串行（先到先得，后到的 claim 被拦）。无 sharedScopes 时整块不渲染。
     */
    function SharedScopesBlock({ t, shared }) {
      if (!shared || typeof shared !== 'object') return null
      const blocking = Array.isArray(shared.blocking) ? shared.blocking : []
      const queued = Array.isArray(shared.queued) ? shared.queued : []
      if (blocking.length === 0 && queued.length === 0) return null
      const peers = (list) => list.length > 0
        ? list.map((p) => j('span', { key: p.taskId, className: 'mt-scope-chip', children: `${String(p.taskId)} ${String(p.title ?? '')}`.trim() }))
        : [j('span', { className: 'mt-hint', children: t('scope.shared.none') })]
      return js('section', { className: 'mt-sec mt-shared-scopes', children: [
        js('div', { className: 'mt-dsec-head', children: [
          j('h4', { children: t('scope.shared.title') }),
          j('span', { className: 'mt-line', 'aria-hidden': true }),
          j('span', { className: 'mt-n', children: String(blocking.length + queued.length) }),
        ] }),
        js('div', { className: 'mt-scope-row', children: [
          j('span', { className: 'mt-scope-k', children: t('scope.shared.blocking') }),
          j('span', { className: 'mt-scope-v', children: peers(blocking) }),
        ] }),
        js('div', { className: 'mt-scope-row', children: [
          j('span', { className: 'mt-scope-k', children: t('scope.shared.queued') }),
          j('span', { className: 'mt-scope-v', children: peers(queued) }),
        ] }),
        j('p', { className: 'mt-hint', children: t('scope.shared.note') }),
      ] })
    }

    /**
     * CHG-185：成本归因的「没有数字」三档判定 —— 纯函数，可单测。
     *
     * 为什么单独抽出来：旧实现把三种完全不同的事压进一句话（离线读不到 sidecar / 在线但
     * 还没产生用量 / 读到了但计量字段缺失），用户无法判断要不要处理。判定收在这里，渲染只
     * 按 tone 出；**非 ok 的 tone 一律渲染 `—`**（绝不显示伪造的 0）。
     *
     * @param {'offline'|'loaded'} loadState sidecar 是否读到（只读 / 离线团队 / 无端点 = offline）
     * @param {object|null|undefined} tokens  getTokens 的 tokens 视图（null = 读到了但没有；undefined = 还在读）
     * @param {(key: string) => string} t     文案查表（注入而非闭包，保证本函数无副作用、可单测）
     * @returns {{tone: 'offline'|'no-usage'|'partial'|'loading'|'ok', text: string}}
     */
    function costDegradeOf(loadState, tokens, t) {
      if (loadState === 'offline') return { tone: 'offline', text: t('cost.offline') }
      /* 还在读（undefined）不是「没有用量」——不猜，值留 —、提示先不出 */
      if (tokens === undefined) return { tone: 'loading', text: '' }
      if (!tokens) return { tone: 'no-usage', text: t('cost.noUsage') }
      /* 用量口径 = 四桶之和（buildTokens 视图按成员分桶，没有扁平 input/output/cached 字段） */
      const used = Object.values(tokens.totals ?? {}).reduce((sum, bucket) => sum
        + Number(bucket?.uncachedInput ?? 0) + Number(bucket?.cacheRead ?? 0)
        + Number(bucket?.cacheWrite ?? 0) + Number(bucket?.output ?? 0), 0)
      if (!(used > 0)) return { tone: 'no-usage', text: t('cost.noUsage') }
      /* 计量完整度以 sidecar 的 coverage 三态为单一来源（coverageOfFile 派生），不在这里另立口径 */
      const partial = tokens.coverage === 'partial' || tokens.coverage === 'none'
      return partial ? { tone: 'partial', text: t('cost.partial') } : { tone: 'ok', text: '' }
    }
