/**
 * T32（CHG-53）：队长内置技能 —— create-role / modify-role / create-team / write-team-charter。
 *
 * 角色只能由标准队长（myteam-captain 预设）创建与修改（用户定案）；技能挂进队长 scope
 * （host.initialize → ctx.skills.register），模型按需加载全文后调用对应 Lead 工具落库。
 *
 * ── CHG-102 修订（用户定案 2026-11-07）───────────────────────────
 * 「你创建角色、创建团队的这个技能做得不对」——旧版三个问题：
 *   ① 路径写的是 `.team-workplace/`（旧落盘根），而宿主实际把它解析到了 DSH profile，
 *      于是**项目级角色写进了用户全局目录**；
 *   ② `create-team` 名不副实：名字叫「创建团队」，正文却在写**章程**（不建名册、不派任务）
 *      —— 用户说「创建一个项目级别的团队」时拿到的是写文档的指导；
 *   ③ 没写「项目级存储」这条主心骨（哪些落 `config/`、哪些落 `tasks/`、哪些不入库）。
 *
 * 现在：`create-team` = 建团队（名册 + 任务 DAG，落 `.dsh-myteam/`）；
 * 写章程拆成独立技能 `write-team-charter`。所有路径以
 * `core/workspace/layout.ts` 的目录契约为准。
 *
 * 纪律：
 *  - 技能正文只写"怎么做 + 边界"，不复制角色 schema 的实现细节（schema 以工具定义为准）；
 *  - 内置/全局角色只读：修改走"复制进项目再改"（update_role 的 copy-on-write）；
 *  - 运行中成员是身份快照（C3），改角色不影响已召唤成员。
 */

export interface CaptainSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
}

