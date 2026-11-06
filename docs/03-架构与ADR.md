# 03-架构与 ADR

> TL 主导维护。所有架构决策必须落在这里，不允许只留在聊天里。
> 技术前提已由 T0 探针验证（docs/02-技术可行性.md，CHG-14），本文架构建立在验证过的事实上。

## 架构总览

### 运行形态（对应 PRD v2.3 双模式；**已按 ADR-005 R1-勘误同步为 preset EntryGroup 实际形态**）

```
┌─ DSH Host（单进程，web profile）──────────────────────────────────────┐
│                                                                       │
│  myteam 插件（bundle patch 声明 4 行，入口 = lib/host.mjs 构建产物）     │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ ① myteam-carrier（顶层裸包名行，apply 直接 return，仅为进 client 图）│   │
│  │ ② myteam-panel（根级 typert 门面，inject=['agents','agentPresets']）│   │
│  │     └─ 26 端点：listTeams + 项目/角色 3 + 5 离线 + 17 会话门面（serviceFor 透传）│   │
│  │ ③ myteam-preset-captain（@deepseek-ai/dsh-agent-preset，id=myteam-captain）│   │
│  │     └─ plugins[]（preset 子行，**均须显式 name**）：              │   │
│  │        ├─ myteam-host（name=包根）→ service + 26 Lead 工具        │   │
│  │        │     + **行级 isolate:{myteam:true}**（防 leaksServices）  │   │
│  │        └─ myteam-persona-captain（@deepseek-ai/dsh-persona）      │   │
│  │ ④ client（package.json dsh.client.inject 声明 6 个宿主包）        │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  队长会话（team preset 新建）          成员会话（插件经 agents.create） │
│  ┌──────────────────┐                ┌──────────────────────────┐    │
│  │ 队长提示词（preset │  myteam_* 工具 │ member setup 作用域内：     │    │
│  │ 常驻，F3 最优）    │ ───spawn────▶ │ · 9 成员工具（agent-scoped）│    │
│  │ Lead 工具全集      │  agents.create│ · 角色提示词 section        │    │
│  └──────────────────┘  +setup 作用域  │ · tools.restrict(业务收窄)  │    │
│           │                           │ · skills provider(绑定注入) │    │
│           │ task.escalated 通知       └──────────────────────────┘    │
│           ▼                                    ▲    │                 │
│  ┌──────────────────┐                          │    │ followup 唤醒    │
│  │ myteam service   │◀──事件写────  成员工具调用 ┘    │（四种因果唤醒）  │
│  │ ledger.jsonl 单写者│                            ▼                 │
│  │ .team-workplace/ │──── tokens.json 侧车（tokenMeter 重放派生）    │
│  └──────────────────┘                                               │
└──────────────────────────────────────────────────────────────────────┘
```

> **形态要点（易踩坑，均有实弹记录）**：①patch `insert:` 是**追加**语义，同名 id 追加会触发 boot sweep 的 duplicate 报错——跨层覆盖必须走**顶层行**；②preset 子行**缺 name** = import 失败静默跳过（FIX-8）；③dsh-persona **不能顶层挂载**（与 deployment persona 冲突 fail loud）；④`myteam-host` 不写 `isolate:{myteam:true}` 会因 `Preset services require isolate realms` 报错、preset 卡片显示"加载失败"（CHG-32 实锤）；⑤入口必须是**包根**名（含 `/` 的 exactPackageSpecifier 被拒）。

### 模块划分（host 插件内，五域；**依赖方向单向：D1←D2←D3，D4/D5 依赖 D1**）

| 域 | 模块 | 职责 | 关键依赖（实现层） |
|---|---|---|---|
| **D1 账本域** | `core/ledger` | append-only JSONL 单写者、事件 schema 校验、seq 分配、rules.version、崩溃残行截断 | 仅 `node:fs`（零第三方依赖；无 dsh-atomic-write，原子性由 write+fsync+close 序列自实现） |
| **D2 调度域** | `core/scheduler` | 状态机 fold、依赖求解、原子 claim（attemptId）、escalate/re-scoping、恢复决策表（**全部纯函数**〔J1〕） | 仅 D1 的类型（无运行时依赖） |
| **D3 成员域** | `core/members` | agents.create 封装、setup 作用域组装（9 工具+restrict+persona+skills）、快照 identity.json、排空/三态、并发上限自管 | 宿主 `ctx.agents`（动态注入，非构造期依赖） |
| **D4 角色库域** | `core/roles` | 三来源解析（内置只读/全局/项目）、引用即复制、C7 守门、create-role 校验、sessionDefaults | 仅 `node:fs` |
| **D5 接口域** | `tools/` + `remote/` + `client/` | Lead/成员工具定义、面板 Remote 方法、Web 工作台 | 宿主 `ctx.tools`/typert/client-ui-* |

> **"零依赖"的精确含义**：无第三方 npm 运行时依赖（`dependencies` 为空），宿主服务全部经 `ctx` 注入；文档早期写的 `dsh-atomic-write` 是设计意图，**实现未采用**（自实现 fsync 序列，见 D1）。

### 核心数据流（唯一权威 = 账本；**读路径以内存投影为准**）

