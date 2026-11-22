> 文档治理：`research`。本文件是调研输入，不直接构成 myteam 的需求或架构权威；现行设计见 [../architecture/README.md](../architecture/README.md)。
> 来源、日期与外部能力描述按原文保留，使用前需按当前环境复核。

# dsh-task-ledger 源码研读笔记

> 仓库：<https://github.com/cq-guojia/dsh-task-ledger>（MIT，TypeScript + Go；Go 92 文件 1.37 万行、TS 48 文件 1.34 万行、Markdown 42 篇 2.5 千行）
> 研读快照：`main` @ `140ffbca`（2026-11-11）
> 本文的组织方式是「**先建立心智模型 → 再拆每层机制 → 最后落到可借鉴/可疑清单**」，不是逐文件导读。每条结论后给 `路径:行号`，可直接跳过去看。

---

## 0. 一句话结论

这是一个**把「任务台账」塞进 git 工作区的 DSH 插件**：没有数据库、没有托管后端、没有任何二进制格式。它用

> **单文件原子写 + 固定写序 + 重跑幂等 + 两级文件锁**

四件事，硬生生撑起了一个「多人 / 多机 / 会崩在中间」的协作系统；再往上用 `git` 当传输层与审计日志，用 `Go 静态二进制` 当唯一写入口，用 `TypeScript 插件` 当只读展示面。

它的价值不在「用 Go 写了个 CRUD」，而在于**把分布式系统的老问题用最便宜的手段解掉了**，并且把代价（写序变成公开契约）明确写进了文档。

---

## 1. 它到底是什么

### 1.1 定位

一本放在工作区里的**纯文本任务台账**。任务由 Agent 创建、认领、推进、结案，每一步都落到 `ledger/` 目录里的 JSON 与 Markdown：

```text
<工作区>/                                  # 直接含 ledger/ 的目录才是「工作区根」
└── ledger/
    ├── pool.json                          # 公共池：未认领任务
    ├── owners.json                        # 索引：身份 uuid → 分片文件
    ├── owners/<sha256前12位>.json          # 每人一份分片：自己名下的任务
    ├── worklog/<YYYYMM>/<时分>-<说明>-<随机码>.md   # 过程文档（六节，一任务一篇）
    └── history/<YYYYMM>.md                 # 已结案索引（十六列 Markdown 表）
```

### 1.2 为什么要它

只要一件工作**跨了多次会话 / 跨了若干天 / 由多人接力**，三个问题就再也答不上来：谁在做、做到哪一步、原本要达成什么。对话记录留不住；Jira 这类工具虽然答得上，却把答案放在工作区之外。

这个项目的答案很直接：**答案记在工作区里，以可读、可 diff、可评审的纯文本保存**。

### 1.3 单仓双包

| 包 | 语言 | 内容 | 发布 tag |
|---|---|---|---|
| `packages/plugin`（`dsh-task-ledger`） | TypeScript | DSH 插件：host 半（路由 + 聚合 + skill 注册）+ client 半（看板 UI）；`dist/` 入仓 | `plugin-v*` |
| `packages/skill`（`task-ledger`） | Go | `SKILL.md` + `scripts/progress` shim + 三平台静态二进制 + `src/` 实现 | `skill-v*` |

关键约束：**skill 内容唯一真源在 `packages/skill/`**，插件构建时只把运行时那几项拷进 `packages/plugin/skill/`，Go 源码不进副本（`docs/architecture/overview.md:14`）。

发版规则（`AGENTS.md`）：改了 skill 必须**同时**升 `skill-vX.Y.Z` 与 `plugin-vX.Y.Z`；只改插件侧则只升插件。

---

## 2. 全局架构

### 2.1 一张图

```text
┌──────────────────────────── 浏览器（client 半） ────────────────────────────┐
│  侧栏条目 + main 整页面板：在办 / 历史 / 设置 三段滑轨                      │
│  store.ts（单仓 + useSyncExternalStore）→ rows.ts（纯函数筛选）→ ui.ts（薄包裹）│
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTP（Desktop 走 IPC bridge）
                                   │ 统一前缀 /api/task-ledger
┌──────────────────────────────────▼───────────────────────────────────────┐
│  host 半（Node）                                                          │
│   routes.ts ──► services/*（纯计算）──► repositories/*（唯一知道怎么读台账） │
│                                              │                            │
│                                    repositories/runner.ts                 │
│                                    （全仓唯一 spawn 点）                    │
└──────────────────────────────────────────────┼────────────────────────────┘
                                               │ 子进程
┌──────────────────────────────────────────────▼────────────────────────────┐
│  Go 静态二进制（scripts/bin/ledger-<os>-<arch>）                            │
│                                                                           │
│   main.go → shell.Main → shell.Run → runCommand                           │
│                              │                                            │
│                     actions/*（业务：定写序、定幂等判据）                     │
│                              │                                            │
│                     store/*（数据：一种文件一个对象，读改写原子写回）            │
│                              │                                            │
│                     core/*（纯换算：时间、路径、任务号、Markdown 增删行）      │
└──────────────────────────────────────────────┬────────────────────────────┘
                                               │ 只经 git
                                       各工作区 ledger/ 文件
```

### 2.2 分层纪律是可机械检查的

`docs/api/ledger-api.md:33-43` 把「准入规则」写成了 `grep` 命令，每条必须为 0：

| 规则 | 检查 |
|---|---|
| 业务层不许反向依赖外壳 | `grep -rn "internal/shell" internal/actions/` |
| 数据层不许依赖业务层 / 外壳 | `grep -rn "internal/actions\|internal/shell" internal/store/` |
| 工具层只许碰 `notices` | `grep -rn "internal/" internal/core/` |
| 只有外壳能跑 git | `grep -rn "exec.Command" internal/` |
| 只有外壳能打印 | `grep -rn "fmt.Print\|os.Stdout" internal/core internal/store internal/actions` |
| 只有 `actions/scope.go` 的 `Atom` 能加锁 | `grep -rn "store.LedgerLock\|store.ProgressLock" internal/` |
| 动作之间不许互相调用（唯一例外 `set_task.go` 路由） | `grep -rn "actions\.\(Release\|Handoff\|Claim\|Relabel\)(" internal/actions/` |

**这一条最值得抄**：架构约束若不落成 CI 里能跑的 grep，三个月后必然失效。

### 2.3 外壳为什么是「进程边界」不是「第三层业务」

`docs/api/ledger-api.md:31` 给了三条理由，每一条都是踩出来的：

1. 推送被拒会自动 rebase，**冲突合并直接改磁盘文件**；业务层若握着「改前数据」，下一次整份写回会抹掉别人刚合进来的任务。
2. 业务函数要能被界面单独调；按一下「释放」不该顺带跑参数解析、退出码与 git 提交。
3. 外壳只管「这次改了哪些文件」和「返回什么结果」；越界一次，顺序与回滚就散回每个命令里。

---

## 3. 数据模型

### 3.1 任务表：`pool.json` 与 `owners/*.json` 是同一张表

两者都是 `TaskStore`（`packages/skill/src/internal/store/taskstore.go:16-35`），只是路径不同：

- `pool.json` = `owner` 为空的**分区**
- 分片 = 某人名下的**分区**

所以「认领 / 释放 / 交接」都是**跨分区搬移**，不是「新建一条 + 删除一条」两笔独立记录（`docs/data/ledger-files.md:24`）。

任务对象字段（`internal/actions/new_task.go:100-117`）：

| 字段 | 样例 | 说明 |
|---|---|---|
| `title` | `熟悉项目初衷并搭建初始文档架构` | 标题 |
| `status` | `open` / `doing` | `done` 只能由 close 产生 |
| `creator` / `owner` | uuid | 池里的行 `owner` 为 `null` |
| `created` / `started` / `updated` / `finished` | `YYYY-MM-DD HH:MM:SS` | **存盘一律 UTC、无偏移**；输出转本机时区 |
| `category` | `建设` | 单值，**建任务时定死，之后谁都改不了** |
| `tags` | `["文档架构","初始化"]` | 1~5 个，`new` 必填 |
| `worklog` | `worklog/202610/16-1742-…-5563.md` | 相对 `ledger/` 的过程文档路径 |

