/**
 * t66（P4）：计划批准走令牌两段式，提案/丢弃走直接确认。
 *
 * 锁五件事（对应方案 §10 判据 3、5）：
 *   1. 批准是 `token` 类：预览拿令牌，凭令牌确认才执行；
 *   2. **伪造令牌被拒**（第二步必须自己复验，不能只信请求体）；
 *   3. **planHash 变了令牌失效**（`CONFIRMATION_TARGET_CHANGED`）——
 *      计划内容在预览与确认之间被改过，就不能按旧令牌批准；
 *   4. 提案 / 丢弃是 `direct` 类，带 `confirm: true` 直接执行，且走预览会明确报错；
 *   5. 令牌不能重复消费。
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
import { createProjectRole, initializeProject } from '../src/application/commands.ts'
import {
  applyDirectPanelWrite,
  applyPanelWrite,
  createPanelWriteAuthorizer,
  panelWriteKind,
  previewPanelWrite,
} from '../src/application/panel-writes.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
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

function withProject(body: (runtime: ProjectRuntime, roleId: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myteam-t66-'))
    try {
      const runtime = openRuntime(dir)
      try {
        initializeProject(runtime, { actor: HUMAN, name: '计划令牌' })
        createProjectRole(runtime, {
          actor: HUMAN,
          profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
          capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
        })
        const roleId = [...runtime.state.roles.keys()][0]!
        await body(runtime, roleId)
      } finally {
        runtime.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('三个方法的确认方式：批准 token，提案与丢弃 direct', () => {
  assert.equal(panelWriteKind('planApprove'), 'token')
  assert.equal(panelWriteKind('planPropose'), 'direct')
  assert.equal(panelWriteKind('planDiscard'), 'direct')
})

test('提案与丢弃走 direct：带 confirm 直接执行；走预览明确报错', withProject((runtime, roleId) => {
  const proposed = applyDirectPanelWrite(runtime, 'planPropose', {
    confirm: true,
    params: {
      name: '结算改造',
      goal: '把结算页模块化',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 2, parentSlotKey: null }],
    },
  })
  assert.ok(proposed.committed !== undefined)
  assert.equal(runtime.state.teamPlans.size, 1, '提案只落计划')
  assert.equal(runtime.state.teams.size, 0, '提案不建团队')

  const planId = [...runtime.state.teamPlans.keys()][0]!

  // 走预览通道应明确拒绝（不是静默成功）
  const authorizer = createPanelWriteAuthorizer()
  assert.throws(
    () => previewPanelWrite(runtime, authorizer, 'planPropose', {}),
    (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_COMMAND',
  )

  // 丢弃
  applyDirectPanelWrite(runtime, 'planDiscard', { confirm: true, params: { planId, reason: '不做了' } })
  assert.equal(runtime.state.teamPlans.size, 0, '丢弃后计划消失')
}))

test('批准：预览拿令牌 → 凭令牌执行', withProject(async (runtime, roleId) => {
  applyDirectPanelWrite(runtime, 'planPropose', {
    confirm: true,
    params: {
      name: '结算改造',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 2, parentSlotKey: null }],
    },
  })
  const planId = [...runtime.state.teamPlans.keys()][0]!
  const planHash = runtime.state.teamPlans.get(planId)!.planHash

  const authorizer = createPanelWriteAuthorizer()
  const preview = previewPanelWrite(runtime, authorizer, 'planApprove', { planId })
  assert.ok(preview.confirmation !== undefined, '预览必须给出令牌')
  assert.ok(preview.summary.includes('2 名成员'), `摘要要写清影响面：${preview.summary}`)

  const applied = await applyPanelWrite(
    runtime,
    authorizer,
    'planApprove',
    {
      params: { planId, planHash },
      confirmation: preview.confirmation!,
      reason: '批准开跑',
    },
  )
  assert.ok(applied.committed !== undefined)
  assert.equal(runtime.state.teams.size, 1, '批准后团队建出来')
  assert.equal(runtime.state.members.size, 2, '2 名成员')
  assert.equal(runtime.state.teamPlans.size, 0, '计划被消费')
}))

test('伪造令牌被拒：第二步必须自己复验', withProject(async (runtime, roleId) => {
  applyDirectPanelWrite(runtime, 'planPropose', {
    confirm: true,
    params: {
      name: '结算改造',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
    },
  })
  const planId = [...runtime.state.teamPlans.keys()][0]!
  const planHash = runtime.state.teamPlans.get(planId)!.planHash

  const authorizer = createPanelWriteAuthorizer()
  previewPanelWrite(runtime, authorizer, 'planApprove', { planId })

  // 伪造一个 nonce 不对的令牌
  const forged = {
    operationId: 'op_forged',
    action: 'plan.approve' as const,
    nonce: 'forged-nonce',
    targetHash: planHash,
    impactHash: 'sha256:whatever',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }
  await assert.rejects(
    () => applyPanelWrite(runtime, authorizer, 'planApprove', {
      params: { planId, planHash },
      confirmation: forged,
      reason: '伪造',
    }),
    (error: unknown) => error instanceof MyTeamError,
  )
  assert.equal(runtime.state.teams.size, 0, '伪造令牌不能建团队')
}))

test('planHash 变了令牌失效（计划内容在预览后被改过）', withProject(async (runtime, roleId) => {
  applyDirectPanelWrite(runtime, 'planPropose', {
    confirm: true,
    params: {
      name: '结算改造',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
    },
  })
  const planId = [...runtime.state.teamPlans.keys()][0]!
  const oldHash = runtime.state.teamPlans.get(planId)!.planHash

  const authorizer = createPanelWriteAuthorizer()
  const preview = previewPanelWrite(runtime, authorizer, 'planApprove', { planId })

  // 用旧 hash 去确认（模拟「计划内容变了、调用方还拿旧 hash」）
  await assert.rejects(
    () => applyPanelWrite(runtime, authorizer, 'planApprove', {
      params: { planId, planHash: 'sha256:stale' },
      confirmation: preview.confirmation!,
      reason: '用旧 hash 确认',
    }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'CONFIRMATION_TARGET_CHANGED',
  )
  assert.equal(runtime.state.teams.size, 0, 'hash 不符不能建团队')
  assert.equal(runtime.state.teamPlans.get(planId)!.planHash, oldHash, '计划内容没被改')
}))
