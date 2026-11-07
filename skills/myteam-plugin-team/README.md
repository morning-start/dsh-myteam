# myteam-plugin-team — 给 myteam 贡献团队模板的 skill 包

> 让一个 DSH 插件把「一套已经配好的团队」（角色 + 名册 + 门禁链 + 看板列 + 章程）作为**数据**贡献进 myteam 的全局团队库 —— 装插件即得团队。
> 读者是第三方插件作者，不写 myteam 运行时；权威文档是 [../../docs/16-插件团队贡献契约.md](../../docs/16-插件团队贡献契约.md)，本包服从它。

## 是什么

一个 **契约 + 模板 + 校验器** 三件套。你产出 JSON 数据，myteam 负责把它变成可用的团队：

| 你产出 | 落到哪 | 谁来读 |
|---|---|---|
| `plugin.json` | `$DSH_HOME/myteam/plugins/<pluginId>/plugin.json` | myteam 启动时扫描 |
| `roles/*.json` | 同上 `roles/` | 注册为 `plugin` 来源的角色 |
| `teams/*.json` | 同上 `teams/` | 注册为可召唤的团队模板 |

**不做**：不教你写 myteam 运行时（账本 / 门禁 / 看板都是 myteam 的）。你只产出**数据**，myteam 只 `JSON.parse`，永不 `import()` 你的代码。

## 5 分钟上手

### 1. 拷模板

```bash
cp -r templates/acme-workflow ./contributions/
```

`templates/acme-workflow/` 是**可直接跑**的完整示例（3 角色 + 1 团队），改字段比从零写快。

### 2. 改字段

按你的插件改 `pluginId` / `namespace` / 角色 id 前缀。**所有 id 都加前缀**（`acme-reviewer` 而不是 `reviewer`）——角色 id 撞内置角色是硬失败，撞别的插件也是硬失败，而报错发生在用户那儿、不在你这儿。

### 3. 校验（不能跳）

```bash
node tools/check-contribution.mjs ./contributions --root
```

必须 **0 error**（自带的 `acme-workflow` 模板是 0 error 0 warning；warning 允许，但要看得懂）。有 error → 查 [reference/errors.md](reference/errors.md) 对照修，再跑一遍。

### 4. 接进安装流程

把 `contributions/<pluginId>/` 拷到 `$DSH_HOME/myteam/plugins/<pluginId>/`（`$DSH_HOME` 缺省 `~/.dsh`，Windows 是 `%USERPROFILE%\.dsh`）。幂等：重复安装覆盖自己那份，不要删别人的目录。

### 5. 重启 DSH 验证

1. 重启 DSH（或在面板点「重新扫描插件」）；
2. 角色库 → 全局 tab → 应出现「插件」分区，带你的 `displayName`；
3. 建队向导 → 模板下拉 → 应看到你的团队模板；
4. 有角色没出现 → 看面板顶部红色横幅的 warning，对着 [reference/errors.md](reference/errors.md) 修。

## 文件清单

| 文件 | 作用 |
|---|---|
| [SKILL.md](SKILL.md) | 主入口：工作流、三条最容易踩的坑、交付检查清单 |
| [reference/manifest.md](reference/manifest.md) | `plugin.json` 字段速查（最小可用 / 完整 / 字段表 / 三个「为什么」） |
| [reference/roles.md](reference/roles.md) | 角色文件字段速查 + 约束 + 写好 `systemPrompt` 的三条 |
| [reference/teams.md](reference/teams.md) | 团队模板字段速查 + 三条硬约束 + `charter` 是什么 |
| [reference/errors.md](reference/errors.md) | 错误码 → 怎么改（清单级 / 条目级 / 写操作级） |
| [templates/acme-workflow/](templates/acme-workflow/) | 可直接跑的完整示例：`plugin.json` + 3 角色 + 1 团队 |
| [tools/check-contribution.mjs](tools/check-contribution.mjs) | 可执行契约校验器（`--json` 给 CI） |

## 校验器

```bash
# 单个插件目录
node tools/check-contribution.mjs ./contributions/acme-workflow

# plugins 根目录（含多个插件子目录）
node tools/check-contribution.mjs ./contributions --root

# CI：机器可读
node tools/check-contribution.mjs ./contributions --root --json
```

| 退出码 | 含义 | 后果 |
|---|---|---|
| `0` | 无 error | 可以进下一步；warning 允许但要看懂 |
| `1` | 有 error | 该条目会被 myteam 跳过（不会静默进库） |
| `2` | 用法错误 | 参数 / 路径写错了，先修命令 |

## 契约概览

详见 [../../docs/16-插件团队贡献契约.md](../../docs/16-插件团队贡献契约.md)。

```
$DSH_HOME/myteam/plugins/<pluginId>/
├── plugin.json              # 清单（必需）
├── roles/<roleId>.json      # 角色（复用 RoleDefinition）
└── teams/<templateId>.json  # 团队模板（复用 PresetDefinition + namespace / charter）
```

角色来源优先级（低 → 高）：

```
builtin(0) < plugin(1) < global(2) < project-role(3) < project(4)
```

**用户的全局 / 项目库永远压得过插件** —— 想改插件给的默认，写一份同 id 的进全局库即可；插件贡献的角色在面板里只读（想改走「复制到项目」）。插件升级不追溯已召唤的成员（用召唤时快照）。

## 四条硬边界

1. 不能贡献**队长**（`isCaptain: true` → `MT_ROLE_CAPTAIN_RESERVED`）
2. 不能覆盖**内置角色**（撞 id → `MT_ROLE_CONTRIBUTION_CONFLICT`）
3. 不能**扩权**（`toolPolicy.allow` 只收窄，未知工具名丢弃）
4. 不能**执行代码**（只 `JSON.parse`，永不 `import`）

## 安装与版本

本目录是一个标准 DSH skill 包，装到：

```
$DSH_HOME/skills/myteam-plugin-team/
```

（或你的 skill 目录；DSH 在会话启动时扫描，装完新开会话即出现在 skill 目录列表里。）

`contractVersion = 1`（对应 `dsh-plugin-myteam` ≥ 0.1.0）。契约变更走 myteam 的 CHG 流程（[../../docs/09-变更记录.md](../../docs/09-变更记录.md)），本 skill 跟随更新。

---

[← 上级目录](../README.md)
