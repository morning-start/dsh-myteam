# 配置 Schema 定稿（FR-9.1 / FR-14.3 / FR-18 / R12 / R4b）

> **状态：定稿**（2026-11-08，CHG-116，M2-7 的前置交付）。
>
> 三处同源，改一处必须改三处（`t89-config-schema` 门禁锁死）：
> - 机器可读 schema：[plugin/schema/team-config.schema.json](../plugin/schema/team-config.schema.json)（JSON Schema draft-07）
> - 代码常量与合并实现：[plugin/src/core/config/team-config.ts](../plugin/src/core/config/team-config.ts)（`DEFAULT_CONFIG` / `PATCH_CEILINGS`）
> - 本文档（字段语义、组合面、迁移口径）
>
> 关联：FR-9.1（配置驱动）、FR-14.3（设置页）、FR-18（create-team 章程）、FR-13.2（create-role 扩充）、R12（三层合并复杂度）、R4b（patch × config × 临时参数）、CHG-55/56/102（落盘与三层合并）、CHG-91（插件贡献契约 v1）。

---

## 0. 定稿范围

| 件 | 是什么 | 不是 |
|---|---|---|
| **① `team.config.json`** | 行为配置：看板列 / 泳道 / 视图 / 规模上限 / 门禁默认 / 任务类型 / 澄清 / 记忆 / 审计 | 不是数据模型——团队/角色/任务等实体的权威是账本（docs/04） |
| **② 角色 schema** | 角色定义的字段面与约束（提示词 / 工具策略 / 技能 / MCP / 模型 / 兴趣词 / 来源） | 不是「角色实例」——在册成员是团队账本里的事件 |
| **③ 团队模板（preset）组合面** | 模板能声明哪些配置段、建团时怎么落到团队层 | 不是配置的第四层——模板只是**建团时的写入来源** |

**定稿之后 M2-7 不再有设计前置**：create-team / create-role 两个随行 skill 已分别由 CHG-88/93（章程注入）与 CHG-94（角色扩充）实装，本文档补上它们引用的配置面。

---

## 1. 文件布局与读写方

| 层 | 路径 | 写方 | 读方 |
|---|---|---|---|
| 内置默认 | 代码常量 `DEFAULT_CONFIG`（不可写） | 开发者 | 所有团队 |
| 项目层 | `<workspace>/.dsh-myteam/config/team.config.json` | 用户 / 项目管理员（手写或设置页） | 该项目**全部**团队 |
| 团队层 | `<workspace>/.dsh-myteam/state/teams/<teamId>/team.config.json` | `submit_plan({presetId})` 建团时**原子写**（tmp + rename）；`resetTeamConfig` 删除 | 该团队 |

- 落盘根统一由 `core/workspace/layout.ts` 提供（CHG-102：项目级 `.dsh-myteam/`，不再写用户全局 profile）。
- 读：`TeamService` 构造时 `loadEffectiveConfig(readProjectConfigRaw(ws), readTeamConfigRaw(ws, teamId))`；文件缺失或坏 JSON → `undefined`（该层视为未提供，回退默认，不抛错）。
- 写：**只允许整文件替换**（`writeTeamConfigRaw` 原子写），不做增量 patch 写文件——半写会让团队起不来。

---

## 2. 合并语义（R12 / K5 / R4b）

