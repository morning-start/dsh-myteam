# myteam-plugin-team

把「一套已经配好的团队」贡献给 myteam 的全局团队库 —— **装插件即得团队**。

## 这个 skill 是什么

一个**契约 + 模板 + 校验器**三件套，给要「带团队」的 DSH 插件作者用。

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 主入口：工作流、三条最容易踩的坑、检查清单 |
| `reference/manifest.md` | `plugin.json` 字段速查 |
| `reference/roles.md` | 角色文件字段速查 + 约束 |
| `reference/teams.md` | 团队模板字段速查 + 约束 |
| `reference/errors.md` | 错误码 → 怎么改 |
| `templates/acme-workflow/` | **可直接跑**的完整示例（3 角色 + 1 团队） |
| `tools/check-contribution.mjs` | **可执行契约校验器**（CI 可用） |

**权威文档是仓库里的 `docs/16-插件团队贡献契约.md`**，本 skill 服从它。

## 用起来

### 1. 拷模板

```bash
cp -r templates/acme-workflow ./contributions/
```

### 2. 改字段

按你的插件改 `pluginId` / `namespace` / 角色 id 前缀。**所有 id 都加前缀**（`acme-reviewer` 而不是 `reviewer`）。

### 3. 校验（不能跳）

```bash
node tools/check-contribution.mjs ./contributions --root
```

必须 `✅ 通过（0 条 warning）`。

### 4. 接进安装流程

把 `contributions/<pluginId>/` 拷到 `$DSH_HOME/myteam/plugins/<pluginId>/`（`$DSH_HOME` 缺省 `~/.dsh`）。

### 5. 重启 DSH 验证

角色库 → 全局 tab → 「插件」分区；建队向导 → 模板下拉。

## 校验器

```bash
# 单个插件目录
node tools/check-contribution.mjs ./contributions/acme-workflow

# plugins 根目录（多个插件）
node tools/check-contribution.mjs ./contributions --root

# CI：机器可读
node tools/check-contribution.mjs ./contributions --root --json
```

退出码：`0` = 无 error；`1` = 有 error（条目会被 myteam 跳过）；`2` = 用法错误。

## 契约概览（详见 `docs/16`）

```
$DSH_HOME/myteam/plugins/<pluginId>/
├── plugin.json          # 清单（必需）
├── roles/<roleId>.json  # 角色（复用 RoleDefinition）
└── teams/<templateId>.json  # 团队模板（复用 PresetDefinition + namespace/charter）
```

角色来源优先级（低 → 高）：`builtin(0) < plugin(1) < global(2) < project-role(3) < project(4)`。

**用户的全局/项目库永远压得过插件** —— 想改插件给的默认，写一份同 id 的进全局库即可。

## 四条硬边界

1. 不能贡献**队长**（`isCaptain: true` → `MT_ROLE_CAPTAIN_RESERVED`）
2. 不能覆盖**内置角色**（撞 id → `MT_ROLE_CONTRIBUTION_CONFLICT`）
3. 不能**扩权**（`toolPolicy.allow` 只收窄，未知工具名丢弃）
4. 不能**执行代码**（只 `JSON.parse`，永不 `import`）

## 安装这个 skill

本目录是一个标准 DSH skill 包。装到：

```
$DSH_HOME/skills/myteam-plugin-team/
```

（或你的 skill 目录；DSH 会在会话启动时扫描并出现在 skill 目录列表里）

## 版本

`contractVersion = 1`（对应 `dsh-plugin-myteam` ≥ 0.1.0）。契约变更走 myteam 的 CHG 流程，本 skill 跟随更新。