**写盘格式是契约**：`DumpLedgerJSON(data, expand)` 把 `expand`（即 `tasks`）里的**一条任务压成一行**，其余字段各占一行（`store/jsonstore.go:105-141`）。这不是审美问题——一条任务一行是 git 行级 diff 与多人合并的前提，注释里明写「不许改成缩进美化格式」。

### 3.2 索引：`owners.json`

```json
{ "workers": { "<归一化身份>": { "file": "<sha256前12位>.json", "name": "…", "joined": "…" } } }
```

两条不变量：

1. 分片文件名 = `sha256(归一化身份)[:12] + ".json"`，由 `core.ShardRel` 算（`core/paths.go:44-47`）——**归一化必须先做**，否则同一个人大小写不同会算出两个分片。
2. **但路径的真源是索引里的 `file` 字段，不是重算**。`ShardRelOf` 的注释把这个坑写得很清楚（`internal/actions/scope.go:73-95`）：

```go
// internal/actions/scope.go:79-95
func ShardRelOf(repo, who string) string {
	key := core.Normalize(who)
	fallback := core.ShardRel(key)
	all, err := store.NewOwnersIndex(repo).All()
	if err != nil { return fallback }
	record, ok := all[key]
	if !ok { return fallback }
	name, _ := record["file"].(string)
	if name == "" { return fallback }
	return core.OwnersDir + "/" + name
}
```

结论：`core.ShardRel` 只用于**建**新分片；凡是「用」分片的地方（读写、加锁、提交集、交接目标、查重）必须走 `ShardRelOf`。否则手动改过名的分片会「索引删了人、文件还躺着」——`os.Remove` 的 ENOENT 被当成「本来就没有」放过。

冗余的 `owner_name` / `creator_name` 是**显示名快照**：改名不回写旧记录，旧任务仍显示当时那个名字（`docs/data/ledger-files.md:48`）。

### 3.3 已结案：`history/<YYYYMM>.md`

**十六列定宽**（`core/history_md.go:14-31`）：

```text
Finished | Created | Title | Category | Tags | Owner | Owner Name | Creator | Creator Name
         | Summary | Result | Worklog | Deleted | Deleted By | Deleted By Name | Deleted At
```

行级规则：

| 规则 | 依据 |
|---|---|
| 列数 ≠ 16 的行**静默跳过**，不告警 | `core/history_md.go:174-176` |
| 首列必须是合法时间，否则跳过 | `:177-180` |
| `owner` / `creator` 写**裸 uuid**，名字列写 `@名字`，读回来两侧都剥 `@` | `:198-201` |
| `Result` 只有 `done` / `cancelled` / 空 | `docs/data/ledger-files.md:61` |
| `Deleted == "yes"` 是唯一删除判据，空 = 未删 | `core/history_md.go:31` |
| 每行带 `Stamp` = 整行 sha256 前 12 hex，删除时作 `--expect` 校验 | `:61-70` |

最后一条值得单独说：**行号会漂移，指纹不会**。这是 HTTP `ETag`/`If-Match` 的同一套思路，用来在「原地打删除标记」这种不可逆操作前证明「我要动的确实是读到的那一条」。

### 3.4 过程文档：`worklog/<YYYYMM>/*.md`

固定六节：**Background / To Do / Next / Process / Conclusion / Execution Log**（模板真源 `packages/skill/assets/worklog.md`）。

头部四行，顺序由 `HeadKeyOrder = ["meta","status","created","frozen"]` 的 rank 决定（`core/worklog_md.go:21`、`:295-340`）：

```markdown
- **Tags**: 建设, DSH, 台账
- **Status**: doing · 2026-10-27 09:12:33 · @某人 · 8d557c6d-7c93-43ac-8c73-5d623e82e1c6
- **Created**: 2026-10-26 23:38:02 · @某人 · 8d557c6d-…
- **Sealed**: 2026-10-27 09:20:10 · @某人 · 8d557c6d-…
```

**头部行的位置是可计算的，不靠字符串替换**，所以「补一行」天然幂等——同一条命令跑两遍不会插出两行。

脚本只有「建篇」+ 四处**锚点编辑**能力：`AppendExecLog`（追加执行记录）、`StampFrozen`（封卷）、`RewriteLabelLine`（标签行）、`RewriteStatusLine`（状态行）。**没有「整篇替换既有正文」这种能力**——这是刻意的能力裁剪。

---

## 4. 写链路（一）：七步外壳

### 4.1 入口

```go
// packages/skill/src/main.go:10-12
func main() { os.Exit(shell.Main(os.Args[1:])) }
```

一行转发，全部逻辑（含退出码）都在 shell 层。

### 4.2 `shell.Main`：解析 → 旁路 → 定位 → 分级加锁

`packages/skill/src/internal/shell/cli.go:680-739` 的顺序不可换：

1. `IgnoreSIGPIPE()`（见 §6.4）
2. `ParseArgs(argv)`
3. **五条命令在定位仓库之前旁路返回**：`whoami` / `init` / `switch` / `root` / `dirs`（`cli.go:702-720`）
4. `ResolveRepo(a.Repo, repoModeOf(a.Command))`
5. **只读命令直接 `Run`，连锁都不拿**（`cli.go:728-730`）
6. 写命令：`store.SyncLock(lockDir(repo), 60*time.Second)` → `Run` → `unlock()`

第 3 步的理由：「这个目录有没有台账」**恰恰不能要求先有台账**。

`ResolveRepo` 把 `--repo` 校验分成三档（`cli.go:600-622`）：

| 档位 | 命令 | 语义 |
|---|---|---|
| `modeStrict` | `list` / `stats` / `show` / `history` | 必须是台账根，**绝不静默读空台账** |
| `modePlain` | `owners` / `validate` / `logout` | 沿用原口径，既不建台账也不拒父目录 |
| `modeCreate` | 其余写命令 | 允许首次创建，但拒绝「下面已有子台账的父目录」和 home 及其上层 |

没给 `--repo` 时从 cwd 往上找 `ledger/`，找不到直接报业务错——**绝不在当前目录自作主张建台账**。

### 4.3 七步：`runCommand`

`packages/skill/src/internal/shell/runner.go:88-201`，顺序不可换：

```text
① 绑记账本    log := &store.WriteLog{}; unbind := store.Bound(log)     :36-38
② 取最新      g.CheckRepoState() → g.GuardBeforeWrite(scope)          :109
              → g.SyncDown(scope) → log.RecordPresync(...)            :146-159
③ 自举        for rel := range scope.Files { store.Snapshot ... }     :167-174
              withAtom(bootScope) { actions.Bootstrap(repo, me) }     :176-183
④ 调业务函数  withAtom(actScope) { spec.Run(repo, me, params) }        :185-192
⑤ 打印        renderOf(spec, value, args, args.JSON)                  :194
⑥ 提交        finalize → g.Commit(log.CommitSet(), msg)               :244
⑦ 推送        g.Push(8, pushDeadline())                               :248
```

两个关键设计：

- **取最新必须早于自举**。`PresyncScope` 先从 `owners.json` 算锁集；旧索引会盖掉远端刚登记的人，顺序反了就会「自举拿旧名册把别人写回去」。
- **自举与动作各用一个独立 `Atom`**（`runner.go:204-211`），不是一个大事务——因为自举是幂等的，且失败补偿必须能在同一把锁内做完（文件锁**不可重入**）。

### 4.4 三个跳过条件是「分组」而不是「逐条判」

| 跳过条件 | 判定位置 | 跳过什么 | 不跳过什么 |
|---|---|---|---|
| **只读命令** | `runner.go:120`，来源 `registry.go:36` 的 `ActionSpec.ReadOnly` | `GitRepo`、`PresyncScope`、`GuardBeforeWrite`、`SyncDown`、`Bootstrap`、`finalize` | 仍走 `CurrentIdentity`、`paramsOf`、`renderOf`、`RepoBanner` |
| **`--no-sync`** | `runner.go:102` + `:215-224` | 只跳刷盘与提交推送 | **锁集照算**（`PresyncScope` 无条件调，`presync.go:11` 注明「它本来就不碰 git」）；写命令仍拿 `SyncLock` |
| **`already_done`** | `runner.go:21-22` 注释 + `:197` 无条件调 `finalize` | 什么都不跳 | 写没写**只看记账本**（`log.HasWrites()`）；退出码仍是 0 |

