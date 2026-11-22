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
import {
  applyDirectPanelWrite,
  applyPanelWrite,
  createPanelWriteAuthorizer,
  panelWriteKind,
  previewPanelWrite,
} from '../src/application/panel-writes.ts'
import { newId } from '../src/contracts/ids.ts'
import { createReviewTaskFixture } from './fixtures/review-task.ts'
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

test('面板写通道：预览签发令牌 → 凭令牌执行 → 同一令牌不可复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = seed(runtime)
      const authorizer = createPanelWriteAuthorizer()

      const preview = previewPanelWrite(runtime, authorizer, 'teamDisband', { teamId })
      assert.match(preview.summary, /解散团队/, '预览要说清这是解散')
      assert.equal(preview.confirmation.action, 'team.disband')
      assert.equal(typeof preview.confirmation.nonce, 'string')

      const applied = applyPanelWrite(runtime, authorizer, 'teamDisband', {
        params: { teamId },
        confirmation: preview.confirmation,
        reason: '项目结束',
      })
      assert.equal(applied.method, 'teamDisband')
      assert.equal(applied.operationId, preview.operationId)
      assert.equal(runtime.state.teams.get(teamId)!.status, 'disbanded')

      // 令牌是一次性的：再确认一次必须失败（消费或状态冲突，二者都不执行写入）
      assert.throws(() =>
        applyPanelWrite(runtime, authorizer, 'teamDisband', {
          params: { teamId },
          confirmation: preview.confirmation,
          reason: '重复确认',
        }),
      )
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板写通道：队长接管也要令牌，接管后 generation 递增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { teamId } = seed(runtime)
      const authorizer = createPanelWriteAuthorizer()
      const before = runtime.state.captains.get(teamId)?.generation ?? 0

      const preview = previewPanelWrite(runtime, authorizer, 'captainTakeover', {
        teamId,
        toSessionId: 'ses_next_captain',
      })
      assert.equal(preview.confirmation.action, 'captain.takeover')
      assert.match(preview.summary, /队长/, '预览要说明这是队长变更')

      applyPanelWrite(runtime, authorizer, 'captainTakeover', {
        params: { teamId, toSessionId: 'ses_next_captain' },
        confirmation: preview.confirmation,
        reason: '会话切换',
      })
      assert.equal(runtime.state.captains.get(teamId)?.generation, before + 1)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写方法分两种确认方式：解散/接管要令牌，门禁裁决直接带 confirm', () => {
  assert.equal(panelWriteKind('teamDisband'), 'token')
  assert.equal(panelWriteKind('captainTakeover'), 'token')
  assert.equal(panelWriteKind('gateVerdict'), 'direct')
})

test('门禁裁决：带 confirm 才落账，verdict 绑定当前 Attempt，任务仍停在 review', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-verdict-' })
  try {
    const applied = applyDirectPanelWrite(fx.runtime, 'gateVerdict', {
      confirm: true,
      params: {
        taskId: fx.taskId,
        attemptId: fx.attemptId,
        outcome: 'pass',
        checks: [{ command: 'node --test', exitCode: 0, summary: '12 passed' }],
        evidence: [{ kind: 'command', ref: 'node --test' }],
      },
    })
    const committed = applied.committed as { verdict: { id: string; outcome: string }; taskStatus: string }
    assert.equal(applied.operationId, committed.verdict.id, 'operationId 就是这次裁决的 id')
    assert.equal(committed.verdict.outcome, 'pass')
    assert.equal(committed.taskStatus, 'review', '裁决只落账，不改任务状态（完成是另一步）')

    const verdict = fx.runtime.state.verdicts.get(fx.taskId)!
    assert.equal(verdict.attemptId, fx.attemptId)
    assert.equal(verdict.checks.length, 1)
    assert.equal(verdict.checks[0]!.exitCode, 0, '缺省字段要被归一化，不能留 undefined 进事件')
    assert.equal(verdict.checks[0]!.stdoutHash, null)
  } finally {
    fx.dispose()
  }
})

test('门禁裁决：缺 confirm: true 拒绝，且账本不动', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-verdict-' })
  try {
    const params = {
      taskId: fx.taskId,
      attemptId: fx.attemptId,
      outcome: 'pass',
      checks: [{ command: 'node --test', exitCode: 0, summary: 'ok' }],
      evidence: [{ kind: 'command', ref: 'node --test' }],
    }
    expectCode(() => applyDirectPanelWrite(fx.runtime, 'gateVerdict', { confirm: false, params }), 'INVALID_PAYLOAD')
    assert.equal(fx.runtime.state.verdicts.get(fx.taskId), undefined, '被拒绝的裁决不能留下痕迹')
  } finally {
    fx.dispose()
  }
})

