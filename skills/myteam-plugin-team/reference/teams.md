# 团队模板字段速查（`teams/<templateId>.json`）

> 权威：`docs/16-插件团队贡献契约.md` §6。Schema 复用 myteam 的 `PresetDefinition`（`plugin/src/core/presets/preset-store.ts`），新增 `namespace` / `charter` 两个可选字段。
>
> **注意**：CHG-52 定过「全局只保留角色，不存团队模板」。本契约**修订**了它——插件模板是**插件资产**（跨项目可见），不是用户资产（用户自建模板仍只在项目层）。理由见契约 §6.4。

## 最小可用

```json
{
  "id": "acme-trio",
  "name": "Acme 三人组",
  "members": [
    { "roleId": "acme-requirement" },
    { "roleId": "acme-implementer" },
    { "roleId": "acme-reviewer" }
  ]
}
```

## 完整

```json
{
  "id": "acme-trio",
  "name": "Acme 三人组（需求 → 实现 → 复核）",
  "description": "Acme 风格的标准交付团队；门禁链强制 实现后复核",
  "members": [
    { "roleId": "acme-requirement", "instanceName": "需求" },
    { "roleId": "acme-implementer", "instanceName": "实现" },
    {
      "roleId": "acme-reviewer",
      "instanceName": "复核",
      "skills": ["acme-style-guide"],
      "mcpAllowlist": ["acme-figma"]
    }
  ],
  "board": { "columns": ["待办", "进行中", "门禁", "完成"] },
  "pipeline": { "swimlaneBy": "role", "stages": ["todo", "running", "gate", "done"] },
  "gates": { "enabled": true, "commandTimeoutMs": 120000 },
  "taskTypes": {
    "impl": { "gateChain": ["review", "verify"] },
    "doc": { "gateChain": ["review"] }
  },
  "version": 1,
  "namespace": "acme",
  "charter": "## Acme 团队章程\n\n- 产出先过 `acme-lint`\n- 复核不通过必须给可复现步骤\n- 不做范围外的重构"
}
```

## 字段表

| 字段 | 类型 | 必需 | 约束 | 错了报 |
|---|---|---|---|---|
| `id` | string | ✅ | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`、含 `..` 拒；**必须等于清单声明**；带 namespace 前缀 | `MT_CONTRIBUTION_ID_MISMATCH` |
| `name` | string | ✅ | 非空 | `MT_PLUGIN_MANIFEST_INVALID` |
| `description` | string | ❌ | — | — |
| `members` | array | ✅ | **非空**；**不含 `captain`**；每项 `roleId` 必须解析得到 | `MT_TEAM_TEMPLATE_CAPTAIN` / `MT_TEAM_TEMPLATE_UNRESOLVED` |
| `members[].roleId` | string | ✅ | 必须在「装载后合并角色库」里 | `MT_TEAM_TEMPLATE_UNRESOLVED` |
| `members[].instanceName` | string | ❌ | 缺省 = `roleId` | — |
| `members[].skills` | string[] | ❌ | 覆盖角色声明的 skills | — |
| `members[].mcpAllowlist` | string[] | ❌ | 覆盖角色声明的 mcpAllowlist | — |
| `board.columns` | string[] | ❌ | 看板列 | — |
| `board.columnMapping` | object | ❌ | 状态 → 列 | — |
| `pipeline.swimlaneBy` | string | ❌ | 泳道维度（`role` / `priority`） | — |
| `gates.enabled` | boolean | ❌ | — | — |
| `gates.commandTimeoutMs` | number | ❌ | 命令门禁超时 | — |
| `taskTypes` | object | ❌ | 任务类型 → 门禁链 | — |
| `version` | number | ❌ | 缺省 `1`；**不参与比较** | — |
| **`namespace`** | string | ❌ | **本契约新增**。面板分组 | — |
| **`charter`** | string | ❌ | **本契约新增**。团队章程 markdown（将来注入队长 system prompt 的那段） | — |

## 三条硬约束

### 1. `members` 不能含 `captain`

```
❌ { "members": [{ "roleId": "captain" }, ...] }     → MT_TEAM_TEMPLATE_CAPTAIN
✅ { "members": [{ "roleId": "acme-reviewer" }, ...] }  // 队长由预设隐式提供
```

myteam 的团队**恒有且仅有一个队长**（`myteam-captain` 预设），名册里只有**队员**。

### 2. 每个 `roleId` 必须解析得到

「解析得到」= 在下面这个合并集合里：

```
builtin 角色（captain / implementer / req-validator / developer / acceptor / ...）
  ∪ 本插件贡献的角色
  ∪ 其它已装插件贡献的角色
  ∪ 全局角色库（$DSH_HOME/myteam/roles/）
  ∪ 项目自身角色（config/project-role.json）
  ∪ 项目角色库（config/roles/）
```

**最容易的错**：你贡献了 `acme-reviewer` 角色，但模板里写成 `reviewer`。

### 3. `id` 撞内置模板 `starter-team` / `triad` = 硬失败

改 `acme-trio` 就好。

## `charter` 是什么

团队章程 = 这个团队的**结构约定**（谁沟通、谁存档、文件放哪、做到什么程度）。

- 它会被存进团队的结构文件（`structure.md`），> **v1 只登记，尚未自动注入队长 system prompt**（`docs/16` §14 未决 / `docs/08` §8 未验项）。
- 想现在就生效：把章程内容**写进每个角色的 `systemPrompt`**（重复但立刻有效）。

## 一个模板 vs 多个模板

| 场景 | 建议 |
|---|---|
| 插件只有一种「正确用法」 | 1 个模板（`acme-trio`） |
| 插件覆盖多种任务类型（实现 / 文档 / 数据） | 2~3 个模板（`acme-impl` / `acme-doc`） |
| > 3 个 | 太多了。用户选不过来 → 合成 1 个 + 用 `taskTypes` 区分 |

**模板是「开箱即用的起点」，不是「全部可能」。** 用户建队后可以自由加人。
