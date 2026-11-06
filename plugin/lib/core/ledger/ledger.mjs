/**
 * D1 账本域（T2）：append-only JSONL 账本，唯一权威〔I2〕。
 *
 * 设计要点（ADR-002）：
 * - 单写者 = myteam service（host 进程内单例）；文件只追加不覆盖。
 * - append 前校验：事件 type 白名单 + payload schema + seq 连续性 + ts 单调。
 * - 崩溃恢复：写中途产生的不完整行（无换行尾）在重放时丢弃并截断（原子性）。
 * - rules.version：校验规则演进标记〔I3〕，账本首事件必须是 rules.version.adopted。
 * - 纯函数 fold 与 IO 分离（〔J1〕），投影在 D2/T3 实现。
 */
import { readFileSync, writeFileSync, statSync, truncateSync, openSync, writeSync, closeSync, fsyncSync } from 'node:fs'

/** 账本事件类型全集（PRD §7.2 + CHG-16 增补），payload 校验器见 validatePayload */
export const EVENT_TYPES = [
  'team.created',
  'plan.clarify',
  'plan.staged',
  'plan.revised',
  'plan.approved',
  'plan.discarded',
  'member.spawned',
  'member.released',
  'member.archived',
  'member.restored',
  'member.interrupted',
  'task.created',
  'task.claimed',
  'task.assigned',
  'task.attempt.revoked',
  'task.progress',
  'task.evidence',
  'task.completed',
  'task.failed',
  'task.escalated',
  'task.rescoped',
  'task.updated',       // CHG-70：任务元数据编辑（补丁合并，不改状态）
  'task.cancelled',     // CHG-73：取消任务（终态；下游按 downstream 策略处理）
  'task.rewired',       // CHG-75：下游改挂（把被取消的上游换成新上游，或解除依赖）
  'team.updated',       // CHG-70：团队名/目标编辑
  'task.proposal',
  'task.proposal.resolved',
  'task.deliverable',
  'task.gate.result',
  // CHG-69（FR-21）：任务 × 团队参与关系（多对多边；主责=lead，协作=coop）
  'task.participate',
  'task.participation.released',
  'message.sent',
  'message.consumed',
  'knowledge.proposed',
  'knowledge.adopted',
  'knowledge.revised', // v2.7 条目演化修订（FR-17.2，M2-0c）：refine/contradict 采纳落 diff 摘要
  // CHG-87（FR-16.4③）：跨会话引用留痕——消费 `session:<id>` 证据指针时落一条（读取即审计）
  'session.read',
  'memory.audit',
  'rules.version.adopted',
  'team.disbanded',
]         

                                                    

/** 当前校验规则版本（演进时 +1，老事件按其之前最新标记校验〔I3〕） */
export const RULES_VERSION = 1

                              
             
            
                                                                       
                 
                                  
 

