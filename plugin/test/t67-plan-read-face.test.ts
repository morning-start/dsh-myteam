/**
 * t67（P5）：读面与工具 —— 计划出现在「待你确认」里。
 *
 * 锁四件事（对应方案 §10 判据 1、6）：
 *   1. 提案后 `pendingApprovalsView` 里出现 `kind: 'plan'` 的卡，且
 *      **teams / members / runs 仍然为空**（「批准前不产生会话与花费」从读面也能看出来）；
 *   2. 卡的文案给出影响面：几名成员、几个任务、批准后开不开 Run；
 *   3. 批准 / 丢弃后卡片消失（计划被消费）；
 *   4. `unsupported.planApproval` 已经是 false —— 四类都覆盖了，不再有「假装有」的说明。
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
  approveTeamPlanCommand,
  createProjectRole,
  createProjectWorkflowCommand,
  discardTeamPlanCommand,
  initializeProject,
  proposeTeamPlanCommand,
} from '../src/application/commands.ts'
import { pendingApprovalsView } from '../src/application/queries.ts'
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
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t67-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '计划读面' })
      createProjectRole(runtime, {
        actor: HUMAN,
        profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
        capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
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

test('提案后：待确认里有计划卡，且团队/成员/Run 仍然为空', () => {
  withProject((runtime, roleId) => {
    const { plan } = proposeTeamPlanCommand(runtime, {
      actor: HUMAN,
      name: '结算改造',
      goal: '把结算页模块化',
      captainSessionId: 'ses_captain',
      formation: [
        { key: 'impl', roleId, count: 2, parentSlotKey: null },
        { key: 'reviewer', roleId, count: 1, parentSlotKey: null },
      ],
    })

    const view = pendingApprovalsView(runtime.state)
    const card = view.pending.find((item) => item.kind === 'plan')
    assert.ok(card !== undefined, '待确认里必须出现计划卡')
    assert.equal(card!.id, plan.id)
    assert.ok(card!.title.includes('结算改造'), `标题要带团队名：${card!.title}`)
    assert.ok(card!.detail?.includes('3 名成员') ?? false, `要写清成员数：${card!.detail}`)
    assert.ok(card!.detail?.includes('批准前不建会话') ?? false, '要写明批准前不建会话')
    assert.equal(card!.by, 'human:user-1')

    // 判据 1：读面上也能验证「还没花钱」
    assert.equal(runtime.state.teams.size, 0)
    assert.equal(runtime.state.members.size, 0)
    assert.equal(runtime.state.runs.size, 0)
  })
})

test('带工作流的计划：卡片要写「几个任务 · 批准后开 Run」', () => {
  withProject((runtime, roleId) => {
    createProjectWorkflowCommand(runtime, {
      actor: HUMAN,
      name: '交付流',
      description: '',
      templates: [
        {
          key: 'impl',
          title: '实现',
          description: '',
          acceptance: ['可验证'],
          requiredRoleId: roleId,
          dependsOn: [],
          gate: { commands: [], requireEvidence: false, requireArtifacts: false },
          deliverable: null,
        },
      ],
    })
    const workflowId = [...runtime.state.workflows.keys()][0]!
    proposeTeamPlanCommand(runtime, {
      actor: HUMAN,
      name: '带流计划',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
      workflowId,
    })

    const card = pendingApprovalsView(runtime.state).pending.find((item) => item.kind === 'plan')
    assert.ok(card !== undefined)
    assert.ok(card!.detail?.includes('1 个任务') ?? false, `要写任务数：${card!.detail}`)
    assert.ok(card!.detail?.includes('批准后开 Run') ?? false, `要写明会开 Run：${card!.detail}`)
  })
})

test('批准后计划卡消失', () => {
  withProject((runtime, roleId) => {
    const { plan } = proposeTeamPlanCommand(runtime, {
      actor: HUMAN,
      name: '要批的',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
    })
    assert.equal(pendingApprovalsView(runtime.state).pending.filter((i) => i.kind === 'plan').length, 1)

    approveTeamPlanCommand(runtime, { actor: HUMAN, planId: plan.id, planHash: plan.planHash, startRun: false })
    assert.equal(
      pendingApprovalsView(runtime.state).pending.filter((i) => i.kind === 'plan').length,
      0,
      '批准后不该还有计划卡',
    )
  })
})

test('丢弃后计划卡消失，且什么都没建', () => {
  withProject((runtime, roleId) => {
    const { plan } = proposeTeamPlanCommand(runtime, {
      actor: HUMAN,
      name: '要丢的',
      goal: '目标',
      captainSessionId: 'ses_captain',
      formation: [{ key: 'impl', roleId, count: 1, parentSlotKey: null }],
    })
    discardTeamPlanCommand(runtime, { actor: HUMAN, planId: plan.id, reason: '不做了' })
    assert.equal(pendingApprovalsView(runtime.state).pending.filter((i) => i.kind === 'plan').length, 0)
    assert.equal(runtime.state.teams.size, 0)
  })
})

test('unsupported：计划批准已覆盖（不再标未覆盖）', () => {
  withProject((runtime) => {
    const view = pendingApprovalsView(runtime.state)
    assert.equal(view.unsupported.planApproval, false, '计划批准已接通')
    assert.equal(view.unsupported.captainTakeover, false, '队长接管已接通')
  })
})
