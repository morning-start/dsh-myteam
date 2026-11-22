/**
 * v1 → v2 候选导入（只写候选目录，不碰旧数据）。
 *
 * 支持的迁移面**刻意收窄**，并且对不支持的旧事件**阻断**而不是跳过：
 * 跳过会让「迁移后少了三个任务」看起来像成功。当前支持：
 *
 *   team.created      → team.created（无队长：旧会话不可信）
 *   member.spawned    → member.appointed（需要角色定义可解析）
 *   rules.version.adopted → 跳过并报告（版本规则只初始化一次）
 *
 * 其他事件（任务、门禁、消息、知识…）一律 `UNSUPPORTED_FOR_IMPORT` 阻断，
 * 等它们的 payload 语义被逐项确认后再开放。这比「尽力猜」诚实，也让
 * cutover 的影响面可证明。
 *
 * 写入后立即做对账：重放候选事件，与转换时声明的计数逐项比较。
 */
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { EvidenceRef, KnowledgeEntry, Member, RoleDefinition, Task, TaskStatus, Team } from '../../../contracts/entities.ts'
import { ERROR_CODES, fail, toErrorShape } from '../../../contracts/errors.ts'
import type { ActorRef, EntityRef, EventType } from '../../../contracts/events.ts'
import type { IdFactory } from '../../../contracts/ids.ts'
import { EVENTS_FILE } from '../../../contracts/versions.ts'
import { appointMember } from '../../../domain/teams/member.ts'
import { ProjectRuntime } from '../../../application/project-runtime.ts'
import type { DraftEvent } from '../../../application/project-runtime.ts'
import { rebuildProjectState } from '../../../application/projections/project-state.ts'
import { FileEventStore } from '../../event-store/file-store.ts'
import { WriterLeaseManager } from '../../event-store/writer-lease.ts'
import { ensureProjectManifest } from '../../fs/project-manifest.ts'
import type { V1Analysis, V1ImportPlan, V1LedgerEvent } from './analyze.ts'

const MIGRATION_ACTOR: ActorRef = { kind: 'system', component: 'migration-v1' }

export interface ConvertIssue {
  code: 'UNSUPPORTED_FOR_IMPORT' | 'MISSING_ROLE' | 'MISSING_FIELD' | 'UNKNOWN_TEAM_STATUS'
  severity: 'blocking' | 'warning'
  message: string
  detail?: Record<string, unknown>
}

export interface ConvertedRecord {
  order: number
  type: EventType
  entity: EntityRef
  payload: unknown
  legacy: NonNullable<DraftEvent['legacy']>
}

export interface ConversionResult {
  ok: boolean
  issues: ConvertIssue[]
  records: ConvertedRecord[]
  skipped: { type: string; count: number; reason: string }[]
  mappings: { teams: Record<string, string>; members: Record<string, string> }
  counts: { teams: number; members: number; tasks: number; knowledge: number }
  /** 每条来源事件的下场：converted / skipped / blocked。 */
  disposition: { teamId: string; seq: number; type: string; outcome: 'converted' | 'skipped' | 'blocked' }[]
}

