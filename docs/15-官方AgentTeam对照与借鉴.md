# 15-官方 Agent Teams 插件对照与借鉴

> **取证对象**：DSH 官方 team 插件四件套 `0.2.2-rc.1`（本机 `C:\APP\agent\DeepSeek Harness\resources\app.asar` 解包，`refs/host-src/` 快照为 `0.2.1-rc.3`，本轮以**更新的 0.2.2-rc.1** 为准）。
> **对照对象**：本仓库 `plugin/`（`dsh-plugin-myteam` 0.1.0）。
> **取证方式**：四包 `lib/**` 逐行通读 + 本插件 `src/**` 只读盘点，全部结论附 `文件:行号`。取证原始笔记：`.tmp/notes/{official-core,official-surface,ours}.md`（不入库）。
> **调研日期**：2026-11-06（CHG-89 触发）。
> **本文性质**：调研 + 决策建议。**不改变任何既有需求口径**；被采纳的条目在 §8 分档后另开变更单。

---

## 0. 一句话结论

官方与本插件**不是同一件事的两个版本，而是同一问题域里两种相反的架构取舍**：

- **官方 = 寄生宿主**。账本是 Lead 的 **Session 日志本身**，读模型是宿主的 **Session 投影**，成员通道是宿主的 **subagent 服务**。四个包合计 **2903 行**（1638 + 556 + 690 + 29），自己一行存储、一行 RPC、一行 UI 状态都不写。
- **本插件 = 自建运行时**。账本是 **`.team-workplace/state/teams/<id>/ledger.jsonl`**（append-only，唯一权威〔I2〕），读模型是 **40 型事件的纯函数 fold**，成员通道是 `agents.create` 直连。能力面比官方大一个数量级（42 工具 / 40 事件 / 39 端点 / 11 态状态机 / 角色库 / 团队模板 / 知识库 / 门禁链 / 归档 / 成本口径），代价是这些东西全部要自己实现、自己测（当前 410 条单测）。

**因此「直接使用官方插件」这个选项基本不成立**（§5 逐条论证），但**官方的工程实现有 10 处值得直接搬**（§4），其中 5 处是「本插件已经有对应实现但做得不如官方稳」，2 处是「本插件当前的真空缺」，3 处是「宿主契约用法可以省掉一层自研」。

---

## 1. 官方四包全景

| 包 | 版本 | 体量 | 职责 | 运行时入口 |
|---|---|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team` | 0.2.2-rc.1 | `lib/index.js` **1638 行 / 62,546 B** | 领域服务 `ctx.agentTeams`：roster、任务板、journal、projection、activity、lifecycle | `main: lib/index.js` |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 0.2.2-rc.1 | `lib/index.js` **556 行 / 18,903 B** | 9 个 per-Agent scoped 工具 + `team:policy` / `team:identity` 两段提示词 | 插件 `apply()` |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | 0.2.2-rc.1 | `lib/client.js` **690 行 / 32,553 B**（Host 入口 6 行空壳） | 1 个 slot：`conversation.session.header.actions`（只读名册 + 任务板 + 成员导航） | 浏览器 `./client` |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.2.2-rc.1 | `cordis.patch.yml` **29 行 / 728 B**（`lib/index.js` 11 B） | 组合包：禁 3 行旧控件、插 3 行（服务 / 工具 / UI） | `dsh.bundle.patch` |

**包间关系**（`PROFILE/patch:1-29`）：

```yaml
- id: tool-subagent-control   # 全局 list_agents / send_message / interrupt_agent
  disabled: true
- id: tool-subagent           # 全局 subagent + list_subagent_models
  disabled: true
- id: tool-subagent-fork      # 全局 subagent_fork
  disabled: true
- insert:
    - id: agent-team          # 领域服务（maxMembers 8 / maxTasks 256 / maxMessageBytes 65536 / disposalTimeoutMs 5000）
    - id: tool-agent-team     # 9 工具（freshProvider: spawn / forkProvider: fork）
    - id: ui-agent-team       # 只读面板
