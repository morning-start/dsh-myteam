    /* ── G2：角色/名册展示小工具（纯展示派生，不造第二事实源）── */
    const TOKEN_BUCKET_KEYS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']
    /** token 侧车单成员合计 → 386k / 1.2M（四桶相加，成本口径仍是估算值） */
    const fmtTokenCount = (n) => {
      const value = Number(n ?? 0)
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value >= 1e6) return `${(value / 1e6).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`
      if (value >= 1e3) return `${Math.round(value / 1e3)}k`
      return String(Math.round(value))
    }
    /** 角色头像配色（a1~a4 四档；按角色 id 稳定取一档，避免每次渲染换色） */
    const AVATAR_CLASSES = ['mt-avatar-a1', 'mt-avatar-a2', 'mt-avatar-a3', 'mt-avatar-a4']
    const avatarClassOf = (key) => {
      const text = String(key ?? '')
      let hash = 0
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 9973
      return AVATAR_CLASSES[hash % AVATAR_CLASSES.length]
    }
    /** 头像字（角色名首字；无名时回落 id 首字） */
    const avatarCharOf = (name, fallback) => String(name || fallback || '?').trim().slice(0, 1) || '?'
    /** 单成员 token 合计（侧车四桶；无记录 = 0，不编数字） */
    const tokenTotalOf = (tokens, memberId) => {
      const bucket = tokens?.totals?.[memberId]
      if (!bucket) return 0
      return TOKEN_BUCKET_KEYS.reduce((sum, key) => sum + Number(bucket[key] ?? 0), 0)
    }
    /** 交付 x/y = 该实例被指派的已完成任务 / 被指派任务总数（从项目任务派生） */
    const deliveryOf = (tasks, memberId) => {
      const mine = (tasks ?? []).filter((task) => (task.assignees ?? (task.assignee ? [task.assignee] : [])).includes(memberId))
      return { done: mine.filter((task) => String(task.state ?? '') === 'done').length, total: mine.length }
    }
