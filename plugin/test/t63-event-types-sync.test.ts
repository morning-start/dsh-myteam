/**
 * t63：事件类型的两张表必须完全一致。
 *
 * 为什么要这条：`EventType` 是**类型**联合，`EVENT_TYPES` 是**运行时**数组，两者手工维护。
 * 只改一边的后果不是编译错，而是：
 *   - 只改联合 → 扫描器不认识这个类型 → 把它当**日志损坏**（`PROJECT_WRITE_BLOCKED`），
 *     整个项目停止写入，而且报错完全指不到根因；
 *   - 只改数组 → 类型上不认识，写不进去（这个反而好查）。
 *
 * 真实踩过：加 `team.plan.*` 时只改了联合，第一次 commit 写进去、第二次 commit 重扫就判损坏。
 * 所以这里从源码解析出两张表逐项比对，缺一个就红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_TYPES } from '../src/contracts/events.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 从 events.ts 里把 `export type EventType = ...` 的字符串字面量抓出来。 */
function unionTypes(): string[] {
  const source = readFileSync(join(ROOT, 'contracts', 'events.ts'), 'utf8')
  const start = source.indexOf('export type EventType =')
  assert.ok(start >= 0, '找不到 EventType 联合')
  // 联合到下一个顶层 `\n\n` 或 `export` 为止。
  const rest = source.slice(start)
  const end = rest.search(/\n\n(?:export|\/\*\*)/)
  const block = end < 0 ? rest : rest.slice(0, end)
  // 注意：事件类型里有连字符（effect.outcome-unknown），正则必须带上 `-`，
  // 否则会漏抓一项、误报「在数组里但不在联合里」。
  return [...block.matchAll(/'([a-z][a-z0-9.-]*)'/g)].map((match) => match[1]!)
}

test('EventType 联合与 EVENT_TYPES 数组完全一致（缺一个就是日志损坏级事故）', () => {
  const union = new Set(unionTypes())
  const runtime = new Set<string>(EVENT_TYPES)

  const onlyInUnion = [...union].filter((type) => !runtime.has(type)).sort()
  const onlyInRuntime = [...runtime].filter((type) => !union.has(type)).sort()

  assert.deepEqual(
    onlyInUnion,
    [],
    `这些类型在 EventType 里但不在 EVENT_TYPES 里 —— 扫描器会把它当日志损坏：${onlyInUnion.join(', ')}`,
  )
  assert.deepEqual(onlyInRuntime, [], `这些类型在 EVENT_TYPES 里但不在 EventType 里：${onlyInRuntime.join(', ')}`)
  assert.ok(union.size > 50, `解析出的类型数量异常（${String(union.size)}），可能正则没抓到`)
})

test('team.plan.* 三个事件都在运行时清单里（防止再漏一次）', () => {
  for (const type of ['team.plan.proposed', 'team.plan.approved', 'team.plan.discarded']) {
    assert.ok((EVENT_TYPES as readonly string[]).includes(type), `${type} 必须进 EVENT_TYPES`)
  }
})
