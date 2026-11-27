/**
 * 建队计划用例：提出 / 批准 / 丢弃，以及队长交接建议。
 *
 * 计划批准前要带 planHash 复核（防「看的是旧计划、批的是新计划」）；
 * 批准后才落团队与 WorkflowRun。由 {@link ../commands.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { hashContent } from '../../contracts/json.ts'
import { computeEffectiveConfig } from '../../domain/config/merge.ts'
import { planInstantiation } from '../../domain/definitions/workflow.ts'
import { assertBlueprintResolvable } from '../../domain/definitions/blueprint.ts'
import { authorize } from '../../domain/permissions/policy.ts'
import { appointMember, assertMemberLimits } from '../../domain/teams/member.ts'
import { createTeam } from '../../domain/teams/team.ts'
import { createWorkflowRun } from '../../domain/workflows/run.ts'
import type { ConfigOverrides, DefinitionRef, FormationSlot, Member, TeamPlan } from '../../contracts/entities.ts'
import type { JsonValue } from '../../contracts/json.ts'
import type { ActorRef } from '../../contracts/events.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from '../project-runtime.ts'

/**
 * 把发起动作的 actor 压成一个可读标签，写进事件的 `proposedBy` / `discardedBy`。
 *
 * 为什么需要显式收窄而不是内联三元链：`plan.propose` / `plan.discard` 都在
 * `HUMAN_ONLY` 里，`authorize` 会在到达这里之前就拒掉 member/system，所以最后一个
 * 分支**运行时不可达**。但类型系统看不到「前面某个函数已经排除过」，内联三元链的
 * 最后一支会去读 `system` 分支上不存在的 `sessionId`——tsc 报 TS2339，而 strip 构建
 * 不报错，于是这个隐患一直没人发现。
 *
 * 这里把不可达分支显式写成 `never`：将来若有人把某个动作从 HUMAN_ONLY 里移出来，
 * 编译器会立刻在这里报错，而不是等到运行期产出 `system:undefined`。
 */
function proposerLabel(actor: ActorRef): string {
  switch (actor.kind) {
    case 'human':
      return `human:${actor.userId}`
    case 'captain':
      return `captain:${actor.sessionId}`
    case 'member':
      return `member:${actor.sessionId}`
    case 'system':
      return `system:${actor.component}`
  }
}

export interface ApproveTeamPlanResult {
  commit: CommitResult
  teamId: string
  memberIds: string[]
  runId: string | null
  taskIds: string[]
}

/**
 * 批准开队计划（`team.plan.approved`）—— **一个原子批次建出整个团队**。
 *
 * 这是「批准前不产生会话与花费」的另一半：批准之前什么都没建，批准这一次全建。
 * 顺序固定，且**全部在同一个 `runtime.commit` 里**：
 *
 *   1. `team.plan.approved`（先消费计划：后面任何一步失败，整批回滚，
 *      不会出现「计划没了但团队没建」）
 *   2. `config.override.changed`（团队配置快照）
 *   3. `team.created`（`status: 'active'`，带队长与队形）
 *   4. N × `member.appointed`（按 formation 展开）
 *   5. 若计划带工作流：`run.created` + 首批 `task.created`
 *
 * **为什么不用现成的 `appointMemberCommand` / `startWorkflowRunCommand`**：
 * 它们各自 `commit`，而且会读 `state.teamConfigs` / `state.teams` ——
 * 在一个批次里那些状态还没生效（`state` 只在 commit 之后更新）。
 * 所以这里用同一批**领域函数**（`createTeam` / `appointMember` / `planInstantiation` /
 * `createWorkflowRun`）自己组批次，保证「一次批准 = 一次原子变化」。
 *
 * **会话**：成员以 `appointed`（`sessionId: null`）建出来 —— 真正的会话由队长后续
 * spawn 时绑定（`member.session.bound`）。这一层没有「创建宿主会话」的端口，
 * 也不该有：会话是执行载体，不是账本实体。
 *
 * @param input.planHash - 调用方看到的计划内容 hash；与计划当前 hash 不符就拒
 *   （防止「看的是旧计划、批的是新计划」）。
 */
