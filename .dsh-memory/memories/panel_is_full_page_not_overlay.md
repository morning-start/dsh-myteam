---
id: "panel_is_full_page_not_overlay"
title: "面板是 main 插槽里的完整页面，不是浮层也不是 iframe"
kind: "decision"
about: "面板形态的三个理由，以及三通道编码（文字/图标/形状）的判据（CHG-192 重锚）"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:48:18Z"
modifiedAt: "2026-11-13T18:59:26Z"
lastVerifiedAt: "2026-11-13T18:59:26Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["面板", "信息架构", "main 插槽", "H4", "H6", "三通道", "阅读列"]
supersedes: ["panel_is_full_page_not_overlay"]
evidence:
  - kind: "file"
    ref: "design/design-notes.md"
    hash: "7c8f6c98a6778659a91e0559af3a3986323b1546d40fa28bea16ce984ff8dbb5"
  - kind: "file"
    ref: "plugin/src/panel.ts"
    hash: "9fced34a99d53e17b33f067808bf88cfbfaee0d771ecfc3d56884dfca8a81ac6"
  - kind: "file"
    ref: "plugin/client/client.js"
    hash: "410add046bd3ce3ed628a9af29cac688b5ac3bc0a7bcd1de3d39c420434bfce7"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-192"
    state: "unverified"
    evidence: "（底部 dock 是另一个插槽，形态按 dock 约束）。 <!-- CHG-192：重锚（2026-11-14）。CHG-182c 推翻了旧的「空态例外（1080px 宽列）」—— 空态现在继承同一阅读列；四种列宽反复横跳的教训：只有反向锁挡得住第五次。 -->"
---

## 功能名

面板挂在 `main` 插槽，是**完整页面**，横向三段式：顶部团队信息条 → 中间功能域 tab → 底部成本栏；看板类视图在中间区再切三视图（看板 / 流程 / 依赖图）。

## 生效条件

任何面板布局或信息架构决策。

## 子功能

- **宽屏礼让（H6）**：`main` 是宿主最大一块地，占满才能一次看清任务 + 队员 + 成本；overlay 会遮住会话。
- **一屏一焦点**：看板只回答「现在到哪一步、谁在干什么、哪里卡住」；任务细节进独立详情页，不在看板上开侧抽屉。
- **状态不靠颜色（H4）**：文字 + 图标 + 形状三通道同时编码。
- **阅读列口径（唯一）**：面板内正文一律 `padding-inline:max(28px, calc((100% - 1400px)/2))`。**空态与有任务态必须同宽**（CHG-182c：用户「有任务和无任务两种状态为什么宽度不一样？在用户看来这就是一个窗口」）——空态**不许**设 `max-width` / `margin-inline` 覆盖，只允许改文字对齐与标题行布局。

## 执行

新增视图先问「它属于哪个 tab 的哪个视图」，不要新开浮层；详情进 `detail` 页。

## 验证方式

`design/design-notes.md` 与 `plugin/client/client.js` 的 slot 注册一致；CDP 实测 `overflowX=0`；`t101 ④` 反向锁（空态出现任何列宽覆盖即红）；全量 `cd plugin && npm test` **942 条**绿。

## 不适用条件

不适用于 `DockChip`（底部 dock 是另一个插槽，形态按 dock 约束）。

<!-- CHG-192：重锚（2026-11-14）。CHG-182c 推翻了旧的「空态例外（1080px 宽列）」——
     空态现在继承同一阅读列；四种列宽反复横跳的教训：只有反向锁挡得住第五次。 -->