`--no-sync` 还有一条「静默腐烂」的补丁：它在有写入时打一条提示，明确告知「留不提交会被下一条写命令的 guard 拦住」（`runner.go:216-221`）。

---

## 5. 写链路（二）：动作层——写序即崩溃恢复协议

这是整套系统里**最值得学**的一节。`docs/data/ledger-files.md:85-99` 有一张表，我把它理解为「每个动作的写序不是实现细节，是数据契约」：

| 动作 | 写序 | 崩在中间 | 重跑怎么收敛 |
|---|---|---|---|
| 自举 `Bootstrap` | 目录与池 → 我的分片 → 索引 | 留孤儿分片 | 已登记零写；未登记由下次写命令补登记 |
| 建任务 `NewTask` | 过程文档 → 台账 | 留孤儿文档 | **不自愈**：文档在、台账没落 ⇒ 拒绝并说明「可能崩在中间」，换号重建 |
| 认领 `Claim` | 我的分片 → 删池那行 → 执行记录 | 两边都有 | 分片已有 ⇒ 只补删池 |
| 释放 `Release` | 写回池 → 删我分片 → 执行记录 | 两边都有 | 池里已有同号且是干净空位 ⇒ 不写回、只补删我 |
| 交接 `Handoff` | 对方分片 → 删我分片 → 执行记录 | 两边都有 | 内容一致 ⇒ 只补删我；不同 ⇒ 拒绝 |
| 记进展 `LogProgress` | 分片 `updated` → worklog 追加 | 文档没写 | **不算失败**：警告一句 + 退出码 0 |
| 结案 `CloseTask` | 改标签行 → 历史行 → 封卷 → **最后删分片** | 历史多一行 / 已封卷 | 历史按 worklog 名去重、封卷认标记行、「已结案无需重复」退 0；判不出来 ⇒ Fail |
| 删除在办 `DeleteTask` | 转接 `CloseTask{Delete:true}` | 同结案 | 同结案 |
| 删历史行 `DeleteHistoryRow` | 「已删过」判重 → 行指纹核对 → 只改末四格 | — | 重复删按幂等回「已经删除过了」 |

三条通用规则：

1. **多文件先写目标、后删源，删永远是最后一步。** 崩在中间最坏只是「两边都有」，重跑靠判重收敛。
2. **建任务反过来：先文档后台账，且刻意不自愈。** 因为复用历史号比留孤儿更危险（`new_task.go:83-85`）。
3. **没有「改状态」这个动作。** 状态只随命令语义变（认领→`doing`、释放→`open`、结案→进历史）；`list --status` 是只读筛选。

已知且**接受**的例外（不是遗漏）：跨月重跑 `close` 会在两个月各记一行；重跑同一动作会再追加一条执行记录。

### 5.1 为什么不引 journal

`store.Snapshot` / `store.Restore`（`store/atomic.go:98-119`）的定位很明确：**进程内失败回滚**，不是崩溃恢复。

- 调用点只有三处多文件动作：`close_task.go:129-143`、`new_task.go:88`、`delete_task.go:105`；
- 回滚由外壳统一触发：`runner.go:56-60` 判断 `!log.CommitStarted`；
- `Restore` 用 `track=false` 写回，所以「撤销」这个动作本身不会被提交。

**不引 journal 的理由**：journal 解决的是「进程写一半被杀，下次启动要能重放」。而这个系统把崩溃恢复责任交给了**写序 + 幂等重跑**——每一对「先写目标、后删源」都保证中间态可读（两边都有 ⇒ 去重），重跑一次就收敛。journal 会引入第二个真源（日志文件本身），而它自己也需要原子性与 GC，收益为负。

### 5.2 命令名册：`ActionSpec`

`packages/skill/src/internal/actions/registry.go:33-41`：

```go
type ActionSpec struct {
	Render           string   // 渲染函数名（只存名字不存函数，避免 actions 反向 import shell）
	ReadOnly         bool
	OptionalIdentity bool     // 没初始化身份也能跑（目前只有 owners）
	LockAction       string   // 交给 LockScope 的动作名
	Params           []string // ← 死字段，见 §12.1
	Run              func(repo string, me core.Identity, p Params) (any, error)
}
```

外壳**不许自己 switch 命令名**，一律查名册（`SpecOf`）。`Render` 只存名字是这个设计的巧处——`actions` 不必 import `shell`，依赖方向不会反。

---

## 6. 并发与一致性四件套

### 6.1 单文件原子写：`WriteTextAtomic`

`packages/skill/src/internal/store/atomic.go:24-72` 是**全仓唯一写盘出口**：

```go
func WriteTextAtomic(path, text string, track bool) error {
	parent := filepath.Dir(path)
	info, statErr := os.Lstat(parent)
	if statErr != nil || !info.IsDir() {
		return core.Failf("写 %s 失败：父目录 %s 不存在（建目录要显式调 EnsureDir）。", path, parent)
	}
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return core.Failf("拒绝写入 %s：它是符号链接，写入会把它替换成普通文件", path)
	}
	mode := os.FileMode(0o644)
	existed := false
	if fi, err := os.Stat(path); err == nil { mode = fi.Mode().Perm(); existed = true }
	tmp, err := os.CreateTemp(parent, filepath.Base(path)+".*.tmp")
	// …WriteString → tmp.Sync() → tmp.Close() → os.Chmod(tmpName, mode)
	if err := os.Rename(tmpName, path); err != nil { /* … */ }
	fsyncDir(parent)
	Current().Record(path, track, !existed)
	return nil
}
```

八步：**父目录存在性 → 拒符号链接 → 捕获原权限 → 同目录临时文件 → write → fsync(file) → chmod → rename → fsync(dir) → 记账本**。

三个容易被忽略的细节：

1. **临时文件必须同目录**，否则 `rename` 跨文件系统会失败——这是 POSIX 原子替换的硬前提。
2. **`fsync(file)` 在 `rename` 之前，`fsync(dir)` 在之后**。顺序反了，掉电时可能出现「文件名指向一个空 inode」。
3. **`Record` 是最后一步**，`created = !existed`。写盘失败的文件**不会**进提交集合——记账本只记「真的落盘了的东西」。

失败路径矩阵：

| 失败点 | 已产生的副作用 | 清理方式 |
|---|---|---|
| 父目录不存在 / 是符号链接 / `CreateTemp` 失败 | 无 | 直接返回 |
| `WriteString` / `Sync` 失败 | 临时文件 | `cleanup()` = Close + Remove |
| `Close` / `Chmod` / `Rename` 失败 | 临时文件 | 只 Remove（不再 Close） |
| `fsyncDir` 失败 | 文件已改名 | **静默忽略** |

目标文件在任何失败路径下都保持原样——这是「整份替换」语义的全部价值，也是错误文案里那句「文件是整份替换，不会写坏」的兑现。

### 6.2 两级锁

| 锁 | 位置 | 参数 | 用途 |
|---|---|---|---|
| `SyncLock(dir, timeout)` | `<git 公共目录>/dsh-task-ledger.sync.lock` | 100ms 轮询、60s 超时 | **整条命令**互斥（写前同步 → 命令写入 → 提交推送） |
| `ProgressLock(path)` | `os.TempDir()/koc-progress-<sha256前16>.lock` | 阻塞**无超时**、不重入 | **单文件**读改写 |
| `LedgerLock(repo, rels...)` | 多把 `ProgressLock` | 去重 → 排序 → 依次加 → 逆序放 | 多文件事务 |

关键点：

