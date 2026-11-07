# 04-API 与数据契约

> TL 主导维护，PM 确认业务语义，QA 依据此做契约测试。
> 对应 PRD v2.3 §6（工具清单）/§7（数据模型）/ADR-001~008。

## 1. 模型工具契约（myteam_*）

### 1.1 Lead 专属工具（注册在 preset 层，仅队长会话可见）

| 工具 | 参数（schema 摘要） | 返回 | 校验（拒绝式） | 账本事件 |
|------|--------------------|------|----------------|----------|
| `myteam_submit_plan`（CHG-70：teamId 派生/重复提交守门） | `{teamId?, teamName, goal, presetId?, roster?:[{roleId, instanceName?, skills?, mcpAllowlist?}], tasks:[TaskInput], clarify?: {questions:[{id,type:'taste'\|'fact',text,assumption?}]}}` —— **CHG-36 v2.13**：roster 缺省/空时按预置团队「标准三人组」成团（captain+req-validator+developer+acceptor）；**CHG-54**：显式 `presetId` 时按项目/内置模板 members 组队（队长隐式，队员可带技能/MCP 覆写），模板引用的全局/内置角色在提交时复制进项目库；**CHG-55**：模板的 `board/pipeline/gates/taskTypes` 同时原子写入团队级 `team.config.json`（service 构造前落盘） | `{teamId, planId?, validation, roster, presetId?, presetName?, configApplied?, note}` | 队长必含且仅一个（FR-10.2）；FR-11.2 七项硬校验；任务数≤上限；未知模板/未知角色 → `MT_VALIDATION`；**同名 active 团队 → `MT_TEAM_STATE`**（不改名不覆盖，改名用 update_team）；teamId 缺省时从团队名 slug 派生，**全中文名用名字哈希 `team-<6hex>`**（同名稳定、异名不同） | `team.created` `plan.clarify?` `plan.staged` |
| `myteam_approve_plan` | `{teamId, planId}` | `{spawned:[{memberId,sessionId}]}` | 无未关闭 clarify；团队处于 draft | `plan.approved` `member.spawned` |
| `myteam_revise_plan` | `{teamId, planId, note}` | `{}` | 团队 draft | `plan.revised` |
| `myteam_discard_plan` | `{teamId, planId, confirm: true}` | `{}` | confirm 两段确认 | `plan.discarded` |
| `myteam_create_task` | `{teamId, task: TaskInput, taskId?, assignees?:string[], participants?:[{teamId, memberIds?, role?}]}` | `{status:'created', taskId, assigned?, participants?, warnings?}` | FR-11.2 硬校验；**CHG-55**：`gateChain` 缺省时按生效配置 `taskTypes[taskType] → taskTypes.default` 展开（显式链优先）；**CHG-73**：`assignees`/`participants` 同一次调用写入（创建后补写 `task.assigned`/`task.participate`，关系失败只回 warnings，任务不回滚） | `task.created`（+`task.assigned`/`task.participate`） |
| `myteam_edit_task`（CHG-70/73 修；**CHG-86 改名**，原 `myteam_update_task`） | `{teamId, taskId, patch:{title?,description?,acceptanceCriteria?,deliverableSpec?,deps?,requiredRole?,taskType?,gateChain?,priority?,estimate?,tags?}, rescope?: {reason}, memberIds?}` | `{status:'updated', taskId, changes:[{field,from,to}]}` / `{status:'rescoped', …}` | **编辑 = 白名单补丁合并，不改状态机 / attempt / 证据**；空补丁/未知字段/依赖成环/名册外角色/AC 为空 → `MT_VALIDATION`；**CHG-73**：字段级 `changes` 随事件落账（详情「改动记录」与证据过期判定同源）；`rescope` 走一键重规划管线（任何非终态 + reason 必填）。**CHG-86（P0-4）**：改名原因 = 与成员作用域 `myteam_update_task`（申报进度）**重名**，同名跨层注册时宿主按解析顺序取其一——若队长侧生效，成员即可绕过 attemptId 校验直接改任务结构（越权）。改后两作用域**零重名** | `task.updated`（带 changes）/ `task.rescoped` |
| `myteam_review_task`（**CHG-86 新增**，M2-C；**CHG-87 补 verify 门**，FR-5.3） | `{teamId, taskId, verdict:'pass'\|'fail', reviewerMemberId?, reason?, confirm?, expectedRevision?}` | `{status:'gate-pass'\|'gate-fail'\|'needs-human', gate, taskState, rejectCount?, note?, code?, message?, verify?{argv,exitCode,signal,durationMs,outputTail,truncated}, forcedBy?}` | **门禁裁决唯一入口**（修复前没有任何入口能提交 `task.gate.result`）。① `gate:review` → 只认**显式结论行**，且**强制交叉审查**（`reviewerMemberId` 必填且 ≠ 实现者；同成员 → `MT_CROSS_REVIEW`，FR-5.1）；② **`gate:verify`（CHG-87 / FR-5.3）→ 真跑命令，不是人工裁决**：host 按任务声明的 `verifyCommand` 执行（`argv` 数组直传、**无 shell 解释**），exitCode 决定 verdict，payload 记 `command{argv,cwd?}` / `exitCode` / `signal` / `durationMs` / `outputTail`（尾部 2000 字符，截断时前置 `…[truncated N chars]…`）/ `executedBy:'host'`；**修复的缺陷**：旧实现把 verify 门当 review 门处理（要 `reviewerMemberId` 人工裁决），等于「门禁本来要防的模型自述『测试通过』反而从 verify 门漏了进来」；任务未声明 `verifyCommand` → `MT_VERIFY_NO_COMMAND`；宿主无 `subprocess` 服务 → `MT_UNAVAILABLE`（**不猜、不静默降级**）；超时取「任务声明」与 `config.gates.commandTimeoutMs` 的**更严格者**（K5）；③ `gate:archive` → **不是人工裁决门**：host 按 `deliverableSpec` 约定路径做落位校验（FR-10.4），review 通过后自动推进到 `done`；④ **打回预算**（FR-5.2）：单门 fail 轮数 ≥ `GATE_REJECT_BUDGET`(2) 后队长侧 pass 被拒（`MT_REJECT_BUDGET` → `needs-human`），只有人工 `confirm=true` **且 `reason` 非空**能放行（payload 标 `forcedBy:'human'`，这是唯一不跑命令的出口且留痕）；⑤ 非 `gate:*` 状态 → `MT_VALIDATION`；⑥ **`expectedRevision`（CHG-87 / QA-4 乐观锁）**：可选，给了就先比 `projection.revision` 再碰任何状态，不等 → `MT_REVISION_CONFLICT` + 回显 `currentRevision`，**账本零写入** | `task.gate.result`（+`task.deliverable`，archive 门 pass 时） |
| `myteam_apply_roles`（**CHG-87 新增**，FR-16.1 单角色调用） | `{teamId?, roles:string[], remove?:string[], confirm?}` | `{status:'applied'\|'confirm-required', roles, removed?, sessionDefaultsPath, promptSection, effectiveAt:'next-wake'}` | `/myteam+<id>` 单角色调用的落地工具（**修复的缺陷**：客户端原来只有一个硬编码演示卡 `MyTeamApplyRolesToolView`（假角色名），而本工具**不存在**——UI 展示的是假数据）。`roles` 累加启用、`remove` 卸载；**不入团队账本**（单角色调用不是团队）；两段确认；未知角色 → `MT_ROLE_NOT_FOUND`。落盘 `.team-workplace/config/session-defaults.json`（**不是 `config/roles/`**——`listProjectRoles()` 把 `config/roles/` 下所有 `*.json` 当角色定义读，放这里会让整个角色目录 `MT_ROLE_CORRUPT`）。**诚实告知**：`promptSection` **下次唤醒/重启**才生效（宿主 `systemPrompt.section()` 是会话建立时注册的，运行期改不了，NFR-7.3「系统提示稳定」），不假装即时生效 | 无（单角色调用不进团队账本） |
| `myteam_list_contributions`（**CHG-92 新增**，插件团队贡献契约 v1 §12.1） | `{teamId?}` | `{status, root, ok, scannedAt, plugins[], roles[], teams[], warnings[]}` | 只读 | 无（贡献物是插件资产，**不进账本**） |
| `myteam_reload_contributions`（**CHG-92 新增**） | `{teamId?}` | 同 `myteam_list_contributions` | 只读（重扫 `$DSH_HOME/myteam/plugins/`） | 无 |
| `myteam_reassign_task` | `{teamId, taskId, fromMemberId?, toMemberId?, reason}` | `{attemptId}` | 目标成员角色匹配；先 revoke 旧 attempt | `task.attempt.revoked` `task.assigned` |
| `myteam_revoke_attempt` | `{teamId, taskId, attemptId, reason}` | `{}` | attempt 属于该任务 | `task.attempt.revoked` |
| `myteam_spawn_member` | `{teamId, roleId, instanceName?, skills?, mcpAllowlist?}` | `{memberId, sessionId}` | maxMembers（ADR-008）；角色在项目库；技能/MCP 覆写写入成员身份快照，并在成员 setup 内**硬隔离**（CHG-58：MCP 用 `tools.restrict` deny + 执行期 `guard`；技能用作用域同名占位 provider，`modelInvocable:false`、正文不可读）；allowlist 为空 = 不限制 | `member.spawned`（payload 含 skills/mcpAllowlist，若覆写） |
| `myteam_release_member` | `{teamId, memberId, mode:'suspend'\|'archive'\|'remove', confirm?}` | `{drained:{running, pending}}` | 排空后才报成功（FR-3.11）；remove 两段确认 | `member.released`/`member.archived` |
| `myteam_message` | `{to: memberId\|'inbox', taskId?, content, kind:'assign'\|'steer'\|'notify'}` | `{messageId}` | to 存在 | `message.sent` |
| `myteam_interrupt` | `{memberId, reason}` | `{}` | 成员在跑 | `member.interrupted` |
| `myteam_disband` | `{teamId, confirm: true}` | `{status:'disbanded', impact:{members,tasks}, archive:{dir, relativeDir, files[]}}` / `{status:'confirm-required', impact}` / `{status:'error', code:'MT_ARCHIVE_FAILED', message}` | 全量排空；两段确认。**CHG-86（P0-2）**：旧实现只写一条账本事件、**零文件 IO**（面板归档视图渲染的 `archive/<id>/{team.json,tokens.json,members/,artifacts/,MANIFEST.json}` 永远不存在）。现在先落账本（状态变 `archived`）→ 再按归档态快照写盘（`MANIFEST.json` 最后写 = 完整性判据）→ 最后释放成员；归档写失败返回 `MT_ARCHIVE_FAILED` **不静默** | `team.disbanded` |
| `myteam_resolve_proposal` | `{teamId, proposalId, decision:'approved'\|'rejected', note?}` | `{}` | 提案存在且未处置 | `task.proposal.resolved` |
| `myteam_adopt_knowledge`（CHG-19 补，CHG-34 v2.7 扩） | `{teamId, draftId, decision:'adopted'\|'rejected', note?}` | `{status:'adopted'\|'revised'\|'rejected', entryPath?, diff?, note?}` | 提案存在于账本；adopted 落库带 evidence+contributor 归因（FR-17.4 策展门）；**v2.7**：提案带 `relation:'refine'\|'contradict'` → 走 reviseEntry 演化式修订（refine 清 staleSince / contradict 标 staleSince 待复核），落 `knowledge.revised`；目标条目不存在 → MT_VALIDATION | `knowledge.adopted` / `knowledge.revised`（v2.7） |
| `myteam_create_role`（CHG-53/69） | `{roleId, name, description, systemPrompt, skills?, mcpAllowlist?, interestWords?, toolPolicy?, model?, isCaptain?}`（interestWords ≤8 个、每个 1~16 字；派单软信号，不是权限） | `{status:'created', roleId, filePath}` | 队长专属（create-role 技能）；id 小写/数字/连字符；同名任一来源存在 → `MT_ROLE_EXISTS`（不覆盖）；写项目角色库 | 无（角色库文件，不进账本） |
| `myteam_update_role`（CHG-53/69） | `{roleId, patch:{name?,description?,systemPrompt?,skills?,mcpAllowlist?,interestWords?,toolPolicy?,model?,isCaptain?}}` | `{status:'updated', roleId, version, copiedFrom?}` | 队长专属（modify-role 技能）；项目库缺失但 builtin/global 存在 → 先复制进项目（fork，origin 保留）再 patch；运行中成员用身份快照不受影响 | 无（角色库文件） |
| `myteam_list_presets`（CHG-57） | `{}` | `{status:'ok', dirs, warnings, presets:[{id,name,origin,description,memberCount,members[{roleId,skills?,mcpAllowlist?}],boardColumns?,taskTypes?,readOnly}]}` | 只读；内置 + 项目（全局不存模板，CHG-52） | — |
| `myteam_save_preset`（CHG-57） | `{preset:{id,name,description?,members[{roleId,instanceName?,skills?,mcpAllowlist?}],board?,pipeline?,gates?,taskTypes?}, overwrite?}` | `{status:'created'\|'updated', presetId, version, presetPath}` | 内置 id → `MT_PRESET_BUILTIN`；已存在且 `overwrite!==true` → 两段确认（`MT_PRESET_EXISTS`）；未知角色/空名册/超 6 名 → `MT_VALIDATION`；写 `.team-workplace/config/presets/<id>.json` | 无（配置目录） |
| `myteam_copy_preset`（CHG-57） | `{fromPresetId, toPresetId, name?}` | `{status:'copied', presetId, fromPresetId, presetPath}` | 来源不存在 → `MT_PRESET_NOT_FOUND`；目标为内置 id → `MT_PRESET_BUILTIN`；目标已存在 → `MT_PRESET_EXISTS` | 无 |
| `myteam_delete_preset`（CHG-57） | `{presetId, confirm}` | `{status:'deleted', presetId}` | 内置 → `MT_PRESET_BUILTIN`；`confirm!==true` → 两段确认；不存在 → `MT_PRESET_NOT_FOUND`；已建团队不受影响 | 无 |
| `myteam_reset_team_config`（CHG-57） | `{teamId, confirm}` | `{status:'reset'\|'noop', teamId, configSource}` | `confirm!==true` → 两段确认；删团队级 `team.config.json` 并重建 TeamService 配置缓存（账本/成员不动）；无团队级配置 → noop | 无（配置层） |
| `myteam_participate_task`（CHG-69） | `{teamId, taskId, participantTeamId, role?:'lead'\|'coop', memberIds?:string[]}` | `{status:'participating'}` | 任务存在；participantTeamId 非空；**主责只能是本团队**（跨团队主责需迁移账本，当前不支持）；协作不能是本团队（本团队已是主责） | `task.participate` |
| `myteam_assign_task`（CHG-69） | `{teamId, taskId, memberIds:string[]}` | `{status:'assigned', taskId, memberIds}` | 任务存在；至少 1 名；每个 id 必须在项目投影名册内（未知 → `MT_VALIDATION`）；不改 claim 语义（执行仍按角色 claim，指派只标注「谁负责」） | `task.assigned`（payload 带 memberIds） |
| `myteam_update_team`（CHG-70） | `{teamId, name?, goal?}` | `{status:'updated', teamId, name?, goal?}` | 至少给一个字段；空串 → `MT_VALIDATION`；写 `team.updated`（面板团队头与索引随 commit 刷新） | `team.updated` |
| `myteam_set_project_role`（CHG-69） | `{roleId?, clear?, confirm?}` | `{status:'set'\|'cleared'\|'confirm-required', role?, filePath?}` | 两段确认（先预览后 confirm=true）；roleId 必须存在于内置/全局/项目/项目自身任一角色库；clear 删除 `config/project-role.json` | 无（角色库文件） |
| `myteam_rescope_task`（CHG-73） | `{teamId, taskId, reason, patch?, memberIds?}` | `{status:'rescoped', taskId, state:'ready'\|'backlog', revokedAttempt?, assigned?, changes?}` | reason 必填；终态任务 → `MT_TASK_TERMINAL`；patch 白名单（结构字段允许）；先撤 attempt（`task.attempt.revoked`）再落 `task.rescoped`；依赖未完成 → 回 backlog | `task.attempt.revoked?` `task.rescoped`（+`task.assigned?`） |
| `myteam_cancel_task`（CHG-73/75） | `{teamId, taskId, reason, downstream?:'leave'\|'cancel'\|'rewire', rewireTo?, confirm?}` | `{status:'confirm-required', impact{dependents,hasAttempt,downstream,rewireTo?,directDependents?}}` / `{status:'cancelled', taskId, cancelled[], downstream, rewired?:[{taskId,removed,added?}]}` | reason 必填；终态 → `MT_TASK_TERMINAL`；两段确认；`cancel` 级联下游闭包（逐条事件带 `cascadeFrom`，终态下游跳过）；**`rewire`（CHG-75）把直接下游改挂到 `rewireTo`（不填 = 解除依赖）——改挂非法（新上游不存在/自身/已取消/成环 `MT_TASK_CYCLE`）在取消落账前就拒** | `task.attempt.revoked?` `task.cancelled`（+级联）+ `task.rewired`（每条直接下游一条） |
| `myteam_batch_task_op`（CHG-73/76） | `{teamId, op:'cancel'\|'rescope'\|'assign'\|'priority', taskIds:string[1~50], reason?, memberIds?, priority?, downstream?:'leave'\|'cancel'\|'rewire', rewireTo?, confirm?}` | `{status:'batch-done', batchId, results[{taskId,ok,status?,code?,message?,rewired?,rewireErrors?}], summary{total,ok,failed}}` | 任务必须存在；cancel/rescope 要 reason；assign 要 memberIds；priority ∈ P0~P3；cancel 两段确认（先给 `impact{tasks,dependents,downstream?,rewireTo?,rewireByTask?}`）；**`downstream:'rewire'`（CHG-76）逐任务把直接下游改挂到整批统一的 `rewireTo`（缺省 = 逐条解除依赖）**——批量级前置校验：`rewireTo` 不能是本批要取消的任务、不能已取消/失败，否则整批拒（`MT_VALIDATION`）；逐条独立落账，部分失败不影响其余 | 对应单条事件（同一 `batchId`） |
| `myteam_create_tasks`（CHG-76 / FR-33） | `{teamId, goal?, tasks:[{title, requiredRole, description?, priority?, estimate?, taskType?, acceptanceCriteria?, deliverableSpec?, deps?, after?, assignees?}][1~30], confirm?}` | `{status:'confirm-required', impact{tasks, byRole, rolesMissing, edges, ids, warnings?}}` / `{status:'created', batchId, tasks[{taskId,title}], results[{index,ok,title,taskId?,code?,message?,warnings?}], summary{total,created,failed}, warnings?}` | title/requiredRole 必填；priority ∈ P0~P3；`after` = 本批 1-based 序号（自指/越界/成环 `MT_TASK_CYCLE` 拒绝且不写账本）；`after` 解析成生成后的 taskId，按拓扑序创建；`requiredRole` 必须在名册（预览 `rolesMissing` 预警，创建时该条失败）；缺验收标准补「完成「标题」」、叶子任务缺交付物补 `docs/<taskId>.md`（都进 warnings）；逐条独立落账，一条失败后续依赖它的条目 `MT_DEPENDENCY_FAILED` | `task.created`（每条）+ `task.assigned?` |
| `myteam_delete_role`（CHG-73） | `{roleId, confirm: true}` | `{status:'confirm-required', usage{teams,instances,presets}}` / `{status:'deleted', filePath, auditPath}` | 只删项目库（内置/全局 → `MT_ROLE_BUILTIN`）；captain → `MT_ROLE_CAPTAIN`；被模板/团队在册/项目自身角色占用 → `MT_ROLE_OCCUPIED`（列占用方）；两段确认 + `.audit.jsonl`（action=deleted） | 无（角色库文件 + 审计） |

