/**
 * CHG-186（T155c）：团队族端点适配层。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/archive/**`（归档快照与落盘）、`core/host/session-handoff.ts`（会话移交）、
 * `core/host/session-archaeology.ts`（会话考古），装配与状态在 `host.ts`。方法体
 * **逐字搬自** `host.ts` 的 `switch (toolName)` 里对应 case，允许的差异只有：
 *   ① `this.` → `host.`（宿主面，见下）；
 *   ② `this.workspaceRoot` → `host.workspaceRoot()`（**惰性 getter**，不能在装配处取值
 *      快照——那会把「首次访问才解析项目根」提前到 host 构造期，日志顺序会变）；
 *   ③ `myteam_export_team` 等转发型 case 的 `teamId` 未参与计算（工具从 `args` 取），
 *      保留同形签名以与其它端点一致。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖 `syncTokens` / `log` / `dispose` 等 `MyTeamHost` 的成员（部分是私有），
 * 而 TS 的私有成员不参与结构化赋值。两条路：把私有方法改成 public（扩大入口层 API，和
 * 「入口层只留装配」的方向相反），或者 `as` 强转（改名后编译器抓不到）。这里选第三条：
 * host.ts 传一个**只含用到的成员**的闭包对象进来——私有方法名一改，装配处立刻编译报错。
 *
 * ── 为什么同步 / 异步混着 ─────────────────────────────────────────────────────
 * **原 case 是什么就是什么**：`exportTeamTool` / `saveTeamConfigTool` 是同步返回，
 * `importTeamTool` / `publishTeamTool` / `copyTeamTool` / `handoffTeam` /
 * `readSessionHistory` 本来就是 async（要 await 宿主 agents / 会话服务）。给同步的加
 * `async` 会让 `executeLeadTool` 的调用方拿到 Promise——那是行为变化，这一批不做。
 */
import type { CommitDraft, TeamService } from '../core/service.ts'
import type { TokensFile } from '../core/ledger/token-sidecar.ts'
import { buildArchiveSnapshot, writeArchive } from '../core/archive/archive-store.ts'
import { STORE_DIR } from '../core/workspace/layout.ts'

/**
 * 团队族用到的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this\." host.ts` 里 `update_team` / `disband` / `export_team` /
 * `import_team` / `publish_team` / `copy_team` / `save_team_config` /
 * `reset_team_config` / `handoff` / `read_session` 十个 case 实际碰到的成员。
 * 加成员前先问：这条逻辑能不能落在 `core/**`（那才是规则该在的地方）。
 */
export interface TeamsHostSurface {
  /** 统一提交入口（单写者管线：成功后按事件类型触发唤醒 / 派单扫描） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>

  /** 按 teamId 取 TeamService（惰性创建 + 冷启动重放恢复 + 首次 bootstrap；**幂等缓存**） */
  service(teamId: string): TeamService

  /** token 侧车同步（归档快照要带最新累计量；`syncTokens` 是同步方法） */
  syncTokens(teamId: string): TokensFile

  /** 项目根（**惰性 getter**：首次访问才解析，装配处取不到值） */
  workspaceRoot(): string

  /** 宿主日志通道（归档写失败要留 error 级痕迹） */
  log(level: 'info' | 'warn' | 'error', msg: string): void

  /** 有界卸载（解散后释放成员会话 / 关准入闸门） */
  dispose(): void

  /** 导出团队快照（仅队长） */
  exportTeamTool(args: Record<string, unknown>): Record<string, unknown>

  /** 导入团队快照（仅队长；async） */
  importTeamTool(args: Record<string, unknown>): Promise<Record<string, unknown>>

  /** 发布团队定义到全局团队库（人类专属；async） */
  publishTeamTool(args: Record<string, unknown>): Promise<Record<string, unknown>>

  /** 复制团队定义 → 新草稿（仅队长；async） */
  copyTeamTool(args: Record<string, unknown>): Promise<Record<string, unknown>>

  /** 写团队配置（仅队长；校验先于写 + 两段确认） */
  saveTeamConfigTool(args: Record<string, unknown>): Record<string, unknown>

  /** 重置团队配置（回落到团队模板 / 内置默认） */
  resetTeamConfig(teamId: string, args: Record<string, unknown>): Record<string, unknown>

  /** 会话移交（摘要提取 + 新团队预设会话注入；async） */
  handoffTeam(args: Record<string, unknown>): Promise<Record<string, unknown>>