const CREATE_ROLE_CONTENT = `# 创建角色（create-role）

你是团队队长。用户要求"新建一个角色/岗位/成员类型"时，用 \`myteam_create_role\` 写进**本项目**的角色库
（\`<项目>/.dsh-myteam/config/roles/<roleId>.json\`）。

## 作用域：默认项目级，全局必须明示（CHG-103，硬规则）

**不传 \`scope\` = 写项目库**（\`.dsh-myteam/config/roles/\`，只对本项目可见）——这是绝大多数情况。

只有在**用户明确说「全局」/「所有项目共用」/「放到全局角色库」**时，才允许 \`scope: "global"\`：

1. 先调 \`myteam_create_role({..., scope: "global"})\`（**不带** \`confirmGlobal\`）→ 返回 \`confirm-required\`；
2. 把这个回执原样讲给用户（会写进跨项目全局库、影响所有项目），**等用户明确确认**；
3. 用户确认后再调一次，带 \`confirmGlobal: true\` 落盘。

**禁止猜测**：指令含糊（「建个架构师」）时一律建项目级，不要自作主张写全局；
用户说「全局」但没确认影响面时，也不要直接带 \`confirmGlobal: true\`。

## 先问清三件事（合并成一轮，不要反复追问）

1. 这个角色负责什么、不负责什么（职责边界）。
2. 它需要哪些技能（skills）与可见的 MCP（mcpAllowlist）——没有就说"继承/不绑定"。
3. 它与现有角色的差别；若只是"另一个开发者"，优先改现有角色而不是新建。

## 角色是配置单元，不是成员

- 角色 = 职责 + 系统提示词 + 工具策略 + 技能 + MCP + 模型路由；
- 成员 = 角色的一次实例化（独立会话、独立快照、独立 token 账）；
- 队长是**全局唯一的「类」**（内置 \`captain\`），每个团队各有一个**实例**（独立会话 + 独立快照）；
  **只有 id === \`captain\` 能带 \`isCaptain: true\`** —— 第二个队长类会被 \`MT_ROLE_CAPTAIN_RESERVED\` 硬拒（CHG-101）。
  想改队长的提示词或工具集？覆写项目库的 \`config/roles/captain.json\` —— 换的是**同一份设定的实现**，
  不是新增第二个队长类。\`isCaptain\` 保持 \`false\` 即可（默认值，不用显式写）。

## 落盘位置（项目级，不是全局）

| 内容 | 路径 | 入库 |
|---|---|---|
| 角色 | \`.dsh-myteam/config/roles/<roleId>.json\` | ✅ 随仓库共享 |
| 项目自身角色 | \`.dsh-myteam/config/project-role.json\` | ✅ |
| 团队（名册） | \`.dsh-myteam/config/teams/<teamId>.json\` | ✅ |
| 技能 | \`.dsh-myteam/config/skills/<skillId>.json\` | ✅ |
| 工具策略 | \`.dsh-myteam/config/tools/<toolId>.json\` | ✅ |
| 任务与依赖 | \`.dsh-myteam/tasks/<teamId>/ledger.jsonl\` | ✅ |
| 运行时状态 | \`.dsh-myteam/state/\`、\`history/\`、\`export/\` | ❌ 不入库 |

**默认就是项目级**：不要写"全局角色库"、不要用绝对路径、不要写进 \`.dsh/\` 或用户家目录。

## 字段怎么写

- \`roleId\`：小写字母/数字/连字符，2~64 位，例如 \`data-auditor\`。
- \`name\` / \`description\`：给人看的中文名与一句话职责。
- \`systemPrompt\`：写给该成员 agent 的完整提示词。至少包含：
  - 它的职责与**不做什么**（避免越权）；
  - 工作纪律：先读任务、按 AC 交付、done 必须带证据块、受阻先 escalate；
  - 输出要求：交付物路径、验收自检。
- \`skills\`：技能名数组；只写本环境真实存在的技能名。
- \`mcpAllowlist\`：MCP 名数组；只写宿主已连接且该角色确实需要的服务。
- \`toolPolicy\`（可选）：C5 只能收窄——\`allow\` 白名单或 \`deny\` 黑名单；团队协调工具（myteam_*）永远不能被 deny。
- \`model\`（可选）：需要时再覆写 \`{ provider, model }\`。

## 示例

\`\`\`
myteam_create_role({
  roleId: "data-auditor",
  name: "数据审计员",
  description: "核对数据口径与报表一致性，输出差异清单；不做取数开发。",
  systemPrompt: "你是数据审计员。职责：核对口径、抽样对账、输出差异与证据。你不写生产代码、不改数据源。工作纪律：先读任务与 AC；结论必须带命令/文件证据；受阻先 escalate。",
  skills: ["data-analysis"],
  mcpAllowlist: []
})
\`\`\`

## 记忆与汇报机制（M2-F / FR-6.1~6.2、FR-5.0）

角色的提示词必须**明确写下**这两件事——不写，成员会各自发挥，团队留痕就散了。

### 记忆区（\`memory.md\` + \`notes/\`，FR-6.1）

- 每个成员有独立记忆区：\`.dsh-myteam/history/members/<teamId>/<memberId>/\` 下的
  \`memory.md\`（长期结论）与 \`notes/\`（过程记录，自建）。
- **证据强制**（默认开）：记忆条目的 \`[Verification evidence]\` 必须指向真实存在的
  任务 id / 文件路径 / 会话指针（\`task:\` / \`file:\` / \`session:\` 三类前缀）。
  无证据的记忆会被 \`memory.audit\` 记账——这是给"模型自信地记错"上的硬约束。
- 提示词里要写清：**什么值得记**（跨任务仍成立的结论）、**什么不要记**（一次性过程、
  可从代码直接读出的东西）。不写这一句，记忆区会退化成第二份日志。

### 汇报机制（FR-5.0）

- **done 申报必须带证据块**：\`myteam_submit_done\` 的 \`evidence.commands[]\`
  每条至少 \`{ cmd, exitCode }\`，改了文件就带 \`filesTouched\`。
  **禁止**「没有出现拒绝词就认为通过」——审查先看证据块再读正文。
- **escalate 时机**：不是"遇到阻力就报"，是"**信息不足且无法用默认值兜底**"
  （如 AC 自相矛盾、依赖任务交付物缺失）。每次 escalate 必须带 evidence；
  每任务累计 >2 次，队长会建议改走 rescope。
- **提案（proposal）**：发现任务切分不合理时提 split/rescope，**不要自行扩大范围**。
- 提示词里要写清：这个角色**向谁汇报什么**（队长要的是"结论 + 证据"，
  不是"我做了这些步骤"）。

## 落库之后

- 新角色只存在项目库；\`getRoles\` 会显示 origin=project。
- 组队时把该 roleId 放进名册（\`myteam_submit_plan\` 的 roster）或 \`myteam_spawn_member\`。
- 同名角色已存在会被拒绝（MT_ROLE_EXISTS）——要改就转 modify-role，不要覆盖。
`;

