> 文档治理：`audit`。本文件是带时点的代码、技术、UI 或真机证据，不是目标架构正文；现行入口见 [../README.md](../README.md)。
> 静态推导、测试与真机结论按原文保留，当前结果需重新运行对应命令。

# 27-成员子代理化与 SQLite 记忆（ADR-010 草案）

> 用户定案（2026-11-21）：**成员改用子代理**；记忆等长期状态要存下来，
> 借鉴 Hindsight 的记忆方法，用 SQLite。
> 本文只写「怎么改、按什么顺序改、怎么验收」；取证见 [docs/15 §9](../research/15-官方AgentTeam对照与借鉴.md)。

## 0. 一句话

把成员从「插件自建的**根会话**」换成「DSH **子代理**（子会话 + 父链 + preset 组合）」，
把记忆从「成员目录下的 `memory.md`」换成「workspace 级 **SQLite**（bank / evidence / refine / recall）」。
账本仍是唯一权威，服务仍是单写者。

---

## 1. 机制事实（本机解包 0.2.2-rc.5，写代码前必须先认这五条）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 子代理的服务入口是 `subagents.startActivation(spec)`，spec 里可给 `childId`（稳定身份）、`agentPreset`、`parent`、`prompt`、`maxDepth` | `dsh-subagent/src/index.ts:252-272`、`types.ts:144-190` |
| 2 | **子代理默认 join 父的 preset 代际**；不指定 `agentPreset` 就会拿到队长那 60 个 Lead 工具（违反 C5） | `dsh-subagent/src/child-agent.ts:187-201`（`composeFrom`） |
| 3 | 子代理的 local child `setup` 是**管理器私有**的（composition / descriptor / cwd / outputSchema），插件插不进去 → 成员工具只能经 **preset** 装 | `dsh-subagent/src/manager.ts:826-865` |
| 4 | 工具的 `execute(args, exec)` 第二参带 **调用方 Agent**（`exec.agent`），所以我们的 `myteam_spawn_member` 能拿到船长 Agent 去 `startActivation` | `dsh-tool-agent-team/src/index.ts:83-86,131-132` |
| 5 | `node:sqlite` 在宿主可用（`DatabaseSync`/`StatementSync`），官方 `dsh-session-query-sqlite` 也无原生依赖 | 本机 `require('node:sqlite')` 实测 + 该包 `package.json` 依赖只有 schemastery |

---

## 2. 目标形态

### 2.1 服务与工具分层（**修订 2026-11-21：不需要把服务挪到 root**）

原方案是「服务移到 root + preset 拆 captain/member」。查完执行链后否掉了——有一条更小的路：

| 事实 | 证据 |
|---|---|
| 工具 `execute(input)` 的 `input.agent` 就是**拥有该作用域的 Agent**；「Owning Agent supplies scoped tools and execution context」 | `dsh-tools/src/executor.ts:29-32` |
| 面板门面已经用 `agentPresets.serviceFor(agent, 'myteam')` 拿到**队长 preset 作用域里**的服务，且工作正常 | `plugin/src/panel.ts:216-220` |

所以：**成员的工具由成员 preset 里的一个小插件注册**；每次 `execute(args, exec)` 时用
`exec.agent`（成员自己）→ `exec.agent.session.header.parentSession`（队长会话）→
`agents.get(parentSessionId)`（队长 Agent）→ `serviceFor(captain, 'myteam')`（同一个服务实例、同一个单写者）
→ 调宿主执行。**服务留在原地**，账本单写者与面板门面都不动。

| 层 | 放什么 | 变化 |
|---|---|---|
| **队长 preset** | `myteam` 服务 + 60 个 Lead 工具 + 队长 persona | 不动 |
| **成员 preset** | 新的 `dsh-plugin-myteam/member` 入口：注册 13 个成员工具，执行时按上表解析服务 | 新增 |
| root | 面板门面 `myteamPanel`（namespace `myteam`） | 不动 |

代价：成员工具调用多一次「父会话 → 队长 Agent → 服务」的解析（O(1) 查表），失败时返回
`MT_UNAVAILABLE` 并说明「队长会话不在线」——**不静默**。

