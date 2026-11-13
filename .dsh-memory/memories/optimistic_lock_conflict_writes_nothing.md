---
id: "optimistic_lock_conflict_writes_nothing"
title: "乐观锁冲突必须「什么都没发生」——两个 commit 都带 revision"
kind: "pitfall"
about: "多步写操作里只给最后一个 commit 加 expectedRevision 会留下半截状态（CHG-192 重锚）"
confidence: "verified"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:17Z"
modifiedAt: "2026-11-13T18:59:03Z"
lastVerifiedAt: "2026-11-13T18:59:03Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["乐观锁", "expectedRevision", "revision", "MT_REVISION_CONFLICT", "并发"]
supersedes: ["optimistic_lock_conflict_writes_nothing"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/ledger/ledger.ts"
    hash: "13aa86ecfd1ca440583e93cb213227fb9abe18f8f26f0b9559cb03faafb788c3"
  - kind: "file"
    ref: "plugin/src/core/gates/gate-execution.ts"
    hash: "4fa75a2469aa9e1a446960bb7add4315d4b116095b35d3c6f8697cfb44607407"
  - kind: "test"
    ref: "plugin/test/t71-m2-remaining.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-174"
    state: "unverified"
    evidence: "的 （CHG-174）， 不再自己 。 - **CHG-190 之后**： / 的实现已下沉到"
  - kind: "ticket"
    ref: "CHG-190"
    state: "unverified"
    evidence: "G-174）， 不再自己 。 - **CHG-190 之后**： / 的实现已下沉到 ——**「每个 commit 都"
  - kind: "ticket"
    ref: "CHG-192"
    state: "unverified"
    evidence: "适用条件 不适用于单事件写路径（一个 commit 天然原子）。 <!-- CHG-192：重锚（2026-11-14）。CHG-190 把 expectedRevisionOf/reviewTask 下沉到 core/gates/gate-execution.ts 后锚"
  - kind: "ticket"
    ref: "QA-4"
    state: "unverified"
    evidence: "的 QA-4 组；面板 端到端；全量 **942 条**绿。 ## 不适用条件 不适用于单事件写路径"
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
- **CHG-190 之后**：`expectedRevisionOf` / `reviewTask` 的实现已下沉到 `core/gates/gate-execution.ts`——**「每个 commit 都带 revision」这条纪律不随搬家改变**，只是判定函数换了位置。

## 执行

`reviewTask` 里同样先比版本再碰状态；`MT_REVISION_CONFLICT` 是唯一冲突码。

## 验证方式

`plugin/test/t71-m2-remaining.test.ts` 的 QA-4 组；面板 `TaskDetailView.revision` 端到端；全量 `cd plugin && npm test` **942 条**绿。

## 不适用条件

不适用于单事件写路径（一个 commit 天然原子）。

<!-- CHG-192：重锚（2026-11-14）。CHG-190 把 expectedRevisionOf/reviewTask 下沉到
     core/gates/gate-execution.ts 后锚点切片再次漂移；结论未变，测试计数 917 → 942。 -->