- `ProgressLock` **锁的不是目标文件**，而是「绝对路径（含 `EvalSymlinks` 还原）的 sha256 前 16 hex」放在系统临时目录。理由：不污染仓库、不被 `git status` 看见。
- `SyncLock` 的 `dir` 由 `lockDir(repo)` 算（`cli.go:647-677`）：`.git` 是目录就用它；是文件（worktree）就按 `gitdir:` 指针反推公共目录；都不成（非 git 仓库）就哈希仓库路径落到 `os.TempDir()`。
- **多文件加锁的全序**（去重 → 排序 → 依次加 → 逆序放）是最小死锁避免：全序下不可能出现 A 等 B、B 等 A。

**为什么数据层禁止加锁**（`docs/api/ledger-api.md:120`）：认领写序是「分片→池」、释放是「池→分片」，两向相反，各自加锁会 ABBA 死锁。只有业务层的 `Atom` 能加，且任何失败补偿**只能在同一 `Atom` 内做完**（`ProgressLock` 阻塞无超时、不重入，同进程同路径第二次加会自死锁）。

平台差异：

| 维度 | linux / darwin | windows | 其它 |
|---|---|---|---|
| 原语 | `syscall.Flock` | `LockFileEx` + `UnlockFileEx` | 无锁 |
| `ProgressLock` 等待 | 阻塞无超时 | 轮询 50ms，24h 兜底 | 立即返回空解锁 |
| 锁粒度 | 整文件 | 1 个字节 | — |
| 未适配平台 | — | — | **静默放行**（只为能编译） |

### 6.3 记账本：提交集合的唯一真源

`packages/skill/src/internal/store/dirty.go:14-21`：

```go
type WriteLog struct {
	Changed       []string        // track=true 的写
	Created       []string        // 本次新建
	Presync       []PresyncRecord // 取最新刷过的 + 刷之前字节
	mu            sync.Mutex
	CommitStarted bool            // 分水岭
}
```

`CommitSet()` = `Changed ∪ Presync` 去重保序（`dirty.go:48-64`），**完全不看 `Result.Changed`**。

`Presync` 必须进提交集合的理由（`runner.go:161-174` 注释）：自举与 `SyncDown` 把远端内容刷进了工作树，这些「不是我写的」改动也必须在本次提交里，否则台账停在「已写未提交」，下一条写命令会被写前 guard 拦死。

`RecordPresync` 是**按路径覆盖**而不是追加（`dirty.go:39-46`），保证同一文件只留**最早**那份 `Before`——回滚要回到「命令开始时」而不是「上一次覆盖前」。

### 6.4 收尾矩阵：`CommitStarted` 是分水岭

```go
// packages/skill/src/internal/shell/runner.go:43-62
code, err := runCommand(command, args, log)
if err == nil { return code }
title, status := "错误", ExitBusiness
var fail *core.Fail
if !errors.As(err, &fail) { title, status = "未预期错误", ExitUnexpected }
if fail != nil && fail.Code == core.FailIdentityMissing { status = ExitIdentityMissing }
if !log.CommitStarted {
	log.RollbackPresync()   // 按备份逆序恢复
	log.DiscardCreated()    // 删本次新建
}
FailMessage(title, err.Error())
return status
```

| 阶段 | `CommitStarted` | 收尾动作 |
|---|---|---|
| 中间态检查 / 算锁集 / 取最新 / 快照 / 自举 / 动作 / 渲染 失败 | `false` | `RollbackPresync()` + `DiscardCreated()`，退 1 或 3 |
| `--no-sync` | `false` | 不提交不推送，有写入则打提示，`log.Clear()` |
| 没有任何写入 | `false` | `log.Clear()` 直接返回成功 |
| 不是 git 仓库 | `false` | 提示「台账只写了本地文件」，`log.Clear()` |
| **提交阶段失败** | **`true`（先置位）** | **不回滚**，只 `FailMessage` |
| **推送阶段失败** | **`true`** | **不回滚**，`Push` 内部只 `notices.Note`、绝不抛 |
| 成功 | `true` | `log.Clear()` |
| Ctrl-C（提交前） | `false` | 回滚 + `FlushNotices()` + `os.Exit(130)` |
| Ctrl-C（提交后） | `true` | 原样退出 |
| 下游 broken pipe | — | **不回滚** |

### 6.5 唯一一个「不回滚」的失败分支：broken pipe

```go
// packages/skill/src/internal/shell/sigpipe_unix.go:11-17
// IgnoreSIGPIPE 让「下游提前关管道」变成写失败而不是进程直接被信号杀掉。
//
// 输出被 `head` 之类截断时，文件已经写完，提交推送必须照常走完
// （否则台账留在「已写未提交」，下一条写命令被写前 guard 拦死）。
func IgnoreSIGPIPE() { signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE) }
```

这条分支之所以**必须**不回滚，因为它发生在七步的**第 6 步（打印）之后**——业务函数已经把台账写进磁盘，只是 stdout 读端（`head` / 分页器 / 宿主进程）提前退出。若按「失败就回滚」处理，会得到两个更坏的后果：

1. 回滚把**已成功写入、即将提交**的台账吃掉；
2. 更致命的是**不提交**，台账停在「已写未提交」，写前 guard 会拦住下一条写命令——**一条只读输出被截断，就能让整个仓库写不进去**。

所以设计上把它降级为「写失败」：`writeRaw` 显式丢弃错误，进程继续走 `finalize` 完成提交推送。Windows 没有 SIGPIPE 语义（管道断裂表现为写错误），`sigpipe_windows.go` 是空实现。

---

## 7. git 同步与冲突合并

### 7.1 写前 guard 已经「降级」了（文档还没跟上）

`GuardBeforeWrite`（`gitops.go:185-219`）当前的**实际**行为：

| # | 异常 | 现在的处置 | 依据 |
|---|---|---|---|
| 1 | 本地台账有未提交改动 | **不再硬拦**，交给 `SyncDown` 逐文件跳过取最新 | `gitops.go:216-218`、`:278-281` |
| 2 | 有未推送的台账提交 | **自动 `Push(3, 20s)` 一次**，推不干净才 `Fail` 交人工 | `:206-215` |
| 3 | 有未入库的同名新文件 | **不覆盖**，`!trackedSet[rel]` 直接跳过 | `:278` |
| 4 | 处于 rebase / merge 中间态 | **硬拦**，给 `git rebase --abort` 的处理办法 | `:173-183`、`:196-198` |

第 4 类必须是**全局前提**：冲突标记下的台账不是合法 JSON，`PresyncScope` / `paramsOf` 一读就会抛出去被兜成「未预期错误」（退出码 3），而用户需要的是「仓库处于中间态」这句人话。

### 7.2 `SyncDown`：先整体快进，再逐文件刷

`gitops.go:221-322` 四段：

1. **无上游 ⇒ 整体静默跳过**；远端连不上 ⇒ 打提示后按本地写。
2. **整体快进**：`ahead == 0 && behind > 0` 时 `git merge --ff-only -q <upstream>`——只刷工作树的话，「远端新增的内容」会被本次提交原样重放，推送必被拒、rebase 必冲突。
3. **逐文件刷**：一次 `git status` / `diff` / `ls-files` 摸清本地状态；每个路径先判上游有没有（`cat-file -e`），再判本地有没有我的东西——`aheadSet[rel] || !trackedSet[rel] || (!isWorklogPath(rel) && dirtySet[rel])` 任一成立就跳过。
4. **手写过程文档走 stash → checkout → pop 叠回**；pop 冲突时**不回滚**，`core.Failf` 把冲突标记留在工作树里并明确「顺序不能反：先 drop 再解决，手写的那段就没了」。

**索引还原**是容易被忽略的一环：`checkout` 会把上游版本写进索引，而失败回滚只按字节还原工作树，索引里那份脏会让下一条写命令被 guard 拦死——所以取完立刻 `git reset --quiet -- <rel>`。

### 7.3 `Commit`：三拨分流 + `--relative`

- 只提交台账那几个文件（**不带 pathspec** 会把用户自己暂存的别的东西卷进来）。
- 按「索引里有没有」分三拨：`stage`（还在磁盘上 → `git add`）、`removed`（索引有磁盘没了 → `git rm --cached`）、`skip`（都没有 → 跳过）。
- **`--relative` 不能少**——`diff` 默认按「相对仓库根」输出，台账放在别人仓库子目录下时会输出 `Explore/ledger/...`，再当 pathspec 用就变成 `Explore/Explore/...`，`commit` 直接报 `did not match any file(s)`（`gitops.go:382-386`，回归测试 `gitops_test.go:36-71`）。
- `--no-verify` 绕开用户的 commit 钩子。