### 2.2 成员创建

```
myteam_spawn_member(roleId)
  → exec.agent（船长 Agent）
  → subagents.startActivation({
      parent: exec.agent,
      childId: 'mt-<teamId>-<roleSlug>-<n>',   // 与账本 sessionId 同一份，稳定、可对账
      agentPreset: 'myteam-member',            // 必须显式，否则拿队长工具（事实 2）
      label: '<roleId>-<n>',
      prompt: 上岗引导（读板 → 认领）
    })
  → 账本仍走两阶段（provisioning → active），handle 换成 activation
```

成员身份反查：`myteam-member` preset 的插件在 `setup(agentCtx, agent)` 里用
`agent.session.id`（即 childId）查账本 → `memberId / roleId / teamId` → 装配角色 section 与工具收窄。

### 2.3 生命周期与恢复

- 释放成员 = `activation.dispose()`；父会话结束 = 宿主级联，**成员会话会被释放**。
- 重启后：账本 + 子代理会话日志都在，但**没有 live activation** → 与今天同一个缺口，
  需要「按需恢复」策略（收到消息时 `startActivation({childId})` 续上，或显式拒绝并给出可行动错误）。
- 这一条是记忆必须落 DB 的根本原因：会话会被释放，记忆不能跟着没。

---

## 3. SQLite 记忆（借鉴 Hindsight 的三件事）

位置：`<ws>/.dsh-myteam/history/memory.db`（`history/` 已在 `.gitignore`）。

| Hindsight 概念 | 本插件落地 | 差异 |
|---|---|---|
| bank | `team:<teamId>` / `member:<teamId>:<memberId>` | 同构；召回只在单个 bank 内 |
| evidence / provenance | `entries.evidence` **必填**，无证据写入直接抛 | 比 Hindsight 更硬（FR-6.2 审计口径） |
| refine not overwrite | `supersedes` 指针 + 旧条目归档（不删） | 与知识库 `knowledge.revised` 同源 |
| recall | FTS5 `trigram` + `bm25` + 重要度 + 新鲜度（30 天半衰） | 不做向量检索（本地无 embedding 服务） |
| observations → pages | `kind` 五型：fact / decision / pitfall / convention / episode | 先不做自动「页维护」，只做显式写入 |

表：`banks` / `entries`（含 `seq`、`evidence`、`importance`、`supersedes`、`archived_at`）/
`entries_fts`（FTS5 external content + 三个触发器）。

**中文检索**：FTS5 用 `trigram`（`unicode61` 对中文不切词，等于没有索引）；
trigram 要求 ≥3 字，短查询回退 `LIKE`（bank 过滤 + limit，规模可控）。

新增工具（A 档全员，成员与队长共用）：

| 工具 | 语义 |
|---|---|
| `myteam_remember` | `{bank, kind, title, body, evidence, importance?, supersedes?}` → 条目 id |
| `myteam_recall` | `{bank, query?, kind?, limit?}` → 带 score 与出处的条目 |
| `myteam_forget` | `{id}` → 归档（软删，不物理删） |

---

## 4. 分批（每批：测试 + 8 门禁 + 提交推送）

| 批 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **P1** | `core/memory/store.ts`（SQLite 存储层）+ `core/memory/recall.ts`（上岗召回）+ 7 条测试 | 写入/召回/隔离/归档/重开/预算 全绿 | ✅ 已入库（CHG-212） |
| **P2** | `myteam_remember` / `myteam_recall` / `myteam_forget` + 工具契约锁（defs / tiers / output-contract / 成员工具表 / 4 处计数） | 工具数 59 lead + 13 member = 72，A 档 26，契约锁全绿 | ✅ 已入库（CHG-212） |
| **P3** | `dsh-plugin-myteam/member` 入口（注册 13 个成员工具）+ `myteam-member` preset | 假 ctx 单测 + 活体探针：preset 挂载、13 工具、无 Lead 泄漏 | ✅ 已入库（CHG-212） |
| **P4** | `spawn` 改 `subagents.startActivation({childId, agentPreset:'myteam-member', parent})` + 身份反查 + C5 懒收窄 + 上岗简报 | 活体探针：`parent=<captain>` / `preset=myteam-member` / `depth=1` / `13 myteam tools` / `leadLeak=false` | ✅ 已入库（CHG-212） |
| **P5** | 重启后按账本身份回落 `agents.get(sessionId)` + 投递失败如实回报 | t177c：新 host + 空句柄表 + 活着的成员会话 → 消息投得出去 | ✅ 已入库（CHG-212） |

