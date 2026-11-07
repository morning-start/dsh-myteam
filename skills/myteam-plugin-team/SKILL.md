---
name: myteam-plugin-team
description: 让一个 DSH 插件把「一套已经配好的团队」（角色 + 名册 + 门禁链 + 看板列 + 团队章程）贡献给 myteam 的全局团队库，装插件即得团队。用户说「我的插件要带团队 / 装插件后 myteam 里就有这套角色 / 做一个带团队的插件 / 插件怎么接 myteam / contribution / 贡献点」时使用。核心纪律：契约先行——先产出符合 docs/16 契约的贡献文件并通过校验器，再谈插件实现。
---

# 给插件带一套团队（myteam 贡献点）

## 这个 skill 干什么

把「一个已经配好的团队」打包进你的 DSH 插件，装上以后 myteam 里**直接出现这套角色和团队模板**，用户建队时能选、召唤成员时能用。

**不做**：不教你写 myteam 运行时（那是我这边的）。你只产出**数据**。

## 🔴 第一纪律：契约先行

**顺序不能颠倒。** 用户明确要求过：

> 「这个 skill 需要先有一定的协议、一定的契约，在契约的基础上再去做这件事情，也就是先设置好契约，然后再来实现。」

所以工作流是：

```
① 读契约（docs/16）→ ② 写贡献数据 → ③ 跑校验器全绿 → ④ 才写插件代码
```

**跳过 ③ 直接写代码 = 返工。** 贡献数据过不了校验，插件装上去角色就是被静默跳过。

## 权威文档

| 文档 | 作用 |
|---|---|
| **`docs/16-插件团队贡献契约.md`** | **唯一权威**。字段、优先级、错误码、安全边界都在这里 |
| `reference/manifest.md` | `plugin.json` 字段速查 |
| `reference/roles.md` | 角色文件字段速查 + 约束 |
| `reference/teams.md` | 团队模板字段速查 + 约束 |
| `reference/errors.md` | 错误码 → 怎么改（对着报错查这里） |

**本 skill 与契约冲突时，契约赢。**

---

## 工作流

### 第 0 步：先判断「你要的是不是这个」

| 你的插件是 | 用哪个 |
|---|---|
| 带**一套角色/团队**（提示词 + 名册 + 门禁） | ✅ 本 skill（贡献点） |
| 带**能力**（技能 / MCP / 工具） | ❌ 不是本 skill。角色里写技能/MCP 名字即可，能力本身走你自己的插件 |
| 带**运行时**（自己的多智能体引擎） | ❌ 不是本 skill |

一句话判据：**你需要 myteam 的账本/门禁/看板来跑任务吗？** 需要 → 本 skill；不需要 → 你不需要 myteam。

### 第 1 步：设计命名空间

先定 `pluginId`（小写 + 连字符，`^[a-z][a-z0-9-]{1,63}$`），再定 `namespace`（缺省 = `pluginId` 第一段）。

**然后所有角色/模板 id 都加前缀**：

```
pluginId: acme-workflow
namespace: acme
角色:  acme-reviewer  acme-implementer  acme-acceptor
模板:  acme-trio
```

为什么必须加前缀（契约 §7.2）：**角色 id 撞内置角色 = 硬失败**，撞别的插件也是硬失败。你不加前缀，用户装两个插件就炸一个，而且报错在他那儿不在你这儿。

### 第 2 步：写贡献目录

在**你插件的仓库里**建这个结构（这就是你要 `files` 里带上的东西）：

```
contributions/                      # 你的源码目录（随便叫什么）
└── <pluginId>/                     # 目录名 = pluginId，逐字相等
    ├── plugin.json                 # 清单
    ├── roles/
    │   ├── acme-reviewer.json
    │   └── acme-implementer.json
    └── teams/
        └── acme-trio.json
```

拷骨架：

```bash
cp -r <skill>/templates/<pluginId> ./contributions/
```

（`templates/` 里是可跑的完整示例，改字段比从零写快。）

### 第 3 步：跑校验器（**这一步不能跳**）

```bash
node <skill>/tools/check-contribution.mjs ./contributions --root
```

- `--root` 表示传的是 `plugins` 根目录（含多个插件子目录）
- 单个插件目录就不加 `--root`
- `--json` 给 CI 用

