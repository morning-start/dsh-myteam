/**
 * 执行（第二步）：凭令牌确认后执行，以及 direct 类动作的显式 `confirm`。
 *
 * 两类确认的区别只在「要不要令牌」：令牌类走同一签发器复核，direct 类由
 * 前端在用户点过提交后置 `confirm: true`——所以每个方法都必须自己守住语义。
 * 由 {@link ../panel-writes.ts} 统一重导出。
 */
import type { GateVerdict, Task } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { editGlobalDefinition } from '../global-edit.ts'
import { HumanAuthorizer } from '../../domain/permissions/human-authorizer.ts'
import type { HumanConfirmation } from '../../domain/permissions/human-authorizer.ts'
import { appointMemberCommand, archiveMemberCommand, claimTaskCommand, createProjectBlueprint, createTaskCommand, createTeamCommand, releaseMemberCommand, restoreMemberCommand, saveProjectBlueprintCommand, saveProjectRole, saveProjectWorkflowCommand } from '../commands.ts'
import { forgetMemory, rememberMemory } from '../memory-commands.ts'
import { discardTeamPlanCommand, proposeTeamPlanCommand } from '../commands.ts'
import { confirmTeamPlanApproval } from '../human-actions.ts'
import { confirmDefinitionPublication } from '../publication.ts'
import { confirmCaptainTakeover, confirmTeamDisband } from '../human-actions.ts'
import type { ProjectRuntime } from '../project-runtime.ts'
import { cancelTaskCommand, recordVerdictCommand, reopenTaskCommand } from '../task-commands.ts'
import type { PanelWriteApplied, PanelWriteDeps } from './deps.ts'
import { requireGlobalEditor, requireGlobalEntries, requireMemory, requirePublicationKind, requirePublisher } from './deps.ts'
import type { DirectPanelWriteMethod, TokenPanelWriteMethod } from './methods.ts'
import { PANEL_HUMAN } from './methods.ts'
import { optionalString, optionalStringArray, requireChecks, requireEvidenceList, requireFormation, requireOutcome, requireOverrides, requireString, requireStringArray, requireTeamId } from './params.ts'
import { previewGlobalEdit } from './previews.ts'

/**
 * 第二步：凭令牌确认并执行。
 * @param runtime - 项目运行时（已打开，状态须是最新）。
 * @param authorizer - 与预览同一实例（令牌登记在它里面）。
 * @param method - 白名单方法名。
 * @param input - 令牌、参数与人类填写的理由。
 * @param deps - 额外端口（全局发布用）。
 */