> **乐观锁 `expectedRevision`（CHG-87 / QA-4，全 Lead 写工具通用可选参数）**：`docs/04 §1.1` 与 §4 错误码表早就承诺 `expectedRevision` / `MT_REVISION_CONFLICT`，但 `plugin/src` 曾**零命中**（契约承诺未兑现）。现已实装：`TeamService.commit({expectedRevision})` **先比版本再碰任何状态**——`projection.revision` = 已应用事件数 = 末事件 seq + 1；不相等 → `MT_REVISION_CONFLICT` 并回显 `currentRevision`，**账本零写入**（不会写进一条不可重放的事件）；坏值（非非负整数）→ `MT_VALIDATION`；缺省 → 不校验（向后兼容，单写者管线下无竞态）。
> **已接线的工具**：`myteam_edit_task` / `myteam_rescope_task` / `myteam_cancel_task` / `myteam_reassign_task` / `myteam_review_task`（host 侧统一走 `commitGuarded`）。面板侧 `updateTask` 透传，`TaskDetailView.revision` 新增（编辑表单打开时快照，保存时回传）。

### 1.2 成员工具（注册在成员 agent 作用域，**9 个，永不可被策略关闭**）

| 工具 | 参数 | 返回 | 校验 | 账本事件 |
|------|------|------|------|----------|
| `myteam_get_task` | `{taskId}` | `{task, myAttemptId?, blocking?}` | NFR-7.6 只答该任务 | — |
| `myteam_list_tasks` | `{filter?: {state?, requiredRole?, priority?}, limit?}` | `{tasks, returnedCount, note}` | NFR-7.6 明示行数≠读了多少 | — |
| `myteam_claim_task` | `{taskId}` | `{attemptId, task}` | FR-11.5 调度条件全满足（原子）；返回 attemptId（FR-4.2） | `task.claimed` |
| `myteam_update_task` | `{taskId, attemptId, status:'in_progress'\|'done'\|'failed', progress?, evidence?: EvidenceBlock, knowledgeDraft?}` | `{status, note?, knowledgeDraftError?, knowledgeHint?, staleMarked?}` | **attemptId 必须当前**（FR-4.3）；done 时 evidence 必填（FR-5.0/ADR-007）；knowledgeDraft 必带证据（缺省=taskId）；**v2.7**：done 附提案时任务 tags 触达知识库条目 → staleSince 写入 + host 给 tags 相交候选（非阻塞提示） | `task.progress` `task.evidence` `task.completed` `task.failed` `knowledge.proposed` |
| `myteam_peer_message` | `{toMemberId, taskId?, content}` | `{messageId}` | 对端存在 | `message.sent` |
| `myteam_wait_for_change` | `{taskId?, timeoutMs?}` | `{changed: bool, cause?: 'assign'\|'message'\|'resume'\|'revoke'}` | NFR-7.7 只返回失效提示不推正文 | — |
| `myteam_propose_task_change` | `{taskId, type:'split'\|'add-dep'\|'reassign'\|'cancel', payload, reason}` | `{proposalId}` | — | `task.proposal` |
| `myteam_escalate_task` | `{taskId, reason, evidence:{attempted, blockedAt}, suggestion?:'rescope'\|'split'\|'abort'}` | `{}` | 任务处于本成员 in_progress attempt | `task.escalated`（立即生效：attempt 撤销+任务入 re-scoping，FR-11.7） |
| `myteam_read_knowledge`（CHG-19 补，CHG-34 v2.7 扩） | `{id}` | `{status, entry:{id, title, tags, unverified, staleSince?, proofCount, body}}` | 索引见提示词；**v2.7**：stale 条目 body 前缀 `[stale 待复核]` 提醒交叉核对 | — |

