/**
 * CHG-91（插件团队贡献契约 v1）：**贡献点的数据契约**。
 *
 * 权威是 `docs/16-插件团队贡献契约.md`。本文件只放**类型与常量**，不放逻辑——
 * 这样 `parse.ts` 的纯函数、`host.ts` 的装载、面板视图都能共用同一份定义，
 * 不会出现「文档说 14 个错误码，代码里散落 12 个字符串」这种分叉。
 *
 * 三条不可动摇的口径（契约 P2/P3/P4）：
 *  1. **数据不是代码**——这里没有 `import()`，只有 `JSON.parse`；
 *  2. **单向流动**——插件 → 全局库 → 项目库，插件贡献物只读；
 *  3. **失败隔离但大声**——单个插件/条目坏掉不拖垮别人，但每个失败都进 `warnings[]`。
 */
                                                               
                                                                  

/* ── 契约版本 ─────────────────────────────────────────────────────── */

/**
 * 当前实现的契约版本。
 *
 * 版本协商只认**集合成员**，不做「尽力解析」（契约 §10）：高版本 → 整个插件跳过 +
 * `MT_PLUGIN_CONTRACT_UNSUPPORTED`。理由：尽力解析的失败模式是字段被静默丢弃，
 * 用户拿到一个少了门禁链的团队却不知道，比直接报错危险得多。
 */
export const CONTRIBUTION_CONTRACT_VERSION = 1

/** 支持的契约版本集合（与 `CONTRIBUTION_CONTRACT_VERSION` 同源，便于将来并行支持 v1/v2） */
export const SUPPORTED_CONTRACT_VERSIONS                      = new Set([CONTRIBUTION_CONTRACT_VERSION])

/** 单文件大小上限（256 KiB）——超过说明提示词该拆成 skill 了 */
export const MAX_CONTRIBUTION_FILE_BYTES = 256 * 1024

/* ── 错误码（契约 §9；改这里 = 改契约，必须同步 docs/16）────────── */

export const CONTRIBUTION_CODES = {
  /* 插件级：整个插件被跳过 */
  MANIFEST_INVALID: 'MT_PLUGIN_MANIFEST_INVALID',
  CONTRACT_UNSUPPORTED: 'MT_PLUGIN_CONTRACT_UNSUPPORTED',
  ID_INVALID: 'MT_PLUGIN_ID_INVALID',
  ID_MISMATCH: 'MT_PLUGIN_ID_MISMATCH',
  ID_DUPLICATE: 'MT_PLUGIN_ID_DUPLICATE',
  /* 条目级：该角色/模板被跳过 */
  FILE_MISSING: 'MT_CONTRIBUTION_FILE_MISSING',
  TOO_LARGE: 'MT_CONTRIBUTION_TOO_LARGE',
  ID_MISMATCH_ENTRY: 'MT_CONTRIBUTION_ID_MISMATCH',
  PATH_TRAVERSAL: 'MT_CONTRIBUTION_PATH_TRAVERSAL',
  ROLE_CONFLICT: 'MT_ROLE_CONTRIBUTION_CONFLICT',
  CAPTAIN_RESERVED: 'MT_ROLE_CAPTAIN_RESERVED',
  TEAM_CONFLICT: 'MT_TEAM_TEMPLATE_CONFLICT',
  TEAM_CAPTAIN: 'MT_TEAM_TEMPLATE_CAPTAIN',
  TEAM_UNRESOLVED: 'MT_TEAM_TEMPLATE_UNRESOLVED',
  /* 非错误 */
  ORIGIN_STAMPED: 'MT_CONTRIBUTION_ORIGIN_STAMPED',
  CODE_IGNORED: 'MT_CONTRIBUTION_CODE_IGNORED',
  ROOT_ABSENT: 'MT_CONTRIBUTION_ROOT_ABSENT',
  /* 写操作 */
  ROLE_READONLY: 'MT_ROLE_READONLY',
}         

                                                                                           

/* ── 数据结构 ─────────────────────────────────────────────────────── */

/** 目录发现结果（只做发现，不解析） */
                                     
                                            
                  
                    
             
                      
 

/** 一条失败/提示（契约 §8.3） */
                                      
              
                                   
                 
                  
                                                 
               
                                           
                        
                                  
 

/** 单个插件的装载状态 */
                                                                       

                                     
                  
                     
                 
                                
                   
             
                      
                   
                          
                                    
                              
                 
                     
                 
                                  
 

/** 一份贡献目录的完整装载结果 */
                                      
                                          
              
                               
                                              
                         
               
                           
                                 
                   
                                                  
             
 

/** 空目录（没有插件贡献是正常态，不是错误） */
export function emptyContributionCatalog(root        , now = new Date().toISOString())                      {
  return { root, plugins: [], roles: [], teams: [], warnings: [], scannedAt: now, ok: true }
}