const MODIFY_ROLE_CONTENT = `# 修改角色（modify-role）

用户要求调整某个角色的职责、提示词、技能或 MCP 时，用 \`myteam_update_role\`。

## 先确认改的是哪一层

- 项目角色（origin=project）：直接改项目库（\`.dsh-myteam/config/roles/\`）。
- 内置角色（origin=builtin）/ 全局角色（origin=global）：只读。\`myteam_update_role\` 会**先复制一份进项目库**（fork，保留 \`origin: builtin:<id>\`）再应用修改；这意味着：
  - 只影响本项目，全局/内置原文件不变；
  - 同名副本之后以项目库为准（运行时只认项目库）。
- 如果用户其实想改全局，告诉他们当前能力是"复制进项目改"，全局同步需要后续版本。

## 修改前必须说明影响面

- 运行中的成员使用**身份快照**，改角色**不影响**已在跑的成员；
- 影响的是之后 spawn 的成员与组队引用；
- 改动会写回项目角色库（\`version + 1\`），不做历史版本回滚。

## 正确用法

1. 先 \`myteam_get_roles\`（或面板角色页）确认 roleId 与来源。
2. 只提交要改的字段（patch），不要整份重写；systemPrompt 改动要给用户看要点。
3. 调用后把 \`copiedFrom\` / \`version\` 回报给用户。

\`\`\`
myteam_update_role({
  roleId: "developer",
  patch: {
    skills: ["ui-design", "office-docx"],
    mcpAllowlist: ["filesystem"]
  }
})
\`\`\`

## 边界

- 不要用修改角色来"绕开"工具策略扩权（C5 只收窄）；
- 不要删除角色（删除守门 C7 由角色库管理，当前不在本技能范围）；
- 不要改 \`roleId\`（id 不可变）；要换 id 请新建角色。
`;

const CHOOSE_TEMPLATE_CONTENT = `# 选择团队模板（choose-team-template）

用户要建团队时，**先看有哪些模板，再决定名册**，不要凭记忆编 \`presetId\`。

## 流程

1. 调 \`myteam_list_presets\`（只读）拿内置 + 项目模板列表：id / 名称 / 来源 / 队员（含每人的技能与 MCP）/ 看板列 / 任务类型。
2. 按目标挑一个最贴近的：
   - 标准交付 → 内置 \`starter-team\`（标准队长 + 需求验证员 + 开发者 + 验收员，3 名队员）；
   - 项目已有专用模板 → 用该 \`presetId\`；
   - 都不合适 → 用名册手工组队，或先 \`myteam_copy_preset\` 复制一个再调整。
3. 用 \`myteam_submit_plan({ presetId, teamName, goal, tasks })\` 提交草稿；此时 roster 可省略。

## 边界

- 模板只在**建团时**快照：看板列/泳道/门禁/任务类型会落到团队级配置，之后改模板不影响已建团队；
- 内置模板只读；要改先复制成新 id（\`myteam_copy_preset\`），再 \`myteam_save_preset({ overwrite: true })\`；
- 模板里引用的角色会在提交时复制进项目库（运行时只认项目层）；
- 未知 \`presetId\` 会被拒绝（MT_VALIDATION）——先 list 再选。
`;

