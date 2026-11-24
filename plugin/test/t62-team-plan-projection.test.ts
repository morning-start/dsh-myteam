/**
 * t62（P1）：开队计划的契约与投影。
 *
 * 这一批只做「计划能落进状态、能被消费」，不建任何实体。锁三件事：
 *   1. `team.plan.proposed` 之后 `state.teamPlans` 有记录，且 `teams/members/runs` **仍然为空**
 *      —— 这是方案 §10 判据 1 的投影层表达（「批准前不产生会话与花费」）；
 *   2. `team.plan.approved` / `team.plan.discarded` 都会把计划从状态里删掉
 *      —— 「批准后不可回到草稿」是结构事实，不是靠字段标记；
 *   3. 计划 id 走 `plan_` 前缀，能被 `idKindOf` 认出来（防止和 teamId 混用）。
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
import { initializeProject } from '../src/application/commands.ts'
import type { TeamPlan } from '../src/contracts/entities.ts'
import { idKindOf, newId } from '../src/contracts/ids.ts'
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

function samplePlan(overrides: Partial<TeamPlan> = {}): TeamPlan {
  return {
    id: newId('plan'),
    name: '结算改造',
    goal: '把结算页模块化',
    blueprint: { id: 'bp_1', revision: 3 },
    formation: [
      { key: 'impl', roleId: 'role_1', count: 2, parentSlotKey: null },
      { key: 'reviewer', roleId: 'role_2', count: 1, parentSlotKey: null },
    ],
    workflow: { id: 'wfl_1', revision: 2 },
    captainSessionId: 'ses_captain',
    overrides: {},
    planHash: 'sha256:abc',
    proposedBy: 'captain:ses_captain',
    proposedAt: NOW,
    ...overrides,
  }
}

function withProject(body: (runtime: ProjectRuntime) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t62-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '计划投影' })
      body(runtime)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('计划 id 走 plan_ 前缀，能被 idKindOf 认出来', () => {
  const id = newId('plan')
  assert.ok(id.startsWith('plan_'), `前缀不对：${id}`)
  assert.equal(idKindOf(id), 'plan')
})

test('提案后：计划进状态，但 teams / members / runs 都还是空的', () => {
  withProject((runtime) => {
    const plan = samplePlan()
    runtime.commit([
      {
        type: 'team.plan.proposed',
        actor: HUMAN,
        entity: { kind: 'team', id: plan.id },
        payload: { plan },
      },
    ])

    assert.equal(runtime.state.teamPlans.size, 1, '计划要进状态')
    assert.equal(runtime.state.teamPlans.get(plan.id)!.name, '结算改造')
    // 判据 1：批准前不产生会话与花费 —— 结构上可验证。
    assert.equal(runtime.state.teams.size, 0, '提案不该建团队')
    assert.equal(runtime.state.members.size, 0, '提案不该建成员')
    assert.equal(runtime.state.runs.size, 0, '提案不该开 Run')
    assert.equal(runtime.state.captains.size, 0, '提案不该指派队长')
  })
})

test('批准后：计划被消费（从状态里消失）', () => {
  withProject((runtime) => {
    const plan = samplePlan()
    runtime.commit([
      {
        type: 'team.plan.proposed',
        actor: HUMAN,
        entity: { kind: 'team', id: plan.id },
        payload: { plan },
      },
    ])
    assert.equal(runtime.state.teamPlans.size, 1)

    runtime.commit([
      {
        type: 'team.plan.approved',
        actor: HUMAN,
        entity: { kind: 'team', id: plan.id },
        payload: { planId: plan.id, teamId: 'team_1', planHash: plan.planHash, runId: null },
      },
    ])

    assert.equal(runtime.state.teamPlans.size, 0, '批准后计划不该还在状态里（不可回到草稿）')
  })
})

test('丢弃后：计划被消费，且什么都没建', () => {
  withProject((runtime) => {
    const plan = samplePlan()
    runtime.commit([
      {
        type: 'team.plan.proposed',
        actor: HUMAN,
        entity: { kind: 'team', id: plan.id },
        payload: { plan },
      },
    ])
    runtime.commit([
      {
        type: 'team.plan.discarded',
        actor: HUMAN,
        entity: { kind: 'team', id: plan.id },
        payload: { planId: plan.id, reason: '不做了', discardedBy: 'human:user-1' },
      },
    ])

    assert.equal(runtime.state.teamPlans.size, 0, '丢弃后计划不该还在')
    assert.equal(runtime.state.teams.size, 0, '丢弃不该建团队')
    assert.equal(runtime.state.members.size, 0, '丢弃不该建成员')
    assert.equal(runtime.state.runs.size, 0, '丢弃不该开 Run')
  })
})

test('两份计划可以并存（不同 planId 互不覆盖）', () => {
  withProject((runtime) => {
    const first = samplePlan({ name: '甲计划' })
    const second = samplePlan({ name: '乙计划' })
    runtime.commit([
      { type: 'team.plan.proposed', actor: HUMAN, entity: { kind: 'team', id: first.id }, payload: { plan: first } },
    ])
    runtime.commit([
      { type: 'team.plan.proposed', actor: HUMAN, entity: { kind: 'team', id: second.id }, payload: { plan: second } },
    ])
    assert.equal(runtime.state.teamPlans.size, 2)
  })
})
