/**
 * T178 成员上岗简报（CHG-212 / ADR-010 P4b）。
 *
 * 子代理形态下 `setup` 注入不了 section，角色纪律 / 知识索引 / 记忆召回全靠这段文本补回来。
 * 这里钉住三件事：三段都在、记忆条目带出处、空知识库不产空段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemberBrief } from '../src/core/members/member-brief.ts'
import { memberBankId, memoryDbPath, openMemoryStore } from '../src/core/memory/store.ts'
import type { RoleDefinition } from '../src/core/roles/builtin-roles.ts'
import type { MemberInstance } from '../src/core/members/member-setup.ts'

const role = {
  id: 'implementer',
  name: '实现者',
  description: '按 AC 完成实现并附证据块',
  toolPolicy: { deny: ['pwsh'] },
} as unknown as RoleDefinition

const member: MemberInstance = {
  memberId: 'm1-implementer',
  roleId: 'implementer',
  instanceName: 'implementer-1',
  sessionId: 'mt-t1-implementer-1',
  teamId: 't1',
  parentMemberId: null,
  depth: 0,
  rootMemberId: 'm1-implementer',
}

test('t178a: 角色纪律 + 记忆纪律都在，且带成员身份', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt178a-'))
  try {
    const text = buildMemberBrief({ role, member, workspaceRoot: root })
    assert.match(text, /实现者/, '角色名要在简报里')
    assert.match(text, /按 AC 完成实现并附证据块/, '职责要在')
    assert.match(text, /myteam_claim_task/, '工作纪律要在')
    assert.match(text, /记忆写入纪律/, '记忆纪律要在')
    assert.match(text, /mt-t1-implementer-1/, '身份连续性：会话 id 要在')
    assert.ok(!text.includes('\n\n\n'), '不能出现连续空段')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t178b: 有记忆时带出处召回，且排在记忆纪律之前', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt178b-'))
  try {
    const store = openMemoryStore(memoryDbPath(root))
    store.remember({
      bankId: memberBankId('t1', 'm1-implementer'),
      kind: 'pitfall',
      title: '登录前必须刷新 token',
      body: '否则 401。',
      evidence: 'task t-42',
      importance: 5,
      source: 'member:m1-implementer',
    })
    store.close()

    const text = buildMemberBrief({ role, member, workspaceRoot: root })
    assert.match(text, /上岗召回/, '记忆召回段要在')
    assert.match(text, /登录前必须刷新 token/)
    assert.match(text, /evidence: task t-42/, '记忆必须带出处')
    assert.ok(text.indexOf('上岗召回') < text.indexOf('记忆写入纪律'), '召回在纪律之前（先给事实，再给纪律）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})