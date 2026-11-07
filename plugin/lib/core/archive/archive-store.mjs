/**
 * CHG-86（P0-2 / FR-14.1）：团队归档落盘。
 *
 * 修复的缺陷：`myteam_disband` 此前只往账本写一条 `team.disbanded` 事件，payload 里
 * 带个 `archivedPaths: ['.dsh-myteam/history/archive']` 字符串就算完事——**没有任何文件 IO**。
 * 而面板归档视图（`plugin/client/client.js` 归档回放屏）渲染的是
 * `archive/<teamId>/team.json`、`tokens.json`、`members/`、`artifacts/`，
 * 这些文件**永远不存在**，整套归档视图因此是空壳。
 *
 * 布局（CHG-102：整体流程历史分区，`.dsh-myteam/history/archive/` 在存储目录
 * 自己的 `.gitignore` 里被忽略）：
 * ```
 * .dsh-myteam/history/archive/<teamId>/
 *   MANIFEST.json             归档清单（生成时间 / 来源账本 / 事件数 / 文件列表）
 *   team.json                 团队快照（名册 + 任务终态 + 目标 + 归档时刻）
 *   tokens.json               token 侧车最终快照（按天桶）
 *   members/<memberId>.json   每名队员一份（角色 / 实例名 / 状态 / 会话 id）
 *   artifacts/artifacts.json  交付物清单（task.deliverable 事件的路径引用）
 * ```
 *
 * 设计约束：
 *  - **账本仍是唯一权威**〔I2〕：归档是只读快照，不参与 fold，不进模型上下文；
 *  - **幂等**：同一团队重复归档覆盖同名目录（内容由当次投影决定，不累加）；
 *  - **纯函数与 IO 分离**〔J1〕：`buildArchiveSnapshot` 无 IO，`writeArchive` 只写不读，
 *    `readArchive` 只读不写；这样快照结构可以在单测里不碰磁盘地断言。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
                                                           
                                                            
import { teamArchiveDir, archiveRoot, STORE_DIR } from '../workspace/layout.mjs'

/** 归档快照版本（结构演进时 +1，读侧按版本兼容） */
export const ARCHIVE_VERSION = 1

                                
            
                
                      
                
                    
                              
                        
 

                              
            
               
               
                  
                   
                 
                                               
                                 
                       
 

                                  
              
                
             
 

                                      
                 
                
              
              
               
                    
                    
                                  
                    
                             
                    
                  
                          
                      
                              
                                           
                    
 

/** 归档目录（团队级）：`history/archive/<teamId>` */
export function archiveDirOf(workspaceRoot        , teamId        )         {
  return teamArchiveDir(workspaceRoot, teamId)
}

/** 归档根目录：`history/archive` */
export function archiveRootOf(workspaceRoot        )         {
  return archiveRoot(workspaceRoot)
}

/**
 * 投影 + token 侧车 → 归档快照（纯函数，无 IO）。
 *
 * `tokens` 由调用方传入（host 侧 syncTokens 的结果），这样本函数可以完全无时钟、
 * 无服务依赖地在单测里断言结构。
 */
export function buildArchiveSnapshot(input   
                      
                    
                    
                    
                    
                    
 )                      {
  const { team, tokens, archivedAt, archivedBy, ledgerPath, eventCount } = input
  const members                  = Object.values(team.members).map((member) => ({
    id: member.id,
    roleId: member.roleId,
    instanceName: member.instanceName,
    status: member.status,
    ...(member.sessionId ? { sessionId: member.sessionId } : {}),
    ...(member.currentTaskId ? { currentTaskId: member.currentTaskId } : {}),
  }))
  const tasks                = Object.values(team.tasks).map((task) => ({
    id: task.id,
    title: task.input.title,
    state: task.state,
    priority: task.input.priority,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    gates: [...task.gates],
    gateVerdicts: { ...task.gateVerdicts },
    evidenceCount: task.evidenceRefs.length,
  }))
  // 交付物清单：账本只存路径引用（FR-10.4），归档把引用原样收进来
  const artifacts                    = Object.values(team.tasks).flatMap((task) =>
    task.deliverables.map((deliverable) => ({ path: deliverable.path, taskId: task.id, seq: deliverable.seq })),
  )
  return {
    version: ARCHIVE_VERSION,
    teamId: team.teamId,
    name: team.name ?? '',
    goal: team.goal ?? '',
    state: team.state,
    archivedAt,
    archivedBy,
    ledgerPath,
    eventCount,
    revision: team.revision,
    members,
    tasks,
    artifacts,
    tokens,
  }
}

                                     
             
                                                         
                     
                 
 

