---
id: "line_ending_lf_crlf_split"
title: "client.js 与多数 md 用 LF，docs/09 与 docs/14 用 CRLF，绝不混"
kind: "convention"
about: "仓库的行尾约定，以及为什么行尾混用会造出整文件 diff"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-07T10:47:43Z"
modifiedAt: "2026-11-07T10:47:43Z"
lastVerifiedAt: "2026-11-07T10:47:43Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["行尾", "LF", "CRLF", "编码", "Set-Content", "GBK"]
supersedes: []
evidence:
  - kind: "file"
    ref: ".gitattributes"
    hash: "7e2c9c5217e6a7d39693a7ec3347ecc4e909979b30dfa0bb94ddca021daecec2"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-96"
    state: "unverified"
    evidence: "/ 批量改 UTF-8 文件会把行尾和编码一起改坏（CHG-96 实弹：835KB 的 被写成 GBK）。 - 正确做法：写 脚本用 Node 的"
  - kind: "ticket"
    ref: "UTF-8"
    state: "unverified"
    evidence: "werShell 的 / 批量改 UTF-8 文件会把行尾和编码一起改坏（CHG-96 实弹：835KB 的 被写成 GBK）。 - 正确做法：写 脚本用 Node 的"
---

## 功能名

`plugin/client/client.js` 与绝大多数 md 是 **LF**；`docs/09-变更记录.md`、`docs/14-UI复检清单.md` 是 **CRLF**。

## 生效条件

任何写文件、批量替换、或生成 CHG 行的操作之前。

## 子功能

- 用 PowerShell 的 `Set-Content`/`Out-File` 批量改 UTF-8 文件会把行尾和编码一起改坏（CHG-96 实弹：835KB 的 `client.js` 被写成 GBK）。
- 正确做法：写 `.tmp/*.mjs` 脚本用 Node 的 `readFileSync/writeFileSync(..., 'utf8')`，保留原 `eol`。
- `.gitattributes` 已声明行尾策略，但仍要人工核对。

## 执行

改完 `git diff --stat` 看是否出现「整文件重写」；用 `node .debug/chg89-lf-check.mjs` 之类脚本核对。

## 验证方式

`git diff --numstat` 的增删行数应与实际改动量同阶；整文件重写 = 行尾被换。

## 不适用条件

不适用于二进制/图片（`design/*.png`、`.debug/*.png`）。