> 修正说明（已闭环，CHG-16）：PRD v2.3 §6 成员工具缺 claim 入口——已定稿为 **8 个工具**（`myteam_claim_task` 独立），PRD v2.4 §6/FR-3.5 已同步。CHG-34 勘误：T18（CHG-19 波次）实际又加了 `myteam_read_knowledge`，成员工具现为 **9 个**（源码权威：`plugin/src/tools/defs.ts` memberToolDefs）。

### 1.2b 成员记忆区（memory.md + notes/，FR-6.1~6.2，T19~T21）

> 定位（三层记忆模型）：成员私有记忆 = 候选池，团队知识库 = 策展后正典；成员在任务中学到的东西先落自己的 memory，被确认为团队级理解的经 knowledgeDraft 提案沉淀进知识库（FR-17.4）。

**落盘**：`state/teams/<teamId>/members/<memberId>/memory/`（成员私有，**不入库**，gitignore 托管块已忽略 state/）：

```
memory/
  memory.md          ← 记忆主文件（frontmatter 归因头 + 自由正文/条目列表）
  notes/             ← 结构化笔记（成员自建子文件，R26：宿主不预创建）
```

**memory.md 种子模板**（spawn 时由 host 进程 fs 创建，幂等；已存在不覆盖——记忆跨会话不重置 FR-6.1）：

```markdown
---
member: m1-implementer
role: implementer
team: <teamId>
evidence: none
updated: 2026-10-25T16:00:00+08:00
---

# 私有记忆

（此文件是你的私有记忆区，跨会话保留。记录任务中学到的项目背景、踩坑、口径。
写入纪律见系统提示词：每条记忆必带证据指针。）
```

**写入纪律（FR-追忆-2）**：成员写 memory.md/notes/ 必须带证据指针（taskId / 账本 seq / 文件路径）；`memory.evidenceRequired=true`（默认）时无证据条目**不拦截写入**（宿主 write 工具不可拦截，诚实声明不拦截）——改为**事后审计**（同 FR-5.4 取向）：

| 检查点 | 动作 |
|---|--- |
| 任务收口（completed/failed 提交后，同一 actor 视角） | host 扫该成员 memory/ 下全部 .md，解析 frontmatter 的 `evidence:` 键：缺失或 `none` → 记违规 |
| `memory.audit` 账本事件 | `{teamId, memberId, taskId?, findings:[{file, entry?, reason:'missing-evidence'\|'empty-evidence'}], checkedFiles, violations}`（fold 跳过，统计面消费） |
| 释放前（release scan） | release 时同样扫描一次并落事件（防止任务外写入漏审） |

**审计解析规则**：frontmatter `evidence: <指针>` 为键必须存在（种子模板含 `evidence: none` 种子头不算违规——主文件条目以正文 `## <条目>` 二级节为条目单位，条目头紧跟 `evidence: <指针>` 行；无二级节则整文件按单条目审计）条目级 evidence 优先于 frontmatter 级。

**归因（FR-6.3 数据部分）**：frontmatter 的 member/role/team + `updated` 由提示词要求成员自行维护；面板读取计数 M2（UI 不做）。

### 1.2c 记忆写入纪律 section（提示词层，FR-6.2/6.4，T20）

成员系统提示词新增 `myteam:memory-<memberId>` section（order 103）：

```
私有记忆区：<memoryDir>（memory.md + notes/；跨会话保留，重启不重置）。
写入纪律：
1. 每条记忆必须带证据指针（taskId / 账本 seq / 文件路径），写在条目标题下一行：evidence: <指针>。
2. memory.evidenceRequired 开启时，无证据的记忆会被 host 审计并落账本（memory.audit 事件），队长可见。
3. 学到团队级知识（别的成员也需要的背景/坑/口径）：不要只写私有记忆——在 update_task done 申报附 knowledgeDraft 提案沉淀进团队知识库。
交接纪律（FR-6.4）：
4. 你是同一身份的延续（sessionId 不变），不存在"上一代"——不要宣告交接、不要写"接替上代"、不要生成 handoff 摘要；直接读 memory.md 与账本即可恢复工作状态。
```

> 设计说明（FR-6.4 的机理，E6 反坑）：模型被告知"交接"会执行交接动作（写 handoff envelope、宣告"我是新一代"）而非读记忆恢复；对策是**正面陈述身份连续性**（"你是延续，不存在上一代"）+ 显式禁止清单。

### 1.2d 知识条目模型（config/knowledge/<id>.md + index.json，FR-17.1~17.5，v2.7/CHG-34）

```yaml
---
id: db-schema-users            # [a-z0-9][a-z0-9-]{1,63}
title: 用户域数据模型
tags: [database, core]         # 行内数组或多行 - item 列表
audience: [dev, qa]            # 空 = 全员可见（spawn 索引按成员 roleId 软过滤）
evidence: task-k1              # 单指针行内；多指针用多行列表（v2.7）：evidence: + "  - <p>"
contributor: m1                # 采纳归因（adoptDraft 写入）
proofCount: 2                  # ≥evidence.length；演化修订取 max
updated: 2026-10-28
core: false                    # core 小集排索引前
staleSince: 2026-10-27         # v2.7：staleness 标（touchStale 写入；refine 复核后清除；'null'/缺省 = 无）
---
正文……

## 演化                        # v2.7：reviseEntry 幂等追加的修订轨迹节（账本 knowledge.revised 为权威流）

- 2026-10-28 · m1 · refine · 证据 task-k9：精炼用户域模型
- 2026-10-29 · m3 · contradict · 证据 task-k11：矛盾：…   # contradict 不改写原断言，只标 staleSince 待复核
```

判定与派生（源码权威：`plugin/src/core/knowledge/knowledge.ts`）：缺 evidence → `unverified: true`、proofCount=0；提案校验 `validateDraft`（relation ∈ new|refine|contradict；refine/contradict 需合法 targetId → `MT_KB_TARGET_REQUIRED`）；`adoptDraft` 拒绝 refine/contradict（`MT_KB_RELATION_MISMATCH`，走 reviseEntry）；`touchStale`（任务 tags × 条目 tags 交集 → staleSince）；`candidatesForDraft`（host 给 tags 相交候选，人定夺关系）；`renderIndexSection(index, {audience})` 徽标优先级 `[core] > [unverified] > [stale 待复核]`，≤40 行预算（indexBudget 可调）。

### 1.2e 成员能力隔离（CHG-58，运行时硬约束）

生效来源：`resolveCapabilities(role, member)` —— 成员 `skills/mcpAllowlist` 非空优先，否则回退角色声明；都为空 = **不启用隔离**。

| 能力 | 通道 | 语义 |
|------|------|------|
| MCP | `tools.restrict({deny:[mcp__<server>__*]})` | allowlist 之外的 server 工具在该 agent 作用域不可见（`get/schemas/dispatch` 全走同一 view） |
| MCP（兜底） | `tools.guard(exec => ...)` | 按 `exec.name` 实时拒绝；覆盖 setup 之后才连上的 server；`tools/change` 时增量补 deny |
| 技能 | 作用域同名占位 provider | allowlist 之外、当前可见的技能 → `modelInvocable:false,userInvocable:false`，`get` 返回 `undefined`；模型目录、skill 工具、`/name` 注入三处同时挡住；`skills/change` 动态刷新 |

边界：隔离失败只告警不阻断上岗；技能侧依赖"就近层同名覆盖"（非官方 deny 语义，宿主升级需回归）；面板/调试列表可能仍显示被屏蔽技能的名字。

### 1.3 证据块结构（EvidenceBlock，ADR-007）

```jsonc
{
  "kind": "commands",            // 或 "na"
  "commands": [                  // kind=commands 时必填 ≥1
    { "cmd": "pnpm test", "exitCode": 0, "assertions": 12, "durationMs": 3400,
      "filesTouched": ["plugin/src/host.ts", "plugin/test/t71-m2-remaining.test.ts"] }  // CHG-87 / FR-5.4：本次命令碰过的文件（scope 审计输入）
  ],
  "na": { "reason": "纯文档任务无可执行验证" }   // kind=na 时必填
}
```
校验：done 申报缺 evidence → 工具拒绝（硬）；kind=na 缺 reason → 拒绝。账本 `task.evidence` 事件 payload 存原始结构。**CHG-87**：`commands[].filesTouched` 是可选数组，**只算当前 attempt 的证据**（历史 attempt 的文件不算这次交付），供 §1.3c 的 scope 审计消费。

### 1.3b verify 门执行结果（`gate:verify`，CHG-87 / FR-5.3）

`gate:verify` **不是人工裁决门**——host 真跑任务声明的命令，用退出码定 verdict。`task.gate.result` 的 payload：

```jsonc
{
  "taskId": "task-3", "gate": "verify", "verdict": "pass",
  "command": { "argv": ["pnpm", "test"], "cwd": "plugin" },   // argv 数组直传，无 shell 解释
  "exitCode": 0, "signal": null, "durationMs": 4210,
  "outputTail": "…尾部 2000 字符…",                            // 截断时前置 "…[truncated N chars]…"
  "executedBy": "host",
  "forcedBy": "human"                                          // 仅人工强制放行时出现
}
```