**必须全绿（0 error）才能进下一步。** warning 可以留，但要看得懂。

看错误码 → 查 `reference/errors.md` 对照修。

### 第 4 步：接进插件安装流程

把 `contributions/<pluginId>/` 拷到：

```
$DSH_HOME/myteam/plugins/<pluginId>/
```

- `$DSH_HOME` 缺省 `~/.dsh`（Windows `%USERPROFILE%\.dsh`）
- 用你的 `postinstall` 脚本 / 插件 `apply()` 里的 `fs.cp` 都行
- **幂等**：重复安装覆盖自己那份，不要删别人的目录

### 第 5 步：验证（在 DSH 里）

1. 重启 DSH（或 myteam 面板点「重新扫描插件」）
2. 角色库 → 全局 tab → 应看到「插件」分区，带你的 `displayName`
3. 建队向导 → 模板下拉 → 应看到你的团队模板
4. 有任何角色**没出现** → 打开面板顶部红色横幅看 warning，对着 `reference/errors.md` 修

---

## 三条最容易踩的坑

### 坑 1：`plugin.json` 的 `pluginId` 和目录名不一致

```
contributions/acme-workflow/plugin.json  →  {"pluginId": "acme_workflow"}   ❌ 下划线
```

报 `MT_PLUGIN_ID_MISMATCH` 或 `MT_PLUGIN_ID_INVALID`。**改目录名或改清单，两者逐字相等。**

### 坑 2：角色文件里的 `id` 和清单里声明的 `id` 不一致

```
plugin.json    →  {"id": "acme-reviewer", "file": "roles/reviewer.json"}
reviewer.json  →  {"id": "reviewer", ...}                                    ❌
```

报 `MT_CONTRIBUTION_ID_MISMATCH`。

### 坑 3：团队模板引用了「不在本插件、也不在库里」的角色

```
teams/acme-trio.json → {"members": [{"roleId": "acme-reviewer"}, {"roleId": "acme-tester"}]}
                                                              ↑ 这个角色你没贡献
```

报 `MT_TEAM_TEMPLATE_UNRESOLVED`（消息里会列出解析不到的 id）。**要么在同一个插件里贡献它，要么确认它来自 builtin / 全局库 / 项目库。**

---

## 硬边界（契约 §11，不要试探）

| 你不能 | 报什么 |
|---|---|
| 贡献队长角色（`isCaptain: true`） | `MT_ROLE_CAPTAIN_RESERVED` |
| 覆盖内置角色（`captain` / `implementer` / ...） | `MT_ROLE_CONTRIBUTION_CONFLICT` |
| 团队模板里列 `captain` | `MT_TEAM_TEMPLATE_CAPTAIN` |
| 用 `..` 或绝对路径引文件 | `MT_CONTRIBUTION_PATH_TRAVERSAL` |
| 靠 `toolPolicy.allow` 扩权 | 未知工具名会被**丢弃**（C5 只收窄） |
| 写 myteam 的账本 | 装载只读，没有写入口 |
| 在贡献目录里放 `.js` 让它执行 | 只 `JSON.parse`，**永不执行**（会记 info） |

---

## 检查清单（交付前逐条过）

- [ ] `pluginId` 匹配 `^[a-z][a-z0-9-]{1,63}$`，且与目录名**逐字相等**
- [ ] `contractVersion: 1`
- [ ] `displayName` 非空、`version` 是 semver
- [ ] 每个角色/模板 id 都有 `namespace` 前缀
- [ ] 每个 `roles[].id` / `teams[].id` 与文件内 `id` **逐字相等**
- [ ] 角色 `systemPrompt` 非空
- [ ] 角色**没有** `origin` 字段（myteam 会盖章）、**没有** `isCaptain: true`
- [ ] 团队模板 `members` 非空、**不含** `captain`、每个 `roleId` 都解析得到
- [ ] `node tools/check-contribution.mjs ./contributions --root` → **0 error**
- [ ] 安装脚本幂等（重复跑不出错、不删别人目录）
- [ ] DSH 里重启后角色库和模板下拉都能看到

---

## 一句话总结

**你产出数据（`plugin.json` + `roles/*.json` + `teams/*.json`），myteam 负责把它变成可用的团队。先过校验器，再谈别的。**
