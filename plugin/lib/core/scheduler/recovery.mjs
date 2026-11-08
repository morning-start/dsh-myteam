/**
 * T8 archive 门禁 + T16 有序恢复（host 侧逻辑，纯函数 + 文件校验分离）。
 *
 * archive 门禁（FR-10.4）：校验产物文件存在于 deliverableSpec 约定路径（轻量落位校验，
 * 不做内容语义评审——那是 review 门禁的事）。
 *
 * 有序恢复表（FR-4.6/I8/D7）：重启后按优先级选一条恢复路径。
 */
import { existsSync } from 'node:fs'

                                   
              
                 
 

/** archive gate 判定：约定路径存在即 pass（M1 轻量）；无约定 → fail（叶子任务必填在计划校验已拦） */
export function checkArchiveGate(
  deliverableSpec                              ,
  actualDeliverables                    ,
  fileExists                         = existsSync,
)                                                                 {
  if (!deliverableSpec?.path) {
    return { pass: false, checks: [], reason: 'task has no deliverableSpec.path (leaf tasks require one, FR-11.2)' }
  }
  const declared = deliverableSpec.path
  const candidates = actualDeliverables.length > 0 ? actualDeliverables.map((d) => d.path) : [declared]
  const checks = candidates.map((p) => ({ path: p, exists: fileExists(p) }))
  const pass = checks.some((c) => c.exists)
  return { pass, checks, reason: pass ? undefined : `deliverable not found on disk: ${checks.map((c) => c.path).join(', ')}` }
}

/* ── T16：有序恢复表 ────────────────────────────────────────── */

                                
               
                    
                   
                                                   
                     
                                         
                                                               
                                                                    
                                               
                                         
                                   
                  
                                         
                    
                             
                       
                                                                                      
                                         
 

                            
                                                                         
                                                                  
                                                                      
                                                
                    

/**
 * 恢复决策表（FR-4.6：按有序表选一条路径，不并行多策）。
 * 顺序：完成转移 > 原地重激活 > 新 attempt 重试 > blocked > noop。
 *
 * P2-2：只认 `state` / `attemptId` / `assignee` / `memberLive` 四项——新拆出的
 * `attempt` / `handoffId` / `reassigning` / `parkedAttempts` **不参与**判定
 * （增字段后行为逐条不变，见 `t124`）。阶段判断请用 `attemptPhase`。
 */
export function recoveryAction(facts                  )                 {
  if (facts.state === 'in_progress') {
    if (facts.memberLive && facts.assignee) return { kind: 're-activate-in-place' }
    if (facts.attemptId) return { kind: 're-activate-new-attempt' }
    return { kind: 'to-blocked' }
  }
  if (facts.state === 'ready' || facts.state === 'backlog') return { kind: 'noop' } // 调度层自然接管
  if (facts.state === 're-scoping') return { kind: 'noop' } // 等队长裁决（Inbox 已有提醒）
  if (facts.state === 'gate:review' || facts.state === 'gate:verify' || facts.state === 'gate:archive') {
    return facts.memberLive ? { kind: 're-activate-in-place' } : { kind: 're-activate-new-attempt' }
  }
  return { kind: 'noop' } // 终态不恢复
}

/* ── P2-2（docs/21 §6，来源 NM `src/types.ts:179-188`）：attempt 阶段 ── */

/** attempt 生命周期阶段（五态；判定顺序见 `attemptPhase`） */
                                                                                    

/**
 * 执行阶段（纯函数）：把「从哪个字段能看出什么阶段」钉成**单一事实源**。
 *
 * 为什么需要它：四字段拆开之后，「当前在干什么」有五种合法组合。如果每个调用方各自
 * `if (attemptId) … else if (handoffId) …`，顺序一有分歧，**同一个任务在不同视图里就是不同阶段**
 * （看板说交接中、调度器说已领取）——这类分叉不会报错，只会让人做出相反的决定。
 * 这里把顺序和判据都固定下来，调用方只读结果。
 *
 * 判定顺序（**从左到右，先中先返回**）：
 *   ① `parked`      —— 当前 attempt 在 `parkedAttempts` 里；或没有活跃 attempt 但停放记录还在。
 *                      停放 = **已有裁决的停止**（等人工/重试），必须压过一切过渡态：
 *                      排在后面，调度器就会把「已停」的任务当成「正在换人/正在跑」继续推进。
 *   ② `reassigning` —— 交接正在排空旧持有人（`reassigning`）。交接期间它和 `handoffId` 同时为真，
 *                      阶段名取**更具体**的那个（排空 vs 等落地）；排空结束闸门落下，
 *                      阶段自然回落到 `handoff`。
 *   ③ `handoff`     —— 有交接票据、下一次 attempt 还没开始（等交接落地）。
 *                      排在 `claimed` 前：撤权后旧 `attemptId` 可能还留着（旧持有人尚未 drain 完），
 *                      此时任务属于**交接**，不属于旧 attempt。
 *   ④ `claimed`     —— 有当前能力票据（正在执行）。
 *   ⑤ `idle`        —— 四字段都空（可调度 / 终态）。
 *
 * 注意：`claimed` 只表示**票据还在**。`gate:*` 与已 done 的任务也保留票据（它是证据归属的锚点），
 * 判断「能不能派单」必须再叠 `state`，不要拿阶段当调度结论。
 */
