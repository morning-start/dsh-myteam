---
id: "optimistic_lock_conflict_writes_nothing"
title: "乐观锁冲突必须「什么都没发生」——两个 commit 都带 revision"
kind: "pitfall"
about: "多步写操作里只给最后一个 commit 加 expectedRevision 会留下半截状态（CHG-183 重锚）"
confidence: "verified"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:17Z"
modifiedAt: "2026-11-13T14:08:34Z"
lastVerifiedAt: "2026-11-13T14:08:34Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["乐观锁", "expectedRevision", "revision", "MT_REVISION_CONFLICT", "并发"]
supersedes: ["optimistic_lock_conflict_writes_nothing"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/ledger/ledger.ts"
    hash: "1ba8bfedd66b104b71c67158095e1a5a7ba8d9838b8a7d26d800633d754573c9"
  - kind: "file"
    ref: "plugin/src/core/service.ts"
    hash: "9656632cf523b23bace8006f3936ead181c376e18f273aa6944e64e97bab56ec"
  - kind: "test"
    ref: "plugin/test/t71-m2-remaining.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-174"
    state: "unverified"
    evidence: "的 （CHG-174）， 不再自己 。 ## 执行 里同样先比版本再碰状态； 是唯一冲突码。"
  - kind: "ticket"
    ref: "CHG-183"
    state: "unverified"
    evidence: "适用条件 不适用于单事件写路径（一个 commit 天然原子）。 <!-- CHG-183（2026-11-13）：ledger.ts / service.ts 重构（写盘出口统一）后锚点切片漂移， 结论未变；补一条「写盘面走 appendTextSync」的现状。 --"
  - kind: "ticket"
    ref: "QA-4"
    state: "unverified"
    evidence: "的 QA-4 组；面板 端到端；全量 917 条绿。 ## 不适用条件 不适用于单事件写路径（一个"
---

## 功能名

`TeamService.commit({ expectedRevision })` 先比版本再碰任何状态；冲突时**账本零写入**。

## 生效条件

任何一次用户动作会连续产生多个账本事件的写路径（reassign / review / rescope …）。

## 子功能

- `myteam_reassign_task` 先撤 attempt 再指派：只给第二个 commit 加 revision，冲突时 attempt 已经没了。
- 正确做法是统一走 `commitGuarded`，**每个 commit 都带 revision**。
- 响应回显 `currentRevision`，让客户端能提示「重取后重试」。
- **写盘面**：账本追加统一走 `core/fs/atomic-write.ts` 的 `appendTextSync`（CHG-174），`ledger.ts` 不再自己 `openSync`。

## 执行

`reviewTask` 里同样先比版本再碰状态；`MT_REVISION_CONFLICT` 是唯一冲突码。

## 验证方式

`plugin/test/t71-m2-remaining.test.ts` 的 QA-4 组；面板 `TaskDetailView.revision` 端到端；全量 `cd plugin && npm test` 917 条绿。

## 不适用条件

不适用于单事件写路径（一个 commit 天然原子）。

<!-- CHG-183（2026-11-13）：ledger.ts / service.ts 重构（写盘出口统一）后锚点切片漂移，
     结论未变；补一条「写盘面走 appendTextSync」的现状。 -->