1. **顺序**：内置默认 ← 项目层 ← 团队层（后层覆盖前层，逐层独立校验）。
2. **数组整条替换**（`board.columns` / `board.cardFields` / `pipeline.stages` / `views.tabs` / 每个 `taskTypes.*.gateChain`）：不拼接、不深度合并（K5 反坑）。
3. **对象段落按子键合并**（`board` / `pipeline` / `dag` / `views` / `limits` / `gates` / `taskTypes` / `clarify` / `memory` / `audit` 的内部子键）；子键值仍是对象时**浅并一层**，不做无限递归。
4. **未知键**：告警 `unknown config key "<key>" ignored`，**不报错**——这是前后兼容的承重墙（旧版本读新配置不会崩）。
5. **逐层校验**（每层各自判定，失败**只废这一层**）：
   - 结构校验 `isStructurallyValidConfig`：只拒「类型明显错误」（已知段落存在但不是对象、`board.columns` 不是字符串数组）；
   - 终态覆盖 `validateCoverage`：`done` / `failed` / `blocked` / `cancelled` 必须被 `board.columns ∪ board.columnMapping` 覆盖（看板不能有任务落不进任何列）。
   - 失败 → 该层整层忽略、`fellBack = true`、告警写进 `warnings`，**其余层保留**（拒绝式但不误伤）。
6. **硬上限钳制**（`applyCeilings`，更严格者胜）：`limits.maxMembers ≤ 6`、`limits.memberMaxDepth ≤ 0`，超出即钳制 + 告警（`PATCH_CEILINGS` 是 patch 层给不出更高值的硬顶）。
7. **结果面**：`loadEffectiveConfig` 返回 `{ config, warnings, fellBack, applied: { project, team } }`；`getConfig` 的 `source ∈ default | project | team` 是**最后生效的层**，`mergeChain` 展示三层与各自是否生效。

---

## 3. 字段表：`team.config.json`

> 「影响面」列说明改这个字段用户能看见什么；「校验」列就是 schema 里的约束。

### 3.1 `board` —— 看板列与状态归并

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `columns` | `string[]` | `["backlog","ready","running","gates","done"]` | 非空、每项非空串 | 看板列顺序（左 → 右），列头计数 |
| `columnMapping` | `Record<string, string[]>` | `running:[in_progress,re-scoping]`、`gates:[gate:review,gate:verify,gate:archive]`、`done:[done]`、`backlog:[failed,blocked,cancelled]` | 值为字符串数组；**归并结果必须覆盖全部终态** | 任务状态 → 列的归并；终态兜底桶 |
| `cardFields` | `("assignee"\|"deps"\|"gateState"\|"tokens")[]` | `["assignee","deps","gateState","tokens"]` | 枚举去重 | 看板卡上显示哪些元数据 |
| `dragRules` | `"state-machine"` | `"state-machine"` | 枚举（v1 只有状态机） | 拖拽非法流转：抖动 150ms + 弹回 + 左下角回执 |

### 3.2 `pipeline` —— 蛇形泳道图

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `swimlaneBy` | `"stage"\|"member"\|"priority"` | `"stage"` | 枚举 | 泳道按什么分组 |
| `stages` | `string[]` | `["plan","dev","gates","integrate"]` | 非空 | 蛇形布局的阶段节点 |
| `layout` | `"serpentine"\|"linear"` | `"serpentine"` | 枚举 | 蛇形 / 线性排布 |

### 3.3 `dag` —— 依赖图

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `showModel` | `boolean` | `true` | — | 节点上是否显示模型徽标 |
| `collapseGroups` | `boolean` | `true` | — | 同层节点是否折叠成组 |
| `direction` | `"LR"\|"TB"` | `"LR"` | 枚举 | 横向 / 纵向布局 |

### 3.4 `views` —— 视图条

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `default` | `"board"\|"swimlane"\|"dag"\|"roster"` | `"board"` | 枚举 | 打开团队时默认视图 |
| `tabs` | 同上枚举数组 | 全四视图 | 枚举、去重 | 视图条上出现哪些切换 |

### 3.5 `limits` —— 规模上限（**含 patch 硬上限**）

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `maxMembers` | `integer` | `6` | `1..6`（硬上限 6） | 团队最多成员数；超过即钳制 + 告警 |
| `memberMaxDepth` | `integer` | `0` | `0..0`（硬上限 0） | 成员再派成员的深度；ADR-010 定死「成员内不得嵌套委派」 |
| `maxTasks` | `integer` | `20` | `≥1` | 单团队任务数上限 |