| 情形 | 结果 |
|---|---|
| exitCode === 0 | verdict `pass` |
| exitCode ≠ 0 / 被信号杀 | verdict `fail`（打回预算 +1） |
| 任务没声明 `verifyCommand` | `MT_VERIFY_NO_COMMAND`（**不猜一个默认命令**） |
| 宿主没有 `subprocess` 服务 | `MT_UNAVAILABLE`（**不静默降级成人工裁决**） |
| 超时 | 任务声明与 `config.gates.commandTimeoutMs` **取更严格者**（K5） |
| 人工强制放行 | 仅 `actor='human'` + `confirm=true` + `reason` 非空；payload 标 `forcedBy:'human'`（唯一不跑命令的出口，且留痕） |

> 源码权威：`plugin/src/core/gates/command-gate.ts`（`validateVerifyCommand` / `classifyVerifyResult` / `truncateOutput` / `resolveTimeoutMs` / `runVerifyCommand`；适配注入的 `ctx.subprocess`，形状兼容 `handle.done()` / `handle.done` Promise / thenable）。

### 1.3d 门禁结论可信度（`TaskProjection.gateResults`，CHG-93）

`task.gate.result` 折叠进投影时同时记下**谁执行的 / 是否人工强制放行**：

```ts
gateResults?: Record<string, {
  verdict: 'pass' | 'fail'
  executedBy?: string   // 'host' = 宿主 subprocess 真跑了命令（按退出码判定）
  forcedBy?: string    // 'human' = 打回预算用尽后人工确认放行
  exitCode?: number | null
  at: number            // 裁决时刻（面板排序）
}>
```

**为什么必须上屏**：这两个字段**账本里一直有、界面一直没画**——等于「可审计但看不见」。
而它们直接决定结论可信度：`executedBy:'host'` 是「真跑了」，`forcedBy:'human'` 是「人越预算硬放」。
面板渲染为绿色「宿主执行」/ 黄色「人工强制放行」chip。

### 1.3e 团队章程注入（CHG-93 / FR-18 职责③ F8）

`core/host/team-charter.ts` 是 `.team-workplace/structure.md` 的**唯一读取方**：

- `readTeamCharter(workspaceRoot)` → `{ text, path, truncated, bytes }`（纯函数，可单测）；
- 注入方式：`systemPrompt.variable('myteam_team_charter', () => readTeamCharter(...).text)`
  + `systemPrompt.section({ name:'myteam:team-charter', order:610, text:'{{myteam_team_charter}}' })`；
- **为什么用 variable 而不是静态 section**：静态 section 是**会话建立时**取值（NFR-7.3 系统提示稳定），
  改章程要重启；variable 的 provider **每次组装求值** → 改了下一次请求生效；
- 宿主无 `variable` API 时**降级为静态注入并如实告知**（改动下次重启生效，不假装即时生效）；
- 边界：**章程是给模型看的约定，不是权限**——不改 `toolPolicy`、不绕门禁；
  文件缺失是合法状态（新项目首次启动就是空的），不注册 section、不阻断会话建立；
- 上限 64 KiB（≈16k tokens）并显式标注截断——一份 100KB 章程会把 system prompt 挤爆，比没有更糟。

### 1.3f 会话索引（`HandoffSummaryMetadata.sessionIndex`，CHG-94 / FR-16.4①）

```ts
interface HandoffSessionRef {
  sessionId: string                        // 写成 `session:<id>` 即为合法证据指针
  kind: 'captain' | 'member'
  title: string
  taskId?: string; memberId?: string; roleId?: string
}
```

**为什么是索引不是摘要**：FR-16.3 否决原地变身的两条理由里，第二条是「旧会话历史整段混进队长上下文
→ 模型按旧上下文继续干活」。摘要虽已截断，但**截断仍是内容**。索引只给 `session:<id>` 指针，
新队长需要时按需深读（读取留痕 `session.read`）。

四条不变量：队长会话**永远排第一** · **没有 `sessionId` 的成员不进索引**（编造 id 比没有更糟）·
**去重** · **有界**（`HANDOFF_SESSION_INDEX_LIMIT = 20`）。摘要里明确写「**未深读的内容不在你的上下文里**」——
不写这句模型会以为已经给全了。
### 1.3c scope 完成审计（`TaskProjection.scopeAudit`，CHG-87 / FR-5.4）

任务声明 `writeScopes`，完成时把「实际写事件」对照声明做越界审计。

```jsonc
// TaskProjection.scopeAudit / TaskDetailView.scopeAudit / BoardTaskView.scopeAudit
{ "declared": true, "writeScopes": ["plugin/src/**", "plugin/test/**"],
  "outOfScope": ["docs/09-变更记录.md"], "ok": false, "checkedAt": 1762350000000 }
```

| 语义 | 说明 |
|---|---|
| 未声明 `writeScopes` | **不审计**（`declared:false`）——**不是**「全部越界」 |
| 越界 | **只留痕不阻断交付**（FR-5.4 原文：诚实声明不拦截 bash；阻断只会 incentive 少报） |
| 证据范围 | 只算**当前 attempt** 的 `filesTouched`（历史 attempt 的文件不算这次交付） |
| 配置开关 | `team.config.json` 的 `audit.writeScopes`（默认 **true**） |

> 源码权威：`plugin/src/core/gates/scope-audit.ts`（`auditWriteScopes` / `matchesScope` / `normalizeScopePath` / `filesTouchedOf`；类型 `ScopeAudit{declared,writeScopes,outOfScope,ok,checkedAt}`）。

### 1.4 任务输入结构（TaskInput，FR-11.1）

```jsonc
{
  "title": "实现账本投影折叠", "description": "…",
  "acceptanceCriteria": ["…"],       // ≥1，host 拒绝空
  "deliverableSpec": {                // 叶子任务必填
    "path": "docs/myteam/…", "producer": "…", "reviewer": "…", "archiver": "…"
  },
  "deps": ["task-2"],                 // 引用存在 + 无环（拓扑校验）
  "requiredRole": "researcher",       // 名册内
  "taskType": "dev",                  // config taskTypes 键，缺省 default
  "gateChain": ["review","verify","archive"],  // 缺省按 taskType 展开
  "priority": "P2",                   // P0~P3
  "estimate": "M",                    // S/M/L 可选
  "tags": ["database", "perf"],       // v2.7（CHG-34）：主题标签，任务 done 时用于知识库 staleness 触达（FR-17.2）
  "writeScopes": ["plugin/src/**"],   // CHG-87（FR-5.4）：声明的写入范围（glob），完成时做 scope 审计；缺省 = 不审计
  "verifyCommand": {                  // CHG-87（FR-5.3）：gate:verify 要执行的命令
    "argv": ["pnpm", "test"],         // argv 数组直传，**无 shell 解释**
    "cwd": "plugin",                  // 可选，相对工作区根
    "timeoutMs": 300000               // 可选，与 config.gates.commandTimeoutMs 取更严格者
  }
}
```

## 2. 面板 Remote 契约（client ↔ host，ctx.remote.myteam.*）

