# docs · 项目文档导航

> 当前阶段：**整体架构与文档重构评审**。
> 阅读顺序：**产品目标 → 系统架构 → Role/Workflow → 迁移蓝图 → 功能设计 → 契约与代码 → 验收证据**。
> 运行时数据保存在项目工作区的 `.dsh-myteam/`，不属于本目录。

## 1. 现行阅读入口

| 顺序 | 入口 | 回答的问题 |
|---|---|---|
| 1 | [product/README](product/README.md) | 目标用户、当前目标需求、核心场景与非目标 |
| 2 | [architecture/00](architecture/00-现状与决策基线.md) | 代码实际是什么、旧文档冲突在哪里、哪些决策已确认 |
| 3 | [architecture/01](architecture/01-系统架构.md) | 全局/项目边界、项目事件真源、Root Runtime、权限、配置与恢复 |
| 4 | [architecture/03](architecture/03-角色能力与工作流.md) | Role、Skill、Workflow、TeamBlueprint 与统一 Task DAG 的关系 |
| 5 | [architecture/04](architecture/04-全量重构实施设计.md) | 全量 v2 实施路径、真实数据迁移、交付阶段与历史删除门禁 |
| 6 | [architecture/02](architecture/02-文档重构与迁移蓝图.md) | 文档治理、旧数据迁移、cutover、实施批次与验收矩阵 |

这些文档当前按 **as-is（现行实现）+ roadmap（尚未实施）** 两种口径写：
v2 代码已落地并验收（62 模块、46 个测试文件、面板 16 个只读方法、隔离实例 46/46，见
[25-隔离验收记录](delivery/25-隔离验收记录.md)），`proposed` 只用于**还没做**的路线项。
哪一条断言算成立、哪些过期，逐条对账见 [architecture/07](architecture/07-文档现状对账-2.0.0.md)。

## 2. 文件夹职责

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| [product/](product/README.md) | 当前产品目标、需求、用户场景与非目标 | 代码模块图、历史需求流水 |
| [architecture/](architecture/README.md) | 系统边界、资源模型、真源、权限、配置、恢复与 ADR | 具体工具参数、UI 控件 |
| [features/](features/README.md) | 后续六组逐功能实现设计 | 旧场景与旧实现的混合记录 |
| [contracts/](contracts/README.md) | 现行接口契约（多数由代码生成） | 手改生成物 |
| [delivery/](delivery/README.md) | 当前执行、风险、验收方法、变更记录 | 第二套架构权威 |
| [research/](research/README.md) | 竞品、官方实现、实践和源码研究 | 未经验证的宿主能力断言 |
| [audits/](audits/README.md) | 带日期的代码、技术、UI、交互和真机证据 | 目标架构正文 |
| `myteam/` | 运行时目录与工具使用说明（目前只有占位 `.gitkeep`，B4 里补或并入 `features/`） | 架构权威 |

> 旧资料（`historical/`）已按 [13-历史材料确认清单](delivery/13-历史材料确认清单.md) 删除，
> 追溯历史请用 git 历史与 `audits/`，本仓库没有 `docs/historical/` 目录。

每个目录的 `README.md` 是该部分的唯一导航入口。新增文档先确定部分，再建立链接，不再在 docs 根目录追加散文件。

## 3. 现行实现（as-is v2）

代码已经是 v2：项目事件账本是唯一真源（`events/project.jsonl`），面板/看板/审计读同一份投影；
Root Runtime 由「carrier + 两个 preset」组合（`plugin/cordis.patch.yml`）；RoleDefinition /
WorkflowDefinition / TeamBlueprint 是独立定义资产，团队与任务在项目内共享一套 Task DAG。

因此：

- [contracts/panel-rpc](contracts/panel-rpc.md)、[contracts/tool-surface](contracts/tool-surface.md)、
  [contracts/config-schema](contracts/config-schema.md)、[contracts/capabilities](contracts/capabilities.md)
  都是**从当前代码生成**的现行契约（改契约先改代码再生成，不要手改）；
- [audits/22](audits/22-架构梳理.md)是某一时点的代码快照，不是模块图权威；
- [audits/27](audits/27-成员子代理化与SQLite记忆.md)是子代理/SQLite 的真机证据；
- 尚未实施的只有路线项（例：动作卡片的宿主服务，见
  [architecture/06](architecture/06-动作卡片挂起说明.md)）；逐条对账见
  [architecture/07](architecture/07-文档现状对账-2.0.0.md)。

## 4. 按任务查找

### 我要评审 Role / Workflow

读 [architecture/03](architecture/03-角色能力与工作流.md)：RoleDefinition 是独立真源，由 RoleProfile + CapabilitySet 构成；WorkflowDefinition 可复用，WorkflowRun 仅属项目并复用统一 Task DAG。

### 我要理解当前代码

先读 [architecture/00](architecture/00-现状与决策基线.md)，再看 [audits/22](audits/22-架构梳理.md)和源码。运行 `node tools/arch-report.mjs` 获取当前代码体量与依赖，不引用旧数字冒充当前结果。

### 我要查接口 / 配置 / 贡献契约

进入 [contracts/](contracts/README.md)。三份生成契约（面板 RPC / 工具面 / 配置）改代码后重跑
`tools/gen-*.mjs`；`capabilities.md` 给能力矩阵。

### 我要执行计划、登记变更或验收

从 [delivery/README](delivery/README.md) 进入。发布口径看 [23-发版清单](delivery/23-发版清单.md)，
真机结果看 [25-隔离验收记录](delivery/25-隔离验收记录.md)，带日期的历史证据归 `audits/`。

### 我要追溯旧需求、旧架构或旧存储

旧资料已删除（见 [13-历史材料确认清单](delivery/13-历史材料确认清单.md)）：用 git 历史与 `audits/`。
新决策在 `architecture/` 或 `features/` 中明确 `supersedes` 关系。

## 5. 文档状态与轨道

| 标识 | 含义 |
|---|---|
| `as-is` | 描述**当前实现**的对账/纪实，可以被代码与测试证伪 |
| `accepted` | 当前有效设计，可指导功能设计与实现 |
| `proposed` | 尚未实施的路线项，不能当施工承诺 |
| `as-is v1` | 仅指 v1 兼容面（迁移用），不是现行架构 |
| `superseded` | 已被新文档/ADR 替代，保留演化记录 |
| `historical` | 时点需求、设计、计划或报告 |
| `generated` | 由代码或 schema 生成，只能改生成源 |

`research/` 和 `audits/` 还必须在正文注明日期、来源和验证方法。静态代码推导、单元测试和真机实测不得互相冒充。

## 6. 变更纪律

1. **先设计，后契约，再代码**；完成后登记变更与真实验收。
2. **一个事项一个权威**：产品、架构、功能、契约、执行分别归位。
3. **可点击链接与历史正文分开处理**：移动时修复链接，历史命令和旧变更单保留原文。
4. **生成内容不手改**：工具数、RPC 数、事件数、错误码和 schema 从代码生成。
5. **文档重构不等于数据迁移**：任何 cutover 都必须单独分析、验证并由用户确认。
6. **逐文件归属已落地**：完整映射见 [architecture/02 §4](architecture/02-文档重构与迁移蓝图.md#4-旧文档逐项处置)。
