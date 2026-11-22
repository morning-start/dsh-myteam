# 交付与执行

> 本目录管理当前重写计划的执行、风险、验收方法与变更记录。
> 目标设计本身不在这里重复；以 [../architecture/README.md](../architecture/README.md) 和功能设计为准。

## 1. 当前执行入口

1. 架构决策与系统边界：[../architecture/00-现状与决策基线.md](../architecture/00-现状与决策基线.md)、[../architecture/01-系统架构.md](../architecture/01-系统架构.md)；
2. Role 与 Workflow：[../architecture/03-角色能力与工作流.md](../architecture/03-角色能力与工作流.md)；
3. 迁移和实施批次：[../architecture/02-文档重构与迁移蓝图.md](../architecture/02-文档重构与迁移蓝图.md)；
4. 功能设计拆分：[../features/README.md](../features/README.md)。

旧 [05-任务板](./README.md)记录旧 M1～M3 计划，不再作为当前重写任务入口。

## 2. 当前资料

| 文档 | 用途 |
|---|---|
| [06-风险与依赖](06-风险与依赖.md) | 旧实现风险、技术债和依赖；新架构风险需按重写计划增补 |
| [07-验收标准与用例](07-验收标准与用例.md) | 验收模板、缺陷分级、DoR/DoD 方法 |
| [09-变更记录](09-变更记录.md) | 追加式 CHG 历史，不代替架构正文 |
| [13-UI对齐分工](13-UI对齐分工.md) | 旧 UI 施工与分工方法，不决定目标领域模型 |

## 3. 统一验证命令

```bash
# 构建产物与源码同步
cd plugin && npm run bundle

# 完整单元测试
cd plugin && npm test

# 仓库统一 8 项门禁
node tools/check-all.mjs

# 仅检查文档链接
node tools/check-doc-links.mjs

# 当前代码结构报告
node tools/arch-report.mjs
```

DSH Web 活体验收使用 `tools/boot-test-web.cmd`。Web 真机结果归入 `audits/`，不得倒写成设计阶段已经验证。

## 4. 变更纪律

1. 先设计、后契约、再代码；完成后再登记变更与真实验收。
2. 数据 cutover 与代码回滚分开处理，不能用 Git 回滚冒充业务数据回滚。
3. 当前测试数、工具数、RPC 数不手工写入多个文档，以可复现命令和生成物为准。
4. 历史计划与报告只保留时点事实，不为“看起来最新”而回填。
