---
id: "only_dsw_alias_tokens_no_hex"
title: "样式只用 --dsw-alias-* 语义 token，零十六进制色零 font-family"
kind: "convention"
about: "面板样式纪律，以及为什么设计稿变量要包一层 var(--dsw-alias-*, fallback)"
confidence: "verified"
provenance: "file-derived"
status: "active"
actionRisk: "R3"
createdAt: "2026-11-07T10:48:03Z"
modifiedAt: "2026-11-07T10:48:03Z"
lastVerifiedAt: "2026-11-07T10:48:03Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["样式", "token", "dsw-alias", "hex", "font-family", "深色模式"]
supersedes: []
evidence:
  - kind: "file"
    ref: "design/tokens.css"
    hash: "b742a4e59d4b6e4f1cbe1e12b875e51ff296c900b49862fc56ea82808bc25fa8"
  - kind: "test"
    ref: "plugin/test/t13c-client.test.ts"
relations: []
claims: []
---

## 功能名

面板 CSS 只消费宿主 `--dsw-alias-*` 语义 token；仓库内**零**十六进制色值、**零** `font-family` 声明。

## 生效条件

新增或修改任何样式、以及设计稿 token 时。

## 子功能

- 局部自定义属性**必须带 fallback**：`var(--dsw-alias-xxx, 兜底值)` —— 独立打开设计稿时走 fallback，嵌进宿主时自动跟随。
- 深色模式读宿主**解析后的**信号（`body[data-ds-dark-theme]` + `MutationObserver`），不靠 `prefers-color-scheme` 猜。
- 动效必须给 `prefers-reduced-motion` 兜底；reduced-motion 下不是简单 `animation:none`，而是换静态 `outline` 保住语义通道。

## 执行

改完跑 `plugin/test/t13c-client.test.ts`（断言无 hex / 无 font-family / 必用 `--dsw-alias-*`）。

## 验证方式

`t13c-client.test.ts` 绿；`design/tokens.css` 的 `var(--dsw-alias-` 计数 ≥15（当前 33）。

## 不适用条件

不适用于成员四色（`--m1-bg` ~ `--m4-ink`）—— 宿主无对应物，保留字面值。
