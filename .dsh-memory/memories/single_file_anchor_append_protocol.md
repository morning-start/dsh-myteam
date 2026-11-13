---
id: "single_file_anchor_append_protocol"
title: "多路并行改 client.js 只能按锚点字面追加，禁整文件写"
kind: "convention"
about: "client.js 是手写单文件（现 13,851 行），多路并行修改时的协作协议（CHG-183 重锚）"
confidence: "verified"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-07T10:47:56Z"
modifiedAt: "2026-11-13T14:09:52Z"
lastVerifiedAt: "2026-11-13T14:09:52Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["client.js", "并行", "锚点", "FS_STALE_VERSION", "prettier", "单文件"]
supersedes: ["single_file_anchor_append_protocol"]
evidence:
  - kind: "file"
    ref: "plugin/client/client.js"
    hash: "a644ddd1b24fabcbf7fb2d81560ab9186abc53fb8800fb2ae769aed3d950648d"
  - kind: "test"
    ref: "plugin/test/t138-client-hook-order.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-168"
    state: "unverified"
    evidence: "KB**（CHG-183 之前的记录是 11,695 行 / 821 KB，随 CHG-168~182 持续增长）。六组并行改同一文件会互相覆盖。 ## 生效条件 任何多人/多 agent 同时改面板的协作场景。 ## 子功能 - Lead 预置**按屏锚点**：CSS 数组末"
  - kind: "ticket"
    ref: "CHG-183"
    state: "unverified"
    evidence: "是**手写**单文件（不是编译产物）。CHG-183 时实测 **13,851 行 / 约 937 KB**（CHG-183 之前的记录是 11,695 行 / 821 KB，随 CHG-168~182 持续增长）。六组并行改同一文件会互相覆盖"
---

## 功能名

`plugin/client/client.js` 是**手写**单文件（不是编译产物）。CHG-183 时实测 **13,851 行 / 约 937 KB**（CHG-183 之前的记录是 11,695 行 / 821 KB，随 CHG-168~182 持续增长）。六组并行改同一文件会互相覆盖。

## 生效条件

任何多人/多 agent 同时改面板的协作场景。

## 子功能

- Lead 预置**按屏锚点**：CSS 数组末尾 `/* [G1 detail] */`…、zh/en 字典同序锚点、`teamsPage` 的 `teamTab` 分支。
- 每组只在自己锚点后**字面追加**，不碰别人的区段。
- 遇 `FS_STALE_VERSION` 重读重放；**禁整文件 write / 禁 prettier / 禁改行尾**（仓库要求纯 LF，CRLF 0 处）。
- **静态门禁**：`t138` 会扫全文件的 hook 顺序（早退后不得再调 hook），`t13c` / `t83` 扫表面根与深色规则——改这个文件前先知道有这几条红线。

## 执行

用 `edit` 定点改，不用 `write`；改完 `node --check plugin/client/client.js`，再 `cd plugin && npm run bundle` 刷新 `plugin/lib/build-manifest.json` 的 clientHash（`t42` 会校验）。

## 验证方式

`node --check` exit 0；`git diff --numstat` 增删行数与改动量同阶；`cd plugin && npm test` 917 条全绿；`node tools/check-drift.mjs` MISMATCH: 0。

## 不适用条件

不适用于 `plugin/src/**` 下的小文件（单个模块几十到几百行，可以整文件写）。

<!-- CHG-183（2026-11-13）：client.js 在本轮 UI 修复中多次改动（hook 顺序、泳道、依赖图、
     空态列宽），锚点切片漂移；行数/体积按实测刷新。 -->
