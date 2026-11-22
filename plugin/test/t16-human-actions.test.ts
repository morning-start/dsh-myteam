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
} from '../src/application/commands.ts'
import {
  confirmCaptainTakeover,
  confirmTeamDisband,
  previewCaptainTakeover,
  previewTeamDisband,
} from '../src/application/human-actions.ts'
import { HumanAuthorizer } from '../src/domain/permissions/human-authorizer.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const CAPTAIN: ActorRef = { kind: 'captain', teamId: 'team_x', sessionId: 'ses_a', generation: 1 }
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

function seed(runtime: ProjectRuntime): { teamId: string; roleId: string; memberId: string } {
  initializeProject(runtime, { actor: HUMAN, name: '确认项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
  const team = createTeamCommand(runtime, { actor: HUMAN, name: '甲队', goal: 'g', captainSessionId: 'ses_a' })
  const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id
  const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_member' })
  const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id
  return { teamId, roleId, memberId }
}

function authorizer(): HumanAuthorizer {
  let counter = 0
  return new HumanAuthorizer({ now: () => NOW, createNonce: () => `nonce-${++counter}`, ttlMs: 60_000 })
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

test('解散团队：预览 → 人类确认 → 执行 → 令牌不可复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = seed(runtime)
      const auth = authorizer()
      const preview = previewTeamDisband(runtime, { teamId })
      assert.match(preview.summary, /解散团队/)
      assert.equal((preview.impact as { members: string[] }).members.length, 1)

      const confirmation = auth.issue(
        {
          operationId: preview.operationId,
          action: 'team.disband',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        HUMAN,
      )

      confirmTeamDisband(runtime, { authorizer: auth }, {
        actor: HUMAN,
        teamId,
        operationId: preview.operationId,
        confirmation,
        reason: '项目结束',
      })
      assert.equal(runtime.state.teams.get(teamId)!.status, 'disbanded')
      assert.equal(auth.consumedCount(), 1)

      expectCode(
        () =>
          confirmTeamDisband(runtime, { authorizer: auth }, {
            actor: HUMAN,
            teamId,
            operationId: preview.operationId,
            confirmation,
            reason: '再点一次',
          }),
        'CONFLICT',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('解散团队：预览后影响面变化 → 令牌失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId, roleId } = seed(runtime)
      const auth = authorizer()
      const preview = previewTeamDisband(runtime, { teamId })
      const confirmation = auth.issue(
        {
          operationId: preview.operationId,
          action: 'team.disband',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        HUMAN,
      )

      // 预览之后又加了一个成员：影响面变了，必须重新看。
      appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: 'ses_member_2' })

      expectCode(
        () =>
          confirmTeamDisband(runtime, { authorizer: auth }, {
            actor: HUMAN,
            teamId,
            operationId: preview.operationId,
            confirmation,
            reason: 'r',
          }),
        'CONFIRMATION_TARGET_CHANGED',
      )
      assert.equal(runtime.state.teams.get(teamId)!.status, 'active')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('队长接管：generation +1，旧令牌不可复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = seed(runtime)
      const auth = authorizer()
      const preview = previewCaptainTakeover(runtime, { teamId, toSessionId: 'ses_b' })
      assert.equal((preview.impact as { nextGeneration: number }).nextGeneration, 2)

      const confirmation = auth.issue(
        {
          operationId: preview.operationId,
          action: 'captain.takeover',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        HUMAN,
      )

      confirmCaptainTakeover(runtime, { authorizer: auth }, {
        actor: HUMAN,
        teamId,
        toSessionId: 'ses_b',
        operationId: preview.operationId,
        confirmation,
      })

      const captain = runtime.state.captains.get(teamId)!
      assert.equal(captain.generation, 2)
      assert.equal(captain.sessionId, 'ses_b')
      assert.equal(captain.reason, 'handoff')

      expectCode(
        () =>
          confirmCaptainTakeover(runtime, { authorizer: auth }, {
            actor: HUMAN,
            teamId,
            toSessionId: 'ses_b',
            operationId: preview.operationId,
            confirmation,
          }),
        'CONFLICT',
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人类专属动作：agent 既不能签发也不能执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = seed(runtime)
      const auth = authorizer()
      const preview = previewTeamDisband(runtime, { teamId })

      expectCode(
        () =>
          auth.issue(
            {
              operationId: preview.operationId,
              action: 'team.disband',
              targetHash: preview.targetHash,
              impactHash: preview.impactHash,
            },
            CAPTAIN,
          ),
        'HUMAN_ONLY',
      )

      const confirmation = auth.issue(
        {
          operationId: preview.operationId,
          action: 'team.disband',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        HUMAN,
      )
      expectCode(
        () =>
          confirmTeamDisband(runtime, { authorizer: auth }, {
            actor: CAPTAIN,
            teamId,
            operationId: preview.operationId,
            confirmation,
            reason: 'r',
          }),
        'HUMAN_ONLY',
      )
      assert.equal(runtime.state.teams.get(teamId)!.status, 'active')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})