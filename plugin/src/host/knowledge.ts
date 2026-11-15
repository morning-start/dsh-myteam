/**
 * CHG-186（T155c）：知识族端点适配层。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/knowledge/**`（`adoptDraft` / `reviseEntry` / `validateDraft` / `writeKnowledgeEntry`），
 * 装配与状态在 `host.ts`。方法体**逐字搬自** `host.ts` 的 `switch (toolName)` 里对应
 * case，允许的差异只有：
 *   ① `this.` → `host.`（宿主面，见下）；
 *   ② `this.workspaceRoot` → `host.workspaceRoot()`（**惰性 getter**，不能在装配处取值
 *      快照——那会把「首次访问才解析项目根」提前到 host 构造期，日志顺序会变）；
 *   ③ `findKnowledgeProposal(…)` 经宿主面透传（它是 `host.ts` 的模块级函数，直接 import
 *      回来会与 `host.ts` 成 **value 环**，arch-report 的 value 环会从 0 变 1）。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 为什么分两个工厂（lead / member）────────────────────────────────────────────
 * 知识族横跨**两个通道**：`executeLeadTool`（采纳 / 提案 / 参与 / 指派）与
 * `executeMemberToolInner`（只读 `myteam_read_knowledge`）。两边上下文不同
 * （`actor` 一个是 `'lead' | 'human'`，一个是 `member:<id>`），返回口径也不同
 * （成员通道有护栏包一层）。合在一个工厂里只能靠 `any` 蒙，所以拆成两个。
 *
 * ⚠️ 成员通道的 `executeMemberToolInner` 里那行 `const svc = this.service(teamId)`
 * **必须留在 host.ts**：它是每次成员工具调用「惰性建 TeamService + 冷启动重放 + 首次
 * bootstrap」的唯一入口——含 `myteam_read_knowledge` 与未知工具名（那些 case 不读 `svc`，
 * 但侧效应照旧）。挪进 handler 会改变 read_knowledge 的行为。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖 `service` / `commit` 等成员（部分私有），而 TS 的私有成员不参与结构化
 * 赋值。两条路：把私有方法改成 public（扩大入口层 API，和「入口层只留装配」的方向相反），
 * 或者 `as` 强转（改名后编译器抓不到）。这里选第三条：host.ts 传一个**只含用到的成员**
 * 的闭包对象进来——私有方法名一改，装配处立刻编译报错。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────────
 * 原 case 全是**同步返回**（`executeLeadTool` 的返回类型是 `Record | Promise<Record>`）。
 * 加 `async` 会让原本同步的结果变成 Promise——调用方（`test/`、面板远程面）就地拿到
 * `[object Promise]`。所以保持同步：搬实现不搬异步语义。
 */
import { createHash } from 'node:crypto'
import type { CommitDraft, TeamService } from '../core/service.ts'
import {
  adoptDraft,
  knowledgeDirOf,
  knowledgeEntryView,
  listKnowledge,
  readKnowledgeEntry,
  reviseEntry,
  validateDraft,
  writeKnowledgeEntry,
  type KnowledgeDraft,
} from '../core/knowledge/knowledge.ts'

/**
 * 知识族用到的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this\." host.ts` 里 `adopt_knowledge` / `propose_knowledge` /
 * `participate_task` / `assign_task` / `read_knowledge` 五个 case 实际碰到的成员。
 * 加成员前先问：这条逻辑能不能落在 `core/knowledge/**`（那才是规则该在的地方）。
 */
export interface KnowledgeHostSurface {
  /** 统一提交入口（单写者管线：成功后按事件类型触发唤醒 / 派单扫描） */
  commit(teamId: string, draft: CommitDraft): ReturnType<TeamService['commit']>

  /** 按 teamId 取 TeamService（惰性创建 + 冷启动重放恢复 + 首次 bootstrap；**幂等缓存**） */
  service(teamId: string): TeamService

  /** 项目根（**惰性 getter**：首次访问才解析，装配处取不到值） */
  workspaceRoot(): string

  /** 按 draftId 找回提案事件（**模块级函数**透传：import 回来会与 host.ts 成 value 环） */
  findKnowledgeProposal(ledgerPath: string, draftId: string): Record<string, any> | null
}

/** 成员通道用到的宿主面（只读：成员无知识写入口——策展制的运行时保证） */
export interface MemberKnowledgeHostSurface {
  /** 项目根（**惰性 getter**：首次访问才解析，装配处取不到值） */
  workspaceRoot(): string
}

