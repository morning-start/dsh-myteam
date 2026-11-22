# 契约文档

> 本目录区分**当前实现的 as-is v1 契约**与**目标架构的新契约**，避免把旧 API 当成重写后的既定接口。

## 1. 当前实现契约

| 文档 | 轨道 | 用途 |
|---|---|---|
| [04-API与数据契约](04-API与数据契约.md) | as-is v1 | 旧工具、RPC、事件、错误码与数据形状；迁移表征和兼容分析 |
| [16-插件团队贡献契约](16-插件团队贡献契约.md) | as-is v1 | 当前第三方 Role/Team 模板贡献方式与安全边界 |
| [18-配置Schema定稿](18-配置Schema定稿.md) | as-is v1 | 当前团队配置字段、合并与写契约 |

这些文档仍有现实价值，因为当前代码仍在使用相应模型；但它们**不是目标架构的 v2 设计**。其中涉及团队分账本、队长内 Host、角色/模板旧 schema 和旧目录的内容，应以代码与迁移表征复核。

## 2. 目标契约的形成顺序

```text
architecture 评审
  → features 功能设计
  → contracts 新契约
  → 代码实现与生成物
  → audits 验证
```

目标契约至少包括：

- 定义资产：RoleDefinition、WorkflowDefinition、TeamBlueprint、SkillRef；
- 项目事件、原子批次、revision 与恢复记录；
- WorkflowRun、Task、Attempt、Gate、Evidence；
- Captain/Member/Panel 的命令与查询；
- Effective Config Snapshot、Knowledge、Memory；
- 新一代插件贡献与迁移契约。

## 3. 贡献契约的特殊提醒

当前 v1 贡献契约只覆盖 Role 与团队模板，**不代表已经支持 WorkflowDefinition**。

目标架构新增独立 WorkflowDefinition 后，必须先设计：

- 贡献物清单与只读目录；
- Role/Workflow/Blueprint 的引用校验；
- 插件卸载、升级与项目快照；
- 全局写与 Human 确认边界；
- 版本兼容和失败隔离。

在这些内容形成新契约前，不得向 v1 文档直接添加“已支持 Workflow”的实现承诺。

## 4. 生成与手工维护

- 错误码由 `plugin/src/core/errors.ts` 经 `tools/gen-error-docs.mjs` 生成到 [04](04-API与数据契约.md) 的标记块；
- 工具数、RPC 数、事件数、错误码和 schema 后续应从代码生成；
- 手写部分负责语义、权限、故障和迁移，不复制容易漂移的计数；
- 当前实现与目标设计不得共用“已冻结、适用于所有版本”的表述。
