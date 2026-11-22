# 插件团队贡献契约（现行摘要）

> 状态：**部分定稿**。可执行权威是
> [`skills/myteam-plugin-team/tools/check-contribution.mjs`](../../skills/myteam-plugin-team/tools/check-contribution.mjs)
> （`contractVersion = 1`）。v2 的插件 manifest 尚未最终定稿，因此本页只承诺
> 「检查器会拒绝什么」，不另外发明字段。

## 贡献目录

```
plugins/
  <pluginId>/            # 含 plugin.json 的目录
    plugin.json
    roles/<roleId>.json
    templates/<teamId>.json
```

- `<pluginId>`：`^[a-z][a-z0-9-]{1,63}$`，全小写，连字符分隔；
- 角色 id：`^[a-z][a-z0-9-]{2,63}$`；文件内 id 必须与文件名一致；
- 版本：语义化版本（`\d+\.\d+\.\d+[-+…]`）；
- 单文件上限 256 KiB（超过即 `error`，避免把大模型提示塞进角色定义）。

## 硬失败（不允许静默跳过）

| 情况 | 结果 |
|---|---|
| manifest 不是合法 JSON / 缺 `pluginId`、`version`、`displayName` | error |
| `roles` / `teams` 不是数组 | error |
| 角色或模板 id 撞内置（`captain`、`developer`、`starter-team` 等） | error |
| 同一插件内 id 重复，或跨插件重复 | error |
| 角色文件路径越界（`..`、绝对路径） | error |
| 引用了不存在的团队模板 / 角色 | error |

## 校验方式

```bash
node skills/myteam-plugin-team/tools/check-contribution.mjs <贡献目录> [--json]
node skills/myteam-plugin-team/tools/check-contribution.mjs <plugins 根> --root
```

- 退出码 `0` = 通过（可含 warning）；`1` = 有 error，对应条目会被跳过；
- 建议在贡献者自己的仓库里跑，而不是装进 DSH 后才发现角色被静默跳过。

## 与旧契约的关系

旧的 [`16-插件团队贡献契约.md`](../contracts/16-插件团队贡献契约.md) 描述的是 v1 加载器行为
（`config/plugins` 下的目录约定）。现行实现以 checker 为准；**字段级 schema 待 v2
manifest 定稿后补齐**，在此之前不要按旧文档写新贡献。