### 7.4 `Push`：有上限的 rebase + push 循环

| 检查 | 结论 |
|---|---|
| `push.Code == 0` | 成功返回 |
| `Upstream() == ""` | 提示「没有上游分支，本地提交已保留」 |
| `hasForeignCommits()` | 上游之上混了**非台账**提交 ⇒ 不自动 rebase（会改写提交号），提示手动 `git pull --rebase` |
| `rebaseRetry()` | `fetch --quiet` → `rebase --autostash @{upstream}`；成功则循环再 push |
| 次数 / 时限耗尽 | 提示「已提交在本地、未推送」 |

**`Push` 的任何失败都只 `notices.Note`、绝不抛**——理由与 broken pipe 同源：提交已经落下去了，抛业务错误会让 runner 走失败收尾，把已提交的内容从工作树里抹掉，那才是真丢数据。

`--autostash` 是必需的：不把工作树里用户未提交的改动临时收走，只要仓库里有一处未提交改动，自动合并就永久失效。

### 7.5 冲突接管：按**任务号**三方合并

```go
// packages/skill/src/internal/shell/merge.go:19-21
// rebase 的 stage 语义与字面直觉相反（实测确认）：:1 共同祖先、:2 上游（别人的）、
// :3 本机正在重放的那个提交。本文档的 ours 一律指 :2、theirs 指 :3，与 git
// 自己在 rebase 里的叫法一致 —— 标反了会让人照着冲突标记把别人的版本留下来。
```

这条注释本身就是血的教训。`ResolveConflicts` 取 `:1` / `:2` / `:3` 三路内容，先判「这份文件归不归脚本管」（`Owns`），混进业务文件就整体 `abortRebase`；然后分两路：

- **追加式正文**（`worklog/` / `history/`）：`UnionMerge`（`merge.go:202-225`）——本机那份 + 上游相对共同祖先新增的行，任一侧为空也照常合，一行不丢。
- **JSON 台账**（`pool.json` / 分片 / `owners.json`）：`MergeTaskDicts`（`merge.go:84-150`）按**任务号**三方合并——只有一边动过的直接采纳，两边都动过的列进 `conflicts`。

```go
// merge.go:86-88 的核心洞察
// 合并单位是「任务」不是文本行 —— 行级合并只认相邻上下文：不同任务各自新增 /
// 结案挤在文件末尾就会撞，而同一任务两边都改时它也判不出该留谁。
```

同一任务被两边改过时，`markedText`（`:252-302`）渲染出「一条一行 + `<<<<<<< 远端 / ======= / >>>>>>> 本地`」的标记，**不替用户选任何一个**。

`conflicts()` 必须用 `-z`（`gitops.go:591-607`）：不加的话中文任务名的过程文档路径会带引号与八进制转义，`git show :1:<path>` 取不到内容、`owns()` 也判否，冲突接管会整个放弃。

---

## 8. 读链路：host 三层

### 8.1 三层职责

| 层 | 文件 | 职责 | 明确禁止 |
|---|---|---|---|
| 路由层 | `host/routes.ts` | 参数解析、`try/catch`、状态码、响应体、NDJSON 流 | 读文件、算统计 |
| 服务层 | `host/services/*` | 纯计算：跨工作区求和、周窗口、身份映射、历史合并 | 起子进程、碰台账文件 |
| 仓储层 | `host/repositories/*` | **唯一**知道台账怎么读：定位二进制、spawn、解析 JSON、进程内缓存 | 拼 HTTP 响应 |

依赖严格单向：`routes → services → repositories → runner.ts`，而 `repositories/runner.ts` 是**全仓唯一 spawn 点**。

### 8.2 为什么这样分层（两条「死法」）

- **死法一：路由层开始算统计。** 看板 8 张卡的数字来自 `stats --json`（`my_doing` / `open` / `stale` 等），插件只做 `reduce` 求和。如果路由层自己判「停滞 = `updated` 超 N 天」，阈值就出现第二份真源，与 skill 的 `thresholds` 一旦漂移，界面与命令行就会给出两个答案。所以代码里连阈值都从 skill 回显，**缺失时抛错而不许硬编码**（`stats.repository.ts:67-72`）。
- **死法二：服务层起子进程。** `settleWorkspaces` 用 `Promise.allSettled` 扇出，要求每个 `read` 是可替换的纯异步函数。若服务层自己 spawn，「部分失败 200 + degraded、全部失败 500」这条规则就没法在**一层**里统一表达。

代价是**类型重复**：`host/types.ts` 与 `client/types.ts` 各写一份形状，靠「不 import 官方包」的注释纪律维持。这是有意用「重复」换「宿主 rc 接口变更不炸」。

### 8.3 子进程读台账

入口二选一（`runner.ts:8-16`）：

```ts
function defaultScriptPath(): string {
	if (process.platform === "win32")
		return fileURLToPath(new URL("../../../skill/scripts/bin/ledger-windows-amd64.exe", import.meta.url));
	return fileURLToPath(new URL("../../../skill/scripts/progress", import.meta.url));
}
```

**Windows 不能起那个无扩展名的 sh 包装**——`CreateProcessW` 不执行 sh 脚本，还会按扩展名补 `.exe` 去找 `progress.exe`，结果 `spawn ENOENT`。

`exec()` 的四个失败出口（`runner.ts:100-167`，手写 Promise + `settled` 布尔量保证只结算一次）：

| 失败形态 | 归一成 |
|---|---|
| 起不了程序 | `起不了台账程序（…）` |
| 超时 | `skill 脚本超时（>Nms）：sub args` |
| 非零退出 | `withoutSteps(stderr) \|\| 退出码 N` |
| 输出不是 JSON | `skill 脚本输出不是 JSON：<前 200 字>` |

超时分两档：默认 `10_000`（实测单仓 5 万行 1.2s）；写命令另给——`WRITE_TIMEOUT_MS = 120_000`、`RENAME_TIMEOUT_MS = 180_000`、趋势 `20_000`。理由是写命令要「取最新 → 改 → 提交 → 推送」，10s 会**在脚本改到一半时 kill 掉**。

**身份缺失是独立错误类**（`runner.ts:40-53`）：判据是退出码 `100`（与 Go 侧 `shell.ExitIdentityMissing` 一致）。否则「没身份」会淹进「台账坏了」，界面分不出该切身份页还是该显示错误。

### 8.4 缓存的三条语义（`repositories/cache.ts`）

```ts
export function cached<T>(key: string, load: () => Promise<T>, now: number = Date.now()): Promise<T> {
	const hit = settled.get(key);
	if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value as T);
	const pending = inflight.get(key);
	if (pending !== undefined) return pending as Promise<T>;
	const issued = epoch;
	const task = Promise.resolve().then(load).then((value) => {
		if (issued === epoch) settled.set(key, { at: Date.now(), value });
		return value;
	}).finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
	inflight.set(key, task);
	return task;
}
```

1. **TTL 1.5s**：够挡同一屏的重复读，短到不会让人看到旧数据。时间戳记的是**拿到结果那一刻**，不是发起时刻——趋势要跑 3s，按发起记会「刚回来就过期」。
2. **单飞**：同 key 并发只跑一次脚本。
3. **代次失效（epoch）**：`invalidate()` 递增 `epoch`，在飞的 Promise 落地时代次变了就不写回。这防的是「清缓存 → 旧读回来又填上」，手动刷新与写后刷新都会踩。

### 8.5 降级语义

多工作区 fan-out 逐个读，失败项进 `degraded` 数组（`workspaceId` / `title` / `op` / `code` / `message`），成功项照常合并：**部分失败仍 200、坏工作区标红；全部失败才抛首个错误**转 500。

> 「全部降级成一片绿色空板」= 界面撒谎，所以必须区分。

