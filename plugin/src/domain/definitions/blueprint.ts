/**
 * TeamBlueprint：建团蓝图。
 *
 * 它只回答「要组建什么团队」——队形（角色引用 × 数量）、工作流引用、默认配置。
 * 不拥有被引用的 Role/Workflow（引用断裂必须阻断而不是猜），不含运行实例，
 * 也不是 DSH AgentPreset（后者决定会话由哪些宿主插件组成）。
 */
import type { FormationSlot, TeamBlueprint } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { hashContent } from '../../contracts/json.ts'

export function normalizeBlueprint(blueprint: TeamBlueprint): TeamBlueprint {
  return {
    ...blueprint,
    name: blueprint.name.trim(),
    description: blueprint.description.trim(),
    formation: blueprint.formation.map((slot) => ({
      key: slot.key.trim(),
      roleId: slot.roleId,
      count: slot.count,
      parentSlotKey: slot.parentSlotKey === null ? null : slot.parentSlotKey.trim(),
    })),
    workflows: [...blueprint.workflows],
    defaults: normalizeOverrides(blueprint.defaults),
  }
}

function normalizeOverrides(defaults: TeamBlueprint['defaults']): TeamBlueprint['defaults'] {
  // 覆盖层的字段校验在 domain/config 里做；这里只去掉空对象，避免 hash 里
  // 出现 `{limits:{}}` 与「没有 limits」被判成两种不同内容。
  const result: TeamBlueprint['defaults'] = {}
  if (defaults.limits !== undefined && Object.keys(defaults.limits).length > 0) result.limits = defaults.limits
  if (defaults.gates !== undefined && Object.keys(defaults.gates).length > 0) result.gates = defaults.gates
  if (defaults.messaging !== undefined && Object.keys(defaults.messaging).length > 0) {
    result.messaging = defaults.messaging
  }
  return result
}

export function blueprintContentHash(blueprint: TeamBlueprint): string {
  const normalized = normalizeBlueprint(blueprint)
  return hashContent({
    name: normalized.name,
    description: normalized.description,
    formation: normalized.formation,
    workflows: normalized.workflows,
    defaults: normalized.defaults,
  })
}

/**
 * 校验蓝图。
 *
 * `resolveRole` / `resolveWorkflow` 由调用方注入：定义可能来自项目事件，
 * 也可能来自全局库，领域层不关心存储，只关心「能不能解析到」。
 */
export function validateBlueprint(
  blueprint: TeamBlueprint,
  resolveRole: (roleId: string) => { revision: number } | undefined,
  resolveWorkflow: (workflowId: string) => { revision: number } | undefined,
): string[] {
  const problems: string[] = []
  const normalized = normalizeBlueprint(blueprint)

  if (normalized.name.length === 0) problems.push('蓝图名称不能为空')
  if (normalized.formation.length === 0) problems.push('蓝图至少需要一个队形槽位')

  const keys = new Set<string>()
  for (const slot of normalized.formation) {
    if (slot.key.length === 0) {
      problems.push('队形槽位缺少 key')
      continue
    }
    if (keys.has(slot.key)) problems.push(`队形槽位 key 重复：${slot.key}`)
    keys.add(slot.key)
  }

  for (const slot of normalized.formation) {
    if (!Number.isInteger(slot.count) || slot.count < 1) {
      problems.push(`槽位 ${slot.key} 的数量必须是正整数`)
    }
    if (slot.parentSlotKey !== null && !keys.has(slot.parentSlotKey)) {
      problems.push(`槽位 ${slot.key} 的父槽位不存在：${slot.parentSlotKey}`)
    }
    if (resolveRole(slot.roleId) === undefined) {
      problems.push(`槽位 ${slot.key} 引用的角色不存在：${slot.roleId}`)
    }
  }

  const parentCycle = findParentCycle(normalized.formation)
  if (parentCycle !== null) problems.push(`队形父子关系存在环：${parentCycle.join(' → ')}`)

  for (const workflowId of normalized.workflows) {
    if (resolveWorkflow(workflowId) === undefined) {
      problems.push(`蓝图引用的工作流不存在：${workflowId}`)
    }
  }

  return problems
}

/** 实例化前的硬校验：引用断裂直接拒绝，不带着缺失引用建团队。 */
export function assertBlueprintResolvable(
  blueprint: TeamBlueprint,
  resolveRole: (roleId: string) => { revision: number } | undefined,
  resolveWorkflow: (workflowId: string) => { revision: number } | undefined,
): void {
  const problems = validateBlueprint(blueprint, resolveRole, resolveWorkflow)
  if (problems.length > 0) {
    fail(ERROR_CODES.NOT_FOUND, '蓝图引用无法解析，不能用于建团', { details: { problems } })
  }
}

/** 队形里的成员总数（考虑 count）。 */
export function formationSize(blueprint: TeamBlueprint): number {
  return blueprint.formation.reduce((total, slot) => total + slot.count, 0)
}

function findParentCycle(formation: readonly FormationSlot[]): string[] | null {
  const parent = new Map<string, string>()
  for (const slot of formation) {
    if (slot.parentSlotKey !== null) parent.set(slot.key, slot.parentSlotKey)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  for (const slot of formation) {
    if (state.has(slot.key)) continue
    const path: string[] = []
    let current: string | undefined = slot.key
    while (current !== undefined) {
      const seen = state.get(current)
      if (seen === 'done') break
      if (seen === 'visiting') {
        const start = path.indexOf(current)
        return path.slice(start < 0 ? 0 : start).concat(current)
      }
      state.set(current, 'visiting')
      path.push(current)
      current = parent.get(current)
    }
    for (const key of path) state.set(key, 'done')
  }
  return null
}