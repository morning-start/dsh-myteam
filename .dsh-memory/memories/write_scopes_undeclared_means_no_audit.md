---
id: "write_scopes_undeclared_means_no_audit"
title: "writeScopes 未声明等于不审计，不是「全部越界」"
kind: "pitfall"
about: "scope 越界审计的默认语义方向，以及为什么越界只留痕不阻断交付"
confidence: "verified"
provenance: "file-derived"
status: "active"
actionRisk: "R1"
createdAt: "2026-11-07T10:47:11Z"
modifiedAt: "2026-11-07T10:47:11Z"
lastVerifiedAt: "2026-11-07T10:47:11Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:dsh-myteam"]
triggers: ["writeScopes", "scope", "越界", "scopeAudit", "审计"]
supersedes: []
evidence:
  - kind: "file"
    ref: "plugin/src/core/gates/scope-audit.ts"
    hash: "30361dbd335e41ac40bd6f8ffbf7fa8cbc6a9bdaa4cf5773339610bc5f0e018e"
  - kind: "test"
    ref: "plugin/test/t71-m2-remaining.test.ts"
relations: []
claims:
  - kind: "ticket"
    ref: "FR-5"
    state: "unverified"
    evidence: "就集体报越界 —— 误报会让人关掉整条审计。 - 越界**只留痕不阻断交付**（FR-5.4「诚实声明不拦截 bash；阻断只会 incentive 少报」）。 - 只算**当前 attempt** 的证据；历史 attempt 的 不算进这次交付。"
---

## 功能名

`scopeAudit` 只对**声明了 `writeScopes` 的任务**做越界判定；未声明 = 不审计。

## 生效条件

升级老任务、或新增任务类型时。

## 子功能

- 若把「未声明」当「全部越界」，所有老任务一升级就集体报越界 —— 误报会让人关掉整条审计。
- 越界**只留痕不阻断交付**（FR-5.4「诚实声明不拦截 bash；阻断只会 incentive 少报」）。
- 只算**当前 attempt** 的证据；历史 attempt 的 `filesTouched` 不算进这次交付。

## 执行

投影只存 seq → 必须 `events.find(e => e.seq === seq)` 取事件，不能用下标。

## 验证方式

`plugin/test/t71-m2-remaining.test.ts` 覆盖「未声明放行」「越界留痕」「历史 attempt 不计入」三型。

## 不适用条件

不适用于 `gate:archive` 的落位校验（那是按 `deliverableSpec` 约定路径判定，与 writeScopes 无关）。
