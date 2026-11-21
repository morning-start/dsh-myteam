/**
 * P1-6（docs/21 §6）：**工具输出契约**——`jsonOutput` 双声明。
 *
 * 为什么必须有：68 个工具的 `output.schema` 此前只有 `{ status: string }` —— 结果契约只声明了
 * 一个字段，宿主的 `createSuccessResult → validateJsonSchemaValue` 等于什么都没校验，
 * 面板与模型也都不知道「这个工具能拿到什么」。
 *
 * 官方范式（`tool/lib/index.js:211-219`）是**双声明**：
 *   ① `output.schema` = 完整结果契约（成功字段与失败字段在同一个 schema 里）；
 *   ② `render` 只负责把值压成**紧凑 JSON**（不丢字段、不加装饰、不 pretty-print）。
 * 本模块是这两件事的唯一来源，`defs.ts` 的 68 个工具全部经它声明。
 *
 * 三条纪律（都是「为什么这么写」而不是「怎么写」）：
 *
 *  ① **契约必须能拒绝东西**：`required: ['status']` + 状态词表 `RESULT_STATUSES`。
 *     只有 `properties` 的 schema 是注释不是契约——`assertToolResult` 是它的运行时面。
 *
 *  ② **不改工具行为**：`properties` 只做**开放声明**（不加 `additionalProperties: false`），
 *     既有 `execute` 返回值原样通过宿主校验。本批只补声明、不动返回形状——
 *     68 个工具的真实返回里有 `field` / `currentRevision` / `attemptId` 等按路径才出现的字段，
 *     写死 `additionalProperties` 会让今天能用的工具明天报 `ToolOutputError`。
 *
 *  ③ **失败不抛**：`assertToolResult` 返回结构化结果（`{ok:false, code:'MT_TOOL_CONTRACT'}`）。
 *     工具管线里抛错会被宿主编译成 `MT_INTERNAL`，真正的原因（哪个字段缺了）就丢了。
 *
 * 运行：`cd plugin && node --test test/t121-tool-output-contract.test.ts`
 */
import { TOOL_TIERS,               } from './tool-tiers.mjs'

/** JSON Schema 子集（宿主 `assertSupportedJsonSchema` 认的那一套：type/properties/required/items/enum/description） */
                                                    

/** 宿主 `ctx.tools.register` 的 output 契约（T0 实证 tools.register 校验器）：
 *  `{ schema, render, presentationMeta? }`；`schema` 会被用于 execute 返回值校验。 */
                             
                        
                                                                                                        
 

/** `assertToolResult` 的裁决结果（**不抛**：调用方决定记日志还是阻断） */
                                                                                                     

/** 契约违规码。与 `core/errors.ts` 的 `MT_*` 单一来源同口径（t81 门禁守它）。 */
export const TOOL_CONTRACT_CODE = 'MT_TOOL_CONTRACT'         

/**
 * 结果状态词表（**超集**，只用于 `assertToolResult` 的合法性判定，不写进 schema）。
 *
 * 为什么不把词表写进 `output.schema.properties.status.enum`：宿主会拿 schema 校验 execute
 * 的返回值，`enum` 写窄了 = 今天能跑的工具明天报 `ToolOutputError`（真实返回里有
 * staged / approved / claimed / confirm-required 等 40 余种领域状态）。所以：
 *   - **schema 开放**（`type: 'string'`）→ 不阻断既有返回；
 *   - **运行时词表**（本数组）→ 契约仍然能拒绝拼错的状态。
 *
 * 词表来源：`src/**` 里全部 status 的字符串字面量（t121 有一条漂移门禁盯着它，
 * 新增状态忘了登记会变红）。
 */
export const RESULT_STATUSES                    = [
  'active',
  'adopted',
  'applied',
  'approved',
  'assigned',
  'batch-done',
  'cancelled',
  'changed',
  'claimed',
  'clarify-limit',
  'cleared',
  'completed',
  'confirm-required',
  'copied',
  'created',
  'deleted',
  'disbanded',
  'discarded',
  'drain-pending',
  'empty',
  'error',
  'escalated',
  'failed',
  'forked',
  'gate-fail',
  'gate-pass',
  'interrupted',
  'needs-human',
  'noop',
  'not-running',
  'ok',
  'participating',
  'proposed',
  'provisioning',
  'published',
  'reassigned',
  'rejected',
  'rescoped',
  'reset',
  'restored',
  'revised',
  'revoked',
  'saved',
  'sent',
  'set',
  'spawned',
  'staged',
  /* CHG-165（T133 并行分支）：`myteam_message` 的 steer 语义结果（消息已投递并转向成员当前轮）。 */
  'steered',
  'timeout',
  'unavailable',
  'updated',
]

