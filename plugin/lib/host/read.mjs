/**
 * CHG-200（用户定案「队长没有最基本的读取工具」）：**队长读面适配层**。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────────────
 * `host.ts` 的 A6 行数棘轮（入口层只减不增）不允许把读面逻辑堆进入口层。这里只做
 * 「取投影 → 调 core 视图构建器 → 裁剪 → 返回」；状态机与视图口径都在
 * `core/index/views.ts`（与面板同源）和 `core/knowledge/**`——**不另造第二套读模型**。
 *
 * ── 三条纪律（与 `tools/defs.ts` 队长读面的注释同源）───────────────────────
 *  ① **只读**：不 `commit`、不改状态（t144 断言调用前后账本行数一致）；
 *  ② **不含 attemptId**：attemptId 是写凭据（陈旧写校验），只发给当前持有人——
 *     队长读面返回它，等于给「代成员写」开了口子，与「队长不做领域工作」相悖；
 *  ③ **限界读**（NFR-7.6）：证据 / 时间线 / 消息按上限截断，并用 `omitted` 如实报
 *     未展示条数——「返回 N 行」不等于「已读全部内容」。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────
 * `executeLeadTool` 的返回类型是 `Record | Promise<Record>`；读面全是同步投影，
 * 加 `async` 会把原本同步的结果变成 Promise（面板远程面/测试就地拿到 `[object Promise]`）。
 */
                                                     
import { buildTaskDetailView } from '../core/index/views.mjs'
import { knowledgeEntryView } from '../core/knowledge/knowledge.mjs'

/** 读面用到的宿主能力（**只列用到的成员**，不做全能门面） */
                                  
                                                      
                                      

     
                                  
    
                                                                     
                                                             
     
                                                                                             

                                        
                         
 

/** 证据条数默认上限（按最新取）——证据块可能很长，全量返回等于把 token 预算当燃料 */
const DEFAULT_EVIDENCE_LIMIT = 5
/** 时间线/消息默认上限（详情页同源视图可能上百条） */
const DEFAULT_TIMELINE_LIMIT = 20
/** 看板默认行数 / 硬上限（与 docs/04 的限界读口径一致） */
const DEFAULT_TASK_ROWS = 50
const MAX_TASK_ROWS = 200