### 3.6 `gates` —— 门禁默认

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | — | 门禁命令是否执行 |
| `commandTimeoutMs` | `integer` | `120000` | `1000..600000` | 门禁命令超时（超时判 fail） |

### 3.7 `taskTypes` —— 任务类型 → 门禁链

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `taskTypes.<type>.gateChain` | `("review"\|"verify"\|"archive")[]` | `default:[review,archive]`、`dev:[review,verify,archive]` | 枚举 | `create_task({taskType})` 展开出的门禁链；**显式 `gateChain` 优先** |

### 3.8 `clarify` —— 澄清轮次

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `maxRounds` | `integer` | `3` | `≥0` | 澄清最多问几轮（超出强制出计划） |

### 3.9 `memory` —— 记忆审计

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `evidenceRequired` | `boolean` | `true` | — | 无证据指针的记忆条目是否被审计落账本（CHG-19 / ADR-009） |

### 3.10 `audit` —— scope 完成审计

| 字段 | 类型 | 默认 | 校验 | 影响面 |
|---|---|---|---|---|
| `writeScopes` | `boolean` | `true` | — | 任务声明 `writeScopes` 时是否对照证据块申报文件对账；越界**只留痕不阻断**（CHG-87 / FR-5.4） |

---

## 4. 角色 schema 扩展（FR-13.2 / CHG-74 / CHG-89）

角色定义落 `roles/<id>.json`（项目库）/ 全局库 / 内置 / 插件贡献；**运行时不认非项目库**（R13：内置与全局是复制源，改它们不生效不是 bug）。字段面：

| 字段 | 类型 | 必填 | 校验 | 语义 |
|---|---|---|---|---|
| `id` | `string` | ✅ | `^[a-z0-9][a-z0-9-]*$`，全库唯一 | 角色 id（`reviewer` / `implementer` …） |
| `name` | `string` | ✅ | 非空 | 展示名 |
| `description` | `string` | ✅ | — | 一句话职责（面板卡描述） |
| `systemPrompt` | `string` | ✅ | — | 角色系统提示词（create-role 的主要产出） |
| `version` | `integer` | ✅ | `≥1` | 定义版本（副本 / 发布 / 审计用） |
| `isCaptain` | `boolean` | — | 预设**必含且仅含一个** | 队长标记；内置仅 `captain` 带 |
| `toolPolicy` | `{ allow?: string[]; deny?: string[] }` | — | 数组 | C5：**allow 只能收窄不能扩权**——成员 setup 时据此生成 restrict 掩码 |
| `skills` | `string[]` | — | 数组 | 角色绑定的技能（全局技能 id） |
| `mcpAllowlist` | `string[]` | — | 数组 | 该角色可见的 MCP 工具（`mcp__<server>__<tool>` 前缀） |
| `model` | `{ provider: string; model: string }` | — | 两字段非空 | 模型路由；缺省走会话默认 |
| `interestWords` | `string[]` | — | 数组 | **软信号**（派单理由 / 认领排序 / 审计追溯），**不是权限**——权限只由 `toolPolicy` / `skills` / `mcpAllowlist` 决定 |
| `origin` | `string` | — | `^(builtin\|global\|plugin):<id>$` | fork 来源标记（复制成项目副本时写入） |

**与两个随行 skill 的对应**（create-role 扩充，CHG-94）：

| create-role 的输入 | 落到角色 schema |
|---|---|
| 提示词（职责 / 边界 / 工作方式） | `systemPrompt` |
| 技能与已有 MCP 挂接 | `skills` + `mcpAllowlist`（**已有**连接，不新建连接） |
| 记忆与汇报机制 | `systemPrompt` 里的固定段落（记忆写入 / 汇报格式）+ `toolPolicy` 收窄 |
| 兴趣词 | `interestWords`（软信号，进 identity 快照 C3） |