错误码只增不改，`LEDGER_` 前缀避开宿主错误码空间：`LEDGER_SCRIPT_UNAVAILABLE` / `LEDGER_SCRIPT_TIMEOUT` / `LEDGER_SCRIPT_FAILED` / `LEDGER_SCRIPT_BAD_JSON` / `LEDGER_DATA_INVALID` / `LEDGER_IDENTITY_MISSING`。

### 8.6 当前路由表

统一前缀 `/api/task-ledger`（`routes.ts:69`）：

| Method | Path | 用途 |
|---|---|---|
| GET | `/identity` | 本机身份 + 可复制的 init 命令 |
| GET | `/identity/roster` | 各工作区可认领名册（没身份也能读） |
| POST | `/identity/switch` | 新建 / 认领 / 改昵称 |
| POST | `/identity/forget` | 从名册摘人（**NDJSON 流**逐本推进度） |
| GET | `/workspaces` | 台账目录清单（已过滤隐藏项） |
| GET/POST | `/dirs` | 台账目录读 / 写（add·hide·unhide·rename·remove） |
| GET/POST | `/rules-injection` | 会话规则注入文案的读 / 存 / 恢复默认 |
| POST | `/task/action` | 任务动作 claim·release·cancel·close·delete（**NDJSON 流**） |
| GET | `/workspace/kind` | 台账目录是不是宿主登记过的工作区 |
| POST | `/task/continue` | 在该台账所属工作区起会话并注入提示词 |
| GET | `/board/snapshot` | 首屏一次拿全：8 卡 + 在办 + 趋势两档 + 名册 |
| GET | `/history/trend` | 历史页顶部趋势 |
| GET | `/history/list` | 历史明细，只取选中的那个月 |
| GET | `/fs` | 核心 explorer 的只读文件路由 |

两处**读写同路径**是宿主限制的反向塑形：宿主 `webServer.register` 对重复 path 直接 throw，所以 `/dirs`、`/rules-injection` 只能按 `req.method` 分流。

---

## 9. Agent 契约：`SKILL.md` 才是产品

这个项目最容易忽略的一点：**它的「产品」不是看板，是 `packages/skill/SKILL.md`（436 行）**。看板只是同一个数据面的另一种视图。

### 9.1 生命周期十一条

`SKILL.md:339-353` 把「用户说什么 → 跑哪条命令」钉成了 11 条，其中最核心的是**授权分级**：

| 命令 | 档位 | 要求 |
|---|---|---|
| `new` / `claim` / `set` | 动手类 | 执行前复述完整参数并取得确认 |
| `log` | 免确认 | 本任务的推进 / 卡点 / 交付记录直接跑 |
| `close`（正常结案） | 独立授权 | 仅认明确说「结束掉 / close 掉」；**agent 自判「干完了」不算** |
| `close --cancel`（取消） | 独立授权 | **只有**用户明确说「取消 / 作废」才跑 |
| `delete` | 独立授权 + **二次确认** | 只认原话明确说「删除」；「删掉 / 清掉 / 清理 / 移除」都不算 |
| 八个只读命令 | 只读 | 直接跑 |

三条容易被忽略的语义区分：

- **「暂停」不是「释放」也不是「取消」**：「不做了 / 先放一放 / 以后再做」→ 状态不动，最多记一条 `log`。
- **「取消」不是「删除」**：取消仍是「这单被正式作废」的业务事实，照常计入结案统计；删除是数据纠错，从所有列表、统计、趋势中整行消失。
- **必须二次确认**：即使用户说了「删除」，也要先复述要删哪条、问「确定要删除这个东西吗？」，拿到明确答复才跑。一次确认只对一条一次有效。

### 9.2 身份闸门：只用退出码判，不预检

**不用事先确认身份。** 直接跑该跑的命令；没初始化时脚本用**退出码 100** 当场告诉你。不要为了「确认有没有初始化」先跑一次 `whoami`——那是白花一轮工具调用。

**唯一例外是 `owners`**：读名册不需要身份，未初始化也照常输出（`ActionSpec.OptionalIdentity`）。

### 9.3 退出码

| 退出码 | 含义 | 触发 |
|---|---|---|
| `0` | 成功 | — |
| `1` | 业务错 | 任务不存在、不是你的、参数不合法；`validate` 有 problems |
| `2` | 用法错 | 命令 / 参数不认识、必填缺失 |
| `3` | 未预期异常 | 非 `Fail` 的 error |
| `100` | 没身份 | **刻意远离 1/2/3 与 128+n 信号区**，插件 host 据此给 `LEDGER_IDENTITY_MISSING` |
| `130` | 中断 | Ctrl-C（提交开始前会回滚） |

### 9.4 跨包契约：`--json` 必须始终输出 JSON

| 规则 | 边界 |
|---|---|
| 带 `--json` 时空结果也要出 JSON | `history --json` → `{"count":0,"filters":{…},"records":[],"warnings":[],"capped":false}`；`list --json` → `{}` |
| 人话只走 stdout 的非 JSON 模式或 stderr | 提示类信息本来就在 stderr |
| 真失败照旧非零退出 + stderr 原文 | **空是合法数据，错才是错；空 ≠ 错** |

理由很实在：**空台账工作区不能让看板打不开**。

---

## 10. 界面层：client 半

### 10.1 装配：六块彼此独立、各自「服务就位才触发」

`client/index.ts` 只做注册。**不用顶层 `inject`** 的原因写在头注里：任一依赖缺席会让 entry 一直 pending、卡死整个 dsh 启动。

| 块 | 注入 | 做的事 |
|---|---|---|
| ① | `locale` | 注册 `{zh,en}` 字典 + 绑模块级 `t` 席位 |
| ② | `layout` | 拿 `selectPanel` 当「打开 / 返回」 |
| ③ | `uiWorkspace` | 会话跳转 / 归档出口 |
| ④ | `sessions` / `uiConversation` | 「由 Agent 结案」与只读会话视图 |
| ⑤ | `slots` | 侧栏条目 + `main` keyed 槽整页 |
| ⑥ | `slots,locale,configForms` | 插件详情页配置区 + 订阅设置变更重挂侧栏 |

`applySidebarEntry()` 设计成**幂等重挂**：先摘旧 factory 与旧条目，再按当前值注册——因为两个 slot 的 owner 到达顺序、设置与 slots 谁先到都没有保证。

### 10.2 状态：单仓 + `useSyncExternalStore`

**没有 Redux 也没有 Context**，只有一个模块级 `state` 对象、一个 `Set` 监听器和 `emit/set`。消费方式是 `useSyncExternalStore(boardSubscribe, boardSnapshot)`。

两条纪律：

- `getSnapshot` 必须返回**稳定引用**（每次新建对象会被判定「一直在变」⇒ 无限重渲染），所以 `refresh` 里只有真变了才 `set`。
- 并发用 `runToken` 解决：迟到的响应按 token 丢弃。

**身份是登录闸**：`refresh` 先问身份再拉快照，没身份连请求都不发——因为 skill 侧所有读命令都过身份闸门，快照必然 500。`markIdentityMissing()` 把 identity 清空，面板的**条件渲染自然变成身份页**，不需要额外的跳转代码。这是很漂亮的一手：**用渲染的条件表达式代替路由跳转**。

### 10.3 纯函数视图层 `rows.ts`

`selectView(current)` 是列表的唯一实现：先做「档位无关」的三层收窄（工作区 / 执行人 / 搜索），再逐档计数，最后 `filter(tabHit).sort(...)`。排序键三档：**工作区注册序 → 组内优先级 → 创建时间倒序**。注释点出了坑：`sort` 必须先把「工作区」比完再比优先级，否则同区行不连续、切不出组。

`resolveActions(task)` 是**按钮权限的唯一判定**，`task-row.ts:13` 明写「本文件只按返回值画」。

### 10.4 样式：`--dtl-*` token 层