### 4.1 活体验证记录（2026-11-21，真实 host、不经模型）

用一次性探针（`--patch` 注入，不入库）在 `myteam-web` profile 的真实 host 里执行：

```
captain service: MyTeamRemote  memberToolBySession: function  policy: function  brief: function
child: mt-probe-implementer-xxx   name: probe1
childLive: true   parent: probe-cap-xxx   preset: myteam-member   depth: 1
toolCount: 25   myteamTools: 13   remember: true   leadLeak: false
```

这一轮**抓到两个只在真机上才暴露的断点**（都已修）：

| 断点 | 现象 | 根因 |
|---|---|---|
| 成员入口调不到宿主 | `svc.executeLeadTool is not a function` | `agentPresets.serviceFor(agent,'myteam')` 返回的是 **MyTeamRemote**（隔离门面），不是 MyTeamHost |
| 成员 preset 整行激活失败 | `cannot get property "systemPrompt" without inject` | 插件读 `ctx.systemPrompt` 却没在 `inject` 里声明 → preset 变 broken（与 CHG-211a 同一类事故） |

**当时的未验证部分**（诚实记录）：成员真正跑一轮模型（需要可用的队长会话与模型路由）、以及长跑中记忆的积累质量。
工具面、父子链、preset 挂载由上面的探针证实；**这些探针绕过了 `myteam_spawn_member`**，所以「成员真能跑起来」当时并没有被证明。

### 4.2 活体验收（2026-11-21，真实 host + 真模型，走真实工具入口）

做法：一次性探针（`--patch` 注入，不入库）在 `myteam-web` profile 里建一个**真队长会话**（挂 `myteam-captain` preset），
然后经 `ctx.tools.execute({ agent: 队长 })` 调**真实 lead 工具**：`myteam_submit_plan` → `myteam_approve_plan` →
`myteam_spawn_member` → `myteam_message`；成员侧是**真模型**（magpie / `workbuddy/deepseek-v4.1-flash`）跑一轮。

**这一轮抓到 4 个「只有真机才暴露」的缺陷，全部已修 + 有回归用例**：

