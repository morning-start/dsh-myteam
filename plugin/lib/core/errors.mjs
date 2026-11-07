/**
 * 全项目错误码的**唯一来源**（CHG-98，审计 A7）。
 *
 * 背景：改名前 `MT_*` 是散落在 250 余处调用点的字符串字面量，`docs/04` 的散文里提到一部分，
 * 没有任何东西保证两边一致 —— 实测**实现 70 个、文档只覆盖 32 个**，客户端 10 处
 * 按码分支的代码在静默失效（码改了没人知道）。
 *
 * 现在：
 *   - `MT_CODES` 是唯一的码清单，`MtCode` 由它推导，编译器能拦住错字；
 *   - `MT_CODE_DOCS` 是**同一个文件里的**说明表，`docs/04` 的「错误码」一节由
 *     `tools/gen-error-docs.mjs` 从它生成 —— 文档不再手写；
 *   - `plugin/test/t81-error-codes.test.ts` 四条断言守一致：源码字面量 ⊆ 清单、
 *     清单 = 文档、每个码至少被用一次。
 *
 * 加码流程：① 这里加一行（含说明）→ ② `node tools/gen-error-docs.mjs` 重生成 docs/04
 * → ③ `cd plugin && npm test` 全绿。
 *
 * 命名约定：`MT_<域>_<条件>`。域取 `LEDGER` / `TASK` / `ROLE` / `ROSTER` / `KB` /
 * `PRESET` / `PLUGIN` / `CONTRIBUTION` / `TEAM` / `HANDOFF`；跨域通用码不带域
 * （`MT_VALIDATION` / `MT_INTERNAL` / `MT_UNAVAILABLE` …）。
 */

/** 全项目错误码清单。**只在这里增删**；顺序按域分组，便于审阅。 */
export const MT_CODES = [
  // ── 跨域通用 ──────────────────────────────────────────────
  'MT_VALIDATION',
  'MT_INTERNAL',
  'MT_INTERNAL_FOLD',
  'MT_UNAVAILABLE',
  'MT_UNKNOWN_TOOL',
  'MT_EXTERNAL_FAILURE',

  // ── 账本（append-only JSONL）────────────────────────────────
  'MT_LEDGER_BAD_ACTOR',
  'MT_LEDGER_BAD_PAYLOAD',
  'MT_LEDGER_CORRUPT',
  'MT_LEDGER_MISSING_FIELD',
  'MT_LEDGER_MISSING_RULES_VERSION',
  'MT_LEDGER_UNKNOWN_TYPE',

  // ── 任务与状态机 ────────────────────────────────────────────
  'MT_ATTEMPT_STALE',
  'MT_CROSS_REVIEW',
  'MT_DEPENDENCY_FAILED',
  'MT_DRAIN_PENDING',
  'MT_EVIDENCE_REQUIRED',
  'MT_MEMBER_LIMIT',
  'MT_NO_AGENTS_SERVICE',
  'MT_NOT_CLAIMABLE',
  'MT_REJECT_BUDGET',
  'MT_REVISION_CONFLICT',
  'MT_TASK_CYCLE',
  'MT_TASK_STRUCTURAL_EDIT',
  'MT_TASK_TERMINAL',
  'MT_TEAM_STATE',
  'MT_VERIFY_NO_COMMAND',

  // ── 归档 ────────────────────────────────────────────────────
  'MT_ARCHIVE_FAILED',

  // ── 知识库 ──────────────────────────────────────────────────
  'MT_KB_CORRUPT',
  'MT_KB_EVIDENCE_REQUIRED',
  'MT_KB_EXISTS',
  'MT_KB_INVALID',
  'MT_KB_NOT_FOUND',
  'MT_KB_RELATION_MISMATCH',
  'MT_KB_TARGET_MISMATCH',
  'MT_KB_TARGET_REQUIRED',

  // ── 角色库 ──────────────────────────────────────────────────
  'MT_ROLE_BUILTIN',
  'MT_ROLE_CAPTAIN',
  'MT_ROLE_CAPTAIN_RESERVED',
  'MT_ROLE_CONTRIBUTION_CONFLICT',
  'MT_ROLE_CORRUPT',
  'MT_ROLE_EXISTS',
  'MT_ROLE_INVALID',
  'MT_ROLE_NO_GLOBAL_DIR',
  'MT_ROLE_NOT_FOUND',
  'MT_ROLE_OCCUPIED',
  'MT_ROLE_READONLY',

  // ── 名册 ────────────────────────────────────────────────────
  'MT_ROSTER_DUAL_CAPTAIN',
  'MT_ROSTER_EMPTY',
  'MT_ROSTER_NO_CAPTAIN',

  // ── 团队模板 / 预设 ─────────────────────────────────────────
  'MT_PRESET_BUILTIN',
  'MT_PRESET_EXISTS',
  'MT_PRESET_NOT_FOUND',
  'MT_TEAM_TEMPLATE_CAPTAIN',
  'MT_TEAM_TEMPLATE_CONFLICT',
  'MT_TEAM_TEMPLATE_UNRESOLVED',

  // ── 会话移交（handoff）──────────────────────────────────────
  'MT_HANDOFF_FAILED',
  'MT_HANDOFF_NO_SESSION',

  // ── 插件贡献契约 ────────────────────────────────────────────
  'MT_CONTRIBUTION_CODE_IGNORED',
  'MT_CONTRIBUTION_FILE_MISSING',
  'MT_CONTRIBUTION_ID_MISMATCH',
  'MT_CONTRIBUTION_ORIGIN_STAMPED',
  'MT_CONTRIBUTION_PATH_TRAVERSAL',
  'MT_CONTRIBUTION_ROOT_ABSENT',
  'MT_CONTRIBUTION_TOO_LARGE',
  'MT_PLUGIN_CONTRACT_UNSUPPORTED',
  'MT_PLUGIN_ID_DUPLICATE',
  'MT_PLUGIN_ID_INVALID',
  'MT_PLUGIN_ID_MISMATCH',
  'MT_PLUGIN_MANIFEST_INVALID',
]         

                                              

