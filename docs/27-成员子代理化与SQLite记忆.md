# 27-成员子代理化与 SQLite 记忆（ADR-010 草案）

> 用户定案（2026-11-21）：**成员改用子代理**；记忆等长期状态要存下来，
> 借鉴 Hindsight 的记忆方法，用 SQLite。
> 本文只写「怎么改、按什么顺序改、怎么验收」；取证见 [docs/15 §9](15-官方AgentTeam对照与借鉴.md)。

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

**未验证的部分**（诚实记录）：成员真正跑一轮模型（需要可用的队长会话与模型路由）、以及长跑中记忆的积累质量。工具面、父子链、preset 挂载已由上面的探针证实。
| **P5** | 重启后按需恢复 + 记忆注入（上岗时召回 top-5） | kill 后重启，成员可被唤醒且记忆仍在 | 待做 |

**顺序理由**：P1/P2 与成员载体无关，先落地能立刻受益；P3 是 P4 的前置（否则成员视图拿不到服务）；
P4 风险最高，放在服务分层之后一次完成。

---

## 5. 验收（P4 完成后）

- Given 队长会话 / When `myteam_spawn_member(roleId)` / Then
  新会话 `origin='subagent'`、`parentSession=队长会话`、`delegationDepth=1`，且**看不到** Lead 工具。
- Given 成员正在跑 / When 释放成员 / Then activation 被 dispose、账本落 `member.released`、子代理树里消失。
- Given 成员写完一条记忆 / When `myteam_recall` / Then 召回带 evidence 与 score，且另一个 team 的 bank 查不到。
- Given 重启 / When 船长再发消息给成员 / Then 要么成员被续起（childId 复用），要么返回可行动错误（不静默丢消息）。

---

## 6. 风险与不做的部分

| 风险 | 处置 |
|---|---|
| 面板 `MyTeamRemote` 端点随服务迁移而变 | 门面留在 root、namespace 不变；迁移后跑 t13p/t13r/t143 |
| `host.ts` A6 顶格 4377 | 新逻辑落 `host/` 族与 `core/`；必要时先做结构重构 |
| 子代理树 UI 的 `subagentCatalog` 由宿主写 | 不自己拼 catalog；身份只认账本 + `childId` |
| 老 `memory.md` | P2 提供一次性导入（`import:memory.md`），文件保留只读，不双写 |
| 明确不做 | 向量检索、自动页维护（Hindsight 服务端能力）、把知识库也搬进 SQLite（知识库仍是策展文件，记忆才是 SQLite） |
