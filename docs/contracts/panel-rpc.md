# 面板 RPC 契约

> 由 `tools/gen-panel-contract.mjs` 从 `plugin/src/application/panel-contract.ts` 生成。
> 不要手改；改契约请改代码后重新生成。

- 协议版本：`2`
- 请求：`{ protocolVersion?: number, method: string, params?: object }`
- 响应：`{ ok: true, data: object }` 或 `{ ok: false, error: { code, message, retryable, details? } }`

协议版本显式不匹配时返回 `UNSUPPORTED_PROTOCOL_VERSION`；未知方法返回 `INVALID_COMMAND`。
面板只读方法不写项目；人类专属写操作走确认令牌通道，不在此命名空间内。

## 方法

| 方法 | 说明 |
|---|---|
| `status` | 项目身份、观察到的 projectSeq、graphRevision 与各实体计数。 |
| `overview` | 看板总数、团队摘要与需要关注项（评审中、阻塞、结果未知的 Effect）。 |
| `board` | 按状态分列的任务看板，含阻塞上游与总计数。 |
| `task` | 单任务详情：正文、验收标准、依赖状态、Attempt、门禁裁决与证据。 |
| `team` | 团队概览：队长世代、成员、任务与生效配置快照。 |
| `definitions` | 项目内角色/工作流/蓝图清单，含 lineage 与发布状态。 |
| `migration` | v1 旧数据的只读迁移影响面报告（需要装配迁移分析器）。 |

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
