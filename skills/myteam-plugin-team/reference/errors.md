# 错误码 → 怎么改

> 权威：`docs/16-插件团队贡献契约.md` §9。本文按「你可能看到它的顺序」排。

## 先看这个：error 和 warn 的区别

| 级别 | 后果 | 你该做什么 |
|---|---|---|
| **error** | 该**插件**或该**条目**被跳过（不会出现在 myteam 里） | **必修**，否则功能不存在 |
| **warn** | 加载成功，但有隐患 | 建议修；至少确认你能接受 |
| info | 纯提示 | 看情况 |

校验器退出码：`0` = 无 error；`1` = 有 error；`2` = 用法错误。

---

## 清单级（整个插件被跳过）

### `MT_PLUGIN_MANIFEST_INVALID`

`plugin.json` 读不了 / 不是合法 JSON / 缺必需字段 / `roles` 不是数组。

```
常见原因：
  · 尾逗号          { "pluginId": "acme", }           ← JSON 不允许
  · 注释            // 说明                              ← JSON 不允许
  · 单引号          { 'pluginId': 'acme' }             ← 必须双引号
  · 缺 displayName
  · version 不是 semver（"1.0" / "v1.0.0" / 1.0）
```

**修**：`node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf8'))"`

### `MT_PLUGIN_CONTRACT_UNSUPPORTED`

`contractVersion` 不是 `1`。

```
你的：{"contractVersion": 2}     myteam 支持：[1]
```

**修**：改成 `1`。如果契约确实需要 v2 的字段，说明你要的能力还没进契约——找 myteam 提 CHG，**不要自己造版本号**。

### `MT_PLUGIN_ID_INVALID`

`pluginId` 不合规。

```
规则：^[a-z][a-z0-9-]{1,63}$

❌ acme_workflow    （下划线）
❌ Acme-Workflow    （大写）
❌ acmeWorkflow     （驼峰）
❌ a                （太短，至少 2 字符）
✅ acme-workflow
```

### `MT_PLUGIN_ID_MISMATCH`

清单 `pluginId` ≠ 目录名。

```
contributions/acme-workflow/plugin.json
                └─────────────┘
{"pluginId": "acme_workflow"}    ❌ 两份对不上
```

**修**：让它们**逐字相等**。这是防复制粘贴错误的，不是形式主义。

### `MT_PLUGIN_ID_DUPLICATE`

两个目录声明了同一个 `pluginId`。

```
plugins/acme-workflow/plugin.json    {"pluginId": "acme-workflow"}
plugins/acme-workflow-old/plugin.json {"pluginId": "acme-workflow"}   ← 这条失败
```

**裁决**：按目录名**字典序**，后者失败（确定性，不随机）。

**修**：删掉旧的那份（通常是升级没清干净）。

---

## 条目级（该角色/模板被跳过）

### `MT_CONTRIBUTION_FILE_MISSING`

清单里列了但文件不存在。

```
{"roles": [{"id": "acme-reviewer", "file": "roles/reviewer.json"}]}
                                          └───────────────────────┘ 这个文件没有
```

**修**：补文件，或删清单项。检查大小写（Windows 不敏感、Linux 敏感）。

### `MT_CONTRIBUTION_ID_MISMATCH`

文件内 `id` ≠ 清单声明。

```
plugin.json      →  {"id": "acme-reviewer", "file": "roles/reviewer.json"}
reviewer.json    →  {"id": "reviewer"}                                    ❌
```

**修**：让文件里的 `id` 等于清单里的 `id`。

### `MT_CONTRIBUTION_TOO_LARGE`

单文件 > 256 KiB。

**修**：角色提示词不该这么长。如果确实长（大段规范），把它写成 **skill**，角色里只留 `skills: ["your-skill"]`。

### `MT_CONTRIBUTION_PATH_TRAVERSAL`

`file` 字段含 `..` 或绝对路径，或解析后越出插件目录。

```
❌ "../../etc/passwd"
❌ "C:/Windows/system32/x.json"
❌ "/roles/x.json"
✅ "roles/x.json"
```

**修**：用插件目录内的相对路径。这是安全边界（§11.2），**不会**为你放宽。

### `MT_ROLE_CONTRIBUTION_CONFLICT`

角色 id 撞 builtin 或其它插件。

```
❌ "implementer"        ← builtin 已有
❌ "reviewer"           ← 另一个插件已有
✅ "acme-implementer"   ← 加前缀
```

**修**：**加 namespace 前缀**，不是删角色。这是为什么 §1 让你先定前缀。

### `MT_ROLE_CAPTAIN_RESERVED`

角色写了 `"isCaptain": true`。

**修**：删掉该字段。队长只能是内置 `captain`——团队模板隐式带队长，你不需要贡献它。

### `MT_ROLE_INVALID`

角色 schema 不合法。最常见：`systemPrompt` 为空。

**修**：补 `systemPrompt`；检查 `toolPolicy.allow/deny` 是**字符串数组**（不是字符串、不是对象）。

### `MT_TEAM_TEMPLATE_CONFLICT`

模板 id 撞 builtin（`starter-team` / `triad`）或其它插件。

**修**：加前缀 → `acme-trio`。

### `MT_TEAM_TEMPLATE_CAPTAIN`

模板 `members` 里列了 `captain`。

```
❌ {"members": [{"roleId": "captain"}, ...]}     ← 队长由预设隐式提供
✅ {"members": [{"roleId": "acme-reviewer"}, ...]}
```

**修**：删掉那一项。

### `MT_TEAM_TEMPLATE_UNRESOLVED`

模板引用了**解析不到**的角色。

```
{"members": [{"roleId": "acme-reviewer"}, {"roleId": "acme-tester"}]}
                                                          └──────────┘ 你没贡献这个
```

**修**（二选一）：
1. 在**同一个插件**里贡献 `acme-tester`（加进 `roles[]`）
2. 确认它来自 builtin / 全局库 / 项目库，并且**名字逐字相等**

**注意**：全局库/项目库里的角色**用户可能没装**。如果模板强依赖一个非本插件的角色，把那个角色也一起带上更稳。

---

## 写操作级

### `MT_ROLE_READONLY`

对**插件来源**的角色做 `save` / `delete`。

插件贡献的角色**只读**（P3 单向流动）。想改？

```
面板 → 角色详情 → 「复制到项目」 → 改项目库那份 → 项目库优先级更高，自动生效
```

这是设计如此，不是限制。

---

## 非错误（但你会看到）

### `MT_CONTRIBUTION_ORIGIN_STAMPED`（warn）

角色文件里写了 `origin` 字段。myteam 会**覆盖**成 `plugin:<pluginId>`。

**修**：删掉 `origin`。它由 myteam 盖章（与 fork 内置角色写 `builtin:<id>` 同构）。

### `MT_CONTRIBUTION_CODE_IGNORED`（info）

插件目录里有 `.js` / `.mjs` / `.cjs` 文件。

**不用修**——myteam **只读 JSON，永不执行**（P2 数据不是代码）。只是提醒你别指望它跑。

### `MT_CONTRIBUTION_ROOT_ABSENT`（info）

`$DSH_HOME/myteam/plugins/` 不存在。

**不用修**——没装任何带团队的插件时这是正常的。

---

## 还是不通？

1. `node tools/check-contribution.mjs ./contributions --root --json` 拿到完整 findings
2. 对每条 `code` 查本文
3. 面板 → 角色库 → 顶部红色横幅（同一个 `code`）
4. 仍不通：把 `--json` 输出贴给 myteam 提 issue——**带上 pluginId 和 code**，不要只说「角色没出现」
