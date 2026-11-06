/**
 * D5 接口域：myteam_* 工具定义（T7 收口，v2.5）。
 *
 * 两层注册（ADR-003）：
 *   - Lead 工具（22 个）：preset 层 → 仅队长会话可见；
 *   - 成员工具（9 个）：成员 setup 作用域 → 仅成员会话可见。
 * 工具 execute 全部走 TeamService.commit()（单写者管线）+ 投影读。
 *
 * 参数用宿主 parameter schema spec 风格（T0 实证 dsh-tools/lib L603：属性级
 * `required: true` 会被编译器收集；TF 实证：register 前必须经
 * parameterSchemaSpecToJsonSchema 编译，否则 schema 缺 type: object 被提供方拒绝）。
 */

                                               

const str = (description        , required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const num = (description        ) => ({ type: 'number', description })
/**
 * CHG-86（tsc 真 bug）：`bool` 原先只收 1 个参数，`bool('…', true)` 的第二个实参被**静默丢弃**，
 * 于是所有 `confirm` 型布尔参数在 JSON schema 里都**不是 required**（宿主不强制两段确认）。
 * 现在与 `str`/`arr` 同签名。
 */
const bool = (description        , required = false) => ({ type: 'boolean', description, ...(required ? { required: true } : {}) })
const arr = (items         , description        , required = false) => ({ type: 'array', items, description, ...(required ? { required: true } : {}) })

export const EVIDENCE_PARAM            = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['commands', 'na'], description: '证据类型' },
    commands: {
      type: 'array',
      description: 'kind=commands 时必填',
      items: {
        type: 'object',
        properties: {
          cmd: str('执行的命令', true),
          exitCode: { type: 'number', description: '退出码', required: true },
          assertions: num('断言计数（可省）'),
          durationMs: num('耗时毫秒（可省）'),
          /* CHG-87（FR-5.4）：本次改动/产出的文件（scope 完成审计的输入）。
           * 越界不会阻断交付，但会进 gate 结果与看板徽标——诚实申报对自己有利。 */
          filesTouched: { type: 'array', items: { type: 'string' }, description: '本次改动/产出的文件路径（可省；用于 scope 完成审计，FR-5.4）' },
        },
      },
    },
    na: {
      type: 'object',
      description: 'kind=na 时必填',
      properties: { reason: str('无法执行验证的原因', true) },
    },
  },
  required: ['kind'],
}

const taskId = () => str('任务 id', true)
const teamId = () => str('团队 id', true)
const attemptId = () => str('当前 attemptId（claim 时获得；陈旧被拒）', true)
/**
 * CHG-87（QA-4 乐观锁，docs/04 §1.1/§4）：调用方读到的投影版本。
 * 缺省 = 不校验（向后兼容）；与当前 `revision` 不等 → `MT_REVISION_CONFLICT`（附 currentRevision）。
 * 面板「编辑」应在打开详情时快照 `detail.revision` 并回传，避免覆盖别人刚做的改动。
 */
const expectedRevision = () => num('乐观锁：你读到的任务投影版本（detail.revision）；与当前不符则拒绝并回显 currentRevision')

                          
              
                     
                       
 

/** 宿主 ctx.tools.register 的 output 契约（T0 实证 tools.register 校验器）：
 *  output 缺失 / render 非函数 / presentationMeta 非函数 → TypeError
 *  `tool "X" must declare output { schema, render, presentationMeta? }`；
 *  且 execute 返回值会经 output.schema 校验（createSuccessResult →
 *  validateJsonSchemaValue，违规抛 ToolOutputError）。全部 myteam 工具的
 *  execute 都返回 { status: string, ... } 对象 → 共享这一个声明即精确匹配。 */
                             
                   
                                                                                                            
 

export function toolOutput()             {
  return {
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '结果状态：成功路径（ok/staged/approved/claimed/sent/...）或 error/confirm-required/timeout 等' },
      },
      required: ['status'],
    },
    render(_args, value) {
      // 内容块数组（isContentBlockShape：plain object + string type）；text 块是文档保证的最小形态
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  }
}

/* ── 成员工具（9 个，v2.5 +read_knowledge）────────────────────────────────────── */

