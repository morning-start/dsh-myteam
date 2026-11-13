---
id: "gate_tests_must_use_real_entry"
title: "门禁与调度测试必须走真实入口，禁止 host.commit 桩"
kind: "convention"
about: "为什么全绿单测没抓到门禁链死锁，以及测试替身的正确边界（CHG-192 重锚）"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-07T10:47:30Z"
modifiedAt: "2026-11-13T18:58:06Z"
lastVerifiedAt: "2026-11-13T18:58:06Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["测试替身", "host.commit", "executeLeadTool", "门禁测试", "死锁"]
supersedes: ["gate_tests_must_use_real_entry"]
evidence:
  - kind: "file"
    ref: "plugin/test/t71-m2-remaining.test.ts"
    hash: "6104ea8a2e13c462d77196564e8fec107d08b7f987d7dc05d36a90bcbfbb52bb"
  - kind: "file"
    ref: "plugin/src/tools/defs.ts"
    hash: "c58ed1fbbf451236eefab2474eaed85c32f349f43d86cee2c94de2be427dbabd"
  - kind: "file"
    ref: "plugin/src/core/gates/gate-execution.ts"
    hash: "4fa75a2469aa9e1a446960bb7add4315d4b116095b35d3c6f8697cfb44607407"
relations: []
claims:
  - kind: "ticket"
    ref: "CHG-186"
    state: "unverified"
    evidence: "fold / graph / views）可以直测，因为它们没有替身。 - **CHG-186/190 之后**：门禁执行的实现已下沉到 ，但**测试仍必须走 **——下沉的是实现位置，不是入"
  - kind: "ticket"
    ref: "CHG-192"
    state: "unverified"
    evidence: "）—— 它们没有宿主依赖。 <!-- CHG-192：重锚（2026-11-14）。CHG-186/190 三轮重构（端点族搬家 / 门禁执行下沉）后 锚点切片再次漂移，结论未变；测试计数 917 → 942，补「下沉的是实现位置不是"
---

## 功能名

门禁/调度类用例**只用真实入口**：`executeLeadTool` / `executeMemberTool` / 面板 Remote。

## 生效条件

写或改任何门禁、状态机、调度相关测试时。

## 子功能

- 反例：`t17:222`、`t45:105` 用 `host.commit()` 直接写 `task.gate.result`，把「真实用户路径」整个盖住。
- 后果：早年的 359 条全绿单测没抓到门禁链死锁 —— 桩让「不可能发生的状态」看起来合法。
- 纯函数（fold / graph / views）可以直测，因为它们没有替身。
- **CHG-186/190 之后**：门禁执行的实现已下沉到 `core/gates/gate-execution.ts`，但**测试仍必须走 `executeLeadTool`**——下沉的是实现位置，不是入口语义。

## 执行

新测试先问：这个入口用户真的会走吗？会 → 必须用真实工具；不会 → 才是纯函数直测。

## 验证方式

`cd plugin && npm test` **942 条**；门禁相关用例可 grep `executeLeadTool(` 确认走真实入口。

## 不适用条件

不适用于纯函数层（`core/tasks/graph.ts`、`core/index/views.ts`、`core/scheduler/fold.ts`）—— 它们没有宿主依赖。

<!-- CHG-192：重锚（2026-11-14）。CHG-186/190 三轮重构（端点族搬家 / 门禁执行下沉）后
     锚点切片再次漂移，结论未变；测试计数 917 → 942，补「下沉的是实现位置不是入口语义」。 -->
