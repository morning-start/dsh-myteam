---
id: "ledger_seq_never_renumbered"
title: "账本重写时刻意不重编号 seq，坏行留永久空洞"
kind: "decision"
about: "为什么 ledger 压缩/重写后 seq 会出现空洞，以及为什么不能靠数组下标取事件（CHG-192 重锚）"
confidence: "verified"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:46:58Z"
modifiedAt: "2026-11-13T18:58:19Z"
lastVerifiedAt: "2026-11-13T18:58:19Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["账本", "seq", "ledger", "坏行", "corrupted", "重编号"]
supersedes: ["ledger_seq_never_renumbered"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/ledger/ledger.ts"
    hash: "13aa86ecfd1ca440583e93cb213227fb9abe18f8f26f0b9559cb03faafb788c3"
  - kind: "file"
    ref: "plugin/src/core/ledger/migrate.ts"
    hash: "90bc1aa8a1369a2b1a2e6749cb33cbeb3abedd0850c10b2a32c3721b387ec802"
  - kind: "test"
    ref: "plugin/test/t70-ledger-integrity.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-192"
    state: "unverified"
    evidence: "层（projection 是按 seq 建的 Map，不是数组）。 <!-- CHG-192：重锚（2026-11-14）。CHG-187b 引入账本迁移（core/ledger/migrate.ts）后锚点切片 再次漂移，结论未变；补一条「迁移只补字段、不重编号 seq」"
---

## 功能名

`plugin/src/core/ledger/ledger.ts` 的 append-only 账本在重写时**保留原始 seq**，坏行被跳过而不重编号，于是 seq 序列允许出现空洞。

## 生效条件

任何读账本、按 seq 定位事件、或做增量折叠的代码。

## 子功能

- 尾部残行 → 截断并计 `truncated`；中部坏行 → 跳过并继续，计 `corrupted`，**绝不丢后续事件**。
- seq 断点接受区间 `[expectedSeq, expectedSeq + skipped]`（坏行本身占一个 seq，所以空隙合法）。
- 重写时保留**原始行文本**而不是重新序列化 —— payload 里可能含任意字符串。
- **CHG-187b 之后**：`member.spawned` 的三个派生树字段（`parentMemberId/depth/rootMemberId`）是**必填**，旧账本由 `core/ledger/migrate.ts` 一次性迁移（幂等 + fail-loud）。**迁移不重编号 seq**——它只补字段，行序与 seq 原样保留，否则历史事件会整体错位。

## 执行

取事件一律 `events.find((e) => e.seq === seq)`；**禁止** `events[seq]`。

## 验证方式

`plugin/test/t70-ledger-integrity.test.ts` 覆盖坏行跳过与断点接受；`t139-12/13` 覆盖迁移幂等与失败大声；全量 `cd plugin && npm test` **942 条**绿。

## 不适用条件

不适用于投影层（projection 是按 seq 建的 Map，不是数组）。

<!-- CHG-192：重锚（2026-11-14）。CHG-187b 引入账本迁移（core/ledger/migrate.ts）后锚点切片
     再次漂移，结论未变；补一条「迁移只补字段、不重编号 seq」，测试计数 917 → 942。 -->
