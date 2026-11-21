/**
 * CHG-207（P1-8）/**冷启动恢复的落账端**（T16 / FR-4.6）。
 *
 * ── 修复前的两个断点 ──────────────────────────────────────────────────────────
 *  ① **零调用**：`recoverOnBoot` 写在 `host.ts` 里，`initialize()` 从没调它——进程重启后
 *     滞留在 `in_progress` 的任务永不恢复（attempt 不撤、不重派、也不阻塞）。看板一直显示
 *     「运行中」，实际没有任何 agent 在跑，用户也没有任何入口把它推下去。
 *  ② **账本零写入**：`to-blocked` 分支只往返回的 `actions[]` 塞一条字符串。恢复表算出
 *     「该停下等人」，落账却什么都没发生——任务原地不动，下次启动再算一遍同样的结论。
 *
 * 这里把两件事补上：恢复动作**真的落成账本事件**（`task.attempt.revoked` / `task.blocked`），
 * 并提供 `recoverAll()` 给 `initialize()` 在启动时对全部团队跑一遍。
 *
 * ── 为什么文案在这里拼，而不是在 `recoveryAction` 里 ──────────────────────────
 * `recoveryAction` 是**纯决策**（选哪条路径），人类可读的原因属于展示层。把它塞进决策结果会
 * 污染 6 处 `deepEqual(action, { kind: 'to-blocked' })` 断言，也让「决策」和「怎么说」耦合。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *  - 恢复失败**不阻断启动**：单团队账本坏了只告警，下次启动再对；
 *  - 每次落账都检查 `commit` 结果：被拒（如状态已经不在 in_progress）只告警，不假装成功；
 *  - 只处理 `in_progress`（与旧实现同范围）：gate 态等的是裁决，不该被启动流程改写。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { storeLayout } from '../core/workspace/layout.ts'
import { recoveryAction, type TaskRuntimeFacts } from '../core/scheduler/recovery.ts'
import type { CommitDraft, TeamService } from '../core/service.ts'

/** 恢复端用到的宿主能力（**只列用到的成员**，不做全能门面） */
export interface RecoveryHostSurface {
  /** 按 teamId 取 TeamService（惰性创建 + 冷启动重放） */
  service(teamId: string): TeamService
  /** 账本提交（含状态机校验；恢复被拒要如实告警） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>
  /** 成员的会话是否还在本进程里（handle 表命中 = 活着） */
  memberLive(memberId: string): boolean
  /** 项目根（**惰性 getter**：构造期取不到项目级工作区） */
  workspaceRoot(): string
  /** 宿主日志通道（`[myteam]` 前缀由 host 侧统一加） */
  log(level: 'info' | 'warn', msg: string): void
}

export function createBootRecovery(host: RecoveryHostSurface) {
  /**
   * blocked 的落账原因。
   *
   * 为什么要把 facts 摊开写进 reason：恢复表判 `to-blocked` 有两种前提（「已停放 = 有裁决的停止」
   * 与「没有活着的持有人」），两者的处置不同——前者等人放行，后者多半要重派。账本只记一条
   * `task.blocked`，原因必须自带区分，否则排查时只能靠猜。
   */
  function blockedReasonOf(facts: TaskRuntimeFacts): string {
    const parts: string[] = []
    if (!facts.attemptId) parts.push('no active attempt')
    if (!facts.assignee) parts.push('no assignee')
    else if (!facts.memberLive) parts.push(`member ${facts.assignee} not live`)
    return `host restart recovery: ${parts.length > 0 ? parts.join(' / ') : 'recovery table returned to-blocked'}`
  }

  /** 单团队：对滞留 `in_progress` 任务按恢复表落事件（返回实际落账的动作） */
  function recoverTeam(teamId: string): { recovered: number; actions: string[] } {
    const svc = host.service(teamId)
    const actions: string[] = []
    for (const t of Object.values(svc.projectionSnapshot.tasks)) {
      if (t.state !== 'in_progress') continue
      const facts: TaskRuntimeFacts = {
        state: t.state,
        ...(t.attemptId !== undefined ? { attemptId: t.attemptId } : {}),
        ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
        ...(typeof t.attempt === 'number' ? { attempts: t.attempt } : {}),
        memberLive: t.assignee ? host.memberLive(t.assignee) : false,
      }
      const action = recoveryAction(facts)
      if (action.kind === 're-activate-new-attempt') {
        const r = host.commit(teamId, {
          actor: 'host',
          type: 'task.attempt.revoked',
          payload: { teamId, taskId: t.id, attemptId: t.attemptId ?? 'unknown', reason: 'host restart recovery (FR-4.6)', prevAssignee: t.assignee },
        })
        if (!r.ok) {
          host.log('warn', `boot recovery: task ${t.id} (team ${teamId}) revoke rejected: ${r.code} ${r.message}`)
          continue
        }
        actions.push(`task ${t.id}: attempt revoked for re-claim`)
      } else if (action.kind === 'to-blocked') {
        const reason = blockedReasonOf(facts)
        const r = host.commit(teamId, { actor: 'host', type: 'task.blocked', payload: { teamId, taskId: t.id, reason, recovery: true } })
        if (!r.ok) {
          host.log('warn', `boot recovery: task ${t.id} (team ${teamId}) blocked rejected: ${r.code} ${r.message}`)
          continue
        }
        actions.push(`task ${t.id}: blocked (${reason})`)
      }
      // re-activate-in-place（成员活着）与 noop 不需要落账：前者本来就该继续跑，后者无事可做
    }
    return { recovered: actions.length, actions }
  }

  /** 启动时对**全部团队**跑一遍（`initialize()` 调用；**任何失败都不抛出**，只告警） */
  function recoverAll(): { teams: number; recovered: number } {
    let dir: string
    let teamIds: string[] = []
    try {
      dir = storeLayout(host.workspaceRoot()).tasks
      if (!existsSync(dir)) return { teams: 0, recovered: 0 }
      teamIds = readdirSync(dir).filter((name) => existsSync(join(dir, name, 'ledger.jsonl')))
    } catch (e) {
      host.log('warn', `boot recovery skipped (teams dir unreadable): ${String(e)}`)
      return { teams: 0, recovered: 0 }
    }
    let recovered = 0
    for (const teamId of teamIds) {
      try {
        const result = recoverTeam(teamId)
        recovered += result.recovered
        for (const line of result.actions) host.log('info', `boot recovery (${teamId}): ${line}`)
      } catch (e) {
        host.log('warn', `boot recovery failed for team ${teamId} (startup continues): ${String(e)}`)
      }
    }
    return { teams: teamIds.length, recovered }
  }

  return { recoverTeam, recoverAll, blockedReasonOf }
}
