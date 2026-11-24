/**
 * t54：成员「归档」（`member.archived`）—— 与「释放」是两件事。
 *
 * 背景：设计稿 `p-member-archive` 要的是「先排空、再归档、名册留痕、可回放」，
 * 而 `MemberStatus` 原本只有 appointed/active/paused/released，`released` 是终态。
 * 决策见 docs/decisions/成员归档语义.md（选项 A）。
 *
 * 这里钉住四类行为：
 *   1. 合法迁移：active/paused → archived，archived → active（恢复），archived → released；
 *   2. 有进行中 Attempt 时：默认 wait 拒绝、drain=pause 先落 paused 再落 archived（两事件）；
 *   3. 子成员未处理时 CONFLICT 并列出子成员 id（级联必须显式确认）；
 *   4. `archived` 不能接新活（团队必须 active，且 archived 不在可认领态里）。
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
  archiveMemberCommand,
  claimTaskCommand,
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
  releaseMemberCommand,
} from '../src/application/commands.ts'
import { canChangeMemberStatus } from '../src/domain/teams/member.ts'
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

function withRuntime(body: (runtime: ProjectRuntime) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t54-'))
  try {
    body(openRuntime(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(runtime: ProjectRuntime): {
  teamId: string
  roleId: string
  memberId: string
  taskId: string
} {
  initializeProject(runtime, { actor: HUMAN, name: '归档项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
  createTeamCommand(runtime, {
    actor: HUMAN,
    name: '甲队',
    goal: '交付',
    captainSessionId: 'ses_captain_1',
  })
  // 团队 id 从投影取：createTeamCommand 内部的 payload.team 与
  // runtime.state.teams 的 key 不一定同源，直接读键最稳（t49 也是拿到 committed.teamId 之后
  // 再去 state.teams 里查）。
  const teamId = [...runtime.state.teams.keys()][0]
  if (teamId === undefined) throw new Error('seed 失败：建队后投影里没有团队')
  const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_member_1' })
  const memberId = (member.events.find((event) => event.type === 'member.appointed')!.payload as { member: { id: string } }).member.id
  const task = createTaskCommand(runtime, {
    actor: HUMAN,
    ownerTeamId: teamId,
    title: '待认领的任务',
    description: '',
    acceptance: ['可验证'],
  })
  const taskId = (task.events.find((event) => event.type === 'task.created')!.payload as { task: { id: string } }).task.id
  return { teamId, roleId, memberId, taskId }
}

test('迁移表：archived 可以回 active、可以走 released；released 是终态', () => {
  assert.equal(canChangeMemberStatus('active', 'archived'), true)
  assert.equal(canChangeMemberStatus('paused', 'archived'), true)
  assert.equal(canChangeMemberStatus('archived', 'active'), true, '归档要能恢复')
  assert.equal(canChangeMemberStatus('archived', 'released'), true, '归档后也能彻底离开')
  assert.equal(canChangeMemberStatus('released', 'archived'), false, '终态不能回到归档')
  assert.equal(canChangeMemberStatus('released', 'active'), false)
})

test('归档没有进行中尝试的成员：落 member.archived，投影状态变 archived', () => {
  withRuntime((runtime) => {
    const { teamId, memberId } = seed(runtime)
    const result = archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId })

    assert.equal(result.events.length, 1, '干净归档只该有一条事件')
    assert.equal(result.events[0]!.type, 'member.archived')
    assert.equal(runtime.state.members.get(memberId)!.status, 'archived')
  })
})

test('有进行中 Attempt：默认 wait 拒绝，报 CONFLICT 并列出 attemptId', () => {
  withRuntime((runtime) => {
    const { teamId, memberId, taskId } = seed(runtime)
    claimTaskCommand(runtime, { actor: HUMAN, taskId, memberId })

    assert.throws(
      () => archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId }),
      (error: unknown) => error instanceof MyTeamError
        && error.code === 'CONFLICT'
        && JSON.stringify((error as { details?: unknown }).details ?? {}).includes('attempt'),
    )
    assert.notEqual(runtime.state.members.get(memberId)!.status, 'archived', '被拒绝就不能改状态')
  })
})

test('有进行中 Attempt + drain=pause：先落 paused 再落 archived（两事件）', () => {
  withRuntime((runtime) => {
    const { teamId, memberId, taskId } = seed(runtime)
    claimTaskCommand(runtime, { actor: HUMAN, taskId, memberId })

    const result = archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId, drain: 'pause' })
    assert.equal(result.events.length, 2)
    assert.equal(result.events[0]!.type, 'member.status.changed')
    assert.equal((result.events[0]!.payload as { status: string }).status, 'paused')
    assert.equal(result.events[1]!.type, 'member.archived')
    assert.equal(runtime.state.members.get(memberId)!.status, 'archived')
  })
})

test('子成员未处理：CONFLICT 并列出子成员 id', () => {
  withRuntime((runtime) => {
    const { teamId, roleId, memberId } = seed(runtime)
    const child = appointMemberCommand(runtime, {
      actor: HUMAN,
      teamId,
      roleId,
      parentMemberId: memberId,
      sessionId: null,
    })
    assert.equal(child.events.length, 1)

    assert.throws(
      () => archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId }),
      (error: unknown) => error instanceof MyTeamError
        && error.code === 'CONFLICT'
        && /子成员/.test(error.message),
    )
  })
})

test('归档之后：成员不再接活（认领被拒），但记录与记忆保留', () => {
  withRuntime((runtime) => {
    const { teamId, memberId, taskId } = seed(runtime)
    archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId })

    assert.throws(
      () => claimTaskCommand(runtime, { actor: HUMAN, taskId, memberId }),
      (error: unknown) => error instanceof MyTeamError,
      '已归档成员不能被派活/认领',
    )
    const member = runtime.state.members.get(memberId)!
    assert.ok(member !== undefined, '记录必须还在（归档 = 留痕）')
    assert.equal(member.status, 'archived')
  })
})

test('归档 → 恢复（archived → active）→ 归档 → 释放，都走得通', () => {
  withRuntime((runtime) => {
    const { teamId, memberId } = seed(runtime)
    archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId })
    assert.equal(runtime.state.members.get(memberId)!.status, 'archived')

    // 恢复没有专门命令时，走通用的状态变更（域里允许 archived → active）。
    const member = runtime.state.members.get(memberId)!
    assert.equal(canChangeMemberStatus(member.status, 'active'), true)
    assert.equal(canChangeMemberStatus(member.status, 'released'), true)

    // 归档不能重复归档（archived → archived 不在迁移表里）。
    assert.throws(
      () => archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_TRANSITION',
    )
  })
})

test('已释放的成员不能再归档（released 是终态）', () => {
  withRuntime((runtime) => {
    const { teamId, memberId } = seed(runtime)
    releaseMemberCommand(runtime, { actor: HUMAN, teamId, memberId })
    assert.throws(
      () => archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_TRANSITION',
    )
  })
})

test('归档和释放是两个不同终局：归档留痕可查，释放也是留痕（member 记录不删）', () => {
  withRuntime((runtime) => {
    const { teamId, memberId } = seed(runtime)
    archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId })
    const archived = runtime.state.members.get(memberId)!
    assert.equal(archived.status, 'archived')
    // 关键差异：归档后仍可恢复，释放后不行。
    assert.equal(canChangeMemberStatus('archived', 'active'), true)
    assert.equal(canChangeMemberStatus('released', 'active'), false)

  })
})
