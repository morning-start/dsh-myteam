import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { bootstrapProject } from '../src/application/bootstrap.ts'
import {
  appointMemberCommand,
  claimTaskCommand,
  createTaskCommand,
  createTeamCommand,
} from '../src/application/commands.ts'
import { recordVerdictCommand } from '../src/application/task-commands.ts'

const HUMAN = { kind: 'human' as const, userId: 'tester', via: 'host' as const }

test('裁决必须在提交之后：claimed 状态直接裁决被判 INVALID_TRANSITION', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-gate-'))
  const hosts = new ProjectHosts()
  try {
    const runtime = await hosts.open(dir)
    bootstrapProject(runtime, dir)
    const role = [...runtime.state.roles.values()][0]!

    const created = createTeamCommand(runtime, {
      actor: HUMAN,
      name: '门禁队',
      goal: '',
      captainSessionId: 'ses_cap',
    })
    const teamId = (created.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
      .team.id
    const captain = { kind: 'captain' as const, teamId, sessionId: 'ses_cap', generation: 1 }

    const appointed = appointMemberCommand(runtime, { actor: captain, teamId, roleId: role.id, sessionId: 'ses_mem' })
    const memberId = (appointed.events.find((event) => event.type === 'member.appointed')!.payload as { member: { id: string } })
      .member.id

    const task = createTaskCommand(runtime, {
      actor: captain,
      title: '未提交就裁决',
      description: '',
      acceptance: ['返回 ok'],
      ownerTeamId: teamId,
    })
    const taskId = (task.events.find((event) => event.type === 'task.created')!.payload as { task: { id: string } })
      .task.id

    const claim = claimTaskCommand(runtime, { actor: captain, taskId, memberId })
    const attemptId = (claim.events.find((event) => event.type === 'task.claimed')!.payload as { attempt: { id: string } })
      .attempt.id

    assert.throws(
      () =>
        recordVerdictCommand(runtime, {
          actor: captain,
          taskId,
          attemptId,
          outcome: 'pass',
          checks: [{ command: 'none', exitCode: 0, summary: 'no evidence' }],
          evidence: [],
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_TRANSITION', JSON.stringify(error))
        return true
      },
    )
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})