---

## 5. 团队模板（preset）组合面（CHG-55 / CHG-91）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `id` | `string` | ✅ | 模板 id（`^[a-z0-9][a-z0-9-]*$`） |
| `name` | `string` | ✅ | 展示名 |
| `description` | `string` | — | 一句话说明 |
| `members` | `{ roleId, instanceName?, skills?, mcpAllowlist? }[]` | ✅ | 队员（队长由预设隐式提供，**不得**含 captain） |
| `board` | `{ columns?, columnMapping? }` | — | 只写这两段；未声明走默认 |
| `pipeline` | `{ swimlaneBy?, stages?, layout? }` | — | 同上 |
| `gates` | `{ enabled?, commandTimeoutMs? }` | — | 同上 |
| `taskTypes` | `Record<string, { gateChain: string[] }>` | — | 同上 |
| `version` | `integer` | — | 模板版本 |
| `namespace` | `string` | — | 插件贡献的分组名（缺省 = 插件 id 第一段） |
| `charter` | `string` | — | 团队章程 markdown（FR-18）：谁沟通、谁存档、文件放哪、做到什么程度 |

**组合规则**（`configOverrideFromPreset`）：

1. 模板**只声明它负责的段**；`configOverrideFromPreset` 只取显式声明的 `board/pipeline/gates/taskTypes`，其余段走插件默认。
2. 建团流程：`submit_plan({presetId})` → 在 `TeamService` 首次构造**之前**把覆盖按 `board/pipeline/gates/taskTypes` 原子写进团队层 `team.config.json`（tmp + rename）→ `TeamService` 构造时按 §2 三层合并读出生效配置。
3. 模板声明了非法配置（如终态未覆盖）→ **团队层被忽略 + 告警**，建团不阻断（默认配置兜底）；告警出现在 `getConfig().warnings` 与建团回执里。
4. 插件贡献（`origin: plugin`）走同一套 `PresetDefinition` 校验（docs/16 契约 v1）；`charter` 由 CHG-88/93 注入队长 system prompt。
5. 模板**不能**声明 `limits` / `views` / `clarify` / `memory` / `audit`：这些是团队运行期策略，不是建团模板的职责（模板只负责「开箱长什么样」）。

---

## 6. 版本与迁移（定稿裁决）

**裁决：`team.config.json` 不引入顶层 `version` 字段。**

理由：

1. 配置是**行为开关**，不是数据模型；账本/投影的兼容由事件版本承担（docs/04）。
2. 引入 `version` 会让**存量文件全部非法**（缺字段 → 校验失败 → 整层回退），代价远大于收益。
3. 兼容靠三件事，已经够用：**未知键告警忽略**（旧版本读新配置不崩）、**缺省补默认**（新版本读旧配置不崩）、**逐层回退**（坏层不连坐）。

破坏性变更的迁移口径（写进对应 CHG 行，不提供自动迁移脚本）：

- **删字段**：旧文件里该键变成未知键 → 告警忽略；面板「设置」页在 JSON 源视图里仍展示原文并标告警，表单不渲染。
- **改语义**：CHG 记录里必须写「旧语义 → 新语义 + 默认值」，并用一个 `t8x` 用例锁住新语义。
- **改类型**：视同「删 + 加」，同上。

角色定义与模板**有** `version`（整数、单调），用于副本 / 发布 / 审计追溯，不参与配置合并。

---

## 7. 设置页写契约（M2-3 的接口面；本文档即其契约）

| 方法 | 入参 | 返回 | 状态 |
|---|---|---|---|
| `getConfig` | `{ teamId? }` | `{ status, config, source, mergeChain, warnings, patchCeilings }` | ✅ 已实现（CHG-49/55/56） |
| `resetTeamConfig` | `{ teamId, confirm: true }` | `{ status: 'reset'\|'noop', teamId, configSource }` | ✅ 已实现（CHG-57 工具面 / **CHG-117 面板端点**） |
| `saveTeamConfig` | `{ teamId, config, confirm? }` | 同 `getConfig` + 影响面回执 | ✅ 已实现（**CHG-117**） |

