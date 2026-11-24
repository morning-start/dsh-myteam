# 权限矩阵（人类 / 队长 / 成员）

> 状态：`as-is`（2026-11-24 从 `plugin/src/domain/permissions/policy.ts` 直接生成，**不要手改结论**）。
> 生成方式：`node tools/gen-permission-doc.mjs`；改动权限请改 `policy.ts`，本表由脚本重算。

## 0. 怎么读这两张表

- 这里有两件事，别混：**能不能做这个动作**（本页）与**能不能看到这个按钮**（界面）。
  界面隐藏只是体验层，服务端对同一动作做同样的判定。
- 「人类」= 面板 / 命令这类可信入口的 `human` 身份。**它的权限是全集**，
  但其中 5 个动作带「人类专属」标记：非 human 调用一律 `HUMAN_ONLY` 拒绝，
  且 human 调这些动作还要过一次性的确认令牌（防「我看到的」和「实际执行的」不是同一件事）。
- 「队长」和「成员」的权限是**白名单**：不在集合里就是 `FORBIDDEN`，没有「默认允许」。
- 队长只能操作**自己团队**的实体；成员只能操作**自己的**实体与自己的 Attempt。
  这条限制不和动作权限混在一起写，见 §3。

## 0.5 读写当前项目：读面不设动作门，写面要过动作门

团队的存在意义是**完成当前项目**，所以「读写当前项目」是默认能力，不是特权。
但要分清两层，避免把「能读」和「能改」混成一件事：

| 面 | 例子 | 怎么判定 | 谁能用 |
|---|---|---|---|
| **读面**（面板查询） | `status` `overview` `board` `task` `team` `definitions` `runs` `run` `knowledge` `effects` `audit` `settings` `memory` | **不经过 `authorize(Action)`**：`panel-service.read()` 只按宿主绑定解析出会话所在的工作区，读到就折叠成视图。对应动作 `project.read` 只是名义登记 | 任何能打开这个项目的会话（人类 / 队长 / 成员都行） |
| **写面**（命令） | 建队、建任务、认领、改配置、归档成员… | **必须过 `authorize(Action)`**：白名单 + 作用域（队长限本团队、成员限本人） | 见 §1 逐动作表 |

为什么读面不设动作门：一个成员连自己团队的任务都读不到，就没法干活；而「读」不会改变项目状态，
所以把它设成权限只会制造「界面看不见但改个参数就能读」的假安全。真正的边界在**写**上。

> 有一条例外值得记住：`memory` 的**读**走的是 `memory.read` 动作（不是面板读面），
> 因为记忆按 bank 分，成员的读要落到自己那个 bank —— 这是唯一一个「读也要授权」的面。

---

## 1. 动作 × 身份（核心表）

