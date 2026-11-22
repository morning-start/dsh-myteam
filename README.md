<div align="center">
  <img src="plugin/icon.svg" width="88" height="88" alt="myteam icon">
  <h1>dsh-plugin-myteam</h1>
  <p>DSH 内的通用多智能体团队运行时：可复用定义、项目级任务 DAG、可审计事件与可重建视图。</p>
</div>

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-informational)
![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.0%20~%200.3.0-informational)

> **当前阶段：整体架构重写评审。** 现有插件实现代表旧架构；新目标架构已写入 `docs/architecture/`，目前为 `proposed`。在书面评审与后续功能实现设计完成前，不把目标设计描述成已经实现的能力。

## 1. 先读架构文档

| 顺序 | 文档 | 内容 |
|---|---|---|
| 1 | [docs/product/README](docs/product/README.md) | 产品目标、当前需求、用户场景与非目标 |
| 2 | [docs/architecture/00-现状与决策基线](docs/architecture/00-现状与决策基线.md) | 代码事实、旧文档冲突、已确认决策与兼容约束 |
| 3 | [docs/architecture/01-系统架构](docs/architecture/01-系统架构.md) | 资源模型、项目事件真源、Root Runtime、权限、配置与恢复 |
| 4 | [docs/architecture/03-角色能力与工作流](docs/architecture/03-角色能力与工作流.md) | RoleProfile + CapabilitySet、SkillRef、WorkflowDefinition/Run 与 Task DAG |
| 5 | [docs/architecture/04-全量重构实施设计](docs/architecture/04-全量重构实施设计.md) | 全量 v2 实施路径、真实数据迁移与历史删除门禁 |
| 6 | [docs/architecture/02-文档重构与迁移蓝图](docs/architecture/02-文档重构与迁移蓝图.md) | 文档目录、旧数据迁移、实施批次与验证矩阵 |

完整阅读路径见 [docs/README.md](docs/README.md)。旧编号文档继续保留用于追溯，但涉及作用域、真源、权限、成员、记忆和目录时，不能再各自宣称唯一权威。

## 2. 目标架构一页概览

myteam 将系统分为三层：

| 层 | 负责什么 | 核心规则 |
|---|---|---|
| **全局复用层** | RoleDefinition、WorkflowDefinition、TeamBlueprint | 跨项目复用；任何进入或修改全局的动作必须经用户确认 |
| **项目定义与运行层** | 项目定义、多个团队、WorkflowRun、项目任务 DAG、配置、知识、记忆 | agent 主操作；项目内跨会话、跨时间持久化 |
| **DSH 执行层** | 队长/成员会话、子代理、模型与工具执行、Session Log | DSH 持有执行事实，myteam 只保存明确引用 |

目标模型的关键变化：

- **Role 只保留两部分**：RoleProfile + CapabilitySet，Skill 由 DSH 持有并通过 SkillRef 引用；
- **Workflow 独立**：Definition 可复用，Run 仅属项目并复用统一项目 Task DAG，不建立第二套任务引擎；
- **任务直接属于项目**：允许一个项目多个团队并行，允许跨团队依赖；
- **项目统一事件真源**：项目定义、配置、知识和运行事实进入同一项目事件日志；
- **配置文件是生成视图**：不再与账本形成双真源；
- **Root MyTeamRuntime**：captain、member、panel 共用同一应用服务，不再由每个队长各持一份业务 Host；
- **两级写入协调**：项目写者防物理分叉，Captain Assignment 防业务指令冲突；
- **长期记忆独立**：SQLite 是唯一记忆权威，严格校验 bank 所有权；
- **全局写不可伪造**：普通 `confirm:true` 或 `actor:'human'` 不构成用户授权。

完整定义与边界以 [系统架构](docs/architecture/01-系统架构.md) 为准。

## 3. 当前实现与目标设计的关系

当前代码仍采用以下旧模型：团队分账本、captain preset 内 Host、面板在线/离线多条读路、文件与 SQLite 双记忆面。它既是现有功能的实现，也是迁移输入来源，**不是目标架构的准确示意图**。

