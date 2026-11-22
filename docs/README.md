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

这些目标文档目前为 `proposed`，不能描述成已实现能力。架构书面评审和功能实现设计完成后，才进入整体代码重写。

## 2. 文件夹职责

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| [product/](product/README.md) | 当前产品目标、需求、用户场景与非目标 | 代码模块图、历史需求流水 |
| [architecture/](architecture/README.md) | 系统边界、资源模型、真源、权限、配置、恢复与 ADR | 具体工具参数、UI 控件 |
| [features/](features/README.md) | 后续六组逐功能实现设计 | 旧场景与旧实现的混合记录 |
| [contracts/](contracts/README.md) | as-is v1 契约，以及评审后的新工具/RPC/事件/schema | 把旧 API 当目标契约 |
| [delivery/](delivery/README.md) | 当前执行、风险、验收方法、变更记录 | 第二套架构权威 |
| [research/](research/README.md) | 竞品、官方实现、实践和源码研究 | 未经验证的宿主能力断言 |
| [audits/](audits/README.md) | 带日期的代码、技术、UI、交互和真机证据 | 目标架构正文 |
| [historical/](historical/README.md) | 被替代的需求、目标、架构、存储、计划与旧 PRD | 当前施工依据 |

每个目录的 `README.md` 是该部分的唯一导航入口。新增文档先确定部分，再建立链接，不再在 docs 根目录追加散文件。

## 3. 当前实现与目标设计

当前代码仍是旧 Runtime：团队分账本、captain preset 内 Host、旧角色/模板/配置 schema。目标架构则是项目事件真源、Root Runtime、多团队项目 DAG，以及独立 RoleDefinition/WorkflowDefinition/TeamBlueprint。

因此：

- [contracts/04](contracts/04-API与数据契约.md)、[contracts/16](contracts/16-插件团队贡献契约.md)、[contracts/18](contracts/18-配置Schema定稿.md)是 **as-is v1**，用于当前实现和迁移表征；
- [audits/22](audits/22-架构梳理.md)是代码快照，不是目标模块图；
- [audits/27](audits/27-成员子代理化与SQLite记忆.md)是子代理/SQLite 真机证据，不恢复旧 ADR 编号；
- `historical/` 中“唯一权威”“定稿草案”等字样只代表历史原文，不覆盖当前导航。

## 4. 按任务查找

### 我要评审 Role / Workflow

读 [architecture/03](architecture/03-角色能力与工作流.md)：RoleDefinition 是独立真源，由 RoleProfile + CapabilitySet 构成；WorkflowDefinition 可复用，WorkflowRun 仅属项目并复用统一 Task DAG。

### 我要理解当前代码

先读 [architecture/00](architecture/00-现状与决策基线.md)，再看 [audits/22](audits/22-架构梳理.md)和源码。运行 `node tools/arch-report.mjs` 获取当前代码体量与依赖，不引用旧数字冒充当前结果。

### 我要查当前旧 API / 配置 / 贡献契约

进入 [contracts/](contracts/README.md)，先确认 as-is v1 与目标契约的区别。目标 WorkflowDefinition 尚未因为旧贡献契约存在就被视为已实现。

### 我要执行计划、登记变更或验收

从 [delivery/README](delivery/README.md) 进入。旧 [05-任务板](historical/05-任务板.md)不再作为当前重写计划；真实测试与真机结果归 `audits/`。

### 我要追溯旧需求、旧架构或旧存储

进入 [historical/README](historical/README.md)。历史文档不回填成最新设计；新决策在 `architecture/` 或 `features/` 中明确 `supersedes` 关系。

## 5. 文档状态与轨道

| 标识 | 含义 |
|---|---|
| `proposed` | 目标设计评审中，不能作为代码施工承诺 |
| `accepted` | 当前有效目标设计，可指导功能设计与实现 |
| `as-is v1` | 当前旧实现契约，用于兼容和迁移，不是目标架构 |
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
