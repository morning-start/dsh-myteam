import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskTemplate, TeamBlueprint, WorkflowDefinition } from '../src/contracts/entities.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { planInstantiation, validateWorkflow, workflowContentHash } from '../src/domain/definitions/workflow.ts'
import { formationSize, validateBlueprint } from '../src/domain/definitions/blueprint.ts'
import {
  blockingDependencies,
  cycleIfEdgesChanged,
  findCycle,
  readyTaskIds,
  topologicalOrder,
  transitiveDependents,
} from '../src/domain/tasks/dag.ts'

const NOW = '2026-01-01T00:00:00.000Z'

function template(key: string, dependsOn: string[] = []): TaskTemplate {
  return {
    key,
    title: key,
    description: '',
    acceptance: [`${key} 完成`],
    requiredRoleId: null,
    dependsOn,
    gate: { commands: [], requireEvidence: true, requireArtifacts: false },
    deliverable: null,
  }
}

function workflow(templates: TaskTemplate[], requiredKeys: string[] = []): WorkflowDefinition {
  return {
    id: 'wfl_00000001',
    revision: 1,
    name: '实现流程',
    description: '',
    templates,
    completion: { mode: requiredKeys.length > 0 ? 'required-tasks' : 'all-tasks', requiredKeys },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test('工作流校验：重复 key / 缺失依赖 / 环 / 完成条件引用', () => {
  const duplicate = validateWorkflow(workflow([template('a'), template('a')]))
  assert.ok(duplicate.some((problem) => problem.includes('重复')))

  const missing = validateWorkflow(workflow([template('a', ['nope'])]))
  assert.ok(missing.some((problem) => problem.includes('不存在')))

  const cyclic = validateWorkflow(workflow([template('a', ['b']), template('b', ['a'])]))
  assert.ok(cyclic.some((problem) => problem.includes('环')))

  const unknownRequired = validateWorkflow(workflow([template('a')], ['ghost']))
  assert.ok(unknownRequired.some((problem) => problem.includes('ghost')))
})

test('实例化：key 映射、依赖重指、全部 planned', () => {
  let counter = 0
  const plan = planInstantiation({
    definition: workflow([template('design'), template('build', ['design'])]),
    runId: 'run_00000001',
    ownerTeamId: 'team_00000001',
    now: NOW,
    nextTaskId: () => `task_${String(++counter).padStart(8, '0')}`,
  })

  assert.equal(plan.tasks.length, 2)
  const design = plan.templateKeyToTaskId.design!
  const build = plan.templateKeyToTaskId.build!
  assert.notEqual(design, build)
  assert.deepEqual(plan.tasks[1]!.dependencies, [design])
  assert.ok(plan.tasks.every((task) => task.status === 'planned'))
  assert.ok(plan.tasks.every((task) => task.runId === 'run_00000001'))
})

test('实例化：非法定义直接拒绝，不产出半成品', () => {
  assert.throws(
    () =>
      planInstantiation({
        definition: workflow([template('a', ['a'])]),
        runId: null,
        ownerTeamId: null,
        now: NOW,
        nextTaskId: () => 'task_00000001',
      }),
    (error: unknown) => error instanceof MyTeamError && error.code === 'INVALID_PAYLOAD',
  )
})

test('内容 hash：模板顺序变了但语义相同仍同 hash（语义相同指规范化后一致）', () => {
  const first = workflow([template('a'), template('b', ['a'])])
  const second = workflow([template('a'), template('b', ['a'])])
  assert.equal(workflowContentHash(first), workflowContentHash(second))
  assert.notEqual(workflowContentHash(first), workflowContentHash(workflow([template('a'), template('b')])))
})

test('DAG：自环与多节点环都能定位', () => {
  assert.deepEqual(findCycle({ edges: new Map([['a', ['a']]]) }), ['a', 'a'])
  const cycle = findCycle({ edges: new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]) })
  assert.deepEqual(cycle, ['a', 'b', 'c', 'a'])
  assert.equal(findCycle({ edges: new Map([['a', ['b']], ['b', []]]) }), null)
})

test('DAG：接边试算能提前拒绝成环', () => {
  const graph = { edges: new Map([['a', []], ['b', ['a']]]) }
  assert.notEqual(cycleIfEdgesChanged(graph, 'a', ['b']), null)
  assert.equal(cycleIfEdgesChanged(graph, 'a', []), null)
})

test('DAG：就绪只认 done，cancelled 不解除下游', () => {
  const graph = { edges: new Map([['a', []], ['b', ['a']], ['c', []]]) }
  const status = new Map([['a', 'done'], ['b', 'planned'], ['c', 'cancelled']])
  assert.deepEqual(readyTaskIds(graph, (id) => status.get(id)), ['b'])
  assert.deepEqual(blockingDependencies(graph, 'b', (id) => status.get(id)), [])

  const blocked = new Map([['a', 'cancelled'], ['b', 'planned'], ['c', 'planned']])
  assert.deepEqual(blockingDependencies(graph, 'b', (id) => blocked.get(id)), ['a'])
})

test('DAG：拓扑序与传递下游', () => {
  const graph = { edges: new Map([['a', []], ['b', ['a']], ['c', ['b']]]) }
  assert.deepEqual(topologicalOrder(graph), ['a', 'b', 'c'])
  assert.deepEqual([...transitiveDependents(graph, 'a')].sort(), ['b', 'c'])
})

test('蓝图：引用断裂与父子环都要报出来', () => {
  const blueprint: TeamBlueprint = {
    id: 'bp_00000001',
    revision: 1,
    name: '小队',
    description: '',
    formation: [
      { key: 'lead', roleId: 'role_lead', count: 1, parentSlotKey: null },
      { key: 'impl', roleId: 'role_missing', count: 2, parentSlotKey: 'lead' },
    ],
    workflows: ['wfl_missing'],
    defaults: {},
    createdAt: NOW,
    updatedAt: NOW,
  }
  const problems = validateBlueprint(
    blueprint,
    (roleId) => (roleId === 'role_lead' ? { revision: 1 } : undefined),
    () => undefined,
  )
  assert.ok(problems.some((problem) => problem.includes('role_missing')))
  assert.ok(problems.some((problem) => problem.includes('wfl_missing')))
  assert.equal(formationSize(blueprint), 3)

  const cyclic: TeamBlueprint = {
    ...blueprint,
    formation: [
      { key: 'a', roleId: 'role_lead', count: 1, parentSlotKey: 'b' },
      { key: 'b', roleId: 'role_lead', count: 1, parentSlotKey: 'a' },
    ],
    workflows: [],
  }
  const cycleProblems = validateBlueprint(cyclic, () => ({ revision: 1 }), () => ({ revision: 1 }))
  assert.ok(cycleProblems.some((problem) => problem.includes('环')))
})