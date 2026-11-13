---
id: "role_dir_holds_only_role_files"
title: "config/roles 目录即集合，塞非角色 JSON 会让整个角色库崩掉"
kind: "pitfall"
about: "为什么 session-defaults.json 不能放进 config/roles，以及为什么坏文件必须 fail loud（CHG-183 重锚）"
confidence: "verified"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:24Z"
modifiedAt: "2026-11-13T14:08:58Z"
lastVerifiedAt: "2026-11-13T14:08:58Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["角色库", "config/roles", "MT_ROLE_CORRUPT", "session-defaults", "fail loud"]
supersedes: ["role_dir_holds_only_role_files"]
evidence:
  - kind: "file"
    ref: "plugin/src/core/roles/role-store.ts"
    hash: "75a444ecb0a5e7f6f317af7ebff47b6814ca1dc5ad9d76038c9ca96edc3147e5"
  - kind: "test"
    ref: "plugin/test/t5-roles.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-174"
    state: "unverified"
    evidence: "面**：角色文件写入统一走 （CHG-174），因此 里不会再出现裸 。 ## 执行 **反向纪律**： 的「坏文件 fail l"
  - kind: "ticket"
    ref: "CHG-183"
    state: "unverified"
    evidence: "（预设库有自己的加载器，但同样是目录即集合）。 <!-- CHG-183（2026-11-13）：role-store.ts 重构（写盘出口统一到 core/fs/atomic-write.ts）后 锚点切片漂移，结论未变。 -->"
---

## 功能名

`listProjectRoles()` 把 `config/roles/` 下**所有** `*.json` 当角色定义读，读到非角色 JSON 直接 `MT_ROLE_CORRUPT`。

## 生效条件

新增任何「配置资产」类文件时。

## 子功能

- 角色库 `config/roles/`、预设库 `config/presets/` 都是「目录即集合」语义。
- 任何新增配置文件必须**另开目录/前缀**，不能顺手套进已存在的集合目录。
- 会话默认值因此放在 `.team-workplace/config/session-defaults.json`（配置根，不是角色库）。
- **写盘面**：角色文件写入统一走 `core/fs/atomic-write.ts`（CHG-174），因此 `role-store.ts` 里不会再出现裸 `writeFileSync`。

## 执行

**反向纪律**：`listProjectRoles()` 的「坏文件 fail loud」是 T5 定案，**不能改成静默跳过** —— 静默跳过会让「角色丢了」看起来像「从没建过」。

## 验证方式

`plugin/test/t5-roles.test.ts` 断言坏文件报 `MT_ROLE_CORRUPT`；改成 try/catch 跳过会立刻红。全量 `cd plugin && npm test` 917 条绿。

## 不适用条件

不适用于 `config/presets/`（预设库有自己的加载器，但同样是目录即集合）。

<!-- CHG-183（2026-11-13）：role-store.ts 重构（写盘出口统一到 core/fs/atomic-write.ts）后
     锚点切片漂移，结论未变。 -->