1. **写路径**（唯一写者 = host 插件进程）：队长/成员工具调用 → myteam service 校验（C5/DoR/乐观锁）→ **副本上单事件 `applyEvent`（先算后写：折返失败即弃）** → 账本 append（原子写）→ 事件广播 → 触发唤醒/面板失效。单次提交 O(1)（CHG-59）。
2. **读路径**：面板经 Remote 读 **service 内存投影**（`projectionSnapshot`）；**不落也不读 team.json**（ADR-002 R2 决策 B 已实装）；冷启动从 `ledger.jsonl` 全量重放一次（唯一恢复路径）；成员 `get_task/list_tasks` 读投影（NFR-7.6 限界）。
3. **唤醒路径**：账本事件 → 判定四种因果唤醒（assign/message/resume/revoke）→ `handle.agent.followup()`（无事件即零请求，NFR-7.1）。
4. **计量路径**：disband/周期 → 对每成员 session 调 `tokenMeter.measure()`/读 `tokenUsage` 投影 → 按天桶聚合 → tokens.json 侧车（不进模型上下文）。

## ADR 列表

### ADR-001 成员通道：agents.create 直连，不走 subagent 委托工具链
- 状态：已接受（2026-10-25，依据 T0-①/②）
- 背景：PRD 要求成员为"独立根级 Agent"（FR-3.1）。宿主有两条产生会话的通道：subagent 管理器（受 `maxActiveSubagents=8` 池约束、初始 prompt 被追加 return guidance）与 `ctx.agents.create()` 直连（无池、无追加、setup 作用域完全自主）。
- 决策：成员经 `ctx.agents.create({sessionId, agentOptions, setup})` 直连创建，`sessionId` 由插件按 `mt-<teamId>-<roleSlug>-<n>` 分配以便幂等恢复；父链（parentAgent）不设置——成员是运行时根，归属关系由账本表达而非宿主 lineage。
- 备选方案：①走 dsh-subagent 的 startActivation——被否：占池 8 上限、prompt 追加、外部后端不可续；②fork 继承——被否：上下文混入正是 v2.2 要避免的。
- 放弃原因：T0-② 证实直连通道不吃池、setup 作用域提供 C5/C6 全部所需；subagent 通道的优势（宿主管理的结果通知）myteam 用自己的账本+唤醒实现且更可控。
- 何时重构：若宿主未来给 agents.create 直连加池/配额约束，改回 subagent 通道并把 maxMembers 映射到池容量。

### ADR-002 账本单写者与投影架构：账本为唯一权威，投影仅存内存（不落 team.json）
- 状态：已接受（2026-10-25；**2026-10-31 R2 收口，CHG-59**）
- 背景：PRD〔I2〕要求 UI/工具/面板全部由账本派生；R19 要求大账本上聚合查询不劣化。
- 决策：写路径收敛到 host 插件进程的单一 service（Cordis 单例，天然单写者）；**投影仅存内存 + 账本为唯一权威**：每次提交在投影**副本**上 `applyEvent` 单事件（O(1)），成功才 append 账本并切换内存投影；冷启动从 `ledger.jsonl` 全量重放一次（O(n)，唯一恢复路径）。**team.json 明确不落盘**（原"原子落盘/损坏可重建"承诺作废，见下 R2 收口）。账本 append 前校验（状态机合法转移 + FR-11.2 硬校验 + 证据块），**拒绝式**；投影含 per-task 消息索引，解 R19。
- 备选方案：①多写者 + 文件锁——否：复杂且与宿主单进程模型〔I10〕冲突；②不落投影、每次全扫——否：R19 性能。
- 放弃原因：单写者与"状态机 fold 纯函数"〔J1〕天然契合；投影可重建性由验收场景 6 覆盖。
- 何时重构：若 v2 支持多进程/多 Workspace 活跃团队，账本需引入按 teamId 分片的协调层。
- **R2 收口（CHG-59，2026-10-31；对应 R37/R38）**：原「原子落盘 + 损坏可重建」承诺已**作废并实装决策 B**——
  - **决断**：取 B（投影仅内存、冷启动全量重放），不取 A（原子写 team.json + checksum/coveredSeq 校验）。理由：增量 apply 后单次提交 O(1)，冷启动 O(n) 只发生一次；team.json 换来的只是「省一次重放」，代价是双写一致性与第二个事实源（M2 规模 n≈数十~数百事件，收益不成立）。
  - **实装**：`TeamService.commit()` 改为「结构校验 → `structuredClone(投影)` → `applyEvent(副本, event)` → `appendEvent` → 切换投影」（CHG-59）。顺带修掉旧路径的隐患：旧实现 append 后全量 fold，一旦 fold 防线抛错会留下**不可重放的脏事件**；新顺序先算后写，失败不落账本、不动投影（t40 用例 2 断言）。
  - **验证**：t40 三用例（增量与全量重放逐字段一致 / 失败不落账 / 冷启动重放一致），全量 198 绿（含 t42 门禁三用例）；`revision` 语义 = 已应用事件数（逐事件 +1）。
  - **重估触发条件**（与 R30 同源）：账本真到 10k+ 事件或冷启动实测明显变慢，再评估方案 A；届时 team.json 必须声明为「可弃缓存」，删除不影响正确性。

### ADR-003 队长会话 = team preset 行，成员工具用 preset 载体 + setup 双层注入
- 状态：已接受（2026-10-25，依据 T0-⑤）
- 背景：CHG-12/13 定稿队长预设化（唯一团队入口）。preset 是声明式 Cordis 插件行，工具注册有全局层与 agent 作用域两层。
- 决策：①插件 bundle patch 同时声明 host 行与 `myteam-captain` preset 行；preset 的 plugins[] 挂 myteam 工具行 + 队长提示词 section + create-role 技能；②成员工具（9 个）在成员 setup 作用域内经 `agentCtx.tools.register()` 注册——同一工具定义函数复用，注册层不同可见性即不同（Lead 全集 22 个在 preset 层，成员 9 个在 agent 层）；③成员业务工具收窄用 `agentCtx.tools.restrict(allowMask)`，掩码按角色 allow 白名单生成（9 团队工具永不入掩码 deny 名单——C5 硬边界在掩码生成函数中断言）；**CHG-58 起**成员技能/MCP 追加运行时硬隔离（技能同名占位屏蔽 + `tools.restrict({ deny })` + 执行期 guard，见 docs/04 §1.2e）。
- 备选方案：①全部工具注册在全局层 + 运行时 guard 拒绝越权调用——否：工具 schema 对模型可见性失控（成员看到 Lead 工具诱导误用），token 面浪费（NFR-7.4 违约）；②两套工具定义——否：schema 漂移风险。
- 放弃原因：preset 层 + agent 层是宿主官方可见性模型（T0-⑤），最小机制实现 NFR-7.4。
- 何时重构：若宿主 preset 支持 per-session 工具覆写（未来能力），成员工具可迁到 preset 子行。

