---
id: "gate_tests_must_use_real_entry"
title: "门禁与调度测试必须走真实入口，禁止 host.commit 桩"
kind: "convention"
about: "为什么 359 条全绿单测没抓到门禁链死锁，以及测试替身的正确边界"
confidence: "inferred"
provenance: "file-derived"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-07T10:47:30Z"
modifiedAt: "2026-11-07T10:47:30Z"
lastVerifiedAt: "2026-11-07T10:47:30Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["测试替身", "host.commit", "executeLeadTool", "门禁测试", "死锁"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/test/t71-m2-remaining.test.ts"
    hash: "2276ea61b8e0622aae27ac473cb35f31de8a963c3535a413f40294cc6fd6370b"
  - kind: "file"
    ref: "plugin/src/tools/defs.ts"
    hash: "e7063275db04f0752e6796d63b071416d4e2c72ba69b7503dd65dd8980578e40"
relations: []
claims: []
---

## 功能名

门禁/调度类用例**只用真实入口**：`executeLeadTool` / `executeMemberTool` / 面板 Remote。

## 生效条件

写或改任何门禁、状态机、调度相关测试时。

## 子功能

- 反例：`t17:222`、`t45:105` 用 `host.commit()` 直接写 `task.gate.result`，把「真实用户路径」整个盖住。
- 后果：359 个全绿单测没抓到门禁链死锁 —— 桩让「不可能发生的状态」看起来合法。
- 纯函数（fold / graph / views）可以直测，因为它们没有替身。

## 执行

新测试先问：这个入口用户真的会走吗？会 → 必须用真实工具；不会 → 才是纯函数直测。

## 验证方式

`cd plugin && npm test` 522 条；门禁相关用例可 grep `executeLeadTool(` 确认走真实入口。

## 不适用条件

不适用于纯函数层（`core/tasks/graph.ts`、`remote/views.ts`、`core/scheduler/fold.ts`）—— 它们没有宿主依赖。
