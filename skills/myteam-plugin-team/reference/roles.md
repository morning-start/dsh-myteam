# 角色文件字段速查（`roles/<roleId>.json`）

> 权威：`docs/16-插件团队贡献契约.md` §5。**Schema 完全复用** myteam 的 `RoleDefinition`（`plugin/src/core/roles/builtin-roles.ts`），不新造。

## 最小可用

```json
{
  "id": "acme-reviewer",
  "name": "Acme 评审员",
  "description": "独立复核者",
  "systemPrompt": "你负责复核 Acme 风格产出。"
}
```

只需 4 个字段就能跑。`systemPrompt` 是**唯一有语义**的必需字段——角色的全部价值在这里。

## 完整

```json
{
  "id": "acme-reviewer",
  "name": "Acme 评审员",
  "description": "对 Acme 风格产出的独立复核者",
  "systemPrompt": "你负责复核 Acme 风格产出：先看验收标准是否可测，再看实现是否越界。不做具体实现，不修改被审代码。",
  "toolPolicy": {
    "allow": ["myteam_*", "Read", "Grep"],
    "deny": ["Write", "Edit", "Bash"]
  },
  "skills": ["acme-style-guide"],
  "mcpAllowlist": ["acme-figma"],
  "model": { "provider": "deepseek", "model": "deepseek-chat" },
  "interestWords": ["风格一致性", "越界检查"],
  "version": 1
}
```

## 字段表

| 字段 | 类型 | 必需 | 约束 | 错了报 |
|---|---|---|---|---|
| `id` | string | ✅ | `^[a-z][a-z0-9-]{2,63}$`；**必须等于清单里声明的 id**；**必须带 namespace 前缀**（约定，非强制） | `MT_CONTRIBUTION_ID_MISMATCH` |
| `name` | string | ✅ | 面板显示名 | — |
| `description` | string | ✅ | 一句话说明「它天然关注什么」 | — |
| `systemPrompt` | string | ✅ | **非空**。角色的人格与职责 | `MT_ROLE_INVALID` |
| `isCaptain` | boolean | ❌ | **禁止为 `true`** | `MT_ROLE_CAPTAIN_RESERVED` |
| `toolPolicy.allow` | string[] | ❌ | 只**收窄**权限（C5）；未知工具名被**丢弃**并 warning | 非数组 → `MT_ROLE_INVALID` |
| `toolPolicy.deny` | string[] | ❌ | 同上 | 同上 |
| `skills` | string[] | ❌ | 只是名字，不校验存在性 | — |
| `mcpAllowlist` | string[] | ❌ | 同上 | — |
| `model` | `{provider, model}` | ❌ | 缺省继承会话 | — |
| `interestWords` | string[] | ❌ | 软信号（派单参考），**不是权限** | — |
| `version` | number | ❌ | 缺省 `1` | — |
| `origin` | — | ❌ | **不要写**！myteam 装载时盖章为 `plugin:<pluginId>`（写了会被覆盖 + warning） | `MT_CONTRIBUTION_ORIGIN_STAMPED`（warn） |

## 三条关键约束

### 1. `id` 必须带 namespace 前缀

```
✅ acme-reviewer
❌ reviewer          → 撞另一个插件就炸
❌ implementer       → 撞内置角色，直接失败
```

myteam **不强制**前缀（强制会让 id 变丑），但**冲突时要求你改名**——而且报错在用户那儿，不在你这儿。所以**请主动加**。

### 2. `isCaptain` 只能是 `false` 或省略

队长是名册的锚点（「有且仅有一个」），**只能**来自内置 `captain`。

你需要「一个像队长的角色」？那是**团队模板的预设队长**（`myteam-captain`），你不需要贡献它。

### 3. `toolPolicy.allow` 只收窄，不能扩权

这是 C5 硬约束：角色的 `allow` 与宿主已注册工具集**取交集**。

```json
{ "toolPolicy": { "allow": ["myteam_*", "SomeToolThatDoesNotExist"] } }
```

`SomeToolThatDoesNotExist` 会被**丢掉**并记 warning。**这不是安全漏洞，是提示你写错了工具名。**

想确认工具名？看 myteam 的 `myteam_list_contributions` 输出，或宿主工具表。

## 写好 `systemPrompt` 的三条

1. **说清「不做什么」比「做什么」更重要**——模型最容易越界的地方就是职责边界。
2. **不要写协作协议**（「先 claim 再 attempt」）——那是 myteam 运行时注入的，你写了会重复。
3. **可测**——如果 `systemPrompt` 里说了「必须 X」，那 X 应该能写进任务的验收标准。

## 示例：三个角色

```jsonc
// 需求侧
{ "id": "acme-requirement", "name": "Acme 需求", "description": "把模糊目标拆成可测 AC",
  "systemPrompt": "你只做需求澄清与验收标准撰写。产出必须可测（每条 AC 能判真假）。不做实现方案。" }

// 实现侧
{ "id": "acme-implementer", "name": "Acme 实现", "description": "按 AC 产出代码",
  "systemPrompt": "你只做实现。动手前先复述 AC；交付时附改动文件清单与验证命令。不扩大范围。",
  "toolPolicy": { "allow": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"] } }

// 复核侧
{ "id": "acme-reviewer", "name": "Acme 复核", "description": "独立复核",
  "systemPrompt": "你只审不写。按 AC 逐条判定「通过/不通过/无法判定」，不通过要给出可复现步骤。",
  "toolPolicy": { "allow": ["Read", "Grep", "Glob"] } }
```
