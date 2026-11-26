# dsh-plugin-myteam · v2

项目级多智能体团队运行时。v2 是**重写**，不是给 v1 打补丁：v1 的完整实现保存在
Git 标签 `v1-backup`，本分支从新的分层骨架开始重新实现。

> 状态：`2.0.0`（正式版）。读面 16 个方法、写面 6 项、会话「团队视图」九栏 + 左栏 myteam 五栏
> 全部接真实端点；写操作一律要人确认（令牌两段式，或显式 `confirm: true`）。
> 已在隔离实例里实测：准入/读面/写面/客户端资产/清除 **46/46**（见
> [隔离验收记录](../docs/delivery/25-隔离验收记录.md)）；界面观感、深色、窄宽需人眼过一遍，
> 见 [发版清单](../docs/delivery/23-发版清单.md) 的「已知限制」。

## 为什么要重写

v1 的问题不是「文件太大」，而是边界错了，且错在会被持续沿用：

- 业务 Host 挂在 captain preset 里，成员工具反向依赖入口 Host；
- 配置、知识、成员卡、身份快照与索引各有多份权威与非原子写；
- 面板在线/离线存在多条读写路径，离线视图另起一套状态机；
- `actor:'human'` / `confirm:true` 只是普通参数，不能构成可信人类授权。

继续「原地换内核」会让旧 Host 继续决定系统边界，所以 v2 在隔离 worktree 中重建，
最终整体替换（见 [全量重构实施设计](../docs/architecture/04-全量重构实施设计.md)）。

## 分层与依赖方向

```text
plugin/src/
├── contracts/      事件、批次帧、实体形状、错误码、版本与规范化 hash
├── domain/         纯领域规则：定义资产、任务 DAG、状态机、配置合并、权限
├── application/    用例命令、项目运行时、内存投影（纯 reducer）
├── infrastructure/ 文件事件库、写者租约（未来：DSH 适配器、迁移读取器）
└── composition/    （R4）DSH 装载与依赖装配
```

依赖只能向内：

```text
composition → infrastructure → application → domain → contracts
```

由 `tools/check-architecture.mjs` 机械检查（V1～V5：目录归属、依赖方向、宿主模块、
第三方包、打印边界）。`contracts/domain/application` 不得 import `fs` /
`child_process` / `path`，也不得 `console.log`；需要 IO 或日志时用
`application/ports.ts` 的端口。

## 已实现的不变量

