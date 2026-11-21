<div align="center">
  <img src="plugin/icon.svg" width="88" height="88" alt="myteam icon">
  <h1>dsh-plugin-myteam</h1>
  <p>DSH 宿主内的独立多智能体团队运行时 —— 一个 append-only 账本作为唯一权威，<br>让「队长规划 + 成员执行」完全可审计、可重建。</p>
</div>

![license](https://img.shields.io/badge/license-MIT-blue)
![tests](https://img.shields.io/badge/tests-950%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-informational)
![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.0%20~%200.3.0-informational)
![tools](https://img.shields.io/badge/tools-68%20%28Lead%2058%20%2B%20member%2010%29-blueviolet)

## v4.0 目标（2026-11-11 重梳理）

这个项目只做两件事，而且**必须分开做**：

| 部分 | 管什么 | 资源 | 落盘 |
|---|---|---|---|
| **① 团队与成员** | 把「角色」聘任成成员，成员再派生更小的子 Agent | **角色**（全局 / 项目两级） | 全局 → `$DSH_HOME/myteam/roles/`；项目 → `<ws>/.dsh-myteam/config/roles/` |
| **② 任务与看板** | 任务作为项目级工作项，用**一张看板**同步整套进度 | **任务**（项目级，唯一作用域） | `<ws>/.dsh-myteam/tasks/<teamId>/ledger.jsonl` |

两条铁律：**角色可复用**（全局 → 项目单向复制，运行时只认项目库）、**任务项目级**（不存在全局任务，团队通过「参与」接手，看板在最外层聚合全部任务）。

目标树：**支柱一 FR-32 角色即资源 → 子 Agent 编队**（成员在角色 `delegation` 授权下派生，深度默认 1 / 硬上限 2，子成员能力 ⊆ 父成员）；**支柱二 FR-33 任务即资源 → 项目共享看板**（项目有活跃团队时默认落地 = 任务看板，三种分组 + 五个汇总）。完整目标体系、冲突裁决（撤销「不引入成员管理成员的递归权限」、修订 `memberMaxDepth=0` 与 ADR-010 反模式 #4）、验收场景 37~46、M3 任务分解（≈9d）见 [docs/23-项目目标重梳理.md](docs/23-项目目标重梳理.md)。

## 为什么还要一个团队运行时

DSH 内核已经内置了 `agentTeams` 服务与 `spawn_teammate` / `team_task_*` 一套工具。myteam **不包装它、不调用它、不 import 它** —— 它补齐的是内置能力不负责的三件事：

| 内置 agentTeams | myteam |
|---|---|
| 协作过程散在 session 与内存里 | **append-only JSONL 账本**是唯一权威：可 grep、可 diff、可人工救场，UI 与工具全部从账本派生 |
| 任务只有创建 / 更新 | 任务有**显式状态机 + 依赖 DAG + 门禁链 + attempt 防陈旧写**，卡住时能说清卡在哪 |
| 成员配置写死在会话里 | **角色库 + 团队预设**两层，角色与团队解耦，一套配置可跨项目复用 |

在此之上再加三样内置没有的：**团队知识库**（带证据指针与归因）、**token 计量侧车**（四桶口径，永不进模型上下文）、**插件团队贡献契约**（第三方插件装进来就自带一套配好的团队）。

它与官方 `@deepseek-ai/dsh-experimental-agent-team` 的 12 维逐条对照见 [docs/15-官方AgentTeam对照与借鉴.md](docs/15-官方AgentTeam对照与借鉴.md)；**当前版本 vs 全部 6 个参考来源**的 15 维功能矩阵见 [docs/21-参考项目功能对照.md](docs/21-参考项目功能对照.md)。

## 核心概念

| 概念 | 定义 |
|---|---|
| **Team** | 一次协作的容器，状态 `draft → active → archived → discarded` |
| **Role（角色）** | **可复用资源**：独立配置单元（职责描述、提示词、工具策略（只收窄）、技能引用、模型路由、兴趣词、`delegation` 委派白名单），全局 / 项目两级 |
| **Captain（队长）** | 由 team 专用预设创建的专职会话，只做任务安排 / 结构整理 / 过程检查，不做领域工作 |
| **Preset（团队预设）** | 团队模板：名册（队长 + N 个角色引用）+ 看板列 + 泳道 + 门禁链 |
| **Member（队员）** | 从预设实例化出的独立根级 Agent，配置快照不可变、有私有记忆与独立 token 账；**不是资源**，是「角色 × 团队」的聘任记录 |
| **Sub-member（子 Agent，v4.0）** | 成员在角色 `delegation` 授权范围内再聘任一次角色（**同一团队内**父子树；深度硬上限 2） |
| **Task / Attempt** | 账本里的工作项（**项目级资源**，不存在全局任务）/ 一次 claim 的凭据（`attemptId` 防陈旧写入） |
| **Gate（门禁）** | 完成链上的检查点：`review`（交叉审查）/ `verify`（host 跑命令取 exit code）/ `archive`（产物落位校验） |
| **Ledger（账本）** | append-only JSONL，唯一权威；`team.json` / `tokens.json` 都只是可重建的派生缓存 |
| **Knowledge** | 全员共享的项目知识，条目必带证据指针；无证据标 `unverified` |
| **Human Inbox** | 队长 → 人类的消息队列，badge 只报未读总数 |

## 快速开始

```bash
# 构建插件产物（改 src 后必须执行，否则装载的是旧 lib）
cd plugin && npm run bundle

# 全量单测（node --test，纯离线）
cd plugin && npm test

# 一键门禁（CI 与本地同一个入口：架构 / 指纹 / 文档 / 客户端 / 死代码，共 7 项）
node tools/check-all.mjs

# 只校验 src 与 lib 是否漂移（MISMATCH 为 0 才退 0）
node tools/check-drift.mjs

# CLI 实弹 boot（网关 RPC 直驱，K 系列验证用）
tools\boot-myteam.cmd
```

**环境要求**：Node ≥ 22.18（`stripTypeScriptTypes` + `node --test` 跑 `.ts` 用例），DSH `0.2.1-rc.0 ~ 0.3.0`。插件本身**零运行时依赖**。**CI**：`.github/workflows/ci.yml`（bundle → 测试 → `check-all`，push/PR 到 main 自动跑）——门禁与本地同一个入口，不写两套命令。

**装载**：插件以「preset EntryGroup 组合」形态挂进 profile —— `plugin/cordis.patch.yml` 声明三行：`myteam-carrier`（客户端载体）、`myteam-panel`（根级面板 Remote）、`myteam-preset-captain`（团队模式预设，内含 host + persona 子行）。profile 侧把 `dsh-plugin-myteam` 指向 `plugin/` 并登记进 `dsh.profile.bundles` 即可。装载链的实测记录见 [docs/02-技术可行性.md](docs/02-技术可行性.md)。

**动手改 UI 之前**：先看 [design/](design/README.md) 的 27 屏终稿，再对照 [docs/13-UI对齐分工.md](docs/13-UI对齐分工.md) 与 [docs/14-UI复检清单.md](docs/14-UI复检清单.md)。

## 项目级存储（`.dsh-myteam/`）

**所有项目级内容都落在项目目录下的 `.dsh-myteam/`**，不写用户全局 profile。目录契约见
[docs/17-项目级存储架构.md](docs/17-项目级存储架构.md)（唯一权威）：

```
<project>/.dsh-myteam/
├── .gitignore          # 上传纪律：config/ 与 tasks/ 入库；state/、history/、export/ 不入库
├── manifest.json       # 项目清单（schema 版本 / 项目名 / 默认团队）
├── structure.md        # 团队章程
├── config/             # ① 角色 / 团队 / 技能 / 工具 / 流程 / 知识（入库）
├── tasks/<teamId>/     # ② 任务及依赖（ledger.jsonl 唯一权威，入库）
├── history/            # ③ 归档 / token 计量 / 成员记忆（不入库）
├── state/              # 索引 / scratch / 日志（可重建，不入库）
└── export/             # 导出快照（不入库）
```

项目根由 `core/workspace/layout.ts` 的 `resolveProjectRoot()` 解析：**会话工作目录 > 行 config
显式 > 宿主 workspace（须过 `rejectProjectRoot`）> 进程 cwd**；落在 `$DSH_HOME` 内的路径一律拒绝
（DSH profile 永远不是项目）。

## 仓库结构

| 位置 | 内容 |
|---|---|
| [`dsh-myteam-requirements.md`](dsh-myteam-requirements.md) | **PRD 正本**（v4.0）：需求 / 场景 / 验收 / 风险的权威来源 |
| [`docs/`](docs/README.md) | 项目文档：需求池、调研、技术可行性、架构与 ADR、API 契约、任务板、风险、验收、变更记录（CHG-01~199）、数据模型、用户场景、官方对照、贡献契约、**17 项目级存储架构（现行口径）**、18 配置 Schema、19 资源模型、20 存储结构、**21 参考项目功能对照（当前版本）**、**22 架构梳理（实测结构快照）**、**23 项目目标重梳理（v4.0 目标体系）** |
| [`plugin/`](plugin/README.md) | **插件实现**（可装载单元）：`src/` 源码 → `lib/` 构建产物 · `client/` 面板客户端 · `test/` 单测 · `cordis.patch.yml` · `locale/` |
| [`design/`](design/README.md) | 面板 UI 设计稿：27 屏 HTML 终稿 + tokens / app.css / icons.svg / dag.js |
| [`skills/`](skills/README.md) | 对外 skill 包：[`myteam-plugin-team/`](skills/myteam-plugin-team/README.md)（契约 + 模板 + 可执行校验器） |
| [`tools/`](tools/README.md) | 实弹与探针工具：CLI boot、网关 RPC、CDP 调试、演示数据、漂移检查、性能冒烟 |
| `refs/` | 本地参考资产（**不入库**，在 `.gitignore` 里）：竞品源码、宿主源码快照、测试证据。克隆后没有这个目录是正常的 |

全部项目级内容（角色 / 团队 / 任务账本 / 成员记忆 / token 侧车）由插件在项目目录下的 `.dsh-myteam/` 生成，随队长会话首开初始化。上传纪律住在存储目录**自己的** `.gitignore` 里（CHG-102 起不再往项目根写规则；旧目录 `.team-workplace/` 走一次性迁移）。

## 仓库规范

- **正本唯一**：PRD 在根、文档在 `docs/`、实现只在 `plugin/`。`lib/` 是构建产物但随包分发（`main` 指向它），改 `src` 必须 `npm run bundle`。
- **参考资产不入库**：`refs/` 全是本地调研材料，删掉不影响构建与测试。
- **不提交密钥与运行态**：boot 过程产生的 token / cookie 每次重新生成；`.dsh-myteam/` 的 `state/`、`history/`、`export/` 不入库。
- **改文档先改代码**：`docs/04` 的 `MT_*` 错误码表由 [`tools/gen-error-docs.mjs`](tools/gen-error-docs.mjs) 从 `plugin/src/core/errors.ts` 生成，**手改会被覆盖并被 `t81` 判红**。

## 当前状态

**机制层已收口**：单测 **984 条全绿**（**137 个测试文件 / 74 个 src 模块 / 237 条依赖边**），`check-drift` 报 `MISMATCH: 0`、`check-architecture` 报 `ARCH_VIOLATIONS: 0`，69 个工具（队长 59 + 成员 10；**档位元数据 + 运行时门禁**：A 23 / C 36 / CM 4 / H 6——CHG-202y 把 spawn/release 从 C 挪到 CM）、**Remote 41 个端点 / 门面 60 个方法**（含「团队资产」UI：技能清单 / 导出 / 复制 / 发布；CHG-203 补离线计划反馈、CHG-204 退役 3 个无调用者 RPC）、40 型账本事件、27 屏面板设计稿。全局/项目**不拆两个宿主表面**（CHG-114 裁决）：侧栏入口 = 全局库、团队视图 = 本团队看板；团队视图的看板/流程/依赖图与面板**同源换挂载点**（CHG-115）。配置字段的唯一定稿是 [docs/18](docs/18-配置Schema定稿.md)（CHG-116），写路径已闭环（CHG-117 端点 + CHG-118 设置页表单 / JSON 源视图 / 两段确认）；计划质量反馈只读观测（CHG-119），会话考古按 `session:<id>` 只读读历史（CHG-120）；资源模型与能力矩阵见 [docs/19](docs/19-资源模型与能力矩阵.md)（CHG-121）。**写盘一致性**：全仓唯一写盘出口 `core/fs/atomic-write.ts`（八步写序 + 拒符号链接 + 唯一临时名 + 权限继承）+ 记账本/收尾闸门 `core/fs/write-log.ts`，由 `tools/check-architecture.mjs` 的 A1–A5 五条规则守门（CHG-174~176）。**客户端**：13,819 行单文件已拆成 `client/src/` 的 **46 个片段 + 构建产物**，依赖方向由 `tools/check-client-arch.mjs` 棘轮守（CHG-202j~n）。**当前版本 vs 全部参考项目**（6 个来源 / 15 维矩阵 / P0~P2 差距 14 条，**P0 3/3 · P1 6/6 · P2 5/5 全补完**）见 [docs/21](docs/21-参考项目功能对照.md)（CHG-149；P0~P2 补全见 CHG-142~157；P2-4 单文件客户端拆分由 CHG-202j~n 关闭）。**交互流程打通审计**（[docs/25](docs/25-交互流程打通审计.md)，CHG-202x）：静态对账 + 三路并行深挖出的 **7 条 P0 断点 + 14 条 P1** 已全部收口（任务删除、全局页角色详情/死控件、归档回放下钻、知识提案串台、名册 cascade、建团向导名册、verify 门死锁、token 侧车入库路径…），并修好「死词条」分析器的 36 条假阳性——**死词条 0 / 死导出 0 / 死模块 0**。**真实会话可用性修复**（CHG-205~208）：读面 lossless JSON、`edit_task` 字段 diff 漏报、成员 agent 缺模型选择（`has no provider/model` 空壳）、冷启动恢复未接线 + `blocked` 零写入（新增 `task.blocked` 与重试上限），并补上驱动链集成测试（`t159` 证明成员真的会 claim）。

> ~~旧口径（CHG-149 时点）：单测 786 条全绿（110 个测试文件 / 55 个 src 模块）、40 个面板端点、P0 3 条已补完 / P1 已补 2 条~~ → ~~CHG-157 时点：800 条 / 113 文件~~ → ~~CHG-167 时点：859 条~~ → ~~CHG-173 时点：867 条 / 121 文件 / 54 模块~~ → **现口径**：**984 条 / 137 文件 / 74 模块、工具 69（队长 59 + 成员 10；A 23 / C 36 / CM 4 / H 6）**（CHG-200 补齐队长读面与成员检查面；CHG-201 全局 / 项目作用域物理分离——侧边栏页只有全局资产、画布「团队视图」tab 是项目视图，跨工作区 `workspaces.json` 退役；CHG-202 系列清完全部死代码并拆掉单文件客户端；CHG-203 补离线计划反馈）、Remote 41 / 门面 60、**P0 3/3 · P1 6/6 · P2 5/5**（CHG-150~157 补齐 P1 剩余与 P2 四项；CHG-158~165 打通「未打通清单」的 A 类断链与 D 类文档漂移；CHG-166 收口 B 类可自动验证面——动态冒烟自动化 + 本仓库狗粮成团 + handoff 真实可见性实测；CHG-168~173 修完上份「未打通报告」剩余四项：内置工具隐藏实际生效清单 / 共享写范围串行链 / 单角色调用面板入口 / taskPlanning=template；CHG-174~176 移植 `dsh-task-ledger` 的写盘一致性三件套；**CHG-202j~n 关闭最后一项 P2-4**：客户端拆成 46 个片段 + 零死代码）。

**已经过真实宿主安装验证**（CHG-93/94）：两次安装各抓到单测永远发现不了的 P0（preset 作用域服务异步就绪导致队长技能静默不注入；团队章程未注入队长 system prompt），均已修复并留下断言。深色对比度 8.15:1、横向溢出 0、控制台无插件侧报错。

**剩余门**：GUI 目检与动态冒烟需要人类在桌面宿主上配合（**安装层已于 CHG-93/94 真实宿主验证**）。~~M2 的 UI 七阶段与 M2-7（最终配置 schema）仍排期中~~ → **M2 七项已全部关闭**：UI 七阶段逐屏收口（CHG-82/84/85/87/114/115，27 屏中 26 屏对齐 + 1 屏撤屏），M2-7 由 CHG-116 定稿配置 schema、CHG-88/93/94 实装两个随行 skill（详见 [docs/05](docs/05-任务板.md) M2 复核块）。完整逐条进度见 [docs/09-变更记录.md](docs/09-变更记录.md)，里程碑拆解见 [docs/05-任务板.md](docs/05-任务板.md)。

**v4.0（CHG-178，2026-11-11）**：目标重梳理为「角色 / 任务两类资源 + 团队聘任容器」——**M3 待开工 ≈9d**（支柱一 FR-32 子 Agent 编队 5 项 / 支柱二 FR-33 项目共享看板 3 项；工具 68、Remote 40→42、门面 58→60、账本 40 型不变、设计稿 27→28 屏）。目标正本与 M3 任务板见 [docs/23](docs/23-项目目标重梳理.md) 与 [docs/05](docs/05-任务板.md) M3 节。

## 明确不做

- 不做 npm 市场发布纪律（只保留 `engines.dsh` 一行防错装）。
- 不做多 Workspace 多活跃团队（每 Workspace 至多 1 个活跃团队，归档不限）。
- 不做跨进程并发协调（诚实沿用单进程串行）。
- 不代用户连接 MCP、不代管凭据 —— 只做声明、可见性过滤与「未验证」标记。
- 队长不是大家长：不承担具体领域功能，职责限定为任务安排/结构整理/过程检查与调度（FR-10.1）；~~不引入「成员管理成员」的递归权限~~ → **v4.0 修订**：改为「不引入**无授权**的成员派生」——队长 + 角色 `delegation.canSpawn` 显式授权可派生子成员（FR-32）。
- **不做全局任务**（v4.0）：任务只属于项目，跨项目汇总属宿主层；**不做成员树无限深度**（硬上限 2 层）；**不做子团队**（team 树，子 Agent 仍在同一团队同一账本）；**不做任务父子层级**（任务保持扁平 DAG，层级只在成员树）。

---

[MIT](LICENSE) © 2026 morning-start
