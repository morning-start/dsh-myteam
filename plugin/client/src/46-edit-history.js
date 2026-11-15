    function EditHistory({ t, edits, memberName, limit = 20 }) {
      const [open, setOpen] = react.useState(false)
      const all = edits ?? []
      const list = all.slice(0, limit)
      return js('div', { children: [
        j('h4', { children: js('button', {
          className: 'mt-foldhead',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
          children: [
            j('span', { 'aria-hidden': true, children: open ? '▾' : '▸' }),
            j('span', { children: t('detail.edits') }),
            j('span', { className: 'mt-count', children: all.length }),
          ],
        }) }),
        open ? (list.length === 0
          ? j('div', { className: 'mt-hint', children: t('detail.editsEmpty') })
          : js('div', { className: 'mt-editlist', children: [
            all.length > list.length ? j('div', { className: 'mt-hint', children: t('detail.editsLimit').replace('{n}', String(list.length)) }) : null,
            ...list.map((edit) => js('div', { key: edit.seq, className: 'mt-edititem', children: [
              js('div', { className: 'mt-edithead', children: [
                j('span', { className: 'mt-seq', children: `#${edit.seq}` }),
                j('span', { className: 'mt-actor', children: actorLabel(edit.actor, memberName) }),
                j('span', { className: 'mt-hint', children: fmtClock(edit.ts) }),
              ] }),
              ...(edit.changes ?? []).map((change, i) => js('div', { key: i, className: 'mt-change', children: [
                j('b', { children: fieldLabel(t, change.field) }),
                j('span', { children: '：' }),
                j('span', { className: 'mt-change-from', children: fieldValueText(t, change.field, change.from) }),
                j('span', { className: 'mt-change-arrow', children: '→' }),
                j('span', { className: 'mt-change-to', children: fieldValueText(t, change.field, change.to) }),
              ] })),
              edit.reason ? j('div', { className: 'mt-editreason', children: `${t('detail.editReason')}：${edit.reason}` }) : null,
            ] })),
          ] })) : null,
      ] })
    }