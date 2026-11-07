# plugin — 插件实现（可装载单元）

> `dsh-plugin-myteam` 的可装载单元：`src/` 是唯一实现，`lib/` 是构建产物，`cordis.patch.yml` 是装载声明。
> 读者：要构建、调试、扩展插件源码的开发者。面板怎么用见[根 README](../README.md)，对外契约见 [docs/04](../docs/04-API与数据契约.md)。

## 一句话定位

`package.json` 的 `main` 与 `exports["."]` 都指向 `./lib/host.mjs` —— **宿主直接装载构建产物，不装载 src**。所以「改 `src/` 必须 `npm run bundle`」不是习俗而是硬约束：漏跑一次，宿主跑的就是旧代码（R38 门禁由 `t42-lib-manifest` 守着）。

## 快速开始

```bash
cd plugin

npm run bundle    # src/**.ts → lib/**.mjs（暂存构建 → node --check → 原子 rename）
npm test          # = node --test test/*.test.ts test/*.test.js
```

插件**零 devDependency**：构建与测试都靠 Node 自带的类型擦除（`stripTypeScriptTypes` + `node --test`），不需要装 TypeScript。想要类型检查就自己装一份（不写进 `package.json`）：

```bash
npm i -D --no-save typescript
npx tsc -p tsconfig.json --noEmit
```

## 目录地图

| 路径 | 职责 |
|---|---|
| `src/` | TypeScript 源码真身：42 个 `.ts` + 1 个遗留转发 `host.js` |
| `lib/` | 构建产物：42 个 `.mjs` + `build-manifest.json`；`main` 指向 `lib/host.mjs`，随包分发 |
| `client/` | `client.js` 面板浏览器产物——**不经 src 编译**，由 `exports["./client"]` 直载，指纹单独记 |
| `test/` | 单测 67 个文件（`node --test`） |
| `scripts/` | `build-lib.mjs`：构建脚本（代码生成器，不是运行时） |
| `locale/` | 面板文案 `zh.json` / `en.json` |
| `cordis.patch.yml` | 装载声明（preset EntryGroup 三行，见下文「装载形态」） |
| `icon.svg` | 插件图标（`exports["./icon"]`） |

项目级数据落在 `<project>/.dsh-myteam/`（`config/` 角色与团队配置、`tasks/<teamId>/ledger.jsonl` 任务账本**入库**；`history/`、`state/`、`export/` 不入库）。目录契约的唯一事实源是 `src/core/workspace/layout.ts` 的 `storeLayout()`，口径见 [docs/17](../docs/17-项目级存储架构.md)。

## 源码结构（五域）

依赖方向单向：**D1 ← D2 ← D3**，D4 / D5 依赖 D1（口径见 [docs/03 §模块划分](../docs/03-架构与ADR.md)）。纪律：判定逻辑做成无 IO 的纯函数，宿主接线留在 `host.ts` —— 于是「能不能领任务」「门禁判什么」都能在无 `ctx` 环境下单测。

