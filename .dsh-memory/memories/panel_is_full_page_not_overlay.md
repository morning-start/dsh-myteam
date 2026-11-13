---
id: "panel_is_full_page_not_overlay"
title: "面板是 main 插槽里的完整页面，不是浮层也不是 iframe"
kind: "decision"
about: "面板形态的三个理由，以及三通道编码（文字/图标/形状）的判据（CHG-183 重锚）"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:48:18Z"
modifiedAt: "2026-11-13T14:09:19Z"
lastVerifiedAt: "2026-11-13T14:09:19Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["面板", "信息架构", "main 插槽", "H4", "H6", "三通道"]
supersedes: ["panel_is_full_page_not_overlay"]
evidence:
  - kind: "file"
    ref: "design/design-notes.md"
    hash: "7c8f6c98a6778659a91e0559af3a3986323b1546d40fa28bea16ce984ff8dbb5"
  - kind: "file"
    ref: "plugin/src/panel.ts"
    hash: "8d7ee1ecbd395011e730e86fe37450fbddeb5fca137a07aea23e3113fca6d8ad"
  - kind: "file"
    ref: "plugin/client/client.js"
    hash: "a644ddd1b24fabcbf7fb2d81560ab9186abc53fb8800fb2ae769aed3d950648d"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-167"
    state: "unverified"
    evidence: "居中（CHG-167/180~182）；**空态例外**——面板铺满、内容左对齐 1080px 宽列（CHG-182）。 ## 执行 新增视图先问「它属于哪个 tab 的哪个视图」，不要新开浮层；详情进"
  - kind: "ticket"
    ref: "CHG-174"
    state: "unverified"
    evidence: "026-11-13）：panel.ts / design-notes.md 在 CHG-174~182 期间多次改动， 锚点切片漂移；结论未变，补「阅读列 vs 空态」两种列宽口径。 -->"
  - kind: "ticket"
    ref: "CHG-182"
    state: "unverified"
    evidence: "180~182）；**空态例外**——面板铺满、内容左对齐 1080px 宽列（CHG-182）。 ## 执行 新增视图先问「它属于哪个 tab 的哪个视图」，不要新开浮层；详情进 页。 ## 验证方式 与"
  - kind: "ticket"
    ref: "CHG-183"
    state: "unverified"
    evidence: "（底部 dock 是另一个插槽，形态按 dock 约束）。 <!-- CHG-183（2026-11-13）：panel.ts / design-notes.md 在 CHG-174~182 期间多次改动， 锚点切片漂移；结论未变，补「阅读列 vs 空态」两种列宽口"
---

## 功能名

面板挂在 `main` 插槽，是**完整页面**，横向三段式：顶部团队信息条 → 中间功能域 tab → 底部成本栏；看板类视图在中间区再切三视图（看板 / 流程 / 依赖图）。

## 生效条件

任何面板布局或信息架构决策。

## 子功能

- **宽屏礼让（H6）**：`main` 是宿主最大一块地，占满才能一次看清任务 + 队员 + 成本；overlay 会遮住会话。
- **一屏一焦点**：看板只回答「现在到哪一步、谁在干什么、哪里卡住」；任务细节进独立详情页，不在看板上开侧抽屉。
- **状态不靠颜色（H4）**：文字 + 图标 + 形状三通道同时编码。
- **阅读列口径**：面板内正文用 `padding-inline:max(28px, calc((100% - 1400px)/2))` 居中（CHG-167/180~182）；**空态例外**——面板铺满、内容左对齐 1080px 宽列（CHG-182）。

## 执行

新增视图先问「它属于哪个 tab 的哪个视图」，不要新开浮层；详情进 `detail` 页。

## 验证方式

`design/design-notes.md` 与 `plugin/client/client.js` 的 slot 注册一致；CDP 实测 `overflowX=0`；全量 `cd plugin && npm test` 917 条绿。

## 不适用条件

不适用于 `DockChip`（底部 dock 是另一个插槽，形态按 dock 约束）。

<!-- CHG-183（2026-11-13）：panel.ts / design-notes.md 在 CHG-174~182 期间多次改动，
     锚点切片漂移；结论未变，补「阅读列 vs 空态」两种列宽口径。 -->