| 方法 | 语义 | 读/写 |
|------|------|-------|
| `listTeams()` | **全局视图发现（CHG-45）**：存活队长会话（`online:true`，带 sessionId/name/workspaceRoot/goal/state/members/counts；name 来自 `team.created.name`，旧账本为空时面板回落 teamId，CHG-62）+ 跨工作区离线索引 `$DSH_HOME/myteam/workspaces.json`（`online:false`，sessionId=''，带 updatedAt）。用于面板常驻全局列表与角色↔团队关系视图 | 读（会话 + 派生索引） |
| `getProject({workspaceRoot})` | **项目聚合（CHG-69）**：面板「项目」作用域的数据面。在线团队走隔离服务 `getBoard`，离线团队折叠账本，索引缺失时扫 `<ws>/.team-workplace/state/teams` 补齐；角色目录直接读文件（不需会话）。返回 `{status:'ok', workspaceRoot, teams[{teamId,name,state,goal,online,sessionId?,members,counts}], tasks[{key,ownerTeamId,ownerTeamName?,ownerOnline,ownerSessionId?,…BoardTaskView}], graph{levels,edges,roots,cyclic}, roles[RoleCatalogView], projectRole?, counts, warnings}`。**无 agent 首参**：网关 args 只允许 `{query}`。**CHG-73**：`roles[].canDelete`（仅 project + 无在册成员 + 未被模板引用）、`tasks[]` 继承看板的 `actions`/`evidenceStale`/`cancelled`。**CHG-74**：`roles[].shadowedBy`（同名副本被更高优先级来源压过时标注谁让位；目录**不隐藏**任何一份，隐藏会让人以为自己的角色丢了） | 读（会话 + 账本 + 配置目录） |
| `getRoleDetail({workspaceRoot, roleId})` | **角色详情（CHG-69）**：定义全文（含 systemPrompt）+ 技能/MCP/兴趣词/模型 + 跨团队在册情况 `memberships[{teamId,teamName?,instanceName,status,online}]` + `usage{teams,instances}`；角色不存在 → `MT_ROLE_NOT_FOUND`。**CHG-74**：同名副本（内置/全局/项目库同一 id）时返回**生效的那份**（优先级 project > project-role > global > builtin，运行时真相恒为项目库），并附 `shadowed:[origin…]`（被它让位的同名来源）与 `editable:boolean`（项目库那份可直接编辑，其余是"复制到项目再改"） | 读（角色库 + 团队投影） |
| `getOfflineBoard({workspaceRoot, teamId})` | **离线只读看板（CHG-46）**：不依赖队长会话，读 `<workspaceRoot>/.team-workplace/state/teams/<teamId>/ledger.jsonl` → 坏行/坏事件容错折叠 → 与 `getBoard` 同构的 `board`。返回 `{status:'ok', readOnly:true, online:false, board, config, meta:{updatedAt,lastSeq,badLines,skippedEvents,degraded}}`（**CHG-62**：`config` = 项目层 + 团队层合并后的配置载荷，来源链与 `getConfig` 同构，离线设置页直接渲染）；空账本 `status:'empty'`；参数非法返回 `MT_VALIDATION`（workspaceRoot 必须绝对路径、teamId 白名单，防目录穿越）。**无 agent 首参**：网关 args 只允许 `{query}`（`assertExactArguments`） | 读（账本文件） |
| `saveRole({workspaceRoot, role, confirm?})` | **角色保存（CHG-72，ADR-006 R1）**：配置资产写 `config/roles/<id>.json`（不进账本）。校验与工具链同源（`assertValidRole`：id 规则/提示词非空/兴趣词≤8/工具策略只能收窄）；同名已存在且 `confirm!==true` → `{status:'confirm-required', existing:{id,name,version}}`；`confirm:true` 覆盖。captain 是内置身份，禁止被项目角色覆盖。每次写入追加 `config/roles/.audit.jsonl`（ts/actor/action/roleId/file）。返回 `{status:'saved', action:'created'\|'updated', filePath, auditPath}`；参数非法 → `MT_VALIDATION`，角色非法 → `MT_ROLE_INVALID` | 写（配置资产 + 审计） |
| `createTask({teamId, task, taskId?, assignees?, participants?})` | **面板新建任务（CHG-72/73）**：经隔离服务复用 `myteam_create_task` 同一条管线（domain 校验 + `task.created`），`actor=human`；teamId 缺省时按最近账本解析。**CHG-73**：`assignees[]` / `participants[{teamId,memberIds?,role?}]` 一次写入——创建后同管线补写 `task.assigned` / `task.participate`，关系写失败只回 `warnings`（任务不回滚）。返回 `{status:'created', taskId, assigned?, participants?, warnings?}`。离线团队无会话 → unavailable | 写→账本（actor=human） |
| `updateTask({teamId, taskId, patch, rescope?})` | **面板编辑任务（CHG-72/73）**：`patch` 白名单同 `myteam_edit_task`（**CHG-86 改名**，原 `myteam_update_task`）；普通编辑落 `task.updated`（**CHG-73**：载荷带字段级 `changes[{field,from,to}]`，返回同样回显），`rescope:{reason}` 走一键重规划管线。执行中改结构字段 → `MT_TASK_STRUCTURAL_EDIT`（面板出口：保存并重新规划 / 只保存元数据） | 写→账本（actor=human） |
| `assignTask({teamId, taskId, memberIds})` | **面板指派负责队员（CHG-72）**：落 `task.assigned`（多选）；语义仍是「标注」，执行按角色 claim 不变 | 写→账本（actor=human） |
| `participateTask({teamId, taskId, participantTeamId, role?, memberIds?})` | **面板登记协作团队（CHG-72）**：落 `task.participate`；主责固定为本团队，协作不能是自己；`memberIds` 为空 = 只建立关系 | 写→账本（actor=human） |
| `rescopeTask({teamId, taskId, reason, patch?, memberIds?})` | **一键重新规划（CHG-73）**：撤当前 attempt（若有，落 `task.attempt.revoked`）→ 带补丁落 `task.rescoped` → 任务回 `ready`（新依赖未完成则 `backlog`）→ 可选重派（`task.assigned`）。`reason` 必填；终态任务 → `MT_TASK_TERMINAL`；返回 `{status:'rescoped', taskId, state, revokedAttempt?, assigned?, changes?}` | 写→账本（actor=human） |
| `cancelTask({teamId, taskId, reason, downstream?, rewireTo?, confirm?})` | **取消任务（CHG-73/75）**：不带 confirm → `{status:'confirm-required', impact:{dependents,hasAttempt,downstream,rewireTo?,directDependents?}}`；带 confirm → 先撤 attempt 再落 `task.cancelled`；`downstream:'leave'`（默认）只停本任务、`'cancel'` 级联取消下游闭包（逐条事件带 `cascadeFrom`）、**`'rewire'`（CHG-75）把直接下游改挂到 `rewireTo`**（不填 = 解除依赖让下游变独立任务；逐条落 `task.rewired`）。返回 `{status:'cancelled', taskId, cancelled[], downstream, rewired?:[{taskId,removed,added?}]}`；改挂非法（不存在/自身/已取消/成环 `MT_TASK_CYCLE`）**在取消落账前就被拒**（不留半吊子状态） | 写→账本（actor=human） |
| `batchTaskOp({teamId, op, taskIds, reason?, memberIds?, priority?, downstream?, rewireTo?, confirm?})` | **批量编排（CHG-73/76）**：`op ∈ cancel/rescope/assign/priority`；逐条独立落账（同一 `batchId`），个别失败不影响其余；`cancel` 需两段确认（先返回 `impact{tasks,dependents,downstream?,rewireTo?,rewireByTask?}`）；**CHG-76**：`downstream:'rewire'` 逐任务把直接下游改挂到整批统一的 `rewireTo`（缺省 = 逐条解除依赖），`rewireTo` 是本批要取消的任务 / 已取消 → 整批 `MT_VALIDATION`；返回 `{status:'batch-done', batchId, results[{taskId,ok,status?,code?,message?,rewired?,rewireErrors?}], summary{total,ok,failed}}` | 写→账本（actor=human） |
| `createTasks({teamId, goal?, tasks[], confirm?})` | **批量建任务（CHG-76 / FR-33）**：草稿列表（1~30）→ 不带 confirm 返回 `{status:'confirm-required', impact{tasks,byRole,rolesMissing,edges,ids,warnings?}}` → 带 confirm 逐条落 `task.created`（同一 `batchId`）；`after` 用本批 1-based 序号声明批内依赖，按拓扑序创建（自指/越界/成环 `MT_TASK_CYCLE` 且不写账本）；缺验收标准/叶子缺交付物自动补齐并进 `warnings`；返回 `{status:'created', batchId, tasks[{taskId,title}], results[{index,ok,title,taskId?,code?,message?,warnings?}], summary{total,created,failed}}`；依赖失败条目后续 `MT_DEPENDENCY_FAILED` | 写→账本（actor=human） |
| `deleteRole({workspaceRoot, roleId, confirm?})` | **删除项目角色（CHG-73，C7 守门）**：只能删项目库（内置/全局 → `MT_ROLE_BUILTIN`），captain → `MT_ROLE_CAPTAIN`；被模板/团队在册/项目自身角色占用 → `MT_ROLE_OCCUPIED`（`usage{bindings}` 给占用方）；两段确认（先返回 `usage{teams,instances,presets}`）；删除后追加 `.audit.jsonl`（action=deleted）。返回 `{status:'deleted', roleId, filePath, auditPath}` | 写（配置资产 + 审计） |
| `getCapabilityCatalog({workspaceRoot})` | **角色表单候选（CHG-73）**：`skills[{name,source:'host'\|'role'}]`（宿主 skills 服务 + 已有角色声明）、`mcp[{name,source}]`（工具表 `mcp__<server>__*` 推导 + 角色声明）、`warnings[]`。**是提示不是白名单**：允许输入目录外的名字 | 读（宿主服务 + 角色库，降级不报错） |
| `getOfflineTaskDetail({workspaceRoot, teamId, taskId})` | 离线任务详情：时间线 / 证据块 / 交付物 / 门禁链与裁决 / 沟通消息从账本复原（`readOnly:true`）；任务不存在或账本为空 → `MT_VALIDATION` | 读（账本文件） |
| `getOfflineTokens({workspaceRoot, teamId})` | **离线成本（CHG-47）**：直接读团队目录 `tokens.json` 侧车（无会话也可看四桶）；返回与 `getTokens` 同构的视图（`source:'tokenMeter'`、`caliber:'heuristic'`、`nonBillable:true`）；侧车缺失/损坏 → `status:'empty'` | 读（侧车文件） |
| `getOfflineAudit({workspaceRoot, teamId, limit?, beforeSeq?})` | **离线审计（CHG-49）**：账本事件流新→旧分页（归档回放）；返回 `{status:'ok', readOnly:true, total, events:[{seq,ts,actor,type,taskId?}], nextBeforeSeq}`；参数非法 → `MT_VALIDATION` | 读（账本文件） |
| `getOfflinePresets({workspaceRoot, teamId})` | **离线开箱团队（CHG-50）**：与在线同一 loader 读三层目录（`builtin` 代码内置 / `global` `<ws>/../.dsh/myteam/presets` / `project` `<ws>/.team-workplace/config/presets`），返回 `{status:'ok', readOnly:true, entries, warnings, dirs}`；团队 id 仅用于路径安全校验 | 读（配置目录） |
| `disband(teamId, confirm?)` | 解散两段确认：`confirm:false` → `{status:'confirm-required', impact:{members,tasks}}`；`confirm:true` → 落 `team.disbanded` **并真的写归档文件**（**CHG-86 / P0-2**：返回 `archive:{dir, relativeDir, files[]}`，写失败 → `MT_ARCHIVE_FAILED`） | 写→账本 + 文件 |
| `reviewTask({teamId?, taskId, verdict:'pass'\|'fail', reviewerMemberId?, reason?, confirm?})` | **门禁裁决（CHG-86 / M2-C，FR-5.1~5.2）**：面板任务详情「门禁裁决」区的唯一写入口，与队长工具 `myteam_review_task` 同一条管线（`actor:'human'`）。review/verify 门强制交叉审查（`reviewerMemberId` 必填且 ≠ 实现者）；archive 门由 host 落位校验；`confirm:true` 是打回预算超限后的人工放行开关 | 写→账本（actor=human） |
| `getArchive({teamId?})` | **归档快照（CHG-86 / P0-2）**：面板归档回放视图的读面，返回 `{status:'ok', teamId, archive:{version,teamId,name,goal,state,archivedAt,archivedBy,ledgerPath,eventCount,revision,members[],tasks[],artifacts[],tokens}, root}`；未归档 → `archive:null`（按"未归档"渲染，不猜半个快照） | 读（`.team-workplace/archive/<id>/`） |
| `getArchives()` | 已归档团队 id 清单（面板「全部团队」入口）：`{status:'ok', root, teams[]}` | 读（归档目录名） |
| `adoptKnowledge({teamId?, draftId, decision:'adopted'\|'rejected', note?})` | **知识提案策展（CHG-86 / P1-9，FR-17.4）**：面板「采纳 / 驳回」按钮的写路径（`actor:'human'`），与队长工具 `myteam_adopt_knowledge` 同一条管线。修复前 UI 只写"由队长执行"、面板没有任何写路径 | 写→账本 + 知识库文件 |
| `getBoard(teamId, view)` | 看板/泳道/DAG 三视图数据（同源投影）。**board 字段（CHG-62/69/72/73）**：`teamId/name?/state/goal/members[]/columns[{name,tasks[]}]/inboxCount/proposalCount/revision/graph{levels,edges,roots,cyclic}`；每个 task 含 `id/title/state/priority/assignee?/assignees?/requiredRole/deps/gates/gateVerdicts/evidenceCount/participants[{teamId,role,memberIds}]/diagnosis?{codes,roleId,roleMembers,depsPending?,depsCancelled?,busyMembers?,fix?{assignable?,roleSwap?,spawnRole?}}/actions{rescope,cancel,edit}/evidenceStale?{since,fields}/cancelled?{ts,reason}`（**CHG-72**：诊断 `codes` ∈ team-inactive/deps-pending/no-role/role-busy；**CHG-73**：`dep-cancelled` + 动作可用性 + 证据过期 + 取消留痕；**CHG-76**：`fix` 给一键修复候选——`assignable[{memberId,instanceName}]` 同角色空闲、`roleSwap[{roleId,idleMembers}]` 其它角色空闲、`spawnRole` 建议召唤，只在 codes 含 no-role/role-busy/deps-pending 时出现）；旧账本无参与事件时 participants 回落 `[{teamId(owner),role:'lead'}]` | 读 |
| `getTaskDetail(teamId, taskId)` | 时间线 + 沟通区 + 证据块 + 交付物 + 门禁链/逐门裁决（FR-8.1/12.2，CHG-47）。**CHG-69**：增 `participants[]` / `assignees[]`（参与团队与多队员负责）。**CHG-63**：`evidenceRefs[{seq, evidence, attemptId?}]`（attemptId 取自 `task.evidence` 事件载荷，旧账本缺失时前端归入「—」组），面板按 attempt 分组渲染命令与退出码。**CHG-73**：增 `actions{rescope,cancel,edit}` / `evidenceStale?{since,fields,evidenceSeq?}` / `edits[{seq,ts,actor,reason?,changes[]}]`（新→旧 20 条，来自 `task.updated`/`task.rescoped` 载荷）/ `cancellation?{ts,reason,downstream}` | 读 |
| `getPresets()` | **开箱团队（CHG-50/51）**：三层只读目录（`entries[{origin,definition,filePath?,warnings}]` + 目录路径 + 读取告警）。定义 = **标准队长（隐式，myteam-captain）+ 队员列表（roleId/instanceName/skills/mcpAllowlist）** + 看板列 + 泳道 + 门禁链 + 任务类型；创建团队仍走团队模式会话，本端点不写盘 | 读（配置目录） |
| `getRoles()` | 角色 tab 三来源卡片 + 引用计数（FR-13.1） | 读 |
| `getKnowledge(teamId?)` | 知识 tab：条目全量（badge 面 core/unverified/stale + proofCount + evidence + contributor）+ 各团队待审提案（relation/targetId/proposedBy）+ 条目演化时间线（knowledge.revised 账本流）。**CHG-35（M2-0b）**：`host.buildKnowledgeView(workspaceRoot)` 纯读投影；提案=各团队账本 `knowledge.proposed` 减已裁决（`knowledge.adopted` 同 draftId，含 rejected） | 读 |
| `getTokens(teamId)` | 侧车四桶 + 命中率 + **来源标注**（`source:'tokenMeter'`/`caliber:'heuristic'`/`nonBillable:true`，REV-5） | 读 |
| `getAudit(teamId?, limit?, beforeSeq?)` | **审计页（FR-12.5，CHG-49）**：账本事件流新→旧分页（`buildAuditView` 纯函数）；`limit` 1~500（默认 100），`beforeSeq` 为上一页 `nextBeforeSeq`；返回 `{status:'ok', total, events, nextBeforeSeq}` | 读（账本） |
| `getConfig(teamId?)` | **设置页（FR-14.3，CHG-49/55/56）**：生效配置（看板/流水线/视图/限制/门禁/任务类型/澄清/记忆）+ `source:'default'\|'project'\|'team'` + 合并链 `default ‹ project ‹ team` + `warnings`；`project` = 项目级 `.team-workplace/config/team.config.json`，`team` = 建团模板落盘的团队级配置 | 读（服务配置） |
| `getInbox(teamId)` | 人工待办（审批横幅/escalate 提醒/提案队列 badge） | 读 |
| `postComment(teamId, taskId, content)` | 人留言（写账本 actor=human，FR-12.2） | 写→账本 |
| `planAction(teamId, action:'approve'\|'revise'\|'discard')` | 人审三动作（写账本） | 写→账本 |
| `memberOp(teamId, memberId, op:'suspend'\|'archive'\|'remove'\|'restore', confirm?)` | 成员管理（FR-14.2，**CHG-48 已实装**）：写 `member.released`/`member.archived`/`member.restored`（actor=human）；`remove` 两段确认（confirm:false → `confirm-required`）；`restore` 仅允许 suspended/archived；成员仍有在跑任务 → `MT_DRAIN_PENDING`；已处于目标态/未知 op → `MT_VALIDATION` | 写→账本 |
| `roleOp({workspaceRoot, op, payload})` | **角色库写操作统一入口（CHG-87 实装，FR-13.1）**：修复「§2 列了 `roleOp(op, payload)`、实现只有 `saveRole`/`deleteRole`」的**文档承诺与实现分叉**。`op ∈ save` / `delete` / `publish` / `fork`，host 侧（`MyTeamHost.roleOp`，用插件配置解析的角色库路径）与面板侧（`MyTeamPanelFacade.roleOp`，用 `projectRolePaths(workspaceRoot)`）**共用同一份实现**（`core/roles/role-ops.ts`），离线团队（无活动会话）也能改角色库——角色是配置资产，不需要会话。① `save` = 新建/覆盖（同名 `confirm` 两段确认）；② `delete` = 只删项目库，C7 占用面（`bindings`）拒绝并列占用方，captain → `MT_ROLE_CAPTAIN`；③ `publish` = 项目库角色 → 全局库（`~/.dsh/myteam/roles/`），两段确认，captain 拒绝；④ `fork` = 任意来源复制成新 id（同名 → `MT_ROLE_EXISTS`）。参数非法 → `MT_VALIDATION`；角色不存在 → `MT_ROLE_NOT_FOUND` | 写→角色库 |
| `applyRoles({teamId?, roles, remove?, confirm?})` | **单角色调用（CHG-87 实装，FR-16.1）**：`/myteam+<id>` 的落地端，与队长工具 `myteam_apply_roles` 同一条管线。累加启用 / `remove` 卸载；**不入团队账本**；两段确认；未知角色 → `MT_ROLE_NOT_FOUND`。返回 `{status, roles, removed?, sessionDefaultsPath, promptSection, effectiveAt:'next-wake'}`——`promptSection` **下次唤醒/重启**才生效（宿主 `systemPrompt.section()` 会话建立时注册，运行期改不了，NFR-7.3）。**离线团队无会话可注入 → `MT_UNAVAILABLE`**（不假装成功） | 写（配置资产，非账本） |
| `getContributions({workspaceRoot})` | **插件贡献只读视图（CHG-92 实装，docs/16 §12.1）**：第三方插件贡献进全局团队库的角色与团队模板。**根级**（只收 query，离线团队也能看）。返回 `{status, root, ok, scannedAt, plugins[], roles[{id,name,origin}], teams[{id,name,namespace,members}], warnings[]}`——列表**不带 `systemPrompt`**（面板不需要，避免上千字正文）；`warnings[]` 每条带 `code` + 中文修法（P4 大声）。 |
| `reloadContributions({workspaceRoot})` | **显式重载（CHG-92）**：插件装/卸后不必重启宿主。清缓存重扫，返回与 `getContributions` 同构。**只读**：不写任何文件、不写账本。 |

