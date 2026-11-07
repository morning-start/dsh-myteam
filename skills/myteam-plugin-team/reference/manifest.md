# `plugin.json` 字段速查

> 权威：`docs/16-插件团队贡献契约.md` §4。本文是速查，冲突时以契约为准。

## 最小可用

```json
{
  "contractVersion": 1,
  "pluginId": "acme-workflow",
  "displayName": "Acme 工作流",
  "version": "1.0.0"
}
```

只有这 4 个字段是必需的。没有角色/模板 = 一个空插件（合法但没意义）。

## 完整

```json
{
  "contractVersion": 1,
  "pluginId": "acme-workflow",
  "displayName": "Acme 工作流插件",
  "version": "1.2.3",
  "description": "需求 → 实现 → 复核 的 Acme 风格团队",
  "homepage": "https://github.com/acme/dsh-plugin-acme-workflow",
  "namespace": "acme",
  "roles": [
    { "id": "acme-reviewer", "file": "roles/reviewer.json" },
    { "id": "acme-implementer", "file": "roles/implementer.json" }
  ],
  "teams": [
    { "id": "acme-trio", "file": "teams/trio.json" }
  ]
}
```

## 字段表

| 字段 | 类型 | 必需 | 约束 | 错了报 |
|---|---|---|---|---|
| `contractVersion` | integer | ✅ | 必须是 `1` | `MT_PLUGIN_CONTRACT_UNSUPPORTED`（其它值）/ `MT_PLUGIN_MANIFEST_INVALID`（不是整数） |
| `pluginId` | string | ✅ | `^[a-z][a-z0-9-]{1,63}$` | `MT_PLUGIN_ID_INVALID` |
| `pluginId` 与目录名 | — | ✅ | **逐字相等** | `MT_PLUGIN_ID_MISMATCH` |
| `pluginId` 与其它插件 | — | ✅ | 全局唯一 | `MT_PLUGIN_ID_DUPLICATE`（目录名字典序后者失败） |
| `displayName` | string | ✅ | 非空 | `MT_PLUGIN_MANIFEST_INVALID` |
| `version` | string | ✅ | semver 形状（`^\d+\.\d+\.\d+`） | `MT_PLUGIN_MANIFEST_INVALID` |
| `description` | string | ❌ | — | — |
| `homepage` | string | ❌ | — | — |
| `namespace` | string | ❌ | 缺省 = `pluginId` 第一段 | — |
| `roles` | array | ❌ | `[{id, file}]` | `MT_PLUGIN_MANIFEST_INVALID` |
| `roles[].id` | string | ✅ | `^[a-z][a-z0-9-]{2,63}$` | `MT_PLUGIN_MANIFEST_INVALID` |
| `roles[].file` | string | ✅ | 相对路径、禁止 `..`、禁止绝对路径 | `MT_CONTRIBUTION_PATH_TRAVERSAL` |
| `roles[].file` 存在性 | — | ✅ | 必须存在 | `MT_CONTRIBUTION_FILE_MISSING` |
| `roles[].file` ≤ 256 KiB | — | ✅ | — | `MT_CONTRIBUTION_TOO_LARGE` |
| `teams` | array | ❌ | `[{id, file}]` | 同 `roles` |

## 三个「为什么」

### 为什么 `pluginId` 要和目录名相等？

目录名是 myteam **唯一**的插件标识（`discoverContributions` 扫目录）。清单里再写一份是为了**防止复制粘贴错误**——两份对不上，说明你拷错了。

### 为什么 `version` 只校验形状不比较？

myteam **不做版本协商**（契约 §10）。理由：range 求值器是额外的依赖面和失败模式，而插件资产本来就是「装上就用最新」。需要 myteam 版本要求时用 `requires`（v1 只记录不阻断）：

```json
{ "requires": { "myteam": ">=0.1.0" } }
```

### 为什么 `roles` / `teams` 是**显式清单**而不是目录扫描？

- 目录扫描无法表达「这个文件我暂时不想启用」
- 无法做拼写错误检测（文件在但清单没列 = 忽略，且记 info）
- 显式清单让「这个插件贡献了什么」一眼可见

**没列在清单里的文件不会被加载**（包括编辑器备份 `reviewer.json~`）。
