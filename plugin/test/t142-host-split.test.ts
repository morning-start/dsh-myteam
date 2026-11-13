/**
 * T142 · 入口层拆薄（CHG-186）
 *  ① 解 type 环：`remote/service.ts` 不得再从 `host.ts` 取类型
 *  ② 行数棘轮：`host.ts` 只减不增（拆完一档就把上限压下来）
 *
 * ── 行数口径（别用错工具）──────────────────────────────────────────────────────
 * `split('\n').length`，与 `tools/arch-report.mjs` 的 `loc` 完全一致，也就是计划 §4
 * 里写的「`host.ts` 6,210 行」。**不要**用 `(Get-Content src/host.ts | Measure-Object -Line).Lines`：
 * 本仓源码是 UTF-8 无 BOM + 大量中文注释，Windows 下 `Get-Content` 会按错误编码解码，
 * 实测少报约 900 行（同一时刻报 5,319，而真实是 6,209 行 / 6,210 个 split 元素）。
 * 拿它当基线会让棘轮凭空多出一截余量，等于没钉。
 *
 * ── 基线策略 ────────────────────────────────────────────────────────────────────
 * 本任务（T155a）**只解环、不搬实现**（纯类型搬家，行为零变化）。契约下沉本身已把
 * `host.ts` 从 6,210 行减到 **6,163 行**（`MyTeamConfig` 48 行 + `KnowledgeView` 4 行
 * 换成 1 行 import，净 -47），棘轮直接钉在**拆完的实测值**上——不留余量：入口层再加一行
 * 注释都该红。T155b 每搬完一族（members → tasks → plan → roles → teams → audit）就把
 * `HOST_LINES_LIMIT` 往下压一档，**保证只减不增**，最终 4,000 行。
 * 同一常量在 `tools/check-architecture.mjs` 的 `A6_LIMIT` 里（两处必须一起改）。
 *
 * T155b 进度：成员族（`src/host/members.ts`）搬完 → 6,160；任务族（`src/host/tasks.ts`）
 * 搬完 → **5,961**（本次压到 5,961，净减 202 行）。
 * T155c 进度：计划族（`src/host/plan.ts`）搬完 → **5,715**（本次压到 5,715，净减 246 行）；
 * 角色族（`src/host/roles.ts`）搬完 → **5,710**（本次压到 5,710，再净减 5 行）；
 * 团队族（`src/host/teams.ts`）搬完 → **5,682**（本次压到 5,682，再净减 28 行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, '..', p), 'utf8')

/** 入口层行数棘轮基线（CHG-186 拆完实测；只减不增） */
const HOST_LINES_LIMIT = 5682

test('t142-1: 契约独立成文件，remote/service.ts 不再 import host.ts', () => {
  const service = read('src/remote/service.ts')
  assert.ok(!/from ['"]\.\.\/host\.ts['"]/.test(service), 'remote/service.ts 仍从 host.ts 取类型（type 环未解）')
  assert.ok(/from ['"]\.\.\/core\/host\/contract\.ts['"]/.test(service), 'remote/service.ts 应从 core/host/contract.ts 取契约')
})

test('t142-2: host.ts 行数棘轮（只减不增）', () => {
  const lines = read('src/host.ts').split('\n').length
  assert.ok(
    lines <= HOST_LINES_LIMIT,
    `host.ts 已 ${lines} 行，超出棘轮上限 ${HOST_LINES_LIMIT}——新代码请落到 src/host/*.ts`,
  )
})
