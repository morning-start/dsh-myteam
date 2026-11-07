---
id: "powershell_encoding_traps"
title: "PowerShell 的引号、重定向与 HTTP 响应会把中文改坏"
kind: "pitfall"
about: "在这个仓库用 pwsh 改中文文件/读 HTTP 时必踩的三个编码坑"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:49Z"
modifiedAt: "2026-11-07T10:47:49Z"
lastVerifiedAt: "2026-11-07T10:47:49Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["PowerShell", "pwsh", "编码", "UTF-16", "乱码", "Invoke-WebRequest"]
supersedes: []
evidence:
  - kind: "file"
    ref: ".debug/chg87-conventions.md"
    hash: "7d612da0000fb529d48b60a30fb8acb20191e33a5657c10a120f3d8c9915b8b0"
relations: []
claims:
  - kind: "ticket"
    ref: "UTF-16"
    state: "unverified"
    evidence: "ll 在三条路径上会破坏非 ASCII：双引号字符串吃掉反引号与转义、重定向写 UTF-16、 的 把 UTF-8 解成 Latin-1。 ## 生效条件 批量改文档、读日志、调本地 HTTP API 时。 ## 子功"
  - kind: "ticket"
    ref: "UTF-8"
    state: "unverified"
    evidence: "F-16、 的 把 UTF-8 解成 Latin-1。 ## 生效条件 批量改文档、读日志、调本地 HTTP API 时。 ## 子功能 - 双引号绞杀： 双引号里的模板串/引号反复被改坏 → **批量"
---

## 功能名

PowerShell 在三条路径上会破坏非 ASCII：双引号字符串吃掉反引号与转义、重定向写 UTF-16、`Invoke-WebRequest` 的 `.Content` 把 UTF-8 解成 Latin-1。

## 生效条件

批量改文档、读日志、调本地 HTTP API 时。

## 子功能

- 双引号绞杀：`pwsh` 双引号里的模板串/引号反复被改坏 → **批量改文档一律写 `.tmp/*.mjs` 脚本**（UTF-8 no BOM）。
- 重定向是 UTF-16：`*>` / `Start-Process -Redirect*` 写出来必须 `[Text.Encoding]::Unicode.GetString(bytes)` 读，且宿主占用文件时要 `FileShare.ReadWrite`。
- HTTP 响应乱码：用 `[System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())`；请求体 `UTF8Encoding($false).GetBytes(json)`。

## 执行

每个脚本写后校验 U+FFFD：`Select-String -Pattern "\uFFFD"`。

## 验证方式

改写后抽查文件头几行中文是否正常；`Select-String -Pattern "\uFFFD"` 应零命中。

## 不适用条件

不适用于纯 ASCII 输出（如 `git status`、测试计数）。
