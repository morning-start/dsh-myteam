#!/usr/bin/env node
/**
 * 只读项目体检：读 manifest + 事件库，重建投影后打印团队/任务摘要。
 *
 * 用途：cutover 之后确认「运行时不靠会话也能打开这个项目」，以及排障时
 * 快速看清项目里到底有什么。只读：不拿写租约、不写任何文件。
 *
 *   node tools/myteam-inspect.mjs [--root <dir>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FileEventStore } from '../plugin/lib/infrastructure/event-store/file-store.mjs'
import { rebuildProjectState } from '../plugin/lib/application/projections/project-state.mjs'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd())
const base = join(root, '.dsh-myteam')

if (!existsSync(join(base, 'manifest.json'))) {
  console.error(`不是 v2 项目（缺少 ${join(base, 'manifest.json')}）：${root}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'))
const store = new FileEventStore(join(base, 'events', 'project.jsonl'))
const { events } = store.readCommitted()
const state = rebuildProjectState(manifest.projectId, events)

const STATUS = ['planned', 'ready', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'cancelled']

console.log(`项目：${manifest.name ?? '(未命名)'}（${manifest.projectId}）`)
console.log(`根目录：${root}`)
console.log(`schemaVersion=${manifest.schemaVersion} layoutVersion=${manifest.layoutVersion} seq=${state.seq} events=${events.length}`)
console.log(`团队 ${state.teams.size} · 角色 ${state.roles.size} · 成员 ${state.members.size} · 任务 ${state.tasks.size}`)

for (const team of state.teams.values()) {
  const captain = state.captains.get(team.id)
  console.log(`\n- 团队 ${team.name}（${team.id}）状态=${team.status} 队长=${captain?.sessionId ?? '未指派'}`)
  const tasks = [...state.tasks.values()].filter((task) => task.ownerTeamId === team.id)
  for (const status of STATUS) {
    const bucket = tasks.filter((task) => task.status === status)
    if (bucket.length === 0) continue
    console.log(`  ${status}(${bucket.length})：${bucket.map((task) => task.title).join(' / ')}`)
  }
}