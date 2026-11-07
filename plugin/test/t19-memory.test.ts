/**
 * T19 成员记忆数据层测试（CHG-19，FR-6.1/6.2 + ADR-009）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  memoryDirFor,
  memorySeedTemplate,
  seedMemoryIfMissing,
  parseFrontmatter,
  auditMemoryContent,
} from '../src/core/members/memory.ts'

const member = { memberId: 'm1-implementer', roleId: 'implementer', instanceName: 'implementer-1', teamId: 't1' }

test('t19a: memoryDirFor 布局符合契约（history/members/<t>/<m>/memory，CHG-102）', () => {
  const dir = memoryDirFor('/ws', 't1', 'm1-implementer')
  // 布局用 resolve()（根是绝对路径），跨平台断言只看尾部段
  assert.ok(dir.endsWith(join('.dsh-myteam', 'history', 'members', 't1', 'm1-implementer', 'memory')), dir)
})

test('t19b: seedMemoryIfMissing 播种 + 幂等（已存在不覆盖，FR-6.1）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt19-'))
  try {
    const dir = memoryDirFor(root, 't1', 'm1-implementer')
    const r1 = seedMemoryIfMissing(dir, member)
    assert.equal(r1.seeded, true)
    const seeded = readFileSync(r1.memoryMdPath, 'utf8')
    assert.match(seeded, /^---\nmember: m1-implementer\nrole: implementer\nteam: t1\nevidence: none\nupdated: /)
    assert.match(seeded, /# 私有记忆（implementer-1）/)
    // 模拟成员写入后再次 spawn：幂等不覆盖
    writeFileSync(r1.memoryMdPath, seeded + '\n## 任务 t-42 的坑\n\nevidence: t-42\n\n运行测试前必须 pnpm i。\n', 'utf8')
    const r2 = seedMemoryIfMissing(dir, member)
    assert.equal(r2.seeded, false)
    const after = readFileSync(r1.memoryMdPath, 'utf8')
    assert.match(after, /t-42 的坑/) // 成员内容保留
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t19c: parseFrontmatter 取键 + 无 frontmatter 回退', () => {
  const { data, body } = parseFrontmatter('---\nmember: m1\nevidence: none\n---\n\n# 正文')
  assert.equal(data.member, 'm1')
  assert.equal(data.evidence, 'none')
  assert.match(body, /^# 正文/)
  const r2 = parseFrontmatter('# 无 frontmatter')
  assert.deepEqual(r2.data, {})
  assert.equal(r2.body, '# 无 frontmatter')
})

test('t19d: 审计——种子模板（无条目 + evidence: none）不算违规', () => {
  const seed = memorySeedTemplate(member)
  const r = auditMemoryContent('memory.md', seed)
  assert.equal(r.violations, 0)
})

test('t19e: 审计——条目级 evidence 全命中 = 0 违规', () => {
  const text = [
    '---', 'member: m1', 'evidence: none', '---', '',
    '# 私有记忆', '',
    '## 用户表的隐藏口径',
    '',
    'evidence: task-7',
    '',
    'orders 表软删字段是 deleted_at 不是 is_deleted。',
    '',
    '## 部署流程坑',
    '',
    'evidence: ledger#42',
    '',
    '先 pnpm build 再 test。',
  ].join('\n')
  const r = auditMemoryContent('memory.md', text)
  assert.equal(r.violations, 0, JSON.stringify(r.findings))
})

test('t19f: 审计——条目缺 evidence 行 → 回退 frontmatter none → empty-evidence', () => {
  const text = [
    '---', 'member: m1', 'evidence: none', '---', '',
    '## 无证据条目', '',
    '凭感觉记的内容。',
  ].join('\n')
  const r = auditMemoryContent('memory.md', text)
  assert.equal(r.violations, 1)
  assert.equal(r.findings[0].reason, 'empty-evidence')
  assert.ok(r.findings[0].entry!.includes('无证据条目'))
})

test('t19g: 审计——frontmatter 缺 evidence 键 + 有条目 → missing-evidence', () => {
  const text = ['---', 'member: m1', '---', '', '## 条目A', 'evidence: task-1', '内容', '', '## 条目B', '没写指针'].join('\n')
  const r = auditMemoryContent('memory.md', text)
  assert.equal(r.violations, 1)
  assert.equal(r.findings[0].reason, 'missing-evidence')
  assert.ok(r.findings[0].entry!.includes('条目B'))
})

test('t19h: 审计——无条目时裸 evidence 空指针行 → empty-evidence；无裸行 = 放行', () => {
  const bareEmpty = ['---', 'member: m1', '---', '', '随手记', 'evidence:', '无指针'].join('\n')
  const r1 = auditMemoryContent('m.md', bareEmpty)
  assert.equal(r1.violations, 1)
  assert.equal(r1.findings[0].reason, 'empty-evidence')
  const clean = ['---', 'member: m1', '---', '', '随手记但没有 evidence 行'].join('\n')
  assert.equal(auditMemoryContent('m.md', clean).violations, 0)
})

test('t19i: 审计——条目 evidence: none 显式空指针 → empty-evidence', () => {
  const text = ['---', 'member: m1', '---', '', '## 条目', 'evidence: none', '内容'].join('\n')
  const r = auditMemoryContent('memory.md', text)
  assert.equal(r.violations, 1)
  assert.equal(r.findings[0].reason, 'empty-evidence')
})

test('t19j: 多文件审计聚合（host 层遍历 .md 的聚合口径）', () => {
  const files = [
    { name: 'memory.md', text: memorySeedTemplate(member) },
    { name: 'notes/x.md', text: ['## 笔记', 'evidence: task-9', '内容'].join('\n') },
    { name: 'notes/y.md', text: ['## 无指针笔记', '内容'].join('\n') },
  ]
  let checked = 0
  const findings = []
  for (const f of files) {
    const r = auditMemoryContent(f.name, f.text)
    checked += r.checkedFiles
    findings.push(...r.findings)
  }
  assert.equal(checked, 3)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].file, 'notes/y.md')
})

test('t19k: 目录残留检查（seed 只建 memory/，notes/ 留给成员自建，R26）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt19b-'))
  try {
    const dir = memoryDirFor(root, 't1', 'm1-implementer')
    seedMemoryIfMissing(dir, member)
    assert.ok(existsSync(join(dir, 'memory.md')))
    assert.ok(!existsSync(join(dir, 'notes')), 'host 不预创建 notes/（R26：成员自建）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