const RESULT_STATUS_SET = new Set        (RESULT_STATUSES)

/** 统一结果契约的**字段说明**（`TOOL_RESULT_SCHEMA.properties` 的单一来源） */
const RESULT_PROPERTIES                                 = {
  status: {
    type: 'string',
    description: '结果状态：ok=成功 / error=失败；其余为领域状态（staged、approved、claimed、confirm-required…），见 RESULT_STATUSES',
  },
  code: { type: 'string', description: '错误码（MT_*；status=error 时给，面板/客户端据此分支）' },
  message: { type: 'string', description: '给人和模型看的说明（失败原因 / 下一步该做什么）' },
  field: { type: 'string', description: '校验失败时点名的参数名（如 teamId），面板据此高亮表单字段' },
  data: {
    type: 'object',
    description: '结构化结果兜底槽（工具专属字段能具名的在 TOOL_OUTPUT_FIELDS 里就地展开）',
  },
}

/**
 * 统一结果契约：68 个工具**共同**的那部分。
 *
 * `required` 只有 `status`：它是唯一「所有工具、所有分支都一定给」的字段。
 * 其余字段按工具就地补（`TOOL_OUTPUT_FIELDS`），没补的也不代表拿不到——
 * 开放声明下额外字段照常通过。
 */
export const TOOL_RESULT_SCHEMA                 = deepFreeze({
  type: 'object',
  properties: RESULT_PROPERTIES,
  required: ['status'],
})

/**
 * **每个工具就地补的结果字段**（只列「结果里确有、且值得让模型/面板知道」的）。
 *
 * 只收验证过真实返回形状的：`host.ts` 的 `executeLeadTool` / `executeMemberTool` 分支
 * （如 `myteam_claim_task` → `{status:'claimed', attemptId, task}`）。
 * 没登记的工具走统一契约——这不是漏，是「猜字段不如不写」：写错的声明会在
 * 宿主校验时把能用的工具判红。
 */