| # | 现象 | 根因 | 修法 | 用例 |
|---|---|---|---|---|
| 1 | `myteam_spawn_member` 直接 `MT_INTERNAL: cannot get property "subagents" without inject` | `spawn` 读 `ctx.subagents` 用**属性直读**，而插件 `inject` 只有 `tools/agents`；异常抛在 `canActivate` 里，子代理分支与回落分支**一起**挂 | `subagentsOf()` 走显式 `get('subagents')`（与 CHG-206 的 `agentDefaultModel` 同一口径），取不到才回落 `agents.create` | t179a / t179b |
| 2 | 队长看到 `{status:'sent'}`，成员却一条都没收到 | `myteam_message` 无条件回 sent（`deliverMemberMessage` 的布尔被丢掉） | 返回值带 `delivered`，未送达给可行动下一步 | t179c |
| 3 | 成员**所有** `myteam_*` 工具都报 `Cannot read properties of undefined (reading 'host')` | 成员入口把服务方法**取出来再调**（`const run = host.foo; run(...)`）→ `this` 丢失，MyTeamRemote 的 `this.host` 当场炸 | 带接收者调用 | t176i |
| 4 | 成员「永远收不到消息」：`session "mt-…" cannot append outside a SessionStore` | 子代理 child 的 Agent 是**可续起 seed**，`agent.followup` 不能 append；官方通道是 `subagents.sendMessage(队长, childId, …)` | 新增 `host/delivery.ts`：子代理走 sendMessage（异步），根会话走 followup（同步），双形状调用方都接 | t179d |
| 5 | `myteam_release_member` 后账本说已释放，`agents.get(childId)` 里 child **还在跑** | settle 时 handle 被换成 live Agent，activation 的 `dispose` 丢了 | `rememberActivation` 记下 dispose，释放时调用 | t179e |
| 6 | `memberById` **永远**返回 undefined（`member.teamId` 也是 undefined） | 投影是 `MemberProjection`（主键 `id`、不带 `teamId`），成员族用 `MemberInstance`（`memberId`/`teamId`），旧实现 `as` 强转后比较 `memberId` | `host/member-lookup.ts` 就地归一（`id → memberId`，补 `teamId`） | t179c/t179d 触发 |
| 7 | 新团队的消息投到了**老团队同名成员**上（`agent "mt-live-e2e-s5-implementer-2" is not a member of this subagent tree`） | 成员 id 只在**团队内**唯一（每队都有 `m1-implementer`），而 `memberById` / 投递没带 `teamId`，遍历到第一个同名就返回 | `member-lookup` 支持 `teamId` 作用域；`deliverMemberMessage` / `memberOp(steer)` / 唤醒全部带上 teamId | t179h |
| 8 | spawn 后**立刻**发第一条消息必然 `delivered:false`（`subagent "…" is unavailable`） | `startActivation` 返回时 child 还没进 `resident`，`sendMessage` 以「还没就绪」拒绝——消息本可送到，只是早了几百毫秒 | `host/delivery.ts` 对**瞬时**错误短暂重试（0/150/400/900ms）；`cannot resume` / `UNAUTHORIZED` 这类确定性拒绝立即放弃、不做无意义等待 | t179f / t179g |

另一个相关修正：**通道选择不再看「child 现在在不在 resident」**。实测有两个窗口（spawn 与首条消息之间、
成员一轮跑完被收回之后）`agents.get(childId)` 都是 undefined，用活跃度判载体就会把子代理成员误判成
根会话，消息直接投不出去。现在只认 spawn 时定下来的**载体事实**（`subagentMembers`）。

顺带修掉上一轮记录的双投递：一次 `myteam_message` 曾触发两次投递（消息 + `message.sent` 唤醒），
现在 `from=lead|human` 的消息不再额外唤醒（成员→成员消息仍靠唤醒送达）。

**验收结果（真机实测）**：

```
checks.child        origin=subagent  parentSession=live-cap-s5  agentPreset=myteam-member
                    delegationDepth=1  toolCount=25  myteamTools=13  leadLeak=[]
checks.memory       bank=member:live-e2e-s5:m2-implementer  evidence=file:…/tasks/live-e2e-report.md
memberReport        记忆 id：m-mwqhzgtc-1 / recall returnedCount：1 / 「remember 与 recall 均成功返回」
stage2              memberSessionAliveAfterRestart=false  delivered=false +「先 release 再 spawn」
                    w2AliveAfterRelease=false  ledger: member.released(seq 19)
```

成员那一轮的模型输出（原样，未加工）：

> 记忆 id：m-mwqhzgtc-1
> recall returnedCount：1；前两条 title：「子代理成员上岗验证」（仅 1 条，无第二条）
> 一句话结论：子代理成员可正常调用记忆工具，remember 与 recall 均成功返回。

**这一轮也证明了两件产品侧的纪律在真机上成立**：① 成员在没有证据时会**如实写「受阻，AC 未达成」**
而不是编造记忆 id（第 4 个缺陷窗口里的报告原文）；② 同队自动召唤的成员（`m1-implementer`）确实
`task.claimed` 并写了自己的记忆条目（`bank=member:live-e2e-s5:m1-implementer`）。

**仍未验证**：长跑（多轮派单 → 门禁 → done）下的记忆积累质量；`subagentCatalog` 的服务端列表
（宿主 `subagents` 服务没有 `list` 方法，探针只能证明「dispose 后 `agents.get` 拿不到」）。

### 4.3 载体与唤醒验收（2026-11-21，第二轮，真机 + 真模型）

