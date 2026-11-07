# skills — 对外 skill 包

> 给**第三方插件作者**用的 skill 包：契约使用说明 + 字段速查 + 可跑模板 + 可执行校验器。谁想让自己的 DSH 插件「带一套团队」进 myteam，从这里开始。
> 这不是 myteam 插件的运行时组成部分——删掉本目录，`plugin/` 照样构建、照样装载、照样跑测试。

## 定位

myteam 只做一件事：**把「一套配好的团队」变成可跑的多智能体协作**。谁来配？两种来源——

| 来源 | 谁产出 | 在哪 |
|---|---|---|
| 用户在面板里建 | 用户自己 | `$DSH_HOME/myteam/`、项目 `.dsh-myteam/` |
| 插件贡献 | 第三方插件作者 | `$DSH_HOME/myteam/plugins/<pluginId>/` |

本目录服务第二种。它**不含运行时**，只含「怎么写对那份数据」的知识与工具：契约怎么读、字段怎么填、校验器怎么跑、错了看哪个错误码。

**权威文档是 [../docs/16-插件团队贡献契约.md](../docs/16-插件团队贡献契约.md)**（v1，已冻结并实装）。本目录是它的使用说明，契约与本目录冲突时**契约赢**。

## 目录里有什么

目前只有**一个**包：

| 包 | 一句话职责 | 入口 |
|---|---|---|
| `myteam-plugin-team/` | 教你把「一套已经配好的团队」（角色 + 名册 + 门禁链 + 看板列 + 章程）作为**数据**贡献进 myteam 的全局团队库，装插件即得团队 | [myteam-plugin-team/README.md](myteam-plugin-team/README.md) · [SKILL.md](myteam-plugin-team/SKILL.md) |

包内结构（细节见该包 README 的文件清单表）：

```
skills/myteam-plugin-team/
├── SKILL.md                        # 主入口：工作流 + 三条最易踩的坑 + 交付检查清单
├── reference/                      # 字段级速查（manifest / roles / teams / errors 四份）
├── templates/acme-workflow/        # 可直接跑的完整示例（3 角色 + 1 团队）
└── tools/check-contribution.mjs    # 可执行契约校验器（--json 给 CI）
```

## 怎么装

本目录整体是标准 DSH skill 包，装到：

```
$DSH_HOME/skills/myteam-plugin-team/
```

- `$DSH_HOME` 缺省 `~/.dsh`（Windows 是 `%USERPROFILE%\.dsh`）。
- DSH 在会话启动时扫描 skill 目录，装完**新开一个会话**才会出现在 skill 目录列表里。
- 只想先跑校验器的话**不用装**：`node skills/myteam-plugin-team/tools/check-contribution.mjs <你的贡献目录> --root` 在任何有 Node 的机器上都能跑——校验器存在的意义就是让你在**自己的仓库里**就发现「角色会被跳过」，而不是装进 DSH 之后。

## 三条约束（给要新增 skill 包的人）

1. **一个包一个目录**，目录名 = 包名；包内必须有 `SKILL.md`，且 frontmatter 带 `name` 与 `description`（`description` 写「什么时候该用它」，路由靠它）。
2. **包只描述数据与流程，不实现运行时**。要写 myteam 运行时逻辑，那是 `plugin/` 的事（见 [../plugin/README.md](../plugin/README.md)）。
3. **契约变更走 CHG**：本目录任何字段说法都必须能在 [../docs/16-插件团队贡献契约.md](../docs/16-插件团队贡献契约.md) 里找到依据；契约要改先走 [../docs/09-变更记录.md](../docs/09-变更记录.md) 的 CHG 流程，本目录跟随更新。

## 相关文档

| 文档 | 什么时候读 |
|---|---|
| [../docs/16-插件团队贡献契约.md](../docs/16-插件团队贡献契约.md) | 唯一权威：目录布局、字段、优先级、错误码、安全边界 |
| [myteam-plugin-team/README.md](myteam-plugin-team/README.md) | 5 分钟上手 + 校验器用法 + 四条硬边界 |
| [myteam-plugin-team/reference/errors.md](myteam-plugin-team/reference/errors.md) | 校验器报错 → 怎么改 |
| [myteam-plugin-team/templates/acme-workflow/](myteam-plugin-team/templates/acme-workflow/) | 可直接拷的骨架 |
| [../plugin/README.md](../plugin/README.md) | myteam 侧的装载实现（贡献点怎么被发现、校验、注册） |

---

[← 上级目录](../README.md)
