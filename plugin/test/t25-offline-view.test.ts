/**
 * T25（CHG-46）：离线只读视图单测。
 *  - 路径安全（teamId 白名单、绝对工作区）
 *  - 容错折叠：坏事件跳过但保留此前状态；坏 JSON 行计入 degraded
 *  - 看板/任务详情与在线视图同构（buildBoardView/buildTaskDetailView 纯函数复用）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildOfflineAudit,
  buildOfflineBoard,
  buildOfflineTaskDetail,
  buildOfflineTokens,
  foldTolerant,
  isSafeTeamId,
  readOfflineTokens,
  teamLedgerPath,
} from '../src/core/index/offline-view.ts'

const TS = 1_700_000_000_000

const ev = (seq: number, type: string, payload: Record<string, unknown>, actor = 'lead') => ({ seq, ts: TS + seq, actor, type, payload })

function withWorkspace(fn: (ws: string) => void): void {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t25-'))
  try { fn(ws) } finally { rmSync(ws, { recursive: true, force: true }) }
}

function writeLedger(ws: string, teamId: string, lines: string[]): void {
  const dir = join(ws, '.dsh-myteam', 'tasks', teamId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n')
}

test('t25-1: teamId 白名单 + 绝对工作区（禁止路径穿越）', () => {
  assert.equal(isSafeTeamId('team-1'), true)
  assert.equal(isSafeTeamId('T_1.a'), true)
  assert.equal(isSafeTeamId('../evil'), false)
  assert.equal(isSafeTeamId('.hidden'), false)
  assert.equal(isSafeTeamId('team/../x'), false)
  assert.equal(isSafeTeamId(''), false)
  assert.equal(teamLedgerPath('relative/ws', 't1'), undefined, '相对路径拒绝')
  assert.equal(teamLedgerPath(tmpdir(), '../t1'), undefined)
  assert.ok(teamLedgerPath(tmpdir(), 't1')?.endsWith(join('.dsh-myteam', 'tasks', 't1', 'ledger.jsonl')))
})

test('t25-2: foldTolerant 跳过非法事件、保留此前折叠结果', () => {
  const events = [
    ev(1, 'team.created', { teamId: 't1', name: 'n', goal: 'g' }),
    ev(2, 'task.created', { taskId: 'a', task: { title: 'A', requiredRole: 'dev', deps: ['b'] } }),
    // a 依赖 b 未完成 → claim 在 fold 层非法（FoldError），应只跳过这一条
    ev(3, 'task.claimed', { taskId: 'a', memberId: 'm1', attemptId: 'at1' }),
  ] as never[]
  const { proj, skippedEvents } = foldTolerant('t1', events)
  assert.equal(skippedEvents, 1)
  assert.equal(proj.goal, 'g')
  assert.equal(proj.tasks.a.state, 'backlog', '非法 claim 不改变任务状态')
})

test('t25-3: 离线看板折叠（坏 JSON 行容错 → degraded）', () => {
  withWorkspace((ws) => {
    writeLedger(ws, 't-bad', [
      JSON.stringify(ev(1, 'team.created', { teamId: 't-bad', name: 'n', goal: '离线目标' })),
      '{not json',
      JSON.stringify(ev(2, 'task.created', { taskId: 'task-1', task: { title: '任务', requiredRole: 'dev', priority: 'P0', deps: [] } })),
    ])
    const result = buildOfflineBoard(ws, 't-bad')
    assert.ok(result, '有可解析事件 → 返回看板')
    assert.equal(result!.meta.badLines, 1)
    assert.equal(result!.meta.degraded, true)
    assert.equal(result!.board.goal, '离线目标')
    assert.deepEqual(result!.board.columns.find((c) => c.name === 'backlog')!.tasks.map((t) => t.id), ['task-1'])
  })
})

test('t25-5: 离线 tokens 侧车读取（缺失/损坏/版本不符 → undefined，命中率派生）', () => {
  withWorkspace((ws) => {
    assert.equal(readOfflineTokens(ws, 'no-team'), undefined)
    assert.equal(buildOfflineTokens(ws, 'no-team'), undefined)

    writeLedger(ws, 't-tok', [JSON.stringify(ev(1, 'team.created', { teamId: 't-tok', name: 'n', goal: 'g' }))])
    const dir = join(ws, '.dsh-myteam', 'tasks', 't-tok')
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({
      version: 1, teamId: 't-tok', updatedAt: 1, days: {},
      totals: { m1: { uncachedInput: 30, cacheRead: 70, cacheWrite: 0, output: 10, calls: 1 } },
      note: 'n',
    }))
    const view: any = buildOfflineTokens(ws, 't-tok')
    assert.equal(view.source, 'tokenMeter')
    assert.equal(view.caliber, 'heuristic')
    assert.equal(view.nonBillable, true)
    assert.equal(view.totals.m1.calls, 1)
    assert.ok(Math.abs(view.totals.m1.hitRate - 0.7) < 1e-9)

    writeFileSync(join(dir, 'tokens.json'), '{broken')
    assert.equal(readOfflineTokens(ws, 't-tok'), undefined)

    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ version: 2, totals: {}, days: {} }))
    assert.equal(readOfflineTokens(ws, 't-tok'), undefined)
  })
})

test('t25-4: 离线任务详情（时间线/证据/交付物） + 空账本返回 undefined', () => {
  withWorkspace((ws) => {
    writeLedger(ws, 't-detail', [
      JSON.stringify(ev(1, 'team.created', { teamId: 't-detail', name: 'n', goal: 'g' })),
      JSON.stringify(ev(2, 'task.created', { taskId: 'task-1', task: { title: '任务', requiredRole: 'dev', deps: [] } })),
      JSON.stringify(ev(3, 'task.evidence', { taskId: 'task-1', evidence: { command: 'npm test', result: 'ok' } })),
    ])
    const detail = buildOfflineTaskDetail(ws, 't-detail', 'task-1')
    assert.ok(detail)
    assert.equal(detail!.input.title, '任务')
    assert.equal(detail!.evidenceRefs.length, 1)
    assert.equal((detail!.evidenceRefs[0].evidence as Record<string, unknown>).result, 'ok')
    assert.ok(detail!.timeline.some((e) => e.type === 'task.evidence'))

    assert.equal(buildOfflineTaskDetail(ws, 't-detail', 'missing'), undefined)
    assert.equal(buildOfflineBoard(ws, 'no-such-team'), undefined)
  })
})

test('t25-6: 离线审计分页（新→旧、limit、beforeSeq 游标）', () => {
  withWorkspace((ws) => {
    writeLedger(ws, 't-audit', [
      JSON.stringify(ev(1, 'team.created', { teamId: 't-audit', name: 'n', goal: 'g' })),
      JSON.stringify(ev(2, 'plan.staged', { teamId: 't-audit' })),
      JSON.stringify(ev(3, 'task.created', { taskId: 'task-1', task: { title: 'A', requiredRole: 'dev', deps: [] } })),
      JSON.stringify(ev(4, 'task.progress', { taskId: 'task-1', note: 'p' })),
    ])
    const page = buildOfflineAudit(ws, 't-audit', { limit: 2 })!
    assert.equal(page.total, 4)
    assert.deepEqual(page.events.map((e) => e.seq), [4, 3])
    assert.equal(page.nextBeforeSeq, 3)
    assert.equal(page.events[1].taskId, 'task-1')

    const older = buildOfflineAudit(ws, 't-audit', { limit: 2, beforeSeq: page.nextBeforeSeq! })!
    assert.deepEqual(older.events.map((e) => e.seq), [2, 1])
    assert.equal(older.nextBeforeSeq, null)

    assert.equal(buildOfflineAudit(ws, '../evil'), undefined)
  })
})