| 域 | 文件 | 职责 |
|---|---|---|
| **D1 账本** | `core/ledger/ledger.ts` | append-only JSONL：事件类型白名单、payload 校验、seq 连续、`rules.version` 首事件、崩溃残行截断 |
| | `core/ledger/token-sidecar.ts` | tokenUsage 四桶 → 按天桶聚合 → `tokens.json` 侧车（绝不进模型上下文） |
| **D2 调度** | `core/scheduler/state.ts` | 任务状态机与投影类型（`backlog → ready → in_progress → gate:* → done`；`failed` / `cancelled` 终态） |
| | `core/scheduler/fold.ts` | 账本事件 → `TeamProjection` 逐型折叠，可从零重放重建（纯函数） |
| | `core/scheduler/wake.ts` | 四种因果唤醒判定（assign / message / resume / revoke）→ `agent.followup()`；无事件即零请求 |
| | `core/scheduler/recovery.ts` | archive 门禁的落位校验 + 重启后的有序恢复表 |
| **D3 成员** | `core/members/member-setup.ts` | `setup(agentCtx)` 作用域组装：9 个成员工具 + `tools.restrict` 收窄 + 角色提示词 + 技能 provider |
| | `core/members/capability-guard.ts` | 技能 / MCP allowlist 的执行面（MCP 真收窄；技能走 deny-by-shadow，无 deny API） |
| | `core/members/memory.ts` | 成员记忆区（`memory.md` + `notes/`）的幂等播种与事后审计 |
| | `core/members/smoke.ts` | 动态冒烟探针（六项），需真实宿主会话，**不进 CI** |
| **D4 角色库** | `core/roles/role-store.ts` | 三来源解析（builtin / global / project）、引用即复制、C7 守门、名册队长唯一性 |
| | `core/roles/builtin-roles.ts` | 内置只读角色 + 五档 `RoleOrigin`（builtin < plugin < global < project-role < project） |
| | `core/roles/role-ops.ts` | 角色库写操作统一入口 `roleOp` —— 工具侧与面板侧共用同一份实现 |
| | `core/roles/captain-skills.ts` | 队长内置技能：create-role / modify-role / create-team / write-team-charter |
| | `core/roles/session-defaults.ts` | 单角色调用（`/myteam+<id>`）的落盘与跨重启恢复 |
| **D5 接口** | `tools/defs.ts` | `memberToolDefs()` / `leadToolDefs()` 的纯数据定义（见下文「工具面」） |
| | `remote/service.ts` | `MyTeamRemote`：28 个 Remote 方法（手写 marker 等价装饰器 —— strip-only 环境无装饰器语法） |
| | `remote/views.ts` | 面板只读投影纯函数：看板 / 详情 / token / 审计 / 配置 |

跨域模块：

| 目录 | 文件 | 职责 |
|---|---|---|
| `core/config/` | `team-config.ts` · `config-view.ts` | 三层配置合并（默认 < 项目 < 团队，数组整条替换）+ 在线/离线共用同一份配置载荷 |
| `core/tasks/` | `diff.ts` · `graph.ts` · `readiness.ts` | 字段级 diff（兼判证据过期）· 依赖图层级与边集（横/竖双布局共用）· 「为什么没人领」诊断 |
| `core/knowledge/` | `knowledge.ts` · `evidence-pointer.ts` | 团队知识库（策展制 + 索引预算 ≤40 行）· `task:` / `file:` / `session:` 证据指针解析 |
| `core/index/` | `team-index.ts` · `offline-view.ts` | 工作区级 / 跨工作区级派生索引（可全量重建）· 离线只读看板（不构造 TeamService） |
| `core/workspace/` | `layout.ts` | `.dsh-myteam/` 目录契约**唯一事实源**：`storeLayout()` / `resolveProjectRoot()` |
| `core/gates/` | `command-gate.ts` · `scope-audit.ts` | verify 门由 host 执行命令取真实退出码（argv 直传，无 shell）· 完成时 `writeScopes` 越界对账 |
| `core/contributions/` | `contract.ts` · `discover.ts` · `parse.ts` | 插件团队贡献契约：类型常量 / 目录发现 / **纯函数**解析与冲突裁决（只 `JSON.parse`，永不 `import()`） |
| `core/archive/` | `archive-store.ts` | 解散归档落盘：`MANIFEST.json` / `team.json` / `tokens.json` / `members/` |
| `core/host/` | `session-handoff.ts` · `team-charter.ts` | 会话移交（摘要 + 新开会话，不做原地变身）· 团队章程 → 队长 system prompt 注入 |
| `core/` | `errors.ts` | `MT_*` 错误码唯一来源（`MT_CODES` / `MT_CODE_DOCS`；docs/04 错误码表由 `tools/gen-error-docs.mjs` 生成） |
| | `service.ts` | `TeamService`：单写者写管线（校验 → 副本 apply → 账本 append），拒绝式返回而非抛异常 |