const MANAGE_TEMPLATE_CONTENT = `# 管理团队模板（manage-team-template）

模板 = 标准队长（隐式）+ 队员（各自技能/MCP）+ 看板列 + 泳道 + 门禁 + 任务类型。
写路径全部在项目层：\`.dsh-myteam/config/teams/<id>.json\`。

## 四个工具

- \`myteam_save_preset({ preset, overwrite? })\`：建/改项目模板。已存在时必须 \`overwrite: true\`（两段确认，version + 1）；内置 id 拒写（MT_PRESET_BUILTIN）。
- \`myteam_copy_preset({ fromPresetId, toPresetId, name? })\`：内置/项目 → 新项目模板（fork）。目标已存在或为内置 id 会被拒。
- \`myteam_delete_preset({ presetId, confirm: true })\`：仅项目模板；内置拒删；confirm 两段确认。
- \`myteam_reset_team_config({ teamId, confirm: true })\`：删除团队级 \`tasks/<teamId>/team.config.json\`，退回「项目层 < 插件默认」。只重置配置，不动账本/成员。

## 判断该用哪个

- 用户说"以后都用这种队形" → save/copy 模板；
- 用户说"这个团队改回默认看板" → reset_team_config；
- 用户想改模板但怕影响别人 → copy 一份新的再改；
- 删除前必须确认没有别的流程依赖它（已建团队不受影响，但模板本身会被删）。

## 边界

- 不写内置模板（随插件分发，只读）；
- 不在模板里放 \`captain\`（队长隐式；members 里出现会被忽略）；
- 模板名册 1~6 名队员（maxMembers 硬上限 6，队长的位置不算）；
- 成员技能/MCP 已做**运行时硬隔离**（CHG-58）：allowlist 之外的 MCP 工具不可见/不可调用（restrict + 执行期 guard），allowlist 之外的技能被同名占位屏蔽（模型不可见、正文不可读）；
- 隔离只在 allowlist **非空**时启用：空 = 不限制（继承宿主能力）；要"只给这几项"，务必显式列出；
- 隔离在成员上岗（spawn/approve）时生效；改角色/模板后需要重新上岗的成员才会重新收窄。
`;

const CREATE_TEAM_CONTENT = `# 创建项目级团队（create-team）

用户说"建一个团队 / 创建一个项目级别的团队 / 把这几个人组成一个团队"时用本技能。

**产出 = 一个可运行的团队**（名册 + 任务 DAG + 落盘配置），不是一份文档。
想写"团队章程/文件治理约定" → 用 \`write-team-charter\` 技能，别在本技能里写。

## 团队是什么

- **Team** = 一次协作的容器（唯一 teamId），状态 \`draft → active → archived → discarded\`；
- **名册** = 标准队长（隐式，\`myteam-captain\` 预设）+ N 名队员（每名队员引用一个角色）；
  名册里**不能有 captain**（队长隐式，写了会被忽略）；
- **任务 DAG** = 任务 + 依赖 + 每任务的验收标准（AC ≥1 且可检验）；
- **落盘**：团队配置进 \`.dsh-myteam/config/teams/<teamId>.json\`，任务与依赖进
  \`.dsh-myteam/tasks/<teamId>/ledger.jsonl\`（append-only，唯一权威）。

## 流程（四步，不要跳）

### 第 1 步：先看模板

\`myteam_list_presets\` 拿内置 + 项目模板。有贴的就用 \`presetId\` 起步；
没有就手工列名册（每个 roleId 必须**已在项目角色库**，见 \`myteam_get_roles\`）。

### 第 2 步：定名册

- 每名队员写清：\`roleId\`、\`instanceName\`（同角色多人时区分）、可选的 \`skills\` / \`mcpAllowlist\`；
- 名册 1~6 名队员（队长不算）；
- 角色不够用？先走 \`create-role\` 技能建角色，**不要**临时编一个不存在的 roleId。

### 第 3 步：拆任务

- 每个任务：\`title\` + \`requiredRole\`（必须在名册内）+ \`acceptanceCriteria\`（≥1 条，可判真假）
  + 叶子任务的 \`deliverableSpec\`（\`path/producer/reviewer/archiver\`）；
- 依赖用 \`deps\`（任务 id 数组）：**只写直接上游**，不要写传递依赖（DAG 会自己算）；
- 并行度：能并行的别串起来；一条链上的任务数量控制在 5 个以内。

### 第 4 步：提交草稿并等人工批准

\`\`\`
myteam_submit_plan({
  teamName: "结算页重做",
  goal: "把结算页从 v1 重做到 v2，性能与可访问性达标",
  presetId: "starter-team",      // 有模板就填，没有就改用 roster
  tasks: [
    { id: "t1", title: "接口契约", requiredRole: "req-validator", acceptanceCriteria: ["列出 12 个字段的类型与来源"], deps: [] },
    { id: "t2", title: "页面实现", requiredRole: "developer", acceptanceCriteria: ["三态齐全", "构建通过"], deps: ["t1"], deliverableSpec: { path: "src/pages/checkout", producer: "developer", reviewer: "acceptor", archiver: "acceptor" } }
  ]
})
\`\`\`

**草稿阶段不产生任何成员会话**：等用户在面板上 Approve & Run 才实例化。

## 边界

- 不写章程（\`write-team-charter\`）；不建角色（\`create-role\`）；不保存模板（\`manage-team-template\`）；
- 不把团队落盘到全局目录：一律在 \`<项目>/.dsh-myteam/\` 下；
- 名册里出现 \`captain\`、任务 \`requiredRole\` 不在名册、AC 为空、依赖成环——都会被硬拒，别试；
- 团队解散（disband）会归档到 \`.dsh-myteam/history/archive/<teamId>/\`，不可逆，需要两段确认。
`;

