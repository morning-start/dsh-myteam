/**
 * FR-16.1 单角色调用（CHG-87 / M2-0 T12）：`/myteam+<id>` 的落盘面。
 *
 * 语义（PRD §5.16）：单角色调用 = 把**一个角色**的配置临时注入当前会话
 * （提示词 section + C5 收窄 + Skill/MCP 绑定），与成员实例化同管线；**不入团队账本**
 * （它不是一个团队，没有任务 DAG）；`sessionDefaults` 跨重启恢复（FR-16.1 明确要求）。
 *
 * 为什么落 `config/roles/session-defaults.json` 而不是账本：
 *  - 角色是**配置资产**（docs/04 §3.4），角色库写操作一律不进账本（create_role /
 *    update_role / saveRole 都不进）；单角色调用与它们同类；
 *  - 目录语义上属于 `.dsh-myteam/config/`（项目级配置），不属任何团队 state。
 *
 * 跨重启恢复的口径：本文件是**默认值**，不是运行期状态——启动时读它重建提示词 section；
 * 会话内改动用同一个文件覆盖写（单写者：host 进程）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
                                                        
import { storeLayout } from '../workspace/layout.mjs'

export const SESSION_DEFAULTS_VERSION = 1

/** 单角色调用的落盘形态（schema 极小：只存角色 id 列表 + 归因） */
                                      
                 
                                    
                 
                                              
                               
                   
                                 
                
 

/**
 * `.dsh-myteam/config/session-defaults.json` 绝对路径。
 *
 * **为什么不放 `config/roles/`**（踩过的坑）：`listProjectRoles()` 会把 `config/roles/` 下
 * 所有 `*.json` 当角色定义读，读到本文件直接判定 `MT_ROLE_CORRUPT` → **整个角色目录变不可用**
 * （面板角色 tab / 建团选角色全挂）。会话默认值是配置，不是角色条目，必须与角色库分开目录。
 */
export function sessionDefaultsPath(workspaceRoot        )         {
  return storeLayout(workspaceRoot).sessionDefaults
}

/** 读默认值（文件缺失/损坏 → 空列表；损坏不抛，面板降级为「未启用」） */
export function readSessionDefaults(workspaceRoot        )                      {
  const filePath = sessionDefaultsPath(workspaceRoot)
  const empty                      = { version: SESSION_DEFAULTS_VERSION, roles: [], action: 'applied', updatedAt: '' }
  if (!existsSync(filePath)) return empty
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))                                
    return {
      version: typeof parsed?.version === 'number' ? parsed.version : SESSION_DEFAULTS_VERSION,
      roles: Array.isArray(parsed?.roles) ? [...new Set(parsed.roles.map(String).filter((id) => id.length > 0))] : [],
      action: parsed?.action === 'removed' ? 'removed' : 'applied',
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
      ...(typeof parsed?.actor === 'string' ? { actor: parsed.actor } : {}),
    }
  } catch {
    return empty
  }
}

/** 写默认值（幂等覆盖；返回落盘路径） */
export function writeSessionDefaults(
  workspaceRoot        ,
  roles          ,
  opts                                                                   = {},
)                                                  {
  const filePath = sessionDefaultsPath(workspaceRoot)
  const file                      = {
    version: SESSION_DEFAULTS_VERSION,
    roles: [...new Set(roles.map(String).filter((id) => id.length > 0))],
    action: opts.action === 'removed' ? 'removed' : 'applied',
    updatedAt: opts.now ?? new Date().toISOString(),
    ...(opts.actor ? { actor: opts.actor } : {}),
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  return { filePath, file }
}

/**
 * 提示词 section（FR-16.1「角色配置临时注入当前会话」）。
 *
 * 与成员 persona 同源（`RoleDefinition.systemPrompt`），但**上下文不同**：
 * 单角色调用的会话不是团队会话，没有任务 DAG / claim 机制 / 账本。
 * 故这里显式收窄（C5）：只给身份与能力边界，不给团队协作协议——
 * 否则模型会开始找 `myteam_claim_task`，而那些工具在这个会话里不存在。
 *
 * 空列表 → 返回空串（调用方据此决定「不注入」，而不是注入一个空 section）。
 */
export function buildRolePromptSection(roles                  )         {
  if (roles.length === 0) return ''
  const header =
    roles.length === 1
      ? `【单角色调用】当前会话已启用角色：${roles[0].id}（${roles[0].name}）。`
      : `【单角色调用】当前会话已启用 ${roles.length} 个角色：${roles.map((role) => `${role.id}（${role.name}）`).join('、')}。`
  const blocks = roles.map((role) => {
    const bindings           = []
    if (Array.isArray(role.skills) && role.skills.length > 0) bindings.push(`技能：${role.skills.join(', ')}`)
    if (Array.isArray(role.mcpAllowlist) && role.mcpAllowlist.length > 0) bindings.push(`MCP：${role.mcpAllowlist.join(', ')}`)
    return [`### ${role.id} · ${role.name}`, bindings.length > 0 ? `（${bindings.join('；')}）` : '', role.systemPrompt].filter((line) => line.length > 0).join('\n')
  })
  return [
    header,
    '本会话是**单角色调用**，不是团队会话：没有任务 DAG、没有 claim/attempt、没有团队账本。',
    '角色配置由用户在面板以 `/myteam+<roleId>` 启用或 `-<roleId>` 卸载；你没有创建/解散团队的权限。',
    ...blocks,
  ].join('\n\n')
}


//# sourceURL=./src/core/roles/session-defaults.ts