### ADR-004 token 计量：插件侧车 tokens.json，四桶口径，按天桶聚合
- 状态：已接受（2026-10-25，依据 T0-③）
- 背景：FR-8.2/R10/REV-5。tokenMeter 无持久化（T0-③ 实锤），只给 totals 与 measure() 快照。
- 决策：tokens.json 侧车 schema：`{version:1, teamId, updatedAt, days: {"2026-10-25": {memberId: {uncachedInput, cacheRead, cacheWrite, output, calls}}}, totals, note}`（字段以 `core/ledger/token-sidecar.ts` 为准）。聚合时机：①每次面板读时增量 fold 账本（首选，O(delta)）②disband 全量重建兜底。口径 = tokenUsage 投影四桶 + 命中率派生（cacheRead/(cacheRead+uncachedInput+cacheWrite)）；heuristic 部分标注"估算"；熔断口径独立字段不混入（REV-5）。聚合函数纯函数 + 单测〔J1〕。
- 备选方案：①读宿主 session-stats 包——否：它是会话级 UI 投影，无按天桶与成员对照；②每请求实时写账本——否：token 数据进账本违反 F2（不进模型上下文的数据分离）。
- 放弃原因：侧车是 PRD 明示落点；四桶由 T0-③ 定死。
- 何时重构：宿主若提供持久化 token 服务，侧车降级为缓存。

### ADR-005 插件装载形态：preset EntryGroup 组合装载（host/persona 均为 preset 子行）
- 状态：已接受（2026-10-25，依据 T0-⑤ + TF 实证；**同日修订 R1**——官方插件生命周期对齐复核）
- 背景：TF 实证 `insert:` 块语义（顶层行是"替换"语义，找不到目标被静默跳过）；name 必须用包根否则 client 端不装载（TF cordis.patch.yml 注释实锤）。
- 决策：cordis.patch.yml `insert:` 块声明 **preset EntryGroup 组合**：`myteam-preset-captain`（name=@deepseek-ai/dsh-agent-preset，config.plugins 内嵌两子行——`myteam-host`（name=包根，服务+Lead 工具+Remote）与 `myteam-persona-captain`（name=@deepseek-ai/dsh-persona，队长身份提示词））。**host 行不再顶层挂载**：Entry._init 按 options.name 解析（子行缺 name = import 失败静默跳过）；dsh-persona 只能挂 agent scope（顶层与 deployment persona 冲突 fail loud）。副作用（已接受）：服务与工具仅在队长会话 scope 激活（NFR-7.4 强化），`.team-workplace` 目录初始化随队长会话首开而非应用启动；面板 Remote 通道在 M2 接 gateway 前显示友好不可用态。client 注入声明进 package.json `dsh.client`（inject 列表对齐官方 client 形态）。engines.dsh 写 `>=0.2.1-rc.0 <0.3.0`。
- 入口形态（修订 R1 定稿）：host 导出 `apply(ctx, config)` + `inject = ['tools','agents']`（host-plugin.md 规范）；~~入口指向 `./src/host.ts`（Node 24 strip-types 直跑，不依赖构建产物）~~ **实际实现指向 `./lib/host.mjs`**（见 R1-勘误）；资源清理归 `ctx.effect`。
- 备选方案：①单行多职责——否：client 检测按 entry 名解析 package.json；②host 顶层全局挂载——否：persona 顶层 fail loud + 服务可见性违反 NFR-7.4；③~~入口指向 lib/host.mjs——否：构建产物不存在即装载失败~~ **实际采用了此方案**（构建产物 `plugin/lib/**` 20 个 .mjs 随包分发，`files` 白名单含 `lib`）；strip-types 直跑 src 在 Node 24 可用但**未采纳为装载入口**。
- 放弃原因：preset EntryGroup 是 Loader 官方组合语义（dsh-agent-preset EntryGroup + dsh-persona「No global mount」README 实证）。
- 何时重构：宿主 manifestVersion 升级时随迁；若 M2 面板需要 app-boot 期全局服务（如 archive 视图），再评估 host 行拆双行（全局服务行 + preset 内工具行）。
- 修订记录：R1（2026-10-25）原「三行顶层 bundle patch」形态在官方生命周期复核中发现 4 处致命缺陷（patch 子行缺 name / persona 顶层挂载 / 入口指向不存在的 lib/host.mjs / host 导出无 apply+inject），全部修复并回归 107/107。
- **R2-补充（2026-10-31，CHG-42/43）**：**团队与角色的创建一律通过「团队模式」预设会话（队长工具）完成，面板不做创建**——面板定位为「查看 + 管理」：全局视图看团队列表与**角色↔团队关系**，团队工作台看板/流程（任务流转检查）/角色/知识。面板不调 `session/create`（CHG-43 纠正 CHG-42 的面板建队入口）。**preset 行保留**（宿主约束：`@deepseek-ai/dsh-agent-preset` 配置仅 id/plugins/name/description/order，无 hidden/内部标记；`dsh-persona` 只能挂 preset scope，顶层挂载与部署级 persona 冲突 fail loud ⇒ 队长身份只能由 preset 承载）。「团队模式」仍会出现在 DSH 预设列表中——彻底移出预设体系需宿主能力（隐藏预设或非 preset 的 agent 身份注入），已登记为宿主缺口。
- **R1-勘误（2026-10-31，PM 复核「分析当前系统架构」会话 + 源码实证）**：本节存在**三处自相矛盾**，需以源码为准修正认知——
  1. **准入形态的"决策"与"备选方案③"互相冲突**：决策段写"入口指向 `./src/host.ts` 不依赖构建产物"，备选③又把"入口指向 lib/host.mjs"明确否决为"构建产物不存在即装载失败"；
  2. **实际实现选择的是被否决的那条**：`plugin/package.json` `main: "./lib/host.mjs"`、`exports["."]: "./lib/host.mjs"`、`files` 白名单含 `lib`，且 `plugin/lib/**` 现存 26 个 `.mjs`（host/panel/host-workspace + core/remote/tools 子目录；数量以 `lib/build-manifest.json` 为准），`scripts/build-lib.mjs` 用 `node:module.stripTypeScriptTypes` 预编译——**装载入口实为构建产物**；
  3. **"指向不存在的 lib/host.mjs"是历史事实而非当前事实**：R1 修订记录说的缺陷是"指向了**不存在**的产物"（当时未构建），而非"不该指向产物"。当前产物已存在且必须随包分发（发布契约），所以正确表述应为「**入口指向 lib/host.mjs（构建产物必须随包存在并保持与 src 同步）**」。
  - **正确结论**：入口 = `lib/host.mjs`；`src/**`（26 个 .ts）是唯一的**源**，`lib/**` 是**构建产物**，二者必须同步（由 R38 一致性门禁守住：`lib/build-manifest.json` 源码指纹 + t42 三用例，改 src 未重跑 bundle 即红）；ADR-005 的"不依赖构建产物"表述作废，KI-7 的"打包时再评估 bundle 化"已事实上完成（bundle 即当前形态）。
  - **为何这条重要**：若后来者按旧措辞去改 `main` 指向 src，会立刻踩回 R1 的坑（开发态 strip-types 可能可用，但发布包装载会失败）；这是"文档比实现跑得远"最典型的第三例，与 R37（team.json）、R38（src-lib）同批清偿。