export interface ConvertOptions {
  analysis: V1Analysis
  plan: V1ImportPlan
  now: string
  ids: IdFactory
  /** 角色定义来源；缺失时 member.spawned 阻断，不伪造角色。 */
  resolveRole: (roleId: string) => RoleDefinition | undefined
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function teamStatusOf(analysis: V1Analysis, teamId: string, issues: ConvertIssue[]): Team['status'] {
  const fromIndex = analysis.index.find((team) => team.teamId === teamId)
  const legacy = fromIndex?.state ?? 'active'
  switch (legacy) {
    case 'active':
      return 'active'
    case 'archived':
      return 'archived'
    case 'disbanded':
      return 'disbanded'
    case 'draft':
      issues.push({
        code: 'UNKNOWN_TEAM_STATUS',
        severity: 'warning',
        message: `团队 ${teamId} 的旧状态为 draft，按 active 迁移（无成员、无任务）`,
        detail: { teamId, legacy },
      })
      return 'active'
    default:
      issues.push({
        code: 'UNKNOWN_TEAM_STATUS',
        severity: 'warning',
        message: `团队 ${teamId} 的旧状态 ${legacy} 不认识，按 active 迁移`,
        detail: { teamId, legacy },
      })
      return 'active'
  }
}

/**
 * 把一个 v1 事件转成零个或多个 v2 记录；不支持的返回阻断问题。
 *
 * 纯函数：不写文件、不依赖当前时间以外的状态。
 */
export function convertV1Analysis(options: ConvertOptions): ConversionResult {
  const issues: ConvertIssue[] = []
  const records: ConvertedRecord[] = []
  const skipped = new Map<string, { count: number; reason: string }>()
  const teams = new Map<string, Team>()
  const teamMapping: Record<string, string> = {}
  const memberMapping: Record<string, string> = {}
  const members = new Map<string, Member>()
  const disposition: ConversionResult['disposition'] = []
  let convertedTasks = 0
  let convertedKnowledge = 0

  /*
   * 知识：v1 的提案/采纳是两个事件（`knowledge.proposed` + `knowledge.adopted`）。
   * 迁移保留这条链：pending 只写 proposed；adopted 写 proposed + adopted；
   * 被驳回（decision=rejected）不迁移（v2 没有「已驳回条目」，硬造会复活被否掉的知识）。
   */
  const knowledgeSeen = new Map<
    string,
    { order: number; event: V1LedgerEvent; legacy: NonNullable<DraftEvent['legacy']>; adoptedEvent: V1LedgerEvent | null; rejected: boolean }
  >()
  for (const planned of options.plan.events) {
    const event = planned.event
    if (event.type !== 'knowledge.proposed' && event.type !== 'knowledge.adopted') continue
    const draftId = asString(event.payload.draftId)
    if (draftId === null) continue
    if (event.type === 'knowledge.proposed') {
      if (!knowledgeSeen.has(draftId)) {
        knowledgeSeen.set(draftId, { order: planned.order, event, legacy: planned.legacyOrigin, adoptedEvent: null, rejected: false })
      }
      continue
    }
    const current = knowledgeSeen.get(draftId)
    if (current === undefined) continue
    if (event.payload.decision === 'rejected') current.rejected = true
    else current.adoptedEvent = event
  }

  const mapEvidencePointer = (pointer: string): EvidenceRef => {
    if (pointer.startsWith('session:')) return { kind: 'session', ref: pointer }
    if (pointer.startsWith('file:')) return { kind: 'file', ref: pointer.slice('file:'.length) }
    if (pointer.includes('/') || pointer.includes('\\') || /\.[a-z0-9]+$/i.test(pointer)) {
      return { kind: 'file', ref: pointer }
    }
    return { kind: 'artifact', ref: pointer }
  }

  /*
   * 任务状态折叠：旧账本里一个任务的状态散在 created/claimed/progress/completed…
   * 多个事件里。v2 迁移不为每条执行细节重建事件，而是**一次**写出终态任务，
   * 并在报告里说明「执行细节未逐条重放」。这样既保住当前事实，也不伪造 Attempt。
   */
  const taskIds = new Map<string, string>()
  const taskSeen = new Map<string, { order: number; event: V1LedgerEvent; teamLabel: string }>()
  const taskFinal = new Map<string, { status: TaskStatus; completedAt: string | null; touched: boolean }>()

  for (const planned of options.plan.events) {
    const event = planned.event
    const legacyTaskId =
      event.type.startsWith('task.') && typeof event.payload.taskId === 'string' ? event.payload.taskId : null
    if (legacyTaskId === null) continue

    if (event.type === 'task.created') {
      if (!taskIds.has(legacyTaskId)) taskIds.set(legacyTaskId, options.ids('task'))
      if (!taskSeen.has(legacyTaskId)) taskSeen.set(legacyTaskId, { order: planned.order, event, teamLabel: planned.teamId })
      taskFinal.set(legacyTaskId, { status: 'planned', completedAt: null, touched: false })
      continue
    }

    const current = taskFinal.get(legacyTaskId)
    if (current === undefined) continue
    switch (event.type) {
      case 'task.claimed':
        current.status = 'claimed'
        break
      case 'task.progress':
        current.status = 'in_progress'
        break
      case 'task.blocked':
      case 'task.paused':
        current.status = 'blocked'
        break
      case 'task.failed':
        current.status = 'ready'
        break
      case 'task.completed':
        current.status = 'done'
        current.completedAt = new Date(event.ts).toISOString()
        break
      case 'task.cancelled':
        current.status = 'cancelled'
        break
      default:
        break
    }
    current.touched = true
  }

  /** 只影响执行细节、不改变 v2 需要表达的事实：跳过并计数。 */
  const SKIPPED_TYPES = new Set([
    'plan.clarify',
    'plan.staged',
    'plan.revised',
    'plan.approved',
    'plan.discarded',
    'task.claimed',
    'task.assigned',
    'task.attempt.revoked',
    'task.progress',
    'task.evidence',
    'task.completed',
    'task.failed',
    'task.blocked',
    'task.paused',
    'task.escalated',
    'task.rescoped',
    'task.updated',
    'task.cancelled',
    'task.deleted',
    'task.rewired',
    'task.proposal',
    'task.proposal.resolved',
    'task.deliverable',
    'task.gate.result',
    'task.participate',
    'task.participation.released',
    'message.sent',
    'message.consumed',
    'session.read',
    'memory.audit',
    'team.updated',
    'team.disbanded',
    'member.released',
    'member.archived',
    'member.restored',
    'member.interrupted',
  ])

  const skip = (teamId: string, event: V1LedgerEvent, reason: string) => {
    const current = skipped.get(event.type) ?? { count: 0, reason }
    skipped.set(event.type, { count: current.count + 1, reason })
    disposition.push({ teamId, seq: event.seq, type: event.type, outcome: 'skipped' })
  }

  for (const planned of options.plan.events) {
    const event = planned.event
    const teamLabel = planned.teamId
    const block = (code: ConvertIssue['code'], message: string) => {
      issues.push({ code, severity: 'blocking', message, detail: { teamId: teamLabel, seq: event.seq, type: event.type } })
      disposition.push({ teamId: teamLabel, seq: event.seq, type: event.type, outcome: 'blocked' })
    }

    if (event.type === 'rules.version.adopted') {
      skip(teamLabel, event, '规则版本只初始化一次，保留旧行作为来源证据')
      continue
    }

    if (SKIPPED_TYPES.has(event.type)) {
      skip(teamLabel, event, '执行细节/历史产物不逐条重放，保留旧行作为来源证据')
      continue
    }

    if (event.type === 'task.created') {
      const legacyTaskId = asString(event.payload.taskId)
      const seen = legacyTaskId === null ? undefined : taskSeen.get(legacyTaskId)
      if (legacyTaskId === null || seen === undefined) {
        block('MISSING_FIELD', 'task.created 缺少 taskId')
        continue
      }
      if (seen.order !== planned.order) {
        skip(teamLabel, event, '任务状态已折叠进首次 task.created')
        continue
      }
      const raw = event.payload.task
      if (typeof raw !== 'object' || raw === null) {
        block('MISSING_FIELD', `task.created 缺少 task 对象（${legacyTaskId}）`)
        continue
      }
      const input = raw as Record<string, unknown>
      const title = asString(input.title)
      const acceptance = Array.isArray(input.acceptanceCriteria)
        ? input.acceptanceCriteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
      if (title === null || acceptance.length === 0) {
        block('MISSING_FIELD', `任务 ${legacyTaskId} 缺少 title 或 acceptanceCriteria`)
        continue
      }
      const mappedTeamId = teamMapping[teamLabel]
      if (mappedTeamId === undefined) {
        block('MISSING_FIELD', `任务 ${legacyTaskId} 的主责团队没有迁移成功`)
        continue
      }

      const final = taskFinal.get(legacyTaskId)!
      let status = final.status
      if (status === 'claimed' || status === 'in_progress') {
        issues.push({
          code: 'UNKNOWN_TEAM_STATUS',
          severity: 'warning',
          message: `任务 ${legacyTaskId} 迁移时仍在执行，已回落为 ready（旧 Attempt 不迁移）`,
          detail: { legacyTaskId },
        })
        status = 'ready'
      }

      const depsLegacy = Array.isArray(input.deps)
        ? input.deps.filter((item): item is string => typeof item === 'string')
        : []
      const dependencies: string[] = []
      for (const dependency of depsLegacy) {
        const mapped = taskIds.get(dependency)
        if (mapped === undefined) {
          issues.push({
            code: 'MISSING_FIELD',
            severity: 'warning',
            message: `任务 ${legacyTaskId} 的依赖 ${dependency} 没有迁移，依赖边已丢弃`,
            detail: { legacyTaskId, dependency },
          })
          continue
        }
        dependencies.push(mapped)
      }

      const deliverableSpec = input.deliverableSpec
      const deliverablePath =
        typeof deliverableSpec === 'object' && deliverableSpec !== null && typeof (deliverableSpec as { path?: unknown }).path === 'string'
          ? (deliverableSpec as { path: string }).path
          : null
      const verifyCommand = input.verifyCommand
      const verifyArgv =
        typeof verifyCommand === 'object' && verifyCommand !== null && Array.isArray((verifyCommand as { argv?: unknown }).argv)
          ? ((verifyCommand as { argv: unknown[] }).argv.filter((item): item is string => typeof item === 'string'))
          : null

      const task: Task = {
        id: taskIds.get(legacyTaskId)!,
        title,
        description: asString(input.description) ?? '',
        acceptance,
        status,
        ownerTeamId: mappedTeamId,
        collaborators: [],
        dependencies,
        runId: null,
        templateKey: null,
        requiredRoleId: asString(input.requiredRole),
        gate: {
          commands: verifyArgv === null || verifyArgv.length === 0 ? [] : [verifyArgv.join(' ')],
          requireEvidence: true,
          requireArtifacts: deliverablePath !== null,
        },
        deliverable: deliverablePath === null ? null : { paths: [deliverablePath], description: '' },
        attemptId: null,
        revision: 1,
        createdAt: new Date(event.ts).toISOString(),
        updatedAt: options.now,
        completedAt: final.completedAt,
      }

      records.push({
        order: planned.order,
        type: 'task.created',
        entity: { kind: 'task', id: task.id, teamId: mappedTeamId },
        payload: { task, graphRevision: 1 },
        legacy: planned.legacyOrigin,
      })
      convertedTasks += 1
      disposition.push({ teamId: teamLabel, seq: event.seq, type: event.type, outcome: 'converted' })
      continue
    }

    if (event.type === 'knowledge.proposed') {
      const draftId = asString(event.payload.draftId)
      const seen = draftId === null ? undefined : knowledgeSeen.get(draftId)
      if (draftId === null || seen === undefined) {
        block('MISSING_FIELD', 'knowledge.proposed 缺少 draftId')
        continue
      }
      if (seen.order !== planned.order) {
        skip(teamLabel, event, '知识状态已折叠进首次提案')
        continue
      }
      if (seen.rejected) {
        skip(teamLabel, event, '旧提案已被驳回，v2 不保留驳回条目')
        continue
      }
      const draft = event.payload.draft
      const draftRecord = typeof draft === 'object' && draft !== null ? (draft as Record<string, unknown>) : null
      const title = draftRecord === null ? null : asString(draftRecord.title)
      const body = draftRecord === null ? null : asString(draftRecord.body)
      const evidencePointer = draftRecord === null ? null : asString(draftRecord.evidence)
      if (title === null || body === null || evidencePointer === null) {
        block('MISSING_FIELD', `知识提案 ${draftId} 缺少 title/body/evidence`)
        continue
      }

      const entryId = options.ids('knowledge')
      const entry: KnowledgeEntry = {
        id: entryId,
        title,
        body,
        evidence: [mapEvidencePointer(evidencePointer)],
        status: 'proposed',
        supersedes: null,
        revision: 1,
        createdAt: new Date(event.ts).toISOString(),
        updatedAt: options.now,
      }
      records.push({
        order: planned.order,
        type: 'knowledge.proposed',
        entity: { kind: 'knowledge-entry', id: entryId },
        payload: { entry },
        legacy: planned.legacyOrigin,
      })
      if (seen.adoptedEvent !== null) {
        records.push({
          order: planned.order,
          type: 'knowledge.adopted',
          entity: { kind: 'knowledge-entry', id: entryId },
          payload: { entryId, revision: 2, adoptedBy: 'migration' },
          legacy: planned.legacyOrigin,
        })
      }
      convertedKnowledge += 1
      disposition.push({ teamId: teamLabel, seq: event.seq, type: event.type, outcome: 'converted' })
      continue
    }

    if (event.type === 'knowledge.adopted') {
      skip(teamLabel, event, '采纳已折叠进 knowledge.proposed 记录')
      continue
    }

    if (event.type === 'team.created') {
      const name = asString(event.payload.name)
      const goal = asString(event.payload.goal)
      if (name === null || goal === null) {
        block('MISSING_FIELD', `team.created 缺少 name/goal（${teamLabel}）`)
        continue
      }
      const teamId = options.ids('team')
      teamMapping[teamLabel] = teamId
      const status = teamStatusOf(options.analysis, teamLabel, issues)
      const team: Team = {
        id: teamId,
        name,
        goal,
        status,
        blueprint: null,
        configRevision: 1,
        revision: 1,
        createdAt: options.now,
        updatedAt: options.now,
      }
      teams.set(teamId, team)
      records.push({
        order: planned.order,
        type: 'team.created',
        entity: { kind: 'team', id: teamId },
        payload: { team, captain: null, formation: [] },
        legacy: planned.legacyOrigin,
      })
      disposition.push({ teamId: teamLabel, seq: event.seq, type: event.type, outcome: 'converted' })
      continue
    }

    if (event.type === 'member.spawned') {
      const legacyMemberId = asString(event.payload.memberId)
      const roleId = asString(event.payload.roleId)
      if (legacyMemberId === null || roleId === null) {
        block('MISSING_FIELD', 'member.spawned 缺少 memberId/roleId')
        continue
      }
      const mappedTeamId = teamMapping[teamLabel]
      if (mappedTeamId === undefined) {
        block('MISSING_FIELD', `成员 ${legacyMemberId} 所属团队没有迁移成功`)
        continue
      }
      const role = options.resolveRole(roleId)
      if (role === undefined) {
        block('MISSING_ROLE', `成员 ${legacyMemberId} 引用的角色 ${roleId} 无法解析`)
        continue
      }
      const parentLegacyId = asString(event.payload.parentMemberId)
      const parent = parentLegacyId === null ? null : (members.get(parentLegacyId) ?? null)
      const { member } = appointMember({
        id: options.ids('member'),
        teamId: mappedTeamId,
        role,
        parent,
        sessionId: null,
        now: options.now,
      })
      memberMapping[legacyMemberId] = member.id
      members.set(legacyMemberId, member)
      records.push({
        order: planned.order,
        type: 'member.appointed',
        entity: { kind: 'member', id: member.id, teamId: mappedTeamId },
        payload: { member, roleRevision: role.revision, parentMemberId: member.parentMemberId },
        legacy: planned.legacyOrigin,
      })
      disposition.push({ teamId: teamLabel, seq: event.seq, type: event.type, outcome: 'converted' })
      continue
    }

    block('UNSUPPORTED_FOR_IMPORT', `暂不支持迁移事件 ${event.type}（${teamLabel} seq=${event.seq}）`)
  }

  const blocking = issues.some((issue) => issue.severity === 'blocking')
  return {
    ok: !blocking,
    issues,
    records,
    skipped: [...skipped.entries()].map(([type, value]) => ({ type, count: value.count, reason: value.reason })),
    mappings: { teams: teamMapping, members: memberMapping },
    counts: { teams: teams.size, members: members.size, tasks: convertedTasks, knowledge: convertedKnowledge },
    disposition,
  }
}

export interface CandidateWriteOptions {
  candidateRoot: string
  projectId: string
  projectName: string
  now: string
  ids: IdFactory
  clock: { now(): string }
  /** 分析时的来源 hash；即使零业务事件也要落盘，cutover 靠它判断源是否变化。 */
  sourceHashes?: { teamId: string; sourceHash: string }[]
}

export interface CandidateWriteResult {
  rootDir: string
  projectId: string
  written: number
  seq: number
  verification: {
    ok: boolean
    teams: number
    members: number
    tasks: number
    knowledge: number
    expectedTeams: number
    expectedMembers: number
    expectedTasks: number
    expectedKnowledge: number
    problems: string[]
  }
}

/**
 * 把转换结果写进候选目录，并立即对账。
 *
 * 候选目录是**独立项目**：manifest + events。旧工作区一个字节都不动。
 * 写入后重放事件，确认团队/成员数量与转换时声明一致——对不上就说明转换
 * 或投影有 bug，必须在 cutover 前暴露。
 */
export function writeCandidateProject(conversion: ConversionResult, options: CandidateWriteOptions): CandidateWriteResult {
  if (!conversion.ok) {
    fail(ERROR_CODES.MIGRATION_BLOCKED, '转换存在阻断问题，不能写候选目录', {
      details: { issues: conversion.issues as unknown as import('../../../contracts/json.ts').JsonValue },
    })
  }

  const manifest = ensureProjectManifest(options.candidateRoot, {
    projectId: options.projectId,
    name: options.projectName,
    createdAt: options.now,
  })

  // 迁移证据单独落盘：rules-only 的候选没有任何带 legacy 的事件，
  // cutover 仍需要来源 hash 才能证明「候选没有过期」。
  writeFileSync(
    join(options.candidateRoot, '.dsh-myteam', 'migration.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: options.now,
        projectId: manifest.projectId,
        sourceHashes: options.sourceHashes ?? [],
        counts: conversion.counts,
        skipped: conversion.skipped,
      },
      null,
      2,
    ),
  )

