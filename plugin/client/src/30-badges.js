    /* ── 状态徽标（H4：文字 + 形状，不依赖颜色）── */
    const STATE_LABEL = {
      backlog: '待规划', ready: '就绪', running: '进行中', gates: '门禁中', done: '完成',
      draft: '草稿', active: '运行中', archived: '已归档', discarded: '已废弃', disbanded: '已解散',
      in_progress: '进行中', 're-scoping': '重规划', 'gate:review': '审查中', 'gate:verify': '验证中', 'gate:archive': '归档中',
      failed: '失败', blocked: '受阻', cancelled: '已取消',
    }
    const SHAPE = { running: '◐', 're-scoping': '△', failed: '✕', blocked: '▣', done: '●', draft: '○', active: '●' }
    const stateLabel = (s) => STATE_LABEL[s] ?? s
    const stateShape = (s) => SHAPE[s] ?? '·'
    /** 成员状态（与团队状态区分：团队 active=运行中，成员 active=在岗） */
    const MEMBER_STATE_LABEL = { active: '在岗', suspended: '挂起', archived: '已归档', removed: '已移除', spawn_failed: '上岗失败' }
    const memberStateLabel = (s) => MEMBER_STATE_LABEL[s] ?? stateLabel(s)
    /** 泳道名（团队模板 pipeline.stages 是业务阶段名，不套任务状态表） */
    const STAGE_LABEL = { plan: '规划', dev: '开发', gates: '门禁', integrate: '集成' }
    const stageLabel = (s) => STAGE_LABEL[s] ?? s
    /** 门禁名（review/verify/archive 是固定门禁 id） */
    const GATE_LABEL = { review: '交叉审查', verify: '验证', archive: '归档' }
    const gateLabel = (g) => GATE_LABEL[g] ?? g
    /** 角色显示名（内置角色；自定义角色回落 id，id 仍作为副标识展示） */
    const ROLE_LABEL = {
      captain: '队长', implementer: '实现者', reviewer: '评审者',
      'req-validator': '需求验证员', developer: '开发者', acceptor: '验收员',
    }
    const roleLabel = (id) => ROLE_LABEL[id] ?? id
    /** 账本事件中文名（审计/时间线可读性；未知类型回落原始 id，前向兼容） */
    const EVENT_LABEL = {
      'rules.version.adopted': '规则版本',
      'team.created': '团队创建', 'team.disbanded': '团队解散',
      'plan.clarify': '计划澄清', 'plan.staged': '计划暂存', 'plan.revised': '计划修订',
      'plan.approved': '计划批准', 'plan.discarded': '计划丢弃',
      'member.spawned': '成员上岗', 'member.released': '成员释放', 'member.archived': '成员归档',
      'member.restored': '成员恢复', 'member.interrupted': '成员中断',
      'task.created': '任务创建', 'task.claimed': '任务领取', 'task.assigned': '任务指派',
      'task.progress': '任务进展', 'task.evidence': '提交证据', 'task.completed': '任务完成申报',
      'task.failed': '任务失败', 'task.escalated': '任务受阻申报', 'task.rescoped': '任务重规划', 'task.updated': '任务修改', 'team.updated': '团队修改',
      'task.attempt.revoked': '尝试撤销', 'task.proposal': '任务提案', 'task.proposal.resolved': '提案裁决',
      'task.deliverable': '交付物登记', 'task.gate.result': '门禁裁决',
      'message.sent': '消息发送', 'message.consumed': '消息已读',
      'knowledge.proposed': '知识提案', 'knowledge.adopted': '知识采纳', 'knowledge.revised': '知识演化',
      'memory.audit': '记忆审计',
    }
    const eventLabel = (type) => EVENT_LABEL[type] ?? type
    const ACTOR_LABEL = { lead: '队长', human: '人工', host: '宿主', system: '系统' }
    /** 事件 actor → 显示名（成员 id 走成员实例名；lead/human/host 走固定词表） */
    const actorLabel = (actor, memberName) => {
      const raw = String(actor ?? '')
      if (!raw) return '—'
      const member = memberName?.(raw)
      if (member && member !== raw) return member
      return ACTOR_LABEL[raw] ?? raw
    }
    /** CHG-73：结构字段 → 词条 key（改动记录与证据过期横幅共用；未知字段回落原始 key） */
    const FIELD_LABEL_KEY = {
      title: 'field.title', description: 'field.description', acceptanceCriteria: 'field.acceptanceCriteria',
      deps: 'field.deps', requiredRole: 'field.requiredRole', gateChain: 'field.gateChain',
      deliverableSpec: 'field.deliverableSpec', priority: 'field.priority', assignees: 'field.assignees',
      participants: 'field.participants', state: 'field.state',
    }
    const fieldLabel = (t, field) => {
      const key = FIELD_LABEL_KEY[field]
      return key ? t(key) : String(field ?? '')
    }
    /** 改动值 → 一行可读文本（数组用、连接；交付物取 path；角色取显示名） */
    const fieldValueText = (t, field, value) => {
      if (value === null || value === undefined || value === '') return '—'
      if (field === 'requiredRole') return roleLabel(String(value))
      if (Array.isArray(value)) {
        if (value.length === 0) return '—'
        return value.map((item) => (item && typeof item === 'object' ? fieldValueText(t, field, item) : String(item))).join('、')
      }
      if (typeof value === 'object') {
        if (typeof value.path === 'string') return value.path
        try { return JSON.stringify(value) } catch { return String(value) }
      }
      return String(value)
    }
    /** 字段列表 → 中文名（证据过期横幅：改了哪些字段） */
    const fieldListText = (t, fields) => {
      const list = fields ?? []
      return list.length > 0 ? list.map((field) => fieldLabel(t, field)).join('、') : '—'
    }
    /** 任务筛选（标题/id/成员/依赖 + 优先级 + 成员；视图层共用，不改投影） */
    const taskMatches = (task, f, memberName) => {
      if (!f) return true
      if (f.prio && f.prio !== 'all' && String(task.priority ?? '') !== f.prio) return false
      if (f.member && f.member !== 'all' && String(task.assignee ?? '') !== f.member) return false
      const needle = String(f.query ?? '').trim().toLowerCase()
      if (!needle) return true
      const hay = [
        task.id, task.title, task.assignee ? memberName?.(task.assignee) ?? task.assignee : '',
        ...(task.deps ?? []),
      ].join(' ').toLowerCase()
      return hay.includes(needle)
    }
    /** 看板/泳道/DAG/流转共用的筛选后 board（列结构保持，只过滤 tasks） */
    const filterBoard = (board, f, memberName) => {
      if (!board || !f || (!f.query && (!f.prio || f.prio === 'all') && (!f.member || f.member === 'all'))) return board
      const inner = board.board
      if (!inner) return board
      return {
        ...board,
        board: {
          ...inner,
          columns: (inner.columns ?? []).map((col) => ({ ...col, tasks: (col.tasks ?? []).filter((task) => taskMatches(task, f, memberName)) })),
        },
      }
    }
    /** 任务卡状态点（CHG-62：颜色只做辅助，文字仍在 meta 行，H4 不依赖颜色） */
    const stateDotClass = (s) =>
      s === 'done' ? 'mt-task-dot-done'
        : s === 'in_progress' || s === 'gate:review' || s === 'gate:verify' || s === 'gate:archive' ? 'mt-task-dot-active'
          : s === 'failed' || s === 'blocked' || s === 're-scoping' ? 'mt-task-dot-fail'
            : 'mt-task-dot'
    /** 毫秒 → 人话（预设卡门禁超时等；避免设置页/预设卡出现裸 120000 ms） */
    const humanMs = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (n < 1000) return `${n} ms`
      if (n % 60000 === 0 && n < 3600000) return `${n / 60000} 分钟`
      if (n % 1000 === 0 && n < 60000) return `${n / 1000} 秒`
      return `${(n / 1000).toFixed(1)} 秒`
    }
    /** 工作区路径 → 项目名（全局列表分组标签；空值显示 —） */
    const projectLabel = (root) => {
      if (!root) return '—'
      const parts = String(root).replace(/\\/g, '/').split('/').filter(Boolean)
      return parts[parts.length - 1] ?? String(root)
    }
    /**
     * 展示用路径（CHG-108 客户端版）：**家目录前缀缩成 `~`**，不把用户名打出来。
     *
     * 为什么客户端也要有一份：团队摘要里的 `workspaceRoot` 是**索引里的历史值**（可能属于
     * 别的项目/机器），服务端的 `displayPath` 只能处理「本机 $HOME」，而浏览器里连
     * `homedir()` 都没有。所以这里按「用户目录形状」做纯文本缩写：
     *   `C:\Users\<名字>\...` / `/home/<名字>/...` / `/Users/<名字>/...` → `~/...`
     * 认不出形状（或不是家目录）→ 原样返回，**绝不猜**。
     */
    const prettyPath = (value) => {
      const path = String(value ?? '')
      if (!path) return path
      const match = path.match(/^(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/(?:home|Users)\/[^/]+)(?=[\\/]|$)/)
      if (!match) return path
      const rest = path.slice(match[0].length)
      return `~${rest || ''}`
    }
    /** 时间戳 → 相对时间（索引的 updatedAt 为 epoch ms；0/缺失显示 —） */
    const relTime = (ts, t) => {
      if (!ts) return '—'
      const diff = Date.now() - ts
      if (!Number.isFinite(diff) || diff < 0) return t('time.justNow')
      if (diff < 60e3) return t('time.justNow')
      const minutes = Math.floor(diff / 60e3)
      if (minutes < 60) return t('time.minutesAgo').replace('{n}', String(minutes))
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo').replace('{n}', String(hours))
      return t('time.daysAgo').replace('{n}', String(Math.floor(hours / 24)))
    }

    /**
     * 影响面计数渲染（FR-14.1 / CHG-86 P0-2）。
     *
     * 已知缺陷：host 的 `member.released` 事件里 `drained: { running: 0, pending: 0 }` 是**硬编码**
     * （`plugin/src/host.ts:1808`，客户端无权改）。所以 UI 侧的口径是：
     *  - 有真实值（有限数）→ 如实渲染；
     *  - 缺失 / 不可用 → 显示占位 `—`，**不显示伪造的 0**（0 会被读成「没有影响」）。
     */
    const impactCountText = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : String(Number(value)))

    /**
     * 深色覆盖的作用域根（CHG-99 / C13）。
     *
     * 面板在各插槽里是**互不相邻的根节点**（main 面板 / 会话视图 / composer dock / 侧栏入口 /
     * 工具卡），没有共同祖先；宿主自己的容器不能挂属性（会污染面板之外）。
     * 所以 `data-theme` 写在每个 `.mt-*` 表面根上，深色规则统一以本选择器作前缀。
     */
    const DARK_SURFACE = ':is(.mt-panel,.mt-conv,.mt-dockrow,.mt-entry,.mt-toolcard)[data-theme="dark"]'