### ADR-006 面板数据流：Remote 只读侧车与投影，写操作一律走账本
- 状态：已接受（2026-10-25）；**R1 修订（2026-11-01 CHG-72）：面板写边界细化**
- 背景：FR-12.1（人留言写账本 actor=human）、NFR-7.2（面板读磁盘真相）、R20（双入口留痕形态）。
- 决策：client 经 `ctx.remote.myteam.*`（TypertRemoteService，TF 同型）只读投影/侧车 + 提交写意图（留言/审批三动作/成员操作）；写意图落到 myteam service → 走与工具调用相同的账本写路径（同一校验、同一 seq 权威）。**面板绝不直写文件**。
- 备选方案：面板直接读写 .team-workplace 文件——否：绕过校验与单写者，破坏账本完整性。
- 放弃原因：账本唯一权威是 I2 不变量。
- 何时重构：无。
- **R1 修订（CHG-72）**：面板从「只看 + 少量管理」扩到四类日常写入口，边界按「是不是账本实体」二分：
  1. **账本实体（任务）**：`createTask` / `updateTask` / `assignTask` / `participateTask` 四个门面端点，经隔离服务复用 `executeLeadTool` → `TeamService.commit` → `validateEvent` → `appendEvent` 同一条单写者管线；`exec.actor='human'` 让账本 actor 记人工（不是伪装队长）。面板拿不到会话时返回 `unavailable`，离线团队只读。
  2. **配置资产（角色）**：`saveRole` 直接写 `config/roles/<id>.json`（**不进账本**）——角色不是任务/团队那种账本实体，运行时只认项目库、召唤时快照；为保证不绕过校验：与工具链共用 `assertValidRole`、同名必须显式 `confirm`（两段确认）、captain 身份禁止覆盖、每次写入追加 `.audit.jsonl` 审计行（ts/actor/action/roleId/file）。若将来角色也进账本，本段作废并改为事件。
  3. **建队不新增写路径**：面板只生成首条指令并 `uiWorkspace.startSession({agentPreset:'myteam-captain'})` 打开团队模式会话，团队仍由队长 `submit_plan` + 人工批准产生（ADR-005 R2 不变）。
  4. 结论：**账本写仍只有「工具」与「面板意图」两个入口，且共用同一管线；配置资产写只开放给角色，且带校验/确认/审计三件套**。
- **R2 修订（2026-11-01 CHG-73）：执行期写操作沿用 R1 的二分，并补三条边界**
  1. **重规划 / 取消 / 批量都是账本写**：`rescopeTask` / `cancelTask` / `batchTaskOp` 三个门面端点 → 隔离服务 → `executeLeadTool` → 同一管线，`actor=human`；批量编排逐条独立落账（同一 `batchId`），**不引入批量事务**——账本 append-only 语义下，部分成功是可见且可审计的正确结果，回滚会伪造历史。
  2. **角色删除仍按配置资产处理**：`deleteProjectRoleSafe` 复用 C7 守门（模板引用 / 团队在册 / 项目自身角色三处占用面），两段确认 + `.audit.jsonl`（action=deleted）；只允许删项目库（内置/全局是复制源，删了会误导「改了全局」）。
  3. **服务端算动作，客户端不算规则**：看板/详情下发 `actions {rescope, cancel, edit}` 与 `evidenceStale`，UI 只负责展示与收集理由。理由（reason）在所有不可逆/结构写操作上必填（重规划、取消），属于审计字段而非 UI 装饰。
  4. 结论不变：**账本写两入口共用管线；配置资产写（新建/覆盖/删除）三件套不变；面板不新增绕过校验的路径**。