| 规矩 | 为什么 |
|---|---|
| `--dtl-*` 只在 `tokens.ts` 定义，别处只 `var(--dtl-*)` 消费 | 宿主升级换变量别名时改一处即可 |
| 每个 token 都带兜底值（`var(--dsw-xxx,#1f2328)`） | 宿主没定义时最坏退到兜底色，不会白屏 / 透明字 |
| 明暗差异只写文件末尾的 `body[data-ds-dark-theme]` 段 | 判据是**纯 CSS 选择器**，宿主切主题立即生效，不需要 `MutationObserver` |
| **禁用 `prefers-color-scheme`** | 它跟操作系统、不跟宿主里的选择；两者不一致会把暗色的浅字套在浅色面板上 ⇒ 白字白底隐形 |

**控件全部走核心库，不许自绘皮肤**（`docs/development/ui-style.md:29-47`）：按钮 / 输入框 / 下拉 / 分段 / 标签 / 一行一条 / 提示气泡 / 图标 / 容器外框全用 `dsh-plugin-core/ui`，本地只允许**薄包裹**（转 props、拼 className 做布局），不得重写高度 / 内距 / 边框 / 圆角 / 配色。核心没有的（表格、行内排版、图表画法）才允许自绘，且颜色圆角字号只吃 `var(--dtl-*)`。

### 10.5 图表：不用 canvas、不用图表库

- **柱区**：`buckets` 由 `endKey` 往前数 `perScreen` 个槽位，空槽补 0 值对象——因为「每格都渲染」，点空柱也有锚点，不必找「最近有数据」。柱高 `Math.max((total / peak) * 100, 2)%`，2% 保底让 0 值也有可点区域。
- **折线**：一条 `<polyline>`，`viewBox="0 0 100 100"` + `preserveAspectRatio="none"`，x 用「列中心 / plot 实宽」的真实占比——周 / 月模式柱子只占左边一小条，曲线必须跟着柱走。
- 两个真机级细节：① `plotEl` 必须是 **callback ref**——plot 是条件渲染的，对象 ref 的 effect 只跑一次会扑空，曲线用的实宽永远 0；② 列 key 里带批次 `gran:shift:key`，否则翻页时新旧窗口大半列 key 相同、React 复用 DOM ⇒ 那几根柱子不重放动画。

### 10.6 历史列表虚拟滚动：定高 + 偏移表 + 二分

- **三类行三种固定行高**（`day` / `ws` / `rec`），首帧用**真行** `getBoundingClientRect()` 量一次，不在 JS 里写死像素——「样式一改自动跟着走」。
- **偏移表是 `Float64Array` 前缀和**，`rowAt` 是手写二分，滚动时 O(log n) 换算窗口。
- `recompute` 用**表格**的 `getBoundingClientRect()` 而不是外层容器：容器里还有筛选条，行号偏移必须从表格顶边算。上下各加 `OVERSCAN_PX = 600`。
- 滚动用 `requestAnimationFrame` 节流 + `ResizeObserver` 兜面板改宽。
- 取数按月：`monthCache` 按 `ym|workspace|owner` 缓存 60 秒，`loadedYm` 独立存放「这批 records 属于哪个月」，滚动请求必须等 `loadedYm === props.ym` 才处理——否则点别的月的柱子时，这一帧拿到的仍是上个月的行，会把 token 记成「已处理」、新数据到了也不再滚。
- 删除后的滚动锚点按**身份回填**而不是「scrollTop 减行高」：浏览器自带 scroll anchoring 也会自己调 scrollTop，减法会和它叠成两次。

---

## 11. 值得学习的设计（15 条）

1. **全仓唯一写盘出口 + 唯一建目录点**。审一个「能不能写坏台账」的问题，只需要看两个函数。
2. **临时文件 → fsync(file) → chmod → rename → fsync(dir)** 的完整顺序，且 `fsyncDir` 吞错以兼容 Windows。
3. **拒绝写符号链接**。一个 `ln -s ~/.ssh/id_rsa pool.json` 就能让「整份替换」变成「写穿到别处」，这一行把这条路堵死了。
4. **写盘格式即契约**：「一条任务一行」让多人改不同任务时 git 不冲突，注释里明写「不许改成缩进美化格式」。
5. **锁按绝对路径 hash 放系统临时目录**，锁的不是目标文件本身——既不污染仓库，又避开对目标文件加锁的语义纠缠。
6. **多文件加锁的全序**：去重 → 排序 → 依次加 → 逆序放，经典且正确的最小死锁避免。
7. **提交集合与「这次做了什么」解耦**：`CommitSet = Changed ∪ Presync`，把「远端刷下来的改动也必须提交」从业务代码里彻底拿走了。
8. **两套失败收尾 + 一条不可逆边界**：`RollbackPresync` + `DiscardCreated`，`CommitStarted` 之后一律不回滚。边界划在「数据已落盘」那一刻，语义干净。
9. **三态判重 `Hit / Miss / Undecidable`**，判不出来就说判不出来并要人看一眼，**拒绝用「猜」来保证幂等**。
10. **索引的 `file` 字段是真源，哈希只用于「建」**。命名与身份解耦，支持手动改名。
11. **缓存永远不是正确性依赖**：坏 JSON 当没有、写失败静默降级、`algo` 版本号自动失效。
12. **分层纪律写成可 grep 的 CI 规则**，而不是文档里的一句「请注意分层」。
13. **缓存用「代次」而不是只清 Map**：解决「清完缓存旧读回来又填上」，比时间戳比较更稳。
14. **降级 vs 全局失败二分**：部分失败 200 + `degraded`、全失败抛首个错误，并明确「全部降级 = 界面撒谎」。
15. **身份缺失独立错误类**：避免「没身份」淹进「台账坏了」，界面按 `code` 分流而非匹配中文。

---

## 12. 可疑 / 有坑之处（12 条，按严重度）

### 12.1 确认的死代码

**`ActionSpec.Params`**（`registry.go:39`）声明「从参数里挑哪些键传给动作」，每个命令都填了，但 `runner.paramsOf`（`runner.go:330-393`）**根本不读它**——它把整个 `Args` 手工映射成 `actions.Params`。改这份清单不会有任何效果。

同类的还有 `LockActions` 里的 `"tags"`（`scope.go:22`）：改标签走的是 `set`、`LockAction` 也是 `"set"`，没有任何路径把 `"tags"` 传进 `LockScope`。

**`core/history_md.go:213` 的 `warnings` 返回值恒为 `nil`**：签名承诺了一个告警通道，实现里一次都没 `append` 过；测试 `store/historystore_test.go:36-38` 还专门断言 `len(warnings) == 0`，等于把死接口钉成了契约。

### 12.2 文档与代码已经分叉（**最容易害人**）

- `docs/architecture/overview.md:52` 仍写「写前 guard 会硬拦：本地台账有未提交改动 / 有未推送的台账提交 / 有未入库的同名文件 / 处于 rebase 中间态 ⇒ 中止」，但代码里**前两类已经降级**（见 §7.1）。只有 rebase 中间态还是硬拦。
- 顶层 `usageText`（`cli.go:32`）列了 17 个命令，却**缺 `forget` 和 `logout`**（两者在 `commandFlags` 里都有，`cli.go:106-107`）；`TestHelpDocExists` 只钉「每个命令有 `--help` 文案」，钉不住这段常量。

### 12.3 两套列宽口径并存（真错位）

- `render.go:71-78` 的 `padRight` 按 **rune 数**补空格，中文算一个字：

```go
// render.go:71-78
// padRight 按**字符数**右填充，中文算一个字。
func padRight(text string, width int) string {
	n := len([]rune(text))
	if n >= width { return text }
	return text + strings.Repeat(" ", width-n)
}
```

- `term_canvas.go:216-239` 的 `displayWidth` 按**显示宽度**算，CJK 算两列。

结论：`padRight("张三", 12)` 补 10 个空格，实际显示 `2×2+10 = 14` 列，而期望是 12 列。凡是入参可能含中文的地方（`list` 的 `padRight(owner, 12)`、`owners` 的 `padRight("@"+name, 16)`、`dirs` 的 `padRight(dir.Name, 20)`、`history` 的 `padRight(owner, 12)`）都会错位——**中文项目的常态**。修法很直接：`padRight` 内部改用 `displayWidth` 算差。

### 12.4 Windows 上 `os.Rename` 无重试