/**
 * 每个码的一句话说明（**文档的唯一来源**）。
 *
 * 写「**什么时候会看到它**」，不写「它表示什么」——后者看名字就知道，
 * 前者是排障时真正需要的。
 */
export const MT_CODE_DOCS                         = {
  // 跨域通用
  MT_VALIDATION: '入参不满足工具契约（缺必填、类型不符、越界、成环、名册外角色等）。最常见的一个码。',
  MT_INTERNAL: '服务端未预期异常已兜底成结构化错误；原始堆栈只在宿主日志里。',
  MT_INTERNAL_FOLD: '账本重放（fold）时抛异常：事件流与投影代码不兼容，或 payload 形状漂移。',
  MT_UNAVAILABLE: '依赖的宿主服务（subprocess / agents / tokenMeter 等）在当前 profile 未注册。**不猜、不静默降级**。',
  MT_UNKNOWN_TOOL: '调用了未注册的 `myteam_*` 工具名（拼写错、或被 `toolPolicy` 收窄掉了）。',
  MT_EXTERNAL_FAILURE: '门禁里跑的外部命令自身失败（非零退出、被信号杀），不是门禁判定为 fail。',

  // 账本
  MT_LEDGER_BAD_ACTOR: '事件 `actor` 不是 `member:<id>` / `lead` / `system` 之一。',
  MT_LEDGER_BAD_PAYLOAD: '事件 payload 不是普通对象（null / 数组 / 原始值）。',
  MT_LEDGER_CORRUPT: '账本行 JSON 合法但不是合法事件，或 seq 断点／回退。**跳过该行、继续解析**，只告警不丢后续事件。',
  MT_LEDGER_MISSING_FIELD: '事件缺 `seq` / `type` / `at` / `actor` / `payload` 之一。',
  MT_LEDGER_MISSING_RULES_VERSION: '新账本的首事件不是 `rules.version.adopted`（I3 前提）。',
  MT_LEDGER_UNKNOWN_TYPE: '事件 `type` 不在 `EVENT_TYPES` 白名单里（旧版本写的账本用新代码打开时会看到）。',

  // 任务与状态机
  MT_ATTEMPT_STALE: '针对的 attempt 已被撤销或已结束（并发重试、或成员被 interrupt 后回写）。',
  MT_CROSS_REVIEW: '`gate:review` 要求 `reviewerMemberId` 必填且 ≠ 实现者；同成员自审被拒（FR-5.1）。',
  MT_DEPENDENCY_FAILED: '批量建任务时，本条依赖的前序条目创建失败，本条目跳过。',
  MT_DRAIN_PENDING: '释放成员前还有未排空的运行中/待处理任务（FR-3.11：排空后才报成功）。',
  MT_EVIDENCE_REQUIRED: '成员申报 done 但没带 `[Verification evidence]` 证据块（FR-5.0）。',
  MT_MEMBER_LIMIT: '成员数超过 `maxMembers` 上限（ADR-008）。',
  MT_NO_AGENTS_SERVICE: '宿主没给 `agents` 服务，无法 spawn 成员。',
  MT_NOT_CLAIMABLE: '任务当前状态不允许 claim（不满足就绪条件：依赖未完成 / 已被占用 / 非 ready）。',
  MT_REJECT_BUDGET: '单门 fail 轮数达到 `GATE_REJECT_BUDGET`(2)，队长侧 pass 被拒，转人工（FR-5.2）。',
  MT_REVISION_CONFLICT: '乐观锁失败：传了 `expectedRevision` 但与当前投影版本不等，**账本零写入**（QA-4）。',
  MT_TASK_CYCLE: '依赖成环（含自指、或 `rewireTo` 指回下游造成的环）。',
  MT_TASK_STRUCTURAL_EDIT: '尝试改任务的**结构字段**（AC / 交付物 / 依赖）但走错了入口——结构改动必须走 `rescope` 管线。',
  MT_TASK_TERMINAL: '任务已在终态（done / cancelled / failed），不允许再变更。',
  MT_TEAM_STATE: '团队状态不允许当前操作（如同名 active 团队已存在、非 draft 时批准计划）。',
  MT_VERIFY_NO_COMMAND: '`gate:verify` 要求任务声明 `verifyCommand`，但没声明（不能用人工裁决冒充真跑命令）。',

  // 归档
  MT_ARCHIVE_FAILED: '解散团队时归档写盘失败；**已落账本但文件没写全**，不静默（CHG-86 P0-2）。',

  // 知识库
  MT_KB_CORRUPT: '知识条目 frontmatter 损坏或文件不可解析。',
  MT_KB_EVIDENCE_REQUIRED: '采纳知识草稿时缺证据指针（FR-17.4 策展门）。',
  MT_KB_EXISTS: '同 id 知识条目已存在且未走 `revise` 演化式修订。',
  MT_KB_INVALID: '知识条目字段不合规（id 格式、tags、audience 等）。',
  MT_KB_NOT_FOUND: '知识条目不存在（可能被归档或 id 写错）。',
  MT_KB_RELATION_MISMATCH: '草稿声明的 `relation`（refine / contradict）与目标条目状态不匹配。',
  MT_KB_TARGET_MISMATCH: '草稿指向的目标条目与 `adopt` 时传入的不一致。',
  MT_KB_TARGET_REQUIRED: '`relation` 为 refine / contradict 时必须给 `target`。',

  // 角色库
  MT_ROLE_BUILTIN: '内置角色的 id 被保留，不能创建同名项目角色。',
  MT_ROLE_CAPTAIN: '队长角色唯一：名册里已有队长时再指定第二个。',
  MT_ROLE_CAPTAIN_RESERVED: '只有内置 `captain` 可以是队长角色（队长是全局唯一的「类」）；想改队长请覆写项目库的 `config/roles/captain.json`，不要新建第二个队长类。',
  MT_ROLE_CONTRIBUTION_CONFLICT: '插件贡献的角色 id 与已有角色（项目/全局/内置）冲突。',
  MT_ROLE_CORRUPT: '角色定义文件不可解析（常见原因：把非角色 JSON 放进了 `config/roles/`）。',
  MT_ROLE_EXISTS: '同 id 角色已存在且未带覆盖语义（两段确认）。',
  MT_ROLE_INVALID: '角色定义字段不合规（id 格式、systemPrompt 为空、interestWords 越界等）。',
  MT_ROLE_NO_GLOBAL_DIR: '全局角色库目录不存在（`$DSH_HOME/myteam/roles/` 还没初始化）。',
  MT_ROLE_NOT_FOUND: '角色 id 在内置/全局/项目三层里都找不到。',
  MT_ROLE_OCCUPIED: '角色正被在册成员占用，不能删改（先释放成员）。',
  MT_ROLE_READONLY: '内置角色只读，不能改不能删——想改即 fork 进项目库（CHG-6）。',

  // 名册
  MT_ROSTER_DUAL_CAPTAIN: '名册里有多个队长。',
  MT_ROSTER_EMPTY: '名册为空（FR-10.2）。',
  MT_ROSTER_NO_CAPTAIN: '名册里没有队长（FR-10.2）。',

  // 团队模板 / 预设
  MT_PRESET_BUILTIN: '内置预设 id 保留，不能覆盖/删除（想改即复制）。',
  MT_PRESET_EXISTS: '同 id 预设已存在且未带 `overwrite: true`。',
  MT_PRESET_NOT_FOUND: '预设 id 不存在（项目库与内置库都没有）。',
  MT_TEAM_TEMPLATE_CAPTAIN: '团队模板里声明了队长，但队长必须隐式派生（不能显式指定）。',
  MT_TEAM_TEMPLATE_CONFLICT: '团队模板 id 与已有模板/预设冲突。',
  MT_TEAM_TEMPLATE_UNRESOLVED: '模板引用的角色在任意一层角色库里都找不到。',

  // 会话移交
  MT_HANDOFF_FAILED: '移交时建会话或注入摘要失败；**仍回 sessionId**（不假装成功，也不吞掉已建会话）。',
  MT_HANDOFF_NO_SESSION: '移交目标会话不存在或不可写。',

  // 插件贡献契约
  MT_CONTRIBUTION_CODE_IGNORED: '贡献物里的代码字段被宿主忽略（只做声明，不执行第三方代码）。',
  MT_CONTRIBUTION_FILE_MISSING: '插件声明的贡献物文件不存在。',
  MT_CONTRIBUTION_ID_MISMATCH: '贡献物文件里的 id 与 manifest 声明不一致。',
  MT_CONTRIBUTION_ORIGIN_STAMPED: '贡献物已被标记来源（origin），不能二次盖章。',
  MT_CONTRIBUTION_PATH_TRAVERSAL: '贡献物路径含 `..` 或绝对路径，越出贡献根目录。',
  MT_CONTRIBUTION_ROOT_ABSENT: '贡献根目录（`$DSH_HOME/myteam/plugins/`）不存在。',
  MT_CONTRIBUTION_TOO_LARGE: '贡献物超过体积上限。',
  MT_PLUGIN_CONTRACT_UNSUPPORTED: '插件声明的贡献契约版本不在支持范围内（v1）。',
  MT_PLUGIN_ID_DUPLICATE: '同一贡献根下两个插件用了同一个 id。',
  MT_PLUGIN_ID_INVALID: '插件 id 格式不合规（必须小写字母/数字/连字符）。',
  MT_PLUGIN_ID_MISMATCH: '插件目录名与 manifest 里的 id 不一致。',
  MT_PLUGIN_MANIFEST_INVALID: '插件 manifest 不是合法 JSON 或字段不合规。',
}

/** 运行时守卫：外部字符串进系统前过一遍，把「拼错的码」挡在边界上。 */
export function isMtCode(value         )                  {
  return typeof value === 'string' && (MT_CODES                     ).includes(value)
}


//# sourceURL=./src/core/errors.ts