`saveTeamConfig` 的约束（M2-3 实现时必须遵守）：

1. 先 `isStructurallyValidConfig` + `validateCoverage`，失败返回 `MT_VALIDATION`（带 `field` 与 `reason`），**零写入**；
2. 原子写团队层（tmp + rename），写后重读并返回**生效配置**（不是回显入参）；
3. `confirm` 语义：影响面（成员数 / 在跑任务数 / 门禁链变化）需要两段确认，与解散/归档同源；
4. 未知键**不拒**（写入保留，`warnings` 回显），保证「JSON 源视图 → 表单 → 保存」不丢用户手写内容；
5. 表单与 JSON 源视图**双向一致**：表单是 schema 驱动的子集，源视图是全文；两者保存都走同一路径。

---

## 8. 示例

**最小（只改看板列）**：

```json
{
  "board": {
    "columns": ["backlog", "ready", "running", "gates", "done"]
  }
}
```

**完整**：

```json
{
  "board": {
    "columns": ["backlog", "ready", "running", "gates", "done"],
    "columnMapping": {
      "running": ["in_progress", "re-scoping"],
      "gates": ["gate:review", "gate:verify", "gate:archive"],
      "done": ["done"],
      "backlog": ["failed", "blocked", "cancelled"]
    },
    "cardFields": ["assignee", "deps", "gateState", "tokens"],
    "dragRules": "state-machine"
  },
  "pipeline": { "swimlaneBy": "stage", "stages": ["plan", "dev", "gates", "integrate"], "layout": "serpentine" },
  "dag": { "showModel": true, "collapseGroups": true, "direction": "LR" },
  "views": { "default": "board", "tabs": ["board", "swimlane", "dag", "roster"] },
  "limits": { "maxMembers": 6, "memberMaxDepth": 0, "maxTasks": 20 },
  "gates": { "enabled": true, "commandTimeoutMs": 120000 },
  "taskTypes": {
    "default": { "gateChain": ["review", "archive"] },
    "dev": { "gateChain": ["review", "verify", "archive"] }
  },
  "clarify": { "maxRounds": 3 },
  "memory": { "evidenceRequired": true },
  "audit": { "writeScopes": true }
}
```

**非法（终态未覆盖 → 该层整层回退，其余层保留）**：

```json
{ "board": { "columnMapping": { "running": ["in_progress"] } } }
```

> `columnMapping` 覆盖了 `running` 但没覆盖 `done/failed/blocked/cancelled` —— 看板会有任务落不进任何列，该层被忽略并告警 `terminal state "done" not covered ...`。

---

## 9. 验收

| 门禁 | 断言 |
|---|---|
| `t11-config` | 数组整条替换（K5）、标量覆盖、未知键告警、终态覆盖校验、硬上限钳制 |
| `t34-team-config` | 模板声明的 `board/pipeline/gates/taskTypes` 落团队层并生效；无配置段不落文件；`taskType` 展开门禁链 |
| `t35-project-config` | 项目层 `config/team.config.json` 生效；`default ‹ project ‹ team` 三层顺序 |
| **`t89-config-schema`（本 CHG 新增）** | 本文档 ↔ schema ↔ 代码常量三方同步：顶层字段全覆盖、`default` 与 `DEFAULT_CONFIG` 逐项相等、非法样例被拒、`PATCH_CEILINGS` 与 schema `maximum` 一致、文档提到每个字段名 |

手工验收（M2-3 实现后）：设置页 JSON 源视图改一行 → 保存 → 刷新看板列变化；把 `columnMapping` 改坏 → 保存被拒（`MT_VALIDATION`）且文件未改。