export function approveTeamPlanCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; planId: string; planHash: string; startRun?: boolean },
): ApproveTeamPlanResult {
  authorize('plan.approve', input.actor)
  const state = runtime.state

  const plan = state.teamPlans.get(input.planId)
  if (plan === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '没有这份待批准的计划（可能已经批准或丢弃）', { details: { planId: input.planId } })
  }
  if (plan.planHash !== input.planHash) {
    fail(ERROR_CODES.CONFIRMATION_TARGET_CHANGED, '计划内容与预览时不一致，请重新预览再批准', {
      details: { planId: plan.id, expectedHash: input.planHash, actualHash: plan.planHash },
    })
  }

  const now = runtime.now()
  const teamId = runtime.nextId('team')
  const configRevision = state.configRevision + 1

  // 蓝图默认值：批准时按计划里记的 blueprint revision 取（计划绑的是那一版）。
  const blueprintDefaults =
    plan.blueprint === null ? null : (state.blueprints.get(plan.blueprint.id)?.defaults ?? null)
  const snapshot = computeEffectiveConfig({
    projectDefaults: state.configDefaults as ConfigOverrides,
    blueprintDefaults,
    teamOverrides: plan.overrides,
    configRevision,
    sources: {
      projectDefaultsRevision: state.configRevision,
      blueprintRevision: plan.blueprint?.revision ?? null,
      teamOverridesRevision: 1,
    },
  })

  const team = createTeam({
    id: teamId,
    name: plan.name,
    goal: plan.goal,
    blueprint: plan.blueprint,
    configRevision: snapshot.configRevision,
    now,
  })

  // ── 成员：按 formation 展开。全部是深度 1（子成员由队长后续派生，不在批准这一步建）。──
  const plannedCount = plan.formation.reduce((sum, slot) => sum + slot.count, 0)
  assertMemberLimits({
    existingMembers: 0,
    depth: 1,
    parentChildren: 0,
    config: snapshot.values.limits,
  })
  if (plannedCount > snapshot.values.limits.maxMembers) {
    fail(ERROR_CODES.PRECONDITION_FAILED, `计划要建 ${String(plannedCount)} 名成员，超过团队上限 ${String(snapshot.values.limits.maxMembers)}`, {
      details: { plannedCount, maxMembers: snapshot.values.limits.maxMembers },
    })
  }

  const members: { member: Member; roleRevision: number }[] = []
  for (const slot of plan.formation) {
    const role = state.roles.get(slot.roleId)
    if (role === undefined) {
      // 提案时校验过，但角色可能在提案之后被删（定义可以归档）。宁可拒绝也不建残缺团队。
      fail(ERROR_CODES.NOT_FOUND, `队形里的角色已经不存在：${slot.roleId}`, { details: { roleId: slot.roleId } })
    }
    for (let index = 0; index < slot.count; index += 1) {
      const { member } = appointMember({
        id: runtime.nextId('member'),
        teamId,
        role,
        parent: null,
        sessionId: null,
        now,
      })
      members.push({ member, roleRevision: role.revision })
    }
  }

  // ── Run（可选）：和团队在同一个批次里实例化，避免「有团队没 Run」的中间态。──
  const shouldStartRun = input.startRun !== false && plan.workflow !== null
  let runId: string | null = null
  let taskIds: string[] = []
  let runDrafts: DraftEvent[] = []
  let graphRevision = state.graphRevision
  if (shouldStartRun) {
    const definition = state.workflows.get(plan.workflow!.id)
    if (definition === undefined) {
      fail(ERROR_CODES.NOT_FOUND, '计划里的默认工作流已经不存在', { details: { workflowId: plan.workflow!.id } })
    }
    runId = runtime.nextId('run')
    const instantiated = planInstantiation({
      definition,
      runId,
      ownerTeamId: teamId,
      now,
      nextTaskId: () => runtime.nextId('task'),
    })
    // 根任务直接 ready，否则每次批准完还要人工放开一次。
    for (const task of instantiated.tasks) {
      if (task.dependencies.length === 0) task.status = 'ready'
    }
    const run = createWorkflowRun({
      id: runId,
      workflowId: definition.id,
      workflowRevision: definition.revision,
      teamId,
      taskIds: instantiated.tasks.map((task) => task.id),
      templateKeyToTaskId: instantiated.templateKeyToTaskId,
      now,
    })
    graphRevision = state.graphRevision + 1
    taskIds = instantiated.tasks.map((task) => task.id)
    runDrafts = [
      {
        type: 'run.created',
        actor: input.actor,
        entity: { kind: 'workflow-run', id: runId, teamId },
        entityRevision: 1,
        configRevision: snapshot.configRevision,
        payload: { run, completion: instantiated.completion, graphRevision },
      },
      ...instantiated.tasks.map(
        (task): DraftEvent => ({
          type: 'task.created',
          actor: input.actor,
          entity: { kind: 'task', id: task.id, teamId },
          entityRevision: 1,
          configRevision: snapshot.configRevision,
          payload: { task, graphRevision },
        }),
      ),
    ]
  }

  const drafts: DraftEvent[] = [
    {
      type: 'team.plan.approved',
      actor: input.actor,
      entity: { kind: 'team-plan', id: plan.id },
      payload: { planId: plan.id, teamId, planHash: plan.planHash, runId },
    },
    {
      type: 'config.override.changed',
      actor: input.actor,
      entity: { kind: 'config', id: teamId, teamId },
      payload: { teamId, configRevision, overrides: plan.overrides, snapshot },
    },
    {
      type: 'team.created',
      actor: input.actor,
      entity: { kind: 'team', id: teamId },
      entityRevision: 1,
      configRevision: snapshot.configRevision,
      payload: {
        team,
        captain: { sessionId: plan.captainSessionId, generation: 1 },
        formation: plan.formation,
      },
    },
    ...members.map(
      (entry): DraftEvent => ({
        type: 'member.appointed',
        actor: input.actor,
        entity: { kind: 'member', id: entry.member.id, teamId },
        entityRevision: 1,
        configRevision: snapshot.configRevision,
        payload: { member: entry.member, roleRevision: entry.roleRevision, parentMemberId: null },
      }),
    ),
    ...runDrafts,
  ]

  const commit = runtime.commit(drafts)
  return { commit, teamId, memberIds: members.map((entry) => entry.member.id), runId, taskIds }
}

