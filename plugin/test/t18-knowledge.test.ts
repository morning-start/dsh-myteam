import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseFrontmatter,
  entryFromMarkdown,
  entryToMarkdown,
  buildIndex,
  renderIndexSection,
  validateDraft,
  adoptDraft,
  reviseEntry,
  touchStale,
  candidatesForDraft,
  listKnowledge,
  readKnowledgeEntry,
  writeKnowledgeEntry,
  knowledgeDirOf,
  INDEX_BUDGET_LINES,
  KnowledgeError,
} from '../src/core/knowledge/knowledge.ts'

const sampleEntry = `---
id: db-schema-users
title: 用户域数据模型
tags: [database, core]
audience: [dev, qa]
evidence: task-k1
contributor: dev-1
updated: 2026-10-25
core: true
---
users 表是核心域；sessions 表通过 user_id 外键关联。`

test('T18: frontmatter parse + entry roundtrip (FR-17.2)', () => {
  const entry = entryFromMarkdown(sampleEntry)
  assert.equal(entry.id, 'db-schema-users')
  assert.deepEqual(entry.tags, ['database', 'core'])
  assert.equal(entry.unverified, false)
  assert.equal(entry.core, true)
  assert.deepEqual(entry.evidence, ['task-k1']) // v2.7：证据指针一律数组
  assert.equal(entry.proofCount, 1)
  assert.ok(entry.body.includes('sessions 表'))
  // roundtrip 稳定
  const re = entryFromMarkdown(entryToMarkdown(entry))
  assert.equal(re.id, entry.id)
  assert.deepEqual(re.evidence, entry.evidence)
  assert.equal(re.proofCount, entry.proofCount)
  assert.equal(re.core, true)
})

test('T18: missing evidence → unverified flag (scene 32)', () => {
  const noEvidence = entryFromMarkdown(`---
id: dsl-notes
title: DSL 注意事项
tags: [tool]
updated: 2026-10-25
---
正文`)
  assert.equal(noEvidence.unverified, true)
  assert.deepEqual(noEvidence.evidence, [])
  assert.equal(noEvidence.proofCount, 0)
})

test('T18 v2.7: multi-line evidence list frontmatter parses; roundtrip keeps list', () => {
  const entry = entryFromMarkdown(`---
id: mls-evidence
title: 多行证据
tags: [tool]
evidence:
  - task-k1
  - http://git.example/pr/12
updated: 2026-10-28
---
正文`)
  assert.deepEqual(entry.evidence, ['task-k1', 'http://git.example/pr/12'])
  assert.equal(entry.proofCount, 2)
  const re = entryFromMarkdown(entryToMarkdown(entry))
  assert.deepEqual(re.evidence, ['task-k1', 'http://git.example/pr/12'])
})

test('T18 v2.7: relation validation — refine/contradict need resolvable target (FR-17.4)', () => {
  const refine = validateDraft({ id: 'db-schema-users', title: '精炼', tags: ['database'], body: '补充', evidence: 'task-k9', relation: 'refine', targetId: 'db-schema-users' })
  assert.equal(refine.ok, true)
  // 格式可解析（ID_RE）即过校验；条目是否真实存在由 host 采纳时解析（MT_VALIDATION unknown entry）
  const resolvable = validateDraft({ id: 'wrong-target', title: 't', tags: [], body: 'b', evidence: 'e', relation: 'refine', targetId: 'no-such' })
  assert.equal(resolvable.ok, true)
  const badTarget = validateDraft({ id: 'wrong-target', title: 't', tags: [], body: 'b', evidence: 'e', relation: 'refine', targetId: 'BAD_ID' })
  assert.equal(badTarget.ok, false)
  assert.equal(badTarget.code, 'MT_KB_TARGET_REQUIRED')
  const badRelation = validateDraft({ id: 'x-rel', title: 't', tags: [], body: 'b', evidence: 'e', relation: 'merge' as never })
  assert.equal(badRelation.ok, false)
})

test('T18 v2.7: adoptDraft refuses refine/contradict (must go through reviseEntry)', () => {
  assert.throws(
    () => adoptDraft({ id: 'kb-refine-t', title: 't', tags: [], body: 'b', evidence: 'e', relation: 'refine', targetId: 'kb-refine-t' }, 'm1', new Set(), '2026-10-28'),
    (e: unknown) => (e as KnowledgeError).code === 'MT_KB_RELATION_MISMATCH',
  )
})