| 动作 | 说明 | 人类 | 队长 | 成员 | 系统 | 人类专属 |
|---|---|:--:|:--:|:--:|:--:|:--:|
| **项目 / 定义** | | | | | | |
| `project.read` | 读项目（概览、看板、审计等） | ✅ | ✅ | ✅ | — |  |
| `definition.write` | 改项目定义副本（角色 / 工作流 / 蓝图） | ✅ | ✅ | — | — |  |
| `definition.copy-from-global` | 从全局库复制到项目 | ✅ | ✅ | — | — |  |
| `definition.publish.request` | 请求发布到全局库（第一步：出影响面） | ✅ | ✅ | — | — |  |
| `definition.publish.confirm` | 确认发布（第二步：凭一次性令牌写全局库） | ✅ | — | — | — | 🔒 |
| **团队** | | | | | | |
| `team.create` | 建团队 | ✅ | ✅ | — | — |  |
| `team.update` | 改团队（改名 / 目标） | ✅ | ✅ | — | — |  |
| `team.archive` | 归档团队 | ✅ | ✅ | — | — |  |
| `team.disband` | 解散团队（不可逆） | ✅ | — | — | — | 🔒 |
| `captain.assign` | 指定队长 | ✅ | ✅ | — | — |  |
| `captain.handoff.propose` | 提议队长交接 | ✅ | ✅ | — | — |  |
| `captain.handoff.confirm` | 确认队长交接（换代） | ✅ | — | — | — | 🔒 |
| **成员** | | | | | | |
| `member.appoint` | 召唤 / 聘任成员 | ✅ | ✅ | — | — |  |
| `member.release` | 释放成员（终态） | ✅ | ✅ | — | — |  |
| `member.archive` | 归档成员 / 恢复已归档成员 | ✅ | ✅ | — | — |  |
| `member.pause` | 暂停成员 | ✅ | ✅ | — | — |  |
| **工作流与任务** | | | | | | |
| `run.create` | 实例化工作流（创建 Run） | ✅ | ✅ | — | — |  |
| `run.revise` | 修订运行（改完成规则） | ✅ | ✅ | — | — |  |
| `task.create` | 建任务 | ✅ | ✅ | — | — |  |
| `task.update` | 改任务（标题 / 验收标准） | ✅ | ✅ | — | — |  |
| `task.dependencies.change` | 改任务依赖（DAG 连边） | ✅ | ✅ | — | — |  |
| `task.claim` | 认领任务 | ✅ | ✅ | ✅ | — |  |
| `task.progress` | 写进度 | ✅ | — | ✅ | — |  |
| `task.evidence` | 提交证据 | ✅ | — | ✅ | — |  |
| `task.submit-review` | 提交评审 | ✅ | — | ✅ | — |  |
| `task.review` | 接受评审（队长侧） | ✅ | ✅ | — | — |  |
| `task.complete` | 完成任务 | ✅ | ✅ | — | — |  |
| `task.reopen` | 重开任务 | ✅ | ✅ | — | — |  |
| `task.cancel` | 取消任务 | ✅ | ✅ | — | — |  |
| **知识与配置** | | | | | | |
| `knowledge.propose` | 知识提案 | ✅ | ✅ | ✅ | — |  |
| `knowledge.adopt` | 采纳知识 | ✅ | ✅ | — | — |  |
| `knowledge.archive` | 归档知识 | ✅ | ✅ | — | — |  |
| `config.write` | 改团队配置 | ✅ | ✅ | — | — |  |
| `config.rebase` | rebase 团队配置 | ✅ | ✅ | — | — |  |
| **记忆** | | | | | | |
| `memory.read` | 读记忆 | ✅ | ✅ | ✅ | — |  |
| `memory.write` | 写记忆 | ✅ | ✅ | ✅ | — |  |
| `memory.forget` | 遗忘记忆 | ✅ | ✅ | — | — |  |
| **其它** | | | | | | |
| `message.post` | 发消息 | ✅ | ✅ | ✅ | — |  |
| `effect.settle` | 结算 Effect（系统） | ✅ | ✅ | — | ✅ |  |
| `plan.approve` | 批准计划 | ✅ | — | — | — | 🔒 |
| `migration.cutover` | 执行 v1 迁移切换 | ✅ | — | — | — | 🔒 |

## 2. 按身份汇总（反向表：这个身份能做哪些）

### 人类（41 / 41 个动作）

全部动作都允许；其中 🔒 标记的 5 个还要过一次性令牌，且只能由人类发起：

> `definition.publish.confirm` · `team.disband` · `captain.handoff.confirm` · `plan.approve` · `migration.cutover`

`project.read` · `definition.write` · `definition.copy-from-global` · `definition.publish.request` · `definition.publish.confirm` · `team.create` · `team.update` · `team.archive` · `team.disband` · `captain.assign` · `captain.handoff.propose` · `captain.handoff.confirm` · `member.appoint` · `member.release` · `member.archive` · `member.pause` · `run.create` · `run.revise` · `task.create` · `task.update` · `task.dependencies.change` · `task.claim` · `task.progress` · `task.evidence` · `task.submit-review` · `task.review` · `task.complete` · `task.reopen` · `task.cancel` · `knowledge.propose` · `knowledge.adopt` · `knowledge.archive` · `config.write` · `config.rebase` · `memory.read` · `memory.write` · `memory.forget` · `message.post` · `effect.settle` · `plan.approve` · `migration.cutover`