export async function applyPanelWrite(
  runtime: ProjectRuntime,
  authorizer: HumanAuthorizer,
  method: TokenPanelWriteMethod,
  input: { params: Record<string, unknown>; confirmation: HumanConfirmation; reason: string },
  deps: PanelWriteDeps = {},
): Promise<PanelWriteApplied> {
  switch (method) {
    case 'planApprove': {
      const planId = requireString(input.params, 'planId')
      const planHash = requireString(input.params, 'planHash')
      const result = confirmTeamPlanApproval(runtime, { authorizer }, {
        actor: PANEL_HUMAN,
        planId,
        planHash,
        startRun: input.params.startRun !== false,
        operationId: input.confirmation.operationId,
        confirmation: input.confirmation,
      })
      return { method, operationId: input.confirmation.operationId, committed: result }
    }
    case 'globalDefinitionSave': {
      // 第二步：**必须自己复验令牌**。预览时签的 targetHash 是「当时的文件 hash」，
      // 已通过 expectedHash 把它带回来 —— 这里重新算一遍当前文件 hash 与令牌绑定，
      // 目标/影响面任一变化都拒（这道校验不能省，否则伪造令牌可以直写全局库）。
      const kind = requirePublicationKind(input.params)
      const id = requireString(input.params, 'id')
      const raw = input.params.expectedHash
      if (raw !== null && typeof raw !== 'string') {
        fail(ERROR_CODES.INVALID_PAYLOAD, 'expectedHash 必须是字符串或 null')
      }
      const currentHash = requireGlobalEditor(deps).readFileHash(kind, id)
      const currentTargetHash = currentHash === null ? 'sha256:absent' : currentHash
      const preview = previewGlobalEdit(deps, { kind, id, definition: input.params.definition })
      authorizer.verify(input.confirmation, {
        operationId: input.confirmation.operationId,
        action: 'definition.global.write',
        targetHash: currentTargetHash,
        impactHash: preview.impactHash,
      })
      authorizer.consume(input.confirmation)
      const result = editGlobalDefinition(
        { editor: requireGlobalEditor(deps), globalEntries: requireGlobalEntries(deps) },
        {
          actor: PANEL_HUMAN,
          kind,
          id,
          definition: input.params.definition,
          expectedHash: raw,
          operationId: input.confirmation.operationId,
          editedAt: runtime.now(),
          editor: 'panel:owner',
        },
      )
      return { method, operationId: result.id, committed: result }
    }
    case 'teamDisband': {
      const teamId = requireTeamId(input.params)
      const result = confirmTeamDisband(runtime, { authorizer }, {
        actor: PANEL_HUMAN,
        teamId,
        operationId: input.confirmation.operationId,
        confirmation: input.confirmation,
        reason: input.reason,
      })
      return { method, operationId: input.confirmation.operationId, committed: result }
    }
    case 'captainTakeover': {
      const teamId = requireTeamId(input.params)
      const toSessionId = requireString(input.params, 'toSessionId')
      const result = confirmCaptainTakeover(runtime, { authorizer }, {
        actor: PANEL_HUMAN,
        teamId,
        toSessionId,
        operationId: input.confirmation.operationId,
        confirmation: input.confirmation,
      })
      return { method, operationId: input.confirmation.operationId, committed: result }
    }
    case 'gateVerdict':
      fail(ERROR_CODES.INVALID_COMMAND, 'gateVerdict 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'taskCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskCreate 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'taskMove':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskMove 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'teamCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'teamCreate 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberAppoint':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberAppoint 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberArchive':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberArchive 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberRestore':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRestore 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memberRelease':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRelease 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'memoryRemember':
    case 'memoryForget':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 不使用确认令牌，请走 applyDirectPanelWrite`)
    case 'definitionSave':
      fail(ERROR_CODES.INVALID_COMMAND, 'definitionSave 不使用确认令牌，请走 applyDirectPanelWrite')
    case 'definitionPublish': {
      const result = confirmDefinitionPublication(runtime, { authorizer, publisher: requirePublisher(deps) }, {
        actor: PANEL_HUMAN,
        operationId: input.confirmation.operationId,
        kind: requirePublicationKind(input.params),
        id: requireString(input.params, 'id'),
        confirmation: input.confirmation,
      })
      return {
        method,
        operationId: input.confirmation.operationId,
        committed: { file: result.file, globalHash: result.globalHash },
      }
    }
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}

/** 直接执行类写动作的入参：`confirm` 是面板层的显式确认位。 */
export interface PanelDirectWriteInput {
  params: Record<string, unknown>
  /** 前端必须在用户点过「提交」之后才置 true；缺省或 false 一律拒绝。 */
  confirm: boolean
}

/**
 * 直接执行类写动作。
 *
 * 与 `applyPanelWrite` 的区别只在确认方式：这里没有令牌，`confirm: true` 就是
 * 「我已经看过并同意」。所以**每个方法都必须自己守住语义**——`gateVerdict` 依赖
 * `recordVerdictCommand` 的两道域校验（任务须在 `review`、`attemptId` 须为当前
 * Attempt），而不是依赖调用方老实。
 *
 * @param runtime - 项目运行时（已刷新到最新账本）。
 * @param method - 白名单方法名，且其 `PanelWriteKind` 必须是 `direct`。
 * @param input - 参数与确认位。
 * @param deps - 额外端口（写记忆需要存储实现与项目根）。
 */
export function applyDirectPanelWrite(
  runtime: ProjectRuntime,
  method: DirectPanelWriteMethod,
  input: PanelDirectWriteInput,
  deps: PanelWriteDeps = {},
): PanelWriteApplied {
  switch (method) {
    case 'planPropose': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '提案计划需要 confirm: true（会写进事件账本）')
      }
      const proposed = proposeTeamPlanCommand(runtime, {
        actor: PANEL_HUMAN,
        name: requireString(input.params, 'name'),
        goal: optionalString(input.params, 'goal') ?? '',
        captainSessionId: requireString(input.params, 'captainSessionId'),
        blueprintId: optionalString(input.params, 'blueprintId'),
        formation: requireFormation(input.params),
        workflowId: optionalString(input.params, 'workflowId'),
        overrides: requireOverrides(input.params),
      })
      return { method, operationId: proposed.plan.id, committed: { plan: proposed.plan } }
    }
    case 'planDiscard': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '丢弃计划需要 confirm: true（会写进事件账本）')
      }
      const planId = requireString(input.params, 'planId')
      discardTeamPlanCommand(runtime, {
        actor: PANEL_HUMAN,
        planId,
        reason: optionalString(input.params, 'reason') ?? '',
      })
      return { method, operationId: planId, committed: { discarded: true } }
    }
    case 'gateVerdict': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '门禁裁决需要 confirm: true（一次判定会写进事件账本，不能撤销）')
      }
      const taskId = requireString(input.params, 'taskId')
      const attemptId = requireString(input.params, 'attemptId')
      const outcome = requireOutcome(input.params)
      const checks = requireChecks(input.params)
      const evidence = requireEvidenceList(input.params)

      const result = recordVerdictCommand(runtime, {
        actor: PANEL_HUMAN,
        taskId,
        attemptId,
        outcome,
        checks,
        evidence,
      })
      const verdict = (result.events.find((event) => event.type === 'task.verdict')!.payload as { verdict: GateVerdict })
        .verdict
      return {
        method,
        operationId: verdict.id,
        committed: {
          verdict,
          taskStatus: runtime.state.tasks.get(taskId)?.status ?? null,
        },
      }
    }
    case 'teamDisband':
    case 'captainTakeover':
    case 'globalDefinitionSave':
    case 'globalUnpublish':
    case 'projectDestroy':
    case 'definitionPublish':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 走确认令牌通道（先预览再确认），不能直接执行`)
    case 'memoryRemember': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '写记忆需要 confirm: true')
      }
      // 先把参数验完再开库：参数错误不该在磁盘上留下一个空记忆库。
      const teamId = requireTeamId(input.params)
      const memberId = optionalString(input.params, 'memberId')
      const text = requireString(input.params, 'text')
      const tags = optionalStringArray(input.params, 'tags')
      const evidence = optionalStringArray(input.params, 'evidence')
      const { memory } = requireMemory(deps)
      try {
        const record = rememberMemory(
          { memory, ids: (kind) => runtime.nextId(kind), now: runtime.now() },
          {
            actor: PANEL_HUMAN,
            teamId,
            ...(memberId === undefined ? {} : { memberId }),
            text,
            ...(tags === undefined ? {} : { tags }),
            ...(evidence === undefined ? {} : { evidence }),
          },
        )
        return { method, operationId: record.id, committed: record }
      } finally {
        memory.close()
      }
    }
    case 'memoryForget': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '遗忘记忆需要 confirm: true')
      }
      // 同样先验参数：缺 id 时不该动到库。
      const teamId = requireTeamId(input.params)
      const memberId = optionalString(input.params, 'memberId')
      const id = requireString(input.params, 'id')
      const hard = input.params.hard === true
      const { memory } = requireMemory(deps)
      try {
        forgetMemory(
          { memory, ids: (kind) => runtime.nextId(kind), now: runtime.now() },
          {
            actor: PANEL_HUMAN,
            teamId,
            ...(memberId === undefined ? {} : { memberId }),
            id,
            reason: optionalString(input.params, 'reason') ?? '面板遗忘',
            hard,
          },
        )
        return { method, operationId: id, committed: { id, hard } }
      } finally {
        memory.close()
      }
    }
    case 'taskCreate': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '新建任务需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const title = requireString(input.params, 'title')
      const description = optionalString(input.params, 'description') ?? ''
      const acceptance = requireStringArray(input.params, 'acceptance')
      const dependencies = optionalStringArray(input.params, 'dependencies')

      const result = createTaskCommand(runtime, {
        actor: PANEL_HUMAN,
        title,
        description,
        acceptance,
        ownerTeamId: teamId,
        ...(dependencies === undefined ? {} : { dependencies }),
      })
      const task = (result.events.find((event) => event.type === 'task.created')!.payload as { task: Task }).task
      return {
        method,
        operationId: task.id,
        committed: {
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            ownerTeamId: task.ownerTeamId,
            dependencies: task.dependencies,
            requiredRoleId: task.requiredRoleId,
          },
        },
      }
    }
    case 'definitionSave': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '保存定义需要 confirm: true')
      const kind = requireString(input.params, 'kind')
      // 蓝图允许不带 id（= 新建）；角色/工作流必须带 id（走修订）。
      const id = kind === 'blueprint'
        ? (optionalString(input.params, 'id') ?? '')
        : requireString(input.params, 'id')
      if (kind === 'role') {
        const profile = input.params.profile
        if (typeof profile !== 'object' || profile === null) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '角色 profile 必须是对象', { details: { kind, id } })
        }
        saveProjectRole(runtime, {
          actor: PANEL_HUMAN,
          id,
          profile: profile as never,
          capabilities: (input.params.capabilities ?? { tools: { allow: [], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] }) as never,
        })
        return { method, operationId: id, committed: { kind, id } }
      }
      if (kind === 'workflow') {
        const templates = input.params.templates
        if (!Array.isArray(templates)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '工作流 templates 必须是数组', { details: { kind, id } })
        }
        saveProjectWorkflowCommand(runtime, {
          actor: PANEL_HUMAN,
          id,
          name: requireString(input.params, 'name'),
          description: optionalString(input.params, 'description') ?? '',
          templates: templates as never,
          ...(input.params.completion === undefined ? {} : { completion: input.params.completion as never }),
        })
        return { method, operationId: id, committed: { kind, id } }
      }
      if (kind === 'blueprint') {
        const formation = input.params.formation
        if (!Array.isArray(formation)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图 formation 必须是数组', { details: { kind, id } })
        }
        const workflows = input.params.workflows
        if (!Array.isArray(workflows)) {
          fail(ERROR_CODES.INVALID_PAYLOAD, '蓝图 workflows 必须是数组', { details: { kind, id } })
        }
        const fields = {
          actor: PANEL_HUMAN,
          name: requireString(input.params, 'name'),
          description: optionalString(input.params, 'description') ?? '',
          formation: formation as never,
          workflows: workflows as string[],
          defaults: (input.params.defaults ?? {}) as never,
        }
        // id 为空视为「新建」：面板建蓝图不需要先有一个空壳。
        if (id.length === 0) {
          const created = createProjectBlueprint(runtime, fields)
          const event = created.events.find((entry) => entry.type === 'definition.blueprint.created')
          const blueprint = (event?.payload as { blueprint?: { id: string } } | undefined)?.blueprint
          return { method, operationId: blueprint?.id ?? '', committed: { kind, id: blueprint?.id ?? '' } }
        }
        saveProjectBlueprintCommand(runtime, { ...fields, id })
        return { method, operationId: id, committed: { kind, id } }
      }
      fail(ERROR_CODES.INVALID_PAYLOAD, 'definitionSave 只支持 kind = role / workflow / blueprint', {
        details: { kind },
      })
    }
    case 'taskMove': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '移动任务需要 confirm: true')
      const taskId = requireString(input.params, 'taskId')
      const targetStatus = requireString(input.params, 'targetStatus')
      const reason = optionalString(input.params, 'reason') ?? '面板移动任务'
      if (targetStatus === 'cancelled') {
        cancelTaskCommand(runtime, { actor: PANEL_HUMAN, taskId, reason })
        return { method, operationId: taskId, committed: { taskId, status: 'cancelled' } }
      }
      if (targetStatus === 'ready') {
        reopenTaskCommand(runtime, { actor: PANEL_HUMAN, taskId, reason })
        return { method, operationId: taskId, committed: { taskId, status: 'ready' } }
      }
      if (targetStatus === 'claimed') {
        const memberId = requireString(input.params, 'memberId')
        claimTaskCommand(runtime, { actor: PANEL_HUMAN, taskId, memberId })
        return { method, operationId: taskId, committed: { taskId, status: 'claimed', memberId } }
      }
      fail(ERROR_CODES.INVALID_PAYLOAD, 'taskMove 只支持 targetStatus = cancelled / ready / claimed；完成（done）必须走门禁裁决', {
        details: { targetStatus },
      })
    }
    case 'teamCreate': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '建团队需要 confirm: true')
      const name = requireString(input.params, 'name')
      const goal = requireString(input.params, 'goal')
      const captainSessionId = requireString(input.params, 'captainSessionId')
      const blueprintId = optionalString(input.params, 'blueprintId')
      const result = createTeamCommand(runtime, {
        actor: PANEL_HUMAN,
        name,
        goal,
        captainSessionId,
        ...(blueprintId === undefined ? {} : { blueprintId }),
      })
      const created = result.events.find((event) => event.type === 'team.created')
      if (created === undefined) fail(ERROR_CODES.INTERNAL, '建团队没有产生 team.created 事件')
      const team = (created.payload as { team: { id: string; name: string } }).team
     return { method, operationId: team.id, committed: { teamId: team.id, name: team.name, captainSessionId } }
    }
    case 'memberAppoint': {
      if (input.confirm !== true) fail(ERROR_CODES.INVALID_PAYLOAD, '召唤成员需要 confirm: true')
      const teamId = requireString(input.params, 'teamId')
      const roleId = requireString(input.params, 'roleId')
      const parentMemberId = optionalString(input.params, 'parentMemberId')
      const sessionId = optionalString(input.params, 'sessionId')
      const result = appointMemberCommand(runtime, {
        actor: PANEL_HUMAN,
        teamId,
        roleId,
        ...(parentMemberId === undefined ? {} : { parentMemberId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      const appointed = result.events.find((event) => event.type === 'member.appointed')
      if (appointed === undefined) fail(ERROR_CODES.INTERNAL, '召唤成员没有产生 member.appointed 事件')
      const member = (appointed.payload as { member: { id: string; status: string } }).member
      return { method, operationId: member.id, committed: { memberId: member.id, teamId, roleId, status: member.status } }
    }
    case 'memberArchive': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '归档成员需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const memberId = requireString(input.params, 'memberId')
      const drainRaw = optionalString(input.params, 'drain')
      if (drainRaw !== undefined && drainRaw !== 'wait' && drainRaw !== 'pause') {
        fail(ERROR_CODES.INVALID_PAYLOAD, 'drain 只能是 wait 或 pause', { details: { drain: drainRaw } })
      }
      archiveMemberCommand(runtime, {
        actor: PANEL_HUMAN,
        teamId,
        memberId,
        ...(drainRaw === undefined ? {} : { drain: drainRaw }),
      })
      return { method, operationId: memberId, committed: { memberId, teamId, status: 'archived' } }
    }
    case 'memberRestore': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '恢复成员需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const memberId = requireString(input.params, 'memberId')
      restoreMemberCommand(runtime, { actor: PANEL_HUMAN, teamId, memberId })
      return { method, operationId: memberId, committed: { memberId, teamId, status: 'active' } }
    }
    case 'memberRelease': {
      if (input.confirm !== true) {
        fail(ERROR_CODES.INVALID_PAYLOAD, '释放成员需要 confirm: true')
      }
      const teamId = requireString(input.params, 'teamId')
      const memberId = requireString(input.params, 'memberId')
      const result = releaseMemberCommand(runtime, { actor: PANEL_HUMAN, teamId, memberId })
      const released = result.events.find((event) => event.type === 'member.released')
      if (released === undefined) {
        fail(ERROR_CODES.INTERNAL, '释放成员没有产生 member.released 事件', { details: { memberId } })
      }
      return { method, operationId: memberId, committed: { memberId, teamId, status: 'released' } }
    }
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}
