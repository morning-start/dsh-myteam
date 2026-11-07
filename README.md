<div align="center">
  <img src="plugin/icon.svg" width="88" height="88" alt="myteam icon">
  <h1>dsh-plugin-myteam</h1>
  <p>DSH 宿主内的独立多智能体团队运行时 —— 一个 append-only 账本作为唯一权威，<br>让「队长规划 + 成员执行」完全可审计、可重建。</p>
</div>

![license](https://img.shields.io/badge/license-MIT-blue)
![tests](https://img.shields.io/badge/tests-526%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-informational)
![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.0%20~%200.3.0-informational)
![tools](https://img.shields.io/badge/tools-44%20%28Lead%2035%20%2B%20member%209%29-blueviolet)

## 为什么还要一个团队运行时

DSH 内核已经内置了 `agentTeams` 服务与 `spawn_teammate` / `team_task_*` 一套工具。myteam **不包装它、不调用它、不 import 它** —— 它补齐的是内置能力不负责的三件事：

| 内置 agentTeams | myteam |
|---|---|
| 协作过程散在 session 与内存里 | **append-only JSONL 账本**是唯一权威：可 grep、可 diff、可人工救场，UI 与工具全部从账本派生 |
| 任务只有创建 / 更新 | 任务有**显式状态机 + 依赖 DAG + 门禁链 + attempt 防陈旧写**，卡住时能说清卡在哪 |
| 成员配置写死在会话里 | **角色库 + 团队预设**两层，角色与团队解耦，一套配置可跨项目复用 |

在此之上再加三样内置没有的：**团队知识库**（带证据指针与归因）、**token 计量侧车**（四桶口径，永不进模型上下文）、**插件团队贡献契约**（第三方插件装进来就自带一套配好的团队）。

它与官方 `@deepseek-ai/dsh-experimental-agent-team` 的 12 维逐条对照见 [docs/15-官方AgentTeam对照与借鉴.md](docs/15-官方AgentTeam对照与借鉴.md)。

## 核心概念

| 概念 | 定义 |
|---|---|
| **Team** | 一次协作的容器，状态 `draft → active → archived → discarded` |
| **Role（角色）** | 独立配置单元：职责描述、提示词、工具策略（只收窄）、技能引用、模型路由、兴趣词 |
| **Captain（队长）** | 由 team 专用预设创建的专职会话，只做任务安排 / 结构整理 / 过程检查，不做领域工作 |
| **Preset（团队预设）** | 团队模板：名册（队长 + N 个角色引用）+ 看板列 + 泳道 + 门禁链 |
| **Member（队员）** | 从预设实例化出的独立根级 Agent，配置快照不可变、有私有记忆与独立 token 账 |
| **Task / Attempt** | 账本里的工作项 / 一次 claim 的凭据（`attemptId` 防陈旧写入） |
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

# 校验 src 与 lib 是否漂移（CI 可当门禁，MISMATCH 为 0 才退 0）
node tools/check-drift.mjs

# CLI 实弹 boot（网关 RPC 直驱，K 系列验证用）
tools\boot-myteam.cmd
```

**环境要求**：Node ≥ 22.18（`stripTypeScriptTypes` + `node --test` 跑 `.ts` 用例），DSH `0.2.1-rc.0 ~ 0.3.0`。插件本身**零运行时依赖**。

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
| [`dsh-myteam-requirements.md`](dsh-myteam-requirements.md) | **PRD 正本**（v3.0）：需求 / 场景 / 验收 / 风险的权威来源 |
| [`docs/`](docs/README.md) | 项目文档：需求池、调研、技术可行性、架构与 ADR、API 契约、任务板、风险、验收、变更记录（CHG-01~102）、数据模型、用户场景、官方对照、贡献契约、**17 项目级存储架构（现行口径）** |
| [`plugin/`](plugin/README.md) | **插件实现**（可装载单元）：`src/` 源码 → `lib/` 构建产物 · `client/` 面板客户端 · `test/` 单测 · `cordis.patch.yml` · `locale/` |
| [`design/`](design/README.md) | 面板 UI 设计稿：27 屏 HTML 终稿 + tokens / app.css / icons.svg / dag.js |
| [`skills/`](skills/README.md) | 对外 skill 包：[`myteam-plugin-team/`](skills/myteam-plugin-team/README.md)（契约 + 模板 + 可执行校验器） |
| [`tools/`](tools/README.md) | 实弹与探针工具：CLI boot、网关 RPC、CDP 调试、演示数据、漂移检查、性能冒烟 |
| [`refs/`](refs/README.md) | 本地参考资产（**不入库**）：竞品源码、宿主源码快照、测试证据 |

全部项目级内容（角色 / 团队 / 任务账本 / 成员记忆 / token 侧车）由插件在项目目录下的 `.dsh-myteam/` 生成，随队长会话首开初始化。上传纪律住在存储目录**自己的** `.gitignore` 里（CHG-102 起不再往项目根写规则；旧目录 `.team-workplace/` 走一次性迁移）。

## 仓库规范

- **正本唯一**：PRD 在根、文档在 `docs/`、实现只在 `plugin/`。`lib/` 是构建产物但随包分发（`main` 指向它），改 `src` 必须 `npm run bundle`。
- **参考资产不入库**：`refs/` 全是本地调研材料，删掉不影响构建与测试。
- **不提交密钥与运行态**：boot 过程产生的 token / cookie 每次重新生成；`.dsh-myteam/` 的 `state/`、`history/`、`export/` 不入库。
- **改文档先改代码**：`docs/04` 的 `MT_*` 错误码表由 [`tools/gen-error-docs.mjs`](tools/gen-error-docs.mjs) 从 `plugin/src/core/errors.ts` 生成，**手改会被覆盖并被 `t81` 判红**。

## 当前状态

**机制层已收口**：单测 526 条全绿（67 个测试文件 / 43 个 src 模块），`check-drift` 报 `MISMATCH: 0`，44 个工具（队长 35 + 成员 9）、40 型账本事件、27 屏面板设计稿。

**已经过真实宿主安装验证**（CHG-93/94）：两次安装各抓到单测永远发现不了的 P0（preset 作用域服务异步就绪导致队长技能静默不注入；团队章程未注入队长 system prompt），均已修复并留下断言。深色对比度 8.15:1、横向溢出 0、控制台无插件侧报错。

**剩余门**：GUI 目检与动态冒烟需要人类在桌面宿主上配合；M2 的 UI 七阶段与 M2-7（最终配置 schema）仍排期中。完整逐条进度见 [docs/09-变更记录.md](docs/09-变更记录.md)，里程碑拆解见 [docs/05-任务板.md](docs/05-任务板.md)。

## 明确不做

- 不做 npm 市场发布纪律（只保留 `engines.dsh` 一行防错装）。
- 不做多 Workspace 多活跃团队（每 Workspace 至多 1 个活跃团队，归档不限）。
- 不做跨进程并发协调（诚实沿用单进程串行）。
- 不代用户连接 MCP、不代管凭据 —— 只做声明、可见性过滤与「未验证」标记。
- 队长不是大家长：不承担具体领域功能，也不引入「成员管理成员」的递归权限。

---

[MIT](LICENSE) © 2026 morning-start
