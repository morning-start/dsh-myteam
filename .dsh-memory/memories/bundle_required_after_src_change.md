---
id: "bundle_required_after_src_change"
title: "改 src 或 client.js 不重跑 bundle，t42 指纹门禁立刻红"
kind: "convention"
about: "构建产物的指纹门禁语义，以及为什么 client.js 单独计一个 hash"
confidence: "verified"
provenance: "file-derived"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-07T10:47:36Z"
modifiedAt: "2026-11-07T10:47:36Z"
lastVerifiedAt: "2026-11-07T10:47:36Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["bundle", "build-lib", "sourceHash", "clientHash", "t42", "指纹"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/scripts/build-lib.mjs"
    hash: "47d246f562d2f5012f06120bd1e51c2f3b5b8b7d302f454ae039d4c37ea4b069"
  - kind: "test"
    ref: "plugin/test/t42-lib-manifest.test.ts"
relations: []
claims: []
---

## 功能名

`plugin/scripts/build-lib.mjs` 把 `plugin/src/**/*.ts` 用 `stripTypeScriptTypes` 字节剥离成 `plugin/lib/**/*.mjs`，并写 `lib/build-manifest.json` 记两个指纹。

## 生效条件

任何改动 `plugin/src/` 或 `plugin/client/client.js` 之后。

## 子功能

- `sourceHash` = src 全量 sha256（路径\0内容 顺序哈希）；`clientHash` = `client.js` 指纹。
- **两者语义不同，必须分开**：混在一起会让「lib 是否需重建」的判定失真。
- `client.js` **不在** src→lib 构建里（浏览器直载），但**在**指纹门禁里。

## 执行

`cd plugin && npm run bundle -- --force`；构建走「暂存 → `node --check` 语法校验 → 确认 → 原子 rename」，失败时 `lib/` 原样不动。

## 验证方式

`plugin/test/t42-lib-manifest.test.ts` 4 条复算指纹；`node tools/check-drift.mjs` 应输出 `MISMATCH: 0`。

## 不适用条件

不适用于只改 `docs/`、`design/`、`plugin/test/` 的提交（不进产物）。