- **R3 修订（2026-11-02 CHG-74）：同名角色副本的目录口径——不隐藏、不误认、只认项目库**
  - 背景：spawn 按「引用即复制」把内置角色复制进项目库，于是同一个 `id` 同时存在多份（内置只读 / 全局个人资产 / 项目库副本 / 项目自身角色）。旧实现有两个真缺陷：①**详情取错来源**——`buildRoleDetailView` 用 `entries.find(id)` 命中第一份（内置），于是「项目里改的那份，详情却显示内置定义」，编辑入口也走错分支（fork 而非 edit）；②**列表 id 重复**——视图里同 id 两份，客户端用 `role.id` 作 React key → 重复 key，角色卡互相吞。
  - 决策：
    1. **目录不隐藏任何一份**（隐藏会让人以为自己的角色丢了），只标注 `shadowedBy`（谁让我让位）；
    2. **生效优先级 `project > project-role > global > builtin`**——运行时真相恒为项目库（R13 不变）；
    3. **详情按生效条目返回**（`getRoleDetail` 附 `shadowed:[origin…]` 与 `editable:boolean`），客户端同样按优先级挑生效条目；
    4. 客户端列表 key 改 `origin:id`（key 必须能区分同名副本）。
  - 备选方案：①目录只留生效那一份——否：用户会以为自己的副本被系统删了；②详情继续用第一份——否：就是本轮修的缺陷。
  - 后果：+「项目里改的那份」在详情里正确显示，编辑按钮是「编辑」而非「复制到项目」；+同名副本一眼可辨。− 视图多一个 `shadowedBy` 字段与一条「同名副本」说明文案。

### ADR-007 澄清硬终止与证据块：host 结构化判定，不做全文语义解析
- 状态：已接受（2026-10-25）
- 背景：FR-1.6（plan.clarify）、FR-5.0（证据块）、TF 教训"禁止全文拒绝词即否决"。
- 决策：①证据块 = `update_task` 工具的**结构化参数**（`evidence: {command?, exitCode?, assertions?, na?: {reason}}` 必填于 done 申报），host 校验字段完整性后落 `task.evidence` 事件——不解析自由文本；②澄清拦截 = `submit_plan` 前置状态检查（账本存在未关闭的 `plan.clarify` 事件 → 拒绝提交），追问轮数计数由 host 在 clarify 事件中累计，N 默认 3（config 可调）；③结论行判定（M2 review 门禁）= review 申报工具的 `verdict` 枚举参数，同样结构化。
- 备选方案：从成员输出文本中正则提取证据块——否：TF 证实脆且易被拒词误杀。
- 放弃原因：工具参数化是宿主工具体系的原生形态，比文本协议可靠。
- 何时重构：无（M2 command 门禁在此结构上扩展，不推翻）。

### ADR-008 并发上限自管：maxMembers 是插件级配额，创建失败可重试可报告
- 状态：已接受（2026-10-25，依据 T0-② R6 消解）
- 背景：R6 消解后，宿主不再为成员创建提供背压；maxMembers=6 的理由变为模型并发成本与上下文管理。
- 决策：myteam service 内维护创建计数器（账本 member.spawned 事件为真相）；maxMembers 校验在 spawn 工具入口（拒绝式）；创建失败（模型路由错误/凭据缺失）→ 账本 `member.spawn_failed` 衍生记录（复用 member.spawned payload 的 status 字段），队长 Inbox 可见，幂等重试安全（sessionId 固定）。
- 备选方案：复用宿主 maxActiveSubagents 配置——否：语义不同（那是 subagent 通道的），混用误导用户。
- 放弃原因：配额语义必须与真实约束（成本）对应。
- 何时重构：宿主若给 agents.create 加配额服务则对接。

### ADR-009 成员记忆区：文件即真相 + 事后审计，不建记忆服务
- 状态：已接受（2026-10-25，CHG-19 用户拍板记忆波次 T19~T21）
- 背景：PRD v2.5→用户增补记忆内容（§5.6 FR-6.1~6.7 + 三层记忆模型 + `memory.evidenceRequired` 配置）；M1 只落数据层与纪律（FR-6.3 UI 计数、FR-6.5/6.6/6.7 留 M2/M3）。
- 决策：①**文件即真相**——成员记忆就是 `state/.../members/<id>/memory/`（memory.md + notes/）普通文件，插件不建记忆数据库、不做读写代理；成员经宿主 write/Edit 工具直写（R26：spawn 时由 host 进程 fs 播种模板，notes/ 由成员自建）。②**审计不拦截**——FR-6.2 的"无证据写入被禁止"落为：提示词纪律（T20 section）+ 事后扫描（T21：任务收口后、release 前，扫 frontmatter/条目级 `evidence:` 指针，违规落 `memory.audit` 账本事件，fold 跳过、统计面消费）——与 FR-5.4 scope 完成时审计同一取向。③**FR-6.4 交接纪律走提示词**——正面陈述身份连续性（"你是延续，不存在上一代"）+ 显式禁止 handoff 宣告（E6 反坑：告知"交接"会诱发交接动作）。
- 备选方案：a) 插件记忆写入工具（成员经 myteam_write_memory 写）——否：增加工具面（违背 NFR-7.4 工具面最小化），且文件直写是宿主原生形态；b) 写拦截（扫描在 write 前阻断）——否：宿主 write 工具不在插件控制面内，做不到，诚实声明；c) 全自动记忆（成员自行沉淀）——否：TF ADR-0009 否决先例，团队级知识必须走策展门（FR-17.4）。
- 放弃原因：M1 的目标是记忆的**身份绑定、持久性、可审计**三件事，全部可由"文件 + 提示词 + 审计事件"最小闭环达成；代理层与拦截层是 M2/M3 观察后再议的增强。
- 何时重构：若 M2 审计数据显示违规率高且提示词纪律失效，再评估"release 门禁 hard 阻断"（违规未清不许归档）；FR-6.6 简化 respawn 时记忆恢复直接复用本层（sessionId 不变 → memory/ 天然延续）。

