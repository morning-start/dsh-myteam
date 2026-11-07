/**
 * T18c — buildKnowledgeView（FR-17.5 数据面，M2-0b）：
 * 条目全量投影 + 待审提案（proposed − 已裁决 adopted[含 rejected]）+ 演化时间线（knowledge.revised 按 entryId 归组）。
 * 纯读：不写任何文件；ledger 用临时 JSONL 手工落（与账本行格式一致：seq/ts/actor/type/payload）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildKnowledgeView } from '../src/host.ts'
import { writeKnowledgeEntry, knowledgeDirOf, type KnowledgeEntry } from '../src/core/knowledge/knowledge.ts'

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t18c-'))
  const entry: KnowledgeEntry = {
    id: 'kb-view-1', title: '构建缓存要清 dist', tags: ['build', 'cache'], audience: [],
    evidence: ['task-k1'], contributor: 'm1', updated: '2026-10-28', unverified: false, core: false,
    proofCount: 1, body: '构建前先清 dist，否则旧产物混入。',
  }
  writeKnowledgeEntry(knowledgeDirOf(ws), entry)
  // 团队 t1：一条未裁决提案 + 一条已驳回提案 + 一条演化事件
  const dir1 = join(ws, '.dsh-myteam', 'tasks', 't1')
  mkdirSync(dir1, { recursive: true })
  const lines = [
    { seq: 1, ts: Date.now(), actor: 'member:m1', type: 'knowledge.proposed', payload: { teamId: 't1', draftId: 'd-pending', draft: { id: 'd-pending', title: '新条目提案', tags: ['api'], relation: 'new', evidence: ['task-k9'] }, proposedBy: 'm1' } },
    { seq: 2, ts: Date.now(), actor: 'lead', type: 'knowledge.adopted', payload: { teamId: 't1', draftId: 'd-rejected', decision: 'rejected' } },
    { seq: 3, ts: Date.now(), actor: 'member:m2', type: 'knowledge.proposed', payload: { teamId: 't1', draftId: 'd-rejected', draft: { id: 'd-rejected', title: '会被驳回', tags: [] } }, proposedBy: 'm2' },
    { seq: 4, ts: Date.now(), actor: 'lead', type: 'knowledge.revised', payload: { teamId: 't1', entryId: 'kb-view-1', relation: 'refine', diff: 'refine · kb-view-1 · +evidence:task-k2 · by m2' } },
  ]
  writeFileSync(join(dir1, 'ledger.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return ws
}

test('t18c-1: entries 全量投影（badge 面/proofCount/evidence/body）', () => {
  const v = buildKnowledgeView(setup())
  assert.equal(v.entries.length, 1)
  const e = v.entries[0]
  assert.equal(e.id, 'kb-view-1')
  assert.equal(e.proofCount, 1)
  assert.deepEqual(e.evidence, ['task-k1'])
  assert.equal(e.unverified, false)
  assert.ok(e.body.includes('dist'))
})

test('t18c-2: proposals = proposed − 已裁决（adopted 同 draftId 含 rejected）；按时间升序', () => {
  const v = buildKnowledgeView(setup())
  assert.equal(v.proposals.length, 1, '已驳回提案不进待审队列')
  const p = v.proposals[0]
  assert.equal(p.draftId, 'd-pending')
  assert.equal(p.teamId, 't1')
  assert.equal(p.relation, 'new')
  assert.equal(p.proposedBy, 'm1')
  assert.deepEqual(p.evidence, ['task-k9'])
})

test('t18c-3: timeline 按 entryId 归组 knowledge.revised（ts/actor/diff）', () => {
  const v = buildKnowledgeView(setup())
  const tl = v.timeline['kb-view-1']
  assert.ok(tl, '演化事件应归组到条目')
  assert.equal(tl.length, 1)
  assert.equal(tl[0].relation, 'refine')
  assert.equal(tl[0].actor, 'lead')
  assert.ok(tl[0].diff.includes('+evidence:task-k2'))
})

test('t18c-4: 无 teams 目录 → 条目照常返回，提案/时间线为空（面板降级不报错）', () => {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t18c-empty-'))
  const v = buildKnowledgeView(ws)
  assert.deepEqual(v.proposals, [])
  assert.deepEqual(v.timeline, {})
})