> **契约勘误（CHG-93 裁决）：`getWorkspaceState()` 不实装。**
>
> 这条端点曾列在本表（CHG-16 订立），但 `plugin/src` 与 `plugin/client` **全量零命中**——文档承诺、代码不存在。
> 同数据由**非网关通道** `MyTeamRemote.describe()` 提供（活跃团队信息卡 + 成员摘要 + 任务计数，`remote/service.ts`），
> 门面 `listTeams()` 内部聚合它。
>
> **裁决理由**：新增一个只读端点的唯一价值是「给外部消费者一个稳定入口」，但本插件是**单一消费者**（面板），
> `describe()` 已经是内部稳定面；再加一层网关封装是**纯转发**，只会多一个需要同步维护的契约面。
> 故**删行不补端点**——表里只留真实存在的端点，历史记在 CHG-87 / CHG-93 变更单里。
错误统一结构：`{code: string, message: string, detail?: object}`。

## 3. 数据模型

### 3.1 账本事件（ledger.jsonl，`{seq, ts, actor, type, payload}`）

| type | payload 关键字段 | 产生者 |
|------|-----------------|--------|
| `team.created` | teamId, name, goal | Lead 工具 |
| `plan.clarify` | questions[{id,type,text,assumption}], round | Lead（硬终止计数在此累计） |
| `plan.staged / plan.revised / plan.approved / plan.discarded` | planId, roster, tasks 快照 | Lead 工具 |
| `member.spawned` | memberId, roleId, instanceName, sessionId, snapshotRef, status:'ok'\|'failed', skills?, mcpAllowlist?（CHG-54：成员级覆写时记录） | Lead 工具 |
| `member.interrupted` | memberId, reason | Lead 工具（myteam_interrupt；QA-2 勘误补行） |
| `member.released / member.archived / member.restored` | memberId, mode, drained | Lead 工具 |
| `task.created` | taskId, task(TaskInput), createdBy；task.gateChain 可为 host 按 taskTypes 展开后的链（CHG-55） | Lead 工具 |
| `task.claimed` | taskId, memberId, attemptId, overrides?(FR-15.2 覆写落账本) | 成员工具 |
| `task.assigned` | taskId, memberId（主负责，= memberIds[0]）, memberIds?（CHG-69 多队员）, attemptId, by?, reason | Lead 工具（reassign：先 revoke 旧 attempt 再 assigned；QA-2 勘误补行） |
| `task.attempt.revoked` | taskId, attemptId, reason, byMember? | 双方 |
| `task.progress` | taskId, attemptId, progress | 成员工具 |
| `task.evidence` | taskId, attemptId, evidence(EvidenceBlock) | 成员工具 |
| `task.completed / task.failed` | taskId, attemptId, summary | 成员工具 |
| `task.escalated` | taskId, attemptId, reason, evidence, suggestion, count | 成员工具 |
| `task.rescoped` | taskId, reason（**CHG-73 必填**）, patch（合入任务输入）, changes（字段级 diff）, batchId? | Lead 工具 / 面板（actor=human） |
| `task.updated`（CHG-70 新增） | taskId, patch（白名单：title/description/acceptanceCriteria/deliverableSpec/deps/requiredRole/taskType/gateChain/priority/estimate/tags）, changes?（**CHG-73**：字段级 diff）, reason?, batchId? | Lead 工具 / 面板（myteam_update_task） |
| `task.cancelled`（CHG-73 新增） | taskId, reason（必填）, downstream:'leave'\|'cancel'\|'rewire', cascadeFrom?（级联取消时指向上游）, batchId? | Lead 工具 / 面板（myteam_cancel_task） |
| `task.rewired`（CHG-75 新增） | taskId（被改挂的下游）, removed（被换掉的上游 id）, added?（新上游 id；缺省 = 解除依赖）, reason（必填）, batchId? | Lead 工具 / 面板（myteam_cancel_task downstream=rewire） |
| `team.updated`（CHG-70 新增） | name?, goal? | Lead 工具（myteam_update_team） |
| `task.proposal` / `task.proposal.resolved` | proposalId, taskId, type, payload / decision | 成员/Lead |
| `task.deliverable` | taskId, path, artifactType, producer | host（archive gate/完成时） |
| `task.gate.result` | taskId, gate:'review'\|'verify'\|'archive', verdict, detail | host/成员 |
| `task.participate`（CHG-69 新增） | teamId（主责团队=账本持有者）, taskId, participantTeamId（参与团队）, role:'lead'\|'coop', memberIds?（该团队为此任务派出的队员） | Lead 工具（myteam_participate_task） |
| `task.participation.released`（CHG-69 新增） | teamId, taskId, participantTeamId | Lead 工具（释放协作；主责不可释放） |
| `message.sent / message.consumed` | messageId, from, to, taskId?, kind | 工具/host |
| `knowledge.proposed` | draftId, proposedBy, draft{title, tags, audience?, evidence, relation?, targetId?, body} | 成员工具（done 附 knowledgeDraft；FR-17.4；QA-2 勘误补行；v2.7 draft 可带 relation/targetId） |
| `knowledge.adopted` | draftId, decision:'adopted'\|'rejected', entryPath?, note?, contributor | Lead 工具（myteam_adopt_knowledge；rejected 只留痕不落库；QA-2 勘误补行；v2.7 仅 new 关系走此事件） |
| `knowledge.revised`（v2.7 新增，CHG-34） | teamId, entryId, relation:'refine'\|'contradict', diff（`<relation> · <entryId> · +evidence:<pointer> · by <proposer>`） | Lead 工具（myteam_adopt_knowledge 处理 refine/contradict 提案：refine=精炼既有条目并清 staleSince；contradict=矛盾轨迹+标 staleSince 待复核；正文「## 演化」节随文件留轨迹） |
| `session.read`（**CHG-87 新增**，FR-16.4③） | teamId, sessionId, pointer（原样 `session:<id>`）, by, taskId? | 成员工具（`myteam_update_task` 的 `knowledgeDraft` 证据指针是 `session:<id>` 时落一条——FR-16.4 边界「读取留痕」） |
| `memory.audit`（CHG-19 新增） | teamId, memberId, taskId?, findings[{file, entry?, reason:'missing-evidence'\|'empty-evidence'}], checkedFiles, violations | host 审计扫描（任务收口后 / release 前；fold 跳过，统计面消费） |
| `rules.version.adopted` | version | host 启动 |
| `team.disbanded` | archivedPaths | Lead 工具 |