/** 整数 clamp（非法值回落默认；**不抛错**——读工具不该因为一个可选参数失败） */
function clampInt(value         , fallback        , min        , max        )         {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/**
 * 取数组**最新**的 n 条（账本/时间线都是追加序，最新的在尾部）。
 *
 * `slice(-0)` 等于 `slice(0)`（返回全部）——这正是「上限 0 却返回全部」的经典坑，
 * 所以必须显式判 `<= 0`。
 */
function takeLast   (items     , n        )      {
  if (n <= 0) return []
  return items.slice(-n)
}

export function createReadHandlers(host                 ) {
  return {
    /**
     * `myteam_read_task`：任务完整视图（队长侧）。
     *
     * 为什么复用 `buildTaskDetailView`：面板「任务详情」与队长读面必须是**同一份口径**——
     * 两处各算一次「证据按 attempt 分组 / 改动记录 / 门禁裁决」必然漂移（CHG-153 的教训）。
     */
    readTask(teamId        , args                         )                          {
      const taskId = String(args.taskId ?? '').trim()
      if (taskId.length === 0) {
        return { status: 'error', code: 'MT_VALIDATION', field: 'taskId', message: 'taskId is required' }
      }
      const svc = host.service(teamId)
      const { events } = host.readLedgerEvents(svc.ledgerPath)
      const detail = buildTaskDetailView(svc, taskId, events         )
      if (!detail) {
        return { status: 'error', code: 'MT_VALIDATION', field: 'taskId', message: `task "${taskId}" not found` }
      }
      const evidenceLimit = clampInt(args.evidenceLimit, DEFAULT_EVIDENCE_LIMIT, 0, 50)
      const timelineLimit = clampInt(args.timelineLimit, DEFAULT_TIMELINE_LIMIT, 0, 200)
      const evidenceRefs = takeLast(detail.evidenceRefs, evidenceLimit)
      const timeline = takeLast(detail.timeline, timelineLimit)
      const messages = takeLast(detail.messages, timelineLimit)
      // ② 不含 attemptId：解构丢弃（不是「有但不展示」——返回体里不能出现这个字段）
      const { attemptId: _attemptId, ...rest } = detail
      return {
        status: 'ok',
        task: { ...rest, evidenceRefs, timeline, messages },
        omitted: {
          evidence: detail.evidenceRefs.length - evidenceRefs.length,
          timeline: detail.timeline.length - timeline.length,
          messages: detail.messages.length - messages.length,
        },
        note: '只读快照（不含 attemptId：写凭据只发给当前持有人）；证据/时间线按最新截断，omitted 是未展示条数（NFR-7.6）',
      }
    },

    /**
     * `myteam_read_board`：任务看板（队长侧）。
     *
     * 与成员侧 `myteam_list_tasks` 的区别：成员按「我可领的我」过滤（claimable 依赖角色），
     * 队长**没有可领集合**——它看的是全队看板（谁在跑 / 哪里卡住 / 还差几个）。
     */
    readBoard(teamId        , args                         )                          {
      const svc = host.service(teamId)
      const proj = svc.projectionSnapshot
      const normalize = (value         )                     => {
        const text = typeof value === 'string' ? value.trim() : ''
        return text.length > 0 && text !== 'all' ? text : undefined
      }
      const state = normalize(args.state)
      const requiredRole = normalize(args.requiredRole)
      const assignee = normalize(args.assignee)
      const limit = clampInt(args.limit, DEFAULT_TASK_ROWS, 1, MAX_TASK_ROWS)
      const all = Object.values(proj.tasks)
      const byState                         = {}
      for (const task of all) byState[task.state] = (byState[task.state] ?? 0) + 1
      const filtered = all.filter(
        (task) =>
          (state === undefined || task.state === state) &&
          (requiredRole === undefined || task.input.requiredRole === requiredRole) &&
          (assignee === undefined || task.assignee === assignee || (task.assignees ?? []).includes(assignee)),
      )
      const rows = filtered.slice(0, limit).map((task) => ({
        id: task.id,
        title: task.input.title,
        state: task.state,
        priority: task.input.priority,
        requiredRole: task.input.requiredRole,
        ...(task.assignee ? { assignee: task.assignee } : {}),
        ...(task.assignees && task.assignees.length > 0 ? { assignees: [...task.assignees] } : {}),
        deps: [...(task.input.deps ?? [])],
        escalateCount: task.escalateCount,
        evidenceCount: task.evidenceRefs.length,
      }))
      const open = all.filter((task) => !['done', 'failed', 'cancelled'].includes(task.state)).length
      const filters = [
        state ? `state=${state}` : 'state=all',
        ...(requiredRole ? [`role=${requiredRole}`] : []),
        ...(assignee ? [`assignee=${assignee}`] : []),
      ].join(' · ')
      return {
        status: 'ok',
        teamId,
        counts: { total: all.length, open, done: byState.done ?? 0, byState },
        tasks: rows,
        returnedCount: rows.length,
        note: `返回 ${rows.length} 行 ≠ 已读全部内容（NFR-7.6）；过滤：${filters}`,
      }
    },

    /**
     * `myteam_read_knowledge_entry`：知识条目全文（队长侧）。
     *
     * 与成员侧 `myteam_read_knowledge` **同语义不同名**：视图构建收敛到
     * `core/knowledge/knowledge.ts` 的 `knowledgeEntryView`（stale 前缀只有一处实现）。
     */
    readKnowledgeEntry(_teamId        , args                         )                          {
      const id = String(args.id ?? '').trim()
      if (id.length === 0) {
        return { status: 'error', code: 'MT_VALIDATION', field: 'id', message: 'id is required' }
      }
      const entry = knowledgeEntryView(host.workspaceRoot(), id)
      if (!entry) return { status: 'error', code: 'MT_KB_NOT_FOUND', message: `knowledge entry "${id}" not found（索引见提示词）` }
      return { status: 'ok', entry }
    },
  }
}


//# sourceURL=./src/host/read.ts