---
id: "verify_gate_runs_real_command"
title: "verify 门必须真跑命令取退出码，绝不采信模型自述「测试通过」"
kind: "decision"
about: "为什么 gate:verify 不能退化成人工裁决，以及宿主缺服务时必须报错而不是静默放行"
confidence: "verified"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:05Z"
modifiedAt: "2026-11-07T10:47:05Z"
lastVerifiedAt: "2026-11-07T10:47:05Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["verify", "门禁", "gate", "退出码", "exitCode", "MT_VERIFY_NO_COMMAND"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/src/core/gates/command-gate.ts"
    hash: "94e42d6907b4573f052b4602586ddc49347631b128ef1a15427a9a2e8eaff594"
  - kind: "test"
    ref: "plugin/test/t71-m2-remaining.test.ts"
relations: []
claims: []
---

## 功能名

`gate:verify` 由 host 经 `ctx.subprocess` 真跑任务声明的 `verifyCommand`，用真实 `exitCode` 定 verdict。

## 生效条件

任务进入 `gate:verify`、或新增任何「完成判据」类门禁时。

## 子功能

- `argv` 数组直传，**无 shell 解释**（防注入）。
- 落账 payload 记 `command{argv,cwd?}` / `exitCode` / `signal` / `durationMs` / `outputTail`（尾 2000 字符，截断时前置 `…[truncated N chars]…`）/ `executedBy:'host'`。
- 唯一不跑命令的出口：`actor='human'` 且 `confirm=true` 且 `reason` 非空，payload 标 `forcedBy:'human'`。

## 执行

宿主无 `subprocess` 服务 → `MT_UNAVAILABLE`；任务没声明命令 → `MT_VERIFY_NO_COMMAND`。**两者都不许静默降级成人工点通过**。

## 验证方式

`plugin/test/t71-m2-remaining.test.ts` 走真实入口；端点级 e2e `node .debug/chg87-e2e-endpoint.mjs`。

## 不适用条件

不适用于 `gate:review`（人工裁决）与 `gate:archive`（宿主落位校验）—— 那两道的裁决人不同。
