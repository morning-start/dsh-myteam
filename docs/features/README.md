# 功能实现设计

> 本目录只保存**已经基于目标架构展开的逐功能设计**。
> 旧 [用户场景与功能设计](./README.md)描述旧实现与旧规划，不进入新主干。
> 在产品与架构书面评审完成前，本目录只提供设计顺序和统一模板，不提前承诺工具、RPC 或 UI 实现。

## 1. 设计顺序

| 顺序 | 功能包 | 必须覆盖的主题 |
|---|---|---|
| F01 | 定义资产与发布 | RoleDefinition、WorkflowDefinition、TeamBlueprint、SkillRef、复制、origin/baseHash、发布确认 |
| F02 | 建队与成员 | 计划审批、Captain Assignment、handoff、子代理、成员树、角色快照与生命周期 |
| F03 | Workflow、任务 DAG 与门禁 | Definition/Run、TaskTemplate、项目任务、参与关系、Attempt、动态改图、门禁与完成条件 |
| F04 | 消息、Effect 与恢复 | durable 后副作用、受理/消费、结果未知、离线、租约、SessionRef 换绑与恢复 |
| F05 | 配置、知识与记忆 | Effective Config Snapshot、生成视图、知识策展、SQLite bank 与所有权 |
| F06 | 面板、契约与迁移 | 统一 Query、用户操作、工具/RPC/schema 生成、旧数据 cutover 与 DSH Web 验收 |

F01 → F02/F03 → F04/F05 → F06 是主要依赖关系；每个功能包先评审再进入下一个实现批次。

## 2. 每份功能设计的固定结构

```text
# FNN · 功能名称

1. 目标、用户与场景
2. 概念边界及与架构决策的关系
3. 正常流程与关键异常流程
4. 状态机、实体与事件变化
5. 工具/RPC/查询契约及版本
6. 权限、确认与负面对抗
7. 持久化、派生物与恢复
8. 旧数据/旧调用迁移
9. 单元、集成、真机验收
10. 实现拆分与回退边界
```

## 3. 完成定义

一份功能设计只有满足以下条件才可标记 `accepted`：

- 与 [系统架构](../architecture/01-系统架构.md) 和 [角色能力与工作流](../architecture/03-角色能力与工作流.md) 无冲突；
- 每个写操作都能定位唯一权威、唯一写入口和权限来源；
- 每个外部副作用都说明 durable 边界、结果未知与恢复行为；
- 每个动态图操作都说明项目 revision、防环和任务归属；
- 每个配置相关动作都说明 configRevision 与在途 Attempt 规则；
- 每个旧实体都有迁移、保留或明确退役去向；
- 不包含未决 TODO/TBD，不用“后续再说”隐藏核心分支；
- 已完成独立读者评审。

## 4. 契约与实现的关系

- 功能设计稳定后，工具/RPC/事件/配置等机器契约归入 [../contracts/README.md](../contracts/README.md)；
- 当前代码的 v1 契约只作 as-is 参考，不能复制成新设计的默认答案；
- 实现计划、风险和变更登记归入 [../delivery/README.md](../delivery/README.md)；
- 真机与审计结果归入 `audits/`，不回写成“设计时已验证”。
