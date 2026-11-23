# 契约文档

> 状态：`as-is`（现行实现契约，2026-11-23 按 2.0.0 核对）。本目录描述**今天跑着的接口**，
> 不是「目标设计」。逐条对账见 [architecture/07](../architecture/07-文档现状对账-2.0.0.md)。

## 1. 现行契约

| 文档 | 来源 | 管什么 |
|---|---|---|
| [panel-rpc](panel-rpc.md) | **生成**（`tools/gen-panel-contract.mjs`） | 面板 16 个只读方法、协议版本、写通道 `/__myteam/write/<method>` 与错误信封 |
| [tool-surface](tool-surface.md) | **生成**（`tools/gen-tool-contract.mjs`） | 队长 15 个 + 成员 3 个工具、身份规则、错误码表 |
| [config-schema](config-schema.md) | **生成**（`tools/gen-config-contract.mjs`） | 团队配置字段、默认值、合并与上限 |
| [capabilities](capabilities.md) | 手工（数字来自代码） | 能力矩阵：动作集合、谁能做、当前有没有实现 |
| [contribution](contribution.md) | 手工摘要 | 第三方 Role / 团队模板怎么贡献、安全边界在哪 |

生成的三份顶部都带「不要手改」标记；手改会被下一次生成覆盖，也会被 `tools/verify.mjs` 里的
`gen-* --check` 判红。

## 2. 改契约的流程

```text
改代码（panel-contract.ts / panel-writes.ts / tool-specs.ts / domain/config/merge.ts / contracts/errors.ts）
  → node tools/gen-<对应>.mjs            # 重新生成文档
  → node tools/verify.mjs                # 生成物是否已同步 + 三份契约 --check + 文档链接
  → 提交（代码 + 文档同一笔）
```

反向不成立：**不要**先改文档再让代码去追，生成物没有「手工定稿」这个状态。

## 3. v1 兼容面在哪

v1 的团队分账本、旧角色/模板 schema 只剩**一次性迁移代码**里：
`plugin/src/infrastructure/migration/v1/{analyze,convert,cutover,report}.ts`，由 t11 / t13 / t18 / t19 / t21 / t33 守着。
`docs/` 里不再保留 v1 契约文档 —— 那套 API 已经不在宿主里运行，留着只会被当成现状。

## 4. 手工部分写什么

- 写：语义、权限边界、故障行为、迁移影响、为什么这样定；
- 不写：方法数、工具数、错误码个数、字段默认值（这些从代码来；要写就同时给出生成命令）；
- 任何「已冻结 / 适用于所有版本」的说法都不要写 —— 契约是随代码走的，`--check` 才是承诺。

## 5. 提交前自查

1. 改了接口却没有 `gen-*` 产物变化 → 说明契约源没改，或改错了地方；
2. 新错误码只加在字符串里、没进 `contracts/errors.ts` → `gen-tool-contract --check` 会红；
3. 手写文档里出现的计数，追不到一条可复跑的命令 → 删掉或补命令；
4. 旧路径（`docs/04`、`plugin/src/core/errors.ts`、`gen-error-docs.mjs`）出现在正文 → 那是 v1 时代的东西，改掉。
