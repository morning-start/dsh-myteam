---
id: "panel_is_full_page_not_overlay"
title: "面板是 main 插槽里的完整页面，不是浮层也不是 iframe"
kind: "decision"
about: "面板形态的三个理由，以及三通道编码（文字/图标/形状）的判据"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:48:18Z"
modifiedAt: "2026-11-07T10:48:18Z"
lastVerifiedAt: "2026-11-07T10:48:18Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["面板", "信息架构", "main 插槽", "H4", "H6", "三通道"]
supersedes: []
evidence:
  - kind: "file"
    ref: "design/design-notes.md"
    hash: "b45615c6d7a8189678c445c0edd7e6a8e5cb80b403d11d30953187b0200e38b3"
  - kind: "file"
    ref: "plugin/src/panel.ts"
    hash: "3819e7cf1e2917b3da1c4d2b663752c434425acc87766ed047fe1f145b6b1704"
relations: []
claims: []
---

## 功能名

面板挂在 `main` 插槽，是**完整页面**，横向三段式：顶部团队信息条 → 中间功能域 tab → 底部成本栏；看板类视图在中间区再切三视图（看板 / 流程 / 依赖图）。

## 生效条件

任何面板布局或信息架构决策。

## 子功能

- **宽屏礼让（H6）**：`main` 是宿主最大一块地，占满才能一次看清任务 + 队员 + 成本；overlay 会遮住会话。
- **一屏一焦点**：看板只回答「现在到哪一步、谁在干什么、哪里卡住」；任务细节进独立详情页，不在看板上开侧抽屉。
- **状态不靠颜色（H4）**：文字 + 图标 + 形状三通道同时编码。

## 执行

新增视图先问「它属于哪个 tab 的哪个视图」，不要新开浮层；详情进 `detail` 页。

## 验证方式

`design/design-notes.md` 与 `plugin/client/client.js` 的 slot 注册一致；CDP 实测 `overflowX=0`。

## 不适用条件

不适用于 `DockChip`（底部 dock 是另一个插槽，形态按 dock 约束）。
