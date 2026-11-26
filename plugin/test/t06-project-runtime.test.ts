import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import {
  appointMemberCommand,
  claimTaskCommand,
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { cancelTaskCommand, reopenTaskCommand } from '../src/application/task-commands.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { rebuildProjectState } from '../src/application/projections/project-state.ts'

const PROJECT = 'prj_00000001'
const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'panel' }

function openRuntime(dir: string): ProjectRuntime {
  return ProjectRuntime.open({
    projectId: PROJECT,
    eventStore: new FileEventStore(join(dir, 'events', 'project.jsonl')),
    writerLock: new WriterLeaseManager(join(dir, 'state', 'writer.lock')),
    clock: { now: () => '2026-01-01T00:00:00.000Z' },
    ids: newId,
  })
}

function scenario(runtime: ProjectRuntime): { teamId: string; taskId: string; memberId: string; roleId: string } {
  initializeProject(runtime, { actor: HUMAN, name: '演示项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '写代码', instructions: '按 AC 实现', specialties: ['ts'] },
    capabilities: { tools: { allow: ['read', 'write'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id

  const team = createTeamCommand(runtime, {
    actor: HUMAN,
    name: '登录小队',
    goal: '完成登录',
    captainSessionId: 'ses_captain_01',
  })
  const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
    .team.id

  const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_member_01' })
  const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id

  const task = createTaskCommand(runtime, {
    actor: HUMAN,
    title: '实现登录接口',
    description: 'POST /login',
    acceptance: ['成功返回 token'],
    ownerTeamId: teamId,
    requiredRoleId: roleId,
  })
  const taskId = (task.events[0]!.payload as { task: { id: string } }).task.id

  claimTaskCommand(runtime, { actor: HUMAN, taskId, memberId })
  return { teamId, taskId, memberId, roleId }
}

/** 再建一条**没有依赖**的任务（创建即 ready，可被认领）。 */
function readyTask(runtime: ProjectRuntime, teamId: string, title: string): string {
  const created = createTaskCommand(runtime, {
    actor: HUMAN,
    title,
    description: title,
    acceptance: ['做完'],
    ownerTeamId: teamId,
  })
  return (created.events[0]!.payload as { task: { id: string } }).task.id
}

test('项目切片：建项目 → 角色 → 团队 → 成员 → 任务 → 认领', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-runtime-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId, taskId, memberId } = scenario(runtime)

      // 事件序号按事件计：initialize(1) role(2) config+team(3,4) member(5) task(6) claim(7)
      assert.equal(runtime.state.seq, 7)
      assert.equal(runtime.state.teams.get(teamId)!.status, 'active')
      assert.equal(runtime.state.members.get(memberId)!.status, 'active')

      const task = runtime.state.tasks.get(taskId)!
      assert.equal(task.status, 'claimed')
      assert.notEqual(task.attemptId, null)

      const attempt = runtime.state.attempts.get(task.attemptId!)!
      assert.equal(attempt.generation, 1)
      assert.equal(attempt.memberId, memberId)
      assert.equal(attempt.status, 'active')

      const captain = runtime.state.captains.get(teamId)!
      assert.equal(captain.generation, 1)
      assert.equal(captain.sessionId, 'ses_captain_01')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Attempt generation：同一任务反复重开后，generation 必须严格递增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-runtime-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId, memberId } = scenario(runtime)
      const taskId = readyTask(runtime, teamId, '反复重开')

      const generations: number[] = []
      // 三轮「认领 → 取消 → 重开」。只做一轮时旧实现（取历史最大值 + 1）
      // 也会给出 2，测不出问题；做到三轮，旧实现会停在 2，新实现才是 1/2/3。
      for (let round = 1; round <= 3; round += 1) {
        const claim = claimTaskCommand(runtime, { actor: HUMAN, taskId, memberId })
        const attempt = (claim.events[0]!.payload as { attempt: { id: string; generation: number } }).attempt
        generations.push(attempt.generation)

        cancelTaskCommand(runtime, { actor: HUMAN, taskId, reason: `第 ${round} 轮换人` })
        assert.equal(runtime.state.attempts.get(attempt.id)!.status, 'revoked')
        reopenTaskCommand(runtime, { actor: HUMAN, taskId, reason: `第 ${round} 轮重开` })
        assert.equal(runtime.state.tasks.get(taskId)!.status, 'ready')
      }

      assert.deepEqual(
        generations,
        [1, 2, 3],
        '同一任务的 Attempt generation 必须严格递增：复用旧值会让迟到的旧 Attempt 写入被当成当前世代',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目切片：重开后投影与关闭前一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-runtime-'))
  try {
    const first = openRuntime(dir)
    const ids = scenario(first)
    const before = {
      seq: first.state.seq,
      tasks: [...first.state.tasks.values()],
      members: [...first.state.members.values()],
      teams: [...first.state.teams.values()],
      attempts: [...first.state.attempts.values()],
    }
    first.close()

    const second = openRuntime(dir)
    try {
      assert.equal(second.state.seq, before.seq)
      assert.deepEqual([...second.state.tasks.values()], before.tasks)
      assert.deepEqual([...second.state.members.values()], before.members)
      assert.deepEqual([...second.state.teams.values()], before.teams)
      assert.deepEqual([...second.state.attempts.values()], before.attempts)

      const store = new FileEventStore(join(dir, 'events', 'project.jsonl'))
      const rebuilt = rebuildProjectState(PROJECT, store.readCommitted().events)
      assert.deepEqual([...rebuilt.tasks.values()], before.tasks)
      assert.equal(second.state.tasks.has(ids.taskId), true)
    } finally {
      second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目切片：第二个写者拿不到租约', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-runtime-'))
  try {
    const first = openRuntime(dir)
    try {
      assert.throws(
        () => openRuntime(dir),
        (error: unknown) => error instanceof MyTeamError && error.code === 'WRITER_LEASE_LOST',
      )
    } finally {
      first.close()
    }
    const third = openRuntime(dir)
    third.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目切片：依赖已存在任务可以建立，缺失依赖被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-runtime-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '依赖' })
      const team = createTeamCommand(runtime, {
        actor: HUMAN,
        name: 't',
        goal: 'g',
        captainSessionId: 'ses_captain_01',
      })
      const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
        .team.id

      const a = createTaskCommand(runtime, {
        actor: HUMAN,
        title: 'a',
        description: '',
        acceptance: ['x'],
        ownerTeamId: teamId,
      })
      const aId = (a.events[0]!.payload as { task: { id: string } }).task.id

      const b = createTaskCommand(runtime, {
        actor: HUMAN,
        title: 'b',
        description: '',
        acceptance: ['x'],
        ownerTeamId: teamId,
        dependencies: [aId],
      })
      const bTask = (b.events[0]!.payload as { task: { id: string; dependencies: string[]; status: string } }).task
      assert.deepEqual(bTask.dependencies, [aId])
      assert.equal(bTask.status, 'planned', '有依赖的新任务不应立刻 ready')

      assert.throws(
        () =>
          createTaskCommand(runtime, {
            actor: HUMAN,
            title: 'c',
            description: '',
            acceptance: ['x'],
            ownerTeamId: teamId,
            dependencies: ['task_99999999'],
          }),
        (error: unknown) => error instanceof MyTeamError && error.code === 'NOT_FOUND',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})