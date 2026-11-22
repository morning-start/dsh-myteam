# 配置字段契约

> 由 `tools/gen-config-contract.mjs` 从 `plugin/src/domain/config/merge.ts` 生成。不要手改。

## 分层与优先级

```
内置默认 (DEFAULT_TEAM_CONFIG)
  → 项目默认 (projectDefaults)
  → 蓝图默认 (blueprintDefaults，可无)
  → 团队覆盖 (teamOverrides)
  = 生效配置 (EffectiveConfigSnapshot)
```

规则：

- 覆盖是**深合并**：只写要改的叶子键；
- **未知键与类型错误都拒绝**（拼写错与面板传错类型不能被静默吞掉）；
- 生效配置带 `configRevision`；团队覆盖更新时只 rebase 冲突字段，不整份重置；
- 迁移来的团队没有可信覆盖，`legacy.unknownConfigRevision` 标记这一点。

## 字段与默认值

| 键 | 类型 | 默认值 |
|---|---|---|
| `limits` | 分组 | — |
| `limits.maxMembers` | `number` | `8` |
| `limits.maxMemberDepth` | `number` | `3` |
| `limits.maxChildrenPerMember` | `number` | `4` |
| `limits.maxParallelAttempts` | `number` | `4` |
| `limits.maxEscalationsPerTask` | `number` | `2` |
| `gates` | 分组 | — |
| `gates.requireEvidence` | `boolean` | `true` |
| `gates.requireArtifacts` | `boolean` | `true` |
| `gates.commandTimeoutMs` | `number` | `120000` |
| `messaging` | 分组 | — |
| `messaging.allowMemberToMember` | `boolean` | `true` |
| `messaging.maxMessagesPerTask` | `number` | `40` |

## 校验边界

- 数值字段必须是有限正数（`commandTimeoutMs` 允许单位为毫秒的整数）；
- 布尔字段只接受 `true`/`false`；
- 成员权限收窄由 `domain/permissions/narrowing.ts` 负责，不在配置里表达。