### 队长（33 / 41 个动作）

白名单；且 `context.teamId` 必须等于自己的团队。注意：**读当前项目的面板数据不需要任何动作**（见 §0.5），上面这 33 条是「能改什么」。

`project.read` · `definition.write` · `definition.copy-from-global` · `definition.publish.request` · `team.create` · `team.update` · `team.archive` · `captain.assign` · `captain.handoff.propose` · `member.appoint` · `member.release` · `member.archive` · `member.pause` · `run.create` · `run.revise` · `task.create` · `task.update` · `task.dependencies.change` · `task.claim` · `task.review` · `task.complete` · `task.reopen` · `task.cancel` · `knowledge.propose` · `knowledge.adopt` · `knowledge.archive` · `config.write` · `config.rebase` · `memory.read` · `memory.write` · `memory.forget` · `message.post` · `effect.settle`

### 成员（9 / 41 个动作）

白名单；且只能操作自己的实体 / 自己的 Attempt。同样地，**读当前项目的面板数据不需要动作**（§0.5）；这 9 条里 4 条是干活必需的写（认领/进度/证据/提交评审），其余是读项目、读记忆、写记忆、提知识与发消息。

`project.read` · `task.claim` · `task.progress` · `task.evidence` · `task.submit-review` · `knowledge.propose` · `memory.read` · `memory.write` · `message.post`

### 系统（Effect Runner）（1 / 41 个动作）

**只能结算 Effect，不能发起任何业务动作** —— 这是刻意的：系统不是「超级身份」。

`effect.settle`

## 3. 作用域限制（动作之外还有一层）

动作权限只回答「这个身份能不能做这类事」。真正执行时还叠一层**作用域校验**：

| 身份 | 作用域约束 | 拒绝时错误码 |
|---|---|---|
| 人类 | 无团队限制（可信入口） | — |
| 队长 | `context.teamId` 必须等于 `actor.teamId` | `FORBIDDEN`「队长不能操作其他团队的实体」 |
| 成员 | 同上，**且** `context.memberId` / `attemptMemberId` 必须是本人 | `FORBIDDEN`「成员只能操作自己的实体 / 自己的 Attempt」 |
| 系统 | 无作用域，但只有 `effect.settle` | `FORBIDDEN` |

## 4. 2026-11-24 的两处变更（备查）

| 动作 | 变更 | 谁可以做 | 为什么 |
|---|---|---|---|
| `member.archive` | **新增**（归档成员，退役但可回放） | 人类 ✅ 队长 ✅ 成员 — | 与 `member.release` 同级：队长管自己团队的成员生命周期 |
| `memberRestore` | 面板写**新增**，但复用 `member.archive` 动作 | 同上 | 恢复就是把归档成员放回在岗，属于同一类动作，不为它单开权限 |

> 注意 `memberRestore` 是个**面板写方法**，不是新的 `Action` —— 它走的是 `member.archive` 的授权。
> 这是刻意的：为「恢复」单开一个动作会让权限矩阵多一行只有箭头不同的东西，收益为零。

## 5. 还没定的（全局库编辑，见 [决策](../decisions/全局库编辑写通道.md)）

下面这个动作**还不存在**，方案里建议是这样，等拍板后才进 `policy.ts`：

| 建议动作 | 人类 | 队长 | 成员 | 理由 |
|---|:--:|:--:|:--:|---|
| `definition.global.write`（直改全局库） | ✅（令牌） | ❌ | ❌ | 全局定义是跨项目资产；现在的 `definition.publish.confirm` 已经是人类专属，直改不该更松 |

## 6. 复跑

```powershell
node tools/gen-permission-doc.mjs   # 重算本表（改 policy.ts 之后跑）
node tools/verify.mjs               # 全量门禁
```