> 共 **40 型**（源码权威：`plugin/src/core/ledger/ledger.ts` EVENT_TYPES；QA-2 勘误——原表缺 4 行已补；v2.7/CHG-34 增 `knowledge.revised`；CHG-69 增 `task.participate`/`task.participation.released`；CHG-70 增 `task.updated`/`team.updated`；CHG-73 增 `task.cancelled`；CHG-75 增 `task.rewired`；**CHG-87 增 `session.read`**）。

### 3.2 投影（内存 `TeamProjection`，可从账本重建；**不落 team.json**）

```
{ version, teamId, name?, goal?, state, members: {id: {roleId, instanceName, status, currentTask, capability}}, 
  tasks: {id: {…TaskInput 折叠（含 tags）, state, attemptId?, assignee?, assignees?, gates, escalateCount, evidenceRefs[], deliverables[], timeline: seq[]}},
  participations: {taskId: {leadTeamId?, teams: {teamId: {teamId, role:'lead'|'coop', memberIds[], seq, ts}}}},  // CHG-69 任务×团队参与边
  proposals: {id: {…, status}}, inbox: [{seq, kind, read?}], 
  perTaskMessages: {taskId: seq[]},   // R19 消解：thread 聚合索引
  revision }                           // 已应用事件数（逐事件 +1；乐观锁口径）
```

> **实现约束（CHG-59，ADR-002 R2 决策 B）**：①写路径 = 校验 → `structuredClone(投影)` → `applyEvent(副本, event)` → 账本 append → 切换投影；折返失败**不落账本、不动投影**（账本永不含不可重放事件）。②读路径只读内存投影（`projectionSnapshot`），不落也不读 `team.json`。③冷启动从 `ledger.jsonl` 全量重放一次（唯一恢复路径），`foldEvents` 与增量 `applyEvent` 结果逐字段一致（t40 断言）。④`revision` 不是账本 seq：seq 从 0 连续分配，`revision = 事件数 = 末事件 seq + 1`。

### 3.3 tokens.json 侧车（ADR-004）

```
{ version:1, teamId, updatedAt, 
  days: { "2026-10-25": { memberId: {uncachedInput, cacheRead, cacheWrite, output, calls} } },
  totals: { memberId: 四桶合计 }, 
  note: "含启发式估算成分，非账单" }
```

### 3.4 角色条目（config/roles/<roleId>.json）

```
{ id, name, description, systemPrompt, toolPolicy: {allow?: string[], deny?: string[]}, 
  skills: string[], mcpAllowlist: string[], interestWords?: string[], model?: {provider, model}, 
  origin?: "builtin:<id>", version }
```
内置角色随插件包只读分发；运行时只解析项目库（FR-10.2）。
**CHG-69**：`interestWords`（兴趣词，≤8 个短词）是角色架构属性，召唤时随 identity 快照固化；只为派单/认领的软信号，不参与权限判定（权限只由 toolPolicy/skills/mcpAllowlist 决定）。
**项目自身角色**：`config/project-role.json`（schema 同上，origin 标记 `project-role`）——不属于任何团队、可被本项目各团队聘任；`listRoleCatalog` 会把它与内置/全局/项目角色并列返回。

### 3.5 identity.json 成员快照（不可变，C3）

实例化时从角色条目 + 覆写复制固化：`{memberId, roleId, roleSnapshot(3.4 全文), instanceName, modelRoute, spawnedAt, teamId}`。

## 4. 错误码与异常约定

| 错误码 | 含义 | 前端表现 |
|--------|------|----------|
| `MT_VALIDATION` | 计划/任务硬校验失败（含字段定位，FR-11.2⑦项） | 表单/聊天显示具体任务与原因 |
| `MT_REVISION_CONFLICT` | **乐观锁冲突（CHG-87 已实装，QA-4 关闭）**：调用方传的 `expectedRevision` 与 `projection.revision`（= 已应用事件数 = 末事件 seq + 1）不相等。**先比版本再碰任何状态，账本零写入** | 提示重取后重试；响应回显 `currentRevision` |
| `MT_VERIFY_NO_COMMAND` | **（CHG-87 / FR-5.3）** 任务处于 `gate:verify` 但没声明 `verifyCommand`——verify 门没有可执行命令 | 提示给任务补 `verifyCommand.argv`；**不猜默认命令、不降级成人工裁决** |
| `MT_UNAVAILABLE` | **（CHG-87）** 宿主缺少所需服务：`gate:verify` 时没有 `subprocess` 服务；单角色调用时没有活动队长会话（离线团队无会话可注入） | 如实说明「不可用」，**不静默降级**、不假装成功 |
| `MT_PLUGIN_MANIFEST_INVALID` | **（CHG-92 / docs/16 §9）** 插件清单坏 JSON / 缺必需字段 / `roles` 不是数组（**插件级**：整插件跳过） | 面板「插件贡献」红条 + 具体原因 |
| `MT_PLUGIN_CONTRACT_UNSUPPORTED` | **（CHG-92）** `contractVersion` 高于 myteam 支持集（当前 `[1]`）。**不做「尽力解析」**——尽力解析的失败模式是字段被静默丢弃 | 提示升级 myteam；该插件 0 贡献 |
| `MT_PLUGIN_ID_INVALID` / `MT_PLUGIN_ID_MISMATCH` / `MT_PLUGIN_ID_DUPLICATE` | **（CHG-92）** 插件 id 不合规（`^[a-z][a-z0-9-]{1,63}$`）/ 清单与目录名不一致 / 两个目录声明同一 id（字典序后者失败） | 红条点名目录与清单 |
| `MT_CONTRIBUTION_FILE_MISSING` / `MT_CONTRIBUTION_TOO_LARGE` / `MT_CONTRIBUTION_ID_MISMATCH` / `MT_CONTRIBUTION_PATH_TRAVERSAL` | **（CHG-92）** 清单列了但文件不存在 / 单文件 > 256 KiB / 文件内 id ≠ 清单 / `file` 含 `..` 或绝对路径（**条目级**：只丢该条目） | 红条带相对路径 |
| `MT_ROLE_CONTRIBUTION_CONFLICT` | **（CHG-92）** 插件角色 id 撞 **builtin** 或**另一个插件**——**硬失败**（静默替换语义字段是最危险的 bug 类型）。撞全局库/项目库**允许**（用户那份生效，插件那份标 `shadowedBy`） | 消息给改名建议（加 namespace 前缀） |
| `MT_ROLE_CAPTAIN_RESERVED` | **（CHG-92）** 插件贡献了 `isCaptain: true`——队长是名册锚点，只能来自内置 `captain` | 提示删掉该字段 |
| `MT_TEAM_TEMPLATE_CONFLICT` / `MT_TEAM_TEMPLATE_CAPTAIN` / `MT_TEAM_TEMPLATE_UNRESOLVED` | **（CHG-92）** 团队模板 id 撞 builtin/插件 / `members` 含 `captain` / `members[].roleId` 解析不到 | 消息列出冲突方或解析不到的 id |
| `MT_ROLE_READONLY` | **（CHG-92 / P3 单向流动）** 对 `plugin` 来源角色做 `save`/`delete`/`publish` | 「插件贡献的角色只读；想改请先『复制到项目』」 |
| `MT_ATTEMPT_STALE` | attemptId 非当前（FR-4.3） | 成员工具返回，重新 get_task |
| `MT_NOT_CLAIMABLE` | 调度条件不满足（deps/角色/优先级归属） | 列出未满足条件 |
| `MT_TASK_STRUCTURAL_EDIT` | 任务在 in_progress / gate 阶段修改结构字段（AC/交付物/依赖/角色/门禁链） | 提示走 rescope（先撤 attempt）或就绪前改 |
| `MT_MEMBER_LIMIT` | maxMembers 达上限（ADR-008） | 显示当前值与上限 |
| `MT_DRAIN_PENDING` | 排空未完成，release 拒绝 | 显示在跑 x/待处理 y |
| `MT_ROLE_OCCUPIED` | C7 守门：角色被预设绑定/使用中 | 列出占用方 |
| `MT_EXTERNAL_FAILURE` | 供应商故障终态（REV-3/M2） | 任务 externalFailure 徽标 |
| `MT_TEAM_STATE` | 团队状态不允许该操作 | 状态徽标 + 合法操作列表 |

> **CHG-98（审计 A7）**：本表原含 3 个**没有任何实现**的码，已删除 ——
> `MT_CLARIFY_OPEN`（clarify 未关闭时的拒绝，实际走 `MT_TEAM_STATE` / `MT_VALIDATION`）、
> `MT_ESCALATE_BUDGET`（escalate 计数提示，实际是工具返回值里的 `note`，不是错误码）、
> `MT_CONFIG_INVALID`（team.config.json 非法，实际走 `MT_VALIDATION`）。
> 保留它们会让客户端写出**永不触发的分支**。
>
> **完整清单见文末「错误码（`MT_*`）」一节**（由 `tools/gen-error-docs.mjs` 从
> `plugin/src/core/errors.ts` 生成，70 个，`t81` 守一致）。本节只保留**需要展开语义**的码；
> 新增码请只改 `errors.ts` 再重生成，**不要手改这两处表格**。


## 5. 裁决记录（2026-10-25 用户拍板"可以"，CHG-16 全部定稿）

1. ~~成员工具 7→8~~ **定：8 个**，`myteam_claim_task` 独立成工具（与"原子 claim 返回 attemptId"语义对齐）。
2. **定：clarify N=3**（config `clarify.maxRounds` 可调）。
3. **定：合一工具** `myteam_update_task`（evidence 仅 done 必填）。
4. **定：面板留言允许**（只读观察者可写，actor=human）。
5. **定：tokens 按宿主本地时区**。
6. **定（CHG-19，2026-10-25 用户拍板"记忆波次 T19~T21"）**：①记忆审计 = 事后审计不拦截写入（同 FR-5.4 取向，宿主 write 工具不可拦截）；②审计检查点 = 任务收口后 + release 前，不做周期扫描（成本）；③`memory.evidenceRequired` 进 DEFAULT_CONFIG；④FR-6.3 面板读取计数留 M2；⑤FR-6.5/6.6/6.7 留 M2/M3 不动。

