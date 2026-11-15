    function Panel(props) {
      const { ctx, connection, t: tProp, mode = 'global', sessionId: panelSessionId } = props
      const t = tProp ?? ((k) => zh[k] ?? k)
      /* CHG-201：作用域由**挂载点**决定（不是界面状态）——界面内的 setScope 一律无效，
       * 避免全局页点进项目、项目页点回全局。 */
      const scope = mode === 'project' ? 'project' : 'global'
      const setScope = react.useCallback(() => {}, [])
      /* CHG-99（C13）：宿主**解析后**的深色态写到面板表面根上；样式侧只用 `.mt-*[data-theme="dark"]`，
       * 不再依赖系统偏好媒体查询（宿主手动切深色时媒体查询不触发）。 */
      const dark = useDarkTheme()
      const themeAttr = { 'data-theme': dark ? 'dark' : 'light' }
      /* CHG-201：项目视图绑定会话（`getProjectScope` 等 agent 端点要 agentId）；全局视图
       * 不传 sessionId（只读全局资产，根级端点也不需要它）。 */
      const discoveryApi = react.useMemo(() => makeApi(connection, panelSessionId), [connection, panelSessionId])
      /* ── CHG-164（报告 A3）：能力协商（describe）——治「两端方法表漂移」──
       * 为什么需要：客户端 `makeApi` 是**手写**方法表，服务端门面是另一份。任一漏写就是运行时
       * `undefined`（CHG-104 整屏卡「加载中」）。describe 返回服务端**真实**方法表：缺方法时
       * 按「不支持」降级（隐藏/置灰入口 + 提示重启宿主），而不是等调用时炸。
       * 纪律：describe 拿不到（旧宿主 / 网络错）→ `methods:null` = **未知**，退回 `typeof` 探测
       * （保守：不因为协商失败就禁用全部功能）。 */
      const [capabilities, setCapabilities] = react.useState(null)
      const capabilitiesRef = useRefSafe(null)
      capabilitiesRef.current = capabilities
      /* 批量是否可用：describe 明说没有 → false；调用报 MT_UNKNOWN_METHOD → 一次降级并记住
       * （旧宿主上不该每次首屏都白试一次往返）。 */
      const batchAllowedRef = useRefSafe(true)
      react.useEffect(() => {
        let alive = true
        const describeFn = discoveryApi?.describe
        if (typeof describeFn !== 'function') {
          setCapabilities({ methods: null, version: 0, complete: false })
          return undefined
        }
        Promise.resolve(describeFn({}))
          .then((r) => {
            if (!alive) return
            const methods = Array.isArray(r?.methods) ? r.methods.map((method) => String(method)) : null
            setCapabilities({ methods: methods ? new Set(methods) : null, version: Number(r?.version) || 0, complete: r?.complete !== false })
            if (methods && !methods.includes('batch')) batchAllowedRef.current = false
          })
          .catch(() => { if (alive) setCapabilities({ methods: null, version: 0, complete: false }) })
        return () => { alive = false }
      }, [discoveryApi])
      /** 端点是否被**服务端**支持：describe 拿到就按它判，否则退回 `typeof`（未知 = 不禁用） */
      const hasEndpoint = react.useCallback((name) => {
        const caps = capabilitiesRef.current
        if (caps && caps.methods) return caps.methods.has(name)
        return typeof discoveryApi?.[name] === 'function'
      }, [discoveryApi])
      /* CHG-114：入口交接（每次挂载只消费一次）——从团队视图进来时直接落在项目作用域的团队页，
       * 侧栏入口没有交接（pendingNav=null）→ 仍按 CHG-42 的默认落在全局库。 */
      const entryNavRef = react.useRef(null)
      if (entryNavRef.current === null) entryNavRef.current = { nav: takePendingNav() }
      const entryNav = entryNavRef.current.nav
      const [projectTab, setProjectTab] = react.useState(entryNav?.projectTab ?? 'tasks') // 角色 | 团队 | 任务
      const [projectRoot, setProjectRoot] = react.useState(entryNav?.workspaceRoot ?? '')
      /* CHG-202：项目作用域的 `projectRoot` 是**异步解析**的（`getProjectScope`）——解析出结果前
       * 不能把「还没有团队」当成结论（那是「解析完成但确实没有项目」的文案）。默认 `true`
       * 让全局页（不解析项目）直接走空态，项目页在拿到响应前显示「正在解析」。 */
      const [scopeResolved, setScopeResolved] = react.useState(mode !== 'project')
      /* CHG-201：项目作用域先解析「当前会话属于哪个项目」（`getProjectScope`），再走既有的
       * getProject / getStoreState 数据面；全局作用域不解析项目（只读全局资产）。
       *
       * CHG-202b：`projectRoot` 的**唯一来源就是这里**——不再有候选列表兜底。解析失败就
       * 保持空、顶部如实说「解析不出」，绝不换一个项目顶上。 */
      react.useEffect(() => {
        if (scope !== 'project' || projectRoot) return undefined
        let alive = true
        const api = makeApi(connection, panelSessionId)
        Promise.resolve(typeof api.getProjectScope === 'function' ? api.getProjectScope() : null)
          .then((sc) => {
            if (!alive || !sc) return
            const root = String(sc.workspaceRoot ?? '')
            if (root) setProjectRoot(root)
            if (typeof sc.initialized === 'boolean') setStoreState({ initialized: sc.initialized, workspaceRoot: root })
          })
          /* 失败要**大声**（P4）：静默 catch 正是 CHG-202 那个「参数形状错却没人知道」的温床 */
          .catch((e) => {
            try { console.error('[myteam] 解析当前会话的项目根失败（getProjectScope）：', e) } catch { /* 控制台不可用 */ }
          })
          /* CHG-202：无论成败都算「解析过一次」——否则失败时永远停在「正在解析」。 */
          .finally(() => { if (alive) setScopeResolved(true) })
        return () => { alive = false }
      }, [scope, projectRoot, connection, panelSessionId])
      /**
       * CHG-102：项目级存储状态（`.dsh-myteam/` 是否已初始化）。
       *
       * 为什么必须有：用户还没进团队模式时，面板此前照样渲染角色库/团队/任务
       * （内置角色 + 全局库 + 别的项目的离线团队）——「所有项目看起来都一样、
       * 还没开始就一堆内容」。未初始化时只画一句空态 + 初始化入口。
       */
      const [storeState, setStoreState] = react.useState(undefined)
      const [teams, setTeams] = react.useState(null)
      const [project, setProject] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [selectedTeamId, setSelectedTeamId] = react.useState(entryNav?.teamId ?? null)
      const [teamTab, setTeamTab] = react.useState(entryNav?.teamTab ?? 'members')     // 队员 | 参与任务 | 知识 | 审计 | 设置
      /* design/team-tasks.html：本队角色筛选（全部 / 主责 / 协作） */
      const [teamTaskFilter, setTeamTaskFilter] = react.useState('all')
      const [taskView, setTaskView] = react.useState('board')     // 列表 | 看板 | 流程 | 依赖图
      /* CHG-202x（P0-3）：角色库的来源筛选（all | project | global | builtin）——受控，
       * 好让「引入全局角色」这类跨区块入口真的能切视图。 */
      const [roleOriginFilter, setRoleOriginFilter] = react.useState('all')
      const [dagDir, setDagDir] = react.useState('h')
      // CHG-82：拖拽流转态（design/dragging.html）—— 被拖起的卡 + 当前落点列 + 被拒回执
      const [dragTask, setDragTask] = react.useState(null)
      const [dragToast, setDragToast] = react.useState(null)
      const [dragShake, setDragShake] = react.useState(null)      // 非法落点：源卡抖动 + 弹回 150ms
      const [railTeam, setRailTeam] = react.useState('all')
      const [taskQuery, setTaskQuery] = react.useState('')
      const [taskPrio, setTaskPrio] = react.useState('all')
      const [taskMember, setTaskMember] = react.useState('all')
      const [openTask, setOpenTask] = react.useState(null)        // { key, teamId, taskId, online, sessionId }
      /* CHG-193（T160 · M3-7）：项目看板**派生索引**（`getBoard({}).project`）——面板「任务」tab 的数据源。
       * `undefined` = 未加载（首屏）；`null` = 不可用（降级 `getProject`）；对象 = 索引在手。
       * 索引是**派生数据**：这里只存「这次拉到的那份」，不做第二真源、不写回、不参与任何计算。 */
      const [boardIndex, setBoardIndex] = react.useState(undefined)
      const [openRole, setOpenRole] = react.useState(null)
      const [roleDetail, setRoleDetail] = react.useState(null)
      const [kb, setKb] = react.useState(undefined)
      const [audit, setAudit] = react.useState(undefined)
      const [auditFilter, setAuditFilter] = react.useState('all')
      const [config, setConfig] = react.useState(undefined)
      /* CHG-119（FR-11.6）：计划质量反馈（只读观测；undefined=未加载） */
      const [feedback, setFeedback] = react.useState(undefined)
      const [tokens, setTokens] = react.useState(undefined)
      const [inbox, setInbox] = react.useState(null)
      const [presets, setPresets] = react.useState(undefined)
      const [showCost, setShowCost] = react.useState(false)
      /* CHG-202x（P1-13）：成本栏刷新令牌（+1 = 重新拉一次 tokens 侧车） */
      const [costToken, setCostToken] = react.useState(0)
      /* CHG-82（G3）：全局作用域的随行资产子页——角色库 / 预设库 / 技能 & MCP（design/presets.html · skills.html） */
      const [globalPage, setGlobalPage] = react.useState('roles')
      const [disband, setDisband] = react.useState(null)
      /* CHG-86 / P0-2：归档快照（getArchive 的真实落盘内容；undefined=未加载，null=未归档） */
      const [archiveSnap, setArchiveSnap] = react.useState(undefined)
      const [archiveRoot, setArchiveRoot] = react.useState('')
      const [disbandBusy, setDisbandBusy] = react.useState(false)
      /* CHG-72：面板闭环（建队引导 / 角色表单 / 任务表单 / 成功提示） */
      const [notice, setNotice] = react.useState(null)
      const [teamCreate, setTeamCreate] = react.useState(false)
      const [roleForm, setRoleForm] = react.useState(null)
      const [taskForm, setTaskForm] = react.useState(null)
      /* CHG-73：多选批量 / 重新规划 / 取消 / 详情刷新 / 能力目录 */
      const [selectMode, setSelectMode] = react.useState(false)
      const [selected, setSelected] = react.useState(() => new Set())
      const [rescopeFor, setRescopeFor] = react.useState(null)
      const [cancelFor, setCancelFor] = react.useState(null)
      const [detailToken, setDetailToken] = react.useState(0)
      const [capCatalog, setCapCatalog] = react.useState(undefined)
      /* CHG-172（A11 / FR-16.1）：单角色调用应用——写路径 = facade.applyRoles（需在线团队会话作载体，不写团队账本）
       * CHG-178（U1 · P0）：这两个 useState **必须**留在所有早退之前。
       * 早退分支（`scope === 'global'` 的预设/技能子页、全局角色库、加载中）会跳过下面所有代码；
       * 之前它们声明在 11839 行（早退之后），于是「全局 → 项目」切换时 hook 数量变多 → React #310
       * （Rendered more hooks than during the previous render）→ 整屏「面板渲染失败」。 */
      const [guestBusy, setGuestBusy] = react.useState(false)
      const [guestNote, setGuestNote] = react.useState(null)

      /* CHG-72：抽屉互斥——同一时间只开一个表单，避免「点了新建团队却看到任务表单」 */
      /* CHG-84：打开建团向导时若预设目录还没就绪（或上次读取失败），立刻触发拉取 ——
       * 抽屉里先渲染骨架，避免「点了没反应」；已就绪则不重复拉。 */
      const openTeamCreator = () => {
        setTeamCreate(true)
        setRoleForm(null)
        setTaskForm(null)
        setOpenRole(null)
      }
      const openRoleEditor = (form) => { setRoleForm(form); setTaskForm(null); setTeamCreate(false) }
      const openTaskEditor = (form) => { setTaskForm(form); setRoleForm(null); setTeamCreate(false); setOpenRole(null); setOpenTask(null) }
      const closeDrawers = () => { setTeamCreate(false); setRoleForm(null); setTaskForm(null) }
      /* CHG-82 G2：角色库的两个跨页动作（全局作用域也要能「复制进项目 / 用它单干」） */
      /** 复制进项目 = 打开角色编辑器（fork 语义：先复制再改，不静默覆盖；同名由服务端两段确认） */
      const copyRoleToProject = async (role) => {
        if (!role?.id) return
        try {
          const detail = await discoveryApi.getRoleDetail({ workspaceRoot: projectRoot, roleId: role.id })
          const definition = detail?.status === 'ok' ? detail.definition : undefined
          openRoleEditor({ mode: 'create', fork: true, forkOrigin: role.origin, definition: definition ?? { ...role } })
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }
      /** 用它单干 = 复制 /myteam+<roleId> 命令（不新增写路径；单角色调用在普通会话里发起） */
      const guestRoleCommand = async (role) => {
        const roleId = role?.id
        if (!roleId) return
        const command = `/myteam+${roleId}`
        const ok = await copyText(command)
        setNotice(t(ok ? 'roles.guestCopied' : 'roles.guestCopyFailed').replace('{cmd}', command))
      }
      const exitSelect = () => { setSelectMode(false); setSelected(new Set()) }
      const toggleSelected = (task) => setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(task.key)) next.delete(task.key)
        else next.add(task.key)
        return next
      })

      /**
       * CHG-201：**项目作用域**的团队清单（按会话工作区；全局作用域不加载团队）。
       * 旧 `listTeams`（跨工作区「全部项目」）已退役——全局不记录项目。
       */
      const loadTeams = react.useCallback(async () => {
        if (scope !== 'project') { setTeams([]); return }
        try {
          const d = await discoveryApi.getProjectScope?.()
          setTeams(d?.teams ?? [])
        } catch (e) {
          setTeams([])
          setError(String(e?.message ?? e))
        }
      }, [discoveryApi, scope])

      /* CHG-99（C3）：请求序号 + 项目根快照 —— 并发/切项目时只认**最后一次**请求的响应。
       * 修复前 `loadProject` 无序号、无 alive 守卫，两个可复现 bug：
       *  ① 切项目闪回：从「结算页」切到「插件 v0.2」时旧项目的 `getProject` 还在飞，
       *     回来照样 `setProject(旧项目)` → 面板闪回上一个项目，等下次 5s 轮询才纠正；
       *  ② 写后数据倒退：点「批准计划」→ `await planAction()` → `await loadProject()`
       *     （9 处写后全量刷新）与 5s 轮询撞车时，慢的响应覆盖新状态 → 界面显示「批准前」，
       *     用户以为没生效再点一次 → **二次操作**。
       * 序号用 ref（useState 会多一轮渲染）；`projectRootRef` 是 projectRoot 的渲染期镜像——
       * 异步回调里的 `projectRoot` 是发起时那次渲染的闭包值，读 ref 才是当前值。 */
      const loadSeqRef = useRefSafe(0)
      const projectRootRef = useRefSafe(projectRoot)
      projectRootRef.current = projectRoot
      const loadProject = react.useCallback(async (root) => {
        if (!root) { setProject(null); setStoreState(undefined); return }
        const seq = ++loadSeqRef.current
        /** 过期响应：被更新的请求顶掉，或调用方的 root 已不是当前项目 */
        const stale = () => seq !== loadSeqRef.current || root !== projectRootRef.current
        /* CHG-164（报告 A3）：**首屏一次往返**——把 getProject + getStoreState 打成一个 batch。
         * 为什么值得：CHG-112 建了 batch 端点（「首屏 3 次往返 → 1 次」），但客户端**零消费**，
         * 首屏仍是两次**串行** RPC（getStoreState 要等 getProject 回来才发），白等一个 RTT。
         * 降级纪律（两层，缺一不可）：
         *  ① describe 明说服务端没有 batch → 直接走两次调用，不白试；
         *  ② 试了回 `MT_UNKNOWN_METHOD`/异常（旧宿主）→ 记住失败，本会话后续走两次调用。
         * 无论哪条路，**结果语义与两次调用完全一致**（包括 getStoreState 失败 = 未知，
         * 绝不阻塞面板）。 */
        if (batchAllowedRef.current && hasEndpoint('batch') && hasEndpoint('getProject')) {
          try {
            const r = await discoveryApi.batch({
              calls: [
                { kind: 'getProject', args: { workspaceRoot: root } },
                ...(hasEndpoint('getStoreState') ? [{ kind: 'getStoreState', args: { workspaceRoot: root } }] : []),
              ],
            })
            if (stale()) return
            const results = Array.isArray(r?.results) ? r.results : []
            const first = results[0]
            /* 只有「整批跑通且第一条成功」才认；否则落到下面的单次调用（不猜半截状态） */
            if (r?.status === 'ok' && first?.ok === true) {
              const p = first.value
              if (p?.status === 'ok') { setProject(p); setError(null) } else setError(p?.message ?? t('error.unreadable'))
              const s = results[1]?.ok === true ? results[1].value : undefined
              setStoreState(s?.status === 'ok' ? s : undefined)
              return
            }
            // 服务端不认 batch（旧宿主）→ 本会话永久降级，别每次首屏都白试
            batchAllowedRef.current = false
          } catch {
            if (stale()) return
            batchAllowedRef.current = false
          }
        }
        try {
          const p = await discoveryApi.getProject({ workspaceRoot: root })
          if (stale()) return
          if (p?.status === 'ok') { setProject(p); setError(null) } else setError(p?.message ?? t('error.unreadable'))
        } catch (e) {
          /* 错误分支同样要守卫：过期响应的 error 也不能盖掉当前项目的状态 */
          if (stale()) return
          setError(String(e?.message ?? e))
        }
        /* 降级路径：存储状态与项目**并行**发（不串行等），失败一律未知（不阻塞面板） */
        if (!hasEndpoint('getStoreState')) { setStoreState(undefined); return }
        discoveryApi.getStoreState({ workspaceRoot: root })
          .then((r) => { if (!stale()) setStoreState(r?.status === 'ok' ? r : undefined) })
          .catch(() => { if (!stale()) setStoreState(undefined) })
      }, [discoveryApi, hasEndpoint, t])

      react.useEffect(() => { loadTeams() }, [loadTeams])
      /* CHG-202b（用户定案「会话模式下的 UI 应该自己打开当前会话所在工作目录的位置，
       * 而不是什么能指定的项目位置」）：**项目候选列表整块删除**。
       *
       * 修复前这里有一份 `rootCandidates`（有团队的工作区 → 一个都没有就退回整个 GUI 的
       * 工作区列表），再拿 `rootCandidates[0]` 兜底。它看着像"降级"，实际是**第二真源**：
       * 会话解析不出项目根时，界面会静默打开**别人家**的工作区，用户以为自己在看本项目。
       * 项目视图的唯一真源 = 会话工作目录（`getProjectScope()`）；解析不出就如实显示
       * 「解析不出」，绝不猜一个顶上。 */
      react.useEffect(() => { loadProject(projectRoot) }, [projectRoot, loadProject])
      /**
       * CHG-193（T160 · M3-7）：拉项目看板**派生索引**（`getBoard({})` 的 `project` 字段）。
       *
       * 为什么面板要它：项目级看板此前是「每次读时全量折叠」（`getProject` 扫全部团队账本
       * → 折 → 归并），团队一多首屏就慢；索引把这次折叠落盘，读路径变成一次 JSON 读。
       *
       * 三条纪律：
       *  - **要会话载体**：`getBoard` 是 agent 作用域端点（首参 `agent` 由网关按 `agentId` 解析），
       *    所以借本项目**第一个在线团队**的会话去读——索引是项目级的，谁的会话读都同一份；
       *    项目里一个在线团队都没有（全离线）→ 不白试，直接 `null` 走 `getProject` 的实时折叠。
       *  - **失败即降级**：抛错 / 没有 `project` / `tasks` 不是数组 → `null`（渲染侧回落），
       *    **绝不**因为索引坏了把「读不到」画成「这个项目没有任务」（那是谎报，比慢更糟）。
       *  - **派生数据不缓存**：每次 `project` 刷新（写后重载 / `watch` 追平）都重新拉一次，
       *    不在客户端留一份会过期的副本——索引自己是盘上那份，客户端只做一次性投影。
       */
      react.useEffect(() => {
        if (!projectRoot) { setBoardIndex(undefined); return undefined }
        const carrier = (project?.teams ?? []).find((team) => team.online && team.sessionId)
        if (!carrier) { setBoardIndex(null); return undefined }
        let alive = true
        makeApi(connection, carrier.sessionId).getBoard({})
          .then((r) => {
            if (!alive) return
            const index = r && typeof r === 'object' ? r.project : undefined
            setBoardIndex(index && Array.isArray(index.tasks) ? index : null)
          })
          .catch(() => { if (alive) setBoardIndex(null) })
        return () => { alive = false }
      }, [projectRoot, project, connection])
      /* CHG-102 / CHG-104：项目存储状态。
       * 纪律：**读取失败绝不阻塞面板**——失败/方法缺失/加载中一律视为「未知」(undefined)，
       * 照常渲染面板；只有明确拿到 `initialized:false` 才显示引导横幅（不替换整屏）。
       * CHG-164：取数已并入 `loadProject`（首屏 batch / 降级并行），这里**不再单独发一次**——
       * 两次都要拉同一份数据 = 首屏多一次往返，正是本项要治的病。 */
      /** 空态里的「初始化」：只建目录与元文件（幂等，不建团队不写账本） */
      const initStore = async () => {
        if (!projectRoot) return
        try {
          const r = await discoveryApi.initStore({ workspaceRoot: projectRoot })
          if (r?.status !== 'ok') { setError(r?.message ?? String(r)); return }
          setNotice(t('store.initDone').replace('{path}', String(r.rootDisplay ?? r.root ?? '')))
          await loadProject(projectRoot)
        } catch (e) { setError(String(e?.message ?? e)) }
      }
      /**
       * CHG-113：**长轮询追平**——账本一有新事件就刷新，替代 5s 轮询。
       *
       * 为什么能替：`watch` 在服务端挂着等（最多 25s），有新事件**立刻**返回；
       * 客户端拿到 `changed:true` 才重新拉看板，`changed:false` 就重开——空闲时零请求，
       * 有变化时毫秒级。切到后台时暂停（不请求网关），回到可见立刻补一次。
       *
       * 降级：旧宿主没有 `watch` 方法 → 直接返回，由下面的 5s 轮询兜底（绝不把面板搞死）。
       */
      react.useEffect(() => {
        if (typeof discoveryApi.watch !== 'function') return undefined
        if (!projectRoot) return undefined
        const teamId = selectedTeamId || (project?.teams ?? [])[0]?.teamId || ''
        if (!teamId) return undefined
        let alive = true
        let since = 0
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const loop = async () => {
          while (alive) {
            if (isHidden()) { await sleep(1000); continue }
            try {
              const r = await discoveryApi.watch({ workspaceRoot: projectRoot, teamId, sinceSeq: since, timeoutMs: 20000 })
              if (!alive) return
              if (typeof r?.seq === 'number') since = r.seq
              if (r?.changed) {
                await loadProject(projectRoot)
                await loadTeams()
              } else if (r?.status === 'empty') {
                /* 团队还没建账本：慢一点等，别把网关打满 */
                await sleep(2000)
              }
            } catch {
              /* 网关/网络抖动：退避后重试，不弹错（面板已有自己的 error 通道） */
              await sleep(3000)
            }
          }
        }
        void loop()
        return () => { alive = false }
      }, [projectRoot, selectedTeamId, project, discoveryApi, loadProject, loadTeams])
      /* 回退：只有宿主没有 `watch` 时才用 5s 轮询（CHG-113 之前的行为） */
      react.useEffect(() => {
        if (typeof discoveryApi.watch === 'function') return undefined
        const tick = () => {
          if (isHidden()) return
          loadTeams()
          if (projectRoot) loadProject(projectRoot)
        }
        const timer = setInterval(tick, POLL_MS)
        const onVisible = () => { if (!isHidden()) tick() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [loadTeams, loadProject, projectRoot, discoveryApi])

      /* 角色详情：点开时拉一次（含定义全文与在册情况）。
       * CHG-202x（P0-2）：**全局页没有项目根**——传空 workspaceRoot，服务端降级为
       * 「内置 + 全局 + 插件贡献」目录（在册为空）。修复前这里 `!projectRoot` 直接置 null，
       * 抽屉永远停在「加载中…」。 */
      react.useEffect(() => {
        if (!openRole || (scope === 'project' && !projectRoot)) { setRoleDetail(null); return undefined }
        let alive = true
        discoveryApi.getRoleDetail({ workspaceRoot: scope === 'project' ? projectRoot : '', roleId: openRole }).then((r) => {
          if (alive) setRoleDetail(r?.status === 'ok' ? r : null)
        }).catch(() => { if (alive) setRoleDetail(null) })
        return () => { alive = false }
      }, [openRole, projectRoot, discoveryApi, scope])

      const teamList = project?.teams ?? []
      const selectedTeam = selectedTeamId ? teamList.find((team) => team.teamId === selectedTeamId) : undefined
      const teamName = (id) => teamList.find((team) => team.teamId === id)?.name || id
      const memberName = (id) => {
        for (const team of teamList) {
          const m = (team.members ?? []).find((member) => member.id === id)
          if (m) return m.instanceName
        }
        return id
      }
      const api = react.useMemo(() => makeApi(connection, selectedTeam?.sessionId), [connection, selectedTeam?.sessionId])
      const offline = selectedTeam ? !selectedTeam.online : false

      const resetTeamCaches = () => {
        setKb(undefined); setAudit(undefined); setAuditFilter('all'); setConfig(undefined); setTokens(undefined); setInbox(null); setDisband(null)
        setArchiveSnap(undefined); setArchiveRoot('')
      }
      const openTeam = (teamId) => {
        setSelectedTeamId(teamId)
        setProjectTab('teams')
        setTeamTab('members')
        resetTeamCaches()
      }
      const closeTeam = () => { setSelectedTeamId(null); resetTeamCaches(); setShowCost(false) }

      /* CHG-86 / P0-2：归档团队选中时拉一次**真实快照**（archive/<teamId>/team.json 等落盘文件）。
       * 在线团队走 panel.getArchive（需要活跃会话）；离线团队 / 端点缺失 → 保持 undefined，
       * 归档视图降级到 board/tokens/audit 派生（不猜半个快照）。 */
      react.useEffect(() => {
        if (!selectedTeam || selectedTeam.state !== 'archived' || !selectedTeam.online || !selectedTeam.sessionId) {
          setArchiveSnap(undefined)
          setArchiveRoot('')
          return undefined
        }
        let alive = true
        makeApi(connection, selectedTeam.sessionId).getArchive({ teamId: selectedTeam.teamId }).then((r) => {
          if (!alive) return
          setArchiveSnap(r?.status === 'ok' ? (r.archive ?? null) : undefined)
          setArchiveRoot(r?.rootDisplay ? String(r.rootDisplay) : r?.root ? String(r.root) : '')
        }).catch(() => { if (alive) { setArchiveSnap(undefined); setArchiveRoot('') } })
        return () => { alive = false }
      }, [selectedTeam?.teamId, selectedTeam?.state, selectedTeam?.online, selectedTeam?.sessionId, connection])

      // 团队 tab 数据懒加载（知识/审计/设置/成本）
      react.useEffect(() => {
        if (!selectedTeam || !selectedTeamId) return undefined
        let alive = true
        const offlineCall = (method, query) => discoveryApi[method]({ workspaceRoot: projectRoot, teamId: selectedTeamId, ...query })
        if (teamTab === 'knowledge' && kb === undefined) {
          /* CHG-202x（P1-6）：知识库是**工作区级**资产（`knowledgeView()` 只读 workspaceRoot，与团队无关），
           * 所以离线团队照样能看。修复前这里按 `selectedTeam.online` 短路成 unavailable——
           * 归档/离线团队的知识 tab 永远是空的。走 discoveryApi（会话门面）而不是团队 api：
           * 后者绑定团队会话，离线时根本不存在。 */
          const pending = discoveryApi.getKnowledge({ workspaceRoot: projectRoot, teamId: selectedTeamId })
          pending.then((r) => { if (alive) setKb(r?.status === 'ok' ? (r.knowledge ?? null) : null) }).catch(() => { if (alive) setKb(null) })
        }
        if (teamTab === 'audit' && audit === undefined) {
          const pending = selectedTeam.online ? api.getAudit({ teamId: selectedTeamId, limit: 100 }) : offlineCall('getOfflineAudit', { limit: 100 })
          pending.then((r) => { if (alive) setAudit(r?.status === 'ok' ? { events: r.events ?? [], total: r.total ?? 0, nextBeforeSeq: r.nextBeforeSeq ?? null } : null) }).catch(() => { if (alive) setAudit(null) })
        }
        if (teamTab === 'settings' && config === undefined) {
          // 离线团队：getOfflineBoard 带出账本折叠后的生效配置（来源链 + 值），与在线同构
          const pending = selectedTeam.online
            ? api.getConfig({ teamId: selectedTeamId })
            : discoveryApi.getOfflineBoard({ workspaceRoot: projectRoot, teamId: selectedTeamId }).then((r) => (r?.status === 'ok' && r.config ? { status: 'ok', ...r.config } : { status: 'unavailable' }))
          pending.then((r) => { if (alive) setConfig(r?.status === 'ok' ? r : null) }).catch(() => { if (alive) setConfig(null) })
        }
        /* CHG-119（FR-11.6）：计划质量反馈——只读观测，离线团队走离线账本折叠 */
        if (teamTab === 'feedback' && feedback === undefined) {
          if (selectedTeam.online) {
            api.getPlanFeedback?.({ teamId: selectedTeamId })
              .then((r) => { if (alive) setFeedback(r?.status === 'ok' ? (r.feedback ?? null) : null) })
              .catch(() => { if (alive) setFeedback(null) })
          } else {
            setFeedback(null)
          }
        }
        return () => { alive = false }
      }, [teamTab, selectedTeam, selectedTeamId, projectRoot, api, discoveryApi, kb, audit, config, feedback])
      // 成本：选中团队即加载（底部成本栏 + 抽屉共用）
      /* CHG-202x（P1-13）：可刷新 + **三态**——`undefined` = 加载中、`null` = 读不到（离线/无侧车）、
       * 对象 = 有数据。修复前 `undefined` 与 `null` 都渲染成「整条成本栏消失」，用户看不出是没数据还是坏了；
       * 而且没有任何刷新入口（跑完任务要切团队才能看到新数字）。 */
      react.useEffect(() => {
        if (!selectedTeam) { setTokens(undefined); return undefined }
        let alive = true
        setTokens(undefined)
        const pending = selectedTeam.online
          ? makeApi(connection, selectedTeam.sessionId).getTokens({ teamId: selectedTeam.teamId })
          : discoveryApi.getOfflineTokens({ workspaceRoot: projectRoot, teamId: selectedTeam.teamId })
        pending.then((r) => { if (alive) setTokens(r?.status === 'ok' ? (r.tokens ?? null) : null) }).catch(() => { if (alive) setTokens(null) })
        return () => { alive = false }
      }, [selectedTeam, costToken, connection, discoveryApi, projectRoot])
      // 暂存横幅（在线团队）
      react.useEffect(() => {
        if (!selectedTeam || !selectedTeam.online || !selectedTeam.sessionId) { setInbox(null); return undefined }
        let alive = true
        makeApi(connection, selectedTeam.sessionId).getInbox({ teamId: selectedTeam.teamId }).then((r) => {
          if (alive) setInbox(r?.inbox ?? null)
        }).catch(() => { if (alive) setInbox(null) })
        return () => { alive = false }
      }, [selectedTeam, connection])
      // 全局预设（文件目录，不需要会话）——CHG-72：建队引导在项目页也要用，故不再限 scope
      react.useEffect(() => { setPresets(undefined) }, [projectRoot])
      react.useEffect(() => {
        if (!projectRoot || presets !== undefined) return undefined
        let alive = true
        discoveryApi.getOfflinePresets({ workspaceRoot: projectRoot }).then((r) => {
          if (alive) setPresets(r?.status === 'ok' ? r : null)
        }).catch(() => { if (alive) setPresets(null) })
        return () => { alive = false }
      }, [scope, projectRoot, presets, discoveryApi])
      /**
       * CHG-201：**全局作用域的数据面** = `getGlobalScope()`——内置 + 全局角色、内置/插件预设、
       * 插件贡献。不依赖任何项目（全局页不记录项目），因此与 `getProject` 两条数据面**互斥**。
       */
      react.useEffect(() => {
        if (scope !== 'global') return undefined
        let alive = true
        Promise.resolve(typeof discoveryApi.getGlobalScope === 'function' ? discoveryApi.getGlobalScope() : null)
          .then((g) => {
            if (!alive || !g) return
            setProject({ roles: g.roles ?? [], projectRole: g.projectRole ?? undefined, teams: [], tasks: [], counts: g.counts ?? {}, warnings: g.warnings ?? [] })
            if (g.presets) setPresets(g.presets)
          })
          .catch(() => { if (alive) setProject({ roles: [], teams: [], tasks: [], counts: {}, warnings: [] }) })
        return () => { alive = false }
      }, [scope, discoveryApi])
      // CHG-73：技能 / MCP 候选目录——角色表单打开时才拉（失败降级为「已有角色出现过的名字」）
      react.useEffect(() => { setCapCatalog(undefined) }, [projectRoot])
      react.useEffect(() => {
        /* CHG-82（G3）：技能 & MCP 页也要目录——角色表单没开、但全局作用域停在技能页时照样拉 */
        /* CHG-201：全局页没有项目根（`projectRoot` 为空），技能 & MCP 目录仍要能拉——
         * 服务端对空 workspaceRoot 降级为「宿主技能 + 无项目角色绑定」。 */
        if ((scope === 'project' && !projectRoot) || capCatalog !== undefined) return undefined
        if (!roleForm && !(scope === 'global' && globalPage === 'skills')) return undefined
        let alive = true
        discoveryApi.getCapabilityCatalog({ workspaceRoot: projectRoot }).then((r) => {
          if (alive) setCapCatalog(r?.status === 'ok' ? r : null)
        }).catch(() => { if (alive) setCapCatalog(null) })
        return () => { alive = false }
      }, [roleForm, projectRoot, capCatalog, discoveryApi, scope, globalPage])

      // CHG-63/69：筛选生效时把看板列区滚到第一个命中列（否则命中任务可能藏在右滚区）
      react.useEffect(() => {
        if (!taskQuery.trim() && taskPrio === 'all' && taskMember === 'all' && railTeam === 'all') return undefined
        const timer = setTimeout(() => {
          const el = typeof document !== 'undefined' ? document.querySelector('.mt-columns') : null
          if (!el) return
          const first = Array.from(el.children).find((col) => col.querySelector('.mt-task'))
          if (first) el.scrollLeft = Math.max(0, first.offsetLeft - el.offsetLeft - 8)
        }, 0)
        return () => clearTimeout(timer)
      }, [taskQuery, taskPrio, taskMember, railTeam])

      /* ── 顶部：tab（左）+ 当前项目（右，只读）——**同一行** ── */
      /* CHG-202b（用户定案）：项目是**会话属性**，不是界面状态——这里**不再有项目下拉**。
       * 给下拉就等于允许「在这个会话里看别的项目」，而那正是「所有项目看起来都一样」的入口。
       * 只读展示「项目名 + 完整路径」（路径走 title，长路径省略号截断）。
       *
       * CHG-202d（用户定案「角色 / 团队 / 任务标签靠左，项目具体信息靠右，放在一行中」）：
       * 原来 tab 单独占一行（`.mt-subtabs` 自带 border-bottom），顶栏右侧剩一大片空——
       * 两行合并成一行：tab 撑满整行（选中下划线正好压在这一行的底部分隔线上），
       * 项目信息用 `margin-left:auto` 贴右。行高仍是 44px，**不靠** tab 的固定 `height:40px`。
       *
       * CHG-202e（用户定案「红框的这部分去掉」）：**删掉插件名 `myteam` + 作用域标签 `项目` +
       * 竖分隔线**。它们只是自报家门——用户已经在「团队视图」这个 tab 里，项目名和路径自己
       * 说明了一切；留着反而把右侧挤满。现在右组只剩「项目名 + 路径 + 刷新」。
       * ⚠️ 作用域词条（`scope.project` / `scope.global`）仍留在词表里：`t13c-client` 的
       * 词条对等性断言要它，且将来别处要标作用域还能直接用。
       *
       * 数据依赖前置：`projectTabs` 要用 `rolesCount` / `projectTasks`，所以这几行从项目页
       * 区块上移到这里（全局页 `project` 为 null 时靠 `?.` 兜底，tab 也不渲染）。 */
      const pv = project
      /* CHG-202x（P0-2/P0-3）：角色表单的两块数据面（能力目录 + 保存写路径）上移到**两种作用域共用**的
       * 位置——全局页（侧边栏）也要能「新建 / 编辑 / 复制到项目」，而它原来提前 return，
       * 这三块定义在项目页 return 之后，全局页根本拿不到。 */
      /** 角色能力目录（getCapabilityCatalog；失败降级为「已有角色出现过的名字」并提示） */
      const fallbackCatalog = (() => {
        const collect = (key) => [...new Set((pv?.roles ?? []).flatMap((role) => role?.[key] ?? []))].sort()
        return {
          skills: collect('skills').map((name) => ({ name, source: 'role' })),
          mcp: collect('mcpAllowlist').map((name) => ({ name, source: 'role' })),
          warnings: [],
          fallback: true,
        }
      })()
      const catalogForForm = capCatalog === undefined ? undefined : (capCatalog ?? fallbackCatalog)
      /** 角色保存（CHG-72 / CHG-103）：配置资产写文件；作用域缺省项目级，全局由服务端返回 confirm-required */
      const saveRoleDef = async (role, confirm, scope) => {
        const result = await discoveryApi.saveRole({
          /* CHG-202x（P0-2）：全局作用域不需要项目根（服务端写 $DSH_HOME/myteam/roles） */
          workspaceRoot: scope === 'global' ? '' : projectRoot,
          role,
          scope: scope === 'global' ? 'global' : 'project',
          ...(scope === 'global' ? { confirmGlobal: confirm === true } : {}),
          confirm,
        })
        if (result?.status === 'saved') {
          setNotice(t('role.saved').replace('{id}', String(role.id)))
          await loadProject(projectRoot)
        }
        return result
      }
      /* CHG-193（T160 · M3-7）：任务区的数据源 = 项目看板派生索引（`getBoard({}).project`），
       * 索引未加载/不可用/为空时回落到 `getProject().tasks` 的实时折叠（详见 `resolveProjectTasks`）。
       * 会话绑定（online / sessionId）按 `ownerTeamId` 从实时名册补齐——索引刻意不存这两个字段。 */
      const projectTasks = resolveProjectTasks(boardIndex, pv?.teams, pv?.tasks)
      const rolesCount = (pv?.roles ?? []).length + (pv?.projectRole ? 1 : 0)
      /* tab 条：只有项目作用域有（全局页只读全局资产，没有项目 tab） */
      const projectTabs = scope === 'project'
        ? js('div', { className: 'mt-subtabs', role: 'tablist', children: [
          j('button', { className: projectTab === 'roles' ? 'mt-tab mt-tab-active' : 'mt-tab', role: 'tab', 'aria-selected': projectTab === 'roles', onClick: () => { setProjectTab('roles'); setSelectedTeamId(null); exitSelect() }, children: `${t('project.tabs.roles')}（${rolesCount}）` }),
          j('button', { className: projectTab === 'teams' ? 'mt-tab mt-tab-active' : 'mt-tab', role: 'tab', 'aria-selected': projectTab === 'teams', onClick: () => { setProjectTab('teams'); exitSelect() }, children: `${t('project.tabs.teams')}（${(pv?.teams ?? []).length}）` }),
          j('button', { className: projectTab === 'tasks' ? 'mt-tab mt-tab-active' : 'mt-tab', role: 'tab', 'aria-selected': projectTab === 'tasks', onClick: () => { setProjectTab('tasks'); setSelectedTeamId(null) }, children: `${t('project.tabs.tasks')}（${projectTasks.length}）` }),
        ] })
        : null
      const topbar = js('div', { className: 'mt-topbar', children: [
        projectTabs,
        js('div', { className: 'mt-topbar-right', children: [
          scope === 'project'
            ? (projectRoot
              ? js('span', { className: 'mt-project', title: projectRoot, children: [
                j('span', { className: 'mt-project-name', children: projectLabel(projectRoot) }),
                j('span', { className: 'mt-project-path', children: projectRoot }),
              ] })
              /* 解析中 / 解析不出：如实说，**不猜一个项目顶上** */
              : j('span', { className: 'mt-hint', role: 'status', 'aria-live': 'polite', children: scopeResolved ? t('project.unresolved') : t('project.resolving') }))
            : null,
          j('button', { className: 'mt-btn', onClick: () => { loadTeams(); if (projectRoot) loadProject(projectRoot) }, 'aria-label': t('action.reload'), children: t('action.reload') }),
        ] }),
      ] })

      /* CHG-82（G3）：全局作用域的随行资产子页——预设库（design/presets.html）与技能 & MCP（design/skills.html）。
       * 两层都是「入口不藏」：随行资产卡直接进，页内 teambar 的「← 全局」回角色库。 */
      /* CHG-201：全局子页（预设 / 技能 & MCP）**不依赖项目**——只读全局资产。 */
      if (scope === 'global' && globalPage !== 'roles') {
        const globalRoleList = [...(project?.roles ?? []), ...(project?.projectRole ? [project.projectRole] : [])]
        return js('div', { className: 'mt-panel', ...themeAttr, children: [
          topbar,
          globalPage === 'presets'
            ? j(PresetsPage, {
              t,
              presets,
              teams: project?.teams ?? [],
              onBack: () => setGlobalPage('roles'),
              onUse: () => openTeamCreator(),
              onNotice: setNotice,
              onSkills: () => setGlobalPage('skills'),
            })
            : j(SkillsPage, {
              t,
              roles: globalRoleList,
              catalog: capCatalog,
              onBack: () => setGlobalPage('roles'),
              onPresets: () => setGlobalPage('presets'),
              onNotice: setNotice,
              /* CHG-202x（P0-3）：「绑定到角色」曾调空实现 setScope——现在回全局角色库（列表里就能复制到项目/试召唤） */
              onBind: () => setGlobalPage('roles'),
            }),
        ] })
      }

      /* ── 全局页：只有角色 + 随行资产（预设 / 技能&MCP） ── */
      if (scope === 'global') {
        const globalRoles = (project?.roles ?? []).filter((role) => role.origin === 'global')
        const builtinRoles = (project?.roles ?? []).filter((role) => role.origin === 'builtin')
        const skills = new Set()
        const mcps = new Set()
        for (const role of project?.roles ?? []) {
          for (const s of role.skills ?? []) skills.add(s)
          for (const m of role.mcpAllowlist ?? []) mcps.add(m)
        }
        return js('div', { className: 'mt-panel', ...themeAttr, children: [
          topbar,
          /* CHG-80：信息条按 design/global.html 的 header.teambar——作用域标题 + 副标题 + 说明 + 主按钮 */
          js('div', { className: 'mt-teambar', children: [
            js('span', { className: 'mt-teambar-title', children: [
              j('b', { children: t('scope.global') }),
              j('span', { className: 'mt-teambar-id', children: t('global.crossProject') }),
            ] }),
            j('span', { className: 'mt-teambar-goal', children: t('global.rolesNote') }),
            js('span', { className: 'mt-teambar-actions', children: [
              j('button', {
                className: 'mt-btn mt-btn-primary mt-btn-sm',
                title: t('global.newRole'),
                /* CHG-202x（P0-3）：曾调空实现 setScope（点了没反应）。语义 = **新建一个全局角色**
                 * （全局页只有全局资产，没有项目库可写）。 */
                onClick: () => openRoleEditor({ mode: 'create', scope: 'global' }),
                children: `＋ ${t('global.newRole')}`,
              }),
            ] }),
          ] }),
          js('div', { className: 'mt-workspace', children: [
          js('div', { className: 'mt-page', children: [
            /* CHG-96：插件贡献区块必须在**全局作用域**可见。
             *
             * 为什么：`$DSH_HOME/myteam/plugins` 是全局位置，贡献的角色进的就是「全局角色库」——
             * 而这一段原本只在「项目」作用域的「角色」tab 里渲染，且「项目」按钮在未选工作区时
             * 是 disabled 的。结果：用户装完插件、打开面板（默认停「全局」）看不到任何入口，
             * 区块自己的文案却说「贡献进全局角色库」。放在这里才和它的语义一致。 */
            j(ContributionsSection, {
              t,
              api: discoveryApi,
              workspaceRoot: projectRoot,
              onNotice: setNotice,
              onChanged: () => loadProject(projectRoot),
            }),
            /* CHG-80：区块顺序对齐设计稿——内置 → 全局 → 随行资产；每段「标题 · N + 横线 + 右侧说明」 */
            js('div', { id: 'mt-roles-section', className: 'mt-section-head', children: [
              j('h3', { children: `${t('roles.page.builtin')} · ${builtinRoles.length}` }),
              j('span', { className: 'mt-rule', 'aria-hidden': true }),
              j('span', { className: 'mt-hint', children: t('global.builtinNote') }),
            ] }),
            js('div', { className: 'mt-cardgrid', children: builtinRoles.map((role) => j(RoleCard, { key: `${role.origin}:${role.id}`, t, role, onOpen: setOpenRole })) }),
            js('div', { id: 'mt-global-roles-section', className: 'mt-section-head', children: [
              j('h3', { children: `${t('roles.page.global')} · ${globalRoles.length}` }),
              j('span', { className: 'mt-rule', 'aria-hidden': true }),
              j('span', { className: 'mt-hint', children: t('global.globalNote') }),
            ] }),
            globalRoles.length === 0
              ? j('div', { className: 'mt-empty-inline mt-hint', children: t('roles.empty') })
              : js('div', { className: 'mt-cardgrid', children: globalRoles.map((role) => j(RoleCard, { key: `${role.origin}:${role.id}`, t, role, onOpen: setOpenRole })) }),
            /* CHG-80：随行资产按 design/global.html 的卡片结构重做——
             * 图标 + 标题 + 副标题 + 一行内容 + 跳转脚；点击滚到下方对应区块，不再用大留白静态卡。 */
            js('div', { className: 'mt-section-head', children: [
              j('h3', { children: t('global.assets') }),
              j('span', { className: 'mt-rule', 'aria-hidden': true }),
              j('span', { className: 'mt-hint', children: t('global.assetsNote') }),
            ] }),
            js('div', { className: 'mt-assets', children: [
              j('button', {
                className: 'mt-assetcard',
                title: t('global.jumpPresets'),
                onClick: () => setGlobalPage('presets'),
                children: [
                  js('div', { className: 'mt-assetcard-top', children: [
                    j('span', { className: 'mt-assetcard-icon', 'aria-hidden': true, children: j('svg', {
                      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                      children: [
                        j('path', { d: 'M8 1.8 14.2 5 8 8.2 1.8 5z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                        j('path', { d: 'M1.8 8 8 11.2 14.2 8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                        j('path', { d: 'M1.8 11 8 14.2 14.2 11', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                      ],
                    }) }),
                    js('div', { className: 'mt-assetcard-body', children: [
                      j('div', { className: 'mt-assetcard-title', children: t('global.presets') }),
                      j('div', { className: 'mt-assetcard-sub', children: t('global.presetsSub') }),
                    ] }),
                  ] }),
                  j('div', { className: 'mt-assetcard-row', children: (presets?.entries ?? []).length > 0
                    ? presets.entries.map((entry) => entry.definition?.name ?? entry.definition?.id ?? entry.file).join(' · ')
                    : t('global.presetsEmpty') }),
                  js('div', { className: 'mt-assetcard-foot', children: [
                    j('span', { className: 'mt-hint', children: t('global.presetCount').replace('{n}', String(presets?.entries?.length ?? 0)) }),
                    /* CHG-85：跳转指示用 SVG chevron（design/icons.svg#i-chevron-right），不用 → 字符 */
                    j('span', { className: 'mt-assetcard-chev', 'aria-hidden': true, children: j('svg', {
                      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
                      children: j('path', { d: 'M9.5 6l6 6-6 6', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                    }) }),
                  ] }),
                ],
              }),
              j('button', {
                className: 'mt-assetcard',
                title: t('global.jumpRoles'),
                onClick: () => setGlobalPage('skills'),
                children: [
                  js('div', { className: 'mt-assetcard-top', children: [
                    j('span', { className: 'mt-assetcard-icon', 'aria-hidden': true, children: j('svg', {
                      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                      children: [
                        j('path', { d: 'M2.2 4.6 8 2l5.8 2.6v6.8L8 14 2.2 11.4z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                        j('path', { d: 'M2.2 4.6 8 7.2l5.8-2.6M8 7.2V14', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                      ],
                    }) }),
                    js('div', { className: 'mt-assetcard-body', children: [
                      j('div', { className: 'mt-assetcard-title', children: t('global.skills') }),
                      j('div', { className: 'mt-assetcard-sub', children: t('global.skillsSub') }),
                    ] }),
                  ] }),
                  j('div', { className: 'mt-assetcard-row', children: skills.size + mcps.size > 0
                    ? [...skills].map((name) => t('global.skillItem').replace('{n}', name)).concat([...mcps].map((name) => t('global.mcpItem').replace('{n}', name))).join(' · ')
                    : t('global.skillsEmpty') }),
                  js('div', { className: 'mt-assetcard-foot', children: [
                    j('span', { className: 'mt-hint', children: t('global.skillCount').replace('{s}', String(skills.size)).replace('{m}', String(mcps.size)) }),
                    j('span', { className: 'mt-assetcard-chev', 'aria-hidden': true, children: j('svg', {
                      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
                      children: j('path', { d: 'M9.5 6l6 6-6 6', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                    }) }),
                  ] }),
                ],
              }),
            ] }),
            /* CHG-82（G3）：预设库与技能 & MCP 各自成页（design/presets.html · skills.html），
             * 入口就是上面的随行资产卡——这里不再内联一份预设卡列表（避免两套模板渲染）。 */
          ] }),
          openRole ? j(RoleDetailDrawer, {
            t,
            data: roleDetail,
            onClose: () => setOpenRole(null),
            teamName,
            onCopyToProject: copyRoleToProject,
            onGuest: guestRoleCommand,
            skillTotal: (capCatalog?.skills ?? []).length || undefined,
            /* CHG-202x（P0-2/P0-3）：全局页**没有项目根**——「复制到项目」必须置灰并说明。 */
            copyHint: t('roles.copyNeedsProject'),
            /* 全局角色就地编辑（写全局库）；内置角色只读，不给编辑入口。 */
            onEdit: roleDetail && roleDetail.origin === 'global'
              ? (detail) => openRoleEditor({ mode: 'edit', scope: 'global', definition: detail.definition })
              : undefined,
            /* 全局页只看与复制：删除是项目库的动作（deleteRoleFlow 在项目页作用域内），这里给只读说明 */
          }) : null,
          /* CHG-202x（P0-3）：角色编辑器必须在全局页也渲染——否则「＋ 新建角色」「编辑」点了没反应。
           * 保存走 saveRoleDef（scope=global → 服务端写 $DSH_HOME/myteam/roles）。 */
          roleForm ? j(RoleFormDrawer, {
            key: `role-${roleForm.mode}-${roleForm.definition?.id ?? 'new'}`,
            t,
            initial: roleForm,
            catalog: catalogForForm,
            onClose: () => setRoleForm(null),
            save: saveRoleDef,
          }) : null,
          ] }),
        ] })
      }

      /* ── 项目页 ── */
      /* CHG-202d：`pv` / `projectTasks` / `rolesCount` / `projectTabs` 已上移到顶栏之前
       * （tab 与项目信息合并成一行，`projectTabs` 要在 `topbar` 里渲染）。 */

      if (!projectRoot) {
        /* CHG-202b：项目页只有两种诚实状态，**都不猜项目**：
         *  - 还没解析完 → 「正在解析当前会话所属项目…」（`role=status`，读屏也知道在等）；
         *  - 解析完成仍没有工作目录 → 「解析不出当前会话的工作目录」（`role=alert`）。
         * 这里**不能**再退回 `global.empty`（「还没有团队」）——那是全局页的结论，
         * 项目页拿它占位等于骗人：用户会以为本项目没团队，而其实是没绑上项目。
         *
         * 另外：这里的 `<br>` **必须传 props 对象**（`j('br', {})`）。宿主的
         * `react/jsx-runtime` 是拿 `createElement` 顶的（`jsx = jsxs = createElement`），
         * 而那一版实现是 `d.key !== void 0` 直取、没有 `config != null` 兜底——
         * 少传第二个参数就是 `Cannot read properties of undefined (reading 'key')`，
         * 整块面板直接进渲染兜底（CHG-155 的「渲染失败」页）。 */
        return js('div', { className: 'mt-panel', ...themeAttr, children: [
          topbar,
          scopeResolved
            ? j('div', { className: 'mt-empty', role: 'alert', children: [t('project.unresolved'), j('br', {}), t('project.unresolvedHint')] })
            : j('div', { className: 'mt-empty', role: 'status', 'aria-live': 'polite', children: t('project.resolving') }),
        ] })
      }
      /**
       * CHG-104：**面板永不因为存储状态白屏**（用户反馈「UI 加载不出来」）。
       *
       * 修复前的两个 early return 把整屏换成了「加载中」/「一句话空态」：
       *  - `storeState === null`（读取失败或方法不存在）→ 永远停在「加载中」，没有出口；
       *  - `initialized === false` → 连 tab 和目录都不给看。
       *
       * 现在改成**非阻塞横幅**：未初始化时顶部提示 + 初始化按钮，**tab 与内容照常渲染**；
       * 未知（undefined）时什么都不显示，直接渲染正常面板。
       */
      /* CHG-202b（用户定案「如果没有初始化可以给一个初始化按钮，或者引导用户对话初始化」）：
       * 未初始化时给一块**能看懂、能动手**的引导卡，而不是把 4 个元素塞进一行 flex
       * （标题被正文挤扁、路径和按钮飘在最右，用户看不出该点哪）。
       * 版式：① 标题 + 存储路径（同行，路径省略号）② 一段说明 ③ 主按钮 + 对话式引导。
       * 仍然**非阻塞**——tab 与内容照常渲染，随时可以先去看看有什么。 */
      const storeBanner = scope === 'project' && storeState && storeState.initialized === false
        ? js('div', { className: 'mt-banner mt-banner-info mt-banner-store', role: 'status', children: [
            js('div', { className: 'mt-store-head', children: [
              j('b', { children: t('store.emptyTitle') }),
              j('code', { className: 'mt-banner-path mt-store-path', title: String(storeState.layout?.root ?? ''), children: String(storeState.layout?.rootDisplay ?? storeState.layout?.root ?? '') }),
            ] }),
            j('p', { className: 'mt-banner-text mt-store-text', children: t('store.emptyBody') }),
            js('div', { className: 'mt-store-actions', children: [
              j('button', { className: 'mt-btn mt-btn-primary mt-btn-sm', onClick: initStore, children: t('store.init') }),
              j('span', { className: 'mt-hint', children: t('store.initHint') }),
            ] }),
          ] })
        : null
      if (!pv) {
        return js('div', { className: 'mt-panel', ...themeAttr, children: [topbar, j('div', { className: 'mt-empty', children: error ?? t('state.loading') })] })
      }

      /* CHG-73：详情抽屉动作条的打开器（重新规划 / 取消）；成功后刷新看板 + 详情就地重载 */
      const openRescopeDialog = (detail) => {
        const ownerTeamId = openTask?.teamId
        const ownerTeam = (pv.teams ?? []).find((item) => item.teamId === ownerTeamId)
        setRescopeFor({
          teamId: ownerTeamId,
          taskId: detail?.id ?? openTask?.taskId,
          sessionId: openTask?.sessionId,
          title: detail?.input?.title ?? detail?.id ?? '',
          input: detail?.input ?? {},
          /* CHG-89（QA-4 乐观锁）：重新规划也是写路径——快照打开时的 revision */
          revision: detail?.revision,
          members: ownerTeam?.members ?? [],
          tasks: (pv.tasks ?? []).filter((task) => task.ownerTeamId === ownerTeamId),
        })
      }
      const openCancelDialog = (detail) => {
        const taskId = detail?.id ?? openTask?.taskId
        const ownerTeamId = openTask?.teamId
        /* CHG-75：rewire 档的候选新上游 = 同团队、排除自己、排除 cancelled/failed。
         * `done` 是合法候选（依赖已满足 → 下游立刻可领，这正是"改挂"的常见用途）；
         * `failed` 必须排除（永远不会完成，依赖它等于换一个死锁）。服务端语义为准。 */
        const upstreams = (pv.tasks ?? [])
          .filter((task) => task.ownerTeamId === ownerTeamId)
          .filter((task) => task.id !== taskId)
          .filter((task) => !['cancelled', 'failed'].includes(String(task.state ?? '')))
          .map((task) => ({ id: task.id, title: task.title ?? '', done: String(task.state ?? '') === 'done' }))
        setCancelFor({
          teamId: ownerTeamId,
          taskId,
          sessionId: openTask?.sessionId,
          title: detail?.input?.title ?? detail?.id ?? '',
          dependents: (pv.tasks ?? [])
            .filter((task) => task.ownerTeamId === ownerTeamId && (task.deps ?? []).includes(taskId))
            .map((task) => task.id),
          upstreams,
        })
      }
      const afterTaskMutation = async (message) => {
        setRescopeFor(null)
        setCancelFor(null)
        if (message) setNotice(message)
        setDetailToken((value) => value + 1)
        await loadProject(projectRoot)
      }
      const submitRescope = async (result) => {
        await afterTaskMutation(t('task.rescopeDone').replace('{id}', String(result?.taskId ?? '')).replace('{state}', stateLabel(result?.state)))
      }
      const submitCancel = async (result) => {
        const count = (result?.cancelled ?? []).length || 1
        /* CHG-75：rewire 档额外报「已改挂 N 个任务」（就地提示，不新开窗口） */
        const rewiredCount = (result?.rewired ?? []).length
        const message = rewiredCount > 0
          ? `${t('cancel.done').replace('{n}', String(count))}；${t('cancel.rewired').replace('{n}', String(rewiredCount))}`
          : t('cancel.done').replace('{n}', String(count))
        await afterTaskMutation(message)
      }
      /** CHG-76 C：诊断一键修复成功 → notice + 详情就地重载 + 看板刷新 */
      const onDiagnosisFixed = async (message) => {
        if (message) setNotice(message)
        setDetailToken((value) => value + 1)
        await loadProject(projectRoot)
      }
      /**
       * 删除任务（CHG-202x / P0-1）：两段确认（第一次拿影响面，第二次落账）；成功后关抽屉并刷新看板。
       * 端点走 openTask 绑定的队长会话（离线团队没有删除语义——那是账本写操作）。
       */
      const deleteTaskFlow = async (confirm) => {
        if (!openTask?.taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'missing taskId' }
        const result = await makeApi(connection, openTask.sessionId).deleteTask({ teamId: openTask.teamId, taskId: openTask.taskId, confirm: confirm === true })
        if (result?.status === 'deleted') {
          setNotice(t('task.deleted').replace('{id}', String(openTask.taskId)))
          setOpenTask(null)
          await loadProject(projectRoot)
        }
        return result
      }
      /**
       * 任务详情抽屉（CHG-202x / P0-4）：**三个入口共用一份**——团队工作台、任务 tab、归档回放。
       *
       * 归档分支原来在 `teamsPage` 里提前 return，`openTask` 永不被消费（「看证据 / 看门禁」点了没反应，
       * 也没有任何提示）。`membersForTeam` 由调用方给：归档团队的名册来自快照，其它来自实时名册。
       */
      const taskDetailNode = (membersForTeam) => (openTask
        ? j(TaskDetail, {
          api: makeApi(connection, openTask.sessionId),
          t,
          teamId: openTask.teamId,
          taskId: openTask.taskId,
          readOnly: !openTask.online,
          memberName,
          teamName,
          /* CHG-86：门禁裁决的审查人下拉需要名册（离线团队 getBoard 不可用） */
          members: membersForTeam ?? [],
          refreshToken: detailToken,
          loader: openTask.online ? undefined : (q) => discoveryApi.getOfflineTaskDetail({ ...q, workspaceRoot: projectRoot }),
          onRescope: openTask.online ? openRescopeDialog : undefined,
          onCancel: openTask.online ? openCancelDialog : undefined,
          /* CHG-202x（P0-1）：删除任务（产品定案「不能手动建，可以手动删除」） */
          onDelete: openTask.online ? deleteTaskFlow : undefined,
          onDiagnosisFixed,
          onEdit: openTask.online ? (detail) => openTaskEditor({
            mode: 'edit',
            task: {
              id: detail.id,
              ownerTeamId: openTask.teamId,
              ownerOnline: true,
              ownerSessionId: openTask.sessionId,
              state: detail.state,
              /* CHG-89（QA-4 乐观锁）：打开表单时快照 revision，保存时作为
               * expectedRevision 回传——服务端不等即 MT_REVISION_CONFLICT（账本零写入）。 */
              revision: detail.revision,
              input: detail.input,
              assignees: detail.assignees,
              participants: detail.participants,
            },
          }) : undefined,
          onClose: () => setOpenTask(null),
        })
        : null)
      /* CHG-172（A11 / FR-16.1）：单角色调用应用——写路径 = facade.applyRoles（需在线团队会话作载体，不写团队账本）
       * CHG-178：`guestBusy` / `guestNote` 两个 state 已上移到 Panel 顶部（早退之前），此处只留动作。 */
      const applyGuestRoles = async (picked) => {
        if (guestBusy || !Array.isArray(picked) || picked.length === 0) return
        const carrier = (pv.teams ?? []).find((team) => team.online && team.sessionId)
        if (!carrier) { setGuestNote({ kind: 'warn', text: t('guest.noCarrier') }); return }
        setGuestBusy(true)
        setGuestNote(null)
        try {
          const r = await makeApi(connection, carrier.sessionId).applyRoles({ teamId: carrier.teamId, roles: picked })
          if (r?.status === 'ok') setGuestNote({ kind: 'ok', text: t('guest.applied').replace('{n}', String(picked.length)) })
          else setGuestNote({ kind: 'warn', text: String(r?.message ?? r?.code ?? t('guest.failed')) })
        } catch (e) {
          setGuestNote({ kind: 'warn', text: String(e?.message ?? e) })
        } finally {
          setGuestBusy(false)
        }
      }
      /* CHG-73：批量编排——按主责团队分组逐个 batchTaskOp（每条事件同一 batchId 由服务端落） */
      /* 角色页（design/roles.html）：三层来源分区 + 搜索/来源筛选 + 引用计数 + 复制/对比 + 创建卡 */
      /* CHG-202c：**必须带类名**。`.mt-workspace` 是 `display:flex` 的**行**容器，这个根 div 是它的
       * flex item（`flex:0 1 auto`）——不给 `flex:1` 就退化成「内容宽度」，于是里面
       * `padding-inline: calc((100% - 1100px)/2)` 的百分比按**收缩后的宽度**算（2148 画布下实测
       * 176px 而不是 380px），整页内容左对齐、右边空一大块。`.mt-home` / `.mt-workbench`
       * 本来就有 `flex:1`，所以只有角色页塌。 */
      const rolesPage = js('div', { className: 'mt-rolepage', children: [
        /* CHG-91：插件贡献（只读 + 装载告警 + 重新扫描）——放在角色库顶部，
         * 因为「这个角色是谁给的」必须在用户看列表之前就有答案 */
        j(ContributionsSection, {
          t,
          api: discoveryApi,
          workspaceRoot: projectRoot,
          onNotice: setNotice,
          onChanged: () => loadProject(projectRoot),
        }),
        /* CHG-172（A11 / FR-16.1）：单角色调用——/myteam+ 的可视化多选入口（PRD 拍板保留在角色 tab 管理场景） */
        j(GuestApplySection, {
          t,
          roles: pv.roles ?? [],
          carrier: (pv.teams ?? []).find((team) => team.online && team.sessionId) ?? null,
          busy: guestBusy,
          note: guestNote,
          onApply: applyGuestRoles,
        }),
        j(RoleLibrary, {
          t,
          pv,
          onOpen: setOpenRole,
          onGuest: guestRoleCommand,
          onCopyToProject: copyRoleToProject,
          onCompare: (role) => setOpenRole(role.id),
          onCreate: () => openRoleEditor({ mode: 'create' }),
          /* CHG-202x（P0-3）：「引入全局角色」曾调空实现 setScope——现在把来源筛选切到「全局」 */
          filter: roleOriginFilter,
          onFilter: setRoleOriginFilter,
          onIntroGlobal: () => setRoleOriginFilter('global'),
        }),
      ] })

      /* 团队页：列表 or 团队工作台（队员/参与任务/知识/审计/设置） */
      const participatingCount = (teamId) => (pv.tasks ?? []).filter((task) => (task.participants ?? []).some((p) => p.teamId === teamId)).length
      const teamsPage = selectedTeam
        ? (() => {
          const team = selectedTeam
          /* [G4 ledger · 归档回放] —— design/archive.html：归档团队整体换归档条 + 只读回放 */
          if (team.state === 'archived') {
            const archivedTasks = (pv.tasks ?? []).filter((task) => task.ownerTeamId === team.teamId)
            const loadMoreAudit = async () => {
              if (!audit?.nextBeforeSeq) return
              const call = team.online
                ? api.getAudit({ teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
                : discoveryApi.getOfflineAudit({ workspaceRoot: projectRoot, teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
              try {
                const r = await call
                if (r?.status !== 'ok') return
                setAudit({ events: [...(audit.events ?? []), ...(r.events ?? [])], total: r.total ?? audit.total, nextBeforeSeq: r.nextBeforeSeq ?? null })
              } catch (e) { setError(String(e?.message ?? e)) }
            }
            return j(ArchiveReplay, {
              t,
              team,
              tasks: archivedTasks,
              tokens,
              audit,
              memberName,
              /* CHG-86 / P0-2：真实归档快照（拿不到时组件内降级到 board 派生） */
              archive: archiveSnap,
              archiveRoot,
              onMoreAudit: loadMoreAudit,
              onBack: closeTeam,
              onOpenAll: () => { closeTeam(); setProjectTab('teams') },
              onOpenTask: (task) => setOpenTask({ teamId: task.ownerTeamId, taskId: task.id, online: task.ownerOnline, sessionId: task.ownerSessionId }),
            })
          }
          const teamTasksAll = (pv.tasks ?? []).filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId))
          /* CHG-187（FR-32 支柱一）：`childCount` 从**同一份名册**现算（与 `listMembers` 同源）：
           * 释放按钮据此决定要不要二次确认「将一并释放 N 个子成员」。 */
          const members = (team.members ?? []).map((member) => ({
            ...member,
            childCount: (team.members ?? []).filter((other) => other.parentMemberId === member.id).length,
          }))
          const taskTitle = (id) => (teamTasksAll.find((task) => task.id === id)?.title)
          /* CHG-119：团队内 tab 增加「反馈」（FR-11.6 计划质量），排在审计后、设置前 */
          const tabs = ['members', 'participating', 'knowledge', 'audit', 'feedback', 'settings']
          const tabLabel = (key) => {
            if (key === 'members') return `${t('tab.members')}（${members.length}）`
            if (key === 'participating') return `${t('team.tab.participating')}（${teamTasksAll.length}）`
            return t(`tab.${key}`)
          }
          let content
          /* [G2 roster · 名册 tab] —— 团队内「队员」tab（design/roster.html）：一张卡一个角色 + 实例行 + 召唤卡 */
          if (teamTab === 'members') {
            const active = members.filter((m) => m.status === 'active' || m.status === 'suspended')
            const inactive = members.filter((m) => m.status !== 'active' && m.status !== 'suspended')
            const roleOf = (roleId) => (pv.roles ?? []).find((role) => role.id === roleId && role.origin === 'project')
              ?? (pv.roles ?? []).find((role) => role.id === roleId)
            const groupByRole = (list) => {
              const map = new Map()
              for (const member of list) {
                const bucket = map.get(member.roleId)
                if (bucket) bucket.push(member)
                else map.set(member.roleId, [member])
              }
              return [...map.entries()]
            }
            const summon = () => { setProjectTab('roles'); setSelectedTeamId(null) }
            const maxMembers = config?.config?.limits?.maxMembers ?? 6
            const openMemberTask = (taskId) => setOpenTask({ teamId: team.teamId, taskId, online: team.online, sessionId: team.sessionId })
            content = js('div', { className: 'mt-page', children: [
              team.online ? null : j('div', { className: 'mt-note', children: t('offline.readonlyTip') }),
              js('div', { className: 'mt-page-head', children: [
                js('div', { children: [j('h2', { children: t('roster.page.title') }), j('p', { children: t('roster.page.desc') })] }),
                js('div', { className: 'mt-page-head-actions', children: [
                  j('button', { className: 'mt-btn mt-btn-primary', onClick: summon, children: `＋ ${t('roster.summon')}` }),
                ] }),
              ] }),
              js('div', { className: 'mt-note mt-note-info', children: [
                j('b', { children: t('roster.noCaptain') }),
                j('span', { children: ` — ${t('roster.noCaptainHint')}` }),
              ] }),
              active.length === 0
                ? j('div', { className: 'mt-empty', children: t('roster.empty') })
                : js('div', { className: 'mt-roster-grid', children: [
                  ...groupByRole(active).map(([roleId, list]) => j(MemberCard, {
                    key: roleId,
                    t,
                    roleId,
                    role: roleOf(roleId),
                    members: list,
                    tasks: teamTasksAll,
                    tokens,
                    teamName,
                    taskTitle,
                    readOnly: !team.online,
                    api,
                    teamId: team.teamId,
                    onOpen: openMemberTask,
                    onChanged: () => loadProject(projectRoot),
                    onError: setError,
                    onNotice: setNotice,
                  })),
                  j(RosterSummonCard, { key: 'summon', t, onSummon: summon }),
                ] }),
              inactive.length > 0 ? js('div', { className: 'mt-roster-inactive', children: [
                j('h4', { children: `${t('roster.inactive')}（${inactive.length}）` }),
                js('div', { className: 'mt-roster-grid', children: groupByRole(inactive).map(([roleId, list]) => j(MemberCard, {
                  key: `inactive-${roleId}`,
                  t,
                  roleId,
                  role: roleOf(roleId),
                  members: list,
                  tasks: teamTasksAll,
                  tokens,
                  teamName,
                  taskTitle,
                  readOnly: !team.online,
                  api,
                  teamId: team.teamId,
                  onOpen: openMemberTask,
                  onChanged: () => loadProject(projectRoot),
                  onError: setError,
                  onNotice: setNotice,
                })) }),
              ] }) : null,
              /* CHG-87 §5.3：单角色调用（/myteam+<roleId> 语法）—— 面板没有会话输入框，
               * 挂载点落在团队页（见 GuestRoleCallCard 注释）。 */
              j(GuestRoleCallCard, {
                t,
                api,
                teamId: team.teamId,
                readOnly: !team.online,
                onChanged: () => loadProject(projectRoot),
                onNotice: setNotice,
                onError: setError,
              }),
              j('p', { className: 'mt-note', children: t('roster.limitNote').replace('{n}', String(maxMembers)).replace('{active}', String(members.filter((m) => m.status === 'active' || m.status === 'suspended').length)) }),
            ] })
          /* [G2 roster · 参与任务 tab] —— 团队参与的跨团队任务（design/team-tasks.html） */
          } else if (teamTab === 'participating') {
            const leadCount = teamTasksAll.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'lead')).length
            const coopCount = teamTasksAll.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'coop')).length
            const stateChip = (state) => (state === 'done' ? 'mt-status-done'
              : state === 'failed' || state === 'cancelled' ? 'mt-status-fail'
              : String(state).startsWith('gate') || state === 'gates' ? 'mt-status-gate'
              : state === 'in_progress' || state === 'running' || state === 're-scoping' ? 'mt-status-run'
              : 'mt-status-idle')
            const PARTICIPATING_LIMIT = 8
            const filtered = teamTasksAll.filter((task) => {
              if (teamTaskFilter === 'all') return true
              const mine = (task.participants ?? []).find((p) => p.teamId === team.teamId)
              return (mine?.role ?? 'coop') === teamTaskFilter
            })
            const shown = filtered.slice(0, PARTICIPATING_LIMIT)
            const rest = filtered.slice(PARTICIPATING_LIMIT)
            content = js('div', { className: 'mt-page', children: [
              /* 任务头 + 页头（design/team-tasks.html 的 .page-head：只列本团队参与的任务与主责/协作） */
              js('div', { className: 'mt-section-head', children: [
                j('h3', { children: t('g6.teamTasks.title') }),
                j('span', { className: 'mt-rule', 'aria-hidden': true }),
                /* CHG-202x（P1-10）：「看板视图」曾写成 `setOpenTask(null)`——什么都没发生。
                 * 正确语义是切到项目「任务」tab 的看板（并退出团队工作台）。 */
                j('button', { className: 'mt-btn mt-btn-sm', onClick: () => { setOpenTask(null); setSelectedTeamId(null); setProjectTab('tasks') }, children: t('g6.teamTasks.boardBtn') }),
              ] }),
              j('p', { className: 'mt-hint', children: t('g6.teamTasks.desc') }),
              /* 本队角色筛选：全部 / 主责 / 协作（实线 = 主责，虚线 = 协作） */
              js('div', { className: 'mt-filterbar', children: [
                js('div', { className: 'mt-seg', role: 'group', 'aria-label': t('g6.teamTasks.title'), children: [
                  ['all', t('g6.teamTasks.filterAll').replace('{n}', String(teamTasksAll.length))],
                  ['lead', t('g6.teamTasks.filterLead').replace('{n}', String(leadCount))],
                  ['coop', t('g6.teamTasks.filterCoop').replace('{n}', String(coopCount))],
                ].map(([key, label]) => j('button', {
                  key,
                  className: teamTaskFilter === key ? 'mt-seg mt-seg-active' : 'mt-seg',
                  'aria-pressed': teamTaskFilter === key,
                  onClick: () => setTeamTaskFilter(key),
                  children: label,
                })) }),
                j('span', { className: 'mt-filterbar-hint', children: t('g6.teamTasks.filterHint') }),
              ] }),
              teamTasksAll.length === 0
                ? j('div', { className: 'mt-empty', children: t('tasks.empty') })
                : js('div', { children: shown.map((task) => {
                  const mine = (task.participants ?? []).find((p) => p.teamId === team.teamId) ?? {}
                  const others = (task.participants ?? []).filter((p) => p.teamId !== team.teamId)
                  return js('button', {
                    key: task.key,
                    className: 'mt-trow',
                    onClick: () => setOpenTask({ teamId: task.ownerTeamId, taskId: task.id, online: task.ownerOnline, sessionId: task.ownerSessionId }),
                    children: [
                      j('span', { className: 'mt-tid', children: task.id }),
                      j('span', { className: 'mt-tt', children: task.title }),
                      j('span', {
                        /* design/team-tasks.html：主责 = 实心主色 chip，协作 = 虚线 chip */
                        className: `mt-status-chip ${mine.role === 'lead' ? 'mt-status-filled' : 'mt-status-dashed'}`,
                        children: [
                          j('span', { className: 'mt-shape', 'aria-hidden': true }),
                          j('span', { children: mine.role === 'lead' ? t('task.owner') : t('task.coop') }),
                        ],
                      }),
                      j('span', {
                        className: `mt-status-chip ${stateChip(task.state)}`,
                        children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: stateLabel(task.state) })],
                      }),
                      j('span', { className: 'mt-who', children: (task.assignees ?? []).map((id) => j('span', { key: id, className: 'mt-mini-chip mt-mini-chip-num', children: memberName(id) })) }),
                      ...others.map((p) => j('span', {
                        key: `other-${p.teamId}`,
                        className: 'mt-mini-chip mt-mini-chip-coop',
                        children: t(p.role === 'lead' ? 'g6.teamTasks.leadTeam' : 'g6.teamTasks.coopTeam').replace('{name}', teamName(p.teamId)),
                      })),
                      j('span', { className: 'mt-chev', 'aria-hidden': true, children: '›' }),
                    ],
                  })
                }) }),
              rest.length > 0
                ? js('button', {
                  className: 'mt-trow mt-trow-more',
                  /* CHG-202x（P1-10）：同上的死控件——「其余 N 条」必须真的跳到任务看板 */
                  onClick: () => { setOpenTask(null); setSelectedTeamId(null); setProjectTab('tasks') },
                  children: [
                    j('span', { className: 'mt-tid', children: '…' }),
                    j('span', { className: 'mt-tt', children: t('g6.teamTasks.rest')
                      .replace('{n}', String(rest.length))
                      .replace('{backlog}', String(rest.filter((task) => task.state === 'backlog' || task.state === 'ready').length))
                      .replace('{done}', String(rest.filter((task) => task.state === 'done').length)) }),
                    j('span', { className: 'mt-who', children: j('span', { className: 'mt-mini-link', children: t('g6.teamTasks.gotoBoard') }) }),
                  ],
                })
                : null,
              js('p', { className: 'mt-note mt-note-info', children: [
                j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '⑃' }),
                j('span', { children: t('g6.teamTasks.note') }),
              ] }),
            ] })
          /* [G3 knowledge · 知识 tab] —— design/knowledge.html */
          } else if (teamTab === 'knowledge') {
            /* 写路径（提案裁决）与只读数据面分开渲染：KnowledgeTab 的 props 契约保持
             * `{ t, data, members }`（t63-1 断言），采纳 / 驳回由 KnowledgeProposals 直通 adoptKnowledge。 */
            content = js('div', { children: [
              j(KnowledgeProposals, {
                t,
                proposals: kb?.proposals ?? [],
                members,
                api,
                teamId: team.teamId,
                readOnly: !team.online,
                onChanged: () => { setKb(undefined); loadProject(projectRoot) },
                onNotice: setNotice,
                onError: setError,
              }),
              j(KnowledgeTab, { t, data: kb, members }),
            ] })
          /* [G4 ledger · 审计 tab] —— design/audit.html */
          } else if (teamTab === 'audit') {
            content = j(AuditTab, {
              t, audit, tasks: teamTasksAll, memberName,
              filter: auditFilter,
              setFilter: setAuditFilter,
              onOpen: (taskId) => setOpenTask({ teamId: team.teamId, taskId, online: team.online, sessionId: team.sessionId }),
              /* CHG-202x（P1-7）：导出反馈走顶部 notice 条 */
              onNotice: setNotice,
              onMore: async () => {
                if (!audit?.nextBeforeSeq) return
                const pending = team.online
                  ? api.getAudit({ teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
                  : discoveryApi.getOfflineAudit({ workspaceRoot: projectRoot, teamId: team.teamId, limit: 100, beforeSeq: audit.nextBeforeSeq })
                try {
                  const r = await pending
                  if (r?.status !== 'ok') return
                  setAudit({ events: [...(audit.events ?? []), ...(r.events ?? [])], total: r.total ?? audit.total, nextBeforeSeq: r.nextBeforeSeq ?? null })
                } catch (e) { setError(String(e?.message ?? e)) }
              },
            })
          /* [G4 ledger · 反馈 tab] —— design 未单列屏；FR-11.6「先可观测不自动改」 */
          } else if (teamTab === 'feedback') {
            content = j(PlanFeedbackTab, { t, feedback })
          /* [G4 ledger · 设置 tab] —— design/settings.html */
          } else {
            content = j(SettingsTab, {
              t,
              config: config ?? undefined,
              offline: !team.online,
              team,
              connection,
              onDisbanded: () => { closeTeam(); loadProject(projectRoot) },
              /* CHG-118：保存 / 恢复默认后刷新生效配置与团队看板（配置在服务端重建过服务） */
              onSaved: (view) => {
                if (view?.status === 'ok') setConfig(view)
                else setConfig(undefined)
                setBoard(undefined)
              },
            })
          }
          const askDisband = async () => {
            if (!team.online) return
            try {
              const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: false })
              if (r?.status === 'confirm-required') setDisband({ impact: r.impact ?? {} })
            } catch (e) { setError(String(e?.message ?? e)) }
          }
          const doDisband = async () => {
            if (!team.online || disbandBusy) return
            setDisbandBusy(true)
            try {
              const r = await makeApi(connection, team.sessionId).disband({ teamId: team.teamId, confirm: true })
              if (r?.ok === false || r?.status === 'error') { setError(r?.message ?? 'disband failed'); return }
              setDisband(null)
              closeTeam()
              await loadProject(projectRoot)
            } catch (e) { setError(String(e?.message ?? e)) } finally { setDisbandBusy(false) }
          }
          return js('div', { className: 'mt-panel', ...themeAttr, children: [
            js('div', { className: 'mt-topbar', children: [
              j('button', { className: 'mt-btn', onClick: closeTeam, children: t('team.backList') }),
              j('strong', { className: 'mt-title', children: team.name || team.teamId }),
              team.name && team.name !== team.teamId ? j('span', { className: 'mt-hint', children: team.teamId }) : null,
              team.goal ? j('span', { className: 'mt-goal', children: team.goal }) : null,
              j('span', { className: 'mt-chip', children: `${stateShape(team.state)} ${stateLabel(team.state)}` }),
              team.online ? null : j('span', { className: 'mt-chip mt-chip-offline', children: t('global.offline') }),
              j('span', { className: 'mt-hint', children: `${t('global.counts').replace('{done}', String(team.counts?.done ?? 0)).replace('{total}', String(team.counts?.tasks ?? 0))} · ${t('global.running').replace('{n}', String(team.counts?.running ?? 0))}` }),
              team.online ? j('button', { className: 'mt-btn mt-btn-danger', onClick: askDisband, children: t('action.disband') }) : null,
            ] }),
            /* CHG-82 G1：解散改走 design/confirm.html 的两段确认（四条不可撤销影响 + 输入 teamId 才可提交） */
            disband ? j(DisbandDialog, {
              t,
              teamId: team.teamId,
              teamName: team.name || team.teamId,
              impact: disband.impact,
              busy: disbandBusy,
              error: null,
              onConfirm: doDisband,
              onClose: () => setDisband(null),
            }) : null,
            team.online ? j(StagedBanner, { api: makeApi(connection, team.sessionId), t, teamId: team.teamId, inbox, onAct: () => loadProject(projectRoot) }) : null,
            js('div', { className: 'mt-tabs', role: 'tablist', children: tabs.map((key) => j('button', {
              key,
              className: teamTab === key ? 'mt-tab mt-tab-active' : 'mt-tab',
              role: 'tab',
              'aria-selected': teamTab === key,
              onClick: () => setTeamTab(key),
              children: tabLabel(key),
            })) }),
            js('div', { className: 'mt-workspace', children: [content, taskDetailNode(members)] }),
            j(CostBar, { t, tokens, onOpen: () => setShowCost(true), onRefresh: () => setCostToken((value) => value + 1) }),
          ] })
        })()
        : j(TeamsHome, {
          t,
          teams: pv.teams ?? [],
          tasks: pv.tasks ?? [],
          workspaceRoot: projectRoot,
          gateOf: (teamId) => (pv.tasks ?? []).filter((task) => task.ownerTeamId === teamId && String(task.state).startsWith('gate:')).length,
          onOpen: openTeam,
          onCreateTeam: openTeamCreator,
        })

      /* 任务页：左参与团队轨 + 视图条 + 四视图 + 详情抽屉 */
      /* CHG-193（T160）：四视图（列表 / 看板 / 流程 / 依赖图）统一吃 `projectTasks`——
       * 派生索引优先、`getProject` 兜底；这里不再直接读 `pv.tasks`（团队页那几处仍读，见文档）。 */
      const allProjectTasks = projectTasks
      const matches = (task) => {
        if (railTeam !== 'all' && !(task.participants ?? []).some((p) => p.teamId === railTeam)) return false
        if (taskPrio !== 'all' && String(task.priority) !== taskPrio) return false
        if (taskMember !== 'all') {
          const ids = task.assignees ?? (task.assignee ? [task.assignee] : [])
          if (!ids.includes(taskMember)) return false
        }
        const needle = taskQuery.trim().toLowerCase()
        if (!needle) return true
        const hay = [task.id, task.title, task.key, ...(task.deps ?? []), ...(task.participants ?? []).map((p) => p.teamId)].join(' ').toLowerCase()
        return hay.includes(needle)
      }
      const shownTasks = allProjectTasks.filter(matches)
      const filtersActive = Boolean(taskQuery.trim()) || taskPrio !== 'all' || taskMember !== 'all' || railTeam !== 'all'
      /* CHG-73：批量编排——按主责团队分组逐个 batchTaskOp（同一 op 的多团队选择也能一次跑完） */
      const selectedTasks = shownTasks.filter((task) => selected.has(task.key))
      const runBatch = async (op, extra, confirmed) => {
        const groups = new Map()
        for (const task of selectedTasks) {
          const bucket = groups.get(task.ownerTeamId)
          if (bucket) bucket.push(task)
          else groups.set(task.ownerTeamId, [task])
        }
        const results = []
        const impacts = []
        for (const [teamId, list] of groups) {
          const team = (pv.teams ?? []).find((item) => item.teamId === teamId)
          if (!team?.online || !team?.sessionId) {
            results.push({ taskId: list[0]?.id ?? '—', ok: false, code: 'MT_OFFLINE', message: t('batch.offlineSkipped') })
            continue
          }
          const query = { teamId, op, taskIds: list.map((task) => task.id) }
          if (extra?.reason) query.reason = extra.reason
          /* CHG-73：批量取消下游策略（leave 默认 / cancel 级联），与影响面预览同一档 */
          if (op === 'cancel' && extra?.downstream) query.downstream = extra.downstream
          /* CHG-76 A：rewire 档带统一新上游（缺省 = 解除依赖） */
          if (op === 'cancel' && extra?.rewireTo) query.rewireTo = extra.rewireTo
          if (op === 'assign') {
            const own = new Set((team.members ?? []).map((member) => member.id))
            const memberIds = (extra?.memberIds ?? []).filter((id) => own.has(id))
            if (memberIds.length === 0) {
              results.push({ taskId: list[0]?.id ?? '—', ok: false, code: 'MT_VALIDATION', message: t('batch.assignTeamEmpty') })
              continue
            }
            query.memberIds = memberIds
          }
          if (op === 'priority') query.priority = extra?.priority
          if (confirmed) query.confirm = true
          try {
            const r = await makeApi(connection, team.sessionId).batchTaskOp(query)
            if (r?.status === 'confirm-required') { impacts.push({ teamId, impact: r.impact ?? {} }); continue }
            if (r?.status === 'error') { results.push({ taskId: list[0]?.id ?? '—', ok: false, code: r.code, message: r.message }); continue }
            results.push(...(r?.results ?? []))
          } catch (e) {
            results.push({ taskId: list[0]?.id ?? '—', ok: false, message: String(e?.message ?? e) })
          }
        }
        if (impacts.length > 0) return { kind: 'confirm', impacts }
        const ok = results.filter((item) => item.ok).length
        /* CHG-76 A：把逐条 results 带回（afterBatch 要汇总 results[].rewired 报「已改挂 N 个任务」） */
        return { kind: 'done', ok, failed: results.length - ok, results }
      }
      const afterBatch = async (result) => {
        await loadProject(projectRoot)
        const results = result?.results ?? []
        /* CHG-76 A：已改挂 = results.flatMap(r => r.rewired ?? []).length（added 缺省 = 解除依赖，同样计数） */
        const rewiredCount = results.flatMap((item) => (Array.isArray(item?.rewired) ? item.rewired : [])).length
        const base = t('batch.done').replace('{ok}', String(result?.ok ?? 0)).replace('{failed}', String(result?.failed ?? 0))
        const withRewired = rewiredCount > 0 ? `${base} · ${t('batch.rewiredDone').replace('{n}', String(rewiredCount))}` : base
        /* 失败条目把服务端 message 原样带出来（如整批拒绝的 MT_VALIDATION「这一批…」/ 逐条 MT_TASK_CYCLE） */
        const failureNotes = [...new Set(results
          .filter((item) => item && item.ok === false)
          .map((item) => String(item.message ?? item.code ?? ''))
          .filter(Boolean))].slice(0, 2)
        setNotice(failureNotes.length > 0 ? `${withRewired} · ${t('batch.failedItems').replace('{items}', failureNotes.join('；'))}` : withRewired)
        exitSelect()
      }
      /* design/lanes.html 的 .trail：参与团队轨（行首头像 + 名称 + 参与统计） */
      const railItem = (key, name, meta, avatar, pressed) => js('button', {
        key,
        className: 'mt-teamrail-item mt-titem',
        'aria-pressed': pressed ? 'true' : 'false',
        title: meta,
        onClick: () => setRailTeam(key),
        children: [
          j('span', { className: 'mt-tav', 'aria-hidden': true, children: avatar }),
          js('span', { className: 'mt-tinfo', children: [
            j('b', { children: name }),
            j('span', { children: meta }),
          ] }),
        ],
      })
      const rail = js('aside', { className: 'mt-teamrail mt-trail', 'aria-label': t('tasks.rail'), children: [
        j('span', { className: 'mt-teamrail-head mt-trail-cap', children: t('tasks.rail') }),
        railItem('all', t('tasks.railAll'), `${allProjectTasks.length} 个任务`, '全', railTeam === 'all'),
        ...(pv.teams ?? []).map((team) => {
          const lead = allProjectTasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'lead')).length
          const coop = allProjectTasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId && p.role === 'coop')).length
          const name = team.name || team.teamId
          return railItem(team.teamId, name, `${t('task.owner')} ${lead} · ${t('task.coop')} ${coop}`, String(name).trim().slice(0, 1), railTeam === team.teamId)
        }),
      ] })

      /* CHG-193（T160）：打开任务详情一律带**复合键**（`teamId` + `taskId`）——
       * 项目级看板跨团队聚合后 `task-N` 会撞（每团队都从 task-1 编号），只传 taskId 会打开
       * 另一个团队的同名任务，写操作也会落到错误的团队。`taskOpenTarget` 是唯一入口，
       * 写路径的 service 由 `TaskDetail` 用 `openTask.sessionId`（**任务所属团队**）取。 */
      const openTaskOf = (task) => { const target = taskOpenTarget(task); if (target) setOpenTask(target) }

      /* CHG-82：拖拽流转（design/dragging.html）—— 落点由状态机判定；非法落点抖动 + 弹回 + 左下角回执 */
      /** attempt 失效（门禁未过 / 已取消）的卡锁住不可拖 */
      const dragLocked = (task) => Boolean(task?.evidenceStale || task?.cancelled)
      /** 状态机允许的落点：门禁 → 完成要求门禁已过（超时过的卡 = 门禁未过） */
      const canDropOn = (task, colName) => {
        if (!task) return false
        if (!(DRAG_LEGAL_TARGETS[projectColumnOf(task.state)] ?? []).includes(colName)) return false
        if (colName === '已完成' && (task.escalateCount ?? 0) > 0) return false
        return true
      }
      const startDrag = (event, task) => {
        if (dragLocked(task)) { event?.preventDefault?.(); return }
        setDragToast(null)
        setDragTask({ key: task.key, code: task.id, title: task.title, from: projectColumnOf(task.state), over: null })
      }
      const dragOverCol = (event, colName) => {
        if (!dragTask) return
        event?.preventDefault?.()
        if (dragTask.over !== colName) setDragTask({ ...dragTask, over: colName })
      }
      const dropOnCol = (event, colName) => {
        if (!dragTask) return
        event?.preventDefault?.()
        const task = allProjectTasks.find((item) => item.key === dragTask.key)
        if (task && canDropOn(task, colName)) {
          /* CHG-202x（P1-4）：拖拽**不是**状态变更入口（看板列 = 任务状态，只能由 claim/门禁裁决等
           * 真实事件推进；面板没有任何「把任务挪到某列」的写端点）。修复前这里只 setNotice 一句
           * 「已移入」，看着像成功了、实际什么都没发生——那是假交互。
           * 现在的语义：**拖拽 = 打开该任务的详情并定位到对应动作**，由人在详情里执行真操作。 */
          setNotice(t('drag.accepted').replace('{code}', String(task.id)).replace('{col}', colName))
          if (task.ownerTeamId && task.id) {
            setOpenTask({ teamId: task.ownerTeamId, taskId: task.id, online: task.ownerOnline, sessionId: task.ownerSessionId })
          }
          setDragToast(null)
        } else {
          /* 非法落点：抖动 + 弹回 150ms（reduced-motion 下只闪边框），并给左下角回执 */
          setDragToast({ code: dragTask.code, col: colName, timeouts: task?.escalateCount ?? 0 })
          setDragShake(dragTask.key)
          setTimeout(() => setDragShake(null), 220)
        }
        setDragTask(null)
      }
      const endDrag = () => setDragTask(null)
      const dragPropsOf = (task) => ({ locked: dragLocked(task), shake: dragShake === task.key, onDragStart: startDrag, onDragEnd: endDrag })
      const draggedTask = dragTask ? allProjectTasks.find((item) => item.key === dragTask.key) : null
      const runningCodes = shownTasks.filter((task) => task.state === 'in_progress' || task.state === 're-scoping').map((task) => task.id)
      /** 拖起的卡悬在「进行中 → 门禁」交界的空中（design/dragging.html 的 .tcard.lift） */
      const liftCard = draggedTask ? js('div', {
        className: 'mt-task mt-task-lift',
        'aria-grabbed': 'true',
        children: [
          j('span', { className: 'mt-lift-tag', children: t('drag.liftTag') }),
          js('span', { className: 'mt-task-top', children: [
            j('span', { className: 'mt-task-id', children: draggedTask.id }),
            draggedTask.priority ? j('span', { className: `mt-pri mt-pri-${draggedTask.priority}`, children: draggedTask.priority }) : null,
          ] }),
          j('span', { className: 'mt-task-title-text', children: draggedTask.title }),
          js('span', { className: 'mt-task-meta', children: [
            j('span', { className: 'mt-rolechip', children: (draggedTask.assignees ?? []).slice(0, 2).map((id) => memberName(id)).join(' · ') || stateLabel(draggedTask.state) }),
            j('span', { className: 'mt-hint', children: `${stateLabel(draggedTask.state)} · ${projectColumnOf(draggedTask.state)}` }),
          ] }),
          draggedTask.model ? j('span', { className: 'mt-task-meta', children: j('span', { className: 'mt-task-model', children: draggedTask.model }) }) : null,
        ],
      }) : null

      let tasksContent
      if (taskView === 'board') {
        /* CHG-115：看板同源（会话视图复用同一个 BoardView，只读挂载） */
        tasksContent = j(BoardView, {
          t,
          tasks: shownTasks,
          memberName,
          teamName,
          showTeamName: new Set(shownTasks.map((item) => item.ownerTeamId)).size > 1,
          selectMode,
          selected,
          onToggle: toggleSelected,
          onOpen: openTaskOf,
          /* CHG-202u：不传 `onAdd` —— 列头的「＋」直达新建一并移除（任务由队长规划，
           * 面板侧只读 + 删除）。`LanesView` 里 `onAdd` 是可选 prop，不传即不渲染。 */
          drag: {
            task: dragTask,
            dragged: draggedTask,
            canDrop: canDropOn,
            liftCard,
            cardFor: dragPropsOf,
            onDragStart: startDrag,
            onDragEnd: endDrag,
            onDragOver: dragOverCol,
            onDrop: dropOnCol,
          },
        })
      } else if (taskView === 'list') {
        /* 项目级任务列表（design/tasks.html）：任务头 + 汇总条 + 按团队分组任务行 + 视图条 */
        /** design/tasks.html：每个团队组只列 6 行，其余收成「… 其余在看板」 */
        const TASK_GROUP_LIMIT = 6
        const stateChipClass = (state) => (state === 'done' ? 'mt-status-done'
          : state === 'failed' || state === 'cancelled' ? 'mt-status-fail'
          : String(state).startsWith('gate') || state === 'gates' ? 'mt-status-gate'
          : state === 'in_progress' || state === 'running' || state === 're-scoping' ? 'mt-status-run'
          : 'mt-status-idle')
        const teamGroups = (pv.teams ?? [])
          .map((team) => ({ team, tasks: shownTasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId)) }))
          .filter((group) => group.tasks.length > 0)
        const orphanTasks = shownTasks.filter((task) => (task.participants ?? []).length === 0)
        const taskRow = (task) => js('button', {
          key: task.key,
          className: 'mt-trow' + (selectMode && selected.has(task.key) ? ' mt-trow-selected' : ''),
          'aria-pressed': selectMode ? selected.has(task.key) : undefined,
          onClick: () => (selectMode ? toggleSelected(task) : openTaskOf(task)),
          children: [
            selectMode
              ? j('span', { className: 'mt-flow-check', 'aria-hidden': true, children: selected.has(task.key) ? '✓' : '' })
              : j('span', { className: 'mt-tid', children: task.id }),
            j('span', { className: 'mt-tt', children: task.title }),
            ...(task.participants ?? []).map((p) => j('span', {
              key: `p-${p.teamId}`,
              className: p.role === 'lead' ? 'mt-mini-chip mt-mini-chip-team' : 'mt-mini-chip mt-mini-chip-coop',
              children: p.role === 'lead'
                ? `${teamName(p.teamId)} · ${t('task.owner')}`
                : `${t('task.coop')} · ${teamName(p.teamId)}`,
            })),
            j('span', {
              className: `mt-status-chip ${stateChipClass(task.state)}`,
              children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: stateLabel(task.state) })],
            }),
            task.evidenceStale ? j('span', {
              className: 'mt-status-chip mt-status-gate',
              title: t('board.staleTitle').replace('{fields}', fieldListText(t, task.evidenceStale.fields)).replace('{time}', fmtClock(task.evidenceStale.since)),
              children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: t('board.evidenceStale') })],
            }) : null,
            task.cancelled ? j('span', {
              className: 'mt-status-chip mt-status-fail',
              title: t('board.cancelledTitle').replace('{reason}', task.cancelled.reason || '—'),
              children: [j('span', { className: 'mt-shape', 'aria-hidden': true }), j('span', { children: t('board.cancelled') })],
            }) : null,
            j(DiagChips, { t, diagnosis: task.diagnosis }),
            j('span', { className: 'mt-who', children: (task.assignees ?? []).map((id) => j('span', { key: id, className: 'mt-mini-chip mt-mini-chip-num', children: memberName(id) })) }),
            j('span', { className: 'mt-chev', 'aria-hidden': true, children: '›' }),
          ],
        })
        const runningCount = shownTasks.filter((task) => task.state === 'in_progress' || task.state === 're-scoping' || task.state === 'running').length
        const gateCount = shownTasks.filter((task) => String(task.state).startsWith('gate') || task.state === 'gates').length
        const doneCount = shownTasks.filter((task) => task.state === 'done').length
        const leadTotal = shownTasks.flatMap((task) => task.participants ?? []).filter((p) => p.role === 'lead').length
        const coopTotal = shownTasks.flatMap((task) => task.participants ?? []).filter((p) => p.role === 'coop').length
        const draftTeam = (pv.teams ?? []).find((team) => team.state === 'draft' && !teamGroups.some((group) => group.team.teamId === team.teamId))
        tasksContent = js('div', { className: 'mt-page', children: [
          /* CHG-202t（用户定案「这部分可以去掉」）：任务清单页的标题条
           * （`mt-section-head` = 「任务清单」+ 分隔线 + 「看板视图」按钮）**整块删除**——
           * 上方的视图切换条（列表/看板/流程/依赖图）已经承担了同一职责，这里是重复入口。 */
          j('p', { className: 'mt-hint', children: t('g6.tasks.pageDesc') }),
          /* 汇总条：任务 / 参与关系 / 进行中 / 门禁待审 / 已完成 */
          js('div', { className: 'mt-summary', children: [
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(shownTasks.length) }), j('span', { children: t('g6.tasks.summaryTasks') })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(leadTotal + coopTotal) }), j('span', { children: t('g6.tasks.summaryLinks').replace('{lead}', String(leadTotal)).replace('{coop}', String(coopTotal)) })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(runningCount) }), j('span', { children: t('g6.tasks.summaryRunning') })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(gateCount) }), j('span', { children: t('g6.tasks.summaryGates') })] }),
            js('div', { className: 'mt-tstat', children: [j('b', { children: String(doneCount) }), j('span', { children: t('g6.tasks.summaryDone') })] }),
            j('span', { className: 'mt-summary-note', children: t('g6.tasks.stageNote') }),
          ] }),
          /* 按团队筛选 seg（全部 / 各团队 n） */
          teamGroups.length > 1 ? js('div', { className: 'mt-filterbar', children: [
            js('div', { className: 'mt-seg', role: 'group', 'aria-label': t('tasks.rail'), children: [
              j('button', { className: railTeam === 'all' ? 'mt-seg mt-seg-active' : 'mt-seg', 'aria-pressed': railTeam === 'all', onClick: () => setRailTeam('all'), children: t('g6.tasks.filterAll').replace('{n}', String(shownTasks.length)) }),
              ...teamGroups.map((group) => j('button', {
                key: group.team.teamId,
                className: railTeam === group.team.teamId ? 'mt-seg mt-seg-active' : 'mt-seg',
                'aria-pressed': railTeam === group.team.teamId,
                onClick: () => setRailTeam(group.team.teamId),
                children: `${group.team.name || group.team.teamId} ${group.tasks.length}`,
              })),
            ] }),
          ] }) : null,
          teamGroups.length === 0 && orphanTasks.length === 0
            ? j('div', { className: 'mt-empty', children: t('tasks.empty') })
            : null,
          ...teamGroups.map((group) => js('div', { key: `group-${group.team.teamId}`, children: [
            js('div', { className: 'mt-dsec-head', children: [
              j('h4', { children: group.team.name || group.team.teamId }),
              j('span', { className: 'mt-line', 'aria-hidden': true }),
              j('span', {
                className: 'mt-n',
                children: t('g6.tasks.groupMeta')
                  .replace('{id}', group.team.teamId)
                  .replace('{state}', stateLabel(group.team.state ?? 'active'))
                  .replace('{lead}', String(group.tasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === group.team.teamId && p.role === 'lead')).length))
                  .replace('{coop}', String(group.tasks.filter((task) => (task.participants ?? []).some((p) => p.teamId === group.team.teamId && p.role === 'coop')).length)),
              }),
              j('button', { className: 'mt-mini-link', onClick: () => setTaskView('board'), children: t('g6.tasks.boardLink') }),
            ] }),
            ...group.tasks.slice(0, TASK_GROUP_LIMIT).map(taskRow),
            /* design/tasks.html：每组只列前几行 + 一条虚线「… 其余在看板」行（完整清单去看板/其他视图） */
            group.tasks.length > TASK_GROUP_LIMIT
              ? js('button', {
                className: 'mt-trow mt-trow-more',
                onClick: () => setTaskView('board'),
                children: [
                  j('span', { className: 'mt-tid', children: '…' }),
                  j('span', {
                    className: 'mt-tt',
                    children: t('g6.tasks.restInBoard')
                      .replace('{backlog}', String(group.tasks.slice(TASK_GROUP_LIMIT).filter((task) => task.state === 'backlog' || task.state === 'ready').length))
                      .replace('{done}', String(group.tasks.slice(TASK_GROUP_LIMIT).filter((task) => task.state === 'done').length)),
                  }),
                  j('span', { className: 'mt-who', children: j('span', { className: 'mt-mini-link', children: t('g6.tasks.boardLink') }) }),
                ],
              })
              : null,
          ] })),
          orphanTasks.length > 0 ? js('div', { children: [
            js('div', { className: 'mt-dsec-head', children: [
              j('h4', { children: t('tasks.railAll') }),
              j('span', { className: 'mt-line', 'aria-hidden': true }),
              j('span', { className: 'mt-n', children: t('g6.tasks.draftEmpty') }),
            ] }),
            ...orphanTasks.map(taskRow),
          ] }) : null,
          draftTeam ? js('p', { className: 'mt-note mt-note-info', children: [
            j('span', { className: 'mt-note-icon', 'aria-hidden': true, children: '◷' }),
            j('span', { children: t('g6.tasks.draftNote') }),
          ] }) : null,
        ] })
      } else if (taskView === 'lanes') {
        const laneMembers = (pv.teams ?? []).flatMap((team) => (team.members ?? []).map((member) => ({ ...member, teamId: team.teamId })))
        tasksContent = j(LanesView, { t, tasks: shownTasks, members: laneMembers, onOpen: (task) => openTaskOf(task) })
      } else {
        tasksContent = j(DagView, { t, tasks: toGraphTasks(shownTasks), onOpen: (id) => {
          const task = shownTasks.find((item) => item.key === id)
          if (task) openTaskOf(task)
        }, memberName, teamName, dir: dagDir })
      }

      const tasksPage = js('div', { className: 'mt-workbench', children: [
        /* design/tasks.html 的任务头（.teambar）：任务 + 数量 / 团队参与数 + 一句话说明 + 阶段统计 + 操作 */
        js('div', { className: 'mt-taskhead', children: [
          js('span', { className: 'mt-taskhead-title', children: [
            j('b', { children: t('g6.tasks.headTitle') }),
            j('span', {
              className: 'mt-taskhead-meta',
              children: t('g6.tasks.headMeta')
                .replace('{n}', String(allProjectTasks.length))
                .replace('{m}', String(new Set(allProjectTasks.flatMap((task) => (task.participants ?? []).map((p) => p.teamId))).size)),
            }),
          ] }),
          j('span', { className: 'mt-taskhead-goal', children: t('g6.tasks.headGoal') }),
          j('span', {
            className: 'mt-taskhead-stats',
            children: [
              `${t('g6.tasks.summaryRunning')} ${allProjectTasks.filter((task) => task.state === 'in_progress' || task.state === 're-scoping' || task.state === 'running').length}`,
              `${t('g6.tasks.summaryGates')} ${allProjectTasks.filter((task) => String(task.state).startsWith('gate') || task.state === 'gates').length}`,
              `${t('g6.tasks.summaryDone')} ${allProjectTasks.filter((task) => task.state === 'done').length}`,
            ].join(' · '),
          }),
          /* CHG-202u（用户定案「任务不能手动建，但是可以手动删除」）：
           * 新建 / 批量新建两个入口**整块删除**——任务由队长在团队会话里规划产生，面板侧不提供手动创建。
           * 删除：CHG-202x（P0-1）落地为任务详情的「删除此任务」按钮（`onDelete` → `deleteTaskFlow`），
           * 当时这条注释写的「删除仍走任务详情」只是一句空头承诺，删了实现（见 docs/25 §7）。 */
        ] }),
        js('div', { className: 'mt-viewbar', children: [
          /* CHG-84：新建任务 / 批量新建 已在任务头（.mt-taskhead-actions）里，视图条不再重复 */
          j('span', { className: 'mt-viewbar-hint', children: t('view.label') }),
          /* design/tasks.html 的 .viewbar .vlinks：列表 / 看板 / 流程 / 依赖图（保留 mt-seg 供既有交互脚本与样式复用） */
          js('div', { className: 'mt-viewlinks', role: 'group', 'aria-label': t('view.label'), children: [
            ...['list', 'board', 'lanes', 'dag'].map((key) => j('button', {
              key,
              className: taskView === key ? 'mt-seg mt-seg-active mt-vlink mt-vlink-on' : 'mt-seg mt-vlink',
              'aria-pressed': taskView === key,
              onClick: () => setTaskView(key),
              children: key === 'list' ? t('g6.tasks.viewList')
                : key === 'board' ? t('g6.tasks.viewBoard')
                : key === 'lanes' ? t('g6.tasks.viewFlow') : t('g6.tasks.viewDag'),
            })),
          ] }),
          /* design/dag.html · dag-vertical.html：视图条右上「方向」seg 两版互链 + 显示模型 + 已高亮依赖链 */
          taskView === 'dag' ? js('span', { className: 'mt-viewbar-dir', children: [
            j('span', { className: 'mt-filterlabel', children: t('view.dir') }),
            j('button', {
              className: dagDir === 'h' ? 'mt-switch-btn mt-switch-active' : 'mt-switch-btn',
              'aria-pressed': dagDir === 'h',
              onClick: () => setDagDir('h'),
              children: t('view.dir.arrow.h'),
            }),
            j('button', {
              className: dagDir === 'v' ? 'mt-switch-btn mt-switch-active' : 'mt-switch-btn',
              'aria-pressed': dagDir === 'v',
              onClick: () => setDagDir('v'),
              children: t('view.dir.arrow.v'),
            }),
            j('span', {
              className: 'mt-chip',
              title: t('dag.showModelHint'),
              children: [
                j('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true, children: j('circle', { cx: 5, cy: 5, r: 3, fill: 'currentColor' }) }),
                j('span', { children: t('dag.showModel') }),
              ],
            }),
            j('span', {
              className: 'mt-chip mt-chip-gate',
              title: t('dag.hotChainHint'),
              children: [
                j('svg', {
                  width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                  children: [
                    j('path', { d: 'M6.4 9.6 9.6 6.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
                    j('path', { d: 'M7.4 5.2 8.6 4a2.6 2.6 0 0 1 3.7 3.7l-1.2 1.2M8.6 10.8 7.4 12a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
                  ],
                }),
                j('span', { children: runningCodes.length > 0 ? t('dag.hotChain').replace('{ids}', runningCodes.join(' / ')) : t('dag.hotChainEmpty') }),
              ],
            }),
          ] }) : null,
          /* design/lanes.html：行 = 角色（分行方式由设置页 pipeline.swimlaneBy 决定） */
          taskView === 'lanes' ? js('span', { className: 'mt-viewbar-right', children: [
            j('span', { className: 'mt-chip', children: t('lanes.groupBy') }),
            j('button', { className: 'mt-btn mt-btn-sm', title: t('lanes.byStageHint'), onClick: () => setNotice(t('lanes.byStageHint')), children: t('lanes.byStage') }),
            j('button', { className: 'mt-btn mt-btn-sm', title: t('lanes.byStageHint'), onClick: () => setNotice(t('lanes.byStageHint')), children: t('lanes.byPriority') }),
          ] }) : null,
          j('input', {
            className: 'mt-search mt-search-sm',
            value: taskQuery,
            /* design/tasks.html 的搜索框文案：任务号 / 标题 / 团队 */
            placeholder: t('g6.tasks.searchPlaceholder'),
            'aria-label': t('g6.tasks.searchPlaceholder'),
            onChange: (e) => setTaskQuery(e.target.value),
          }),
          j('span', { className: 'mt-filterlabel', children: t('filter.priority') }),
          js('select', {
            className: 'mt-select',
            value: taskPrio,
            'aria-label': t('filter.priority'),
            title: t('filter.priority'),
            onChange: (e) => setTaskPrio(e.target.value),
            children: [['all', t('filter.all')], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']]
              .map(([value, label]) => j('option', { key: value, value, children: label })),
          }),
          j('span', { className: 'mt-filterlabel', children: t('filter.member') }),
          js('select', {
            className: 'mt-select',
            value: taskMember,
            'aria-label': t('filter.member'),
            title: t('filter.member'),
            onChange: (e) => setTaskMember(e.target.value),
            children: [
              j('option', { key: 'all', value: 'all', children: t('filter.all') }),
              ...teamList.flatMap((team) => (team.members ?? []).map((m) => j('option', { key: m.id, value: m.id, children: m.instanceName }))),
            ],
          }),
          filtersActive ? j('button', { className: 'mt-btn mt-btn-sm', onClick: () => { setTaskQuery(''); setTaskPrio('all'); setTaskMember('all'); setRailTeam('all') }, children: t('filter.clear') }) : null,
          filtersActive ? j('span', { className: 'mt-hint', children: t('filter.showing').replace('{n}', String(shownTasks.length)).replace('{total}', String(allProjectTasks.length)) }) : null,
          /* CHG-73：多选模式（卡片/列表复选框 + 全选/反选 → 底部批量操作条） */
          j('button', {
            className: selectMode ? 'mt-chipbtn mt-chipbtn-active' : 'mt-chipbtn',
            'aria-pressed': selectMode,
            title: selectMode ? t('multi.off') : t('multi.hint'),
            onClick: () => (selectMode ? exitSelect() : setSelectMode(true)),
            children: selectMode ? t('multi.off') : t('multi.on'),
          }),
          selectMode ? js('span', { className: 'mt-batchbar-group', children: [
            j('button', { className: 'mt-btn mt-btn-sm', onClick: () => setSelected(new Set(shownTasks.map((task) => task.key))), children: t('multi.all') }),
            j('button', {
              className: 'mt-btn mt-btn-sm',
              onClick: () => setSelected(new Set(shownTasks.filter((task) => !selected.has(task.key)).map((task) => task.key))),
              children: t('multi.invert'),
            }),
            j('span', { className: 'mt-hint', children: t('multi.count').replace('{n}', String(selectedTasks.length)) }),
          ] }) : null,
          /* CHG-202f（用户定案「红框的这部分去掉」）：原来的「流转规则」chip + 它展开的
           * `.mt-rules` 状态机说明条**整块删除**。
           *
           * 为什么删而不是留：那条说明是**教学文案**（「待规划 → 就绪/受阻；……」），
           * 对已经会用的人只是常驻噪音，还占掉一整行高度；而它描述的约束在**交互层**已经
           * 兑现（拖到非法列会抖动弹回 + 左下角回执说明原因），文案重复。真要查规则，
           * 设计稿 design/dragging.html 里也有一份。
           * 词条 `rules.title` / `rules.body` / `drag.rulesBadge` 保留在词表里（不删数据，
           * 将来若要放进帮助浮层可直接复用）。 */
        ] }),
        js('div', { className: 'mt-body', children: [
          /* 列表视图用「按团队筛选」seg 取代参与团队轨（design/tasks.html 无左轨） */
          taskView === 'list' ? null : rail,
          js('div', { className: 'mt-view', children: [tasksContent] }),
        ] }),
        /* design/dragging.html：左下角拖拽回执（被拒案例：gate 未过的卡进不了已完成） */
        dragToast ? js('div', { className: 'mt-dragtoast', role: 'status', children: [
          j('svg', {
            width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: 'mt-lock-icon',
            children: [
              j('path', { d: 'M8 2.2 13.4 5v6L8 13.8 2.6 11V5z', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
              j('path', { d: 'M8 7.2v3.2M8 5.4v.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
            ],
          }),
          js('div', { children: [
            j('b', { children: t('drag.rejectedTitle').replace('{code}', String(dragToast.code)).replace('{col}', String(dragToast.col)) }),
            j('p', { children: t('drag.rejectedBody').replace('{n}', String(dragToast.timeouts ?? 0)) }),
            j('button', { className: 'mt-link', onClick: () => { const task = allProjectTasks.find((item) => item.id === dragToast.code); if (task) openTaskOf(task) }, children: t('drag.rejectedLink').replace('{code}', String(dragToast.code)) }),
          ] }),
          j('button', { className: 'mt-dragtoast-close', 'aria-label': t('action.close'), onClick: () => setDragToast(null), children: '✕' }),
        ] }) : null,
        /* CHG-202f（用户定案「红框的这部分去掉」）：原来的 `.mt-dag-note` 依赖图图注
         * （「箭头从上游指到下游：一条边表示『下游要等上游』……」）**整块删除**。
         *
         * 为什么删：箭头方向本身就是**图例的常识**（箭头 = 指向下游），而真正常用的信息
         * ——「哪些节点当前在跑」——已经在节点卡上高亮了，不需要再用一段 60 字的说明教一遍。
         * 它常驻在画布底部、占满整行宽度，是纯噪音。
         * 词条 `dag.noteLead*` / `dag.arrowNote*` 保留在词表里（不删数据）。 */
      ] })

      const onTaskSaved = async (taskId, message) => {
        setTaskForm(null)
        setNotice(message)
        setDetailToken((value) => value + 1)
        await loadProject(projectRoot)
      }
      /** 角色删除（CHG-73 / CHG-103）：deleteRole 两段确认；全局作用域需 confirmGlobal */
      const deleteRoleFlow = async (roleId, confirm, scope) => {
        if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'missing roleId' }
        const result = await discoveryApi.deleteRole({
          workspaceRoot: projectRoot,
          roleId,
          scope: scope === 'global' ? 'global' : 'project',
          ...(scope === 'global' ? { confirmGlobal: confirm === true } : {}),
          confirm,
        })
        if (result?.status === 'deleted') {
          setNotice(t('role.deleted').replace('{id}', roleId))
          setOpenRole(null)
          setRoleDetail(null)
          await loadProject(projectRoot)
        }
        return result
      }
      /**
       * CHG-89（FR-13.1「发布到全局库」）：项目库角色 → 全局角色库。
       *
       * 两段确认：第一段只问影响面（目标文件 + 「全局库对该工作区所有项目可见」），
       * 第二段带 `confirm:true` 才落盘。**单向流动**——发布后各项目仍需显式
       * copyToProject 才进各自项目库，所以这里不做「已发布」的本地状态推断，
       * 只把服务端返回的 filePath 如实回显。
       */
      const publishRoleFlow = async (roleId, confirm) => {
        if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'missing roleId' }
        const result = await discoveryApi.roleOp({ workspaceRoot: projectRoot, op: 'publish', payload: { roleId }, confirm })
        if (result?.status === 'published') {
          setNotice(t('role.published').replace('{id}', roleId))
          await loadProject(projectRoot)
        }
        return result
      }
      /** CHG-74：同一 id 可能有多份副本（内置/全局/项目库）——「生效的那份」= 优先级最高者，
       *  与服务端 resolveEffectiveRole 同口径（项目库 > 项目自身角色 > 全局 > 内置）。 */
      const roleEntryOf = (roleId) => {
        const candidates = (pv.roles ?? []).filter((role) => role.id === roleId)
        if (candidates.length === 0) return undefined
        const rank = { builtin: 0, global: 1, 'project-role': 2, project: 3 }
        return candidates.reduce((best, role) => ((rank[role.origin] ?? 0) > (rank[best.origin] ?? 0) ? role : best))
      }
      const openRoleEntry = openRole ? roleEntryOf(openRole) : undefined
      const canDeleteOpenRole = Boolean(openRoleEntry) && (typeof openRoleEntry.canDelete === 'boolean'
        ? openRoleEntry.canDelete
        : openRoleEntry.origin === 'project' && (openRoleEntry.memberships ?? []).length === 0)
      /* CHG-76 B：批量新建默认团队 = 优先「在线 + active + 有队员」（能真正派单），否则任意在线团队 */
      const firstOnlineTeamId = (pv.teams ?? []).find((team) => team.online && team.sessionId && team.state === 'active' && (team.members ?? []).length > 0)?.teamId
        ?? (pv.teams ?? []).find((team) => team.online && team.sessionId)?.teamId
        ?? ''

      const tasksTabContent = js('div', { className: 'mt-workspace', children: [
        tasksPage,
        taskDetailNode((pv.teams ?? []).find((tm) => tm.teamId === openTask?.teamId)?.members ?? []),
      ] })

      /* CHG-202x（P0-4）：归档团队走 ArchiveReplay（组件内提前 return），**没有** TaskDetail 的渲染点——
       * 所以这里把详情抽屉并排挂上，让「看证据 / 看门禁」真的能下钻（修复前点了完全没反应）。
       * 名册优先用归档快照（`archiveSnap.members`），没有快照才回落实时名册。 */
      const content = projectTab === 'roles'
        ? rolesPage
        : projectTab === 'teams'
          ? (selectedTeam?.state === 'archived'
            ? [teamsPage, taskDetailNode(archiveSnap?.members ?? selectedTeam?.members ?? [])]
            : teamsPage)
          : tasksTabContent

      return js('div', { className: 'mt-panel', ...themeAttr, children: [
        topbar,
        /* CHG-104：未初始化引导是横幅，不替换整屏（面板永远可加载、可浏览） */
        storeBanner,
        error ? j('div', { className: 'mt-banner mt-error-banner', role: 'alert', children: error }) : null,
        notice ? js('div', { className: 'mt-banner', children: [
          j('span', { className: 'mt-notice', children: notice }),
          j('button', { className: 'mt-btn', onClick: () => setNotice(null), children: t('action.close') }),
        ] }) : null,
        js('div', { className: 'mt-workspace', children: [
          content,
          openRole ? j(RoleDetailDrawer, {
            t,
            data: roleDetail,
            onClose: () => setOpenRole(null),
            teamName,
            onEdit: (data) => openRoleEditor({ mode: data.origin === 'project' ? 'edit' : 'create', fork: data.origin !== 'project', forkOrigin: data.origin, definition: data.definition }),
            onCopyToProject: copyRoleToProject,
            onGuest: guestRoleCommand,
            /* CHG-89（FR-13.1）：只有「项目库」来源才有发布到全局的语义（内置/全局是复制源不是发布源） */
            onPublish: openRoleEntry?.origin === 'project' ? (confirm) => publishRoleFlow(openRole ?? roleDetail?.roleId, confirm) : undefined,
            skillTotal: (capCatalog?.skills ?? []).length || undefined,
            /* CHG-202z（FR-33 · M3-7b）：角色反向视图——该角色在本项目的任务（在跑 / 待领） */
            roleTasks: (project?.tasks ?? [])
              .filter((task) => task.requiredRole === (openRole ?? roleDetail?.roleId ?? roleDetail?.definition?.id))
              .map((task) => ({ key: task.key, id: task.id, title: task.title, state: task.state })),
            onDelete: canDeleteOpenRole ? (confirm) => deleteRoleFlow(openRole ?? roleDetail?.roleId, confirm) : undefined,
            /* CHG-73：deleteRole 是根级端点（只要 workspaceRoot）——离线项目也能清理未占用角色，
             * 因此不再按「有无在线团队会话」禁用；唯一门控是 canDelete（项目库 + 无在册 + 未被模板引用）。 */
            deleteHint: !canDeleteOpenRole && openRoleEntry?.origin === 'project' ? t('role.deleteOccupied') : undefined,
          }) : null,
          roleForm ? j(RoleFormDrawer, {
            key: `role-${roleForm.mode}-${roleForm.definition?.id ?? 'new'}`,
            t,
            initial: roleForm,
            catalog: catalogForForm,
            onClose: () => setRoleForm(null),
            save: saveRoleDef,
          }) : null,
          taskForm ? j(TaskFormDrawer, {
            key: `task-${taskForm.mode}-${taskForm.task?.id ?? 'new'}`,
            t,
            mode: taskForm.mode,
            teams: pv.teams ?? [],
            tasks: pv.tasks ?? [],
            initial: taskForm.task,
            defaultTeamId: taskForm.defaultTeamId,
            connection,
            onClose: () => setTaskForm(null),
            onSaved: onTaskSaved,
          }) : null,
          teamCreate ? j(TeamCreateDrawer, {
            t,
            ctx,
            projectRoot,
            presets,
            roles: pv.roles ?? [],
            onClose: () => setTeamCreate(false),
            onRetryPresets: () => setPresets(undefined),
            /* design/new-team-1.html 的脚注「管理预设库」：跳到全局页的预设区块（同一份目录） */
            onManagePresets: () => {
              setTeamCreate(false)
              setScope('global')
              setTimeout(() => {
                if (typeof document !== 'undefined') document.getElementById('mt-presets-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 0)
            },
          }) : null,
          showCost && tokens !== undefined ? js('div', { className: 'mt-drawer', children: [
            js('div', { className: 'mt-drawer-head', children: [j('strong', { children: t('cost.open') }), j('button', { className: 'mt-btn', onClick: () => setShowCost(false), children: t('action.close') })] }),
            j(TokensTab, { t, tokens, members: selectedTeam?.members ?? [], emptyText: offline ? t('cost.offlineEmpty') : t('cost.empty') }),
          ] }) : null,
        ] }),
        /* CHG-73：多选批量操作条 + 重新规划 / 取消对话框（模态层级在抽屉之上） */
        selectMode && projectTab === 'tasks' ? j(BatchBar, {
          t,
          tasks: selectedTasks,
          allTasks: pv.tasks ?? [],
          teams: pv.teams ?? [],
          memberName,
          onExit: exitSelect,
          onClear: () => setSelected(new Set()),
          runBatch,
          onDone: afterBatch,
        }) : null,
        rescopeFor ? j(RescopeDialog, {
          t,
          api: makeApi(connection, rescopeFor.sessionId),
          teamId: rescopeFor.teamId,
          taskId: rescopeFor.taskId,
          title: rescopeFor.title,
          input: rescopeFor.input,
          members: rescopeFor.members,
          tasks: rescopeFor.tasks,
          expectedRevision: rescopeFor.revision,
          onClose: () => setRescopeFor(null),
          onDone: submitRescope,
        }) : null,
        cancelFor ? j(CancelDialog, {
          t,
          api: makeApi(connection, cancelFor.sessionId),
          teamId: cancelFor.teamId,
          taskId: cancelFor.taskId,
          title: cancelFor.title,
          dependents: cancelFor.dependents,
          upstreams: cancelFor.upstreams,
          memberName,
          onClose: () => setCancelFor(null),
          onDone: submitCancel,
        }) : null,
      ] })
    }
