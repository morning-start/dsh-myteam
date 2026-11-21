/**
 * P1-2 交付判定的正文长度下限（按任务类型）。
 *
 * 为什么按类型分档：实现类（dev）的产出主要在文件里，正文只需要简短汇报；
 * 需求 / 验收类（prd/qa）的交付物**就是文字结论**，短正文必然信息不足。
 * 为什么导出常量：面板、提示词、文档要引用同一组数字——各写一份必然漂移。
 *
 * 宿主无关的纯规则，从 `host.ts` 搬出来（CHG-212 顺带给 A6 腾行，逻辑零变化）。
 */
export const DELIVERABLE_MIN_LENGTH                                                 = {
  dev: 60,
  qa: 250,
  prd: 400,
}

/**
 * 任务类型 → 正文长度下限。未知类型按 `dev`（实现类最常见、下限最宽松）：
 * 挡住「空话冒充交付」靠的是下限本身，不是分档的精度。
 */
export function deliverableMinLength(taskType         )         {
  const type = String(taskType ?? '').trim().toLowerCase()
  if (type.length === 0) return DELIVERABLE_MIN_LENGTH.dev
  if (type.includes('qa') || type.includes('test') || type.includes('accept')) return DELIVERABLE_MIN_LENGTH.qa
  if (type.includes('prd') || type.includes('req') || type.includes('design') || type.includes('doc')) return DELIVERABLE_MIN_LENGTH.prd
  return DELIVERABLE_MIN_LENGTH.dev
}


//# sourceURL=./src/core/tasks/deliverable.ts