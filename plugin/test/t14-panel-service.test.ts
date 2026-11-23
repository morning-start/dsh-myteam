import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { PanelService } from '../src/application/panel-service.ts'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import {
  appointMemberCommand,
  createProjectRole,
  createTaskCommand,
  createTeamCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { proposeKnowledgeCommand } from '../src/application/knowledge-commands.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'
import { PROTOCOL_VERSION } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'panel' }
const NOW = '2026-01-01T00:00:00.000Z'

function seed(rootDir: string): { teamA: string; teamB: string; taskId: string; roleId: string } {
  const manifest = ensureProjectManifest(rootDir, { projectId: newId('project'), createdAt: NOW })
  const runtime = ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(rootDir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(rootDir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
  try {
    initializeProject(runtime, { actor: HUMAN, name: '面板项目' })
    const role = createProjectRole(runtime, {
      actor: HUMAN,
      profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
      capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
    })
    const roleId = (role.events[0]!.payload as { role: { id: string } }).role.id

    const teamA = createTeamCommand(runtime, { actor: HUMAN, name: '甲队', goal: 'a', captainSessionId: 'ses_a' })
    const teamAId = (teamA.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id
    const teamB = createTeamCommand(runtime, { actor: HUMAN, name: '乙队', goal: 'b', captainSessionId: 'ses_b' })
    const teamBId = (teamB.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } }).team.id

    appointMemberCommand(runtime, { actor: HUMAN, teamId: teamAId, roleId, sessionId: 'ses_member_a' })

    const task = createTaskCommand(runtime, {
      actor: HUMAN,
      title: '甲队任务',
      description: '',
      acceptance: ['x'],
      ownerTeamId: teamAId,
    })
    const taskId = (task.events[0]!.payload as { task: { id: string } }).task.id
    createTaskCommand(runtime, {
      actor: HUMAN,
      title: '乙队任务',
      description: '',
      acceptance: ['x'],
      ownerTeamId: teamBId,
      dependencies: [taskId],
    })
    proposeKnowledgeCommand(runtime, {
      actor: HUMAN,
      title: '知识',
      body: '正文',
      evidence: [{ kind: 'file', ref: 'docs/x.md' }],
    })
    return { teamA: teamAId, teamB: teamBId, taskId, roleId }
  } finally {
    runtime.close()
  }
}

function makeService(rootDir: string, withMigration = false): { service: PanelService; hosts: ProjectHosts } {
  const hosts = new ProjectHosts()
  const service = new PanelService({
    hosts,
    ...(withMigration
      ? {
          analyzeMigration: () => ({ verdict: 'ready' as const, headline: '可导入', markdown: '# ok' }),
        }
      : {}),
  })
  void rootDir
  return { service, hosts }
}

test('面板：status/overview/board 来自同一投影', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const { service, hosts } = makeService(dir)
  try {
    const { teamA, taskId } = seed(dir)

    const status = await service.invoke(dir, { protocolVersion: PROTOCOL_VERSION, method: 'status' })
    assert.equal(status.ok, true)
    const statusData = (status as { ok: true; data: { counts: { teams: number; tasks: number; knowledge: number } } }).data
    assert.equal(statusData.counts.teams, 2)
    assert.equal(statusData.counts.tasks, 2)
    assert.equal(statusData.counts.knowledge, 1)

    const overview = await service.invoke(dir, { method: 'overview' })
    assert.equal(overview.ok, true)
    const overviewData = (overview as { ok: true; data: { totals: { all: number }; teams: { id: string }[] } }).data
    assert.equal(overviewData.totals.all, 2)
    assert.equal(overviewData.teams.length, 2)

    const board = await service.invoke(dir, { method: 'board' })
    assert.equal(board.ok, true)
    const boardData = (board as { ok: true; data: { columns: { status: string; count: number }[]; totals: { all: number } } }).data
    assert.equal(boardData.totals.all, 2)
    assert.equal(boardData.columns.find((column) => column.status === 'ready')!.count, 1)

    const task = await service.invoke(dir, { method: 'task', params: { taskId } })
    assert.equal(task.ok, true)
    const taskData = (task as { ok: true; data: { task: { title: string }; team: { id: string } } }).data
    assert.equal(taskData.task.title, '甲队任务')
    assert.equal(taskData.team.id, teamA)

    const team = await service.invoke(dir, { method: 'team', params: { teamId: teamA } })
    assert.equal(team.ok, true)
    const teamData = (team as { ok: true; data: { members: unknown[] } }).data
    assert.equal(teamData.members.length, 1)
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：定义清单带 lineage 字段，不猜上游状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const { service, hosts } = makeService(dir)
  try {
    seed(dir)
    const definitions = await service.invoke(dir, { method: 'definitions' })
    assert.equal(definitions.ok, true)
    const data = (definitions as {
      ok: true
      data: { items: { kind: string; name: string; localChanged: boolean; upstreamChanged: null; updateAvailable: null; detail: unknown }[] }
    }).data
    assert.equal(data.items.length, 1)
    assert.equal(data.items[0]!.kind, 'role')
    assert.equal(data.items[0]!.name, '实现者')
    assert.equal(data.items[0]!.localChanged, false)
    assert.equal(data.items[0]!.upstreamChanged, null)
    assert.equal(data.items[0]!.updateAvailable, null)
    // 详情页要用的正文：角色给 profile + capabilities（缺了就只能显示一行名字）。
    const roleDetail = data.items[0]!.detail as { profile: { name: string }; capabilities: { tools: { allow: string[] } } }
    assert.equal(roleDetail.profile.name, '实现者')
    assert.deepEqual(roleDetail.capabilities.tools.allow, ['read'])
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：协议版本、未知方法与缺参数都被结构化拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const { service, hosts } = makeService(dir)
  try {
    seed(dir)

    const wrongVersion = await service.invoke(dir, { protocolVersion: PROTOCOL_VERSION + 1, method: 'status' })
    assert.equal(wrongVersion.ok, false)
    assert.equal((wrongVersion as { error: { code: string } }).error.code, 'UNSUPPORTED_PROTOCOL_VERSION')

    const unknownMethod = await service.invoke(dir, { method: 'drop_all_tables' })
    assert.equal(unknownMethod.ok, false)
    assert.equal((unknownMethod as { error: { code: string } }).error.code, 'INVALID_COMMAND')

    const missingParam = await service.invoke(dir, { method: 'task', params: {} })
    assert.equal(missingParam.ok, false)
    assert.equal((missingParam as { error: { code: string } }).error.code, 'INVALID_PAYLOAD')

    const notFoundTask = await service.invoke(dir, { method: 'task', params: { taskId: 'task_99999999' } })
    assert.equal(notFoundTask.ok, false)
    assert.equal((notFoundTask as { error: { code: string } }).error.code, 'NOT_FOUND')
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：迁移分析未装配时明确报错，装配后返回注入结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const without = makeService(dir)
  try {
    const result = await without.service.invoke(dir, { method: 'migration' })
    assert.equal(result.ok, false)
    assert.equal((result as { error: { code: string } }).error.code, 'INTERNAL')
  } finally {
    await without.hosts.closeAll()
  }

  const withAnalyzer = makeService(dir, true)
  try {
    const result = await withAnalyzer.service.invoke(dir, { method: 'migration' })
    assert.equal(result.ok, true)
    assert.deepEqual((result as { ok: true; data: unknown }).data, {
      verdict: 'ready',
      headline: '可导入',
      markdown: '# ok',
    })
  } finally {
    await withAnalyzer.hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('面板：知识、Effect 与配置面的只读形状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const { service, hosts } = makeService(dir)
  try {
    seed(dir)

    const knowledge = await service.invoke(dir, { method: 'knowledge' })
    assert.equal(knowledge.ok, true)
    const knowledgeData = (knowledge as { ok: true; data: { items: { title: string; body: string; evidence: unknown[] }[] } }).data
    assert.equal(knowledgeData.items.length, 1)
    assert.equal(typeof knowledgeData.items[0]!.title, 'string')
    assert.ok(Array.isArray(knowledgeData.items[0]!.evidence), '知识条目必须带证据引用数组')

    const effects = await service.invoke(dir, { method: 'effects' })
    assert.equal(effects.ok, true)
    const effectsData = (effects as { ok: true; data: { items: unknown[]; counts: Record<string, number> } }).data
    assert.ok(Array.isArray(effectsData.items))
    for (const key of ['requested', 'accepted', 'completed', 'failed', 'cancelled', 'outcome-unknown']) {
      assert.equal(typeof effectsData.counts[key], 'number', `effects.counts 缺 ${key}`)
    }

    const settings = await service.invoke(dir, { method: 'settings' })
    assert.equal(settings.ok, true)
    const settingsData = (settings as { ok: true; data: { configRevision: number; teams: unknown[] } }).data
    assert.equal(typeof settingsData.configRevision, 'number')
    assert.ok(Array.isArray(settingsData.teams))
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：审计是新→旧分页，beforeSeq 往前翻，limit 有边界', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const { service, hosts } = makeService(dir)
  try {
    seed(dir)

    const first = await service.invoke(dir, { method: 'audit', params: { limit: 3 } })
    assert.equal(first.ok, true)
    const firstData = (first as { ok: true; data: { items: { seq: number }[]; nextBeforeSeq: number | null } }).data
    assert.equal(firstData.items.length, 3)
    assert.ok(firstData.items[0]!.seq > firstData.items[2]!.seq, '必须是新→旧')
    assert.equal(typeof firstData.nextBeforeSeq, 'number')

    const second = await service.invoke(dir, {
      method: 'audit',
      params: { limit: 3, beforeSeq: firstData.nextBeforeSeq },
    })
    assert.equal(second.ok, true)
    const secondData = (second as { ok: true; data: { items: { seq: number }[] } }).data
    assert.ok(secondData.items[0]!.seq < firstData.nextBeforeSeq!, '第二页要比第一页更旧')

    const bad = await service.invoke(dir, { method: 'audit', params: { limit: 0 } })
    assert.equal(bad.ok, false)
    assert.equal((bad as { error: { code: string } }).error.code, 'INVALID_PAYLOAD')
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：运行清单与运行详情（缺 runId / 不存在都结构化拒绝）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const { service, hosts } = makeService(dir)
  try {
    seed(dir)

    const runs = await service.invoke(dir, { method: 'runs' })
    assert.equal(runs.ok, true)
    assert.deepEqual((runs as { ok: true; data: { items: unknown[] } }).data.items, [])

    const missing = await service.invoke(dir, { method: 'run', params: {} })
    assert.equal(missing.ok, false)
    assert.equal((missing as { error: { code: string } }).error.code, 'INVALID_PAYLOAD')

    const notFound = await service.invoke(dir, { method: 'run', params: { runId: 'run_99999999' } })
    assert.equal(notFound.ok, false)
    assert.equal((notFound as { error: { code: string } }).error.code, 'NOT_FOUND')
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板：全局库方法不打开项目，走注入的全局根', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-panel-'))
  const globalDir = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  const hosts = new ProjectHosts()
  const service = new PanelService({ hosts, globalLibrary: { library: () => ({ exists: false, entries: [], counts: {} }), audit: (limit: number) => ({ items: [], limit }) } })
  try {
    const lib = await service.invokeGlobal('globalLibrary', {})
    assert.equal(lib.ok, true)
    assert.equal((lib as { ok: true; data: { exists: boolean } }).data.exists, false, '没有全局库时如实返回 exists: false')

    const bad = await service.invokeGlobal('globalAudit', { limit: 0 })
    assert.equal(bad.ok, false)
    assert.equal((bad as { error: { code: string } }).error.code, 'INVALID_PAYLOAD')

    const unknown = await service.invokeGlobal('board', {})
    assert.equal(unknown.ok, false, '项目方法不能走全局入口')
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
    rmSync(globalDir, { recursive: true, force: true })
  }
})