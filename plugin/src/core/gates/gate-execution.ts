/**
 * CHG-190（T159b）：门禁执行（**行为边界**）——审查 / 验证 / 交付裁决 / 归档门禁 / 自动推进。
 *
 * `host.ts` 里与「一道门禁怎么判、怎么落账、怎么推进下一道」有关的 12 个私有方法**逐字**
 * 搬进本文件，宿主侧只剩一行转发（方法签名不变，调用点一个都没动）。这是入口层下沉三刀里的
 * **第二刀**（第一刀 T159a 把 spawn 生命周期搬进 `core/members/spawn-lifecycle.ts`，
 * 入口层 35.5% → 34.2%）。
 *
 * ## 为什么按「行为边界」而不是「端点」切
 *
 * T155 搬完端点族（`executeLeadTool` 的 case 层）后，入口层剩下的全是私有方法体。
 * 本文件收的是**一条完整行为链**：
 *
 * ```
 *   任务进 gate:*  ──→ review()         显式结论行 + 强制交叉审查（FR-5.1）+ 打回预算（FR-5.2）
 *   gate:verify   ──→ runVerifyGate()   host 跑命令取真实退出码（FR-5.3，绝不采信模型自述）
 *   gate:archive  ──→ evaluateArchive() 落位校验（FR-10.4）+ 交付判定（P1-2）+ 环境 latch（P1-5）
 *                        ↑ 新鲜度 freshness() / 产物基线 captureBaseline() / 证据与正文
 *                          artifactText() / completionReply() / deliveryJudgement()
 *   pass 之后     ──→ autoEvaluate()    下一道是 archive 就立即推进（archive 不是人工裁决门）
 * ```
 *
 * ## 逐字搬迁（纪律，不是口号）
 *
 * 方法体**一字不差**搬过来，只做形式适配。规范化规则只有四类，没有第五类：
 *
 *  1. `this.foo(` → `deps.foo(`——宿主面能力（`service` / `commit` / `log` /
 *     `artifactBaselinePath` / `resolveArtifactPath` / `statArtifact` / `guardVerdict`）；
 *  2. `this.workspaceRoot` → `deps.workspaceRoot()`、`this.rt.subprocess` →
 *     `deps.rt().subprocess`——**惰性 getter / 字段一律以方法接出来**（构造期取值会把
 *     「首次访问才解析项目根」提前，日志顺序会变）；
 *  3. `this.<私有方法>(` → `<同名>(/`——**同一工厂内的兄弟方法**不再是 `this` 成员。
 *     ⚠️ **声明名一律保留宿主名**，改名的只有「调用点」这一侧；对外暴露的 12 个键在返回对象里
 *     映射（`review: reviewTask`、`scopeAudit: scopeAuditFor` 等）。为什么不直接改声明名：
 *     方法体里本来就有同名局部变量（`reviewTask` / `runVerifyGate` 的 `const scopeAudit`、
 *     `deliveryJudgementFor` / `evaluateArchiveGate` 的 `const freshness`），把声明改叫
 *     `scopeAudit` / `freshness` 会让 `const scopeAudit = scopeAudit(…)` 落进 **TDZ** ——
 *     那不是形式适配，是真的行为变化。保留声明名 = 方法体（含签名行）**逐字**，
 *     改名只发生在唯一一处「对外表面」（返回对象），核验脚本能把两者分开判；
 *  4. 模块级标识符 → `deps.<name>`（`ABSENT_PATH_FINGERPRINT` / `ARTIFACT_TEXT_READ_LIMIT` /
 *     `deliverablePathsOf` / `readArtifactBaselineRecord` / `writeArtifactBaselineRecord` /
 *     `readLedgerEvents` / `deliverableMinLength` / `guardPayloadOf`）。
 *
 * `git diff` 的删除行与本文件做规范化后比对：**N/M 条逻辑行全部一字不差**（见 CHG-190 变更记录）。
 * 方法体内的注释也逐字保留——注释里的交叉引用仍写宿主侧方法名（`deliveryJudgementFor` 等），
 * 它们不是逻辑行，改它们只会让「逐字」这件事不可机械核验。
 *
 * ## 依赖边界（为什么是 17 个，而不是「全能门面」）
 *
 * `GateExecutionDeps` 只声明这 12 个方法**真正碰到**的宿主能力。有三类**不能**靠 import
 * 解决，所以只能显式注入：
 *
 *  - `deliverablePathsOf` / `readArtifactBaselineRecord` / `writeArtifactBaselineRecord` /
 *    `readLedgerEvents` / `deliverableMinLength` / `guardPayloadOf` 是 `host.ts` 的**模块级
 *    函数**（不是类成员）——`core/**` import 入口层 = `check-architecture.mjs` 的 **A1 门禁红**，
 *    并且 arch-report 的「逆向 value 边」会从 0 变 1。
 *  - `ABSENT_PATH_FINGERPRINT` / `ARTIFACT_TEXT_READ_LIMIT` 是 `host.ts` 的模块级常量，同理。
 *  - `rt` / `workspaceRoot` / `service` / `commit` / `log` / `guardVerdict` 是宿主**运行时
 *    状态与通道**（宿主 subprocess 服务、项目根、团队服务缓存、账本写入口、日志、护栏状态），
 *    它们的生命周期属于 host 进程，不属于领域层。
 *
 * `rt()` 只声明 `subprocess` 一个字段（`runVerifyCommand` 的入参口径就是 `unknown`）：
 * 在这里把 `HostRuntime` 收窄等于假装知道了宿主服务形状。**不是** `as any` 蒙混——
 * 本文件一个 `as` 断言都没有。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { runVerifyCommand, validateVerifyCommand, classifyVerifyResult, resolveTimeoutMs, type VerifyCommand, type VerifyFailureKind } from './command-gate.ts'
import { auditWriteScopes, filesTouchedOf, type ScopeAudit } from './scope-audit.ts'
import { artifactBaseline, artifactIsStale, mergeBaseline, type ArtifactBaseline, type ArtifactStat } from './artifact-freshness.ts'
import { extractEvidenceBlock, judgeDeliverable, type DeliveryJudgement } from './delivery-verdict.ts'
import { blocksCompletion, type GuardVerdict } from '../agent/guard.ts'
import { checkArchiveGate } from '../scheduler/recovery.ts'
import { GATE_REJECT_BUDGET } from '../scheduler/state.ts'
import type { CommitDraft, TeamService } from '../service.ts'

/**
 * 产物基线落盘结构（**只声明本文件读到的字段**）。
 *
 * 权威定义在 `host.ts` 的 `ArtifactBaselineRecord`（入口层）。`core/**` 不能 import 它
 * （A1 门禁），所以这里按**结构**声明；`host.ts` 的实参在装配处按结构化赋值校验，
 * 字段漂移会编译报错，不会静默漂移。
 */
