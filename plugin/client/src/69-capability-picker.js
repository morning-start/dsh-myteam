    function CapabilityPicker({ t, label, value, options, onChange, emptyText, placeholder }) {
      const picked = value ?? []
      const opts = options ?? []
      const [draft, setDraft] = react.useState('')
      const has = (name) => picked.includes(name)
      const push = (names) => {
        const next = [...picked]
        for (const raw of names) {
          const name = String(raw ?? '').trim()
          if (name && !next.includes(name)) next.push(name)
        }
        onChange(next)
      }
      const remove = (name) => onChange(picked.filter((item) => item !== name))
      const commit = () => {
        const parts = String(draft).split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
        if (parts.length > 0) push(parts)
        setDraft('')
      }
      return js('div', { className: 'mt-field', children: [
        js('div', { className: 'mt-cap-label', children: [
          j('label', { children: label }),
          j('span', { className: 'mt-hint', children: `${t('role.catalog')} ${opts.length}` }),
        ] }),
        js('div', { className: 'mt-capbox', children: [
          picked.length > 0
            ? js('div', { className: 'mt-cap-picked', children: picked.map((name) => j('button', {
              key: name,
              className: 'mt-cap-opt mt-cap-opt-on',
              title: `${name} ×`,
              onClick: () => remove(name),
              children: `${name} ×`,
            })) })
            : j('div', { className: 'mt-hint', children: emptyText ?? t('role.catalogEmpty') }),
          js('div', { className: 'mt-cap-row', children: [
            j('input', {
              value: draft,
              placeholder: placeholder ?? t('role.catalogFree'),
              'aria-label': label,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault?.(); commit() } },
            }),
            j('button', { className: 'mt-btn mt-btn-sm', onClick: commit, children: t('role.catalogAdd') }),
          ] }),
          opts.length > 0 ? js('div', { className: 'mt-rolechips', children: opts.map((opt) => js('button', {
            key: opt.name,
            className: has(opt.name) ? 'mt-cap-opt mt-cap-opt-on' : 'mt-cap-opt',
            'aria-pressed': has(opt.name),
            title: opt.name,
            onClick: () => (has(opt.name) ? remove(opt.name) : push([opt.name])),
            children: [
              j('span', { children: opt.name }),
              j('span', { className: 'mt-cap-src', children: opt.source === 'host' ? 'host' : 'role' }),
            ],
          })) }) : null,
          j('div', { className: 'mt-hint', children: t('role.catalogHint') }),
        ] }),
      ] })
    }

    /** 重新规划对话框（CHG-73 §4.3）：理由必填 + 可选结构补丁 + 可选重派队员 → rescopeTask */