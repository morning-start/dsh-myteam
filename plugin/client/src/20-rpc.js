    /* ── M2 RPC 通道：直连网关（官方 invokeRemote 信封 {ok,value}|{ok,error}）── */
    async function rpcCall(connection, endpoint, args, signal) {
      const r = await connection.rpc.call('/api', endpoint, { args }, signal)
      // 官方连接层成功返回 {ok:true,value}；失败 {ok:false,error:{code,message}} 或直接 throw
      if (r && typeof r === 'object' && 'ok' in r) {
        if (!r.ok) throw new Error(r.error?.message ?? `rpc ${endpoint} failed`)
        return r.value
      }
      return r
    }

    /** 绑定到某个队长会话（sessionId）的 myteam API 面；query 透传给门面第二参 */
    function makeApi(connection, sessionId) {
      const call = (method, query) => rpcCall(connection, `myteam/${method}`, { agentId: sessionId, query })
      return {
        /* CHG-201（用户定案「全局和项目级分开」）：
         *  - getGlobalScope：全局作用域（侧边栏页）——只读全局资产，不需要项目；
         *  - getProjectScope：项目作用域（画布「团队视图」tab）——按会话工作区读本项目。
         * 跨工作区 `listTeams`（「全部项目」）已随 workspaces.json 一起退役。
         *
         * CHG-202 教训（**必读**）：`getProjectScope(agent)` 的服务端签名**只有 agent、没有
         * query**，而 typert 网关按描述符**严格校验** args 字段——多传一个 `query` 就整体
         * 拒绝（`args fields do not match the descriptor: unexpected "query"`）。
         * 那个 rejection 被 `.catch(() => {})` 吞掉，表现成「RPC 返回空 workspaceRoot」，
         * 于是项目视图静默回落到候选列表第一个工作区——正是用户说的「所有项目看起来都一样」。
         * 所以这里**不能**用 `call()` 助手（它固定带 query），必须直连只传 agentId。 */
        getGlobalScope: () => rpcCall(connection, 'myteam/getGlobalScope', {}),
        getProjectScope: () => rpcCall(connection, 'myteam/getProjectScope', { agentId: sessionId }),
        /* CHG-111：能力协商——拿到宿主**真实**方法表，缺能力就降级而不是运行时崩 */
        describe: (query) => rpcCall(connection, 'myteam/describe', { query }),
        /* CHG-112：批量调用——首屏多次往返 → 一次；逐条返回 {ok,value|error} */
        batch: (query) => rpcCall(connection, 'myteam/batch', { query }),
        /* CHG-113：长轮询追平——sinceSeq 后有新事件立刻返回，否则最多挂 timeoutMs */
        watch: (query) => rpcCall(connection, 'myteam/watch', { query }),
        /* CHG-102：项目级存储状态 / 初始化（根级端点，只收 query）。
         * CHG-104 教训：面板门面加了方法、客户端的 api 表没加 → `discoveryApi.getStoreState` 是
         * undefined → 调用即 TypeError → catch 里 setStoreState(null) → 面板永远停在「加载中」。
         * 现在由 t85 交叉校验「服务端 marker ⊆ 客户端 api 表」，漏一个就红。 */
        getStoreState: (query) => rpcCall(connection, 'myteam/getStoreState', { query }),
        initStore: (query) => rpcCall(connection, 'myteam/initStore', { query }),
        // T25：离线只读视图——网关门面方法无 agent 首参，args 只允许 { query }（assertExactArguments）
        getOfflineBoard: (query) => rpcCall(connection, 'myteam/getOfflineBoard', { query }),
        getOfflineTaskDetail: (query) => rpcCall(connection, 'myteam/getOfflineTaskDetail', { query }),
        getOfflineTokens: (query) => rpcCall(connection, 'myteam/getOfflineTokens', { query }),
        getOfflineAudit: (query) => rpcCall(connection, 'myteam/getOfflineAudit', { query }),
        getOfflinePresets: (query) => rpcCall(connection, 'myteam/getOfflinePresets', { query }),
        // CHG-69：项目级聚合（门面方法只收 query，不需要会话）
        getProject: (query) => rpcCall(connection, 'myteam/getProject', { query }),
        getRoleDetail: (query) => rpcCall(connection, 'myteam/getRoleDetail', { query }),
        // CHG-72：面板内闭环写入口（角色 = 配置资产；任务 = 账本，actor=human）
        saveRole: (query) => rpcCall(connection, 'myteam/saveRole', { query }),
        // CHG-73 P2：项目级配置资产（删除角色 / 能力目录）——无会话，只发 query
        deleteRole: (query) => rpcCall(connection, 'myteam/deleteRole', { query }),
        getCapabilityCatalog: (query) => rpcCall(connection, 'myteam/getCapabilityCatalog', { query }),
        /* CHG-91（插件团队贡献契约 v1）：插件贡献的只读视图 + 显式重载。
         * 根级端点（只发 query）——插件贡献是配置资产，离线团队也能看。 */
        getContributions: (query) => rpcCall(connection, 'myteam/getContributions', { query }),
        reloadContributions: (query) => rpcCall(connection, 'myteam/reloadContributions', { query }),
        // CHG-73 P2：账本写（重新规划 / 取消 / 批量编排）——绑定队长会话
        rescopeTask: (query) => call('rescopeTask', query),
        cancelTask: (query) => call('cancelTask', query),
        /* CHG-202x（P0-1）：删除任务（从账本投影移除；两段确认） */
        deleteTask: (query) => call('deleteTask', query),
        /* CHG-202z（FR-33 · M3-7）：项目共享看板——三种分组（team/role/rootMember）+ 五个汇总 */
        getProjectBoard: (query) => call('getProjectBoard', query),
        getProjectSummary: (query) => call('getProjectSummary', query),
        batchTaskOp: (query) => call('batchTaskOp', query),
        createTask: (query) => call('createTask', query),
        /* CHG-76 B：批量建任务（预览 / 确认同一端点；逐条 task.created 同一 batchId） */
        createTasks: (query) => call('createTasks', query),
        updateTask: (query) => call('updateTask', query),
        assignTask: (query) => call('assignTask', query),
        participateTask: (query) => call('participateTask', query),
        /* CHG-86 新增端点（面板直连；与队长工具同一条管线，actor=human）：
         *  - reviewTask：门禁裁决（pass / fail；review·verify 门强制交叉审查，archive 门由 host 落位校验）；
         *  - getArchive / getArchives：归档快照读面（archive/<teamId>/team.json 等真实落盘文件）；
         *  - adoptKnowledge：知识提案采纳 / 驳回（UI-5 验收门的按钮写路径）。 */
        reviewTask: (query) => call('reviewTask', query),
        getArchive: (query) => call('getArchive', query),
        getArchives: (query) => call('getArchives', query),
        adoptKnowledge: (query) => call('adoptKnowledge', query),
        /* CHG-87（FR-16.1 / 契约 §5.1）：单角色调用写入口。
         * `applyRoles({ teamId?, roles: string[], remove?: string[], confirm? })`——
         * 面板 `/myteam+<roleId>` / `/myteam-<roleId>` 语法解析后落到这里。 */
        applyRoles: (query) => call('applyRoles', query),
        /* CHG-89（FR-13.1 / docs/04 §2）：角色库统一写入口。
         * `roleOp({ op, payload, confirm })`，op ∈ save / delete / publish / fork——
         * 面板的「发布到全局」按钮走这里（publish 两段确认）。 */
        roleOp: (query) => rpcCall(connection, 'myteam/roleOp', { query }),
        /* CHG-88/89（M2-E / FR-16.3）：会话移交（摘要 → 新团队预设会话；不写团队账本）。
         * 服务端链路 CHG-88 已通，这里补面板入口——此前 client 零命中，用户点不到。 */
        handoff: (query) => call('handoff', query),
        getBoard: (query) => call('getBoard', query),
        getTaskDetail: (query) => call('getTaskDetail', query),
        getTokens: (query) => call('getTokens', query),
        getInbox: (query) => call('getInbox', query),
        getRoles: (query) => call('getRoles', query),
        getKnowledge: (query) => call('getKnowledge', query),
        getAudit: (query) => call('getAudit', query),
        getConfig: (query) => call('getConfig', query),
        /* CHG-117（FR-14.3 / docs/18 §7）：设置页配置写路径——校验先于写 + 原子写 + 两段确认 */
        saveTeamConfig: (query) => call('saveTeamConfig', query),
        resetTeamConfig: (query) => call('resetTeamConfig', query),
        /* CHG-119（FR-11.6）：计划质量反馈（只读观测，不自动改计划） */
        getPlanFeedback: (query) => call('getPlanFeedback', query),
        /* CHG-120（M2-D ② / FR-16.4②）：会话考古（按 session:<id> 只读读一页历史） */
        readSessionHistory: (query) => call('readSessionHistory', query),
        /* CHG-139a（docs/19 §M6/§M3）：依赖图谱 / 可复用技能清单（只读） */
        getTaskGraph: (query) => call('getTaskGraph', query),
        listSkills: (query) => call('listSkills', query),
        /* CHG-187（FR-32 支柱一）：名册只读面——成员 + 派生树事实（父 / 深度 / 子成员数） */
        listMembers: (query) => call('listMembers', query),
        /* CHG-139b（docs/19 §5.2/§5.3）：复制团队 / 发布团队（发布 = H 档两段确认） */
        copyTeam: (query) => call('copyTeam', query),
        publishTeam: (query) => call('publishTeam', query),
        /* CHG-139c（docs/20 §8）：导出 / 导入团队快照（导入 = 新 id，永不覆盖） */
        exportTeam: (query) => call('exportTeam', query),
        importTeam: (query) => call('importTeam', query),
        /* CHG-139d（docs/20 §5.4）：创建技能 / 工具（只写 myteam 队长预设） */
        createSkill: (query) => call('createSkill', query),
        createTool: (query) => call('createTool', query),
        getPresets: (query) => call('getPresets', query),
        memberOp: (query) => call('memberOp', query),
        planAction: (query) => call('planAction', query),
        postComment: (query) => call('postComment', query),
        disband: (query) => call('disband', query),
      }
    }