export function memberToolDefs()            {
  return [
    {
      name: 'myteam_get_task',
      description: '读取单个任务的完整状态（限界读：只答该任务，NFR-7.6）。返回任务详情 + 我的 attemptId（若我持有）+ 阻塞原因。',
      parameters: { type: 'object', properties: { taskId: taskId() } },
    },
    {
      name: 'myteam_list_tasks',
      description: '列出可领/相关任务（限界读：明示返回行数 ≠ 已读内容）。按角色过滤可领集合（调度规则：deps 全 done + 角色匹配 + 优先级 + FIFO）。',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['claimable', 'mine', 'all'], description: 'claimable=我可领取的（默认）/ mine=我持有的 / all=全部就绪视图' },
          limit: num('最多返回条数（默认 20）'),
        },
      },
    },
    {
      name: 'myteam_claim_task',
      description: '原子领取一个就绪任务（FR-4.2/11.5：角色匹配+deps 全 done+优先级最高+同级 FIFO；一次只领一个）。返回 attemptId——后续所有 update 必须携带它。',
      parameters: { type: 'object', properties: { taskId: taskId() } },
    },
    {
      name: 'myteam_update_task',
      description: '申报任务进度/完成/失败（必须带当前 attemptId）。done 必附证据块 [Verification evidence]：kind=commands（命令+退出码+断言数）或 kind=na（显式 N/A+原因）。缺失被拒（FR-5.0）。done 可选附 knowledgeDraft 提案（团队级理解，队长采纳才入库，FR-17.4）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: taskId(),
          attemptId: attemptId(),
          status: { type: 'string', enum: ['in_progress', 'done', 'failed'], description: '申报状态', required: true },
          progress: str('进度摘要（in_progress 时）'),
          summary: str('完成/失败摘要'),
          reason: str('失败原因（failed 时）'),
          evidence: EVIDENCE_PARAM,
          knowledgeDraft: {
            type: 'object',
            description: '可选：任务产出"团队级理解"时随 done 申报提交的知识提案（队长采纳才入库，FR-17.4）',
            properties: {
              id: str('条目 id（小写字母数字连字符）', true),
              title: str('条目标题', true),
              tags: { type: 'array', items: { type: 'string' }, description: '主题标签' },
              body: str('条目正文（Markdown）', true),
              evidence: str('证据指针（默认=本任务 id）', true),
              core: bool('是否核心小集（默认 false）'),
            },
          },
        },
      },
    },
    {
      name: 'myteam_peer_message',
      description: '成员间私讯（taskId 可选——挂了就进任务 thread 留痕，FR-12.1）。',
      parameters: {
        type: 'object',
        properties: { toMemberId: str('收件成员', true), taskId: taskId(), content: str('消息内容', true) },
      },
    },
    {
      name: 'myteam_wait_for_change',
      description: '等待任务相关变化（只返回失效提示 changed+cause，不推状态正文，NFR-7.7；空闲期零请求）。cause ∈ assign/message/resume/revoke/progress/escalate/gate。',
      parameters: {
        type: 'object',
        properties: { taskId: str('任务 id（可省=等待任何相关变化）'), sinceSeq: { type: 'number', description: '等待起点账本 seq（上次读取的尾）', required: true }, timeoutMs: num('超时毫秒（默认 60000）') },
      },
    },
    {
      name: 'myteam_propose_task_change',
      description: '结构化提案（FR-11.4）：split/add-dep/reassign/cancel。落账本 task.proposal，队长批准才生效；成员直接改结构无入口。',
      parameters: {
        type: 'object',
        properties: {
          taskId: taskId(),
          type: { type: 'string', enum: ['split', 'add-dep', 'reassign', 'cancel'], description: '提案类型', required: true },
          payload: { type: 'object', description: '提案载荷（如 split 的子任务草案）' },
          reason: str('提案理由', true),
        },
      },
    },
    {
      name: 'myteam_escalate_task',
      description: '受阻申报（FR-11.7，立即生效）：attempt 撤销 + 任务入 re-scoping + 队长收提醒。必须附 evidence（已尝试什么+卡在哪）；建议 suggestion ∈ rescope/split/abort。',
      parameters: {
        type: 'object',
        properties: {
          taskId: taskId(),
          reason: str('受阻原因', true),
          evidence: {
            type: 'object',
            description: '已尝试证据',
            properties: { attempted: str('已尝试的手段', true), blockedAt: str('具体卡在哪', true) },
            required: true                    ,
          },
          suggestion: { type: 'string', enum: ['rescope', 'split', 'abort'], description: '建议出口' },
        },
      },
    },
    {
      name: 'myteam_read_knowledge',
      description: '读团队知识库条目全文（FR-17.3 按需读：先看提示词里的索引层，遇到相关主题再读对应条目；绝不凭印象做事）。只读——写知识库走 done 申报的 knowledgeDraft 提案（队长采纳才入库）。',
      parameters: { type: 'object', properties: { id: str('知识条目 id（见索引层）', true) } },
    },
  ]
}

