---
id: "v4_closure_delivered_state"
title: "v4 收口已交付 14 commits（CHG-179~192）：派生树 / 三刀下沉 / 看板索引 / UI 三修；942 绿、入口层 30.1%"
kind: "fact"
about: "v4 收口这一轮做到哪了：14 个提交的交付面、关键数字、以及还欠什么（下次开会话先看这条）"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R4"
createdAt: "2026-11-13T19:18:41Z"
modifiedAt: "2026-11-13T19:18:41Z"
lastVerifiedAt: "2026-11-13T19:18:41Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["v4 收口", "做到哪了", "入口层", "派生树", "看板索引", "CHG-192", "还欠什么"]
supersedes: []
evidence:
  - kind: "doc"
    ref: "docs/09-变更记录.md"
    hash: "95bf77676470ef84e7065e7e8828dc79c7010d23bb3c9efaae52cea832a5dbd0"
  - kind: "doc"
    ref: "docs/superpowers/plans/2026-11-13-v4-closure.md"
    hash: "db38e461b8302f734bbfe9b5df014787de4113a4951aede08baaec65905a2522"
  - kind: "file"
    ref: "plugin/src/core/gates/gate-execution.ts"
    hash: "4fa75a2469aa9e1a446960bb7add4315d4b116095b35d3c6f8697cfb44607407"
  - kind: "file"
    ref: "plugin/src/core/members/hierarchy.ts"
    hash: "c4815a27bbed0d5fa2619fd648aca33e6319468ede19aeeaaf6fb45276e91d76"
  - kind: "file"
    ref: "plugin/src/core/index/project-board-index.ts"
    hash: "0efe1127613a419a449426ecdb7eb2e21936f69d73ccd13da5614165d79fcd27"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-179"
    state: "unverified"
    evidence: "## 功能名 myteam **v4 收口**（CHG-179~192）——一轮把「审计报告剩下的 5 项 + 入口层下沉三刀」全部落地。**当前状态：全部完成，工作树干净，HEAD = 。** ## 生效条件 任何要接着做 myt"
  - kind: "ticket"
    ref: "FR-32"
    state: "unverified"
    evidence: "到哪一步了」时。 ## 子功能（14 个提交的交付面） - **成员派生树（FR-32）**： （深度/子数/级联纯规则）+ （spawn 生命周期）；"
  - kind: "ticket"
    ref: "M3-7"
    state: "unverified"
    evidence: "I 没接。跨团队聚合要 **复合键**，属 M3-7。 3. 提交 信息写「重锚 5 条」实际 **6 条**（不影响内容，日志数字错）。 在「派生树 / 迁移 / 索引 / 下沉」这四块上，**不要再重新审计**——直接"
---

## 功能名

myteam **v4 收口**（CHG-179~192）——一轮把「审计报告剩下的 5 项 + 入口层下沉三刀」全部落地。**当前状态：全部完成，工作树干净，HEAD = `1b9f34f`。**

## 生效条件

任何要接着做 myteam 架构/UI 的会话，**开工前先读这条**，避免重复审计；以及需要回答「这个项目做到哪一步了」时。

## 子功能（14 个提交的交付面）

- **成员派生树（FR-32）**：`core/members/hierarchy.ts`（深度/子数/级联纯规则）+ `core/members/spawn-lifecycle.ts`（spawn 生命周期）；`member.spawned` 三字段 `parentMemberId/depth/rootMemberId` **必填**，旧账本由 `core/ledger/migrate.ts` 一次性迁移（**幂等 + fail-loud**，`MT_SCHEMA_MIGRATION_FAILED`）；错误码 82 → 86。
- **架构下沉三刀**：`core/members/spawn-lifecycle.ts`(477 行/18 依赖) · `core/gates/gate-execution.ts`(764 行/17 依赖) · `core/tasks/batch-orchestration.ts`(579 行/7 依赖)。**逐字核验 1,141 条逻辑行一字不差**（281 + 443 + 417）。
- **入口层拆薄**：`core/host/contract.ts` 解掉 `host.ts ⇄ remote/service.ts` 的 **type 环（1 → 0）**；六族端点全部搬进 `src/host/*.ts`。
- **看板派生索引**：`core/index/project-board-index.ts` → `state/index/tasks.json`，三条不变量（删掉能重建 / 与实时折叠逐字段相等 / 坏索引降级**不返回空看板**）。
- **UI 三修**：成本归因三档降级（`costDegradeOf` 纯函数）· 空态列宽统一（**有任务/无任务同一个 1400 阅读列**，`t101 ④` 反向锁）· 泳道行高与依赖图连线（CHG-179）。
- **工具修正**：`arch-report` 把 `src/host/*.ts` 归入口层——否则 16 条正常边被算成「逆向依赖」，会拿到**假架构报告**。

## 执行

- 门禁四条：`cd plugin && npm test`（**942 条**）· `node tools/check-architecture.mjs`（A1–A6）· `node tools/check-drift.mjs` · `cd plugin && npm run bundle`（`t42` 校验 clientHash）
- 结构类改动一律「**先写失败测试 → 逐字搬 → 反向逐行比对 → 降棘轮**」，每族/每刀一次提交
- 棘轮两处同步：`tools/check-architecture.mjs` 的 `A6_LIMIT` 与 `plugin/test/t142-host-split.test.ts` 的 `HOST_LINES_LIMIT`

## 验证方式

```
942/942 pass · ARCH_VIOLATIONS 0 · MISMATCH 0
host.ts 6,210 → 4,405 行（−29%）· 入口层 33.7% → 30.1%
逆向 value 边 0 · value 环 0 · type 环 0 · 入口不可达 0 · 悬空 0
memory_audit：锚点全部健康（13 条）· 回执健康 · contradicted 0
```

## 不适用条件

**还欠三件，别当成已完成**：
1. **4,000 行目标未达成**（收在 4,405）。case 层已 100% 清空，剩下的全是**装配与唤醒逻辑**（`afterCommit` / `dispatchSweep` / `refreshTeamIndex`）——**再降要靠装配逻辑下沉，不是继续按端点切**。
2. **`getBoard().project` 仍无消费方**：索引建好、五条不变量钉死，但 UI 没接。跨团队聚合要 `teamId + taskId` **复合键**，属 M3-7。
3. 提交 `1b9f34f` 信息写「重锚 5 条」实际 **6 条**（不影响内容，日志数字错）。

在「派生树 / 迁移 / 索引 / 下沉」这四块上，**不要再重新审计**——直接读 `docs/09` 的 CHG-179~192 与 `docs/superpowers/plans/2026-11-13-v4-closure.md`。