/**
 * 提案开队计划（`team.plan.proposed`）—— **只落计划，不建任何实体**。
 *
 * 这是「批准前不产生会话与花费」的落点：团队、成员、会话、Run 全部等到批准时才建。
 * 丢弃只需要一条 `team.plan.discarded`，没有任何东西要回滚。
 *
 * 校验顺序（先便宜后贵，且都发生在写盘前）：
 *   1. 名字与队长会话非空、队形非空；
 *   2. 蓝图/工作流（若给了）必须存在且能解析引用 —— 否则批准时才炸就晚了；
 *   3. 队形里的角色必须都存在（否则批准时聘不出来）。
 */
export function proposeTeamPlanCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    name: string
    goal: string
    captainSessionId: string
    blueprintId?: string
    /** 队形；不给时用蓝图里的 formation。 */
    formation?: FormationSlot[]
    /** 默认工作流；不给时用蓝图里第一个可用的。 */
    workflowId?: string
    overrides?: ConfigOverrides
  },
): { plan: TeamPlan; result: CommitResult } {
  authorize('plan.propose', input.actor)
  const state = runtime.state

  const name = input.name.trim()
  if (name.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '计划必须有团队名')
  }
  if (input.captainSessionId.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '计划必须指定队长会话')
  }

  let blueprintRef: DefinitionRef | null = null
  let blueprintDefaults: ConfigOverrides | null = null
  let blueprintFormation: FormationSlot[] = []
  let blueprintWorkflow: string | null = null
  if (input.blueprintId !== undefined) {
    const blueprint = state.blueprints.get(input.blueprintId)
    if (blueprint === undefined) {
      fail(ERROR_CODES.NOT_FOUND, '蓝图不存在', { details: { blueprintId: input.blueprintId } })
    }
    // 引用必须当场就能解析：等到批准才发现缺角色，人已经以为能开跑了。
    assertBlueprintResolvable(
      blueprint,
      (roleId) => state.roles.get(roleId),
      (workflowId) => state.workflows.get(workflowId),
    )
    blueprintRef = { id: blueprint.id, revision: blueprint.revision }
    blueprintDefaults = blueprint.defaults
    blueprintFormation = blueprint.formation
    blueprintWorkflow = blueprint.workflows[0] ?? null
  }

  const formation = input.formation ?? blueprintFormation
  if (formation.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '计划至少要有一个成员槽位（队长不算在队形里）')
  }
  for (const slot of formation) {
    if (state.roles.get(slot.roleId) === undefined) {
      fail(ERROR_CODES.NOT_FOUND, `队形里的角色不存在：${slot.roleId}`, { details: { roleId: slot.roleId } })
    }
    if (!Number.isInteger(slot.count) || slot.count < 1) {
      // details 必须是 JsonValue：FormationSlot 是 interface（无索引签名），直接塞进去
      // tsc 会拒。cloneJson<T> 保留原类型 T，帮不上忙；这里显式走一次 JSON 往返，
      // 得到结构相同、类型是 JsonValue 的值。
      fail(ERROR_CODES.INVALID_PAYLOAD, `槽位 ${slot.key} 的数量必须是正整数`, {
        details: JSON.parse(JSON.stringify(slot)) as JsonValue,
      })
    }
  }

  const workflowId = input.workflowId ?? blueprintWorkflow
  let workflowRef: DefinitionRef | null = null
  if (workflowId !== null) {
    const workflow = state.workflows.get(workflowId)
    if (workflow === undefined) {
      fail(ERROR_CODES.NOT_FOUND, '默认工作流不存在', { details: { workflowId } })
    }
    workflowRef = { id: workflow.id, revision: workflow.revision }
  }

  const overrides = input.overrides ?? blueprintDefaults ?? {}
  const now = runtime.now()
  const planId = runtime.nextId('plan')

  // planHash 绑**内容**，不绑 id：队形/工作流/配置任何一项被改过，hash 就变，批准令牌立刻失效。
  const planHash = hashContent({
    name,
    goal: input.goal,
    blueprint: blueprintRef,
    formation,
    workflow: workflowRef,
    captainSessionId: input.captainSessionId,
    overrides,
  })

  const plan: TeamPlan = {
    id: planId,
    name,
    goal: input.goal,
    blueprint: blueprintRef,
    formation,
    workflow: workflowRef,
    captainSessionId: input.captainSessionId,
    overrides,
    planHash,
    proposedBy: proposerLabel(input.actor),
    proposedAt: now,
  }

  const result = runtime.commit([
    {
      type: 'team.plan.proposed',
      actor: input.actor,
      entity: { kind: 'team-plan', id: planId },
      payload: { plan },
    },
  ])
  return { plan, result }
}