/* ── Lead 工具（22 个）──────────────────────────────────────── */

export function leadToolDefs()            {
  const rosterItem = {
    type: 'object',
    properties: {
      roleId: str('角色 id（项目库）', true),
      instanceName: str('实例名（可省，默认 roleId-N）'),
      skills: arr({ type: 'string' }, '该成员的技能绑定（可省：继承角色）'),
      mcpAllowlist: arr({ type: 'string' }, '该成员可见的 MCP（可省：继承角色）'),
    },
  }
  const taskInputSpec            = {
    type: 'object',
    properties: {
      title: str('任务标题', true),
      description: str('做什么、不做什么', true),
      acceptanceCriteria: arr(str('可检验的完成定义'), '≥1 条；空被拒（FR-11.1）', true),
      deliverableSpec: {
        type: 'object',
        properties: { path: str('产物落点'), producer: str('谁产出'), reviewer: str('谁评审'), archiver: str('谁存档') },
        description: '叶子任务必填 path',
      },
      deps: arr(str('依赖任务 id'), '依赖列表（扁平 DAG）'),
      requiredRole: str('所需角色（名册内）', true),
      taskType: str('任务类型（config taskTypes 键，缺省 default）'),
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: '默认 P2' },
      estimate: { type: 'string', enum: ['S', 'M', 'L'], description: '体量（可选）' },
      gateChain: arr(str('门禁名'), '缺省按 taskType 展开'),
      tags: arr(str('主题标签'), 'v2.7：任务主题标签（知识域关键词）；done 时用于知识库 staleness 触达（FR-17.2）'),
    },
  }
  const presetMemberSpec = {
    type: 'object',
    properties: {
      roleId: str('队员角色 id（项目库；队长隐式，不要放进 members）', true),
      instanceName: str('实例名（可省）'),
      skills: arr({ type: 'string' }, '该队员的技能绑定（可省：继承角色）'),
      mcpAllowlist: arr({ type: 'string' }, '该队员可见的 MCP server（可省：继承角色）'),
    },
  }
  const presetSpec            = {
    type: 'object',
    properties: {
      id: str('模板 id（安全 id：字母数字开头，可含 ._-）', true),
      name: str('模板名', true),
      description: str('一句话说明'),
      members: arr(presetMemberSpec, '队员列表（1~6 名；队长隐式）', true),
      board: {
        type: 'object',
        properties: {
          columns: arr({ type: 'string' }, '看板列（需覆盖 done/failed/blocked/cancelled 或由 columnMapping 覆盖）'),
          columnMapping: { type: 'object', description: '状态 → 列：{ 列名: 状态[] }' },
        },
      },
      pipeline: {
        type: 'object',
        properties: {
          swimlaneBy: str('泳道维度：stage | member | priority'),
          stages: arr({ type: 'string' }, '阶段名'),
          layout: str('布局：serpentine | linear'),
        },
      },
      gates: {
        type: 'object',
        properties: { enabled: bool('门禁开关'), commandTimeoutMs: num('门禁命令超时毫秒') },
      },
      taskTypes: { type: 'object', description: '任务类型 → { gateChain: string[] }' },
    },
    required: ['id', 'name', 'members'],
  }
  return [
    {
      name: 'myteam_submit_plan',
      description: '提交团队草稿：名册+任务 DAG（只落账本，绝不创建成员会话）。校验：名册必含且仅一个队长（FR-10.1）；任务七项硬校验（FR-11.2）。澄清轮以 clarify 参数落账（plan.clarify；≤3 轮硬终止）。',
      parameters: {
        type: 'object',
        properties: {
          teamId: str('团队 id（可省略：host 从团队名派生，与既有团队冲突时自动加 -N 后缀；建议省略）', false),
          teamName: str('团队名', true),
          goal: str('目标一句话', true),
          presetId: str('团队模板 id（项目/内置开箱团队；给定时按模板名册组队，roster 可省）'),
          roster: arr(rosterItem, '名册（presetId 省略时必含且仅含一个队长）', false),
          tasks: arr({ ...taskInputSpec, properties: { ...(taskInputSpec.properties                           ), taskKey: str('任务 id（显式分配）', true) } }, '任务集', true),
          clarify: {
            type: 'object',
            description: '本轮澄清（无则省）',
            properties: {
              questions: arr({ type: 'object', properties: { id: str('问题 id'), type: { type: 'string', enum: ['taste', 'fact'] }, text: str('问题'), assumption: str('fact 型默认假设') } }, '问题列表', true),
            },
          },
        },
      },
    },
    { name: 'myteam_approve_plan', description: '批准草稿（人审 Approve & Run 经面板/命令后由 Lead 落账）：批量召唤成员、seed 任务。', parameters: { type: 'object', properties: { teamId: teamId() } } },
    { name: 'myteam_revise_plan', description: '退回修改（Revise）：改的是同一份草稿，账本 plan.revised 追加（FR-1.2）。', parameters: { type: 'object', properties: { teamId: teamId(), note: str('要改什么', true) } } },
    { name: 'myteam_discard_plan', description: '丢弃草稿（Discard，两段确认：草稿归档且不自动重建，FR-1.2）。', parameters: { type: 'object', properties: { teamId: teamId(), confirm: bool('二段确认必须为 true', true) } } },
    {
      name: 'myteam_create_task',
      description: '创建任务（队长专属，FR-11.4）：host 七项硬校验（含环/孤儿/AC）。CHG-73：可在同一次调用里带上负责队员（assignees）与参与团队（participants），不必再串 assign/participate。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          taskId: str('任务 id（显式分配）', true),
          task: { ...taskInputSpec, required: true },
          assignees: arr({ type: 'string' }, '负责队员 id（本团队名册内；可省）——与 create 一次写入'),
          participants: arr(
            {
              type: 'object',
              properties: {
                teamId: str('参与团队 id（协作方）', true),
                memberIds: arr({ type: 'string' }, '该团队为此任务派出的队员（可省）'),
                role: { type: 'string', enum: ['lead', 'coop'], description: '参与角色（默认 coop）' },
              },
            },
            '参与团队列表（任务 × 团队多对多边；可省）',
          ),
        },
      },
    },
    {
      name: 'myteam_participate_task',
      description: '登记任务的参与团队（CHG-69 / FR-21）：任务与团队是多对多关系——本团队是主责（lead，不可改），可拉其他团队协作（coop）。参与关系会显示在任务卡团队 chip / 任务详情参与团队 / 对方团队的「参与任务」页。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          taskId: taskId(),
          participantTeamId: str('参与团队 id（协作方；不能是本团队）', true),
          role: { type: 'string', enum: ['lead', 'coop'], description: '参与角色：coop=协作（默认）；lead 仅本团队（无需显式登记）' },
          memberIds: arr({ type: 'string' }, '该团队为此任务派出的队员（实例名，可省）'),
        },
        required: ['taskId', 'participantTeamId'],
      },
    },
    {
      name: 'myteam_assign_task',
      description: '指派任务的负责队员（CHG-69 / FR-21）：一个任务可由一个或多个队员负责（主负责 + 协作）。指派不改变 claim 语义（执行者仍按角色 claim），只是把「谁负责」标注在任务上。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          taskId: taskId(),
          memberIds: arr({ type: 'string' }, '负责队员 id 列表（本团队名册内，至少 1 个）', true),
        },
        required: ['taskId', 'memberIds'],
      },
    },
    /* CHG-86（P0-4 工具重名）：本工具原名为 myteam_update_task，与成员作用域的
     * myteam_update_task（申报进度/完成）重名。同名跨层注册时宿主按解析顺序取其一——
     * 若队长侧生效，成员就能绕过 attemptId 校验直接改任务结构（越权）。改为 myteam_edit_task：
     * 队长侧=编辑元数据，成员侧=申报进度，语义边界与作用域边界一致。 */
    { name: 'myteam_edit_task', description: '编辑任务元数据（CHG-70/CHG-73；CHG-86 改名，原 myteam_update_task）：patch 白名单合并（title/description/acceptanceCriteria/deliverableSpec/deps/requiredRole/taskType/gateChain/priority/estimate/tags/writeScopes/verifyCommand），不改状态与 attempt；deps 变更会做环检测；每次编辑的字段级 diff 落账（详情页「改动记录」）。任务在跑时结构字段被拒（MT_TASK_STRUCTURAL_EDIT）——改用 patch+rescope（撤 attempt 后按新定义重跑）。团队改名/改目标用 myteam_update_team。**CHG-87（FR-5.3/5.4）**：`writeScopes`（可写范围，完成时 scope 审计）与 `verifyCommand`（verify 门由 host 执行的命令 `{argv,cwd?,timeoutMs?}`）也在这里声明。', parameters: { type: 'object', properties: { teamId: teamId(), taskId: taskId(), patch: { type: 'object', description: '元数据补丁（白名单字段；空对象被拒）' }, rescope: { type: 'object', properties: { reason: str('重新规划理由（必填）', true) } }, memberIds: arr({ type: 'string' }, 'rescope 时顺带重派给这些队员（可省）'), expectedRevision: expectedRevision() } } },
    /* CHG-86（M2-C / FR-5.1~5.2）：门禁裁决入口。
     * 修复前：只有成员 update_task 的 archive 分支会写 task.gate.result，而默认链
     * ['review','archive'] 下任务 done 后停在 gate:review（不是 gate:archive）——
     * 条件永不成立，没有任何入口能提交 review 裁决 ⇒ 任务永远到不了 done，
     * 下游依赖永不解锁、归档与成本管线全部悬空。 */
    {
      name: 'myteam_review_task',
      description: '提交门禁裁决（CHG-86 / FR-5.1~5.2，M2-C）：任务处于 gate:* 时由队长（或指定审查队员）显式裁决。review / verify 门强制交叉审查（reviewerMemberId 必填且不能是实现者本人，同成员被拒 MT_CROSS_REVIEW）；打回预算 ≤2 轮，超限后放行需人工（面板 confirm=true）——避免打回闭环吞噬预算（TF r9 实测 61%）。archive 门不需要人工裁决：由 host 按 deliverableSpec 约定路径做落位校验，本工具只是触发重校验。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          taskId: taskId(),
          verdict: { type: 'string', enum: ['pass', 'fail'], description: '裁决结论（只认显式结论行；无结论 = needs-human，不回退解析自由文本）', required: true },
          reviewerMemberId: str('审查队员 id（review/verify 门必填，且必须不同于实现者——强制交叉审查 FR-5.1）'),
          reason: str('裁决说明（verdict=fail 时必填；pass 时可选）'),
          confirm: bool('人工放行：打回轮数超预算（>2）时，只有人工可带 confirm=true 放行'),
          expectedRevision: expectedRevision(),
        },
        required: ['taskId', 'verdict'],
      },
    },
    /* CHG-87（FR-16.1 单角色调用 / FR-15.1 角色指派入口②）：`/myteam+<id>` 的工具面。
     * 修复前：客户端有 `MyTeamApplyRolesToolView` **硬编码演示卡**，而工具不存在——
     * 面板展示的是假数据（UI 声称支持单角色调用，实际没有任何落库路径）。 */
    {
      name: 'myteam_apply_roles',
      description: '单角色调用（CHG-87 / FR-16.1，M2-0 T12）：把角色配置临时注入当前会话（提示词 section + C5 收窄 + Skill/MCP 绑定），与成员实例化同管线；**不入团队账本**（不是团队，没有任务 DAG）。`roles` 累加启用（`/myteam+researcher+reviewer`），`remove` 卸载（`/myteam-researcher`）。sessionDefaults 落 .team-workplace/config/roles/session-defaults.json，跨重启恢复。已有会话与普通新对话都可用；不可用于启用 Team（FR-16.1 拍板）。',
      parameters: {
        type: 'object',
        properties: {
          teamId: str('团队 id（可省；仅用于面板作用域解析，单角色调用不写团队账本）'),
          roles: arr({ type: 'string' }, '要启用的角色 id 列表（项目库/内置/全局任一来源；累加语义）'),
          remove: arr({ type: 'string' }, '要卸载的角色 id 列表（与会话内已有角色求差）'),
          confirm: bool('两段确认：首次调用返回影响面（生效角色、技能/MCP 绑定），confirm=true 才落盘'),
        },
      },
    },
    {
      name: 'myteam_rescope_task',
      description: '一键重新规划（CHG-73 / FR-31）：撤当前 attempt（若有）→ 任务回 ready（依赖未完成则回 backlog）→ 可用 patch 改完成定义 → 可重派队员。理由必填（为什么要重规划必须留痕）。终态任务（done/failed/cancelled）不可重规划。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          taskId: taskId(),
          reason: str('重新规划理由（必填）', true),
          patch: { type: 'object', description: '顺带修改的元数据补丁（结构字段在此允许）' },
          memberIds: arr({ type: 'string' }, '重派给这些队员（可省；仍按角色 claim 执行）'),
          expectedRevision: expectedRevision(),
        },
        required: ['taskId', 'reason'],
      },
    },
    {
      name: 'myteam_cancel_task',
      description: '取消任务（CHG-73/75）：终态不可逆，理由必填。撤当前 attempt；downstream=leave（默认）只停本任务、downstream=cancel 级联取消下游、downstream=rewire 把**直接下游**改挂到 rewireTo（不填 = 解除依赖让下游变独立任务，避免「永远等不到上游」的死结）。第一次不带 confirm 返回影响面（下游清单），带 confirm=true 才落账。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          taskId: taskId(),
          reason: str('取消理由（必填）', true),
          downstream: { type: 'string', enum: ['leave', 'cancel', 'rewire'], description: '下游策略：leave=保持原状（默认）/ cancel=级联取消 / rewire=改挂新上游' },
          rewireTo: str('downstream=rewire 时的新上游任务 id（缺省 = 解除依赖，让下游变独立任务）'),
          confirm: bool('二段确认：先不带 confirm 看 impact，再带 confirm=true 落账'),
          expectedRevision: expectedRevision(),
        },
        required: ['taskId', 'reason'],
      },
    },
    {
      name: 'myteam_batch_task_op',
      description: '批量编排（CHG-73/76）：对多个任务执行同一操作（cancel/rescope/assign/priority），逐条独立落账（同一 batchId），个别失败不影响其余。批量 cancel 需两段确认；下游策略支持 leave/cancel/rewire（rewire 把每个被取消任务的直接下游统一改挂到 rewireTo，不填 = 解除依赖）。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          op: { type: 'string', enum: ['cancel', 'rescope', 'assign', 'priority'], description: '批量操作类型', required: true },
          taskIds: arr(str('任务 id'), '任务 id 列表（1~50）', true),
          reason: str('cancel/rescope 必填的理由'),
          memberIds: arr({ type: 'string' }, 'op=assign 时必填：负责队员'),
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'op=priority 时必填' },
          downstream: { type: 'string', enum: ['leave', 'cancel', 'rewire'], description: 'op=cancel 时的下游策略：leave 保持原状 / cancel 一并取消 / rewire 改挂到新的上游' },
          rewireTo: str('downstream=rewire 时的新上游任务 id（缺省 = 解除依赖；不能是本批要取消的任务）'),
          confirm: bool('op=cancel 时必须为 true（两段确认）'),
        },
        required: ['op', 'taskIds'],
      },
    },
    {
      name: 'myteam_create_tasks',
      description: '批量建任务（CHG-76 / FR-33）：把一次想出的一批任务当草稿——先不带 confirm 看影响面（条数 / 角色分布 / 名册缺角色 / 依赖边 / 补齐项），带 confirm=true 后逐条独立落账（同一 batchId，部分失败不中断）。`after` 填本批 1-based 序号表示"依赖本批第 N 条"（服务端按依赖顺序创建，成环拒绝）；验收标准/叶子任务交付物缺省会补齐并在 warnings 说明。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          goal: str('这批任务服务于什么目标（写进确认文案，可省）'),
          tasks: arr({
            type: 'object',
            properties: {
              title: str('标题', true),
              requiredRole: str('角色 id', true),
              description: str('描述'),
              priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: '优先级（缺省 P2）' },
              estimate: num('预估人日'),
              taskType: str('任务类型（决定门禁链）'),
              acceptanceCriteria: arr(str('验收标准'), '验收标准（缺省用「完成「标题」」占位）'),
              deliverableSpec: { type: 'object', description: '交付物规格 {path,...}（叶子任务缺省 docs/<taskId>.md）' },
              deps: arr(str('任务 id'), '依赖的既有任务 id'),
              after: arr({ type: 'number' }, '依赖本批的第几条（1-based 序号）'),
              assignees: arr(str('成员 id'), '创建后补写的负责队员'),
            },
            required: ['title', 'requiredRole'],
          }, '任务草稿列表（1~30 条）', true),
          confirm: bool('二段确认：先不带 confirm 看影响面，再带 confirm=true 落账'),
        },
        required: ['tasks'],
      },
    },
    {
      name: 'myteam_delete_role',
      description: '删除项目角色（CHG-73 / FR-27）：只删项目库（内置/全局只读），captain 不可删；被模板引用或团队在册时拒绝并列占用方。两段确认（第一次返回 usage），删除留 .audit.jsonl 审计行。',
      parameters: {
        type: 'object',
        properties: {
          roleId: str('角色 id（项目库）', true),
          confirm: bool('二段确认必须为 true', true),
        },
        required: ['roleId'],
      },
    },
    { name: 'myteam_update_team', description: '编辑团队名/目标（CHG-70）：至少给一个字段；名字与目标写回账本 team.updated，面板与索引同步刷新。解散/成员管理走各自工具。', parameters: { type: 'object', properties: { teamId: teamId(), name: str('团队名'), goal: str('目标一句话') } } },
    { name: 'myteam_reassign_task', description: '重派任务：先撤销旧 attempt（等旧 worker 静默）再指派（FR-4.3）。', parameters: { type: 'object', properties: { teamId: teamId(), taskId: taskId(), toMemberId: str('目标成员', true), reason: str('重派原因', true), expectedRevision: expectedRevision() } } },
    { name: 'myteam_revoke_attempt', description: '撤销当前 attempt（重派/回收前置）。', parameters: { type: 'object', properties: { teamId: teamId(), taskId: taskId(), reason: str('撤销原因', true) } } },
    { name: 'myteam_spawn_member', description: '实例化成员（角色从项目库复制语义；maxMembers 拒绝式；并发自管 ADR-008）。可按成员覆写技能/MCP。', parameters: { type: 'object', properties: { teamId: teamId(), roleId: str('角色 id（项目库）', true), instanceName: str('实例名'), skills: arr({ type: 'string' }, '该成员的技能绑定（省略则继承角色）'), mcpAllowlist: arr({ type: 'string' }, '该成员可见的 MCP（省略则继承角色）') } } },
    { name: 'myteam_release_member', description: '释放成员（三态 suspend/archive/remove）：排空后才报成功（FR-3.11）；remove 两段确认。', parameters: { type: 'object', properties: { teamId: teamId(), memberId: str('成员 id', true), mode: { type: 'string', enum: ['suspend', 'archive', 'remove'], description: '释放形态', required: true }, confirm: bool('remove 时必须 true（两段确认）') } } },
    { name: 'myteam_message', description: '发消息给成员（assign/steer）或人工 Inbox（to=inbox）。', parameters: { type: 'object', properties: { teamId: teamId(), to: str('成员 id 或 "inbox"', true), taskId: taskId(), content: str('内容', true), kind: { type: 'string', enum: ['assign', 'steer', 'notify'], description: '消息性质' } } } },
    { name: 'myteam_interrupt', description: '打断成员当前轮（interrupt 只停当前轮不销毁会话）。', parameters: { type: 'object', properties: { teamId: teamId(), memberId: str('成员 id', true), reason: str('打断原因', true) } } },
    { name: 'myteam_disband', description: '解散团队（两段确认+影响面）：全量排空→归档（名册+任务+tokens 快照，FR-14.1 影响面提示的数据源）。', parameters: { type: 'object', properties: { teamId: teamId(), confirm: bool('二段确认必须为 true', true) } } },
    { name: 'myteam_resolve_proposal', description: '处置成员结构提案（FR-11.4）：approved/rejected。**批准即执行对应变更**（CHG-88）：split → 落子任务 + 原任务取消；add-dep → 加依赖；reassign → 改派；cancel → 取消。驳回只留痕、结构不动。载荷不合规会拒绝并说明，不会留下「已批准但什么都没做」的半截状态。', parameters: { type: 'object', properties: { teamId: teamId(), proposalId: str('提案 id', true), decision: { type: 'string', enum: ['approved', 'rejected'], description: '处置决定', required: true }, note: str('处置说明') } } },
    { name: 'myteam_adopt_knowledge', description: '采纳/驳回知识提案（FR-17.4 策展门）：adopted 落 config/knowledge/（带 evidence+contributor 归因）；rejected 只留痕。draftId 来自 knowledge.proposed 事件。', parameters: { type: 'object', properties: { teamId: teamId(), draftId: str('知识提案 id（knowledge.proposed 事件的 draftId）', true), decision: { type: 'string', enum: ['adopted', 'rejected'], description: '策展决定', required: true }, note: str('处置说明') } } },
    {
      name: 'myteam_create_role',
      description: '创建项目角色（队长专属，CHG-53）：写 .team-workplace/config/roles/<roleId>.json。角色是配置单元（职责/提示词/工具策略/技能/MCP）；内置与全局角色只读，新建角色可在组队时引用。',
      parameters: {
        type: 'object',
        properties: {
          roleId: str('角色 id（小写字母/数字/连字符，2~64 位）', true),
          name: str('角色名（展示用）', true),
          description: str('一句话职责描述', true),
          systemPrompt: str('系统提示词：职责、边界、工作纪律、输出要求', true),
          skills: arr({ type: 'string' }, '绑定的技能名列表'),
          mcpAllowlist: arr({ type: 'string' }, '可见的 MCP 名列表'),
          interestWords: arr({ type: 'string' }, '兴趣词（≤8 个，描述角色天然关注什么：如 模块边界/结算/灰度；派单软信号，不是权限）'),
          toolPolicy: { type: 'object', description: '工具策略（C5 只收窄）：{ allow?: string[], deny?: string[] }' },
          model: { type: 'object', description: '模型路由覆写：{ provider, model }' },
          isCaptain: bool('是否队长角色（默认 false；一个团队只能有一个队长）'),
        },
        required: ['roleId', 'name', 'description', 'systemPrompt'],
      },
    },
    {
      name: 'myteam_update_role',
      description: '修改项目角色（队长专属，CHG-53）：patch 合并后写回；项目库缺失但内置/全局存在时先复制进项目（fork，origin 保留）。运行中的成员使用身份快照，修改不影响他们。',
      parameters: {
        type: 'object',
        properties: {
          roleId: str('角色 id', true),
          patch: { type: 'object', description: '要修改的字段：name/description/systemPrompt/skills/mcpAllowlist/interestWords/toolPolicy/model/isCaptain', required: true },
        },
        required: ['roleId', 'patch'],
      },
    },
    {
      name: 'myteam_set_project_role',
      description: '指定「项目自身角色」（CHG-69 / FR-19）：项目本身也有一个角色（项目助理/协调者），不属于任何团队、可被本项目各团队聘任。roleId 取自内置/全局/项目角色库（必须已存在）；confirm=false 时返回当前项目角色供确认。传 clear=true 取消。',
      parameters: {
        type: 'object',
        properties: {
          roleId: str('角色 id（内置/全局/项目库中已存在）'),
          clear: bool('取消项目自身角色（删除 project-role.json）'),
          confirm: bool('写入是两段确认操作：先不带 confirm 预览，再带 confirm=true 落盘'),
        },
      },
    },
    {
      name: 'myteam_list_presets',
      description: '列出团队模板（内置 + 项目，CHG-57）：id/名称/来源/队员（含技能与 MCP）/看板列/任务类型。组队前先看这里，不要凭记忆编 template id。',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'myteam_save_preset',
      description: '创建或更新项目团队模板（CHG-57）：写 .team-workplace/config/presets/<id>.json。内置模板只读（请用 myteam_copy_preset 复制成新 id）；已存在的项目模板需 overwrite=true 才覆盖（两段确认）。',
      parameters: {
        type: 'object',
        properties: {
          preset: { ...presetSpec, required: true },
          overwrite: bool('覆盖已有项目模板时必须为 true（两段确认）'),
        },
      },
    },
    {
      name: 'myteam_copy_preset',
      description: '复制/fork 团队模板（CHG-57）：内置或项目模板 → 新项目模板。目标 id 已存在时拒绝；不修改来源模板。',
      parameters: {
        type: 'object',
        properties: {
          fromPresetId: str('来源模板 id（内置或项目）', true),
          toPresetId: str('新模板 id（不能是内置 id）', true),
          name: str('新模板名（可省：沿用来源名 + 副本）'),
        },
      },
    },
    {
      name: 'myteam_delete_preset',
      description: '删除项目团队模板（CHG-57，两段确认）：内置模板不可删（MT_PRESET_BUILTIN）；confirm 必须为 true。已被运行中团队使用不受影响（模板只在建团时快照）。',
      parameters: {
        type: 'object',
        properties: {
          presetId: str('模板 id', true),
          confirm: bool('二段确认必须为 true', true),
        },
      },
    },
    {
      name: 'myteam_reset_team_config',
      description: '恢复团队的默认配置（CHG-57）：删除团队级 team.config.json，重新按「项目层 < 插件默认」生效。两段确认；只重建配置缓存，不动账本/成员。',
      parameters: {
        type: 'object',
        properties: {
          teamId: teamId(),
          confirm: bool('二段确认必须为 true', true),
        },
      },
    },
  ]
}

/** 工具名 → 归属（注册层判定 + 零依赖审计用） */
export function toolRegistryPlan()                                       {
  return {
    lead: leadToolDefs().map((t) => t.name),
    member: memberToolDefs().map((t) => t.name),
  }
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/tools/defs.ts