export function attemptPhase(facts                  )               {
  const parked = facts.parkedAttempts ?? {}
  const attemptId = typeof facts.attemptId === 'string' ? facts.attemptId : ''
  const handoffId = typeof facts.handoffId === 'string' ? facts.handoffId : ''
  // 用 hasOwnProperty 而不是 `in`：attemptId 来自账本载荷，`__proto__` 之类的键不能当「已停放」
  const currentParked = attemptId.length > 0 && Object.prototype.hasOwnProperty.call(parked, attemptId)
  if (currentParked || (attemptId.length === 0 && Object.keys(parked).length > 0)) return 'parked'
  if (facts.reassigning === true) return 'reassigning'
  if (handoffId.length > 0) return 'handoff'
  if (attemptId.length > 0) return 'claimed'
  return 'idle'
}

/* ── P0-1（docs/21 §6）：两阶段 spawn 的三条件对账 ────────────── */

/**
 * 三条件探针结果（官方 `types/roster.js:339-386` 的 `reconcileProvisioning`）。
 *
 * 三个条件缺一不可，因为它们各自排除一种「看起来建成了、实际不可用」的假活：
 *   - `sessionExists`：child 会话根本不存在（宿主崩在 create 之前或中途）；
 *   - `continuable`：会话存在但不是可续会话（one-shot 子代理跑完即不可恢复，不能当成员）；
 *   - `initialPromptAccepted`：会话在、也能续，但上岗引导（初始 user 消息）没被宿主接受——
 *     成员起来了却不知道自己该做什么，等价于「没上岗」。
 */
                                          
                        
                      
                                
 

/** 对账输入：投影/账本里处于 `provisioning` 的成员事实（只读快照） */
                                     
                  
                    
                
 

                                                                            

                                         
                  
                                      
                                                                    
                
 

const PROVISIONING_ACTIVE_REASON = 'session exists ∧ continuable ∧ initial prompt accepted'

/**
 * 启动对账（纯函数，无 IO）：把「停在 provisioning」的成员按三条件结算成 active / failed。
 *
 * 为什么必须是**纯函数**：对账跑在冷启动路径上，而冷启动最怕「对账代码自己崩」——
 * 把宿主探测（`probe`）挡在外面之后，单测能穷举三条件矩阵，不需要真起会话。
 *
 * 幂等口径：**同一 memberId 只结算一次**（同一成员出两条结算事件正是账本要避免的重复写入）；
 * 同样的 members + 同样的探针结果 → 同样的输出（探针自身有副作用时不作保证）。
 *
 * 判活的取向：**证明不了自己是活的，就判 failed**。failed 可重试（重新 spawn），
 * 假 active 会静默丢任务——两种错误的代价不对称。
 */
export function reconcileProvisioning(
  members                               ,
  probe                                                ,
)                           {
  const settled = new Set        ()
  const out                           = []
  for (const member of members) {
    // 只处理 provisioning：active / spawn_failed 是已结算状态，重复结算会写出重复事件
    if (member.status !== 'provisioning') continue
    if (settled.has(member.memberId)) continue
    settled.add(member.memberId)
    const sessionId = typeof member.sessionId === 'string' ? member.sessionId : ''
    if (sessionId.length === 0) {
      // 没记 sessionId = 探针无从下手（旧账本/坏 payload）；这本身就不构成「可恢复的 child」
      out.push({
        memberId: member.memberId,
        action: 'settle-failed',
        reason: 'no sessionId recorded at provisioning (cannot probe the child session)',
      })
      continue
    }
    let probed                         
    try {
      probed = probe(sessionId)
    } catch (e) {
      // 探针抛错 = 证明不了它是活的 → failed（可重试）；绝不因对账代码异常把成员判活
      out.push({ memberId: member.memberId, action: 'settle-failed', reason: `probe threw: ${String(e)}` })
      continue
    }
    const missing           = []
    if (probed?.sessionExists !== true) missing.push('child session missing')
    if (probed?.continuable !== true) missing.push('session is not continuable')
    if (probed?.initialPromptAccepted !== true) missing.push('initial prompt was not accepted')
    out.push(
      missing.length === 0
        ? { memberId: member.memberId, action: 'settle-active', reason: PROVISIONING_ACTIVE_REASON }
        : { memberId: member.memberId, action: 'settle-failed', reason: `provisioning did not settle: ${missing.join('; ')}` },
    )
  }
  return out
}

/** 恢复动作 → 账本事件（重构 attempt 用新 attemptId） */
export function recoveryEventFor(action                , taskId        , newAttemptId         )                                                                 {
  switch (action.kind) {
    case 're-activate-new-attempt':
      return {
        type: 'task.attempt.revoked',
        payload: { taskId, attemptId: `revoked-on-recovery`, reason: 'host restart recovery (FR-4.6)', prevAssignee: undefined },
      }
    case 'to-blocked':
      return { type: 'task.rescoped', payload: { taskId, patch: { recoveryBlocked: true } } }
    default:
      return undefined
  }
  void newAttemptId
}


//# sourceURL=./src/core/scheduler/recovery.ts