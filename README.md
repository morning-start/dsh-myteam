# dsh-plugin-myteam

![license](https://img.shields.io/badge/license-MIT-blue)
![tests](https://img.shields.io/badge/tests-492%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-informational)
![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.0%20~%200.3.0-informational)
![tools](https://img.shields.io/badge/tools-44%20(Lead%2035%20%2B%20member%209)-blueviolet)

DSH 宿主内的独立多智能体团队运行时插件：**一个 append-only 账本作为唯一权威，让「队长规划 + 成员执行」的团队协作完全可审计、可重建**。定位是通用 Agent 团队平台（不限于开发场景），内置「标准三人组」预置团队。

> 与 DSH 官方 `@deepseek-ai/dsh-experimental-agent-team` 的关系与差异（12 维对照 + 10 条借鉴项）见 [docs/15-官方AgentTeam对照与借鉴.md](docs/15-官方AgentTeam对照与借鉴.md)。

## 目录结构

| 位置 | 内容 |
|---|---|
| `dsh-myteam-requirements.md` | **PRD（正本）**，v3.0；需求/场景/验收/风险的权威来源 |
| `docs/` | 项目文档：00 需求池 · 01 调研与竞品 · 02 技术可行性（T0 探针实测）· 03 架构与 ADR · 04 API 与数据契约 · 05 任务板 · 06 风险与依赖 · 07 验收标准 · 08 验收报告 · 09 变更记录（CHG-01~94）· 10 实现说明 · 11 数据模型与存储设计 · 12 用户场景与功能设计 · **15 官方 Agent Teams 插件对照与借鉴（CHG-89）** · **16 插件团队贡献契约（CHG-91）** · 调研清单 |
| `skills/` | **对外 skill 包**：`myteam-plugin-team/`（契约 + 模板 + 可执行校验器，给"要带团队"的第三方插件作者用，见 [skills/myteam-plugin-team/README.md](skills/myteam-plugin-team/README.md)） |
| `plugin/` | **插件实现**（可装载单元）：`src/` 源码 → `lib/` 构建产物（改 src 后必须 `npm run bundle`，见 R38）· `client/` 面板客户端 · `test/` 单测 · `cordis.patch.yml` 装载声明 · `locale/` 文案 · `scripts/build-lib.mjs` |
| `design/` | 面板 UI 设计稿：**27 屏** HTML 终稿 + tokens/app.css/icons.svg + dag.js（依赖图渲染器）+ design-notes.md（CHG-64~68 已重构：作用域分层 / 任务团队解耦 / 依赖图双布局；设计参照，实现不引用） |
| `tools/` | 实弹与探针工具：CLI boot 脚本、网关 RPC 驱动、asar 解包器、探测脚本、提交性能冒烟（`smoke-commit-perf.mjs`）、面板 UI 调试夹具（`cdp-debug.mjs` + `seed-demo-team.mjs`），以及实弹运行时锁定清单 `tools/runtime/package.json` |
| `refs/` | **本地参考资产（不入库）**：`competitors/` 5 个社区竞品源码 · `host-src/` 宿主源码快照 · `probes/` 测试证据（详见 [refs/README.md](refs/README.md)） |

运行时数据（账本/成员记忆/token 侧车）由插件在 `.team-workplace/` 下生成，随队长会话首开初始化，**不入库**（根 `.gitignore` 已覆盖）。

## 仓库规范

- **正本唯一**：PRD 在根、文档在 `docs/`、实现只在 `plugin/`；`lib/` 是构建产物但随包分发（`main` 指向它），改 `src` 必须 `npm run bundle`。
- **参考资产不入库**：`refs/` 全部为本地调研材料（约 320M），不随仓库分发；删掉不影响构建与测试。
- **不提交密钥与运行态**：boot 过程产生的 token/cookie 每次重新生成，不得入库；`.team-workplace/` 整目录忽略。

## 快速操作

```bash
# 构建插件 lib（改 src 后必须执行，否则装载跑旧产物）
cd plugin && npm run bundle

# 跑全量单测
cd plugin && npm test

# CLI 实弹 boot（网关 RPC 直驱测试，K 系列验证用）
tools\boot-myteam.cmd
```

## 当前状态（2026-11-06）

- **真实非空插件贡献 + 无障碍修复（CHG-96，2026-11-07）**：把「插件贡献」从单测分支验到**真实非空插件 + 真实 GUI** —— ①造真实插件（1 角色 + 1 团队模板）后宿主日志首次出现 `plugin contributions: 1 plugin(s), 1 role(s), 1 team(s)`，面板把插件名/版本/角色/只读锁/团队模板/贡献目录**全部真实渲染**（`overflowX=0`、异常 0）；②修掉「区块只在项目作用域可见」——贡献来自全局目录、面板默认停全局，原实现让入口**完全不可达**；③修掉两处 3.70:1 未达 AA 的对比度（→ **4.93:1**）；④如实记录一次 `client.js` 编码损坏与 CDP 取证还原（**835,413 B 逐字节相等**）。
- **样式表重复规则清理（CHG-97，2026-11-07）**：清掉 11 个「同一顶层选择器定义多次」（28 份冗余，CHG-82 把 `app.css` 工具类分给 4 组各抄一份留下的债）。**两次修错都写进变更记录**——第一次脚本把选择器起点记成 `{` 的位置，一口气删了 1184 行（git 还原）；第二次以为「同选择器只有最后一条生效」，实测删完页头 margin 从 0 变 16.6px（**CSS 层叠是按属性生效的，后一条没写的属性不会重置**）。正确修法 = 按属性合并、后者优先，与层叠逐属性等价；顺带恢复 `.mt-tstat b` 被静默吞掉的 `color`（统计数字与标签才有层级）。新增 `t62-10` 反向锁死。
- 机制层：**单测 492 条全绿**（63 个测试文件，`node --test test/*.test.ts test/*.test.js` → 492 pass / 0 fail），有条件通过——升「通过」剩余门 = 真实安装 + GUI 目检 + 动态冒烟（KI-2 已实弹收口）
- **真实安装验证 + 3 项 P2 收口（CHG-93/94，2026-11-06）**：第一次把插件**装进真实宿主**跑，抓到 2 个单测永远发现不了的 P0 —— ①**preset 作用域服务是异步就绪的**：`initialize()` 同步执行时 `skills` / `systemPrompt` 还没注册完，于是 **5 个队长技能 + 团队章程全部静默不注入**（单测里的 `rt` 是同步桩，永远拿得到）；修法 `deferCaptainServices()` 用 cordis `ctx.inject([...], cb)` 延迟注入。②**团队章程注入队长 system prompt**（FR-18 职责③ F8）：`core/host/team-charter.ts` 用 `systemPrompt.variable` + 插值 section 做到「改章程下次请求生效」，去 BOM / 框成只读参考 / 64 KiB 上限。另收口三项 §7.4 遗留：`drained.pending` 硬编码 0（释放宣称「排空完成」必须是真的）、`executedBy`/`forcedBy` 上屏（账本里有、界面没画 = 可审计但看不见）、`getWorkspaceState()` 幽灵端点**删行不补**（单一消费者，`describe()` 已是稳定面）。**M2-D ① handoff 摘要升级为索引**：`session:<id>` 指针列表按需深读，不整段注入旧会话（FR-16.3 第二条理由）。**M2-F** create-role 补「记忆与汇报机制」。真实安装实测：深色对比度 **8.15:1**、溢出 **0**、异常 **0**。测试 466 → **490**。
- **插件团队贡献契约 v1 实装（CHG-92，2026-11-06）**：CHG-91 只交付「契约 + skill + 校验器」，CHG-92 把 myteam 侧装载实现补齐 —— **装插件即得团队**真的能跑通。新增 `core/contributions/{contract,discover,parse}.ts`（3 模块，`parse` 是**纯函数**：只 `readFileSync`/`JSON.parse`，不写盘、不碰账本、不 `import()` 插件代码）；`RoleOrigin` 扩为五档 `builtin(0) < plugin(1) < global(2) < project-role(3) < project(4)`（**用户的全局/项目库永远压得过插件**）；`PresetOrigin` 扩 `plugin`（插件模板跨项目可见）；插件来源**只读**（`MT_ROLE_READONLY`，想改走「复制到项目」）；面板根级端点 `getContributions`/`reloadContributions` + 队长工具 `myteam_list_contributions`/`myteam_reload_contributions`（Lead 33 → **35**）；面板角色库新增「插件贡献」区块（插件列表 + 只读徽标 + 模板名册 + **error 红条** + 重新扫描）。**顺带修掉一个 CHG-58 遗留的真 bug**：`TOOL_ALLOW_PATTERNS` 只认小写，`toolPolicy.allow: ["Read"]` 被判非法，而宿主原生工具名就是 PascalCase —— 等于「合法名字写不进去」。测试 445 → **466**（t77 装载 19 + t76 契约 24 + t75 渲染 2）。
- **插件团队贡献契约 v1（CHG-91，2026-11-06）**：让第三方插件把「一套配好的团队」（角色 + 名册 + 门禁链 + 看板列 + 章程）贡献进 myteam 的**全局**团队库——**装插件即得团队**。**契约先行**（用户明确要求）：新增 [docs/16-插件团队贡献契约.md](docs/16-插件团队贡献契约.md) 定四件事——**① 贡献点目录** `$DSH_HOME/myteam/plugins/<pluginId>/{plugin.json,roles/*.json,teams/*.json}`（插件写**数据**不写代码）；**② 优先级与冲突**：来源扩为 5 档 `builtin(0) < plugin(1) < global(2) < project-role(3) < project(4)`（**用户的全局/项目库永远压得过插件**），撞内置 = **硬失败**而非静默 shadow；**③ 生命周期**：启动扫描 + 显式重载，卸载 = 目录消失 = 贡献消失，已召唤成员用召唤时快照不追溯（CHG-6），**失败隔离但必须大声**（warnings + 面板红条）；**④ 安全边界**：不能贡献队长 / 不能覆盖内置 / `toolPolicy.allow` 只收窄 / **只 `JSON.parse` 永不 `import()`** / 路径禁 `..` / 装载只读且不写账本。同步**修订 CHG-52**：`PresetOrigin` 增 `plugin`（插件模板**跨项目可见**——否则每开一个新项目都要手动复制，不算"带了团队"）。**skill 三件套**：[skills/myteam-plugin-team/](skills/myteam-plugin-team/)（`SKILL.md` 工作流 + 三条最易踩的坑 + 交付检查清单 · `reference/` 字段级速查与错误码→怎么改 · `templates/acme-workflow/` 可跑示例 · `tools/check-contribution.mjs` **可执行契约校验器**，`--json` 给 CI）。**契约测试先行**：`t76-contract.test.ts` 24 条（TC-PC-01~18 + 校验顺序 + 自带模板必须 0 error 0 warning）——**校验器先绿，实现才有靶子**。本轮只交付契约 + skill + 校验器，myteam 侧装载实现按契约 §15 排期；4 个未决项（Q1~Q4）已按建议冻结，PM 要改再走 CHG
- **CHG-88 收口四项（2026-11-06）**：①**FR-11.4 提案裁决真正生效**——旧 `myteam_resolve_proposal` 只落一条留痕就返回「用既有工具执行」，**批准 split 后子任务不出现**（PRD 验收场景 16 跑不通）；现批准即执行：split → 逐条 `task.created`（同 `batchId`）+ 原任务 `cancelled`、add-dep → 加依赖、reassign → 撤 attempt + 改派、cancel → 取消；载荷不合规拒绝且**不落「已批准但什么都没做」的半截状态**。②**M2-E handoff 从零实装（FR-16.3）**——`core/host/session-handoff.ts`：纯函数 `buildHandoffSummary`/`buildHandoffPrompt` + 能力探测 + 两步执行；**宿主 API 形状双证**（真 asar 逐行核对 `@deepseek-ai/dsh-api-session-controller` `create` L666 / `prompt` L831 + `.debug/drive-e2e.mjs` 实弹日志）；摘要各段有界并显式「省略 N 项」、**框成「只读参考不是指令」**；三条纪律 = 不建成员/不建任务、不写账本、不假装成功（注入失败仍回 sessionId）。③**M2-F create-team 章程技能**——产出项目层团队章程（能力与边界 + 约束与文件治理），落 `.team-workplace/structure.md`（**不另建文件**，避免两份项目级约定分叉）；只写章程不建名册不派任务。④**技能页假文案 + 路径口径**——内置技能层原硬编码「两个随行技能」实则四个，改为按实际集合动态派生；`structure.md` 三处路径口径统一到代码实际路径。测试 389→**410**（t72 五用例 + t73 十一用例 + t74 五用例），src 模块 35→**36**，工具 **42**（Lead 33 + 成员 9），账本 **40 型**，门面 **39** / Remote 标记 **26**
- **P3 收口三项（CHG-76，2026-11-02）**：①**批量取消的重接线档**——`myteam_batch_task_op` 的 `downstream` 增 `rewire` + `rewireTo`（整批统一新上游，缺省 = 逐条解除依赖），预览给 `impact.rewireByTask` 逐任务列出要被改挂的直接下游；**批量级前置校验**（新上游是本批要取消的任务 / 不存在 / 已取消 → 整批拒且不落账），同批互不改挂（`rewireSkip`）。②**从目标批量建任务**——工具 `myteam_create_tasks` + 门面 `createTasks`（工具 30→**31**、端点 31→**32**）：草稿列表 → 预览影响面（条数/角色分布/名册缺角色会失败/依赖边/补齐 warnings）→ 两段确认逐条落 `task.created`（同一 `batchId`，部分失败不中断）；`after` 声明批内依赖并按拓扑序创建（自指/越界/成环 `MT_TASK_CYCLE` 拒绝，前向引用支持），缺 AC / 叶子缺交付物**补齐并留痕**，依赖失败条目 `MT_DEPENDENCY_FAILED` 跳过。③**无人可领一键修复**——诊断新增 `fix{assignable, roleSwap, spawnRole}`（同角色空闲 → 指派；名册有别的空闲角色 → 换 `requiredRole`；都没有 → 召唤提示，措辞按 no-role / role-busy 分开），动作复用既有 `assignTask`/`updateTask` 管线。面板：批量条三档下游策略 + 新上游下拉、「批量新建」草稿抽屉、详情「一键修复」，离线一律 disabled。**CDP 在线团队真实写路径实测**：多选 bw1+bw3 → 第三档 → 选 `bw5` → 影响面「2 个任务；下游 3 个，将改挂到新上游」→ 确认 → notice「批量操作完成：成功 2 / 失败 0 · 已改挂 3 个任务」、bw2/fx-assign/bw4 卡片变「依赖 bw5」带「已改挂」chip、账本 `task.cancelled`→`task.rewired` 顺序正确（actor=human）；「批量新建」预览「将创建 3 个任务 · 角色分布 · 依赖边 draft-1→draft-2→draft-3 · 警告」→ 创建 notice「已创建 3 个任务（失败 0）」且依赖解析成真实 taskId；三个修复态（no-role 换角色+召唤提示 / role-busy 增援措辞 / deps-pending 一键指派 → notice「已指派 reviewer」）；溢出 0、控制台无插件侧报错、无裸 key。测试 260→**290 绿**（t52 十用例 + t53 十字例），账本仍 **39 型**（无新事件，批次用 `batchId` 串）。口径见 docs/03 ADR-013 R3 + ADR-014、docs/12 §5
- **取消后重接线（CHG-75，2026-11-02）**：取消任务的**第三档下游策略** `downstream:'rewire'`——把**直接下游**的依赖改挂到新上游（不指定 = 解除依赖让下游变独立任务），账本新增 `task.rewired`（38→**39 型**）；只改直接下游，传递下游随链条自动受益；**预检先于不可逆写**（新上游不存在/自身/已取消/成环 `MT_TASK_CYCLE` 一律在「取消」落账前就拒，不留"上游已死、下游还挂着"的半吊子状态）；解除依赖后下游无待完成依赖则 `backlog → ready`。面板 `CancelDialog` 第三档 + 上游下拉（候选排除 `cancelled`/`failed`，`done` 可选并标「（已完成）」）+ 影响面分三档文案 + 「已改挂 N 个任务」提示。CDP **在线团队真实写路径**实测：第三档 → 选 w3 → 影响面「下游 1 个任务，将改挂到新上游」→ 确认 → notice「已改挂 1 个任务」、卡片变「依赖 w3」带「已改挂」chip，账本 `task.cancelled`→`task.rewired` 顺序正确（actor=human）。口径见 docs/03 ADR-013 R2、docs/12 §5
- **同名角色副本口径（CHG-74，2026-11-02）**：修掉两个真缺陷——**详情取错来源**（`getRoleDetail` 用 `find(id)` 命中第一份 → 「项目里改的那份，详情却显示内置定义」，编辑入口走错分支）与**列表 id 重复**（视图里同 id 两份 + 客户端 `role.id` 作 React key → 同名卡互相吞）。新口径（ADR-006 R3）：**目录不隐藏任何一份**（只标 `shadowedBy` 谁让位）、**生效优先级 `project > project-role > global > builtin`**（运行时真相恒为项目库）、**详情按生效条目返回**（附 `shadowed`/`editable`）；客户端 key 改 `origin:id` + 「同名项目副本（以此为准）」徽标。CDP 实测：项目角色页同名两份**都在**、详情命中项目库那份（按钮=「编辑」）。口径见 docs/03 ADR-006 R3、docs/11 §4.3
- **执行期编辑闭环（CHG-73，2026-11-01）**：P2 八项落地——①一键重规划 `myteam_rescope_task`/门面 `rescopeTask`（撤 attempt → ready/backlog → 可选结构补丁 → 可选重派，理由必填；撤 attempt 也能离开门禁态）；②字段级 diff 落账（`task.updated`/`task.rescoped` 载荷 `changes`，详情「改动记录」）；③证据过期标记（投影 `evidenceStale{since,fields}`：结构编辑晚于证据 → 看板徽标 + 详情横幅，新证据清除）；④任务取消 `task.cancelled`（两段确认给影响面、理由必填、下游 `leave`/`cancel` 两档，诊断新增 `dep-cancelled`「上游已取消」）；⑤`create_task` 一次写入 `assignees`/`participants`；⑥角色表单技能/MCP 目录多选（门面 `getCapabilityCatalog`，目录是提示不是白名单）；⑦角色删除 `deleteRole`（C7 占用面 + 两段确认 + `.audit.jsonl` action=deleted）；⑧批量编排 `myteam_batch_task_op`（cancel/rescope/assign/priority，逐条落账同一 `batchId`，部分失败回显）。工具 26→**30**、账本 37→**38 型**、门面 26→**31 端点**；CDP 实测：看板出现「证据过期」「已取消」「上游已取消」chip、详情证据过期横幅 + 改动记录 + 动作条（离线全禁用并给 title）、角色删除两段确认（usage 在册/实例/模板）后落盘、批量条「已选 2」+「同时取消下游」、无横向溢出。口径见 docs/03 ADR-006 R2 + ADR-013、docs/12 §5
- **面板闭环（CHG-72，2026-11-01）**：P1 四项落地——①团队页「新建团队」引导（生成首条指令 → `uiWorkspace.startSession` 打开团队模式会话并预填，不新增建队写路径）；②角色表单（`saveRole`：配置资产写文件 + `assertValidRole` 同源校验 + 同名两段确认 + `.audit.jsonl` 审计）；③任务新建/编辑（`createTask`/`updateTask`/`assignTask`/`participateTask`，走账本管线 `actor=human`；执行中改结构字段提示「只保存元数据」）；④「无人可领」诊断（`team-inactive`/`deps-pending`/`no-role`/`role-busy`，卡片/列表/详情三处）。CDP 实测顺带修复：在线团队看板被返回形态误判丢弃、多会话团队重复、抽屉堆叠、`uiWorkspace` 未 inject 抛错、active 团队补独立任务被孤儿规则误拒。口径见 docs/03 ADR-006 R1、docs/12 §5
- **面板 UI 与运行时（CHG-64~69，2026-11-01）**：25 屏重构 + **运行时已落地**——全局 / 项目作用域分层（项目三标签：角色 / 团队 / 任务；项目自身角色 `config/project-role.json`）、任务与团队解耦（参与关系多对多：`task.participate` / 主责 1 · 协作 N）、多队员负责（`assignees[]`）、依赖图 `core/tasks/graph.ts` + 面板 SVG 箭头（横 / 竖双布局）、角色兴趣词 `interestWords[]`、角色详情聚合、门面 `getProject`/`getRoleDetail`、工具 26 个（含任务/团队编辑）；词汇改版（队员 = 聘任记录，UI 不出现「成员」）、实现细节不出 UI。运行时口径见 docs/04 §2/§3、docs/11 §九、design/design-notes.md
- **面板 UI（CHG-62/63）**：Web 端 + CDP（无头 Chrome `:9222`）按真实渲染修复——看板全高等宽列、卡片优先级/依赖/证据、团队名贯通、成本栏单行、离线设置页生效配置、侧栏入口 SVG 图标；1440/1024/820 三档无页面横向溢出。功能层补全：看板筛选（文本/优先级/成员）、收件箱在线裁决（批准/修订/丢弃 + 两段确认）、审计与时间线中文词表、证据按 attempt 分组 + 退出码、DAG 单击高亮依赖链/双击详情。复现方式见 [tools/cdp-debug.mjs](tools/cdp-debug.mjs)
- **M2 前置门 M2-A0（P1，需用户桌面宿主）**：复测 KI-14（成员 `agents.create` factory 通道在 headless 下 turn 空转）；通过后按 [docs/05-任务板.md](docs/05-任务板.md)「M2 重规划」节顺序开工（A0→B…）
- **M2-A1 技术债三件已提前清偿（CHG-59/60）**：commit 改增量 apply（先算后写，O(1)）/ team.json 决策 B 收口（不落盘，ADR-002 改写）/ `lib/build-manifest.json` + t42 守住 src↔lib 一致
- **M2-A2 方案边界已 ADR 化（CHG-61）**：ADR-010 五问判据（常驻团队 / 临时委派 / 单 agent 能力）
- 结构规范化记录：CHG-41（[docs/09-变更记录.md](docs/09-变更记录.md)）

## 许可证

[MIT](LICENSE) © 2026 morning-start
