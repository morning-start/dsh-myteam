/**
 * CHG-73（FR-31 编辑闭环）：任务编辑的字段级 diff —— 纯函数，只读投影 + 补丁。
 *
 * 为什么需要它：
 *   1. **改动可读**：账本只记「补丁」，人看详情时要回答的是「谁把哪条 AC 从什么改成了什么」；
 *      写入端把 diff 一起落账（`changes`），详情页直接渲染，不必自己再猜一遍。
 *   2. **证据过期判定**：结构性字段（AC / 交付物 / 依赖 / 角色 / 任务类型 / 门禁链）一改，
 *      之前提交的证据就不再覆盖当前定义——fold 用同一份 diff 判定 `evidenceStale`，
 *      避免「判定口径散落在 UI 和 fold 两处」。
 *
 * 纪律：白名单与 `TeamService.validateTaskPatch` 同源；比较用 JSON 值语义（数组按内容）。
 */

/** 可编辑字段白名单（与 service.validateTaskPatch 的 known 列表一致） */
export const EDITABLE_FIELDS = [
  'title',
  'description',
  'acceptanceCriteria',
  'deliverableSpec',
  'deps',
  'requiredRole',
  'taskType',
  'gateChain',
  'priority',
  'estimate',
  'tags',
]         

                                                            

/**
 * 结构性字段：改了就等于「任务的完成定义变了」。
 * 任务在跑时这些字段只能走 rescope（CHG-71 守卫）；任务已交付后改了 → 证据过期（CHG-73）。
 */
export const STRUCTURAL_FIELDS                      = new Set([
  'acceptanceCriteria',
  'deliverableSpec',
  'deps',
  'requiredRole',
  'taskType',
  'gateChain',
])

/** 单字段改动（from/to 为 JSON 值；数组按内容比较，不按引用） */
                              
               
               
             
 

/** 字段「含义上的当前值」：补丁里缺省 = 未改，不产生 change */
function fieldValue(input                         , field        )          {
  if (field === 'gateChain') {
    // 投影里 gateChain 与 gates 同步；账本旧数据可能只有其一，统一取 gateChain
    return input.gateChain ?? input.gates ?? []
  }
  return input[field]
}

function sameValue(a         , b         )          {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 计算补丁相对当前任务输入的实际改动（只含真正变化的字段）。
 * @param input 任务输入面（TaskProjection.input；也接受其 JSON 形态）
 * @param patch 待应用的补丁（白名单字段）
 */
export function diffTaskInput(input                         , patch                         )                {
  if (!patch || typeof patch !== 'object') return []
  const changes                = []
  for (const field of EDITABLE_FIELDS) {
    if (!(field in patch)) continue
    const before = fieldValue(input, field)
    const after = patch[field]
    if (sameValue(before, after)) continue
    changes.push({ field, from: before ?? null, to: after ?? null })
  }
  return changes
}

/** 补丁里是否有结构性字段（不看真的有没有变化——调用方可用 diff 结果更精确） */
export function hasStructuralFields(patch                         )          {
  return Object.keys(patch ?? {}).some((key) => STRUCTURAL_FIELDS.has(key))
}

/** 改动里落到结构性字段的那些字段名（证据过期判定用） */
export function structuralFieldsOf(changes               )           {
  return changes.filter((change) => STRUCTURAL_FIELDS.has(change.field)).map((change) => change.field)
}

/** 一个 changed 数组的稳定指纹（去重用：同一补丁重复提交不产生第二条等价事件） */
export function changesDigest(changes               )         {
  return changes
    .map((change) => `${change.field}=${JSON.stringify(change.to)}`)
    .sort()
    .join('|')
}


//# sourceURL=./src/core/tasks/diff.ts