export interface ArtifactBaselineView {
  version: 1
  teamId: string
  taskId: string
  /** **首次**拍基线的时间（ISO）：重拍只补缺失键，这个时间不被覆盖 */
  capturedAt: string
  /** 路径 → 指纹（`size:mtimeMs`，或 `absentPathFingerprint`） */
  baseline: ArtifactBaseline
}

/**
 * 门禁执行的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 加成员前先问：这条逻辑能不能落在 `core/gates/**`？只有「宿主进程才有的东西」
 * （subprocess 服务、项目根、团队服务缓存、账本提交、日志通道、护栏状态、模块级纯函数）
 * 才该进这里。
 */
export interface GateExecutionDeps {
  /** 团队服务（账本路径 / 投影 / 生效配置都从它取；host 侧缓存） */
  service: (teamId: string) => TeamService
  /** 账本提交（含 revision 校验；门禁裁决的唯一写入口） */
  commit: (teamId: string, draft: CommitDraft) => ReturnType<TeamService['commit']>
  /** 宿主日志通道（`[myteam]` 前缀由 host 侧 `log()` 统一加） */
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** 项目根（**惰性 getter**：构造期取不到项目级工作区） */
  workspaceRoot: () => string
  /** 宿主运行时（只用到 `subprocess`：command 门禁的唯一执行通道） */
  rt: () => { subprocess?: unknown }
  /** 产物基线落点 `.dsh-myteam/state/artifacts/<teamId>/<taskId>.json`（布局契约在 `core/workspace/layout.ts`） */
  artifactBaselinePath: (teamId: string, taskId: string) => string
  /** 产物路径 → 绝对路径（相对工作区解析；绝对路径原样） */
  resolveArtifactPath: (path: string) => string
  /** 读产物指纹（读不到 → undefined：**不要把异常抛进判定**） */
  statArtifact: (path: string) => ArtifactStat | undefined
  /** 成员单调用护栏的最近判定（P1-5 环境不可用 latch；`host.ts` 的 `guardVerdict` 方法） */
  guardVerdict: (memberId: string) => GuardVerdict | undefined
  /** `deliverableSpec` → 候选产物路径（`host.ts` 模块级纯函数，core 不能 import） */
  deliverablePathsOf: (spec: unknown, extra?: readonly string[]) => string[]
  /** 读产物基线记录（`host.ts` 模块级；缺失 / 坏 JSON → undefined） */
  readArtifactBaselineRecord: (filePath: string) => ArtifactBaselineView | undefined
  /** 写产物基线记录（走原子写；`host.ts` 模块级） */
  writeArtifactBaselineRecord: (filePath: string, record: ArtifactBaselineView) => string
  /** 「拍基线时还不存在」的哨兵指纹（`host.ts` 的 `ABSENT_PATH_FINGERPRINT`） */
  absentPathFingerprint: string
  /** 产物内容读取上限（`host.ts` 的 `ARTIFACT_TEXT_READ_LIMIT`） */
  artifactTextReadLimit: number
  /** 账本读取（`host.ts` 模块级；core 反向 import 会成 value 环） */
  readLedgerEvents: (ledgerPath: string) => { events: Record<string, any>[]; warnings: string[] }
  /** 任务类型 → 正文长度下限（`host.ts` 模块级纯函数） */
  deliverableMinLength: (taskType?: string) => number
  /** 护栏结论 → `task.gate.result` 载荷（`host.ts` 模块级纯函数） */
  guardPayloadOf: (verdict: GuardVerdict) => Record<string, unknown>
}

/* CHG-210 批 4.1：verify 门的环境熔断。
 * 同一命令连续「没跑起来」达阈值即熔断（转 needs-human，不再重复执行）。
 * 状态按**命令签名**隔离——换一条命令是新的开始。 */
const VERIFY_ENV_LATCH = 3
const verifyEnvFailures = new Map<string, number>()

/** 测试用：清空 verify 环境熔断状态（否则用例之间会串） */
export function __resetVerifyEnvLatch(): void {
  verifyEnvFailures.clear()
}

