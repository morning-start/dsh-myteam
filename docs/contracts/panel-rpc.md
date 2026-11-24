# 面板 RPC 契约

> 由 `tools/gen-panel-contract.mjs` 从 `plugin/src/application/panel-contract.ts` 生成。
> 不要手改；改契约请改代码后重新生成。

- 协议版本：`2`
- 请求：`{ protocolVersion?: number, method: string, params?: object }`
- 响应：`{ ok: true, data: object }` 或 `{ ok: false, error: { code, message, retryable, details? } }`

协议版本显式不匹配时返回 `UNSUPPORTED_PROTOCOL_VERSION`；未知方法返回 `INVALID_COMMAND`。
面板只读方法不写项目。写操作不走这个命名空间，而是单独一条通道：
`POST /__myteam/write/<method>`，必须带 `sessionId`，按确认方式分两类——
`token` 先预览影响面换一次性令牌、再凭令牌执行；`direct` 直接带 `confirm: true` 执行
（由域内状态校验兜底）。

## 方法

| 方法 | 说明 |
|---|---|
| `status` | 项目身份、观察到的 projectSeq、graphRevision 与各实体计数。 |
| `overview` | 看板总数、团队摘要与需要关注项（评审中、阻塞、结果未知的 Effect）。 |
| `board` | 按状态分列的任务看板，含阻塞上游与总计数。 |
| `task` | 单任务详情：正文、验收标准、依赖状态、Attempt、门禁裁决与证据。 |
| `team` | 团队概览：队长世代、成员、任务与生效配置快照。 |
| `definitions` | 项目内角色/工作流/蓝图清单，含 lineage 与发布状态。 |
| `runs` | 工作流运行清单：状态、定义 revision、完成规则 revision 与任务数。 |
| `run` | 单个运行详情：完成规则、templateKey → taskId 映射与各任务当前状态。 |
| `knowledge` | 项目知识条目：正文、证据引用、修订与取代关系。 |
| `effects` | Effect 清单与三态计数：requested / accepted / completed，另列 failed、cancelled、outcome-unknown。 |
| `audit` | 已提交事件流（新→旧分页）：seq、时间、类型、actor 与实体引用。 |
| `settings` | 配置面只读视图：项目默认值、configRevision 与各团队的生效配置快照。 |
| `memory` | 项目长期记忆（SQLite）：bank 汇总与条目（含已遗忘标记），可按 bankId 过滤。 |
| `globalLibrary` | 全局库只读视图：$DSH_HOME/myteam 下的角色/工作流/蓝图（含 v1 teams 兼容）与读不懂的文件清单。 |
| `globalAudit` | 全局操作审计（audit/global-operations.jsonl）：新→旧、坏行跳过并记 warning。 |
| `migration` | v1 旧数据的只读迁移影响面报告（需要装配迁移分析器）。 |

## 写方法

| 方法 | 确认方式 | 说明 |
|---|---|---|
| `teamDisband` | `token` | 解散团队：预览成员与任务影响面，凭一次性令牌执行。动作 `team.disband`（人类专属）。 |
| `captainTakeover` | `token` | 队长接管：预览世代递增与生效成员，凭一次性令牌执行。动作 `captain.takeover`（人类专属）。 |
| `gateVerdict` | `direct` | 门禁裁决：对评审中的任务写入 pass / fail / blocked 与检查结果，需 `confirm: true`。 |
| `taskCreate` | `direct` | 新建任务：标题、验收标准、依赖与所需角色，建在指定团队下，需 `confirm: true`。 |
| `taskMove` | `direct` | 移动任务：只支持取消 / 重开 / 认领三个方向的合法迁移；完成必须走门禁裁决，需 `confirm: true`。 |
| `teamCreate` | `direct` | 建团队：名字、目标、队长会话（可选蓝图初始化角色与配置），需 `confirm: true`。 |
| `memberAppoint` | `direct` | 召唤成员：团队 + 角色（可选父成员与会话）→ 聘任并固化角色快照，需 `confirm: true`。 |
| `memberRelease` | `direct` | 释放成员（终态）：成员不能有进行中的尝试；释放后不再接活，需 `confirm: true`。 |
| `memberArchive` | `direct` | 归档成员（退役但可回放）：名册留痕、记忆与证据保留、可恢复；有进行中尝试时要么等结束（drain=wait），要么先暂停再归档（drain=pause）；子成员须先处理，需 `confirm: true`。 |
| `memberRestore` | `direct` | 恢复已归档成员（archived → active）；只对归档态有效，已释放不可恢复，需 `confirm: true`。 |
| `definitionPublish` | `token` | 发布定义到全局库：预览引用与覆盖影响面，凭一次性令牌执行。动作 `definition.publish.confirm`（人类专属）。 |
| `globalDefinitionSave` | `token` | 直改全局库里的定义（不经项目）：预览引用与被引用、冲突检测（expectedHash），凭一次性令牌执行。动作 `definition.global.write`（人类专属）。 |
| `definitionSave` | `direct` | 保存项目定义（角色 / 工作流）：revision 递增并记 previousHash，需 `confirm: true`。 |
| `memoryRemember` | `direct` | 写一条长期记忆到团队 bank 或某个成员 bank，需 `confirm: true`。 |
| `memoryForget` | `direct` | 遗忘一条记忆（默认软删留痕，`hard` 才真删），需 `confirm: true`。 |

## 参数

| 方法 | 必填参数 |
|---|---|
| `task` | `taskId` |
| `team` | `teamId` |
| `migration` | 无（读取请求里的工作区根） |
| 其余 | 无 |

## 稳定标识

方法名是协议的一部分，发布后只增不改。新增能力只能追加方法，不能改变已有方法的
参数语义或返回结构。
