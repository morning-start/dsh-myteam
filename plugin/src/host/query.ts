/**
 * CHG-186（T155c）：查询族端点适配层（只读）。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/index/**`（团队目录 / 角色目录 / 依赖图谱）、`core/ledger/**`（token / 审计）、
 * `core/presets/**`（团队模板）、`core/roles/**`（技能 / 工具资产），装配与状态在
 * `host.ts`。方法体**逐字搬自** `host.ts` 的 `switch (toolName)` 里对应 case，允许的
 * 差异只有：
 *   ① `this.` → `host.`（宿主面，见下）。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 这一族为什么「搬了等于没搬」──────────────────────────────────────────────────
 * 查询族的 case **本来就只有两行**（`case` + 一行转发），没有内联逻辑可搬。所以本文件
 * 不减少入口层任何业务代码，它换来的是**形状统一**：`executeLeadTool` 的 switch 现在
 * 是纯粹的「工具名 → 适配层」路由表，读的人不用再在 case 之间分辨「哪些还有逻辑」。
 *
 * 也正因为如此，这里**不做**「把 `listTeamsTool` 等实现也搬进来」这种动作：它们是
 * `MyTeamHost` 的公开方法（面板 / 远程面直接调），搬走只能换来一层委托，等于把一份
 * 实现拆成两处。入口层真正该下沉的是**行为边界**（`spawnMember` / `reviewTask` /
 * `batchTaskOp` / `scopeAuditFor` 这类），不是继续按端点切——见 CHG-186 的收口说明。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖 `listContributionsTool` 这个**私有**方法（其余是公开方法），而 TS 的
 * 私有成员不参与结构化赋值。两条路：把它改成 public（扩大入口层 API，和「入口层只留
 * 装配」的方向相反），或者传 `this` 再 `as` 蒙。这里选第三条：host.ts 传一个**只含用
 * 到的成员**的闭包对象进来——成员改名，装配处立刻编译报错。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────────
 * 这十五个端点原 case 全是**同步返回**（`executeLeadTool` 的返回类型是
 * `Record | Promise<Record>`）。加 `async` 会让原本同步的结果变成 Promise——调用方
 * （`test/`、面板远程面）就地拿到 `[object Promise]`。所以保持同步。
 */
import type { ContributionCatalog } from '../core/contributions/contract.ts'

/**
 * 查询族用到的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this\." host.ts` 里 `get_audit` / `get_tokens` / `list_skills` /
 * `get_task_graph` / `list_teams` / `get_team` / `list_roles` / `list_presets` /
 * `list_contributions` / `reload_contributions` / `save_preset` / `copy_preset` /
 * `delete_preset` / `create_skill` / `create_tool` 十五个 case 实际碰到的成员。
 */
export interface QueryHostSurface {
  /** 审计事件流（只读；不写账本、不 fold） */
  getAuditTool(args: Record<string, unknown>): Record<string, unknown>

  /** token / 成本只读查询（按天桶 + 成员排行） */
  getTokensTool(args: Record<string, unknown>): Record<string, unknown>

  /** 可复用技能清单（宿主 skills 服务可用则并入） */
  listSkillsTool(args: Record<string, unknown>): Record<string, unknown>

  /** 任务依赖图谱（Kahn 分层 + 环检测） */
  getTaskGraphTool(args: Record<string, unknown>): Record<string, unknown>

  /** 团队目录（项目 / 全局 / 归档三态并列） */
  listTeamsTool(args: Record<string, unknown>): Record<string, unknown>

  /** 团队详情 */
  getTeamTool(args: Record<string, unknown>): Record<string, unknown>

  /** 角色目录只读视图（三态 + origin 标注） */
  listRolesTool(args: Record<string, unknown>): Record<string, unknown>

  /** 团队模板目录（内置只读 + 项目层可写） */
  listPresetsTool(): Record<string, unknown>

  /** 插件贡献的只读视图（`listContributionsTool` 私有方法；默认取当前目录） */
  listContributionsTool(catalog?: ContributionCatalog): Record<string, unknown>

  /** 显式重载插件贡献（只读：不写账本） */
  reloadContributions(): ContributionCatalog

  /** 保存团队模板（两段确认 + 校验先于写） */
  savePreset(args: Record<string, unknown>): Record<string, unknown>

  /** 复制团队模板 */
  copyPreset(args: Record<string, unknown>): Record<string, unknown>

  /** 删除团队模板 */
  deletePreset(args: Record<string, unknown>): Record<string, unknown>

  /** 创建技能（只写 myteam 队长预设，不污染全局） */
  createSkillTool(args: Record<string, unknown>): Record<string, unknown>

  /** 创建工具（声明式，不执行第三方代码） */
  createToolTool(args: Record<string, unknown>): Record<string, unknown>
}

export function createQueryHandlers(host: QueryHostSurface) {
  return {
    createSkill(args: Record<string, unknown>): Record<string, unknown> {
      return host.createSkillTool(args)
    },

    createTool(args: Record<string, unknown>): Record<string, unknown> {
      return host.createToolTool(args)
    },

    getAudit(args: Record<string, unknown>): Record<string, unknown> {
      return host.getAuditTool(args)
    },

    getTokens(args: Record<string, unknown>): Record<string, unknown> {
      return host.getTokensTool(args)
    },

    listSkills(args: Record<string, unknown>): Record<string, unknown> {
      return host.listSkillsTool(args)
    },

    getTaskGraph(args: Record<string, unknown>): Record<string, unknown> {
      return host.getTaskGraphTool(args)
    },

    listTeams(args: Record<string, unknown>): Record<string, unknown> {
      return host.listTeamsTool(args)
    },

    getTeam(args: Record<string, unknown>): Record<string, unknown> {
      return host.getTeamTool(args)
    },

    listRoles(args: Record<string, unknown>): Record<string, unknown> {
      return host.listRolesTool(args)
    },

    listPresets(): Record<string, unknown> {
      return host.listPresetsTool()
    },

    listContributions(): Record<string, unknown> {
      return host.listContributionsTool()
    },

    reloadContributions(): Record<string, unknown> {
      return host.listContributionsTool(host.reloadContributions())
    },

    savePreset(args: Record<string, unknown>): Record<string, unknown> {
      return host.savePreset(args)
    },

    copyPreset(args: Record<string, unknown>): Record<string, unknown> {
      return host.copyPreset(args)
    },

    deletePreset(args: Record<string, unknown>): Record<string, unknown> {
      return host.deletePreset(args)
    },
  }
}
