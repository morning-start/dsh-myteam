/**
 * t48：释放成员（L0-G3）。
 *
 * 为什么要有：`MemberStatus` 里一直有 `released`、事件类型里一直有 `member.released`，
 * 但没有任何命令能把它写出来 —— 设计稿的「释放成员 / 归档成员」两屏因此只能看不能动。
 * 这组用例锁住：正常释放、终态不可复用、跨团队/未知成员拒绝、面板写的确认要求与令牌路径拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import {
  appointMemberCommand,
  createProjectRole,
  createTeamCommand,
  initializeProject,
  releaseMemberCommand,
} from '../src/application/commands.ts'
import {
  applyDirectPanelWrite,
  createPanelWriteAuthorizer,
  previewPanelWrite,
} from '../src/application/panel-writes.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  const manifest = ensureProjectManifest(dir, { projectId: newId('project'), createdAt: NOW })
  return ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(dir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(dir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
}

/** 造两支团队，各一个成员（用来测跨团队拒绝）。 */
function seed(runtime: ProjectRuntime): { teamA: string; memberA: string; teamB: string; memberB: string } {
  initializeProject(runtime, { actor: HUMAN, name: '释放成员项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id

  const makeTeam = (name: string, sessionId: string): { teamId: string; memberId: string } => {
    const team = createTeamCommand(runtime, { actor: HUMAN, name, goal: 'g', captainSessionId: sessionId })
    const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id
    const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: `${sessionId}-m` })
    const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id
    return { teamId, memberId }
  }

  const a = makeTeam('甲队', 'ses_a')
  const b = makeTeam('乙队', 'ses_b')
  return { teamA: a.teamId, memberA: a.memberId, teamB: b.teamId, memberB: b.memberId }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, `应抛 MyTeamError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

test('释放成员：写 member.released，状态变 released，revision 递增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-release-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamA, memberA } = seed(runtime)
      const before = runtime.state.members.get(memberA)!
      const result = releaseMemberCommand(runtime, { actor: HUMAN, teamId: teamA, memberId: memberA })

      const released = result.events.find((event) => event.type === 'member.released')
      assert.ok(released !== undefined, '必须产生 member.released 事件')
      assert.deepEqual(released.payload, { teamId: teamA, memberId: memberA, revision: before.revision + 1 })

      const after = runtime.state.members.get(memberA)!
      assert.equal(after.status, 'released')
      assert.equal(after.revision, before.revision + 1)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('释放成员：released 是终态，重复释放被拒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-release-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamA, memberA } = seed(runtime)
      releaseMemberCommand(runtime, { actor: HUMAN, teamId: teamA, memberId: memberA })
      expectCode(() => releaseMemberCommand(runtime, { actor: HUMAN, teamId: teamA, memberId: memberA }), 'INVALID_TRANSITION')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('释放成员：跨团队 / 未知成员都拒绝（不能拿别人的 teamId 释放）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-release-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamA, memberB } = seed(runtime)
      expectCode(() => releaseMemberCommand(runtime, { actor: HUMAN, teamId: teamA, memberId: memberB }), 'NOT_FOUND')
      expectCode(
        () => releaseMemberCommand(runtime, { actor: HUMAN, teamId: teamA, memberId: 'member_00000099' }),
        'NOT_FOUND',
      )
      assert.equal(runtime.state.members.get(memberB)!.status, 'active', '被拒绝的释放不能改状态')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板写 memberRelease：必须 confirm: true；不走令牌通道', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-release-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamA, memberA } = seed(runtime)
      const params = { teamId: teamA, memberId: memberA }

      expectCode(() => applyDirectPanelWrite(runtime, 'memberRelease', { confirm: false, params }), 'INVALID_PAYLOAD')
      assert.equal(runtime.state.members.get(memberA)!.status, 'active', '被拒绝的写不能留下痕迹')

      // 确认方式是 direct：走令牌预览路径必须被明确拒绝，而不是悄悄走错通道。
      expectCode(
        () => previewPanelWrite(runtime, createPanelWriteAuthorizer() as never, 'memberRelease', { params }),
        'INVALID_COMMAND',
      )

      const applied = applyDirectPanelWrite(runtime, 'memberRelease', { confirm: true, params })
      assert.equal(applied.method, 'memberRelease')
      assert.deepEqual(applied.committed, { memberId: memberA, teamId: teamA, status: 'released' })
      assert.equal(runtime.state.members.get(memberA)!.status, 'released')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})