export function createKnowledgeHandlers(host: KnowledgeHostSurface) {
  return {
    adopt(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      // 策展门（FR-17.4）：提案必须存在账本；adopted 落库带归因
      const draftId = String(args.draftId)
      const decision = String(args.decision)
      if (decision === 'rejected') {
        const r = host.commit(teamId, { actor, type: 'knowledge.adopted', payload: { teamId, draftId, decision: 'rejected', note: args.note } })
        return r.ok ? { status: 'rejected', note: '提案已留痕驳回；不入库' } : { status: 'error', code: r.code, message: r.message }
      }
      const svc = host.service(teamId)
      const proposedEvent = host.findKnowledgeProposal(svc.ledgerPath, draftId)
      if (!proposedEvent) return { status: 'error', code: 'MT_VALIDATION', message: `knowledge proposal "${draftId}" not found in ledger` }
      const draft = proposedEvent.payload.draft as KnowledgeDraft
      const now = new Date().toISOString()
      const kbDir = knowledgeDirOf(host.workspaceRoot())
      const existingEntries = listKnowledge(kbDir)
      const proposer = String(proposedEvent.payload.proposedBy ?? 'unknown')
      // v2.7（M2-0c，FR-17.4）：refine/contradict 走演化式修订（reviseEntry）；
      // refine = 精炼既有条目（staleSince 清除），contradict = 矛盾记录轨迹（标 staleSince 待复核）。
      if (draft.relation === 'refine' || draft.relation === 'contradict') {
        const targetId = draft.targetId ?? draft.id
        const target = existingEntries.find((e) => e.id === targetId)
        if (!target) return { status: 'error', code: 'MT_VALIDATION', message: `${draft.relation} proposal targets unknown entry "${targetId}"` }
        const { entry, diffSummary } = reviseEntry(target, draft, proposer, now)
        const written = writeKnowledgeEntry(kbDir, entry)
        const r = host.commit(teamId, { actor, type: 'knowledge.revised', payload: { teamId, entryId: entry.id, relation: draft.relation, diff: diffSummary } })
        return r.ok
          ? { status: 'revised', entryPath: written.filePath, diff: diffSummary, note: draft.relation === 'refine' ? '条目已精炼（演化节留轨迹）；成员索引下轮 spawn/重启生效' : '矛盾证据已记录轨迹并标记待复核（原断言未改写）；请安排复核' }
          : { status: 'error', code: r.code, message: r.message }
      }
      const existing = new Set(existingEntries.map((e) => e.id))
      const entry = adoptDraft(draft, proposer, existing, now)
      const written = writeKnowledgeEntry(kbDir, entry)
      const r = host.commit(teamId, { actor, type: 'knowledge.adopted', payload: { teamId, draftId, entryPath: written.filePath, note: args.note } })
      return r.ok
        ? { status: 'adopted', entryPath: written.filePath, note: '知识条目已入库（config/knowledge/，带 evidence+contributor 归因）；成员索引下轮 spawn/重启生效' }
        : { status: 'error', code: r.code, message: r.message }
    },

    propose(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      /*
       * CHG-163（docs/10 KI-9 / FR-17.4 沉淀时机①）：**队长侧提案入口**。
       *
       * 为什么需要它：知识库的写入口一直只有成员 `myteam_update_task` 的 knowledgeDraft
       * （任务验收后提案）。「onboarding 采集」是规划轮的动作——那时还没有任何任务，
       * 成员侧这条路物理上走不通，所以队长侧必须有独立的提案入口。
       *
       * 三条纪律（越界即破坏策展制）：
       *  ① **只提案不写库**：只落 `knowledge.proposed`，绝不写 config/knowledge/——
       *     入库必须随后 `myteam_adopt_knowledge` 采纳（TF ADR-0009 先例）。
       *  ② **证据先行**（E8）：无证据直接拒绝且**账本零写入**（不消耗 seq）。
       *  ③ 草案形状与成员侧完全同构（`KnowledgeDraft` + 同一 payload 形状），
       *     否则队长审阅队列会出现两种草案，面板与采纳管线要分叉。
       */

      // ① 证据归一化：`{kind, ref}` → 账本里的 `kind:ref` 指针字符串。
      //    kind 限定已知四类（这是**入参**不是历史账本，没有兼容包袱：未知类型放行只会
      //    让「证据」变成自由文本，E8 就形同虚设）。
      const evidenceIn = Array.isArray(args.evidence) ? (args.evidence as Array<Record<string, unknown>>) : []
      const pointers: string[] = []
      for (const item of evidenceIn) {
        const kind = String(item?.kind ?? '').trim().toLowerCase()
        const ref = String(item?.ref ?? '').trim()
        if (!['task', 'file', 'session', 'seq'].includes(kind)) {
          return {
            status: 'error',
            code: 'MT_KB_INVALID',
            message: `evidence.kind 必须是 task|file|session|seq，实际 "${kind}"（证据指针是有类型的，不是自由文本）`,
          }
        }
        if (ref.length === 0) {
          return { status: 'error', code: 'MT_KB_EVIDENCE_REQUIRED', message: `证据指针 "${kind}:" 后缺少内容（ref 为空 = 没有证据）` }
        }
        pointers.push(`${kind}:${ref}`)
      }
      // ② 证据纪律（E8）：空数组 = 没证据 = 拒绝。必须在任何 commit 之前——
      //    「先落账再校验」会给账本留下一条空证提案（成员侧分支的历史坑，此处不重演）。
      if (pointers.length === 0) {
        return {
          status: 'error',
          code: 'MT_KB_EVIDENCE_REQUIRED',
          message: '知识提案必须带证据指针（task:<id> / file:<path> / session:<id> / seq:<n>）；没有证据就不要提（E8）',
        }
      }
      // ③ 草案 id 由标题派生：KnowledgeDraft.id 受 ID_RE 约束（小写/数字/连字符），
      //    中文标题派生不出合法 id → 哈希兜底（确定性，同一标题重复提案落在同一 id，
      //    便于采纳时判重）。
      const title = String(args.title ?? '').trim()
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
      const draftId = /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)
        ? slug
        : `kb-${createHash('sha1').update(title).digest('hex').slice(0, 8)}`
      const relationIn = args.relation === undefined ? 'new' : String(args.relation)
      const draft: KnowledgeDraft = {
        id: draftId,
        title,
        body: String(args.body ?? ''),
        tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String).filter((t) => t.length > 0) : [],
        // 条目证据是**单指针**（KnowledgeEntry.evidence 是数组，但 adoptDraft 只取一条）：
        // 多条证据时取第一条，其余靠 relation:'refine' 逐条巩固（v2.7 演化式修订口径）。
        evidence: pointers[0]!,
        relation: relationIn as KnowledgeDraft['relation'],
        ...(typeof args.targetId === 'string' && args.targetId.trim().length > 0 ? { targetId: args.targetId.trim() } : {}),
      }
      const check = validateDraft(draft)
      if (!check.ok) return { status: 'error', code: check.code, message: check.message }
      // ④ refine/contradict 的目标必须是**显式给的既有条目**。
      //    为什么不能靠 validateDraft 兜：它允许 `targetId ?? draft.id` 的回落，
      //    而本工具的 draft.id 是**新派生**的（slug/哈希），回落等于「指向一个刚编出来的 id」——
      //    到采纳那一刻才炸（MT_KB_TARGET_MISMATCH），提案却白占了队长队列。
      if (draft.relation === 'refine' || draft.relation === 'contradict') {
        if (!draft.targetId) {
          return {
            status: 'error',
            code: 'MT_KB_TARGET_REQUIRED',
            message: `${draft.relation} 提案必须给 targetId（要精炼/矛盾的既有条目 id；新条目请用 relation:"new"）`,
          }
        }
        if (!readKnowledgeEntry(knowledgeDirOf(host.workspaceRoot()), draft.targetId)) {
          return {
            status: 'error',
            code: 'MT_KB_NOT_FOUND',
            message: `${draft.relation} 提案的目标条目 "${draft.targetId}" 不在知识库；先提 new 提案并采纳，或改用正确的 targetId`,
          }
        }
      }
      // ⑤ 落账（形状与成员侧 knowledgeDraft 分支一致：teamId/draftId/draft/proposedBy）
      const proposed = host.commit(teamId, {
        actor,
        type: 'knowledge.proposed',
        payload: { teamId, draftId, draft, proposedBy: actor },
      })
      return proposed.ok
        ? {
            status: 'proposed',
            draftId,
            relation: draft.relation ?? 'new',
            ...(draft.targetId ? { targetId: draft.targetId } : {}),
            evidence: pointers,
            note: '提案已进队长队列（**未入库**）；用户确认后 myteam_adopt_knowledge({ draftId, decision:"adopted" }) 才写进 config/knowledge/',
          }
        : { status: 'error', code: proposed.code, message: proposed.message }
    },

    participate(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const role = args.role === 'lead' ? 'lead' : 'coop'
      const memberIds = Array.isArray(args.memberIds)
        ? args.memberIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      const r = host.commit(teamId, {
        actor,
        type: 'task.participate',
        payload: {
          teamId,
          taskId: args.taskId,
          participantTeamId: args.participantTeamId,
          role,
          ...(memberIds.length > 0 ? { memberIds } : {}),
        },
      })
      return r.ok
        ? { status: 'participating', note: `任务 ${String(args.taskId)} 已登记参与团队 ${String(args.participantTeamId)}（${role}）` }
        : { status: 'error', code: r.code, message: r.message }
    },

    assign(teamId: string, args: Record<string, unknown>, actor: string): Record<string, unknown> {
      const ids = Array.isArray(args.memberIds)
        ? args.memberIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      if (ids.length === 0) return { status: 'error', code: 'MT_VALIDATION', message: 'memberIds requires at least 1 member' }
      const r = host.commit(teamId, {
        actor,
        type: 'task.assigned',
        payload: { teamId, taskId: args.taskId, memberId: ids[0], memberIds: ids },
      })
      return r.ok
        ? { status: 'assigned', taskId: args.taskId, memberIds: ids, note: '负责队员已标注；执行仍按角色 claim（指派不改变调度）' }
        : { status: 'error', code: r.code, message: r.message }
    },
  }
}

export function createMemberKnowledgeHandlers(host: MemberKnowledgeHostSurface) {
  return {
    /** `myteam_read_knowledge`：条目视图与队长读面同源（`knowledgeEntryView`，CHG-200）。 */
    read(args: Record<string, unknown>): Record<string, unknown> {
      const entry = knowledgeEntryView(host.workspaceRoot(), String(args.id))
      if (!entry) return { status: 'error', code: 'MT_KB_NOT_FOUND', message: `knowledge entry "${args.id}" not found（索引见提示词）` }
      return { status: 'ok', entry }
    },
  }
}
