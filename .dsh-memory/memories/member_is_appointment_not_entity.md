---
id: "member_is_appointment_not_entity"
title: "队员是「角色 × 团队」的聘任记录，不是第三种实体"
kind: "decision"
about: "实体模型的边界判据：什么该建实体，什么该做关系字段"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R5"
createdAt: "2026-11-07T10:48:10Z"
modifiedAt: "2026-11-07T10:48:10Z"
lastVerifiedAt: "2026-11-07T10:48:10Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["实体模型", "队员", "成员", "聘任", "参与", "interestWords"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/src/core/roles/role-store.ts"
    hash: "6c9a8906f2bc9bce1e15e7047ea8e596d0c579d56fd2427b63fa962958978828"
  - kind: "file"
    ref: "plugin/src/core/members/member-setup.ts"
    hash: "2235f5db02623a47fa2bbc0b29e1a406bb9aee0366351fa923a681cd0280d454"
relations: []
claims: []
---

## 功能名

角色（Role）是唯一要用户管理的实体；团队（Team）是一次角色编排；**队员（Member）是聘任记录** `{ teamId, roleId, instanceName, 快照, joinedAt }`；参与（Participation）是「任务 × 团队」的关系记录。

## 生效条件

任何新功能需要「队员」或「参与」有自己的生命周期（创建/编辑/删除面板）时。

## 子功能

- 快照在召唤那一刻固化（C3）——**改角色不影响已聘任的实例**；同名角色多次召唤自动 `-2` 编号。
- 两条边同构：都不是实体，都是一等公民的「关系」，都带快照与审计。
- 兴趣词 `interestWords[]` 是**软信号**（分派理由与认领排序），**不是权限**；权限只由 `toolPolicy`/`skills`/`mcpAllowlist` 决定。

## 执行

判据：先问「这是不是角色或任务上的一个字段/一条关系」，**默认不是实体**。

## 验证方式

`plugin/test/t5-roles.test.ts` 与 `docs/11-数据模型与存储设计.md` §九口径一致。

## 不适用条件

不适用于「团队」本身 —— 团队是编排单位，有独立生命周期。
