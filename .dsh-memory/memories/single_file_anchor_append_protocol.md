---
id: "single_file_anchor_append_protocol"
title: "多路并行改 client.js 只能按锚点字面追加，禁整文件写"
kind: "convention"
about: "client.js 是 11,695 行手写单文件，六路并行修改时的协作协议"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-07T10:47:56Z"
modifiedAt: "2026-11-07T10:47:56Z"
lastVerifiedAt: "2026-11-07T10:47:56Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["client.js", "并行", "锚点", "FS_STALE_VERSION", "prettier", "单文件"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/client/client.js"
    hash: "6baca6b8718f8f248129f3190889f172b0a9e32165a5c9c4c1cc1143da0bf25a"
relations: []
claims: []
---

## 功能名

`plugin/client/client.js` 是**手写**单文件（不是编译产物），11,695 行 / 821 KB，六组并行改同一文件会互相覆盖。

## 生效条件

任何多人/多 agent 同时改面板的协作场景。

## 子功能

- Lead 预置**按屏锚点**：CSS 数组末尾 `/* [G1 detail] */`…、zh/en 字典同序锚点、`teamsPage` 的 `teamTab` 分支。
- 每组只在自己锚点后**字面追加**，不碰别人的区段。
- 遇 `FS_STALE_VERSION` 重读重放；**禁整文件 write / 禁 prettier / 禁改行尾**。

## 执行

用 `edit` 定点改，不用 `write`；改完 `node --check plugin/client/client.js`。

## 验证方式

`node --check` exit 0；`git diff --numstat` 增删行数与改动量同阶；`npm test` 全绿。

## 不适用条件

不适用于 `plugin/src/**` 下的小文件（单个模块几十到几百行，可以整文件写）。
