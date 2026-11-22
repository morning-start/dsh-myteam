/**
 * 共享夹具：把一个任务推进到「评审中」。
 *
 * 为什么单独抽出来：门禁裁决、任务完成、面板写通道三组用例都需要一个**已提交评审**
 * 的任务，而它的前置条件是一串有先后约束的命令（建队 → 任命 → 建任务 → 认领 →
 * 进度 → 证据 → 提交评审）。内联复制过一次（t28）之后就能看到代价：反例用例里
 * 九十行脚手架，读者分不清哪几行才是它真正在测的东西；约束一变还要逐处同步。
 *
 * 夹具只负责造状态，**不含任何断言**（断言留在各用例里）；负责自己清理临时目录，
 * 用完调用 `dispose()`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appointMemberCommand,
  claimTaskCommand,
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
} from '../../src/application/commands.ts'
import { ProjectRuntime } from '../../src/application/project-runtime.ts'
import { recordEvidenceCommand, recordProgressCommand, submitReviewCommand } from '../../src/application/task-commands.ts'
import type { ActorRef } from '../../src/contracts/events.ts'
import { newId } from '../../src/contracts/ids.ts'
import { ensureProjectManifest } from '../../src/infrastructure/fs/project-manifest.ts'
import { FileEventStore } from '../../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../../src/infrastructure/event-store/writer-lease.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../../src/contracts/versions.ts'

/** 夹具里所有命令的发起人：单属主部署下的人类入口。 */
export const FIXTURE_HUMAN: ActorRef = { kind: 'human', userId: 'fixture', via: 'host' }

/** 固定时钟：事件时间与 `decidedAt` 可预期，断言不必迁就真实时间。 */
export const FIXTURE_NOW = '2026-01-01T00:00:00.000Z'

export interface ReviewTaskFixture {
  /** 临时项目根（用例若要另外打开运行时，直接用这个目录）。 */
  dir: string
  runtime: ProjectRuntime
  teamId: string
  roleId: string
  memberId: string
  taskId: string
  /** 当前 Attempt：门禁裁决必须带它，过期的 Attempt 会得到 ATTEMPT_STALE。 */
  attemptId: string
  /** 关运行时并删除临时目录；重复调用无副作用。 */
  dispose: () => void
}

export interface ReviewTaskFixtureOptions {
  /** 临时目录前缀，方便在失败时认出是哪个用例漏了清理。 */
  prefix?: string
  taskTitle?: string
}

/**
 * 建一个「已提交评审」的项目。
 *
 * 只依赖文件系统临时目录，不碰 `$DSH_HOME`，也不读全局库。
 */
export function createReviewTaskFixture(options: ReviewTaskFixtureOptions = {}): ReviewTaskFixture {
  const dir = mkdtempSync(join(tmpdir(), options.prefix ?? 'myteam-review-'))
  const manifest = ensureProjectManifest(dir, { projectId: newId('project'), createdAt: FIXTURE_NOW })
  const runtime = ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(dir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(dir, WRITER_LOCK_FILE)),
    clock: { now: () => FIXTURE_NOW },
    ids: newId,
  })

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    const human = FIXTURE_HUMAN
    initializeProject(runtime, { actor: human, name: '夹具项目' })

    const role = createProjectRole(runtime, {
      actor: human,
      profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
      capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
    })
    const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id

    const team = createTeamCommand(runtime, { actor: human, name: '夹具队', goal: '交付', captainSessionId: 'ses_fixture_captain' })
    const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id

    const member = appointMemberCommand(runtime, { actor: human, teamId, roleId, sessionId: 'ses_fixture_member' })
    const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id

    const task = createTaskCommand(runtime, {
      actor: human,
      title: options.taskTitle ?? '待评审任务',
      description: '',
      acceptance: ['返回 ok'],
      ownerTeamId: teamId,
    })
    const taskId = (task.events.find((event) => event.type === 'task.created')!.payload as { task: { id: string } }).task.id

    const claim = claimTaskCommand(runtime, { actor: human, taskId, memberId })
    const attemptId = (claim.events.find((event) => event.type === 'task.claimed')!.payload as { attempt: { id: string } })
      .attempt.id

    recordProgressCommand(runtime, {
      actor: human,
      taskId,
      attemptId,
      memberId,
      note: '实现完成，待评审',
      percent: 100,
    })
    recordEvidenceCommand(runtime, {
      actor: human,
      taskId,
      attemptId,
      memberId,
      evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
    })
    submitReviewCommand(runtime, { actor: human, taskId, attemptId, memberId })

    return { dir, runtime, teamId, roleId, memberId, taskId, attemptId, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