export const TOOL_OUTPUT_FIELDS                                 = {
  /* ── 成员工具：任务面 ─────────────────────────────────────── */
  myteam_get_task: {
    properties: {
      task: {
        type: 'object',
        description: '任务投影（id/title/description/acceptanceCriteria/deliverableSpec/deps/requiredRole/priority/state/attemptId/escalateCount）；attemptId 只发给当前持有人',
      },
    },
  },
  myteam_list_tasks: {
    properties: {
      tasks: { type: 'array', items: { type: 'object' }, description: '任务行（id/title/state/priority/requiredRole）' },
      returnedCount: { type: 'number', description: '本次返回行数（≠ 已读内容，NFR-7.6）' },
      note: { type: 'string', description: '限界读说明' },
    },
  },
  myteam_claim_task: {
    properties: {
      attemptId: { type: 'string', description: '领取到的 attemptId —— 后续 update 必须带上它（陈旧被拒 MT_ATTEMPT_STALE）' },
      task: { type: 'object', description: '被领取任务的摘要（id/title/acceptanceCriteria/deliverableSpec）' },
    },
  },
  myteam_escalate_task: {
    properties: {
      count: { type: 'number', description: '本任务累计 escalate 次数（>2 时建议人工介入，FR-11.7）' },
      note: { type: 'string', description: '下一步提示' },
    },
  },
  myteam_propose_task_change: {
    properties: {
      proposalId: { type: 'string', description: '提案 id（进队长队列；批准才生效，FR-11.4）' },
      note: { type: 'string', description: '下一步提示' },
    },
  },
  myteam_read_knowledge: {
    properties: {
      entry: {
        type: 'object',
        description: '知识条目（id/title/tags/unverified/staleSince/proofCount/body）；stale 时 body 带待复核前缀',
      },
    },
  },
  /* CHG-200（用户定案「任务检查应该由成员自己完成」）：**成员提交门禁裁决**。
   * 审查者 = 调用者；review/verify 门强制交叉审查（reviewer ≠ 实现者，MT_CROSS_REVIEW）。 */
  myteam_submit_review: {
    properties: {
      gate: { type: 'string', description: '门禁名（review / verify / archive）' },
      taskState: { type: 'string', description: '裁决后的任务状态（gate-pass / gate-fail / needs-human 等）' },
      rejectCount: { type: 'number', description: '本门已打回轮数（>0 时看板/详情可见）' },
      delivery: { type: 'object', description: '交付判定结果（P1-2 三级信号；review 门只留痕不否决）' },
      note: { type: 'string', description: '口径说明（archive 门由 host 落位校验，不接受模型自述）' },
    },
  },
  /* CHG-163（docs/10 KI-9）：队长侧**提案入口**的结果面——只回提案凭据，不回条目
   * （条目要等 `myteam_adopt_knowledge` 采纳后才存在于 config/knowledge/，宣称有就是假的）。 */
  myteam_propose_knowledge: {
    properties: {
      draftId: { type: 'string', description: '提案 id（knowledge.proposed 事件的 draftId；`myteam_adopt_knowledge` 用它采纳）' },
      relation: { type: 'string', description: '与既有条目的关系声明（new/refine/contradict）' },
      targetId: { type: 'string', description: 'refine/contradict 的目标条目 id（new 关系时缺省）' },
      evidence: { type: 'array', items: { type: 'string' }, description: '归一化后的证据指针（kind:ref）；条目证据取第一条' },
      note: { type: 'string', description: '下一步提示（未入库；等队长/用户采纳）' },
    },
  },
  /* ── Lead 工具：只读面 ───────────────────────────────────── */
  /* CHG-200（用户定案「队长没有最基本的读取工具」）：**队长读面**——任务详情 / 看板 / 知识条目。
   * 只读：不写账本、不改状态；**不返回 attemptId**（写凭据只发给当前持有人）。 */
  myteam_read_task: {
    properties: {
      task: {
        type: 'object',
        description: '任务完整视图（state/input/gates/gateVerdicts/assignees/evidenceRefs/deliverables/timeline/edits/scopeAudit）；**不含 attemptId**',
      },
      omitted: { type: 'object', description: '被截断的条数（evidence/timeline/messages；限界读 NFR-7.6）' },
      note: { type: 'string', description: '只读口径说明' },
    },
  },
  /* CHG-210 批 6.1：待批提案清单（队长侧）。字段少但都是决策必需：没有 proposalId
   * 队长无法调 resolve_proposal；没有 proposerId 驳回后不知道该通知谁。 */
  myteam_list_proposals: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      count: { type: 'number', description: '条数' },
      proposals: { type: 'array', items: { type: 'object' }, description: '提案行（proposalId/taskId/type/status/title/proposerId）' },
    },
  },
  myteam_read_board: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      counts: { type: 'object', description: '计数（total/open/done/byState）' },
      tasks: { type: 'array', items: { type: 'object' }, description: '任务行（id/title/state/priority/requiredRole/assignee/assignees/deps/escalateCount/evidenceCount）' },      returnedCount: { type: 'number', description: '本次返回行数（≠ 已读全部内容，NFR-7.6）' },
      note: { type: 'string', description: '限界读说明' },
    },
  },
  myteam_read_knowledge_entry: {
    properties: {
      entry: { type: 'object', description: '知识条目（id/title/tags/unverified/staleSince/proofCount/body）；stale 时 body 带待复核前缀' },
    },
  },
  /* CHG-212（ADR-010）：长期记忆（SQLite bank）三件套。 */
  myteam_remember: {
    properties: {
      id: { type: 'string', description: '记忆条目 id（supersedes / forget 用）' },
      bank: { type: 'string', description: '落库的 bank（member:<team>:<member> / team:<team>）' },
      kind: { type: 'string', description: '记忆类型' },
      title: { type: 'string', description: '标题' },
    },
  },
  myteam_recall: {
    properties: {
      entries: { type: 'array', items: { type: 'object' }, description: '召回条目（id/kind/title/body/evidence/importance/score），按 score 降序' },
      returnedCount: { type: 'number', description: '本次返回条数（空 = 正常结果，不是错误）' },
      note: { type: 'string', description: '评分口径说明' },
    },
  },
  myteam_forget: {
    properties: {
      id: { type: 'string', description: '被归档的条目 id' },
      forgotten: { type: 'boolean', description: '是否命中活条目（重复归档返回 false）' },
    },
  },
  myteam_get_audit: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      total: { type: 'number', description: '账本事件总数（不受本页 limit 影响）' },
      count: { type: 'number', description: '本页返回条数' },
      events: { type: 'array', items: { type: 'object' }, description: '审计事件（seq/type/actor/ts），按 seq 倒序' },
      nextBeforeSeq: { type: 'number', description: '往前翻页游标（不含）；本页为空时缺省' },
      note: { type: 'string', description: '口径说明' },
    },
  },
  myteam_get_tokens: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      tokens: { type: 'object', description: 'token 计量（days 增量桶 + totals；估算值，不是账单）' },
    },
  },
  myteam_list_skills: {
    properties: {
      total: { type: 'number', description: '去重后的技能数' },
      declared: { type: 'array', items: { type: 'object' }, description: '角色目录里已绑定的技能（name/boundBy）' },
      host: { type: 'object', description: '宿主技能服务清单（available=false 时带 note，不伪造）' },
      note: { type: 'string', description: '能力不可用时的说明' },
    },
  },
  /* CHG-187（FR-32 支柱一）：名册只读面——成员 + 派生树事实（父 / 深度 / 树根 / 子成员数） */
  myteam_list_members: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      total: { type: 'number', description: '成员数' },
      members: {
        type: 'array',
        items: { type: 'object' },
        description: '成员行（id/roleId/instanceName/status/parentMemberId/depth/rootMemberId/childCount）',
      },
    },
  },
  /* CHG-213（实机）：`myteam_message` 必须如实回报「有没有送到」——账本落了 ≠ 送到了。
   * 旧实现只回 `{status:'sent'}`，成员根本没起来时队长也以为送达了（本次验收正是被它掩盖）。 */
  myteam_message: {
    properties: {
      delivered: { type: 'boolean', description: '是否真的投递到活着的成员会话（false = 已落账未送达，按 message 给的下一步处理）' },
    },
  },
  myteam_get_task_graph: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      nodes: { type: 'array', items: { type: 'object' }, description: '任务节点（id/title/state/priority/requiredRole）' },
      edges: { type: 'array', items: { type: 'object' }, description: '依赖边（from/to）' },
      layers: { type: 'array', items: { type: 'array' }, description: '拓扑层级（同层可并行；有环时只含无环部分）' },
      order: { type: 'array', items: { type: 'string' }, description: '拓扑序' },
      cycles: { type: 'array', items: { type: 'array' }, description: '环（每环是任务 id 序列）' },
      hasCycle: { type: 'boolean', description: '是否存在环' },
    },
  },
  myteam_list_teams: {
    properties: {
      workspaceRoot: { type: 'string', description: '工作区根（团队按项目隔离）' },
      state: { type: 'string', description: '本次过滤用的状态（all/draft/active/archived/discarded）' },
      total: { type: 'number', description: '过滤后团队数' },
      teams: { type: 'array', items: { type: 'object' }, description: '团队行（teamId/name/goal/state/tasks）' },
      archived: { type: 'object', description: '归档团队（count/ids）；includeArchived=false 时缺省' },
      note: { type: 'string', description: '索引未生成时的说明（不假装没有团队）' },
    },
  },
  myteam_get_team: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      name: { type: 'string', description: '团队名' },
      goal: { type: 'string', description: '团队目标' },
      state: { type: 'string', description: '团队状态' },
      counts: { type: 'object', description: '计数（tasks/done/running/members）' },
      members: { type: 'array', items: { type: 'object' }, description: '名册摘要（id/roleId/instanceName/status/currentTaskId）' },
    },
  },
  myteam_read_session: {
    properties: {
      sessionId: { type: 'string', description: '会话 id' },
      items: { type: 'array', items: { type: 'object' }, description: '有界摘要（seq/role/type/ts/text/truncated）' },
      omitted: { type: 'number', description: '本页未展示的条数' },
      hasMore: { type: 'boolean', description: '是否还有更早的历史' },
      chars: { type: 'number', description: '本页原文总字符数' },
      notes: { type: 'array', items: { type: 'string' }, description: '阅读纪律说明（只读历史，不是当前上下文）' },
    },
  },
  /* ── Lead 工具：写面 ─────────────────────────────────────── */
  myteam_export_team: {
    properties: {
      teamId: { type: 'string', description: '团队 id' },
      filePath: { type: 'string', description: '快照落盘路径' },
      bytes: { type: 'string', description: '快照字节数' },
      counts: { type: 'object', description: '计数（roster/events/hasConfig）' },
      note: { type: 'string', description: '口径说明（不含会话 id / 记忆 / token 明细）' },
    },
  },
}

