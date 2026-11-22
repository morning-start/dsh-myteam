/**
 * 团队与队长任期（纯规则）。
 *
 * 「项目写者」和「团队队长」是两种锁，不能互相替代（docs/architecture/01 §9.4）：
 *   - 写者防物理分叉：同一项目同时只有一个进程能追加事件；
 *   - 队长任期防业务指令冲突：同一团队同时只有一个有效 generation。
 *
 * 因此这里只处理后者：generation 单调递增、旧 generation 一律拒绝、
 * handoff 必须由人类确认后才推进。队长是否在线不影响这个判定。
 */
import type { CaptainAssignment, Team, TeamStatus } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'

export function createTeam(input: {
  id: string
  name: string
  goal: string
  blueprint: Team['blueprint']
  configRevision: number
  now: string
}): Team {
  if (input.name.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '团队名称不能为空')
  }
  return {
    id: input.id,
    name: input.name.trim(),
    goal: input.goal.trim(),
    status: 'active',
    blueprint: input.blueprint,
    configRevision: input.configRevision,
    graphRevision: 1,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

const TEAM_TRANSITIONS: Readonly<Record<TeamStatus, readonly TeamStatus[]>> = {
  active: ['archived', 'disbanded'],
  archived: ['active'],
  disbanded: [],
}

export function canChangeTeamStatus(from: TeamStatus, to: TeamStatus): boolean {
  return (TEAM_TRANSITIONS[from] ?? []).includes(to)
}

export function assertTeamStatusChange(from: TeamStatus, to: TeamStatus): void {
  if (!canChangeTeamStatus(from, to)) {
    fail(ERROR_CODES.INVALID_TRANSITION, `团队状态不能从 ${from} 变为 ${to}`, {
      details: { from, to },
    })
  }
}

/** 团队必须处于 active 才能接新的派遣、认领与配置变更。 */
export function assertTeamActive(team: Team): void {
  if (team.status !== 'active') {
    fail(ERROR_CODES.TEAM_NOT_ACTIVE, `团队当前状态为 ${team.status}，不能执行该操作`, {
      details: { teamId: team.id, status: team.status },
    })
  }
}

/**
 * 实体乐观锁。
 *
 * 前置条件不匹配时返回当前 revision，调用方重读后重建意图；服务端不会
 * 「尽力合并」，因为团队改名与成员任命同时冲突时，合并结果没有唯一正确答案。
 */
export function assertRevision(current: number, expected: number, what: string): void {
  if (current !== expected) {
    fail(ERROR_CODES.PRECONDITION_FAILED, `${what} 已被修改，请重读后重试`, {
      details: { current, expected },
    })
  }
}

/** DAG 版本只随图结构变化递增，不被无关消息/进度事件推进。 */
export function assertGraphRevision(current: number, expected: number): void {
  if (current !== expected) {
    fail(ERROR_CODES.PRECONDITION_FAILED, '任务图已被修改，请重读 DAG 后重试', {
      details: { currentGraphRevision: current, expectedGraphRevision: expected },
    })
  }
}

export function nextCaptainGeneration(previous: CaptainAssignment | null): number {
  return previous === null ? 1 : previous.generation + 1
}

/**
 * 队长指令必须携带当前 generation。
 *
 * 不做「generation 更新就顺手接受」：旧队长在 handoff 之后仍可能继续发指令，
 * 顺手接受等于 handoff 没发生。因此旧 generation 一律拒绝，要求调用方停止。
 */
export function assertCaptainGeneration(current: CaptainAssignment | null, generation: number): void {
  if (current === null) {
    fail(ERROR_CODES.CAPTAIN_GENERATION_STALE, '该团队还没有队长任期', { details: { generation } })
  }
  if (current.generation !== generation) {
    fail(ERROR_CODES.CAPTAIN_GENERATION_STALE, '队长 generation 已过期', {
      details: { current: current.generation, provided: generation },
    })
  }
}

export function assertCaptainTeam(current: CaptainAssignment | null, teamId: string): CaptainAssignment {
  if (current === null || current.teamId !== teamId) {
    fail(ERROR_CODES.CAPTAIN_GENERATION_STALE, '当前会话不是该团队的队长', {
      details: { teamId, assignedTeamId: current?.teamId ?? null },
    })
  }
  return current
}

/** 应用一次团队变更并推进 revision。 */
export function reviseTeam(team: Team, patch: { name?: string; goal?: string }, now: string): Team {
  assertTeamActive(team)
  return {
    ...team,
    name: patch.name === undefined ? team.name : patch.name.trim(),
    goal: patch.goal === undefined ? team.goal : patch.goal.trim(),
    revision: team.revision + 1,
    updatedAt: now,
  }
}