## 6. 变更影响

- CHG-16 闭环：PRD v2.4 §6/FR-3.5 同步为 8 个；本文件 1.2 表头保持"7+1=8"。

<!-- BEGIN:MT_CODES（由 tools/gen-error-docs.mjs 生成，勿手改）-->

## 错误码（`MT_*`）

> **本表由 `tools/gen-error-docs.mjs` 从 `plugin/src/core/errors.ts` 生成，共 70 个。**
> 手改会被覆盖，且 `plugin/test/t81-error-codes.test.ts` 会判红。
>
> **加码流程**：① `errors.ts` 加一行（含说明）→ ② `node tools/gen-error-docs.mjs` → ③ `cd plugin && npm test`。
>
> 客户端按码分支的地方（`plugin/client/client.js`）必须只认本表里的码；
> 服务端新增码时若客户端要分支，同步改客户端并在 CHG 里记一笔。

### 跨域通用（7）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_VALIDATION` | 入参不满足工具契约（缺必填、类型不符、越界、成环、名册外角色等）。最常见的一个码。 |
| `MT_INTERNAL` | 服务端未预期异常已兜底成结构化错误；原始堆栈只在宿主日志里。 |
| `MT_INTERNAL_FOLD` | 账本重放（fold）时抛异常：事件流与投影代码不兼容，或 payload 形状漂移。 |
| `MT_UNAVAILABLE` | 依赖的宿主服务（subprocess / agents / tokenMeter 等）在当前 profile 未注册。**不猜、不静默降级**。 |
| `MT_UNKNOWN_TOOL` | 调用了未注册的 `myteam_*` 工具名（拼写错、或被 `toolPolicy` 收窄掉了）。 |
| `MT_EXTERNAL_FAILURE` | 门禁里跑的外部命令自身失败（非零退出、被信号杀），不是门禁判定为 fail。 |
| `MT_NOT_CLAIMABLE` | 任务当前状态不允许 claim（不满足就绪条件：依赖未完成 / 已被占用 / 非 ready）。 |

### 账本（append-only JSONL）（6）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_LEDGER_BAD_ACTOR` | 事件 `actor` 不是 `member:<id>` / `lead` / `system` 之一。 |
| `MT_LEDGER_BAD_PAYLOAD` | 事件 payload 不是普通对象（null / 数组 / 原始值）。 |
| `MT_LEDGER_CORRUPT` | 账本行 JSON 合法但不是合法事件，或 seq 断点／回退。**跳过该行、继续解析**，只告警不丢后续事件。 |
| `MT_LEDGER_MISSING_FIELD` | 事件缺 `seq` / `type` / `at` / `actor` / `payload` 之一。 |
| `MT_LEDGER_MISSING_RULES_VERSION` | 新账本的首事件不是 `rules.version.adopted`（I3 前提）。 |
| `MT_LEDGER_UNKNOWN_TYPE` | 事件 `type` 不在 `EVENT_TYPES` 白名单里（旧版本写的账本用新代码打开时会看到）。 |

### 任务与状态机（14）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_ATTEMPT_STALE` | 针对的 attempt 已被撤销或已结束（并发重试、或成员被 interrupt 后回写）。 |
| `MT_CROSS_REVIEW` | `gate:review` 要求 `reviewerMemberId` 必填且 ≠ 实现者；同成员自审被拒（FR-5.1）。 |
| `MT_DEPENDENCY_FAILED` | 批量建任务时，本条依赖的前序条目创建失败，本条目跳过。 |
| `MT_DRAIN_PENDING` | 释放成员前还有未排空的运行中/待处理任务（FR-3.11：排空后才报成功）。 |
| `MT_EVIDENCE_REQUIRED` | 成员申报 done 但没带 `[Verification evidence]` 证据块（FR-5.0）。 |
| `MT_MEMBER_LIMIT` | 成员数超过 `maxMembers` 上限（ADR-008）。 |
| `MT_NO_AGENTS_SERVICE` | 宿主没给 `agents` 服务，无法 spawn 成员。 |
| `MT_REJECT_BUDGET` | 单门 fail 轮数达到 `GATE_REJECT_BUDGET`(2)，队长侧 pass 被拒，转人工（FR-5.2）。 |
| `MT_REVISION_CONFLICT` | 乐观锁失败：传了 `expectedRevision` 但与当前投影版本不等，**账本零写入**（QA-4）。 |
| `MT_TASK_CYCLE` | 依赖成环（含自指、或 `rewireTo` 指回下游造成的环）。 |
| `MT_TASK_STRUCTURAL_EDIT` | 尝试改任务的**结构字段**（AC / 交付物 / 依赖）但走错了入口——结构改动必须走 `rescope` 管线。 |
| `MT_TASK_TERMINAL` | 任务已在终态（done / cancelled / failed），不允许再变更。 |
| `MT_TEAM_STATE` | 团队状态不允许当前操作（如同名 active 团队已存在、非 draft 时批准计划）。 |
| `MT_VERIFY_NO_COMMAND` | `gate:verify` 要求任务声明 `verifyCommand`，但没声明（不能用人工裁决冒充真跑命令）。 |

### 归档（1）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_ARCHIVE_FAILED` | 解散团队时归档写盘失败；**已落账本但文件没写全**，不静默（CHG-86 P0-2）。 |

### 知识库（8）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_KB_CORRUPT` | 知识条目 frontmatter 损坏或文件不可解析。 |
| `MT_KB_EVIDENCE_REQUIRED` | 采纳知识草稿时缺证据指针（FR-17.4 策展门）。 |
| `MT_KB_EXISTS` | 同 id 知识条目已存在且未走 `revise` 演化式修订。 |
| `MT_KB_INVALID` | 知识条目字段不合规（id 格式、tags、audience 等）。 |
| `MT_KB_NOT_FOUND` | 知识条目不存在（可能被归档或 id 写错）。 |
| `MT_KB_RELATION_MISMATCH` | 草稿声明的 `relation`（refine / contradict）与目标条目状态不匹配。 |
| `MT_KB_TARGET_MISMATCH` | 草稿指向的目标条目与 `adopt` 时传入的不一致。 |
| `MT_KB_TARGET_REQUIRED` | `relation` 为 refine / contradict 时必须给 `target`。 |

### 角色库（11）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_ROLE_BUILTIN` | 内置角色的 id 被保留，不能创建同名项目角色。 |
| `MT_ROLE_CAPTAIN` | 队长角色唯一：名册里已有队长时再指定第二个。 |
| `MT_ROLE_CAPTAIN_RESERVED` | 插件贡献的角色不能占用队长保留 id。 |
| `MT_ROLE_CONTRIBUTION_CONFLICT` | 插件贡献的角色 id 与已有角色（项目/全局/内置）冲突。 |
| `MT_ROLE_CORRUPT` | 角色定义文件不可解析（常见原因：把非角色 JSON 放进了 `config/roles/`）。 |
| `MT_ROLE_EXISTS` | 同 id 角色已存在且未带覆盖语义（两段确认）。 |
| `MT_ROLE_INVALID` | 角色定义字段不合规（id 格式、systemPrompt 为空、interestWords 越界等）。 |
| `MT_ROLE_NO_GLOBAL_DIR` | 全局角色库目录不存在（`$DSH_HOME/myteam/roles/` 还没初始化）。 |
| `MT_ROLE_NOT_FOUND` | 角色 id 在内置/全局/项目三层里都找不到。 |
| `MT_ROLE_OCCUPIED` | 角色正被在册成员占用，不能删改（先释放成员）。 |
| `MT_ROLE_READONLY` | 内置角色只读，不能改不能删——想改即 fork 进项目库（CHG-6）。 |

### 名册（3）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_ROSTER_DUAL_CAPTAIN` | 名册里有多个队长。 |
| `MT_ROSTER_EMPTY` | 名册为空（FR-10.2）。 |
| `MT_ROSTER_NO_CAPTAIN` | 名册里没有队长（FR-10.2）。 |

### 团队模板 / 预设（6）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_PRESET_BUILTIN` | 内置预设 id 保留，不能覆盖/删除（想改即复制）。 |
| `MT_PRESET_EXISTS` | 同 id 预设已存在且未带 `overwrite: true`。 |
| `MT_PRESET_NOT_FOUND` | 预设 id 不存在（项目库与内置库都没有）。 |
| `MT_TEAM_TEMPLATE_CAPTAIN` | 团队模板里声明了队长，但队长必须隐式派生（不能显式指定）。 |
| `MT_TEAM_TEMPLATE_CONFLICT` | 团队模板 id 与已有模板/预设冲突。 |
| `MT_TEAM_TEMPLATE_UNRESOLVED` | 模板引用的角色在任意一层角色库里都找不到。 |

### 会话移交（2）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_HANDOFF_FAILED` | 移交时建会话或注入摘要失败；**仍回 sessionId**（不假装成功，也不吞掉已建会话）。 |
| `MT_HANDOFF_NO_SESSION` | 移交目标会话不存在或不可写。 |

### 插件贡献契约（12）

| 码 | 什么时候会看到它 |
|---|---|
| `MT_CONTRIBUTION_CODE_IGNORED` | 贡献物里的代码字段被宿主忽略（只做声明，不执行第三方代码）。 |
| `MT_CONTRIBUTION_FILE_MISSING` | 插件声明的贡献物文件不存在。 |
| `MT_CONTRIBUTION_ID_MISMATCH` | 贡献物文件里的 id 与 manifest 声明不一致。 |
| `MT_CONTRIBUTION_ORIGIN_STAMPED` | 贡献物已被标记来源（origin），不能二次盖章。 |
| `MT_CONTRIBUTION_PATH_TRAVERSAL` | 贡献物路径含 `..` 或绝对路径，越出贡献根目录。 |
| `MT_CONTRIBUTION_ROOT_ABSENT` | 贡献根目录（`$DSH_HOME/myteam/plugins/`）不存在。 |
| `MT_CONTRIBUTION_TOO_LARGE` | 贡献物超过体积上限。 |
| `MT_PLUGIN_CONTRACT_UNSUPPORTED` | 插件声明的贡献契约版本不在支持范围内（v1）。 |
| `MT_PLUGIN_ID_DUPLICATE` | 同一贡献根下两个插件用了同一个 id。 |
| `MT_PLUGIN_ID_INVALID` | 插件 id 格式不合规（必须小写字母/数字/连字符）。 |
| `MT_PLUGIN_ID_MISMATCH` | 插件目录名与 manifest 里的 id 不一致。 |
| `MT_PLUGIN_MANIFEST_INVALID` | 插件 manifest 不是合法 JSON 或字段不合规。 |

---

<!-- END:MT_CODES -->
