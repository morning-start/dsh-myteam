---
id: "optimistic_lock_conflict_writes_nothing"
title: "乐观锁冲突必须「什么都没发生」——两个 commit 都带 revision"
kind: "pitfall"
about: "多步写操作里只给最后一个 commit 加 expectedRevision 会留下半截状态"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:17Z"
modifiedAt: "2026-11-07T10:47:17Z"
lastVerifiedAt: "2026-11-07T10:47:17Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["乐观锁", "expectedRevision", "revision", "MT_REVISION_CONFLICT", "并发"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/src/core/ledger/ledger.ts"
    hash: "9c84f722be3bee0414b09f1f6be296935d6b2ac44f81af126b0f5d2e5ff4939c"
  - kind: "file"
    ref: "plugin/src/core/service.ts"
    hash: "c2d7c53a197608ef28bf51a63c0de408c2c59030ff795668f5f62726ae0a4ae5"
relations: []
claims:
  - kind: "ticket"
    ref: "QA-4"
    state: "unverified"
    evidence: "的 QA-4 组；面板 端到端。 ## 不适用条件 不适用于单事件写路径（一个 commit 天然原子）。"
---

## 功能名

`TeamService.commit({ expectedRevision })` 先比版本再碰任何状态；冲突时**账本零写入**。

## 生效条件

任何一次用户动作会连续产生多个账本事件的写路径（reassign / review / rescope …）。

## 子功能

- `myteam_reassign_task` 先撤 attempt 再指派：只给第二个 commit 加 revision，冲突时 attempt 已经没了。
- 正确做法是统一走 `commitGuarded`，**每个 commit 都带 revision**。
- 响应回显 `currentRevision`，让客户端能提示「重取后重试」。

## 执行

`reviewTask` 里同样先比版本再碰状态；`MT_REVISION_CONFLICT` 是唯一冲突码。

## 验证方式

`plugin/test/t71-m2-remaining.test.ts` 的 QA-4 组；面板 `TaskDetailView.revision` 端到端。

## 不适用条件

不适用于单事件写路径（一个 commit 天然原子）。