/** 深冻结：契约是共享常量，任何调用方改它都是全局面貌漂移（且没人会想到） */
function deepFreeze   (value   )    {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value                           )) deepFreeze(child)
  }
  return value
}

/**
 * 合成「统一契约 + 工具就地字段」的完整结果契约。
 *
 * 合并语义（三条都不难，但错了就很难查）：
 *  - `properties` **并集**（就地字段覆盖同名字段，其余保留）；
 *  - `required` **并集去重**且 `status` 一定在内 —— 工具可以加必填字段，不能把 status 减掉；
 *  - 其余关键字（`description` 等）以就地声明为准。
 */
export function jsonOutput(schema                 )             {
  const extra = schema ?? {}
  const baseProps = (TOOL_RESULT_SCHEMA['properties'] ?? {})                                  
  const extraProps = (extra['properties'] ?? {})                                  
  const baseRequired = (TOOL_RESULT_SCHEMA['required'] ?? [])            
  const extraRequired = (extra['required'] ?? [])            
  const properties = deepFreeze({ ...baseProps, ...extraProps })
  const required = [...new Set([...baseRequired, ...extraRequired])]
  return {
    schema: deepFreeze({ ...TOOL_RESULT_SCHEMA, ...extra, properties, required }),
    /** 紧凑 JSON：不 pretty-print（省 token）、不筛选（不丢字段）、不包壳（宿主自己包 text 块） */
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value) }]
    },
  }
}

