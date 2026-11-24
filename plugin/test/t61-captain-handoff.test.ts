/**
 * t61：队长接管**排队**（`captain.handoff.proposed`）。
 *
 * 背景：这个事件早就声明在事件目录里，但**没有任何写入方**、投影也是 no-op ——
 * 所以「谁在等接管确认」查不出来，设计稿 `p-approval` 的「队长接管」那张卡画不出来。
 *
 * 这里锁住四件事：
 *   1. 提案落事件、进待确认列表，但**不改队长、不动 generation**（只提案不执行）；
 *   2. 同一会话重复提案被拒（待确认列表里不该堆一样的）；
 *   3. 人类确认后提案消失、generation +1（执行才改状态）；
 *   4. 提案带 fromGeneration，供确认时判断有没有过期。
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
  createTeamCommand,
  initializeProject,
  proposeCaptainHandoffCommand,
} from '../src/application/commands.ts'
import { confirmCaptainTakeover, previewCaptainTakeover } from '../src/application/human-actions.ts'
import { createPanelWriteAuthorizer } from '../src/application/panel-writes.ts'
import { pendingApprovalsView } from '../src/application/queries.ts'
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

function withTeam(body: (runtime: ProjectRuntime, teamId: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t61-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '接管排队' })
      createTeamCommand(runtime, {
        actor: HUMAN,
        name: '甲队',
        goal: '测试接管',
        captainSessionId: 'session_old',
      })
      const teamId = [...runtime.state.teams.keys()][0]!
      body(runtime, teamId)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('提案接管：进待确认列表，但**不改队长、不动 generation**', () => {
  withTeam((runtime, teamId) => {
    const before = runtime.state.captains.get(teamId)!
    assert.equal(before.sessionId, 'session_old')
    assert.equal(before.generation, 1)

    proposeCaptainHandoffCommand(runtime, {
      actor: HUMAN,
      teamId,
      toSessionId: 'session_new',
    })

    // 只提案，不执行
    const after = runtime.state.captains.get(teamId)!
    assert.equal(after.sessionId, 'session_old', '提案不该换掉队长')
    assert.equal(after.generation, 1, '提案不该推进 generation')

    // 但待确认里要看得到
    const view = pendingApprovalsView(runtime.state)
    const card = view.pending.find((item) => item.kind === 'handoff')
    assert.ok(card !== undefined, '提案应出现在待确认列表里')
    assert.ok(card!.title.includes('甲队'), '标题要带团队名')
    assert.ok(card!.detail?.includes('session_new') ?? false, '要写清接任会话')
    assert.equal(card!.by, 'human:user-1', '要记提案人')
    // 接管已经支持了，不该再标未覆盖
    assert.equal(view.unsupported.captainTakeover, false)
  })
})

test('同一会话重复提案被拒（待确认里不该堆一样的）', () => {
  withTeam((runtime, teamId) => {
    proposeCaptainHandoffCommand(runtime, { actor: HUMAN, teamId, toSessionId: 'session_new' })
    assert.throws(
      () => proposeCaptainHandoffCommand(runtime, { actor: HUMAN, teamId, toSessionId: 'session_new' }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFLICT',
    )
    const view = pendingApprovalsView(runtime.state)
    assert.equal(view.pending.filter((item) => item.kind === 'handoff').length, 1, '只该有一张卡')
  })
})

test('已经是当前队长 → 拒绝（没什么可接管的）', () => {
  withTeam((runtime, teamId) => {
    assert.throws(
      () => proposeCaptainHandoffCommand(runtime, { actor: HUMAN, teamId, toSessionId: 'session_old' }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFLICT',
    )
  })
})

test('人类确认后：提案消失、generation +1', () => {
  withTeam((runtime, teamId) => {
    proposeCaptainHandoffCommand(runtime, { actor: HUMAN, teamId, toSessionId: 'session_new' })
    assert.equal(pendingApprovalsView(runtime.state).pending.filter((item) => item.kind === 'handoff').length, 1)

    const authorizer = createPanelWriteAuthorizer()
    const preview = previewCaptainTakeover(runtime, { teamId, toSessionId: 'session_new' })
    const confirmation = authorizer.issue(
      {
        operationId: preview.operationId,
        action: 'captain.takeover',
        targetHash: preview.targetHash,
        impactHash: preview.impactHash,
      },
      HUMAN,
    )
    confirmCaptainTakeover(runtime, { authorizer }, {
      actor: HUMAN,
      teamId,
      toSessionId: 'session_new',
      operationId: preview.operationId,
      confirmation,
    })

    const after = runtime.state.captains.get(teamId)!
    assert.equal(after.sessionId, 'session_new', '确认后队长换人')
    assert.equal(after.generation, 2, 'generation 只在确认时 +1')
    assert.equal(
      pendingApprovalsView(runtime.state).pending.filter((item) => item.kind === 'handoff').length,
      0,
      '确认之后提案不该还在待确认里',
    )
  })
})
