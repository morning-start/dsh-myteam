import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEAM_MEMBER_TOOLS,
  HOST_TEAM_TOOLS_TO_HIDE,
  buildToolMask,
  memberSessionId,
  memberPromptSection,
  scratchPathFor,
} from '../src/core/members/member-setup.ts'
import { BUILTIN_ROLES } from '../src/core/roles/builtin-roles.ts'

test('T6: exactly 9 member tools (v2.5 +read_knowledge); team tools never in deny mask (FR-3.5)', () => {
  assert.equal(TEAM_MEMBER_TOOLS.length, 9)
  assert.ok(TEAM_MEMBER_TOOLS.includes('myteam_claim_task'))
  assert.ok(TEAM_MEMBER_TOOLS.includes('myteam_read_knowledge'))
  // deny 团队工具 → 拒绝
  assert.throws(
    () => buildToolMask({ ...BUILTIN_ROLES[1], toolPolicy: { deny: ['myteam_claim_task'] } }),
    /FR-3.5 invariant/,
  )
  // deny 业务工具 → 掩码生效
  const denyMask = buildToolMask({ ...BUILTIN_ROLES[1], toolPolicy: { deny: ['bash'] } })
  assert.equal(denyMask.mode, 'deny')
  assert.deepEqual(denyMask.deny, ['bash'])
})

test('T6: allow whitelist always includes the 8 team tools (C5 narrowing only)', () => {
  const mask = buildToolMask({ ...BUILTIN_ROLES[1], toolPolicy: { allow: ['bash', 'read'] } })
  assert.equal(mask.mode, 'allow')
  for (const t of TEAM_MEMBER_TOOLS) {
    assert.ok(mask.allow!.includes(t), `team tool ${t} missing from allow mask`)
  }
  assert.ok(mask.allow!.includes('bash'))
  // 无策略 → 不收窄
  assert.equal(buildToolMask(BUILTIN_ROLES[1]).mode, 'none')
})

test('T6: hide list matches host builtin team tools (T0-verified 9 tools)', () => {
  assert.equal(HOST_TEAM_TOOLS_TO_HIDE.length, 9)
  assert.ok(HOST_TEAM_TOOLS_TO_HIDE.includes('spawn_teammate'))
  assert.ok(HOST_TEAM_TOOLS_TO_HIDE.includes('team_task_update'))
})

test('T6: sessionId naming is idempotent and slugged (ADR-001)', () => {
  assert.equal(memberSessionId('t1', 'implementer', 2), 'mt-t1-implementer-2')
  assert.equal(memberSessionId('t1', ' weird role! ', 1), 'mt-t1--weird-role---1')
})

test('T6: member prompt section carries role identity + discipline rules', () => {
  const member = { memberId: 'm1', roleId: 'implementer', instanceName: 'impl-1', sessionId: 'mt-t1-implementer-1', teamId: 't1' }
  const section = memberPromptSection(BUILTIN_ROLES.find((r) => r.id === 'implementer')!, member)
  assert.equal(section.name, 'myteam:member-m1')
  assert.ok(section.text.includes('impl-1'))
  assert.ok(section.text.includes('attemptId'))
  assert.ok(section.text.includes('Verification evidence'))
  assert.ok(section.text.includes('escalate_task'))
  assert.ok(section.text.includes('零请求'))
})

test('T6: scratch path nests per team/member (FR-10.5, R26 member mkdirs)', () => {
  const p = scratchPathFor('E:/ws', 't1', 'm1')
  assert.ok(p.includes('.team-workplace/state/scratch/t1/m1') || p.includes('.team-workplace\\state\\scratch\\t1\\m1'))
})
