# .dsh-myteam —— 项目级团队存储

本目录是 myteam 的**项目级唯一落盘根**：角色、团队、技能、工具、任务依赖、流程配置
都在这里，随项目走，不落到用户全局 profile。

## 目录

| 路径 | 内容 | 上传 |
|---|---|---|
| `manifest.json` | 项目清单（schema 版本 / 项目名 / 默认团队） | ✅ |
| `config/team.config.json` | 行为配置（看板列 / 泳道 / 门禁 / 限制） | ✅ |
| `config/workflow.json` | 整体流程（阶段 + 门禁链 + 交接规则） | ✅ |
| `config/roles/<roleId>.json` | 角色（职责 / 提示词 / 工具策略 / 技能 / MCP） | ✅ |
| `config/teams/<teamId>.json` | 团队（名册模板） | ✅ |
| `config/skills/<skillId>.json` | 项目技能 | ✅ |
| `config/tools/<toolId>.json` | 工具策略（只能收窄权限） | ✅ |
| `config/knowledge/` | 团队知识库（`index.json` + 主题条目） | ✅ |
| `tasks/<teamId>/ledger.jsonl` | 任务与依赖的 append-only 账本（唯一权威） | ✅ |
| `structure.md` | 团队章程（队长维护的结构约定） | ✅ |
| `history/` | 归档 / token 计量 / 成员记忆 | ❌ |
| `state/` | 索引 / scratch / 日志（可从账本重建） | ❌ |
| `export/` | 导出快照 | ❌ |

## 规矩

1. **只改 `config/` 与 `tasks/` 里你懂的东西**；`state/` 删掉不会丢数据（可重建）。
2. 想让别人共享你的团队：提交 `config/`（`.gitignore` 已经放行）。
3. 别把凭据写进来——`config/` 是入库的。
