/**
 * myteam 工具定义（与宿主无关的部分）。
 *
 * 工具只做三件事：解析参数 → 解析调用者身份 → 调用应用用例。
 * 它们**不**读账本、不合并配置、不判断权限；那些都在应用与领域层。这样面板
 * RPC 与工具调用走的是同一条命令路径，不会出现「面板能建、工具不能建」。
 *
 * 身份来自会话绑定，不接受参数声明（见 actor-resolution）。
 */
import type { ActorRef } from '../contracts/events.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ErrorShape } from '../contracts/errors.ts'
import type { JsonValue } from '../contracts/json.ts'
import type { EvidenceRef, GateCheckResult, VerdictOutcome } from '../contracts/entities.ts'
import { resolveAgentActor, resolveMemberActor } from './actor-resolution.ts'
import {
  appointMemberCommand,
  claimTaskCommand,
  createProjectWorkflowCommand,
  createTaskCommand,
  createTeamCommand,
} from './commands.ts'
import { completeTaskCommand, recordEvidenceCommand, recordProgressCommand, recordVerdictCommand, submitReviewCommand } from './task-commands.ts'
import { startWorkflowRunCommand } from './run-commands.ts'
import { adoptKnowledgeCommand, proposeKnowledgeCommand } from './knowledge-commands.ts'
import { boardView, taskDetail, teamView } from './queries.ts'
import type { ProjectRuntime } from './project-runtime.ts'

export interface ToolRuntimeContext {
  runtime: ProjectRuntime
  sessionId: string
}

export interface MyTeamToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  outputSchema: Record<string, unknown>
  execute(args: unknown, context: ToolRuntimeContext): Promise<JsonValue> | JsonValue
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    data: { type: 'object' },
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
  required: ['ok'],
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '工具参数必须是对象')
  }
  return args as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `缺少参数 ${key}`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(ERROR_CODES.INVALID_PAYLOAD, `参数 ${key} 必须是字符串`)
  return value
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `参数 ${key} 必须是字符串数组`)
  }
  return value as string[]
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, `参数 ${key} 必须是数字`)
  }
  return value
}

/** 工具输出只需要可读 JSON：undefined 在序列化层被丢弃，避免模型看到 "undefined"。 */
function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function actorOf(context: ToolRuntimeContext): ActorRef {
  return resolveAgentActor(context.runtime.state, context.sessionId)
}

/** 队长/成员的默认团队：从身份里取，避免让模型自己填 teamId 填错。 */
function defaultTeamId(actor: ActorRef, args: Record<string, unknown>): string {
  const explicit = optionalString(args, 'teamId')
  if (explicit !== undefined) return explicit
  if (actor.kind === 'captain' || actor.kind === 'member') return actor.teamId
  fail(ERROR_CODES.INVALID_PAYLOAD, '缺少参数 teamId')
}

function parseEvidence(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'evidence 必须是非空数组')
  }
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) fail(ERROR_CODES.INVALID_PAYLOAD, 'evidence 条目必须是对象')
    const record = item as Record<string, unknown>
    const kind = record.kind
    const ref = record.ref
    if (kind !== 'file' && kind !== 'command' && kind !== 'session' && kind !== 'url' && kind !== 'artifact') {
      fail(ERROR_CODES.INVALID_PAYLOAD, 'evidence.kind 不合法')
    }
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      fail(ERROR_CODES.INVALID_PAYLOAD, 'evidence.ref 不能为空')
    }
    const evidence: EvidenceRef = { kind, ref }
    if (typeof record.excerpt === 'string') evidence.excerpt = record.excerpt
    if (typeof record.hash === 'string') evidence.hash = record.hash
    return evidence
  })
}

function parseChecks(value: unknown): GateCheckResult[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(ERROR_CODES.INVALID_PAYLOAD, 'checks 必须是数组')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) fail(ERROR_CODES.INVALID_PAYLOAD, 'checks 条目必须是对象')
    const record = item as Record<string, unknown>
    return {
      command: typeof record.command === 'string' ? record.command : '',
      exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
      stdoutHash: typeof record.stdoutHash === 'string' ? record.stdoutHash : null,
      summary: typeof record.summary === 'string' ? record.summary : '',
    }
  })
}