### ADR-010 方案边界：常驻团队 / 临时委派 / 单 agent 能力，三种形态怎么选
- 状态：已接受（2026-10-31，M2-A2；依据架构会话判据 + CHG-39/40 实弹经验）
- 背景：同一件工作有三种可用形态——**A 常驻团队**（myteam：插件持会话 + 账本 + 看板 + 门禁）、**B 临时委派**（宿主 `subagent` 一次性任务）、**C 单 agent + 能力**（技能/工具直接给当前会话，不组队）。三者成本、隔离强度、可审计性各差一个量级；没有判据就会出现「用团队去 grep」「用一次性委派做跨天项目」两类浪费。架构会话里的「方案三 / 方案二 / 方案一」简称仅作索引：A=骨架（方案三）、B=临时委派（方案二）、C=能力（方案一）——**本 ADR 以行为定义为准，避免编号歧义**。
- 决策：**五问判据**（按序回答，命中即定形态，不再往下问）：

| # | 问题 | 是 → | 否 → |
|---|---|---|---|
| 1 | 产出要不要**跨会话留存、事后可审计**（谁在何时改了什么、证据/门禁记录在哪）？ | **A** | 问 2 |
| 2 | 是否需要**多人并行**且职责/权限不同（不同技能、MCP、工具白名单，需硬隔离）？ | **A** | 问 3 |
| 3 | 任务是否**一次性、可丢弃**、失败重来成本低（搜索/试跑/临时评审/批量改写）？ | **B** | 问 4 |
| 4 | 是否**单线程、能在一个上下文里做完**（写一篇文档、改一个文件、跑一次分析）？ | **C** | 问 5 |
| 5 | 是否**跨天、需要角色交接与门禁**（评审/验收/返工/交接下一班）？ | **A** | **B**（并在任务说明里写清「为什么不用 A」） |

- 形态对照（成本量级与硬边界）：

| 维度 | A 常驻团队 | B 临时委派（subagent） | C 单 agent + 能力 |
|---|---|---|---|
| 启动成本 | 高（建团 + 名册 + 计划审批 + 门禁） | 低（一次 spawn） | 零 |
| 状态与恢复 | 账本权威，可重放/归档/审计 | 随会话结束消失 | 随会话结束消失 |
| 职责隔离 | 角色 + 技能/MCP 硬隔离（CHG-58） | 仅 prompt/工具面差异，无账本约束 | 无（同一上下文） |
| 并发 | 插件自管 maxMembers（ADR-008） | 宿主池（8，超限不排队） | 1 |
| 适用时长 | 小时~周（跨会话） | 分钟~小时（单次） | 分钟 |
| 反悔成本 | 中（解散/归档仍留痕） | 低（重跑） | 低（重写） |

- **该用 subagent（B）的四个信号**：① 只需要一份结果、不需要过程记录；② 结果可丢弃，失败直接重跑；③ 不需要角色权限差异（都用同一套工具）；④ 分钟级、单轮或少数几轮就能收口。
- **该升级到 A 的三个信号**：① 需要「谁批的、证据在哪、门禁过没过」；② 需要两个以上角色互相制衡（做的人 ≠ 验的人）；③ 需要跨会话继续（今天没做完，明天接着做）。
- **反模式（明确禁止）**：
  1. 用 A 做一次性工作（建团 + 审批 + 门禁的成本远高于产出）；
  2. 用 B 做需要审计/交接的长期项目（结果无账本、无法追责、无法恢复）；
  3. 用 C 假装团队（同一上下文里"扮演"多个角色，没有隔离与制衡，评审必然自我通过）；
  4. 在 A 的成员里再嵌套 B 做子任务（C5 已把 subagent 类工具收窄掉，且嵌套会破坏 attempt 归属）；
  5. 用 B 承载需要用户多轮裁决的流程（审批面只在 A 的收件箱/门禁里）。
- 何时重构：若宿主提供统一的「可持久化任务委派」抽象（带审计与恢复），A/B 可合并为一种形态，本 ADR 随之作废并改写；在此之前，边界以本表为准。

### ADR-011 面板实体关系与作用域分层（提案——设计稿先行，CHG-64~68）

**状态**：**接受（2026-11-01 CHG-69 已实现）**——账本 +2 事件、投影 participations/assignees、视图 ProjectView/RoleCatalogView/RoleDetailView、门面 +2 端点、工具 22→25、面板 IA 重构（212 绿，CDP 实测）；契约见 docs/04 §2/§3，模型见 docs/11 §九。

**背景**：面板早期把任务塞在团队里（团队 tab = 看板）、「成员」与「角色」概念混用、全局与项目不分。用户于 2026-11-01 五轮拍板（CHG-64~68）确立新口径。

