/**
 * CHG-137（docs/19 §三「档位元数据」）：**工具权限档位**——把散落在注释里的「谁能调」显式化。
 *
 * 为什么必须有：docs/19 定义了四档（A 全员 / C 仅队长 / CM 队长+显式授权成员 / H 仅人类），
 * 但此前**只写在描述文字里**——`toolPolicy` 只能收窄，没有任何单一事实源能被门禁校验。
 * 结果是「档位」靠人记，改工具时容易悄悄越权。
 *
 * 三条纪律：
 *  ① **单一事实源**：每个工具必须在这里有且只有一个档位（`t107` 双向锁死 defs ↔ 本表）；
 *  ② **只收窄**：`canCall` 只回答「这一档能不能调」，**不扩权**——成员的 C 档工具永远拿不到；
 *  ③ **H 档模型不可调**：人类专属（发布 / 批准 / 解散），模型只能提案。
 */

                                             

/** 调用者类别（人类走面板 / 命令，不经过工具分发） */
                                                       

/**
 * 工具 → 档位（**唯一事实源**）。
 *
 * 口径来自 docs/19 能力矩阵：
 *  - `A`（全员）：只读查询、认领、上报、消息、资产创建（技能/工具只写 myteam 预设）
 *  - `C`（仅队长）：规划、角色/团队写、门禁裁决、成员管理、快照导入导出
 *  - `CM`（队长 + 显式授权成员）：改元数据、审计、会话考古
 *  - `H`（仅人类）：批准 / 退回 / 丢弃 / 解散 / 发布（单向不可逆）
 */
export const TOOL_TIERS                           = {
  /* ── A：全员可读 / 自助 ─────────────────────────────────── */
  myteam_get_task: 'A',
  myteam_list_tasks: 'A',
  myteam_claim_task: 'A',
  myteam_update_task: 'A',
  myteam_peer_message: 'A',
  myteam_wait_for_change: 'A',
  myteam_propose_task_change: 'A',
  myteam_escalate_task: 'A',
  myteam_read_knowledge: 'A',
  myteam_list_roles: 'A',
  myteam_list_teams: 'A',
  myteam_get_team: 'A',
  myteam_list_skills: 'A',
  myteam_list_presets: 'A',
  myteam_get_tokens: 'A',
  myteam_get_task_graph: 'A',
  myteam_create_skill: 'A',
  myteam_create_tool: 'A',

  /* ── C：仅队长 ──────────────────────────────────────────── */
  myteam_submit_plan: 'C',
  myteam_create_task: 'C',
  myteam_create_tasks: 'C',
  myteam_edit_task: 'C',
  myteam_review_task: 'C',
  myteam_rescope_task: 'C',
  myteam_cancel_task: 'C',
  myteam_batch_task_op: 'C',
  myteam_assign_task: 'C',
  myteam_reassign_task: 'C',
  myteam_participate_task: 'C',
  myteam_apply_roles: 'C',
  myteam_create_role: 'C',
  myteam_update_role: 'C',
  myteam_delete_role: 'C',
  myteam_set_project_role: 'C',
  myteam_copy_role: 'C',
  myteam_copy_team: 'C',
  myteam_export_team: 'C',
  myteam_import_team: 'C',
  myteam_update_team: 'C',
  myteam_save_team_config: 'C',
  myteam_reset_team_config: 'C',
  myteam_save_preset: 'C',
  myteam_copy_preset: 'C',
  myteam_delete_preset: 'C',
  myteam_spawn_member: 'C',
  myteam_release_member: 'C',
  myteam_interrupt: 'C',
  myteam_message: 'C',
  myteam_resolve_proposal: 'C',
  /* CHG-163（docs/10 KI-9）：知识提案入口——**写面归 C**的理由：它落的是团队账本事件
   * （`knowledge.proposed` 进队长队列），不是只读自助；成员侧的同语义入口是
   * `myteam_update_task` 的 `knowledgeDraft`（A 档，但只能提自己任务上的证据）。
   * 队长侧收 C = 只有队长能起草 onboarding 初始条目，成员不能替团队立「团队级理解」。 */
  myteam_propose_knowledge: 'C',
  myteam_adopt_knowledge: 'C',
  myteam_list_contributions: 'C',
  myteam_reload_contributions: 'C',
  myteam_handoff: 'C',
  myteam_revoke_attempt: 'C',

  /* ── CM：队长 + 显式授权成员 ─────────────────────────────── */
  myteam_get_audit: 'CM',
  myteam_read_session: 'CM',

  /* ── H：仅人类（模型只能提案）─────────────────────────────── */
  myteam_approve_plan: 'H',
  myteam_revise_plan: 'H',
  myteam_discard_plan: 'H',
  myteam_disband: 'H',
  myteam_publish_role: 'H',
  myteam_publish_team: 'H',
}

/** 查档位（未登记 → `undefined`，由门禁报「未登记工具」而不是放行） */
export function tierOf(toolName        )                       {
  return TOOL_TIERS[String(toolName)]
}

/**
 * 能否调用（**只收窄，不扩权**）。
 *
 * | 调用者 \ 档位 | A | C | CM | H |
 * |---|---|---|---|---|
 * | captain | ✅ | ✅ | ✅ | ❌ |
 * | member  | ✅ | ❌ | ❌（除非 `authorized`） | ❌ |
 * | human   | ✅ | ✅ | ✅ | ✅ |
 *
 * @param authorized 成员是否被 `toolPolicy.allow` **显式点名**（只对 CM 档有效）
 */
export function canCall(toolName        , caller            , authorized = false)          {
  const tier = tierOf(toolName)
  if (!tier) return false
  if (caller === 'human') return true
  if (tier === 'H') return false
  if (tier === 'A') return true
  if (caller === 'captain') return true
  /* member：C 永远不可；CM 仅在显式授权时可用 */
  return tier === 'CM' && authorized
}

/** 按档位分组（面板/文档/测试共用） */
export function toolsByTier()                             {
  const grouped                             = { A: [], C: [], CM: [], H: [] }
  for (const [name, tier] of Object.entries(TOOL_TIERS)) grouped[tier].push(name)
  for (const tier of Object.keys(grouped)              ) grouped[tier].sort()
  return grouped
}


//# sourceURL=./src/core/tools/tool-tiers.ts