| 不变量 | 落点 | 测试 |
|---|---|---|
| 事件内容 hash 与字段顺序无关、拒绝不可无损表达的值 | `contracts/json.ts` | `t01` |
| 批次 = 头帧 + 事件帧 + 提交帧；hash/数量/序号三者对齐才是 durable 提交点 | `contracts/batch.ts` | `t01` |
| 撕裂尾部与损坏严格区分：前者可显式修复，后者整个项目停写 | `infrastructure/event-store/log-scan.ts` | `t01`、`t05` |
| 追加前核对 projectSeq 连续；跳号拒绝且不写坏日志 | `infrastructure/event-store/file-store.ts` | `t05` |
| 写者租约独占、fencing 单调、过期可接管、释放留墓碑 | `infrastructure/event-store/writer-lease.ts` | `t05` |
| 能力只收窄；deny 不能被下层重新打开；`*` 与空 allow 语义不同 | `domain/definitions/role.ts` | `t02` |
| 工作流定义可实例化：key 唯一、依赖存在、无环、完成条件可解析 | `domain/definitions/workflow.ts` | `t03` |
| 任务就绪只认上游 `done`；`cancelled` 不解除下游 | `domain/tasks/dag.ts` | `t03` |
| 完成 = review + 门禁 pass + 证据/交付物齐 + 依赖完成，缺一不可 | `domain/tasks/task.ts` | `t04` |
| 配置分层合并后按安全上限钳制，钳制项写进快照；未知键报错 | `domain/config/merge.ts` | `t04` |
| 人类专属动作对任何 agent 返回 `HUMAN_ONLY` | `domain/permissions/policy.ts` | `t04` |
| 项目重开后的投影与关闭前逐字段一致 | `application/project-runtime.ts` | `t06` |
| 外部写入后先按 seq 重建投影再判身份（陈旧读会导致队长被误判 FORBIDDEN） | `application/project-runtime.ts` `refresh()` | 真机复现（`a144b2e`） |
| 每个事件类型都有投影处理（目录与 switch 不漂移） | `application/projections/project-state.ts` | `t07` |
| Run 实例化 = 一个原子批次；完成条件满足时同批次关 Run | `application/run-commands.ts`、`task-commands.ts` | `t08` |
| 完成一个任务时同批次放开已满足依赖的下游任务 | `application/task-commands.ts` | `t08` |
| 知识提案必须有证据；提案与采纳分离 | `application/knowledge-commands.ts` | `t09` |
| 配置 rebase 必须带 `expectedConfigRevision` | `application/commands.ts` | `t09` |
| Effect 只能 `requested→accepted→completed`；未知结果不重放 | `application/effect-commands.ts` | `t10` |
| v1 分析：未知事件/序号断裂阻断，索引孤儿只告警 | `infrastructure/migration/v1/analyze.ts` | `t11` |
| 工具身份只来自会话绑定；未知会话 = FORBIDDEN | `application/actor-resolution.ts` | `t12` |
| 队长 15 个工具、成员 3 个工具，互不泄漏 | `composition/host.ts`、`composition/member.ts` | `t12` |
| 同一工作区只开一个项目运行时（并发打开折叠为一个 Promise） | `infrastructure/dsh/project-hosts.ts` | `t12` |
| 迁移影响面可复现：CLI 与报告同一结构，阻断时不给导入顺序 | `infrastructure/migration/v1/report.ts` | `t13` |
| 面板只读服务：协议版本不匹配即拒绝，未知方法/缺参数结构化报错 | `application/panel-service.ts` | `t14` |
| 人类确认令牌绑定 operationId/action/targetHash/impactHash/一次性 nonce | `domain/permissions/human-authorizer.ts` | `t15` |
| 解散团队/队长接管：预览 → 确认 → 执行；影响面变化即失效 | `application/human-actions.ts` | `t16` |
| 候选导入只支持已确认的事件形状；其他事件阻断而非跳过 | `infrastructure/migration/v1/convert.ts` | `t18` |
| 候选写入后从磁盘重放对账，数量不符即失败 | `infrastructure/migration/v1/convert.ts` | `t18` |
| 任务按终态折叠迁移；在途执行回落 ready，旧 Attempt 不迁移 | `infrastructure/migration/v1/convert.ts` | `t18` |
| 知识保留「提案→采纳」链；被驳回的提案不迁移 | `infrastructure/migration/v1/convert.ts` | `t18` |
| cutover 前必须证明候选未过期（来源 hash 对得上） | `infrastructure/migration/v1/cutover.ts` | `t19` |
| 记忆属于 bank 不属于会话；跨 bank 读取视为不存在；硬删除仅人类 | `infrastructure/memory-store/sqlite-memory.ts` | `t20` |
| 人类动作（解散/接管）走 CLI：预览只读、执行前重算影响面、令牌一次性 | `tools/myteam-human.mjs` | `t31` |
| 同一动作也有斜杠命令入口（不带 `--yes` 只预览；模型无法伪造） | `src/composition/human-command.ts` | `t32` |
| 演练在临时副本上完成切换与回滚，不触碰真实工作区 | `tools/rehearse-cutover.mjs` | `t21` |
| 面板视图模型只做排序/分组/标签，不重算业务；未知状态显示为未知 | `client/panel-model.js` | `t22` |
| 面板渲染纯字符串；所有数据文本必须转义（防 XSS） | `client/panel-render.js` | `t23` |
| 静态演示页用同一套模型/渲染，可直接在浏览器看效果 | `client/panel-demo.html`、`panel-definitions.html`、`panel-migration.html` | 人工预览 |
| 面板客户端与传输无关；服务端错误转 PanelError，畸形响应不算成功 | `client/panel-client.js` | `t24` |
| 项目根取**会话工作目录**（workingDirectory.ensure），不是进程 cwd | `src/composition/host.ts` | `t12` |
| 队长与成员共享同一项目运行时（按 root 引用计数，最后释放才 close） | `infrastructure/dsh/project-hosts.ts` | `t12` |

## 运行