const WRITE_CHARTER_CONTENT = `# 编写团队章程（write-team-charter）

用户要"定团队边界 / 写团队章程 / 约定文件治理 / 规定谁归档"时用本技能，产出**一份项目层章程文件**：
团队能力与边界 + 约束与文件治理章程，写入 \`.dsh-myteam/structure.md\`。

这是**写章程**的技能：只产出并落盘这一个文件，**不建名册、不派任务**（要建团队用 \`create-team\`）。

定位：章程是**项目层**的一份约定（每个项目一份，不是每个团队一份），是队长做规划与派单时的
能力补充说明——规划前先读它，产出物落位以它为准。

## 先问清两件事（合并成一轮，不要反复追问）

1. **能力与边界**：这个团队负责什么领域、明确不做什么、做到什么程度算完、什么情况必须升级到人。
2. **约束与文件治理**：文件放哪里、做到什么程度、谁沟通、谁存档。

用户已经说清的就别再问；缺的部分用默认值兜底，并在章程里标注「假设」。

## 章程正文怎么写

文件路径固定为 \`.dsh-myteam/structure.md\`（项目级，随仓库共享；宿主已预置标题骨架，你**覆盖正文**，不要另建文件）。

正文分两段，段标题固定，便于后续检索与引用：

### 一、团队能力与边界

- **领域边界**：本团队负责哪一段；范围外的相邻领域怎么处理（转交 / 拒绝 / 上报）。
- **明确不做**：列 3~5 条本团队不承担的事，以及超出边界时怎么回。
- **质量与验收基线**：一条交付满足什么才算完成（要可检验的判据，不写"高质量"这类空话）。
- **升级到人的条件**：哪几类情况必须交回人裁决（不可逆操作、对外发布、需求歧义、连续受阻）。

### 二、约束与文件治理章程

- **文件放哪里**：\`.dsh-myteam/config/\`（角色 / 团队 / 技能 / 工具 / 流程 / 知识，**入库共享**）、
  \`.dsh-myteam/tasks/<teamId>/\`（任务与依赖账本，**入库**）、
  \`.dsh-myteam/state/\`、\`.dsh-myteam/history/\`（运行时与历史，**不入库**）、\`docs/\`（人读交付物）。
- **做到什么程度**：什么算"写到一半"（草稿），什么算"可交付"（完整且可复核）。
- **谁沟通**：队长对外，队员对队长；跨团队协作走既有团队协作路径，不私拉群。
- **谁存档**：产物落位由任务的 \`deliverableSpec\` 指派（\`path/producer/reviewer/archiver\`）；章程本身由队长维护。

## 落盘

1. 先读 \`.dsh-myteam/structure.md\`（宿主预置的标题骨架），再写，避免覆盖已有内容。
2. 用工作区文件工具（\`write\` / \`edit\`）把上面两段正文写进该文件。
3. 写完读回一遍确认落盘，再把章程要点（能力边界 + 文件治理）向用户复述一遍。
4. 当前会话没有文件写入工具时：把章程全文贴给用户，并明确说明"未落盘"——不要口头声称已写入。

## 与其他能力的关系

- 名册与任务不归本技能：要组队用 \`create-team\` 技能（\`myteam_submit_plan\`）。
- 角色不归本技能：要新建或改角色用 create-role / modify-role 技能。
- 团队模板不归本技能：要保存队形为模板用 manage-team-template 技能。

## 边界

- 不越权：本技能**只写章程文件**，不改角色库、不动预设、不提交任务草稿。
- 不越权：章程是**约定**不是硬门禁——它约束队长与队员的行为，宿主不会据此拦截任何工具调用。
- 不越权：不把章程塞进成员提示词、不改队友身份快照——要让某条边界对某个角色生效，走角色提示词。
- 不越权：不改 \`.dsh-myteam/config/team.config.json\`（看板列/门禁等行为配置由预设与团队级配置决定；章程只声明"怎么管文件"，不改配置结构）。
- 章程是**每个项目一份**（项目层），不是每个团队一份；团队间的差异用各自任务的 \`deliverableSpec\` 表达。
`;