export function createGateExecution(deps: GateExecutionDeps) {
  /**
   * CHG-55：任务类型 → 门禁链展开（团队模板 taskTypes 生效）。
   * 显式 gateChain 优先；否则按生效配置 taskTypes[taskType] → taskTypes.default 展开。
   * 都不命中时原样返回（fold 兜底 review/archive）。
   */
  function taskWithGateChain(teamId: string, task: Record<string, unknown>): Record<string, unknown> {
    const explicit = Array.isArray(task.gateChain)
      ? (task.gateChain as unknown[]).filter((gate): gate is string => typeof gate === 'string' && gate.length > 0)
      : []
    if (explicit.length > 0) return task
    const types = deps.service(teamId).effectiveConfig.taskTypes
    const type = typeof task.taskType === 'string' && task.taskType ? task.taskType : 'default'
    const chain = types[type]?.gateChain ?? types.default?.gateChain
    return chain && chain.length > 0 ? { ...task, gateChain: [...chain] } : task
  }

  /**
   * CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口（队长工具 + 面板 reviewTask 共用）。
   *
   * 修复的断链：`task.gate.result` 此前**只有**成员 `update_task` 的 archive 分支会写，
   * 而默认门禁链是 `['review','archive']`——任务 done 后进的是 `gate:review` 不是
   * `gate:archive`，条件永不成立；且任何 Lead 工具 / 面板端点都没有裁决入口。
   * 结果：任务永远到不了 `done`，下游依赖永不解锁，归档与成本管线全部悬空。
   *
   * 裁决口径：
   *  - `gate:review` / `gate:verify` → 只认显式结论行（verdict 必填），**强制交叉审查**
   *    （reviewerMemberId 必填且 ≠ 实现者；同成员拒绝 `MT_CROSS_REVIEW`，FR-5.1）；
   *  - `gate:archive` → 不是人工裁决门：host 按 `deliverableSpec` 约定路径做落位校验
   *    （FR-10.4），verdict 参数只用于"再校验一次"，**绝不采信模型自述"已归档"**；
   *  - 打回预算（FR-5.2）：单门 fail 轮数 ≥ `GATE_REJECT_BUDGET` 后，队长侧 pass 被拒
   *    （`MT_REJECT_BUDGET` → needs-human），只有人工（actor='human' 且 confirm=true）能放行。
   */
  function reviewTask(
    teamId: string,
    args: Record<string, unknown>,
    actor: string,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const taskId = String(args.taskId ?? '')
    if (!taskId) return { status: 'error', code: 'MT_VALIDATION', message: 'taskId is required' }
    const verdict = args.verdict === 'pass' ? 'pass' : args.verdict === 'fail' ? 'fail' : undefined
    if (!verdict) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        message: 'verdict must be "pass" or "fail"（只认显式结论行；无结论 = needs-human，不回退解析自由文本 FR-5.1）',
      }
    }
    const task = deps.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    if (!task.state.startsWith('gate:')) {
      return {
        status: 'error',
        code: 'MT_VALIDATION',
        message: `task "${taskId}" is ${task.state}, not in a gate state（门禁裁决只对 gate:* 任务有效；先由实现者申报 done）`,
      }
    }
    const gate = task.state.slice('gate:'.length)

    // ① archive 门：结论由文件事实决定
    if (gate === 'archive') {
      const evaluated = evaluateArchiveGate(teamId, taskId, actor)
      return {
        // P1-5：环境不可用 latch → needs-human（人工裁决入口），既不是 pass 也不是可自动重试的 fail
        status: evaluated.needsHuman === true ? 'needs-human' : evaluated.pass ? 'gate-pass' : 'gate-fail',
        gate,
        ...(evaluated.needsHuman === true ? { code: 'MT_ENV_UNAVAILABLE' } : {}),
        taskState: deps.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? task.state,
        note: evaluated.note,
        ...(evaluated.reason ? { reason: evaluated.reason } : {}),
        note2: 'archive 门由 host 按 deliverableSpec 约定路径做落位校验（FR-10.4），不接受模型自述「已归档」',
      }
    }

    // ①b verify 门：**不接受人工 verdict** —— host 跑命令取真实退出码（FR-5.3）
    // 「绝不采信模型自述『测试通过』」：连人工点了 pass 都不算，只有进程退出码算。
    // （人工强制放行是独立的 confirm 通道，会留痕 forcedBy:'human'。）
    if (gate === 'verify') {
      return runVerifyGate(teamId, taskId, args, actor)
    }

    // ② review 门：强制交叉审查（FR-5.1）
    const reviewer = String(args.reviewerMemberId ?? '').trim()
    if (!reviewer) {
      return {
        status: 'error',
        code: 'MT_CROSS_REVIEW',
        message: `gate "${gate}" requires reviewerMemberId（强制交叉审查 FR-5.1：审查者必须是另一名成员）`,
      }
    }
    const reviewerMember = deps.service(teamId).projectionSnapshot.members[reviewer]
    if (!reviewerMember) return { status: 'error', code: 'MT_VALIDATION', message: `reviewer "${reviewer}" not found in this team` }
    const implementer = task.assignee
    if (implementer && reviewer === implementer) {
      return {
        status: 'error',
        code: 'MT_CROSS_REVIEW',
        message: `reviewer "${reviewer}" is the implementer of "${taskId}"; 强制交叉审查要求审查者不同于实现者（FR-5.1）`,
      }
    }

    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (verdict === 'fail' && !reason) {
      return { status: 'error', code: 'MT_VALIDATION', message: 'verdict=fail requires a non-empty reason（打回必须写清要改什么）' }
    }
    const rejectCount = task.gateRejects?.[gate] ?? 0
    // ③ 打回预算（FR-5.2）：超预算后只有人工能放行
    if (verdict === 'pass' && rejectCount >= GATE_REJECT_BUDGET && !(actor === 'human' && args.confirm === true)) {
      return {
        status: 'needs-human',
        code: 'MT_REJECT_BUDGET',
        gate,
        taskState: task.state,
        rejectCount,
        message: `gate "${gate}" 已打回 ${rejectCount} 轮，达到复验预算上限（≤${GATE_REJECT_BUDGET}）；需人工裁决（面板带 confirm=true 可放行）`,
      }
    }
    const scopeAudit = scopeAuditFor(teamId, taskId)
    // P1-2 接线（review 门）：交付判定**只留痕不否决** —— review 门是人 / 队长的显式裁决
    // （FR-5.1 强制交叉审查），交付判定的否决权在 archive 门（host 事实面）。
    // 记进同一份 `task.gate.result` 载荷，账本里能看出「这次裁决时交付信号是什么」。
    const delivery = deliveryJudgementFor(teamId, taskId).payload
    const r = deps.commit(teamId, {
      actor,
      type: 'task.gate.result',
      payload: {
        teamId, taskId, gate, verdict,
        ...(reason ? { reason } : {}),
        reviewerMemberId: reviewer,
        /* CHG-210 批 3.3：**把这次裁决钉在被审的那一世产物上**。
         * 光有「review 过了」不够——必须能回答「过的是哪一版」。落账后：
         *   - 审计面能看出「这条 pass 对应的 attempt」；
         *   - `task.claimed`（新 attempt）会清空 gate 裁决（见 fold），旧结论不会自动继承。 */
        ...(task.attemptId ? { reviewedAttempt: task.attemptId } : {}),
        ...(scopeAudit ? { scopeAudit } : {}),
        delivery,
      },
      ...(expectedRevisionOf(args) !== undefined ? { expectedRevision: expectedRevisionOf(args) } : {}),
    })
    if (!r.ok) return { status: 'error', code: r.code, message: r.message, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) }

    if (verdict === 'fail') {
      return {
        status: 'gate-fail',
        gate,
        taskState: task.state,
        rejectCount: rejectCount + 1,
        delivery,
        note: `已打回（第 ${rejectCount + 1} 轮）；任务留在 ${task.state}，实现者修复后重新提交 done 再复验`,
      }
    }
    // ④ pass 后：下一道若是 archive 门，host 立即做落位校验（archive 不是人工裁决门）
    const auto = autoEvaluateGateChain(teamId, taskId, actor)
    return {
      status: 'gate-pass',
      gate,
      taskState: deps.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'done',
      delivery,
      ...(auto.note ? { note: auto.note } : {}),
    }
  }

  /**
   * CHG-87（QA-4 乐观锁）：把工具入参里的 `expectedRevision` 收敛成 `number | undefined`。
   * 非数字字符串 → NaN（service 侧 `Number.isInteger` 判定为 `MT_VALIDATION`），
   * 这样"给了个坏值"不会被静默当成"没给"。
   */
  function expectedRevisionOf(args: Record<string, unknown>): number | undefined {
    const raw = args?.expectedRevision
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'number') return raw
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }

  /**
   * CHG-87（FR-5.4）：为某任务算一次 scope 完成审计。
   *
   * 输入 = 任务声明的 `writeScopes` × 当前 attempt 的证据块申报的 `filesTouched`。
   * 未声明 writeScopes（或配置 `audit.writeScopes=false`）→ `undefined`（不落审计载荷，
   * 不制造"未越界"的空噪音）。
   *
   * 为什么从**证据事件**取申报文件而不是从投影：投影只存 seq，申报内容的权威在账本里
   * （`task.evidence` 事件的 `evidence.commands[].filesTouched`）。取**最后一个属于当前
   * attempt** 的证据——历史 attempt 的文件不该算进这次交付。
   */
  function scopeAuditFor(teamId: string, taskId: string): ScopeAudit | undefined {
    const svc = deps.service(teamId)
    if (svc.effectiveConfig.audit?.writeScopes === false) return undefined
    const task = svc.projectionSnapshot.tasks[taskId]
    if (!task) return undefined
    const scopes = task.input.writeScopes ?? []
    if (scopes.length === 0) return undefined
    const attemptId = task.attemptId
    let declared: string[] = []
    for (let i = task.evidenceRefs.length - 1; i >= 0; i--) {
      const payload = svc.eventBySeq(task.evidenceRefs[i])?.payload
      if (!payload) continue
      // 只认当前 attempt 的证据（历史 attempt 的文件不算这次交付）；旧账本无 attemptId 时放行
      if (attemptId && payload.attemptId && payload.attemptId !== attemptId) continue
      declared = filesTouchedOf(payload.evidence as Record<string, unknown> | undefined)
      break
    }
    return auditWriteScopes(declared, scopes)
  }

  /**
   * CHG-87（FR-5.3）：`gate:verify` 的 host 执行路径。
   *
   * 语义（严格对齐 FR-5.3「绝不采信模型自述"测试通过"」）：
   *  - **普通调用（actor=lead / 未 confirm）**：忽略 verdict 参数，跑 `task.input.verifyCommand`，
   *    以**真实退出码**定 pass/fail，结果（命令 / exitCode / signal / durationMs / 输出尾部 /
   *    scope 审计）落账本；
   *  - **人工强制放行（actor=human 且 confirm=true）**：不跑命令，落 pass 并标
   *    `forcedBy:'human'` + 必填 reason——这是"宿主没有 subprocess 服务"时的唯一出口，
   *    且留痕（谁在什么时候放过了哪道门）；
   *  - 任务没声明 verifyCommand → `MT_VERIFY_NO_COMMAND`（不是静默 pass）；
   *  - 宿主没 subprocess 服务 → `MT_UNAVAILABLE`（**不静默降级成人工点通过**）。
   */
  /**
   * CHG-210 批 4.4：**失败原因分线，每条带下一步**。
   *
   * 旧实现只有一句 `verify 门 fail（exit 1）；任务已回到修复队列`——用户分不清
   * 「环境缺东西」还是「代码错」，而这两件事该做的事完全相反。
   */
  function verifyFailureNote(kind: VerifyFailureKind | undefined, code: number | string | null | undefined): string {
    switch (kind) {
      case 'not-run':
        return `命令没跑起来（exit ${code}）——**不是代码问题**：确认 verifyCommand 的可执行文件在 PATH 上、cwd 存在`
      case 'timed-out':
        return '命令超时未跑完，按未通过处理——可缩小 verifyCommand 范围，或调高 gates.commandTimeoutMs'
      case 'signaled':
        return `命令被信号中断（${code}）——确认没有外部 kill / OOM`
      default:
        return `断言失败（exit ${code}）——修完重新申报 done 再跑`
    }
  }

  async function runVerifyGate(
    teamId: string,
    taskId: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<Record<string, unknown>> {
    const svc = deps.service(teamId)
    const task = svc.projectionSnapshot.tasks[taskId]
    if (!task) return { status: 'error', code: 'MT_VALIDATION', message: `task "${taskId}" not found` }
    const command = task.input.verifyCommand as VerifyCommand | undefined
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

    // 人工强制放行（唯一不跑命令的出口；必须留下理由）
    if (actor === 'human' && args.confirm === true) {
      if (!reason) {
        return { status: 'error', code: 'MT_VALIDATION', message: '人工强制放行必须写清理由（reason 非空；这是唯一绕过命令执行的出口，要能审计）' }
      }
      const scopeAudit = scopeAuditFor(teamId, taskId)
      const forced = deps.commit(teamId, {
        actor,
        type: 'task.gate.result',
        payload: {
          teamId,
          taskId,
          gate: 'verify',
          verdict: 'pass',
          forcedBy: 'human',
          reason,
          ...(scopeAudit ? { scopeAudit } : {}),
        },
        ...(expectedRevisionOf(args) !== undefined ? { expectedRevision: expectedRevisionOf(args) } : {}),
      })
      if (!forced.ok) {
        return { status: 'error', code: forced.code, message: forced.message, ...(forced.currentRevision !== undefined ? { currentRevision: forced.currentRevision } : {}) }
      }
      const auto = autoEvaluateGateChain(teamId, taskId, actor)
      return {
        status: 'gate-pass',
        gate: 'verify',
        forcedBy: 'human',
        taskState: deps.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'done',
        note: `人工强制放行已留痕（reason: ${reason}）；${auto.note ?? '已推进门禁链'}`,
        ...(scopeAudit ? { scopeAudit } : {}),
      }
    }

    // 普通路径：必须有命令
    const commandError = validateVerifyCommand(command)
    if (commandError) return { status: 'error', code: commandError.code, message: commandError.message }
    if (!command) {
      return {
        status: 'error',
        code: 'MT_VERIFY_NO_COMMAND',
        message: `gate "verify" 要求任务声明 verifyCommand（argv 数组）；task "${taskId}" 未声明，无法执行 command 门禁（FR-5.3）。请用 myteam_edit_task 补 verifyCommand 后重试`,
      }
    }
    /* CHG-210 批 4.3：**打回预算超限后不再重复执行命令**。
     *
     * 旧实现只在下面拦 `pass`：verify 门每轮 fail 都要真跑一次命令（最长 120s）、把任务放回
     * ready、下一轮再跑——于是 `GATE_REJECT_BUDGET` 事实上只挡住了「放行」，没挡住「继续烧」。
     * 超限后的正确动作是交给人，而不是再跑一遍同一条注定失败的命令。
     * 人工强制放行（上面那个分支）不受此限：它就是超预算后的出口。 */
    /* CHG-210 批 4.1：**环境类失败优先于预算类**（必须在预算闸之前）。
     *
     * 为什么：`GATE_REJECT_BUDGET` 默认 2，而 verify 每轮 fail 都会 +1——第 3 次进来时预算闸
     * 先拦（`MT_REJECT_BUDGET`），熔断的名额永远轮不到。但两句话对用户的价值完全不同：
     * 「你已打回 2 轮，转人工」vs「这条命令连续 2 次根本没跑起来，去查 PATH」——后者可行动。
     *
     * 判据用**上一轮的结果**（所以阈值是 `-1`）：第 1/2 次正常跑命令并计数，第 3 次进来时
     * 看到「前两次都是 not-run」就直接熔断，不再浪费一次执行。 */
    const verifySig = Array.isArray(task.input.verifyCommand?.argv) ? (task.input.verifyCommand!.argv as string[]).join('\u0000') : ''
    const envSeen = verifySig ? (verifyEnvFailures.get(verifySig) ?? 0) : 0
    if (envSeen >= VERIFY_ENV_LATCH - 1) {
      return {
        status: 'needs-human',
        code: 'MT_ENV_UNAVAILABLE',
        gate: 'verify',
        taskState: task.state,
        failureKind: 'not-run',
        failures: envSeen,
        message: `这条命令已连续 ${envSeen} 次没跑起来（**不是代码问题**）；不再重复执行，等环境修好后由人工确认重跑。检查可执行文件是否在 PATH、cwd 是否存在。`,
      }
    }
    const spentRejects = task.gateRejects?.verify ?? 0
    if (spentRejects >= GATE_REJECT_BUDGET) {
      return {
        status: 'needs-human',
        code: 'MT_REJECT_BUDGET',
        gate: 'verify',
        taskState: task.state,
        rejectCount: spentRejects,
        message: `verify 门已打回 ${spentRejects} 轮（上限 ${GATE_REJECT_BUDGET}），本轮**不再执行命令**；需人工裁决（面板带 confirm=true + 理由可强制放行）`,
      }
    }
    const workdir = command.cwd ? join(deps.workspaceRoot(), command.cwd) : deps.workspaceRoot()
    const timeoutMs = resolveTimeoutMs(command.timeoutMs, svc.effectiveConfig.gates?.commandTimeoutMs)
    const run = await runVerifyCommand({ command, workdir, timeoutMs, subprocess: deps.rt().subprocess })
    if (!run.ok) return { status: 'error', code: run.code, message: run.message }

    /* CHG-210 批 4.2：分类带 `failureKind`——「命令没跑起来」与「测试真挂了」在界面上必须分开，
     * 因为用户要做的事完全相反（修环境 vs 改代码）。 */
    const classified = classifyVerifyResult(run.result)
    const verdict = classified.verdict
    /* CHG-210 批 4.1：这里只**计数**，不返回——真正的熔断判断在下一轮进入时做
     * （见上面的「环境类失败优先于预算类」）。计数按命令签名隔离。 */
    {
      const signature = command.argv.join('\u0000')
      if (classified.failureKind === 'not-run') verifyEnvFailures.set(signature, (verifyEnvFailures.get(signature) ?? 0) + 1)
      else verifyEnvFailures.delete(signature)
    }
    const scopeAudit = scopeAuditFor(teamId, taskId)
    const rejectCount = task.gateRejects?.verify ?? 0
    if (verdict === 'pass' && rejectCount >= GATE_REJECT_BUDGET && !(actor === 'human' && args.confirm === true)) {
      return {
        status: 'needs-human',
        code: 'MT_REJECT_BUDGET',
        gate: 'verify',
        taskState: task.state,
        rejectCount,
        exitCode: run.result.exitCode,
        command: { argv: [...command.argv], ...(command.cwd ? { cwd: command.cwd } : {}) },
        message: `verify 门已打回 ${rejectCount} 轮，达到复验预算上限（≤${GATE_REJECT_BUDGET}）；需人工裁决（面板带 confirm=true 可放行）`,
      }
    }
    const committed = deps.commit(teamId, {
      actor,
      type: 'task.gate.result',
      payload: {
        teamId,
        taskId,
        gate: 'verify',
        verdict,
        command: { argv: [...command.argv], ...(command.cwd ? { cwd: command.cwd } : {}) },
        exitCode: run.result.exitCode,
        signal: run.result.signal,
        durationMs: run.result.durationMs,
        outputTail: run.result.outputTail,
        ...(classified.failureKind ? { failureKind: classified.failureKind } : {}),
        executedBy: 'host',
        ...(reason ? { reason } : {}),
        ...(scopeAudit ? { scopeAudit } : {}),
      },
      ...(expectedRevisionOf(args) !== undefined ? { expectedRevision: expectedRevisionOf(args) } : {}),
    })
    if (!committed.ok) {
      return { status: 'error', code: committed.code, message: committed.message, ...(committed.currentRevision !== undefined ? { currentRevision: committed.currentRevision } : {}) }
    }
    const base = {
      gate: 'verify',
      command: { argv: [...command.argv], ...(command.cwd ? { cwd: command.cwd } : {}) },
      exitCode: run.result.exitCode,
      signal: run.result.signal,
      durationMs: run.result.durationMs,
      outputTail: run.result.outputTail,
      ...(classified.failureKind ? { failureKind: classified.failureKind } : {}),
      ...(scopeAudit ? { scopeAudit } : {}),
    }
    if (verdict === 'fail') {
      return {
        status: 'gate-fail',
        ...base,
        taskState: deps.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'gate:verify',
        rejectCount: rejectCount + 1,
        note: `verify 门 fail（${verifyFailureNote(classified.failureKind, run.result.exitCode ?? run.result.signal)}）；任务已回到修复队列`,
      }
    }
    const auto = autoEvaluateGateChain(teamId, taskId, actor)
    return {
      status: 'gate-pass',
      ...base,
      taskState: deps.service(teamId).projectionSnapshot.tasks[taskId]?.state ?? 'done',
      ...(auto.note ? { note: auto.note } : { note: 'verify 门 pass（exit 0）' }),
    }
  }

  /**
   * P1-1 接线：任务进入 `in_progress`（claim 成功 / 申报 in_progress / 重规划）时拍产物基线。
   *
   * 为什么必须在**阶段开始**拍：基线语义是「本阶段开始时这些文件长什么样」，
   * 只有它固定在阶段起点，「指纹变了」才等于「本阶段真的写过它」。
   *
   * 为什么给「拍基线时不存在」的路径写哨兵：见 `deps.absentPathFingerprint`。
   *
   * 续跑 / 重试只补缺失键（`mergeBaseline`）：重拍若能覆盖，「第一轮写了、第二轮没写」
   * 会把第一轮的写入洗成基线，第二轮反而凭第一轮的文件被判新鲜 —— 正是要防的假绿。
   */
  function captureArtifactBaseline(teamId: string, taskId: string): ArtifactBaseline {
    try {
      const task = deps.service(teamId).projectionSnapshot.tasks[taskId]
      if (!task) return {}
      const paths = deps.deliverablePathsOf(task.input.deliverableSpec)
      if (paths.length === 0) return {}
      const filePath = deps.artifactBaselinePath(teamId, taskId)
      const previous = deps.readArtifactBaselineRecord(filePath)
      const next = artifactBaseline(paths, (path) => deps.statArtifact(path))
      for (const path of paths) {
        if (!Object.prototype.hasOwnProperty.call(next, path)) next[path] = deps.absentPathFingerprint
      }
      const baseline = previous ? mergeBaseline(previous.baseline, next) : next
      deps.writeArtifactBaselineRecord(filePath, {
        version: 1,
        teamId: String(teamId),
        taskId: String(taskId),
        capturedAt: previous?.capturedAt ?? new Date().toISOString(),
        baseline,
      })
      return baseline
    } catch (e) {
      // 基线是「判交付的客观凭据」：拍不下来只告警（archive 门会按「没拍过基线」兼容放行）
      deps.log('warn', `artifact baseline capture failed (${teamId}/${taskId}): ${String(e)}`)
      return {}
    }
  }

  /**
   * P1-1：产物新鲜度过滤（**stale 的当不存在**）。
   *
   * 兼容口径（旧账本 / 未领取过的任务）：**没有基线记录** → 不过滤（全部当新鲜）。
   * 理由：接线之前入库的任务从没拍过基线，按「缺键 = 陈旧」判会把历史任务全拒掉；
   * 而假绿的防线仍在 —— 这类任务拿不到「空收尾用产物内容顶替」的交付兜底
   * （见 `deliveryJudgementFor` 的 docText），且归档结果里会带 `freshness: 'baseline-missing'`
   * 供审计区分「真的新鲜」与「没拍过基线」。
   *
   * `enforced` 只是为了留痕：判定本身已经把 stale 的路径从新鲜集合里剔除了。
   */
  function artifactFreshnessFor(
    teamId: string,
    taskId: string,
    declaredPaths: readonly string[] = [],
  ): { fresh: string[]; stale: string[]; enforced: boolean } {
    const task = deps.service(teamId).projectionSnapshot.tasks[taskId]
    const paths = deps.deliverablePathsOf(task?.input.deliverableSpec, declaredPaths)
    const record = deps.readArtifactBaselineRecord(deps.artifactBaselinePath(teamId, taskId))
    if (!record) return { fresh: [...paths], stale: [], enforced: false }
    const fresh: string[] = []
    const stale: string[] = []
    for (const path of paths) {
      // 定义变更（rescope 加的新产物）在基线上没有这个键 —— 那不是「本阶段没写」，
      // 而是「拍基线时还没这条要求」：放行并留痕，不当陈旧（否则重规划后永远过不了门）。
      if (!Object.prototype.hasOwnProperty.call(record.baseline, path)) {
        fresh.push(path)
        continue
      }
      if (artifactIsStale(record.baseline, path, deps.statArtifact(path))) stale.push(path)
      else fresh.push(path)
    }
    return { fresh, stale, enforced: true }
  }

  /**
   * 读产物内容（P1-2 空收尾兜底用的 `docText`）：**只读新鲜产物**，空文件不贡献内容。
   *
   * 为什么空文件要单独跳过（而不是让空串参与长度比较）：`docText` 会喂给
   * `judgeDeliverable` 的「空文件不算交付」判据，一个 0 字节文件在这里留下空块，
   * 只会让「产物存在」和「产物为空」在判定里长得一样。跳过 = 空文件等价于不存在。
   */
  function artifactTextOf(paths: readonly string[]): string {
    const chunks: string[] = []
    for (const path of paths) {
      try {
        const text = readFileSync(deps.resolveArtifactPath(path), 'utf8')
        const trimmed = text.trim()
        if (trimmed.length === 0) continue
        chunks.push(trimmed.slice(0, deps.artifactTextReadLimit))
      } catch {
        // 读不到 = 没有内容可顶替（陈旧判定已在 artifactFreshnessFor 里做过）
      }
    }
    return chunks.join('\n')
  }

  /**
   * 取「申报 done 时的回复正文」（P1-2 的 `text` / `stopReason` 来源）。
   *
   * 为什么从账本取而不是再存一份：`task.completed` 的 `summary` 就是成员的回复正文，
   * 账本已经持久化它；再存一份必然两份漂移（而且重启后只剩账本）。
   * 找不到 completed 事件 → **不传** stopReason：空收尾分支只在真正确认过正常收尾时才该生效，
   * 凭空造 `completed` 会让「短正文 + 产物凑长度」被误判成交付。
   */
  function completionReplyOf(teamId: string, taskId: string): { text: string; stopReason?: string } {
    try {
      const events = deps.readLedgerEvents(deps.service(teamId).ledgerPath).events
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type !== 'task.completed') continue
        if (String(event.payload?.taskId ?? '') !== String(taskId)) continue
        return { text: typeof event.payload?.summary === 'string' ? event.payload.summary : '', stopReason: 'completed' }
      }
      return { text: '' }
    } catch {
      return { text: '' }
    }
  }

  /**
   * P1-2 交付判定（review 门留痕 / archive 门否决共用同一口径）。
   *
   * `hasEvidence` 取**客观事实**：账本里有 `task.evidence` 事件（FR-5.0 的要求：
   * 申报 done 前必须有同 attempt 的证据事件），或回复正文里带 `[Verification evidence]` 块。
   * 为什么结构化证据也算：成员的证据是 `myteam_update_task` 的结构化参数、落的是
   * `task.evidence` 事件 —— 它比「正文里有没有那行标记」更硬（正文可能被摘要截断）。
   *
   * `docText` 只取**新鲜**产物的内容：陈旧文件是上游写的，不能当本阶段的交付顶替。
   *
   * P1-5 接线（docs/21 §6）：如果该任务的实现者已经 latch 了 `env-unavailable`，
   * 交付判定**直接** `needs-human`——`blocksCompletion` 的语义是「环境根本不可用，
   * 任何『完成』声明都一定是假的」：此时重试、换命令、换参数都修不好环境，
   * 自动重试只会继续烧 token（P1-5 的整个存在理由）。
   */
  function deliveryJudgementFor(teamId: string, taskId: string): { judgement: DeliveryJudgement; payload: Record<string, unknown> } {
    const task = deps.service(teamId).projectionSnapshot.tasks[taskId]
    const reply = completionReplyOf(teamId, taskId)
    const freshness = artifactFreshnessFor(teamId, taskId)
    const hasEvidence = extractEvidenceBlock(reply.text) !== undefined || (task?.evidenceRefs?.length ?? 0) > 0
    const minLength = deps.deliverableMinLength(task?.input.taskType)
    const docText = artifactTextOf(freshness.fresh)
    const judged = judgeDeliverable({
      ...(reply.stopReason ? { stopReason: reply.stopReason } : {}),
      text: reply.text,
      minLength,
      docText,
      hasEvidence,
    })
    // P1-5：环境不可用 latch 优先于一切交付信号（含证据块）——它证伪的是「能不能跑」，
    // 不是「跑得对不对」，所以不能走 evidence 分支放行。
    const guard = deps.guardVerdict(String(task?.assignee ?? ''))
    const blocked = blocksCompletion(guard)
    const judgement: DeliveryJudgement = blocked && guard
      ? {
          verdict: 'needs-human',
          signal: 'none',
          reason: `环境不可用（guard:${guard.kind}）：${guard.message} —— 转人工；重试/换命令/换参数都修不好环境，禁止自动重试`,
        }
      : judged
    return {
      judgement,
      payload: {
        verdict: judgement.verdict,
        signal: judgement.signal,
        reason: judgement.reason,
        minLength,
        hasEvidence,
        docLength: docText.trim().length,
        freshArtifacts: freshness.fresh,
        staleArtifacts: freshness.stale,
        // 区分「真的新鲜」与「没拍过基线」：兼容分支不该看起来像一次成功的新鲜度校验
        ...(freshness.enforced ? {} : { freshness: 'baseline-missing' }),
        // P1-5：护栏结论进同一份 gate 载荷（不新增事件型）
        ...(blocked && guard ? { guardBlocked: true, guard: deps.guardPayloadOf(guard) } : {}),
      },
    }
  }

  /**
   * archive 门落位校验（FR-10.4）：按 `deliverableSpec` 约定路径检查产物是否真实存在。
   * pass → 补写 `task.deliverable`（实存路径）再落 `task.gate.result` pass（fold 推进 done）；
   * fail → 落 `task.gate.result` fail 留档（repair 流转 M2），调用方从返回 note 可见。
   * 抽取自 FIX-10 的成员 `update_task` 分支：CHG-86 起队长工具 / 面板 / 成员三处共用同一判定。
   *
   * P1-1/P1-2 接线后（docs/21 §6）：两道判据**同时**成立才算 pass——
   *  ① **落位**：新鲜产物里至少有一个真实存在（stale 的不算数）；
   *  ② **交付判定**：`judgeDeliverable` 判 delivered（空文件 / 无证据 + 无正文 / 有拒绝词 = 不算交付）。
   * 判定结论（verdict / signal / 新鲜与陈旧清单）随 `task.gate.result` 载荷落账本，
   * **不新增事件型**（保持 40 型）。这样「产物在但没人写过它」这类假绿在账本里可查。
   *
   * P1-5：`guardBlocked`（环境不可用 latch）**不落 gate.result fail**，而是返回
   * `needsHuman` —— fail 会被 fold 放回 `ready`（自动重试），而环境不可用时重试只会继续烧
   * token。任务停在 `gate:archive` 等人工裁决，这才是「禁止自动重试」的实现面。
   */
  function evaluateArchiveGate(
    teamId: string,
    taskId: string,
    actor: string,
    declaredPaths: string[] = [],
  ): { pass: boolean; note: string; reason?: string; needsHuman?: boolean } {
    const task = deps.service(teamId).projectionSnapshot.tasks[taskId]
    if (!task || task.state !== 'gate:archive') {
      return { pass: false, note: '', reason: `task "${taskId}" is not at gate:archive` }
    }
    const existsUnderWorkspace = (p: string) => (isAbsolute(p) ? existsSync(p) : existsSync(join(deps.workspaceRoot(), p)))
    // ① P1-1：只把**新鲜**产物交给落位校验（stale 的当不存在）
    const freshness = artifactFreshnessFor(teamId, taskId, declaredPaths)
    const placement = checkArchiveGate(
      task.input.deliverableSpec as { path: string } | undefined,
      freshness.fresh.map((path) => ({ path })),
      existsUnderWorkspace,
    )
    // ② P1-2 + P1-5：交付判定（产物陈旧 / 空文件 / 无证据 / 命中拒绝词 / 环境不可用 都不算交付）
    const { judgement, payload } = deliveryJudgementFor(teamId, taskId)
    const delivered = placement.pass && judgement.verdict === 'delivered'
    if (delivered) {
      for (const c of placement.checks) {
        if (c.exists) deps.commit(teamId, { actor, type: 'task.deliverable', payload: { teamId, taskId, path: c.path } })
      }
      const gr = deps.commit(teamId, {
        actor,
        type: 'task.gate.result',
        payload: { teamId, taskId, gate: 'archive', verdict: 'pass', delivery: payload },
      })
      return gr.ok
        ? { pass: true, note: `archive gate pass（落位校验通过 + 交付判定 ${judgement.verdict}），任务已归档` }
        : { pass: false, note: '', reason: gr.message ?? 'gate.result commit failed' }
    }
    const reason = placement.pass
      ? `交付判定未通过（${judgement.signal}）：${judgement.reason}`
      : (placement.reason ?? 'deliverable 未落位')
    // P1-5：环境不可用 → 转人工，**不落 fail**（fail 会被 fold 放回 ready = 自动重试）
    if (payload.guardBlocked === true) {
      deps.log('warn', `archive gate blocked by guard for ${teamId}/${taskId}: ${reason}`)
      return {
        pass: false,
        needsHuman: true,
        note: `archive gate 转人工：${reason}（任务停在 gate:archive，禁止自动重试；请人工确认环境后强制放行）`,
        reason,
      }
    }
    deps.commit(teamId, {
      actor,
      type: 'task.gate.result',
      payload: { teamId, taskId, gate: 'archive', verdict: 'fail', reason, delivery: payload },
    })
    return {
      pass: false,
      note: `archive gate fail：${reason}（repair 流转 M2；请补交付物后 escalate 或联系队长）`,
      reason,
    }
  }

  /**
   * 门禁自动推进（CHG-86）：review/verify 裁决通过后，若下一道是 archive 门则立即
   * 做落位校验并推进到 done（archive 不是人工裁决门，不该让人再点一次）。
   * 循环上限 = 门禁链长度 + 1：自定义链里 archive 出现在中间时不会死循环。
   */
  function autoEvaluateGateChain(teamId: string, taskId: string, actor: string): { advanced: boolean; note?: string } {
    const chain = deps.service(teamId).projectionSnapshot.tasks[taskId]?.gates ?? []
    let note: string | undefined
    let advanced = false
    for (let i = 0; i <= chain.length; i++) {
      const task = deps.service(teamId).projectionSnapshot.tasks[taskId]
      if (!task || task.state !== 'gate:archive') break
      const evaluated = evaluateArchiveGate(teamId, taskId, actor)
      note = evaluated.note
      if (!evaluated.pass) break
      advanced = true
    }
    return { advanced, ...(note ? { note } : {}) }
  }
  return {
    taskWithGateChain,
    review: reviewTask,
    expectedRevision: expectedRevisionOf,
    scopeAudit: scopeAuditFor,
    runVerifyGate,
    captureBaseline: captureArtifactBaseline,
    freshness: artifactFreshnessFor,
    artifactText: artifactTextOf,
    completionReply: completionReplyOf,
    deliveryJudgement: deliveryJudgementFor,
    evaluateArchive: evaluateArchiveGate,
    autoEvaluate: autoEvaluateGateChain,
  }
}
