/**
 * T32（CHG-53）：队长内置技能 —— create-role / modify-role。
 *
 * 角色只能由标准队长（myteam-captain 预设）创建与修改（用户定案）；两个技能挂进
 * 队长 scope（host.initialize → ctx.skills.register），模型按需加载全文后调用
 * myteam_create_role / myteam_update_role 两个 Lead 工具落库。
 *
 * M2-7（FR-18）：新增 create-team 团队章程技能——只产出**项目层**章程文件
 * （`.team-workplace/structure.md`），不建名册、不派任务；沿用同一注册面。
 *
 * 纪律：
 *  - 技能正文只写"怎么做 + 边界"，不复制角色 schema 的实现细节（schema 以工具定义为准）；
 *  - 内置/全局角色只读：修改走"复制进项目再改"（update_role 的 copy-on-write）；
 *  - 运行中成员是身份快照（C3），改角色不影响已召唤成员。
 */

                               
              
                     
                    
                 
 

const CREATE_ROLE_CONTENT = `# 创建角色（create-role）

你是团队队长。用户要求"新建一个角色/岗位/成员类型"时，用 \`myteam_create_role\` 写进**项目角色库**（\`.team-workplace/config/roles/<roleId>.json\`）。

## 先问清三件事（合并成一轮，不要反复追问）

1. 这个角色负责什么、不负责什么（职责边界）。
2. 它需要哪些技能（skills）与可见的 MCP（mcpAllowlist）——没有就说"继承/不绑定"。
3. 它与现有角色的差别；若只是"另一个开发者"，优先改现有角色而不是新建。

## 角色是配置单元，不是成员

- 角色 = 职责 + 系统提示词 + 工具策略 + 技能 + MCP + 模型路由；
- 成员 = 角色的一次实例化（独立会话、独立快照、独立 token 账）；
- 队长是标准预设 \`myteam-captain\`，**不要创建第二个队长角色**（\`isCaptain\` 保持 false）。

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

- 每个成员有独立记忆区：\`.team-workplace/state/teams/<teamId>/members/<memberId>/\` 下的
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

- 项目角色（origin=project）：直接改项目库。
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
写路径全部在项目层：\`.team-workplace/config/presets/<id>.json\`。

## 四个工具

- \`myteam_save_preset({ preset, overwrite? })\`：建/改项目模板。已存在时必须 \`overwrite: true\`（两段确认，version + 1）；内置 id 拒写（MT_PRESET_BUILTIN）。
- \`myteam_copy_preset({ fromPresetId, toPresetId, name? })\`：内置/项目 → 新项目模板（fork）。目标已存在或为内置 id 会被拒。
- \`myteam_delete_preset({ presetId, confirm: true })\`：仅项目模板；内置拒删；confirm 两段确认。
- \`myteam_reset_team_config({ teamId, confirm: true })\`：删除团队级 team.config.json，退回「项目层 < 插件默认」。只重置配置，不动账本/成员。

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

const CREATE_TEAM_CONTENT = `# 组建团队章程（create-team）

用户要"定团队边界/写团队章程/约定文件治理"时，用本技能产出**一份项目层章程文件**：
团队能力与边界 + 约束与文件治理章程，写入 \`.team-workplace/structure.md\`。

这是**写章程**的技能：只产出并落盘这一个文件，**不建名册、不派任务**。

定位：章程是**项目层**的一份约定（每个项目一份，不是每个团队一份），是队长做规划与派单时的
能力补充说明——规划前先读它，产出物落位以它为准。

## 先问清两件事（合并成一轮，不要反复追问）

1. **能力与边界**：这个团队负责什么领域、明确不做什么、做到什么程度算完、什么情况必须升级到人。
2. **约束与文件治理**：文件放哪里、做到什么程度、谁沟通、谁存档。

用户已经说清的就别再问；缺的部分用默认值兜底，并在章程里标注「假设」。

## 章程正文怎么写

文件路径固定为 \`.team-workplace/structure.md\`（项目层，随仓库共享；宿主已预置标题骨架，你**覆盖正文**，不要另建文件）。

正文分两段，段标题固定，便于后续检索与引用：

### 一、团队能力与边界

- **领域边界**：本团队负责哪一段；范围外的相邻领域怎么处理（转交 / 拒绝 / 上报）。
- **明确不做**：列 3~5 条本团队不承担的事，以及超出边界时怎么回。
- **质量与验收基线**：一条交付满足什么才算完成（要可检验的判据，不写"高质量"这类空话）。
- **升级到人的条件**：哪几类情况必须交回人裁决（不可逆操作、对外发布、需求歧义、连续受阻）。

### 二、约束与文件治理章程

- **文件放哪里**：\`.team-workplace/config/\`（项目配置：\`team.config.json\`、\`roles/\`、\`presets/\`、\`knowledge/\`）、\`.team-workplace/state/\`（运行时状态，不入库）、\`docs/\`（人读交付物）。
- **做到什么程度**：什么算"写到一半"（草稿），什么算"可交付"（完整且可复核）。
- **谁沟通**：队长对外，队员对队长；跨团队协作走既有团队协作路径，不私拉群。
- **谁存档**：产物落位由任务的 \`deliverableSpec\` 指派（\`path/producer/reviewer/archiver\`）；章程本身由队长维护。

## 落盘

1. 先读 \`.team-workplace/structure.md\`（宿主预置的标题骨架），再写，避免覆盖已有内容。
2. 用工作区文件工具（\`write\` / \`edit\`）把上面两段正文写进该文件。
3. 写完读回一遍确认落盘，再把章程要点（能力边界 + 文件治理）向用户复述一遍。
4. 当前会话没有文件写入工具时：把章程全文贴给用户，并明确说明"未落盘"——不要口头声称已写入。

## 与其他能力的关系

- 名册与任务不归本技能：要组队用 \`myteam_submit_plan\`（名册 + 任务 DAG），要改团队名/目标用 \`myteam_update_team\`。
- 角色不归本技能：要新建或改角色用 create-role / modify-role 技能。
- 团队模板不归本技能：要保存队形为模板用 manage-team-template 技能。

## 边界

- 不越权：本技能**只写章程文件**，不改角色库、不动预设、不提交任务草稿。
- 不越权：章程是**约定**不是硬门禁——它约束队长与队员的行为，宿主不会据此拦截任何工具调用。
- 不越权：不把章程塞进成员提示词、不改队友身份快照——要让某条边界对某个角色生效，走角色提示词。
- 不越权：不改 \`.team-workplace/config/team.config.json\`（看板列/门禁等行为配置由预设与团队级配置决定；章程只声明"怎么管文件"，不改配置结构）。
- 章程是**每个项目一份**（项目层），不是每个团队一份；团队间的差异用各自任务的 \`deliverableSpec\` 表达。
`;

export const CAPTAIN_SKILLS                 = [
  {
    name: 'create-role',
    description: '由队长创建项目角色：写职责/系统提示词/工具策略/技能/MCP，落项目角色库。',
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
  {
    name: 'create-team',
    description: '由队长产出项目层团队章程：团队能力与边界 + 约束与文件治理章程，写入 .team-workplace/structure.md；只写章程，不建名册不派任务。',
    whenToUse: '用户要组建团队并定边界、写团队章程、明确团队能力范围，或要约定文件治理与落位规则时。',
    content: CREATE_TEAM_CONTENT,
  },
]


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/roles/captain-skills.ts