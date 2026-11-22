    /* ── 主工作台（常驻面板：全局视图=团队列表+角色↔团队关系；团队视图=工作台+任务流转）── */
/* ══ CHG-69：全局 / 项目双作用域面板（角色 · 团队 · 任务） ══ */

    /** 项目任务按状态分列（项目级看板：不依赖单个团队的 config 列） */
    const PROJECT_COLUMNS = [
      { name: '待规划', states: ['backlog'] },
      { name: '就绪', states: ['ready'] },
      { name: '进行中', states: ['in_progress', 're-scoping'] },
      { name: '门禁', states: ['gate:review', 'gate:verify', 'gate:archive'] },
      /* CHG-85：列名对齐 design-v2/p-tasks.html（「已完成」；末列是虚线收口列） */
      { name: '已完成', states: ['done'] },
      { name: '未完成', states: ['failed', 'blocked', 'cancelled'], done: true },
    ]

    const projectColumnOf = (state) => {
      for (const col of PROJECT_COLUMNS) if (col.states.includes(state)) return col.name
      return PROJECT_COLUMNS[0].name
    }

    /** 项目任务行 → DAG 输入（id 用复合键，deps 同步映射；跨团队依赖不存在） */
    const toGraphTasks = (tasks) => tasks.map((task) => ({
      ...task,
      id: task.key,
      code: task.id,
      deps: (task.deps ?? []).map((dep) => `${task.ownerTeamId}/${dep}`),
    }))

    /**
     * CHG-193（T160 · M3-7）：面板「任务」tab 的**数据源归一** —— 派生索引优先、`getProject` 兜底。
     *
     * 为什么需要这一步：`getBoard({}).project`（`state/index/tasks.json` 派生索引）是项目级任务的
     * 唯一派生面，但它**刻意不存** `ownerOnline` / `ownerSessionId` —— 那是机器相关字段
     * （索引要能换机器/换工作区副本复用，绝对路径与 sessionId 一换就废，见
     * `core/index/project-board-index.ts` 的字段清单）。而面板的写入口（详情抽屉的
     * 重新规划 / 取消 / 编辑）必须知道「这个任务属于哪个团队的哪个会话」——所以这里把
     * 索引里的**业务字段**与**实时团队名册**（`getProject().teams`）的**会话绑定**按
     * `ownerTeamId` 拼回去：任务只认索引、会话只认名册，两边都是唯一真源，谁也不当第二份。
     *
     * 降级（三条，缺一条就白屏）：
     *  ① 索引未加载（`undefined`）或不可用（`null`，`getBoard` 抛错 / 没 `project` 字段
     *     / `tasks` 不是数组）→ 回落 `getProject().tasks`；
     *  ② 索引在手但 `tasks` 为空 → 同样回落实时折叠（两条路折的是**同一份账本**，结果一致，
     *     不存在「哪个更新」的问题；用回落而不是空数组，是因为「读不到」不该被说成
     *     「这个项目没有任务」——那是谎报）；
     *  ③ 任务找不到所属团队（团队刚被删、索引还没重算）→ 原样保留，`ownerOnline` 缺失
     *     即按只读渲染（`readOnly: !openTask.online`），不给不存在的团队开写路径。
     */
    function resolveProjectTasks(boardIndex, projectTeams, fallbackTasks) {
      const indexTasks = boardIndex && Array.isArray(boardIndex.tasks) ? boardIndex.tasks : null
      const source = indexTasks && indexTasks.length > 0 ? indexTasks : (Array.isArray(fallbackTasks) ? fallbackTasks : [])
      return source.map((task) => {
        const owner = (projectTeams ?? []).find((team) => team.teamId === task.ownerTeamId)
        if (!owner) return task
        return {
          ...task,
          ownerOnline: owner.online === true,
          ...(owner.sessionId ? { ownerSessionId: owner.sessionId } : {}),
          ...(owner.name ? { ownerTeamName: owner.name } : {}),
        }
      })
    }

    /**
     * CHG-193（T160）：任务详情的**复合键**打开目标 —— `{ teamId, taskId }`。
     *
     * 为什么不能只传 taskId：项目级看板是**跨团队聚合**的，而每个团队的账本都从 `task-1`
     * 开始编号——只传 taskId 就会打开另一个团队的同名任务，写操作（重新规划 / 取消 / 编辑）
     * 也会落到错误的团队账本。所以打开详情一律带团队 id，`TaskDetail` 用它取**任务所属团队**
     * 的 service（`makeApi(connection, target.sessionId)`），不是当前选中/默认团队。
     *
     * 空 id 返回 `null`（不制造假任务）；`sessionId` 缺失 = 该团队不在线 → 只读。
     */
    function taskOpenTarget(task) {
      if (!task || task.id === undefined || task.id === null || task.id === '') return null
      return {
        teamId: String(task.ownerTeamId ?? ''),
        taskId: String(task.id),
        online: task.ownerOnline === true,
        ...(task.ownerSessionId ? { sessionId: String(task.ownerSessionId) } : {}),
      }
    }

    /** CHG-82 G2：角色卡按 design-v2/p-teams.html 的 .card 结构——
     *  圆形头像 + 角色名/ID + 来源 chip + 描述 + 兴趣词 + 模型路由/Skill/MCP + 复制来源 + 脚（实例 / 用它单干 / 复制进项目）。
     *  CHG-74：同名副本要能一眼分辨——被压过的那份标「同名 X 副本（以此为准）」。 */
    const fmtClock = (ts) => {
      if (!ts) return '—'
      const d = new Date(ts)
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
      return d.toDateString() === now.toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
    }
    const dagChipOf = (state) => {
      const s = String(state ?? '')
      if (s.startsWith('gate:')) return 'gate'
      if (s === 'done') return 'done'
      if (s === 'in_progress' || s === 're-scoping') return 'run'
      if (s === 'failed' || s === 'cancelled') return 'fail'
      if (s === 'blocked') return 'blocked'
      return 'idle'
    }
    const sumBuckets = (buckets) => {
      const sum = { calls: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const bucket of buckets) for (const key of Object.keys(sum)) sum[key] += Number(bucket?.[key] ?? 0)
      return sum
    }
    const hitRateOf = (sum) => {
      const denom = sum.uncachedInput + sum.cacheRead + sum.cacheWrite
      return denom === 0 ? null : sum.cacheRead / denom
    }