/* ── 错误消息（中文可读；面板直接显示）─────────────────────────── */

/**
 * 把「拒绝」翻译成人能照做的话。
 *
 * 契约 §9 要求每条错误都有**修法**——所以这里不接受「失败了」，
 * 必须说清「哪里错了 + 怎么改」。这是 P4「大声」的具体含义。
 */
export function describeContribution(code        , detail                          = {})         {
  switch (code) {
    case CONTRIBUTION_CODES.MANIFEST_INVALID:
      return `插件清单不合法：${String(detail.reason ?? '缺少必需字段或不是合法 JSON')}`
    case CONTRIBUTION_CODES.CONTRACT_UNSUPPORTED:
      return `插件要求契约 v${String(detail.contractVersion ?? '?')}，当前 myteam 支持 v${CONTRIBUTION_CONTRACT_VERSION}；该插件会被整体跳过`
    case CONTRIBUTION_CODES.ID_INVALID:
      return `pluginId "${String(detail.pluginId ?? '')}" 不合规（需小写字母开头、只含 a-z0-9-、2~64 字符）`
    case CONTRIBUTION_CODES.ID_MISMATCH:
      return `清单 pluginId "${String(detail.pluginId ?? '')}" 与目录名 "${String(detail.dirName ?? '')}" 不一致`
    case CONTRIBUTION_CODES.ID_DUPLICATE:
      return `pluginId "${String(detail.pluginId ?? '')}" 与另一个插件目录重复（按目录名字典序，后者失败）`
    case CONTRIBUTION_CODES.FILE_MISSING:
      return `清单声明了 "${String(detail.file ?? '')}" 但文件不存在`
    case CONTRIBUTION_CODES.TOO_LARGE:
      return `"${String(detail.file ?? '')}" 超过 256 KiB（实际 ${String(detail.size ?? 0)} B）——长提示词请拆成 skill`
    case CONTRIBUTION_CODES.ID_MISMATCH_ENTRY:
      return `"${String(detail.file ?? '')}" 内 id="${String(detail.actual ?? '')}" 与清单声明 "${String(detail.declared ?? '')}" 不一致`
    case CONTRIBUTION_CODES.PATH_TRAVERSAL:
      return `"${String(detail.file ?? '')}" 必须是插件目录内的相对路径（禁止 .. 与绝对路径）`
    case CONTRIBUTION_CODES.ROLE_CONFLICT:
      return `角色 "${String(detail.roleId ?? '')}" 与 ${String(detail.conflictsWith === 'builtin' ? '内置角色' : `插件 "${String(detail.conflictsWith ?? '')}"`)} 冲突；请改用带前缀的 id（如 "${String(detail.suggestion ?? '')}"）`
    case CONTRIBUTION_CODES.CAPTAIN_RESERVED:
      return `角色 "${String(detail.roleId ?? '')}" 声明了 isCaptain:true——插件不能贡献队长（队长是名册锚点，只能来自内置 captain）`
    case CONTRIBUTION_CODES.TEAM_CONFLICT:
      return `团队模板 "${String(detail.teamId ?? '')}" 与 ${String(detail.conflictsWith === 'builtin' ? '内置模板' : `插件 "${String(detail.conflictsWith ?? '')}"`)} 冲突；请改用带前缀的 id`
    case CONTRIBUTION_CODES.TEAM_CAPTAIN:
      return `团队模板 "${String(detail.teamId ?? '')}" 的 members 不能含 captain（队长由预设隐式提供）`
    case CONTRIBUTION_CODES.TEAM_UNRESOLVED:
      return `团队模板 "${String(detail.teamId ?? '')}" 引用了不可解析的角色：${(detail.roleIds                        )?.map((id) => `"${id}"`).join(', ') ?? ''}——请在同一个插件里贡献它，或确认它来自 builtin / 全局库 / 项目库`
    case CONTRIBUTION_CODES.ORIGIN_STAMPED:
      return `角色 "${String(detail.roleId ?? '')}" 的 origin 字段会被 myteam 覆盖为 "plugin:${String(detail.pluginId ?? '')}"，请删除该字段`
    case CONTRIBUTION_CODES.CODE_IGNORED:
      return `插件目录含可执行文件（${(detail.files                        )?.join(', ') ?? ''}）——myteam 只读 JSON，不会执行它们`
    case CONTRIBUTION_CODES.ROOT_ABSENT:
      return `贡献根目录不存在（没有插件贡献，这是正常的）：${String(detail.root ?? '')}`
    case CONTRIBUTION_CODES.ROLE_READONLY:
      return `插件贡献的角色 "${String(detail.roleId ?? '')}" 只读；想改请先「复制到项目」再编辑项目库那份`
    default:
      return String(detail.message ?? code)
  }
}


//# sourceURL=./src/core/contributions/contract.ts