/** 最小 payload 契约（字段存在性；详细校验在各域内做，账本只兜结构） */
const PAYLOAD_REQUIRED                                       = {
  'team.created': ['teamId', 'name', 'goal'],
  'plan.clarify': ['teamId', 'questions', 'round'],
  'plan.staged': ['teamId', 'planId'],
  'plan.revised': ['teamId', 'planId', 'note'],
  'plan.approved': ['teamId', 'planId'],
  'plan.discarded': ['teamId', 'planId'],
  'member.spawned': ['teamId', 'memberId', 'roleId', 'sessionId', 'status'],
  'member.released': ['teamId', 'memberId', 'mode'],
  'member.archived': ['teamId', 'memberId'],
  'member.restored': ['teamId', 'memberId'],
  'task.created': ['teamId', 'taskId', 'task'],
  'task.claimed': ['teamId', 'taskId', 'memberId', 'attemptId'],
  'task.assigned': ['teamId', 'taskId', 'memberId'],
  'task.attempt.revoked': ['teamId', 'taskId', 'attemptId', 'reason'],
  'task.progress': ['teamId', 'taskId', 'attemptId'],
  'task.evidence': ['teamId', 'taskId', 'attemptId', 'evidence'],
  'task.completed': ['teamId', 'taskId', 'attemptId'],
  'task.failed': ['teamId', 'taskId', 'attemptId', 'reason'],
  'task.escalated': ['teamId', 'taskId', 'attemptId', 'reason', 'count'],
  'task.rescoped': ['teamId', 'taskId', 'patch'],
  // CHG-70：patch 为白名单补丁；reason 可选（审计可读）
  'task.updated': ['teamId', 'taskId', 'patch'],
  // CHG-73：取消必须留理由（终态不可逆，审计要能回答"为什么停"）
  'task.cancelled': ['teamId', 'taskId', 'reason'],
  // CHG-75：改挂下游依赖；removed = 被换掉的上游 id；added 可省（= 解除依赖，下游变独立任务）
  'task.rewired': ['teamId', 'taskId', 'removed', 'reason'],
  'team.updated': ['teamId'],
  'task.proposal': ['teamId', 'taskId', 'proposalId', 'type'],
  'task.proposal.resolved': ['teamId', 'proposalId', 'decision'],
  'task.deliverable': ['teamId', 'taskId', 'path'],
  'task.gate.result': ['teamId', 'taskId', 'gate', 'verdict'],
  // CHG-69：participantTeamId = 参与团队；role = lead|coop；memberIds 可选（该团队为此任务派出的队员）
  'task.participate': ['teamId', 'taskId', 'participantTeamId', 'role'],
  'task.participation.released': ['teamId', 'taskId', 'participantTeamId'],
  'message.sent': ['teamId', 'messageId', 'from', 'to'],
  'message.consumed': ['teamId', 'messageId'],
  'knowledge.proposed': ['teamId', 'draftId', 'draft'],
  'knowledge.adopted': ['teamId', 'draftId'],
  // v2.7 条目演化修订（FR-17.2，M2-0c）：relation = refine|contradict，diff = 摘要字符串
  'knowledge.revised': ['teamId', 'entryId', 'relation', 'diff'],
  // CHG-87（FR-16.4③）：跨会话读取留痕（sessionId + 指针原文 + 谁读的）
  'session.read': ['teamId', 'sessionId', 'pointer', 'by'],
  'memory.audit': ['teamId', 'memberId', 'findings', 'checkedFiles', 'violations'],
  'rules.version.adopted': ['version'],
  'team.disbanded': ['teamId', 'archivedPaths'],
}

export class LedgerValidationError extends Error {
  code        
  constructor(code        , message        ) {
    super(message)
    this.name = 'LedgerValidationError'
    this.code = code
  }
}

/** 结构校验（append 前，拒绝式）。返回规范化后的事件。 */
export function validateEvent(
  draft                                                                      ,
  expectedSeq        ,
)              {
  if (!EVENT_TYPES.includes(draft.type)) {
    throw new LedgerValidationError('MT_LEDGER_UNKNOWN_TYPE', `unknown event type: ${draft.type}`)
  }
  if (typeof draft.actor !== 'string' || draft.actor.length === 0) {
    throw new LedgerValidationError('MT_LEDGER_BAD_ACTOR', 'actor must be a non-empty string')
  }
  const payload = draft.payload ?? {}
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LedgerValidationError('MT_LEDGER_BAD_PAYLOAD', 'payload must be an object')
  }
  const required = PAYLOAD_REQUIRED[draft.type] ?? []
  for (const key of required) {
    if (payload[key] === undefined) {
      throw new LedgerValidationError('MT_LEDGER_MISSING_FIELD', `${draft.type} missing payload.${key}`)
    }
  }
  return {
    seq: expectedSeq,
    ts: Date.now(),
    actor: draft.actor,
    type: draft.type,
    payload,
  }
}

/**
 * 解析一行 JSON；不完整/不可解析行（崩溃残留）返回 null，由调用方决定截断还是跳过。
 * JSON 可解析但结构不是事件的（缺 seq/ts/type、非对象）抛 MT_LEDGER_CORRUPT。
 */
function parseLine(line        , lineNo        )                     {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let value         
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null // 不完整行，调用方负责截断
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LedgerValidationError('MT_LEDGER_CORRUPT', `corrupt event at line ${lineNo}`)
  }
  const event = value               
  if (typeof event.seq !== 'number' || typeof event.ts !== 'number' || typeof event.type !== 'string') {
    throw new LedgerValidationError('MT_LEDGER_CORRUPT', `corrupt event at line ${lineNo}`)
  }
  return event
}

                                   
                       
                 
                                 
                   
     
                                                    
                                                      
     
                    
                                                 
                     
 

