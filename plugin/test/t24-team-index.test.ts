/**
 * T24（CHG-45）：团队索引测试 —— **项目级** teams.json。
 *
 * 覆盖：
 *  - entryFromProjection：投影 → 摘要（目标/状态/成员/计数）
 *  - scanWorkspaceIndex：从账本全量重建（坏行容错、空目录）
 *  - 原子写 + 读回 + upsert（createdAt 沿用旧值、排序）
 *
 * CHG-201（用户定案「全局和项目级分开」）：跨工作区索引 `workspaces.json` 已删除
 * （全局层不记录「都有哪些项目」），原 t24-4 用例随之移除。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  entryFromProjection,
  scanWorkspaceIndex,
  workspaceIndexPath,
  readWorkspaceIndex,
  upsertTeamEntry,
} from '../src/core/index/team-index.ts'
import { emptyProjection } from '../src/core/scheduler/state.ts'

const tmpWs = () => mkdtempSync(join(tmpdir(), 'myteam-idx-'))
const ev = (seq: number, type: string, payload: Record<string, unknown>, ts = 1000 + seq) => ({ seq, ts, actor: 'lead', type, payload })

function writeLedger(ws: string, teamId: string, events: Array<Record<string, unknown>>): void {
  const dir = join(ws, '.dsh-myteam', 'tasks', teamId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ledger.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
}

/** 一条最小可用账本：team.created → plan.approved → member.spawned ×1 → task.created ×2 */
function teamLedger(teamId: string, goal: string): Array<Record<string, unknown>> {
  return [
    ev(0, 'team.created', { teamId, name: teamId, goal }),
    ev(1, 'plan.approved', { teamId, planId: 'p-1' }),
    ev(2, 'member.spawned', { teamId, memberId: 'm-1', roleId: 'developer', sessionId: 's-1', status: 'active', parentMemberId: null, depth: 0, rootMemberId: 'm-1' }),
    ev(3, 'task.created', { teamId, taskId: 't-1', task: { title: 'A', requiredRole: 'developer', acceptanceCriteria: ['ok'] } }),
    ev(4, 'task.created', { teamId, taskId: 't-2', task: { title: 'B', requiredRole: 'developer', acceptanceCriteria: ['ok'] } }),
  ]
}

test('t24-1: entryFromProjection 摘要（目标/状态/成员/计数）', () => {
  const proj = emptyProjection('alpha')
  proj.goal = '做登录页'
  proj.state = 'active'
  proj.tasks = {
    't-1': { id: 't-1', state: 'done' },
    't-2': { id: 't-2', state: 'in_progress' },
    't-3': { id: 't-3', state: 'backlog' },
  } as never
  proj.members = {
    'm-1': { id: 'm-1', roleId: 'developer', instanceName: 'dev-1', status: 'active' },
    'm-2': { id: 'm-2', roleId: 'acceptor', instanceName: 'qa-1', status: 'archived' },
  } as never
  const entry = entryFromProjection('alpha', proj, 123)
  assert.equal(entry.teamId, 'alpha')
  assert.equal(entry.goal, '做登录页')
  assert.equal(entry.state, 'active')
  assert.equal(entry.createdAt, 123)
  assert.deepEqual(entry.counts, { tasks: 3, done: 1, running: 1, members: 1 })
  assert.deepEqual(entry.members.map((member) => member.roleId), ['developer', 'acceptor'])
})

test('t24-2: scanWorkspaceIndex 从账本全量重建（含空目录与坏行容错）', () => {
  const ws = tmpWs()
  writeLedger(ws, 'alpha', teamLedger('alpha', '目标 A'))
  writeLedger(ws, 'beta', teamLedger('beta', '目标 B'))
  // 坏行：不应让整个扫描失败
  const badDir = join(ws, '.dsh-myteam', 'tasks', 'gamma')
  mkdirSync(badDir, { recursive: true })
  writeFileSync(join(badDir, 'ledger.jsonl'), '{"seq":0,"ts":1,"type":"team.created"\n', 'utf8')

  const index = scanWorkspaceIndex(ws)
  assert.equal(index.version, 1)
  assert.equal(index.workspaceRoot, ws)
  const ids = index.teams.map((team) => team.teamId).sort()
  assert.deepEqual(ids, ['alpha', 'beta'], '坏行团队（无有效事件）被跳过')
  const alpha = index.teams.find((team) => team.teamId === 'alpha')!
  assert.equal(alpha.goal, '目标 A')
  assert.equal(alpha.counts.done, 0)
  assert.equal(alpha.counts.tasks, 2)
  assert.equal(alpha.counts.members, 1)
})

test('t24-3: 工作区索引原子读写 + upsert（createdAt 沿用、团队去重）', () => {
  const ws = tmpWs()
  assert.equal(readWorkspaceIndex(ws), undefined, '索引缺失返回 undefined')

  const index = scanWorkspaceIndex(ws) // 空工作区
  const path = workspaceIndexPath(ws)
  // upsert 首次写入
  const first = upsertTeamEntry(ws, { ...entryFromProjection('alpha', emptyProjection('alpha'), 111) })
  assert.equal(first.teams.length, 1)
  assert.equal(first.teams[0].createdAt, 111)
  assert.ok(existsSync(path), 'teams.json 落盘')
  assert.ok(!existsSync(`${path}.tmp`), 'tmp 文件已 rename，无残留')

  // 同团队再 upsert：不重复、createdAt 沿用
  const second = upsertTeamEntry(ws, { ...entryFromProjection('alpha', emptyProjection('alpha'), 0), state: 'archived' })
  assert.equal(second.teams.length, 1)
  assert.equal(second.teams[0].state, 'archived')
  assert.equal(second.teams[0].createdAt, 111, 'createdAt 沿用旧值')

  // 第二个团队：按 updatedAt 倒序
  const third = upsertTeamEntry(ws, { ...entryFromProjection('beta', emptyProjection('beta'), 222), updatedAt: Date.now() + 1000 })
  assert.deepEqual(third.teams.map((team) => team.teamId), ['beta', 'alpha'])
  assert.equal(readWorkspaceIndex(ws)!.teams.length, 2)
  // 文件是合法 JSON
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')))
})

/* CHG-201：跨工作区索引（workspaces.json）已退役——全局层不记录项目。
 * 项目清单由项目视图按会话工作区读 `.dsh-myteam/state/teams.json`（t24-2/3 已覆盖）。 */
