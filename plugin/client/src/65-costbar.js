    /* ── 成本栏（底部常驻：累计 token / 缓存命中率 / 今日未命中·输出 / 估算标注）── */
    const fmtTokens = (n) => {
      const value = Number(n ?? 0)
      if (!Number.isFinite(value) || value === 0) return '0'
      if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(value)
    }
    const dayKeyOf = (ts) => {
      const d = new Date(Number(ts) || Date.now())
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    function CostBar({ t, tokens, onOpen, readOnly, onRefresh }) {
      /* CHG-202x（P1-13）：三态（加载中 / 读不到 / 有数据）+ 刷新入口——不能再「整条消失」。 */
      const refresh = onRefresh ? j('button', { className: 'mt-link', onClick: onRefresh, children: t('cost.refresh') }) : null
      if (tokens === undefined) {
        return js('div', { className: 'mt-costbar mt-costbar-skeleton', role: 'status', children: [j('span', { className: 'mt-hint', children: t('state.loading') }), refresh] })
      }
      if (!tokens) {
        return js('div', { className: 'mt-costbar mt-costbar-skeleton', role: 'status', children: [j('span', { className: 'mt-hint', children: t('costbar.noData') }), refresh] })
      }
      const sum = sumBuckets(Object.values(tokens.totals ?? {}))
      const hit = hitRateOf(sum)
      const today = sumBuckets(Object.values((tokens.days ?? {})[dayKeyOf()] ?? {}))
      const item = (label, value) => js('div', { className: 'mt-costbar-item', children: [
        js('div', { children: [
          j('div', { className: 'mt-costbar-label', children: label }),
          j('div', { className: 'mt-costbar-val', children: value }),
        ] }),
      ] })
      return js('div', { className: 'mt-costbar', children: [
        item(t('costbar.total'), fmtTokens(sum.uncachedInput + sum.cacheRead + sum.cacheWrite + sum.output)),
        item(t('costbar.hitRate'), js('span', { children: [hit === null ? '—' : (hit * 100).toFixed(1), j('small', { children: '%' })] })),
        item(t('costbar.today'), js('span', { children: [`${fmtTokens(today.uncachedInput)} `, j('small', { children: '/' }), ` ${fmtTokens(today.output)}`] })),
        item(t('costbar.calls'), fmtTokens(sum.calls)),
        js('div', { className: 'mt-costbar-right', children: [
          readOnly
            ? j('span', { className: 'mt-mini-chip mt-tone-idle', children: t('archive.replayChip') })
            : j('span', { className: 'mt-mini-chip', title: t('costbar.na'), children: t('costbar.context') }),
          j('span', { className: 'mt-mini-chip', children: t('costbar.estimate') }),
          refresh,
          onOpen ? j('button', { className: 'mt-link', onClick: onOpen, children: t('cost.open') }) : null,
        ] }),
      ] })
    }