  /** 会话考古（按 session:<id> 只读读一页历史；async） */
  readSessionHistory(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export function createTeamsHandlers(host: TeamsHostSurface) {
  return {
    updateTeam(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const payload: Record<string, unknown> = { teamId }
      if (args.name !== undefined) payload.name = String(args.name).trim()
      if (args.goal !== undefined) payload.goal = String(args.goal).trim()
      const r = host.commit(teamId, { actor, type: 'team.updated', payload })
      return r.ok
        ? { status: 'updated', teamId, ...(args.name !== undefined ? { name: String(args.name).trim() } : {}), ...(args.goal !== undefined ? { goal: String(args.goal).trim() } : {}) }
        : { status: 'error', code: r.code, message: r.message }
    },

    disband(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      if (args.confirm !== true) return { status: 'confirm-required', message: '解散是两段确认操作（影响面：成员排空/未完成任务转 blocked/账本归档），请带 confirm=true 重调' }
      const svc = host.service(teamId)
      const proj = svc.projectionSnapshot
      const memberCount = Object.keys(proj.members).length
      const taskCount = Object.keys(proj.tasks).length
      // CHG-86（P0-2）：归档必须**真的落盘**。旧实现只往账本写一条 team.disbanded
      // （payload 里带个路径字符串），没有任何文件 IO——面板归档视图渲染的
      // archive/<id>/{team.json,tokens.json,members/,artifacts/} 永远不存在，整套是空壳。
      // 顺序：先落账本（状态变 archived）→ 再按归档态快照写文件 → 最后释放成员。
      const disbanded = host.commit(teamId, { actor, type: 'team.disbanded', payload: { teamId, archivedPaths: [`${STORE_DIR}/history/archive/${teamId}`] } })
      if (!disbanded.ok) {
        return { status: 'error', code: disbanded.code, message: disbanded.message }
      }
      let archived: { dir: string; relativeDir: string; files: string[] } | undefined
      try {
        const after = host.service(teamId).projectionSnapshot
        const tokens = host.syncTokens(teamId)
        const snapshot = buildArchiveSnapshot({
          team: after,
          tokens,
          archivedAt: Date.now(),
          archivedBy: actor,
          ledgerPath: svc.ledgerPath,
          eventCount: after.revision,
        })
        archived = writeArchive(host.workspaceRoot(), snapshot)
      } catch (e) {
        // 归档写失败不静默：账本已记 disbanded，但必须让调用方知道文件没落盘
        host.log('error', `archive write for ${teamId} failed: ${String(e)}`)
        host.dispose()
        return {
          status: 'error',
          code: 'MT_ARCHIVE_FAILED',
          // A2：旧文案在这里引用了一个**全仓无定义**的归档列表工具（幽灵引用）。
          // 归档的真实落点：`<STORE_DIR>/history/archive/<teamId>/`（MANIFEST.json 是完整性
          // 判据，缺它即视为未归档）；真实可做的事：账本里 team.disbanded 已落，用
          // myteam_get_audit 复核，用 myteam_list_teams 的 archived.ids 看目录是否被登记。
          message: `团队已解散但归档落盘失败：${String(e)}（账本仍完整：team.disbanded 已落账，可用 myteam_get_audit 复核；归档目录 ${STORE_DIR}/history/archive/${teamId}/ 可能只有部分文件——MANIFEST.json 缺失即视为未归档，可用 myteam_list_teams 的 archived.ids 核对是否被登记）`,
          impact: { members: memberCount, tasks: taskCount },
        }
      }
      host.dispose()
      return {
        status: 'disbanded',
        impact: { members: memberCount, tasks: taskCount },
        archive: archived,
        note: `归档已落盘：${archived.relativeDir}（${archived.files.length} 个文件，只读可查）`,
      }
    },

    exportTeam(args: Record<string, unknown>): Record<string, unknown> {
      return host.exportTeamTool(args)
    },

    importTeam(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return host.importTeamTool(args)
    },

    publishTeam(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return host.publishTeamTool(args)
    },

    copyTeam(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return host.copyTeamTool(args)
    },

    handoff(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return host.handoffTeam(args)
    },

    readSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return host.readSessionHistory(args)
    },

    saveTeamConfig(args: Record<string, unknown>): Record<string, unknown> {
      return host.saveTeamConfigTool(args)
    },

    resetTeamConfig(teamId: string, args: Record<string, unknown>): Record<string, unknown> {
      return host.resetTeamConfig(teamId, args)
    },
  }
}