**决策**：
1. **双实体**：任务与团队是项目内两个独立实体。任务（派单 / 依赖 / 门禁 / 证据 / 验收口径）升为项目级；团队（队员 / 知识 / 审计 / 设置）不再拥有任务。
2. **两条关系边（都不是实体）**：队员 = 角色 × 团队（聘任记录，快照召唤时固化）；参与 = 任务 × 团队（主责 1 / 协作 N，多对多）。两条边同构，UI 各有三处显性化表达。
3. **作用域两层**：全局只有角色（内置只读 + 全局资产，不设团队）；项目有团队、任务与项目自身角色。项目层导航 = 角色 / 团队 / 任务三标签；团队内 = 队员 / 参与任务 / 知识 / 审计 / 设置五标签。
4. **实现细节不出 UI**：存储路径与复制方向只进文档；来源对用户以「卡片小标 + 筛选 + 动作语义（引入全局角色 / 复制到项目）」表达。

**后果**：+面板 IA 清晰、任务 / 团队关系可显性化（参与团队轨 / 任务卡团队 chip / 参与任务 tab）；−账本需新增参与事件与跨团队聚合读（全局索引扩展）；任务账本物理分布不变（主责团队持有，协作团队引用）。

**关联**：CHG-64~69、docs/00 FR-19~24、docs/11 §九、design-notes §十~十三、R35（契约漂移门禁先行）。

**实装要点（CHG-69）**：①参与边由主责团队单写（账本物理分布不变），协作方只读聚合；②`task.created` 隐含主责边、旧账本视图回落 owner=lead；③主责迁移/跨团队 claim 明确不支持（拒绝式），协作 = 关系 + 指定队员 + 展示；④项目自身角色是独立文件 `config/project-role.json`，不进项目角色库目录，避免被误当成普通项目角色删除。

### ADR-012 派单唤醒（dispatch）——第五种因果唤醒（CHG-71）

**状态**：接受（已实现，222 绿）

**背景**：M1 的唤醒纪律是「四种因果唤醒」（assign/message/resume/revoke），其余事件不唤醒空闲成员（NFR-7.1 零请求）。实装后发现它有一个执行面空洞：**新建任务、上游完成解锁下游，没有任何人会被叫醒**——成员上岗时若没有任务就会静默等待，团队因此停在原地，「建任务让团队执行」实际不可用。

**决策**：在提交后增加一次**克制的派单扫描**：
1. 触发事件限定为「可能改变可领集合」的：`task.created` / `task.completed` / `task.rescoped` / `task.updated` / `task.gate.result`；
2. 只扫 active 团队的空闲成员（status=active 且无 currentTaskId），每个角色最多唤醒 1 名，一次扫描最多 2 名；
3. 团队级 400ms、成员级 3s 节流（`dispatchTeamCooldownMs` / `dispatchMemberCooldownMs` 可配，测试置 0）；
4. 若同一事件已产生显式唤醒（assign/message/resume/revoke），跳过扫描；
5. 唤醒文案只给「有 N 个匹配任务」的失效提示，不推任务正文（NFR-7.7 不变）。

**后果**：+ 团队自动运转、上游解锁即时生效；− 空闲成员可能多一次「查到无活可干」的 turn（节流与「每角色 1 名」把浪费压到最小）；NFR-7.1 的零请求纪律调整为「空闲期零轮询，但有新工作可领时允许一次唤醒」。

**关联**：CHG-71、docs/12 §3、FR-30；与 ADR-006 无冲突（dispatch 在 host 执行面；CHG-72 面板任务写入口同样经账本管线，只是 `actor=human`）。

### ADR-013 任务取消与下游策略：终态不可逆，下游显性化而非静默悬空（CHG-73）

**状态**：接受（已实现）

**背景**：此前只有成员提案里的 `cancel`（提案类型），没有执行工具。缺口的真实后果不是「少一个按钮」，而是**依赖图上会出现一个永远等不到 done 的上游**——下游任务既不会变成 ready，也不会报错，只会安静地躺在 backlog 里。

**决策**：
1. **终态**：新增账本事件 `task.cancelled`（payload：`teamId`/`taskId`/`reason` 必填 + `downstream` + 可选 `cascadeFrom`/`batchId`），状态机进 `cancelled`（`done`/`failed`/`cancelled` 三终态之一，之后不可重规划、不可取消、不再参与调度）。
2. **下游策略两档**（不引入第三个「重接线」档，理由见后果）：
   - `leave`（默认）：只取消本任务；下游保持原状，但**诊断必须显性化**——`dep-cancelled` 码 + `depsCancelled` 清单，UI 文案「上游已取消」，含义是「需要重新编排或一起取消」，不是「再等等」；
   - `cancel`：级联取消下游**传递闭包**，每个下游一条独立 `task.cancelled` 事件（带 `cascadeFrom`），可逐条审计/回放；已终态的下游跳过。
3. **两段确认**：第一次不带 `confirm` 返回 `impact {dependents, hasAttempt, downstream}`（下游清单 + 是否有活跃 attempt），人工看过才落账——取消是不可逆的账本事实，必须先看到影响面。
4. **取消前先撤 attempt**：`task.attempt.revoked` → `task.cancelled`，成员手上的任务被释放（`currentTaskId` 清空），不会出现「任务没了但成员还在跑」的孤儿轮。

**后果**：+ 依赖图不再有静默死锁；取消可审计（谁、为什么、影响了谁）；批量取消逐条可追溯。− 「重接线」（把下游改挂到新上游）需要改图 + 改依赖 + 改派单语义三件事，本批不做，留给 P3；`leave` 策略下需要人主动处理下游（诊断已提示，不是隐性）。

**关联**：ADR-002（append-only/部分成功语义）、ADR-006 R2（面板写边界）、ADR-012（`task.cancelled` 也进 dispatch 触发集）、docs/12 §4。

