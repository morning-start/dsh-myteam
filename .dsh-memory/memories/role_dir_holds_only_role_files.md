---
id: "role_dir_holds_only_role_files"
title: "config/roles 目录即集合，塞非角色 JSON 会让整个角色库崩掉"
kind: "pitfall"
about: "为什么 session-defaults.json 不能放进 config/roles，以及为什么坏文件必须 fail loud"
confidence: "verified"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:24Z"
modifiedAt: "2026-11-07T10:47:24Z"
lastVerifiedAt: "2026-11-07T10:47:24Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["角色库", "config/roles", "MT_ROLE_CORRUPT", "session-defaults", "fail loud"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/src/core/roles/role-store.ts"
    hash: "6c9a8906f2bc9bce1e15e7047ea8e596d0c579d56fd2427b63fa962958978828"
  - kind: "test"
    ref: "plugin/test/t5-roles.test.ts"
relations: []
claims: []
---

## 功能名

`listProjectRoles()` 把 `config/roles/` 下**所有** `*.json` 当角色定义读，读到非角色 JSON 直接 `MT_ROLE_CORRUPT`。

## 生效条件

新增任何「配置资产」类文件时。

## 子功能

- 角色库 `config/roles/`、预设库 `config/presets/` 都是「目录即集合」语义。
- 任何新增配置文件必须**另开目录/前缀**，不能顺手套进已存在的集合目录。
- 会话默认值因此放在 `.team-workplace/config/session-defaults.json`（配置根，不是角色库）。

## 执行

**反向纪律**：`listProjectRoles()` 的「坏文件 fail loud」是 T5 定案，**不能改成静默跳过** —— 静默跳过会让「角色丢了」看起来像「从没建过」。

## 验证方式

`plugin/test/t5-roles.test.ts` 断言坏文件报 `MT_ROLE_CORRUPT`；改成 try/catch 跳过会立刻红。

## 不适用条件

不适用于 `config/presets/`（预设库有自己的加载器，但同样是目录即集合）。
