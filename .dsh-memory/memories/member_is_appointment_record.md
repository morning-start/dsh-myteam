---
id: "member_is_appointment_record"
title: "队员是「角色 × 团队」的聘任记录，不是第三种实体"
kind: "decision"
about: "实体模型的边界判据：什么该建实体，什么该做关系字段（CHG-192 重锚）"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R5"
createdAt: "2026-11-13T14:07:58Z"
modifiedAt: "2026-11-13T18:58:43Z"
lastVerifiedAt: "2026-11-13T18:58:43Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["实体模型", "队员", "成员", "聘任", "参与", "interestWords", "派生树"]
supersedes: ["member_is_appointment_record"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/roles/role-store.ts"
    hash: "75a444ecb0a5e7f6f317af7ebff47b6814ca1dc5ad9d76038c9ca96edc3147e5"
  - kind: "file"
    ref: "plugin/src/core/members/member-setup.ts"
    hash: "aaa7a610db1c911928a7d2b3168cacfba19a525adfc5f41a63b251425a06dfcf"
  - kind: "file"
    ref: "plugin/src/core/members/hierarchy.ts"
    hash: "c4815a27bbed0d5fa2619fd648aca33e6319468ede19aeeaaf6fb45276e91d76"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-174"
    state: "unverified"
    evidence: "面**：聘任记录写盘统一走 （CHG-174 之后唯一写盘出口），角色库 与 都不再自己 。 - **CHG-187（FR-32）之后**"
  - kind: "ticket"
    ref: "CHG-187"
    state: "unverified"
    evidence: "都不再自己 。 - **CHG-187（FR-32）之后**：成员可以派生更小的子 Agent—— / / 是**投影的必填字段**（旧账本由"
  - kind: "ticket"
    ref: "CHG-192"
    state: "unverified"
    evidence: "件 不适用于「团队」本身 —— 团队是编排单位，有独立生命周期。 <!-- CHG-192：重锚（2026-11-14）。CHG-187/187b 引入成员派生树（parentMemberId/depth/rootMemberId 必填 + 迁移）后锚点切片漂移；结论未变"
  - kind: "ticket"
    ref: "FR-32"
    state: "unverified"
    evidence: "都不再自己 。 - **CHG-187（FR-32）之后**：成员可以派生更小的子 Agent—— / / 是**投影的必填字段**（旧账本由"
---

## 功能名

角色（Role）是唯一要用户管理的实体；团队（Team）是一次角色编排；**队员（Member）是聘任记录** `{ teamId, roleId, instanceName, 快照, joinedAt, parentMemberId, depth, rootMemberId }`；参与（Participation）是「任务 × 团队」的关系记录。

## 生效条件

任何新功能需要「队员」或「参与」有自己的生命周期（创建/编辑/删除面板）时。

## 子功能

- 快照在召唤那一刻固化（C3）——**改角色不影响已聘任的实例**；同名角色多次召唤自动 `-2` 编号。
- 两条边同构：都不是实体，都是一等公民的「关系」，都带快照与审计。
- 兴趣词 `interestWords[]` 是**软信号**（分派理由与认领排序），**不是权限**；权限只由 `toolPolicy`/`skills`/`mcpAllowlist` 决定。
- **落盘面**：聘任记录写盘统一走 `core/fs/atomic-write.ts`（CHG-174 之后唯一写盘出口），角色库 `role-store.ts` 与 `member-setup.ts` 都不再自己 `writeFileSync`。
- **CHG-187（FR-32）之后**：成员可以派生更小的子 Agent——`parentMemberId` / `depth` / `rootMemberId` 是**投影的必填字段**（旧账本由 `core/ledger/migrate.ts` 一次性迁移补齐），深度上限 `memberMaxDepth`、子数上限 `maxChildren` 由 `core/members/hierarchy.ts` 的纯规则判定。**「成员仍是聘任记录」这个判据没变**：派生树是记录上的字段，不是第三种实体。

## 执行

判据：先问「这是不是角色或任务上的一个字段/一条关系」，**默认不是实体**。

## 验证方式

`plugin/test/t5-roles.test.ts` 与 `docs/11-数据模型与存储设计.md` §九口径一致；`t139` 11 条覆盖派生树与迁移；全量 `cd plugin && npm test` **942 条**绿。

## 不适用条件

不适用于「团队」本身 —— 团队是编排单位，有独立生命周期。

<!-- CHG-192：重锚（2026-11-14）。CHG-187/187b 引入成员派生树（parentMemberId/depth/rootMemberId
     必填 + 迁移）后锚点切片漂移；结论未变——派生树是记录上的字段，不是新实体。 -->
