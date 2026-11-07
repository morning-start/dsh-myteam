/**
 * T79 · CHG-94（M2-D ① / FR-16.4①）：handoff 摘要**升级为索引**。
 *
 * ## 为什么这是「升级」而不是「加一段」
 *
 * FR-16.3 否决原地变身的两条理由里，第二条是「旧会话历史整段混进队长上下文 →
 * 模型按旧上下文继续干活」。摘要虽然截断，但**截断仍是内容**：新队长读到的是
 * 「上一个团队做了什么」，而不是「哪里能查到」。
 *
 * 索引只给指针（`session:<id>`），需要时按需深读，读取留痕 `session.read`。
 *
 * ## 本文件守住的四条不变量
 *
 * 1. 索引**只含指针**，不含会话正文（正文一旦混进来，就等于整段注入）；
 * 2. 没有 `sessionId` 的成员**不进索引**（编造 id 比没有更糟——深读会落到不存在的会话）；
 * 3. 队长会话**永远排第一**（上下文最完整的一条）；
 * 4. 有界（`HANDOFF_SESSION_INDEX_LIMIT`）且去重。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHandoffSummary,
  buildSessionIndex,
  HANDOFF_SESSION_INDEX_LIMIT,
} from '../src/core/host/session-handoff.ts'

const MEMBERS = [
  { id: 'm1', roleId: 'implementer', instanceName: '实现一', status: 'active', sessionId: 'sess-m1' },
  { id: 'm2', roleId: 'reviewer', instanceName: '复核一', status: 'active', sessionId: 'sess-m2', currentTaskId: 'task-2' },
  // 没有 sessionId：正在创建 / 已释放
  { id: 'm3', roleId: 'implementer', instanceName: '实现二', status: 'removed' },
]

test('t79-1: 队长会话永远排第一（上下文最完整的一条）', () => {
  const index = buildSessionIndex({ teamId: 't1', sourceSessionId: 'sess-captain', members: MEMBERS })
  assert.equal(index.length, 3, '队长 + 两个有 sessionId 的成员')
  assert.equal(index[0].sessionId, 'sess-captain')
  assert.equal(index[0].kind, 'captain')
})

test('t79-2: 没有 sessionId 的成员不进索引（编造 id 比没有更糟——深读会落到不存在的会话）', () => {
  const index = buildSessionIndex({ teamId: 't1', sourceSessionId: 'sess-captain', members: MEMBERS })
  assert.ok(!index.some((ref) => ref.sessionId === 'm3'), 'm3 没有 sessionId，不能进索引')
  assert.ok(!index.some((ref) => ref.memberId === 'm3'))
  assert.deepEqual(index.map((ref) => ref.sessionId), ['sess-captain', 'sess-m1', 'sess-m2'])
})

test('t79-3: 索引只含指针 —— 结构里没有任何「会话正文」字段（正文混进来就是整段注入）', () => {
  const index = buildSessionIndex({ teamId: 't1', sourceSessionId: 'sess-captain', members: MEMBERS })
  const allowed = new Set(['sessionId', 'kind', 'title', 'taskId', 'memberId', 'roleId'])
  for (const ref of index) {
    for (const key of Object.keys(ref)) assert.ok(allowed.has(key), `索引条目不应有字段 ${key}（那会变成内容注入）`)
  }
})

test('t79-4: 去重 —— 同一 sessionId 只出现一次（取首次）', () => {
  const index = buildSessionIndex({
    teamId: 't1',
    sourceSessionId: 'sess-dup',
    members: [
      { id: 'm1', sessionId: 'sess-dup' },
      { id: 'm2', sessionId: 'sess-dup' },
      { id: 'm3', sessionId: 'sess-other' },
    ],
  })
  assert.deepEqual(index.map((ref) => ref.sessionId), ['sess-dup', 'sess-other'])
})

test('t79-5: 有界 —— 超过 HANDOFF_SESSION_INDEX_LIMIT 只取前 N 条', () => {
  const members = Array.from({ length: HANDOFF_SESSION_INDEX_LIMIT + 5 }, (_, i) => ({ id: `m${i}`, sessionId: `sess-${i}` }))
  const index = buildSessionIndex({ teamId: 't1', sourceSessionId: 'sess-captain', members })
  assert.equal(index.length, HANDOFF_SESSION_INDEX_LIMIT, '索引必须有界（一个百人团队就是一百行）')
})

test('t79-6: 成员条目带当前任务（新队长据此判断「哪个会话还在干活」）', () => {
  const index = buildSessionIndex({ teamId: 't1', sourceSessionId: 'sess-captain', members: MEMBERS })
  const m2 = index.find((ref) => ref.sessionId === 'sess-m2')
  assert.ok(m2)
  assert.equal(m2.taskId, 'task-2')
  assert.equal(m2.roleId, 'reviewer')
  assert.equal(m2.kind, 'member')
})

test('t79-7: 摘要里渲染成 `session:<id>` 指针 + 明确「未深读的内容不在上下文里」', () => {
  const { summary } = buildHandoffSummary({
    teamId: 't1',
    teamName: 'T',
    goal: 'G',
    sourceSessionId: 'sess-captain',
    members: MEMBERS,
  })
  assert.ok(summary.includes('会话索引'), '摘要里要有「会话索引」段')
  assert.ok(summary.includes('`session:sess-captain`'), '队长会话要渲染成合法的 session: 指针')
  assert.ok(summary.includes('`session:sess-m1`'), '成员会话同理')
  assert.ok(summary.includes('未深读的内容不在你的上下文里'), '必须明说「没读就不在上下文」——否则模型以为已经给全了')
  // 反例：没有 sessionId 的成员不能被渲染进索引
  assert.ok(!summary.includes('session:m3'), '没有 sessionId 的成员不能出现在索引里')
})

test('t79-8: 摘要 metadata 带结构化 sessionIndex（面板/审计可读，不进模型上下文）', () => {
  const { metadata } = buildHandoffSummary({
    teamId: 't1', teamName: 'T', goal: 'G',
    sourceSessionId: 'sess-captain',
    members: MEMBERS,
  })
  assert.ok(Array.isArray(metadata.sessionIndex), 'metadata.sessionIndex 要是数组')
  assert.equal(metadata.sessionIndex?.length, 3)
  assert.equal(metadata.sessionIndex?.[0].kind, 'captain')
})

test('t79-9: 没有 sourceSessionId 且成员都没有 sessionId 时，摘要不出现空索引段（空段是噪音）', () => {
  const { summary, metadata } = buildHandoffSummary({
    teamId: 't1', teamName: 'T', goal: 'G',
    members: [{ id: 'm1', roleId: 'implementer' }],
  })
  assert.ok(!summary.includes('会话索引'), '没有任何会话可索引时不要渲染空段')
  assert.equal(metadata.sessionIndex, undefined, 'metadata 也不要给空数组（空对象也是造假）')
})

test('t79-10: 索引条目能被 evidence-pointer 解析成 session 指针（两套契约同源）', async () => {
  const { parseEvidencePointer } = await import('../src/core/knowledge/evidence-pointer.ts')
  const index = buildSessionIndex({ teamId: 't1', sourceSessionId: 'sess-captain', members: MEMBERS })
  for (const ref of index) {
    const pointer = parseEvidencePointer(`session:${ref.sessionId}`)
    assert.equal(pointer.kind, 'session', `session:${ref.sessionId} 必须是合法的 session 指针`)
    assert.equal(pointer.value, ref.sessionId)
  }
})