成员不是一次性执行器——它必须在**多轮派单**里被反复叫醒。这一轮专测这条：

```
队伍               wake-s12（新团队；成员 m2-implementer / 会话 mt-wake-s12-implementer-2）
第一条派单          delivered:true   → 成员跑一轮模型，写 A1
一轮结束后          childResidentAfterTurn:true（会话在岗，工具面 25 / myteam 13 / leadLeak []）
第二条派单（空闲后）  delivered:true   → 成员再跑一轮，写 A2
产物               tasks/live-e2e-wake.md = "A1\nA2\n"
```

这一轮暴露的正是上面表里的 **7（跨团队同名 id 串线）** 与 **8（spawn 后立刻发消息被判 unavailable）**，
都已在真机上复现、修掉、并回到真机验证（第二轮 stdout 里不再有 `not delivered` 警告）。

顺带把 **`pwsh` 的可用性归了类**：在同一个实例里让**队长**调 `pwsh`，报同样的
`sandbox-local: windows-acl workspace grant failed (Win32 5) … or run with danger-full-access`——
说明这是**宿主沙箱在本机拿不到工作区 ACL**（`E:\Workplace` 权限），**不是 myteam 的缺陷**；
桌面端因为是 `danger-full-access` 所以看不到这个现象。要在 CLI 实例里跑命令，得给该 profile 放宽文件策略。

### 4.4 长跑验收（2026-11-21 夜间，桌面端真实队长会话 + 真模型 × 2 成员）

在**重启后的桌面端**（此时插件已含 §4.2/§4.3 的全部修复）里，用真实队长会话（而非探针）跑完整一条链：

```
长跑团队 longrun-1（名册 captain + implementer + reviewer）
plan.staged → approve（自动召唤 m1-implementer / m2-reviewer）→ task-1 上板
成员一轮  myteam_claim_task(attempt at-…) → write tasks/longrun-t1.md（含 [Verification evidence]，
          kind=commands / 退出码 0 / 断言数 3）→ task.evidence → task.completed
门禁      gate:review：m2-reviewer 交叉审查 pass → task.deliverable → gate:archive：host 落位校验 pass
任务      task-1 终态 done（gateVerdicts = { review: pass, archive: pass }）
成员二轮（空闲后被再次唤醒）  myteam_recall("上岗自述") → returnedCount=1，
          命中第一轮写入的 m-mwqloe1z-1（id / title / evidence 指针完全一致）
```

成员自己在交付物里的结论（原样）：

> **记忆跨回合留存成立**。第一轮由 `myteam_remember` 写入的 `m-mwqloe1z-1` 在本轮召回中被原样读出，
> id / title / evidence 指针与写入时一致，且该 evidence 文件此刻仍在盘上；召回走的是成员私有 bank
> （SQLite，`member:longrun-1:m1-implementer`），不依赖会话上下文。

成员还自己数清了工具面：**13 个 myteam 工具**、按调用者分叉的队长读面/写面工具**不在**它的工具面里——
这是 C5 收窄在真机上的自证（不是我们读代码推断的）。

这一轮抓到的缺陷（第 9 个，已修 + 用例）：

| 现象 | 根因 | 修法 |
|---|---|---|
| 成员**认领前**读任务报 `invalid output: value is not lossless JSON`，认领后正常 | `myteam_get_task` 把可选字段写成 `key: undefined`（未认领时 `attemptId`、非叶子任务的 `deliverableSpec`），工具返回值要过 lossless JSON 校验，一个 undefined 就整次失败 | 可选字段改成条件展开（`...(x !== undefined ? {x} : {})`） |
| 同一位队长会话里开**第二个团队**，spawn 直接失败：`agent name "implementer-1" is already used by another subagent you created` | 子代理的模型可见名在**父会话**里必须唯一，而成员实例名是按团队编号的（每个团队都有 `implementer-1`） | 名字改成 `<teamId>-<instanceName>`（按宿主的命名规则 sanitize）；仍撞名（同团队释放后重用）就去掉 `name` 重试，让宿主分配 `agent-N` |
| 成员把交付物写进**会话 cwd**（`E:\Workplace\extension\dsh-myteam`），archive 门按团队工作区根找不到文件 | 上岗简报从没写过「团队工作区根」是什么、`deliverableSpec.path` 相对谁解析；成员只能猜 | 简报新增「交付物落位（必读）」：给出团队工作区根绝对路径 + 要求用绝对路径写 |

