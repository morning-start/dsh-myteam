    /* ── G2 名册卡：一张卡一个角色（design-v2/p-roster.html + member-menu.html）
     * 实现者 ×2 是同一张卡的两个实例行；队长不在名册里（roster.captainNote）。
     * 实例行 = iname / 在跑任务 / 交付 x/y · token；⋯ 展开实例管理菜单（指导 / 暂停 / 归档 / 移除 + 影响面）。 */
    function MemberCard({ t, roleId, role, members, tasks, tokens, teamName, taskTitle, readOnly, api, teamId, onOpen, onChanged, onError, onNotice }) {
      const [menuFor, setMenuFor] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      /* A10（CHG-163）：「指导」输入框的局部状态——面板里唯一「给成员发消息」的写入口。
       * 为什么不复用 `busy`：指导是长文本输入 + 独立的发送中态，和四档管理动作的忙碌态混用会让
       * 输入框在别的操作进行时被禁用（用户正在打字却突然不能输入）。 */
      const [steerOpen, setSteerOpen] = react.useState(false)
      const [steerDraft, setSteerDraft] = react.useState('')
      const [steerBusy, setSteerBusy] = react.useState(false)
      /** 未送达警示文案（`delivered:false`）：与成功 notice 走**不同**的视觉（warning 边框） */
      const [steerWarn, setSteerWarn] = react.useState(null)
      const list = members ?? []
      const roleName = role?.name ?? roleLabel(roleId)
      const words = role?.interestWords ?? []
      const rows = list.map((member) => ({
        member,
        delivery: deliveryOf(tasks, member.id),
        tokenTotal: tokenTotalOf(tokens, member.id),
        task: (tasks ?? []).find((item) => item.id === member.currentTaskId),
      }))
      const running = list.some((member) => member.status === 'active' && member.currentTaskId)
      const gate = rows.some((row) => String(row.task?.state ?? '').startsWith('gate'))
      const idle = list.length > 0 && list.every((member) => member.status === 'active' && !member.currentTaskId)
      const others = (role?.memberships ?? []).filter((membership) => membership.teamId !== teamId && membership.online)
      const gateTask = rows.find((row) => String(row.task?.state ?? '').startsWith('gate'))?.task
      /** 实例当前任务标题（名册显示任务名而非 id；无标题时回落 id） */
      const instanceTaskTitle = (m) => taskTitle?.(m.currentTaskId) ?? (tasks ?? []).find((task) => task.id === m.currentTaskId)?.title
      const act = async (op, member) => {
        if (readOnly || busy || !api) return
        /* CHG-187（FR-32 支柱一）：有子成员时先二次确认「将一并释放 N 个子成员」，再带 `cascade:true`
         * 走倒序级联（叶子先、父最后）。不带 cascade 会被 host 以 MT_HAS_CHILDREN 拒（账本零写入）——
         * 前端先问一句，比让用户点完看到错误更省事，也避免「以为只释放了一个」的误操作。 */
        const children = Number(member.childCount ?? 0)
        const cascade = op !== 'restore' && children > 0
        if (cascade && !window.confirm(t('roster.releaseCascadeConfirm').replace('{n}', String(children)))) return
        setBusy(true)
        try {
          let r = await api.memberOp({ teamId, memberId: member.id, op, confirm: op === 'remove' ? false : undefined, ...(cascade ? { cascade: true } : {}) })
          if (r?.status === 'confirm-required' && window.confirm(t('member.removeConfirm'))) {
            /* CHG-202x（P0-6）：第二次调用**必须**带上 cascade——服务端先返回 confirm-required，
             * 之后才做派生树检查（releaseOrder(..., cascade=false)）；丢了 cascade 会让「点了两次确认、
             * 看到『将一并释放 N 个子成员』」的这一单必然被 MT_HAS_CHILDREN 拒。 */
            r = await api.memberOp({ teamId, memberId: member.id, op, confirm: true, ...(cascade ? { cascade: true } : {}) })
          }
          if (r?.status === 'error' || r?.status === 'drain-pending') onError?.(r.message ?? r.note ?? 'member op failed')
          else onError?.(null)
          setMenuFor(null)
          await onChanged?.()
        } catch (e) {
          onError?.(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      /**
       * 展开/收起实例菜单。收起时顺手清掉指导输入框状态——否则下次打开会带着上一轮的草稿/警示，
       * 看起来像是「刚刚又失败了」。
       */
      const toggleMenu = (id) => {
        setSteerOpen(false)
        setSteerDraft('')
        setSteerWarn(null)
        setMenuFor(menuFor === id ? null : id)
      }
      /**
       * 指导（FR-14.2，A10 / CHG-163）：真的写——`memberOp(op:'steer')` 由 host 落
       * `message.sent(kind=steer)` 并立即 followup 投递。
       *
       * 两条口径（不要合并成「成功」一种）：
       *  - `status:'steered' && delivered:true` → 成功 notice；
       *  - `status:'steered' && delivered:false` → **警示**：账本已记、成员会话不在线（未送达）。
       *    把「记下来了」显示成「送到了」就是假成功（项目纪律）。
       * 成员正在跑任务时带 `taskId`（host 也会兜底补），它才知道指导的是哪一单。
       */
      const sendSteer = async (member) => {
        if (readOnly || steerBusy || !api) return
        const content = String(steerDraft ?? '').trim()
        if (!content) return
        setSteerBusy(true)
        setSteerWarn(null)
        try {
          const r = await api.memberOp({
            teamId,
            memberId: member.id,
            op: 'steer',
            content,
            ...(member.currentTaskId ? { taskId: member.currentTaskId } : {}),
          })
          if (r?.status === 'error' || r?.status === 'drain-pending') {
            onError?.(r.message ?? r.note ?? 'steer failed')
            return
          }
          setSteerDraft('')
          if (r?.status === 'steered' && r.delivered === false) {
            // 账本落了但会话不在线：留在菜单里用警示样式说清，不关窗、不报成功
            setSteerWarn(t('roster.menu.steerUndelivered').replace('{name}', String(member.instanceName ?? member.id)))
            await onChanged?.()
            return
          }
          setSteerWarn(null)
          setSteerOpen(false)
          setMenuFor(null)
          onError?.(null)
          onNotice?.(t('roster.menu.steerSent').replace('{name}', String(member.instanceName ?? member.id)))
          await onChanged?.()
        } catch (e) {
          onError?.(String(e?.message ?? e))
        } finally {
          setSteerBusy(false)
        }
      }
      const statusChip = gate
        ? j('span', { className: 'mt-chip mt-chip-gate', children: [j('span', { className: 'mt-shape mt-shape-gate', 'aria-hidden': true }), t('roster.gate')] })
        : running
          ? j('span', { className: 'mt-chip mt-chip-run', children: [j('span', { className: 'mt-shape mt-shape-run', 'aria-hidden': true }), t('roster.running')] })
          : j('span', { className: 'mt-chip mt-chip-idle', children: [j('span', { className: 'mt-shape mt-shape-idle', 'aria-hidden': true }), t('roster.idle')] })
      const menuRow = menuFor ? rows.find((row) => row.member.id === menuFor) : undefined
      const menu = menuRow ? (() => {
        const member = menuRow.member
        const runningCount = (tasks ?? []).filter((task) => (task.assignees ?? []).includes(member.id)
          && !['done', 'failed', 'cancelled', 'blocked'].includes(String(task.state ?? ''))).length
        const gateCount = (tasks ?? []).filter((task) => (task.assignees ?? []).includes(member.id)
          && String(task.state ?? '').startsWith('gate')).length
        const item = (op, labelKey, ico, extra) => j('button', {
          className: extra?.danger ? 'mt-menu-item mt-menu-item-danger mt-link-danger' : 'mt-menu-item',
          role: 'menuitem',
          disabled: readOnly || busy || Boolean(extra?.disabled),
          title: extra?.title,
          /* `extra.onAct` 优先：没有宿主写路径的项（steer）走「可用 + 明确说明」，
           * 不再留永久 disabled 的假按钮（R34 / UI-1：看起来能点但永远点不动 = 欺骗）。 */
          onClick: () => { if (!extra?.disabled) (extra?.onAct ?? (() => act(op, member)))() },
          children: [j('span', { className: 'mt-menu-ico', 'aria-hidden': true, children: ico }), t(labelKey), extra?.kbd ? j('span', { className: 'mt-kbd', children: extra.kbd }) : null],
        })
        return js('div', { className: 'mt-menupop mt-member-actions', role: 'menu', children: [
          j('div', { className: 'mt-menu-label', children: t('roster.menu.label').replace('{name}', member.instanceName) }),
          /* 引导 / 接管（FR-14.2，A10 / CHG-163）：**真的写**——点开输入框，发送走
           * `memberOp(op:'steer')`（host 落 message.sent 并立即投递）。
           * 只读团队（离线）没有写路径 → 隐藏入口：留一个「点了必然失败」的按钮就是欺骗（R34 / UI-1）。 */
          readOnly ? null : item('steer', 'roster.menu.steer', '→', {
            title: t('roster.menu.steerHint'),
            kbd: 'steer',
            disabled: member.status === 'removed' || member.status === 'archived',
            onAct: () => { setSteerWarn(null); setSteerDraft(''); setSteerOpen(true) },
          }),
          /* 指导输入框：内联在菜单里（不弹窗——指导是「顺手补一句」，弹窗会打断看板上下文） */
          steerOpen ? js('div', { className: 'mt-menu-steer', children: [
            j('textarea', {
              'aria-label': t('roster.menu.steerPlaceholder'),
              placeholder: t('roster.menu.steerPlaceholder'),
              value: steerDraft,
              disabled: steerBusy,
              onChange: (event) => { setSteerDraft(event.target.value); setSteerWarn(null) },
            }),
            js('div', { className: 'mt-menu-steer-actions', children: [
              j('button', {
                className: 'mt-btn mt-btn-sm',
                disabled: steerBusy,
                onClick: () => { setSteerOpen(false); setSteerDraft(''); setSteerWarn(null) },
                children: t('roster.menu.steerCancel'),
              }),
              j('button', {
                className: 'mt-btn mt-btn-primary mt-btn-sm',
                // 空内容不发送（后端也会 MT_VALIDATION，前端先拦一道）
                disabled: steerBusy || String(steerDraft ?? '').trim().length === 0,
                onClick: () => sendSteer(member),
                children: steerBusy ? t('state.loading') : t('roster.menu.steerSend'),
              }),
            ] }),
            /* 未送达：警示样式（warning 边框），不是成功提示 */
            steerWarn ? j('div', { className: 'mt-menu-steer-alert', role: 'alert', children: steerWarn }) : null,
          ] }) : null,
          item('suspend', 'roster.menu.suspend', '‖', { disabled: member.status !== 'active' }),
          j('div', { className: 'mt-menu-sep', 'aria-hidden': true }),
          item('archive', 'roster.menu.archive', '▤', { disabled: !['active', 'suspended'].includes(member.status) }),
          item('remove', 'roster.menu.remove', '✕', { danger: true, disabled: member.status === 'removed' }),
          member.status === 'suspended' || member.status === 'archived' ? item('restore', 'roster.menu.restore', '↺', {}) : null,
          j('div', { className: 'mt-menu-note', children: t('roster.menu.impact').replace('{running}', String(runningCount)).replace('{gate}', String(gateCount)) }),
          readOnly ? j('div', { className: 'mt-menu-note', children: t('roster.menu.readonly') }) : null,
        ] })
      })() : null
      return js('article', {
        className: 'mt-roster-card' + (gate ? ' mt-roster-card-gate' : ''),
        children: [
          js('div', { className: 'mt-roster-top', children: [
            j('span', { className: `mt-avatar ${avatarClassOf(roleId)}`, 'aria-hidden': true, children: avatarCharOf(roleName, roleId) }),
            js('div', { className: 'mt-roster-body', children: [
              js('div', { className: 'mt-roster-title', children: [
                j('strong', { children: roleName }),
                j('span', { className: 'mt-chip mt-chip-plain', children: t('roster.instanceCount').replace('{n}', String(list.length)) }),
              ] }),
              j('div', { className: 'mt-roster-sub', children: role?.model ? `${role.model.model || role.model.provider} · ${t('roster.inheritRoute')}` : t('roster.inheritRoute') }),
              js('div', { className: 'mt-roster-words', children: [
                j('span', { className: 'mt-roster-rowlabel', children: t('roles.interest') }),
                ...(words.length > 0
                  ? words.map((word) => j('span', { key: word, className: 'mt-rolechip', children: word }))
                  : [j('span', { className: 'mt-hint', children: t('roles.interestEmpty') })]),
              ] }),
            ] }),
            statusChip,
          ] }),
          /* CHG-202z（FR-32 · M3-5）：名册树**父子缩进**——有父成员的实例按深度缩进（16px/层），
           * 与深度 chip / 父成员提示同一份数据。一级成员不缩进（避免每条都往右挪）。 */
          ...rows.map((row) => js('div', {
            className: 'mt-inst-row' + (row.member.parentMemberId ? ' mt-inst-row-child' : ''),
            key: row.member.id,
            style: row.member.parentMemberId ? { paddingLeft: `${16 * Math.max(1, Number(row.member.depth ?? 1))}px` } : undefined,
            'aria-level': Number(row.member.depth ?? 0) + 1,
            children: [
            j('span', { className: 'mt-iname', children: row.member.instanceName }),
            /* CHG-187（FR-32 支柱一）：派生深度 chip——有父成员才显示（一级成员不显示，避免噪音）；
             * `title` 给出父成员 id，面板上就能顺着树往回找。 */
            row.member.parentMemberId
              ? j('span', {
                className: 'mt-mini-chip',
                title: t('roster.parentHint').replace('{id}', String(row.member.parentMemberId)),
                children: t('roster.depthChip').replace('{n}', String(row.member.depth ?? 0)),
              })
              : null,
            row.task
              ? j('button', {
                className: 'mt-minichip' + (String(row.task.state ?? '').startsWith('gate') ? ' mt-minichip-gate' : ''),
                title: instanceTaskTitle(row.member) ?? row.task.title,
                onClick: () => onOpen?.(row.member.currentTaskId),
                children: `${row.task.id} ${instanceTaskTitle(row.member) ?? row.task.title}`,
              })
              : j('span', { className: 'mt-minichip', children: t('roster.noTask') }),
            j('span', { className: 'mt-inst-right', children: `${t('roster.delivery').replace('{done}', String(row.delivery.done)).replace('{total}', String(row.delivery.total))} · ${fmtTokenCount(row.tokenTotal)}` }),
            j('button', {
              className: 'mt-inst-menu-btn',
              'aria-expanded': menuFor === row.member.id,
              'aria-label': t('roster.menu.label').replace('{name}', row.member.instanceName),
              onClick: () => toggleMenu(row.member.id),
              children: '⋯',
            }),
          ] })),
          others.length > 0 ? js('div', { className: 'mt-roster-row', children: others.slice(0, 2).map((membership) => j('span', {
            key: `${membership.teamId}-${membership.instanceName}`,
            className: 'mt-minichip mt-minichip-gate',
            children: t('roster.sameRoleOtherTeam').replace('{team}', teamName?.(membership.teamId) || membership.teamName || membership.teamId),
          })) }) : null,
          js('div', { className: 'mt-roster-foot', children: [
            j('span', {
              className: gate ? 'mt-roster-foot-gate' : 'mt-hint',
              children: gate
                ? t('roster.gateNote')
                : list.length > 1
                  ? t('roster.multiNote').replace('{n}', String(list.length))
                  : idle ? t('roster.idleNote') : t('roster.activeNote').replace('{task}', rows.find((row) => row.task)?.task.title ?? '—'),
            }),
            gateTask ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => onOpen?.(gateTask.id), children: t('roster.gateAction') }) : null,
          ] }),
          menu,
        ],
      })
    }

    /** 名册末尾的「召唤角色」虚线卡（design-v2/p-roster.html 最后一格） */
    function RosterSummonCard({ t, onSummon }) {
      return js('button', {
        className: 'mt-roster-card mt-roster-card-summon',
        onClick: () => onSummon?.(),
        children: [
          j('span', { className: 'mt-roster-summon-ico', 'aria-hidden': true, children: '＋' }),
          j('span', { className: 'mt-roster-summon-title', children: t('roster.summon') }),
          j('span', { className: 'mt-roster-summon-hint', children: t('roster.summonCardHint') }),
        ],
      })
    }

    /**
     * `/myteam` 命令解析（CHG-87 §5.3 / FR-15.1）。
     *
     * 只有**以 `/myteam` 开头**才当命令（句中出现按普通文本 —— 闭合命名空间）；
     * `+id` 启用、`-id` 卸载、可累加：`/myteam+researcher+reviewer` / `/myteam-researcher`。
     * 角色 id 本身含 `-`（`tech-writer`）也能正确解析：只按 `+` 切 token，
     * token 首字符是 `-` 才当卸载标记。
     *
     * @returns {{roles: string[], remove: string[]}|null} 不是命令 → `null`
     */
    const parseMyteamCommand = (text) => {
      const raw = String(text ?? '').trim()
      if (!raw.startsWith('/myteam')) return null
      const rest = raw.slice('/myteam'.length)
      const roles = []
      const remove = []
      for (const token of rest.split('+')) {
        const part = token.trim()
        if (!part) continue
        if (part.startsWith('-')) {
          const id = part.slice(1).trim()
          if (id) remove.push(id)
        } else {
          roles.push(part)
        }
      }
      return { roles, remove }
    }

    /**
     * 单角色调用小卡（CHG-87 §5.3 / FR-16.1）。
     *
     * **挂载点选择（已在报告里说明）**：面板没有会话输入框 —— composer 属于宿主，
     * 插件只注册 slot；硬塞一个全局输入框会抢宿主键盘。按 Lead 给的兜底方案，
     * 落在团队页（队员 tab）：输入 `/myteam+<roleId>` / `/myteam-<roleId>` → `api.applyRoles`。
     */
    function GuestRoleCallCard({ t, api, teamId, readOnly, onChanged, onNotice, onError }) {
      const [value, setValue] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const submit = async () => {
        if (busy) return
        const parsed = parseMyteamCommand(value)
        if (!parsed) { onNotice?.(t('rolecall.notCommand')); return }
        if (parsed.roles.length === 0 && parsed.remove.length === 0) { onNotice?.(t('rolecall.nothing')); return }
        if (readOnly) { onNotice?.(t('rolecall.readonly')); return }
        if (typeof api?.applyRoles !== 'function') { onNotice?.(t('rolecall.unavailable')); return }
        setBusy(true)
        setResult(null)
        try {
          const r = await api.applyRoles({
            teamId,
            roles: parsed.roles,
            ...(parsed.remove.length > 0 ? { remove: parsed.remove } : {}),
          })
          setResult(r ?? null)
          if (r?.status === 'error') {
            /* 解析失败 / 角色不存在：显示 host 返回的 message，不发消息（契约 §5.3） */
            onError?.(r.message ?? r.code ?? t('applyRoles.error'))
            return
          }
          if (parsed.roles.length > 0) onNotice?.(t('rolecall.applied').replace('{roles}', parsed.roles.join('、')))
          else onNotice?.(t('rolecall.removed').replace('{roles}', parsed.remove.join('、')))
          setValue('')
          await onChanged?.()
        } catch (e) {
          onError?.(t('rolecall.failed').replace('{message}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const roles = Array.isArray(result?.roles) ? result.roles : []
      const removed = Array.isArray(result?.removed) ? result.removed.map((id) => String(id)) : []
      return js('div', { className: 'mt-rolecall', children: [
        j('b', { children: t('rolecall.title') }),
        j('p', { className: 'mt-rolecall-hint', children: t('rolecall.desc') }),
        js('div', { className: 'mt-rolecall-row', children: [
          j('input', {
            className: 'mt-input',
            value,
            placeholder: t('rolecall.placeholder'),
            'aria-label': t('rolecall.title'),
            autoComplete: 'off',
            disabled: busy,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          }),
          j('button', { className: 'mt-btn mt-btn-primary mt-btn-sm', disabled: busy, onClick: submit, children: busy ? t('state.loading') : t('rolecall.apply') }),
        ] }),
        roles.length > 0 ? js('div', { className: 'mt-rolecall-chips', children: [
          j('span', { className: 'mt-hint', children: t('applyRoles.roles') }),
          ...roles.map((role, index) => j('span', {
            key: `role-${String(role?.roleId ?? index)}`,
            className: 'mt-mini-chip mt-mini-chip-lead',
            children: `${String(role?.roleId ?? '—')} · ${String(role?.name ?? '—')}`,
          })),
        ] }) : null,
        removed.length > 0 ? js('div', { className: 'mt-rolecall-chips', children: [
          j('span', { className: 'mt-hint', children: t('applyRoles.removed') }),
          ...removed.map((id, index) => j('span', { key: `rm-${index}`, className: 'mt-mini-chip mt-mini-chip-coop', children: `− ${id}` })),
        ] }) : null,
        typeof result?.promptSection === 'string' && result.promptSection.trim()
          ? j('pre', { className: 'mt-ev-code', children: result.promptSection.trim() })
          : null,
        typeof result?.note === 'string' && result.note.trim() ? j('p', { className: 'mt-rolecall-hint', children: result.note.trim() }) : null,
        typeof result?.filePath === 'string' && result.filePath ? j('p', { className: 'mt-rolecall-hint', children: t('rolecall.filePath').replace('{path}', result.filePath) }) : null,
      ] })
    }
