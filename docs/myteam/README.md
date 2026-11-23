# 运行时目录与工具说明

> 状态：`as-is`。本目录放**运行期**的东西（数据在哪、怎么读、怎么清），不放架构权威。

- 项目级数据：工作区里的 `.dsh-myteam/`（`events/project.jsonl` 是真源，`state/` 是派生投影，
  `memory/` 是 SQLite 记忆库）——布局见 [architecture/01 §7](../architecture/01-系统架构.md)。
- 全局级数据：`$DSH_HOME/myteam/`（RoleDefinition / WorkflowDefinition / TeamBlueprint 与全局审计）。
- 读/写口径与并发：项目写者租约在 `state/writer.lock`，多实例同时写会报 `WRITER_LEASE_LOST`（设计如此）。
- 工具面与错误码：见 [contracts/tool-surface](../contracts/tool-surface.md)；面板方法：见
  [contracts/panel-rpc](../contracts/panel-rpc.md)。

本目录目前只有这份说明；具体运维脚本的用法在 [tools/README](../../tools/README.md)。