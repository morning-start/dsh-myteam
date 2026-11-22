/**
 * 工作流定义：可复用的 TaskTemplate + 初始依赖 + 完成条件。
 *
 * 定义与运行严格分离：
 *   - WorkflowDefinition 不知道「谁在做」「做到哪了」，也不保存任务状态；
 *   - 实例化产出的是项目 Task（含 `templateKey → taskId` 映射）与一个 Run；
 *   - 运行期动态增删任务只改项目 DAG 与 Run，不回写 Definition。
 *
 * 因此这里的核心只有三件事：校验定义能否被实例化、算内容 hash、生成实例化计划。
 */
import type {
  CompletionRule,
  Task,
  TaskTemplate,
  WorkflowDefinition,
} from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { hashContent } from '../../contracts/json.ts'
import type { TaskId } from '../../contracts/ids.ts'
import { createPlannedTask } from '../tasks/task.ts'
import { findCycle } from '../tasks/dag.ts'

export function normalizeTemplate(template: TaskTemplate): TaskTemplate {
  return {
    key: template.key.trim(),
    title: template.title.trim(),
    description: template.description.trim(),
    acceptance: dedupeStrings(template.acceptance.map((item) => item.trim()).filter((item) => item.length > 0)),
    requiredRoleId: template.requiredRoleId,
    dependsOn: dedupeStrings(template.dependsOn.map((key) => key.trim()).filter((key) => key.length > 0)),
    gate: {
      commands: dedupeStrings(template.gate.commands.map((command) => command.trim()).filter((command) => command.length > 0)),
      requireEvidence: template.gate.requireEvidence,
      requireArtifacts: template.gate.requireArtifacts,
    },
    deliverable:
      template.deliverable === null
        ? null
        : {
            paths: dedupeStrings(template.deliverable.paths.map((path) => path.trim()).filter((path) => path.length > 0)),
            description: template.deliverable.description.trim(),
          },
  }
}

export function normalizeWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    name: definition.name.trim(),
    description: definition.description.trim(),
    templates: definition.templates.map(normalizeTemplate),
    completion: {
      mode: definition.completion.mode,
      requiredKeys: dedupeStrings(definition.completion.requiredKeys.map((key) => key.trim()).filter((key) => key.length > 0)),
    },
  }
}

export function workflowContentHash(definition: WorkflowDefinition): string {
  const normalized = normalizeWorkflow(definition)
  return hashContent({
    name: normalized.name,
    description: normalized.description,
    templates: normalized.templates,
    completion: normalized.completion,
  })
}

/**
 * 校验定义。返回问题清单；空数组表示可以实例化。
 *
 * 刻意把「模板 key 重复」「依赖指向不存在的 key」「完成条件引用不存在的
 * key」都算错误而不是忽略：定义是要被反复实例化的资产，一次静默丢字段会
 * 让之后每个 Run 都少一个任务，且没人知道为什么。
 */
export function validateWorkflow(definition: WorkflowDefinition): string[] {
  const problems: string[] = []
  const normalized = normalizeWorkflow(definition)

  if (normalized.name.length === 0) problems.push('工作流名称不能为空')
  if (normalized.templates.length === 0) {
    problems.push('工作流至少需要一个任务模板')
    return problems
  }

  const byKey = new Map<string, TaskTemplate>()
  for (const template of normalized.templates) {
    if (template.key.length === 0) {
      problems.push('任务模板缺少 key')
      continue
    }
    if (byKey.has(template.key)) {
      problems.push(`任务模板 key 重复：${template.key}`)
      continue
    }
    byKey.set(template.key, template)
    if (template.title.length === 0) problems.push(`模板 ${template.key} 缺少标题`)
    if (template.acceptance.length === 0) problems.push(`模板 ${template.key} 缺少验收标准`)
    if (template.dependsOn.includes(template.key)) {
      problems.push(`模板 ${template.key} 不能依赖自己`)
    }
    for (const dependency of template.dependsOn) {
      if (!normalized.templates.some((candidate) => candidate.key === dependency)) {
        problems.push(`模板 ${template.key} 依赖了不存在的 key：${dependency}`)
      }
    }
  }

  if (problems.length === 0) {
    const graph = new Map<string, readonly string[]>(
      normalized.templates.map((template) => [template.key, template.dependsOn] as const),
    )
    const cycle = findCycle({ edges: graph })
    if (cycle !== null) problems.push(`任务模板存在环：${cycle.join(' → ')}`)
  }

  const completion = normalized.completion
  if (completion.mode === 'required-tasks') {
    if (completion.requiredKeys.length === 0) {
      problems.push('完成条件为 required-tasks 时必须声明 requiredKeys')
    }
    for (const key of completion.requiredKeys) {
      if (!byKey.has(key)) problems.push(`完成条件引用不存在的模板：${key}`)
    }
  }

  return problems
}

export interface InstantiationInput {
  definition: WorkflowDefinition
  runId: string | null
  ownerTeamId: string | null
  now: string
  /** 由应用层的 id 工厂提供；同一次实例化内必须为每个 key 只调用一次。 */
  nextTaskId: () => TaskId
}

export interface InstantiationPlan {
  tasks: Task[]
  templateKeyToTaskId: Record<string, TaskId>
  completion: CompletionRule
}

/**
 * 生成实例化计划（不写任何存储）。
 *
 * 所有任务先建成 `planned`，依赖指向新 taskId：就绪由应用层在批次提交后
 * 统一计算，避免「先建的已 ready、后建的还在等」这种半就绪状态。
 */
export function planInstantiation(input: InstantiationInput): InstantiationPlan {
  const problems = validateWorkflow(input.definition)
  if (problems.length > 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '工作流定义无法实例化', { details: { problems } })
  }

  const normalized = normalizeWorkflow(input.definition)
  const templateKeyToTaskId: Record<string, TaskId> = {}
  for (const template of normalized.templates) {
    templateKeyToTaskId[template.key] = input.nextTaskId()
  }

  const tasks: Task[] = normalized.templates.map((template) => {
    const dependencies = template.dependsOn.map((key) => templateKeyToTaskId[key]!)
    return createPlannedTask({
      id: templateKeyToTaskId[template.key]!,
      title: template.title,
      description: template.description,
      acceptance: template.acceptance,
      ownerTeamId: input.ownerTeamId,
      dependencies,
      runId: input.runId,
      templateKey: template.key,
      requiredRoleId: template.requiredRoleId,
      gate: template.gate,
      deliverable: template.deliverable,
      now: input.now,
    })
  })

  return { tasks, templateKeyToTaskId, completion: normalized.completion }
}

/**
 * 完成条件是否发生变化。`completionRevision` 只在变化时推进——把所有
 * `run.revised` 都当成条件变化会让 revision 失去「条件版本」的含义。
 */
export function completionChanged(previous: CompletionRule, next: CompletionRule): boolean {
  return hashContent(previous) !== hashContent(next)
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}