function parseArtifacts(value: unknown): { path: string; hash: string | null; exists: boolean }[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(ERROR_CODES.INVALID_PAYLOAD, 'artifacts 必须是数组')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) fail(ERROR_CODES.INVALID_PAYLOAD, 'artifacts 条目必须是对象')
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string') fail(ERROR_CODES.INVALID_PAYLOAD, 'artifacts.path 必须是字符串')
    return {
      path: record.path,
      hash: typeof record.hash === 'string' ? record.hash : null,
      exists: record.exists === true,
    }
  })
}

const taskIdParam = { type: 'string', description: '项目内任务 id（task_…）' }
const attemptIdParam = { type: 'string', description: '当前 Attempt id（task.claimed 返回的 attempt.id）' }

/** 队长工具面。 */
export function leadToolSpecs(): MyTeamToolSpec[] {
  return [
    {
      name: 'myteam_read_board',
      description: '读取项目看板的当前投影（按状态分列、含阻塞上游与总计数）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: OUTPUT_SCHEMA,
      execute(_args, context) {
        return jsonSafe({ ok: true, data: boardView(context.runtime.state) })
      },
    },
    {
      name: 'myteam_read_task',
      description: '读取单个任务详情：正文、验收标准、依赖状态、Attempt、门禁裁决与证据。',
      parameters: { type: 'object', properties: { taskId: taskIdParam }, required: ['taskId'], additionalProperties: false },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        return jsonSafe({ ok: true, data: taskDetail(context.runtime.state, requireString(record, 'taskId')) })
      },
    },
    {
      name: 'myteam_read_team',
      description: '读取团队概览：队长世代、成员、任务与生效配置。',
      parameters: { type: 'object', properties: { teamId: { type: 'string' } }, additionalProperties: false },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        return jsonSafe({ ok: true, data: teamView(context.runtime.state, defaultTeamId(actor, record)) })
      },
    },
    {
      name: 'myteam_create_team',
      description:
        '创建一支团队并让**当前会话**成为它的队长。只能在当前会话还不属于任何团队时调用（新项目的第一步）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '团队名' },
          goal: { type: 'string', description: '团队目标（一句话）' },
          blueprintId: { type: 'string', description: '可选：用哪份蓝图初始化角色与配置' },
        },
        required: ['name', 'goal'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const state = context.runtime.state

        // 引导规则：只有「还不属于任何团队」的会话可以建队，避免一个会话反复建队。
        let existing: ActorRef | null = null
        try {
          existing = resolveAgentActor(state, context.sessionId)
        } catch {
          existing = null
        }
        if (existing !== null) {
          fail(ERROR_CODES.CONFLICT, '当前会话已经属于某个团队，不能重复建队', {
            details: { teamId: existing.kind === 'member' ? existing.teamId : existing.kind === 'captain' ? existing.teamId : null },
          })
        }

        const actor: ActorRef = { kind: 'captain', teamId: '', sessionId: context.sessionId, generation: 1 }
        const result = createTeamCommand(context.runtime, {
          actor,
          name: requireString(record, 'name'),
          goal: requireString(record, 'goal'),
          captainSessionId: context.sessionId,
          ...(optionalString(record, 'blueprintId') === undefined
            ? {}
            : { blueprintId: optionalString(record, 'blueprintId')! }),
        })
        const created = result.events.find((event) => event.type === 'team.created')
        if (created === undefined) {
          fail(ERROR_CODES.INTERNAL, '建队没有产生 team.created 事件')
        }
        const teamId = (created.payload as { team: { id: string } }).team.id
        const roles = [...state.roles.values()].map((role) => ({ id: role.id, name: role.profile.name }))
        return jsonSafe({ ok: true, data: { teamId, captainSessionId: context.sessionId, roles } })
      },
    },
    {
      name: 'myteam_create_task',
      description: '在项目里创建一个任务（默认归当前队长的团队）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          teamId: { type: 'string', description: '主责团队；默认当前队长团队' },
          dependencies: { type: 'array', items: { type: 'string' } },
          requiredRoleId: { type: 'string' },
        },
        required: ['title', 'acceptance'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const teamId = defaultTeamId(actor, record)
        const acceptance = optionalStringArray(record, 'acceptance') ?? []
        const result = createTaskCommand(context.runtime, {
          actor,
          title: requireString(record, 'title'),
          description: optionalString(record, 'description') ?? '',
          acceptance,
          ownerTeamId: teamId,
          dependencies: optionalStringArray(record, 'dependencies'),
          requiredRoleId: optionalString(record, 'requiredRoleId') ?? null,
        })
        const taskId = (result.events[0]!.payload as { task: { id: string } }).task.id
        return jsonSafe({ ok: true, data: { taskId } })
      },
    },
    {
      name: 'myteam_start_workflow',
      description: '用一份工作流定义实例化一次运行（Run），生成全部任务并返回 taskId 映射。',
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          teamId: { type: 'string' },
        },
        required: ['workflowId'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const teamId = defaultTeamId(actor, record)
        const started = startWorkflowRunCommand(context.runtime, {
          actor,
          teamId,
          workflowId: requireString(record, 'workflowId'),
        })
        const run = context.runtime.state.runs.get(started.runId)!
        return jsonSafe({
          ok: true,
          data: {
            runId: run.id,
            taskIds: run.taskIds,
            templateKeyToTaskId: run.templateKeyToTaskId,
            completion: started.completion,
          },
        })
      },
    },
    {
      name: 'myteam_create_workflow',
      description: '定义一份可复用的工作流（任务模板 + 依赖 + 完成条件）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          templates: { type: 'array', items: { type: 'object' } },
          completion: { type: 'object' },
        },
        required: ['name', 'templates'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const templates = record.templates
        if (!Array.isArray(templates)) fail(ERROR_CODES.INVALID_PAYLOAD, 'templates 必须是数组')
        const created = createProjectWorkflowCommand(context.runtime, {
          actor,
          name: requireString(record, 'name'),
          description: optionalString(record, 'description') ?? '',
          templates: templates as never,
          completion: record.completion as never,
        })
        const workflowId = (created.events[0]!.payload as { workflow: { id: string } }).workflow.id
        return jsonSafe({ ok: true, data: { workflowId } })
      },
    },
    {
      name: 'myteam_appoint_member',
      description: '按角色聘任一名团队成员（可选父成员以收窄能力）。',
      parameters: {
        type: 'object',
        properties: {
          teamId: { type: 'string' },
          roleId: { type: 'string' },
          parentMemberId: { type: 'string' },
          sessionId: { type: 'string', description: '成员会话；留空表示待绑定' },
        },
        required: ['roleId'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const result = appointMemberCommand(context.runtime, {
          actor,
          teamId: defaultTeamId(actor, record),
          roleId: requireString(record, 'roleId'),
          parentMemberId: optionalString(record, 'parentMemberId') ?? null,
          sessionId: optionalString(record, 'sessionId') ?? null,
        })
        const memberId = (result.events[0]!.payload as { member: { id: string } }).member.id
        return jsonSafe({ ok: true, data: { memberId } })
      },
    },
    {
      name: 'myteam_claim_task',
      description: '把任务认领给某个成员，创建一次新的 Attempt。',
      parameters: {
        type: 'object',
        properties: { taskId: taskIdParam, memberId: { type: 'string' } },
        required: ['taskId', 'memberId'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const result = claimTaskCommand(context.runtime, {
          actor,
          taskId: requireString(record, 'taskId'),
          memberId: requireString(record, 'memberId'),
        })
        const attempt = (result.events[0]!.payload as { attempt: { id: string; generation: number } }).attempt
        return jsonSafe({ ok: true, data: { attemptId: attempt.id, generation: attempt.generation } })
      },
    },
    {
      name: 'myteam_review_task',
      description: '对 review 状态的任务写入门禁裁决（pass / fail / blocked）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: taskIdParam,
          attemptId: attemptIdParam,
          outcome: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
          checks: { type: 'array', items: { type: 'object' } },
          evidence: { type: 'array', items: { type: 'object' } },
        },
        required: ['taskId', 'attemptId', 'outcome'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const outcome = requireString(record, 'outcome')
        if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'blocked') {
          fail(ERROR_CODES.INVALID_PAYLOAD, 'outcome 只能是 pass / fail / blocked')
        }
        const result = recordVerdictCommand(context.runtime, {
          actor,
          taskId: requireString(record, 'taskId'),
          attemptId: requireString(record, 'attemptId'),
          outcome: outcome as VerdictOutcome,
          checks: parseChecks(record.checks),
          evidence: record.evidence === undefined ? [] : parseEvidence(record.evidence),
        })
        return jsonSafe({ ok: true, data: { verdictId: (result.events[0]!.payload as { verdict: { id: string } }).verdict.id } })
      },
    },
    {
      name: 'myteam_complete_task',
      description: '在门禁通过、证据与交付物齐备时完成任务；满足条件时同一批次关闭 Run。',
      parameters: {
        type: 'object',
        properties: {
          taskId: taskIdParam,
          attemptId: attemptIdParam,
          artifacts: { type: 'array', items: { type: 'object' } },
        },
        required: ['taskId', 'attemptId'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        completeTaskCommand(context.runtime, {
          actor,
          taskId: requireString(record, 'taskId'),
          attemptId: requireString(record, 'attemptId'),
          artifacts: parseArtifacts(record.artifacts),
        })
        const task = context.runtime.state.tasks.get(requireString(record, 'taskId'))!
        return jsonSafe({ ok: true, data: { taskId: task.id, status: task.status } })
      },
    },
    {
      name: 'myteam_propose_knowledge',
      description: '提出一条带证据的项目知识；采纳需要队长或人类。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          evidence: { type: 'array', items: { type: 'object' } },
        },
        required: ['title', 'body', 'evidence'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = actorOf(context)
        const result = proposeKnowledgeCommand(context.runtime, {
          actor,
          title: requireString(record, 'title'),
          body: requireString(record, 'body'),
          evidence: parseEvidence(record.evidence),
        })
        return jsonSafe({ ok: true, data: { entryId: (result.events[0]!.payload as { entry: { id: string } }).entry.id } })
      },
    },
    {
      name: 'myteam_adopt_knowledge',
      description: '采纳一条待采纳的项目知识。',
      parameters: {
        type: 'object',
        properties: { entryId: { type: 'string' } },
        required: ['entryId'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        adoptKnowledgeCommand(context.runtime, { actor: actorOf(context), entryId: requireString(record, 'entryId') })
        return jsonSafe({ ok: true, data: { entryId: requireString(record, 'entryId') } })
      },
    },
  ]
}

