/**
 * t64（P2）：提案与丢弃命令。
 *
 * 这一批锁四件事：
 *   1. 提案**不建任何实体**（判据 1：批准前不产生会话与花费）；
 *   2. 校验在写盘前完成：名字空、队形空、角色不存在、蓝图/工作流不存在、蓝图引用解析不了
 *      —— 全部拒绝，且账本不动；
 *   3. `planHash` 按内容算：同样的输入 hash 相同，改一项 hash 就变；
 *   4. 丢弃只落一条事件，不碰任何实体；丢弃不存在的计划报 NOT_FOUND。
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
  createProjectRole,
  discardTeamPlanCommand,
  initializeProject,
  proposeTeamPlanCommand,
} from '../src/application/commands.ts'
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

function withProject(body: (runtime: ProjectRuntime, roleId: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t64-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '计划命令' })
      createProjectRole(runtime, {
        actor: HUMAN,
        profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
        capabilities: {
          tools: { allow: ['read'], deny: [] },
          mcp: { allow: [], deny: [] },
          skills: [],
        },
      })
      const roleId = [...runtime.state.roles.keys()][0]!
      body(runtime, roleId)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('提案：只落计划，不建团队/成员/会话/Run', () => {
  withProject((runtime, roleId) => {
    const { plan } = proposeTeamPlanCommand(runtime, {
      actor: HUMAN,
      name: '结算改造',
      goal: '把结算页模块化',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 2, parentSlotKey: null }],
    })

    assert.equal(runtime.state.teamPlans.size, 1)
    assert.equal(runtime.state.teamPlans.get(plan.id)!.name, '结算改造')
    // 判据 1
    assert.equal(runtime.state.teams.size, 0, '不该建团队')
    assert.equal(runtime.state.members.size, 0, '不该建成员')
    assert.equal(runtime.state.captains.size, 0, '不该指派队长')
    assert.equal(runtime.state.runs.size, 0, '不该开 Run')
    assert.equal(runtime.state.teamConfigs.size, 0, '不该落配置快照')
  })
})

test('提案校验：名字空 / 队形空 / 角色不存在 / 工作流不存在 全部拒绝且账本不动', () => {
  withProject((runtime, roleId) => {
    const base = {
      actor: HUMAN,
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
    }
    const reject = (input: Parameters<typeof proposeTeamPlanCommand>[1], code: string) => {
      assert.throws(
        () => proposeTeamPlanCommand(runtime, input),
        (error: unknown) => error instanceof MyTeamError && error.code === code,
      )
    }

    reject({ ...base, name: '   ' }, 'INVALID_PAYLOAD')
    reject({ ...base, name: '甲', formation: [] }, 'INVALID_PAYLOAD')
    reject({ ...base, name: '甲', formation: [{ key: 'x', roleId: 'role_missing', count: 1, parentSlotKey: null }] }, 'NOT_FOUND')
    reject({ ...base, name: '甲', formation: [{ key: 'x', roleId, count: 0, parentSlotKey: null }] }, 'INVALID_PAYLOAD')
    reject({ ...base, name: '甲', workflowId: 'wfl_missing' }, 'NOT_FOUND')
    reject({ ...base, name: '甲', blueprintId: 'bp_missing' }, 'NOT_FOUND')

    assert.equal(runtime.state.teamPlans.size, 0, '全部被拒后不该有计划落盘')
  })
})

test('planHash 按内容算：同样输入相同，改一项就变', () => {
  withProject((runtime, roleId) => {
    const input = {
      actor: HUMAN,
      name: '结算改造',
      goal: '把结算页模块化',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 2, parentSlotKey: null }],
    }
    const first = proposeTeamPlanCommand(runtime, input).plan
    const second = proposeTeamPlanCommand(runtime, input).plan
    assert.equal(first.planHash, second.planHash, '同样内容 hash 必须相同（批准令牌才可比对）')

    const changed = proposeTeamPlanCommand(runtime, {
      ...input,
      formation: [{ key: 'impl', roleId, count: 3, parentSlotKey: null }],
    }).plan
    assert.notEqual(first.planHash, changed.planHash, '队形改了 hash 必须变')

    const renamed = proposeTeamPlanCommand(runtime, { ...input, name: '另一个名字' }).plan
    assert.notEqual(first.planHash, renamed.planHash, '名字改了 hash 必须变')
  })
})

test('丢弃：只落一条事件，什么都不建', () => {
  withProject((runtime, roleId) => {
    const { plan } = proposeTeamPlanCommand(runtime, {
      actor: HUMAN,
      name: '要丢的',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
    })
    discardTeamPlanCommand(runtime, { actor: HUMAN, planId: plan.id, reason: '不做了' })

    assert.equal(runtime.state.teamPlans.size, 0, '丢弃后计划消失')
    assert.equal(runtime.state.teams.size, 0, '丢弃不该建团队')
    assert.equal(runtime.state.members.size, 0, '丢弃不该建成员')
  })
})

test('丢弃不存在的计划 → NOT_FOUND', () => {
  withProject((runtime) => {
    assert.throws(
      () => discardTeamPlanCommand(runtime, { actor: HUMAN, planId: 'plan_missing', reason: 'x' }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'NOT_FOUND',
    )
  })
})