```

> **被禁的是「行」，不是「能力」**：Subagent 服务与 `spawn` / `fork` 两个 provider 仍可用，teammate 创建与 workflow `agent()` 都依赖它们（`PROFILE/README.zh.md:49,108`）。

---

## 2. 十二维对照矩阵

| # | 维度 | 官方 `dsh-experimental-agent-team` | 本插件 `dsh-plugin-myteam` | 差异性质 |
|---|---|---|---|---|
| 1 | **定位** | Session 内的隐式团队：任何 root 会话天生是 Lead（`TeamId === SessionId`），**没有"建团队"事件**（`index.js:897-902`、`README.zh.md:126`） | 显式团队实体：`team.created` → `plan.staged` → `plan.approved` 生命周期，团队是 workspace 内的一等公民 | **相反**：官方零实体，本插件实体化 |
| 2 | **启用单位** | 一个 profile 级 bundle（29 行 patch，默认关闭，插件页开关） | preset（`myteam-preset-captain`）+ 顶层 carrier 行 + 根级 panel 门面行 + `isolate: {myteam:true}` | 官方是"打开就有"，本插件是"进团队模式才有" |
| 3 | **状态权威** | **Lead 的 Session 日志**（`team/member` / `team/task` 两类事件） | **`.team-workplace/.../ledger.jsonl`**（40 型事件，append-only，`core/ledger/ledger.ts:14-57`） | 官方寄生宿主，本插件自持 |
| 4 | **事件模型** | 4 型（`team/member`、`team/task`、`team/message/queued`、`team/message/delivered`），后 2 型**已停写、仅历史可读**（`index.js:536-538`） | 40 型，含门禁（`task.gate.result`）、提案（`task.proposal`）、知识（`knowledge.*`）、证据（`task.evidence`）、重规划（`task.escalated`/`task.rescoped`/`task.rewired`） | 本插件多 36 型业务事件 |
| 5 | **读模型** | 宿主 Session 投影 `agentTeam`（`stateVersion: 4`，`index.js:731-739`） | 纯函数 fold：`core/scheduler/fold.ts`（40 型逐型折叠，可从零重放） | 同为"事件 → 视图"，但官方**复用宿主投影缓存**，本插件自己实现 |
| 6 | **成员模型** | 直接 child：`name` / `description` / `provider` / `context`（`fresh`\|`fork`），**扁平不可变、只有 Lead 能建、不可重命名/删除/复用名**（`README.zh.md:205`） | 角色 × 团队的聘任记录：角色库（内置/全局/项目三层）+ 团队模板 + 实例名（`-2` 编号）+ 技能/MCP 覆写 + 不可变快照〔C3〕 | 本插件多"角色"这一设计原子 |
| 7 | **工具面** | **9 个**（Lead 与 teammate schema 完全相同，差异只在运行时授权）（`tool-agent-team/lib/index.js:250-521`） | **42 个**（Lead 33 + 成员 9，两层作用域注册，`tools/defs.ts`） | 4.7 倍 |
| 8 | **任务模型** | 4 态 `pending / in_progress / completed / deleted` + **8 个 CAS action**（`claim/release/edit/set_dependencies/complete/reopen/reassign/delete`），`revision` 乐观锁（`index.js:1275-1385`） | 11 态（含 `backlog/ready/re-scoping/gate:*`）+ 门禁链 + attemptId 原子 claim + 打回预算 + 依赖重接线 | 本插件多门禁与重规划 |
| 9 | **门禁** | **无**（`completed` 即终态） | 三型：`review`（强制交叉审查）/ `verify`（host 跑 `argv` 取真实退出码，= PRD 的 `command` 门）/ `archive`（host 做产物落位校验） | 本插件独有 |
| 10 | **面板** | 1 个 header slot，**只读**、**零 RPC**（纯读 Session 投影）、不提供任何写操作（`client-ui-agent-team/lib/client.js:239,631-636`、`README.zh.md:92`） | 39 个门面端点 + 26 个隔离服务 Remote 标记（`myteam/<method>` RPC），可写；27 屏设计稿 | 本插件面板是完整的应用 |
| 11 | **恢复 / 并发** | 两阶段 spawn（先持久化 `provisioning` 再建 child）+ 三条件对账；`transact` 按 LeadId 串行 + `flush` 后才算成功 | 有序恢复表（`core/scheduler/recovery.ts:53-65`）+ 冷启动全量重放（`openLedger` 容忍坏行）+ 单写者 `commit()` 先算后写 | 官方偏"崩溃对账"，本插件偏"重放恢复" |
| 12 | **依赖边界** | 5 个 `peerDependencies`（`dsh-agent`/`dsh-session`/`dsh-session-persistence`/`dsh-session-projection`/`dsh-subagent`）+ `cordis` | 运行时 `@deepseek-ai/*` **只有 `dsh-typert-protocol` 一条**（`panel.ts:26`、`remote/service.ts`）；重依赖全在 client 侧 | 本插件 host 侧更干净，但自己实现了官方的"宿主免费项" |

**量化对比**：

| 指标 | 官方 | 本插件 |
|---|---|---|
| 实现行数 | 2,903 | `plugin/src` 36 模块 ≈ **16,000 行**（含 `host.ts` 3,318 行） |
| 工具 | 9 | 42 |
| 事件类型 | 4 | 40 |
| 错误码 | 27 个 `TEAM_*` | 30+ 个 `MT_*` |
| 单测 | 包内 `v8 ignore` 标注 + 未开源 | **410 条 / 58 文件** |
| 配置字段 | 4 | `team.config.json` 三层合并（看板/泳道/门禁/上限/任务类型） |
| 存储 | 无（全在 Session 日志） | `.team-workplace/` 四分区 + 全局 `$DSH_HOME/myteam/` |
| 多语种 | 8 语种（UI 25 个 key） | zh/en（面板全量 + `locale/`） |

---

## 3. 差异逐条：官方为什么这么做、我们为什么那么做

> 这一节回答"差别在哪"。**每条都给出官方取舍的理由**——很多差异不是官方偷懒，是本插件 PRD 明确选择了更重的方案。

### 3.1 状态权威：Session 日志 vs 独立 JSONL 账本

**官方**：账本就是 Lead 的 Session 日志。`TeamJournal.appendAndFlush()` 把 `team/member` / `team/task` 追加到**精确那个 live Lead session**，然后 `await ctx.sessions.flush(root.session)`，最后才 `onCommit`（`index.js:159-163`）。

- **收益**：零自研存储；崩溃恢复、回放、导出、审计全部白嫖宿主的 session 持久化；`seq`/`time` 由宿主统一分配，快照不重复保存（`README.zh.md:144`）。
- **代价**：**Team 状态与 Lead 会话强绑定**——Lead 会话没了，团队就没了；换 workspace 换团队靠换会话；一个 workspace 里"多团队"要靠多个 root 会话。

**本插件**：独立 `ledger.jsonl`（ADR-002 决策 B）。`TeamService.commit()` = 乐观锁 → 领域校验 → 在投影副本上增量 apply → 落账（含 fsync）→ 切换投影（先算后写，失败即弃，`core/service.ts:80-81`）。

- **收益**：团队是 workspace 的资产而不是会话的附庸；一个 workspace 可多团队/归档/切换；账本可跨会话、可离线读（`getOfflineBoard` 等 5 个离线端点）。
- **代价**：**自己实现了官方白嫖的那一层**——崩溃恢复（`openLedger` 尾部截断 + 中部坏行跳过）、`seq` 连续性、`rules.version` 首事件、原子写、派生索引重建。

> **判断**：这条**不改**。PRD §1 的定位（"通用 Agent 团队平台 / Agent Resource 管理"）与 FR-19 的"全局 | 项目"两作用域，隐含了团队必须独立于会话。**但官方在这条路径上的两个工程细节值得搬**（§4 R1、R2）。

### 3.2 成员模型：隐式 Team vs 显式 Team + 角色 + 聘任

**官方**：成员 = 一个直接 child，只有 4 个字段（`name` / `description` / `provider` / `context`）。名字**永久占用**，`failed` 成员也占名字，永不复用（`index.js:1026`）。

- 为什么这么少：官方 README 明确"扁平且不可变的 roster——只支持 Lead 创建直接 teammate；不支持嵌套 Team、重命名、删除或名字复用"（`README.zh.md:205`）。
- 这是**刻意的极简**：少一个字段，就少一处 CAS 冲突、少一处审计歧义。

**本插件**：成员 = **角色 × 团队的聘任记录**（FR-20）。角色是设计原子，团队 = 把角色拉进来；实例化时固化不可变快照〔C3〕；同名角色二次召唤自动 `-2` 编号；角色库三层来源（内置只读 / 全局个人资产 / 项目库 = 运行时唯一真相，ADR-006 R3 的 `project > project-role > global > builtin` 生效优先级）。

> **判断**：这条**不改**。角色库是本插件与官方**最大的能力差**（官方完全不碰"角色"这个层），且它承载了"通用团队平台"的定位（小说写作/视频脚本靠角色库适配，FR-10.3）。

### 3.3 工具面：9 vs 42

**官方**：9 个工具，**Lead 与 teammate 的 schema 完全相同**（`tool-agent-team/README.zh.md:127`），Lead-only 由**领域服务**在运行时拒绝（`TEAM_LEAD_REQUIRED`），适配器层不判断角色。理由（`README.zh.md:86`）："**领域掌握裁决权，适配器不加更弱的路径**"。

**本插件**：42 个，两层作用域——Lead 33 个在 preset 层（`myteam-host` 行的 `ctx.tools.register`），成员 9 个在 `agents.create` 的 `setup(agentCtx)` 内注册。

> **判断**：这条**不改**。但官方那句"领域掌握裁决权，适配器不加更弱的路径"是一条应该写进本插件 ADR 的**原则**——本插件已经有对应实现（`TeamService.commit` 是唯一写入口，工具只是搬参），只是没把它写成不变量。已列入 §4 R8。

### 3.4 任务模型：4 态 CAS vs 11 态状态机 + 门禁链

**官方**：4 态 + 8 action。核心是 **`expectedRevision` CAS**——陈旧调用方收到 `TEAM_TASK_STALE_REVISION` 而不是覆盖（`index.js:1281`）。任务 id 是 `task-<n>` 数字后缀，**永不复用**，删除只留 tombstone（`index.js:1226`）。

**本插件**：11 态（`backlog / ready / in_progress / re-scoping / gate:review / gate:verify / gate:archive / done / failed / blocked / cancelled`）+ `LEGAL_TRANSITIONS` 白名单 + attemptId 原子 claim + 门禁链 + 打回预算（`GATE_REJECT_BUDGET = 2`）+ 依赖重接线（`task.rewired`）+ 批量编排（同一 `batchId` 逐条落账）。

两者**都有** `expectedRevision` 乐观锁（本插件 CHG-87 才补上，`TeamService.commit({expectedRevision})`）。

> **判断**：这条**不改**。门禁链是 PRD 的核心差异化（FR-5.1~5.4），官方明确不做。

### 3.5 面板：只读投影 vs RPC 门面 + 写

**官方**：1 个 slot（`conversation.session.header.actions`，id `agent-team`，`order: -20`），**零 RPC**——数据全部来自 `useSessions(s => s.projectionsBySession[leadSessionId]?.values.agentTeam)`（`client.js:239`）。面板**不提供任何写操作**（不能 claim/complete/spawn/interrupt），`writeScopes` 只是提示性 metadata（`README.zh.md:92`）。

- **收益**：不持有状态、不发 RPC、不自己缓存，靠宿主投影 frame 刷新；"打开面板不发起投影请求"（`README.zh.md:12`）。
- **代价**：能力被框死——"没有 lifecycle 或 workspace control"、"没有 mailbox timeline"。

**本插件**：`MyTeamPanelFacade`（根级，39 端点）+ `MyTeamRemote`（preset 内隔离服务，26 个 Remote 标记），靠 `agentPresets.serviceFor(agent,'myteam')` 搭桥（为什么必须这样：preset 挂载审计要求 `isolate`，而网关 `claimsEndpoint` 只扫 root 可见服务，`advisor` 见 `panel.ts:5-15`）。

> **判断**：这条**不改**，但**官方 UI 的两处工程细节可以直接搬**：`useAnchoredPosition` + 150ms hover / 120ms 宽限的交互参数、以及"只在真被截断时才显示展开按钮"的 `ResizeObserver` 写法（§4 R9 附）。

### 3.6 恢复与并发

| 子问题 | 官方 | 本插件 |
|---|---|---|
| **spawn 崩溃安全** | 两阶段：先 `append+flush` `provisioning` 记录 → 再让 provider 建 child → 再 `checkpointInitialPrompt` 等 child 初始 user 消息 durable → 最后 `settleProvisioning(active)`；崩溃后 `reconcileProvisioning` 用**三条件**（parent 匹配 + `continuable` descriptor + 初始 user 消息已接受）判 `active`，否则 `failed`（`index.js:1024-1149`） | 无两阶段：`spawnMember` 直接 `agents.create` 并落 `member.spawned`；失败落 `member.spawned{status:'failed'}`（ADR-008：可重试可报告，`sessionId` 固定保证幂等） |
| **写串行化** | `TeamJournal.transact` 按 `rootId` 串行（promise 链 `.then(op, op)`——**失败也继续排队**，`index.js:143-152`） | Cordis 单例 + `TeamService.commit()` 单写者；同成员操作按提交顺序串行〔I7〕，跨成员不排队 |
| **冷启动** | 宿主 session 投影自动恢复 | `openLedger` 全量重放（O(n)，唯一恢复路径）；尾部残行截断、中部坏行跳过（CHG-86 QA-1） |
| **dispose** | 单 `AbortController` 表达"准入关闭" → `track/pending/settle` 收已准入操作 → `Promise.allSettled` + `withTimeout`（`TEAM_DISPOSAL_TIMEOUT`）+ `isCancellation` 沿 cause 链识别预期取消（`index.js:169-261`、`1624-1635`） | `dispose()` 遍历 `memberHandles` 尽力而为排空（`host.ts:426-433`） |

> **判断**：**这条是本插件真正的空缺**。官方的 `provisioning` 两阶段 + 对账解决了"宿主崩在 `agents.create` 中途"的孤儿成员问题；本插件当前只能靠 `member.spawned{status:'failed'}` 事后报告，没有对账。**已列入 §4 R1（P1）。**

### 3.7 上限、错误码与输入规范化

| 项 | 官方 | 本插件 |
|---|---|---|
| 成员上限 | `maxMembers` 默认 **16**（组合包写死 8），统计**全部**成员（含 `failed`/`provisioning`）= 名字预算 | `maxMembers` 默认 **6**（ADR-008：模型并发成本 + 上下文管理，宿主池已不约束） |
| 任务上限 | `maxTasks` 默认 **256**，只数**非 deleted**（tombstone 不占额度） | `maxTasks` 默认 **20**（`validatePlan` 硬校验） |
| 消息上限 | `maxMessageBytes` 65536（**计入注入的 sender 前缀块**与 JSON 语法开销） | 无字节上限（消息走 `message.sent` 账本事件） |
| 名字规则 | `^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤64 字符，≠ `"lead"` | 角色 id + 实例名（`-2` 编号） |
| 写范围 | `writeScope` 规范化：`\`→`/`、去 `./` 前缀、去尾 `/`；拒绝空/绝对路径/盘符/空段/`.`/`..` | `writeScopes` + `normalizeScopePath` + 前缀/通配匹配（`core/gates/scope-audit.ts`） |
| 错误码 | 27 个 `TEAM_*`（全表见 `.tmp/notes/official-core.md` §4） | 30+ 个 `MT_*` |

> **判断**：本插件的 `maxTasks=20` / `maxMembers=6` 是刻意的保守值（ADR-008 + M1 工期），**不改**。官方 `writeScope` 的规范化规则值得对齐（本插件 `normalizeScopePath` 已实现，行为一致，无动作）。

---

## 4. 可直接借鉴的 10 条（按收益 ÷ 成本排序）

> 每条格式：**现状 → 官方做法（行号）→ 落到本插件哪里 → 成本 → 风险 → 优先级**。
> 优先级：**P1** = 建议本轮做；**P2** = 排进 M2 后段；**P3** = 记录即可。

### R1 ⭐ 两阶段 spawn + 崩溃对账（P1，本插件真空缺）

| 项 | 内容 |
|---|---|
| **现状** | `spawnMember` 直接 `agents.create`，成功后落 `member.spawned`；失败落 `member.spawned{status:'failed'}`。**宿主崩在 `agents.create` 期间 = 无任何记录**，下次启动不知道有这个成员 |
| **官方做法** | ① 先 `append+flush` 一条 `team/member{phase:'provisioning'}`（名字占用与 `maxMembers` 在此判定）→ ② 才 `subagents.startActivation()` 建 child → ③ `checkpointInitialPrompt` 等 child 初始 user 消息 durable → ④ 最后 `settleProvisioning({phase:'active'})`。恢复时 `reconcileProvisioning` 只处理 `phase==='provisioning'` 且**不在 live registry** 的成员，用三条件判 `active`：`header.parentSession === root.id` ∧ `descriptor?.mode === 'continuable'` ∧ `descriptor.provider === member.provider` ∧ `acceptedInitialPrompt`；否则 `failed` 并写三选一的错误文案（`index.js:1024-1149`） |
| **落点** | `plugin/src/host.ts` 的 `spawnMember()` + `core/members/`；账本新增前置态：`member.spawned` 之前先落一条 `member.spawning`（或复用 `member.spawned` 加 `phase` 字段，需改 `ledger.ts` 的 `PAYLOAD_REQUIRED`）；`TeamService.reload()` 冷启动后跑一次对账 |
| **成本** | 约 **1.5~2 人日**（纯函数对账 + 账本 schema 改动 + 4~6 条单测）。**不需要新宿主能力**——`agents.get/list` + `sessionPersistence` 都在白名单内（PRD §9） |
| **风险** | 账本事件 schema 变更（向后兼容：旧账本没有 `member.spawning`，重放时视为已 `active` 即可）；`member.spawned` 现在是"成功才落"，改后要保证**失败路径也落终态**，否则会出现永久 `provisioning` |
| **为什么值得** | 这是 CHG-77 那类"成员会话静默不跑"事故的**结构性解药**——现在只能靠 `agent/error` 错误回声事后发现，官方是启动时主动对账 |

### R2 ⭐ per-Lead 串行事务 + flush 后提交通知（P1，本插件有实现但语义不如官方硬）

| 项 | 内容 |
|---|---|
| **现状** | `TeamService.commit()` 单写者，但**没有"durable 才算成功、durable 才唤醒"的显式顺序保证**；唤醒管线（`wakeDecisionsFor` → `agent.followup`）与 `appendEvent` 的相对时序靠实现顺序隐式保证 |
| **官方做法** | `TeamJournal.transact(rootId, op)` 用 promise 链按 Lead 串行；`appendAndFlush` = `append`（同步）→ `await sessions.flush`（durable）→ `onCommit`（同步通知）。**`flush` 在通知之前**，所以"报告成功"与"唤醒等待者"都发生在 durable 之后（`index.js:143-163`） |
| **落点** | `plugin/src/core/service.ts` 的 `commit()` 尾部；把"唤醒"从 `commit()` 内联调用改成 `onCommit` 回调（与官方同构），并显式 `await fsync` 后再通知 |
| **成本** | 约 **0.5 人日**（重构 `commit()` 尾部 + 2 条时序断言单测） |
| **风险** | 低。当前 `appendEvent` 已含 fsync（`core/ledger/ledger.ts:276`），只是没有"flush 后才通知"的**顺序断言** |
| **为什么值得** | 现在这个不变量靠"代码顺序看起来对"维持，一次无关重构就可能破坏；官方把它写成了显式契约 |

### R3 ⭐ 投影只替换被触及集合 + 两级 WeakMap 视图缓存（P2，性能 + 正确性双收益）

| 项 | 内容 |
|---|---|
| **现状** | `fold.ts` 每次事件返回新 `TeamProjection` 对象（不可变），但**视图层每次都重建**；面板 RPC 每次读都重新 `buildBoardView(...)` |
| **官方做法** | ① `apply` 只复制**被触及的那一个集合**（`members` / `tasks` / `messages` / `delivered`），其余字段保持原引用（`replaceAt`，`index.js:586-591`）；② 视图缓存是**两级 WeakMap**：`WeakMap<members[], WeakMap<tasks[], view>>`，所以**只改 messages/delivered 时 `members` 与 `tasks` 引用都不变 → 命中缓存 → 同一个视图引用 → 客户端不产生 frame**（`index.js:686-728`）；③ `state.failure` 时**绕过缓存**每次重建（失败视图要保留失败瞬间的样子） |
| **落点** | `plugin/src/core/scheduler/fold.ts` 的 `applyEvent`（改成 `replaceAt` 语义）+ `plugin/src/remote/views.ts` 的 `buildBoardView` 加 WeakMap 缓存 |
| **成本** | 约 **1 人日**（fold 改动 + 视图缓存 + 3 条"引用相等"断言单测） |
| **风险** | 中。fold 是所有路径的公共依赖，改错会静默影响全量；**必须先加"逐字段一致性"单测（现有 t40 已有增量 vs 全量重放逐字段对比，可直接复用）** |
| **为什么值得** | 官方这条解决的是"面板开着时每来一条消息就整块重渲染"的性能问题——本插件面板是完整应用（27 屏 + 看板 + DAG），收益比官方更大 |

### R4 ⭐ 准入截止 + 有界结算的 dispose 序列（P1，本插件 dispose 太糙）

| 项 | 内容 |
|---|---|
| **现状** | `dispose()` 遍历 `memberHandles` 逐个 `void handle?.dispose?.()`，**不等待、不设期限、失败吞掉**（`host.ts:426-433`）。宿主关闭时可能留下未排空成员 |
| **官方做法** | ① `lifecycle.close()`（关准入 + `abort` 已准入操作）→ ② `activity.close()`（唤醒全部等待者）→ ③ `lifecycle.settle(pending, failures)`（`Promise.allSettled` + `withTimeout(disposalTimeoutMs)`；**预期取消不计入失败**——用 `isCancellation` 沿 `cause` 链识别）→ ④ 每个 Team 的 child drain 各有一个**独立期限** → ⑤ 有失败则 `throw AggregateError`（`index.js:1624-1635`） |
| **落点** | `plugin/src/host.ts` 的 `dispose()`；需要先有"已准入操作"的概念（可与 R2 的 `onCommit` 一起做） |
| **成本** | 约 **1 人日**（`RuntimeLifecycle` 类 + 3 条 dispose 单测：正常 / 超时 / 预期取消不计失败） |
| **风险** | 低。纯关闭路径，不影响正常业务 |
| **为什么值得** | ①③ 顺序（先关准入再唤醒）防"唤醒后又有新操作进来"；②"预期取消不计失败"防关闭时误报错误 |

### R5 ⭐ 纯派生的 `ready` / `writeScopeWarnings` 视图（P1，本插件有两份口径）

| 项 | 内容 |
|---|---|
| **现状** | 任务就绪判定散在 `canClaim`（`core/scheduler/state.ts:273-286`）、`fold.ts` 的 `advanceDependents`、`readiness.ts` 的 `diagnoseTask` 三处；写范围重叠警告**没有实现**（`scope-audit.ts` 只在完成后审计，不做 in-progress 重叠提示） |
| **官方做法** | `taskReady(state, task)` 与 `projectTaskView(state, task)` 是**纯函数**，任务板与客户端视图**共用同一份**（`index.js:341-388`）；`writeScopeWarnings` 只在"与其他 **in_progress** 任务的写范围重叠"时给 `"write scopes overlap with task-N"`，**纯提示、从不阻断**（`README.zh.md:78`） |
| **落点** | ① 把 `canClaim` 的就绪判定抽成 `taskReady()` 单一导出，三处引用；② `readiness.ts` 增 `writeScopeWarnings(tasks): string[]` |
| **成本** | 约 **0.5 人日**（纯函数抽取 + 2 条单测） |
| **风险** | 低。纯重构 + 纯新增 |
| **为什么值得** | 现在的三处口径是**已知的技术债**（`canClaim` 与 `advanceDependents` 的"deps 全 done"写法就重复了两次），官方给了一个干净的收口形态 |

### R6 工具结果统一 `jsonOutput` 双声明（P2）

| 项 | 内容 |
|---|---|
| **现状** | 本插件 `toolOutput()` 只声明 `output.schema = { status: string }`（`tools/defs.ts:82`），实际返回的 JSON 靠手写 `JSON.stringify` 塞进 text block |
| **官方做法** | `jsonOutput(schema)` 返回 `{ schema, render: (_args, value) => [{type:"text", text: JSON.stringify(value)}] }`——**schema 是完整的结果契约**（`MemberView` / `TaskView` 等 `additionalProperties: false` 的严格形状），`render` 只做紧凑 JSON（`tool-agent-team/lib/index.js:211-219`） |
| **收益** | ① 编译期就能检查 `execute` 返回值与 schema 一致；② 结果结构对模型是**可发现的**（模型能从 schema 知道有哪些字段）；③ 省 token（无缩进） |
| **落点** | `plugin/src/tools/defs.ts` 的 `toolOutput()` + 42 个工具的输出 schema |
| **成本** | 约 **2 人日**（42 个工具逐个补 schema；**可分批**：先给 9 个成员工具补，它们是高频路径） |
| **风险** | 低（纯声明），但 42 个工具一次性改完容易漏；建议按"成员 9 → 门禁 1 → 任务 8 → 其余"分三批 |
| **优先级** | P2（M2 后段）。**注意**：本插件输出契约目前只要求 `{ status: string }`，改成严格 schema 是**放宽还是收紧需要先确认**——若模型已依赖"任意字段都能过"，收紧会破坏兼容 |

### R7 `wait_agent` 的 `no-active-peer` 短路（P1，直接治"模型空等"）

| 项 | 内容 |
|---|---|
| **现状** | `myteam_wait_for_change` 只返回 `{changed, cause}`；如果团队里没有 running 成员，模型会**等到超时**才发现没人会动 |
| **官方做法** | 合法 `timeout_ms` 时**先 `listMembers`**，看有没有"非自己且 status ∈ {running, provisioning}"的成员；**没有就立刻返回** `{timedOut:false, noProgress:{reason:"no-active-peer", message:"..."}}`，文案明确要求"先 list_agents + team_task_list → 再 send_message 唤醒 → 然后才等"（`tool-agent-team/lib/index.js:32,337-349`） |
| **落点** | `plugin/src/tools/defs.ts` 的 `myteam_wait_for_change`；`cause` 枚举增 `no-active-peer`（**新增枚举值 = 向后兼容**） |
| **成本** | 约 **0.3 人日**（一个预检 + 1 条单测） |
| **风险** | 极低。只在"本来就会超时"的路径上提前返回 |
| **为什么值得** | 这是**成本最低、收益最直接**的一条：本插件成员是 `agents.create` 直连的独立会话，`status` 从 `agents.list()` 可取，预检成本 O(n) |

### R8 「领域掌握裁决权，适配器不加更弱的路径」写成不变量（P1，文档 + 断言）

| 项 | 内容 |
|---|---|
| **现状** | 本插件已经是这个形态（`TeamService.commit()` 唯一写入口，工具只搬参），但**没有写成 ADR 不变量，也没有反向断言** |
| **官方做法** | README 原文："工具委托给 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；**适配器不添加更弱的旁路**"（`tool-agent-team/README.zh.md:86`）。落地手段：9 个工具 **Lead 与 teammate schema 完全相同**，Lead-only 只靠领域服务运行时拒绝（`TEAM_LEAD_REQUIRED`） |
| **落点** | `docs/03-架构与ADR.md` 新增一条 ADR；`plugin/test/` 加**反向断言**：所有 `myteam_*` 工具的 `execute` 不得直接写文件/直接改投影（只能调 `commit()`） |
| **成本** | 约 **0.3 人日**（ADR + 一条静态断言单测） |
| **风险** | 无 |
| **为什么值得** | 这条是"防止后来者加旁路"的**结构性护栏**——CHG-86 的 P0-4（工具重名越权）正是旁路的产物 |

### R9 UI 交互的两个可量化参数 + 一处 ResizeObserver 写法（P2，纯 UI 打磨）

| 项 | 内容 |
|---|---|
| **官方做法** | ① hover 开 **150ms**、关 **120ms 宽限**（`pinnedRef` 为真时不平）；② **展开按钮只在真被截断时出现**——`useLayoutEffect` + `ResizeObserver` 量 `scrollHeight > clientHeight + 1`，同步 `aria-expanded`（`client.js:150-165,263-282`）；③ 紧凑模式：`members.length===1 && tasks.length===0` 时面板单列（`client.js:299`） |
| **落点** | `plugin/client/client.js` 的任务详情描述截断、DAG 卡折叠、成员菜单 |
| **成本** | 约 **0.3 人日** |
| **风险** | 无 |
| **为什么值得** | 本插件 CHG-84/85 已经在做同类打磨（79 处差异 + 7 处裁切），这两个参数是**已经验证过的取值**，不用再猜 |

### R10 `team:policy` 抽成 `systemPrompt.section` + 命名 order（P3，可选）

| 项 | 内容 |
|---|---|
| **现状** | 队长身份提示词写在 `plugin/cordis.patch.yml:72-88` 的 YAML 里（`@deepseek-ai/dsh-persona` 的 `prefix`），**不可单元测试、不可按配置裁剪** |
| **官方做法** | 策略文本集中在一个**纯函数** `teamPolicy(interrupt)` 里，按配置插值；用 `scoped.systemPrompt.getSectionOrder("TEAM_POLICY")`（= 600）取 order 而**不硬编码 600**；`team:identity` 用 `required: true` 的 **context 函数**（每次请求现取 membership）（`tool-agent-team/lib/index.js:21-30,234-249`） |
| **收益** | 可测试 + 可裁剪 + order 跟宿主常量走（宿主调顺序时不用改本插件） |
| **风险** | 中——本插件队长身份目前由 `dsh-persona` 承载（ADR-005 R2 明确"persona 只能挂 preset scope"），**改成 `systemPrompt.section` 是否还能拿到 persona 的 context 语义需要实测**，不是纯重构 |
| **优先级** | **P3，记录即可**。当前 YAML 形态是 ADR-005 定稿的结论，动它要先推翻那条 ADR |

---

## 5. 能直接「用官方插件」的部分（复用判断）

> 结论先行：**四个包里没有一个适合直接依赖**。逐条给理由。

### 5.1 能否直接用官方领域服务 `ctx.agentTeams` 代替本插件的成员/消息/任务？

**不能，且 PRD §2 已明确禁止（零依赖边界）。** 三条硬理由：

1. **语义不匹配**：官方任务只有 4 态 + 8 action，**没有门禁、没有 attemptId、没有重规划、没有角色**。本插件的 `myteam_claim_task` 语义（角色匹配 + deps 全 done + 优先级 + 同级 FIFO + 返回 `attemptId`）在官方模型里**无处安放**。
2. **存储不可控**：官方账本 = Lead 的 Session 日志。本插件要的是 workspace 级独立账本（多团队、归档、离线读）。**用官方服务 = 放弃 FR-19 的两作用域分层**。
3. **上限被写死**：官方的 `maxMembers` / `maxTasks` 是**服务级配置**，本插件需要 `team.config.json` 三层合并（内置 < 项目 < 团队）+ `PATCH_CEILINGS` 硬上限（FR-9.1）。官方只给一个数字。

**但反过来有一个真实收益**：R1（两阶段 spawn + 对账）与 R2（flush 后通知）**正是官方在"用宿主能力"这件事上做到位的部分**——本插件自己实现了存储，就必须自己补上这两条。

### 5.2 能否直接用官方 Web UI `dsh-experimental-client-ui-agent-team`？

**不能。** 它只有 1 个 slot、只读、零 RPC、25 个 i18n key。本插件面板是 27 屏 + 39 端点 + 可写。**但它的数据流形态值得抄**：

| 官方做法 | 本插件可否照搬 |
|---|---|
| 数据来源 = Session 投影（`projectionsBySession[lead].values.agentTeam`），**零 RPC、零自持状态** | ❌ 不行——本插件团队状态在 workspace 文件里，不在 Session 投影里。**但"面板不持状态、只读派生视图"的原则可以照搬**（本插件 `remote/views.ts` 已经是纯函数视图，方向一致） |
| `ctx.slots.inject(slotName, factory)` 惰性注册（等 slot 存在再注册） | ✅ **可照搬**——本插件 `client.js` 的插槽注册目前是直接 `slots.register`，宿主 slot 未就绪时会报错 |
| `useAnchoredPosition` + `createPortal(document.body)` + `role="dialog"` | ✅ 可照搬（R9） |
| 成员状态推导：投影给 `phase`，`running` 由实时 Session 状态补 | ✅ 本插件已同构（`getBoard` 里合并在线/离线） |

### 5.3 能否用官方的 4 型事件代替本插件 40 型账本？

**不能。** 官方 4 型（且后 2 型已停写）覆盖不了门禁/提案/知识/证据/重规划。**这是本插件的核心资产，不是重复造轮子**——40 型事件是 PRD FR-5/FR-11/FR-17 的落地形态。

### 5.4 官方「明确不做」的清单 = 本插件的差异化护城河

| 官方明确不做（`README.zh.md:199-207`、`tool-agent-team/README.zh.md:137-145`、`client-ui-agent-team/README.zh.md:84-92`） | 本插件已做 |
|---|---|
| 无 worktree / 无文件锁 / `writeScopes` 仅提示 | 同（诚实声明层面一致）+ **额外做了完成时 scope 审计**（`core/gates/scope-audit.ts`） |
| 无嵌套 Team / 无重命名 / 无删除 / 名字不复用 | 同（FR 未要求）+ **角色库支持同名多副本**（ADR-006 R3） |
| **不会自动释放任务 owner** | 同（诚实声明） |
| 无发送重试保证 / 不对重发去重 | 同 |
| **无门禁**（`completed` 即终态） | ✅ **三型门禁**（review/verify/archive）+ 打回预算 |
| **无角色层** | ✅ 角色库三层 + 团队模板 + 技能/MCP 绑定 |
| **无知识库** | ✅ 团队知识库（策展制 + 证据指针 + 演化修订） |
| **无成本/ token 口径** | ✅ `tokens.json` 四桶 + 命中率 + 按天桶 |
| **无归档** | ✅ `archive/<teamId>/` 完整快照 + MANIFEST 完整性判据 |
| 面板无写操作 | ✅ 39 端点可写（全部走账本 `actor='human'`） |
| 无 mailbox timeline | ✅ 任务 thread（账本派生）+ 成员私讯 |
| 晚启用需刷新页面 | 同（已知限制） |

---

## 6. 共存风险（本机实测）

> **本机 profile 同时启用了官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 与本插件 `dsh-plugin-myteam`**（`~/.dsh/profiles/desktop/package.json:33,38` 的 `dsh.profile.bundles` 两项都在）。这不是假设，是当前状态。

### 6.1 实测到的两套并存

| 观察 | 证据 |
|---|---|
| 当前会话**能看到官方 9 个团队工具**（`spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_*`），系统提示含 "Agent Teams is available in this session" | 本会话 system prompt（官方 `team:policy` 与 `team:identity` 原文，见 `.tmp/notes/official-surface.md` §2.2） |
| 本插件的 `hideBuiltinTeamTools`（默认 `true`）**只在 `myteam-captain` preset scope 内生效**——它在 `myteam-host` 行的 `apply()` 里调 `this.rt.tools.restrict({deny})`（`host.ts:406-423`），作用域 = 队长 preset 会话 | 本会话**不是** captain 会话（standard preset），所以没被 restrict |

### 6.2 三个具体风险

1. **两套语义并存（中）**：标准会话里模型看到的是官方的 `spawn_teammate` 语义（`target` 是成员名、`{sent:true}` 返回），队长会话里看到的是本插件的 `myteam_*` 语义（`teamId` + `memberId`、`{status:'ok'}` 返回）。**同一个模型在不同会话里对"发消息"的理解不同**，容易串。
2. **官方 patch 的 `disabled: true` 三行**（`tool-subagent-control` / `tool-subagent` / `tool-subagent-fork`）**对本插件无影响**——本插件成员走 `agents.create` 直连（ADR-001），不依赖这三个工具行；`subagents` **服务**仍可用（本插件 `subagents.sendMessage` 走的就是服务不是工具）。
3. **官方 `TeamService` 仍挂在 root realm**（`super(ctx, "agentTeams")`，`index.js:1455`），任何代码路径都可以拿到它。本插件**不调用**它（零依赖边界成立，`plugin/src` 全量 grep `agentTeams` 只有 2 处注释命中），但**无法阻止第三方插件调用**。

### 6.3 建议

- **P2**：在 `docs/06-风险与依赖.md` 新增一条风险（R32「双团队运行时共存」），写清"标准会话 = 官方语义 / 队长会话 = myteam 语义"的边界，并把"是否要在标准会话也隐藏官方 9 个工具"作为**待用户决策项**（当前 `hideBuiltinTeamTools` 只作用于 captain scope，扩展到全局需确认不影响其它插件）。
- **P3**：面板「设置 → 内置工具隐藏」页展示**实际生效的 deny 清单**（而不是配置里的期望值）——现在用户看不到 restrict 的真实结果。

---

## 7. 建议动作（分档）

| 档 | 条目 | 理由 | 预估 |
|---|---|---|---|
| **P1 立刻做** | R1 两阶段 spawn + 对账 | 本插件唯一的结构性空洞（崩溃期孤儿成员）；CHG-77 类事故的根因 | 1.5~2 人日 |
| **P1 立刻做** | R2 flush 后提交通知 | 0.5 人日换一条不变量，防未来重构破坏 | 0.5 人日 |
| **P1 立刻做** | R4 dispose 有界结算 | 现在 dispose 不等待不设期限，宿主关闭可能留脏状态 | 1 人日 |
| **P1 立刻做** | R5 就绪判定单一导出 | 三处口径重复是已知技术债，纯重构 | 0.5 人日 |
| **P1 立刻做** | R7 `no-active-peer` 短路 | 成本最低、收益最直接（治模型空等） | 0.3 人日 |
| **P1 立刻做** | R8 不变量 ADR + 反向断言 | 防旁路的结构性护栏（CHG-86 P0-4 的教训） | 0.3 人日 |
| **P2 排 M2 后段** | R3 投影增量 + 视图缓存 | 收益大但风险中（fold 是公共依赖），需先有逐字段一致性门禁 | 1 人日 |
| **P2 排 M2 后段** | R6 `jsonOutput` 双声明 | 42 个工具分批补；**需先确认输出契约收紧的兼容性** | 2 人日 |
| **P2 排 M2 后段** | R9 UI 参数 + ResizeObserver | 纯打磨，参数已验证 | 0.3 人日 |
| **P2 排 M2 后段** | §6.3 共存风险登记 + 隐藏清单可视化 | 本机已是双运行时共存状态 | 0.3 人日 |
| **P3 记录** | R10 策略文本抽 `systemPrompt.section` | 动它要先推翻 ADR-005 R2（persona 只能挂 preset scope） | — |
| **明确不做** | 依赖官方 `ctx.agentTeams` 服务 | 语义不匹配（4 态无门禁/无角色）+ 存储不可控 + 上限被写死（§5.1） | — |
| **明确不做** | 复用官方 Web UI 组件 | 只读、零 RPC、25 key，与本插件 27 屏不在一个量级（§5.2） | — |
| **明确不做** | 迁移到官方 4 型事件 | 覆盖不了门禁/提案/知识/证据/重规划（§5.3） | — |

**P1 合计 ≈ 4.1 人日**（6 条，全部是"补自己实现的存储带来的必然后果"，不新增能力面）。

---

## 8. 附录：取证方法与边界

### 8.1 取证方法

- **版本口径**：本机 `app.asar` 解包得到 **0.2.2-rc.1**；`refs/host-src/` 快照是 **0.2.1-rc.3**（更旧）。**本轮以 0.2.2-rc.1 为准**，行号全部对应该版本。
- **解包方式**：`tools/extract-asar.mjs`（按 asar 头偏移取单文件，未全量解包），产物在 `.tmp/asar-current/`（**不入库**）。
- **四包逐行通读**：`agent-team/lib/index.js` 1638 行、`tool-agent-team/lib/index.js` 556 行、`client-ui-agent-team/lib/client.js` 690 行、`agent-team-profile/cordis.patch.yml` 29 行 + 三个中文 README 全文。
- **本插件盘点**：`plugin/src/**` 只读，核实了 README 声明的三个数字（**工具 42 = Lead 33 + 成员 9 ✅ / 账本 40 型 ✅ / 门面 39 端点 · Remote 26 ✅**）。
- **原始笔记**：`.tmp/notes/official-core.md`（495 行）、`.tmp/notes/official-surface.md`（558 行）、`.tmp/notes/ours.md`（474 行）。**不入库**（`refs/` 与 `.tmp/` 都在 `.gitignore` 内）。

### 8.2 已知偏差（写文档时别照抄源码注释）

| 位置 | 注释写的 | 实际 |
|---|---|---|
| `plugin/src/tools/defs.ts:6,206` | 「Lead 工具（22 个）」 | **33 个** |
| `plugin/src/host.ts:13` | 「Lead 工具 17 个注册」 | **33 个** |
| `plugin/src/core/members/member-setup.ts:6,10` | 「8 个成员工具」 | **9 个** |
| PRD §3 / §7.1 | command 门叫 `command` | 代码状态机与配置里叫 **`verify`**（`gate:verify`，`core/gates/command-gate.ts` 实现） |

### 8.3 PRD 声明但未落地的存储（诚实记录）

`state/rules.version` 独立文件、`display.json`、`attachments/`、`state/logs/` 写入、`export/` 写入——**均无实现**（`rules.version` 只作为账本首事件 `rules.version.adopted` 存在）。`team.json` 运行时不落盘（ADR-002 决策 B），只有归档目录下的快照。

### 8.4 未覆盖

- 官方四包的**单元测试**（未随包分发）。
- 官方 `dsh-experimental-agent-team-profile` 在 **headless / CLI / SDK profile** 下的行为差异（本轮只看了 Web/Desktop 路径）。
- 本插件 `client/client.js`（785.9 KB）的逐行审阅——本轮只核对了它对外暴露的插槽与数据来源。