export const CAPTAIN_SKILLS: CaptainSkill[] = [
  {
    name: 'create-role',
    description: '由队长创建项目角色：写职责/系统提示词/工具策略/技能/MCP，落项目角色库 .dsh-myteam/config/roles/。',
    whenToUse: '用户要求新建角色、岗位或成员类型，或现有角色无法覆盖某类工作时。',
    content: CREATE_ROLE_CONTENT,
  },
  {
    name: 'modify-role',
    description: '由队长修改项目角色：patch 合并写回；内置/全局角色 fork 进项目后再改，运行中成员不受影响。',
    whenToUse: '用户要求调整已有角色的职责、提示词、技能或 MCP 时。',
    content: MODIFY_ROLE_CONTENT,
  },
  {
    name: 'create-team',
    description: '由队长创建项目级团队：定名册 + 拆任务 DAG + 落 .dsh-myteam/（config/teams + tasks/<teamId>/ledger.jsonl），提交草稿等人工批准。',
    whenToUse: '用户要建团队、创建项目级别的团队、定名册（把几个角色组成一个团队）并派任务时。',
    content: CREATE_TEAM_CONTENT,
  },
  {
    name: 'write-team-charter',
    description: '由队长产出项目层团队章程：团队能力与边界 + 约束与文件治理章程，写入 .dsh-myteam/structure.md；只写章程，不建名册不派任务。',
    whenToUse: '用户要定团队边界、写团队章程、明确团队能力范围，或要约定文件治理与落位规则时。',
    content: WRITE_CHARTER_CONTENT,
  },
  {
    name: 'choose-team-template',
    description: '建团前先列项目/内置团队模板并选择 presetId；模板只在建团时快照。',
    whenToUse: '用户要组建团队、或问"有没有现成的团队模板/开箱团队"时。',
    content: CHOOSE_TEMPLATE_CONTENT,
  },
  {
    name: 'manage-team-template',
    description: '创建/复制/删除项目团队模板，或把团队配置恢复默认；内置模板只读、破坏性操作两段确认。',
    whenToUse: '用户要保存队形为模板、复制模板、删除模板，或让某个团队改回默认配置时。',
    content: MANAGE_TEMPLATE_CONTENT,
  },
]
