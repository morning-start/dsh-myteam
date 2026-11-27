/**
 * 团队生命周期用例：建队、改状态、配置 rebase。
 *
 * 建队只落计划（见 team-plan.ts）；真正落团队的是计划批准，所以这里没有「改蓝图」
 * 之外的重入口。由 {@link ../commands.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { computeEffectiveConfig } from '../../domain/config/merge.ts'
import { assertBlueprintResolvable } from '../../domain/definitions/blueprint.ts'
import { authorize } from '../../domain/permissions/policy.ts'
import { assertTeamActive, assertTeamStatusChange, createTeam } from '../../domain/teams/team.ts'
import type { ConfigOverrides } from '../../contracts/entities.ts'
import type { ActorRef } from '../../contracts/events.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from '../project-runtime.ts'

export function createTeamCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    name: string
    goal: string
    captainSessionId: string
    blueprintId?: string
    overrides?: ConfigOverrides
  },
): CommitResult {
  authorize('team.create', input.actor)
  const state = runtime.state
  const now = runtime.now()

  let blueprintDefaults: ConfigOverrides | null = null
  let blueprintRef: { id: string; revision: number } | null = null
  if (input.blueprintId !== undefined) {
    const blueprint = state.blueprints.get(input.blueprintId)
    if (blueprint === undefined) {
      fail(ERROR_CODES.NOT_FOUND, '蓝图不存在', { details: { blueprintId: input.blueprintId } })
    }
    assertBlueprintResolvable(
      blueprint,
      (roleId) => state.roles.get(roleId),
      (workflowId) => state.workflows.get(workflowId),
    )
    blueprintDefaults = blueprint.defaults
    blueprintRef = { id: blueprint.id, revision: blueprint.revision }
  }

  const configRevision = state.configRevision + 1
  const snapshot = computeEffectiveConfig({
    projectDefaults: state.configDefaults as ConfigOverrides,
    blueprintDefaults,
    teamOverrides: input.overrides ?? {},
    configRevision,
    sources: {
      projectDefaultsRevision: state.configRevision,
      blueprintRevision: blueprintRef?.revision ?? null,
      teamOverridesRevision: 1,
    },
  })

  const teamId = runtime.nextId('team')
  const team = createTeam({
    id: teamId,
    name: input.name,
    goal: input.goal,
    blueprint: blueprintRef,
    configRevision: snapshot.configRevision,
    now,
  })

  const drafts: DraftEvent[] = [
    {
      type: 'config.override.changed',
      actor: input.actor,
      entity: { kind: 'config', id: teamId, teamId },
      payload: { teamId, configRevision, overrides: input.overrides ?? {}, snapshot },
    },
    {
      type: 'team.created',
      actor: input.actor,
      entity: { kind: 'team', id: teamId },
      entityRevision: 1,
      configRevision,
      payload: {
        team,
        captain: { sessionId: input.captainSessionId, generation: 1 },
        formation: [],
      },
    },
  ]

  return runtime.commit(drafts)
}

export function rebaseTeamConfigCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    teamId: string
    overrides: ConfigOverrides
    expectedConfigRevision: number
  },
): CommitResult {
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  }
  authorize('config.rebase', input.actor, { teamId: input.teamId })
  assertTeamActive(team)

  if (team.configRevision !== input.expectedConfigRevision) {
    fail(ERROR_CODES.PRECONDITION_FAILED, '团队配置已被修改，请重读差异后重试', {
      details: { expectedConfigRevision: input.expectedConfigRevision, currentConfigRevision: team.configRevision },
    })
  }

  const blueprint =
    team.blueprint === null ? undefined : state.blueprints.get(team.blueprint.id)
  const configRevision = team.configRevision + 1
  const snapshot = computeEffectiveConfig({
    projectDefaults: state.configDefaults as ConfigOverrides,
    blueprintDefaults: blueprint?.defaults ?? null,
    teamOverrides: input.overrides,
    configRevision,
    sources: {
      projectDefaultsRevision: state.configRevision,
      blueprintRevision: team.blueprint?.revision ?? null,
      teamOverridesRevision: configRevision,
    },
  })

  const draft: DraftEvent = {
    type: 'config.rebased',
    actor: input.actor,
    entity: { kind: 'config', id: input.teamId, teamId: input.teamId },
    payload: {
      teamId: input.teamId,
      configRevision,
      previousRevision: team.configRevision,
      snapshot,
    },
  }
  return runtime.commit([draft])
}

export function changeTeamStatusCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; teamId: string; status: 'active' | 'archived' | 'disbanded'; reason?: string },
): CommitResult {
  const team = runtime.state.teams.get(input.teamId)
  if (team === undefined) fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  if (input.status === 'disbanded') authorize('team.disband', input.actor, { teamId: input.teamId })
  else authorize('team.archive', input.actor, { teamId: input.teamId })
  assertTeamStatusChange(team.status, input.status)

  const revision = team.revision + 1
  const draft: DraftEvent =
    input.status === 'disbanded'
      ? {
          type: 'team.disbanded',
          actor: input.actor,
          entity: { kind: 'team', id: input.teamId },
          entityRevision: revision,
          payload: { teamId: input.teamId, revision, reason: input.reason ?? '用户确认解散' },
        }
      : {
          type: 'team.archived',
          actor: input.actor,
          entity: { kind: 'team', id: input.teamId },
          entityRevision: revision,
          payload: { teamId: input.teamId, revision },
        }
  return runtime.commit([draft])
}