/** 某个工具的完整结果契约（未就地声明字段的工具 = 统一契约） */
export function outputForTool(toolName        )             {
  return jsonOutput(TOOL_OUTPUT_FIELDS[String(toolName)])
}

/**
 * 运行时校验一次工具返回值（**不抛**）。
 *
 * 检查顺序 = 排障顺序：先问「是不是对象」，再问「有没有 status」，最后问「status 认不认识」。
 * 三条都过才 `{ok:true}`；失败带**具体值**（`status "BOGUS"`），否则排障要回读源码。
 */
export function assertToolResult(toolName        , result         )                  {
  const fail = (message        )                  => ({ ok: false, code: TOOL_CONTRACT_CODE, message })
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return fail(`${toolName} 的返回值必须是 plain object（结果契约根类型 object），实际 ${describeValue(result)}`)
  }
  const record = result                           
  if (!('status' in record)) {
    return fail(`${toolName} 缺少必填字段 status（契约：{ status, code?, message?, field?, data? }）`)
  }
  if (typeof record['status'] !== 'string' || record['status'].length === 0) {
    return fail(`${toolName} 的 status 必须是非空字符串，实际 ${describeValue(record['status'])}`)
  }
  if (!RESULT_STATUS_SET.has(record['status'])) {
    return fail(`${toolName} 的 status ${describeValue(record['status'])} 不在结果状态词表里（新增状态请先登记 RESULT_STATUSES）`)
  }
  for (const key of ['code', 'message', 'field']         ) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'string') {
      return fail(`${toolName} 的 ${key} 必须是字符串，实际 ${describeValue(value)}`)
    }
  }
  return { ok: true }
}

/** 一个工具的契约清单条目（供测试断言覆盖度 / 面板展示「这个工具能拿到什么」） */
                                    
              
                
                            
                        
                                        
                          
 

/**
 * 68 个工具的契约清单（**按名字排序**，与 `TOOL_TIERS` 同源）。
 *
 * 为什么从 `TOOL_TIERS` 派生而不是再写一份名单：档位表已经是「工具有哪些」的单一事实源
 * （t107 双向锁死），再抄一份 63 行名单必然漂移。数量/去重由 t121 断言。
 */
export function describeContract()                      {
  return Object.keys(TOOL_TIERS)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const declared = (TOOL_OUTPUT_FIELDS[name]?.['properties'] ?? {})                                  
      return {
        name,
        tier: TOOL_TIERS[name] ,
        schema: outputForTool(name).schema,
        declaredFields: Object.keys(declared).sort((a, b) => a.localeCompare(b)),
      }
    })
}

/** 排障用的值描述（`typeof` 对 null/数组/对象不够区分，`String({})` 又太长） */
function describeValue(value         )         {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') return 'object'
  return String(value)
}


//# sourceURL=./src/core/tools/output-contract.ts