本次重写不是删除全部经验：append-only、先算后写、结构化证据、Attempt 防陈旧、能力只收窄、项目根隔离、原子写与真机验收纪律都会保留；服务所有权、项目一致性边界、配置与派生物模型将重构。

迁移采用只读分析、候选导入、全量对账、用户确认 cutover，不做新旧长期双写，也不在启动时悄悄改写旧数据。

## 4. 仓库结构

| 位置 | 内容 |
|---|---|
| [`docs/product/`](docs/product/README.md) | 当前产品目标与需求基线 |
| [`docs/architecture/`](docs/architecture/README.md) | 系统架构、Role/Workflow 与迁移蓝图 |
| [`docs/features/`](docs/features/README.md) | 后续六组功能实现设计 |
| [`docs/contracts/`](docs/contracts/README.md) | as-is v1 与未来目标契约 |
| [`docs/delivery/`](docs/delivery/README.md) | 执行、风险、验收方法与变更记录 |
| [`docs/research/`](docs/research/README.md) · [`docs/audits/`](docs/audits/README.md) · [`docs/historical/`](docs/historical/README.md) | 研究、时点证据与历史文档 |
| [`docs/historical/dsh-myteam-requirements.md`](docs/historical/dsh-myteam-requirements.md) | 原根目录 PRD，已历史化 |
| [`plugin/`](plugin/README.md) | 插件实现：`src/`、`lib/`、`client/`、`test/`、装载 patch 与 locale |
| [`design-v2/`](design-v2/README.md) | UI 设计稿（现行：全局库 / 项目工作台 24 屏 + tokens / 样式 / 图标） |
| [`skills/`](skills/README.md) | 对外 skill 包与第三方贡献辅助资产 |
| [`tools/`](tools/README.md) | 构建检查、实机探针、RPC、架构报告与 Web 测试启动工具 |
| `refs/` | 本地参考材料，不入库；克隆后不存在属于正常情况 |

## 5. 构建与验证

```bash
# 修改 plugin/src 或 client 源片段后重建装载产物
cd plugin && npm run bundle

# 离线单元测试
cd plugin && npm test

# 仓库统一门禁
node tools/check-all.mjs

# 源码与构建产物漂移检查
node tools/check-drift.mjs

# 当前代码结构报告
node tools/arch-report.mjs

# 文档相对链接检查
node tools/check-doc-links.mjs
```

环境要求：Node ≥ 22.18，DSH `0.2.1-rc.0 ~ 0.3.0`。当前是否通过测试只以本次实际运行结果为准；README 不再维护容易过期的测试数、工具数或 RPC 数徽章。

### DSH Web 活体验收

开发和单元测试在桌面端完成，独立 Web 实例用于活体验收：

```powershell
# 启动无密码测试 Web 实例，具体地址与 token 以启动输出为准
tools\boot-test-web.cmd
```

Web 测试不会替代单元测试、权限负面对抗或多进程写者测试。测试同一项目时，必须遵守目标架构的项目写者租约，不能让旧 Runtime 与新 Runtime 同时写入。

## 6. 仓库规范

1. **先设计，后代码**：架构或行为变化先更新设计并评审，再实现；完成后登记变更和真实验收。
2. **源码与产物同步**：`lib/` 是随包分发的构建产物，修改 `plugin/src` 后必须重新 bundle。
3. **生成内容不手改**：错误码、工具/RPC/事件计数和 schema 以生成源为准。
4. **不提交密钥与私有运行态**：token/cookie、SQLite 记忆、写者锁、缓存、导出与 scratch 按存储 `.gitignore` 纪律处理。
5. **不批量改写历史证据**：旧验收和审计只代表对应时点；新结论重新运行命令取得。
6. **文档重写不等于数据迁移**：任何旧项目 cutover 都必须单独分析、验证并由用户确认。

## 7. 下一阶段

架构书面评审通过后，先完成六组功能实现设计：定义与发布、建队与成员、Workflow/任务 DAG 与门禁、消息与恢复、配置/知识/记忆、面板与迁移。每组明确场景、状态、接口、权限、持久化、故障和验收后，才进入整体代码重写。

---

[MIT](LICENSE) © 2026 morning-start