test('T18 v2.7: reviseEntry — refine clears staleSince and appends evolution (FR-17.4)', () => {
  const existing = entryFromMarkdown(`---
id: db-schema-users
title: 用户域数据模型
tags: [database]
staleSince: 2026-10-27
updated: 2026-10-25
---
users 表是核心域。`)
  const { entry, diffSummary } = reviseEntry(
    existing,
    { id: 'db-schema-users', title: '精炼用户域模型', tags: ['database'], body: '补充：分区键为 tenant_id', evidence: 'task-k9', relation: 'refine', targetId: 'db-schema-users' },
    'm1',
    '2026-10-28',
  )
  assert.equal(entry.staleSince, undefined) // refine 清除待复核标
  assert.equal(entry.proofCount, 1) // max(0, evidence.length)
  assert.ok(entry.evidence.includes('task-k9'))
  assert.ok(entry.body.includes('## 演化'))
  assert.ok(entry.body.includes('- 2026-10-28 · m1 · refine · 证据 task-k9：精炼用户域模型'))
  assert.equal(diffSummary, 'refine · db-schema-users · +evidence:task-k9 · by m1')
  // 幂等追加：再来一条演化不重复标题
  const again = reviseEntry(entry, { id: 'db-schema-users', title: '再补', tags: ['database'], body: 'x', evidence: 'task-k10', relation: 'refine', targetId: 'db-schema-users' }, 'm2', '2026-10-29')
  assert.equal(again.entry.body.split('## 演化').length - 1, 1)
})

test('T18 v2.7: reviseEntry — contradict marks stale, keeps original assertions', () => {
  const existing = entryFromMarkdown(`---
id: gate-rule
title: 门禁规则
tags: [process]
updated: 2026-10-25
---
gate 只看 required。`)
  const { entry } = reviseEntry(existing, { id: 'gate-rule', title: '矛盾：gate 也看 tags', tags: ['process'], body: '发现 gate 还校验 tags', evidence: 'task-k11', relation: 'contradict', targetId: 'gate-rule' }, 'm3', '2026-10-28')
  assert.equal(entry.staleSince, '2026-10-28')
  assert.equal(entry.body.includes('gate 只看 required。'), true) // 原断言保留
  assert.ok(entry.body.includes('contradict'))
})

test('T18 v2.7: touchStale marks intersecting tags only; candidatesForDraft ranks shared (FR-17.4)', () => {
  const a = entryFromMarkdown(sampleEntry) // tags: database, core
  const b = entryFromMarkdown('---\nid: ui-tips\ntitle: UI\ntags: [ui]\nupdated: 2026-10-25\n---\n正文')
  const touched = touchStale([a, b], ['database', 'perf'], '2026-10-28')
  assert.deepEqual(touched.map((t) => t.id), ['db-schema-users'])
  assert.equal(touched[0].staleSince, '2026-10-28')
  // 无交集不动
  const untouched = touchStale([a], ['ui'], '2026-10-28')
  assert.equal(untouched.length, 0)
  const cands = candidatesForDraft([a, b], ['database', 'core'])
  assert.equal(cands[0]?.id, 'db-schema-users')
  assert.deepEqual(cands[0]?.shared, ['database', 'core'])
  assert.equal(cands.some((c) => c.id === 'ui-tips'), false)
})

test('T18 v2.7: renderIndexSection — audience soft filter + stale badge', () => {
  const stale = entryFromMarkdown('---\nid: stale-one\ntitle: 过期条目\ntags: [db]\nevidence: task-k1\nupdated: 2026-10-25\n---\n正文')
  stale.staleSince = '2026-10-27'
  const scoped = entryFromMarkdown('---\nid: qa-only\ntitle: QA 专用\ntags: [qa]\naudience: [qa]\nupdated: 2026-10-25\n---\n正文')
  const dev = renderIndexSection(buildIndex([stale, scoped]), { audience: 'dev' })
  assert.ok(dev.text.includes('[stale 待复核]')) // stale 徽标
  assert.ok(!dev.text.includes('qa-only')) // audience 软过滤（dev 看不到 qa-only）
  const qa = renderIndexSection(buildIndex([stale, scoped]), { audience: 'qa' })
  assert.ok(qa.text.includes('qa-only'))
  const all = renderIndexSection(buildIndex([stale, scoped])) // 空 audience = 全员
  assert.ok(all.text.includes('qa-only'))
})

