    function DiagChips({ t, diagnosis }) {
      if (!diagnosis?.codes?.length) return null
      const textOf = (code) => {
        if (code === 'deps-pending') return t('diag.deps-pending').replace('{deps}', (diagnosis.depsPending ?? []).join('、') || '—')
        if (code === 'dep-cancelled') return t('diag.dep-cancelled').replace('{deps}', (diagnosis.depsCancelled ?? []).join('、') || '—')
        if (code === 'no-role') return t('diag.no-role').replace('{role}', roleLabel(diagnosis.roleId))
        if (code === 'role-busy') return t('diag.role-busy').replace('{members}', (diagnosis.busyMembers ?? []).join('、') || '—')
        return t('diag.team-inactive')
      }
      return js('span', { className: 'mt-diag', children: diagnosis.codes.map((code) => j('span', {
        key: code,
        className: code === 'dep-cancelled' ? 'mt-diag-chip mt-chip-cancelled' : 'mt-diag-chip',
        title: `${t('diag.title')} · ${textOf(code)}`,
        children: textOf(code),
      })) })
    }
    function DiagFix({ t, api, teamId, taskId, diagnosis, readOnly, onFixed, expectedRevision }) {
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const [chosenRole, setChosenRole] = react.useState('')
      const fix = diagnosis?.fix
      if (!fix) return null
      const assignable = fix.assignable ?? []
      const roleSwap = fix.roleSwap ?? []
      const spawnRole = fix.spawnRole
      /* CHG-202x（P1-9）：已取消上游的依赖要能一键摘掉——否则下游永远不可领（死锁）。 */
      const depCancelled = fix.depCancelled
      if (assignable.length === 0 && roleSwap.length === 0 && !spawnRole && !depCancelled) return null
      const run = async (fn, message) => {
        if (readOnly || busy) return
        setErr(null)
        setBusy(true)
        try {
          await fn()
          onFixed?.(message)
        } catch (e) {
          setErr(t('diag.fixFailed').replace('{msg}', String(e?.message ?? e)))
        } finally {
          setBusy(false)
        }
      }
      const assign = (option) => run(async () => {
        const r = await api.assignTask({
          teamId,
          taskId,
          memberIds: [option.memberId],
          /* CHG-89（QA-4 乐观锁）：诊断修复也是写路径——详情页打开时的版本快照必须回传，
           * 否则「表单那条路有锁、诊断这条路没有」就是同一个洞开了两个口。 */
          ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
        })
        if (r?.code === 'MT_REVISION_CONFLICT') throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
        if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'assign failed')
      }, t('diag.fixAssignDone').replace('{member}', option.instanceName ?? option.memberId))
      const swapRole = (roleId) => {
        setChosenRole(roleId)
        if (!roleId) return
        run(async () => {
          const r = await api.updateTask({
            teamId,
            taskId,
            patch: { requiredRole: roleId },
            ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
          })
          if (r?.code === 'MT_REVISION_CONFLICT') throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
          if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'update failed')
        }, t('diag.fixRoleSwapDone').replace('{role}', roleLabel(roleId)))
      }
      /** 摘掉已取消上游：rescope 带 deps 补丁（结构性改动 → 在跑任务也走同一条出口） */
      const unlockDeps = () => run(async () => {
        const removed = depCancelled?.removed ?? []
        const r = await api.rescopeTask({
          teamId,
          taskId,
          reason: t('diag.fixUnlockDepsReason').replace('{deps}', removed.join('、')),
          patch: { deps: depCancelled?.remaining ?? [] },
          ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
        })
        if (r?.code === 'MT_REVISION_CONFLICT') throw new Error(t('task.revisionConflict').replace('{current}', String(r?.currentRevision ?? '—')).replace('{snapshot}', String(expectedRevision)))
        if (r?.status === 'error') throw new Error(r.message ?? r.code ?? 'rescope failed')
      }, t('diag.fixUnlockDepsDone').replace('{deps}', (depCancelled?.removed ?? []).join('、')))
      const tip = readOnly ? t('task.readonlyTitle') : undefined
      return js('div', { className: 'mt-diag-fix', children: [
        j('span', { className: 'mt-diag-fix-label', children: t('diag.fix') }),
        depCancelled
          ? j('button', {
            className: 'mt-btn mt-btn-sm mt-btn-primary',
            disabled: readOnly || busy,
            title: tip ?? t('diag.fixUnlockDepsHint'),
            onClick: unlockDeps,
            children: t('diag.fixUnlockDeps'),
          })
          : null,
        ...assignable.map((option) => j('button', {
          key: `assign-${option.memberId}`,
          className: 'mt-btn mt-btn-sm mt-btn-primary',
          disabled: readOnly || busy,
          title: tip ?? t('diag.fixAssign').replace('{member}', option.instanceName ?? option.memberId),
          onClick: () => assign(option),
          children: t('diag.fixAssign').replace('{member}', option.instanceName ?? option.memberId),
        })),
        roleSwap.length > 0 ? j('select', {
          className: 'mt-select',
          value: chosenRole,
          'aria-label': t('diag.fixRoleSwap'),
          title: tip ?? t('diag.fixRoleSwap'),
          disabled: readOnly || busy,
          onChange: (e) => swapRole(e.target.value),
          children: [
            j('option', { value: '', children: t('diag.fixRoleSwap') }),
            ...roleSwap.map((option) => j('option', {
              key: option.roleId,
              value: option.roleId,
              children: t('diag.fixRoleSwapOption')
                .replace('{role}', roleLabel(option.roleId))
                .replace('{n}', String((option.idleMembers ?? []).length)),
            })),
          ],
        }) : null,
        /* CHG-76 C：三者可同时存在（deps-pending 时 assignable 也可能非空）——能做的都列出来，不互相排斥。
         * 召唤措辞按诊断码分开：no-role（名册没这个人）vs role-busy（人都在忙，是增援不是补漏）。 */
        spawnRole
          ? (() => {
            const roleBusy = (diagnosis?.codes ?? []).includes('role-busy')
            const canSwap = assignable.length > 0 || roleSwap.length > 0
            const label = roleBusy
              ? t('diag.fixReinforce').replace('{role}', roleLabel(spawnRole))
              : t('diag.fixSpawn').replace('{role}', roleLabel(spawnRole))
            const hint = roleBusy
              ? (canSwap ? t('diag.fixReinforceHintCanSwap') : t('diag.fixReinforceHint'))
              : (canSwap ? t('diag.fixSpawnHintCanSwap') : t('diag.fixSpawnHint'))
            return js('span', { className: 'mt-hint', title: hint, children: `${label} · ${hint}` })
          })()
          : null,
        err ? j('span', { className: 'mt-error-banner', role: 'alert', children: err }) : null,
      ] })
    }