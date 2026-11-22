import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CapabilitySet, RoleDefinition } from '../src/contracts/entities.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import {
  allowsTool,
  narrowCapabilities,
  normalizeCapabilities,
  roleContentHash,
  validateRole,
} from '../src/domain/definitions/role.ts'

function capability(allow: string[], deny: string[] = []): CapabilitySet {
  return { tools: { allow, deny }, mcp: { allow: [], deny: [] }, skills: [] }
}

function role(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id: 'role_00000001',
    revision: 1,
    profile: { name: '实现者', purpose: '写代码', instructions: '按 AC 实现', specialties: ['typescript'] },
    capabilities: capability(['read', 'write']),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, '应抛 MyTeamError')
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

test('规范化：去重、排序、trim', () => {
  const normalized = normalizeCapabilities({
    tools: { allow: [' write ', 'read', 'write'], deny: [] },
    mcp: { allow: [], deny: [] },
    skills: [{ skillId: 'b' }, { skillId: 'a' }, { skillId: 'a', version: '2' }],
  })
  assert.deepEqual(normalized.tools.allow, ['read', 'write'])
  assert.deepEqual(normalized.skills.map((skill) => skill.skillId), ['a', 'b'])
})

test('内容 hash：与字段顺序无关，与内容有关', () => {
  const first = role()
  const reordered: RoleDefinition = {
    ...first,
    profile: { instructions: first.profile.instructions, specialties: ['typescript'], purpose: first.profile.purpose, name: '实现者' },
    capabilities: { mcp: { deny: [], allow: [] }, skills: [], tools: { deny: [], allow: ['write', 'read'] } },
  }
  assert.equal(roleContentHash(first), roleContentHash(reordered))
  const changed = role({ profile: { ...first.profile, purpose: '改需求' } })
  assert.notEqual(roleContentHash(first), roleContentHash(changed))
})

test('校验：空名称、allow/deny 冲突', () => {
  const problems = validateRole(
    role({
      profile: { name: ' ', purpose: '', instructions: '', specialties: [] },
      capabilities: { tools: { allow: ['read'], deny: ['read'] }, mcp: { allow: [], deny: [] }, skills: [] },
    }),
  )
  assert.ok(problems.length >= 4)
})

test('收窄：子集通过，越权拒绝', () => {
  const parent = capability(['read', 'write', 'bash'])
  const narrowed = narrowCapabilities(parent, capability(['read', 'write']))
  assert.deepEqual(narrowed.capabilities.tools.allow, ['read', 'write'])

  expectCode(() => narrowCapabilities(parent, capability(['read', 'deploy'])), 'CAPABILITY_ESCALATION')
})

test('收窄：父 deny 不能被下层重新打开', () => {
  const parent = capability(['read', 'write'], ['write'])
  expectCode(() => narrowCapabilities(parent, capability(['write'])), 'CAPABILITY_ESCALATION')
  const denied = narrowCapabilities(parent, capability(['read']))
  assert.ok(denied.capabilities.tools.deny.includes('write'))
})

test('收窄：通配符语义与空 allow 不同', () => {
  const wildcardParent = capability(['*'])
  const inherited = narrowCapabilities(wildcardParent, capability(['*']))
  assert.deepEqual(inherited.capabilities.tools.allow, ['*'])

  const nothing = narrowCapabilities(wildcardParent, capability([]))
  assert.deepEqual(nothing.capabilities.tools.allow, [])
  assert.equal(allowsTool(nothing.capabilities, 'read'), false)
  assert.equal(allowsTool(inherited.capabilities, 'read'), true)

  // 父不是 * 时，子请求 * 属于放大，拒绝。
  expectCode(() => narrowCapabilities(capability(['read']), capability(['*'])), 'CAPABILITY_ESCALATION')
})

test('收窄：技能必须是父集合的子集', () => {
  const parent: CapabilitySet = {
    tools: { allow: ['read'], deny: [] },
    mcp: { allow: [], deny: [] },
    skills: [{ skillId: 'spec', version: '1' }],
  }
  const ok = narrowCapabilities(parent, {
    tools: { allow: ['read'], deny: [] },
    mcp: { allow: [], deny: [] },
    skills: [{ skillId: 'spec', version: '1' }],
  })
  assert.equal(ok.capabilities.skills.length, 1)

  expectCode(
    () =>
      narrowCapabilities(parent, {
        tools: { allow: [], deny: [] },
        mcp: { allow: [], deny: [] },
        skills: [{ skillId: 'other' }],
      }),
    'CAPABILITY_ESCALATION',
  )
})

test('收窄：deny 合并后只增不减', () => {
  const parent = capability(['read', 'write'], ['bash'])
  const child = narrowCapabilities(parent, {
    tools: { allow: ['read', 'write'], deny: ['write'] },
    mcp: { allow: [], deny: [] },
    skills: [],
  })
  assert.deepEqual(child.capabilities.tools.deny, ['bash', 'write'])
  assert.equal(allowsTool(child.capabilities, 'write'), false)
})