test('T18: corrupt entries fail loud (no frontmatter / id mismatch / bad id)', () => {
  assert.throws(() => entryFromMarkdown('no frontmatter'), (e: unknown) => (e as KnowledgeError).code === 'MT_KB_CORRUPT')
  assert.throws(
    () => entryFromMarkdown(sampleEntry, 'other-id'),
    (e: unknown) => (e as KnowledgeError).code === 'MT_KB_CORRUPT',
  )
  assert.throws(
    () => entryFromMarkdown('---\nid: BAD_ID\ntitle: t\n---\nbody'),
    (e: unknown) => (e as KnowledgeError).code === 'MT_KB_CORRUPT',
  )
})

test('T18: index built with core first; render respects budget and warns on overflow (scene 31)', () => {
  const entries = [
    entryFromMarkdown(sampleEntry),
    entryFromMarkdown('---\nid: z-tool\ntitle: 工具流程\ntags: [tool]\nupdated: 2026-10-25\n---\n正文'),
  ]
  const index = buildIndex(entries)
  assert.equal(index[0].id, 'db-schema-users') // core 排前
  const small = renderIndexSection(index)
  assert.equal(small.truncated, false)
  assert.ok(small.text.includes('myteam_read_knowledge'))
  // 超预算：造 60 条
  const many = Array.from({ length: 60 }, (_, i) =>
    entryFromMarkdown(`---\nid: e-${String(i).padStart(2, '0')}\ntitle: 条目${i}\ntags: [t]\nupdated: 2026-10-25\n---\n正文`),
  )
  const big = renderIndexSection(buildIndex(many))
  assert.equal(big.truncated, true)
  assert.ok(big.text.includes('索引超预算'))
  assert.ok(big.text.split('\n').length <= INDEX_BUDGET_LINES + 2)
})

test('T18: draft validation requires evidence pointer (E8, FR-17.4)', () => {
  const ok = validateDraft({ id: 'new-k', title: 't', tags: [], body: 'b', evidence: 'task-k1' })
  assert.equal(ok.ok, true)
  const noEv = validateDraft({ id: 'new-k', title: 't', tags: [], body: 'b', evidence: '' })
  assert.equal(noEv.ok, false)
  assert.equal(noEv.code, 'MT_KB_EVIDENCE_REQUIRED')
})

test('T18: adopt writes entry with contributor attribution; duplicate id refused (scene 31)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'myteam-t18-')), 'knowledge')
  const draft = { id: 'dsl-guide', title: 'DSL 指南', tags: ['tool'], body: '怎么写 DSL', evidence: 'task-k2' }
  const entry = adoptDraft(draft, 'm1', new Set(), '2026-10-25')
  assert.equal(entry.contributor, 'm1')
  assert.equal(entry.unverified, false)
  writeKnowledgeEntry(dir, entry)
  assert.ok(existsSync(join(dir, 'dsl-guide.md')))
  assert.ok(existsSync(join(dir, 'index.json')))
  // 同 id 再采纳 → 拒绝
  assert.throws(
    () => adoptDraft(draft, 'm2', new Set(['dsl-guide']), '2026-10-25'),
    (e: unknown) => (e as KnowledgeError).code === 'MT_KB_EXISTS',
  )
  // 读回
  const read = readKnowledgeEntry(dir, 'dsl-guide')
  assert.equal(read?.contributor, 'm1')
  assert.equal(listKnowledge(dir).length, 1)
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as unknown[]
  assert.equal(index.length, 1)
})

test('T18: knowledge dir lives under config (committable, not state) (FR-17.1)', () => {
  const p = knowledgeDirOf('E:/ws').replace(/\\/g, '/')
  assert.ok(p.includes('.dsh-myteam/config/knowledge'))
  assert.ok(!p.includes('/state/'))
})
