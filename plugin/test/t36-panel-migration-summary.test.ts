/**
 * t36：面板迁移摘要（适配层）。
 *
 * 断言点只有一个：**空目录也必须给出一份可读结论，而不是抛错**。
 * 面板的「迁移」页在没有 v1 旧数据的项目里也要能打开——返回 blocked/ready
 * 加一份报告正文，比一个 INTERNAL 有用得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrationSummaryFor } from '../src/infrastructure/migration/v1/panel-summary.ts'

test('面板迁移摘要：空目录也给出结论与可读报告，不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-mig-'))
  try {
    const summary = migrationSummaryFor(dir)
    assert.ok(summary.verdict === 'ready' || summary.verdict === 'blocked', `未知 verdict：${String(summary.verdict)}`)
    assert.equal(typeof summary.headline, 'string')
    assert.ok(summary.headline.length > 0, 'headline 不能为空')
    assert.match(summary.markdown, /结论/, '报告正文要带结论段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})