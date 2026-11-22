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
import type { Member, RoleDefinition, Team } from '../../../contracts/entities.ts'
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
  counts: { teams: number; members: number }
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
    counts: { teams: teams.size, members: members.size },
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
    expectedTeams: number
    expectedMembers: number
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
      expectedTeams: conversion.counts.teams,
      expectedMembers: conversion.counts.members,
      problems,
    },
  }
}

/** 把非法输入收敛成可读错误（CLI 用）。 */
export function explainImportError(error: unknown): string {
  const shape = toErrorShape(error)
  return `${shape.code}: ${shape.message}`
}