/**
 * T10 唤醒管线（FR-4.4/NFR-7.1/NFR-7.7）：四种因果唤醒 → agent.followup()。
 *
 * 纯判定函数：账本事件 → 是否唤醒、唤醒哪个成员、原因类别。
 * 语义：
 *   - 只有四种因果唤醒：assign / message / resume / revoke；
 *   - 其余事件（他人进度/gate 结果等）不唤醒空闲成员（零请求，NFR-7.1）；
 *   - wait_for_change 的返回 = 失效提示（changed + cause），不推状态正文（NFR-7.7）。
 */

                                                                  

                               
                  
                  
 

/** 单事件 → 唤醒决策列表（0..n）。成员状态检查（是否被移除/暂停）由调用方过滤。 */
export function wakeDecisionsFor(event                                                    )                 {
  const p = event.payload
  switch (event.type) {
    case 'task.assigned':
      return [{ memberId: String(p.memberId), cause: 'assign' }]
    case 'task.claimed':
      // claim 不唤醒本人（主动行为）；不唤醒他人
      return []
    case 'message.sent': {
      const to = String(p.to ?? '')
      if (to === 'inbox' || to.startsWith('role:')) return []
      return [{ memberId: to, cause: 'message' }]
    }
    case 'task.attempt.revoked': {
      // 被撤销 attempt 的原持有者需知道（resume 语义：可重新竞争或等待）
      const prev = p.prevAssignee                      
      return prev ? [{ memberId: prev, cause: 'revoke' }] : []
    }
    case 'member.restored':
      return [{ memberId: String(p.memberId), cause: 'resume' }]
    default:
      return []
  }
}

/** wait_for_change 轮询判定：给定"等待起点 seq"与当前账本，返回失效提示（不返回正文） */
export function changeSince(
  events                                                                   ,
  sinceSeq        ,
  taskId         ,
)                                                                             {
  for (const e of events) {
    if (e.seq <= sinceSeq) continue
    const p = e.payload                           
    if (taskId !== undefined) {
      const touchesTask = p.taskId === taskId || (e.type === 'task.escalated' && p.taskId === taskId)
      if (!touchesTask) continue
    }
    switch (e.type) {
      case 'task.assigned': return { changed: true, cause: 'assign' }
      case 'task.attempt.revoked': return { changed: true, cause: 'revoke' }
      case 'message.sent': return { changed: true, cause: 'message' }
      case 'member.restored': return { changed: true, cause: 'resume' }
      case 'task.progress': return { changed: true, cause: 'progress' }
      case 'task.escalated': return { changed: true, cause: 'escalate' }
      case 'task.gate.result': return { changed: true, cause: 'gate' }
      case 'task.completed':
      case 'task.failed':
      case 'task.rescoped':
        return { changed: true, cause: 'progress' }
      default:
        break
    }
  }
  return { changed: false }
}


//# sourceURL=./src/core/scheduler/wake.ts