`atomic.go:65-68` 在目标文件被别的进程以不共享方式打开时会失败（`ERROR_ACCESS_DENIED` / sharing violation），而 POSIX 的 `rename(2)` 永远成功。台账宿主进程同时在读 `pool.json` 时，写命令可能随机失败。**代码没有重试**。

### 12.5 `fsyncDir` 静默吞错掩盖了 POSIX 上的真实故障

`atomic.go:74-83`。Windows 目录 `Sync` 必失败，所以吞掉是必须的；但 POSIX 上的 `EIO` / `ENOSPC` 也一起吞了，掉电一致性其实无法保证——而注释只说了「关失败不影响」，没区分平台。至少应该 `runtime.GOOS != "windows"` 时才记录。

### 12.6 两把锁的等待语义不对称

unix `ProgressLock` 是**无限阻塞**，Windows 版给 24h 兜底，轮询间隔还是 100ms vs 50ms。一个进程持有文件锁后挂死，Linux 上会永久阻塞，Windows 上 24 小时后才报错。不是错误，但语义应该统一。

### 12.7 未适配平台静默不加锁

`locks_unsupported.go:13,16`。`go build` 能过，运行起来两个进程同时写就互相覆盖。注释说「个人单机场景的既有取舍」，但这是把正确性依赖在了「构建目标」上——CI 若在 freebsd 上跑并发测试会得到假绿。

### 12.8 `SyncDown` 的 stash pop 顺序与 push 相反

`gitops.go:286-289` 按遍历顺序 `stash push`，`:307-313` 也按 `stashOrder` 顺序 `stash pop`——但 `git stash` 是 **LIFO**，多个 worklog 同时 dirty 时，第一次 pop 拿到的是**最后一个** push 的内容，而 `entry` 是当前 `rel` 的备份，于是 `changedBytes(entry.Path, entry.Before)` 用错备份，最坏是 `Presync` 记错、回滚时还原成另一个文件的内容。触发条件窄（一次命令同时刷多个手写过程文档），但一旦触发就是静默数据错位。正确写法是**逆序**遍历 `stashOrder`。

### 12.9 `ReadOnly` 的语义是「不碰台账 / 不碰 git」，不是「不写任何文件」

`logout` 标了 `ReadOnly: true`（`registry.go:143`），走只读分支——不取最新、不提交、不拿整命令锁，但它会 `os.Remove(identity.json)`（`logout.go:21`），没有任何回滚与提示。将来若有人按「ReadOnly = 绝对无副作用」加缓存或重试逻辑，会踩到这里。

### 12.10 `routes.ts` 的 `BAD_REQUEST = "参数："` 前缀魔法

靠消息串前缀区分 400 / 500。任何一处 service 抛出的错误如果恰好以「参数：」开头，就会被静默降级成 400；反过来，路由层里新增的校验只要忘了加前缀，用户看到的就是 500。这是全仓最脆的一处协议约定。

### 12.11 手写 DOM 的维护成本已经显形

单个 `board-home.ts` 1015 行、`settings-page.ts` 1569 行、`ui.ts` 909 行，且大量 `style={{…}}` 内联对象。样式真源被拆成三份：`tokens.ts` 的 CSS、`ui.ts` 的 `UI_BASE_CSS`、以及 JSX 里的内联样式——「离散刻度」那条纪律全靠 code review 守，**没有 lint 规则兜底**。

### 12.12 `term_windows.go` 的交互降级没有测试覆盖

该文件自承「只做过交叉编译，没在真实 Windows 控制台上跑过」，而 `promptLineEdit` 在 Windows 上直接 `return "", lineEOF, nil, false`——意味着 Windows 上 `ESC 回上一步`、逐键退格全部失效，`init` 交互退化为普通行读。仓库里没有任何 `term_windows_test.go`。

### 12.13 附带一条：`tokenHex` 在 `crypto/rand` 失败时退化成全 `0`

`core/ids.go:36-42`。`rand.Read` 失败在容器 / 沙箱里并非不可能，退化后 `MakeID` 会生成确定性任务号，重试 20 次必然全撞，最终报「连续冲突 20 次，请检查台账是否异常」——**一个误导性的错误信息**。正确做法是让 `tokenHex` 返回 `error`。

---

## 13. 如果要借鉴到自己的项目

### 13.1 可直接抄的清单

| 场景 | 抄什么 | 出处 |
|---|---|---|
| 任何「配置文件 / 数据文件」写入 | `WriteTextAtomic` 的八步 + 拒符号链接 + 继承权限 | `store/atomic.go:24-72` |
| 多进程写同一批文件 | 两级锁（整命令级 + 单文件级）+ 多文件全序加锁 | `store/locks*.go` |
| 需要「失败不留下半截」的多文件操作 | 记账本（`Changed` / `Created` / `Presync`）+ 两套收尾 + `CommitStarted` 闸门 | `store/dirty.go` + `runner.go:43-62` |
| 不可逆操作（删除 / 覆盖） | 行指纹 `--expect`（sha256 前 12 hex）+ 对不上就零写入 | `core/history_md.go:61-70` |
| 重跑幂等 | 三态判重 `Hit / Miss / Undecidable`，判不出来就交人 | `store/historystore.go:16-20` |
| 缓存 | TTL + 单飞 + 代次失效（不是只清 Map） | `repositories/cache.ts:57-71` |
| 分层 | 把约束写成 CI 里的 `grep`，每条必须为 0 | `docs/api/ledger-api.md:33-43` |
| 多工作区扇出 | 部分失败 200 + `degraded`，全失败才 500 | `errors.ts:69-103` |
| 终端表格 | 自己记账光标（raw 模式下 `\r\n`）、`displayWidth` 按 CJK 双宽 | `term_canvas.go` |
| Agent 工具设计 | 授权分级表 + 「含糊就反问」+ 退出码 100 独立通道 | `SKILL.md:407-427` |

### 13.2 不要照抄的部分

- **写序即公开契约**：这套设计的「税」是每个动作的写序都变成了不可随意改的对外契约（`docs/data/ledger-files.md:85-99`）。如果你的项目没有「多人 + git 合并」这个前提，这部分复杂度是纯负担。
- **文档漂移**：项目已经有 3 处「文档写的和代码不一样」（guard 的四类拦截、`usageText`、退出码注释）。文档驱动开发的代价是**必须有人定期核对**，否则比没有文档更危险。
- **手写 UI**：1500 行的 `settings-page.ts` 与 900 行的 `ui.ts` 说明手写 DOM 在这个规模已经到顶。新项目直接上框架。

### 13.3 继续读的推荐路线

1. `docs/architecture/overview.md`（65 行，全局不变量） →
2. `docs/api/ledger-api.md`（338 行，逐方法签名 + 准入规则） →
3. `packages/skill/src/internal/shell/runner.go`（427 行，七步的完整实现）→
4. `packages/skill/src/internal/store/atomic.go` + `dirty.go`（258 行，写盘与记账本）→
5. `packages/skill/src/internal/shell/merge.go`（338 行，冲突合并，全仓最精巧的一段）→
6. `packages/skill/src/internal/actions/registry.go`（193 行，命令名册）→
7. `packages/skill/SKILL.md`（436 行，Agent 契约，产品定义本身）

---

## 附：本次研读的方法与产物

| 产物 | 内容 |
|---|---|
| 本文 | 综合架构、数据模型、读写链路、并发一致性、界面层、契约、可借鉴/可疑清单 |
| `.tmp/reports/go-data-layer.md` | `store` + `core` 数据层专项（482 行，逐条带行号） |
| `.tmp/reports/go-shell-actions.md` | `shell` + `actions` 外壳与动作层专项（456 行） |
| `.tmp/reports/plugin-ts.md` | `packages/plugin` TypeScript 专项（host 三层 + client UI） |

交叉验证过的三条关键结论（均已在源码中复现）：

1. `GuardBeforeWrite` 已从「硬拦四类」降级为「只硬拦 rebase 中间态」，`docs/architecture/overview.md:52` 是旧描述。
2. `padRight` 按 rune 计宽而 `displayWidth` 按显示宽度计宽，中文列必然错位。
3. `usageText` 缺 `forget` / `logout` 两条命令。
