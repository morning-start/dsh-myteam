import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyCaptainHost } from '../src/composition/host.ts'
import { apply as applyMemberHost } from '../src/composition/member.ts'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import {
  appointMemberCommand,
  claimTaskCommand,
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'panel' }
const NOW = '2026-01-01T00:00:00.000Z'
const CAPTAIN_SESSION = 'ses_captain_01'
const MEMBER_SESSION = 'ses_member_01'

interface FakeTool {
  name: string
  execute(args: unknown, exec: { agent?: { id: string } }): Promise<unknown>
}

function fakeContext(): { ctx: never; tools: Map<string, FakeTool>; cleanups: (() => void)[] } {
  const tools = new Map<string, FakeTool>()
  const cleanups: (() => void)[] = []
  const ctx = {
    tools: {
      register(definition: unknown) {
        const tool = definition as FakeTool
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(execute: () => () => void) {
      cleanups.push(execute())
    },
  }
  return { ctx: ctx as never, tools, cleanups }
}

/** 预置一个已建好团队/成员/任务的项目，然后关闭运行时，让 host 自己打开。 */
function seedProject(rootDir: string): { projectId: string; teamId: string; taskId: string; attemptId: string } {
  const manifest = ensureProjectManifest(rootDir, { projectId: newId('project'), createdAt: NOW })
  const runtime = ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(rootDir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(rootDir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
  try {
    initializeProject(runtime, { actor: HUMAN, name: '工具项目' })
    const role = createProjectRole(runtime, {
      actor: HUMAN,
      profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
      capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
    })
    const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id
    const team = createTeamCommand(runtime, {
      actor: HUMAN,
      name: '工具队',
      goal: 'g',
      captainSessionId: CAPTAIN_SESSION,
    })
    const teamId = (team.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id
    const member = appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, sessionId: MEMBER_SESSION })
    const memberId = (member.events[0]!.payload as { member: { id: string } }).member.id
    const task = createTaskCommand(runtime, {
      actor: HUMAN,
      title: '被工具认领的任务',
      description: '',
      acceptance: ['x'],
      ownerTeamId: teamId,
      requiredRoleId: roleId,
    })
    const taskId = (task.events[0]!.payload as { task: { id: string } }).task.id
    claimTaskCommand(runtime, { actor: HUMAN, taskId, memberId })
    const attemptId = runtime.state.tasks.get(taskId)!.attemptId!
    return { projectId: manifest.projectId, teamId, taskId, attemptId }
  } finally {
    runtime.close()
  }
}

test('队长装配：注册全部 Lead 工具且不泄漏成员工具', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-tools-'))
  try {
    seedProject(dir)
    const { ctx, tools, cleanups } = fakeContext()
    applyCaptainHost(ctx, { projectRoot: dir })
    const names = [...tools.keys()].sort()
    assert.ok(names.includes('myteam_read_board'))
    assert.ok(names.includes('myteam_create_task'))
    assert.ok(names.includes('myteam_review_task'))
    assert.ok(!names.includes('myteam_progress'), '队长不应注册成员执行工具')
    for (const cleanup of cleanups) cleanup()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('队长工具：create_task 走同一条命令路径并写进项目事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-tools-'))
  try {
    seedProject(dir)
    const { ctx, tools, cleanups } = fakeContext()
    applyCaptainHost(ctx, { projectRoot: dir })
    try {
      const createTask = tools.get('myteam_create_task')!
      const result = (await createTask.execute(
        { title: '工具建的任务', acceptance: ['ok'], description: '' },
        { agent: { id: CAPTAIN_SESSION } },
      )) as { ok: boolean; data?: { taskId: string }; error?: { code: string } }
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.match(result.data!.taskId, /^task_/)

      const board = (await tools.get('myteam_read_board')!.execute({}, { agent: { id: CAPTAIN_SESSION } })) as {
        ok: boolean
        data: { totals: { all: number } }
      }
      assert.equal(board.ok, true)
      assert.equal(board.data.totals.all, 2)
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('队长工具：未知会话返回 FORBIDDEN 而不是猜一个团队', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-tools-'))
  try {
    seedProject(dir)
    const { ctx, tools, cleanups } = fakeContext()
    applyCaptainHost(ctx, { projectRoot: dir })
    try {
      const result = (await tools.get('myteam_read_team')!.execute({}, { agent: { id: 'ses_stranger' } })) as {
        ok: boolean
        error?: { code: string }
      }
      assert.equal(result.ok, false)
      assert.equal(result.error!.code, 'FORBIDDEN')
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('成员装配：只有三条执行工具，且能提交自己 Attempt 的事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-tools-'))
  try {
    const { taskId, attemptId } = seedProject(dir)
    const { ctx, tools, cleanups } = fakeContext()
    applyMemberHost(ctx, { projectRoot: dir })
    try {
      const names = [...tools.keys()].sort()
      assert.deepEqual(names, ['myteam_evidence', 'myteam_progress', 'myteam_submit_review'])

      const evidence = (await tools.get('myteam_evidence')!.execute(
        { taskId, attemptId, evidence: [{ kind: 'command', ref: 'npm test', excerpt: '3 passed' }] },
        { agent: { id: MEMBER_SESSION } },
      )) as { ok: boolean; error?: { code: string } }
      assert.equal(evidence.ok, true, JSON.stringify(evidence))

      const progress = (await tools.get('myteam_progress')!.execute(
        { taskId, attemptId, note: '实现中', percent: 40 },
        { agent: { id: MEMBER_SESSION } },
      )) as { ok: boolean; error?: { code: string } }
      assert.equal(progress.ok, true, JSON.stringify(progress))

      const submitted = (await tools.get('myteam_submit_review')!.execute(
        { taskId, attemptId },
        { agent: { id: MEMBER_SESSION } },
      )) as { ok: boolean; error?: { code: string } }
      assert.equal(submitted.ok, true, JSON.stringify(submitted))

      // 再提交一次：任务已在 review，不应再接受重复提交。
      const again = (await tools.get('myteam_submit_review')!.execute(
        { taskId, attemptId },
        { agent: { id: MEMBER_SESSION } },
      )) as { ok: boolean; error?: { code: string } }
      assert.equal(again.ok, false)
      assert.equal(again.error!.code, 'INVALID_TRANSITION')
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('队长装配：项目根取会话工作目录，而不是进程 cwd', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'myteam-session-'))
  const tools = new Map<string, FakeTool>()
  const ctx = {
    tools: {
      register(definition: unknown) {
        const tool = definition as FakeTool
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(execute: () => () => void) {
      execute()
    },
    agents: { get: (id: string) => (id === 'ses_web' ? { id: 'ses_web' } : undefined) },
    workingDirectory: { ensure: async () => sessionDir },
  }

  try {
    applyCaptainHost(ctx as never, {})
    const result = (await tools.get('myteam_read_board')!.execute({}, { agent: { id: 'ses_web' } })) as {
      ok: boolean
      error?: { code: string; details?: { path?: string } }
    }
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(existsSync(join(sessionDir, '.dsh-myteam', 'manifest.json')), '应在会话目录建项目')
  } finally {
    rmSync(sessionDir, { recursive: true, force: true })
  }
})