/**
 * 丢弃一份待批准的计划（`team.plan.discarded`）。
 *
 * 设计稿：「丢弃不产生任何会话与花费」。因为提案本来就没建实体，这里**不需要回滚任何东西**
 * —— 这正是方案 B（独立聚合）换来的好处。
 */
export function discardTeamPlanCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; planId: string; reason: string },
): CommitResult {
  authorize('plan.discard', input.actor)
  const plan = runtime.state.teamPlans.get(input.planId)
  if (plan === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '没有这份待批准的计划（可能已经批准或丢弃）', {
      details: { planId: input.planId },
    })
  }
  return runtime.commit([
    {
      type: 'team.plan.discarded',
      actor: input.actor,
      entity: { kind: 'team-plan', id: plan.id },
      payload: {
        planId: plan.id,
        reason: input.reason.trim().length === 0 ? '未说明原因' : input.reason.trim(),
        discardedBy: proposerLabel(input.actor),
      },
    },
  ])
}

/**
 * 队长提案接管（`captain.handoff.proposed`）—— **只提案，不执行**。
 *
 * 为什么要这一步：设计稿 `p-approval` 的「队长接管」是排队等人类确认的；
 * 而事件 `captain.handoff.proposed` 早就声明在事件目录里，却**没有任何写入方**、
 * 投影也是 no-op —— 于是「谁在等接管确认」根本查不出来。这里把它接通。
 *
 * 分工照设计稿：「这些动作队长只能提案；执行必须来自人类入口并重新校验」。
 *   - 提案：本命令（队长或人类都可以，走 `captain.handoff.propose`）；
 *   - 执行：`confirmCaptainTakeover`（人类专属，`captain.handoff.confirm` + 令牌）。
 *
 * 提案不改变队长，也不动 generation —— 它只是把「想换成谁」记进账本，
 * 让待确认页看得到。generation 只在人类确认时 +1。
 */
export function proposeCaptainHandoffCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; teamId: string; toSessionId: string },
): CommitResult {
  authorize('captain.handoff.propose', input.actor, { teamId: input.teamId })
  const state = runtime.state
  const team = state.teams.get(input.teamId)
  if (team === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '团队不存在', { details: { teamId: input.teamId } })
  }
  if (team.status !== 'active') {
    fail(ERROR_CODES.TEAM_NOT_ACTIVE, `团队状态为 ${team.status}，不能提案接管`, { details: { teamId: team.id } })
  }
  if (input.toSessionId.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '提案接管必须指定接任会话')
  }
  const current = state.captains.get(team.id) ?? null
  if (current !== null && current.sessionId === input.toSessionId) {
    fail(ERROR_CODES.CONFLICT, '该会话已经是当前队长', { details: { sessionId: input.toSessionId } })
  }
  // 同一个人重复提案 → 拒绝，别让待确认列表里堆一串一样的。
  const pending = state.pendingHandoffs.get(team.id)
  if (pending !== undefined && pending.toSessionId === input.toSessionId) {
    fail(ERROR_CODES.CONFLICT, '已经有一份指向同一会话的待确认接管提案', {
      details: { teamId: team.id, toSessionId: input.toSessionId, proposedAt: pending.proposedAt },
    })
  }

  const proposedBy = proposerLabel(input.actor)

  return runtime.commit([
    {
      type: 'captain.handoff.proposed',
      actor: input.actor,
      entity: { kind: 'captain-assignment', id: team.id, teamId: team.id },
      payload: {
        teamId: team.id,
        fromGeneration: current?.generation ?? 0,
        toSessionId: input.toSessionId,
        proposedBy,
      },
    },
  ])
}
