# dsh-plugin-myteam · v2

项目级多智能体团队运行时。v2 是**重写**，不是给 v1 打补丁：v1 的完整实现保存在
Git 标签 `v1-backup`，本分支从新的分层骨架开始重新实现。

> 状态：`2.0.0-alpha.1`。R0～R3（契约、领域内核、事件库与投影、项目用例）已落地并有测试；
> R4～R7（DSH 适配器、面板、实际迁移、验收清理）尚未完成。
> **R4 之前本分支不可安装**：`main` 指向的 `lib/composition/host.mjs` 还不存在，
> `cordis.patch.yml` 里的 preset 入口按 R4 设计尚未接上。

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
| 每个事件类型都有投影处理（目录与 switch 不漂移） | `application/projections/project-state.ts` | `t07` |
| Run 实例化 = 一个原子批次；完成条件满足时同批次关 Run | `application/run-commands.ts`、`task-commands.ts` | `t08` |
| 完成一个任务时同批次放开已满足依赖的下游任务 | `application/task-commands.ts` | `t08` |
| 知识提案必须有证据；提案与采纳分离 | `application/knowledge-commands.ts` | `t09` |
| 配置 rebase 必须带 `expectedConfigRevision` | `application/commands.ts` | `t09` |
| Effect 只能 `requested→accepted→completed`；未知结果不重放 | `application/effect-commands.ts` | `t10` |
| v1 分析：未知事件/序号断裂阻断，索引孤儿只告警 | `infrastructure/migration/v1/analyze.ts` | `t11` |

## 运行

```bash
cd plugin
node --test test/*.test.ts        # 69 个测试
node ../tools/check-architecture.mjs   # ARCH_OK files=30 violations=0
```

不需要 `npm install`：Node ≥ 22.18 直接擦除类型运行 `.ts`，仓库保持零运行时依赖。

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

## 下一阶段

1. **R3 应用用例**：Workflow Run、依赖重接、门禁裁决、知识、配置 rebase、Effect 请求/对账；
2. **R4 DSH 适配器**：Root Runtime、Captain/Member preset、工具注册、SessionRef、HumanAuthorizer；
3. **R5 v2 面板**：只消费 RPC 的统一投影（设计稿见 `design-v2/`）；
4. **R6 迁移**：`.team-workplace/`、两处旧账本、SQLite、memory.md 的一次性候选导入与对账；
5. **R7 验收与清理**：真机链路、文档替换、历史资料删除。