宿主装配入口：

| 文件 | 职责 |
|---|---|
| `host.ts` | `apply(ctx, config)` + `inject`：目录初始化、TeamService 惰性创建与冷启动重放、Lead 工具注册、成员 spawn、唤醒管线 |
| `panel.ts` | `MyTeamPanelFacade`：根级 typert remote 门面（43 个方法），经 `agentPresets.serviceFor(agent, 'myteam')` 读隔离服务 |
| `host-workspace.ts` | 旧导出名兼容层（`ensureWorkplaceDirs` 等），实现已收口到 `core/workspace/layout.ts` |
| `host.js` | 遗留 import 路径的薄转发（仅 `test/t1-workplace.test.js` 用），自身无逻辑 |

## 工具面（44 个 `myteam_*`）

定义在 `src/tools/defs.ts`，纯数据；写操作 execute 全部走 `TeamService.commit()`（单写者管线），读走投影。两层注册（ADR-003）：Lead 工具挂 **preset 层**（仅队长会话可见），成员工具挂**成员 setup 作用域**（仅成员会话可见）。下表省略 `myteam_` 前缀。

| 分组 | 队长 35 个 | 成员 9 个 |
|---|---|---|
| 计划与团队 | `submit_plan` `approve_plan` `revise_plan` `discard_plan` `update_team` `disband` | — |
| 任务 | `create_task` `create_tasks` `edit_task` `assign_task` `participate_task` `reassign_task` `revoke_attempt` `rescope_task` `cancel_task` `batch_task_op` | `get_task` `list_tasks` `claim_task` `update_task` |
| 成员与消息 | `spawn_member` `release_member` `message` `interrupt` | `peer_message` `wait_for_change` |
| 门禁与提案 | `review_task` `resolve_proposal` | `propose_task_change` `escalate_task` |
| 角色与预设 | `create_role` `update_role` `delete_role` `set_project_role` `apply_roles` `list_presets` `save_preset` `copy_preset` `delete_preset` | — |
| 知识 | `adopt_knowledge` | `read_knowledge` |
| 插件贡献 | `list_contributions` `reload_contributions` | — |
| 配置 | `reset_team_config` | — |

几条贯穿全表的口径：任务 / 团队 / 知识类写操作都要 `teamId`；角色与预设是**配置资产**，不带 `teamId`（它们不属于任何团队）。成员侧更新必须带 `attemptId`（陈旧即拒）；`done` 申报必须附证据块（`kind=commands` 或 `kind=na`）；两段确认型操作第一次不带 `confirm` 时只返回影响面，不落账。

## 装载形态（`cordis.patch.yml`）

preset EntryGroup 三行（ADR-005）：

| 行 id | name | 作用 |
|---|---|---|
| `myteam-carrier` | `dsh-plugin-myteam` | 客户端载体行。`config.carrier=true` 让 apply 直接返回 —— 只为了让 `client.js` 进 `window.__DSH_BOOT__` 客户端图（含 `/` 的说明符不进图） |
| `myteam-panel` | `dsh-plugin-myteam/panel` | 根级门面，`inject: ['agents', 'agentPresets']`。隔离服务进不了网关 claims，只有 root 可见服务能提供 `myteam/<method>` 端点 |
| `myteam-preset-captain` | `@deepseek-ai/dsh-agent-preset` | 「团队模式」预设入口，组合内两行子插件：`myteam-host`（`inject: ['tools','agents']`）+ `myteam-persona-captain`（队长人设） |

两条删不得的约束：

- **`isolate: { myteam: true }`**：preset 子树把服务发布到 root realm 会触发 `Preset services require isolate realms: myteam`，预设卡片直接「加载失败」。
- **`@deepseek-ai/dsh-persona` 只能挂在 agent scope**（preset 子行）；顶层全局挂载与 deployment persona 冲突，会 fail loud。

