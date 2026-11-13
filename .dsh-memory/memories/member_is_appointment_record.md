---
id: "member_is_appointment_record"
title: "队员是「角色 × 团队」的聘任记录，不是第三种实体"
kind: "decision"
about: "实体模型的边界判据：什么该建实体，什么该做关系字段（CHG-183 重锚，接替 retired 的 member_is_appointment_not_entity）"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R5"
createdAt: "2026-11-13T14:07:58Z"
modifiedAt: "2026-11-13T14:07:58Z"
lastVerifiedAt: "2026-11-13T14:07:58Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["实体模型", "队员", "成员", "聘任", "参与", "interestWords"]
supersedes: ["member_is_appointment_not_entity"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/roles/role-store.ts"
    hash: "75a444ecb0a5e7f6f317af7ebff47b6814ca1dc5ad9d76038c9ca96edc3147e5"
  - kind: "file"
    ref: "plugin/src/core/members/member-setup.ts"
    hash: "320bdf0cbc6b3e305a72976b12fab3ecc8e3046c66468e6598c4e23ed1400099"
  - kind: "file"
    ref: "plugin/src/core/fs/atomic-write.ts"
    hash: "7721e7863599f49b1be1d1fda655678508c14c029a9dd621cf3db6032a25f66b"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-174"
    state: "unverified"
    evidence: "面**：聘任记录写盘统一走 （CHG-174 之后唯一写盘出口），角色库 与 都不再自己 。 ## 执行 判据：先问「这是不是角色或任"
  - kind: "ticket"
    ref: "CHG-183"
    state: "unverified"
    evidence: "件 不适用于「团队」本身 —— 团队是编排单位，有独立生命周期。 <!-- CHG-183（2026-11-13）：原 id 因重锚流程误退休， 本条目以新 id 接替（supersedes 指向它）。"
---

## 功能名

角色（Role）是唯一要用户管理的实体；团队（Team）是一次角色编排；**队员（Member）是聘任记录** `{ teamId, roleId, instanceName, 快照, joinedAt }`；参与（Participation）是「任务 × 团队」的关系记录。

## 生效条件

任何新功能需要「队员」或「参与」有自己的生命周期（创建/编辑/删除面板）时。

## 子功能

- 快照在召唤那一刻固化（C3）——**改角色不影响已聘任的实例**；同名角色多次召唤自动 `-2` 编号。
- 两条边同构：都不是实体，都是一等公民的「关系」，都带快照与审计。
- 兴趣词 `interestWords[]` 是**软信号**（分派理由与认领排序），**不是权限**；权限只由 `toolPolicy`/`skills`/`mcpAllowlist` 决定。
- **落盘面**：聘任记录写盘统一走 `core/fs/atomic-write.ts`（CHG-174 之后唯一写盘出口），角色库 `role-store.ts` 与 `member-setup.ts` 都不再自己 `writeFileSync`。

## 执行

判据：先问「这是不是角色或任务上的一个字段/一条关系」，**默认不是实体**。

## 验证方式

`plugin/test/t5-roles.test.ts` 与 `docs/11-数据模型与存储设计.md` §九口径一致；全量 `cd plugin && npm test` 917 条绿。

## 不适用条件

不适用于「团队」本身 —— 团队是编排单位，有独立生命周期。

<!-- CHG-183（2026-11-13）：原 id `member_is_appointment_not_entity` 因重锚流程误退休，
     本条目以新 id 接替（supersedes 指向它）。正文结论未变，补「唯一写盘出口」一条现状。 -->