真机复验（重启后，成员自己记录，原样）：

> 在**未认领**状态下调 `myteam_get_task(taskId="task-2")` → `status: ok`、`task.state: ready`、
> **没有** `attemptId` 字段；**未出现**上一版的报错 `invalid output: value is not lossless JSON`。
> 结论：认领前读取正常，lossless JSON 回归通过。

（同一条记录里它提到「交付物落位两处都写、逐字节一致」——正是上表第三条缺陷的现场：它自己发现了根不一致。）

**顺序理由**：P1/P2 与成员载体无关，先落地能立刻受益；P3 是 P4 的前置（否则成员视图拿不到服务）；
P4 风险最高，放在服务分层之后一次完成。

---

### 4.5 测试分工：桌面端写、web 实例测（用户定案）

插件产物是 `lib/*.mjs`，桌面端进程**只在启动时加载**——改完代码必须重启桌面端才生效，
一天重启十几次既慢又打断手上的会话。约定：

| 角色 | 谁 | 怎么起 |
|---|---|---|
| 写（改代码、跑单测与门禁） | 桌面端（本仓） | 照常 `npm test` / `node tools/check-all.mjs` |
| 测（活体验收：建队、spawn、真模型成员） | 独立 `dsh web` 实例 | `tools\boot-test-web.cmd [stage] [tag]` |

要点：
- 这个实例**每次启动重新加载 lib**，所以永远跑最新代码——测完不用重启桌面端。
- **没有密码页**：`dsh-web-login` 在该 profile 的测试 patch 里被 `disabled: true`（实测 `/__login` → 404）；
  启动打印的 `http://127.0.0.1:3080/?token=…` 直接进（token 是宿主自带鉴权，不是密码）。
- 端口固定 3080：**上一轮实例没退干净会 `EADDRINUSE`**，重跑前先按端口杀进程。

## 5. 验收（P4 完成后）
四条都已在真机跑过（§4.2，2026-11-21，真模型 + 真实工具入口）：

| Given / When / Then | 结果 |
|---|---|
| 队长 spawn / 新会话 `origin='subagent'`、`parentSession=队长会话`、`delegationDepth=1`、**看不到** Lead 工具 | ✅ 实测 `leadLeak=[]`，25 个工具 = 13 成员工具 + 12 根层工具 |
| 成员在跑 / 释放 / activation 被 dispose、账本 `member.released`、子代理树里消失 | ✅ dispose 后 `agents.get(childId)` 为 undefined（§4.2 缺陷 5 修好后） |
| 成员写记忆 / `myteam_recall` / 召回带 evidence，且别的 team 的 bank 查不到 | ✅ 两个成员 bank 各 1 条，互不可见（`bank=member:<team>:<member>`） |
| 重启 / 队长再发消息 / 要么续起，要么可行动错误（不静默丢） | ✅ `delivered:false` +「先 release 再 spawn」，账本照落 |

---

## 6. 风险与不做的部分

| 风险 | 处置 |
|---|---|
| 面板 `MyTeamRemote` 端点随服务迁移而变 | 门面留在 root、namespace 不变；迁移后跑 t13p/t13r/t143 |
| `host.ts` A6 顶格 4376 | 新逻辑落 `host/` 族与 `core/`；必要时先做结构重构（本轮拆出 `host/delivery.ts` / `host/member-lookup.ts`） |
| 子代理树 UI 的 `subagentCatalog` 由宿主写 | 不自己拼 catalog；身份只认账本 + `childId` |
| 老 `memory.md` | P2 提供一次性导入（`import:memory.md`），文件保留只读，不双写 |
| 明确不做 | 向量检索、自动页维护（Hindsight 服务端能力）、把知识库也搬进 SQLite（知识库仍是策展文件，记忆才是 SQLite） |