成员工具不在这里注册 —— 由 `agents.create` 的 `setup(agentCtx)` 在成员作用域内注册，preset 只负责队长。

## 构建纪律（`scripts/build-lib.mjs`）

`main` 直指 `lib/`，宿主直接 require 产物。旧实现「先 `rmSync(lib)` 再逐文件写、最后才 `throw`」—— 一次编译失败就留下半截 `lib/`，插件整体不可装载且要重启宿主才能恢复（R39）。现在**闸门顺序本身就是协议**，不要调换：

| 闸 | 做什么 | 失败后果 |
|---|---|---|
| 0 · 暂存构建 | 全部产物先写 `lib.__staging__/`（与 `lib/` 同卷，`rename` 才是原子的），**任何情况不直写 `lib/`** | 删暂存目录，`lib/` 毫发无伤 |
| 1 · 语法校验 | 每个暂存产物跑 `node --check`（按 ESM 解析）。`stripTypeScriptTypes` 只保证「类型擦除成功」，不保证输出是合法 JS | 抛错并清理暂存，`lib/` 原样 |
| 2 · 原子替换 | 全绿才 `rmSync(lib)` + `renameSync(staging → lib)` | 宿主只会看到旧目录或新目录，不会看到半截 |
| 3 · 宿主在跑就拒绝 | TTY 交互确认；`--force` / `-y` / `DSH_BUILD_YES=1` 跳过；非 TTY（CI/管道）自动放行并告警 | 取消则 `lib/` 未做任何改动 |

两条旁路门禁：

- **产物卫生（D9）**：`//# sourceURL=` 只写 repo 相对路径；构建末尾扫全部产物，命中 `file:///` 或盘符绝对路径即失败。
- **`lib/build-manifest.json`**：`sourceHash`（全部 src 按路径排序后「路径\0内容」哈希）+ `clientHash`（`client/client.js` 原始字节）。`t42-lib-manifest` 复算比对 —— **改 src 忘重跑 bundle 时测试立即红**。

独立复算面：

```bash
node tools/check-drift.mjs    # 退出码 0 = MISMATCH: 0
```

它直接复用 `build-lib.mjs` 导出的 `compileSource` —— 编译口径只有一个来源，不会再出现「两边各写一份实现、永远差一行」的 100% 假阳性。

## 测试

```bash
cd plugin && npm test
```

- `test/` 下 67 个测试文件；**条数以 `npm test` 实际输出为准**（增删测试后不要抄旧数字）。
- 门禁型测试不是装饰：`t42`（src↔lib 指纹）、`t80`（构建三道闸）、`t81`（错误码双向锁死）、`t76`（贡献契约）都在「实现与声明分叉」时变红。
- 需要真实宿主会话的探针（`core/members/smoke.ts`）不在 CI 内，按文件头注释在插件 dev profile 里跑。

## 相关文档

| 文档 | 什么时候读 |
|---|---|
| [../README.md](../README.md) | 项目定位、仓库规范、当前状态 |
| [../docs/03-架构与ADR.md](../docs/03-架构与ADR.md) | 五域划分、核心数据流、ADR-001~014 |
| [../docs/04-API与数据契约.md](../docs/04-API与数据契约.md) | 工具 / 端点 / 错误码契约（错误码表由 `tools/gen-error-docs.mjs` 生成，不要手改） |
| [../docs/11-数据模型与存储设计.md](../docs/11-数据模型与存储设计.md) | 账本事件与投影字段 |
| [../docs/16-插件团队贡献契约.md](../docs/16-插件团队贡献契约.md) | 第三方插件怎么贡献角色与团队模板 |
| [../skills/myteam-plugin-team/README.md](../skills/myteam-plugin-team/README.md) | 贡献方视角的 skill 包与可执行校验器 |

---

[← 上级目录](../README.md)