/** 成员工具面：只能提交自己 Attempt 的事实。 */
export function memberToolSpecs(): MyTeamToolSpec[] {
  return [
    {
      name: 'myteam_progress',
      description: '提交当前 Attempt 的进度说明。',
      parameters: {
        type: 'object',
        properties: { taskId: taskIdParam, attemptId: attemptIdParam, note: { type: 'string' }, percent: { type: 'number' } },
        required: ['taskId', 'attemptId', 'note'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = resolveMemberActor(context.runtime.state, context.sessionId)
        recordProgressCommand(context.runtime, {
          actor,
          taskId: requireString(record, 'taskId'),
          attemptId: requireString(record, 'attemptId'),
          memberId: (actor as { memberId: string }).memberId,
          note: requireString(record, 'note'),
          percent: optionalNumber(record, 'percent') ?? null,
        })
        return jsonSafe({ ok: true, data: { taskId: requireString(record, 'taskId') } })
      },
    },
    {
      name: 'myteam_evidence',
      description: '为当前 Attempt 追加证据条目（命令输出、文件、会话等）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: taskIdParam,
          attemptId: attemptIdParam,
          evidence: { type: 'array', items: { type: 'object' } },
        },
        required: ['taskId', 'attemptId', 'evidence'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = resolveMemberActor(context.runtime.state, context.sessionId)
        recordEvidenceCommand(context.runtime, {
          actor,
          taskId: requireString(record, 'taskId'),
          attemptId: requireString(record, 'attemptId'),
          memberId: (actor as { memberId: string }).memberId,
          evidence: parseEvidence(record.evidence),
        })
        return jsonSafe({ ok: true, data: { taskId: requireString(record, 'taskId') } })
      },
    },
    {
      name: 'myteam_submit_review',
      description: '把任务提交评审，等待队长或门禁裁决。',
      parameters: {
        type: 'object',
        properties: { taskId: taskIdParam, attemptId: attemptIdParam },
        required: ['taskId', 'attemptId'],
        additionalProperties: false,
      },
      outputSchema: OUTPUT_SCHEMA,
      execute(args, context) {
        const record = asRecord(args)
        const actor = resolveMemberActor(context.runtime.state, context.sessionId)
        submitReviewCommand(context.runtime, {
          actor,
          taskId: requireString(record, 'taskId'),
          attemptId: requireString(record, 'attemptId'),
          memberId: (actor as { memberId: string }).memberId,
        })
        return jsonSafe({ ok: true, data: { taskId: requireString(record, 'taskId') } })
      },
    },
  ]
}

export type ToolFailure = { ok: false; error: ErrorShape }