function writeJson(filePath        , value         )       {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 落盘归档快照（幂等：同团队重复归档整体覆盖）。
 * 返回写出的文件清单（相对归档目录），供账本 payload 与面板展示。
 */
export function writeArchive(workspaceRoot        , snapshot                     )                     {
  const dir = archiveDirOf(workspaceRoot, snapshot.teamId)
  const membersDir = join(dir, 'members')
  const artifactsDir = join(dir, 'artifacts')
  mkdirSync(membersDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })

  const files           = []
  // team.json：不含 tokens（tokens 单独一份，避免 team.json 随时间膨胀）
  const { tokens, ...teamOnly } = snapshot
  writeJson(join(dir, 'team.json'), teamOnly)
  files.push('team.json')
  writeJson(join(dir, 'tokens.json'), tokens)
  files.push('tokens.json')
  for (const member of snapshot.members) {
    writeJson(join(membersDir, `${member.id}.json`), member)
    files.push(`members/${member.id}.json`)
  }
  writeJson(join(artifactsDir, 'artifacts.json'), snapshot.artifacts)
  files.push('artifacts/artifacts.json')
  // MANIFEST 最后写：它是"这份归档完整"的判据（中途崩溃不会留下看似完整的清单）
  writeJson(join(dir, 'MANIFEST.json'), {
    version: snapshot.version,
    teamId: snapshot.teamId,
    archivedAt: snapshot.archivedAt,
    archivedBy: snapshot.archivedBy,
    ledgerPath: snapshot.ledgerPath,
    eventCount: snapshot.eventCount,
    files: [...files],
  })
  files.push('MANIFEST.json')
  return { dir, relativeDir: `${STORE_DIR}/history/archive/${snapshot.teamId}`, files }
}

/**
 * 读归档快照（只读）。`MANIFEST.json` 缺失视为未归档（宁可报空，不猜半个快照）。
 * tokens 单独读回并挂上，结构与 `buildArchiveSnapshot` 的输出对称。
 */
export function readArchive(workspaceRoot        , teamId        )                             {
  const dir = archiveDirOf(workspaceRoot, teamId)
  const teamPath = join(dir, 'team.json')
  const manifestPath = join(dir, 'MANIFEST.json')
  if (!existsSync(teamPath) || !existsSync(manifestPath)) return null
  try {
    const teamOnly = JSON.parse(readFileSync(teamPath, 'utf8'))                                       
    const tokensPath = join(dir, 'tokens.json')
    const tokens = existsSync(tokensPath)
      ? (JSON.parse(readFileSync(tokensPath, 'utf8'))              )
      : { version: 1         , teamId, updatedAt: 0, days: {}, totals: {}, note: '' }
    return { ...teamOnly, tokens }
  } catch {
    // 坏归档（手工改坏/写一半）：不抛，返回 null 让面板显示"归档不可读"
    return null
  }
}

/** 列出已归档团队 id（面板「全部团队」入口的数据源；只读目录名，不解析内容） */
export function listArchives(workspaceRoot        )           {
  const root = archiveRootOf(workspaceRoot)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}


//# sourceURL=./src/core/archive/archive-store.ts