/**
 * 打开账本：全量重放 + 崩溃残留截断 + 中部坏行跳过（QA-1）。
 * 语义（FR-4.6 有序恢复的账本侧前提）：重放必须无损，残留行截断后 nextSeq 连续。
 *
 * 坏行的两种处置（旧实现一律 break + 只砍最后一行，中部坏行会静默带走其后全部合法事件）：
 * - 尾部残行（其后没有任何内容）→ 截断该行，计入 `truncated`（语义不变）。
 * - 中部坏行 → 跳过该行**继续解析后续行**，计入 `corrupted`，绝不丢后续事件。
 * 重写账本时只保留能完整解析的事件行（原样保留），保证重写后可完整重放。
 */
export function openLedger(filePath        )                   {
  let raw        
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return { events: [], nextSeq: 0, truncated: 0, corrupted: 0, compacted: false }
  }
  const events                = []
  /** 能完整解析的事件行原文（重写时原样保留：payload 内可能含任意串，不能重新序列化） */
  const goodLines           = []
  let truncated = 0
  let corrupted = 0
  let dirty = false
  const lines = raw.split('\n')
  // 末行无换行 = 可能是崩溃残留（写一半），单独判定
  const lastIndex = lines.length - 1
  let expectedSeq                = null // 上一事件之后「应有的」seq（null = 还没有事件）
  let skipped = 0                       // 上一事件之后跳过的坏行数（解释 seq 空洞）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    const tailWithoutNewline = i === lastIndex && !raw.endsWith('\n')
    let parsed                    
    try {
      parsed = parseLine(line, i + 1)
    } catch (e) {
      // JSON 合法但不是事件（MT_LEDGER_CORRUPT）：按坏行处理，绝不让一行带崩整次重放
      if (!(e instanceof LedgerValidationError)) throw e
      parsed = null
    }
    if (parsed === null) {
      dirty = true
      if (tailWithoutNewline) {
        // 尾部残行：截断（语义不变），其后没有内容可丢
        truncated += 1
        break
      }
      // 中部坏行：跳过并继续（QA-1 核心修复，旧实现这里 break 会丢光后续事件）
      corrupted += 1
      skipped += 1
      continue
    }
    // seq 连续性：坏行本身可能占了一个 seq，因此可接受区间 [expectedSeq, expectedSeq + skipped]
    if (expectedSeq !== null && (parsed.seq < expectedSeq || parsed.seq > expectedSeq + skipped)) {
      // 断点/回退 = MT_LEDGER_CORRUPT 级问题：仍然保留事件（不丢），只计数暴露给调用方告警
      corrupted += 1
    }
    expectedSeq = parsed.seq + 1
    skipped = 0
    events.push(parsed)
    goodLines.push(line)
  }
  // 行尾无换行的合法末行：补一个换行，否则下次 appendEvent 会把新事件拼到这一行尾部
  if (!dirty && !raw.endsWith('\n') && goodLines.length > 0) dirty = true
  if (dirty) {
    // 重写：只保留能解析的事件行（中部坏行剔除、尾部残行截断），其余原样保留
    const contentToWrite = goodLines.length > 0 ? `${goodLines.join('\n')}\n` : ''
    truncateSync(filePath, 0)
    if (contentToWrite.length > 0) {
      const fd = openSync(filePath, 'r+')
      writeSync(fd, contentToWrite, 0, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
    }
  }
  const nextSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 0
  return { events, nextSeq, truncated, corrupted, compacted: dirty }
}

/** 追加单事件（含 fsync 持久化屏障）。seq 由本函数按账本尾部分配。 */
export function appendEvent(filePath        , event             )       {
  const line = `${JSON.stringify(event)}\n`
  let existed = false
  try {
    statSync(filePath)
    existed = true
  } catch {
    existed = false
  }
  if (!existed) {
    // 新账本：首事件必须是 rules.version.adopted〔I3〕
    if (event.type !== 'rules.version.adopted') {
      throw new LedgerValidationError('MT_LEDGER_MISSING_RULES_VERSION', 'first event must be rules.version.adopted')
    }
    writeFileSync(filePath, line, 'utf8')
    return
  }
  const fd = openSync(filePath, 'a')
  writeSync(fd, line, 0, 'utf8')
  fsyncSync(fd)
  closeSync(fd)
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/ledger/ledger.ts