---
id: "ledger_seq_never_renumbered"
title: "账本重写时刻意不重编号 seq，坏行留永久空洞"
kind: "decision"
about: "为什么 ledger 压缩/重写后 seq 会出现空洞，以及为什么不能靠数组下标取事件"
confidence: "verified"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:46:58Z"
modifiedAt: "2026-11-13T14:04:36Z"
lastVerifiedAt: "2026-11-13T14:04:36Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["账本", "seq", "ledger", "坏行", "corrupted", "重编号"]
supersedes: ["ledger_seq_never_renumbered"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/ledger/ledger.ts"
    hash: "1ba8bfedd66b104b71c67158095e1a5a7ba8d9838b8a7d26d800633d754573c9"
  - kind: "test"
    ref: "plugin/test/t70-ledger-integrity.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-183"
    state: "unverified"
    evidence: "层（projection 是按 seq 建的 Map，不是数组）。 <!-- CHG-183：重锚（2026-11-13）。ledger.ts 重构（写入出口迁到 core/fs/atomic-write.ts）后 锚点切片漂移，结论未变：seq 仍不重编号、坏行仍是空洞。"
---

## 功能名

`plugin/src/core/ledger/ledger.ts` 的 append-only 账本在重写时**保留原始 seq**，坏行被跳过而不重编号，于是 seq 序列允许出现空洞。

## 生效条件

任何读账本、按 seq 定位事件、或做增量折叠的代码。

## 子功能

- 尾部残行 → 截断并计 `truncated`；中部坏行 → 跳过并继续，计 `corrupted`，**绝不丢后续事件**。
- seq 断点接受区间 `[expectedSeq, expectedSeq + skipped]`（坏行本身占一个 seq，所以空隙合法）。
- 重写时保留**原始行文本**而不是重新序列化 —— payload 里可能含任意字符串。

## 执行

取事件一律 `events.find((e) => e.seq === seq)`；**禁止** `events[seq]`。

## 验证方式

`plugin/test/t70-ledger-integrity.test.ts` 覆盖坏行跳过与断点接受；全量 `cd plugin && npm test` 917 条绿。

## 不适用条件

不适用于投影层（projection 是按 seq 建的 Map，不是数组）。

<!-- CHG-183：重锚（2026-11-13）。ledger.ts 重构（写入出口迁到 core/fs/atomic-write.ts）后
     锚点切片漂移，结论未变：seq 仍不重编号、坏行仍是空洞。测试计数同步到 917。 -->