```bash
cd plugin
node --test test/*.test.ts        # 142 个测试
node ../tools/check-architecture.mjs   # ARCH_OK files=49 violations=0
node scripts/build-lib.mjs        # 构建 lib/（根入口 index.js 转发到 lib/composition/host.mjs）；lib 不入库，安装/本地运行前必须先跑
node ../tools/gen-panel-contract.mjs --check   # 面板契约文档与代码一致
node ../tools/gen-tool-contract.mjs --check    # 工具面契约文档与代码一致
node ../tools/gen-config-contract.mjs --check  # 配置字段契约文档与代码一致
# 真实 cutover 演练（只读；候选写临时目录，不动工作区）
node ../tools/myteam-cutover.mjs --root "<项目目录>"

# v1 数据只读分析（不写旧文件、不迁移）
node ../tools/myteam-migrate.mjs analyze --root "<项目目录>"
node ../tools/myteam-migrate.mjs plan    --root "<项目目录>" --json
# 候选导入：写到一个独立目录，旧工作区不动；写完立即对账
node ../tools/myteam-migrate.mjs candidate --root "<项目目录>" --candidate "<候选目录>"
# cutover 计划：检查候选完整性、源是否变化、列出步骤与回滚边界（不执行切换）
node ../tools/myteam-migrate.mjs cutover-plan --root "<项目目录>" --candidate "<候选目录>"
# cutover 演练：在临时副本上跑完分析→候选→切换→首次打开→回滚，不碰真实工作区
node ../tools/rehearse-cutover.mjs --root "<项目目录>"
```

**运行时零依赖**：Node ≥ 22.18 直接擦除类型运行 `.ts`，宿主装载本插件不需要 `npm install`。

**开发依赖只有类型门禁用的两个**（`typescript` / `@types/node`，锁在 `package-lock.json` 里）：

```bash
cd plugin && npm ci      # 只装 devDependencies，约 3 个包
npm run typecheck        # tsc --noEmit；等价于 node ../tools/check-types.mjs
```

不装也能跑构建与测试，但 `node tools/check-all.mjs` 的「类型检查」会**明确失败**
（`TYPES_FAIL 依赖未安装`）而不是静默跳过——一条会跳过的门禁等于没有门禁。

## 数据布局（v2 目标，R6 迁移后生效）

```text
<project>/.dsh-myteam/
├── manifest.json          # projectId、layoutVersion、schemaVersion
├── events/project.jsonl   # 项目唯一业务事实源（原子批次）
├── config/                # 生成视图，禁止直接写
├── memory/memory.db       # 长期记忆唯一权威（R3）
├── state/projections/     # 可重建缓存
└── state/writer.lock      # 写者协调，不是业务事实
```

## 明确不做

- 启动时自动截断「看起来坏了」的日志——撕裂尾部必须显式修复并留报告；
- 把「返回失败」当成「可能写进去了」——durable 之前的失败不产生任何投影变化；
- 用 `actor:'human'` 或 `confirm:true` 参数充当人类授权——那只是普通数据；
- 两个进程同时写同一项目——未取得租约只读或转发；
- 新旧存储长期双写。

## 排障关键字

宿主日志里按这些 key 搜，能直接定位到对应子系统：

| 日志键 | 含义 / 处置 |
|---|---|
| `writer.lease.renew.failed` | 续租失败；写入前还会再 assert，最终报 `WRITER_LEASE_LOST`。检查是否有第二个进程持有同一项目 |
| `project.state.refreshed` | 检测到外部写入并按 seq 重建投影（正常日志；频繁出现说明有多个实例轮流写） |
| `myteam.panel.registered` | 面板门面已在 root 级注册；缺失说明 typert 协议包没解析到（看 `DSH_INSTALL_DIR`） |
| `myteam.panel.protocol-import-failed` | 同上，带具体 import 错误 |
| `MANIFEST_INVALID`（工具返回） | 工作区还是 v1 布局；先跑 cutover，不要手工改 manifest |

只读体检：`node tools/myteam-inspect.mjs --root <项目目录>`，不拿租约、不写文件。

## 当前阶段与剩余

- R0–R7 的主链路已完成并在真实 DSH Web 验收（隔离工作区 + 真实工作区各一轮，见 `docs/delivery/验收记录-v2-代码侧.md`）；
- 剩余：人类动作的 `actionCards` 卡体（处理器已实现并有测试，缺 zod schema、随包 skill 与卡体渲染），以及发布前的版本策略收口。