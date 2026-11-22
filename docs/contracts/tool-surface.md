# 工具面契约

> 由 `tools/gen-tool-contract.mjs` 从 `plugin/src/application/tool-specs.ts` 与
> `plugin/src/contracts/errors.ts` 生成。不要手改。

## 身份与权限

- 工具参数里的 `teamId` / `memberId` **不可信**；调用者身份只来自会话绑定
  （`application/actor-resolution.ts`），解析不到即 `FORBIDDEN`。
- 队长 preset 只注册队长工具，成员 preset 只注册成员工具；两侧不共享注册表。

## 队长工具（15）

| 工具 | 说明 | 必填参数 |
|---|---|---|
| `myteam_read_board` | 读取项目看板的当前投影（按状态分列、含阻塞上游与总计数）。 | — |
| `myteam_read_task` | 读取单个任务详情：正文、验收标准、依赖状态、Attempt、门禁裁决与证据。 | `taskId` |
| `myteam_read_team` | 读取团队概览：队长世代、成员、任务与生效配置。 | — |
| `myteam_preview_disband` | 预览解散团队的影响面（只读，不写事件）。把返回的 targetHash 交给人类确认；人类侧确认后才真正执行。 | `teamId` |
| `myteam_preview_takeover` | 预览队长接管的影响面（只读，不写事件）。把返回的 targetHash 交给人类确认；人类侧确认后才真正执行。 | `teamId`、`toSessionId` |
| `myteam_create_team` | 创建一支团队并让**当前会话**成为它的队长。只能在当前会话还不属于任何团队时调用（新项目的第一步）。 | `name`、`goal` |
| `myteam_create_task` | 在项目里创建一个任务（默认归当前队长的团队）。 | `title`、`acceptance` |
| `myteam_start_workflow` | 用一份工作流定义实例化一次运行（Run），生成全部任务并返回 taskId 映射。 | `workflowId` |
| `myteam_create_workflow` | 定义一份可复用的工作流（任务模板 + 依赖 + 完成条件）。 | `name`、`templates` |
| `myteam_appoint_member` | 按角色聘任一名团队成员（可选父成员以收窄能力）。 | `roleId` |
| `myteam_claim_task` | 把任务认领给某个成员，创建一次新的 Attempt。 | `taskId`、`memberId` |
| `myteam_review_task` | 对 review 状态的任务写入门禁裁决（pass / fail / blocked）。 | `taskId`、`attemptId`、`outcome` |
| `myteam_complete_task` | 在门禁通过、证据与交付物齐备时完成任务；满足条件时同一批次关闭 Run。 | `taskId`、`attemptId` |
| `myteam_propose_knowledge` | 提出一条带证据的项目知识；采纳需要队长或人类。 | `title`、`body`、`evidence` |
| `myteam_adopt_knowledge` | 采纳一条待采纳的项目知识。 | `entryId` |

## 成员工具（3）

| 工具 | 说明 | 必填参数 |
|---|---|---|
| `myteam_progress` | 提交当前 Attempt 的进度说明。 | `taskId`、`attemptId`、`note` |
| `myteam_evidence` | 为当前 Attempt 追加证据条目（命令输出、文件、会话等）。 | `taskId`、`attemptId`、`evidence` |
| `myteam_submit_review` | 把任务提交评审，等待队长或门禁裁决。 | `taskId`、`attemptId` |

## 返回形状

成功：`{ "ok": true, "data": { ... } }`
失败：`{ "ok": false, "error": { "code": "FORBIDDEN", "message": "...", "retryable": false } }`

业务错误**不抛给宿主**：模型需要看到 `code` 才能改变行为。

## 错误码

- `ALREADY_EXISTS`
- `ATTEMPT_STALE`
- `CAPABILITY_ESCALATION`
- `CAPTAIN_GENERATION_STALE`
- `CAPTAIN_OFFLINE`
- `CONFIRMATION_TARGET_CHANGED`
- `CONFLICT`
- `DEPENDENCY_CYCLE`
- `EFFECT_CANCELLED`
- `EFFECT_NOT_RETRYABLE`
- `EFFECT_OUTCOME_UNKNOWN`
- `EVENT_LOG_CORRUPT`
- `EVENT_LOG_TORN_TAIL`
- `EVENT_LOG_UNWRITABLE`
- `FORBIDDEN`
- `GLOBAL_AUDIT_MISSING`
- `GLOBAL_DEFINITION_MISSING`
- `GLOBAL_PUBLISH_FAILED`
- `GLOBAL_TARGET_CHANGED`
- `HUMAN_CONFIRMATION_EXPIRED`
- `HUMAN_CONFIRMATION_INVALID`
- `HUMAN_ONLY`
- `INTERNAL`
- `INVALID_COMMAND`
- `INVALID_PAYLOAD`
- `INVALID_TRANSITION`
- `MANIFEST_INVALID`
- `MEMBER_NOT_ACTIVE`
- `MIGRATION_BLOCKED`
- `MIGRATION_CONFLICT`
- `MIGRATION_INPUT_UNSUPPORTED`
- `MIGRATION_UNKNOWN_EVENT`
- `NOT_FOUND`
- `PRECONDITION_FAILED`
- `PROJECTION_STALE`
- `PROJECT_NOT_INITIALIZED`
- `PROJECT_WRITE_BLOCKED`
- `SESSION_LOST`
- `TASK_NOT_READY`
- `TEAM_NOT_ACTIVE`
- `UNSUPPORTED_PROTOCOL_VERSION`
- `UNSUPPORTED_SCHEMA_VERSION`
- `WRITER_LEASE_LOST`
