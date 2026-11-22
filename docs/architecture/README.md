# 架构文档

> 当前状态：`proposed`，按用户已确认方向形成评审稿；不把目标设计冒充已实现能力。

## 阅读顺序

| 顺序 | 文档 | 内容 |
|---|---|---|
| 1 | [00-现状与决策基线](00-现状与决策基线.md) | 代码事实、文档冲突、已确认决策、兼容约束和旧 ADR 去向 |
| 2 | [01-系统架构](01-系统架构.md) | 作用域、项目事件真源、Root Runtime、权限、配置、并发与恢复 |
| 3 | [03-角色能力与工作流](03-角色能力与工作流.md) | RoleProfile + CapabilitySet、SkillRef、WorkflowDefinition/Run、TeamBlueprint |
| 4 | [02-文档重构与迁移蓝图](02-文档重构与迁移蓝图.md) | 文档治理、旧数据迁移、cutover、验证和实施批次 |

## 边界

- `architecture/` 回答系统为什么这样划分，以及跨功能不变量；
- `product/` 回答目标用户与需求；
- `features/` 回答每个功能如何实现；
- `contracts/` 回答稳定接口与机器契约；
- `audits/` 回答代码或真机实际验证过什么。

后续局部架构取舍放入 `decisions/`，每份 ADR 只处理一个主题，并明确 `accepted/superseded` 关系，不再把多轮决策持续追加到一份总文档中。