test('门禁裁决：Attempt 过期 → ATTEMPT_STALE；非法 outcome → INVALID_PAYLOAD', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-verdict-' })
  try {
    const base = {
      taskId: fx.taskId,
      outcome: 'pass',
      checks: [{ command: 'node --test', exitCode: 0, summary: 'ok' }],
      evidence: [{ kind: 'command', ref: 'node --test' }],
    }
    expectCode(
      () => applyDirectPanelWrite(fx.runtime, 'gateVerdict', { confirm: true, params: { ...base, attemptId: 'attempt_stale' } }),
      'ATTEMPT_STALE',
    )
    expectCode(
      () => applyDirectPanelWrite(fx.runtime, 'gateVerdict', { confirm: true, params: { ...base, attemptId: fx.attemptId, outcome: '大概行?' } }),
      'INVALID_PAYLOAD',
    )
    expectCode(
      () =>
        applyDirectPanelWrite(fx.runtime, 'gateVerdict', {
          confirm: true,
          params: { ...base, attemptId: fx.attemptId, evidence: [{ kind: 'feeling', ref: 'x' }] },
        }),
      'INVALID_PAYLOAD',
    )
    assert.equal(fx.runtime.state.verdicts.get(fx.taskId), undefined)
  } finally {
    fx.dispose()
  }
})

test('两种确认方式不能互相串用：令牌方法不走直接写，直接写方法不签发令牌', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-verdict-' })
  try {
    const authorizer = createPanelWriteAuthorizer()
    expectCode(
      () =>
        previewPanelWrite(fx.runtime, authorizer, 'gateVerdict', {
          taskId: fx.taskId,
          attemptId: fx.attemptId,
          outcome: 'pass',
        }),
      'INVALID_COMMAND',
    )
    expectCode(
      () => applyDirectPanelWrite(fx.runtime, 'teamDisband', { confirm: true, params: { teamId: fx.teamId } }),
      'INVALID_COMMAND',
    )
  } finally {
    fx.dispose()
  }
})

test('新建任务：带 confirm 落账，无依赖直接 ready', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-task-create-' })
  try {
    const applied = applyDirectPanelWrite(fx.runtime, 'taskCreate', {
      confirm: true,
      params: {
        teamId: fx.teamId,
        title: '面板建的任务',
        description: '从团队视图新建',
        acceptance: ['能看见'],
      },
    })
    const committed = applied.committed as { task: { id: string; status: string; title: string } }
    assert.equal(applied.operationId, committed.task.id, 'operationId 就是新任务 id')
    assert.equal(committed.task.status, 'ready', '没有依赖的任务建完就能认领')
    assert.equal(fx.runtime.state.tasks.get(committed.task.id)!.title, '面板建的任务')
  } finally {
    fx.dispose()
  }
})

test('新建任务：缺 confirm / 团队不存在 / 依赖不存在 / 参数类型不对，全部拒绝且不落账', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-task-create-' })
  try {
    const before = fx.runtime.state.tasks.size
    const base = { teamId: fx.teamId, title: 't', acceptance: ['a'] }

    expectCode(() => applyDirectPanelWrite(fx.runtime, 'taskCreate', { confirm: false, params: base }), 'INVALID_PAYLOAD')
    expectCode(
      () => applyDirectPanelWrite(fx.runtime, 'taskCreate', { confirm: true, params: { ...base, teamId: 'team_missing' } }),
      'NOT_FOUND',
    )
    expectCode(
      () =>
        applyDirectPanelWrite(fx.runtime, 'taskCreate', {
          confirm: true,
          params: { ...base, dependencies: ['task_missing'] },
        }),
      'NOT_FOUND',
    )
    expectCode(
      () => applyDirectPanelWrite(fx.runtime, 'taskCreate', { confirm: true, params: { ...base, acceptance: '不是数组' } }),
      'INVALID_PAYLOAD',
    )
    assert.equal(fx.runtime.state.tasks.size, before, '被拒绝的新建不能留下任务')
  } finally {
    fx.dispose()
  }
})

test('新建任务：有依赖时先停在 planned', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-task-create-' })
  try {
    const applied = applyDirectPanelWrite(fx.runtime, 'taskCreate', {
      confirm: true,
      params: {
        teamId: fx.teamId,
        title: '下游任务',
        acceptance: ['依赖上游'],
        dependencies: [fx.taskId],
      },
    })
    const committed = applied.committed as { task: { status: string; dependencies: string[] } }
    assert.equal(committed.task.status, 'planned')
    assert.deepEqual(committed.task.dependencies, [fx.taskId])
  } finally {
    fx.dispose()
  }
})