**R2 修订（2026-11-02 CHG-75）：补上第三档「重接线」——把死掉的上游换掉，而不是连坐下游**

背景：ADR-013 的两档各有代价——`leave` 让下游永远等不到 done（只能靠诊断提示人手动处理），`cancel` 把下游一起毙掉。第三档是中间解：**换掉那个死掉的上游**，让下游还能跑。

1. **账本**：新增 `task.rewired`（payload：`teamId`/`taskId`/`removed`/`reason` 必填 + 可选 `added`）。落账顺序 = 先 `task.cancelled`（取消本体）→ 再逐个直接下游一条 `task.rewired`；每条独立事件，可逐条审计/重放。
2. **语义**：`removed` = 被换掉的依赖 id；`added` = 新挂上的上游 id，**缺省 = 解除依赖**（该下游变独立任务）。只改**直接下游**（deps 里直接含被取消任务者），传递下游随链条自动受益，不重复改写。
3. **预检先于不可逆写**（本轮修掉的一个真缺陷）：取消是终态、改挂可回滚——所以**先校验每个直接下游都改得动，再落「取消」这一笔**。否则会留下「上游已死、下游还挂着」的半吊子状态。校验项：新上游必须存在、非 `cancelled`/`failed`、不能是它自己、改挂后不成环（`MT_TASK_CYCLE`）。
4. **状态推进**：解除依赖后若该任务已无待完成依赖，`backlog → ready`（否则它会一直躺在"待规划"列，而 claim 口径认为它可领——看板与调度不一致）。
5. **改挂不改其它**：只动依赖，不动状态机 / attempt / 证据；被改挂的事实留在投影 `rewiredFrom`，详情页可见。

**后果**：+ 下游不必陪葬也不必悬空；+ 取消的第三档语义补齐（leave / cancel / rewire）。− 改挂只处理直接下游（传递链靠它自动传导，不逐条写事件）；− 新上游必须是本团队未取消的任务（跨团队改挂不在本批范围）。

**R3 修订（2026-11-02 CHG-76）：批量档也要能改挂，但「新上游不能是本批要取消的任务」**

1. `myteam_batch_task_op` 的 `downstream` 增 `rewire` + `rewireTo`（整批统一新上游，缺省 = 逐条解除依赖）。
2. **批量级前置校验**：`rewireTo` 若在本批 `taskIds` 里 → 整批拒（`MT_VALIDATION`）——改挂到一个即将被取消的任务等于把死锁换个位置；`rewireTo` 不存在 / 已取消 / 失败同样整批拒。
3. **同批互不改挂**：`cancelTask` 新增内部参数 `rewireSkip`（本批其余任务），避免给"自己也要被取消"的下游写改挂事件——那是纯噪音，且会让审计看到一条立刻失效的 `task.rewired`。

**后果**：+ 批量取消与单条取消口径一致（三档都有）；+ 预览 `impact.rewireByTask` 逐任务列出要被改挂的直接下游，人能判断"这一批会动几条边"。

### ADR-014 批量建任务：草稿不是计划（预览 + 部分失败 + 缺省补齐留痕）（CHG-76）

**状态**：接受（已实现）

**背景**：`myteam_create_task` 一次只建一条，队长/人从目标想出一批任务要串 N 次调用，每次都要把 AC/交付物/依赖想全。**卡在"必须先想好验收标准"上，结果是不批量**——这是真实摩擦，不是理论问题。

**决策**：
1. **草稿 ≠ 计划**：`myteam_create_tasks` 收的是草稿（title/requiredRole 必填，其余可缺），走**同一条 `task.created` 管线**（domain 校验一个都不少）——不是绕过校验的旁路，只是把"一次提交多份"和"缺省补齐"分开处理。
2. **两段确认 + 影响面**：预览给 `{tasks, byRole, rolesMissing, edges, ids, warnings}`——人先看到"这批会建出什么、动哪些边、哪些角色名册里没有"。
3. **不做整体原子性**：逐条独立落账（同一 `batchId`），一条失败不影响其余；事实比"回滚干净"更重要——人要能看见哪几条没建成、为什么。
4. **按拓扑序创建**：`after` 用本批 1-based 序号声明批内依赖，解析成生成后的 taskId 后按依赖顺序建；自指/越界/成环（`MT_TASK_CYCLE`）在预览前就拒，不留悬空依赖；被依赖的条目失败 → 后续条目 `MT_DEPENDENCY_FAILED` 跳过。
5. **缺省补齐必须留痕**：缺 AC → 「完成「标题」」，叶子任务缺交付物 → `docs/<taskId>.md`，都进 `warnings`。**不做静默补**：人可以照 warnings 去详情页补；但没有留痕的补齐就是伪造定义。

**后果**：+ 从目标到可执行计划从 N 次调用降到 1 次；+ 草稿阶段不再被 AC 卡住，同时不牺牲可审计性。− 补齐的 AC/交付物是占位（可读性弱于人写的），依赖 warnings 才能发现；− 批量创建的 `requiredRole` 仍受"必须在名册"约束（与单条 create 一致），所以名册里没有的角色只能先召唤再建。

**关联**：ADR-006 R1（同一账本管线，`actor=human`）、ADR-002（append-only/部分成功）、docs/12 §4/§5。

## 风险关联更新

- R6/R9/R10/R21/R23/R25 的架构影响已吸收进 ADR-001/004/005/008。
- R26（沙箱目录不对等）→ 成员 scratch 区创建策略：成员首次写 scratch 时自己 mkdir -p；插件初始化只在 host 进程内做。
- R8（M1 范围大）→ 任务拆解见 docs/05-任务板.md，按"账本+调度先于面板"排依赖序。
