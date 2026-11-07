/**
 * dsh-plugin-myteam — host 入口（T1 骨架）。
 *
 * myteam 独立多智能体团队运行时：零依赖内置 agentTeams（PRD §2 零依赖边界）。
 * 允许的宿主服务白名单（PRD §9 零依赖审计）：
 *   agents（成员会话基座，ADR-001 直连）· subagents（通用消息投递）· tools ·
 *   systemPrompt · tokenMeter（FR-8.2 计量）· subprocess（M2 command 门禁）·
 *   storage/fs · sessionProjections（tokenUsage 投影）
 *
 * 域划分（docs/03-架构与ADR.md）：D1 账本 / D2 调度 / D3 成员 / D4 角色库 / D5 接口。
 *
 * CHG-102：**路径不再在这里定义**。项目级存储的唯一事实源是
 * `core/workspace/layout.ts`（`.dsh-myteam/` 目录契约 + 项目根解析）。本文件只剩
 * 「宿主装配入口」这一件事，且保留旧导出名（`ensureWorkplaceDirs` /
 * `ensureGitignoreManagedBlock`）避免调用点分叉。
 */
import { resolve } from 'node:path'
import { STORE_DIR, ensureStore, storeLayout,                  } from './core/workspace/layout.mjs'

/**
 * 目录分区常量（兼容导出）。
 *
 * @deprecated CHG-102：路径请用 `storeLayout(projectRoot)`。本常量只为既有调用点
 * 与测试保留「分区名」语义，**不再拼出绝对路径**。
 */
export const WORKPLACE_DIRS = {
  root: STORE_DIR,
  config: 'config',
  configRoles: 'config/roles',
  configPresets: 'config/teams',
  configSkills: 'config/skills',
  configTools: 'config/tools',
  state: 'state',
  stateLogs: 'state/logs',
  stateScratch: 'state/scratch',
  stateTeams: 'tasks',
  archive: 'history/archive',
  export: 'export',
}         

/**
 * 幂等维护 `.dsh-myteam/.gitignore`（CHG-102 迁移）。
 *
 * 旧实现把托管块追加到**项目根** `.gitignore`：污染用户仓库、且在 desktop profile 下
 * 往 `~/.dsh/profiles/desktop/.gitignore` 里写垃圾规则。现在规则住在存储目录内部，
 * 由 `ensureStore` 一次写好；本函数只做「存在性检查 + 迁移清理」。
 */
export function ensureGitignoreManagedBlock(workspaceRoot        , warn                            = () => {})                       {
  const before = storeLayout(workspaceRoot)
  const result = ensureStore(workspaceRoot, { warn })
  return { changed: result.created.includes('config') || result.migrated || !before.root }
}

/** 初始化项目级存储（幂等）：`.dsh-myteam/` 全部分区 + 元文件 */
export function ensureWorkplaceDirs(workspaceRoot        , warn                            = () => {})                                                           {
  const result = ensureStore(workspaceRoot, { warn })
  return { root: result.layout.root, created: result.created, layout: result.layout }
}

/** 最小 Cordis 上下文面（本文件只用到这两处；完整类型在 src/host.ts 的 HostRuntime） */
                        
                               
                                                                                 
 

/** T1：宿主插件装配入口。TS 完整版在 src/host.ts。 */
export default function activate(ctx              ) {
  const workspaceRoot = ctx?.workspace?.root ?? process.cwd()
  const warn = (msg        ) => ctx?.logger?.warn?.(`[myteam] ${msg}`) ?? console.warn(`[myteam] ${msg}`)

  const dirs = ensureWorkplaceDirs(workspaceRoot, warn)

  ctx?.logger?.info?.(`[myteam] store ready at ${resolve(dirs.root)} (created: ${dirs.created.length})`)

  return {
    // T2 起逐步挂载：ledger / scheduler / members / roles / tools / remote
    __workplace: dirs,
  }
}


//# sourceURL=./src/host-workspace.ts