  const runtime = ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(options.candidateRoot, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(options.candidateRoot, '.dsh-myteam/state/writer.lock')),
    clock: options.clock,
    ids: options.ids,
  })

  try {
    runtime.commit([
      {
        type: 'project.initialized',
        actor: MIGRATION_ACTOR,
        entity: { kind: 'project', id: manifest.projectId },
        payload: { name: options.projectName, createdAt: options.now },
      },
    ])

    if (conversion.records.length > 0) {
      const drafts: DraftEvent[] = conversion.records.map((record) => ({
        type: record.type,
        actor: MIGRATION_ACTOR,
        entity: record.entity,
        payload: record.payload,
        legacy: record.legacy,
        entityRevision: 1,
      }))
      runtime.commit(drafts)
    }
  } finally {
    runtime.close()
  }

  // 对账：从磁盘重放，而不是相信内存。
  const store = new FileEventStore(join(options.candidateRoot, EVENTS_FILE))
  const { events } = store.readCommitted()
  const rebuilt = rebuildProjectState(manifest.projectId, events)
  const problems: string[] = []
  if (rebuilt.teams.size !== conversion.counts.teams) {
    problems.push(`团队数量不符：投影 ${rebuilt.teams.size}，转换 ${conversion.counts.teams}`)
  }
  if (rebuilt.members.size !== conversion.counts.members) {
    problems.push(`成员数量不符：投影 ${rebuilt.members.size}，转换 ${conversion.counts.members}`)
  }
  if (rebuilt.tasks.size !== conversion.counts.tasks) {
    problems.push(`任务数量不符：投影 ${rebuilt.tasks.size}，转换 ${conversion.counts.tasks}`)
  }
  if (rebuilt.knowledge.size !== conversion.counts.knowledge) {
    problems.push(`知识数量不符：投影 ${rebuilt.knowledge.size}，转换 ${conversion.counts.knowledge}`)
  }
  for (const record of conversion.records) {
    if (record.type === 'team.created' && !rebuilt.teams.has((record.payload as { team: Team }).team.id)) {
      problems.push(`投影缺少团队 ${(record.payload as { team: Team }).team.id}`)
    }
  }

  return {
    rootDir: options.candidateRoot,
    projectId: manifest.projectId,
    written: events.length,
    seq: rebuilt.seq,
    verification: {
      ok: problems.length === 0,
      teams: rebuilt.teams.size,
      members: rebuilt.members.size,
      tasks: rebuilt.tasks.size,
      knowledge: rebuilt.knowledge.size,
      expectedTeams: conversion.counts.teams,
      expectedMembers: conversion.counts.members,
      expectedTasks: conversion.counts.tasks,
      expectedKnowledge: conversion.counts.knowledge,
      problems,
    },
  }
}

/** 把非法输入收敛成可读错误（CLI 用）。 */
export function explainImportError(error: unknown): string {
  const shape = toErrorShape(error)
  return `${shape.code}: ${shape.message}`
}